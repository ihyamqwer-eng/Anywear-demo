import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_PROVIDER_GROUP_ID,
  type StoredProviderKey,
  type StoredProviderKeyConfiguration,
  type StoredProviderKeyGroup,
} from './provider-key-pool.js';

const defaultGroup: StoredProviderKeyGroup = { id: DEFAULT_PROVIDER_GROUP_ID, name: '默认分组' };

export class ProviderKeyStore {
  private operationQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  load(fallbackKeys: readonly string[]): StoredProviderKey[] {
    return this.loadConfiguration(fallbackKeys).keys;
  }

  loadConfiguration(fallbackKeys: readonly string[]): StoredProviderKeyConfiguration {
    if (!existsSync(this.filePath)) {
      return {
        version: 2,
        activeGroupId: defaultGroup.id,
        groups: [{ ...defaultGroup }],
        keys: fallbackKeys.map((value, index) => ({
          id: `provider-key-${index + 1}`,
          value,
          label: `API Key ${index + 1}`,
          enabled: true,
          groupId: defaultGroup.id,
        })),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new Error('The saved API key pool is invalid; repair or remove provider-keys.json to continue');
    }

    if (Array.isArray(parsed)) {
      return {
        version: 2,
        activeGroupId: defaultGroup.id,
        groups: [{ ...defaultGroup }],
        keys: this.validateKeys(parsed, defaultGroup.id, true),
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('The saved API key pool must be a group configuration');
    }

    const configuration = parsed as Record<string, unknown>;
    if (configuration.version !== 2
      || typeof configuration.activeGroupId !== 'string'
      || !Array.isArray(configuration.groups)
      || !Array.isArray(configuration.keys)) {
      throw new Error('The saved API key group configuration is invalid');
    }
    if (configuration.groups.length < 1 || configuration.groups.length > 50) {
      throw new Error('The saved API key pool must contain between 1 and 50 groups');
    }

    const groupIds = new Set<string>();
    const groupNames = new Set<string>();
    const groups = configuration.groups.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`Saved provider group ${index + 1} is invalid`);
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || !/^provider-group-[a-zA-Z0-9-]{1,64}$/.test(record.id) || groupIds.has(record.id)) {
        throw new Error(`Saved provider group ${index + 1} has an invalid identifier`);
      }
      if (typeof record.name !== 'string' || !record.name.trim() || record.name.trim().length > 80) {
        throw new Error(`Saved provider group ${index + 1} has an invalid name`);
      }
      const normalizedName = record.name.trim().toLowerCase();
      if (groupNames.has(normalizedName)) throw new Error('Saved provider group names must be unique');
      groupIds.add(record.id);
      groupNames.add(normalizedName);
      return { id: record.id, name: record.name.trim() };
    });
    if (!groupIds.has(configuration.activeGroupId)) {
      throw new Error('The active provider group does not exist');
    }

    return {
      version: 2,
      activeGroupId: configuration.activeGroupId,
      groups,
      keys: this.validateKeys(configuration.keys, groups[0]!.id, false, groupIds),
    };
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async save(configuration: StoredProviderKeyConfiguration | readonly StoredProviderKey[]): Promise<void> {
    const payload = Array.isArray(configuration)
      ? configuration
      : configuration;
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private validateKeys(
    values: unknown[],
    fallbackGroupId: string,
    allowMissingGroupId: boolean,
    groupIds = new Set([fallbackGroupId]),
  ): StoredProviderKey[] {
    if (values.length > 100) throw new Error('The saved API key pool cannot contain more than 100 keys');
    const ids = new Set<string>();
    const credentials = new Set<string>();
    return values.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`Saved API key ${index + 1} is invalid`);
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || !/^provider-key-\d+$/.test(record.id) || ids.has(record.id)) {
        throw new Error(`Saved API key ${index + 1} has an invalid identifier`);
      }
      if (typeof record.value !== 'string' || !record.value.trim() || record.value.length > 4096 || credentials.has(record.value)) {
        throw new Error(`Saved API key ${index + 1} has an invalid or duplicate value`);
      }
      if (typeof record.label !== 'string' || !record.label.trim() || record.label.length > 80) {
        throw new Error(`Saved API key ${index + 1} has an invalid label`);
      }
      if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
        throw new Error(`Saved API key ${index + 1} has an invalid enabled state`);
      }
      const groupId = record.groupId === undefined && allowMissingGroupId
        ? fallbackGroupId
        : record.groupId;
      if (typeof groupId !== 'string' || !groupIds.has(groupId)) {
        throw new Error(`Saved API key ${index + 1} references an unknown provider group`);
      }
      ids.add(record.id);
      credentials.add(record.value);
      return {
        id: record.id,
        value: record.value,
        label: record.label.trim(),
        enabled: record.enabled ?? true,
        groupId,
      };
    });
  }
}
