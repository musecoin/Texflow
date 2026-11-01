import { z } from 'zod/v4';
import type { Route } from '../http/kernel.ts';
import { camelAll } from '../lib.ts';

const AuditQuery = z.object({
  entityType: z.string().max(40).optional(), entityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/v1/audit', tag: 'core', summary: 'Denetim zaman çizelgesi (değiştirilemez)', permission: 'audit.read', query: AuditQuery,
      handler: async (c) => {
        const q = c.query as z.infer<typeof AuditQuery>;
        const params: unknown[] = []; const where: string[] = [];
        if (q.entityType) { params.push(q.entityType); where.push(`a.entity_type = $${params.length}`); }
        if (q.entityId) { params.push(q.entityId); where.push(`a.entity_id = $${params.length}`); }
        params.push(q.limit);
        const rows = (await c.db.query(`SELECT a.id, a.occurred_at, a.action, a.entity_type, a.entity_id, a.before_state, a.after_state, a.request_id, u.display_name AS actor_name
            FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY a.id DESC LIMIT $${params.length}`, params)).rows;
        return { items: camelAll(rows) };
      } },
    { method: 'GET', path: '/api/v1/dashboard', tag: 'analytics', summary: 'Gösterge paneli özet metrikleri (tanımlı formüllerle)', permission: 'order.read',
      handler: async (c) => {
        const orders = (await c.db.query(`SELECT status, count(*)::int AS n FROM sales_order GROUP BY status`)).rows;
        const rolls = (await c.db.query(`SELECT quality_status, count(*)::int AS n, coalesce(sum(physical_qty),0) AS qty FROM fabric_roll GROUP BY quality_status`)).rows;
        const wo = (await c.db.query(`SELECT status, count(*)::int AS n FROM work_order GROUP BY status`)).rows;
        const coverage = (await c.db.query(`SELECT count(*)::int AS lines, count(*) FILTER (WHERE wm.reserved_qty >= wm.required_qty)::int AS covered,
            coalesce(round(avg(least(wm.reserved_qty / wm.required_qty, 1)) * 100, 1), 0) AS pct FROM work_order_material wm
            JOIN work_order w ON w.id = wm.work_order_id WHERE w.status IN ('RELEASED','IN_PROGRESS')`)).rows[0];
        const dueSoon = (await c.db.query(`SELECT count(*)::int AS n FROM sales_order WHERE status IN ('CONFIRMED','IN_PRODUCTION') AND due_date <= current_date + 14`)).rows[0].n;
        const recent = camelAll((await c.db.query(`SELECT a.occurred_at, a.action, a.entity_type, a.entity_id, u.display_name AS actor_name FROM audit_event a
            LEFT JOIN app_user u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT 10`)).rows);
        // Layer-1 deterministic alerts: plain rules over current data, each naming its data source.
        const shortWos = camelAll((await c.db.query(`SELECT w.id, w.wo_no, count(*)::int AS short_lines FROM work_order w JOIN work_order_material wm ON wm.work_order_id = w.id
            WHERE w.status IN ('RELEASED','IN_PROGRESS') AND wm.reserved_qty < wm.required_qty GROUP BY w.id ORDER BY w.wo_no LIMIT 5`)).rows);
        const dueList = camelAll((await c.db.query(`SELECT id, order_no, due_date, status FROM sales_order WHERE status IN ('CONFIRMED','IN_PRODUCTION')
            AND due_date <= current_date + 14 ORDER BY due_date LIMIT 5`)).rows);
        const quarantine = rolls.find((r) => r.quality_status === 'QUARANTINE')?.n ?? 0;
        const alerts: { level: 'warn' | 'info' | 'ok'; text: string; link?: string; source: string }[] = [];
        if (quarantine) alerts.push({ level: 'warn', text: `${quarantine} top giriş kalite kontrolü bekliyor; karantinadaki stok rezerve edilemez.`, link: 'inventory', source: 'fabric_roll.quality_status' });
        for (const w of shortWos) alerts.push({ level: 'warn', text: `${w.woNo}: ${w.shortLines} malzeme satırında rezervasyon eksik.`, link: `work-orders/${w.id}`, source: 'work_order_material' });
        for (const o of dueList) alerts.push({ level: 'warn', text: `${o.orderNo} termini ${o.dueDate} — 14 gün içinde.`, link: `orders/${o.id}`, source: 'sales_order.due_date' });
        if (!alerts.length) alerts.push({ level: 'ok', text: 'Kural tabanlı kontrollerde açık uyarı yok.', source: 'kurallar' });
        const focus = (await c.db.query(`SELECT id FROM sales_order WHERE status IN ('IN_PRODUCTION','CONFIRMED') ORDER BY (status = 'IN_PRODUCTION') DESC, due_date LIMIT 1`)).rows[0]?.id ?? null;
        return {
          ordersByStatus: orders, rollsByStatus: rolls, workOrdersByStatus: wo, dueWithin14Days: dueSoon,
          materialCoverage: { lines: coverage.lines, coveredLines: coverage.covered, pct: coverage.pct },
          recentActivity: recent, alerts, focusOrderId: focus,
          kpiDefinitions: {
            materialCoverage: 'Malzeme satırları ortalaması: min(rezerve / ihtiyaç, 1) × 100 — farklı birimler toplanmaz (serbest bırakılmış ve devam eden iş emirleri)',
            dueWithin14Days: 'Onaylı veya üretimdeki siparişlerden termini 14 gün içinde olanlar',
          },
        };
      } },
  ];
}
