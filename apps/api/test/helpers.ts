/**
 * Integration test harness: real PostgreSQL (separate test database), real migrations,
 * real HTTP server on an ephemeral port, the least-privilege app role and RLS.
 */
import crypto from 'node:crypto';
import { loadDotEnv, migrate, Connection, parseDatabaseUrl, seedOrganization, type SeededOrg } from '@texflow/db';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';

export const PASSWORD = 'Test!Passw0rd';

export interface Harness {
  base: string; a: SeededOrg; b: SeededOrg;
  login(org: SeededOrg | 'A' | 'B', user: string): Promise<Client>;
  owner(): Promise<Connection>;
  appConn(): Promise<Connection>;
  close(): Promise<void>;
}

export interface Res<T = any> { status: number; body: T; headers: Headers }

export class Client {
  base: string; token: string; refreshToken: string;
  constructor(base: string, token: string, refreshToken: string) { this.base = base; this.token = token; this.refreshToken = refreshToken; }
  async req<T = any>(method: string, path: string, body?: unknown, opts: { idem?: string | null; headers?: Record<string, string> } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...(opts.headers ?? {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && opts.idem !== null) headers['idempotency-key'] = opts.idem ?? crypto.randomUUID();
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  }
  get<T = any>(p: string) { return this.req<T>('GET', p); }
  post<T = any>(p: string, b: unknown = {}, o?: { idem?: string | null }) { return this.req<T>('POST', p, b, o); }
}

export async function rawPost(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null, headers: r.headers };
}

export async function setup(): Promise<Harness> {
  loadDotEnv();
  const dbUrl = process.env.TEST_DATABASE_URL; const appUrl = process.env.TEST_APP_DATABASE_URL;
  if (!dbUrl || !appUrl) throw new Error('TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set');
  if (!/test/.test(parseDatabaseUrl(dbUrl).database)) throw new Error('refusing to run tests against a database whose name does not contain "test"');
  process.env.DATABASE_URL = dbUrl; process.env.APP_DATABASE_URL = appUrl;
  await migrate({ reset: true, log: () => undefined });
  const owner = new Connection(parseDatabaseUrl(dbUrl)); await owner.connect();
  const a = await seedOrganization(owner, { code: 'ACME', name: 'Acme Tekstil (test)', isDemo: false, password: PASSWORD, emailDomain: 'acme.test', withDemoModel: false });
  const b = await seedOrganization(owner, { code: 'BETA', name: 'Beta Konfeksiyon (test)', isDemo: false, password: PASSWORD, emailDomain: 'beta.test', withDemoModel: false });
  await owner.end();
  const app = createApp(loadConfig({ appDatabaseUrl: appUrl, apiRatePerMin: 100_000, loginRatePerMin: 1000, webDistDir: null, corsOrigins: [] }));
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  return {
    base, a, b,
    async login(org, user) {
      const o = org === 'A' ? a : org === 'B' ? b : org;
      const code = o === a ? 'ACME' : 'BETA';
      const r = await rawPost(base, '/api/v1/auth/login', { organizationCode: code, email: o.users[user].email, password: PASSWORD });
      if (r.status !== 200) throw new Error(`login failed for ${user}: ${JSON.stringify(r.body)}`);
      return new Client(base, r.body.accessToken, r.body.refreshToken);
    },
    async owner() { const c = new Connection(parseDatabaseUrl(dbUrl)); await c.connect(); return c; },
    async appConn() { const c = new Connection(parseDatabaseUrl(appUrl)); await c.connect(); return c; },
    async close() { await app.close(); },
  };
}

export function expectStatus(r: Res, status: number, code?: string) {
  if (r.status !== status || (code && r.body?.error?.code !== code)) {
    throw new Error(`expected ${status}${code ? ' ' + code : ''}, got ${r.status}: ${JSON.stringify(r.body).slice(0, 600)}`);
  }
  return r.body;
}

/** Builds an approved model + BOM through the API (teknik creates, teknikmudur approves). */
export async function approvedModel(h: Harness, org: SeededOrg, code: string) {
  const teknik = await h.login(org, 'teknik');
  const mudur = await h.login(org, 'teknikmudur');
  const m = expectStatus(await teknik.post('/api/v1/models', { code, name: `Model ${code}`, customerId: org.customerId, season: 'SS27', colorIds: [org.colors.SYH], sizeIds: [org.sizes.M, org.sizes.L] }), 201);
  const sub = expectStatus(await teknik.post(`/api/v1/models/${m.id}/submit`, { expectedVersion: m.rowVersion }), 200);
  const app = expectStatus(await mudur.post(`/api/v1/models/${m.id}/approve`, { expectedVersion: sub.rowVersion }), 200);
  const bom = expectStatus(await teknik.post(`/api/v1/models/${m.id}/boms`, { items: [
    { materialId: org.materials.jersey, placement: 'Gövde', consumptionPerPiece: '0.95', unit: 'M', wastePct: '4' },
    { materialId: org.materials.rib, placement: 'Yaka', consumptionPerPiece: '0.012', unit: 'KG', wastePct: '3' },
  ] }), 201);
  const approved = expectStatus(await mudur.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: bom.rowVersion }), 200);
  return { model: app, bom: approved };
}

export async function confirmedOrder(h: Harness, org: SeededOrg, modelId: string, qtyM = '600', qtyL = '400') {
  const plan = await h.login(org, 'planlama');
  const o = expectStatus(await plan.post('/api/v1/orders', { factoryId: org.factoryId, customerId: org.customerId, customerPo: 'PO-77', currency: 'EUR', orderDate: '2026-11-02', dueDate: '2027-01-15',
    lines: [{ modelId, colorId: org.colors.SYH, sizeId: org.sizes.M, quantity: qtyM, unitPrice: '4.85' }, { modelId, colorId: org.colors.SYH, sizeId: org.sizes.L, quantity: qtyL, unitPrice: '4.85' }] }), 201);
  const c = expectStatus(await plan.post(`/api/v1/orders/${o.id}/confirm`, { expectedVersion: o.rowVersion }), 200);
  return c;
}

export async function receiveAndAccept(h: Harness, org: SeededOrg, rolls: { qty: string; shade: string; lot: string }[], opts: { accept?: boolean } = {}) {
  const depo = await h.login(org, 'depo');
  const kalite = await h.login(org, 'kalite');
  const gr = expectStatus(await depo.post('/api/v1/receipts', { factoryId: org.factoryId, supplierId: org.supplierId, warehouseId: org.fabricWarehouseId,
    rolls: rolls.map((r) => ({ materialId: org.materials.jersey, lotNo: r.lot, shade: r.shade, colorId: org.colors.SYH, widthCm: '180', gsm: '180', quantity: r.qty, unit: 'M' })) }), 201);
  if (opts.accept === false) return gr.rolls as { id: string }[];
  for (const r of gr.rolls) {
    const roll = expectStatus(await kalite.get(`/api/v1/rolls/${r.id}`), 200);
    expectStatus(await kalite.post(`/api/v1/rolls/${r.id}/inspections`, { inspectedLengthM: r.quantity, cuttableWidthCm: '176', measuredGsm: '182', measuredWidthCm: '179', defects: [], expectedVersion: roll.rowVersion }), 201);
  }
  return gr.rolls as { id: string; rollNo: string; quantity: string }[];
}
