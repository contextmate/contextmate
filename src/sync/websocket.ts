import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

interface FileUpdatedEvent {
  path: string;
  version: number;
}

interface FileDeletedEvent {
  path: string;
}

interface WsMessage {
  type: string;
  path?: string;
  version?: number;
}

export class SyncWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly token: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;

  private static readonly MAX_BACKOFF_MS = 30000;
  private static readonly HEARTBEAT_INTERVAL_MS = 30000;

  constructor(url: string, token: string) {
    super();
    this.url = url;
    this.token = token;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private doConnect(): void {
    const wsUrl = `${this.url}/ws?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit('connected');
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString()) as WsMessage;
        this.handleMessage(message);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', () => {
      // The 'close' event will follow, which handles reconnection
    });
  }

  private handleMessage(message: WsMessage): void {
    switch (message.type) {
      case 'file-updated':
        if (message.path !== undefined && message.version !== undefined) {
          const event: FileUpdatedEvent = { path: message.path, version: message.version };
          this.emit('file-updated', event);
        }
        break;
      case 'file-deleted':
        if (message.path !== undefined) {
          const event: FileDeletedEvent = { path: message.path };
          this.emit('file-deleted', event);
        }
        break;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      SyncWebSocket.MAX_BACKOFF_MS,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, SyncWebSocket.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
