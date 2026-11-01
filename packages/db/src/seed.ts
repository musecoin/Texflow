/**
 * DEMO seed. Every organization, partner, material and plan created here is labelled DEMO.
 * Acceptance limits and exchange rates in this file are placeholders, NOT industry standards
 * or real market data; configure your own before production use.
 *
 *   node packages/db/src/seed.ts
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection, parseDatabaseUrl } from './pg.ts';
import { loadDbEnv } from './env.ts';
import { hashPassword } from './password.ts';

export const ROLE_PERMISSIONS: Record<string, { name: string; perms: string[] | '*' }> = {
  ADMIN: { name: 'Sistem Yöneticisi', perms: '*' },
  PLANNER: { name: 'Planlama', perms: ['org.read', 'customer.read', 'customer.write', 'order.read', 'order.create', 'order.confirm', 'order.cancel', 'model.read', 'bom.read',
    'material.read', 'inventory.read', 'workorder.read', 'workorder.create', 'workorder.release', 'reservation.create', 'reservation.release'] },
  TECHNOLOGIST: { name: 'Teknik Ofis / Modelhane', perms: ['org.read', 'customer.read', 'order.read', 'model.read', 'model.write', 'bom.read', 'bom.write', 'material.read', 'material.write'] },
  TECH_MANAGER: { name: 'Teknik Müdür', perms: ['org.read', 'customer.read', 'order.read', 'model.read', 'model.write', 'model.approve', 'bom.read', 'bom.write', 'bom.approve', 'material.read'] },
  WAREHOUSE: { name: 'Depo', perms: ['org.read', 'material.read', 'inventory.read', 'inventory.receive', 'inventory.adjust.request', 'workorder.read', 'reservation.create', 'order.read'] },
  QC_INSPECTOR: { name: 'Kalite Kontrol', perms: ['org.read', 'material.read', 'inventory.read', 'inventory.inspect'] },
  INVENTORY_CONTROLLER: { name: 'Stok Kontrol (onay)', perms: ['org.read', 'material.read', 'inventory.read', 'inventory.adjust.approve', 'audit.read'] },
  VIEWER: { name: 'Salt Okunur', perms: ['org.read', 'customer.read', 'order.read', 'model.read', 'bom.read', 'material.read', 'inventory.read', 'workorder.read'] },
};

export interface SeededOrg {
  orgId: string; factoryId: string; factory2Id: string; fabricWarehouseId: string; quarantineBinId: string; binA1Id: string;
  customerId: string; supplierId: string; colors: Record<string, string>; sizes: Record<string, string>;
  materials: { jersey: string; rib: string; label: string }; planId: string;
  users: Record<string, { id: string; email: string }>;
  demoModelId?: string;
}

/** Creates a complete organization skeleton. Used by the DEMO seed and by integration tests. */
export async function seedOrganization(c: Connection, o: { code: string; name: string; isDemo: boolean; password: string; emailDomain: string; settings?: Record<string, unknown>; withDemoModel?: boolean }): Promise<SeededOrg> {
  const orgId = crypto.randomUUID();
  await c.query('BEGIN');
  try {
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const tag = o.isDemo ? 'DEMO ' : '';
    await c.query('INSERT INTO organization (id, code, name, base_currency, is_demo, settings) VALUES ($1,$2,$3,$4,$5,$6)',
      [orgId, o.code, o.name, 'TRY', o.isDemo, o.settings ?? {}]);
    const ins = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0]?.id as string;
    const factoryId = await ins('INSERT INTO factory (organization_id, code, name) VALUES ($1,$2,$3) RETURNING id', [orgId, 'IST1', `${tag}İstanbul Entegre Tesis`]);
    const factory2Id = await ins('INSERT INTO factory (organization_id, code, name) VALUES ($1,$2,$3) RETURNING id', [orgId, 'BUR1', `${tag}Bursa Dikim Tesisi`]);
    for (const [code, name, kind] of [['DEPO', 'Hammadde Depo', 'WAREHOUSE'], ['KK', 'Kalite Kontrol', 'QC'], ['KESIM', 'Kesimhane', 'CUTTING'], ['BASKI', 'Baskı & Nakış', 'DECORATION'], ['DIKIM', 'Dikimhane', 'SEWING'], ['PAKET', 'Paketleme', 'PACKING']]) {
      await c.query('INSERT INTO department (organization_id, factory_id, code, name, kind) VALUES ($1,$2,$3,$4,$5)', [orgId, factoryId, code, name, kind]);
    }
    await c.query(`INSERT INTO shift (organization_id, factory_id, code, name, starts_at, ends_at) VALUES ($1,$2,'S1','Sabah','07:30','15:30'), ($1,$2,'S2','Akşam','15:30','23:30')`, [orgId, factoryId]);
    for (const [fid, codes] of [[factoryId, ['HAT-01', 'HAT-02']], [factory2Id, ['HAT-B1']]] as const) {
      for (const code of codes) {
        const line = await ins('INSERT INTO production_line (organization_id, factory_id, code, name) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, fid, code, `Dikim ${code}`]);
        for (let i = 1; i <= 3; i++) {
          const ws = await ins('INSERT INTO workstation (organization_id, factory_id, production_line_id, code, name) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, fid, line, `${code}-I${i}`, `${code} İstasyon ${i}`]);
          await c.query('INSERT INTO machine (organization_id, factory_id, workstation_id, code, name, machine_type) VALUES ($1,$2,$3,$4,$5,$6)', [orgId, fid, ws, `${code}-M${i}`, `${tag}Overlok ${i}`, 'OVERLOCK']);
        }
      }
    }
    const fabricWarehouseId = await ins(`INSERT INTO warehouse (organization_id, factory_id, code, name, kind) VALUES ($1,$2,'KMS-IST','Kumaş Deposu','FABRIC') RETURNING id`, [orgId, factoryId]);
    await c.query(`INSERT INTO warehouse (organization_id, factory_id, code, name, kind) VALUES ($1,$2,'AKS-IST','Aksesuar Deposu','TRIM'), ($1,$2,'MAM-IST','Mamul Deposu','FINISHED_GOODS'), ($1,$3,'KMS-BUR','Bursa Kumaş Deposu','FABRIC')`, [orgId, factoryId, factory2Id]);
    const quarantineBinId = await ins(`INSERT INTO bin (organization_id, warehouse_id, code, is_quarantine) VALUES ($1,$2,'KARANTINA',true) RETURNING id`, [orgId, fabricWarehouseId]);
    const binA1Id = await ins(`INSERT INTO bin (organization_id, warehouse_id, code) VALUES ($1,$2,'A-01') RETURNING id`, [orgId, fabricWarehouseId]);
    await c.query(`INSERT INTO bin (organization_id, warehouse_id, code) VALUES ($1,$2,'A-02')`, [orgId, fabricWarehouseId]);

    // roles & users
    const allPerms = (await c.query<{ code: string }>('SELECT code FROM permission')).rows.map((r) => r.code);
    const roleIds: Record<string, string> = {};
    for (const [code, def] of Object.entries(ROLE_PERMISSIONS)) {
      roleIds[code] = await ins('INSERT INTO role (organization_id, code, name, is_system) VALUES ($1,$2,$3,true) RETURNING id', [orgId, code, def.name]);
      for (const p of def.perms === '*' ? allPerms : def.perms) await c.query('INSERT INTO role_permission (organization_id, role_id, permission_code) VALUES ($1,$2,$3)', [orgId, roleIds[code], p]);
    }
    const pwHash = await hashPassword(o.password);
    const users: SeededOrg['users'] = {};
    const userDefs: [string, string, string, string | null][] = [
      ['admin', 'Sistem Yöneticisi', 'ADMIN', null], ['planlama', 'Planlama Uzmanı', 'PLANNER', null], ['teknik', 'Modelist / Teknik Ofis', 'TECHNOLOGIST', null],
      ['teknikmudur', 'Teknik Müdür', 'TECH_MANAGER', null], ['depo', 'Depo Sorumlusu', 'WAREHOUSE', factoryId], ['kalite', 'Kalite Kontrol Uzmanı', 'QC_INSPECTOR', factoryId],
      ['stokkontrol', 'Stok Kontrol', 'INVENTORY_CONTROLLER', null], ['izleyici', 'İzleyici', 'VIEWER', null], ['bursadepo', 'Bursa Depo', 'WAREHOUSE', factory2Id],
    ];
    for (const [key, name, role, fid] of userDefs) {
      const email = `${key}@${o.emailDomain}`;
      const id = await ins('INSERT INTO app_user (organization_id, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, email, `${tag}${name}`, pwHash]);
      await c.query('INSERT INTO user_role (organization_id, user_id, role_id, factory_id) VALUES ($1,$2,$3,$4)', [orgId, id, roleIds[role], fid]);
      users[key] = { id, email };
    }

    // finance reference — DEMO values only
    await c.query(`INSERT INTO exchange_rate (organization_id, base_currency, quote_currency, rate, valid_on, source) VALUES
      ($1,'EUR','TRY','45.0000000000',current_date,'DEMO — gerçek kur değildir'), ($1,'USD','TRY','40.0000000000',current_date,'DEMO — gerçek kur değildir')`, [orgId]);
    await c.query(`INSERT INTO tax_rate (organization_id, code, name, rate_pct, valid_from) VALUES ($1,'KDV-HAZIR-GIYIM','DEMO KDV oranı (doğrulayın)',10,'2024-01-01')`, [orgId]);

    const customerId = await ins(`INSERT INTO customer (organization_id, code, name, country, currency) VALUES ($1,'NORD','${tag}Nordic Apparel AB','SE','EUR') RETURNING id`, [orgId]);
    await c.query(`INSERT INTO customer (organization_id, code, name, country, currency) VALUES ($1,'MODA','${tag}Moda Mağazacılık A.Ş.','TR','TRY')`, [orgId]);
    const supplierId = await ins(`INSERT INTO supplier (organization_id, code, name, country, currency) VALUES ($1,'ORME','${tag}Örme Kumaş San. Tic.','TR','TRY') RETURNING id`, [orgId]);

    const colors: Record<string, string> = {}; const sizes: Record<string, string> = {};
    for (const [code, name, pantone] of [['SYH', 'Siyah', '19-4005 TCX'], ['BYZ', 'Beyaz', '11-0601 TCX'], ['LCV', 'Lacivert', '19-3933 TCX']]) {
      colors[code] = await ins('INSERT INTO color (organization_id, code, name, pantone) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, code, name, pantone]);
    }
    for (const [i, code] of ['S', 'M', 'L', 'XL'].entries()) sizes[code] = await ins('INSERT INTO size (organization_id, code, sort_order) VALUES ($1,$2,$3) RETURNING id', [orgId, code, i]);

    const planId = await ins(`INSERT INTO fabric_inspection_plan (organization_id, code, name, max_points_per_100_sq_yd, max_width_deviation_pct, max_gsm_deviation_pct, max_shrinkage_pct, is_demo)
      VALUES ($1,'4P-DEMO','DEMO 4 puan planı — limitleri müşteri sözleşmesine göre ayarlayın',20,3,5,5,$2) RETURNING id`, [orgId, o.isDemo]);
    const jersey = await ins(`INSERT INTO material (organization_id, code, name, kind, base_unit, width_cm, gsm, composition, default_supplier_id, inspection_plan_id)
      VALUES ($1,'KUM-SUP-180','${tag}Süprem 30/1 %100 Pamuk 180 g/m²','FABRIC','M',180,180,'%100 CO',$2,$3) RETURNING id`, [orgId, supplierId, planId]);
    const rib = await ins(`INSERT INTO material (organization_id, code, name, kind, base_unit, width_cm, gsm, composition, default_supplier_id, inspection_plan_id)
      VALUES ($1,'KUM-RIB-220','${tag}1x1 Ribana %95 CO %5 EA 220 g/m²','FABRIC','KG',100,220,'%95 CO %5 EA',$2,$3) RETURNING id`, [orgId, supplierId, planId]);
    const label = await ins(`INSERT INTO material (organization_id, code, name, kind, base_unit) VALUES ($1,'AKS-YKM-ETK','${tag}Yıkama talimat etiketi','TRIM','PCS') RETURNING id`, [orgId]);

    let demoModelId: string | undefined;
    if (o.withDemoModel) {
      const admin = users.admin.id;
      demoModelId = await ins(`INSERT INTO product_model (organization_id, code, name, customer_id, season, product_type, status, approved_by, approved_at, created_by)
        VALUES ($1,'TS-1001','${tag}Basic Bisiklet Yaka T-Shirt',$2,'SS27','T-Shirt','TECH_APPROVED',$3,now(),$3) RETURNING id`, [orgId, customerId, admin]);
      for (const col of ['SYH', 'BYZ']) for (const s of ['S', 'M', 'L', 'XL']) {
        await c.query('INSERT INTO product_variant (organization_id, model_id, color_id, size_id, sku) VALUES ($1,$2,$3,$4,$5)', [orgId, demoModelId, colors[col], sizes[s], `TS-1001-${col}-${s}`]);
      }
      const bomId = await ins(`INSERT INTO bom (organization_id, model_id, version, status, notes, created_by, approved_by, approved_at) VALUES ($1,$2,1,'APPROVED','DEMO reçete',$3,$3,now()) RETURNING id`, [orgId, demoModelId, admin]);
      await c.query(`INSERT INTO bom_item (organization_id, bom_id, material_id, placement, consumption_per_piece, unit, waste_pct) VALUES
        ($1,$2,$3,'Gövde','0.950000','M',4), ($1,$2,$4,'Yaka','0.012000','KG',3), ($1,$2,$5,'Yan dikiş','1','PCS',1)`, [orgId, bomId, jersey, rib, label]);
      await c.query(`INSERT INTO audit_event (organization_id, actor_user_id, action, entity_type, entity_id, after_state) VALUES ($1,$2,'seed.demo_model','product_model',$3,'{"note":"DEMO seed"}')`, [orgId, admin, demoModelId]);
    }
    await c.query('COMMIT');
    return { orgId, factoryId, factory2Id, fabricWarehouseId, quarantineBinId, binA1Id, customerId, supplierId, colors, sizes, materials: { jersey, rib, label }, planId, users, demoModelId };
  } catch (e) { await c.query('ROLLBACK'); throw e; }
}

async function main() {
  const env = loadDbEnv();
  if (process.env.NODE_ENV === 'production') throw new Error('DEMO seed is not allowed in production');
  const c = new Connection(parseDatabaseUrl(env.DATABASE_URL));
  await c.connect();
  try {
    const exists = await c.query("SELECT 1 FROM organization WHERE code = 'DEMO'");
    if (exists.rowCount) { console.log('DEMO organization already exists — run `pnpm db:reset` to recreate.'); return; }
    const password = process.env.DEMO_PASSWORD ?? 'Demo!2026';
    const s = await seedOrganization(c, { code: 'DEMO', name: 'DEMO Tekstil A.Ş.', isDemo: true, password, emailDomain: 'demo.texflow.local',
      settings: { allowSelfApproval: true, demoNotice: 'Bu organizasyon DEMO verisi içerir. Tek kullanıcıyla deneme için öz-onay açık.' }, withDemoModel: true });
    console.log(`DEMO organization seeded (org code: DEMO). Users (password from DEMO_PASSWORD):`);
    for (const u of Object.values(s.users)) console.log('  ' + u.email);
  } finally { await c.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
