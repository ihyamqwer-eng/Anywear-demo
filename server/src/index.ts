import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { config, hasProviderKey } from './config.js';
import { garments } from './garments.js';
import { SessionManager } from './session-manager.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const sessions = new SessionManager();

async function requireAllowedOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) return;
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

app.get('/api/garments', async () => garments.filter((garment) => garment.enabled));

app.post('/api/sessions', { preHandler: requireAllowedOrigin }, async (_request, reply) => {
  if (!hasProviderKey()) {
    return reply.code(503).send({
      error: 'DECART_API_KEY is not configured',
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }

  const session = sessions.create();
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

  socket.on('message', (data) => {
    try {
      sessions.handleClientMessage(sessionId, data.toString());
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Session error' }));
    }
  });
  socket.on('close', () => sessions.markClientDisconnected(sessionId));
  socket.on('error', () => sessions.markClientDisconnected(sessionId));
  void sessions.connectUpstream(sessionId).catch((error: unknown) => {
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

await app.listen({ host: config.host, port: config.port });
