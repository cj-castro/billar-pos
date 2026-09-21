-- ============================================================================
-- 029_unified_inventory_model.sql
-- Stage 2 — Conversions as first-class; recipes separated from conversions
--
-- Replaces three ad-hoc scalars (item_type / shots_per_bottle / yields_item_id)
-- with an explicit conversion table. The old scalars are DEPRECATED but kept:
-- init-db STEP 4 re-creates them on every start, so they cannot be dropped
-- until STEP 4 and the seed-beer references are removed.
--
-- Existing-row writes: ~9 rows of data hygiene (documented in PART 4).
-- Depends on: 027
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 0 — Guards
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT _applied('027') THEN
        RAISE EXCEPTION 'Migration 027 must be applied before 029.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Movement event types as a reference table, not a CHECK constraint.
-- A hardcoded CHECK list is a footgun: adding a type would need an ALTER, and
-- the first draft of this migration omitted OPENING_STOCK (written by
-- inventory.py:231 when an item is created with stock), which would have
-- BLOCKED all new inventory item creation. With a table, adding a type is an
-- INSERT. Audited: the only two write paths are inventory_svc.py:84 and
-- inventory.py:231; there are no raw SQL inserts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS movement_event_types (
    code            varchar(30)  PRIMARY KEY,
    description_es  varchar(120) NOT NULL,
    direction       varchar(10)  NOT NULL,
    is_legacy       boolean      NOT NULL DEFAULT false,
    requires_reason boolean      NOT NULL DEFAULT false,
    CONSTRAINT ck_met_direction CHECK (direction IN ('IN','OUT','BOTH'))
);

INSERT INTO movement_event_types (code, description_es, direction, is_legacy, requires_reason) VALUES
    ('SALE_DEDUCTION',     'Venta',                      'OUT',  false, false),
    ('SALE_CONSUMPTION',   'Venta (legado, pre-mayo)',   'OUT',  true,  false),
    ('VOID_REVERSAL',      'Reversa por cancelacion',    'IN',   false, false),
    ('RESTOCK',            'Reabasto',                   'IN',   false, false),
    ('OPENING_STOCK',      'Stock inicial',              'IN',   false, false),
    ('MANUAL_ADJUSTMENT',  'Ajuste manual',              'BOTH', false, true),
    ('COUNT_ADJUSTMENT',   'Ajuste por conteo fisico',   'BOTH', false, true),
    ('WASTE',              'Merma',                      'OUT',  false, true),
    ('BOX_OPENING',        'Apertura de caja (legado)',  'BOTH', true,  false),
    ('BOTTLE_OPENING',     'Apertura de botella (leg.)', 'BOTH', true,  false),
    ('CONVERSION_OUT',     'Conversion: origen',         'OUT',  false, false),
    ('CONVERSION_IN',      'Conversion: destino',        'IN',   false, false),
    ('PRODUCTION_CONSUME', 'Produccion: insumo',         'OUT',  false, false),
    ('PRODUCTION_YIELD',   'Produccion: rendimiento',    'IN',   false, false)
ON CONFLICT (code) DO NOTHING;

DO $$ BEGIN
    ALTER TABLE inventory_movements
        ADD CONSTRAINT fk_movement_event_type
        FOREIGN KEY (event_type) REFERENCES movement_event_types(code) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- PART 2 — Conversions. One-way inventory transformation: the source ceases to
-- exist and becomes the target. DISTINCT from recipes (insumos_base), which
-- consume several items together without transforming any of them. Overloading
-- yields_item_id for both is what produced "whisky bottle yields Agua Mineral".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_conversions (
    id                     varchar(36)   PRIMARY KEY,
    from_item_id           varchar(36)   NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    to_item_id             varchar(36)   NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    ratio                  numeric(12,4) NOT NULL,
    conversion_type        varchar(30)   NOT NULL,
    is_automatic           boolean       NOT NULL DEFAULT true,
    requires_authorization boolean       NOT NULL DEFAULT false,
    loss_factor            numeric(6,4)  NOT NULL DEFAULT 0,
    notes                  text,
    is_active              boolean       NOT NULL DEFAULT true,
    created_at             timestamptz   NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_conv_ratio_positive CHECK (ratio > 0),
    CONSTRAINT ck_conv_loss_range     CHECK (loss_factor >= 0 AND loss_factor < 1),
    CONSTRAINT ck_conv_not_self       CHECK (from_item_id <> to_item_id),
    CONSTRAINT ck_conv_type CHECK (conversion_type IN
        ('PACK_TO_LOOSE','BOTTLE_TO_SHOT','BULK_TO_PORTION','BUCKET_TO_UNIT')),
    CONSTRAINT uq_conv_pair UNIQUE (from_item_id, to_item_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_from ON inventory_conversions (from_item_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_conv_to   ON inventory_conversions (to_item_id)   WHERE is_active;

COMMENT ON COLUMN inventory_conversions.is_automatic IS
    'true = system converts on demand when the target hits zero and the source is available.';
COMMENT ON COLUMN inventory_conversions.loss_factor IS
    'Expected loss, e.g. 0.05 = 5%%. Zero for pack/bottle splits, which are exact.';

-- ---------------------------------------------------------------------------
-- PART 3 — Cycle prevention.
-- The live yields_item_id data contains Tequila Blanco Bottle <-> Shot pointing
-- at EACH OTHER. A recursive availability walk over that pair never terminates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_conv_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        WITH RECURSIVE reach(item_id, depth) AS (
            SELECT NEW.to_item_id, 1
            UNION ALL
            SELECT c.to_item_id, r.depth + 1
              FROM inventory_conversions c
              JOIN reach r ON c.from_item_id = r.item_id
             WHERE c.is_active AND r.depth < 10
        )
        SELECT 1 FROM reach WHERE item_id = NEW.from_item_id
    ) THEN
        RAISE EXCEPTION 'CONVERSION CYCLE: % -> % closes a loop.',
            NEW.from_item_id, NEW.to_item_id
            USING HINT = 'Conversions must be one-way (bottle -> shot, never both).';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_conv_no_cycle ON inventory_conversions;
CREATE TRIGGER trg_conv_no_cycle
    BEFORE INSERT OR UPDATE ON inventory_conversions
    FOR EACH ROW EXECUTE FUNCTION fn_conv_no_cycle();

-- ---------------------------------------------------------------------------
-- PART 4 — Curated conversion map, reviewed with the operator 2026-08-07.
-- Deliberately NOT auto-derived from yields_item_id: that column contains a
-- mis-targeted mapping (whisky -> Agua Mineral) and a circular pair.
-- ---------------------------------------------------------------------------
INSERT INTO inventory_conversions (id, from_item_id, to_item_id, ratio, conversion_type, notes)
SELECT gen_random_uuid()::varchar, v.f, v.t, v.r, v.ty, v.n
FROM (VALUES
 ('81982389-a947-4a70-ba2c-3bdbf3578f03','211e924e-53d5-4204-a33c-bdf665561d3f',20,'PACK_TO_LOOSE','Marlboro Blanco: 20/cajetilla'),
 ('0965f096-2980-401f-abd5-0fd5017b4776','d9203124-6190-4020-8e67-ee279eb9d94e',20,'PACK_TO_LOOSE','Marlboro Rojo: 20/cajetilla'),
 ('b7b37124-0d35-4141-b5f6-e60c29d7ca82','2c285acb-39a7-4ffb-a477-c5a3ff9560d8',14,'PACK_TO_LOOSE','Marlboro Gold: 14/cajetilla (confirmado)'),
 ('4f26fa02-5200-44d3-821b-405d9acc6869','84120913-44c4-4b5d-a20b-1c53c134e820',15,'BOTTLE_TO_SHOT','Tequila Blanco; referencia circular eliminada'),
 ('f1bfc967-f28d-4daf-8599-2385fbaeb737','ee5b1963-5138-4663-9024-fcbd9695620e',15,'BOTTLE_TO_SHOT','Tequila Cristalino'),
 ('530e0aa9-a5bf-4bef-8bbc-7ece94aff97d','b963684a-74bc-4518-a44b-9a9af7575bcb',15,'BOTTLE_TO_SHOT','Whisky Red Label; antes ->Agua Mineral @7, corregido')
) AS v(f,t,r,ty,n)
WHERE EXISTS (SELECT 1 FROM inventory_items WHERE id = v.f)
  AND EXISTS (SELECT 1 FROM inventory_items WHERE id = v.t)
ON CONFLICT (from_item_id, to_item_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Data hygiene on the deprecated scalars
-- 5a: 8 rows hold '' instead of NULL, so IS NOT NULL checks treat them as set.
-- ---------------------------------------------------------------------------
UPDATE inventory_items SET yields_item_id = NULL
 WHERE yields_item_id IS NOT NULL AND btrim(yields_item_id) = '';

-- 5b: Whisky corrected 7 -> 15 shots per bottle (operator confirmed). This DOES
--     change live behaviour for code still reading the scalar (BOTTLE_OPENING).
UPDATE inventory_items SET shots_per_bottle = 15
 WHERE id = '530e0aa9-a5bf-4bef-8bbc-7ece94aff97d' AND shots_per_bottle = 7;

-- 5c: meaningless on loose-cigarette items; the ratio belongs to the pack.
UPDATE inventory_items SET shots_per_bottle = NULL
 WHERE item_type = 'CIG_SINGLE' AND shots_per_bottle IS NOT NULL;

COMMENT ON COLUMN inventory_items.shots_per_bottle IS
    'DEPRECATED (029). Superseded by inventory_conversions.ratio. Cannot be dropped '
    'while init-db STEP 4 re-creates it and seed-beer references it.';
COMMENT ON COLUMN inventory_items.yields_item_id IS
    'DEPRECATED (029). Superseded by inventory_conversions.to_item_id. Same constraint.';
COMMENT ON COLUMN inventory_items.item_type IS
    'DEPRECATED (029). Unreliable: shots labelled BOTTLE, bottles labelled STANDARD. '
    'Use stock_nature.';

-- ---------------------------------------------------------------------------
-- PART 6 — stock_nature: a reliable replacement for item_type
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS stock_nature varchar(20);

UPDATE inventory_items i SET stock_nature = CASE
    WHEN EXISTS (SELECT 1 FROM inventory_conversions c WHERE c.from_item_id = i.id) THEN 'CONVERTIBLE'
    WHEN EXISTS (SELECT 1 FROM inventory_conversions c WHERE c.to_item_id   = i.id) THEN 'DERIVED'
    ELSE 'SIMPLE' END
 WHERE stock_nature IS NULL;

ALTER TABLE inventory_items ALTER COLUMN stock_nature SET DEFAULT 'SIMPLE';
ALTER TABLE inventory_items ALTER COLUMN stock_nature SET NOT NULL;

DO $$ BEGIN
    ALTER TABLE inventory_items ADD CONSTRAINT ck_stock_nature
        CHECK (stock_nature IN ('SIMPLE','CONVERTIBLE','DERIVED','BULK','PORTION'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- PART 7 — Stop FUTURE cigarette oversell; history preserved.
-- Two closed boxes recorded 24/20 and 23/20 -- 7 cigarettes sold that those
-- boxes never held. NOT VALID keeps them as frozen pre-cutover history.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    ALTER TABLE open_cigarette_boxes ADD CONSTRAINT ck_cigs_sold_within_box
        CHECK (cigs_sold <= cigs_per_box) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- PART 8 — Deprecate the dead recipe table (emptied by 029b)
-- ---------------------------------------------------------------------------
COMMENT ON TABLE menu_item_ingredients IS
    'DEPRECATED (029). Superseded by insumos_base since 2026-05-04; the deduction '
    'service reads InsumoBase exclusively. Emptied and write-blocked by 029b.';

-- ---------------------------------------------------------------------------
-- PART 9 — Convertible stock view (ordering by seq, per 027)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_convertible_stock AS
SELECT f.id AS source_id, f.name AS source_name, f.stock_quantity AS source_stock,
       t.id AS derived_id, t.name AS derived_name, t.stock_quantity AS derived_stock,
       c.ratio, c.conversion_type, c.is_automatic,
       t.stock_quantity + (f.stock_quantity * c.ratio * (1 - c.loss_factor)) AS max_derived_available
  FROM inventory_conversions c
  JOIN inventory_items f ON f.id = c.from_item_id
  JOIN inventory_items t ON t.id = c.to_item_id
 WHERE c.is_active AND f.is_active AND t.is_active;

-- ---------------------------------------------------------------------------
-- PART 10 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('029','unified_inventory_model',
        'Conversions table + curated map (6). event_type reference table + FK. Scalars deprecated.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 11 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM inventory_conversions;
    IF n < 6 THEN RAISE EXCEPTION '029: % conversions seeded, expected 6', n; END IF;

    SELECT count(*) INTO n FROM movement_event_types;
    IF n < 14 THEN RAISE EXCEPTION '029: % event types, expected 14', n; END IF;

    -- every event_type present in data must exist in the reference table,
    -- otherwise the NOT VALID FK would reject future inserts of that type
    SELECT count(*) INTO n FROM (
        SELECT DISTINCT m.event_type FROM inventory_movements m
         WHERE NOT EXISTS (SELECT 1 FROM movement_event_types t WHERE t.code = m.event_type)) x;
    IF n <> 0 THEN RAISE EXCEPTION '029: % event_type values in data are unregistered', n; END IF;

    SELECT count(*) INTO n FROM inventory_items WHERE btrim(COALESCE(yields_item_id,'x')) = '';
    IF n <> 0 THEN RAISE EXCEPTION '029: % empty-string yields_item_id remain', n; END IF;

    SELECT count(*) INTO n FROM inventory_items WHERE item_type='CIG_SINGLE' AND shots_per_bottle IS NOT NULL;
    IF n <> 0 THEN RAISE EXCEPTION '029: % CIG_SINGLE rows still carry shots_per_bottle', n; END IF;

    -- the corrected whisky ratio must be present in the conversion table
    IF NOT EXISTS (SELECT 1 FROM inventory_conversions
                    WHERE from_item_id='530e0aa9-a5bf-4bef-8bbc-7ece94aff97d'
                      AND to_item_id='b963684a-74bc-4518-a44b-9a9af7575bcb' AND ratio=15) THEN
        RAISE EXCEPTION '029: whisky bottle->shot conversion missing or wrong ratio';
    END IF;

    SELECT count(*) INTO n FROM inventory_items WHERE stock_nature IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION '029: % items have NULL stock_nature', n; END IF;

    RAISE NOTICE '029 OK -- % conversions, % event types, % CONVERTIBLE, % DERIVED',
        (SELECT count(*) FROM inventory_conversions),
        (SELECT count(*) FROM movement_event_types),
        (SELECT count(*) FROM inventory_items WHERE stock_nature='CONVERTIBLE'),
        (SELECT count(*) FROM inventory_items WHERE stock_nature='DERIVED');
END $$;

COMMIT;
