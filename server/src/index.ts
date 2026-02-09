import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import path from 'node:path';
import { initDb } from './db.js';
import { authRoutes } from './routes/auth.js';
import { fileRoutes } from './routes/files.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { auditRoutes } from './routes/audit.js';
import { setupWebSocket } from './ws.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');

// Initialize database
initDb(DATA_DIR);

const app = new Hono();

// Middleware
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use('*', cors({
  origin: allowedOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Content-Hash', 'X-Version'],
  exposeHeaders: ['X-Version', 'X-Content-Hash'],
  maxAge: 86400,
}));
app.use('*', logger());

// Error handling
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/files', fileRoutes);
app.route('/api/keys', apiKeyRoutes);
app.route('/api/audit-log', auditRoutes);

// Start server with WebSocket support
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`ContextMate server listening on http://localhost:${info.port}`);
});

setupWebSocket(server as any);
