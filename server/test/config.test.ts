import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
delete process.env.DECART_KEY_COOLDOWN_SECONDS;

const { config } = await import('../src/config.js');

test('defaults provider key cooldown to zero', () => {
  assert.equal(config.providerKeyCooldownSeconds, 0);
});
