import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(moduleDirectory, '..', '..', '.env') });
dotenv.config();

function positiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function providerKeys(): string[] {
  const values = [process.env.DECART_API_KEYS ?? '', process.env.DECART_API_KEY ?? '']
    .flatMap((value) => value.split(/[\r\n,]+/))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
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
  providerKeyCooldownSeconds: positiveInteger('DECART_KEY_COOLDOWN_SECONDS', 60),
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
