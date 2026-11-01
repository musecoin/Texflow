import { z } from 'zod/v4';
import { AppError, CreateSalesOrderReq, TransitionReq, PageQuery, findTransition, allowedActions, SALES_ORDER_TRANSITIONS, Dec, type SalesOrderStatus } from '@texflow/shared';
import type { Connection } from '@texflow/db';
import type { Route } from '../http/kernel.ts';
import { nextNumber, one, assertUuid, updateVersioned, page, orderBy, camel, camelAll } from '../lib.ts';

async function snapshot(db: Connection, orderId: string) {
  const o = (await db.query('SELECT * FROM sales_order WHERE id = $1', [orderId])).rows[0];
  const lines = (await db.query('SELECT line_no, model_id, variant_id, quantity, unit, unit_price FROM sales_order_line WHERE sales_order_id = $1 ORDER BY line_no', [orderId])).rows;
  return { order: o, lines };
}

export async function orderStatusView(db: Connection, orderId: string) {
  const o = await one(db, `SELECT so.*, c.name AS customer_name, c.code AS customer_code, f.code AS factory_code
      FROM sales_order so JOIN customer c ON c.id = so.customer_id JOIN factory f ON f.id = so.factory_id WHERE so.id = $1`, [orderId], 'Sipariş');
  const lines = (await db.query(`SELECT l.id, l.line_no, l.model_id, m.code AS model_code, m.name AS model_name, m.status AS model_status,
        v.sku, col.id AS color_id, col.code AS color_code, col.name AS color_name, sz.code AS size_code, l.quantity, l.unit, l.unit_price,
        round(l.quantity * l.unit_price, 4) AS amount
      FROM sales_order_line l JOIN product_model m ON m.id = l.model_id JOIN product_variant v ON v.id = l.variant_id
      JOIN color col ON col.id = v.color_id JOIN size sz ON sz.id = v.size_id
      WHERE l.sales_order_id = $1 ORDER BY l.line_no`, [orderId])).rows;
  const wos = (await db.query(`SELECT w.id, w.wo_no, w.status, w.model_id, w.color_id, w.planned_qty, w.bom_version, w.row_version,
        coalesce(round(avg(least(wm.reserved_qty / wm.required_qty, 1)) * 100, 1), 0) AS coverage_pct, count(wm.id)::int AS material_lines,
        count(wm.id) FILTER (WHERE wm.reserved_qty >= wm.required_qty)::int AS covered_lines
      FROM work_order w LEFT JOIN work_order_material wm ON wm.work_order_id = w.id
      WHERE w.sales_order_id = $1 GROUP BY w.id ORDER BY w.wo_no`, [orderId])).rows;
  const revisions = (await db.query('SELECT revision, reason, created_by, created_at FROM sales_order_revision WHERE sales_order_id = $1 ORDER BY revision', [orderId])).rows;

  const totalQty = Dec.sum(lines.map((l) => l.quantity as string));
  const totalAmount = Dec.sum(lines.map((l) => l.amount as string));
  const plannedQty = Dec.sum(wos.filter((w) => w.status !== 'CANCELLED').map((w) => w.planned_qty as string));
  const released = wos.filter((w) => ['RELEASED', 'IN_PROGRESS', 'COMPLETED'].includes(w.status));
  const allCovered = released.length > 0 && released.every((w) => w.material_lines > 0 && w.covered_lines === w.material_lines);
  let stage: string;
  if (o.status === 'DRAFT') stage = 'AWAITING_CONFIRMATION';
  else if (o.status === 'CANCELLED') stage = 'CANCELLED';
  else if (!wos.length) stage = 'AWAITING_WORK_ORDER';
  else if (!released.length) stage = 'AWAITING_RELEASE';
  else if (!allCovered) stage = 'AWAITING_MATERIAL';
  else stage = 'MATERIAL_RESERVED';
  const unapprovedModels = [...new Set(lines.filter((l) => l.model_status !== 'TECH_APPROVED').map((l) => l.model_code))];

  return {
    ...camel(o),
    lines: camelAll(lines),
    // coverage = mean over material lines of min(reserved/required, 1); quantities of different units are never summed
    workOrders: camelAll(wos),
    revisions: camelAll(revisions),
    summary: {
      totalQty: totalQty.toString(), totalAmount: totalAmount.toFixed(2), currency: o.currency,
      plannedQty: plannedQty.toString(), unplannedQty: Dec.max(totalQty.sub(plannedQty), Dec.zero()).toString(),
      stage, unapprovedModels,
    },
    allowedActions: allowedActions(SALES_ORDER_TRANSITIONS, o.status as SalesOrderStatus),
  };
}

export function orderRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/v1/orders', tag: 'sales', summary: 'Sipariş listesi (sayfalama, filtre, sıralama)', permission: 'order.read', query: PageQuery,
      handler: async (c) => {
        const q = c.query as z.infer<typeof PageQuery>;
        const where: string[] = []; const params: unknown[] = [];
        if (q.status) { params.push(q.status); where.push(`so.status = $${params.length}`); }
        if (q.q) { params.push('%' + q.q.replace(/[%_]/g, '\\$&') + '%'); where.push(`(so.order_no ILIKE $${params.length} OR c.name ILIKE $${params.length} OR so.customer_po ILIKE $${params.length})`); }
        if (c.auth.factoryIds) { params.push([...c.auth.factoryIds]); where.push(`so.factory_id = ANY($${params.length}::uuid[])`); }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const ob = orderBy(q.sort, ['order_no', 'due_date', 'order_date', 'status', 'created_at'], 'so.created_at DESC');
        const total = (await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sales_order so JOIN customer c ON c.id = so.customer_id ${w}`, params)).rows[0].n;
        params.push(q.limit, q.offset);
        const rows = (await c.db.query(`SELECT so.id, so.order_no, so.status, so.customer_po, so.currency, so.order_date, so.due_date, so.revision, so.row_version,
              c.name AS customer_name, coalesce(sum(l.quantity),0) AS total_qty, coalesce(round(sum(l.quantity*l.unit_price),2),0) AS total_amount
            FROM sales_order so JOIN customer c ON c.id = so.customer_id LEFT JOIN sales_order_line l ON l.sales_order_id = so.id
            ${w} GROUP BY so.id, c.name ORDER BY ${ob} LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
        return page(camelAll(rows), total, q);
      } },
    { method: 'GET', path: '/api/v1/orders/:id', tag: 'sales', summary: 'Sipariş detayı ve durum özeti', permission: 'order.read',
      handler: async (c) => { assertUuid(c.params.id, 'Sipariş'); const v = await orderStatusView(c.db, c.params.id); c.assertFactory(v.factoryId); return v; } },
    { method: 'POST', path: '/api/v1/orders', tag: 'sales', summary: 'Sipariş oluştur (taslak)', permission: 'order.create', body: CreateSalesOrderReq,
      handler: async (c) => {
        const b = c.body as z.infer<typeof CreateSalesOrderReq>;
        c.assertFactory(b.factoryId);
        await one(c.db, 'SELECT id FROM customer WHERE id = $1 AND is_active', [b.customerId], 'Müşteri');
        const seen = new Set<string>();
        const resolved = [];
        for (const [i, l] of b.lines.entries()) {
          const key = `${l.modelId}/${l.colorId}/${l.sizeId}`;
          if (seen.has(key)) throw new AppError('VALIDATION_FAILED', 'Aynı varyant iki kez girilmiş', { line: i + 1 });
          seen.add(key);
          const v = (await c.db.query('SELECT id FROM product_variant WHERE model_id = $1 AND color_id = $2 AND size_id = $3', [l.modelId, l.colorId, l.sizeId])).rows[0];
          if (!v) throw new AppError('VALIDATION_FAILED', `Satır ${i + 1}: model/renk/beden varyantı tanımlı değil`, { line: i + 1 });
          resolved.push({ ...l, variantId: v.id as string });
        }
        const orderNo = await nextNumber(c.db, c.auth.orgId, `SO-${b.orderDate.slice(0, 4)}`, `SIP${b.orderDate.slice(2, 4)}`);
        const o = (await c.db.query(`INSERT INTO sales_order (organization_id, factory_id, order_no, customer_id, customer_po, currency, order_date, due_date, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [c.auth.orgId, b.factoryId, orderNo, b.customerId, b.customerPo ?? null, b.currency, b.orderDate, b.dueDate, b.notes ?? null, c.auth.userId])).rows[0];
        for (const [i, l] of resolved.entries()) {
          await c.db.query(`INSERT INTO sales_order_line (organization_id, sales_order_id, line_no, model_id, variant_id, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [c.auth.orgId, o.id, i + 1, l.modelId, l.variantId, l.quantity, l.unitPrice]);
        }
        const snap = await snapshot(c.db, o.id);
        await c.db.query('INSERT INTO sales_order_revision (organization_id, sales_order_id, revision, snapshot, reason, created_by) VALUES ($1,$2,1,$3,$4,$5)',
          [c.auth.orgId, o.id, snap, 'Oluşturuldu', c.auth.userId]);
        await c.audit('order.create', 'sales_order', o.id, null, snap);
        c.emit({ type: 'order.created', entityType: 'sales_order', entityId: o.id, data: { orderNo } });
        return orderStatusView(c.db, o.id);
      } },
    ...(['confirm', 'cancel'] as const).map((action): Route => ({
      method: 'POST', path: `/api/v1/orders/:id/${action}`, tag: 'sales', summary: action === 'confirm' ? 'Siparişi onayla' : 'Siparişi iptal et',
      permission: action === 'confirm' ? 'order.confirm' : 'order.cancel', body: TransitionReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'Sipariş');
        const cur = await one(c.db, 'SELECT * FROM sales_order WHERE id = $1 FOR UPDATE', [c.params.id], 'Sipariş');
        c.assertFactory(cur.factory_id);
        const t = findTransition(SALES_ORDER_TRANSITIONS, 'Sipariş', cur.status, action);
        if (action === 'cancel') {
          const active = (await c.db.query(`SELECT count(*)::int AS n FROM work_order WHERE sales_order_id = $1 AND status NOT IN ('PLANNED','CANCELLED')`, [cur.id])).rows[0].n;
          if (active) throw new AppError('PRECONDITION_FAILED', 'Serbest bırakılmış iş emri olan sipariş iptal edilemez');
        }
        const set: Record<string, unknown> = { status: t.to, revision: cur.revision + 1 };
        if (action === 'confirm') { set.confirmed_by = c.auth.userId; set.confirmed_at = new Date(); }
        const after = await updateVersioned(c.db, 'sales_order', cur.id, c.body.expectedVersion, set);
        const snap = await snapshot(c.db, cur.id);
        await c.db.query('INSERT INTO sales_order_revision (organization_id, sales_order_id, revision, snapshot, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
          [c.auth.orgId, cur.id, after.revision, snap, c.body.reason ?? (action === 'confirm' ? 'Onaylandı' : 'İptal edildi'), c.auth.userId]);
        await c.audit(`order.${action}`, 'sales_order', cur.id, { status: cur.status }, { status: t.to });
        c.emit({ type: 'order.updated', entityType: 'sales_order', entityId: cur.id, data: { status: t.to } });
        return { status: 200, body: await orderStatusView(c.db, cur.id) };
      },
    })),
  ];
}
