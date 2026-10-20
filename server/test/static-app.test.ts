import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const applicationRoot = await mkdtemp(path.join(tmpdir(), 'anywear-app-'));
process.env.ANYWEAR_APP_ROOT = applicationRoot;
const clientDirectory = path.join(applicationRoot, 'client', 'dist');
await mkdir(path.join(clientDirectory, 'assets'), { recursive: true });
await writeFile(path.join(clientDirectory, 'index.html'), '<!doctype html><title>Anywear Fixture</title>');
await writeFile(path.join(clientDirectory, 'assets', 'app.js'), 'window.fixture = true;');

const { app } = await import('../src/index.js');

test('serves the SPA, built assets, and API routes from one origin', async (context) => {
  context.after(async () => {
    await app.close();
    await rm(applicationRoot, { recursive: true, force: true });
  });

  const home = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /Anywear Fixture/);

  const clientRoute = await app.inject({ method: 'GET', url: '/cards', headers: { accept: 'text/html' } });
  assert.equal(clientRoute.statusCode, 200);
  assert.match(clientRoute.body, /Anywear Fixture/);

  const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.body, /fixture/);

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);

  const unauthorizedShutdown = await app.inject({
    method: 'POST',
    url: '/api/internal/shutdown',
    headers: { authorization: 'Bearer invalid' },
    payload: {},
  });
  assert.equal(unauthorizedShutdown.statusCode, 404);

  const missingApi = await app.inject({ method: 'GET', url: '/api/missing', headers: { accept: 'text/html' } });
  assert.equal(missingApi.statusCode, 404);
  assert.equal(missingApi.json().code, 'NOT_FOUND');

  const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing.js' });
  assert.equal(missingAsset.statusCode, 404);
  assert.equal(missingAsset.headers['content-type']?.includes('text/html'), false);
});
