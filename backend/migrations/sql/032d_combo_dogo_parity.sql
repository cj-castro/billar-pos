-- ============================================================================
-- 032d_combo_dogo_parity.sql
--
-- Combo Dogo 2 ($150) is the TWO-hotdog version: 2 buns, 2 sausages, 2 bacon --
-- but zero onion, where Combo Dogo 1 ($100) has one. An omission, so onion was
-- being served untracked on every Combo Dogo 2.
--
-- Depends on: 032c
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('032c') THEN
        RAISE EXCEPTION 'Migration 032c must be applied before 032d.';
    END IF;
END $$;

INSERT INTO insumos_base (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key)
SELECT gen_random_uuid()::varchar, mi.id, ii.id, 2, ii.base_unit_key
  FROM menu_items mi, inventory_items ii
 WHERE btrim(mi.name) = 'Combo Dogo 2' AND mi.is_active
   AND btrim(ii.name) = 'Cebolla' AND ii.is_active
   AND NOT EXISTS (SELECT 1 FROM insumos_base b
                    WHERE b.menu_item_id = mi.id AND b.inventory_item_id = ii.id);

INSERT INTO schema_migrations (version, name, notes)
VALUES ('032d','combo_dogo_parity','Combo Dogo 2 gains Cebolla x2 (2-hotdog portion).')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE v_qty numeric; n int;
BEGIN
    SELECT b.quantity INTO v_qty
      FROM insumos_base b
      JOIN menu_items mi ON mi.id = b.menu_item_id
      JOIN inventory_items ii ON ii.id = b.inventory_item_id
     WHERE btrim(mi.name) = 'Combo Dogo 2' AND btrim(ii.name) = 'Cebolla';
    IF v_qty IS NULL THEN RAISE EXCEPTION '032d: Combo Dogo 2 still has no Cebolla'; END IF;
    IF v_qty <> 2 THEN RAISE EXCEPTION '032d: Combo Dogo 2 Cebolla qty is %, expected 2', v_qty; END IF;

    -- every Combo Dogo 2 ingredient should be double its Combo Dogo 1 counterpart
    SELECT count(*) INTO n
      FROM insumos_base b2
      JOIN menu_items mi2 ON mi2.id = b2.menu_item_id AND btrim(mi2.name) = 'Combo Dogo 2'
      JOIN insumos_base b1 ON b1.inventory_item_id = b2.inventory_item_id
      JOIN menu_items mi1 ON mi1.id = b1.menu_item_id AND btrim(mi1.name) = 'Combo Dogo 1'
     WHERE b2.quantity <> b1.quantity * 2;
    IF n <> 0 THEN
        RAISE EXCEPTION '032d: % shared ingredients are not exactly 2x Combo Dogo 1', n;
    END IF;

    RAISE NOTICE '032d OK -- Combo Dogo 2 ingredients are 2x Combo Dogo 1 across the board';
END $$;

COMMIT;
