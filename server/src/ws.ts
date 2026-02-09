import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { verifyToken } from './middleware/auth.js';

interface TrackedConnection {
  ws: WebSocket;
  userId: string;
  deviceId?: string;
  alive: boolean;
}

const connections = new Map<string, Set<TrackedConnection>>();

export function broadcastToUser(userId: string, message: object, excludeDeviceId?: string): void {
  const userConns = connections.get(userId);
  if (!userConns) return;

  const data = JSON.stringify(message);
  for (const conn of userConns) {
    if (excludeDeviceId && conn.deviceId === excludeDeviceId) continue;
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }
}

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.destroy();
      return;
    }

    let payload: { userId: string };
    try {
      payload = verifyToken(token);
    } catch {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, payload);
    });
  });

  wss.on('connection', (ws: WebSocket, payload: { userId: string }) => {
    const tracked: TrackedConnection = {
      ws,
      userId: payload.userId,
      alive: true,
    };

    if (!connections.has(payload.userId)) {
      connections.set(payload.userId, new Set());
    }
    connections.get(payload.userId)!.add(tracked);

    ws.on('pong', () => {
      tracked.alive = true;
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'register-device' && msg.deviceId) {
          tracked.deviceId = msg.deviceId;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      const userConns = connections.get(payload.userId);
      if (userConns) {
        userConns.delete(tracked);
        if (userConns.size === 0) {
          connections.delete(payload.userId);
        }
      }
    });
  });

  // Heartbeat: ping every 30s, close stale after 60s
  const interval = setInterval(() => {
    for (const [, userConns] of connections) {
      for (const conn of userConns) {
        if (!conn.alive) {
          conn.ws.terminate();
          userConns.delete(conn);
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(interval);
  });
}
