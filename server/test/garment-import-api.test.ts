import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'anywear-garment-import-'));
process.env.NODE_ENV = 'test';
process.env.ANYWEAR_DATA_DIR = dataDirectory;
process.env.ANYWEAR_TRUST_PROXY = 'false';
process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:5173';
process.env.GARMENT_IMPORT_MAX_IMAGE_BYTES = '16';
process.env.GARMENT_IMPORT_MAX_TOTAL_BYTES = '20';
process.env.GARMENT_IMPORT_MAX_FILES = '2';

const { app } = await import('../src/index.js');
let activeApp = app;
let activeAppClosed = false;
const origin = 'http://127.0.0.1:5173';
const localHeaders = { origin, 'x-real-ip': '127.0.0.1' };
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const boundary = 'anywear-test-boundary';

after(async () => {
  if (!activeAppClosed) await activeApp.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

interface FormPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  bytes?: Buffer;
}

function multipart(parts: FormPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? 'image/png'}\r\n\r\n`));
      chunks.push(part.bytes ?? Buffer.alloc(0));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ''}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function upload(parts: FormPart[], headers = localHeaders) {
  return activeApp.inject({
    method: 'POST',
    url: '/api/admin/garment-groups/import',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipart(parts),
  });
}

function importParts(filename = 'shirts/tee.png', bytes = pngSignature): FormPart[] {
  return [
    { name: 'name', value: '夏季服装' },
    { name: 'images', filename, bytes },
  ];
}

test('imports image groups to persistent storage and reloads them after library recreation', async () => {
  const imported = await upload(importParts());
  assert.equal(imported.statusCode, 201);
  const importedGroup = imported.json<{ id: string; name: string; garments: Array<{ id: string; image: string }> }>();
  assert.equal(importedGroup.name, '夏季服装');
  assert.equal(importedGroup.garments.length, 1);

  const listed = await app.inject({ method: 'GET', url: '/api/garment-groups' });
  assert.equal(listed.statusCode, 200);
  const listedGroup = listed.json<Array<Record<string, unknown>>>().find((group) => group.id === importedGroup.id);
  assert.deepEqual(Object.keys(listedGroup ?? {}).sort(), ['garments', 'id', 'name']);
  assert.equal((listedGroup?.garments as unknown[]).length, 1);

  const uploadRoot = path.join(dataDirectory, 'garments');
  const storedGroups = JSON.parse(await readFile(path.join(uploadRoot, 'groups.json'), 'utf8')) as {
    groups: Array<{ id: string; name: string }>;
  };
  assert.deepEqual(storedGroups.groups, [{ id: importedGroup.id, name: '夏季服装' }]);

  const imageId = new URL(importedGroup.garments[0]!.image, 'http://localhost').pathname.split('/').at(-1)!;
  await activeApp.close();
  activeAppClosed = true;
  const restarted = await import('../src/index.js?restart');
  activeApp = restarted.app;
  activeAppClosed = false;
  const reloadedResponse = await activeApp.inject({ method: 'GET', url: '/api/garment-groups' });
  assert.equal(reloadedResponse.statusCode, 200);
  const reloadedGroup = reloadedResponse.json<Array<{ id: string; name: string; garments: Array<{ image: string }> }>>()
    .find((group) => group.id === importedGroup.id);
  assert.equal(reloadedGroup?.name, '夏季服装');
  assert.equal(reloadedGroup?.garments.length, 1);

  const served = await activeApp.inject({ method: 'GET', url: `/api/garment-images/${imageId}` });
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.deepEqual(served.rawPayload, pngSignature);

  assert.equal(reloadedGroup?.garments[0]?.image, importedGroup.garments[0]?.image);

  const appendImage = Buffer.from([...pngSignature, 0x42]);
  const firstAppend = await upload([
    { name: 'name', value: '我的上传' },
    { name: 'groupId', value: 'user-garment-uploads' },
    { name: 'images', filename: 'first.png', bytes: pngSignature },
  ]);
  assert.equal(firstAppend.statusCode, 201);
  const secondAppend = await upload([
    { name: 'name', value: '我的上传' },
    { name: 'groupId', value: 'user-garment-uploads' },
    { name: 'images', filename: 'second.png', bytes: appendImage },
  ]);
  assert.equal(secondAppend.statusCode, 200);
  assert.equal(secondAppend.json<{ id: string; garments: unknown[] }>().id, 'user-garment-uploads');
  assert.equal(secondAppend.json<{ garments: unknown[] }>().garments.length, 2);
});

test('rejects unauthorized, unsafe, unsupported, oversized and excessive uploads without leaving staging data', async () => {
  const denied = await upload(importParts(), { origin: 'http://192.168.1.9:5173' });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'LOCAL_ADMIN_REQUIRED');

  const invalidPath = await upload(importParts('../outside.png'));
  assert.equal(invalidPath.statusCode, 400);
  assert.equal(invalidPath.json().code, 'INVALID_GARMENT_FILE_PATH');

  const unsupported = await upload(importParts('notes.gif'));
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.json().code, 'UNSUPPORTED_GARMENT_IMAGE_TYPE');

  const mismatchedMime = await upload([
    { name: 'name', value: 'Wrong type' },
    { name: 'images', filename: 'wrong.png', contentType: 'application/octet-stream', bytes: pngSignature },
  ]);
  assert.equal(mismatchedMime.statusCode, 400);
  assert.equal(mismatchedMime.json().code, 'UNSUPPORTED_GARMENT_IMAGE_TYPE');

  const invalidContent = await upload(importParts('invalid.png', Buffer.from('not an image')));
  assert.equal(invalidContent.statusCode, 400);
  assert.equal(invalidContent.json().code, 'INVALID_GARMENT_IMAGE_CONTENT');

  const oversizedImage = await upload(importParts('large.png', Buffer.from([...pngSignature, ...Buffer.alloc(9)])));
  assert.equal(oversizedImage.statusCode, 413);
  assert.equal(oversizedImage.json().code, 'GARMENT_IMPORT_IMAGE_TOO_LARGE');

  const oversizedTotal = await upload([
    { name: 'name', value: 'Too large total' },
    { name: 'images', filename: 'first.png', bytes: Buffer.from([...pngSignature, ...Buffer.alloc(3)]) },
    { name: 'images', filename: 'second.png', bytes: Buffer.from([...pngSignature, ...Buffer.alloc(3)]) },
  ]);
  assert.equal(oversizedTotal.statusCode, 413);
  assert.equal(oversizedTotal.json().code, 'GARMENT_IMPORT_TOTAL_TOO_LARGE');

  const tooMany = await upload([
    { name: 'name', value: 'Too many' },
    { name: 'images', filename: 'one.png', bytes: pngSignature },
    { name: 'images', filename: 'two.png', bytes: pngSignature },
    { name: 'images', filename: 'three.png', bytes: pngSignature },
  ]);
  assert.equal(tooMany.statusCode, 413);

  const stagingRoot = path.join(dataDirectory, 'garments', '.tmp');
  const stagingEntries = await readdir(stagingRoot);
  assert.deepEqual(stagingEntries, []);
  const persistedRoot = path.join(dataDirectory, 'garments', 'groups');
  const persistedEntries = await readdir(persistedRoot).catch(() => []);
  const storedGroups = JSON.parse(await readFile(path.join(dataDirectory, 'garments', 'groups.json'), 'utf8')) as {
    groups: Array<{ id: string }>;
  };
  assert.equal(storedGroups.groups.length, 2);
  assert.deepEqual(persistedEntries.sort(), storedGroups.groups.map(({ id }) => id).sort());
});
