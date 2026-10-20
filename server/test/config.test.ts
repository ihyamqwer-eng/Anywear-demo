import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
delete process.env.DECART_KEY_COOLDOWN_SECONDS;
delete process.env.PORT;
delete process.env.ALLOWED_ORIGINS;

const { config } = await import('../src/config.js');

test('defaults provider key cooldown to zero', () => {
  assert.equal(config.providerKeyCooldownSeconds, 0);
});

test('defaults to the local application port and allows its loopback origins', () => {
  assert.equal(config.port, 1111);
  assert.deepEqual(config.allowedOrigins.slice(0, 2), [
    'http://127.0.0.1:1111',
    'http://localhost:1111',
  ]);
});
