import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DECART_API_KEYS = 'private-placeholder-key-a,private-placeholder-key-b';
process.env.DECART_API_KEY = '';
process.env.DECART_KEY_COOLDOWN_SECONDS = '60';

const { app, providerKeyPool } = await import('../src/index.js');

test('lists safe card status and binds manual or automatic sessions correctly', async (context) => {
  context.after(async () => app.close());

  const list = await app.inject({ method: 'GET', url: '/api/provider-keys' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.headers['cache-control'], 'no-store');
  const pool = list.json<{ poolId: string; groupId: string; groupName: string; cards: Array<Record<string, unknown>> }>();
  assert.equal(typeof pool.poolId, 'string');
  assert.equal(pool.groupId, 'provider-group-default');
  assert.equal(pool.groupName, '默认分组');
  const listedCards = pool.cards;
  assert.deepEqual(listedCards.map((card) => [card.id, card.number]), [
    ['provider-key-1', 1],
    ['provider-key-2', 2],
  ]);
  assert.equal(JSON.stringify(listedCards).includes('private-placeholder-key'), false);
  assert.equal(JSON.stringify(listedCards).includes('value'), false);

  const origin = 'http://127.0.0.1:5173';
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: 'provider-key-99', poolId: pool.poolId },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'INVALID_PROVIDER_KEY');
  assert.deepEqual(providerKeyPool.getStatus().map((card) => card.activeSessions), [0, 0]);

  const stalePool = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: 'provider-key-1', poolId: 'stale-pool-instance' },
  });
  assert.equal(stalePool.statusCode, 409);
  assert.equal(stalePool.json().code, 'PROVIDER_POOL_CHANGED');
  assert.deepEqual(providerKeyPool.getStatus().map((card) => card.activeSessions), [0, 0]);

  const unversionedManual = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: 'provider-key-1' },
  });
  assert.equal(unversionedManual.statusCode, 409);
  assert.equal(unversionedManual.json().code, 'PROVIDER_POOL_CHANGED');
  assert.deepEqual(providerKeyPool.getStatus().map((card) => card.activeSessions), [0, 0]);

  const manual = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: 'provider-key-2', poolId: pool.poolId },
  });
  assert.equal(manual.statusCode, 201);
  const manualSession = manual.json<{ sessionId: string; providerKeyId: string }>();
  assert.equal(manualSession.providerKeyId, 'provider-key-2');
  assert.deepEqual(providerKeyPool.getStatus().map((card) => card.activeSessions), [0, 1]);

  const stopped = await app.inject({
    method: 'POST',
    url: `/api/sessions/${encodeURIComponent(manualSession.sessionId)}/stop`,
    headers: { origin },
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(providerKeyPool.getStatus().map((card) => card.activeSessions), [0, 0]);

  providerKeyPool.markFailure('provider-key-2');
  const coolingCards = await app.inject({ method: 'GET', url: '/api/provider-keys' });
  assert.equal(coolingCards.json<{ cards: Array<{ id: string; cooldownSecondsRemaining: number }> }>().cards[1]?.cooldownSecondsRemaining, 60);

  const unavailableManual = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: 'provider-key-2', poolId: pool.poolId },
  });
  assert.equal(unavailableManual.statusCode, 503);
  assert.equal(unavailableManual.json().code, 'PROVIDER_KEY_UNAVAILABLE');
  assert.deepEqual(providerKeyPool.getStatus().map((card) => card.activeSessions), [0, 0]);

  const automatic = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: {},
  });
  assert.equal(automatic.statusCode, 201);
  const automaticSession = automatic.json<{ sessionId: string; providerKeyId: string }>();
  assert.equal(automaticSession.providerKeyId, 'provider-key-1');
  await app.inject({
    method: 'POST',
    url: `/api/sessions/${encodeURIComponent(automaticSession.sessionId)}/stop`,
    headers: { origin },
    payload: {},
  });
});
