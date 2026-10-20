import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { config, hasProviderKey } from './config.js';
import { garments } from './garments.js';
import { GarmentLibrary } from './garment-library.js';
import { ProviderKeyPool } from './provider-key-pool.js';
import { SessionManager } from './session-manager.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const providerKeyPool = new ProviderKeyPool(config.providerKeys, config.providerKeyCooldownSeconds);
const sessions = new SessionManager(providerKeyPool, undefined, app.log as FastifyBaseLogger);
const garmentLibrary = new GarmentLibrary();

async function requireAllowedOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) return;
  request.log.warn({ event: 'origin.rejected', origin: origin ?? null, method: request.method, path: request.url.split('?')[0] }, 'Request origin rejected');
  reply.code(403).send({ error: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' });
}

await app.register(cors, { origin: config.allowedOrigins });
await app.register(websocket);

app.get('/api/health', async () => ({
  ok: true,
  providerConfigured: hasProviderKey(),
  model: config.model,
  speed: config.speed,
  sessionTtlSeconds: config.sessionTtlSeconds,
  maxGenerationSeconds: config.maxGenerationSeconds,
}));

app.get('/api/provider-keys', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { poolId: providerKeyPool.poolId, cards: providerKeyPool.getStatus() };
});

app.get('/api/garments', async () => garments.filter((garment) => garment.enabled));

app.get('/api/garment-groups', async () => garmentLibrary.listGroups());

app.get<{ Params: { imageId: string } }>('/api/garment-images/:imageId', async (request, reply) => {
  const image = await garmentLibrary.readImage(request.params.imageId);
  if (!image) return reply.code(404).send({ error: 'Garment image not found', code: 'GARMENT_IMAGE_NOT_FOUND' });
  return reply.type(image.contentType).header('Cache-Control', 'private, max-age=300').send(image.body);
});

app.post<{ Body: { providerKeyId?: unknown; poolId?: unknown } }>('/api/sessions', { preHandler: requireAllowedOrigin }, async (request, reply) => {
  if (!hasProviderKey()) {
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

if (process.env.NODE_ENV !== 'test') {
  await app.listen({ host: config.host, port: config.port });
}

export { app, providerKeyPool, sessions };
