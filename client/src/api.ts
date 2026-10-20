import type { AdminProviderKeyPoolStatus, Garment, GarmentGroup, ProviderKeyPoolStatus, ProviderKeySelection, SessionResponse } from './types';

export class ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: (T & { error?: string; code?: string }) | null = null;
  try {
    body = (await response.json()) as T & { error?: string; code?: string };
  } catch {
    body = null;
  }
  if (!response.ok) throw new ApiError(body?.error || `Request failed: ${response.status}`, body?.code);
  if (!body) throw new ApiError('服务器返回了无效响应');
  return body;
}

export async function fetchGarmentGroups(): Promise<GarmentGroup[]> {
  return readJson<GarmentGroup[]>(await fetch('/api/garment-groups'));
}

export async function fetchGarments(): Promise<Garment[]> {
  return readJson<Garment[]>(await fetch('/api/garments'));
}

export async function fetchProviderKeys(): Promise<ProviderKeyPoolStatus> {
  return readJson<ProviderKeyPoolStatus>(await fetch('/api/provider-keys', { cache: 'no-store' }));
}

export async function fetchAdminProviderKeys(): Promise<AdminProviderKeyPoolStatus> {
  return readJson<AdminProviderKeyPoolStatus>(await fetch('/api/admin/provider-keys', { cache: 'no-store' }));
}

export async function addAdminProviderKey(key: string, label?: string): Promise<AdminProviderKeyPoolStatus> {
  return readJson<AdminProviderKeyPoolStatus>(await fetch('/api/admin/provider-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, ...(label ? { label } : {}) }),
  }));
}

export async function setAdminProviderKeyEnabled(id: string, enabled: boolean): Promise<AdminProviderKeyPoolStatus> {
  return readJson<AdminProviderKeyPoolStatus>(await fetch(`/api/admin/provider-keys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }));
}

export async function removeAdminProviderKey(id: string): Promise<AdminProviderKeyPoolStatus> {
  return readJson<AdminProviderKeyPoolStatus>(await fetch(`/api/admin/provider-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }));
}

export async function createSession(selection?: ProviderKeySelection): Promise<SessionResponse> {
  return readJson<SessionResponse>(await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(selection ?? {}),
  }));
}

export async function stopSession(sessionId: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    keepalive: true,
  });
}

export async function imageToBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load garment image: ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read garment image'));
    reader.readAsDataURL(blob);
  });
}
