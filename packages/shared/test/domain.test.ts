import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Dec, kgToMeters, toBaseUnit, convertSameDimension, UnitConversionError, defectPoints, scoreFourPoint, evaluateInspection,
  materialRequirement, allocateFifo, findTransition, SALES_ORDER_TRANSITIONS, WORK_ORDER_TRANSITIONS, allowedActions,
  CreateSalesOrderReq, ReceiveRollsReq,
} from '../src/index.ts';

test('Dec: exact decimal arithmetic (no float drift)', () => {
  assert.equal(Dec.of('0.1').add('0.2').toString(), '0.3');
  assert.equal(Dec.of('1250.5').mul('1.035').toFixed(4), '1294.2675');
  assert.equal(Dec.of('10').div('3').toFixed(4), '3.3333');
  assert.equal(Dec.of('2').div('3').toFixed(4), '0.6667');
  assert.equal(Dec.of('-2.5').round(0).toString(), '-3');
  assert.equal(Dec.of('1.00001').ceil(4).toString(), '1.0001');
  assert.throws(() => Dec.of(0.1), TypeError, 'floats are rejected');
  assert.throws(() => Dec.of('1e5'), TypeError);
  assert.throws(() => Dec.of('1').div('0'), RangeError);
});

test('units: same-dimension conversions are exact; kg↔m never implicit', () => {
  assert.equal(convertSameDimension(Dec.of('100'), 'YD', 'M').toFixed(4), '91.4400');
  assert.throws(() => convertSameDimension(Dec.of('1'), 'KG', 'M'), UnitConversionError);
  assert.throws(() => toBaseUnit(Dec.of('25'), 'KG', 'M'), (e: any) => e.code === 'UNIT_CONVERSION_NOT_ALLOWED');
  assert.throws(() => toBaseUnit(Dec.of('25'), 'KG', 'M', { allowGsmWidthEstimate: true, geometry: { gsm: '180' } }), (e: any) => e.code === 'FABRIC_GEOMETRY_REQUIRED');
  // 25 kg of 180 gsm, 180 cm wide jersey: 25000 / (180*1.8) = 77.1605 m
  const r = toBaseUnit(Dec.of('25'), 'KG', 'M', { allowGsmWidthEstimate: true, geometry: { gsm: '180', widthCm: '180' } });
  assert.equal(r.qty.toFixed(4), '77.1605');
  assert.equal(r.basis.method, 'GSM_WIDTH');
  assert.equal(kgToMeters(Dec.of('1'), { gsm: '200', widthCm: '100' }).meters.toFixed(2), '5.00');
});

test('4-point: point bands, holes, per-yard cap and normalisation', () => {
  assert.equal(defectPoints({ code: 'A', lengthIn: '3' }), 1);
  assert.equal(defectPoints({ code: 'A', lengthIn: '3.01' }), 2);
  assert.equal(defectPoints({ code: 'A', lengthIn: '9' }), 3);
  assert.equal(defectPoints({ code: 'A', lengthIn: '12' }), 4);
  assert.equal(defectPoints({ code: 'H', isHole: true }), 4);
  assert.throws(() => defectPoints({ code: 'A' }), RangeError);
  // 100 yd × 60 in, 20 points → 20*3600/(100*60) = 12
  const s = scoreFourPoint({ inspectedLengthM: '91.44', cuttableWidthCm: '152.4', defects: Array.from({ length: 5 }, (_, i) => ({ code: 'X', isHole: true, positionM: String(i * 2) })) });
  assert.equal(s.totalPoints, 20);
  assert.equal(s.pointsPer100SqYd.toFixed(2), '12.00');
  // two holes within the same yard are capped at 4
  const capped = scoreFourPoint({ inspectedLengthM: '91.44', cuttableWidthCm: '152.4', defects: [{ code: 'H', isHole: true, positionM: '0.1' }, { code: 'H', isHole: true, positionM: '0.5' }] });
  assert.equal(capped.totalPoints, 4);
});

test('inspection acceptance uses the configured plan, not a universal limit', () => {
  const plan = { maxPointsPer100SqYd: '20', maxWidthDeviationPct: '2', maxGsmDeviationPct: '5', maxShrinkagePct: '5' };
  assert.equal(evaluateInspection({ plan, pointsPer100SqYd: Dec.of('19.9') }).result, 'PASS');
  const f = evaluateInspection({ plan, pointsPer100SqYd: Dec.of('25'), nominalGsm: '180', measuredGsm: '160', shrinkageLengthPct: '-6', shadeResult: 'REJECT' });
  assert.equal(f.result, 'FAIL');
  assert.deepEqual(f.failedChecks, ['POINTS', 'GSM', 'SHRINKAGE_LENGTH', 'SHADE']);
  assert.equal(evaluateInspection({ plan: { maxPointsPer100SqYd: '40' }, pointsPer100SqYd: Dec.of('25') }).result, 'PASS');
});

test('material requirement rounds up and applies waste', () => {
  assert.equal(materialRequirement('1000', '1.25', '3').toString(), '1287.5');
  assert.equal(materialRequirement('3', '0.333333', '0').toString(), '1'); // 0.999999 → 1.0000 (ceil 4dp)
});

test('FIFO allocation respects single-shade restriction and reports shortfall', () => {
  const rolls = [
    { id: 'r3', lotId: 'L1', shade: 'B', colorId: 'c', receivedAt: '2026-01-03', available: '50' },
    { id: 'r1', lotId: 'L1', shade: 'A', colorId: 'c', receivedAt: '2026-01-01', available: '40' },
    { id: 'r2', lotId: 'L2', shade: 'A', colorId: 'c', receivedAt: '2026-01-02', available: '30' },
    { id: 'r4', lotId: 'L3', shade: 'A', colorId: 'other', receivedAt: '2026-01-00', available: '99' },
  ];
  const a = allocateFifo({ rolls, needed: Dec.of('100'), colorId: 'c' });
  assert.deepEqual(a.lines.map((l) => [l.rollId, l.qty.toString()]), [['r1', '40'], ['r2', '30']]);
  assert.equal(a.shortfall.toString(), '30');
  assert.equal(a.shade, 'A');
  const b = allocateFifo({ rolls, needed: Dec.of('100'), colorId: 'c', singleShade: false });
  assert.equal(b.shortfall.toString(), '0');
  const c = allocateFifo({ rolls, needed: Dec.of('10'), colorId: 'c', shadeLock: 'B' });
  assert.deepEqual(c.lines.map((l) => l.rollId), ['r3']);
});

test('state machines reject invalid transitions', () => {
  assert.equal(findTransition(SALES_ORDER_TRANSITIONS, 'order', 'DRAFT', 'confirm').to, 'CONFIRMED');
  assert.throws(() => findTransition(SALES_ORDER_TRANSITIONS, 'order', 'CANCELLED', 'confirm'), (e: any) => e.code === 'INVALID_TRANSITION');
  assert.throws(() => findTransition(WORK_ORDER_TRANSITIONS, 'wo', 'RELEASED', 'release'), (e: any) => e.code === 'INVALID_TRANSITION');
  assert.deepEqual(allowedActions(SALES_ORDER_TRANSITIONS, 'CONFIRMED'), ['cancel']);
});

test('schemas: reject float numbers, bad dates and negative quantities', () => {
  const base = { factoryId: crypto.randomUUID(), customerId: crypto.randomUUID(), currency: 'USD', orderDate: '2026-11-01', dueDate: '2026-12-01',
    lines: [{ modelId: crypto.randomUUID(), colorId: crypto.randomUUID(), sizeId: crypto.randomUUID(), quantity: '100', unitPrice: '4.25' }] };
  assert.equal(CreateSalesOrderReq.safeParse(base).success, true);
  assert.equal(CreateSalesOrderReq.safeParse({ ...base, dueDate: '2026-10-01' }).success, false);
  assert.equal(CreateSalesOrderReq.safeParse({ ...base, lines: [{ ...base.lines[0], quantity: 100 }] }).success, false);
  assert.equal(CreateSalesOrderReq.safeParse({ ...base, lines: [{ ...base.lines[0], quantity: '10.5' }] }).success, false);
  assert.equal(ReceiveRollsReq.safeParse({ factoryId: base.factoryId, supplierId: base.factoryId, warehouseId: base.factoryId,
    rolls: [{ materialId: base.factoryId, lotNo: 'L', shade: 'A', quantity: '-1', unit: 'M' }] }).success, false);
});

// ---------------------------------------------------------------- order sheet import (deterministic part)
import { OrderSheetExtraction, buildDraft, checkExtraction, matchColor, matchSize, normSize } from '../src/orderSheet.ts';

test('order sheet: draft splits by written size ratio in whole sets, reports remainders, merges duplicate colours', () => {
  const x = OrderSheetExtraction.parse({
    sizes: [{ size: 'L', ratio: 1 }, { size: 'XL', ratio: 1 }, { size: 'XXL', ratio: 1 }, { size: 'XXXL', ratio: 1 }],
    sections: [
      { title: 'ADET', kind: 'cut', printedTotal: 1496, lines: [{ color: 'siyah', size: null, quantity: 240 }, { color: 'laci', size: null, quantity: 624 }, { color: 'Siyah', size: null, quantity: 632 }] },
      { title: 'İSTENEN', kind: 'requested', printedTotal: 1400, lines: [{ color: 'SİYAH', size: null, quantity: 810 }, { color: 'LACİ', size: null, quantity: 610 }] },
    ],
  });
  const req = buildDraft(x, 1);
  assert.deepEqual(req.sizes, ['L', 'XL', 'XXL', '3XL']);
  assert.deepEqual(req.cells.filter((c) => c.color === 'SİYAH').map((c) => c.qty), [202, 202, 202, 202]);
  assert.deepEqual(req.unassigned, [{ color: 'SİYAH', qty: 2 }, { color: 'LACİ', qty: 2 }]);
  const total = req.cells.reduce((a, c) => a + c.qty, 0) + req.unassigned.reduce((a, c) => a + c.qty, 0);
  assert.equal(total, 1420, 'nothing lost, nothing invented');
  const cut = buildDraft(x, 0);
  assert.deepEqual(cut.colors, ['siyah', 'laci']);
  assert.deepEqual(cut.cells.filter((c) => c.color === 'siyah').map((c) => c.qty), [218, 218, 218, 218]);
  assert.deepEqual(cut.unassigned, []);
  const codes = checkExtraction(x).map((c) => c.code);
  assert.ok(codes.includes('TOTAL_MISMATCH'), '1420 ≠ printed 1400 is an error');
  assert.ok(codes.includes('DUPLICATE_LINE') && codes.includes('CUT_VS_REQUESTED') && codes.includes('DUE_DATE_MISSING'));
});

test('order sheet: colour / size matching is Turkish-aware and refuses ambiguity', () => {
  const colors = [{ id: '1', code: 'SYH', name: 'Siyah' }, { id: '2', code: 'LCV', name: 'Lacivert' }, { id: '3', code: 'LAC', name: 'Lacivert Koyu' }];
  assert.equal(matchColor('SİYAH', colors)?.id, '1');
  assert.equal(matchColor('lcv', colors)?.id, '2');
  assert.equal(matchColor('laci', colors), null, 'two Lacivert colours → no guess');
  assert.equal(matchColor('la', colors), null);
  assert.equal(matchColor('laci', colors.slice(0, 2))?.id, '2');
  assert.equal(normSize('xxxl'), '3XL'); assert.equal(normSize(' 2xl '), 'XXL');
  assert.equal(matchSize('XXXL', [{ id: 'a', code: '3XL' }])?.id, 'a');
  // AI output that does not fit the schema is rejected, not repaired
  assert.equal(OrderSheetExtraction.safeParse({ sections: [{ title: 'x', lines: [{ color: 'a', quantity: -3 }] }] }).success, false);
});
