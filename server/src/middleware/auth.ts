import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.js';

function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // Auto-generate and persist for single-instance deploys
  const secretPath = path.join('data', 'jwt-secret.txt');
  try {
    return fs.readFileSync(secretPath, 'utf-8').trim();
  } catch {
    // File doesn't exist — generate a new secret
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    console.warn('[auth] No JWT_SECRET env var — auto-generated and saved to data/jwt-secret.txt');
    return secret;
  }
}

const JWT_SECRET: string = resolveJwtSecret();

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
