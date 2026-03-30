import Database from 'better-sqlite3';
import type { FileOrigin, SyncFile, SyncState } from '../types.js';

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

      CREATE TABLE IF NOT EXISTS deletions (
        path TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Migrations
    try {
      this.db.exec("ALTER TABLE files ADD COLUMN origin TEXT NOT NULL DEFAULT 'synced'");
    } catch {
      // Column already exists
    }

    // Rename deletions table to deleted_files with new columns
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS deleted_files (
          path TEXT PRIMARY KEY,
          deleted_at INTEGER NOT NULL,
          deleted_version INTEGER NOT NULL DEFAULT 0,
          deleted_by TEXT NOT NULL DEFAULT 'local'
        );
        INSERT OR IGNORE INTO deleted_files (path, deleted_at)
          SELECT path, deleted_at FROM deletions;
      `);
    } catch {
      // Table already exists or deletions table doesn't exist
    }

    // Migrate sync_state values
    try {
      this.db.exec(`
        UPDATE files SET sync_state = 'pending_upload' WHERE sync_state = 'pending';
        UPDATE files SET sync_state = 'pending_upload' WHERE sync_state = 'modified';
        UPDATE files SET sync_state = 'pending_delete' WHERE sync_state = 'deleted';
      `);
    } catch {
      // Already migrated
    }
  }

  getFile(path: string): SyncFile | null {
    const row = this.db.prepare(
      'SELECT id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified, origin FROM files WHERE path = ?',
    ).get(path) as { id: string; path: string; content_hash: string; encrypted_hash: string; version: number; size: number; sync_state: SyncState; last_modified: number; origin: FileOrigin } | undefined;
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
      origin: row.origin ?? 'synced',
    };
  }

  upsertFile(file: SyncFile): void {
    this.db.prepare(`
      INSERT INTO files (id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content_hash = excluded.content_hash,
        encrypted_hash = excluded.encrypted_hash,
        version = excluded.version,
        size = excluded.size,
        sync_state = excluded.sync_state,
        last_modified = excluded.last_modified,
        origin = excluded.origin
    `).run(
      file.id,
      file.path,
      file.contentHash,
      file.encryptedHash,
      file.version,
      file.size,
      file.syncState,
      file.lastModified,
      file.origin ?? 'local',
    );
  }

  getAllFiles(): SyncFile[] {
    const rows = this.db.prepare(
      'SELECT id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified, origin FROM files',
    ).all() as Array<{ id: string; path: string; content_hash: string; encrypted_hash: string; version: number; size: number; sync_state: SyncState; last_modified: number; origin: FileOrigin }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      contentHash: row.content_hash,
      encryptedHash: row.encrypted_hash,
      version: row.version,
      size: row.size,
      syncState: row.sync_state,
      lastModified: row.last_modified,
      origin: row.origin ?? 'synced',
    }));
  }

  getFilesByState(state: SyncState): SyncFile[] {
    const rows = this.db.prepare(
      'SELECT id, path, content_hash, encrypted_hash, version, size, sync_state, last_modified, origin FROM files WHERE sync_state = ?',
    ).all(state) as Array<{ id: string; path: string; content_hash: string; encrypted_hash: string; version: number; size: number; sync_state: SyncState; last_modified: number; origin: FileOrigin }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      contentHash: row.content_hash,
      encryptedHash: row.encrypted_hash,
      version: row.version,
      size: row.size,
      syncState: row.sync_state,
      lastModified: row.last_modified,
      origin: row.origin ?? 'synced',
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

  addDeletion(path: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO deletions (path, deleted_at) VALUES (?, ?)',
    ).run(path, Date.now());
    this.db.prepare(
      "INSERT OR REPLACE INTO deleted_files (path, deleted_at, deleted_version, deleted_by) VALUES (?, ?, 0, 'local')",
    ).run(path, Date.now());
  }

  isDeletion(path: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM deletions WHERE path = ?').get(path)
      || !!this.db.prepare('SELECT 1 FROM deleted_files WHERE path = ?').get(path);
  }

  removeDeletion(path: string): void {
    this.db.prepare('DELETE FROM deletions WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM deleted_files WHERE path = ?').run(path);
  }

  clearDeletions(pattern?: string): number {
    // Clear from BOTH old (deletions) and new (deleted_files) tables
    let count = 0;
    if (pattern) {
      count += this.db.prepare('DELETE FROM deletions WHERE path LIKE ?').run(pattern + '%').changes;
      count += this.db.prepare('DELETE FROM deleted_files WHERE path LIKE ?').run(pattern + '%').changes;
    } else {
      count += this.db.prepare('DELETE FROM deletions').run().changes;
      count += this.db.prepare('DELETE FROM deleted_files').run().changes;
    }
    return count;
  }

  listDeletions(pattern?: string): Array<{ path: string; deletedAt: number }> {
    // List from BOTH old and new tables (deduplicated by path)
    const sql = pattern
      ? `SELECT path, deleted_at as deletedAt FROM deletions WHERE path LIKE ? UNION SELECT path, deleted_at as deletedAt FROM deleted_files WHERE path LIKE ? ORDER BY path`
      : 'SELECT path, deleted_at as deletedAt FROM deletions UNION SELECT path, deleted_at as deletedAt FROM deleted_files ORDER BY path';
    if (pattern) {
      return this.db.prepare(sql).all(pattern + '%', pattern + '%') as Array<{ path: string; deletedAt: number }>;
    }
    return this.db.prepare(sql).all() as Array<{ path: string; deletedAt: number }>;
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

  // Cursor management
  getLastCursor(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'last_cursor'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  setLastCursor(seq: number): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_cursor', ?)").run(String(seq));
  }

  // Deletion tracking (new table)
  recordDeletion(path: string, version: number = 0, deletedBy: string = 'local'): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO deleted_files (path, deleted_at, deleted_version, deleted_by) VALUES (?, ?, ?, ?)'
    ).run(path, Date.now(), version, deletedBy);
  }

  isRecentDeletion(path: string, maxAgeMs: number = 24 * 60 * 60 * 1000): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM deleted_files WHERE path = ? AND deleted_at > ?'
    ).get(path, Date.now() - maxAgeMs);
    return !!row;
  }

  expireDeletions(olderThan: number): number {
    return this.db.prepare('DELETE FROM deleted_files WHERE deleted_at < ?').run(olderThan).changes;
  }

  // Transaction wrapper
  transact<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
