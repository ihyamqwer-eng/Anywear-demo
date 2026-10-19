import type { Garment, SessionResponse } from './types';

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

export async function fetchGarments(): Promise<Garment[]> {
  return readJson<Garment[]>(await fetch('/api/garments'));
}

export async function createSession(): Promise<SessionResponse> {
  return readJson<SessionResponse>(await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
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
