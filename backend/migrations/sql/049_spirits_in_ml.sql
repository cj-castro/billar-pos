-- ============================================================================
-- 049_spirits_in_ml.sql
-- Opened spirits are measured in millilitres (batch E2, step 1).
--
-- Until now an opened bottle became N whole "shots" and every recipe deducted
-- whole shots. A splash of Curazao in an Azulito cost a full shot, so the books
-- ran a bottle dry after 15 Azulitos when it really lasts ~37, a double could
-- not be expressed, and the cost of mixed drinks was overstated.
--
-- Now:
--   bottle -> open item conversion ratio = MILLILITRES per bottle (750)
--   open item ("Vodka Shot") base unit   = ml
--   open item portion_size (ml)          = the standard pour ("1 shot")
--   recipes                              = ml (1 shot -> 50 ml; a splash can be 20 ml)
--
-- Existing data is converted EXACTLY, history included, so reports and the
-- 28-day windows never mix shots and ml. For each open item, with
-- f = ml per shot = 750 / shots_per_bottle (bottles assumed 750 ml; owners
-- correct the size per bottle in Inventario, which affects future openings):
--   stock, low-stock threshold, every movement's delta / quantity_after,
--   every sale_item_costs quantity, recipe and modifier-rule quantities  x f
--   unit costs (item, movements, sale_item_costs)                         / f
-- so every peso total is unchanged. Ledger continuity holds because each
-- item's whole chain is scaled by the same factor in one transaction.
--
-- Idempotent: items already stocked in ml are skipped.
-- Depends on: 048
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('048') THEN RAISE EXCEPTION '048 must be applied before 049.'; END IF;
END $$;

DO $$
DECLARE
    r record;
    f numeric;
    n int := 0;
BEGIN
    FOR r IN
        SELECT t.id, t.name, t.base_unit_key,
               -- the active conversion's ratio (any row if none is active)
               (SELECT c.ratio FROM inventory_conversions c
                 WHERE c.to_item_id = t.id AND c.conversion_type = 'BOTTLE_TO_SHOT'
                 ORDER BY c.is_active DESC, c.created_at DESC LIMIT 1) AS ratio
          FROM inventory_items t
         WHERE t.base_unit_key IS DISTINCT FROM 'ml'
           AND EXISTS (SELECT 1 FROM inventory_conversions c
                        WHERE c.to_item_id = t.id AND c.conversion_type = 'BOTTLE_TO_SHOT')
    LOOP
        f := round(750 / r.ratio, 4);

        UPDATE inventory_movements
           SET quantity_delta  = quantity_delta * f,
               quantity_after  = quantity_after * f,
               unit_cost_cents = round(unit_cost_cents / f, 4)
         WHERE inventory_item_id = r.id;

        UPDATE sale_item_costs
           SET quantity_deducted = quantity_deducted * f,
               unit_cost_cents   = round(unit_cost_cents / f, 4)
         WHERE inventory_item_id = r.id;

        -- the item before its recipes: the recipe unit guard compares to it
        UPDATE inventory_items
           SET base_unit_key       = 'ml',
               unit                = 'ml',
               stock_quantity      = stock_quantity * f,
               low_stock_threshold = COALESCE(low_stock_threshold, 0) * f,
               unit_cost_cents     = round(COALESCE(unit_cost_cents, 0) / f, 4),
               portion_size        = f,
               portion_unit_key    = 'ml',
               updated_at          = now()
         WHERE id = r.id;

        UPDATE insumos_base
           SET quantity = quantity * f, deduction_unit_key = 'ml'
         WHERE inventory_item_id = r.id;
        UPDATE modifier_inventory_rules SET quantity = quantity * f WHERE inventory_item_id = r.id;
        UPDATE menu_item_ingredients    SET quantity = quantity * f WHERE inventory_item_id = r.id;

        UPDATE inventory_conversions
           SET ratio = ratio * f
         WHERE to_item_id = r.id AND conversion_type = 'BOTTLE_TO_SHOT';

        INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_state, after_state, reason, created_at)
        VALUES (NULL, 'INVENTORY_UNIT_TO_ML', 'inventory_item', r.id,
                jsonb_build_object('unit', r.base_unit_key, 'shots_per_bottle', r.ratio),
                jsonb_build_object('unit', 'ml', 'ml_per_shot', f, 'ml_per_bottle', r.ratio * f),
                '049: spirits measured in ml (history scaled exactly)', now());
        n := n + 1;
    END LOOP;
    RAISE NOTICE '049: % open-spirit item(s) converted to ml', n;
END $$;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('049', 'spirits_in_ml',
        'Opened spirits in ml: conversion ratio = ml/bottle, portion_size = standard pour; history scaled exactly.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '049_spirits_in_ml: OK'; END $done$;

COMMIT;
