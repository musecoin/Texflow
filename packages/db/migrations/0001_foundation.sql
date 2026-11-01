-- TEXFLOW AI 1.0 — Migration 0001: foundation (Phase 0) + Phase 1 vertical-slice entities
-- Conventions
--   * Every business table carries organization_id and is protected by row-level security
--     keyed on the transaction-local setting app.org_id (defense in depth on top of the
--     application's own scoping).
--   * Quantities: NUMERIC(18,4) with an explicit unit column; consumption NUMERIC(18,6);
--     money NUMERIC(18,4) with an explicit currency; FX NUMERIC(20,10). No floats.
--   * Ledgers (inventory_movement, audit_event, revisions, inspections) are append-only:
--     enforced both by trigger and by GRANTs (app role has no UPDATE/DELETE on them).

CREATE OR REPLACE FUNCTION tf_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION tf_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001', HINT = 'APPEND_ONLY';
END $$;

-- ---------------------------------------------------------------- global reference data
CREATE TABLE permission (
  code        text PRIMARY KEY,
  module      text NOT NULL,
  description text NOT NULL
);

CREATE TABLE currency (
  code        char(3) PRIMARY KEY,
  name        text NOT NULL,
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 4)
);

CREATE TABLE unit (
  code      text PRIMARY KEY,
  name      text NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('COUNT','LENGTH','MASS','AREA','PACK'))
);

-- Only same-dimension, physically exact conversions live here. kg <-> m is NEVER a
-- table conversion: it requires width and GSM and is handled explicitly in code.
CREATE TABLE unit_conversion (
  from_unit text NOT NULL REFERENCES unit(code),
  to_unit   text NOT NULL REFERENCES unit(code),
  factor    numeric(24,12) NOT NULL CHECK (factor > 0),
  PRIMARY KEY (from_unit, to_unit)
);

-- ---------------------------------------------------------------- tenancy & org structure
CREATE TABLE organization (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  base_currency   char(3) NOT NULL REFERENCES currency(code),
  default_locale  text NOT NULL DEFAULT 'tr-TR',
  timezone        text NOT NULL DEFAULT 'Europe/Istanbul',
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE factory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Europe/Istanbul',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE department (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('WAREHOUSE','QC','CUTTING','DECORATION','SEWING','WASHING','FINISHING','PACKING','MAINTENANCE','OFFICE')),
  UNIQUE (organization_id, factory_id, code),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id)
);

CREATE TABLE shift (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  starts_at       time NOT NULL,
  ends_at         time NOT NULL,
  UNIQUE (organization_id, factory_id, code),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id)
);

CREATE TABLE production_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  department_id   uuid REFERENCES department(id),
  code            text NOT NULL,
  name            text NOT NULL,
  UNIQUE (organization_id, factory_id, code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id)
);

CREATE TABLE workstation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  production_line_id uuid,
  code            text NOT NULL,
  name            text NOT NULL,
  UNIQUE (organization_id, factory_id, code),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id),
  FOREIGN KEY (organization_id, production_line_id) REFERENCES production_line(organization_id, id)
);

CREATE TABLE machine (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  workstation_id  uuid REFERENCES workstation(id),
  code            text NOT NULL,
  name            text NOT NULL,
  machine_type    text NOT NULL,
  UNIQUE (organization_id, factory_id, code),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id)
);

CREATE TABLE warehouse (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('FABRIC','TRIM','WIP','FINISHED_GOODS','PACKAGING')),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id)
);

CREATE TABLE bin (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  warehouse_id    uuid NOT NULL,
  code            text NOT NULL,
  is_quarantine   boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, warehouse_id, code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouse(organization_id, id)
);

-- ---------------------------------------------------------------- identity & RBAC
CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  email           text NOT NULL,
  display_name    text NOT NULL,
  password_hash   text NOT NULL,
  locale          text NOT NULL DEFAULT 'tr-TR',
  is_active       boolean NOT NULL DEFAULT true,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (organization_id, lower(email));

CREATE TABLE role (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  is_system       boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE role_permission (
  organization_id uuid NOT NULL REFERENCES organization(id),
  role_id         uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permission(code),
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (organization_id, role_id) REFERENCES role(organization_id, id) ON DELETE CASCADE
);

-- factory_id NULL = role applies to all factories of the organization
CREATE TABLE user_role (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  user_id         uuid NOT NULL,
  role_id         uuid NOT NULL,
  factory_id      uuid,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id) REFERENCES app_user(organization_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES role(organization_id, id),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id)
);
CREATE UNIQUE INDEX user_role_uq ON user_role (user_id, role_id, coalesce(factory_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Opaque tokens; only SHA-256 hashes are stored. Refresh rotates both tokens and links the chain;
-- reuse of a rotated refresh token revokes the whole chain (token theft detection).
CREATE TABLE user_session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  user_id            uuid NOT NULL,
  family_id          uuid NOT NULL,
  access_hash        text NOT NULL UNIQUE,
  refresh_hash       text NOT NULL UNIQUE,
  access_expires_at  timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  rotated_at         timestamptz,
  revoked_at         timestamptz,
  revoke_reason      text,
  ip                 text,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id) REFERENCES app_user(organization_id, id)
);
CREATE INDEX user_session_family_idx ON user_session (family_id);

CREATE TABLE employee (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  department_id   uuid REFERENCES department(id),
  user_id         uuid,
  code            text NOT NULL,
  full_name       text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  anonymized_at   timestamptz,
  UNIQUE (organization_id, code),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id)
);

-- ---------------------------------------------------------------- finance reference (org scoped)
CREATE TABLE exchange_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  base_currency   char(3) NOT NULL REFERENCES currency(code),
  quote_currency  char(3) NOT NULL REFERENCES currency(code),
  rate            numeric(20,10) NOT NULL CHECK (rate > 0),
  valid_on        date NOT NULL,
  source          text NOT NULL,
  UNIQUE (organization_id, base_currency, quote_currency, valid_on)
);

CREATE TABLE tax_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  rate_pct        numeric(7,4) NOT NULL CHECK (rate_pct >= 0),
  valid_from      date NOT NULL,
  UNIQUE (organization_id, code, valid_from)
);

CREATE TABLE number_sequence (
  organization_id uuid NOT NULL REFERENCES organization(id),
  name            text NOT NULL,
  prefix          text NOT NULL,
  next_value      bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, name)
);

-- ---------------------------------------------------------------- partners & product master
CREATE TABLE customer (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  country         char(2),
  tax_number      text,
  currency        char(3) NOT NULL REFERENCES currency(code),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE supplier (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  country         char(2),
  currency        char(3) NOT NULL REFERENCES currency(code),
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE size (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE color (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  pantone         text,
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE product_model (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  customer_id     uuid,
  season          text,
  product_type    text,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','TECH_APPROVED','ARCHIVED')),
  revision        integer NOT NULL DEFAULT 1,
  row_version     integer NOT NULL DEFAULT 1,
  approved_by     uuid,
  approved_at     timestamptz,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customer(organization_id, id)
);

CREATE TABLE product_variant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  model_id        uuid NOT NULL,
  color_id        uuid NOT NULL,
  size_id         uuid NOT NULL,
  sku             text NOT NULL,
  UNIQUE (organization_id, sku),
  UNIQUE (model_id, color_id, size_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, model_id) REFERENCES product_model(organization_id, id),
  FOREIGN KEY (organization_id, color_id) REFERENCES color(organization_id, id),
  FOREIGN KEY (organization_id, size_id) REFERENCES size(organization_id, id)
);

-- Inspection acceptance limits are configuration, never hard-coded universal thresholds.
CREATE TABLE fabric_inspection_plan (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  method          text NOT NULL DEFAULT 'FOUR_POINT' CHECK (method IN ('FOUR_POINT')),
  max_points_per_100_sq_yd numeric(10,2) NOT NULL CHECK (max_points_per_100_sq_yd >= 0),
  max_width_deviation_pct  numeric(7,3),
  max_gsm_deviation_pct    numeric(7,3),
  max_shrinkage_pct        numeric(7,3),
  is_demo         boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE material (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  code            text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('FABRIC','TRIM','THREAD','PACKAGING','DECORATION_CONSUMABLE')),
  base_unit       text NOT NULL REFERENCES unit(code),
  width_cm        numeric(10,2) CHECK (width_cm > 0),
  gsm             numeric(10,2) CHECK (gsm > 0),
  composition     text,
  default_supplier_id uuid,
  inspection_plan_id  uuid,
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, default_supplier_id) REFERENCES supplier(organization_id, id),
  FOREIGN KEY (organization_id, inspection_plan_id) REFERENCES fabric_inspection_plan(organization_id, id)
);

CREATE TABLE bom (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  model_id        uuid NOT NULL,
  version         integer NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','OBSOLETE')),
  notes           text,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid,
  approved_at     timestamptz,
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (model_id, version),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, model_id) REFERENCES product_model(organization_id, id),
  CHECK (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
-- at most one approved BOM per model at a time
CREATE UNIQUE INDEX bom_one_approved_per_model ON bom (model_id) WHERE status = 'APPROVED';

CREATE TABLE bom_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  bom_id          uuid NOT NULL,
  material_id     uuid NOT NULL,
  color_id        uuid,
  placement       text,
  consumption_per_piece numeric(18,6) NOT NULL CHECK (consumption_per_piece > 0),
  unit            text NOT NULL REFERENCES unit(code),
  waste_pct       numeric(7,4) NOT NULL DEFAULT 0 CHECK (waste_pct >= 0 AND waste_pct < 100),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, bom_id) REFERENCES bom(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, material_id) REFERENCES material(organization_id, id),
  FOREIGN KEY (organization_id, color_id) REFERENCES color(organization_id, id)
);

-- ---------------------------------------------------------------- sales orders
CREATE TABLE sales_order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  order_no        text NOT NULL,
  customer_id     uuid NOT NULL,
  customer_po     text,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','IN_PRODUCTION','COMPLETED','SHIPPED','CANCELLED')),
  currency        char(3) NOT NULL REFERENCES currency(code),
  order_date      date NOT NULL,
  due_date        date NOT NULL,
  revision        integer NOT NULL DEFAULT 1,
  row_version     integer NOT NULL DEFAULT 1,
  notes           text,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_by    uuid,
  confirmed_at    timestamptz,
  UNIQUE (organization_id, order_no),
  UNIQUE (organization_id, id),
  CHECK (due_date >= order_date),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customer(organization_id, id)
);
CREATE INDEX sales_order_status_idx ON sales_order (organization_id, status, due_date);

CREATE TABLE sales_order_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  sales_order_id  uuid NOT NULL,
  line_no         integer NOT NULL,
  model_id        uuid NOT NULL,
  variant_id      uuid NOT NULL,
  quantity        numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit            text NOT NULL DEFAULT 'PCS' REFERENCES unit(code),
  unit_price      numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (sales_order_id, line_no),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, sales_order_id) REFERENCES sales_order(organization_id, id),
  FOREIGN KEY (organization_id, model_id) REFERENCES product_model(organization_id, id),
  FOREIGN KEY (organization_id, variant_id) REFERENCES product_variant(organization_id, id)
);

CREATE TABLE sales_order_revision (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  sales_order_id  uuid NOT NULL,
  revision        integer NOT NULL,
  snapshot        jsonb NOT NULL,
  reason          text NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_order_id, revision),
  FOREIGN KEY (organization_id, sales_order_id) REFERENCES sales_order(organization_id, id)
);

-- ---------------------------------------------------------------- work orders
CREATE TABLE work_order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  wo_no           text NOT NULL,
  sales_order_id  uuid NOT NULL,
  sales_order_line_id uuid,
  model_id        uuid NOT NULL,
  color_id        uuid NOT NULL,
  status          text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RELEASED','IN_PROGRESS','COMPLETED','CANCELLED')),
  planned_qty     numeric(18,4) NOT NULL CHECK (planned_qty > 0),
  unit            text NOT NULL DEFAULT 'PCS' REFERENCES unit(code),
  bom_id          uuid,
  bom_version     integer,
  bom_snapshot    jsonb,
  planned_start   date,
  planned_end     date,
  released_by     uuid,
  released_at     timestamptz,
  row_version     integer NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, wo_no),
  UNIQUE (organization_id, id),
  CHECK (status IN ('PLANNED','CANCELLED') OR (bom_id IS NOT NULL AND bom_snapshot IS NOT NULL AND released_at IS NOT NULL)),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id),
  FOREIGN KEY (organization_id, sales_order_id) REFERENCES sales_order(organization_id, id),
  FOREIGN KEY (organization_id, model_id) REFERENCES product_model(organization_id, id),
  FOREIGN KEY (organization_id, color_id) REFERENCES color(organization_id, id),
  FOREIGN KEY (organization_id, bom_id) REFERENCES bom(organization_id, id)
);

CREATE TABLE work_order_material (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  work_order_id   uuid NOT NULL,
  bom_item_id     uuid NOT NULL,
  material_id     uuid NOT NULL,
  unit            text NOT NULL REFERENCES unit(code),
  required_qty    numeric(18,4) NOT NULL CHECK (required_qty > 0),
  reserved_qty    numeric(18,4) NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  issued_qty      numeric(18,4) NOT NULL DEFAULT 0 CHECK (issued_qty >= 0),
  lot_lock_id     uuid,
  shade_lock      text,
  UNIQUE (work_order_id, bom_item_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, work_order_id) REFERENCES work_order(organization_id, id),
  FOREIGN KEY (organization_id, material_id) REFERENCES material(organization_id, id)
);

-- ---------------------------------------------------------------- fabric inventory
CREATE TABLE fabric_lot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  material_id     uuid NOT NULL,
  supplier_id     uuid NOT NULL,
  lot_no          text NOT NULL,
  dye_lot         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, material_id, supplier_id, lot_no),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, material_id) REFERENCES material(organization_id, id),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES supplier(organization_id, id)
);

CREATE TABLE goods_receipt (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  receipt_no      text NOT NULL,
  supplier_id     uuid NOT NULL,
  supplier_delivery_note text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  received_by     uuid NOT NULL,
  UNIQUE (organization_id, receipt_no),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, factory_id) REFERENCES factory(organization_id, id),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES supplier(organization_id, id)
);

-- physical_qty / reserved_qty are a projection maintained ONLY by the inventory_movement
-- trigger below; the ledger is the source of truth. Constraints make over-reservation and
-- negative stock impossible even under concurrent writers.
CREATE TABLE fabric_roll (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  roll_no         text NOT NULL,
  qr_code         text NOT NULL,
  material_id     uuid NOT NULL,
  lot_id          uuid NOT NULL,
  goods_receipt_id uuid NOT NULL,
  supplier_roll_no text,
  warehouse_id    uuid NOT NULL,
  bin_id          uuid,
  color_id        uuid,
  shade           text NOT NULL,
  width_cm        numeric(10,2) CHECK (width_cm > 0),
  gsm             numeric(10,2) CHECK (gsm > 0),
  gross_weight_kg numeric(18,4) CHECK (gross_weight_kg >= 0),
  net_weight_kg   numeric(18,4) CHECK (net_weight_kg >= 0),
  length_m        numeric(18,4) CHECK (length_m >= 0),
  unit            text NOT NULL REFERENCES unit(code),
  received_qty    numeric(18,4) NOT NULL CHECK (received_qty > 0),
  quantity_basis  jsonb NOT NULL,
  quality_status  text NOT NULL DEFAULT 'QUARANTINE' CHECK (quality_status IN ('QUARANTINE','ACCEPTED','REJECTED')),
  physical_qty    numeric(18,4) NOT NULL DEFAULT 0 CHECK (physical_qty >= 0),
  reserved_qty    numeric(18,4) NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  received_at     timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, roll_no),
  UNIQUE (organization_id, qr_code),
  UNIQUE (organization_id, id),
  CHECK (reserved_qty <= physical_qty),
  CHECK (quality_status = 'ACCEPTED' OR reserved_qty = 0),
  CHECK (gross_weight_kg IS NULL OR net_weight_kg IS NULL OR net_weight_kg <= gross_weight_kg),
  FOREIGN KEY (organization_id, material_id) REFERENCES material(organization_id, id),
  FOREIGN KEY (organization_id, lot_id) REFERENCES fabric_lot(organization_id, id),
  FOREIGN KEY (organization_id, goods_receipt_id) REFERENCES goods_receipt(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouse(organization_id, id),
  FOREIGN KEY (organization_id, bin_id) REFERENCES bin(organization_id, id),
  FOREIGN KEY (organization_id, color_id) REFERENCES color(organization_id, id)
);
CREATE INDEX fabric_roll_alloc_idx ON fabric_roll (organization_id, material_id, quality_status, received_at);

CREATE TABLE material_inspection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  roll_id         uuid NOT NULL,
  plan_id         uuid NOT NULL,
  inspector_id    uuid NOT NULL,
  inspected_at    timestamptz NOT NULL DEFAULT now(),
  inspected_length_m  numeric(18,4) NOT NULL CHECK (inspected_length_m > 0),
  cuttable_width_cm   numeric(10,2) NOT NULL CHECK (cuttable_width_cm > 0),
  measured_gsm        numeric(10,2),
  measured_width_cm   numeric(10,2),
  shrinkage_length_pct numeric(7,3),
  shrinkage_width_pct  numeric(7,3),
  shade_result        text CHECK (shade_result IN ('MATCH','MINOR_VARIATION','REJECT')),
  total_points        integer NOT NULL CHECK (total_points >= 0),
  points_per_100_sq_yd numeric(12,4) NOT NULL,
  threshold_snapshot  jsonb NOT NULL,
  failed_checks       text[] NOT NULL DEFAULT '{}',
  result              text NOT NULL CHECK (result IN ('PASS','FAIL')),
  notes               text,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, roll_id) REFERENCES fabric_roll(organization_id, id),
  FOREIGN KEY (organization_id, plan_id) REFERENCES fabric_inspection_plan(organization_id, id)
);
CREATE INDEX material_inspection_roll_idx ON material_inspection (roll_id, inspected_at);

CREATE TABLE inspection_defect (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  inspection_id   uuid NOT NULL,
  defect_code     text NOT NULL,
  length_in       numeric(10,2),
  is_hole         boolean NOT NULL DEFAULT false,
  points          smallint NOT NULL CHECK (points BETWEEN 1 AND 4),
  position_m      numeric(18,4),
  FOREIGN KEY (organization_id, inspection_id) REFERENCES material_inspection(organization_id, id)
);

CREATE TABLE stock_reservation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  work_order_id   uuid NOT NULL,
  work_order_material_id uuid NOT NULL,
  roll_id         uuid NOT NULL,
  material_id     uuid NOT NULL,
  qty             numeric(18,4) NOT NULL CHECK (qty > 0),
  unit            text NOT NULL REFERENCES unit(code),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED','CONSUMED')),
  allocation_policy text NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_by     uuid,
  released_at     timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, work_order_id) REFERENCES work_order(organization_id, id),
  FOREIGN KEY (organization_id, work_order_material_id) REFERENCES work_order_material(organization_id, id),
  FOREIGN KEY (organization_id, roll_id) REFERENCES fabric_roll(organization_id, id)
);
CREATE INDEX stock_reservation_wo_idx ON stock_reservation (work_order_id, status);

CREATE TABLE inventory_adjustment_request (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  roll_id         uuid NOT NULL,
  qty_delta       numeric(18,4) NOT NULL CHECK (qty_delta <> 0),
  unit            text NOT NULL REFERENCES unit(code),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by    uuid NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text,
  UNIQUE (organization_id, id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  FOREIGN KEY (organization_id, roll_id) REFERENCES fabric_roll(organization_id, id)
);

-- Inventory ledger. qty_delta changes physical stock in the given quality status bucket;
-- reserved_delta changes reserved stock. Every row references its originating document.
CREATE TABLE inventory_movement (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id),
  factory_id      uuid NOT NULL,
  movement_type   text NOT NULL CHECK (movement_type IN ('RECEIPT','QC_RELEASE','QC_REJECT','RESERVE','UNRESERVE','ISSUE','ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN')),
  material_id     uuid NOT NULL,
  roll_id         uuid,
  lot_id          uuid,
  warehouse_id    uuid NOT NULL,
  bin_id          uuid,
  stock_status    text NOT NULL CHECK (stock_status IN ('QUARANTINE','ACCEPTED','REJECTED')),
  qty_delta       numeric(18,4) NOT NULL DEFAULT 0,
  reserved_delta  numeric(18,4) NOT NULL DEFAULT 0,
  unit            text NOT NULL REFERENCES unit(code),
  source_type     text NOT NULL,
  source_id       uuid NOT NULL,
  reason          text,
  actor_user_id   uuid NOT NULL,
  request_id      text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_delta <> 0 OR reserved_delta <> 0),
  FOREIGN KEY (organization_id, roll_id) REFERENCES fabric_roll(organization_id, id),
  FOREIGN KEY (organization_id, material_id) REFERENCES material(organization_id, id),
  FOREIGN KEY (organization_id, warehouse_id) REFERENCES warehouse(organization_id, id)
);
CREATE INDEX inventory_movement_roll_idx ON inventory_movement (organization_id, roll_id, id);
CREATE INDEX inventory_movement_material_idx ON inventory_movement (organization_id, material_id, occurred_at);
CREATE INDEX inventory_movement_source_idx ON inventory_movement (organization_id, source_type, source_id);

CREATE OR REPLACE FUNCTION tf_apply_inventory_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r fabric_roll%ROWTYPE;
BEGIN
  IF NEW.roll_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM fabric_roll WHERE id = NEW.roll_id FOR UPDATE;
  IF NOT FOUND OR r.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'cross-tenant movement' USING ERRCODE = 'P0001', HINT = 'TENANT_VIOLATION';
  END IF;
  -- physical deltas always apply; a status move is two rows (-qty old status, +qty new status)
  UPDATE fabric_roll
     SET physical_qty = physical_qty + NEW.qty_delta,
         reserved_qty = reserved_qty + NEW.reserved_delta,
         row_version  = row_version + 1
   WHERE id = NEW.roll_id;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_apply AFTER INSERT ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION tf_apply_inventory_movement();

-- ---------------------------------------------------------------- audit & idempotency
CREATE TABLE audit_event (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  before_state    jsonb,
  after_state     jsonb,
  request_id      text,
  ip              text
);
CREATE INDEX audit_event_entity_idx ON audit_event (organization_id, entity_type, entity_id, id);
CREATE INDEX audit_event_time_idx ON audit_event (organization_id, occurred_at DESC);

CREATE TABLE idempotency_key (
  organization_id uuid NOT NULL REFERENCES organization(id),
  key             text NOT NULL,
  user_id         uuid NOT NULL,
  method          text NOT NULL,
  route           text NOT NULL,
  request_hash    text NOT NULL,
  status_code     integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

-- append-only enforcement
CREATE TRIGGER inventory_movement_immutable BEFORE UPDATE OR DELETE ON inventory_movement FOR EACH ROW EXECUTE FUNCTION tf_forbid_mutation();
CREATE TRIGGER audit_event_immutable        BEFORE UPDATE OR DELETE ON audit_event        FOR EACH ROW EXECUTE FUNCTION tf_forbid_mutation();
CREATE TRIGGER so_revision_immutable        BEFORE UPDATE OR DELETE ON sales_order_revision FOR EACH ROW EXECUTE FUNCTION tf_forbid_mutation();
CREATE TRIGGER inspection_immutable         BEFORE UPDATE OR DELETE ON material_inspection FOR EACH ROW EXECUTE FUNCTION tf_forbid_mutation();
CREATE TRIGGER inspection_defect_immutable  BEFORE UPDATE OR DELETE ON inspection_defect  FOR EACH ROW EXECUTE FUNCTION tf_forbid_mutation();

-- ---------------------------------------------------------------- row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['factory','department','shift','production_line','workstation','machine','warehouse','bin',
    'app_user','role','role_permission','user_role','user_session','employee','exchange_rate','tax_rate','number_sequence',
    'customer','supplier','size','color','product_model','product_variant','fabric_inspection_plan','material','bom','bom_item',
    'sales_order','sales_order_line','sales_order_revision','work_order','work_order_material','fabric_lot','goods_receipt',
    'fabric_roll','material_inspection','inspection_defect','stock_reservation','inventory_adjustment_request',
    'inventory_movement','audit_event','idempotency_key']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = tf_current_org()) WITH CHECK (organization_id = tf_current_org())', t);
  END LOOP;
END $$;
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization USING (id = tf_current_org());

-- Pre-authentication lookups. SECURITY DEFINER functions are the only way the app role can
-- read across tenants, and they return only what login/session validation needs.
CREATE OR REPLACE FUNCTION tf_auth_find_user(p_org_code text, p_email text)
RETURNS TABLE (user_id uuid, organization_id uuid, password_hash text, is_active boolean, locked_until timestamptz, failed_logins integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.organization_id, u.password_hash, u.is_active, u.locked_until, u.failed_logins
    FROM app_user u JOIN organization o ON o.id = u.organization_id
   WHERE o.code = p_org_code AND lower(u.email) = lower(p_email)
$$;

CREATE OR REPLACE FUNCTION tf_auth_find_session(p_access_hash text)
RETURNS TABLE (session_id uuid, organization_id uuid, user_id uuid, access_expires_at timestamptz, revoked_at timestamptz, user_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.organization_id, s.user_id, s.access_expires_at, s.revoked_at, u.is_active
    FROM user_session s JOIN app_user u ON u.id = s.user_id
   WHERE s.access_hash = p_access_hash
$$;

CREATE OR REPLACE FUNCTION tf_auth_find_refresh(p_refresh_hash text)
RETURNS TABLE (session_id uuid, organization_id uuid, user_id uuid, family_id uuid, refresh_expires_at timestamptz, rotated_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.organization_id, s.user_id, s.family_id, s.refresh_expires_at, s.rotated_at, s.revoked_at
    FROM user_session s WHERE s.refresh_hash = p_refresh_hash
$$;
