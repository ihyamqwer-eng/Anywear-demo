import crypto from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

interface StoredGroup {
  id: string;
  name: string;
}

export interface StagedGarmentImport {
  stagingDirectory: string;
  name?: string;
  groupId?: string;
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
  private importQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly libraryRootPath = config.garmentLibraryRoot,
    private readonly groupDefinitions = config.garmentGroups,
    private readonly uploadRootPath = config.garmentDataDirectory,
  ) {}

  private async readStoredGroups(): Promise<StoredGroup[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.uploadRootPath, 'groups.json'), 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('groups' in parsed) || !Array.isArray(parsed.groups)) {
      throw new Error('Stored garment groups are invalid');
    }
    const ids = new Set<string>();
    return parsed.groups.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`Stored garment group ${index} is invalid`);
      const group = item as Record<string, unknown>;
      if (typeof group.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(group.id) || group.id === 'featured') {
        throw new Error(`Stored garment group ${index} has an invalid ID`);
      }
      if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || ids.has(group.id)) {
        throw new Error(`Stored garment group ${index} has an invalid name or duplicate ID`);
      }
      ids.add(group.id);
      return { id: group.id, name: group.name.trim() };
    });
  }

  private async writeStoredGroups(groups: StoredGroup[]): Promise<void> {
    const temporaryPath = path.join(this.uploadRootPath, `.groups-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, groups }, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, path.join(this.uploadRootPath, 'groups.json'));
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async importStagedGroup(input: StagedGarmentImport): Promise<{ group: GarmentGroup; created: boolean }> {
    const operation = this.importQueue.then(async () => {
      await mkdir(this.uploadRootPath, { recursive: true });
      const uploadRoot = await realpath(this.uploadRootPath);
      const stagingDirectory = await realpath(input.stagingDirectory);
      if (!isPathInside(uploadRoot, stagingDirectory) || path.dirname(stagingDirectory) !== path.join(uploadRoot, '.tmp')) {
        throw new Error('Garment import staging directory is invalid');
      }

      const storedGroups = await this.readStoredGroups();
      const existingGroup = input.groupId ? storedGroups.find((group) => group.id === input.groupId) : undefined;
      const configuredGroup = input.groupId ? this.groupDefinitions.find((group) => group.id === input.groupId) : undefined;
      const appendToDefault = input.groupId === 'user-garment-uploads';
      if (input.groupId && !existingGroup && !configuredGroup && !appendToDefault) {
        const error = new Error('Garment group not found') as Error & { statusCode: number; code: string };
        error.statusCode = 404;
        error.code = 'GARMENT_GROUP_NOT_FOUND';
        throw error;
      }
      const created = !existingGroup && !configuredGroup;
      const id = configuredGroup?.id ?? existingGroup?.id ?? input.groupId ?? crypto.randomUUID();
      const name = configuredGroup?.name ?? existingGroup?.name ?? (appendToDefault ? '我的上传' : input.name?.trim());
      if (!name || name.length > 80) {
        const error = new Error('Group name must contain 1 to 80 characters') as Error & { statusCode: number; code: string };
        error.statusCode = 400;
        error.code = 'INVALID_GARMENT_GROUP_NAME';
        throw error;
      }

      const groupsRootPath = path.join(uploadRoot, 'groups');
      await mkdir(groupsRootPath, { recursive: true });
      const groupsRoot = await realpath(groupsRootPath);
      if (!isPathInside(uploadRoot, groupsRoot)) throw new Error('Garment group storage directory is invalid');
      const groupRootPath = path.join(groupsRoot, id);
      await mkdir(groupRootPath, { recursive: true });
      const groupRoot = await realpath(groupRootPath);
      if (!isPathInside(groupsRoot, groupRoot)) throw new Error('Garment group storage directory is invalid');

      const batchPath = path.join(groupRoot, crypto.randomUUID());
      await rename(stagingDirectory, batchPath);
      try {
        const nextGroups = existingGroup || configuredGroup
          ? storedGroups
          : [...storedGroups, { id, name }];
        await this.writeStoredGroups(nextGroups);
      } catch (error) {
        await rm(batchPath, { recursive: true, force: true });
        throw error;
      }

      const group = (await this.listGroups()).find((candidate) => candidate.id === id);
      if (!group) throw new Error('Imported garment group could not be reloaded');
      return { group, created };
    });
    this.importQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async listGroups(): Promise<GarmentGroup[]> {
    const groups: GarmentGroup[] = [{ id: 'featured', name: '精选', garments: garments.filter((garment) => garment.enabled) }];
    const libraryRoot = await realpath(this.libraryRootPath).catch(() => null);
    const uploadRoot = await realpath(path.join(this.uploadRootPath, 'groups')).catch(() => null);
    const storedGroups = await this.readStoredGroups();
    const nextImageEntries = new Map<string, ImageEntry>();

    const definitions = this.groupDefinitions.map((definition) => ({
      ...definition,
      sources: [
        { root: libraryRoot, directory: definition.directory },
        { root: uploadRoot, directory: definition.id },
      ],
    }));
    for (const group of storedGroups) {
      if (!definitions.some((definition) => definition.id === group.id)) {
        definitions.push({
          ...group,
          directory: group.id,
          sources: [{ root: uploadRoot, directory: group.id }],
        });
      }
    }

    for (const definition of definitions) {
      const groupGarments: Garment[] = [];
      for (const source of definition.sources) {
        if (!source.root) continue;
        const requestedDirectory = path.resolve(source.root, source.directory);
        let directory: string;
        try {
          directory = await realpath(requestedDirectory);
          const directoryStat = await stat(directory);
          if (!directoryStat.isDirectory() || !isPathInside(source.root, directory)) continue;
        } catch {
          continue;
        }

        const imagePaths = await collectImages(directory);
        groupGarments.push(...await Promise.all(imagePaths.map(async (absolutePath): Promise<Garment> => {
          const relativePath = path.relative(directory, absolutePath).split(path.sep).join('/');
          const extension = path.extname(absolutePath).toLowerCase();
          const imageId = crypto.createHash('sha256').update(`${definition.id}\0${relativePath}`).digest('hex');
          nextImageEntries.set(imageId, { absolutePath, libraryRoot: source.root!, contentType: imageTypes[extension] });
          return {
            id: `${definition.id}:${imageId}`,
            name: path.basename(absolutePath, extension),
            image: `/api/garment-images/${imageId}`,
            prompt: definition.prompt || 'Replace the current upper-body garment with the garment shown in the reference image. Preserve the person, pose, face, hands, and background.',
            enabled: true,
          };
        })));
      }
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
