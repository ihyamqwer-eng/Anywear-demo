import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { garments } from './garments.js';
import { GarmentLibrary } from './garment-library.js';
import { ProviderKeyPool } from './provider-key-pool.js';
import { ProviderKeyStore } from './provider-key-store.js';
import { SessionManager } from './session-manager.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const providerKeyStore = new ProviderKeyStore(config.providerKeyStorePath);
const providerKeyPool = new ProviderKeyPool(providerKeyStore.load(config.providerKeys), config.providerKeyCooldownSeconds);
const sessions = new SessionManager(providerKeyPool, undefined, app.log as FastifyBaseLogger);
const garmentLibrary = new GarmentLibrary();

function isServicePath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/ws' || pathname.startsWith('/ws/');
}

async function requireAllowedOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) return;
  request.log.warn({ event: 'origin.rejected', origin: origin ?? null, method: request.method, path: request.url.split('?')[0] }, 'Request origin rejected');
  reply.code(403).send({ error: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' });
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function getDockerGatewayAddress(): string | null {
  if (process.env.ANYWEAR_TRUST_PROXY !== 'true') return null;
  try {
    const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    const defaultRoute = routes
      .map((route) => route.trim().split(/\s+/))
      .find(([, destination, , flags]) => destination === '00000000' && (Number.parseInt(flags ?? '0', 16) & 1) === 1);
    const gateway = defaultRoute?.[2];
    if (!gateway || !/^[0-9a-fA-F]{8}$/.test(gateway)) return null;
    return [6, 4, 2, 0].map((offset) => Number.parseInt(gateway.slice(offset, offset + 2), 16)).join('.');
  } catch {
    return null;
  }
}

async function requireLocalAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;
  const referrer = request.headers.referer;
  let sourceOrigin = origin ?? '';
  let loopbackOrigin = false;
  try {
    const sourceUrl = new URL(sourceOrigin || referrer || '');
    sourceOrigin = sourceUrl.origin;
    loopbackOrigin = isLoopbackAddress(sourceUrl.hostname);
  } catch {
    loopbackOrigin = false;
  }

  const peerAddress = request.raw.socket.remoteAddress;
  const peerIsLocal = isLoopbackAddress(peerAddress);
  const dockerGatewayAddress = getDockerGatewayAddress();
  const peerIsDockerGateway = dockerGatewayAddress !== null
    && peerAddress?.replace(/^::ffff:/, '') === dockerGatewayAddress;
  let trustedProxyRequest = false;
  if (!peerIsLocal && process.env.ANYWEAR_TRUST_PROXY === 'true' && peerAddress) {
    const proxyHost = process.env.ANYWEAR_TRUSTED_PROXY_HOST?.trim() || 'frontend';
    const proxyAddress = request.headers['x-real-ip'];
    try {
      const proxyAddresses = await lookup(proxyHost, { all: true });
      trustedProxyRequest = proxyAddresses.some((address) => address.address === peerAddress.replace(/^::ffff:/, ''))
        && typeof proxyAddress === 'string'
        && (isLoopbackAddress(proxyAddress) || proxyAddress === dockerGatewayAddress);
    } catch {
      trustedProxyRequest = false;
    }
  }
  if (!sourceOrigin || !config.allowedOrigins.includes(sourceOrigin) || !loopbackOrigin || (!peerIsLocal && !peerIsDockerGateway && !trustedProxyRequest)) {
    request.log.warn({ event: 'provider_key.admin_rejected', origin: origin ?? null }, 'Non-local provider key management request rejected');
    reply.code(403).send({ error: '卡池管理仅允许在运行服务的本机访问', code: 'LOCAL_ADMIN_REQUIRED' });
  }
}

function providerKeyManagementView() {
  return { poolId: providerKeyPool.poolId, cards: providerKeyPool.getManagementStatus() };
}

await app.register(cors, { origin: config.allowedOrigins });
await app.register(websocket);
await app.register(fastifyStatic, {
  root: resolve(config.applicationRoot, 'client', 'dist'),
  prefix: '/',
  wildcard: true,
  index: ['index.html'],
  cacheControl: false,
  allowedPath: (pathName) => !isServicePath(pathName),
});

app.get('/api/health', async () => ({
  ok: true,
  providerConfigured: providerKeyPool.size > 0,
  model: config.model,
  speed: config.speed,
  sessionTtlSeconds: config.sessionTtlSeconds,
  maxGenerationSeconds: config.maxGenerationSeconds,
}));

app.get('/api/provider-keys', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { poolId: providerKeyPool.poolId, cards: providerKeyPool.getStatus() };
});

app.get('/api/admin/provider-keys', { preHandler: requireLocalAdmin }, async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return providerKeyManagementView();
});

app.post<{ Body: { key?: unknown; label?: unknown } }>('/api/admin/provider-keys', { preHandler: requireLocalAdmin }, async (request, reply) => {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply.code(400).send({ error: 'Request body must be an object', code: 'INVALID_REQUEST_BODY' });
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const label = body.label === undefined ? undefined : typeof body.label === 'string' ? body.label.trim() : null;
  if (key.length < 8 || key.length > 4096 || /[\r\n\0]/.test(key)) {
    return reply.code(400).send({ error: 'API Key 格式无效', code: 'INVALID_PROVIDER_KEY' });
  }
  if (label === null || (label !== undefined && label.length > 80)) {
    return reply.code(400).send({ error: '卡片名称不能超过 80 个字符', code: 'INVALID_PROVIDER_KEY_LABEL' });
  }

  try {
    return await providerKeyStore.runExclusive(async () => {
      let record;
      try {
        record = providerKeyPool.prepareAdd(key, label || undefined);
      } catch (error) {
        const duplicate = error instanceof Error && error.message.includes('already in the pool');
        return reply.code(duplicate ? 409 : 400).send({
          error: duplicate ? '这张 API Key 已在卡池中' : '卡池最多支持 100 张 API Key',
          code: duplicate ? 'DUPLICATE_PROVIDER_KEY' : 'PROVIDER_KEY_POOL_FULL',
        });
      }
      await providerKeyStore.save([...providerKeyPool.getStoredKeys(), record]);
      providerKeyPool.addRecord(record);
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key pool persistence failed');
    return reply.code(500).send({ error: '卡池保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>('/api/admin/provider-keys/:id', { preHandler: requireLocalAdmin }, async (request, reply) => {
  const body = request.body;
  const enabled = body?.enabled;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof enabled !== 'boolean') {
    return reply.code(400).send({ error: 'enabled 必须是布尔值', code: 'INVALID_PROVIDER_KEY_STATE' });
  }
  try {
    return await providerKeyStore.runExclusive(async () => {
      const record = providerKeyPool.getStoredKeys().find((key) => key.id === request.params.id);
      if (!record) return reply.code(404).send({ error: 'API Key 不存在', code: 'PROVIDER_KEY_NOT_FOUND' });
      if (record.enabled === enabled) return providerKeyManagementView();

      providerKeyPool.setEnabled(record.id, enabled);
      try {
        await providerKeyStore.save(providerKeyPool.getStoredKeys());
      } catch {
        providerKeyPool.setEnabled(record.id, record.enabled);
        throw new Error('Provider key pool persistence failed');
      }
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key pool persistence failed');
    return reply.code(500).send({ error: '卡池保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.delete<{ Params: { id: string } }>('/api/admin/provider-keys/:id', { preHandler: requireLocalAdmin }, async (request, reply) => {
  try {
    return await providerKeyStore.runExclusive(async () => {
      const currentKeys = providerKeyPool.getStoredKeys();
      const index = currentKeys.findIndex((key) => key.id === request.params.id);
      if (index < 0) return reply.code(404).send({ error: 'API Key 不存在', code: 'PROVIDER_KEY_NOT_FOUND' });
      if (providerKeyPool.getStatus()[index]?.activeSessions) {
        return reply.code(409).send({ error: '这张卡仍有运行中的会话，请停止会话后再移除', code: 'PROVIDER_KEY_IN_USE' });
      }

      const record = currentKeys[index]!;
      if (!providerKeyPool.remove(record.id)) {
        return reply.code(409).send({ error: '卡池状态已变化，请刷新后重试', code: 'PROVIDER_KEY_IN_USE' });
      }
      try {
        await providerKeyStore.save(providerKeyPool.getStoredKeys());
      } catch {
        providerKeyPool.restore(record, index);
        throw new Error('Provider key pool persistence failed');
      }
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key pool persistence failed');
    return reply.code(500).send({ error: '卡池保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.get('/api/garments', async () => garments.filter((garment) => garment.enabled));

app.get('/api/garment-groups', async () => garmentLibrary.listGroups());

app.get<{ Params: { imageId: string } }>('/api/garment-images/:imageId', async (request, reply) => {
  const image = await garmentLibrary.readImage(request.params.imageId);
  if (!image) return reply.code(404).send({ error: 'Garment image not found', code: 'GARMENT_IMAGE_NOT_FOUND' });
  return reply.type(image.contentType).header('Cache-Control', 'private, max-age=300').send(image.body);
});

app.post<{ Body: { providerKeyId?: unknown; poolId?: unknown } }>('/api/sessions', { preHandler: requireAllowedOrigin }, async (request, reply) => {
  if (providerKeyPool.size === 0) {
    return reply.code(503).send({
      error: 'DECART_API_KEY is not configured',
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }

  const body = request.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return reply.code(400).send({ error: 'Request body must be an object', code: 'INVALID_REQUEST_BODY' });
  }
  const requestedProviderKeyId = body.providerKeyId;
  if (requestedProviderKeyId !== undefined
    && (typeof requestedProviderKeyId !== 'string' || !providerKeyPool.has(requestedProviderKeyId))) {
    return reply.code(400).send({ error: 'Provider key selection is invalid', code: 'INVALID_PROVIDER_KEY' });
  }
  if (requestedProviderKeyId !== undefined && body.poolId !== providerKeyPool.poolId) {
    return reply.code(409).send({ error: '卡池已更新，请重新进入卡池页面选择卡号', code: 'PROVIDER_POOL_CHANGED' });
  }

  const session = sessions.create(requestedProviderKeyId as string | undefined);
  if (!session) {
    return reply.code(503).send({
      error: requestedProviderKeyId ? '所选 API 卡当前不可用，请刷新卡池或选择其他卡' : '当前没有可用的 API 卡',
      code: 'PROVIDER_KEY_UNAVAILABLE',
    });
  }
  return reply.code(201).send({
    ...session,
    websocketPath: `/ws/realtime?session_id=${encodeURIComponent(session.sessionId)}`,
  });
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', { preHandler: requireAllowedOrigin }, async (request, reply) => {
  const session = sessions.get(request.params.id);
  if (!session) return reply.code(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
  await sessions.stop(request.params.id, 'client_stop');
  return { ok: true, sessionId: request.params.id };
});

app.post('/api/internal/shutdown', async (request, reply) => {
  const remoteAddress = request.raw.socket.remoteAddress;
  const authorization = request.headers.authorization;
  const expectedToken = process.env.ANYWEAR_CONTROL_TOKEN ?? '';
  const suppliedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedBuffer = Buffer.from(expectedToken);
  const suppliedBuffer = Buffer.from(suppliedToken);
  const loopback = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  const authorized = loopback
    && expectedBuffer.length > 0
    && expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!authorized) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });

  reply.code(202).send({ ok: true });
  reply.raw.once('finish', () => {
    void app.close().catch((error: unknown) => {
      app.log.error({ errorName: error instanceof Error ? error.name : typeof error }, 'Graceful shutdown failed');
    });
  });
});

app.get('/ws/realtime', { websocket: true, preValidation: requireAllowedOrigin }, (socket: WebSocket, request) => {
  const query = request.query as { session_id?: string };
  const sessionId = typeof query.session_id === 'string' ? query.session_id : '';
  if (!sessionId || !sessions.attachClient(sessionId, socket)) {
    socket.close(4404, 'Session not found or already connected');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    socket.close(4404, 'Session not found');
    return;
  }

  request.log.info({ event: 'websocket.client_connected', sessionId, origin: request.headers.origin ?? null }, 'Browser realtime WebSocket connected');

  socket.on('message', (data) => {
    try {
      sessions.handleClientMessage(sessionId, data.toString());
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Session error' }));
    }
  });
  socket.on('close', (code) => {
    request.log.info({ event: 'websocket.client_closed', sessionId, closeCode: code }, 'Browser realtime WebSocket closed');
    sessions.markClientDisconnected(sessionId);
  });
  socket.on('error', (error) => {
    request.log.warn({ event: 'websocket.client_error', sessionId, errorName: error.name }, 'Browser realtime WebSocket failed');
    sessions.markClientDisconnected(sessionId);
  });
  void sessions.connectUpstream(sessionId).catch((error: unknown) => {
    request.log.error({ event: 'provider.connect_failed', sessionId, errorName: error instanceof Error ? error.name : typeof error }, 'Realtime provider connection failed');
    socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Provider connection failed' }));
    void sessions.stop(sessionId, 'provider_connect_failed');
  });
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const candidateStatusCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
  const candidateCode = error instanceof Error && 'code' in error ? error.code : undefined;
  const statusCode = typeof candidateStatusCode === 'number' && candidateStatusCode >= 400 && candidateStatusCode < 500
    ? candidateStatusCode
    : 500;
  return reply.code(statusCode).send({
    error: statusCode < 500 && error instanceof Error ? error.message : 'Internal server error',
    code: statusCode < 500 && typeof candidateCode === 'string' ? candidateCode : statusCode < 500 ? 'REQUEST_ERROR' : 'INTERNAL_ERROR',
  });
});

app.setNotFoundHandler((request, reply) => {
  const pathname = request.url.split('?')[0];
  const acceptsHtml = request.headers.accept?.includes('text/html');
  if ((request.method === 'GET' || request.method === 'HEAD')
    && !isServicePath(pathname)
    && !pathname.includes('.')
    && acceptsHtml) {
    return reply.type('text/html').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });
});

app.addHook('onClose', async () => {
  await sessions.stopAll('server_shutdown');
});

if (process.env.NODE_ENV !== 'test') {
  process.once('SIGINT', () => void app.close());
  process.once('SIGTERM', () => void app.close());
  await app.listen({ host: config.host, port: config.port });
}

export { app, providerKeyPool, sessions };
