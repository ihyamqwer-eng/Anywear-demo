import crypto from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { config, type GarmentGroupConfig } from './config.js';
import { garments, type Garment } from './garments.js';

const imageTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface GarmentGroup {
  id: string;
  name: string;
  garments: Garment[];
}

interface ImageEntry {
  absolutePath: string;
  libraryRoot: string;
  contentType: string;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function collectImages(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectImages(fullPath));
    else if (entry.isFile() && imageTypes[path.extname(entry.name).toLowerCase()]) files.push(fullPath);
  }
  return files;
}

export class GarmentLibrary {
  private imageEntries = new Map<string, ImageEntry>();

  constructor(
    private readonly libraryRootPath = config.garmentLibraryRoot,
    private readonly groupDefinitions = config.garmentGroups,
  ) {}

  async listGroups(): Promise<GarmentGroup[]> {
    const groups: GarmentGroup[] = [{ id: 'featured', name: '精选', garments: garments.filter((garment) => garment.enabled) }];
    const libraryRoot = await realpath(this.libraryRootPath).catch(() => null);
    const nextImageEntries = new Map<string, ImageEntry>();

    for (const definition of this.groupDefinitions) {
      if (!libraryRoot) {
        groups.push({ id: definition.id, name: definition.name, garments: [] });
        continue;
      }
      const requestedDirectory = path.resolve(libraryRoot, definition.directory);
      let directory: string;
      try {
        directory = await realpath(requestedDirectory);
        const directoryStat = await stat(directory);
        if (!directoryStat.isDirectory() || !isPathInside(libraryRoot, directory)) {
          groups.push({ id: definition.id, name: definition.name, garments: [] });
          continue;
        }
      } catch {
        groups.push({ id: definition.id, name: definition.name, garments: [] });
        continue;
      }

      const imagePaths = await collectImages(directory);
      const groupGarments = await Promise.all(imagePaths.map(async (absolutePath): Promise<Garment> => {
        const relativePath = path.relative(directory, absolutePath).split(path.sep).join('/');
        const extension = path.extname(absolutePath).toLowerCase();
        const imageId = crypto.createHash('sha256').update(`${definition.id}\0${relativePath}`).digest('hex');
        nextImageEntries.set(imageId, { absolutePath, libraryRoot, contentType: imageTypes[extension] });
        return {
          id: `${definition.id}:${imageId}`,
          name: path.basename(absolutePath, extension),
          image: `/api/garment-images/${imageId}`,
          prompt: definition.prompt || 'Replace the current upper-body garment with the garment shown in the reference image. Preserve the person, pose, face, hands, and background.',
          enabled: true,
        };
      }));
      groups.push({ id: definition.id, name: definition.name, garments: groupGarments });
    }

    this.imageEntries = nextImageEntries;
    return groups;
  }

  async readImage(imageId: string): Promise<{ contentType: string; body: Buffer } | null> {
    const entry = this.imageEntries.get(imageId);
    if (!entry) return null;
    try {
      const resolvedPath = await realpath(entry.absolutePath);
      if (!isPathInside(entry.libraryRoot, resolvedPath) || !(await stat(resolvedPath)).isFile()) return null;
      return { contentType: entry.contentType, body: await readFile(resolvedPath) };
    } catch {
      return null;
    }
  }
}
