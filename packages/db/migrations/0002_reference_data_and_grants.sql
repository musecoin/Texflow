-- Migration 0002: global reference data + least-privilege grants for the application role.
-- The application role name is fixed (texflow_app); it is created by the migrator with a
-- password from APP_DATABASE_URL and never owns tables, so RLS always applies to it.

INSERT INTO currency (code, name, minor_units) VALUES
  ('TRY','Türk Lirası',2), ('USD','US Dollar',2), ('EUR','Euro',2), ('GBP','Pound Sterling',2)
ON CONFLICT DO NOTHING;

INSERT INTO unit (code, name, dimension) VALUES
  ('PCS','Adet','COUNT'), ('M','Metre','LENGTH'), ('CM','Santimetre','LENGTH'), ('YD','Yarda','LENGTH'),
  ('KG','Kilogram','MASS'), ('G','Gram','MASS'), ('ROLL','Top','COUNT'), ('CARTON','Koli','PACK'), ('M2','Metrekare','AREA')
ON CONFLICT DO NOTHING;

INSERT INTO unit_conversion (from_unit, to_unit, factor) VALUES
  ('M','CM',100), ('CM','M',0.01), ('YD','M',0.9144), ('M','YD',1.093613298338),
  ('KG','G',1000), ('G','KG',0.001)
ON CONFLICT DO NOTHING;

INSERT INTO permission (code, module, description) VALUES
  ('org.read','core','Organizasyon yapısını görüntüleme'),
  ('user.manage','core','Kullanıcı ve rol yönetimi'),
  ('audit.read','core','Denetim kayıtlarını görüntüleme'),
  ('customer.read','sales','Müşterileri görüntüleme'),
  ('customer.write','sales','Müşteri oluşturma/düzenleme'),
  ('order.read','sales','Siparişleri görüntüleme'),
  ('order.create','sales','Sipariş oluşturma'),
  ('order.confirm','sales','Sipariş onaylama'),
  ('order.cancel','sales','Sipariş iptali'),
  ('model.read','plm','Modelleri görüntüleme'),
  ('model.write','plm','Model oluşturma/düzenleme'),
  ('model.approve','plm','Teknik onay verme'),
  ('bom.read','plm','Reçeteleri görüntüleme'),
  ('bom.write','plm','Reçete oluşturma/düzenleme'),
  ('bom.approve','plm','Reçete onaylama'),
  ('material.read','inventory','Malzemeleri görüntüleme'),
  ('material.write','inventory','Malzeme tanımlama'),
  ('inventory.read','inventory','Stok ve hareket defterini görüntüleme'),
  ('inventory.receive','inventory','Mal kabul (top girişi)'),
  ('inventory.inspect','quality','Kumaş giriş kalite kontrolü'),
  ('inventory.adjust.request','inventory','Stok düzeltme talebi'),
  ('inventory.adjust.approve','inventory','Stok düzeltme onayı'),
  ('workorder.read','production','İş emirlerini görüntüleme'),
  ('workorder.create','production','İş emri oluşturma'),
  ('workorder.release','production','İş emrini serbest bırakma'),
  ('reservation.create','inventory','Malzeme rezervasyonu'),
  ('reservation.release','inventory','Rezervasyon iptali')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- ---- grants ----
GRANT USAGE ON SCHEMA public TO texflow_app;
GRANT SELECT ON permission, currency, unit, unit_conversion TO texflow_app;
GRANT SELECT, INSERT, UPDATE ON
  organization, factory, department, shift, production_line, workstation, machine, warehouse, bin,
  app_user, role, role_permission, user_role, user_session, employee, exchange_rate, tax_rate, number_sequence,
  customer, supplier, size, color, product_model, product_variant, fabric_inspection_plan, material, bom, bom_item,
  sales_order, sales_order_line, work_order, work_order_material, fabric_lot, goods_receipt, fabric_roll,
  stock_reservation, inventory_adjustment_request, idempotency_key
TO texflow_app;
-- deletes only where they are a legitimate part of a workflow (draft editing, access revocation)
GRANT DELETE ON bom_item, user_role, role_permission, idempotency_key TO texflow_app;
-- append-only tables: no UPDATE/DELETE grants at all
GRANT SELECT, INSERT ON inventory_movement, audit_event, sales_order_revision, material_inspection, inspection_defect TO texflow_app;
GRANT EXECUTE ON FUNCTION tf_current_org(), tf_auth_find_user(text,text), tf_auth_find_session(text), tf_auth_find_refresh(text) TO texflow_app;
REVOKE EXECUTE ON FUNCTION tf_auth_find_user(text,text), tf_auth_find_session(text), tf_auth_find_refresh(text) FROM PUBLIC;
