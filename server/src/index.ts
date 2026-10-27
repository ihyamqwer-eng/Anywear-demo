import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { garments } from './garments.js';
import { GarmentLibrary } from './garment-library.js';
import { ProviderKeyPool } from './provider-key-pool.js';
import { ProviderKeyStore } from './provider-key-store.js';
import { SessionManager } from './session-manager.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const providerKeyStore = new ProviderKeyStore(config.providerKeyStorePath);
const providerKeyConfiguration = providerKeyStore.loadConfiguration(config.providerKeys);
const providerKeyPool = new ProviderKeyPool(
  providerKeyConfiguration.keys,
  config.providerKeyCooldownSeconds,
  providerKeyConfiguration.groups,
  providerKeyConfiguration.activeGroupId,
);
const sessions = new SessionManager(providerKeyPool, undefined, app.log as FastifyBaseLogger);
const garmentLibrary = new GarmentLibrary();

function isServicePath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/ws' || pathname.startsWith('/ws/');
}

async function requireAllowedOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) return;
  request.log.warn({ event: 'origin.rejected', origin: origin ?? null, method: request.method, path: request.url.split('?')[0] }, 'Request origin rejected');
  reply.code(403).send({ error: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' });
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function getDockerGatewayAddress(): string | null {
  if (process.env.ANYWEAR_TRUST_PROXY !== 'true') return null;
  try {
    const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    const defaultRoute = routes
      .map((route) => route.trim().split(/\s+/))
      .find(([, destination, , flags]) => destination === '00000000' && (Number.parseInt(flags ?? '0', 16) & 1) === 1);
    const gateway = defaultRoute?.[2];
    if (!gateway || !/^[0-9a-fA-F]{8}$/.test(gateway)) return null;
    return [6, 4, 2, 0].map((offset) => Number.parseInt(gateway.slice(offset, offset + 2), 16)).join('.');
  } catch {
    return null;
  }
}

async function requireLocalAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;
  const referrer = request.headers.referer;
  let sourceOrigin = origin ?? '';
  let loopbackOrigin = false;
  try {
    const sourceUrl = new URL(sourceOrigin || referrer || '');
    sourceOrigin = sourceUrl.origin;
    loopbackOrigin = isLoopbackAddress(sourceUrl.hostname);
  } catch {
    loopbackOrigin = false;
  }

  const peerAddress = request.raw.socket.remoteAddress;
  const peerIsLocal = isLoopbackAddress(peerAddress);
  const dockerGatewayAddress = getDockerGatewayAddress();
  const peerIsDockerGateway = dockerGatewayAddress !== null
    && peerAddress?.replace(/^::ffff:/, '') === dockerGatewayAddress;
  let trustedProxyRequest = false;
  if (!peerIsLocal && process.env.ANYWEAR_TRUST_PROXY === 'true' && peerAddress) {
    const proxyHost = process.env.ANYWEAR_TRUSTED_PROXY_HOST?.trim() || 'frontend';
    const proxyAddress = request.headers['x-real-ip'];
    try {
      const proxyAddresses = await lookup(proxyHost, { all: true });
      trustedProxyRequest = proxyAddresses.some((address) => address.address === peerAddress.replace(/^::ffff:/, ''))
        && typeof proxyAddress === 'string'
        && (isLoopbackAddress(proxyAddress) || proxyAddress === dockerGatewayAddress);
    } catch {
      trustedProxyRequest = false;
    }
  }
  if (!sourceOrigin || !config.allowedOrigins.includes(sourceOrigin) || !loopbackOrigin || (!peerIsLocal && !peerIsDockerGateway && !trustedProxyRequest)) {
    request.log.warn({ event: 'provider_key.admin_rejected', origin: origin ?? null }, 'Non-local provider key management request rejected');
    reply.code(403).send({ error: '卡池管理仅允许在运行服务的本机访问', code: 'LOCAL_ADMIN_REQUIRED' });
  }
}

function providerKeyManagementView() {
  return {
    poolId: providerKeyPool.poolId,
    cards: providerKeyPool.getAllManagementStatus(),
    activeGroupId: providerKeyPool.activeProviderGroupId,
    groups: providerKeyPool.getGroupsManagementStatus(),
  };
}

await app.register(cors, { origin: config.allowedOrigins });
await app.register(multipart, { throwFileSizeLimit: false });
await app.register(websocket);
await app.register(fastifyStatic, {
  root: resolve(config.applicationRoot, 'client', 'dist'),
  prefix: '/',
  wildcard: true,
  index: ['index.html'],
  cacheControl: false,
  allowedPath: (pathName) => !isServicePath(pathName),
});

app.get('/api/health', async () => ({
  ok: true,
  providerConfigured: providerKeyPool.totalSize > 0,
  model: config.model,
  speed: config.speed,
  sessionTtlSeconds: config.sessionTtlSeconds,
  maxGenerationSeconds: config.maxGenerationSeconds,
}));

app.get('/api/provider-keys', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return {
    poolId: providerKeyPool.poolId,
    groupId: providerKeyPool.activeProviderGroupId,
    groupName: providerKeyPool.activeGroup.name,
    cards: providerKeyPool.getStatus(),
  };
});

app.get('/api/admin/provider-keys', { preHandler: requireLocalAdmin }, async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return providerKeyManagementView();
});

app.post<{ Body: { key?: unknown; label?: unknown; groupId?: unknown } }>('/api/admin/provider-keys', { preHandler: requireLocalAdmin }, async (request, reply) => {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply.code(400).send({ error: 'Request body must be an object', code: 'INVALID_REQUEST_BODY' });
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const label = body.label === undefined ? undefined : typeof body.label === 'string' ? body.label.trim() : null;
  const requestedGroupId = body.groupId;
  if (key.length < 8 || key.length > 4096 || /[\r\n\0]/.test(key)) {
    return reply.code(400).send({ error: 'API Key 格式无效', code: 'INVALID_PROVIDER_KEY' });
  }
  if (label === null || (label !== undefined && label.length > 80)) {
    return reply.code(400).send({ error: '卡片名称不能超过 80 个字符', code: 'INVALID_PROVIDER_KEY_LABEL' });
  }
  if (requestedGroupId !== undefined && typeof requestedGroupId !== 'string') {
    return reply.code(400).send({ error: '目标分组不存在', code: 'PROVIDER_GROUP_NOT_FOUND' });
  }

  try {
    return await providerKeyStore.runExclusive(async () => {
      const groupId = typeof requestedGroupId === 'string' ? requestedGroupId : providerKeyPool.activeProviderGroupId;
      if (!providerKeyPool.getStoredGroups().some((group) => group.id === groupId)) {
        return reply.code(400).send({ error: '目标分组不存在', code: 'PROVIDER_GROUP_NOT_FOUND' });
      }
      let record;
      try {
        record = providerKeyPool.prepareAdd(key, label || undefined, groupId);
      } catch (error) {
        const duplicate = error instanceof Error && error.message.includes('already in the pool');
        return reply.code(duplicate ? 409 : 400).send({
          error: duplicate ? '这张 API Key 已在卡池中' : '卡池最多支持 100 张 API Key',
          code: duplicate ? 'DUPLICATE_PROVIDER_KEY' : 'PROVIDER_KEY_POOL_FULL',
        });
      }
      const current = providerKeyPool.getStoredConfiguration();
      await providerKeyStore.save({ ...current, keys: [...current.keys, record] });
      providerKeyPool.addRecord(record);
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key pool persistence failed');
    return reply.code(500).send({ error: '卡池保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>('/api/admin/provider-keys/:id', { preHandler: requireLocalAdmin }, async (request, reply) => {
  const body = request.body;
  const enabled = body?.enabled;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof enabled !== 'boolean') {
    return reply.code(400).send({ error: 'enabled 必须是布尔值', code: 'INVALID_PROVIDER_KEY_STATE' });
  }
  try {
    return await providerKeyStore.runExclusive(async () => {
      const record = providerKeyPool.getStoredKeys().find((key) => key.id === request.params.id);
      if (!record) return reply.code(404).send({ error: 'API Key 不存在', code: 'PROVIDER_KEY_NOT_FOUND' });
      if (record.enabled === enabled) return providerKeyManagementView();

      const current = providerKeyPool.getStoredConfiguration();
      const keys = current.keys.map((key) => key.id === record.id ? { ...key, enabled } : key);
      await providerKeyStore.save({ ...current, keys });
      providerKeyPool.setEnabled(record.id, enabled);
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key pool persistence failed');
    return reply.code(500).send({ error: '卡池保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.delete<{ Params: { id: string } }>('/api/admin/provider-keys/:id', { preHandler: requireLocalAdmin }, async (request, reply) => {
  try {
    return await providerKeyStore.runExclusive(async () => {
      const currentKeys = providerKeyPool.getStoredKeys();
      const index = currentKeys.findIndex((key) => key.id === request.params.id);
      if (index < 0) return reply.code(404).send({ error: 'API Key 不存在', code: 'PROVIDER_KEY_NOT_FOUND' });
      const record = currentKeys[index]!;
      const cardStatus = providerKeyPool.getGroupsManagementStatus()
        .flatMap((group) => group.cards)
        .find((card) => card.id === record.id);
      if (cardStatus?.activeSessions) {
        return reply.code(409).send({ error: '这张卡仍有运行中的会话，请停止会话后再移除', code: 'PROVIDER_KEY_IN_USE' });
      }

      const current = providerKeyPool.getStoredConfiguration();
      await providerKeyStore.save({ ...current, keys: current.keys.filter((key) => key.id !== record.id) });
      if (!providerKeyPool.remove(record.id)) {
        return reply.code(409).send({ error: '卡池状态已变化，请刷新后重试', code: 'PROVIDER_KEY_IN_USE' });
      }
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key pool persistence failed');
    return reply.code(500).send({ error: '卡池保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.post<{ Body: { name?: unknown } }>('/api/admin/provider-key-groups', { preHandler: requireLocalAdmin }, async (request, reply) => {
  const body = request.body;
  const name = body && typeof body === 'object' && !Array.isArray(body) && typeof body.name === 'string'
    ? body.name.trim()
    : '';
  if (!name || name.length > 80) {
    return reply.code(400).send({ error: '分组名称需为 1 到 80 个字符', code: 'INVALID_PROVIDER_GROUP_NAME' });
  }
  try {
    return await providerKeyStore.runExclusive(async () => {
      let group;
      try {
        group = providerKeyPool.prepareCreateGroup(name);
      } catch (error) {
        const duplicate = error instanceof Error && error.message.includes('already exists');
        const full = error instanceof Error && error.message.includes('more than 50');
        return reply.code(duplicate ? 409 : 400).send({
          error: duplicate ? '已存在同名分组' : full ? '分组数量已达上限（50）' : '无法创建分组',
          code: duplicate ? 'DUPLICATE_PROVIDER_GROUP' : full ? 'PROVIDER_GROUP_LIMIT' : 'INVALID_PROVIDER_GROUP_NAME',
        });
      }
      const current = providerKeyPool.getStoredConfiguration();
      await providerKeyStore.save({
        ...current,
        activeGroupId: group.id,
        groups: [...current.groups, group],
      });
      providerKeyPool.addGroup(group, true);
      reply.header('Cache-Control', 'no-store');
      return reply.code(201).send(providerKeyManagementView());
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key group persistence failed');
    return reply.code(500).send({ error: '分组保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.patch<{ Params: { id: string }; Body: { name?: unknown } }>('/api/admin/provider-key-groups/:id', { preHandler: requireLocalAdmin }, async (request, reply) => {
  const body = request.body;
  const name = body && typeof body === 'object' && !Array.isArray(body) && typeof body.name === 'string'
    ? body.name.trim()
    : '';
  if (!name || name.length > 80) {
    return reply.code(400).send({ error: '分组名称需为 1 到 80 个字符', code: 'INVALID_PROVIDER_GROUP_NAME' });
  }
  try {
    return await providerKeyStore.runExclusive(async () => {
      const current = providerKeyPool.getStoredConfiguration();
      const groupIndex = current.groups.findIndex((group) => group.id === request.params.id);
      if (groupIndex < 0) return reply.code(404).send({ error: '分组不存在', code: 'PROVIDER_GROUP_NOT_FOUND' });
      if (current.groups.some((group) => group.id !== request.params.id && group.name.toLowerCase() === name.toLowerCase())) {
        return reply.code(409).send({ error: '已存在同名分组', code: 'DUPLICATE_PROVIDER_GROUP' });
      }
      if (current.groups[groupIndex]!.name === name) return providerKeyManagementView();
      const groups = current.groups.map((group) => group.id === request.params.id ? { ...group, name } : group);
      await providerKeyStore.save({ ...current, groups });
      providerKeyPool.renameGroup(request.params.id, name);
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key group persistence failed');
    return reply.code(500).send({ error: '分组保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.delete<{ Params: { id: string } }>('/api/admin/provider-key-groups/:id', { preHandler: requireLocalAdmin }, async (request, reply) => {
  try {
    return await providerKeyStore.runExclusive(async () => {
      const current = providerKeyPool.getStoredConfiguration();
      const group = current.groups.find((entry) => entry.id === request.params.id);
      if (!group) return reply.code(404).send({ error: '分组不存在', code: 'PROVIDER_GROUP_NOT_FOUND' });
      if (group.id === providerKeyPool.activeProviderGroupId) {
        return reply.code(409).send({ error: '请先启用其他分组，再删除当前分组', code: 'ACTIVE_PROVIDER_GROUP_CANNOT_DELETE' });
      }
      if (current.keys.some((key) => key.groupId === group.id)) {
        return reply.code(409).send({ error: '请先移出或删除分组内的 API 卡', code: 'PROVIDER_GROUP_NOT_EMPTY' });
      }
      await providerKeyStore.save({ ...current, groups: current.groups.filter((entry) => entry.id !== group.id) });
      providerKeyPool.removeGroup(group.id);
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key group persistence failed');
    return reply.code(500).send({ error: '分组保存失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.post<{ Params: { id: string } }>('/api/admin/provider-key-groups/:id/activate', { preHandler: requireLocalAdmin }, async (request, reply) => {
  try {
    return await providerKeyStore.runExclusive(async () => {
      if (!providerKeyPool.getStoredGroups().some((group) => group.id === request.params.id)) {
        return reply.code(404).send({ error: '分组不存在', code: 'PROVIDER_GROUP_NOT_FOUND' });
      }
      if (providerKeyPool.activeProviderGroupId !== request.params.id) {
        const current = providerKeyPool.getStoredConfiguration();
        await providerKeyStore.save({ ...current, activeGroupId: request.params.id });
        providerKeyPool.activateGroup(request.params.id);
      }
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key group activation persistence failed');
    return reply.code(500).send({ error: '分组启用失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.patch<{ Params: { id: string }; Body: { groupId?: unknown } }>('/api/admin/provider-keys/:id/group', { preHandler: requireLocalAdmin }, async (request, reply) => {
  const groupId = request.body?.groupId;
  if (typeof groupId !== 'string') {
    return reply.code(400).send({ error: 'groupId 必须是分组 ID', code: 'INVALID_PROVIDER_GROUP' });
  }
  try {
    return await providerKeyStore.runExclusive(async () => {
      const current = providerKeyPool.getStoredConfiguration();
      const key = current.keys.find((entry) => entry.id === request.params.id);
      if (!key) return reply.code(404).send({ error: 'API Key 不存在', code: 'PROVIDER_KEY_NOT_FOUND' });
      if (!current.groups.some((group) => group.id === groupId)) {
        return reply.code(404).send({ error: '目标分组不存在', code: 'PROVIDER_GROUP_NOT_FOUND' });
      }
      if (key.groupId === groupId) return providerKeyManagementView();
      const card = providerKeyPool.getGroupsManagementStatus().flatMap((group) => group.cards).find((entry) => entry.id === key.id);
      if (card?.activeSessions) {
        return reply.code(409).send({ error: '这张卡仍有运行中的会话，结束后才能移动分组', code: 'PROVIDER_KEY_IN_USE' });
      }
      const keys = current.keys.map((entry) => entry.id === key.id ? { ...entry, groupId } : entry);
      await providerKeyStore.save({ ...current, keys });
      providerKeyPool.move(key.id, groupId);
      reply.header('Cache-Control', 'no-store');
      return providerKeyManagementView();
    });
  } catch (error) {
    request.log.error({ event: 'provider_key.persist_failed', errorName: error instanceof Error ? error.name : typeof error }, 'Provider key group move persistence failed');
    return reply.code(500).send({ error: 'API 卡移动失败，请检查本机数据目录权限', code: 'PROVIDER_KEY_SAVE_FAILED' });
  }
});

app.get('/api/garments', async () => garments.filter((garment) => garment.enabled));

app.get('/api/garment-groups', async () => garmentLibrary.listGroups());

class GarmentImportError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

const uploadImageTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeUploadPath(filename: string): string {
  if (typeof filename !== 'string' || !filename) {
    throw new GarmentImportError('Image file path is invalid', 400, 'INVALID_GARMENT_FILE_PATH');
  }
  const normalized = filename.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!filename || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || segments.length > 32
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new GarmentImportError('Image file path is invalid', 400, 'INVALID_GARMENT_FILE_PATH');
  }
  for (const segment of segments) {
    if (segment.length > 200 || /[\x00-\x1f<>:"|?*]/.test(segment) || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) {
      throw new GarmentImportError('Image file path is invalid', 400, 'INVALID_GARMENT_FILE_PATH');
    }
  }
  if (normalized.length > 1024) {
    throw new GarmentImportError('Image file path is too long', 400, 'INVALID_GARMENT_FILE_PATH');
  }
  return segments.join(path.sep);
}

function matchesImageSignature(contentType: string, header: Buffer): boolean {
  if (contentType === 'image/jpeg') return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (contentType === 'image/png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return contentType === 'image/webp'
    && header.length >= 12
    && header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP';
}

async function stageGarmentImport(request: FastifyRequest): Promise<{ stagingDirectory: string; name?: string; groupId?: string }> {
  const temporaryRoot = path.join(config.garmentDataDirectory, '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const uploadRoot = await realpath(config.garmentDataDirectory);
  const resolvedTemporaryRoot = await realpath(temporaryRoot);
  if (!isPathWithin(uploadRoot, resolvedTemporaryRoot)) {
    throw new GarmentImportError('Garment import temporary directory is invalid', 500, 'GARMENT_IMPORT_STORAGE_INVALID');
  }
  const stagingDirectory = await mkdtemp(path.join(temporaryRoot, 'import-'));
  const paths = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  let name: string | undefined;
  let groupId: string | undefined;

  try {
    const parts = request.parts({
      preservePath: true,
      limits: {
        files: config.garmentImportMaxFiles,
        fields: 2,
        parts: config.garmentImportMaxFiles + 2,
        fieldSize: 256,
        fileSize: config.garmentImportMaxImageBytes + 1,
      },
    });
    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.valueTruncated || typeof part.value !== 'string') {
          throw new GarmentImportError('Import fields are invalid', 400, 'INVALID_GARMENT_IMPORT');
        }
        if (part.fieldname === 'name') {
          if (name !== undefined || !part.value.trim() || part.value.trim().length > 80) {
            throw new GarmentImportError('Group name must contain 1 to 80 characters', 400, 'INVALID_GARMENT_GROUP_NAME');
          }
          name = part.value.trim();
        } else if (part.fieldname === 'groupId') {
          if (groupId !== undefined || !/^[a-zA-Z0-9_-]{1,64}$/.test(part.value)) {
            throw new GarmentImportError('Group ID is invalid', 400, 'INVALID_GARMENT_GROUP_ID');
          }
          groupId = part.value;
        } else {
          throw new GarmentImportError('Import field is not supported', 400, 'INVALID_GARMENT_IMPORT');
        }
        continue;
      }

      if (part.fieldname !== 'images') {
        part.file.resume();
        throw new GarmentImportError('Image files must use the images field', 400, 'INVALID_GARMENT_IMPORT');
      }
      fileCount += 1;
      if (fileCount > config.garmentImportMaxFiles) {
        part.file.resume();
        throw new GarmentImportError('Too many image files', 413, 'GARMENT_IMPORT_FILE_LIMIT');
      }

      let relativePath: string;
      try {
        relativePath = normalizeUploadPath(part.filename);
      } catch (error) {
        part.file.resume();
        throw error;
      }
      const normalizedKey = relativePath.toLocaleLowerCase('en-US');
      if (paths.has(normalizedKey)) {
        part.file.resume();
        throw new GarmentImportError('Image file paths must be unique', 400, 'DUPLICATE_GARMENT_FILE_PATH');
      }
      paths.add(normalizedKey);

      const extension = path.extname(relativePath).toLowerCase();
      const expectedType = uploadImageTypes[extension];
      if (!expectedType || part.mimetype !== expectedType) {
        part.file.resume();
        throw new GarmentImportError('Only JPEG, PNG, and WebP images are supported', 400, 'UNSUPPORTED_GARMENT_IMAGE_TYPE');
      }

      const outputPath = path.resolve(stagingDirectory, 'files', relativePath);
      const relativeOutputPath = path.relative(stagingDirectory, outputPath);
      if (relativeOutputPath.startsWith(`..${path.sep}`) || relativeOutputPath === '..' || path.isAbsolute(relativeOutputPath)) {
        part.file.resume();
        throw new GarmentImportError('Image file path is invalid', 400, 'INVALID_GARMENT_FILE_PATH');
      }
      await mkdir(path.dirname(outputPath), { recursive: true });

      let fileBytes = 0;
      let header = Buffer.alloc(0);
      const inspectStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          fileBytes += chunk.length;
          totalBytes += chunk.length;
          if (fileBytes > config.garmentImportMaxImageBytes) {
            callback(new GarmentImportError('An image exceeds the per-file size limit', 413, 'GARMENT_IMPORT_IMAGE_TOO_LARGE'));
            return;
          }
          if (totalBytes > config.garmentImportMaxTotalBytes) {
            callback(new GarmentImportError('The import exceeds the total size limit', 413, 'GARMENT_IMPORT_TOTAL_TOO_LARGE'));
            return;
          }
          if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
          callback(null, chunk);
        },
      });
      await pipeline(part.file, inspectStream, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated || fileBytes === 0) {
        throw new GarmentImportError('Image is empty or exceeds the per-file size limit', 413, 'GARMENT_IMPORT_IMAGE_TOO_LARGE');
      }
      if (!matchesImageSignature(expectedType, header)) {
        throw new GarmentImportError('Image content does not match its file type', 400, 'INVALID_GARMENT_IMAGE_CONTENT');
      }
    }

    if (fileCount === 0) throw new GarmentImportError('At least one image is required', 400, 'GARMENT_IMPORT_EMPTY');
    if (!groupId && !name) throw new GarmentImportError('Group name is required for a new group', 400, 'INVALID_GARMENT_GROUP_NAME');
    return { stagingDirectory, name, groupId };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

app.post('/api/admin/garment-groups/import', { preHandler: requireLocalAdmin }, async (request, reply) => {
  if (!request.isMultipart()) {
    return reply.code(400).send({ error: 'Request must use multipart/form-data', code: 'INVALID_GARMENT_IMPORT' });
  }
  let stagingDirectory: string | undefined;
  try {
    const stagedImport = await stageGarmentImport(request);
    stagingDirectory = stagedImport.stagingDirectory;
    const imported = await garmentLibrary.importStagedGroup(stagedImport);
    reply.header('Cache-Control', 'no-store');
    return reply.code(imported.created ? 201 : 200).send(imported.group);
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
  }
});

app.get<{ Params: { imageId: string } }>('/api/garment-images/:imageId', async (request, reply) => {
  const image = await garmentLibrary.readImage(request.params.imageId);
  if (!image) return reply.code(404).send({ error: 'Garment image not found', code: 'GARMENT_IMAGE_NOT_FOUND' });
  return reply.type(image.contentType).header('Cache-Control', 'private, max-age=300').send(image.body);
});

app.post<{ Body: { providerKeyId?: unknown; poolId?: unknown } }>('/api/sessions', { preHandler: requireAllowedOrigin }, async (request, reply) => {
  return providerKeyStore.runExclusive(async () => {
    if (providerKeyPool.totalSize === 0) {
      return reply.code(503).send({
        error: 'DECART_API_KEY is not configured',
        code: 'PROVIDER_NOT_CONFIGURED',
      });
    }

    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Request body must be an object', code: 'INVALID_REQUEST_BODY' });
    }
    const requestedProviderKeyId = body.providerKeyId;
    if (requestedProviderKeyId !== undefined && typeof requestedProviderKeyId !== 'string') {
      return reply.code(400).send({ error: 'Provider key selection is invalid', code: 'INVALID_PROVIDER_KEY' });
    }
    if (requestedProviderKeyId !== undefined && body.poolId !== providerKeyPool.poolId) {
      return reply.code(409).send({ error: '卡池已更新，请重新进入卡池页面选择卡号', code: 'PROVIDER_POOL_CHANGED' });
    }
    if (typeof requestedProviderKeyId === 'string' && !providerKeyPool.has(requestedProviderKeyId)) {
      return reply.code(400).send({ error: 'Provider key selection is invalid', code: 'INVALID_PROVIDER_KEY' });
    }
    if (providerKeyPool.size === 0) {
      return reply.code(503).send({
        error: '当前启用分组没有可用的 API 卡',
        code: 'ACTIVE_PROVIDER_GROUP_EMPTY',
      });
    }

    const session = sessions.create(requestedProviderKeyId as string | undefined);
    if (!session) {
      return reply.code(503).send({
        error: requestedProviderKeyId ? '所选 API 卡当前不可用，请刷新卡池或选择其他卡' : '当前启用分组没有可用的 API 卡',
        code: 'PROVIDER_KEY_UNAVAILABLE',
      });
    }
    return reply.code(201).send({
      ...session,
      websocketPath: `/ws/realtime?session_id=${encodeURIComponent(session.sessionId)}`,
    });
  });
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', { preHandler: requireAllowedOrigin }, async (request, reply) => {
  const session = sessions.get(request.params.id);
  if (!session) return reply.code(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
  await sessions.stop(request.params.id, 'client_stop');
  return { ok: true, sessionId: request.params.id };
});

app.post('/api/internal/shutdown', async (request, reply) => {
  const remoteAddress = request.raw.socket.remoteAddress;
  const authorization = request.headers.authorization;
  const expectedToken = process.env.ANYWEAR_CONTROL_TOKEN ?? '';
  const suppliedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedBuffer = Buffer.from(expectedToken);
  const suppliedBuffer = Buffer.from(suppliedToken);
  const loopback = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  const authorized = loopback
    && expectedBuffer.length > 0
    && expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!authorized) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });

  reply.code(202).send({ ok: true });
  reply.raw.once('finish', () => {
    void app.close().catch((error: unknown) => {
      app.log.error({ errorName: error instanceof Error ? error.name : typeof error }, 'Graceful shutdown failed');
    });
  });
});

app.get('/ws/realtime', { websocket: true, preValidation: requireAllowedOrigin }, (socket: WebSocket, request) => {
  const query = request.query as { session_id?: string };
  const sessionId = typeof query.session_id === 'string' ? query.session_id : '';
  if (!sessionId || !sessions.attachClient(sessionId, socket)) {
    socket.close(4404, 'Session not found or already connected');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    socket.close(4404, 'Session not found');
    return;
  }

  request.log.info({ event: 'websocket.client_connected', sessionId, origin: request.headers.origin ?? null }, 'Browser realtime WebSocket connected');

  socket.on('message', (data) => {
    try {
      sessions.handleClientMessage(sessionId, data.toString());
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Session error' }));
    }
  });
  socket.on('close', (code) => {
    request.log.info({ event: 'websocket.client_closed', sessionId, closeCode: code }, 'Browser realtime WebSocket closed');
    sessions.markClientDisconnected(sessionId);
  });
  socket.on('error', (error) => {
    request.log.warn({ event: 'websocket.client_error', sessionId, errorName: error.name }, 'Browser realtime WebSocket failed');
    sessions.markClientDisconnected(sessionId);
  });
  void sessions.connectUpstream(sessionId).catch((error: unknown) => {
    request.log.error({ event: 'provider.connect_failed', sessionId, errorName: error instanceof Error ? error.name : typeof error }, 'Realtime provider connection failed');
    socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Provider connection failed' }));
    void sessions.stop(sessionId, 'provider_connect_failed');
  });
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const candidateStatusCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
  const candidateCode = error instanceof Error && 'code' in error ? error.code : undefined;
  const statusCode = typeof candidateStatusCode === 'number' && candidateStatusCode >= 400 && candidateStatusCode < 500
    ? candidateStatusCode
    : 500;
  return reply.code(statusCode).send({
    error: statusCode < 500 && error instanceof Error ? error.message : 'Internal server error',
    code: statusCode < 500 && typeof candidateCode === 'string' ? candidateCode : statusCode < 500 ? 'REQUEST_ERROR' : 'INTERNAL_ERROR',
  });
});

app.setNotFoundHandler((request, reply) => {
  const pathname = request.url.split('?')[0];
  const acceptsHtml = request.headers.accept?.includes('text/html');
  if ((request.method === 'GET' || request.method === 'HEAD')
    && !isServicePath(pathname)
    && !pathname.includes('.')
    && acceptsHtml) {
    return reply.type('text/html').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });
});

app.addHook('onClose', async () => {
  await sessions.stopAll('server_shutdown');
});

if (process.env.NODE_ENV !== 'test') {
  process.once('SIGINT', () => void app.close());
  process.once('SIGTERM', () => void app.close());
  await app.listen({ host: config.host, port: config.port });
}

export { app, providerKeyPool, sessions };
