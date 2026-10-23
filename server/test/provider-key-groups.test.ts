import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDirectory = await mkdtemp(join(tmpdir(), 'anywear-key-groups-'));
process.env.NODE_ENV = 'test';
process.env.ANYWEAR_DATA_DIR = dataDirectory;
process.env.ANYWEAR_TRUST_PROXY = 'false';
process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:5173';
process.env.DECART_API_KEYS = 'private-default-key-a,private-default-key-b';
process.env.DECART_API_KEY = '';

const { app, providerKeyPool } = await import('../src/index.js');
const { ProviderKeyStore } = await import('../src/provider-key-store.js');
const origin = 'http://127.0.0.1:5173';
const localHeaders = { origin, 'x-real-ip': '127.0.0.1' };
const isolatedKey = 'private-isolated-group-key';

test('creates isolated provider groups and scopes new sessions to the active group', async (context) => {
  context.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const initial = await app.inject({ method: 'GET', url: '/api/admin/provider-keys', headers: localHeaders });
  const initialView = initial.json<{
    activeGroupId: string;
    groups: Array<{ id: string; name: string; active: boolean; cards: Array<{ id: string }> }>;
  }>();
  assert.equal(initialView.groups.length, 1);
  assert.equal(initialView.groups[0]?.name, '默认分组');
  assert.equal(initialView.groups[0]?.active, true);

  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/provider-key-groups',
    headers: localHeaders,
    payload: { name: '演示隔离组' },
  });
  assert.equal(created.statusCode, 201);
  const createdView = created.json<{ activeGroupId: string; groups: Array<{ id: string; name: string; active: boolean }> }>();
  const isolatedGroup = createdView.groups.find((group) => group.id === createdView.activeGroupId);
  assert.deepEqual(isolatedGroup && [isolatedGroup.name, isolatedGroup.active], ['演示隔离组', true]);

  const emptyActiveGroup = await app.inject({ method: 'GET', url: '/api/provider-keys' });
  assert.deepEqual(emptyActiveGroup.json<{ cards: unknown[] }>().cards, []);
  const isolatedUnavailable = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: {},
  });
  assert.equal(isolatedUnavailable.statusCode, 503);
  assert.equal(isolatedUnavailable.json().code, 'ACTIVE_PROVIDER_GROUP_EMPTY');

  const added = await app.inject({
    method: 'POST',
    url: '/api/admin/provider-keys',
    headers: localHeaders,
    payload: { key: isolatedKey, label: '隔离卡', groupId: isolatedGroup?.id },
  });
  assert.equal(added.statusCode, 200);
  const addedView = added.json<{
    poolId: string;
    cards: Array<{ id: string }>;
    groups: Array<{ id: string; cards: Array<{ id: string; activeSessions: number }> }>;
  }>();
  const isolatedCard = addedView.groups.find((group) => group.id === isolatedGroup?.id)?.cards[0];
  assert.ok(isolatedCard);
  assert.deepEqual(addedView.cards.map((card) => card.id), ['provider-key-1', 'provider-key-2', isolatedCard.id]);
  assert.equal(JSON.stringify(addedView).includes(isolatedKey), false);

  const isolatedSessionResponse = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: isolatedCard.id, poolId: addedView.poolId },
  });
  assert.equal(isolatedSessionResponse.statusCode, 201);
  const isolatedSession = isolatedSessionResponse.json<{ sessionId: string; providerKeyId: string }>();
  assert.equal(isolatedSession.providerKeyId, isolatedCard.id);

  const activatedDefault = await app.inject({
    method: 'POST',
    url: `/api/admin/provider-key-groups/${encodeURIComponent(initialView.activeGroupId)}/activate`,
    headers: localHeaders,
  });
  assert.equal(activatedDefault.statusCode, 200);
  const defaultView = activatedDefault.json<{ poolId: string; activeGroupId: string; cards: Array<{ id: string }> }>();
  assert.equal(defaultView.activeGroupId, initialView.activeGroupId);
  assert.deepEqual(defaultView.cards.map((card) => card.id), ['provider-key-1', 'provider-key-2', isolatedCard.id]);
  assert.deepEqual(providerKeyPool.getGroupsManagementStatus().map((group) => group.activeSessions), [0, 1]);

  const staleManualSelection = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: { providerKeyId: isolatedCard.id, poolId: addedView.poolId },
  });
  assert.equal(staleManualSelection.statusCode, 409);
  assert.equal(staleManualSelection.json().code, 'PROVIDER_POOL_CHANGED');

  const automaticDefaultSession = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { origin },
    payload: {},
  });
  assert.equal(automaticDefaultSession.statusCode, 201);
  const defaultSessionId = automaticDefaultSession.json<{ sessionId: string; providerKeyId: string }>().sessionId;
  assert.equal(automaticDefaultSession.json<{ providerKeyId: string }>().providerKeyId, 'provider-key-1');

  const blockedMove = await app.inject({
    method: 'PATCH',
    url: `/api/admin/provider-keys/${encodeURIComponent(isolatedCard.id)}/group`,
    headers: localHeaders,
    payload: { groupId: initialView.activeGroupId },
  });
  assert.equal(blockedMove.statusCode, 409);
  assert.equal(blockedMove.json().code, 'PROVIDER_KEY_IN_USE');

  await app.inject({
    method: 'POST',
    url: `/api/sessions/${encodeURIComponent(isolatedSession.sessionId)}/stop`,
    headers: { origin },
    payload: {},
  });
  await app.inject({
    method: 'POST',
    url: `/api/sessions/${encodeURIComponent(defaultSessionId)}/stop`,
    headers: { origin },
    payload: {},
  });

  const blockedDelete = await app.inject({
    method: 'DELETE',
    url: `/api/admin/provider-key-groups/${encodeURIComponent(isolatedGroup!.id)}`,
    headers: localHeaders,
  });
  assert.equal(blockedDelete.statusCode, 409);
  assert.equal(blockedDelete.json().code, 'PROVIDER_GROUP_NOT_EMPTY');

  const moved = await app.inject({
    method: 'PATCH',
    url: `/api/admin/provider-keys/${encodeURIComponent(isolatedCard.id)}/group`,
    headers: localHeaders,
    payload: { groupId: initialView.activeGroupId },
  });
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(moved.json<{ cards: Array<{ id: string }> }>().cards.map((card) => card.id), [
    'provider-key-1',
    'provider-key-2',
    isolatedCard.id,
  ]);

  const renamed = await app.inject({
    method: 'PATCH',
    url: `/api/admin/provider-key-groups/${encodeURIComponent(isolatedGroup!.id)}`,
    headers: localHeaders,
    payload: { name: '空闲组' },
  });
  assert.equal(renamed.statusCode, 200);
  const conflictDelete = await app.inject({
    method: 'DELETE',
    url: `/api/admin/provider-key-groups/${encodeURIComponent(isolatedGroup!.id)}`,
    headers: localHeaders,
  });
  assert.equal(conflictDelete.statusCode, 200);
  assert.equal(conflictDelete.json<{ groups: Array<{ id: string }> }>().groups.some((group) => group.id === isolatedGroup!.id), false);

  const persisted = JSON.parse(await readFile(join(dataDirectory, 'provider-keys.json'), 'utf8')) as {
    version: number;
    activeGroupId: string;
    groups: Array<{ id: string; name: string }>;
    keys: Array<{ id: string; groupId: string; value: string }>;
  };
  assert.equal(persisted.version, 2);
  assert.equal(persisted.activeGroupId, initialView.activeGroupId);
  assert.equal(persisted.groups.some((group) => group.id === isolatedGroup!.id), false);
  assert.equal(persisted.keys.find((key) => key.id === isolatedCard.id)?.groupId, initialView.activeGroupId);

  const reloaded = new ProviderKeyStore(join(dataDirectory, 'provider-keys.json')).loadConfiguration(['ignored-key']);
  assert.equal(reloaded.activeGroupId, initialView.activeGroupId);
  assert.equal(reloaded.keys.find((key) => key.id === isolatedCard.id)?.value, isolatedKey);
});
