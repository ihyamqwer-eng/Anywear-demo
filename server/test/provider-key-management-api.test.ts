import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDirectory = await mkdtemp(join(tmpdir(), 'anywear-key-management-'));
process.env.NODE_ENV = 'test';
process.env.ANYWEAR_DATA_DIR = dataDirectory;
process.env.ANYWEAR_TRUST_PROXY = 'false';
process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:5173';
process.env.DECART_API_KEYS = 'private-placeholder-key-a,private-placeholder-key-b';
process.env.DECART_API_KEY = '';

const { app, providerKeyPool } = await import('../src/index.js');
const { ProviderKeyStore } = await import('../src/provider-key-store.js');
const origin = 'http://127.0.0.1:5173';
const localHeaders = { origin, 'x-real-ip': '127.0.0.1' };
const managedKey = 'test-managed-secret-credential';

test('manages keys locally without exposing secrets and persists stable IDs', async (context) => {
  context.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const denied = await app.inject({
    method: 'GET',
    url: '/api/admin/provider-keys',
    headers: { origin: 'http://192.168.1.9:5173' },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'LOCAL_ADMIN_REQUIRED');

  const forgedProxy = await app.inject({
    method: 'GET',
    url: '/api/admin/provider-keys',
    remoteAddress: '172.30.0.9',
    headers: { origin, 'x-real-ip': '127.0.0.1' },
  });
  assert.equal(forgedProxy.statusCode, 403);
  assert.equal(forgedProxy.json().code, 'LOCAL_ADMIN_REQUIRED');

  const listed = await app.inject({ method: 'GET', url: '/api/admin/provider-keys', headers: localHeaders });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers['cache-control'], 'no-store');
  assert.deepEqual(listed.json<{ cards: Array<{ id: string }> }>().cards.map((card) => card.id), [
    'provider-key-1',
    'provider-key-2',
  ]);

  const sameOriginRead = await app.inject({
    method: 'GET',
    url: '/api/admin/provider-keys',
    headers: { referer: `${origin}/cards/manage` },
  });
  assert.equal(sameOriginRead.statusCode, 200);

  const added = await app.inject({
    method: 'POST',
    url: '/api/admin/provider-keys',
    headers: localHeaders,
    payload: { key: managedKey, label: 'Demo card' },
  });
  assert.equal(added.statusCode, 200);
  const addedPool = added.json<{ poolId: string; cards: Array<{ id: string; keyHint: string; label: string }> }>();
  const addedCard = addedPool.cards[2];
  assert.deepEqual(addedCard, {
    id: 'provider-key-3',
    number: 3,
    label: 'Demo card',
    keyHint: '****tial',
    enabled: true,
    activeSessions: 0,
    cooldownSecondsRemaining: 0,
  });
  assert.equal(JSON.stringify(addedPool).includes(managedKey), false);
  assert.notEqual(addedPool.poolId, listed.json<{ poolId: string }>().poolId);

  const disabled = await app.inject({
    method: 'PATCH',
    url: '/api/admin/provider-keys/provider-key-3',
    headers: localHeaders,
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  const disabledPool = disabled.json<{ poolId: string; cards: Array<{ id: string; enabled: boolean }> }>();
  assert.equal(disabledPool.cards[2]?.enabled, false);
  assert.notEqual(disabledPool.poolId, addedPool.poolId);
  const availableCards = await app.inject({ method: 'GET', url: '/api/provider-keys' });
  assert.deepEqual(availableCards.json<{ cards: Array<{ id: string }> }>().cards.map((card) => card.id), [
    'provider-key-1',
    'provider-key-2',
  ]);

  const enabled = await app.inject({
    method: 'PATCH',
    url: '/api/admin/provider-keys/provider-key-3',
    headers: localHeaders,
    payload: { enabled: true },
  });
  assert.equal(enabled.statusCode, 200);
  const enabledPool = enabled.json<{ poolId: string; cards: Array<{ id: string; enabled: boolean }> }>();
  assert.equal(enabledPool.cards[2]?.enabled, true);
  assert.notEqual(enabledPool.poolId, disabledPool.poolId);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/admin/provider-keys',
    headers: localHeaders,
    payload: { key: managedKey },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().code, 'DUPLICATE_PROVIDER_KEY');

  const started = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: addedCard?.id, poolId: enabledPool.poolId },
  });
  assert.equal(started.statusCode, 201);
  const sessionId = started.json<{ sessionId: string }>().sessionId;

  const blockedDelete = await app.inject({
    method: 'DELETE',
    url: `/api/admin/provider-keys/${addedCard?.id}`,
    headers: localHeaders,
  });
  assert.equal(blockedDelete.statusCode, 409);
  assert.equal(blockedDelete.json().code, 'PROVIDER_KEY_IN_USE');

  const stopped = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/stop`,
    headers: { origin },
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);

  const removed = await app.inject({
    method: 'DELETE',
    url: '/api/admin/provider-keys/provider-key-1',
    headers: localHeaders,
  });
  assert.equal(removed.statusCode, 200);
  const remaining = removed.json<{ cards: Array<{ id: string }> }>().cards;
  assert.deepEqual(remaining.map((card) => card.id), ['provider-key-2', 'provider-key-3']);

  const stored = JSON.parse(await readFile(join(dataDirectory, 'provider-keys.json'), 'utf8')) as {
    version: number;
    groups: Array<{ id: string; name: string }>;
    keys: Array<{ id: string; value: string; groupId: string }>;
  };
  assert.equal(stored.version, 2);
  assert.equal(stored.groups[0]?.name, '默认分组');
  assert.deepEqual(stored.keys.map((record) => record.id), ['provider-key-2', 'provider-key-3']);
  assert.equal(stored.keys.find((record) => record.id === 'provider-key-3')?.value, managedKey);

  const reloaded = new ProviderKeyStore(join(dataDirectory, 'provider-keys.json')).load(['ignored-fallback-key']);
  assert.deepEqual(reloaded.map((record) => record.id), ['provider-key-2', 'provider-key-3']);
  assert.equal(reloaded.find((record) => record.id === 'provider-key-3')?.value, managedKey);
  assert.equal(providerKeyPool.has('provider-key-1'), false);
});
