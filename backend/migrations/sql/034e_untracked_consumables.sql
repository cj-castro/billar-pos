-- ============================================================================
-- 034e_untracked_consumables.sql
-- Vaso Ruso is lime + salt only, and limes are deliberately not counted. That
-- is different from a damage charge, which consumes nothing at all: both stay
-- out of coverage reporting, but collapsing them would lose information needed
-- for margin analysis. Hence a reason alongside the flag.
-- Depends on: 034d
-- ============================================================================
BEGIN;
DO $$ BEGIN
    IF NOT _applied('034d') THEN RAISE EXCEPTION '034d must be applied before 034e.'; END IF;
END $$;

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS untracked_reason varchar(40);

DO $$ BEGIN
    ALTER TABLE menu_items ADD CONSTRAINT ck_untracked_reason CHECK (
        untracked_reason IS NULL OR untracked_reason IN
        ('DAMAGE_CHARGE','INCOME','UNTRACKED_CONSUMABLES','PROMOTION'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN menu_items.untracked_reason IS
    'Why this item has no recipe. UNTRACKED_CONSUMABLES = a real product whose '
    'ingredients are deliberately not counted, so it has NO cost basis and its '
    'margin reads as 100%%. DAMAGE_CHARGE / INCOME = not a product at all.';

UPDATE menu_items
   SET tracks_inventory = false, untracked_reason = 'UNTRACKED_CONSUMABLES'
 WHERE btrim(name) = 'Vaso Ruso' AND untracked_reason IS NULL;

UPDATE menu_items mi SET untracked_reason = CASE btrim(c.name)
        WHEN 'Daños'       THEN 'DAMAGE_CHARGE'
        WHEN 'INGRESOS'    THEN 'INCOME'
        WHEN 'Promociones' THEN 'PROMOTION' END
  FROM menu_categories c
 WHERE c.id = mi.category_id AND NOT mi.tracks_inventory AND mi.untracked_reason IS NULL;

CREATE OR REPLACE VIEW v_untracked_products AS
SELECT c.name AS categoria, mi.name AS producto, mi.price_cents/100.0 AS precio,
       mi.untracked_reason,
       (SELECT count(*) FROM ticket_line_items li
         WHERE li.menu_item_id = mi.id AND li.status <> 'VOIDED') AS vendido
  FROM menu_items mi LEFT JOIN menu_categories c ON c.id = mi.category_id
 WHERE mi.is_active AND NOT mi.tracks_inventory
 ORDER BY mi.untracked_reason, vendido DESC;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('034e','untracked_consumables','Vaso Ruso = UNTRACKED_CONSUMABLES; reasons labelled.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM menu_items
                    WHERE btrim(name)='Vaso Ruso' AND untracked_reason='UNTRACKED_CONSUMABLES') THEN
        RAISE EXCEPTION '034e: Vaso Ruso not flagged';
    END IF;
    -- guards against someone later "helpfully" adding a lime recipe
    SELECT count(*) INTO n FROM insumos_base b JOIN menu_items mi ON mi.id=b.menu_item_id
     WHERE btrim(mi.name)='Vaso Ruso';
    IF n <> 0 THEN RAISE EXCEPTION '034e: Vaso Ruso should have 0 recipe rows, found %', n; END IF;
    RAISE NOTICE '034e OK -- % untracked products labelled', (SELECT count(*) FROM v_untracked_products);
END $$;
COMMIT;
