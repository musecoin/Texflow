import { z } from 'zod/v4';
import { AppError, CreateWorkOrderReq, TransitionReq, ReserveReq, PageQuery, Dec, findTransition, allowedActions, WORK_ORDER_TRANSITIONS, SALES_ORDER_TRANSITIONS,
  materialRequirement, allocateFifo, convertSameDimension, type UnitCode, type WorkOrderStatus } from '@texflow/shared';
import type { Connection } from '@texflow/db';
import type { Route } from '../http/kernel.ts';
import { nextNumber, one, assertUuid, updateVersioned, page, camel, camelAll } from '../lib.ts';
import { postMovement } from './inventory.ts';

export async function workOrderView(db: Connection, id: string) {
  const w = await one(db, `SELECT w.*, so.order_no, so.status AS order_status, m.code AS model_code, m.name AS model_name, col.code AS color_code, col.name AS color_name
      FROM work_order w JOIN sales_order so ON so.id = w.sales_order_id JOIN product_model m ON m.id = w.model_id JOIN color col ON col.id = w.color_id WHERE w.id = $1`, [id], 'İş emri');
  const materials = (await db.query(`SELECT wm.*, mt.code AS material_code, mt.name AS material_name,
        (SELECT coalesce(sum(r.physical_qty - r.reserved_qty), 0) FROM fabric_roll r WHERE r.material_id = wm.material_id AND r.quality_status = 'ACCEPTED') AS available_stock,
        (SELECT coalesce(sum(r.physical_qty), 0) FROM fabric_roll r WHERE r.material_id = wm.material_id AND r.quality_status = 'QUARANTINE') AS quarantine_stock
      FROM work_order_material wm JOIN material mt ON mt.id = wm.material_id WHERE wm.work_order_id = $1 ORDER BY mt.code`, [id])).rows;
  const reservations = (await db.query(`SELECT sr.id, sr.work_order_material_id, sr.qty, sr.unit, sr.status, sr.allocation_policy, sr.created_at, r.roll_no, r.shade, l.lot_no
      FROM stock_reservation sr JOIN fabric_roll r ON r.id = sr.roll_id JOIN fabric_lot l ON l.id = r.lot_id WHERE sr.work_order_id = $1 ORDER BY sr.created_at, r.roll_no`, [id])).rows;
  return {
    ...camel(w),
    materials: camelAll(materials).map((m) => ({ ...m, shortfallQty: Dec.max(Dec.of(m.requiredQty).sub(m.reservedQty), Dec.zero()).toString() })),
    reservations: camelAll(reservations),
    allowedActions: allowedActions(WORK_ORDER_TRANSITIONS, w.status as WorkOrderStatus),
  };
}

export function workOrderRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/v1/work-orders', tag: 'production', summary: 'İş emirleri', permission: 'workorder.read', query: PageQuery,
      handler: async (c) => {
        const q = c.query as z.infer<typeof PageQuery>;
        const params: unknown[] = []; const where: string[] = [];
        if (q.status) { params.push(q.status); where.push(`w.status = $${params.length}`); }
        if (q.q) { params.push('%' + q.q.replace(/[%_]/g, '\\$&') + '%'); where.push(`(w.wo_no ILIKE $${params.length} OR so.order_no ILIKE $${params.length})`); }
        if (c.auth.factoryIds) { params.push([...c.auth.factoryIds]); where.push(`w.factory_id = ANY($${params.length}::uuid[])`); }
        const wh = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const total = (await c.db.query<{ n: number }>(`SELECT count(*)::int n FROM work_order w JOIN sales_order so ON so.id = w.sales_order_id ${wh}`, params)).rows[0].n;
        params.push(q.limit, q.offset);
        const rows = (await c.db.query(`SELECT w.id, w.wo_no, w.status, w.planned_qty, w.unit, w.bom_version, w.row_version, w.created_at, so.order_no, m.code AS model_code, col.code AS color_code,
            (SELECT round(avg(least(x.reserved_qty / x.required_qty, 1)) * 100, 1) FROM work_order_material x WHERE x.work_order_id = w.id) AS coverage_pct
            FROM work_order w JOIN sales_order so ON so.id = w.sales_order_id JOIN product_model m ON m.id = w.model_id JOIN color col ON col.id = w.color_id
            ${wh} ORDER BY w.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
        return page(camelAll(rows), total, q);
      } },
    { method: 'GET', path: '/api/v1/work-orders/:id', tag: 'production', summary: 'İş emri detayı, malzeme ihtiyacı ve rezervasyonlar', permission: 'workorder.read',
      handler: async (c) => { assertUuid(c.params.id, 'İş emri'); const v = await workOrderView(c.db, c.params.id); c.assertFactory(v.factoryId); return v; } },
    { method: 'POST', path: '/api/v1/work-orders', tag: 'production', summary: 'İş emri oluştur (planlandı)', permission: 'workorder.create', body: CreateWorkOrderReq,
      handler: async (c) => {
        const b = c.body as z.infer<typeof CreateWorkOrderReq>;
        const so = await one(c.db, 'SELECT * FROM sales_order WHERE id = $1 FOR UPDATE', [b.salesOrderId], 'Sipariş');
        c.assertFactory(so.factory_id);
        if (!['CONFIRMED', 'IN_PRODUCTION'].includes(so.status)) throw new AppError('PRECONDITION_FAILED', 'İş emri yalnızca onaylı sipariş için açılabilir');
        // prevent double counting: planned quantity per model/color cannot exceed the ordered quantity
        const ordered = (await c.db.query<{ q: string }>(`SELECT coalesce(sum(l.quantity), 0) AS q FROM sales_order_line l JOIN product_variant v ON v.id = l.variant_id
            WHERE l.sales_order_id = $1 AND l.model_id = $2 AND v.color_id = $3`, [so.id, b.modelId, b.colorId])).rows[0].q;
        if (Dec.of(ordered).isZero()) throw new AppError('VALIDATION_FAILED', 'Bu model/renk siparişte yok');
        const planned = (await c.db.query<{ q: string }>(`SELECT coalesce(sum(planned_qty), 0) AS q FROM work_order WHERE sales_order_id = $1 AND model_id = $2 AND color_id = $3 AND status <> 'CANCELLED'`,
          [so.id, b.modelId, b.colorId])).rows[0].q;
        const remaining = Dec.of(ordered).sub(planned);
        if (Dec.of(b.plannedQty).gt(remaining)) throw new AppError('VALIDATION_FAILED', `Planlanan miktar kalan sipariş miktarını aşıyor (kalan: ${remaining.toString()})`, { remaining: remaining.toString() });
        const woNo = await nextNumber(c.db, c.auth.orgId, 'WO', 'IE');
        const w = (await c.db.query(`INSERT INTO work_order (organization_id, factory_id, wo_no, sales_order_id, model_id, color_id, planned_qty, planned_start, planned_end, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [c.auth.orgId, so.factory_id, woNo, so.id, b.modelId, b.colorId, b.plannedQty, b.plannedStart ?? null, b.plannedEnd ?? null, c.auth.userId])).rows[0];
        await c.audit('workorder.create', 'work_order', w.id, null, w);
        c.emit({ type: 'workorder.created', entityType: 'work_order', entityId: w.id });
        return workOrderView(c.db, w.id);
      } },
    { method: 'POST', path: '/api/v1/work-orders/:id/release', tag: 'production', summary: 'İş emrini serbest bırak (onaylı BOM anlık görüntüsü + malzeme ihtiyacı)', permission: 'workorder.release', body: TransitionReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'İş emri');
        const w = await one(c.db, 'SELECT * FROM work_order WHERE id = $1 FOR UPDATE', [c.params.id], 'İş emri');
        c.assertFactory(w.factory_id);
        findTransition(WORK_ORDER_TRANSITIONS, 'İş emri', w.status, 'release');
        const model = await one(c.db, 'SELECT status FROM product_model WHERE id = $1', [w.model_id], 'Model');
        if (model.status !== 'TECH_APPROVED') throw new AppError('PRECONDITION_FAILED', 'Model teknik onaylı değil');
        const bom = (await c.db.query(`SELECT * FROM bom WHERE model_id = $1 AND status = 'APPROVED'`, [w.model_id])).rows[0];
        if (!bom) throw new AppError('PRECONDITION_FAILED', 'Modelin onaylı reçetesi (BOM) yok');
        const items = (await c.db.query(`SELECT i.*, m.code AS material_code, m.base_unit FROM bom_item i JOIN material m ON m.id = i.material_id WHERE i.bom_id = $1 ORDER BY m.code`, [bom.id])).rows;
        const snapshot = { bomId: bom.id, version: bom.version, approvedAt: bom.approved_at, approvedBy: bom.approved_by, items: camelAll(items), snapshotAt: new Date().toISOString() };
        const requirements = [];
        for (const it of items) {
          const req = materialRequirement(w.planned_qty, it.consumption_per_piece, it.waste_pct);
          const inBase = convertSameDimension(req, it.unit as UnitCode, it.base_unit as UnitCode).ceil(4);
          await c.db.query(`INSERT INTO work_order_material (organization_id, work_order_id, bom_item_id, material_id, unit, required_qty) VALUES ($1,$2,$3,$4,$5,$6)`,
            [c.auth.orgId, w.id, it.id, it.material_id, it.base_unit, inBase.toString()]);
          requirements.push({ material: it.material_code, required: inBase.toString(), unit: it.base_unit,
            formula: `${w.planned_qty} × ${it.consumption_per_piece} ${it.unit} × (1 + ${it.waste_pct}/100)` });
        }
        await updateVersioned(c.db, 'work_order', w.id, c.body.expectedVersion,
          { status: 'RELEASED', bom_id: bom.id, bom_version: bom.version, bom_snapshot: snapshot, released_by: c.auth.userId, released_at: new Date() });
        const so = (await c.db.query('SELECT * FROM sales_order WHERE id = $1 FOR UPDATE', [w.sales_order_id])).rows[0];
        if (so.status === 'CONFIRMED') {
          findTransition(SALES_ORDER_TRANSITIONS, 'Sipariş', so.status, 'start_production');
          await c.db.query(`UPDATE sales_order SET status = 'IN_PRODUCTION', row_version = row_version + 1 WHERE id = $1`, [so.id]);
          await c.audit('order.start_production', 'sales_order', so.id, { status: so.status }, { status: 'IN_PRODUCTION', trigger: w.wo_no });
        }
        await c.audit('workorder.release', 'work_order', w.id, { status: w.status }, { status: 'RELEASED', bomVersion: bom.version, requirements });
        c.emit({ type: 'workorder.released', entityType: 'work_order', entityId: w.id });
        return { status: 200, body: { ...(await workOrderView(c.db, w.id)), requirements } };
      } },
    { method: 'POST', path: '/api/v1/work-orders/:id/materials/:wmId/reserve', tag: 'inventory', summary: 'Malzeme rezervasyonu (FIFO, ton/lot kısıtlı; QR ile tek top da olabilir)', permission: 'reservation.create', body: ReserveReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'İş emri'); assertUuid(c.params.wmId, 'Malzeme satırı');
        const b = c.body as z.infer<typeof ReserveReq>;
        const w = await one(c.db, 'SELECT * FROM work_order WHERE id = $1', [c.params.id], 'İş emri');
        c.assertFactory(w.factory_id);
        if (!['RELEASED', 'IN_PROGRESS'].includes(w.status)) throw new AppError('INVALID_TRANSITION', 'Rezervasyon yalnızca serbest bırakılmış iş emrine yapılır', { from: w.status, action: 'reserve' });
        const wm = await one(c.db, 'SELECT * FROM work_order_material WHERE id = $1 AND work_order_id = $2 FOR UPDATE', [c.params.wmId, w.id], 'Malzeme satırı');
        const needed = Dec.of(wm.required_qty).sub(wm.reserved_qty);
        if (!needed.gt(0)) throw new AppError('PRECONDITION_FAILED', 'Bu malzeme ihtiyacı zaten tamamen rezerve edildi');
        const item = (w.bom_snapshot.items as { id: string; colorId: string | null }[]).find((i) => i.id === wm.bom_item_id);
        const colorId = item?.colorId ?? null;

        let lines: { rollId: string; qty: Dec; shade: string; lotId: string }[] = [];
        let shortfall = Dec.zero();
        let newShadeLock: string | null = wm.shade_lock;
        if (b.rollId) {
          const r = await one(c.db, 'SELECT * FROM fabric_roll WHERE id = $1 FOR UPDATE', [b.rollId], 'Top');
          if (r.material_id !== wm.material_id) throw new AppError('VALIDATION_FAILED', 'Top bu malzemeye ait değil');
          if (r.quality_status !== 'ACCEPTED') throw new AppError('STOCK_NOT_RELEASED', `Top kalite onaylı değil (${r.quality_status}); rezerve edilemez`);
          if (colorId && r.color_id !== colorId) throw new AppError('VALIDATION_FAILED', 'Top rengi reçete rengiyle uyuşmuyor');
          if (b.singleShade && wm.shade_lock && r.shade !== wm.shade_lock) throw new AppError('PRECONDITION_FAILED', `Ton kısıtı: bu iş emri ${wm.shade_lock} tonuna kilitli, top tonu ${r.shade}`);
          const avail = Dec.of(r.physical_qty).sub(r.reserved_qty);
          const qty = b.qty ? Dec.of(b.qty) : Dec.min(needed, avail);
          if (qty.gt(needed)) throw new AppError('VALIDATION_FAILED', `İhtiyaçtan fazla rezervasyon yapılamaz (kalan ihtiyaç ${needed.toString()})`);
          if (!qty.gt(0) || qty.gt(avail)) throw new AppError('INSUFFICIENT_STOCK', 'Topta yeterli kullanılabilir miktar yok', { available: avail.toString() });
          lines = [{ rollId: r.id, qty, shade: r.shade, lotId: r.lot_id }];
          if (b.singleShade && !newShadeLock) newShadeLock = r.shade;
        } else {
          // lock candidates in a stable order (by id) to avoid deadlocks between concurrent allocators
          const cands = (await c.db.query(`SELECT id, roll_no, lot_id, shade, color_id, received_at, (physical_qty - reserved_qty) AS available FROM fabric_roll
              WHERE material_id = $1 AND quality_status = 'ACCEPTED' AND physical_qty > reserved_qty ORDER BY id FOR UPDATE`, [wm.material_id])).rows;
          const alloc = allocateFifo({ rolls: cands.map((r) => ({ id: r.id, lotId: r.lot_id, shade: r.shade, colorId: r.color_id, receivedAt: r.received_at, available: r.available, seq: r.roll_no })),
            needed, colorId, shadeLock: b.singleShade ? wm.shade_lock : null, singleShade: b.singleShade });
          lines = alloc.lines; shortfall = alloc.shortfall;
          if (b.singleShade && !newShadeLock) newShadeLock = alloc.shade;
          if (!lines.length) {
            const quarantine = (await c.db.query<{ q: string }>(`SELECT coalesce(sum(physical_qty), 0) AS q FROM fabric_roll WHERE material_id = $1 AND quality_status = 'QUARANTINE'`, [wm.material_id])).rows[0].q;
            throw new AppError('INSUFFICIENT_STOCK', 'Rezerve edilebilir kabul edilmiş stok yok', { needed: needed.toString(), quarantineQty: quarantine });
          }
          if (shortfall.gt(0) && !b.allowPartial) throw new AppError('INSUFFICIENT_STOCK', 'Stok ihtiyacı karşılamıyor (kısmi rezervasyona izin verilmedi)', { needed: needed.toString(), shortfall: shortfall.toString() });
        }

        const created = [];
        for (const l of lines) {
          const r = (await c.db.query('SELECT r.*, w.factory_id FROM fabric_roll r JOIN warehouse w ON w.id = r.warehouse_id WHERE r.id = $1', [l.rollId])).rows[0];
          const sr = (await c.db.query(`INSERT INTO stock_reservation (organization_id, work_order_id, work_order_material_id, roll_id, material_id, qty, unit, allocation_policy, created_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [c.auth.orgId, w.id, wm.id, l.rollId, wm.material_id, l.qty.toString(), wm.unit, b.rollId ? 'MANUAL_SCAN' : b.policy, c.auth.userId])).rows[0];
          await postMovement(c, { factoryId: r.factory_id, type: 'RESERVE', materialId: wm.material_id, rollId: l.rollId, lotId: r.lot_id, warehouseId: r.warehouse_id, binId: r.bin_id,
            status: 'ACCEPTED', reservedDelta: l.qty.toString(), unit: wm.unit, sourceType: 'stock_reservation', sourceId: sr.id, reason: w.wo_no });
          created.push({ id: sr.id, rollNo: r.roll_no, qty: l.qty.toString(), shade: l.shade });
        }
        const total = Dec.sum(lines.map((l) => l.qty));
        await c.db.query('UPDATE work_order_material SET reserved_qty = reserved_qty + $2, shade_lock = $3 WHERE id = $1', [wm.id, total.toString(), newShadeLock]);
        await c.audit('reservation.create', 'work_order_material', wm.id, { reservedQty: wm.reserved_qty }, { reserved: created, shortfall: shortfall.toString(), shadeLock: newShadeLock });
        c.emit({ type: 'inventory.changed', entityType: 'work_order', entityId: w.id });
        return { reservations: created, reservedQty: total.toString(), shortfallQty: shortfall.toString(), shadeLock: newShadeLock, workOrder: await workOrderView(c.db, w.id) };
      } },
    { method: 'POST', path: '/api/v1/reservations/:id/release', tag: 'inventory', summary: 'Rezervasyonu çöz', permission: 'reservation.release', body: z.object({ reason: z.string().min(3).max(300) }),
      handler: async (c) => {
        assertUuid(c.params.id, 'Rezervasyon');
        const sr = await one(c.db, 'SELECT * FROM stock_reservation WHERE id = $1 FOR UPDATE', [c.params.id], 'Rezervasyon');
        if (sr.status !== 'ACTIVE') throw new AppError('INVALID_TRANSITION', 'Rezervasyon aktif değil', { from: sr.status, action: 'release' });
        await one(c.db, 'SELECT id FROM work_order_material WHERE id = $1 FOR UPDATE', [sr.work_order_material_id]);
        const r = (await c.db.query('SELECT r.*, w.factory_id FROM fabric_roll r JOIN warehouse w ON w.id = r.warehouse_id WHERE r.id = $1 FOR UPDATE OF r', [sr.roll_id])).rows[0];
        c.assertFactory(r.factory_id);
        await c.db.query(`UPDATE stock_reservation SET status = 'RELEASED', released_by = $2, released_at = now() WHERE id = $1`, [sr.id, c.auth.userId]);
        await postMovement(c, { factoryId: r.factory_id, type: 'UNRESERVE', materialId: sr.material_id, rollId: r.id, lotId: r.lot_id, warehouseId: r.warehouse_id, binId: r.bin_id,
          status: 'ACCEPTED', reservedDelta: Dec.of(sr.qty).neg().toString(), unit: sr.unit, sourceType: 'stock_reservation', sourceId: sr.id, reason: c.body.reason });
        await c.db.query(`UPDATE work_order_material SET reserved_qty = reserved_qty - $2,
            shade_lock = CASE WHEN reserved_qty - $2 = 0 THEN NULL ELSE shade_lock END WHERE id = $1`, [sr.work_order_material_id, sr.qty]);
        await c.audit('reservation.release', 'stock_reservation', sr.id, { status: 'ACTIVE' }, { status: 'RELEASED', reason: c.body.reason });
        c.emit({ type: 'inventory.changed', entityType: 'work_order', entityId: sr.work_order_id });
        return { status: 200, body: { id: sr.id, status: 'RELEASED' } };
      } },
  ];
}
