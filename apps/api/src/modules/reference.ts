import { CreateCustomerReq, CreateMaterialReq, AppError } from '@texflow/shared';
import type { Route } from '../http/kernel.ts';
import { camelAll, camel } from '../lib.ts';

export function referenceRoutes(): Route[] {
  return [
    { method: 'GET', path: '/api/v1/factories', tag: 'org', summary: 'Fabrikalar, hatlar ve depolar', permission: 'org.read',
      handler: async (c) => {
        const factories = camelAll((await c.db.query('SELECT id, code, name, timezone FROM factory WHERE is_active ORDER BY code')).rows)
          .filter((f) => !c.auth.factoryIds || c.auth.factoryIds.has(f.id));
        const warehouses = camelAll((await c.db.query(`SELECT w.id, w.factory_id, w.code, w.name, w.kind,
            coalesce(json_agg(json_build_object('id', b.id, 'code', b.code, 'isQuarantine', b.is_quarantine) ORDER BY b.code) FILTER (WHERE b.id IS NOT NULL), '[]') AS bins
          FROM warehouse w LEFT JOIN bin b ON b.warehouse_id = w.id GROUP BY w.id ORDER BY w.code`)).rows);
        const lines = camelAll((await c.db.query('SELECT id, factory_id, code, name FROM production_line ORDER BY code')).rows);
        return { factories, warehouses: warehouses.filter((w) => factories.some((f) => f.id === w.factoryId)), lines };
      } },
    { method: 'GET', path: '/api/v1/customers', tag: 'sales', summary: 'Müşteriler', permission: 'customer.read',
      handler: async (c) => ({ items: camelAll((await c.db.query('SELECT id, code, name, country, currency FROM customer WHERE is_active ORDER BY name')).rows) }) },
    { method: 'POST', path: '/api/v1/customers', tag: 'sales', summary: 'Müşteri oluştur', permission: 'customer.write', body: CreateCustomerReq,
      handler: async (c) => {
        const b = c.body;
        const r = (await c.db.query('INSERT INTO customer (organization_id, code, name, country, currency) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [c.auth.orgId, b.code, b.name, b.country ?? null, b.currency])).rows[0];
        await c.audit('customer.create', 'customer', r.id, null, r);
        return camel(r);
      } },
    { method: 'GET', path: '/api/v1/suppliers', tag: 'purchasing', summary: 'Tedarikçiler', permission: 'material.read',
      handler: async (c) => ({ items: camelAll((await c.db.query('SELECT id, code, name, country, currency FROM supplier WHERE is_active ORDER BY name')).rows) }) },
    { method: 'GET', path: '/api/v1/colors', tag: 'plm', summary: 'Renkler', permission: 'org.read',
      handler: async (c) => ({ items: camelAll((await c.db.query('SELECT id, code, name, pantone FROM color ORDER BY code')).rows) }) },
    { method: 'GET', path: '/api/v1/sizes', tag: 'plm', summary: 'Bedenler', permission: 'org.read',
      handler: async (c) => ({ items: camelAll((await c.db.query('SELECT id, code, sort_order FROM size ORDER BY sort_order, code')).rows) }) },
    { method: 'GET', path: '/api/v1/units', tag: 'core', summary: 'Birimler ve kesin dönüşümler', permission: null,
      handler: async (c) => ({
        units: camelAll((await c.db.query('SELECT code, name, dimension FROM unit ORDER BY code')).rows),
        conversions: camelAll((await c.db.query('SELECT from_unit, to_unit, factor FROM unit_conversion ORDER BY 1,2')).rows),
        note: 'kg↔m dönüşümü tabloda yoktur; yalnızca en ve gramaj (GSM) ile açık onayla hesaplanır.',
      }) },
    { method: 'GET', path: '/api/v1/inspection-plans', tag: 'quality', summary: 'Kumaş muayene planları', permission: 'material.read',
      handler: async (c) => ({ items: camelAll((await c.db.query('SELECT * FROM fabric_inspection_plan ORDER BY code')).rows) }) },
    { method: 'GET', path: '/api/v1/materials', tag: 'inventory', summary: 'Malzemeler', permission: 'material.read',
      handler: async (c) => ({ items: camelAll((await c.db.query(`SELECT m.id, m.code, m.name, m.kind, m.base_unit, m.width_cm, m.gsm, m.composition,
          m.inspection_plan_id, p.code AS inspection_plan_code, s.name AS default_supplier_name
          FROM material m LEFT JOIN fabric_inspection_plan p ON p.id = m.inspection_plan_id LEFT JOIN supplier s ON s.id = m.default_supplier_id
          WHERE m.is_active ORDER BY m.code`)).rows) }) },
    { method: 'POST', path: '/api/v1/materials', tag: 'inventory', summary: 'Malzeme tanımla', permission: 'material.write', body: CreateMaterialReq,
      handler: async (c) => {
        const b = c.body;
        if (b.kind === 'FABRIC' && !['M', 'KG', 'YD'].includes(b.baseUnit)) throw new AppError('VALIDATION_FAILED', 'Kumaş ana birimi M, YD veya KG olmalı');
        const r = (await c.db.query(`INSERT INTO material (organization_id, code, name, kind, base_unit, width_cm, gsm, composition, default_supplier_id, inspection_plan_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [c.auth.orgId, b.code, b.name, b.kind, b.baseUnit, b.widthCm ?? null, b.gsm ?? null, b.composition ?? null, b.defaultSupplierId ?? null, b.inspectionPlanId ?? null])).rows[0];
        await c.audit('material.create', 'material', r.id, null, r);
        return camel(r);
      } },
  ];
}
