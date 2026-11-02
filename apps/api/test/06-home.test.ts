import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureRoleSet } from '@texflow/db';
import { setup, expectStatus, approvedModel, confirmedOrder, receiveAndAccept, PASSWORD, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h?.close(); });

test('home: each role gets its own default panel and only the blocks its permissions allow', async () => {
  const cases: [string, string, string[], string[]][] = [
    // user, default panel, blocks present, blocks absent
    ['fabrikamuduru', 'factory', ['orders', 'workOrders', 'inventory', 'quality'], []],
    ['uretim', 'production', ['orders', 'workOrders', 'inventory'], []],
    ['depo', 'warehouse', ['inventory', 'quality', 'workOrders'], []],
    ['operator', 'operator', ['workOrders', 'inventory'], ['orders']],
    ['kalite', 'warehouse', ['inventory'], ['orders', 'workOrders']],
  ];
  for (const [user, panel, present, absent] of cases) {
    const c = await h.login('A', user);
    const d = expectStatus(await c.get('/api/v1/home'), 200);
    assert.equal(d.defaultPanel, panel, user);
    for (const k of present) assert.ok(d[k], `${user} should see ${k}`);
    for (const k of absent) assert.equal(d[k], undefined, `${user} must not see ${k}`);
  }
  // commercial values only with customer.read; never summed across currencies
  const fm = expectStatus(await (await h.login('A', 'fabrikamuduru')).get('/api/v1/home'), 200);
  assert.ok(Array.isArray(fm.orders.activeValueByCurrency));
  const um = expectStatus(await (await h.login('A', 'uretim')).get('/api/v1/home'), 200);
  assert.equal(um.orders.activeValueByCurrency, null);
  // operator has no order permission on the server either
  const op = await h.login('A', 'operator');
  expectStatus(await op.get('/api/v1/orders'), 403, 'FORBIDDEN');
  assert.deepEqual(expectStatus(await op.get('/api/v1/home'), 200).panels, ['production', 'warehouse', 'operator']);
});

test('home: live order, work-order and fabric data; units are never mixed; unmeasured metrics are not invented', async () => {
  const { model } = await approvedModel(h, h.a, 'HOME-1');
  const order = await confirmedOrder(h, h.a, model.id);
  const plan = await h.login('A', 'planlama');
  // an overdue order (dates in the past are valid history)
  const late = expectStatus(await plan.post('/api/v1/orders', { factoryId: h.a.factoryId, customerId: h.a.customerId, currency: 'TRY', orderDate: '2026-01-05', dueDate: '2026-02-01',
    lines: [{ modelId: model.id, colorId: h.a.colors.SYH, sizeId: h.a.sizes.M, quantity: '100', unitPrice: '10' }] }), 201);
  expectStatus(await plan.post(`/api/v1/orders/${late.id}/confirm`, { expectedVersion: late.rowVersion }), 200);
  const wo = expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: order.id, modelId: model.id, colorId: h.a.colors.SYH, plannedQty: '1000' }), 201);
  expectStatus(await plan.post(`/api/v1/work-orders/${wo.id}/release`, { expectedVersion: wo.rowVersion }), 200);
  await receiveAndAccept(h, h.a, [{ qty: '250', shade: 'A', lot: 'L-H1' }]);
  await receiveAndAccept(h, h.a, [{ qty: '120', shade: 'A', lot: 'L-H2' }], { accept: false });

  const d = expectStatus(await (await h.login('A', 'fabrikamuduru')).get('/api/v1/home'), 200);
  assert.ok(d.orders.active >= 2);
  assert.ok(d.orders.delayed >= 1);
  for (const k of ['active', 'draft', 'delayed', 'dueSoon']) assert.equal(typeof d.orders[k], 'number', k);
  const risky = d.orders.risky.find((r: any) => r.id === late.id);
  assert.ok(risky?.delayed, 'overdue order is listed as delayed');
  assert.ok(d.alerts.some((a: any) => a.link === `orders/${late.id}`));
  // value per currency, separately
  const cur = d.orders.activeValueByCurrency.map((v: any) => v.currency).sort();
  assert.deepEqual(cur, ['EUR', 'TRY']);
  assert.equal(d.orders.activeValueByCurrency.find((v: any) => v.currency === 'TRY').amount, '1000.00000000');
  assert.ok(d.workOrders.list.some((w: any) => w.id === wo.id && w.status === 'RELEASED'));
  assert.ok(d.workOrders.plannedOpen.some((p: any) => p.unit === 'PCS' && Number(p.qty) >= 1000));
  const acc = d.inventory.qtyByUnit.find((r: any) => r.unit === 'M' && r.status === 'ACCEPTED');
  const qua = d.inventory.qtyByUnit.find((r: any) => r.unit === 'M' && r.status === 'QUARANTINE');
  assert.ok(Number(acc.physical) >= 250 && Number(qua.physical) >= 120);
  for (const r of d.inventory.qtyByUnit) assert.ok(['M', 'KG', 'PCS'].includes(r.unit));
  assert.ok(d.quality.inspections30d >= 1 && d.quality.passRatePct !== null);
  // things the system does not record are explicitly not measured
  assert.equal(d.production.measured, false);
  assert.equal(d.cost.measured, false);
  assert.ok(d.production.lines.length >= 2 && d.production.shifts.length >= 2);

  // production filters: by sales order and status
  const pm = await h.login('A', 'uretim');
  const f = expectStatus(await pm.get(`/api/v1/home?salesOrderId=${late.id}`), 200);
  assert.equal(f.workOrders.list.length, 0);
  const g = expectStatus(await pm.get(`/api/v1/home?salesOrderId=${order.id}&woStatus=RELEASED`), 200);
  assert.deepEqual(g.workOrders.list.map((w: any) => w.id), [wo.id]);
  expectStatus(await pm.get('/api/v1/home?woStatus=BOGUS'), 400, 'VALIDATION_FAILED');
});

test('home + legacy dashboard respect factory scope; other organizations are invisible', async () => {
  // bursadepo is bound to the second factory: none of factory 1's rolls or orders are visible
  const bur = await h.login('A', 'bursadepo');
  const d = expectStatus(await bur.get('/api/v1/home'), 200);
  assert.deepEqual(d.scope.factories.map((f: any) => f.id), [h.a.factory2Id]);
  assert.deepEqual(d.inventory.rollsByStatus, []);
  assert.equal(d.orders.active, 0);
  assert.ok(d.production.lines.every((l: any) => l.factoryCode === 'BUR1'));
  expectStatus(await bur.get(`/api/v1/home?factoryId=${h.a.factoryId}`), 403, 'FORBIDDEN');
  const legacy = expectStatus(await bur.get('/api/v1/dashboard'), 200);
  assert.deepEqual(legacy.ordersByStatus, []);
  assert.deepEqual(legacy.rollsByStatus, []);
  // the unrestricted admin of organization A sees data; organization B sees none of it
  const adminA = expectStatus(await (await h.login('A', 'admin')).get('/api/v1/home'), 200);
  assert.ok(adminA.inventory.rollsByStatus.length > 0);
  const adminB = expectStatus(await (await h.login('B', 'admin')).get('/api/v1/home'), 200);
  assert.deepEqual(adminB.inventory.rollsByStatus, []);
  assert.equal(adminB.orders.active, 0);
});

test('seed: display names are role titles (no personal names); role upgrade is idempotent and non-destructive', async () => {
  const titles = new Set(['Sistem Yöneticisi', 'Planlama Uzmanı', 'Modelist / Teknik Ofis', 'Teknik Müdür', 'Depo Sorumlusu', 'Kalite Kontrol Uzmanı', 'Stok Kontrol', 'İzleyici', 'Bursa Depo',
    'Fabrika Müdürü', 'Üretim Sorumlusu', 'Operatör']);
  const o = await h.owner();
  try {
    // RLS-scoped read per organization
    const names: string[] = [];
    for (const org of [h.a.orgId, h.b.orgId]) {
      await o.query("SELECT set_config('app.org_id', $1, false)", [org]);
      names.push(...(await o.query<{ display_name: string }>('SELECT display_name FROM app_user')).rows.map((r) => r.display_name));
    }
    assert.ok(names.length >= 24);
    for (const n of names) assert.ok(titles.has(n.replace(/^DEMO /, '')), `display name is not a role title: ${n}`);
    await o.query("SELECT set_config('app.org_id', $1, false)", [h.a.orgId]);
    const snap = async () => (await o.query<{ s: string }>(`SELECT md5(string_agg(id::text || email || display_name || password_hash, ',' ORDER BY id)) AS s FROM app_user`)).rows[0].s;
    const s1 = await snap();
    assert.deepEqual(await ensureRoleSet(o, 'ACME', { password: PASSWORD, emailDomain: 'acme.test' }), []);
    await o.query("SELECT set_config('app.org_id', $1, false)", [h.a.orgId]);
    assert.equal(await snap(), s1);
  } finally { await o.end(); }
});
