import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { setup, expectStatus, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h?.close(); });

test('health endpoints and OpenAPI document', async () => {
  assert.equal((await (await fetch(h.base + '/health/live')).json()).status, 'ok');
  assert.equal((await (await fetch(h.base + '/health/ready')).json()).db, 'ok');
  const spec = await (await fetch(h.base + '/api/v1/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  const post = spec.paths['/api/v1/orders'].post;
  assert.equal(post['x-permission'], 'order.create');
  assert.ok(post.parameters.some((p: any) => p.name === 'Idempotency-Key' && p.required));
  assert.ok(post.requestBody.content['application/json'].schema.properties.lines);
  assert.ok(Object.keys(spec.paths).length >= 30);
});

test('live events: authenticated WebSocket receives tenant-scoped events only after commit', async () => {
  const depoA = await h.login('A', 'depo');
  const adminB = await h.login('B', 'admin');
  const wsUrl = h.base.replace('http', 'ws') + '/api/v1/events';
  const unauth = await new Promise<number>((res) => { const w = new WebSocket(wsUrl, ['texflow.v1']); w.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)); w.on('error', () => undefined); });
  assert.equal(unauth, 401);

  const collect = (token: string) => new Promise<{ ws: WebSocket; msgs: any[] }>((res, rej) => {
    const ws = new WebSocket(wsUrl, ['texflow.v1', 'auth.' + token]); const msgs: any[] = [];
    ws.on('message', (d) => { const m = JSON.parse(String(d)); msgs.push(m); if (m.type === 'hello') res({ ws, msgs }); });
    ws.on('error', rej);
  });
  const a = await collect(depoA.token);
  const b = await collect(adminB.token);
  // a failing command must not emit
  expectStatus(await depoA.post('/api/v1/receipts', { factoryId: h.a.factoryId, supplierId: h.a.supplierId, warehouseId: h.a.fabricWarehouseId, rolls: [{ materialId: h.a.materials.jersey, lotNo: 'X', shade: 'A', quantity: '5', unit: 'KG' }] }), 422);
  expectStatus(await depoA.post('/api/v1/receipts', { factoryId: h.a.factoryId, supplierId: h.a.supplierId, warehouseId: h.a.fabricWarehouseId, rolls: [{ materialId: h.a.materials.jersey, lotNo: 'X', shade: 'A', quantity: '5', unit: 'M' }] }), 201);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(a.msgs.filter((m) => m.type !== 'hello').map((m) => m.type), ['inventory.changed']);
  assert.equal(b.msgs.filter((m) => m.type !== 'hello').length, 0, 'other tenant receives nothing');
  a.ws.close(); b.ws.close();
});
