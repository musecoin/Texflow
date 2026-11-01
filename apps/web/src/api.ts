/**
 * API client. Never reports success unless the server acknowledged the command.
 * Every user action gets ONE idempotency key; automatic retries reuse it, so a retried
 * request after a dropped connection cannot create a duplicate.
 */
export class ApiError extends Error {
  code: string; status: number; details?: unknown; requestId?: string;
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message); this.status = status; this.code = code; this.details = details; this.requestId = requestId;
  }
}

interface Tokens { accessToken: string; refreshToken: string; accessExpiresAt: string }
const KEY = 'texflow.session';
let tokens: Tokens | null = load();
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function load(): Tokens | null { try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function save(t: Tokens | null) { tokens = t; try { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ } listeners.forEach((l) => l()); }
export const session = {
  get token() { return tokens?.accessToken ?? null; },
  isLoggedIn: () => !!tokens,
  onChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  clear() { save(null); },
};

export const API_BASE = (globalThis as { TEXFLOW_API_BASE?: string }).TEXFLOW_API_BASE ?? '';

async function raw(method: string, path: string, body?: unknown, idemKey?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idemKey) headers['idempotency-key'] = idemKey;
  return fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function refresh(): Promise<boolean> {
  if (!tokens) return false;
  refreshing ??= (async () => {
    try {
      const r = await fetch(API_BASE + '/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: tokens!.refreshToken }) });
      if (!r.ok) { save(null); return false; }
      save(await r.json()); return true;
    } catch { return false; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const idem = method === 'GET' ? undefined : (opts.idempotencyKey ?? crypto.randomUUID());
  let attempt = 0;
  for (;;) {
    let res: Response;
    try { res = await raw(method, path, body, idem); }
    catch {
      // network failure: the server may or may not have processed it; retrying with the SAME key is safe
      if (attempt++ < 2) { await new Promise((r) => setTimeout(r, 600 * attempt)); continue; }
      throw new ApiError(0, 'NETWORK', 'Sunucuya ulaşılamadı. İşlem onaylanmadı; bağlantı gelince tekrar deneyin.');
    }
    if (res.status === 401 && tokens && attempt === 0) {
      const err = await res.clone().json().catch(() => null);
      if (err?.error?.code === 'TOKEN_EXPIRED' && (await refresh())) { attempt++; continue; }
      if (err?.error?.code !== 'INVALID_CREDENTIALS') save(null);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'HTTP_' + res.status, e.message ?? res.statusText, e.details, e.requestId);
    }
    return json as T;
  }
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}, o?: { idempotencyKey?: string }) => api<T>('POST', p, b, o);

export async function login(organizationCode: string, email: string, password: string) {
  const r = await fetch(API_BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationCode, email, password }) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? 'Giriş başarısız');
  save(j);
}

export async function logout() {
  try { await api('POST', '/api/v1/auth/logout', {}); } catch { /* token may already be invalid */ }
  save(null);
}

/** Live events over WebSocket; token travels as a sub-protocol, not in the URL. */
export function connectEvents(onEvent: (e: { type: string; entityType?: string; entityId?: string }) => void, onState: (s: 'live' | 'down') => void): () => void {
  let ws: WebSocket | null = null; let stop = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (stop || !tokens) return;
    const url = (API_BASE || location.origin).replace(/^http/, 'ws') + '/api/v1/events';
    ws = new WebSocket(url, ['texflow.v1', 'auth.' + tokens.accessToken]);
    ws.onopen = () => onState('live');
    ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (e.type !== 'hello') onEvent(e); } catch { /* ignore */ } };
    ws.onclose = () => { onState('down'); if (!stop) timer = setTimeout(open, 3000); };
  };
  open();
  return () => { stop = true; clearTimeout(timer); ws?.close(); };
}
