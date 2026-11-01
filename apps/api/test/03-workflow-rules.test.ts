import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, expectStatus, approvedModel, confirmedOrder, receiveAndAccept, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h?.close(); });

test('sales order state machine rejects invalid transitions and stale versions', async () => {
  const { model } = await approvedModel(h, h.a, 'SM-1');
  const plan = await h.login('A', 'planlama');
  const o = await confirmedOrder(h, h.a, model.id);
  const again = expectStatus(await plan.post(`/api/v1/orders/${o.id}/confirm`, { expectedVersion: o.rowVersion }), 409, 'INVALID_TRANSITION');
  assert.equal(again.error.details.from, 'CONFIRMED');
  // a stale expectedVersion is a conflict, never a silent overwrite
  const draft = expectStatus(await plan.post('/api/v1/orders', { factoryId: h.a.factoryId, customerId: h.a.customerId, currency: 'EUR', orderDate: '2026-11-02', dueDate: '2026-12-01',
    lines: [{ modelId: model.id, colorId: h.a.colors.SYH, sizeId: h.a.sizes.M, quantity: '10', unitPrice: '1' }] }), 201);
  expectStatus(await plan.post(`/api/v1/orders/${draft.id}/confirm`, { expectedVersion: draft.rowVersion + 5 }), 409, 'VERSION_CONFLICT');
  expectStatus(await plan.post(`/api/v1/orders/${draft.id}/cancel`, { expectedVersion: draft.rowVersion }), 200);
  expectStatus(await plan.post(`/api/v1/orders/${draft.id}/confirm`, { expectedVersion: draft.rowVersion + 1 }), 409, 'INVALID_TRANSITION');
});

test('order lines must reference defined variants; due date cannot precede order date', async () => {
  const { model } = await approvedModel(h, h.a, 'SM-2');
  const plan = await h.login('A', 'planlama');
  const base = { factoryId: h.a.factoryId, customerId: h.a.customerId, currency: 'EUR', orderDate: '2026-11-02', dueDate: '2026-12-01' };
  expectStatus(await plan.post('/api/v1/orders', { ...base, lines: [{ modelId: model.id, colorId: h.a.colors.BYZ, sizeId: h.a.sizes.M, quantity: '10', unitPrice: '1' }] }), 400, 'VALIDATION_FAILED');
  expectStatus(await plan.post('/api/v1/orders', { ...base, dueDate: '2026-10-01', lines: [{ modelId: model.id, colorId: h.a.colors.SYH, sizeId: h.a.sizes.M, quantity: '10', unitPrice: '1' }] }), 400, 'VALIDATION_FAILED');
});

test('model / BOM approval workflow preconditions', async () => {
  const teknik = await h.login('A', 'teknik');
  const mudur = await h.login('A', 'teknikmudur');
  const m = expectStatus(await teknik.post('/api/v1/models', { code: 'WF-1', name: 'WF', colorIds: [h.a.colors.SYH], sizeIds: [h.a.sizes.M] }), 201);
  // cannot approve a DRAFT model directly
  expectStatus(await mudur.post(`/api/v1/models/${m.id}/approve`, { expectedVersion: m.rowVersion }), 409, 'INVALID_TRANSITION');
  const bom = expectStatus(await teknik.post(`/api/v1/models/${m.id}/boms`, { items: [{ materialId: h.a.materials.jersey, consumptionPerPiece: '1.1', unit: 'M' }] }), 201);
  // BOM approval requires technical approval of the model first
  expectStatus(await mudur.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: bom.rowVersion }), 409, 'PRECONDITION_FAILED');
  // unit dimension mismatch (kg for a meter-based fabric) is refused at BOM creation
  expectStatus(await teknik.post(`/api/v1/models/${m.id}/boms`, { items: [{ materialId: h.a.materials.jersey, consumptionPerPiece: '0.2', unit: 'KG' }] }), 422, 'UNIT_CONVERSION_NOT_ALLOWED');
  const s = expectStatus(await teknik.post(`/api/v1/models/${m.id}/submit`, { expectedVersion: m.rowVersion }), 200);
  expectStatus(await mudur.post(`/api/v1/models/${m.id}/approve`, { expectedVersion: s.rowVersion }), 200);
  const b1 = expectStatus(await mudur.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: bom.rowVersion }), 200);
  expectStatus(await mudur.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: b1.rowVersion }), 409, 'INVALID_TRANSITION');
  // approving v2 obsoletes v1 (exactly one approved version)
  const bom2 = expectStatus(await teknik.post(`/api/v1/models/${m.id}/boms`, { items: [{ materialId: h.a.materials.jersey, consumptionPerPiece: '1.05', unit: 'M' }] }), 201);
  assert.equal(bom2.version, 2);
  expectStatus(await mudur.post(`/api/v1/boms/${bom2.id}/approve`, { expectedVersion: bom2.rowVersion }), 200);
  const view = expectStatus(await teknik.get(`/api/v1/models/${m.id}`), 200);
  assert.deepEqual(view.boms.map((b: any) => [b.version, b.status]), [[2, 'APPROVED'], [1, 'OBSOLETE']]);
});

test('work order rules: no release without approved BOM; planned qty cannot exceed order; BOM snapshot is frozen at release', async () => {
  const teknik = await h.login('A', 'teknik');
  const mudur = await h.login('A', 'teknikmudur');
  const plan = await h.login('A', 'planlama');
  const m = expectStatus(await teknik.post('/api/v1/models', { code: 'WO-1', name: 'WO', colorIds: [h.a.colors.SYH], sizeIds: [h.a.sizes.M] }), 201);
  const s = expectStatus(await teknik.post(`/api/v1/models/${m.id}/submit`, { expectedVersion: m.rowVersion }), 200);
  expectStatus(await mudur.post(`/api/v1/models/${m.id}/approve`, { expectedVersion: s.rowVersion }), 200);
  const o = expectStatus(await plan.post('/api/v1/orders', { factoryId: h.a.factoryId, customerId: h.a.customerId, currency: 'EUR', orderDate: '2026-11-02', dueDate: '2026-12-01',
    lines: [{ modelId: m.id, colorId: h.a.colors.SYH, sizeId: h.a.sizes.M, quantity: '100', unitPrice: '3' }] }), 201);
  // WO on a DRAFT order is refused
  expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: o.id, modelId: m.id, colorId: h.a.colors.SYH, plannedQty: '100' }), 409, 'PRECONDITION_FAILED');
  expectStatus(await plan.post(`/api/v1/orders/${o.id}/confirm`, { expectedVersion: o.rowVersion }), 200);
  expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: o.id, modelId: m.id, colorId: h.a.colors.SYH, plannedQty: '101' }), 400, 'VALIDATION_FAILED');
  const w1 = expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: o.id, modelId: m.id, colorId: h.a.colors.SYH, plannedQty: '60' }), 201);
  const tooMuch = expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: o.id, modelId: m.id, colorId: h.a.colors.SYH, plannedQty: '41' }), 400, 'VALIDATION_FAILED');
  assert.equal(tooMuch.error.details.remaining, '40');
  expectStatus(await plan.post(`/api/v1/work-orders/${w1.id}/release`, { expectedVersion: w1.rowVersion }), 409, 'PRECONDITION_FAILED');
  // reservation before release is an invalid transition
  expectStatus(await plan.post(`/api/v1/work-orders/${w1.id}/materials/${crypto.randomUUID()}/reserve`, {}), 409, 'INVALID_TRANSITION');

  const bom = expectStatus(await teknik.post(`/api/v1/models/${m.id}/boms`, { items: [{ materialId: h.a.materials.jersey, consumptionPerPiece: '1', unit: 'M', wastePct: '5' }] }), 201);
  expectStatus(await mudur.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: bom.rowVersion }), 200);
  const rel = expectStatus(await plan.post(`/api/v1/work-orders/${w1.id}/release`, { expectedVersion: w1.rowVersion }), 200);
  assert.equal(rel.materials[0].requiredQty, '63.0000');
  expectStatus(await plan.post(`/api/v1/work-orders/${w1.id}/release`, { expectedVersion: rel.rowVersion }), 409, 'INVALID_TRANSITION');
  // a later BOM revision does not change the released work order
  const bom2 = expectStatus(await teknik.post(`/api/v1/models/${m.id}/boms`, { items: [{ materialId: h.a.materials.jersey, consumptionPerPiece: '2', unit: 'M' }] }), 201);
  expectStatus(await mudur.post(`/api/v1/boms/${bom2.id}/approve`, { expectedVersion: bom2.rowVersion }), 200);
  const after = expectStatus(await plan.get(`/api/v1/work-orders/${w1.id}`), 200);
  assert.equal(after.bomVersion, 1);
  assert.equal(after.bomSnapshot.items[0].consumptionPerPiece, '1.000000');
  assert.equal(after.materials[0].requiredQty, '63.0000');
});

test('quality gate: quarantined rolls cannot be reserved; an inspected roll cannot be re-inspected', async () => {
  const { model } = await approvedModel(h, h.a, 'QG-1');
  const plan = await h.login('A', 'planlama');
  const kalite = await h.login('A', 'kalite');
  const o = await confirmedOrder(h, h.a, model.id, '100', '50');
  const w = expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: o.id, modelId: model.id, colorId: h.a.colors.SYH, plannedQty: '100' }), 201);
  const rel = expectStatus(await plan.post(`/api/v1/work-orders/${w.id}/release`, { expectedVersion: w.rowVersion }), 200);
  const jersey = rel.materials.find((m: any) => m.materialId === h.a.materials.jersey);
  const [q] = await receiveAndAccept(h, h.a, [{ qty: '200', shade: 'Q', lot: 'QG' }], { accept: false });
  expectStatus(await plan.post(`/api/v1/work-orders/${w.id}/materials/${jersey.id}/reserve`, { rollId: q.id }), 409, 'STOCK_NOT_RELEASED');
  const auto = expectStatus(await plan.post(`/api/v1/work-orders/${w.id}/materials/${jersey.id}/reserve`, {}), 409, 'INSUFFICIENT_STOCK');
  assert.equal(auto.error.details.quarantineQty, '200.0000');
  const roll = expectStatus(await kalite.get(`/api/v1/rolls/${q.id}`), 200);
  // missing inspection plan is not silently treated as a pass: verify plan presence is enforced by inspecting with stale version first
  expectStatus(await kalite.post(`/api/v1/rolls/${q.id}/inspections`, { inspectedLengthM: '200', cuttableWidthCm: '176', defects: [], expectedVersion: roll.rowVersion + 1 }), 409, 'VERSION_CONFLICT');
  const ok = expectStatus(await kalite.post(`/api/v1/rolls/${q.id}/inspections`, { inspectedLengthM: '200', cuttableWidthCm: '176', defects: [], expectedVersion: roll.rowVersion }), 201);
  expectStatus(await kalite.post(`/api/v1/rolls/${q.id}/inspections`, { inspectedLengthM: '200', cuttableWidthCm: '176', defects: [], expectedVersion: ok.roll.rowVersion }), 409, 'INVALID_TRANSITION');
  // over-reservation of a single roll beyond the remaining requirement is refused
  expectStatus(await plan.post(`/api/v1/work-orders/${w.id}/materials/${jersey.id}/reserve`, { rollId: q.id, qty: '150' }), 400, 'VALIDATION_FAILED');
  const res = expectStatus(await plan.post(`/api/v1/work-orders/${w.id}/materials/${jersey.id}/reserve`, { rollId: q.id }), 201);
  assert.equal(res.reservedQty, '98.8');
  expectStatus(await plan.post(`/api/v1/work-orders/${w.id}/materials/${jersey.id}/reserve`, {}), 409, 'PRECONDITION_FAILED');
  // release returns stock to available and is recorded in the ledger
  const rid = res.reservations[0].id;
  expectStatus(await plan.post(`/api/v1/reservations/${rid}/release`, { reason: 'Plan değişikliği' }), 200);
  expectStatus(await plan.post(`/api/v1/reservations/${rid}/release`, { reason: 'tekrar' }), 409, 'INVALID_TRANSITION');
  const r = expectStatus(await plan.get(`/api/v1/rolls/${q.id}`), 200);
  assert.equal(r.reservedQty, '0.0000');
  assert.deepEqual(r.movements.map((m: any) => m.movementType), ['RECEIPT', 'QC_RELEASE', 'QC_RELEASE', 'RESERVE', 'UNRESERVE']);
});

test('inspection without a configured plan is refused (no universal threshold is assumed)', async () => {
  const admin = await h.login('A', 'admin');
  const mat = expectStatus(await admin.post('/api/v1/materials', { code: 'KUM-NOPLAN', name: 'Plansız kumaş', kind: 'FABRIC', baseUnit: 'M', widthCm: '160', gsm: '200' }), 201);
  const depo = await h.login('A', 'depo');
  const gr = expectStatus(await depo.post('/api/v1/receipts', { factoryId: h.a.factoryId, supplierId: h.a.supplierId, warehouseId: h.a.fabricWarehouseId,
    rolls: [{ materialId: mat.id, lotNo: 'NP', shade: 'A', quantity: '80', unit: 'M' }] }), 201);
  const kalite = await h.login('A', 'kalite');
  const roll = expectStatus(await kalite.get(`/api/v1/rolls/${gr.rolls[0].id}`), 200);
  expectStatus(await kalite.post(`/api/v1/rolls/${roll.id}/inspections`, { inspectedLengthM: '80', cuttableWidthCm: '158', defects: [], expectedVersion: roll.rowVersion }), 409, 'PRECONDITION_FAILED');
});
