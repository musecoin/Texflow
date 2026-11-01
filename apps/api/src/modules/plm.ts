import { z } from 'zod/v4';
import { AppError, CreateModelReq, CreateBomReq, TransitionReq, PageQuery, findTransition, allowedActions, MODEL_TRANSITIONS, BOM_TRANSITIONS,
  UNIT_DIMENSION, type UnitCode, type ModelStatus } from '@texflow/shared';
import type { Connection } from '@texflow/db';
import type { Route } from '../http/kernel.ts';
import { one, assertUuid, updateVersioned, page, camel, camelAll } from '../lib.ts';

async function orgSetting(db: Connection, key: string): Promise<unknown> {
  const r = await db.query<{ v: unknown }>('SELECT settings -> $1 AS v FROM organization WHERE id = tf_current_org()', [key]);
  return r.rows[0]?.v ?? null;
}

async function bomView(db: Connection, bomId: string) {
  const b = await one(db, `SELECT b.*, m.code AS model_code, m.name AS model_name FROM bom b JOIN product_model m ON m.id = b.model_id WHERE b.id = $1`, [bomId], 'Reçete');
  const items = (await db.query(`SELECT i.id, i.material_id, mt.code AS material_code, mt.name AS material_name, mt.kind AS material_kind, mt.base_unit,
      i.color_id, col.code AS color_code, i.placement, i.consumption_per_piece, i.unit, i.waste_pct
      FROM bom_item i JOIN material mt ON mt.id = i.material_id LEFT JOIN color col ON col.id = i.color_id WHERE i.bom_id = $1 ORDER BY mt.code`, [bomId])).rows;
  return { ...camel(b), items: camelAll(items), allowedActions: b.status === 'DRAFT' ? ['approve'] : [] };
}

async function modelView(db: Connection, id: string) {
  const m = await one(db, `SELECT m.*, c.name AS customer_name FROM product_model m LEFT JOIN customer c ON c.id = m.customer_id WHERE m.id = $1`, [id], 'Model');
  const variants = (await db.query(`SELECT v.id, v.sku, v.color_id, col.code AS color_code, col.name AS color_name, v.size_id, s.code AS size_code
      FROM product_variant v JOIN color col ON col.id = v.color_id JOIN size s ON s.id = v.size_id WHERE v.model_id = $1 ORDER BY col.code, s.sort_order`, [id])).rows;
  const boms = (await db.query('SELECT id, version, status, created_at, approved_at, row_version FROM bom WHERE model_id = $1 ORDER BY version DESC', [id])).rows;
  return { ...camel(m), variants: camelAll(variants), boms: camelAll(boms), allowedActions: allowedActions(MODEL_TRANSITIONS, m.status as ModelStatus) };
}

export function plmRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/v1/models', tag: 'plm', summary: 'Model listesi', permission: 'model.read', query: PageQuery,
      handler: async (c) => {
        const q = c.query as z.infer<typeof PageQuery>;
        const params: unknown[] = []; const where: string[] = [];
        if (q.status) { params.push(q.status); where.push(`m.status = $${params.length}`); }
        if (q.q) { params.push('%' + q.q.replace(/[%_]/g, '\\$&') + '%'); where.push(`(m.code ILIKE $${params.length} OR m.name ILIKE $${params.length})`); }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const total = (await c.db.query<{ n: number }>(`SELECT count(*)::int n FROM product_model m ${w}`, params)).rows[0].n;
        params.push(q.limit, q.offset);
        const rows = (await c.db.query(`SELECT m.id, m.code, m.name, m.status, m.season, m.revision, m.row_version, c.name AS customer_name,
            (SELECT count(*)::int FROM product_variant v WHERE v.model_id = m.id) AS variant_count,
            (SELECT max(version) FROM bom b WHERE b.model_id = m.id AND b.status = 'APPROVED') AS approved_bom_version
            FROM product_model m LEFT JOIN customer c ON c.id = m.customer_id ${w} ORDER BY m.code LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
        return page(camelAll(rows), total, q);
      } },
    { method: 'GET', path: '/api/v1/models/:id', tag: 'plm', summary: 'Model detayı, varyantlar ve reçete sürümleri', permission: 'model.read',
      handler: async (c) => { assertUuid(c.params.id, 'Model'); return modelView(c.db, c.params.id); } },
    { method: 'POST', path: '/api/v1/models', tag: 'plm', summary: 'Model oluştur (renk × beden varyantlarıyla)', permission: 'model.write', body: CreateModelReq,
      handler: async (c) => {
        const b = c.body as z.infer<typeof CreateModelReq>;
        const m = (await c.db.query(`INSERT INTO product_model (organization_id, code, name, customer_id, season, product_type, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [c.auth.orgId, b.code, b.name, b.customerId ?? null, b.season ?? null, b.productType ?? null, c.auth.userId])).rows[0];
        const colors = (await c.db.query('SELECT id, code FROM color WHERE id = ANY($1::uuid[])', [b.colorIds])).rows;
        const sizes = (await c.db.query('SELECT id, code FROM size WHERE id = ANY($1::uuid[])', [b.sizeIds])).rows;
        if (colors.length !== new Set(b.colorIds).size || sizes.length !== new Set(b.sizeIds).size) throw new AppError('VALIDATION_FAILED', 'Geçersiz renk veya beden');
        for (const col of colors) for (const s of sizes) {
          await c.db.query('INSERT INTO product_variant (organization_id, model_id, color_id, size_id, sku) VALUES ($1,$2,$3,$4,$5)',
            [c.auth.orgId, m.id, col.id, s.id, `${b.code}-${col.code}-${s.code}`]);
        }
        await c.audit('model.create', 'product_model', m.id, null, { ...m, colors: b.colorIds, sizes: b.sizeIds });
        return modelView(c.db, m.id);
      } },
    ...(['submit', 'approve', 'reject'] as const).map((action): Route => ({
      method: 'POST', path: `/api/v1/models/:id/${action}`, tag: 'plm', summary: { submit: 'Teknik onaya gönder', approve: 'Teknik onay ver', reject: 'Teknik onayı reddet' }[action],
      permission: action === 'submit' ? 'model.write' : 'model.approve', body: TransitionReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'Model');
        const cur = await one(c.db, 'SELECT * FROM product_model WHERE id = $1 FOR UPDATE', [c.params.id], 'Model');
        const t = findTransition(MODEL_TRANSITIONS, 'Model', cur.status, action);
        const set: Record<string, unknown> = { status: t.to };
        if (action === 'approve') { set.approved_by = c.auth.userId; set.approved_at = new Date(); }
        await updateVersioned(c.db, 'product_model', cur.id, c.body.expectedVersion, set);
        await c.audit(`model.${action}`, 'product_model', cur.id, { status: cur.status }, { status: t.to, reason: c.body.reason });
        return { status: 200, body: await modelView(c.db, cur.id) };
      },
    })),
    { method: 'POST', path: '/api/v1/models/:id/boms', tag: 'plm', summary: 'Yeni reçete (BOM) sürümü oluştur', permission: 'bom.write', body: CreateBomReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'Model');
        const model = await one(c.db, 'SELECT * FROM product_model WHERE id = $1 FOR UPDATE', [c.params.id], 'Model');
        if (model.status === 'ARCHIVED') throw new AppError('PRECONDITION_FAILED', 'Arşivlenmiş modele reçete eklenemez');
        const b = c.body as z.infer<typeof CreateBomReq>;
        const mats = new Map((await c.db.query('SELECT id, code, base_unit FROM material WHERE id = ANY($1::uuid[])', [b.items.map((i) => i.materialId)])).rows.map((r) => [r.id, r]));
        for (const [i, it] of b.items.entries()) {
          const mat = mats.get(it.materialId);
          if (!mat) throw new AppError('VALIDATION_FAILED', `Kalem ${i + 1}: malzeme bulunamadı`);
          if (UNIT_DIMENSION[it.unit as UnitCode] !== UNIT_DIMENSION[mat.base_unit as UnitCode]) {
            throw new AppError('UNIT_CONVERSION_NOT_ALLOWED', `Kalem ${i + 1}: ${it.unit} birimi malzemenin ana birimi ${mat.base_unit} ile uyumsuz (örn. kg↔m için GSM/en gerekir)`, { item: i + 1 });
          }
        }
        const version = ((await c.db.query<{ v: number | null }>('SELECT max(version) AS v FROM bom WHERE model_id = $1', [model.id])).rows[0].v ?? 0) + 1;
        const bom = (await c.db.query('INSERT INTO bom (organization_id, model_id, version, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [c.auth.orgId, model.id, version, b.notes ?? null, c.auth.userId])).rows[0];
        for (const it of b.items) {
          await c.db.query(`INSERT INTO bom_item (organization_id, bom_id, material_id, color_id, placement, consumption_per_piece, unit, waste_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [c.auth.orgId, bom.id, it.materialId, it.colorId ?? null, it.placement ?? null, it.consumptionPerPiece, it.unit, it.wastePct]);
        }
        const view = await bomView(c.db, bom.id);
        await c.audit('bom.create', 'bom', bom.id, null, view);
        return view;
      } },
    { method: 'GET', path: '/api/v1/boms/:id', tag: 'plm', summary: 'Reçete detayı', permission: 'bom.read',
      handler: async (c) => { assertUuid(c.params.id, 'Reçete'); return bomView(c.db, c.params.id); } },
    { method: 'POST', path: '/api/v1/boms/:id/approve', tag: 'plm', summary: 'Reçeteyi onayla (önceki onaylı sürüm OBSOLETE olur)', permission: 'bom.approve', body: TransitionReq,
      handler: async (c) => {
        assertUuid(c.params.id, 'Reçete');
        const cur = await one(c.db, 'SELECT * FROM bom WHERE id = $1 FOR UPDATE', [c.params.id], 'Reçete');
        findTransition(BOM_TRANSITIONS, 'Reçete', cur.status, 'approve');
        const model = await one(c.db, 'SELECT status FROM product_model WHERE id = $1 FOR UPDATE', [cur.model_id], 'Model');
        if (model.status !== 'TECH_APPROVED') throw new AppError('PRECONDITION_FAILED', 'Reçete onayı için model teknik onaylı olmalı');
        if (cur.created_by === c.auth.userId && (await orgSetting(c.db, 'allowSelfApproval')) !== true) {
          throw new AppError('SELF_APPROVAL_FORBIDDEN', 'Reçeteyi oluşturan kişi onaylayamaz (görevler ayrılığı)');
        }
        const items = (await c.db.query<{ n: number }>('SELECT count(*)::int AS n FROM bom_item WHERE bom_id = $1', [cur.id])).rows[0].n;
        if (!items) throw new AppError('PRECONDITION_FAILED', 'Boş reçete onaylanamaz');
        const prev = await c.db.query(`UPDATE bom SET status = 'OBSOLETE', row_version = row_version + 1 WHERE model_id = $1 AND status = 'APPROVED' RETURNING id, version`, [cur.model_id]);
        await updateVersioned(c.db, 'bom', cur.id, c.body.expectedVersion, { status: 'APPROVED', approved_by: c.auth.userId, approved_at: new Date() });
        await c.audit('bom.approve', 'bom', cur.id, { status: cur.status }, { status: 'APPROVED', obsoleted: prev.rows });
        return { status: 200, body: await bomView(c.db, cur.id) };
      } },
  ];
}
