import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { ProviderKeyStore } = await import('../src/provider-key-store.js');

test('loads legacy key arrays into the default group and saves the grouped format', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-legacy-keys-'));
  const path = join(directory, 'provider-keys.json');
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify([
    { id: 'provider-key-1', value: 'legacy-placeholder-key', label: 'Legacy', enabled: true },
  ]));

  const store = new ProviderKeyStore(path);
  const configuration = store.loadConfiguration(['ignored-fallback-key']);
  assert.equal(configuration.activeGroupId, 'provider-group-default');
  assert.deepEqual(configuration.groups, [{ id: 'provider-group-default', name: '默认分组' }]);
  assert.equal(configuration.keys[0]?.groupId, configuration.activeGroupId);
  assert.equal(configuration.keys[0]?.value, 'legacy-placeholder-key');

  await store.save(configuration);
  const persisted = JSON.parse(await readFile(path, 'utf8')) as { version: number; groups: unknown[] };
  assert.equal(persisted.version, 2);
  assert.equal(persisted.groups.length, 1);
});
