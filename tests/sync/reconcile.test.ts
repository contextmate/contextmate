import { describe, it, expect } from 'vitest';
import { reconcileFile } from '../../src/sync/reconcile.js';

describe('reconcileFile', () => {
  it('uploads new local file (on disk, not in DB, not on server)', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'abc',
      inDb: false,
      onServer: false,
    });
    expect(action).toEqual({ action: 'upload' });
  });

  it('downloads new remote file (not on disk, not in DB, on server)', () => {
    const action = reconcileFile({
      onDisk: false,
      inDb: false,
      onServer: true, serverVersion: 1,
    });
    expect(action).toEqual({ action: 'download' });
  });

  it('does nothing when all in sync', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'abc',
      inDb: true, dbVersion: 1, dbOrigin: 'synced', dbHash: 'abc',
      onServer: true, serverVersion: 1,
    });
    expect(action).toEqual({ action: 'none' });
  });

  it('downloads when server has newer version', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'abc',
      inDb: true, dbVersion: 1, dbOrigin: 'synced', dbHash: 'abc',
      onServer: true, serverVersion: 3,
    });
    expect(action).toEqual({ action: 'download' });
  });

  it('uploads when local content changed', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'xyz',
      inDb: true, dbVersion: 1, dbOrigin: 'synced', dbHash: 'abc',
      onServer: true, serverVersion: 1,
    });
    expect(action).toEqual({ action: 'upload' });
  });

  it('detects conflict when both changed', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'xyz',
      inDb: true, dbVersion: 1, dbOrigin: 'synced', dbHash: 'abc',
      onServer: true, serverVersion: 3,
    });
    expect(action).toEqual({ action: 'conflict' });
  });

  it('marks local deletion when file removed from disk but synced', () => {
    const action = reconcileFile({
      onDisk: false,
      inDb: true, dbVersion: 1, dbOrigin: 'synced', dbHash: 'abc',
      onServer: true, serverVersion: 1,
    });
    expect(action).toEqual({ action: 'delete_remote' });
  });

  it('cleans up DB when both sides deleted', () => {
    const action = reconcileFile({
      onDisk: false,
      inDb: true, dbVersion: 1, dbOrigin: 'synced', dbHash: 'abc',
      onServer: false,
    });
    expect(action).toEqual({ action: 'cleanup_db' });
  });

  it('deletes local when remote deleted (synced file gone from server)', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'abc',
      inDb: true, dbVersion: 1, dbOrigin: 'synced', dbHash: 'abc',
      onServer: false,
    });
    expect(action).toEqual({ action: 'delete_local' });
  });

  it('does NOT delete pending upload (origin=local, not on server)', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'abc',
      inDb: true, dbVersion: 0, dbOrigin: 'local', dbHash: 'abc',
      onServer: false,
    });
    expect(action).toEqual({ action: 'upload' });
  });

  it('cleans up failed upload (origin=local, not on disk, not on server)', () => {
    const action = reconcileFile({
      onDisk: false,
      inDb: true, dbVersion: 0, dbOrigin: 'local', dbHash: 'abc',
      onServer: false,
    });
    expect(action).toEqual({ action: 'cleanup_db' });
  });

  it('skips upload for new local file that exists on server (download instead)', () => {
    const action = reconcileFile({
      onDisk: true, diskHash: 'abc',
      inDb: false,
      onServer: true, serverVersion: 1,
    });
    expect(action).toEqual({ action: 'download' });
  });
});
