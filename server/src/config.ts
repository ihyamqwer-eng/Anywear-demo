import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: resolve(moduleDirectory, '..', '..', '.env') });
  dotenv.config();
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function providerKeys(): string[] {
  const values = [process.env.DECART_API_KEYS ?? '', process.env.DECART_API_KEY ?? '']
    .flatMap((value) => value.split(/[\r\n,]+/))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

export interface GarmentGroupConfig {
  id: string;
  name: string;
  directory: string;
  prompt?: string;
}

function garmentGroups(): GarmentGroupConfig[] {
  const raw = process.env.GARMENT_GROUPS_JSON?.trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('GARMENT_GROUPS_JSON must be a JSON array');
  const seenIds = new Set<string>(['featured', 'uploaded']);
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`GARMENT_GROUPS_JSON[${index}] must be an object`);
    const group = item as Record<string, unknown>;
    if (typeof group.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(group.id)) {
      throw new Error(`GARMENT_GROUPS_JSON[${index}].id is invalid`);
    }
    if (seenIds.has(group.id)) throw new Error(`GARMENT_GROUPS_JSON[${index}].id is duplicated or reserved`);
    seenIds.add(group.id);
    if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80) {
      throw new Error(`GARMENT_GROUPS_JSON[${index}].name is invalid`);
    }
    if (typeof group.directory !== 'string' || !group.directory.trim()) {
      throw new Error(`GARMENT_GROUPS_JSON[${index}].directory is invalid`);
    }
    if (group.prompt !== undefined && (typeof group.prompt !== 'string' || group.prompt.length > 2000)) {
      throw new Error(`GARMENT_GROUPS_JSON[${index}].prompt is invalid`);
    }
    return {
      id: group.id,
      name: group.name.trim(),
      directory: group.directory.trim(),
      ...(typeof group.prompt === 'string' ? { prompt: group.prompt } : {}),
    };
  });
}

const speed = process.env.DECART_SPEED === 'fast' ? 'fast' : 'standard';
const configuredProviderKeys = providerKeys();
const defaultAllowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? defaultAllowedOrigins.join(','))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const config = {
  apiKey: configuredProviderKeys[0] ?? '',
  providerKeys: configuredProviderKeys,
  providerKeyCooldownSeconds: nonNegativeInteger('DECART_KEY_COOLDOWN_SECONDS', 0),
  garmentLibraryRoot: process.env.GARMENT_LIBRARY_ROOT?.trim() || resolve(moduleDirectory, '..', '..', 'garment-library'),
  garmentGroups: garmentGroups(),
  model: process.env.DECART_MODEL?.trim() || 'lucy-vton-3.6',
  speed,
  host: process.env.HOST?.trim() || '127.0.0.1',
  sessionTtlSeconds: positiveInteger('SESSION_TTL_SECONDS', 120),
  maxGenerationSeconds: positiveInteger('MAX_GENERATION_SECONDS', 120),
  port: positiveInteger('PORT', 8787),
  allowedOrigins,
  upstreamOrigin: 'wss://api.decart.ai/v1/stream',
} as const;

export function hasProviderKey(): boolean {
  return config.providerKeys.length > 0;
}
