import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { authMiddleware, getAuth, signToken } from '../middleware/auth.js';

// In-memory rate limiter
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 10; // max attempts per window

function checkRateLimit(key: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true };
}

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

export const authRoutes = new Hono();

// Get salt for a user by userId (public endpoint for web dashboard login)
authRoutes.get('/salt/:userId', async (c) => {
  const userId = c.req.param('userId');
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  const { allowed, retryAfterMs } = checkRateLimit(`salt:${ip}`);
  if (!allowed) {
    return c.json({ error: 'Too many requests', retryAfterMs }, 429);
  }

  const db = getDb();
  const user = db.prepare('SELECT salt FROM users WHERE id = ?').get(userId) as
    | { salt: string }
    | undefined;

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({ salt: user.salt });
});

// Register a new user
authRoutes.post('/register', async (c) => {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  const { allowed, retryAfterMs } = checkRateLimit(`register:${ip}`);
  if (!allowed) {
    return c.json({ error: 'Too many requests', retryAfterMs }, 429);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { authKeyHash, salt, encryptedMasterKey } = body;

  if (!authKeyHash || !salt || !encryptedMasterKey) {
    return c.json({ error: 'authKeyHash, salt, and encryptedMasterKey are required' }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE auth_key_hash = ?').get(authKeyHash);
  if (existing) {
    return c.json({ error: 'User already exists' }, 409);
  }

  const userId = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    'INSERT INTO users (id, auth_key_hash, salt, encrypted_master_key, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, authKeyHash, salt, encryptedMasterKey, now);

  const token = signToken(userId);
  return c.json({ userId, token }, 201);
});

// Login
authRoutes.post('/login', async (c) => {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  const { allowed, retryAfterMs } = checkRateLimit(`login:${ip}`);
  if (!allowed) {
    return c.json({ error: 'Too many requests', retryAfterMs }, 429);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { authKeyHash } = body;

  if (!authKeyHash) {
    return c.json({ error: 'authKeyHash is required' }, 400);
  }

  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE auth_key_hash = ?').get(authKeyHash) as
    | { id: string }
    | undefined;

  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = signToken(user.id);
  return c.json({ userId: user.id, token });
});

// Register device (auth required)
authRoutes.post('/devices', authMiddleware, async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json();
  const { name, publicKey } = body;

  if (!name || !publicKey) {
    return c.json({ error: 'name and publicKey are required' }, 400);
  }

  const db = getDb();
  const deviceId = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    'INSERT INTO devices (id, user_id, name, public_key, last_seen) VALUES (?, ?, ?, ?, ?)'
  ).run(deviceId, auth.userId, name, publicKey, now);

  return c.json({ deviceId }, 201);
});

// List devices (auth required)
authRoutes.get('/devices', authMiddleware, async (c) => {
  const auth = getAuth(c);
  const db = getDb();

  const devices = db.prepare(
    'SELECT id, name, public_key as publicKey, last_seen as lastSeen FROM devices WHERE user_id = ?'
  ).all(auth.userId);

  return c.json({ devices });
});

// Delete device (auth required)
authRoutes.delete('/devices/:id', authMiddleware, async (c) => {
  const auth = getAuth(c);
  const deviceId = c.req.param('id');
  const db = getDb();

  const result = db.prepare(
    'DELETE FROM devices WHERE id = ? AND user_id = ?'
  ).run(deviceId, auth.userId);

  if (result.changes === 0) {
    return c.json({ error: 'Device not found' }, 404);
  }

  return c.json({ ok: true });
});
