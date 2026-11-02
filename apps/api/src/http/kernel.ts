/**
 * HTTP kernel: routing, validation, authentication, RBAC, tenant-scoped transactions,
 * idempotency, structured errors, CORS, security headers, rate limiting and static hosting.
 *
 * Every authenticated request runs inside ONE database transaction on the least-privilege
 * role with `app.org_id` set locally, so PostgreSQL row-level security enforces tenant
 * isolation even if a handler forgets a WHERE clause. Command handlers, the audit trail,
 * ledger rows and the idempotency record commit or roll back together.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod/v4';
import type { Connection, Pool } from '@texflow/db';
import { PgError } from '@texflow/db';
import { AppError, TransitionError, UnitConversionError, type ErrorCode } from '@texflow/shared';
import type { Config } from '../config.ts';
import { RateLimiter } from './rateLimit.ts';
import { sha256 } from '@texflow/db';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AuthInfo {
  userId: string; orgId: string; sessionId: string;
  permissions: Set<string>;
  /** null = all factories of the organization */
  factoryIds: Set<string> | null;
}

export interface DomainEvent { type: string; entityType: string; entityId: string; data?: Record<string, unknown> }

export interface Ctx<B = any, Q = any> {
  req: http.IncomingMessage;
  requestId: string; ip: string; userAgent: string;
  params: Record<string, string>;
  body: B; query: Q;
  db: Connection;
  auth: AuthInfo;
  /** queue an event to publish after successful commit */
  emit(e: DomainEvent): void;
  can(permission: string): boolean;
  require(permission: string): void;
  assertFactory(factoryId: string): void;
  audit(action: string, entityType: string, entityId: string | null, before: unknown, after: unknown): Promise<void>;
}

export interface PublicCtx<B = any> {
  req: http.IncomingMessage; requestId: string; ip: string; userAgent: string; body: B; pool: Pool;
}

export interface HandlerResult { status?: number; body: unknown; headers?: Record<string, string> }

interface BaseRoute { method: Method; path: string; summary: string; tag: string; body?: z.ZodType; query?: z.ZodType; responseExample?: unknown; /** per-route body limit (default config.maxBodyBytes) */ maxBodyBytes?: number }
export interface AuthedRoute extends BaseRoute {
  public?: undefined;
  /** permission code required; null = any authenticated user */
  permission: string | null;
  /** mutation that requires an Idempotency-Key header (default: true for non-GET) */
  idempotent?: boolean;
  handler: (ctx: Ctx) => Promise<HandlerResult | unknown>;
}
export interface PublicRoute extends BaseRoute { public: true; handler: (ctx: PublicCtx) => Promise<HandlerResult | unknown>; rateLimitKey?: (ctx: PublicCtx) => string }
export type Route = AuthedRoute | PublicRoute;

interface Compiled { route: Route; re: RegExp; keys: string[] }

export class EventBus {
  private subs = new Map<string, Set<(e: DomainEvent & { at: string }) => void>>();
  subscribe(orgId: string, fn: (e: DomainEvent & { at: string }) => void): () => void {
    const s = this.subs.get(orgId) ?? new Set(); s.add(fn); this.subs.set(orgId, s);
    return () => { s.delete(fn); };
  }
  publish(orgId: string, e: DomainEvent) {
    const at = new Date().toISOString();
    for (const fn of this.subs.get(orgId) ?? []) { try { fn({ ...e, at }); } catch { /* subscriber errors never affect commands */ } }
  }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

export function idempotencyKeyOk(k: string) { return /^[A-Za-z0-9_:.\-]{8,128}$/.test(k); }

export function createKernel(deps: { pool: Pool; config: Config; events: EventBus; routes: Route[] }) {
  const { pool, config, events } = deps;
  const compiled: Compiled[] = deps.routes.map((route) => {
    const keys: string[] = [];
    const re = new RegExp('^' + route.path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    return { route, re, keys };
  });
  const apiLimiter = new RateLimiter(config.apiRatePerMin);
  const loginLimiter = new RateLimiter(config.loginRatePerMin);

  function clientIp(req: http.IncomingMessage): string {
    if (config.trustProxy) { const f = req.headers['x-forwarded-for']; if (typeof f === 'string') return f.split(',')[0].trim(); }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(payload);
  }

  function errorBody(code: ErrorCode, message: string, requestId: string, details?: unknown) {
    return { error: { code, message, details, requestId } };
  }

  function toAppError(e: unknown): AppError {
    if (e instanceof AppError) return e;
    if (e instanceof TransitionError) return new AppError('INVALID_TRANSITION', e.message, { from: e.from, action: e.action });
    if (e instanceof UnitConversionError) return new AppError(e.code as ErrorCode, e.message);
    if (e instanceof z.ZodError) return new AppError('VALIDATION_FAILED', 'Doğrulama hatası', e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    if (e instanceof PgError) {
      if (e.code === '23505') return new AppError('CONFLICT', 'Kayıt zaten mevcut', { constraint: e.constraint });
      if (e.code === '23514') {
        if (e.constraint?.startsWith('fabric_roll_')) return new AppError('INSUFFICIENT_STOCK', 'Stok kısıtı ihlal edildi', { constraint: e.constraint });
        return new AppError('VALIDATION_FAILED', 'Veri kısıtı ihlal edildi', { constraint: e.constraint });
      }
      if (e.code === '23503') return new AppError('VALIDATION_FAILED', 'İlişkili kayıt bulunamadı', { constraint: e.constraint });
      if (e.code === '40001' || e.code === '40P01') return new AppError('CONFLICT', 'Eşzamanlı işlem çakışması, tekrar deneyin');
      if (e.code === '42501') return new AppError('FORBIDDEN', 'Veritabanı erişimi reddedildi');
      if (e.code === 'P0001' && /append-only/.test(e.message)) return new AppError('CONFLICT', 'Değiştirilemez kayıt');
      if (e.code === '22P02') return new AppError('VALIDATION_FAILED', 'Geçersiz değer biçimi');
    }
    return new AppError('INTERNAL', 'Beklenmeyen bir hata oluştu');
  }

  async function readBody(req: http.IncomingMessage, limit = config.maxBodyBytes): Promise<unknown> {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new AppError('PAYLOAD_TOO_LARGE', 'İstek gövdesi çok büyük'); chunks.push(c as Buffer); }
    if (!size) return {};
    const ct = req.headers['content-type'] ?? '';
    if (!ct.includes('application/json')) throw new AppError('VALIDATION_FAILED', 'Content-Type application/json olmalı');
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_JSON', 'Geçersiz JSON'); }
  }

  async function loadAuth(db: Connection, sess: { session_id: string; organization_id: string; user_id: string }): Promise<AuthInfo> {
    const r = await db.query<{ permission_code: string | null; factory_id: string | null }>(
      `SELECT rp.permission_code, ur.factory_id
         FROM user_role ur LEFT JOIN role_permission rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1`, [sess.user_id]);
    const permissions = new Set<string>(); let all = false; const factories = new Set<string>();
    for (const row of r.rows) {
      if (row.permission_code) permissions.add(row.permission_code);
      if (row.factory_id === null) all = true; else factories.add(row.factory_id);
    }
    return { userId: sess.user_id, orgId: sess.organization_id, sessionId: sess.session_id, permissions, factoryIds: all ? null : factories };
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (!config.webDistDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const root = path.resolve(config.webDistDir);
    let file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root)) return false;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) return false;
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    return true;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestId = (typeof req.headers['x-request-id'] === 'string' && /^[\w-]{1,64}$/.test(req.headers['x-request-id'])) ? req.headers['x-request-id'] : crypto.randomUUID();
    const ip = clientIp(req);
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 300);
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    if (config.env === 'production') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');

    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-request-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', 'http://local');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/') && !pathname.startsWith('/health')) {
      if (serveStatic(req, res, pathname)) return;
      send(res, 404, errorBody('NOT_FOUND', 'Bulunamadı', requestId)); return;
    }

    let match: { c: Compiled; params: Record<string, string> } | null = null;
    let pathMatched = false;
    for (const c of compiled) {
      const m = c.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (c.route.method !== req.method) continue;
      match = { c, params: Object.fromEntries(c.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!match) { send(res, pathMatched ? 405 : 404, errorBody('NOT_FOUND', pathMatched ? 'Yöntem desteklenmiyor' : 'Uç nokta bulunamadı', requestId)); return; }
    const route = match.c.route;

    try {
      const wait = apiLimiter.check(ip);
      if (wait) throw Object.assign(new AppError('RATE_LIMITED', 'Çok fazla istek'), { retryAfter: wait });
      const rawBody = await readBody(req, route.maxBodyBytes);
      const body = route.body ? route.body.parse(rawBody) : rawBody;
      const query = route.query ? route.query.parse(Object.fromEntries(url.searchParams)) : Object.fromEntries(url.searchParams);

      if (route.public) {
        const pctx: PublicCtx = { req, requestId, ip, userAgent, body, pool };
        if (route.rateLimitKey) {
          const w = loginLimiter.check(route.rateLimitKey(pctx)) || loginLimiter.check('ip:' + ip);
          if (w) throw Object.assign(new AppError('RATE_LIMITED', 'Çok fazla deneme, lütfen bekleyin'), { retryAfter: w });
        }
        const out = await route.handler(pctx);
        const r = normalize(out);
        send(res, r.status ?? 200, r.body, r.headers);
        return;
      }

      // ---- authenticated ----
      const authz = req.headers.authorization ?? '';
      const token = /^Bearer\s+([A-Za-z0-9_\-]{20,200})$/.exec(authz)?.[1];
      if (!token) throw new AppError('UNAUTHENTICATED', 'Oturum gerekli');
      const s = (await pool.query<{ session_id: string; organization_id: string; user_id: string; access_expires_at: string; revoked_at: string | null; user_active: boolean }>(
        'SELECT * FROM tf_auth_find_session($1)', [sha256(token)])).rows[0];
      if (!s || s.revoked_at || !s.user_active) throw new AppError('UNAUTHENTICATED', 'Oturum geçersiz');
      if (new Date(s.access_expires_at) <= new Date()) throw new AppError('TOKEN_EXPIRED', 'Oturum süresi doldu');

      const isMutation = route.method !== 'GET';
      const idempotent = route.idempotent ?? isMutation;
      const idemKey = req.headers['idempotency-key'];
      if (idempotent && (typeof idemKey !== 'string' || !idempotencyKeyOk(idemKey))) {
        throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key başlığı zorunlu (8-128 karakter)');
      }

      const pending: DomainEvent[] = [];
      const result = await pool.transaction(async (db) => {
        await db.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [s.organization_id, s.user_id]);
        const auth = await loadAuth(db, s);
        const ctx: Ctx = {
          req, requestId, ip, userAgent, params: match!.params, body, query, db, auth,
          emit: (e) => pending.push(e),
          can: (p) => auth.permissions.has(p),
          require: (p) => { if (!auth.permissions.has(p)) throw new AppError('FORBIDDEN', `Bu işlem için yetkiniz yok (${p})`, { permission: p }); },
          assertFactory: (fid) => { if (auth.factoryIds && !auth.factoryIds.has(fid)) throw new AppError('FORBIDDEN', 'Bu fabrikaya erişim yetkiniz yok'); },
          audit: async (action, entityType, entityId, before, after) => {
            await db.query(`INSERT INTO audit_event (organization_id, actor_user_id, action, entity_type, entity_id, before_state, after_state, request_id, ip)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [auth.orgId, auth.userId, action, entityType, entityId, before ?? null, after ?? null, requestId, ip]);
          },
        };
        if (route.permission) ctx.require(route.permission);

        let reqHash = '';
        if (idempotent) {
          reqHash = sha256(JSON.stringify([route.method, route.path, match!.params, rawBody ?? null]));
          const ins = await db.query(
            `INSERT INTO idempotency_key (organization_id, key, user_id, method, route, request_hash) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (organization_id, key) DO NOTHING RETURNING key`,
            [auth.orgId, idemKey, auth.userId, route.method, route.path, reqHash]);
          if (!ins.rowCount) {
            // another committed request already used this key (concurrent duplicates block on the unique index above)
            const prev = (await db.query<{ request_hash: string; status_code: number | null; response_body: unknown; user_id: string }>(
              'SELECT request_hash, status_code, response_body, user_id FROM idempotency_key WHERE organization_id = $1 AND key = $2', [auth.orgId, idemKey])).rows[0];
            if (prev.request_hash !== reqHash || prev.user_id !== auth.userId) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Bu Idempotency-Key farklı bir istek için kullanılmış');
            if (prev.status_code == null) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'Aynı istek işleniyor');
            return { replay: true, status: prev.status_code, body: prev.response_body } as const;
          }
        }
        const out = normalize(await route.handler(ctx));
        const status = out.status ?? (isMutation ? 201 : 200);
        if (idempotent) {
          await db.query('UPDATE idempotency_key SET status_code = $3, response_body = $4 WHERE organization_id = $1 AND key = $2',
            [auth.orgId, idemKey, status, out.body ?? null]);
        }
        return { replay: false, status, body: out.body, headers: out.headers, orgId: auth.orgId } as const;
      });
      if (!result.replay) for (const e of pending) events.publish(result.orgId, e);
      send(res, result.status, result.body, { ...(result.replay ? { 'idempotent-replayed': 'true' } : {}), ...('headers' in result ? result.headers : {}) });
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'INTERNAL') console.error(`[${requestId}]`, e);
      const headers: Record<string, string> = {};
      const retry = (e as { retryAfter?: number }).retryAfter; if (retry) headers['retry-after'] = String(retry);
      send(res, err.status, errorBody(err.code, err.message, requestId, err.details), headers);
    }
  }

  return { handle, compiled, loginLimiter, apiLimiter };
}

function normalize(out: unknown): HandlerResult {
  if (out && typeof out === 'object' && 'body' in (out as object) && Object.keys(out as object).every((k) => ['status', 'body', 'headers'].includes(k))) return out as HandlerResult;
  return { body: out };
}
