import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileWatcher } from './watcher.js';
import { SyncStateDB } from './state.js';
import { SyncClient, ConflictError } from './client.js';
import { SyncWebSocket } from './websocket.js';
import { ExtraPathsManager } from './extra-paths.js';
import { encryptFile, decryptFile, hashContent, deriveKeyForPath } from '../crypto/index.js';
import type { ContextMateConfig } from '../config.js';
import type { SyncResult } from '../types.js';
import { getSyncDbPath } from '../utils/paths.js';

export class SyncEngine {
  private watcher: FileWatcher | null = null;
  private stateDb: SyncStateDB | null = null;
  private client: SyncClient;
  private ws: SyncWebSocket | null = null;
  private readonly vaultKey: Uint8Array;
  private readonly config: ContextMateConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private extraPathsManager: ExtraPathsManager | null = null;
  private extraWatchers: FileWatcher[] = [];

  constructor(config: ContextMateConfig, vaultKey: Uint8Array, authToken?: string) {
    this.config = config;
    this.vaultKey = vaultKey;
    this.client = new SyncClient(config.server.url, authToken || config.server.apiKey || '');
  }

  async start(): Promise<void> {
    // Initialize state database
    const dbPath = getSyncDbPath(this.config);
    await mkdir(dirname(dbPath), { recursive: true });
    this.stateDb = new SyncStateDB(dbPath);

    // Start file watcher
    this.watcher = new FileWatcher(this.config.vault.path, this.config.sync.debounceMs);
    this.watcher.start();

    // Connect WebSocket
    const wsUrl = this.config.server.url.replace(/^http/, 'ws');
    this.ws = new SyncWebSocket(wsUrl, this.config.server.apiKey ?? '');
    this.ws.connect();

    // Initial full sync
    await this.syncAll();

    // Wire up local file events
    this.watcher.on('file-changed', (event: { path: string }) => {
      void this.handleLocalChange(event.path);
    });
    this.watcher.on('file-added', (event: { path: string }) => {
      void this.handleLocalChange(event.path);
    });
    this.watcher.on('file-removed', (event: { path: string }) => {
      void this.handleLocalDelete(event.path);
    });

    // Wire up remote events
    this.ws.on('file-updated', (event: { path: string; version: number }) => {
      void this.handleRemoteUpdate(event.path, event.version);
    });
    this.ws.on('file-deleted', (event: { path: string }) => {
      void this.handleRemoteDelete(event.path);
    });

    // Set up extra paths if configured
    if (this.config.sync.extraPaths.length > 0) {
      this.extraPathsManager = new ExtraPathsManager(
        this.config.sync.extraPaths,
        this.config.vault.path,
      );

      // Initial import
      await this.extraPathsManager.importToVault();

      // Watch each base directory
      const watchPaths = this.extraPathsManager.getWatchPaths();
      for (const watchPath of watchPaths) {
        const w = new FileWatcher(watchPath, this.config.sync.debounceMs);
        w.start();

        w.on('file-changed', (event: { path: string }) => {
          void this.handleExtraPathChange(watchPath, event.path);
        });
        w.on('file-added', (event: { path: string }) => {
          void this.handleExtraPathChange(watchPath, event.path);
        });

        this.extraWatchers.push(w);
      }
    }

    // Start periodic poll
    this.pollTimer = setInterval(() => {
      void this.syncAll();
    }, this.config.sync.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const w of this.extraWatchers) {
      await w.stop();
    }
    this.extraWatchers = [];
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
    if (this.stateDb) {
      this.stateDb.close();
      this.stateDb = null;
    }
  }

  async handleLocalChange(relativePath: string): Promise<void> {
    if (!this.stateDb) return;

    try {
      const absolutePath = join(this.config.vault.path, relativePath);
      const content = await readFile(absolutePath);
      const contentBytes = new Uint8Array(content);

      // Hash the content
      const contentHash = hashContent(contentBytes);

      // Check state db - skip if hash unchanged
      const existing = this.stateDb.getFile(relativePath);
      if (existing && existing.contentHash === contentHash) {
        return;
      }

      // Derive file-specific encryption key
      const fileKey = deriveKeyForPath(this.vaultKey, relativePath);

      // Encrypt file
      const encrypted = encryptFile(contentBytes, fileKey);
      const encryptedHash = hashContent(encrypted);

      // Upload
      const currentVersion = existing?.version ?? 0;
      try {
        const result = await this.client.uploadFile(
          relativePath,
          encrypted,
          encryptedHash,
          currentVersion,
        );

        // Update state db
        this.stateDb.upsertFile({
          id: existing?.id ?? randomUUID(),
          path: relativePath,
          contentHash,
          encryptedHash,
          version: result.version,
          size: contentBytes.length,
          syncState: 'synced',
          lastModified: Date.now(),
        });
        this.stateDb.addSyncLog('upload', relativePath);
      } catch (err) {
        if (err instanceof ConflictError) {
          // Conflict: download remote version, save local as .conflict.md
          await this.resolveConflictWithRemote(relativePath, contentBytes);
        } else {
          throw err;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stateDb.addSyncLog('error', relativePath, message);
    }
  }

  private async handleExtraPathChange(basePath: string, relativePath: string): Promise<void> {
    if (!this.extraPathsManager) return;

    try {
      const absolutePath = join(basePath, relativePath);
      const vaultRelative = this.extraPathsManager.sourceToVaultPath(absolutePath);
      if (!vaultRelative) return;

      const content = await readFile(absolutePath);
      const vaultDest = join(this.config.vault.path, vaultRelative);

      // Skip if content is identical (avoid infinite loop)
      try {
        const existing = await readFile(vaultDest);
        if (Buffer.compare(content, existing) === 0) return;
      } catch {
        // Vault file doesn't exist yet
      }

      await mkdir(dirname(vaultDest), { recursive: true });
      await writeFile(vaultDest, content);
      // The vault watcher will pick this up and trigger handleLocalChange -> upload
    } catch {
      // Source unreadable, skip
    }
  }

  async handleRemoteUpdate(path: string, version: number): Promise<void> {
    if (!this.stateDb) return;

    try {
      // Check state db - skip if same version
      const existing = this.stateDb.getFile(path);
      if (existing && existing.version >= version) {
        return;
      }

      // Download encrypted blob
      const { data: encryptedData, version: remoteVersion, encryptedHash } =
        await this.client.downloadFile(path);

      // Derive file key and decrypt
      const fileKey = deriveKeyForPath(this.vaultKey, path);
      const decrypted = decryptFile(encryptedData, fileKey);

      const absolutePath = join(this.config.vault.path, path);

      // Check for local modifications
      if (existing && existing.syncState === 'modified') {
        // Save local as conflict file
        const conflictPath = absolutePath.replace(/\.md$/, '.conflict.md');
        const localContent = await readFile(absolutePath);
        await writeFile(conflictPath, localContent);
        this.stateDb.addSyncLog('conflict', path, 'Local changes saved as .conflict.md');
      }

      // Write remote version to vault
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, decrypted);

      // If this is an extra-path file, write back to original source
      if (this.extraPathsManager && path.startsWith('custom/')) {
        try {
          await this.extraPathsManager.writeBackToSource(path, decrypted);
        } catch {
          // Source location may not exist on this device
        }
      }

      // Update state db
      const contentHash = hashContent(decrypted);
      this.stateDb.upsertFile({
        id: existing?.id ?? randomUUID(),
        path,
        contentHash,
        encryptedHash,
        version: remoteVersion,
        size: decrypted.length,
        syncState: 'synced',
        lastModified: Date.now(),
      });
      this.stateDb.addSyncLog('download', path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stateDb.addSyncLog('error', path, message);
    }
  }

  private async discoverLocalFiles(dir: string, base: string): Promise<string[]> {
    const paths: string[] = [];
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return paths;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          paths.push(...await this.discoverLocalFiles(full, base));
        } else if (s.isFile()) {
          paths.push(relative(base, full));
        }
      } catch {
        // Skip inaccessible entries
      }
    }
    return paths;
  }

  async syncAll(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      conflicts: [],
      errors: [],
    };

    if (!this.stateDb) return result;

    try {
      // Get remote file list
      const remoteFiles = await this.client.listRemoteFiles();
      const localFiles = this.stateDb.getAllFiles();
      const localFileMap = new Map(localFiles.map((f) => [f.path, f]));
      const remoteFileMap = new Map(remoteFiles.map((f) => [f.path, f]));

      // Re-import extra paths to catch new files
      if (this.extraPathsManager) {
        await this.extraPathsManager.importToVault();
      }

      // Discover untracked local files and upload them
      const localDiskFiles = await this.discoverLocalFiles(this.config.vault.path, this.config.vault.path);
      for (const filePath of localDiskFiles) {
        if (filePath.endsWith('.conflict.md')) continue;
        if (localFileMap.has(filePath)) continue; // Already tracked
        if (remoteFileMap.has(filePath)) continue; // Will be handled by pull logic

        try {
          const absolutePath = join(this.config.vault.path, filePath);
          const content = await readFile(absolutePath);
          const contentBytes = new Uint8Array(content);
          const contentHash = hashContent(contentBytes);

          const fileKey = deriveKeyForPath(this.vaultKey, filePath);
          const encrypted = encryptFile(contentBytes, fileKey);
          const encryptedHash = hashContent(encrypted);

          const uploadResult = await this.client.uploadFile(
            filePath,
            encrypted,
            encryptedHash,
            0,
          );

          this.stateDb.upsertFile({
            id: randomUUID(),
            path: filePath,
            contentHash,
            encryptedHash,
            version: uploadResult.version,
            size: contentBytes.length,
            syncState: 'synced',
            lastModified: Date.now(),
          });
          this.stateDb.addSyncLog('upload', filePath);
          result.uploaded.push(filePath);
        } catch (err) {
          result.errors.push({
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Push local changes (modified/pending files)
      const modifiedFiles = this.stateDb.getModifiedFiles();
      for (const file of modifiedFiles) {
        try {
          const absolutePath = join(this.config.vault.path, file.path);
          const content = await readFile(absolutePath);
          const contentBytes = new Uint8Array(content);

          const fileKey = deriveKeyForPath(this.vaultKey, file.path);
          const encrypted = encryptFile(contentBytes, fileKey);
          const encryptedHash = hashContent(encrypted);

          const uploadResult = await this.client.uploadFile(
            file.path,
            encrypted,
            encryptedHash,
            file.version,
          );

          this.stateDb.markSynced(file.path, uploadResult.version, encryptedHash);
          result.uploaded.push(file.path);
        } catch (err) {
          if (err instanceof ConflictError) {
            result.conflicts.push(file.path);
            this.stateDb.markConflict(file.path);
          } else {
            result.errors.push({
              path: file.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Pull remote changes
      for (const remote of remoteFiles) {
        const local = localFileMap.get(remote.path);

        // Skip if we already have this version
        if (local && local.version >= remote.version) {
          continue;
        }

        try {
          const { data: encryptedData, version: remoteVersion, encryptedHash } =
            await this.client.downloadFile(remote.path);

          const fileKey = deriveKeyForPath(this.vaultKey, remote.path);
          const decrypted = decryptFile(encryptedData, fileKey);

          const absolutePath = join(this.config.vault.path, remote.path);

          // Check for local conflict
          if (local && local.syncState === 'modified') {
            const conflictPath = absolutePath.replace(/\.md$/, '.conflict.md');
            const localContent = await readFile(absolutePath);
            await writeFile(conflictPath, localContent);
            result.conflicts.push(remote.path);
            this.stateDb.addSyncLog('conflict', remote.path, 'Local changes saved as .conflict.md');
          }

          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, decrypted);

          // If this is an extra-path file, write back to original source
          if (this.extraPathsManager && remote.path.startsWith('custom/')) {
            try {
              await this.extraPathsManager.writeBackToSource(remote.path, decrypted);
            } catch {
              // Source location may not exist on this device
            }
          }

          const contentHash = hashContent(decrypted);
          this.stateDb.upsertFile({
            id: local?.id ?? randomUUID(),
            path: remote.path,
            contentHash,
            encryptedHash,
            version: remoteVersion,
            size: decrypted.length,
            syncState: 'synced',
            lastModified: Date.now(),
          });
          result.downloaded.push(remote.path);
        } catch (err) {
          result.errors.push({
            path: remote.path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      result.errors.push({
        path: '*',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }

  private async handleLocalDelete(relativePath: string): Promise<void> {
    if (!this.stateDb) return;
    this.stateDb.removeFile(relativePath);
    this.stateDb.addSyncLog('delete', relativePath, 'Local file removed');
  }

  private async handleRemoteDelete(path: string): Promise<void> {
    if (!this.stateDb) return;
    this.stateDb.removeFile(path);
    this.stateDb.addSyncLog('delete', path, 'Remote file deleted');
  }

  private async resolveConflictWithRemote(
    relativePath: string,
    localContent: Uint8Array,
  ): Promise<void> {
    if (!this.stateDb) return;

    const absolutePath = join(this.config.vault.path, relativePath);

    // Save local content as conflict file
    const conflictPath = absolutePath.replace(/\.md$/, '.conflict.md');
    await writeFile(conflictPath, localContent);

    // Download and write remote version
    const { data: encryptedData, version: remoteVersion, encryptedHash } =
      await this.client.downloadFile(relativePath);

    const fileKey = deriveKeyForPath(this.vaultKey, relativePath);
    const decrypted = decryptFile(encryptedData, fileKey);

    await writeFile(absolutePath, decrypted);

    const contentHash = hashContent(decrypted);
    const existing = this.stateDb.getFile(relativePath);
    this.stateDb.upsertFile({
      id: existing?.id ?? randomUUID(),
      path: relativePath,
      contentHash,
      encryptedHash,
      version: remoteVersion,
      size: decrypted.length,
      syncState: 'conflict',
      lastModified: Date.now(),
    });
    this.stateDb.addSyncLog('conflict', relativePath, 'Local changes saved as .conflict.md, remote version written');
  }
}
