import { getDb } from './db.js';

export interface AuditEntry {
  id: number;
  action: string;
  path: string;
  version: number | null;
  size: number | null;
  timestamp: number;
  details: string | null;
}

export interface AuditQueryOptions {
  action?: string;
  path?: string;
  since?: number;
  limit?: number;
  offset?: number;
}

export function recordAudit(
  userId: string,
  action: string,
  path: string,
  options?: { version?: number; size?: number; details?: string },
): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO audit_log (user_id, action, path, version, size, timestamp, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    userId,
    action,
    path,
    options?.version ?? null,
    options?.size ?? null,
    Date.now(),
    options?.details ?? null,
  );
}

export function queryAudit(userId: string, options: AuditQueryOptions = {}): AuditEntry[] {
  const db = getDb();
  const conditions: string[] = ['user_id = ?'];
  const params: (string | number)[] = [userId];

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

  const where = conditions.join(' AND ');
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  return db.prepare(
    `SELECT id, action, path, version, size, timestamp, details FROM audit_log WHERE ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as AuditEntry[];
}
