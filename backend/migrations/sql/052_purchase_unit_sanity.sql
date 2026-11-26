-- ============================================================================
-- 052_purchase_unit_sanity.sql
-- Purchase unit vs stock unit, cleaned up (batch E4).
--
-- The new-item form defaulted "how many per case" to 1, so a few items say
-- they are bought by the "caja" of ONE "pieza" -- the price of a case was
-- taken as the price of a piece. With a pack of 1 the math is "bought as
-- stocked", so these become exactly that (purchase unit = stock unit): costs
-- do not move, the ambiguity goes away. A real case size can be set later and
-- the app now insists on a real count (> 1) when the units differ.
--
-- Bottles that open into shots are counted in botellas (whole numbers, 041);
-- one was stocked in "caballito".
--
-- Only units/labels change; stock and costs are untouched. Audited.
-- Depends on: 051
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('051') THEN RAISE EXCEPTION '051 must be applied before 052.'; END IF;
END $$;

-- 1. Bottles that open are stocked in botellas.
WITH fix AS (
    SELECT i.id, i.base_unit_key AS before
      FROM inventory_items i
     WHERE i.base_unit_key IS DISTINCT FROM 'botella'
       AND EXISTS (SELECT 1 FROM inventory_conversions c
                    WHERE c.from_item_id = i.id AND c.conversion_type = 'BOTTLE_TO_SHOT' AND c.is_active)
), upd AS (
    UPDATE inventory_items i SET base_unit_key = 'botella', unit = 'bottle', updated_at = now()
      FROM fix WHERE i.id = fix.id RETURNING i.id, fix.before
)
INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_state, after_state, reason, created_at)
SELECT NULL, 'INVENTORY_UNIT_FIX', 'inventory_item', id,
       jsonb_build_object('base_unit_key', before), jsonb_build_object('base_unit_key', 'botella'),
       '052: a bottle that opens into shots is counted in botellas', now()
  FROM upd;

-- 2. "Bought by the X of 1" with a different unit = bought as stocked.
WITH fix AS (
    SELECT i.id, i.purchase_unit_key AS before
      FROM inventory_items i
     WHERE i.purchase_unit_key IS NOT NULL
       AND i.purchase_unit_key <> i.base_unit_key
       AND COALESCE(i.purchase_pack_size, 1) <= 1
), upd AS (
    UPDATE inventory_items i SET purchase_unit_key = i.base_unit_key, purchase_pack_size = 1, updated_at = now()
      FROM fix WHERE i.id = fix.id RETURNING i.id, i.base_unit_key AS after, fix.before
)
INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_state, after_state, reason, created_at)
SELECT NULL, 'INVENTORY_UNIT_FIX', 'inventory_item', id,
       jsonb_build_object('purchase_unit_key', before, 'purchase_pack_size', 1),
       jsonb_build_object('purchase_unit_key', after, 'purchase_pack_size', 1),
       '052: a pack of 1 in a different unit meant "bought as stocked"; set a real case size if it has one', now()
  FROM upd;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('052', 'purchase_unit_sanity', 'Pack-of-1 purchase units normalised; opening bottles stocked in botellas.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '052_purchase_unit_sanity: OK'; END $done$;

COMMIT;
