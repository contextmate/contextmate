import type { FileOrigin } from '../types.js';

export interface ReconcileInput {
  onDisk: boolean;
  diskHash?: string;
  inDb: boolean;
  dbVersion?: number;
  dbOrigin?: FileOrigin;
  dbHash?: string;
  onServer: boolean;
  serverVersion?: number;
}

export type ReconcileAction =
  | { action: 'upload' }
  | { action: 'download' }
  | { action: 'conflict' }
  | { action: 'delete_local' }
  | { action: 'delete_remote' }
  | { action: 'cleanup_db' }
  | { action: 'none' };

/**
 * Pure reconciliation function. Given the state of a file across three sources
 * (disk, local DB, remote server), determines the correct action.
 *
 * This is the core decision logic for bidirectional sync. It uses origin tracking
 * to distinguish "file not yet synced" from "file was deleted."
 */
export function reconcileFile(input: ReconcileInput): ReconcileAction {
  const { onDisk, diskHash, inDb, dbVersion, dbOrigin, dbHash, onServer, serverVersion } = input;

  // Case: File exists everywhere — check for changes
  if (onDisk && inDb && onServer) {
    const localChanged = diskHash !== dbHash;
    const remoteChanged = (serverVersion ?? 0) > (dbVersion ?? 0);

    if (localChanged && remoteChanged) return { action: 'conflict' };
    if (localChanged) return { action: 'upload' };
    if (remoteChanged) return { action: 'download' };
    return { action: 'none' };
  }

  // Case: On disk + in DB, NOT on server
  if (onDisk && inDb && !onServer) {
    if (dbOrigin === 'synced') {
      // Was previously synced, now gone from server → remote deletion
      return { action: 'delete_local' };
    }
    // origin='local' — never successfully uploaded, try again
    return { action: 'upload' };
  }

  // Case: On disk only (not in DB, not on server) → new local file
  if (onDisk && !inDb && !onServer) {
    return { action: 'upload' };
  }

  // Case: On disk + on server, NOT in DB → server has it, download to establish baseline
  if (onDisk && !inDb && onServer) {
    return { action: 'download' };
  }

  // Case: In DB + on server, NOT on disk → local deletion
  if (!onDisk && inDb && onServer) {
    if (dbOrigin === 'synced') {
      return { action: 'delete_remote' };
    }
    // origin='remote' or 'local' without disk file → re-download
    return { action: 'download' };
  }

  // Case: In DB only (not on disk, not on server) → stale record
  if (!onDisk && inDb && !onServer) {
    return { action: 'cleanup_db' };
  }

  // Case: On server only (not on disk, not in DB) → new remote file
  if (!onDisk && !inDb && onServer) {
    return { action: 'download' };
  }

  // Case: Nothing exists anywhere — shouldn't happen, but no-op
  return { action: 'none' };
}
