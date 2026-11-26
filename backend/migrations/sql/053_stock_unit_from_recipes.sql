-- ============================================================================
-- 053_stock_unit_from_recipes.sql
-- An item stocked in "cajas" whose recipes deduct "piezas" (batch E4).
--
-- Found: Papas Doradas Caseras -- stocked by caja, bought by caja "of 60",
-- while all its recipes deduct 1 pieza. Every quantity was already in pieces
-- (restocking 1 case added 60; the unit cost $13.33 = $800 / 60 per piece):
-- only the stock unit's LABEL was wrong. Rule, not a name: when an item is
-- bought in the same unit it is stocked in but "N per pack" (N > 1) and every
-- recipe deducts one other unit, that recipe unit is the real stock unit.
-- Stock, costs, recipes and history are untouched. Audited.
-- Depends on: 052
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('052') THEN RAISE EXCEPTION '052 must be applied before 053.'; END IF;
END $$;

WITH fix AS (
    SELECT i.id, i.base_unit_key AS before, min(ib.deduction_unit_key) AS recipe_unit
      FROM inventory_items i
      JOIN insumos_base ib ON ib.inventory_item_id = i.id
     WHERE i.purchase_unit_key = i.base_unit_key
       AND COALESCE(i.purchase_pack_size, 1) > 1
     GROUP BY i.id, i.base_unit_key
    HAVING count(DISTINCT ib.deduction_unit_key) = 1
       AND min(ib.deduction_unit_key) <> i.base_unit_key
       AND EXISTS (SELECT 1 FROM unit_catalog u WHERE u.key = min(ib.deduction_unit_key))
), upd AS (
    UPDATE inventory_items i SET base_unit_key = fix.recipe_unit, updated_at = now()
      FROM fix WHERE i.id = fix.id
    RETURNING i.id, fix.before, fix.recipe_unit, i.purchase_unit_key, i.purchase_pack_size
)
INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_state, after_state, reason, created_at)
SELECT NULL, 'INVENTORY_UNIT_FIX', 'inventory_item', id,
       jsonb_build_object('base_unit_key', before),
       jsonb_build_object('base_unit_key', recipe_unit, 'purchase_unit_key', purchase_unit_key,
                          'purchase_pack_size', purchase_pack_size),
       '053: stocked in the unit its recipes deduct; quantities were already in that unit', now()
  FROM upd;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('053', 'stock_unit_from_recipes', 'Same-unit packs > 1 relabelled to the unit their recipes deduct.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '053_stock_unit_from_recipes: OK'; END $done$;

COMMIT;
