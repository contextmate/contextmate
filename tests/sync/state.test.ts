import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncStateDB } from '../../src/sync/state.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncFile } from '../../src/types.js';

let tmpDir: string;
let db: SyncStateDB;

function makeSyncFile(overrides: Partial<SyncFile> = {}): SyncFile {
  return {
    id: 'file-1',
    path: 'test/file.md',
    contentHash: 'abc123',
    encryptedHash: 'def456',
    version: 1,
    size: 100,
    lastModified: Date.now(),
    syncState: 'pending',
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'contextmate-state-test-'));
  db = new SyncStateDB(join(tmpDir, 'state.db'));
});

afterEach(async () => {
  db.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SyncStateDB', () => {
  it('creates and opens database', () => {
    expect(db).toBeDefined();
  });

  it('upsertFile and getFile round-trip', () => {
    const file = makeSyncFile();
    db.upsertFile(file);
    const retrieved = db.getFile('test/file.md');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('file-1');
    expect(retrieved!.path).toBe('test/file.md');
    expect(retrieved!.contentHash).toBe('abc123');
    expect(retrieved!.encryptedHash).toBe('def456');
    expect(retrieved!.version).toBe(1);
    expect(retrieved!.size).toBe(100);
    expect(retrieved!.syncState).toBe('pending');
  });

  it('getAllFiles returns all inserted files', () => {
    db.upsertFile(makeSyncFile({ id: 'f1', path: 'a.md' }));
    db.upsertFile(makeSyncFile({ id: 'f2', path: 'b.md' }));
    db.upsertFile(makeSyncFile({ id: 'f3', path: 'c.md' }));
    const all = db.getAllFiles();
    expect(all.length).toBe(3);
  });

  it('getFilesByState returns correct subset', () => {
    db.upsertFile(makeSyncFile({ id: 'f1', path: 'a.md', syncState: 'pending' }));
    db.upsertFile(makeSyncFile({ id: 'f2', path: 'b.md', syncState: 'synced' }));
    db.upsertFile(makeSyncFile({ id: 'f3', path: 'c.md', syncState: 'pending' }));
    const pending = db.getFilesByState('pending');
    expect(pending.length).toBe(2);
    expect(pending.every((f) => f.syncState === 'pending')).toBe(true);
  });

  it('getModifiedFiles returns modified and pending files', () => {
    db.upsertFile(makeSyncFile({ id: 'f1', path: 'a.md', syncState: 'modified' }));
    db.upsertFile(makeSyncFile({ id: 'f2', path: 'b.md', syncState: 'synced' }));
    db.upsertFile(makeSyncFile({ id: 'f3', path: 'c.md', syncState: 'pending' }));
    const modified = db.getModifiedFiles();
    expect(modified.length).toBe(2);
    const states = modified.map((f) => f.syncState);
    expect(states).toContain('modified');
    expect(states).toContain('pending');
  });

  it('markSynced updates state correctly', () => {
    db.upsertFile(makeSyncFile({ id: 'f1', path: 'a.md', syncState: 'pending' }));
    db.markSynced('a.md', 2, 'new-enc-hash');
    const file = db.getFile('a.md');
    expect(file!.syncState).toBe('synced');
    expect(file!.version).toBe(2);
    expect(file!.encryptedHash).toBe('new-enc-hash');
  });

  it('markConflict changes state to conflict', () => {
    db.upsertFile(makeSyncFile({ id: 'f1', path: 'a.md', syncState: 'synced' }));
    db.markConflict('a.md');
    const file = db.getFile('a.md');
    expect(file!.syncState).toBe('conflict');
  });

  it('getConflicts returns conflict files', () => {
    db.upsertFile(makeSyncFile({ id: 'f1', path: 'a.md', syncState: 'conflict' }));
    db.upsertFile(makeSyncFile({ id: 'f2', path: 'b.md', syncState: 'synced' }));
    db.upsertFile(makeSyncFile({ id: 'f3', path: 'c.md', syncState: 'conflict' }));
    const conflicts = db.getConflicts();
    expect(conflicts.length).toBe(2);
    expect(conflicts.every((f) => f.syncState === 'conflict')).toBe(true);
  });

  it('removeFile deletes from database', () => {
    db.upsertFile(makeSyncFile({ id: 'f1', path: 'a.md' }));
    expect(db.getFile('a.md')).not.toBeNull();
    db.removeFile('a.md');
    expect(db.getFile('a.md')).toBeNull();
  });

  it('addSyncLog creates log entry', () => {
    // Should not throw
    db.addSyncLog('upload', 'test/file.md', 'uploaded successfully');
    db.addSyncLog('download', 'test/other.md');
  });

  it('getSyncLog returns all entries in reverse id order', () => {
    db.addSyncLog('upload', 'a.md', 'first');
    db.addSyncLog('download', 'b.md', 'second');
    db.addSyncLog('error', 'c.md', 'third');
    const entries = db.getSyncLog();
    expect(entries.length).toBe(3);
    // Most recent (highest id) comes first
    expect(entries[0].id).toBeGreaterThan(entries[1].id);
    expect(entries[1].id).toBeGreaterThan(entries[2].id);
  });

  it('getSyncLog filters by action', () => {
    db.addSyncLog('upload', 'a.md');
    db.addSyncLog('download', 'b.md');
    db.addSyncLog('upload', 'c.md');
    const uploads = db.getSyncLog({ action: 'upload' });
    expect(uploads.length).toBe(2);
    expect(uploads.every((e) => e.action === 'upload')).toBe(true);
  });

  it('getSyncLog filters by path prefix', () => {
    db.addSyncLog('upload', 'claude/memory.md');
    db.addSyncLog('upload', 'openclaw/skill.md');
    db.addSyncLog('upload', 'claude/rules.md');
    const claude = db.getSyncLog({ path: 'claude/' });
    expect(claude.length).toBe(2);
    expect(claude.every((e) => e.path.startsWith('claude/'))).toBe(true);
  });

  it('getSyncLog respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      db.addSyncLog('upload', `file${i}.md`);
    }
    const page1 = db.getSyncLog({ limit: 3 });
    expect(page1.length).toBe(3);
    const page2 = db.getSyncLog({ limit: 3, offset: 3 });
    expect(page2.length).toBe(3);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it('getSyncLog filters by since timestamp', async () => {
    db.addSyncLog('upload', 'old.md');
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    db.addSyncLog('upload', 'new.md');
    const recent = db.getSyncLog({ since: cutoff });
    expect(recent.length).toBe(1);
    expect(recent[0].path).toBe('new.md');
  });

  it('close closes database without error', () => {
    const tmpDb = new SyncStateDB(join(tmpDir, 'close-test.db'));
    expect(() => tmpDb.close()).not.toThrow();
  });
});
