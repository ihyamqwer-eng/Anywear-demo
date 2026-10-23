import { randomUUID } from 'node:crypto';

export const DEFAULT_PROVIDER_GROUP_ID = 'provider-group-default';

interface ProviderKeyEntry {
  id: string;
  value: string;
  label: string;
  enabled: boolean;
  groupId: string;
  activeSessions: number;
  cooldownUntil: number;
}

export interface StoredProviderKey {
  id: string;
  value: string;
  label: string;
  enabled: boolean;
  groupId?: string;
}

export interface StoredProviderKeyGroup {
  id: string;
  name: string;
}

export interface StoredProviderKeyConfiguration {
  version: 2;
  activeGroupId: string;
  groups: StoredProviderKeyGroup[];
  keys: StoredProviderKey[];
}

interface ProviderKeyGroup extends StoredProviderKeyGroup {
  poolId: string;
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
  groupId: string;
}

export interface ProviderKeyGroupManagementStatus extends StoredProviderKeyGroup {
  active: boolean;
  totalKeys: number;
  enabledKeys: number;
  activeSessions: number;
  cards: ProviderKeyManagementStatus[];
}

export class ProviderKeyPool {
  private readonly entries: ProviderKeyEntry[];
  private readonly groups: ProviderKeyGroup[];
  private activeGroupId: string;
  private readonly rotationEntryIds = new Map<string, string>();
  private nextSequence: number;

  constructor(
    values: readonly string[] | readonly StoredProviderKey[],
    private readonly cooldownSeconds: number,
    storedGroups: readonly StoredProviderKeyGroup[] = [],
    activeGroupId?: string,
  ) {
    const sourceGroups = storedGroups.length > 0
      ? storedGroups
      : [{ id: DEFAULT_PROVIDER_GROUP_ID, name: '默认分组' }];
    this.groups = sourceGroups.map((group) => ({ ...group, poolId: randomUUID() }));
    this.activeGroupId = this.groups.some((group) => group.id === activeGroupId)
      ? activeGroupId!
      : this.groups[0]!.id;
    const fallbackGroupId = this.groups[0]!.id;
    this.entries = values.map((item, index) => {
      const record = typeof item === 'string'
        ? { id: `provider-key-${index + 1}`, value: item, label: `API Key ${index + 1}`, enabled: true }
        : { ...item, enabled: item.enabled ?? true };
      const groupId = record.groupId && this.groups.some((group) => group.id === record.groupId)
        ? record.groupId
        : fallbackGroupId;
      return { ...record, groupId, activeSessions: 0, cooldownUntil: 0 };
    });
    this.nextSequence = this.entries.reduce((next, entry) => {
      const sequence = /^provider-key-(\d+)$/.exec(entry.id)?.[1];
      return sequence ? Math.max(next, Number.parseInt(sequence, 10) + 1) : next;
    }, 1);
  }

  get poolId(): string {
    return this.activeGroup.poolId;
  }

  get activeGroup(): ProviderKeyGroup {
    return this.groups.find((group) => group.id === this.activeGroupId)!;
  }

  get activeProviderGroupId(): string {
    return this.activeGroupId;
  }

  get size(): number {
    return this.entries.filter((entry) => entry.groupId === this.activeGroupId && entry.enabled).length;
  }

  get totalSize(): number {
    return this.entries.length;
  }

  add(value: string, label?: string): string {
    const record = this.prepareAdd(value, label);
    this.addRecord(record);
    return record.id;
  }

  prepareAdd(value: string, label?: string, groupId = this.activeGroupId): StoredProviderKey {
    if (this.entries.length >= 100) throw new Error('The API key pool cannot contain more than 100 keys');
    if (!this.groups.some((group) => group.id === groupId)) throw new Error('The provider key group does not exist');
    if (this.entries.some((entry) => entry.value === value)) throw new Error('This API key is already in the pool');
    const groupKeyCount = this.entries.filter((entry) => entry.groupId === groupId).length;
    return {
      id: `provider-key-${this.nextSequence}`,
      value,
      label: label?.trim() || `API Key ${groupKeyCount + 1}`,
      enabled: true,
      groupId,
    };
  }

  addRecord(record: StoredProviderKey): void {
    const groupId = record.groupId ?? this.activeGroupId;
    if (record.id !== `provider-key-${this.nextSequence}`
      || this.entries.some((entry) => entry.value === record.value)
      || !this.groups.some((group) => group.id === groupId)) {
      throw new Error('The API key pool changed before the key could be added');
    }
    this.entries.push({ ...record, groupId, activeSessions: 0, cooldownUntil: 0 });
    this.nextSequence += 1;
    this.refreshGroupPoolId(groupId);
  }

  prepareCreateGroup(name: string): StoredProviderKeyGroup {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) throw new Error('The provider group name is invalid');
    if (this.groups.length >= 50) throw new Error('The provider key pool cannot contain more than 50 groups');
    if (this.groups.some((group) => group.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
      throw new Error('A provider key group with this name already exists');
    }
    return { id: `provider-group-${randomUUID()}`, name: normalizedName };
  }

  addGroup(group: StoredProviderKeyGroup, activate = true): void {
    if (this.groups.some((candidate) => candidate.id === group.id
      || candidate.name.toLocaleLowerCase() === group.name.toLocaleLowerCase())) {
      throw new Error('The provider key group changed before it could be added');
    }
    this.groups.push({ ...group, poolId: randomUUID() });
    if (activate) this.activeGroupId = group.id;
  }

  renameGroup(id: string, name: string): boolean {
    const group = this.groups.find((candidate) => candidate.id === id);
    const normalizedName = name.trim();
    if (!group || !normalizedName || normalizedName.length > 80
      || this.groups.some((candidate) => candidate.id !== id
        && candidate.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) return false;
    group.name = normalizedName;
    return true;
  }

  removeGroup(id: string): boolean {
    const index = this.groups.findIndex((group) => group.id === id);
    if (index < 0 || id === this.activeGroupId || this.entries.some((entry) => entry.groupId === id)) return false;
    this.groups.splice(index, 1);
    this.rotationEntryIds.delete(id);
    return true;
  }

  activateGroup(id: string): boolean {
    if (!this.groups.some((group) => group.id === id)) return false;
    this.activeGroupId = id;
    return true;
  }

  move(id: string, groupId: string): boolean {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.groupId === groupId || entry.activeSessions > 0 || !this.groups.some((group) => group.id === groupId)) return false;
    const previousGroupId = entry.groupId;
    this.advanceRotationPastEntry(previousGroupId, entry.id);
    entry.groupId = groupId;
    this.refreshGroupPoolId(previousGroupId);
    this.refreshGroupPoolId(groupId);
    return true;
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    const entry = this.entries[index];
    if (index < 0 || !entry || entry.activeSessions > 0) return false;
    this.advanceRotationPastEntry(entry.groupId, entry.id);
    this.entries.splice(index, 1);
    this.refreshGroupPoolId(entry.groupId);
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.enabled === enabled) return false;
    entry.enabled = enabled;
    this.refreshGroupPoolId(entry.groupId);
    return true;
  }

  restore(record: StoredProviderKey, index: number): void {
    if (this.entries.some((entry) => entry.id === record.id)) return;
    const groupId = record.groupId && this.groups.some((group) => group.id === record.groupId)
      ? record.groupId
      : this.activeGroupId;
    this.entries.splice(index, 0, { ...record, groupId, activeSessions: 0, cooldownUntil: 0 });
    this.nextSequence = Math.max(this.nextSequence, Number(/^provider-key-(\d+)$/.exec(record.id)?.[1] ?? 0) + 1);
    this.refreshGroupPoolId(groupId);
  }

  acquire(requestedId?: string): ProviderKeyLease | null {
    const entries = this.activeEntries;
    if (entries.length === 0) return null;
    const storedRotationId = this.rotationEntryIds.get(this.activeGroupId);
    const storedRotationIndex = entries.findIndex((entry) => entry.id === storedRotationId);
    const rotationIndex = storedRotationIndex < 0 ? 0 : storedRotationIndex;
    const now = Date.now();

    if (requestedId !== undefined) {
      const index = entries.findIndex((entry) => entry.id === requestedId);
      const entry = entries[index];
      if (!entry || !entry.enabled || entry.cooldownUntil > now) return null;
      entry.activeSessions += 1;
      this.rotationEntryIds.set(this.activeGroupId, entries[(index + 1) % entries.length]!.id);
      return { id: entry.id, value: entry.value };
    }

    const available = entries.filter((entry) => entry.enabled && entry.cooldownUntil <= now);
    if (available.length === 0) return null;

    const leastActive = Math.min(...available.map((entry) => entry.activeSessions));
    for (let offset = 0; offset < entries.length; offset += 1) {
      const index = (rotationIndex + offset) % entries.length;
      const entry = entries[index];
      if (!entry || !entry.enabled || entry.cooldownUntil > now || entry.activeSessions !== leastActive) continue;
      entry.activeSessions += 1;
      this.rotationEntryIds.set(this.activeGroupId, entries[(index + 1) % entries.length]!.id);
      return { id: entry.id, value: entry.value };
    }

    return null;
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id && entry.groupId === this.activeGroupId && entry.enabled);
  }

  getStatus(): ProviderKeyStatus[] {
    return this.toStatus(this.activeEntries.filter((entry) => entry.enabled));
  }

  getManagementStatus(groupId = this.activeGroupId): Omit<ProviderKeyManagementStatus, 'groupId'>[] {
    return this.toManagementStatus(this.entries.filter((entry) => entry.groupId === groupId))
      .map(({ id, number, activeSessions, cooldownSecondsRemaining, label, keyHint, enabled }) => ({
        id,
        number,
        activeSessions,
        cooldownSecondsRemaining,
        label,
        keyHint,
        enabled,
      }));
  }

  getAllManagementStatus(): Omit<ProviderKeyManagementStatus, 'groupId'>[] {
    return this.toManagementStatus(this.entries)
      .map(({ id, number, activeSessions, cooldownSecondsRemaining, label, keyHint, enabled }) => ({
        id,
        number,
        activeSessions,
        cooldownSecondsRemaining,
        label,
        keyHint,
        enabled,
      }));
  }

  getGroupsManagementStatus(): ProviderKeyGroupManagementStatus[] {
    return this.groups.map((group) => {
      const cards = this.toManagementStatus(this.entries.filter((entry) => entry.groupId === group.id));
      return {
        id: group.id,
        name: group.name,
        active: group.id === this.activeGroupId,
        totalKeys: cards.length,
        enabledKeys: cards.filter((card) => card.enabled).length,
        activeSessions: cards.reduce((sum, card) => sum + card.activeSessions, 0),
        cards,
      };
    });
  }

  getStoredKeys(): StoredProviderKey[] {
    return this.entries.map(({ id, value, label, enabled, groupId }) => ({ id, value, label, enabled, groupId }));
  }

  getStoredGroups(): StoredProviderKeyGroup[] {
    return this.groups.map(({ id, name }) => ({ id, name }));
  }

  getStoredConfiguration(): StoredProviderKeyConfiguration {
    return {
      version: 2,
      activeGroupId: this.activeGroupId,
      groups: this.getStoredGroups(),
      keys: this.getStoredKeys(),
    };
  }

  release(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) entry.activeSessions = Math.max(0, entry.activeSessions - 1);
  }

  markFailure(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) entry.cooldownUntil = Date.now() + this.cooldownSeconds * 1000;
  }

  private get activeEntries(): ProviderKeyEntry[] {
    return this.entries.filter((entry) => entry.groupId === this.activeGroupId);
  }

  private toStatus(entries: readonly ProviderKeyEntry[]): ProviderKeyStatus[] {
    const now = Date.now();
    return entries.map((entry, index) => ({
      id: entry.id,
      number: index + 1,
      activeSessions: entry.activeSessions,
      cooldownSecondsRemaining: Math.max(0, Math.ceil((entry.cooldownUntil - now) / 1000)),
    }));
  }

  private toManagementStatus(entries: readonly ProviderKeyEntry[]): ProviderKeyManagementStatus[] {
    const now = Date.now();
    return entries.map((entry, index) => ({
      id: entry.id,
      number: index + 1,
      label: entry.label,
      keyHint: `****${entry.value.slice(-4)}`,
      enabled: entry.enabled,
      groupId: entry.groupId,
      activeSessions: entry.activeSessions,
      cooldownSecondsRemaining: Math.max(0, Math.ceil((entry.cooldownUntil - now) / 1000)),
    }));
  }

  private refreshGroupPoolId(groupId: string): void {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    if (group) group.poolId = randomUUID();
  }

  private advanceRotationPastEntry(groupId: string, entryId: string): void {
    if (this.rotationEntryIds.get(groupId) !== entryId) return;
    const groupEntries = this.entries.filter((entry) => entry.groupId === groupId);
    const index = groupEntries.findIndex((entry) => entry.id === entryId);
    for (let offset = 1; offset < groupEntries.length; offset += 1) {
      const nextEntry = groupEntries[(index + offset) % groupEntries.length];
      if (nextEntry && nextEntry.id !== entryId) {
        this.rotationEntryIds.set(groupId, nextEntry.id);
        return;
      }
    }
    this.rotationEntryIds.delete(groupId);
  }
}
