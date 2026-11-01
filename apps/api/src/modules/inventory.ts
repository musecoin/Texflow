import crypto from 'node:crypto';
import { z } from 'zod/v4';
import { AppError, ReceiveRollsReq, InspectRollReq, AdjustmentReq, DecisionReq, Dec, toBaseUnit, scoreFourPoint, evaluateInspection,
  findTransition, ROLL_TRANSITIONS, type UnitCode } from '@texflow/shared';
import type { Connection } from '@texflow/db';
import type { Route, Ctx } from '../http/kernel.ts';
import { nextNumber, one, assertUuid, page, camel, camelAll } from '../lib.ts';

const LedgerQuery = z.object({
  rollId: z.string().uuid().optional(), materialId: z.string().uuid().optional(), sourceId: z.string().uuid().optional(),
  movementType: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});
const RollQuery = z.object({
  status: z.enum(['QUARANTINE', 'ACCEPTED', 'REJECTED']).optional(), materialId: z.string().uuid().optional(), q: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
});

export interface MovementInput {
  factoryId: string; type: string; materialId: string; rollId: string; lotId: string; warehouseId: string; binId: string | null;
  status: 'QUARANTINE' | 'ACCEPTED' | 'REJECTED'; qtyDelta?: string; reservedDelta?: string; unit: string;
  sourceType: string; sourceId: string; reason?: string;
}

export async function postMovement(c: Ctx, m: MovementInput) {
  const r = await c.db.query(`INSERT INTO inventory_movement (organization_id, factory_id, movement_type, material_id, roll_id, lot_id, warehouse_id, bin_id, stock_status,
      qty_delta, reserved_delta, unit, source_type, source_id, reason, actor_user_id, request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [c.auth.orgId, m.factoryId, m.type, m.materialId, m.rollId, m.lotId, m.warehouseId, m.binId, m.status, m.qtyDelta ?? '0', m.reservedDelta ?? '0', m.unit,
      m.sourceType, m.sourceId, m.reason ?? null, c.auth.userId, c.requestId]);
  return r.rows[0].id as string;
}

export async function rollView(db: Connection, where: string, param: string) {
  const r = await one(db, `SELECT r.*, m.code AS material_code, m.name AS material_name, m.inspection_plan_id, l.lot_no, l.dye_lot, s.name AS supplier_name,
      w.code AS warehouse_code, w.factory_id, b.code AS bin_code, col.code AS color_code, gr.receipt_no,
      (CASE WHEN r.quality_status = 'ACCEPTED' THEN r.physical_qty - r.reserved_qty ELSE 0 END) AS available_qty
    FROM fabric_roll r JOIN material m ON m.id = r.material_id JOIN fabric_lot l ON l.id = r.lot_id JOIN supplier s ON s.id = l.supplier_id
    JOIN warehouse w ON w.id = r.warehouse_id LEFT JOIN bin b ON b.id = r.bin_id LEFT JOIN color col ON col.id = r.color_id
    JOIN goods_receipt gr ON gr.id = r.goods_receipt_id WHERE ${where}`, [param], 'Top');
  const inspections = (await db.query('SELECT * FROM material_inspection WHERE roll_id = $1 ORDER BY inspected_at', [r.id])).rows;
  const defects = inspections.length ? (await db.query('SELECT * FROM inspection_defect WHERE inspection_id = ANY($1::uuid[]) ORDER BY position_m NULLS LAST', [inspections.map((i) => i.id)])).rows : [];
  const movements = (await db.query(`SELECT im.*, u.display_name AS actor_name FROM inventory_movement im JOIN app_user u ON u.id = im.actor_user_id WHERE im.roll_id = $1 ORDER BY im.id`, [r.id])).rows;
  const reservations = (await db.query(`SELECT sr.id, sr.qty, sr.unit, sr.status, sr.created_at, w.wo_no FROM stock_reservation sr JOIN work_order w ON w.id = sr.work_order_id WHERE sr.roll_id = $1 ORDER BY sr.created_at`, [r.id])).rows;
  return {
    ...camel(r),
    inspections: camelAll(inspections).map((i) => ({ ...i, defects: camelAll(defects.filter((d) => d.inspection_id === i.id)) })),
    movements: camelAll(movements), reservations: camelAll(reservations),
    allowedActions: r.quality_status === 'QUARANTINE' ? ['inspect'] : [],
  };
}

export function inventoryRoutes(): Route[] {
  return [
    { method: 'POST', path: '/api/v1/receipts', tag: 'inventory', summary: 'Kumaş top kabulü (karantinaya giriş)', permission: 'inventory.receive', body: ReceiveRollsReq,
      handler: async (c) => {
        const b = c.body as z.infer<typeof ReceiveRollsReq>;
        c.assertFactory(b.factoryId);
        const wh = await one(c.db, 'SELECT * FROM warehouse WHERE id = $1 AND factory_id = $2', [b.warehouseId, b.factoryId], 'Depo');
        if (wh.kind !== 'FABRIC') throw new AppError('VALIDATION_FAILED', 'Kumaş topları yalnızca kumaş deposuna alınabilir');
        await one(c.db, 'SELECT id FROM supplier WHERE id = $1', [b.supplierId], 'Tedarikçi');
        let binId = b.binId ?? null;
        if (binId) await one(c.db, 'SELECT id FROM bin WHERE id = $1 AND warehouse_id = $2', [binId, wh.id], 'Raf/göz');
        else binId = (await c.db.query('SELECT id FROM bin WHERE warehouse_id = $1 AND is_quarantine ORDER BY code LIMIT 1', [wh.id])).rows[0]?.id ?? null;

        const receiptNo = await nextNumber(c.db, c.auth.orgId, 'GR', 'MK');
        const gr = (await c.db.query(`INSERT INTO goods_receipt (organization_id, factory_id, receipt_no, supplier_id, supplier_delivery_note, received_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [c.auth.orgId, b.factoryId, receiptNo, b.supplierId, b.supplierDeliveryNote ?? null, c.auth.userId])).rows[0];
        const rolls = [];
        for (const [i, x] of b.rolls.entries()) {
          const mat = await one(c.db, 'SELECT * FROM material WHERE id = $1', [x.materialId], 'Malzeme');
          if (mat.kind !== 'FABRIC') throw new AppError('VALIDATION_FAILED', `Top ${i + 1}: malzeme kumaş değil`);
          const geometry = { gsm: x.gsm ?? mat.gsm, widthCm: x.widthCm ?? mat.width_cm };
          const conv = toBaseUnit(Dec.of(x.quantity), x.unit as UnitCode, mat.base_unit as UnitCode, { allowGsmWidthEstimate: x.allowGsmWidthEstimate, geometry });
          const qty = conv.qty.round(4);
          if (!qty.gt(0)) throw new AppError('VALIDATION_FAILED', `Top ${i + 1}: miktar sıfır`);
          const lot = (await c.db.query(`INSERT INTO fabric_lot (organization_id, material_id, supplier_id, lot_no, dye_lot) VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (organization_id, material_id, supplier_id, lot_no) DO UPDATE SET dye_lot = coalesce(fabric_lot.dye_lot, EXCLUDED.dye_lot) RETURNING id`,
            [c.auth.orgId, mat.id, b.supplierId, x.lotNo, x.dyeLot ?? null])).rows[0];
          const id = crypto.randomUUID();
          const rollNo = await nextNumber(c.db, c.auth.orgId, 'ROLL', 'TOP', 6);
          await c.db.query(`INSERT INTO fabric_roll (id, organization_id, roll_no, qr_code, material_id, lot_id, goods_receipt_id, supplier_roll_no, warehouse_id, bin_id, color_id,
              shade, width_cm, gsm, gross_weight_kg, net_weight_kg, length_m, unit, received_qty, quantity_basis)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [id, c.auth.orgId, rollNo, `TFROLL:${id}`, mat.id, lot.id, gr.id, x.supplierRollNo ?? null, wh.id, binId, x.colorId ?? null, x.shade,
              x.widthCm ?? null, x.gsm ?? null, x.grossWeightKg ?? null, x.netWeightKg ?? null, x.lengthM ?? null, mat.base_unit, qty.toString(),
              { enteredQty: x.quantity, enteredUnit: x.unit, ...conv.basis }]);
          await postMovement(c, { factoryId: b.factoryId, type: 'RECEIPT', materialId: mat.id, rollId: id, lotId: lot.id, warehouseId: wh.id, binId, status: 'QUARANTINE',
            qtyDelta: qty.toString(), unit: mat.base_unit, sourceType: 'goods_receipt', sourceId: gr.id, reason: conv.basis.method === 'GSM_WIDTH' ? 'GSM/en ile hesaplanan tahmini metraj' : undefined });
          rolls.push({ id, rollNo, qrCode: `TFROLL:${id}`, quantity: qty.toString(), unit: mat.base_unit, quantityBasis: conv.basis, qualityStatus: 'QUARANTINE' });
        }
        await c.audit('inventory.receive', 'goods_receipt', gr.id, null, { receiptNo, rolls });
        c.emit({ type: 'inventory.changed', entityType: 'goods_receipt', entityId: gr.id });
        return { ...camel(gr), rolls };
      } },
    { method: 'GET', path: '/api/v1/rolls', tag: 'inventory', summary: 'Kumaş topları', permission: 'inventory.read', query: RollQuery,
      handler: async (c) => {
        const q = c.query as z.infer<typeof RollQuery>;
        const params: unknown[] = []; const where: string[] = [];
        if (q.status) { params.push(q.status); where.push(`r.quality_status = $${params.length}`); }
        if (q.materialId) { params.push(q.materialId); where.push(`r.material_id = $${params.length}`); }
        if (q.q) { params.push('%' + q.q.replace(/[%_]/g, '\\$&') + '%'); where.push(`(r.roll_no ILIKE $${params.length} OR l.lot_no ILIKE $${params.length} OR r.qr_code ILIKE $${params.length})`); }
        if (c.auth.factoryIds) { params.push([...c.auth.factoryIds]); where.push(`w.factory_id = ANY($${params.length}::uuid[])`); }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const base = `FROM fabric_roll r JOIN fabric_lot l ON l.id = r.lot_id JOIN material m ON m.id = r.material_id JOIN warehouse w ON w.id = r.warehouse_id ${w}`;
        const total = (await c.db.query<{ n: number }>(`SELECT count(*)::int n ${base}`, params)).rows[0].n;
        params.push(q.limit, q.offset);
        const rows = (await c.db.query(`SELECT r.id, r.roll_no, r.qr_code, r.quality_status, r.shade, r.unit, r.received_qty, r.physical_qty, r.reserved_qty,
            (CASE WHEN r.quality_status = 'ACCEPTED' THEN r.physical_qty - r.reserved_qty ELSE 0 END) AS available_qty, r.received_at, r.row_version,
            l.lot_no, m.code AS material_code, m.name AS material_name, w.code AS warehouse_code
            ${base} ORDER BY r.received_at DESC, r.roll_no DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
        return page(camelAll(rows), total, q);
      } },
    { method: 'GET', path: '/api/v1/rolls/:id', tag: 'inventory', summary: 'Top detayı, muayene ve hareket geçmişi', permission: 'inventory.read',
      handler: async (c) => { assertUuid(c.params.id, 'Top'); const v = await rollView(c.db, 'r.id = $1', c.params.id); c.assertFactory(v.factoryId); return v; } },
    { method: 'GET', path: '/api/v1/rolls/by-qr/:qr', tag: 'inventory', summary: 'QR kod ile top sorgula', permission: 'inventory.read',
      handler: async (c) => { const v = await rollView(c.db, 'r.qr_code = $1', c.params.qr); c.assertFactory(v.factoryId); return v; } },
    { method: 'POST', path: '/api/v1/rolls/:id/inspections', tag: 'quality', summary: '4 puan kumaş muayenesi (kabul → kullanılabilir stok, red → red stoğu)', permission: 'inventory.inspect', body: InspectRollReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'Top');
        const b = c.body as z.infer<typeof InspectRollReq>;
        const roll = await one(c.db, `SELECT r.*, w.factory_id FROM fabric_roll r JOIN warehouse w ON w.id = r.warehouse_id WHERE r.id = $1 FOR UPDATE OF r`, [c.params.id], 'Top');
        c.assertFactory(roll.factory_id);
        if (roll.row_version !== b.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Top kaydı değişti; yenileyip tekrar deneyin', { currentVersion: roll.row_version });
        const mat = await one(c.db, 'SELECT * FROM material WHERE id = $1', [roll.material_id], 'Malzeme');
        if (!mat.inspection_plan_id) throw new AppError('PRECONDITION_FAILED', 'Malzeme için muayene planı tanımlı değil; kabul kriteri olmadan karar verilemez');
        const plan = await one(c.db, 'SELECT * FROM fabric_inspection_plan WHERE id = $1', [mat.inspection_plan_id], 'Muayene planı');
        const score = scoreFourPoint({ inspectedLengthM: b.inspectedLengthM, cuttableWidthCm: b.cuttableWidthCm, defects: b.defects });
        const ev = evaluateInspection({
          plan: { maxPointsPer100SqYd: plan.max_points_per_100_sq_yd, maxWidthDeviationPct: plan.max_width_deviation_pct, maxGsmDeviationPct: plan.max_gsm_deviation_pct, maxShrinkagePct: plan.max_shrinkage_pct },
          pointsPer100SqYd: score.pointsPer100SqYd, nominalWidthCm: mat.width_cm, measuredWidthCm: b.measuredWidthCm, nominalGsm: mat.gsm, measuredGsm: b.measuredGsm,
          shrinkageLengthPct: b.shrinkageLengthPct, shrinkageWidthPct: b.shrinkageWidthPct, shadeResult: b.shadeResult,
        });
        const t = findTransition(ROLL_TRANSITIONS, 'Top', roll.quality_status, ev.result === 'PASS' ? 'inspect_pass' : 'inspect_fail');
        const insp = (await c.db.query(`INSERT INTO material_inspection (organization_id, roll_id, plan_id, inspector_id, inspected_length_m, cuttable_width_cm, measured_gsm, measured_width_cm,
            shrinkage_length_pct, shrinkage_width_pct, shade_result, total_points, points_per_100_sq_yd, threshold_snapshot, failed_checks, result, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [c.auth.orgId, roll.id, plan.id, c.auth.userId, b.inspectedLengthM, b.cuttableWidthCm, b.measuredGsm ?? null, b.measuredWidthCm ?? null,
            b.shrinkageLengthPct ?? null, b.shrinkageWidthPct ?? null, b.shadeResult ?? null, score.totalPoints, score.pointsPer100SqYd.toString(),
            { planCode: plan.code, maxPointsPer100SqYd: plan.max_points_per_100_sq_yd, maxWidthDeviationPct: plan.max_width_deviation_pct, maxGsmDeviationPct: plan.max_gsm_deviation_pct, maxShrinkagePct: plan.max_shrinkage_pct, isDemoPlan: plan.is_demo },
            ev.failedChecks, ev.result, b.notes ?? null])).rows[0];
        for (const d of score.defects) {
          await c.db.query('INSERT INTO inspection_defect (organization_id, inspection_id, defect_code, length_in, is_hole, points, position_m) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [c.auth.orgId, insp.id, d.code, d.lengthIn ?? null, d.isHole ?? false, d.rawPoints, d.positionM ?? null]); // raw points; per-yard cap is reflected in total_points
        }
        // status move = two ledger rows: out of QUARANTINE, into ACCEPTED/REJECTED
        const type = t.to === 'ACCEPTED' ? 'QC_RELEASE' : 'QC_REJECT';
        const common = { factoryId: roll.factory_id, type, materialId: roll.material_id, rollId: roll.id, lotId: roll.lot_id, warehouseId: roll.warehouse_id, binId: roll.bin_id, unit: roll.unit, sourceType: 'material_inspection', sourceId: insp.id };
        await c.db.query('UPDATE fabric_roll SET quality_status = $2 WHERE id = $1', [roll.id, t.to]);
        await postMovement(c, { ...common, status: 'QUARANTINE', qtyDelta: Dec.of(roll.physical_qty).neg().toString() });
        await postMovement(c, { ...common, status: t.to as 'ACCEPTED' | 'REJECTED', qtyDelta: roll.physical_qty, reason: ev.failedChecks.length ? 'Ret: ' + ev.failedChecks.join(', ') : undefined });
        await c.audit('inventory.inspect', 'fabric_roll', roll.id, { qualityStatus: roll.quality_status }, { qualityStatus: t.to, inspectionId: insp.id, points: score.pointsPer100SqYd.toString(), failedChecks: ev.failedChecks });
        c.emit({ type: 'inventory.changed', entityType: 'fabric_roll', entityId: roll.id, data: { qualityStatus: t.to } });
        return { inspection: { ...camel(insp), defects: score.defects.map((d) => ({ code: d.code, points: d.points })) }, roll: await rollView(c.db, 'r.id = $1', roll.id) };
      } },
    { method: 'GET', path: '/api/v1/inventory/ledger', tag: 'inventory', summary: 'Stok hareket defteri (değiştirilemez)', permission: 'inventory.read', query: LedgerQuery,
      handler: async (c) => {
        const q = c.query as z.infer<typeof LedgerQuery>;
        const params: unknown[] = []; const where: string[] = [];
        for (const [col, v] of [['im.roll_id', q.rollId], ['im.material_id', q.materialId], ['im.source_id', q.sourceId], ['im.movement_type', q.movementType]] as const) {
          if (v) { params.push(v); where.push(`${col} = $${params.length}`); }
        }
        if (c.auth.factoryIds) { params.push([...c.auth.factoryIds]); where.push(`im.factory_id = ANY($${params.length}::uuid[])`); }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const total = (await c.db.query<{ n: number }>(`SELECT count(*)::int n FROM inventory_movement im ${w}`, params)).rows[0].n;
        params.push(q.limit, q.offset);
        const rows = (await c.db.query(`SELECT im.id, im.roll_id, im.occurred_at, im.movement_type, im.stock_status, im.qty_delta, im.reserved_delta, im.unit, im.source_type, im.source_id, im.reason,
            r.roll_no, l.lot_no, m.code AS material_code, w.code AS warehouse_code, u.display_name AS actor_name,
            CASE im.source_type
              WHEN 'goods_receipt' THEN (SELECT receipt_no FROM goods_receipt WHERE id = im.source_id)
              WHEN 'stock_reservation' THEN (SELECT wo.wo_no FROM stock_reservation sr JOIN work_order wo ON wo.id = sr.work_order_id WHERE sr.id = im.source_id)
              WHEN 'material_inspection' THEN 'Muayene'
              WHEN 'inventory_adjustment_request' THEN 'Düzeltme'
            END AS source_ref
          FROM inventory_movement im JOIN material m ON m.id = im.material_id JOIN warehouse w ON w.id = im.warehouse_id JOIN app_user u ON u.id = im.actor_user_id
          LEFT JOIN fabric_roll r ON r.id = im.roll_id LEFT JOIN fabric_lot l ON l.id = im.lot_id
          ${w} ORDER BY im.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
        return page(camelAll(rows), total, q);
      } },
    { method: 'GET', path: '/api/v1/inventory/summary', tag: 'inventory', summary: 'Malzeme bazında fiziksel / karantina / rezerve / kullanılabilir stok', permission: 'inventory.read',
      handler: async (c) => {
        const rows = (await c.db.query(`SELECT m.id AS material_id, m.code AS material_code, m.name AS material_name, m.base_unit AS unit,
            coalesce(sum(r.physical_qty), 0) AS physical_qty,
            coalesce(sum(r.physical_qty) FILTER (WHERE r.quality_status = 'QUARANTINE'), 0) AS quarantine_qty,
            coalesce(sum(r.physical_qty) FILTER (WHERE r.quality_status = 'ACCEPTED'), 0) AS accepted_qty,
            coalesce(sum(r.physical_qty) FILTER (WHERE r.quality_status = 'REJECTED'), 0) AS rejected_qty,
            coalesce(sum(r.reserved_qty), 0) AS reserved_qty,
            coalesce(sum(r.physical_qty - r.reserved_qty) FILTER (WHERE r.quality_status = 'ACCEPTED'), 0) AS available_qty,
            count(r.id)::int AS roll_count
          FROM material m LEFT JOIN fabric_roll r ON r.material_id = m.id
          WHERE m.kind = 'FABRIC' GROUP BY m.id ORDER BY m.code`)).rows;
        return { items: camelAll(rows), definitions: {
          physical: 'Depoda fiilen bulunan miktar (tüm kalite durumları)',
          available: 'Kabul edilmiş fiziksel stok − aktif rezervasyonlar',
          quarantine: 'Giriş kalite kontrolü bekleyen stok; rezerve edilemez' } };
      } },
    { method: 'GET', path: '/api/v1/inventory/adjustments', tag: 'inventory', summary: 'Stok düzeltme talepleri', permission: 'inventory.read',
      handler: async (c) => ({ items: camelAll((await c.db.query(`SELECT a.*, r.roll_no, u.display_name AS requested_by_name FROM inventory_adjustment_request a
          JOIN fabric_roll r ON r.id = a.roll_id JOIN app_user u ON u.id = a.requested_by ORDER BY a.requested_at DESC LIMIT 200`)).rows) }) },
    { method: 'POST', path: '/api/v1/inventory/adjustments', tag: 'inventory', summary: 'Stok düzeltme talebi (onay gerektirir)', permission: 'inventory.adjust.request', body: AdjustmentReq,
      handler: async (c) => {
        const b = c.body as z.infer<typeof AdjustmentReq>;
        if (Dec.of(b.qtyDelta).isZero()) throw new AppError('VALIDATION_FAILED', 'Düzeltme miktarı sıfır olamaz');
        const roll = await one(c.db, 'SELECT r.*, w.factory_id FROM fabric_roll r JOIN warehouse w ON w.id = r.warehouse_id WHERE r.id = $1', [b.rollId], 'Top');
        c.assertFactory(roll.factory_id);
        const a = (await c.db.query('INSERT INTO inventory_adjustment_request (organization_id, roll_id, qty_delta, unit, reason, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [c.auth.orgId, roll.id, b.qtyDelta, roll.unit, b.reason, c.auth.userId])).rows[0];
        await c.audit('inventory.adjust.request', 'inventory_adjustment_request', a.id, null, a);
        return camel(a);
      } },
    { method: 'POST', path: '/api/v1/inventory/adjustments/:id/decide', tag: 'inventory', summary: 'Stok düzeltme onayı / reddi', permission: 'inventory.adjust.approve', body: DecisionReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'Talep');
        const a = await one(c.db, 'SELECT * FROM inventory_adjustment_request WHERE id = $1 FOR UPDATE', [c.params.id], 'Talep');
        if (a.status !== 'PENDING') throw new AppError('INVALID_TRANSITION', 'Talep zaten sonuçlandırılmış');
        if (a.requested_by === c.auth.userId) throw new AppError('SELF_APPROVAL_FORBIDDEN', 'Kendi düzeltme talebinizi onaylayamazsınız');
        const roll = await one(c.db, 'SELECT r.*, w.factory_id FROM fabric_roll r JOIN warehouse w ON w.id = r.warehouse_id WHERE r.id = $1 FOR UPDATE OF r', [a.roll_id], 'Top');
        c.assertFactory(roll.factory_id);
        if (c.body.approve) {
          const free = Dec.of(roll.physical_qty).sub(roll.reserved_qty);
          if (Dec.of(a.qty_delta).isNeg() && Dec.of(a.qty_delta).abs().gt(free)) throw new AppError('INSUFFICIENT_STOCK', 'Düzeltme rezerve edilmemiş stoktan fazla olamaz', { free: free.toString() });
          await postMovement(c, { factoryId: roll.factory_id, type: 'ADJUSTMENT', materialId: roll.material_id, rollId: roll.id, lotId: roll.lot_id, warehouseId: roll.warehouse_id, binId: roll.bin_id,
            status: roll.quality_status, qtyDelta: a.qty_delta, unit: roll.unit, sourceType: 'inventory_adjustment_request', sourceId: a.id, reason: a.reason });
        }
        const after = (await c.db.query('UPDATE inventory_adjustment_request SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *',
          [a.id, c.body.approve ? 'APPROVED' : 'REJECTED', c.auth.userId, c.body.note ?? null])).rows[0];
        await c.audit('inventory.adjust.decide', 'inventory_adjustment_request', a.id, { status: 'PENDING' }, { status: after.status });
        c.emit({ type: 'inventory.changed', entityType: 'fabric_roll', entityId: roll.id });
        return { status: 200, body: camel(after) };
      } },
  ];
}
