-- ============================================================================
-- 057_low_stock_threshold_not_null.sql
-- An item can never again have an EMPTY low-stock threshold.
--
-- The model always said NOT NULL DEFAULT 0, but the column itself allowed
-- NULL, so items created outside the inventory screen (older migrations, SQL
-- functions) were left empty. GET /inventory/stock-check compares stock with
-- the threshold for every recipe ingredient; the first such item that got
-- stock made it crash (Decimal <= None) every 10 s. The order picker then lost
-- its "Sin stock" labels and "Stock bajo" banner -- seen live at Bola 8 on
-- 2026-11-26 after the wing sauces were restocked (18 items were NULL).
-- Sales were never at risk: the add-item stock gate is a separate check.
--
-- 0 = "no low-stock warning", which is what NULL already meant everywhere else
-- (views COALESCE it to 0). No stock or ledger change.
-- init-db STEP 8 only changes the column TYPE (integer -> numeric, once); it
-- keeps the default and NOT NULL, so this cannot be undone on restart.
-- Depends on: 056
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('056') THEN RAISE EXCEPTION '056 must be applied before 057.'; END IF;
END $$;

DO $$
DECLARE n int;
BEGIN
    UPDATE inventory_items SET low_stock_threshold = 0 WHERE low_stock_threshold IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '057: % item(s) had no low-stock threshold; set to 0', n;
END $$;

ALTER TABLE inventory_items ALTER COLUMN low_stock_threshold SET DEFAULT 0;
ALTER TABLE inventory_items ALTER COLUMN low_stock_threshold SET NOT NULL;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('057', 'low_stock_threshold_not_null', 'inventory_items.low_stock_threshold NOT NULL DEFAULT 0 (stock-check crashed on NULL).')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '057_low_stock_threshold_not_null: OK'; END $done$;

COMMIT;
