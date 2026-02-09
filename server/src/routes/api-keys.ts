import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { authMiddleware, getAuth } from '../middleware/auth.js';

export const apiKeyRoutes = new Hono();

apiKeyRoutes.use('*', authMiddleware);

// Create API key (JWT auth only)
apiKeyRoutes.post('/', async (c) => {
  const auth = getAuth(c);

  if (auth.authType !== 'jwt') {
    return c.json({ error: 'API key creation requires JWT authentication' }, 403);
  }

  const body = await c.req.json();
  const { name, scope, permissions } = body;

  if (!name || !scope) {
    return c.json({ error: 'name and scope are required' }, 400);
  }

  const validPermissions = ['read', 'write', 'readwrite'];
  const perm = permissions || 'read';
  if (!validPermissions.includes(perm)) {
    return c.json({ error: 'Invalid permissions value' }, 400);
  }

  const rawKey = 'cs_' + crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyId = crypto.randomUUID();
  const now = Date.now();

  const db = getDb();
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, key_hash, scope, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(keyId, auth.userId, name, keyHash, scope, perm, now);

  return c.json({
    id: keyId,
    key: rawKey,
    scope,
    permissions: perm,
  }, 201);
});

// List API keys
apiKeyRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const db = getDb();

  const keys = db.prepare(
    'SELECT id, name, scope, permissions, created_at as createdAt, revoked_at as revokedAt FROM api_keys WHERE user_id = ?'
  ).all(auth.userId);

  return c.json({ keys });
});

// Revoke API key
apiKeyRoutes.delete('/:id', async (c) => {
  const auth = getAuth(c);

  if (auth.authType !== 'jwt') {
    return c.json({ error: 'API key management requires JWT authentication' }, 403);
  }

  const keyId = c.req.param('id');
  const db = getDb();
  const now = Date.now();

  const result = db.prepare(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
  ).run(now, keyId, auth.userId);

  if (result.changes === 0) {
    return c.json({ error: 'API key not found or already revoked' }, 404);
  }

  return c.json({ ok: true });
});
