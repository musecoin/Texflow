import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Dec } from '@texflow/shared';
import { setup, expectStatus, type Harness } from './helpers.ts';

let h: Harness;
before(async () => { h = await setup(); });
after(async () => { await h?.close(); });

test('vertical slice: order → model/BOM → roll receipt & inspection → work order → reservation → ledger & order status', async () => {
  const { a } = h;
  const teknik = await h.login('A', 'teknik');
  const mudur = await h.login('A', 'teknikmudur');
  const plan = await h.login('A', 'planlama');
  const depo = await h.login('A', 'depo');
  const kalite = await h.login('A', 'kalite');

  // 1. model with variants, technical approval
  const model = expectStatus(await teknik.post('/api/v1/models', { code: 'TS-2001', name: 'Oversize T-Shirt', customerId: a.customerId, season: 'SS27',
    colorIds: [a.colors.SYH, a.colors.BYZ], sizeIds: [a.sizes.S, a.sizes.M, a.sizes.L] }), 201);
  assert.equal(model.variants.length, 6);
  assert.equal(model.status, 'DRAFT');
  const submitted = expectStatus(await teknik.post(`/api/v1/models/${model.id}/submit`, { expectedVersion: model.rowVersion }), 200);
  const approvedModel = expectStatus(await mudur.post(`/api/v1/models/${model.id}/approve`, { expectedVersion: submitted.rowVersion }), 200);
  assert.equal(approvedModel.status, 'TECH_APPROVED');

  // 2. BOM: jersey in meters, rib in kg; approval by a different person (segregation of duties)
  const bom = expectStatus(await teknik.post(`/api/v1/models/${model.id}/boms`, { items: [
    { materialId: a.materials.jersey, placement: 'Gövde', consumptionPerPiece: '0.95', unit: 'M', wastePct: '4' },
    { materialId: a.materials.rib, placement: 'Yaka', consumptionPerPiece: '12', unit: 'G', wastePct: '3' },
  ] }), 201);
  assert.equal(bom.version, 1);
  const selfApprove = await teknik.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: bom.rowVersion });
  expectStatus(selfApprove, 403, 'FORBIDDEN'); // technologist lacks bom.approve
  const bomOk = expectStatus(await mudur.post(`/api/v1/boms/${bom.id}/approve`, { expectedVersion: bom.rowVersion }), 200);
  assert.equal(bomOk.status, 'APPROVED');

  // 3. customer order, confirmed
  const order = expectStatus(await plan.post('/api/v1/orders', { factoryId: a.factoryId, customerId: a.customerId, customerPo: 'NORD-PO-4471', currency: 'EUR',
    orderDate: '2026-11-02', dueDate: '2027-01-20', lines: [
      { modelId: model.id, colorId: a.colors.SYH, sizeId: a.sizes.S, quantity: '300', unitPrice: '5.10' },
      { modelId: model.id, colorId: a.colors.SYH, sizeId: a.sizes.M, quantity: '500', unitPrice: '5.10' },
      { modelId: model.id, colorId: a.colors.SYH, sizeId: a.sizes.L, quantity: '200', unitPrice: '5.10' },
    ] }), 201);
  assert.match(order.orderNo, /^SIP26-\d{5}$/);
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.summary.totalQty, '1000');
  assert.equal(order.summary.totalAmount, '5100.00');
  const confirmed = expectStatus(await plan.post(`/api/v1/orders/${order.id}/confirm`, { expectedVersion: order.rowVersion }), 200);
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.summary.stage, 'AWAITING_WORK_ORDER');
  assert.equal(confirmed.revisions.length, 2);

  // 4. receive 3 jersey rolls into quarantine (one in a different shade), and one rib roll entered in kg
  const gr = expectStatus(await depo.post('/api/v1/receipts', { factoryId: a.factoryId, supplierId: a.supplierId, warehouseId: a.fabricWarehouseId, supplierDeliveryNote: 'IRS-55821',
    rolls: [
      { materialId: a.materials.jersey, lotNo: 'LOT-A', shade: 'A', colorId: a.colors.SYH, widthCm: '180', gsm: '180', grossWeightKg: '26.4', netWeightKg: '25.6', lengthM: '520', quantity: '520', unit: 'M' },
      { materialId: a.materials.jersey, lotNo: 'LOT-A', shade: 'A', colorId: a.colors.SYH, widthCm: '180', gsm: '180', quantity: '560', unit: 'M' },
      { materialId: a.materials.jersey, lotNo: 'LOT-B', shade: 'B', colorId: a.colors.SYH, widthCm: '180', gsm: '180', quantity: '600', unit: 'M' },
      { materialId: a.materials.rib, lotNo: 'RIB-1', shade: 'A', colorId: a.colors.SYH, quantity: '25', unit: 'KG' },
    ] }), 201);
  assert.match(gr.receiptNo, /^MK-\d{5}$/);
  assert.equal(gr.rolls.length, 4);
  for (const r of gr.rolls) assert.match(r.qrCode, /^TFROLL:[0-9a-f-]{36}$/);
  const [r1, r2, r3, rib] = gr.rolls;

  let summary = expectStatus(await depo.get('/api/v1/inventory/summary'), 200);
  const jerseySum = () => summary.items.find((i: any) => i.materialId === a.materials.jersey);
  assert.equal(jerseySum().quarantineQty, '1680.0000');
  assert.equal(jerseySum().availableQty, '0');

  // 5. 4-point inspection: r1 and r3 pass, r2 fails on points (holes) → rejected stock
  const inspect = async (id: string, defects: unknown[], extra: Record<string, string> = {}) => {
    const roll = expectStatus(await kalite.get(`/api/v1/rolls/${id}`), 200);
    return kalite.post(`/api/v1/rolls/${id}/inspections`, { inspectedLengthM: roll.physicalQty, cuttableWidthCm: '176', measuredGsm: '181', measuredWidthCm: '179', shadeResult: 'MATCH', defects, expectedVersion: roll.rowVersion, ...extra });
  };
  const i1 = expectStatus(await inspect(r1.id, [{ code: 'NOPE', lengthIn: '2', positionM: '10' }, { code: 'YAG', lengthIn: '7', positionM: '120' }]), 201);
  assert.equal(i1.inspection.result, 'PASS');
  assert.equal(i1.inspection.totalPoints, 4);
  assert.equal(i1.roll.qualityStatus, 'ACCEPTED');
  const holes = Array.from({ length: 100 }, (_, i) => ({ code: 'DELIK', isHole: true, positionM: String(i * 5) }));
  const i2 = expectStatus(await inspect(r2.id, holes), 201);
  assert.equal(i2.inspection.result, 'FAIL');
  assert.deepEqual(i2.inspection.failedChecks, ['POINTS']);
  assert.equal(i2.roll.qualityStatus, 'REJECTED');
  expectStatus(await inspect(r3.id, []), 201);
  expectStatus(await inspect(rib.id, [], { inspectedLengthM: '40', cuttableWidthCm: '98', measuredWidthCm: undefined as unknown as string, measuredGsm: undefined as unknown as string }), 201);

  summary = expectStatus(await depo.get('/api/v1/inventory/summary'), 200);
  assert.equal(jerseySum().quarantineQty, '0');
  assert.equal(jerseySum().acceptedQty, '1120.0000');
  assert.equal(jerseySum().rejectedQty, '560.0000');

  // 6. work order for 800 black pcs; release snapshots the approved BOM and computes requirements
  const wo = expectStatus(await plan.post('/api/v1/work-orders', { salesOrderId: order.id, modelId: model.id, colorId: a.colors.SYH, plannedQty: '800' }), 201);
  assert.equal(wo.status, 'PLANNED');
  const released = expectStatus(await plan.post(`/api/v1/work-orders/${wo.id}/release`, { expectedVersion: wo.rowVersion }), 200);
  assert.equal(released.status, 'RELEASED');
  assert.equal(released.bomVersion, 1);
  assert.equal(released.bomSnapshot.items.length, 2);
  const jerseyReq = released.materials.find((m: any) => m.materialId === a.materials.jersey);
  const ribReq = released.materials.find((m: any) => m.materialId === a.materials.rib);
  assert.equal(jerseyReq.requiredQty, '790.4000');  // 800 × 0.95 × 1.04
  assert.equal(jerseyReq.unit, 'M');
  assert.equal(ribReq.requiredQty, '9.8880');       // 800 × 12 g × 1.03 = 9888 g → kg
  assert.equal(ribReq.unit, 'KG');
  const orderAfterRelease = expectStatus(await plan.get(`/api/v1/orders/${order.id}`), 200);
  assert.equal(orderAfterRelease.status, 'IN_PRODUCTION');
  assert.equal(orderAfterRelease.summary.stage, 'AWAITING_MATERIAL');

  // 7. reservation: FIFO, single-shade. r1 (shade A, 520m) is first; r3 (shade B) must NOT be mixed in.
  const res1 = expectStatus(await plan.post(`/api/v1/work-orders/${wo.id}/materials/${jerseyReq.id}/reserve`, { policy: 'FIFO', allowPartial: true, singleShade: true }), 201);
  assert.deepEqual(res1.reservations.map((x: any) => [x.rollNo, x.qty, x.shade]), [[r1.rollNo, '520', 'A']]);
  assert.equal(res1.shortfallQty, '270.4');
  assert.equal(res1.shadeLock, 'A');
  // explicit scan of the shade-B roll is refused while the material line is locked to shade A
  const mixed = await plan.post(`/api/v1/work-orders/${wo.id}/materials/${jerseyReq.id}/reserve`, { rollId: r3.id, singleShade: true });
  expectStatus(mixed, 409, 'PRECONDITION_FAILED');
  // the rejected roll can never be reserved
  expectStatus(await plan.post(`/api/v1/work-orders/${wo.id}/materials/${jerseyReq.id}/reserve`, { rollId: r2.id, singleShade: false }), 409, 'STOCK_NOT_RELEASED');
  // rib reserved fully from the kg roll
  const res2 = expectStatus(await plan.post(`/api/v1/work-orders/${wo.id}/materials/${ribReq.id}/reserve`, {}), 201);
  assert.equal(res2.shortfallQty, '0');

  // 8. ledger: every movement references its source document; balances reconcile with the ledger
  const ledger = expectStatus(await depo.get(`/api/v1/inventory/ledger?materialId=${a.materials.jersey}&limit=500`), 200);
  const types = ledger.items.map((m: any) => m.movementType).sort();
  assert.deepEqual(types, ['QC_REJECT', 'QC_REJECT', 'QC_RELEASE', 'QC_RELEASE', 'QC_RELEASE', 'QC_RELEASE', 'RECEIPT', 'RECEIPT', 'RECEIPT', 'RESERVE']);
  for (const m of ledger.items) { assert.ok(m.sourceType && m.sourceId, 'movement has a source'); assert.ok(m.actorName); }
  const reserveMv = ledger.items.find((m: any) => m.movementType === 'RESERVE');
  assert.equal(reserveMv.sourceRef, wo.woNo);
  assert.equal(reserveMv.reservedDelta, '520.0000');

  const owner = await h.owner();
  try {
    const recon = await owner.query(`SELECT r.roll_no, r.physical_qty, r.reserved_qty, coalesce(sum(m.qty_delta),0) AS ledger_physical, coalesce(sum(m.reserved_delta),0) AS ledger_reserved,
        coalesce(sum(m.qty_delta) FILTER (WHERE m.stock_status = r.quality_status), 0) AS ledger_in_status
      FROM fabric_roll r LEFT JOIN inventory_movement m ON m.roll_id = r.id WHERE r.organization_id = $1 GROUP BY r.id`, [a.orgId]);
    assert.equal(recon.rowCount, 4);
    for (const row of recon.rows) {
      assert.ok(Dec.of(row.physical_qty).eq(row.ledger_physical), `physical == Σ ledger for ${row.roll_no}`);
      assert.ok(Dec.of(row.reserved_qty).eq(row.ledger_reserved), `reserved == Σ ledger for ${row.roll_no}`);
      assert.ok(Dec.of(row.ledger_in_status).eq(row.physical_qty), `all stock sits in the roll's current status bucket for ${row.roll_no}`);
    }
  } finally { await owner.end(); }

  // 9. order status view reflects coverage; audit timeline captured every command
  const status = expectStatus(await plan.get(`/api/v1/orders/${order.id}`), 200);
  assert.equal(status.workOrders.length, 1);
  assert.equal(status.workOrders[0].coveragePct, '82.9'); // mean(520/790.4, 1) = (65.8% + 100%) / 2
  assert.equal(status.workOrders[0].coveredLines, 1);
  assert.equal(status.summary.plannedQty, '800');
  assert.equal(status.summary.unplannedQty, '200');
  const admin = await h.login('A', 'admin');
  const audit = expectStatus(await admin.get('/api/v1/audit?limit=200'), 200);
  const actions = new Set(audit.items.map((x: any) => x.action));
  for (const act of ['model.create', 'model.approve', 'bom.create', 'bom.approve', 'order.create', 'order.confirm', 'inventory.receive', 'inventory.inspect',
    'workorder.create', 'workorder.release', 'order.start_production', 'reservation.create']) assert.ok(actions.has(act), `audit has ${act}`);

  // 10. roll detail by QR shows the full transaction history
  const byQr = expectStatus(await depo.get(`/api/v1/rolls/by-qr/${encodeURIComponent(r1.qrCode)}`), 200);
  assert.deepEqual(byQr.movements.map((m: any) => m.movementType), ['RECEIPT', 'QC_RELEASE', 'QC_RELEASE', 'RESERVE']);
  assert.equal(byQr.availableQty, '0.0000');
  assert.equal(byQr.reservations[0].woNo, wo.woNo);
});

test('kg↔m receipt conversion requires explicit GSM/width approval and records its basis', async () => {
  const { a } = h;
  const depo = await h.login('A', 'depo');
  const base = { factoryId: a.factoryId, supplierId: a.supplierId, warehouseId: a.fabricWarehouseId };
  const roll = { materialId: a.materials.jersey, lotNo: 'LOT-KG', shade: 'A', quantity: '25', unit: 'KG' };
  expectStatus(await depo.post('/api/v1/receipts', { ...base, rolls: [roll] }), 422, 'UNIT_CONVERSION_NOT_ALLOWED');
  const ok = expectStatus(await depo.post('/api/v1/receipts', { ...base, rolls: [{ ...roll, allowGsmWidthEstimate: true, gsm: '180', widthCm: '180' }] }), 201);
  assert.equal(ok.rolls[0].quantity, '77.1605');
  assert.equal(ok.rolls[0].quantityBasis.method, 'GSM_WIDTH');
});
