import { Hono } from 'hono';
import crypto from 'node:crypto';
import path from 'node:path';
import { getDb } from '../db.js';
import { authMiddleware, getAuth, checkScope } from '../middleware/auth.js';
import { storeBlob, loadBlob, deleteBlob } from '../storage.js';
import { broadcastToUser } from '../ws.js';
import { recordAudit } from '../audit.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 10 * 1024 * 1024; // 10MB default

function isValidFilePath(filePath: string): boolean {
  // Reject path traversal attempts
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || normalized.includes('../') || path.isAbsolute(normalized)) {
    return false;
  }
  // Reject null bytes
  if (filePath.includes('\0')) {
    return false;
  }
  return true;
}

export const fileRoutes = new Hono();

fileRoutes.use('*', authMiddleware);

// List all file metadata
fileRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const db = getDb();

  let files = db.prepare(
    'SELECT path, version, encrypted_hash as encryptedHash, size, updated_at as updatedAt FROM files WHERE user_id = ?'
  ).all(auth.userId) as Array<{ path: string; version: number; encryptedHash: string; size: number; updatedAt: number }>;

  // Filter by scope if using API key
  if (auth.scope) {
    files = files.filter((f) => checkScope(auth.scope, f.path));
  }

  return c.json({ files });
});

// Get changes since timestamp
fileRoutes.get('/changes', async (c) => {
  const auth = getAuth(c);
  const since = Number(c.req.query('since') || '0');
  const db = getDb();

  let files = db.prepare(
    'SELECT path, version, encrypted_hash as encryptedHash, size, updated_at as updatedAt FROM files WHERE user_id = ? AND updated_at > ?'
  ).all(auth.userId, since) as Array<{ path: string; version: number; encryptedHash: string; size: number; updatedAt: number }>;

  if (auth.scope) {
    files = files.filter((f) => checkScope(auth.scope, f.path));
  }

  return c.json({ files });
});

// Upload file
fileRoutes.put('/*', async (c) => {
  const auth = getAuth(c);
  const filePath = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''));

  if (!filePath) {
    return c.json({ error: 'File path is required' }, 400);
  }

  if (!isValidFilePath(filePath)) {
    return c.json({ error: 'Invalid file path' }, 400);
  }

  // Check Content-Length before reading body
  const contentLength = Number(c.req.header('Content-Length') || '0');
  if (contentLength > MAX_UPLOAD_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE} bytes` }, 413);
  }

  // Check scope for API key
  if (auth.scope && !checkScope(auth.scope, filePath)) {
    return c.json({ error: 'Access denied: path outside API key scope' }, 403);
  }

  // Check write permission for API keys
  if (auth.authType === 'api-key' && auth.permissions !== 'write' && auth.permissions !== 'readwrite') {
    return c.json({ error: 'Write permission required' }, 403);
  }

  const encryptedHash = c.req.header('X-Content-Hash') || '';
  const expectedVersion = c.req.header('X-Version') ? Number(c.req.header('X-Version')) : undefined;

  const body = await c.req.arrayBuffer();
  const data = Buffer.from(body);

  // Double-check actual body size
  if (data.length > MAX_UPLOAD_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE} bytes` }, 413);
  }

  const db = getDb();
  const existing = db.prepare(
    'SELECT id, version FROM files WHERE user_id = ? AND path = ?'
  ).get(auth.userId, filePath) as { id: string; version: number } | undefined;

  const now = Date.now();

  if (existing) {
    // Atomic version check + update to prevent TOCTOU race condition
    if (expectedVersion !== undefined) {
      const result = db.prepare(
        'UPDATE files SET version = version + 1, encrypted_hash = ?, size = ?, updated_at = ? WHERE user_id = ? AND path = ? AND version = ?'
      ).run(encryptedHash, data.length, now, auth.userId, filePath, expectedVersion);

      if (result.changes === 0) {
        // Re-fetch to get current version for the error response
        const current = db.prepare(
          'SELECT version FROM files WHERE user_id = ? AND path = ?'
        ).get(auth.userId, filePath) as { version: number } | undefined;
        return c.json({
          error: 'Version conflict',
          currentVersion: current?.version,
          expectedVersion,
        }, 409);
      }
    } else {
      db.prepare(
        'UPDATE files SET version = version + 1, encrypted_hash = ?, size = ?, updated_at = ? WHERE user_id = ? AND path = ?'
      ).run(encryptedHash, data.length, now, auth.userId, filePath);
    }

    const updated = db.prepare(
      'SELECT version FROM files WHERE user_id = ? AND path = ?'
    ).get(auth.userId, filePath) as { version: number };

    await storeBlob(DATA_DIR, auth.userId, filePath, data);

    broadcastToUser(auth.userId, { type: 'file-updated', path: filePath, version: updated.version });

    recordAudit(auth.userId, 'upload', filePath, { version: updated.version, size: data.length });

    return c.json({ path: filePath, version: updated.version });
  } else {
    const fileId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO files (id, user_id, path, version, encrypted_hash, size, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)'
    ).run(fileId, auth.userId, filePath, encryptedHash, data.length, now, now);

    await storeBlob(DATA_DIR, auth.userId, filePath, data);

    broadcastToUser(auth.userId, { type: 'file-updated', path: filePath, version: 1 });

    recordAudit(auth.userId, 'upload', filePath, { version: 1, size: data.length });

    return c.json({ path: filePath, version: 1 }, 201);
  }
});

// Download file
fileRoutes.get('/*', async (c) => {
  const auth = getAuth(c);
  const filePath = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''));

  if (!filePath) {
    return c.json({ error: 'File path is required' }, 400);
  }

  if (!isValidFilePath(filePath)) {
    return c.json({ error: 'Invalid file path' }, 400);
  }

  if (auth.scope && !checkScope(auth.scope, filePath)) {
    return c.json({ error: 'Access denied: path outside API key scope' }, 403);
  }

  const db = getDb();
  const file = db.prepare(
    'SELECT id, version, encrypted_hash FROM files WHERE user_id = ? AND path = ?'
  ).get(auth.userId, filePath) as { id: string; version: number; encrypted_hash: string } | undefined;

  if (!file) {
    return c.json({ error: 'File not found' }, 404);
  }

  try {
    const data = await loadBlob(DATA_DIR, auth.userId, filePath);

    recordAudit(auth.userId, 'download', filePath);

    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Version': String(file.version),
        'X-Content-Hash': file.encrypted_hash,
      },
    });
  } catch {
    return c.json({ error: 'Blob not found' }, 404);
  }
});

// Delete file
fileRoutes.delete('/*', async (c) => {
  const auth = getAuth(c);
  const filePath = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''));

  if (!filePath) {
    return c.json({ error: 'File path is required' }, 400);
  }

  if (!isValidFilePath(filePath)) {
    return c.json({ error: 'Invalid file path' }, 400);
  }

  if (auth.scope && !checkScope(auth.scope, filePath)) {
    return c.json({ error: 'Access denied: path outside API key scope' }, 403);
  }

  if (auth.authType === 'api-key' && auth.permissions !== 'write' && auth.permissions !== 'readwrite') {
    return c.json({ error: 'Write permission required' }, 403);
  }

  const db = getDb();
  const result = db.prepare(
    'DELETE FROM files WHERE user_id = ? AND path = ?'
  ).run(auth.userId, filePath);

  if (result.changes === 0) {
    return c.json({ error: 'File not found' }, 404);
  }

  try {
    await deleteBlob(DATA_DIR, auth.userId, filePath);
  } catch {
    // Blob may already be missing
  }

  broadcastToUser(auth.userId, { type: 'file-deleted', path: filePath });

  recordAudit(auth.userId, 'delete', filePath);

  return c.json({ ok: true });
});
