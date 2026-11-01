import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectStatus, rawPost, approvedModel, confirmedOrder, receiveAndAccept, PASSWORD, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h?.close(); });

test('authentication: missing / malformed / revoked tokens are rejected', async () => {
  const r = await fetch(h.base + '/api/v1/orders');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'UNAUTHENTICATED');
  const r2 = await fetch(h.base + '/api/v1/orders', { headers: { authorization: 'Bearer ' + 'x'.repeat(43) } });
  assert.equal(r2.status, 401);
  const c = await h.login('A', 'planlama');
  expectStatus(await c.post('/api/v1/auth/logout', {}, { idem: null }), 200);
  expectStatus(await c.get('/api/v1/orders'), 401, 'UNAUTHENTICATED');
});

test('login: wrong password → generic error; account locks after 5 failures', async () => {
  const email = h.a.users.izleyici.email;
  for (let i = 0; i < 5; i++) {
    const r = await rawPost(h.base, '/api/v1/auth/login', { organizationCode: 'ACME', email, password: 'wrong-password' });
    expectStatus(r, 401, 'INVALID_CREDENTIALS');
  }
  const locked = await rawPost(h.base, '/api/v1/auth/login', { organizationCode: 'ACME', email, password: PASSWORD });
  expectStatus(locked, 423, 'ACCOUNT_LOCKED');
  const unknown = await rawPost(h.base, '/api/v1/auth/login', { organizationCode: 'ACME', email: 'nobody@acme.test', password: 'x' });
  expectStatus(unknown, 401, 'INVALID_CREDENTIALS');
  const wrongOrg = await rawPost(h.base, '/api/v1/auth/login', { organizationCode: 'BETA', email: h.a.users.admin.email, password: PASSWORD });
  expectStatus(wrongOrg, 401, 'INVALID_CREDENTIALS');
});

test('refresh tokens rotate; reusing an old refresh token revokes the whole session family', async () => {
  const c = await h.login('A', 'admin');
  const r1 = expectStatus(await rawPost(h.base, '/api/v1/auth/refresh', { refreshToken: c.refreshToken }), 200);
  assert.notEqual(r1.accessToken, c.token);
  // old access token is revoked by rotation
  expectStatus(await c.get('/api/v1/auth/me'), 401);
  // replay of the first refresh token = theft signal
  expectStatus(await rawPost(h.base, '/api/v1/auth/refresh', { refreshToken: c.refreshToken }), 401, 'REFRESH_TOKEN_REUSED');
  // the legitimately rotated token is now dead too
  const r = await fetch(h.base + '/api/v1/auth/me', { headers: { authorization: `Bearer ${r1.accessToken}` } });
  assert.equal(r.status, 401);
  expectStatus(await rawPost(h.base, '/api/v1/auth/refresh', { refreshToken: r1.refreshToken }), 401, 'REFRESH_TOKEN_REUSED');
});

test('RBAC: permission denials are enforced server-side', async () => {
  const viewer = await h.login('A', 'teknik');
  const kalite = await h.login('A', 'kalite');
  const body = { factoryId: h.a.factoryId, customerId: h.a.customerId, currency: 'EUR', orderDate: '2026-11-02', dueDate: '2026-12-02',
    lines: [{ modelId: crypto.randomUUID(), colorId: h.a.colors.SYH, sizeId: h.a.sizes.M, quantity: '10', unitPrice: '1' }] };
  const r = expectStatus(await viewer.post('/api/v1/orders', body), 403, 'FORBIDDEN');
  assert.equal(r.error.details.permission, 'order.create');
  expectStatus(await kalite.post('/api/v1/receipts', { factoryId: h.a.factoryId, supplierId: h.a.supplierId, warehouseId: h.a.fabricWarehouseId,
    rolls: [{ materialId: h.a.materials.jersey, lotNo: 'L', shade: 'A', quantity: '10', unit: 'M' }] }), 403, 'FORBIDDEN');
  expectStatus(await kalite.get('/api/v1/audit'), 403, 'FORBIDDEN');
});

test('factory scoping: a user assigned to Bursa cannot receive into the Istanbul warehouse', async () => {
  const bursa = await h.login('A', 'bursadepo');
  const r = await bursa.post('/api/v1/receipts', { factoryId: h.a.factoryId, supplierId: h.a.supplierId, warehouseId: h.a.fabricWarehouseId,
    rolls: [{ materialId: h.a.materials.jersey, lotNo: 'L', shade: 'A', quantity: '10', unit: 'M' }] });
  expectStatus(r, 403, 'FORBIDDEN');
  const me = expectStatus(await bursa.get('/api/v1/auth/me'), 200);
  assert.deepEqual(me.factories.map((f: any) => f.code), ['BUR1']);
});

test('tenant isolation: organization B cannot see or touch organization A data (API + RLS)', async () => {
  const { model } = await approvedModel(h, h.a, 'ISO-1');
  const order = await confirmedOrder(h, h.a, model.id);
  const [roll] = await receiveAndAccept(h, h.a, [{ qty: '100', shade: 'A', lot: 'ISO' }]);
  const bAdmin = await h.login('B', 'admin');

  expectStatus(await bAdmin.get(`/api/v1/orders/${order.id}`), 404, 'NOT_FOUND');
  expectStatus(await bAdmin.get(`/api/v1/models/${model.id}`), 404, 'NOT_FOUND');
  expectStatus(await bAdmin.get(`/api/v1/rolls/${roll.id}`), 404, 'NOT_FOUND');
  const list = expectStatus(await bAdmin.get('/api/v1/orders'), 200);
  assert.equal(list.page.total, 0);
  const ledger = expectStatus(await bAdmin.get('/api/v1/inventory/ledger'), 200);
  assert.equal(ledger.page.total, 0);
  // commands referencing A's ids from B fail as not found / invalid reference
  expectStatus(await bAdmin.post(`/api/v1/orders/${order.id}/confirm`, { expectedVersion: 1 }), 404);
  const cross = await bAdmin.post('/api/v1/orders', { factoryId: h.b.factoryId, customerId: h.a.customerId, currency: 'EUR', orderDate: '2026-11-02', dueDate: '2026-12-02',
    lines: [{ modelId: model.id, colorId: h.a.colors.SYH, sizeId: h.a.sizes.M, quantity: '10', unitPrice: '1' }] });
  assert.equal(cross.status, 404);
  expectStatus(await bAdmin.post('/api/v1/work-orders', { salesOrderId: order.id, modelId: model.id, colorId: h.a.colors.SYH, plannedQty: '1' }), 404);

  // Database layer: the app role sees nothing without a tenant context, and only its own tenant with one
  const c = await h.appConn();
  try {
    assert.equal((await c.query('SELECT count(*)::int AS n FROM sales_order')).rows[0].n, 0, 'no tenant context → no rows');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [h.b.orgId]);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM fabric_roll')).rows[0].n, 0);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM sales_order WHERE id = $1', [order.id])).rows[0].n, 0);
    // writing a row that claims another tenant is rejected by the RLS WITH CHECK policy
    await assert.rejects(c.query(`INSERT INTO customer (organization_id, code, name, currency) VALUES ($1,'HACK','x','EUR')`, [h.a.orgId]), (e: any) => e.code === '42501');
    await c.query('ROLLBACK');
    // the app role cannot bypass RLS or read the migrations table
    const role = (await c.query("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0];
    assert.equal(role.rolbypassrls, false); assert.equal(role.rolsuper, false);
    await assert.rejects(c.query('SELECT * FROM schema_migrations'), (e: any) => e.code === '42501');
  } finally { await c.end(); }
});

test('ledgers and audit trail are append-only (grants + triggers)', async () => {
  const c = await h.appConn();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [h.a.orgId]);
    await assert.rejects(c.query('UPDATE inventory_movement SET qty_delta = 0'), (e: any) => e.code === '42501');
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [h.a.orgId]);
    await assert.rejects(c.query('DELETE FROM audit_event'), (e: any) => e.code === '42501');
    await c.query('ROLLBACK');
  } finally { await c.end(); }
  // even the schema owner is stopped by the immutability trigger
  const o = await h.owner();
  try {
    await assert.rejects(o.query('UPDATE inventory_movement SET reason = $1', ['tamper']), /append-only/);
    await assert.rejects(o.query('DELETE FROM audit_event'), /append-only/);
    await assert.rejects(o.query('UPDATE material_inspection SET result = $1', ['PASS']), /append-only/);
  } finally { await o.end(); }
});

test('segregation of duties: BOM creator cannot approve own BOM; adjustment requester cannot approve own request', async () => {
  // grant the technologist bom.approve through a role assignment, then verify SoD still blocks self-approval
  const admin = await h.login('A', 'admin');
  const m = expectStatus(await admin.post('/api/v1/models', { code: 'SOD-1', name: 'SoD', colorIds: [h.a.colors.SYH], sizeIds: [h.a.sizes.M] }), 201);
  const s = expectStatus(await admin.post(`/api/v1/models/${m.id}/submit`, { expectedVersion: m.rowVersion }), 200);
  expectStatus(await admin.post(`/api/v1/models/${m.id}/approve`, { expectedVersion: s.rowVersion }), 200);
  const bom = expectStatus(await admin.post(`/api/v1/models/${m.id}/boms`, { items: [{ materialId: h.a.materials.jersey, consumptionPerPiece: '1', unit: 'M' }] }), 201);
  expectStatus(await admin.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: bom.rowVersion }), 403, 'SELF_APPROVAL_FORBIDDEN');

  const [roll] = await receiveAndAccept(h, h.a, [{ qty: '50', shade: 'A', lot: 'SOD' }]);
  const depo = await h.login('A', 'depo');
  const ctrl = await h.login('A', 'stokkontrol');
  const req = expectStatus(await depo.post('/api/v1/inventory/adjustments', { rollId: roll.id, qtyDelta: '-2.5', reason: 'Sayım farkı - top ucu hasarlı' }), 201);
  expectStatus(await depo.post(`/api/v1/inventory/adjustments/${req.id}/decide`, { approve: true }), 403, 'FORBIDDEN'); // no approve permission
  expectStatus(await admin.post(`/api/v1/inventory/adjustments/${req.id}/decide`, { approve: true }), 200); // admin is not the requester
  const r2 = expectStatus(await admin.post('/api/v1/inventory/adjustments', { rollId: roll.id, qtyDelta: '1', reason: 'Admin kendi talebi' }), 201);
  expectStatus(await admin.post(`/api/v1/inventory/adjustments/${r2.id}/decide`, { approve: true }), 403, 'SELF_APPROVAL_FORBIDDEN');
  expectStatus(await ctrl.post(`/api/v1/inventory/adjustments/${r2.id}/decide`, { approve: false, note: 'Gerekçe yetersiz' }), 200);
  const rollAfter = expectStatus(await depo.get(`/api/v1/rolls/${roll.id}`), 200);
  assert.equal(rollAfter.physicalQty, '47.5000');
  assert.equal(rollAfter.movements.at(-1).movementType, 'ADJUSTMENT');
});

test('input validation returns structured errors; bodies are size-limited', async () => {
  const plan = await h.login('A', 'planlama');
  const r = expectStatus(await plan.post('/api/v1/orders', { factoryId: 'nope', lines: [] }), 400, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(r.error.details) && r.error.details.length > 0);
  assert.ok(r.error.requestId);
  const big = await plan.req('POST', '/api/v1/customers', { code: 'X', name: 'x'.repeat(1_100_000), currency: 'EUR' });
  expectStatus(big, 413, 'PAYLOAD_TOO_LARGE');
  const resp = await fetch(h.base + '/api/v1/orders', { headers: { authorization: `Bearer ${plan.token}` } });
  assert.equal(resp.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(resp.headers.get('cache-control'), 'no-store');
});
