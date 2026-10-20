import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

process.env.NODE_ENV = 'test';
process.env.DECART_KEY_COOLDOWN_SECONDS = '0';
process.env.DECART_API_KEYS = 'placeholder-pool-a,placeholder-pool-b';
process.env.DECART_API_KEY = 'placeholder-legacy-key';

const { config } = await import('../src/config.js');
const { ProviderKeyPool } = await import('../src/provider-key-pool.js');
const { SessionManager } = await import('../src/session-manager.js');

test('accepts zero cooldown and keeps legacy keys in the pool', () => {
  assert.equal(config.providerKeyCooldownSeconds, 0);
  assert.deepEqual(config.providerKeys, [
    'placeholder-pool-a',
    'placeholder-pool-b',
    'placeholder-legacy-key',
  ]);
});

test('assigns the least-active available key and rotates ties', () => {
  const pool = new ProviderKeyPool(['placeholder-key-a', 'placeholder-key-b'], 60);

  const first = pool.acquire();
  const second = pool.acquire();
  const third = pool.acquire();

  assert.equal(first?.id, 'provider-key-1');
  assert.equal(second?.id, 'provider-key-2');
  assert.equal(third?.id, 'provider-key-1');

  pool.release(first!.id);
  pool.release(second!.id);
  pool.release(third!.id);
  pool.markFailure(first!.id);

  const afterFailure = pool.acquire();
  assert.equal(afterFailure?.id, 'provider-key-2');
  assert.equal(afterFailure?.value, 'placeholder-key-b');
  pool.release(afterFailure!.id);
});

test('honors an explicit card selection without falling back from invalid or cooling cards', () => {
  const pool = new ProviderKeyPool(['placeholder-key-a', 'placeholder-key-b'], 60);
  const second = pool.acquire('provider-key-2');
  assert.deepEqual(second, { id: 'provider-key-2', value: 'placeholder-key-b' });
  assert.equal(pool.acquire('provider-key-9'), null);
  pool.markFailure(second!.id);
  assert.equal(pool.acquire('provider-key-2'), null);
  assert.deepEqual(pool.acquire('provider-key-1'), { id: 'provider-key-1', value: 'placeholder-key-a' });
  pool.release('provider-key-1');
  pool.release(second!.id);
});

test('publishes card status without exposing provider credentials', () => {
  const pool = new ProviderKeyPool(['private-placeholder-key'], 60);
  const lease = pool.acquire();
  assert.ok(lease);
  const [status] = pool.getStatus();
  assert.deepEqual(status, {
    id: 'provider-key-1',
    number: 1,
    activeSessions: 1,
    cooldownSecondsRemaining: 0,
  });
  assert.equal(JSON.stringify(status).includes('private-placeholder-key'), false);
  pool.release(lease.id);
});

test('keeps failed keys available when cooldown is disabled', () => {
  const pool = new ProviderKeyPool(['placeholder-key'], 0);
  const first = pool.acquire();
  assert.ok(first);
  pool.release(first.id);
  pool.markFailure(first.id);

  const retry = pool.acquire();
  assert.deepEqual(retry, first);
  pool.release(retry!.id);
});

test('uses the manually selected key for the upstream WebSocket connection', async (context) => {
  const httpServer = createServer();
  const upstreamServer = new WebSocketServer({ server: httpServer, path: '/v1/stream' });
  let upstreamUrl: URL | undefined;
  upstreamServer.on('connection', (_socket, request) => {
    upstreamUrl = new URL(request.url ?? '/', 'http://localhost');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });

  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const pool = new ProviderKeyPool(['placeholder-selected-a', 'placeholder-selected-b'], 0);
  const manager = new SessionManager(pool, `ws://127.0.0.1:${address.port}/v1/stream`);
  let sessionId: string | undefined;
  context.after(async () => {
    if (sessionId) await manager.stop(sessionId, 'test_cleanup');
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  });

  const session = manager.create('provider-key-2');
  assert.ok(session);
  sessionId = session.sessionId;
  assert.equal(session.providerKeyId, 'provider-key-2');
  const client = {
    readyState: WebSocket.OPEN,
    send: (_payload: string) => undefined,
    close: () => undefined,
    terminate: () => undefined,
  } as unknown as WebSocket;
  assert.equal(manager.attachClient(session.sessionId, client), true);
  await manager.connectUpstream(session.sessionId);
  await waitFor(() => upstreamUrl !== undefined);

  assert.equal(upstreamUrl?.searchParams.get('api_key'), 'placeholder-selected-b');
  assert.deepEqual(pool.getStatus().map((card) => card.activeSessions), [0, 1]);
  await manager.stop(session.sessionId, 'test_cleanup');
  assert.deepEqual(pool.getStatus().map((card) => card.activeSessions), [0, 0]);
});

test('retries new sessions across cooled and non-cooled keys', async (context) => {
  const httpServer = createServer();
  const upstreamServer = new WebSocketServer({ server: httpServer, path: '/v1/stream' });
  const receivedKeys: string[] = [];
  upstreamServer.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    receivedKeys.push(url.searchParams.get('api_key') ?? '');
    if (receivedKeys.length === 1 || receivedKeys.length === 3) socket.close(1011, 'simulated provider failure');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  context.after(async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  });

  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const upstreamOrigin = `ws://127.0.0.1:${address.port}/v1/stream`;
  const managers = [
    new SessionManager(new ProviderKeyPool(['placeholder-key-a', 'placeholder-key-b'], 60), upstreamOrigin),
    new SessionManager(new ProviderKeyPool(['placeholder-key-c'], 0), upstreamOrigin),
  ];
  const [cooledManager, nonCooledManager] = managers;
  assert.ok(cooledManager && nonCooledManager);
  context.after(async () => {
    for (const sessionId of [...receivedSessionIds]) {
      await Promise.all(managers.map((manager) => manager.stop(sessionId, 'test_cleanup')));
    }
  });
  const receivedSessionIds: string[] = [];
  const client = () => ({
    readyState: WebSocket.OPEN,
    send: (_payload: string) => undefined,
    close: () => undefined,
    terminate: () => undefined,
  }) as unknown as WebSocket;

  const firstSession = await startSession(cooledManager, client, receivedSessionIds);
  await waitFor(() => receivedKeys.length === 1 && cooledManager.get(firstSession.sessionId)?.stopped === true);
  const secondSession = await startSession(cooledManager, client, receivedSessionIds);
  await waitFor(() => receivedKeys.length === 2);
  await cooledManager.stop(secondSession.sessionId, 'test_cleanup');

  const thirdSession = await startSession(nonCooledManager, client, receivedSessionIds);
  await waitFor(() => receivedKeys.length === 3 && nonCooledManager.get(thirdSession.sessionId)?.stopped === true);
  const fourthSession = await startSession(nonCooledManager, client, receivedSessionIds);
  await waitFor(() => receivedKeys.length === 4);
  assert.deepEqual(receivedKeys, [
    'placeholder-key-a',
    'placeholder-key-b',
    'placeholder-key-c',
    'placeholder-key-c',
  ]);
  await nonCooledManager.stop(fourthSession.sessionId, 'test_cleanup');
});

async function startSession(
  manager: SessionManager,
  createClient: () => WebSocket,
  sessionIds: string[],
): Promise<NonNullable<ReturnType<SessionManager['create']>>> {
  const session = manager.create();
  assert.ok(session);
  sessionIds.push(session.sessionId);
  assert.equal(manager.attachClient(session.sessionId, createClient()), true);
  await manager.connectUpstream(session.sessionId);
  return session;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the local WebSocket fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
