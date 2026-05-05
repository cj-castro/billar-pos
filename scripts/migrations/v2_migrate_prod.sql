-- =============================================================================
-- billar-pos  ·  Production Migration: main → v2
-- =============================================================================
-- Every statement is idempotent — safe to re-run.
-- Run:  docker exec -i billar-pos-postgres-1 psql -U billiard -d billiardbar < v2_migrate_prod.sql
-- =============================================================================

BEGIN;

-- STEP 1: Rename stock_movements → inventory_movements
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='stock_movements'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='inventory_movements'
  ) THEN
    ALTER TABLE stock_movements RENAME TO inventory_movements;
    RAISE NOTICE 'STEP 1: stock_movements renamed to inventory_movements';
  ELSE
    RAISE NOTICE 'STEP 1: skipped';
  END IF;
END $$;

-- STEP 2: Create new tables
CREATE TABLE IF NOT EXISTS unit_catalog (
    key       VARCHAR(50)  PRIMARY KEY,
    name_es   VARCHAR(100) NOT NULL,
    name_en   VARCHAR(100) NOT NULL,
    active    BOOLEAN      NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS suppliers (
    id            VARCHAR(36)  PRIMARY KEY,
    name          VARCHAR(150) NOT NULL,
    contact_phone VARCHAR(50),
    notes         TEXT,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS insumos_base (
    id                 VARCHAR(36)   PRIMARY KEY,
    menu_item_id       VARCHAR(36)   NOT NULL REFERENCES menu_items(id),
    inventory_item_id  VARCHAR(36)   NOT NULL REFERENCES inventory_items(id),
    quantity           NUMERIC(12,4) NOT NULL,
    deduction_unit_key VARCHAR(50)   NOT NULL,
    notes              TEXT,
    created_at         TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sale_item_costs (
    id                    VARCHAR(36)   PRIMARY KEY,
    ticket_line_item_id   VARCHAR(36)   NOT NULL REFERENCES ticket_line_items(id),
    inventory_item_id     VARCHAR(36)   NOT NULL REFERENCES inventory_items(id),
    inventory_movement_id VARCHAR(36),
    insumos_base_id       VARCHAR(36),
    quantity_deducted     NUMERIC(12,4) NOT NULL,
    unit_cost_cents       INTEGER       NOT NULL,
    total_cost_cents      INTEGER       NOT NULL,
    recorded_at           TIMESTAMPTZ
);
DO $$ BEGIN RAISE NOTICE 'STEP 2: new tables created'; END $$;

-- STEP 3: Ticket columns
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS customer_name       VARCHAR(200);
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS tip_cents            INTEGER     DEFAULT 0;
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS was_reopened         BOOLEAN     DEFAULT FALSE;
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS reopened_at          TIMESTAMPTZ;
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS reopened_by          VARCHAR(36);
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS manual_discount_pct  INTEGER     DEFAULT 0;
ALTER TABLE tickets           ADD COLUMN IF NOT EXISTS edited_after_close   BOOLEAN     DEFAULT FALSE;
ALTER TABLE ticket_line_items ADD COLUMN IF NOT EXISTS cost_snapshot_cents  INTEGER;
ALTER TABLE modifier_groups   ADD COLUMN IF NOT EXISTS allow_multiple       BOOLEAN     DEFAULT FALSE;
DO $$ BEGIN RAISE NOTICE 'STEP 3: ticket columns added'; END $$;

-- STEP 4: inventory_items legacy columns
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category         VARCHAR(50)  DEFAULT 'other';
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS shots_per_bottle INTEGER;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS yields_item_id   VARCHAR(36);
DO $$ BEGIN RAISE NOTICE 'STEP 4: inventory legacy columns added'; END $$;

-- STEP 5: inventory_items v2 columns
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sku                VARCHAR(100);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier           VARCHAR(150);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS base_unit_key      VARCHAR(50);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_unit_key  VARCHAR(50);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_pack_size NUMERIC(12,4) DEFAULT 1;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_active          BOOLEAN       DEFAULT TRUE;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ   DEFAULT NOW();
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ   DEFAULT NOW();
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_cost_cents INTEGER;
DO $$ BEGIN RAISE NOTICE 'STEP 5: inventory v2 columns added'; END $$;

-- STEP 6: Rename quantity → stock_quantity
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_items' AND column_name='quantity') THEN
    ALTER TABLE inventory_items RENAME COLUMN quantity TO stock_quantity;
    RAISE NOTICE 'STEP 6: quantity renamed to stock_quantity';
  ELSE
    RAISE NOTICE 'STEP 6: skipped';
  END IF;
END $$;

-- STEP 7: Rename cost_cents → unit_cost_cents
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_items' AND column_name='cost_cents') THEN
    ALTER TABLE inventory_items RENAME COLUMN cost_cents TO unit_cost_cents;
    RAISE NOTICE 'STEP 7: cost_cents renamed to unit_cost_cents';
  ELSE
    RAISE NOTICE 'STEP 7: skipped';
  END IF;
END $$;

-- STEP 8: INTEGER → NUMERIC
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_items' AND column_name='stock_quantity' AND data_type='integer') THEN
    ALTER TABLE inventory_items ALTER COLUMN stock_quantity TYPE NUMERIC(12,4);
    RAISE NOTICE 'STEP 8a: stock_quantity → NUMERIC';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_items' AND column_name='low_stock_threshold' AND data_type='integer') THEN
    ALTER TABLE inventory_items ALTER COLUMN low_stock_threshold TYPE NUMERIC(12,4);
    RAISE NOTICE 'STEP 8b: low_stock_threshold → NUMERIC';
  END IF;
END $$;

-- STEP 9: inventory_movements new columns + NUMERIC
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS quantity_after     NUMERIC(12,4);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_cost_cents     INTEGER;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_quantity   NUMERIC(12,4);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_unit_key   VARCHAR(50);
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_cost_cents INTEGER;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_movements' AND column_name='quantity_delta' AND data_type='integer') THEN
    ALTER TABLE inventory_movements ALTER COLUMN quantity_delta TYPE NUMERIC(12,4);
    RAISE NOTICE 'STEP 9: quantity_delta → NUMERIC';
  END IF;
END $$;

-- STEP 10: modifier_inventory_rules + menu_item_ingredients → NUMERIC
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='modifier_inventory_rules' AND column_name='quantity' AND data_type='integer') THEN
    ALTER TABLE modifier_inventory_rules ALTER COLUMN quantity TYPE NUMERIC(12,4);
    RAISE NOTICE 'STEP 10a: modifier_inventory_rules.quantity → NUMERIC';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='menu_item_ingredients' AND column_name='quantity' AND data_type='integer') THEN
    ALTER TABLE menu_item_ingredients ALTER COLUMN quantity TYPE NUMERIC(12,4);
    RAISE NOTICE 'STEP 10b: menu_item_ingredients.quantity → NUMERIC';
  END IF;
END $$;

-- STEP 11: Integrity constraints
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_inventory_items_sku' AND conrelid='inventory_items'::regclass) THEN
    ALTER TABLE inventory_items ADD CONSTRAINT uq_inventory_items_sku UNIQUE (sku);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_open_per_resource ON tickets (resource_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS uq_waiting_list_floor_ticket_active ON waiting_list (floor_ticket_id) WHERE status IN ('WAITING','SEATED') AND floor_ticket_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_waiting_list_assigned_ticket_active ON waiting_list (assigned_ticket_id) WHERE status IN ('WAITING','SEATED') AND assigned_ticket_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_open_ticket_has_resource' AND conrelid='tickets'::regclass) THEN
    ALTER TABLE tickets ADD CONSTRAINT chk_open_ticket_has_resource CHECK ((status <> 'OPEN') OR (resource_id IS NOT NULL)) NOT VALID;
    ALTER TABLE tickets VALIDATE CONSTRAINT chk_open_ticket_has_resource;
  END IF;
  RAISE NOTICE 'STEP 11: integrity constraints applied';
END $$;

-- STEP 11c: Repair wrongly-cancelled waitlist entries
UPDATE waiting_list w SET status = 'ASSIGNED'
 WHERE w.status = 'CANCELLED'
   AND EXISTS (SELECT 1 FROM audit_log a WHERE a.entity_id = w.id AND a.action = 'WAITLIST_CLEAR_ON_TICKET_END' AND a.before_state->>'status' = 'ASSIGNED' AND a.after_state->>'status' = 'CANCELLED');
DO $$ BEGIN RAISE NOTICE 'STEP 11c: waitlist repair done'; END $$;

-- STEP 12: Seed unit_catalog
INSERT INTO unit_catalog (key, name_es, name_en, active) VALUES
  ('pieza','Pieza','Piece',TRUE),('porcion','Porción','Serving',TRUE),
  ('botella','Botella','Bottle',TRUE),('lata','Lata','Can',TRUE),
  ('caballito','Caballito','Shot',TRUE),('six_pack','Six Pack','Six Pack',TRUE),
  ('caja','Caja','Case',TRUE),('barril','Barril','Keg',TRUE),
  ('ml','Mililitro','Milliliter',TRUE),('litro','Litro','Liter',TRUE),
  ('gramo','Gramo','Gram',TRUE),('kilogramo','Kilogramo','Kilogram',TRUE),
  ('frasco','Frasco','Jar',TRUE),('charola','Charola','Tray',TRUE),
  ('onza','Onza','Oz',TRUE),('taza','Taza','Cup',TRUE)
ON CONFLICT (key) DO NOTHING;
DO $$ BEGIN RAISE NOTICE 'STEP 12: unit_catalog seeded'; END $$;

-- STEP 13: Backfill base_unit_key
UPDATE inventory_items SET base_unit_key='botella'   WHERE base_unit_key IS NULL AND unit='bottle';
UPDATE inventory_items SET base_unit_key='caballito' WHERE base_unit_key IS NULL AND unit='shot';
UPDATE inventory_items SET base_unit_key='lata'      WHERE base_unit_key IS NULL AND unit='can';
UPDATE inventory_items SET base_unit_key='porcion'   WHERE base_unit_key IS NULL AND unit='serving';
UPDATE inventory_items SET base_unit_key='porcion'   WHERE base_unit_key IS NULL AND unit='ramekin';
UPDATE inventory_items SET base_unit_key='ml'        WHERE base_unit_key IS NULL AND unit='ml';
UPDATE inventory_items SET base_unit_key='onza'      WHERE base_unit_key IS NULL AND unit='oz';
UPDATE inventory_items SET base_unit_key='taza'      WHERE base_unit_key IS NULL AND unit='cup';
UPDATE inventory_items SET base_unit_key='kilogramo' WHERE base_unit_key IS NULL AND unit='lb';
UPDATE inventory_items SET base_unit_key='pieza'     WHERE base_unit_key IS NULL AND unit='unit';
UPDATE inventory_items SET base_unit_key='botella'   WHERE base_unit_key IS NULL AND unit='botella';
UPDATE inventory_items SET base_unit_key='caballito' WHERE base_unit_key IS NULL AND unit='caballito';
UPDATE inventory_items SET base_unit_key='lata'      WHERE base_unit_key IS NULL AND unit='lata';
UPDATE inventory_items SET base_unit_key='porcion'   WHERE base_unit_key IS NULL AND unit='porcion';
UPDATE inventory_items SET base_unit_key='pieza'     WHERE base_unit_key IS NULL AND unit='pieza';
UPDATE inventory_items SET base_unit_key='pieza'     WHERE base_unit_key IS NULL;
DO $$ BEGIN RAISE NOTICE 'STEP 13: base_unit_key backfilled'; END $$;

-- STEP 14: FK base_unit_key → unit_catalog
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_inventory_items_base_unit' AND conrelid='inventory_items'::regclass) THEN
    ALTER TABLE inventory_items ADD CONSTRAINT fk_inventory_items_base_unit FOREIGN KEY (base_unit_key) REFERENCES unit_catalog(key) ON DELETE RESTRICT;
    RAISE NOTICE 'STEP 14: FK added';
  ELSE
    RAISE NOTICE 'STEP 14: skipped';
  END IF;
END $$;

-- STEP 15: base_unit_key NOT NULL
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inventory_items' AND column_name='base_unit_key' AND is_nullable='YES')
     AND NOT EXISTS (SELECT 1 FROM inventory_items WHERE base_unit_key IS NULL) THEN
    ALTER TABLE inventory_items ALTER COLUMN base_unit_key SET NOT NULL;
    RAISE NOTICE 'STEP 15: base_unit_key SET NOT NULL';
  END IF;
END $$;

-- STEP 16: Populate insumos_base from menu_item_ingredients
INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key, created_at)
SELECT gen_random_uuid()::text, mii.menu_item_id, mii.inventory_item_id, mii.quantity, COALESCE(ii.base_unit_key,'pieza'), NOW()
FROM menu_item_ingredients mii
JOIN inventory_items ii ON ii.id = mii.inventory_item_id
WHERE NOT EXISTS (SELECT 1 FROM insumos_base ib WHERE ib.menu_item_id=mii.menu_item_id AND ib.inventory_item_id=mii.inventory_item_id);
DO $$ BEGIN RAISE NOTICE 'STEP 16: insumos_base populated'; END $$;

-- STEP 17: Performance indexes
CREATE INDEX IF NOT EXISTS idx_inventory_items_category         ON inventory_items (category);
CREATE INDEX IF NOT EXISTS idx_inventory_items_category_name    ON inventory_items (category, name);
CREATE INDEX IF NOT EXISTS idx_inventory_items_is_active        ON inventory_items (is_active);
CREATE INDEX IF NOT EXISTS idx_inventory_items_base_unit_key    ON inventory_items (base_unit_key);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_item_created ON inventory_movements (inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_event_type   ON inventory_movements (event_type);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference_id ON inventory_movements (reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_movements_restock      ON inventory_movements (inventory_item_id, created_at) WHERE event_type='RESTOCK';
CREATE INDEX IF NOT EXISTS idx_insumos_base_inventory_item      ON insumos_base (inventory_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_insumos_base_link          ON insumos_base (menu_item_id, inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_costs_line_item        ON sale_item_costs (ticket_line_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_costs_inventory_item   ON sale_item_costs (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_costs_recorded_at      ON sale_item_costs (recorded_at);
CREATE UNIQUE INDEX IF NOT EXISTS sale_item_costs_inventory_movement_id_key ON sale_item_costs (inventory_movement_id);
DO $$ BEGIN RAISE NOTICE 'STEP 17: indexes created'; END $$;

-- STEP 18: TipDistributionConfig default row (floor_pct / bar_pct / kitchen_pct)
INSERT INTO tip_distribution_config (id, floor_pct, bar_pct, kitchen_pct)
SELECT 1, 30, 40, 30 WHERE NOT EXISTS (SELECT 1 FROM tip_distribution_config WHERE id=1);
DO $$ BEGIN RAISE NOTICE 'STEP 18: tip_distribution_config seeded'; END $$;

-- STEP 19: Suppliers unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name ON suppliers (lower(name)) WHERE is_active = TRUE;
DO $$ BEGIN RAISE NOTICE 'STEP 19: suppliers index created'; END $$;

-- STEP 20: Fix category sort_order conflict
UPDATE menu_categories SET sort_order=35 WHERE name='Cubetas de Cerveza' AND sort_order=3;
DO $$ BEGIN RAISE NOTICE 'STEP 20: menu_categories sort_order fixed'; END $$;

COMMIT;
