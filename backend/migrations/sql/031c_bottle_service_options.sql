-- ============================================================================
-- 031c_bottle_service_options.sql
-- Widen bottle service to the full refresco lineup: 8 -> 11 options.
--
-- Red Bull is deliberately EXCLUDED: it is sold standalone at $69 and costs
-- multiples of a soda, so including it free in an $800-979 bottle service would
-- erode margin -- and now that 031b makes mixers deduct, that erosion would
-- finally show up in sale_item_costs as unexplained margin decay.
--
-- Depends on: 031b
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('031b') THEN
        RAISE EXCEPTION 'Migration 031b must be applied before 031c.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Spelling: 'Narajada' -> 'Naranjada'.
-- Must happen BEFORE the option is added, because the rule below joins the
-- modifier to its inventory item by name. Without this the Naranjada option
-- would be created with no rule and reopen a coverage gap.
-- ---------------------------------------------------------------------------
UPDATE inventory_items SET name = 'Naranjada' WHERE btrim(name) = 'Narajada';
UPDATE menu_items      SET name = 'Naranjada' WHERE btrim(name) = 'Narajada';

-- ---------------------------------------------------------------------------
-- PART 2 — Three more options on the bottle-service group
-- ---------------------------------------------------------------------------
INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_active)
SELECT gen_random_uuid()::varchar, g.id, v.n, 0, true
  FROM modifier_groups g,
       (VALUES ('Agua Natural'), ('Limonada'), ('Naranjada')) AS v(n)
 WHERE btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio')
   AND NOT EXISTS (SELECT 1 FROM modifiers m
                    WHERE m.modifier_group_id = g.id
                      AND lower(btrim(m.name)) = lower(btrim(v.n)));

-- ---------------------------------------------------------------------------
-- PART 3 — Wire each new option to its inventory item
-- ---------------------------------------------------------------------------
INSERT INTO modifier_inventory_rules (id, modifier_id, inventory_item_id, quantity)
SELECT gen_random_uuid()::varchar, m.id, i.id, 1
  FROM modifiers m
  JOIN modifier_groups g ON g.id = m.modifier_group_id
                        AND btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio')
  JOIN inventory_items i ON lower(btrim(i.name)) = lower(btrim(m.name)) AND i.is_active
 WHERE m.is_active AND NOT m.deducts_no_inventory
   AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);

-- ---------------------------------------------------------------------------
-- PART 4 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('031c','bottle_service_options',
        'Servicio 8 -> 11 options. Narajada spelling fixed. Red Bull excluded by policy.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM modifiers m
      JOIN modifier_groups g ON g.id = m.modifier_group_id
     WHERE btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio') AND m.is_active;
    IF n <> 11 THEN RAISE EXCEPTION '031c: % active Servicio options, expected 11', n; END IF;

    -- Red Bull must NOT be selectable as a bottle-service mixer
    IF EXISTS (SELECT 1 FROM modifiers m
                JOIN modifier_groups g ON g.id = m.modifier_group_id
               WHERE btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio')
                 AND btrim(m.name) ILIKE 'Red Bull%' AND m.is_active) THEN
        RAISE EXCEPTION '031c: Red Bull must not be a bottle-service option';
    END IF;

    -- adding options must not reopen a coverage gap
    SELECT count(*) INTO n FROM v_modifier_coverage_gaps;
    IF n <> 0 THEN RAISE EXCEPTION '031c: % coverage gaps reopened', n; END IF;

    IF EXISTS (SELECT 1 FROM inventory_items WHERE btrim(name) = 'Narajada') THEN
        RAISE EXCEPTION '031c: misspelled Narajada still present';
    END IF;

    RAISE NOTICE '031c OK -- Servicio has % options, Red Bull excluded, gaps 0', n + 11;
END $$;

COMMIT;
