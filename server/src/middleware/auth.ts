import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { getDb } from '../db.js';

const JWT_SECRET: string = process.env.JWT_SECRET ?? (() => {
  throw new Error('JWT_SECRET environment variable is required. Generate one with: openssl rand -base64 32');
})();

export interface AuthContext {
  userId: string;
  scope?: string;
  permissions?: string;
  authType: 'jwt' | 'api-key';
}

export function signToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyToken(token: string): { userId: string } {
  return jwt.verify(token, JWT_SECRET) as { userId: string };
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = verifyToken(token);
      c.set('auth', {
        userId: payload.userId,
        authType: 'jwt',
      } satisfies AuthContext);
      return next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  }

  if (apiKeyHeader) {
    const keyHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex');
    const db = getDb();
    const row = db.prepare(
      'SELECT id, user_id, scope, permissions FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
    ).get(keyHash) as { id: string; user_id: string; scope: string; permissions: string } | undefined;

    if (!row) {
      return c.json({ error: 'Invalid or revoked API key' }, 401);
    }

    c.set('auth', {
      userId: row.user_id,
      scope: row.scope,
      permissions: row.permissions,
      authType: 'api-key',
    } satisfies AuthContext);
    return next();
  }

  return c.json({ error: 'Authentication required' }, 401);
}

export function getAuth(c: Context): AuthContext {
  return c.get('auth') as AuthContext;
}

export function checkScope(scope: string | undefined, filePath: string): boolean {
  if (!scope || scope === '*') return true;
  // scope like "skills/*" should match "skills/foo" and "skills/bar/baz"
  if (scope.endsWith('/*')) {
    const prefix = scope.slice(0, -1); // "skills/"
    return filePath.startsWith(prefix);
  }
  return filePath === scope;
}
