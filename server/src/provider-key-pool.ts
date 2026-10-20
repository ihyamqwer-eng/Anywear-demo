import { randomUUID } from 'node:crypto';

interface ProviderKeyEntry {
  id: string;
  value: string;
  label: string;
  enabled: boolean;
  activeSessions: number;
  cooldownUntil: number;
}

export interface StoredProviderKey {
  id: string;
  value: string;
  label: string;
  enabled: boolean;
}

export interface ProviderKeyLease {
  id: string;
  value: string;
}

export interface ProviderKeyStatus {
  id: string;
  number: number;
  activeSessions: number;
  cooldownSecondsRemaining: number;
}

export interface ProviderKeyManagementStatus extends ProviderKeyStatus {
  label: string;
  keyHint: string;
  enabled: boolean;
}

export class ProviderKeyPool {
  private currentPoolId = randomUUID();
  private readonly entries: ProviderKeyEntry[];
  private nextIndex = 0;
  private nextSequence: number;

  constructor(values: readonly string[] | readonly StoredProviderKey[], private readonly cooldownSeconds: number) {
    this.entries = values.map((item, index) => {
      const record = typeof item === 'string'
        ? { id: `provider-key-${index + 1}`, value: item, label: `API Key ${index + 1}`, enabled: true }
        : { ...item, enabled: item.enabled ?? true };
      return { ...record, activeSessions: 0, cooldownUntil: 0 };
    });
    this.nextSequence = this.entries.reduce((next, entry) => {
      const sequence = /^provider-key-(\d+)$/.exec(entry.id)?.[1];
      return sequence ? Math.max(next, Number.parseInt(sequence, 10) + 1) : next;
    }, 1);
  }

  get poolId(): string {
    return this.currentPoolId;
  }

  get size(): number {
    return this.entries.filter((entry) => entry.enabled).length;
  }

  add(value: string, label?: string): string {
    const record = this.prepareAdd(value, label);
    this.addRecord(record);
    return record.id;
  }

  prepareAdd(value: string, label?: string): StoredProviderKey {
    if (this.entries.length >= 100) throw new Error('The API key pool cannot contain more than 100 keys');
    if (this.entries.some((entry) => entry.value === value)) throw new Error('This API key is already in the pool');
    return {
      id: `provider-key-${this.nextSequence}`,
      value,
      label: label?.trim() || `API Key ${this.entries.length + 1}`,
      enabled: true,
    };
  }

  addRecord(record: StoredProviderKey): void {
    if (record.id !== `provider-key-${this.nextSequence}` || this.entries.some((entry) => entry.value === record.value)) {
      throw new Error('The API key pool changed before the key could be added');
    }
    this.entries.push({ ...record, activeSessions: 0, cooldownUntil: 0 });
    this.nextSequence += 1;
    this.currentPoolId = randomUUID();
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0 || this.entries[index]!.activeSessions > 0) return false;
    this.entries.splice(index, 1);
    this.nextIndex = this.entries.length === 0 ? 0 : this.nextIndex % this.entries.length;
    this.currentPoolId = randomUUID();
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.enabled === enabled) return false;
    entry.enabled = enabled;
    this.currentPoolId = randomUUID();
    return true;
  }

  restore(record: StoredProviderKey, index: number): void {
    if (this.entries.some((entry) => entry.id === record.id)) return;
    this.entries.splice(index, 0, { ...record, activeSessions: 0, cooldownUntil: 0 });
    this.nextSequence = Math.max(this.nextSequence, Number(/^provider-key-(\d+)$/.exec(record.id)?.[1] ?? 0) + 1);
    this.currentPoolId = randomUUID();
  }

  acquire(requestedId?: string): ProviderKeyLease | null {
    if (this.entries.length === 0) return null;
    const now = Date.now();

    if (requestedId !== undefined) {
      const index = this.entries.findIndex((entry) => entry.id === requestedId);
      const entry = this.entries[index];
      if (!entry || !entry.enabled || entry.cooldownUntil > now) return null;
      entry.activeSessions += 1;
      this.nextIndex = (index + 1) % this.entries.length;
      return { id: entry.id, value: entry.value };
    }

    const available = this.entries.filter((entry) => entry.enabled && entry.cooldownUntil <= now);
    if (available.length === 0) return null;

    const leastActive = Math.min(...available.map((entry) => entry.activeSessions));
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const index = (this.nextIndex + offset) % this.entries.length;
      const entry = this.entries[index];
      if (entry.cooldownUntil > now || entry.activeSessions !== leastActive) continue;
      entry.activeSessions += 1;
      this.nextIndex = (index + 1) % this.entries.length;
      return { id: entry.id, value: entry.value };
    }

    return null;
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id && entry.enabled);
  }

  getStatus(): ProviderKeyStatus[] {
    const now = Date.now();
    return this.entries.filter((entry) => entry.enabled).map((entry, index) => ({
      id: entry.id,
      number: index + 1,
      activeSessions: entry.activeSessions,
      cooldownSecondsRemaining: Math.max(0, Math.ceil((entry.cooldownUntil - now) / 1000)),
    }));
  }

  getManagementStatus(): ProviderKeyManagementStatus[] {
    return this.entries.map((entry, index) => ({
      id: entry.id,
      number: index + 1,
      label: entry.label,
      keyHint: `****${entry.value.slice(-4)}`,
      enabled: entry.enabled,
      activeSessions: entry.activeSessions,
      cooldownSecondsRemaining: Math.max(0, Math.ceil((entry.cooldownUntil - Date.now()) / 1000)),
    }));
  }

  getStoredKeys(): StoredProviderKey[] {
    return this.entries.map(({ id, value, label, enabled }) => ({ id, value, label, enabled }));
  }

  release(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) entry.activeSessions = Math.max(0, entry.activeSessions - 1);
  }

  markFailure(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) entry.cooldownUntil = Date.now() + this.cooldownSeconds * 1000;
  }
}
