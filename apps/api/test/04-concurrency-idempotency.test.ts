import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Dec } from '@texflow/shared';
import { setup, expectStatus, approvedModel, receiveAndAccept, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h?.close(); });

const orderBody = (modelId: string, qty = '10') => ({ factoryId: h.a.factoryId, customerId: h.a.customerId, currency: 'EUR', orderDate: '2026-11-02', dueDate: '2026-12-01',
  lines: [{ modelId, colorId: h.a.colors.SYH, sizeId: h.a.sizes.M, quantity: qty, unitPrice: '2.5' }] });

test('idempotency: missing key rejected; repeated key replays the original response without a second effect', async () => {
  const { model } = await approvedModel(h, h.a, 'IDM-1');
  const plan = await h.login('A', 'planlama');
  expectStatus(await plan.post('/api/v1/orders', orderBody(model.id), { idem: null }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  const key = 'order-create-' + crypto.randomUUID();
  const first = await plan.post('/api/v1/orders', orderBody(model.id), { idem: key });
  const second = await plan.post('/api/v1/orders', orderBody(model.id), { idem: key });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.orderNo, first.body.orderNo);
  const list = expectStatus(await plan.get('/api/v1/orders?limit=200'), 200);
  assert.equal(list.items.filter((o: any) => o.id === first.body.id).length, 1);
  assert.equal(list.page.total, 1);
  // same key, different payload → refused
  expectStatus(await plan.post('/api/v1/orders', orderBody(model.id, '11'), { idem: key }), 422, 'IDEMPOTENCY_KEY_REUSED');
  // same key from a different user → refused (keys are not shareable)
  const admin = await h.login('A', 'admin');
  expectStatus(await admin.post('/api/v1/orders', orderBody(model.id), { idem: key }), 422, 'IDEMPOTENCY_KEY_REUSED');
});

test('idempotency under concurrency: 8 parallel submissions with one key create exactly one order', async () => {
  const { model } = await approvedModel(h, h.a, 'IDM-2');
  const plan = await h.login('A', 'planlama');
  const before = expectStatus(await plan.get('/api/v1/orders?limit=1'), 200).page.total;
  const key = 'offline-retry-' + crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => plan.post('/api/v1/orders', orderBody(model.id), { idem: key })));
  const ids = new Set(results.map((r) => { assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id; }));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.headers.get('idempotent-replayed') !== 'true').length, 1);
  const afterTotal = expectStatus(await plan.get('/api/v1/orders?limit=1'), 200).page.total;
  assert.equal(afterTotal, before + 1);
});

test('a failed command does not consume its idempotency key (safe retry after fixing the cause)', async () => {
  const { model } = await approvedModel(h, h.a, 'IDM-3');
  const plan = await h.login('A', 'planlama');
  const o = expectStatus(await plan.post('/api/v1/orders', orderBody(model.id)), 201);
  const key = 'confirm-' + crypto.randomUUID();
  expectStatus(await plan.post(`/api/v1/orders/${o.id}/confirm`, { expectedVersion: 99 }, { idem: key }), 409, 'VERSION_CONFLICT');
  // different body with the same key is fine because nothing was stored for the failed attempt
  const ok = expectStatus(await plan.post(`/api/v1/orders/${o.id}/confirm`, { expectedVersion: o.rowVersion }, { idem: key }), 200);
  assert.equal(ok.status, 'CONFIRMED');
});

async function releasedWo(model: { id: string }, qty: string) {
  const plan = await h.login('A', 'planlama');
  const o = expectStatus(await plan.post('/api/v1/orders', orderBody(model.id, qty)), 201);
  expectStatus(await plan.post(`/api/v1/orders/${o.id}/confirm`, { expectedVersion: o.rowVersion }), 200);
  const w = expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: o.id, modelId: model.id, colorId: h.a.colors.SYH, plannedQty: qty }), 201);
  const rel = expectStatus(await plan.post(`/api/v1/work-orders/${w.id}/release`, { expectedVersion: w.rowVersion }), 200);
  return { wo: rel, wm: rel.materials.find((m: any) => m.materialId === h.a.materials.jersey) };
}

test('inventory concurrency: parallel reservations against one roll never over-reserve', async () => {
  const { model } = await approvedModel(h, h.a, 'CC-1');
  // each WO needs 80 × 0.95 × 1.04 = 79.04 m; only one 100 m roll exists
  const wos = await Promise.all(Array.from({ length: 6 }, () => releasedWo(model, '80')));
  const [roll] = await receiveAndAccept(h, h.a, [{ qty: '100', shade: 'C', lot: 'CC' }]);
  const plan = await h.login('A', 'planlama');
  const results = await Promise.all(wos.map(({ wo, wm }) => plan.post(`/api/v1/work-orders/${wo.id}/materials/${wm.id}/reserve`, { allowPartial: false })));
  const ok = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, 'exactly one full reservation fits');
  assert.equal(refused.length, 5);
  for (const r of refused) assert.equal(r.body.error.code, 'INSUFFICIENT_STOCK');
  const r = expectStatus(await plan.get(`/api/v1/rolls/${roll.id}`), 200);
  assert.equal(r.reservedQty, '79.0400');
  assert.ok(Dec.of(r.reservedQty).lte(r.physicalQty));
});

test('inventory concurrency: parallel partial reservations sum to at most the physical stock and the ledger reconciles', async () => {
  const { model } = await approvedModel(h, h.a, 'CC-2');
  const wos = await Promise.all(Array.from({ length: 8 }, () => releasedWo(model, '40'))); // 39.52 m each, 316.16 m total demand
  const rolls = await receiveAndAccept(h, h.a, [{ qty: '70', shade: 'D', lot: 'CC2' }, { qty: '70', shade: 'D', lot: 'CC2' }, { qty: '50', shade: 'D', lot: 'CC2' }]); // 190 m supply
  const plan = await h.login('A', 'planlama');
  const avail = async () => expectStatus(await plan.get('/api/v1/inventory/summary'), 200).items.find((i: any) => i.materialId === h.a.materials.jersey).availableQty as string;
  const supply = await avail(); // includes leftovers of earlier tests (other shades); 190 m of shade D is new
  assert.ok(Dec.of(supply).gte('190'));
  const results = await Promise.all(wos.map(({ wo, wm }) => plan.post(`/api/v1/work-orders/${wo.id}/materials/${wm.id}/reserve`, { allowPartial: true, singleShade: false })));
  const reserved = Dec.sum(results.filter((r) => r.status === 201).map((r) => r.body.reservedQty));
  assert.ok(reserved.lte(supply), `reserved ${reserved} must not exceed supply ${supply}`);
  assert.ok(Dec.of(supply).sub(reserved).lt('39.52') , 'demand exceeds supply, so (almost) all supply is allocated');
  assert.ok(Dec.of(await avail()).eq(Dec.of(supply).sub(reserved)), 'available stock decreased by exactly the reserved amount');
  for (const r of results) if (r.status !== 201) assert.equal(r.body.error.code, 'INSUFFICIENT_STOCK');
  const owner = await h.owner();
  try {
    const rows = (await owner.query(`SELECT r.id, r.physical_qty, r.reserved_qty, (SELECT coalesce(sum(reserved_delta),0) FROM inventory_movement m WHERE m.roll_id = r.id) AS ledger_reserved,
        (SELECT coalesce(sum(qty),0) FROM stock_reservation s WHERE s.roll_id = r.id AND s.status = 'ACTIVE') AS active_res
      FROM fabric_roll r WHERE r.id = ANY($1::uuid[])`, [rolls.map((x) => x.id)])).rows;
    for (const row of rows) {
      assert.ok(Dec.of(row.reserved_qty).lte(row.physical_qty), 'never over-reserved');
      assert.ok(Dec.of(row.reserved_qty).eq(row.ledger_reserved), 'projection == ledger');
      assert.ok(Dec.of(row.reserved_qty).eq(row.active_res), 'projection == active reservations');
    }
    const wm = (await owner.query(`SELECT wm.id, wm.reserved_qty, (SELECT coalesce(sum(qty),0) FROM stock_reservation s WHERE s.work_order_material_id = wm.id AND s.status='ACTIVE') AS res
      FROM work_order_material wm WHERE wm.id = ANY($1::uuid[])`, [wos.map((w) => w.wm.id)])).rows;
    for (const row of wm) assert.ok(Dec.of(row.reserved_qty).eq(row.res), 'work order material reserved == Σ active reservations');
  } finally { await owner.end(); }
});

test('database constraints are the last line of defence against over-reservation', async () => {
  const [roll] = await receiveAndAccept(h, h.a, [{ qty: '10', shade: 'E', lot: 'DB' }]);
  const c = await h.appConn();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [h.a.orgId]);
    const r = (await c.query('SELECT * FROM fabric_roll WHERE id = $1', [roll.id])).rows[0];
    const f = (await c.query('SELECT factory_id FROM warehouse WHERE id = $1', [r.warehouse_id])).rows[0];
    await assert.rejects(c.query(`INSERT INTO inventory_movement (organization_id, factory_id, movement_type, material_id, roll_id, lot_id, warehouse_id, stock_status, reserved_delta, unit, source_type, source_id, actor_user_id)
      VALUES ($1,$2,'RESERVE',$3,$4,$5,$6,'ACCEPTED','10.0001','M','test',$4,$7)`, [h.a.orgId, f.factory_id, r.material_id, r.id, r.lot_id, r.warehouse_id, h.a.users.admin.id]),
      (e: any) => e.code === '23514' && /reserved_qty|check/.test(e.message + e.constraint));
    await c.query('ROLLBACK');
  } finally { await c.end(); }
});

test('document numbers stay unique under concurrent creation', async () => {
  const { model } = await approvedModel(h, h.a, 'NUM-1');
  const plan = await h.login('A', 'planlama');
  const res = await Promise.all(Array.from({ length: 10 }, () => plan.post('/api/v1/orders', orderBody(model.id))));
  const nos = res.map((r) => { assert.equal(r.status, 201); return r.body.orderNo; });
  assert.equal(new Set(nos).size, 10);
});
