import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoredProviderKey } from './provider-key-pool.js';

export class ProviderKeyStore {
  private operationQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  load(fallbackKeys: readonly string[]): StoredProviderKey[] {
    if (!existsSync(this.filePath)) {
      return fallbackKeys.map((value, index) => ({
        id: `provider-key-${index + 1}`,
        value,
        label: `API Key ${index + 1}`,
        enabled: true,
      }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new Error('The saved API key pool is invalid; repair or remove provider-keys.json to continue');
    }
    if (!Array.isArray(parsed)) throw new Error('The saved API key pool must be an array');
    if (parsed.length > 100) throw new Error('The saved API key pool cannot contain more than 100 keys');

    const ids = new Set<string>();
    const values = new Set<string>();
    return parsed.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`Saved API key ${index + 1} is invalid`);
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || !/^provider-key-\d+$/.test(record.id) || ids.has(record.id)) {
        throw new Error(`Saved API key ${index + 1} has an invalid identifier`);
      }
      if (typeof record.value !== 'string' || !record.value.trim() || record.value.length > 4096 || values.has(record.value)) {
        throw new Error(`Saved API key ${index + 1} has an invalid or duplicate value`);
      }
      if (typeof record.label !== 'string' || !record.label.trim() || record.label.length > 80) {
        throw new Error(`Saved API key ${index + 1} has an invalid label`);
      }
      if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
        throw new Error(`Saved API key ${index + 1} has an invalid enabled state`);
      }
      ids.add(record.id);
      values.add(record.value);
      return { id: record.id, value: record.value, label: record.label.trim(), enabled: record.enabled ?? true };
    });
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async save(keys: readonly StoredProviderKey[]): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, JSON.stringify(keys, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
