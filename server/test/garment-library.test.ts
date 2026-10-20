import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

const { GarmentLibrary } = await import('../src/garment-library.js');
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceImagePath = path.resolve(testDirectory, '../../client/public/garments/studio-white-tee.png');

test('serves every image from its configured group and rejects directories outside the library root', async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'anywear-garments-'));
  const libraryRoot = path.join(temporaryDirectory, 'library');
  const outsideDirectory = path.join(temporaryDirectory, 'outside');
  const imageBytes = await readFile(sourceImagePath);
  await mkdir(path.join(libraryRoot, 'summer', 'nested'), { recursive: true });
  await mkdir(path.join(libraryRoot, 'winter'), { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  for (let index = 0; index < 8; index += 1) {
    await writeFile(path.join(libraryRoot, 'summer', `shirt-${index}.png`), imageBytes);
  }
  await writeFile(path.join(libraryRoot, 'summer', 'nested', 'hoodie.webp'), imageBytes);
  await writeFile(path.join(libraryRoot, 'summer', 'notes.txt'), 'not an image');
  await writeFile(path.join(libraryRoot, 'winter', 'coat.jpeg'), imageBytes);
  await writeFile(path.join(outsideDirectory, 'outside.png'), imageBytes);

  const library = new GarmentLibrary(libraryRoot, [
    { id: 'summer', name: '夏季', directory: 'summer' },
    { id: 'winter', name: '冬季', directory: 'winter' },
    { id: 'outside', name: '外部目录', directory: '../outside' },
  ]);
  const groups = await library.listGroups();

  assert.deepEqual(groups.map(({ id }) => id), ['featured', 'summer', 'winter', 'outside']);
  assert.equal(groups.find(({ id }) => id === 'summer')?.garments.length, 9);
  assert.equal(groups.find(({ id }) => id === 'winter')?.garments.length, 1);
  assert.equal(groups.find(({ id }) => id === 'outside')?.garments.length, 0);

  for (const group of groups.filter(({ id }) => id !== 'featured' && id !== 'outside')) {
    for (const garment of group.garments) {
      const imageId = new URL(garment.image, 'http://localhost').pathname.split('/').at(-1);
      assert.ok(imageId);
      const servedImage = await library.readImage(imageId);
      assert.ok(servedImage);
      const expectedContentType = garment.name === 'hoodie' ? 'image/webp' : garment.name === 'coat' ? 'image/jpeg' : 'image/png';
      assert.equal(servedImage.contentType, expectedContentType);
      assert.deepEqual(servedImage.body, imageBytes);
    }
  }
});
