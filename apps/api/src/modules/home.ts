/**
 * Role-based home screens (TEXFLOW 3.1). One read-only endpoint returns the blocks a user may see:
 * every block is gated by a permission and every query is limited to the user's factory scope.
 * Metrics that the system does not record yet (actual output, defects, downtime, cost) are returned
 * as `measured: false` instead of being estimated.
 */
import { z } from 'zod/v4';
import type { Route, Ctx } from '../http/kernel.ts';
import { camelAll } from '../lib.ts';

export const PANELS = ['factory', 'production', 'warehouse', 'operator'] as const;
export type Panel = (typeof PANELS)[number];
const PANEL_PERM: Record<Panel, string[]> = {
  factory: ['order.read'], production: ['workorder.read'], warehouse: ['inventory.read'], operator: ['workorder.read', 'inventory.read'],
};
/** Default home per role code; first matching role wins, then the first allowed panel. */
const ROLE_DEFAULT: Record<string, Panel> = {
  OPERATOR: 'operator', WAREHOUSE: 'warehouse', QC_INSPECTOR: 'warehouse', INVENTORY_CONTROLLER: 'warehouse',
  PRODUCTION_MANAGER: 'production', PLANNER: 'production', FACTORY_MANAGER: 'factory', ADMIN: 'factory', VIEWER: 'factory', TECH_MANAGER: 'factory', TECHNOLOGIST: 'factory',
};
const ROLE_PRIORITY = ['OPERATOR', 'WAREHOUSE', 'QC_INSPECTOR', 'INVENTORY_CONTROLLER', 'PRODUCTION_MANAGER', 'PLANNER', 'FACTORY_MANAGER', 'ADMIN', 'TECH_MANAGER', 'TECHNOLOGIST', 'VIEWER'];

const HomeQuery = z.object({
  factoryId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
  woStatus: z.enum(['PLANNED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
});

const OPEN_WO = `('RELEASED','IN_PROGRESS')`;
const ACTIVE_SO = `('CONFIRMED','IN_PRODUCTION')`;

export function homeRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/v1/home', tag: 'analytics', summary: 'Rol bazlı ana ekran verisi (yetki ve fabrika kapsamına göre)', permission: 'org.read', query: HomeQuery,
      handler: async (c) => {
        const q = c.query as z.infer<typeof HomeQuery>;
        if (q.factoryId) c.assertFactory(q.factoryId);
        // null = all factories of the organization (unrestricted user)
        const scope: string[] | null = q.factoryId ? [q.factoryId] : c.auth.factoryIds ? [...c.auth.factoryIds] : null;
        const db = c.db; const S = [scope];
        const panels = PANELS.filter((p) => PANEL_PERM[p].some((perm) => c.can(perm)));
        const roleCodes = (await db.query<{ code: string }>(`SELECT DISTINCT r.code FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1`, [c.auth.userId])).rows.map((r) => r.code);
        const roleDefault = ROLE_PRIORITY.filter((r) => roleCodes.includes(r)).map((r) => ROLE_DEFAULT[r]).find((p) => panels.includes(p));
        const factories = camelAll((await db.query(`SELECT id, code, name, timezone FROM factory WHERE is_active AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY code`,
          [c.auth.factoryIds ? [...c.auth.factoryIds] : null])).rows);
        const out: Record<string, unknown> = {
          generatedAt: new Date().toISOString(), panels, defaultPanel: roleDefault ?? panels[0] ?? null,
          scope: { factories, selectedFactoryId: q.factoryId ?? null, restricted: !!c.auth.factoryIds },
        };
        const alerts: { level: 'warn' | 'ok'; text: string; link?: string; source: string }[] = [];

        if (c.can('order.read')) {
          const o = (await db.query(`SELECT
              count(*) FILTER (WHERE status IN ${ACTIVE_SO})::int AS active,
              count(*) FILTER (WHERE status = 'DRAFT')::int AS draft,
              count(*) FILTER (WHERE status IN ${ACTIVE_SO} AND due_date < current_date)::int AS delayed,
              count(*) FILTER (WHERE status IN ${ACTIVE_SO} AND due_date >= current_date AND due_date <= current_date + 14)::int AS due_soon
            FROM sales_order WHERE ($1::uuid[] IS NULL OR factory_id = ANY($1::uuid[]))`, S)).rows[0];
          const risky = camelAll((await db.query(`SELECT so.id, so.order_no, so.due_date, so.status, cu.name AS customer_name, (so.due_date < current_date) AS delayed,
              (so.due_date - current_date) AS days_left
            FROM sales_order so JOIN customer cu ON cu.id = so.customer_id
            WHERE so.status IN ${ACTIVE_SO} AND so.due_date <= current_date + 14 AND ($1::uuid[] IS NULL OR so.factory_id = ANY($1::uuid[]))
            ORDER BY so.due_date LIMIT 8`, S)).rows);
          const orderList = camelAll((await db.query(`SELECT id, order_no FROM sales_order WHERE status IN ('CONFIRMED','IN_PRODUCTION','COMPLETED')
            AND ($1::uuid[] IS NULL OR factory_id = ANY($1::uuid[])) ORDER BY order_no DESC LIMIT 50`, S)).rows);
          const focus = (await db.query(`SELECT id FROM sales_order WHERE status IN ${ACTIVE_SO} AND ($1::uuid[] IS NULL OR factory_id = ANY($1::uuid[]))
            ORDER BY (status = 'IN_PRODUCTION') DESC, due_date LIMIT 1`, S)).rows[0]?.id ?? null;
          // commercial values only for users who may see customers; never summed across currencies
          const value = c.can('customer.read') ? camelAll((await db.query(`SELECT so.currency, sum(l.quantity * l.unit_price) AS amount, count(DISTINCT so.id)::int AS orders
              FROM sales_order so JOIN sales_order_line l ON l.sales_order_id = so.id
              WHERE so.status IN ${ACTIVE_SO} AND ($1::uuid[] IS NULL OR so.factory_id = ANY($1::uuid[])) GROUP BY so.currency ORDER BY so.currency`, S)).rows) : null;
          out.orders = { active: o.active, draft: o.draft, delayed: o.delayed, dueSoon: o.due_soon, risky, options: orderList, focusOrderId: focus, activeValueByCurrency: value };
          for (const r of risky) alerts.push({ level: 'warn', text: r.delayed ? `${r.orderNo} termini geçti (${r.dueDate}).` : `${r.orderNo} termini ${r.daysLeft} gün sonra.`, link: `orders/${r.id}`, source: 'sales_order.due_date' });
        }

        if (c.can('workorder.read')) {
          const p: unknown[] = [scope]; const where = ['($1::uuid[] IS NULL OR w.factory_id = ANY($1::uuid[]))'];
          if (q.salesOrderId) { p.push(q.salesOrderId); where.push(`w.sales_order_id = $${p.length}`); }
          const byStatus = (await db.query(`SELECT w.status, count(*)::int AS n FROM work_order w WHERE ${where.join(' AND ')} GROUP BY w.status`, p)).rows;
          const plannedOpen = camelAll((await db.query(`SELECT w.unit, sum(w.planned_qty) AS qty, count(*)::int AS n FROM work_order w WHERE w.status IN ${OPEN_WO} AND ${where.join(' AND ')} GROUP BY w.unit`, p)).rows);
          const listWhere = [...where]; const lp = [...p];
          if (q.woStatus) { lp.push(q.woStatus); listWhere.push(`w.status = $${lp.length}`); } else listWhere.push(`w.status IN ('PLANNED','RELEASED','IN_PROGRESS')`);
          const list = camelAll((await db.query(`SELECT w.id, w.wo_no, w.status, w.planned_qty, w.unit, w.planned_start, w.planned_end, so.order_no, m.code AS model_code, col.code AS color_code, f.code AS factory_code,
              (SELECT round(avg(least(x.reserved_qty / x.required_qty, 1)) * 100, 1) FROM work_order_material x WHERE x.work_order_id = w.id) AS coverage_pct
            FROM work_order w JOIN sales_order so ON so.id = w.sales_order_id JOIN product_model m ON m.id = w.model_id JOIN color col ON col.id = w.color_id JOIN factory f ON f.id = w.factory_id
            WHERE ${listWhere.join(' AND ')} ORDER BY (w.status = 'IN_PROGRESS') DESC, (w.status = 'RELEASED') DESC, w.planned_end NULLS LAST, w.wo_no LIMIT 20`, lp)).rows);
          const cov = (await db.query(`SELECT count(*)::int AS lines, count(*) FILTER (WHERE wm.reserved_qty >= wm.required_qty)::int AS covered,
              coalesce(round(avg(least(wm.reserved_qty / wm.required_qty, 1)) * 100, 1), 0) AS pct
            FROM work_order_material wm JOIN work_order w ON w.id = wm.work_order_id WHERE w.status IN ${OPEN_WO} AND ${where.join(' AND ')}`, p)).rows[0];
          const short = camelAll((await db.query(`SELECT w.id, w.wo_no, count(*)::int AS short_lines FROM work_order w JOIN work_order_material wm ON wm.work_order_id = w.id
            WHERE w.status IN ${OPEN_WO} AND wm.reserved_qty < wm.required_qty AND ${where.join(' AND ')} GROUP BY w.id ORDER BY w.wo_no LIMIT 5`, p)).rows);
          out.workOrders = { byStatus, plannedOpen, list, materialCoverage: { lines: cov.lines, coveredLines: cov.covered, pct: cov.pct } };
          for (const w of short) alerts.push({ level: 'warn', text: `${w.woNo}: ${w.shortLines} malzeme satırında rezervasyon eksik.`, link: `work-orders/${w.id}`, source: 'work_order_material' });
        }

        if (c.can('inventory.read')) {
          const rollScope = '($1::uuid[] IS NULL OR wh.factory_id = ANY($1::uuid[]))';
          const byStatus = (await db.query(`SELECT r.quality_status AS status, count(*)::int AS n FROM fabric_roll r JOIN warehouse wh ON wh.id = r.warehouse_id WHERE ${rollScope} GROUP BY r.quality_status`, S)).rows;
          // quantities per unit and status — metres and kilograms are never added together
          const qty = camelAll((await db.query(`SELECT r.unit, r.quality_status AS status, sum(r.physical_qty) AS physical, sum(r.reserved_qty) AS reserved, sum(r.physical_qty - r.reserved_qty) AS available, count(*)::int AS rolls
            FROM fabric_roll r JOIN warehouse wh ON wh.id = r.warehouse_id WHERE ${rollScope} AND r.physical_qty > 0 GROUP BY r.unit, r.quality_status ORDER BY r.unit, r.quality_status`, S)).rows);
          const lots = (await db.query(`SELECT count(DISTINCT r.lot_id)::int AS n FROM fabric_roll r JOIN warehouse wh ON wh.id = r.warehouse_id WHERE ${rollScope} AND r.physical_qty > 0`, S)).rows[0].n;
          const locations = camelAll((await db.query(`SELECT wh.code AS warehouse_code, coalesce(b.code, '—') AS bin_code, b.is_quarantine, count(r.id)::int AS rolls
            FROM fabric_roll r JOIN warehouse wh ON wh.id = r.warehouse_id LEFT JOIN bin b ON b.id = r.bin_id WHERE ${rollScope} AND r.physical_qty > 0
            GROUP BY wh.code, b.code, b.is_quarantine ORDER BY wh.code, b.code LIMIT 12`, S)).rows);
          const receipts = camelAll((await db.query(`SELECT gr.id, gr.receipt_no, gr.received_at, s.name AS supplier_name, count(r.id)::int AS rolls
            FROM goods_receipt gr JOIN supplier s ON s.id = gr.supplier_id LEFT JOIN fabric_roll r ON r.goods_receipt_id = gr.id
            WHERE ($1::uuid[] IS NULL OR gr.factory_id = ANY($1::uuid[])) GROUP BY gr.id, s.name ORDER BY gr.received_at DESC LIMIT 5`, S)).rows);
          const movements = camelAll((await db.query(`SELECT im.id, im.movement_type, im.occurred_at, im.qty_delta, im.reserved_delta, im.unit, r.roll_no, r.id AS roll_id
            FROM inventory_movement im LEFT JOIN fabric_roll r ON r.id = im.roll_id WHERE ($1::uuid[] IS NULL OR im.factory_id = ANY($1::uuid[])) ORDER BY im.id DESC LIMIT 8`, S)).rows);
          const consumption = camelAll((await db.query(`SELECT unit, sum(-qty_delta) AS qty FROM inventory_movement WHERE movement_type = 'ISSUE' AND occurred_at >= now() - interval '30 days'
            AND ($1::uuid[] IS NULL OR factory_id = ANY($1::uuid[])) GROUP BY unit`, S)).rows);
          const insp = (await db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE mi.result = 'PASS')::int AS passed, count(*) FILTER (WHERE mi.result = 'FAIL')::int AS failed
            FROM material_inspection mi JOIN fabric_roll r ON r.id = mi.roll_id JOIN warehouse wh ON wh.id = r.warehouse_id
            WHERE mi.inspected_at >= now() - interval '30 days' AND ${rollScope}`, S)).rows[0];
          out.inventory = { rollsByStatus: byStatus, qtyByUnit: qty, activeLots: lots, locations, recentReceipts: receipts, recentMovements: movements, consumption30d: consumption };
          out.quality = { inspections30d: insp.total, passed: insp.passed, failed: insp.failed, passRatePct: insp.total ? Math.round((insp.passed / insp.total) * 1000) / 10 : null };
          const quarantine = byStatus.find((r) => r.status === 'QUARANTINE')?.n ?? 0;
          if (quarantine) alerts.unshift({ level: 'warn', text: `${quarantine} top giriş kalite kontrolü bekliyor; karantinadaki stok rezerve edilemez.`, link: 'inventory', source: 'fabric_roll.quality_status' });
        }

        // production structure exists (lines, machines, shifts); actual output is not recorded yet
        const lines = camelAll((await db.query(`SELECT pl.id, pl.code, pl.name, f.code AS factory_code,
            (SELECT count(*)::int FROM workstation ws WHERE ws.production_line_id = pl.id) AS workstations
          FROM production_line pl JOIN factory f ON f.id = pl.factory_id WHERE ($1::uuid[] IS NULL OR pl.factory_id = ANY($1::uuid[])) ORDER BY f.code, pl.code`, S)).rows);
        const machines = (await db.query(`SELECT count(*)::int AS n FROM machine WHERE ($1::uuid[] IS NULL OR factory_id = ANY($1::uuid[]))`, S)).rows[0].n;
        // current shift in each factory's own time zone
        const shifts = camelAll((await db.query(`SELECT s.code, s.name, s.starts_at, s.ends_at, f.code AS factory_code,
            CASE WHEN s.starts_at <= s.ends_at THEN (now() AT TIME ZONE f.timezone)::time BETWEEN s.starts_at AND s.ends_at
                 ELSE (now() AT TIME ZONE f.timezone)::time >= s.starts_at OR (now() AT TIME ZONE f.timezone)::time <= s.ends_at END AS is_current
          FROM shift s JOIN factory f ON f.id = s.factory_id WHERE ($1::uuid[] IS NULL OR s.factory_id = ANY($1::uuid[])) ORDER BY f.code, s.starts_at`, S)).rows);
        out.production = {
          lines, machines, shifts, measured: false,
          notMeasured: ['Gerçekleşen üretim (sağlam adet)', 'Hatalı / tamir / hurda adet', 'WIP', 'Makine duruşları', 'Hat verimliliği ve darboğaz'],
          reason: 'Üretim kaydı (istasyon okutma, adet, duruş) Faz D ile başlar; o zamana kadar bu değerler tahmin edilmez.',
        };
        out.cost = { measured: false, reason: 'Maliyet ve kârlılık Faz E ile gelir; şu an maliyet kaydı yok.' };
        if (!alerts.length) alerts.push({ level: 'ok', text: 'Kural tabanlı kontrollerde açık uyarı yok.', source: 'kurallar' });
        out.alerts = alerts.slice(0, 8);
        return out;
      } },
  ];
}

export type { Ctx };
