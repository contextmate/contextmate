import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileWatcher } from './watcher.js';
import { SyncStateDB } from './state.js';
import { SyncClient, ConflictError } from './client.js';
import { SyncWebSocket } from './websocket.js';
import { SyncMutex } from './mutex.js';
import { ExtraPathsManager } from './extra-paths.js';
import { reconcileFile } from './reconcile.js';
import { encryptFile, decryptFile, hashContent, deriveKeyForPath } from '../crypto/index.js';
import type { ContextMateConfig } from '../config.js';
import type { SyncResult } from '../types.js';
import { getSyncDbPath } from '../utils/paths.js';

/** Directories that should never be synced or watched inside the vault. */
const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.venv', 'venv', '.next', 'dist', '.cache',
]);

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

  private readonly authToken: string;
  private readonly deviceId: string | undefined;

  private mutex = new SyncMutex();
  private suppressedPaths = new Set<string>();

  constructor(config: ContextMateConfig, vaultKey: Uint8Array, authToken?: string, deviceId?: string) {
    this.config = config;
    this.vaultKey = vaultKey;
    this.authToken = authToken || config.server.apiKey || '';
    this.deviceId = deviceId;
    this.client = new SyncClient(config.server.url, this.authToken);
    this.client.enableTokenRefresh({
      authJsonPath: join(config.data.path, 'auth.json'),
    });
  }

  async start(): Promise<void> {
    // Initialize state database
    const dbPath = getSyncDbPath(this.config);
    await mkdir(dirname(dbPath), { recursive: true });
    this.stateDb = new SyncStateDB(dbPath);

    // Start file watcher (skip heavy dirs that should never sync)
    this.watcher = new FileWatcher(this.config.vault.path, this.config.sync.debounceMs, {
      ignoredDirs: [...SKIP_DIRS],
    });
    this.watcher.start();

    // Wire up local file events BEFORE syncAll so no events are lost
    this.watcher.on('file-changed', (event: { path: string }) => {
      if (this.suppressedPaths.delete(event.path)) return;
      void this.handleLocalChange(event.path);
    });
    this.watcher.on('file-added', (event: { path: string }) => {
      if (this.suppressedPaths.delete(event.path)) return;
      void this.handleLocalChange(event.path);
    });
    this.watcher.on('file-removed', (event: { path: string }) => {
      void this.handleLocalDelete(event.path);
    });

    // Connect WebSocket (use live token getter so reconnects use refreshed tokens)
    const wsUrl = this.config.server.url.replace(/^http/, 'ws');
    this.ws = new SyncWebSocket(wsUrl, () => this.client.currentToken, this.deviceId);
    this.ws.connect();

    // Re-sync on WebSocket reconnection (may have missed events while disconnected)
    this.ws.on('reconnected', () => {
      void this.syncAll();
    });

    // Initial full sync
    await this.syncAll();

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

  // ---------------------------------------------------------------------------
  // Public methods — all go through the mutex
  // ---------------------------------------------------------------------------

  async handleLocalChange(relativePath: string): Promise<void> {
    await this.mutex.run(() => this._handleLocalChange(relativePath));
  }

  async handleRemoteUpdate(path: string, version: number): Promise<void> {
    await this.mutex.run(() => this._handleRemoteUpdate(path, version));
  }

  async handleLocalDelete(relativePath: string): Promise<void> {
    await this.mutex.run(() => this._handleLocalDelete(relativePath));
  }

  async handleRemoteDelete(path: string): Promise<void> {
    await this.mutex.run(() => this._handleRemoteDelete(path));
  }

  async syncAll(): Promise<SyncResult> {
    return this.mutex.run(() => this._syncAll());
  }

  /** Public API for adapters to propagate workspace deletions to server. */
  async deleteFile(relativePath: string): Promise<void> {
    return this.handleLocalDelete(relativePath);
  }

  // ---------------------------------------------------------------------------
  // Internal implementations
  // ---------------------------------------------------------------------------

  private async _handleLocalChange(relativePath: string): Promise<void> {
    if (!this.stateDb) return;

    // Skip files that were deleted remotely
    if (this.stateDb.isRecentDeletion(relativePath)) {
      try {
        await unlink(join(this.config.vault.path, relativePath));
      } catch {
        // Already gone
      }
      return;
    }

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

        // Update state db — mark as synced with origin 'synced' after successful upload
        this.stateDb.upsertFile({
          id: existing?.id ?? randomUUID(),
          path: relativePath,
          contentHash,
          encryptedHash,
          version: result.version,
          size: contentBytes.length,
          syncState: 'synced',
          lastModified: Date.now(),
          origin: 'synced',
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
      this.stateDb?.addSyncLog('error', relativePath, message);
      console.error(`[sync] Error processing ${relativePath}: ${message}`);
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

  private async _handleRemoteUpdate(path: string, version: number): Promise<void> {
    if (!this.stateDb) return;

    try {
      // Clear any deletion tombstone — file is back on remote
      this.stateDb.removeDeletion(path);

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

      // Write remote version to vault (with suppression to avoid echo loop)
      await mkdir(dirname(absolutePath), { recursive: true });
      this.suppressedPaths.add(path);
      await writeFile(absolutePath, decrypted);

      // If this is an extra-path file, write back to original source
      if (this.extraPathsManager && path.startsWith('custom/')) {
        try {
          await this.extraPathsManager.writeBackToSource(path, decrypted);
        } catch {
          // Source location may not exist on this device
        }
      }

      // Update state db — mark as synced with origin 'synced'
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
        origin: 'synced',
      });
      this.stateDb.addSyncLog('download', path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stateDb?.addSyncLog('error', path, message);
      console.error(`[sync] Error processing ${path}: ${message}`);
    }
  }

  private async _handleLocalDelete(relativePath: string): Promise<void> {
    if (!this.stateDb) return;

    const existing = this.stateDb.getFile(relativePath);

    // Record deletion tombstone FIRST to prevent syncAll() from re-downloading
    this.stateDb.recordDeletion(relativePath, existing?.version ?? 0, 'local');
    this.stateDb.removeFile(relativePath);

    // Propagate deletion to server
    try {
      await this.client.deleteFile(relativePath);
    } catch {
      // Server may be unreachable or file already gone
    }

    this.stateDb.addSyncLog('delete', relativePath, 'Local file removed');
  }

  private async _handleRemoteDelete(path: string): Promise<void> {
    if (!this.stateDb) return;

    const existing = this.stateDb.getFile(path);
    this.stateDb.removeFile(path);
    this.stateDb.recordDeletion(path, existing?.version ?? 0, 'remote');

    // Delete the local vault file so syncAll() doesn't re-upload it
    // Use suppression to prevent the watcher from firing a handleLocalDelete
    try {
      const absolutePath = join(this.config.vault.path, path);
      this.suppressedPaths.add(path);
      await unlink(absolutePath);
    } catch {
      // File may already be missing
      this.suppressedPaths.delete(path);
    }

    this.stateDb.addSyncLog('delete', path, 'Remote file deleted');
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
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
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

  private async _syncAll(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      conflicts: [],
      errors: [],
    };

    if (!this.stateDb) return result;

    try {
      // Re-import extra paths to catch new files
      if (this.extraPathsManager) {
        await this.extraPathsManager.importToVault();
      }

      const cursor = this.stateDb.getLastCursor();

      if (cursor === 0) {
        // First sync — no cursor yet, do a full reconciliation
        await this.fullReconciliation(result);
      } else {
        // Incremental sync using the change log
        await this.incrementalSync(cursor, result);
      }

      // Step 4: Expire old deletion tombstones (older than 24 hours)
      this.stateDb.expireDeletions(Date.now() - 24 * 60 * 60 * 1000);
    } catch (err) {
      result.errors.push({
        path: '*',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }

  /**
   * First sync (cursor === 0): Full reconciliation using three-way merge.
   * Lists all remote files and walks local vault, using reconcileFile()
   * to determine the action for each path.
   */
  private async fullReconciliation(result: SyncResult): Promise<void> {
    if (!this.stateDb) return;

    const remoteFiles = await this.client.listRemoteFiles();
    const remoteFileMap = new Map(remoteFiles.map((f) => [f.path, f]));

    const localDiskFiles = await this.discoverLocalFiles(this.config.vault.path, this.config.vault.path);
    const localDiskSet = new Set(localDiskFiles);

    // Collect all paths (union of disk, DB, and remote)
    const dbFiles = this.stateDb.getAllFiles();
    const dbFileMap = new Map(dbFiles.map((f) => [f.path, f]));

    const allPaths = new Set<string>([
      ...localDiskFiles,
      ...dbFiles.map((f) => f.path),
      ...remoteFiles.map((f) => f.path),
    ]);

    for (const path of allPaths) {
      if (path.endsWith('.conflict.md')) continue;

      const onDisk = localDiskSet.has(path);
      const dbEntry = dbFileMap.get(path);
      const remoteEntry = remoteFileMap.get(path);

      let diskHash: string | undefined;
      if (onDisk) {
        try {
          const absolutePath = join(this.config.vault.path, path);
          const content = await readFile(absolutePath);
          diskHash = hashContent(new Uint8Array(content));
        } catch {
          continue; // Can't read, skip
        }
      }

      const decision = reconcileFile({
        onDisk,
        diskHash,
        inDb: !!dbEntry,
        dbVersion: dbEntry?.version,
        dbOrigin: dbEntry?.origin ?? 'synced',
        dbHash: dbEntry?.contentHash,
        onServer: !!remoteEntry,
        serverVersion: remoteEntry?.version,
      });

      try {
        switch (decision.action) {
          case 'upload':
            await this.uploadFile(path, diskHash!, result);
            break;
          case 'download':
            await this.downloadFile(path, result);
            break;
          case 'conflict':
            await this.handleConflict(path, result);
            break;
          case 'delete_local':
            await this.deleteLocalFile(path, result);
            break;
          case 'delete_remote':
            await this.deleteRemoteFile(path, result);
            break;
          case 'cleanup_db':
            this.stateDb!.removeFile(path);
            break;
          case 'none':
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.stateDb?.addSyncLog('error', path, message);
        console.error(`[sync] Error processing ${path}: ${message}`);
        result.errors.push({ path, error: message });
      }
    }

    // Establish cursor by fetching changes(0) to get the latest cursor value
    const { cursor: newCursor } = await this.client.getChanges(0);
    this.stateDb.setLastCursor(newCursor);
  }

  /**
   * Incremental sync: Process the server change log since last cursor,
   * then push local changes and detect local deletions.
   */
  private async incrementalSync(cursor: number, result: SyncResult): Promise<void> {
    if (!this.stateDb) return;

    // Step 1: Process server changes since last cursor
    const { changes, cursor: newCursor } = await this.client.getChanges(cursor);

    for (const change of changes) {
      try {
        if (change.action === 'updated') {
          await this.downloadFile(change.path, result);
        } else if (change.action === 'deleted') {
          // Delete local vault file (with suppression), remove from DB
          const existing = this.stateDb.getFile(change.path);
          this.stateDb.removeFile(change.path);
          this.stateDb.recordDeletion(change.path, existing?.version ?? 0, 'remote');

          try {
            const absolutePath = join(this.config.vault.path, change.path);
            this.suppressedPaths.add(change.path);
            await unlink(absolutePath);
          } catch {
            this.suppressedPaths.delete(change.path);
          }

          this.stateDb.addSyncLog('delete', change.path, 'Remote file deleted (changelog)');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.stateDb?.addSyncLog('error', change.path, message);
        console.error(`[sync] Error processing change ${change.path}: ${message}`);
        result.errors.push({ path: change.path, error: message });
      }
    }

    this.stateDb.setLastCursor(newCursor);

    // Step 1b: Consistency check — catch files where DB version is behind server.
    // This handles cases where a change log entry was missed (e.g., cursor was set
    // past it during first sync, or the entry was created before the changes table existed).
    try {
      const remoteFiles = await this.client.listRemoteFiles();
      const dbFiles = this.stateDb.getAllFiles();
      const dbMap = new Map(dbFiles.map((f) => [f.path, f]));

      for (const remote of remoteFiles) {
        const local = dbMap.get(remote.path);
        if (local && local.version < remote.version) {
          await this.downloadFile(remote.path, result);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sync] Consistency check error: ${message}`);
    }

    // Step 2: Push local changes
    const localDiskFiles = await this.discoverLocalFiles(this.config.vault.path, this.config.vault.path);

    for (const filePath of localDiskFiles) {
      if (filePath.endsWith('.conflict.md')) continue;

      // Skip recently deleted files (prevents re-uploading after remote delete)
      if (this.stateDb.isRecentDeletion(filePath)) continue;

      try {
        const absolutePath = join(this.config.vault.path, filePath);
        const content = await readFile(absolutePath);
        const contentBytes = new Uint8Array(content);
        const contentHash = hashContent(contentBytes);

        const tracked = this.stateDb.getFile(filePath);

        // Skip if tracked and hash unchanged
        if (tracked && tracked.contentHash === contentHash) continue;

        // New or modified file — upload it
        const fileKey = deriveKeyForPath(this.vaultKey, filePath);
        const encrypted = encryptFile(contentBytes, fileKey);
        const encryptedHash = hashContent(encrypted);

        const currentVersion = tracked?.version ?? 0;
        const uploadResult = await this.client.uploadFile(
          filePath,
          encrypted,
          encryptedHash,
          currentVersion,
        );

        this.stateDb.upsertFile({
          id: tracked?.id ?? randomUUID(),
          path: filePath,
          contentHash,
          encryptedHash,
          version: uploadResult.version,
          size: contentBytes.length,
          syncState: 'synced',
          lastModified: Date.now(),
          origin: 'synced',
        });
        this.stateDb.addSyncLog('upload', filePath);
        result.uploaded.push(filePath);
      } catch (err) {
        if (err instanceof ConflictError) {
          result.conflicts.push(filePath);
          const tracked = this.stateDb.getFile(filePath);
          if (tracked) this.stateDb.markConflict(filePath);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.stateDb?.addSyncLog('error', filePath, message);
          console.error(`[sync] Error processing ${filePath}: ${message}`);
          result.errors.push({ path: filePath, error: message });
        }
      }
    }

    // Step 3: Detect local deletions
    const localDiskSet = new Set(localDiskFiles);
    const allDbFiles = this.stateDb.getAllFiles();

    for (const dbFile of allDbFiles) {
      if (localDiskSet.has(dbFile.path)) continue;

      // File is in DB but not on disk — local deletion
      const origin = dbFile.origin ?? 'synced';

      if (origin === 'synced') {
        // Was synced, user deleted locally — propagate to server
        this.stateDb.upsertFile({ ...dbFile, syncState: 'pending_delete' });
        try {
          await this.client.deleteFile(dbFile.path);
        } catch {
          // Server may be unreachable
        }
        this.stateDb.removeFile(dbFile.path);
        this.stateDb.recordDeletion(dbFile.path, dbFile.version, 'local');
        this.stateDb.addSyncLog('delete', dbFile.path, 'Local deletion propagated to server');
      } else {
        // origin='local' — never made it to server, just clean up DB
        this.stateDb.removeFile(dbFile.path);
        this.stateDb.addSyncLog('cleanup', dbFile.path, 'Removed stale local-only DB entry');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shared helpers for syncAll paths (full reconciliation & incremental)
  // ---------------------------------------------------------------------------

  /**
   * Upload a local file to the server. Used by full reconciliation.
   */
  private async uploadFile(path: string, contentHash: string, result: SyncResult): Promise<void> {
    if (!this.stateDb) return;

    const absolutePath = join(this.config.vault.path, path);
    const content = await readFile(absolutePath);
    const contentBytes = new Uint8Array(content);

    const fileKey = deriveKeyForPath(this.vaultKey, path);
    const encrypted = encryptFile(contentBytes, fileKey);
    const encryptedHash = hashContent(encrypted);

    const existing = this.stateDb.getFile(path);
    const currentVersion = existing?.version ?? 0;

    const uploadResult = await this.client.uploadFile(
      path,
      encrypted,
      encryptedHash,
      currentVersion,
    );

    this.stateDb.upsertFile({
      id: existing?.id ?? randomUUID(),
      path,
      contentHash,
      encryptedHash,
      version: uploadResult.version,
      size: contentBytes.length,
      syncState: 'synced',
      lastModified: Date.now(),
      origin: 'synced',
    });
    this.stateDb.addSyncLog('upload', path);
    result.uploaded.push(path);
  }

  /**
   * Download a file from the server to local vault. Used by both sync paths.
   */
  private async downloadFile(path: string, result: SyncResult): Promise<void> {
    if (!this.stateDb) return;

    const { data: encryptedData, version: remoteVersion, encryptedHash } =
      await this.client.downloadFile(path);

    const fileKey = deriveKeyForPath(this.vaultKey, path);
    const decrypted = decryptFile(encryptedData, fileKey);

    const absolutePath = join(this.config.vault.path, path);

    // Write remote version to vault (with suppression to avoid echo loop)
    await mkdir(dirname(absolutePath), { recursive: true });
    this.suppressedPaths.add(path);
    await writeFile(absolutePath, decrypted);

    // If this is an extra-path file, write back to original source
    if (this.extraPathsManager && path.startsWith('custom/')) {
      try {
        await this.extraPathsManager.writeBackToSource(path, decrypted);
      } catch {
        // Source location may not exist on this device
      }
    }

    // Clear any deletion tombstone — file is (back) on remote
    this.stateDb.removeDeletion(path);

    const contentHash = hashContent(decrypted);
    const existing = this.stateDb.getFile(path);
    this.stateDb.upsertFile({
      id: existing?.id ?? randomUUID(),
      path,
      contentHash,
      encryptedHash,
      version: remoteVersion,
      size: decrypted.length,
      syncState: 'synced',
      lastModified: Date.now(),
      origin: 'synced',
    });
    this.stateDb.addSyncLog('download', path);
    result.downloaded.push(path);
  }

  /**
   * Handle a conflict: download remote, save local as .conflict.md.
   * Used by full reconciliation.
   */
  private async handleConflict(path: string, result: SyncResult): Promise<void> {
    if (!this.stateDb) return;

    const absolutePath = join(this.config.vault.path, path);

    // Save local content as conflict file
    const localContent = await readFile(absolutePath);
    const conflictPath = absolutePath.replace(/\.md$/, '.conflict.md');
    await writeFile(conflictPath, localContent);

    // Download remote version
    await this.downloadFile(path, result);

    // Override sync state to 'conflict'
    this.stateDb.markConflict(path);
    this.stateDb.addSyncLog('conflict', path, 'Local changes saved as .conflict.md');
    result.conflicts.push(path);
    // Remove from downloaded since we're reporting it as a conflict
    const idx = result.downloaded.indexOf(path);
    if (idx !== -1) result.downloaded.splice(idx, 1);
  }

  /**
   * Delete a local file that was removed on the server. Used by full reconciliation.
   */
  private async deleteLocalFile(path: string, result: SyncResult): Promise<void> {
    if (!this.stateDb) return;

    const existing = this.stateDb.getFile(path);
    this.stateDb.removeFile(path);
    this.stateDb.recordDeletion(path, existing?.version ?? 0, 'remote');

    try {
      const absolutePath = join(this.config.vault.path, path);
      this.suppressedPaths.add(path);
      await unlink(absolutePath);
    } catch {
      this.suppressedPaths.delete(path);
    }

    this.stateDb.addSyncLog('delete', path, 'Deleted locally (remote deletion)');
  }

  /**
   * Delete a remote file that was removed locally. Used by full reconciliation.
   */
  private async deleteRemoteFile(path: string, result: SyncResult): Promise<void> {
    if (!this.stateDb) return;

    const existing = this.stateDb.getFile(path);
    this.stateDb.removeFile(path);
    this.stateDb.recordDeletion(path, existing?.version ?? 0, 'local');

    try {
      await this.client.deleteFile(path);
    } catch {
      // Server may be unreachable or file already gone
    }

    this.stateDb.addSyncLog('delete', path, 'Deleted remotely (local deletion)');
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

    // Download and write remote version (with suppression)
    const { data: encryptedData, version: remoteVersion, encryptedHash } =
      await this.client.downloadFile(relativePath);

    const fileKey = deriveKeyForPath(this.vaultKey, relativePath);
    const decrypted = decryptFile(encryptedData, fileKey);

    this.suppressedPaths.add(relativePath);
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
      origin: 'synced',
    });
    this.stateDb.addSyncLog('conflict', relativePath, 'Local changes saved as .conflict.md, remote version written');
  }
}
