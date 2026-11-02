import http from 'node:http';
import { z } from 'zod/v4';
import { WebSocketServer, type WebSocket } from 'ws';
import { Pool, parseDatabaseUrl } from '@texflow/db';
import type { Config } from './config.ts';
import { createKernel, EventBus, type Route } from './http/kernel.ts';
import { sha256 } from '@texflow/db';
import { authRoutes } from './modules/auth.ts';
import { referenceRoutes } from './modules/reference.ts';
import { orderRoutes } from './modules/orders.ts';
import { plmRoutes } from './modules/plm.ts';
import { inventoryRoutes } from './modules/inventory.ts';
import { workOrderRoutes } from './modules/workOrders.ts';
import { auditRoutes } from './modules/audit.ts';
import { homeRoutes } from './modules/home.ts';

export const API_VERSION = '1.0.0-phase0';

function openApi(routes: Route[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  const toJson = (s: z.ZodType) => { try { const j = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>; delete j.$schema; return j; } catch { return { type: 'object' }; } };
  for (const r of routes) {
    const p = r.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const params = [...r.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const isPublic = r.public === true;
    const op: Record<string, unknown> = {
      tags: [r.tag], summary: r.summary, operationId: `${r.method.toLowerCase()}_${r.path.replace(/[/:{}-]+/g, '_')}`,
      parameters: [...params],
      responses: { '200': { description: 'OK' }, '201': { description: 'Oluşturuldu' }, default: { description: 'Hata', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      security: isPublic ? [] : [{ bearer: [] }],
    };
    if (!r.public) {
      op['x-permission'] = r.permission;
      if (r.idempotent ?? r.method !== 'GET') (op.parameters as unknown[]).push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } });
    }
    if (r.query) {
      const js = toJson(r.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(js.properties ?? {})) (op.parameters as unknown[]).push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema });
    }
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: toJson(r.body) } } };
    (paths[p] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'TEXFLOW AI API', version: API_VERSION, description: 'Tekstil ERP + MES. Tüm mutasyonlar Idempotency-Key ister; miktar ve tutarlar ondalık string olarak taşınır.' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: { Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } }, required: ['code', 'message'] } } } },
    },
    paths,
  };
}

export function createApp(config: Config) {
  const pool = new Pool({ ...parseDatabaseUrl(config.appDatabaseUrl), applicationName: 'texflow-api' }, 20);
  const events = new EventBus();
  const routes: Route[] = [
    ...authRoutes(config), ...referenceRoutes(), ...orderRoutes(), ...plmRoutes(), ...inventoryRoutes(), ...workOrderRoutes(), ...auditRoutes(), ...homeRoutes(),
  ];
  const spec = openApi(routes);
  routes.push(
    { method: 'GET', path: '/api/v1/openapi.json', tag: 'meta', summary: 'OpenAPI 3.1 belgesi', public: true, handler: async () => spec },
    { method: 'GET', path: '/health/live', tag: 'meta', summary: 'Canlılık', public: true, handler: async () => ({ status: 'ok', version: API_VERSION }) },
    { method: 'GET', path: '/health/ready', tag: 'meta', summary: 'Hazırlık (veritabanı)', public: true,
      handler: async (c) => {
        try { await c.pool.query('SELECT 1'); return { status: 'ok', db: 'ok' }; } catch { return { status: 503, body: { status: 'degraded', db: 'unreachable' } }; }
      } },
  );
  const kernel = createKernel({ pool, config, events, routes });
  const server = http.createServer((req, res) => { void kernel.handle(req, res); });
  server.headersTimeout = 20_000; server.requestTimeout = 30_000;

  // Live events: authenticated with the access token passed as a WebSocket sub-protocol
  // ("texflow.v1", "auth.<token>") so it never appears in URLs or logs.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('texflow.v1') ? 'texflow.v1' : false) });
  const sockets = new Set<WebSocket>();
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/v1/events') throw new Error('path');
      const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
      const token = protos.find((p) => p.startsWith('auth.'))?.slice(5);
      if (!token) throw new Error('no token');
      const s = (await pool.query('SELECT * FROM tf_auth_find_session($1)', [sha256(token)])).rows[0];
      if (!s || s.revoked_at || !s.user_active || new Date(s.access_expires_at) <= new Date()) throw new Error('auth');
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        const unsub = events.subscribe(s.organization_id, (e) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); });
        const expiry = setTimeout(() => ws.close(4001, 'token expired'), Math.max(0, new Date(s.access_expires_at).getTime() - Date.now()));
        ws.on('close', () => { unsub(); clearTimeout(expiry); sockets.delete(ws); });
        ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy();
    }
  });

  return {
    server, pool, events, routes, kernel,
    async listen(port = config.port, host = config.host): Promise<number> {
      await new Promise<void>((res) => server.listen(port, host, () => res()));
      const a = server.address(); return typeof a === 'object' && a ? a.port : port;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((res) => server.close(() => res()));
      await pool.end();
    },
  };
}
