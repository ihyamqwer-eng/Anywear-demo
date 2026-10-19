import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import WebSocketClient from 'ws';
import { config } from './config.js';
import { ProviderKeyPool } from './provider-key-pool.js';

const MAX_UPSTREAM_QUEUE_MESSAGES = 256;
const MAX_UPSTREAM_QUEUE_BYTES = 15 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

export type SessionState =
  | 'idle'
  | 'camera_ready'
  | 'signaling'
  | 'connected'
  | 'generating'
  | 'switching'
  | 'stopping'
  | 'error';

interface Session {
  id: string;
  state: SessionState;
  createdAt: number;
  expiresAt: number;
  usageSeconds: number;
  providerKeyId: string;
  providerApiKey: string;
  providerSessionId?: string;
  client?: WebSocket;
  upstream?: WebSocketClient;
  upstreamQueue: string[];
  upstreamQueueBytes: number;
  upstreamConnectTimer?: NodeJS.Timeout;
  stopTimer: NodeJS.Timeout;
  heartbeatTimer: NodeJS.Timeout;
  lastClientHeartbeatAt: number;
  stopped: boolean;
  failureReported: boolean;
}

export interface SessionView {
  sessionId: string;
  state: SessionState;
  createdAt: string;
  expiresAt: string;
  usageSeconds: number;
  providerSessionId?: string;
}

const allowedProviderMessages = new Set([
  'offer',
  'ice-candidate',
  'prompt',
  'set_image',
]);

function isOpen(socket: WebSocket | WebSocketClient | undefined): boolean {
  return socket?.readyState === WebSocketClient.OPEN;
}

function safeSend(socket: WebSocket | WebSocketClient | undefined, payload: unknown): void {
  if (socket && isOpen(socket)) {
    socket.send(JSON.stringify(payload));
  }
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length > 14_000_000 || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentLength = value.length - padding;

  for (let index = 0; index < contentLength; index += 1) {
    const character = value.charCodeAt(index);
    const isLetter = (character >= 65 && character <= 90) || (character >= 97 && character <= 122);
    const isDigit = character >= 48 && character <= 57;
    if (!isLetter && !isDigit && character !== 43 && character !== 47) return false;
  }

  return true;
}

function closeSocket(socket: WebSocket | WebSocketClient | undefined, code = 1000, reason = 'closed'): void {
  if (!socket) return;
  try {
    if (isOpen(socket)) socket.close(code, reason);
    else socket.terminate();
  } catch {
    socket.terminate();
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly providerKeyPool: ProviderKeyPool) {}

  create(): SessionView | null {
    const keyLease = this.providerKeyPool.acquire();
    if (!keyLease) return null;
    const now = Date.now();
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      state: 'idle',
      createdAt: now,
      expiresAt: now + config.sessionTtlSeconds * 1000,
      usageSeconds: 0,
      providerKeyId: keyLease.id,
      providerApiKey: keyLease.value,
      upstreamQueue: [],
      upstreamQueueBytes: 0,
      stopTimer: setTimeout(() => void this.stop(id, 'session_ttl'), config.sessionTtlSeconds * 1000),
      heartbeatTimer: setInterval(() => this.checkHeartbeat(id), 15_000),
      lastClientHeartbeatAt: now,
      stopped: false,
      failureReported: false,
    };
    this.sessions.set(id, session);
    return this.view(session);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  view(session: Session): SessionView {
    return {
      sessionId: session.id,
      state: session.state,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      usageSeconds: session.usageSeconds,
      providerSessionId: session.providerSessionId,
    };
  }

  attachClient(id: string, client: WebSocket): boolean {
    const session = this.sessions.get(id);
    if (!session || session.stopped || session.client) return false;
    session.client = client;
    session.state = 'signaling';
    session.lastClientHeartbeatAt = Date.now();
    return true;
  }

  async connectUpstream(id: string): Promise<void> {
    const session = this.require(id);
    const query = new URLSearchParams({ api_key: session.providerApiKey, model: config.model });
    if (config.speed === 'fast') query.set('speed', 'fast');

    const upstream = new WebSocketClient(`${config.upstreamOrigin}?${query.toString()}`);
    session.upstream = upstream;
    session.upstreamConnectTimer = setTimeout(() => {
      const current = this.sessions.get(id);
      if (!current || current.stopped || current.upstream !== upstream || upstream.readyState !== WebSocketClient.CONNECTING) return;
      safeSend(current.client, { type: 'error', error: 'Provider connection timed out' });
      void this.stop(id, 'provider_connect_timeout');
    }, 20_000);

    upstream.on('open', () => {
      const current = this.sessions.get(id);
      if (!current || current.stopped) return;
      if (current.upstreamConnectTimer) clearTimeout(current.upstreamConnectTimer);
      const queuedMessages = current.upstreamQueue.splice(0);
      current.upstreamQueueBytes = 0;
      for (const message of queuedMessages) upstream.send(message);
      safeSend(current.client, { type: 'proxy_ready' });
    });

    upstream.on('message', (raw) => this.handleUpstreamMessage(id, raw.toString()));
    upstream.on('error', (error) => {
      const current = this.sessions.get(id);
      if (!current || current.stopped) return;
      this.markProviderFailure(current);
      current.state = 'error';
      safeSend(current.client, { type: 'error', error: error.message || 'Provider connection failed' });
      void this.stop(id, 'provider_error');
    });
    upstream.on('close', () => {
      const current = this.sessions.get(id);
      if (!current || current.stopped) return;
      this.markProviderFailure(current);
      current.state = current.state === 'stopping' ? 'stopping' : 'error';
      safeSend(current.client, { type: 'provider_closed' });
      void this.stop(id, 'provider_closed');
    });
  }

  handleClientMessage(id: string, raw: string): void {
    const session = this.require(id);
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      safeSend(session.client, { type: 'error', error: 'Invalid JSON message' });
      return;
    }

    if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') {
      safeSend(session.client, { type: 'error', error: 'Message type is required' });
      return;
    }

    if (message.type === 'heartbeat') {
      session.lastClientHeartbeatAt = Date.now();
      safeSend(session.client, { type: 'heartbeat_ack' });
      return;
    }

    if (!allowedProviderMessages.has(message.type)) {
      safeSend(session.client, { type: 'error', error: `Unsupported message type: ${message.type}` });
      return;
    }

    if (message.type === 'prompt' && (!('prompt' in message) || typeof message.prompt !== 'string' || message.prompt.length > 2000)) {
      safeSend(session.client, { type: 'error', error: 'Prompt is missing or too long' });
      return;
    }

    if (message.type === 'set_image') {
      if (!('image_data' in message)) {
        safeSend(session.client, { type: 'error', error: 'Reference image is required' });
        return;
      }
      const imageData = message.image_data;
      if (typeof imageData !== 'string' || !isBase64(imageData)) {
        safeSend(session.client, { type: 'error', error: 'Reference image must be base64 encoded' });
        return;
      }
      const paddingBytes = imageData.endsWith('==') ? 2 : imageData.endsWith('=') ? 1 : 0;
      const decodedBytes = imageData.length * 3 / 4 - paddingBytes;
      if (decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
        safeSend(session.client, { type: 'error', error: 'Reference image is too large' });
        return;
      }
      session.state = 'switching';
    }

    const serialized = JSON.stringify(message);
    if (isOpen(session.upstream)) session.upstream?.send(serialized);
    else {
      const messageBytes = Buffer.byteLength(serialized);
      if (session.upstreamQueue.length < MAX_UPSTREAM_QUEUE_MESSAGES
        && session.upstreamQueueBytes + messageBytes <= MAX_UPSTREAM_QUEUE_BYTES) {
        session.upstreamQueue.push(serialized);
        session.upstreamQueueBytes += messageBytes;
        return;
      }

      safeSend(session.client, { type: 'error', error: 'Signaling queue capacity exceeded' });
      void this.stop(id, 'signaling_queue_capacity_exceeded');
    }
  }

  markClientDisconnected(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.stopped) return;
    session.client = undefined;
    void this.stop(id, 'client_disconnected');
  }

  async stop(id: string, reason: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.stopped) return;
    session.stopped = true;
    session.state = 'stopping';
    this.providerKeyPool.release(session.providerKeyId);
    clearTimeout(session.stopTimer);
    clearInterval(session.heartbeatTimer);
    if (session.upstreamConnectTimer) clearTimeout(session.upstreamConnectTimer);
    closeSocket(session.upstream, 1000, reason.slice(0, 120));
    closeSocket(session.client, 1000, reason.slice(0, 120));
    session.upstream = undefined;
    session.client = undefined;
    session.upstreamQueue.length = 0;
    session.upstreamQueueBytes = 0;
    setTimeout(() => this.sessions.delete(id), 5_000);
  }

  private handleUpstreamMessage(id: string, raw: string): void {
    const session = this.sessions.get(id);
    if (!session || session.stopped) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      safeSend(session.client, { type: 'error', error: 'Provider returned invalid JSON' });
      return;
    }

    if (message && typeof message === 'object' && 'type' in message && typeof message.type === 'string') {
      if (message.type === 'session_id' && 'session_id' in message && typeof message.session_id === 'string') {
        session.providerSessionId = message.session_id;
      } else if (message.type === 'generation_started') {
        session.state = 'generating';
      } else if (message.type === 'generation_tick' && 'seconds' in message && typeof message.seconds === 'number') {
        session.usageSeconds = Math.max(session.usageSeconds, message.seconds);
        if (session.usageSeconds >= config.maxGenerationSeconds) {
          safeSend(session.client, { type: 'error', error: 'Demo session reached its generation limit' });
          void this.stop(id, 'generation_limit');
        }
      } else if (message.type === 'generation_ended') {
        if ('seconds' in message && typeof message.seconds === 'number') session.usageSeconds = Math.max(session.usageSeconds, message.seconds);
        session.state = 'connected';
      } else if (message.type === 'set_image_ack' && session.state === 'switching') {
        session.state = 'connected';
      } else if ((message.type === 'answer' || message.type === 'ice-candidate') && session.state === 'signaling') {
        session.state = 'connected';
      }
    }

    safeSend(session.client, message);
  }

  private checkHeartbeat(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.stopped) return;
    if (Date.now() - session.lastClientHeartbeatAt > 35_000) void this.stop(id, 'heartbeat_timeout');
  }

  private markProviderFailure(session: Session): void {
    if (session.failureReported) return;
    session.failureReported = true;
    this.providerKeyPool.markFailure(session.providerKeyId);
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.stopped) throw new Error('Session is not available');
    return session;
  }
}
