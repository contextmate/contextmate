import { Hono } from 'hono';
import { authMiddleware, getAuth } from '../middleware/auth.js';
import { queryAudit } from '../audit.js';

export const auditRoutes = new Hono();

auditRoutes.use('*', authMiddleware);

auditRoutes.get('/', async (c) => {
  const auth = getAuth(c);

  const action = c.req.query('action');
  const path = c.req.query('path');
  const sinceRaw = c.req.query('since');
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');

  const since = sinceRaw ? Number(sinceRaw) : undefined;
  const limit = limitRaw ? Number(limitRaw) : 50;
  const offset = offsetRaw ? Number(offsetRaw) : 0;

  const entries = queryAudit(auth.userId, { action, path, since, limit, offset });

  return c.json({ entries });
});
