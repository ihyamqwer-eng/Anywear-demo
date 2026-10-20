export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEntry {
  timestamp: string;
  level: DiagnosticLevel;
  event: string;
  details?: Record<string, unknown>;
}

const storageKey = 'anywear-diagnostic-log-v1';
const maxEntries = 300;
const listeners = new Set<() => void>();

function sanitizeText(value: string): string {
  return value.replace(/dct_[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/api_key=[^&\s]+/gi, 'api_key=[REDACTED]');
}

function loadEntries(): DiagnosticEntry[] {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.slice(-maxEntries) as DiagnosticEntry[] : [];
  } catch {
    return [];
  }
}

let entries = typeof window === 'undefined' ? [] : loadEntries();

function persist(): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(entries));
  } catch {
    // Diagnostics remain available in memory if browser storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function logDiagnostic(level: DiagnosticLevel, event: string, details?: Record<string, unknown>): void {
  const safeDetails = details && Object.fromEntries(Object.entries(details).map(([key, value]) => [
    key,
    typeof value === 'string' ? sanitizeText(value) : value,
  ]));
  entries = [...entries, { timestamp: new Date().toISOString(), level, event, ...(safeDetails ? { details: safeDetails } : {}) }].slice(-maxEntries);
  persist();
  const logMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  logMethod(`[Anywear] ${event}`, details ?? {});
}

export function getDiagnosticLogs(): DiagnosticEntry[] {
  return entries;
}

export function subscribeDiagnosticLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBrowserDiagnosticContext(): Record<string, unknown> {
  return {
    origin: window.location.origin,
    protocol: window.location.protocol,
    secureContext: window.isSecureContext,
    mediaDevicesAvailable: typeof navigator.mediaDevices !== 'undefined',
    getUserMediaAvailable: typeof navigator.mediaDevices?.getUserMedia === 'function',
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}

export function installGlobalDiagnosticHandlers(): void {
  window.addEventListener('error', (event) => {
    logDiagnostic('error', 'browser.error', { message: event.message || 'Unknown browser error' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logDiagnostic('error', 'browser.unhandled-rejection', {
      name: reason instanceof Error ? reason.name : typeof reason,
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

export function downloadDiagnosticLogs(): void {
  const report = {
    exportedAt: new Date().toISOString(),
    browser: getBrowserDiagnosticContext(),
    entries,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `anywear-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
