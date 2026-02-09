import Database from 'better-sqlite3';
import type { SyncFile, SyncState } from '../types.js';

export interface SyncLogEntry {
  id: number;
  action: string;
  path: string;
  timestamp: number;
  details: string | null;
}

export interface SyncLogOptions {
  action?: string;
  path?: string;
  since?: number;
  limit?: number;
  offset?: number;
}

export class SyncStateDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        content_hash TEXT NOT NULL,
        encrypted_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        sync_state TEXT NOT NULL DEFAULT 'pending',
        last_modified INTEGER NOT NULL,
        last_synced INTEGER
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        current INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        path TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        details TEXT
      );
    `);
  }

  getFile(path: string): SyncFile | null {
    const row = this.db.prepare(
      'SELECT id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified FROM files WHERE path = ?',
    ).get(path) as { id: string; path: string; content_hash: string; encrypted_hash: string; version: number; size: number; sync_state: SyncState; last_modified: number } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      path: row.path,
      contentHash: row.content_hash,
      encryptedHash: row.encrypted_hash,
      version: row.version,
      size: row.size,
      syncState: row.sync_state,
      lastModified: row.last_modified,
    };
  }

  upsertFile(file: SyncFile): void {
    this.db.prepare(`
      INSERT INTO files (id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content_hash = excluded.content_hash,
        encrypted_hash = excluded.encrypted_hash,
        version = excluded.version,
        size = excluded.size,
        sync_state = excluded.sync_state,
        last_modified = excluded.last_modified
    `).run(
      file.id,
      file.path,
      file.contentHash,
      file.encryptedHash,
      file.version,
      file.size,
      file.syncState,
      file.lastModified,
    );
  }

  getAllFiles(): SyncFile[] {
    const rows = this.db.prepare(
      'SELECT id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified FROM files',
    ).all() as Array<{ id: string; path: string; content_hash: string; encrypted_hash: string; version: number; size: number; sync_state: SyncState; last_modified: number }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      contentHash: row.content_hash,
      encryptedHash: row.encrypted_hash,
      version: row.version,
      size: row.size,
      syncState: row.sync_state,
      lastModified: row.last_modified,
    }));
  }

  getFilesByState(state: SyncState): SyncFile[] {
    const rows = this.db.prepare(
      'SELECT id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified FROM files WHERE sync_state = ?',
    ).all(state) as Array<{ id: string; path: string; content_hash: string; encrypted_hash: string; version: number; size: number; sync_state: SyncState; last_modified: number }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      contentHash: row.content_hash,
      encryptedHash: row.encrypted_hash,
      version: row.version,
      size: row.size,
      syncState: row.sync_state,
      lastModified: row.last_modified,
    }));
  }

  getModifiedFiles(): SyncFile[] {
    const rows = this.db.prepare(
      "SELECT id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified FROM files WHERE sync_state IN ('modified', 'pending')",
    ).all() as Array<{ id: string; path: string; content_hash: string; encrypted_hash: string; version: number; size: number; sync_state: SyncState; last_modified: number }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      contentHash: row.content_hash,
      encryptedHash: row.encrypted_hash,
      version: row.version,
      size: row.size,
      syncState: row.sync_state,
      lastModified: row.last_modified,
    }));
  }

  getConflicts(): SyncFile[] {
    return this.getFilesByState('conflict');
  }

  markSynced(path: string, version: number, encryptedHash: string): void {
    this.db.prepare(
      "UPDATE files SET sync_state = 'synced', version = ?, encrypted_hash = ?, last_synced = ? WHERE path = ?",
    ).run(version, encryptedHash, Date.now(), path);
  }

  markConflict(path: string): void {
    this.db.prepare(
      "UPDATE files SET sync_state = 'conflict' WHERE path = ?",
    ).run(path);
  }

  removeFile(path: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
  }

  addSyncLog(action: string, path: string, details?: string): void {
    this.db.prepare(
      'INSERT INTO sync_log (action, path, timestamp, details) VALUES (?, ?, ?, ?)',
    ).run(action, path, Date.now(), details ?? null);
  }

  getSyncLog(options: SyncLogOptions = {}): SyncLogEntry[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.action) {
      conditions.push('action = ?');
      params.push(options.action);
    }
    if (options.path) {
      conditions.push('path LIKE ?');
      params.push(options.path + '%');
    }
    if (options.since) {
      conditions.push('timestamp >= ?');
      params.push(options.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    return this.db.prepare(
      `SELECT id, action, path, timestamp, details FROM sync_log ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as SyncLogEntry[];
  }

  close(): void {
    this.db.close();
  }
}
