import { randomUUID } from 'node:crypto';

interface ProviderKeyEntry {
  id: string;
  value: string;
  activeSessions: number;
  cooldownUntil: number;
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

export class ProviderKeyPool {
  readonly poolId = randomUUID();
  private readonly entries: ProviderKeyEntry[];
  private nextIndex = 0;

  constructor(values: readonly string[], private readonly cooldownSeconds: number) {
    this.entries = values.map((value, index) => ({
      id: `provider-key-${index + 1}`,
      value,
      activeSessions: 0,
      cooldownUntil: 0,
    }));
  }

  acquire(requestedId?: string): ProviderKeyLease | null {
    if (this.entries.length === 0) return null;
    const now = Date.now();

    if (requestedId !== undefined) {
      const index = this.entries.findIndex((entry) => entry.id === requestedId);
      const entry = this.entries[index];
      if (!entry || entry.cooldownUntil > now) return null;
      entry.activeSessions += 1;
      this.nextIndex = (index + 1) % this.entries.length;
      return { id: entry.id, value: entry.value };
    }

    const available = this.entries.filter((entry) => entry.cooldownUntil <= now);
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
    return this.entries.some((entry) => entry.id === id);
  }

  getStatus(): ProviderKeyStatus[] {
    const now = Date.now();
    return this.entries.map((entry, index) => ({
      id: entry.id,
      number: index + 1,
      activeSessions: entry.activeSessions,
      cooldownSecondsRemaining: Math.max(0, Math.ceil((entry.cooldownUntil - now) / 1000)),
    }));
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
