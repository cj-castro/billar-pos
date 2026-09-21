-- ============================================================================
-- 031b_modifier_coverage.sql
-- Closes the remaining 26 modifier coverage gaps.
--
-- The wing sauces are ALREADY portion-based inventory items (serving/porcion) --
-- five of the seven exist with 17-95 portions in stock and simply were never
-- wired to their modifiers. Only Hot Bbq and Tamarindo Habanero are missing.
--
-- New items are created at stock 0 ON PURPOSE. Inventing counts would corrupt
-- the ledger that 027 just secured; they must be established by a physical
-- count through the existing COUNT_ADJUSTMENT path.
--
-- Depends on: 031
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('031') THEN
        RAISE EXCEPTION 'Migration 031 must be applied before 031b.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Portion sizing for bulk stock.
-- Answers "how many portions are left?" by division rather than a conversion
-- row (1 ml -> 0.0067 portions would be awkward and lossy).
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_items
    ADD COLUMN IF NOT EXISTS portion_size     numeric(12,4),
    ADD COLUMN IF NOT EXISTS portion_unit_key varchar(50) REFERENCES unit_catalog(key);

COMMENT ON COLUMN inventory_items.portion_size IS
    'Base units per serving for bulk stock (e.g. Clamato: ml per michelada). '
    'NULL = the item is already counted in whole servable units.';

CREATE OR REPLACE VIEW v_portion_availability AS
SELECT id, name, category, unit, stock_quantity, portion_size,
       CASE WHEN portion_size IS NULL OR portion_size = 0 THEN stock_quantity
            ELSE floor(stock_quantity / portion_size) END AS portions_available
  FROM inventory_items
 WHERE is_active;

-- Clamato: 150 ml per michelada (operator confirmed).
-- 35,906 ml on hand therefore equals ~239 micheladas.
UPDATE inventory_items
   SET portion_size = 150, portion_unit_key = 'ml'
 WHERE id = '3a6e6fb2-0d47-4ec3-80d9-9361502e45b7'
   AND portion_size IS DISTINCT FROM 150;

-- ---------------------------------------------------------------------------
-- PART 2 — Create the missing inventory items.
-- 'unit' is NOT NULL, so it is always set explicitly.
-- Lemon Pepper and Parmesano already exist; the guard skips them.
-- ---------------------------------------------------------------------------
INSERT INTO inventory_items
  (id, name, unit, base_unit_key, stock_quantity, category, item_type, stock_nature, is_active)
SELECT gen_random_uuid()::varchar, v.n, v.u, v.bu, 0, v.cat, 'STANDARD', 'SIMPLE', true
  FROM (VALUES
    ('Fanta',              'can',     'lata',    'mixer'),
    ('Red Bull',           'can',     'lata',    'mixer'),
    ('Hot Bbq',            'serving', 'porcion', 'food'),
    ('Tamarindo Habanero', 'serving', 'porcion', 'food'),
    ('Queso Extra',        'serving', 'porcion', 'food')
  ) AS v(n,u,bu,cat)
 WHERE NOT EXISTS (SELECT 1 FROM inventory_items i
                    WHERE lower(btrim(i.name)) = lower(btrim(v.n)));

-- ---------------------------------------------------------------------------
-- PART 3 — Wing Flavor rules: 7 flavours across 3 groups.
-- One serving of sauce per flavour selected; a 2-flavour order deducts 2.
-- ---------------------------------------------------------------------------
INSERT INTO modifier_inventory_rules (id, modifier_id, inventory_item_id, quantity)
SELECT gen_random_uuid()::varchar, m.id, i.id, 1
  FROM modifiers m
  JOIN modifier_groups g ON g.id = m.modifier_group_id
                        AND btrim(g.name) LIKE 'Wing Flavor%'
  JOIN inventory_items i ON lower(btrim(i.name)) = lower(btrim(m.name)) AND i.is_active
 WHERE m.is_active AND NOT m.deducts_no_inventory
   AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);

-- ---------------------------------------------------------------------------
-- PART 4 — Fanta (bottle service) and Queso Extra, matched by name
-- ---------------------------------------------------------------------------
INSERT INTO modifier_inventory_rules (id, modifier_id, inventory_item_id, quantity)
SELECT gen_random_uuid()::varchar, m.id, i.id, 1
  FROM modifiers m
  JOIN modifier_groups g ON g.id = m.modifier_group_id
                        AND btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio','Queso Extra')
  JOIN inventory_items i ON lower(btrim(i.name)) = lower(btrim(m.name)) AND i.is_active
 WHERE m.is_active AND NOT m.deducts_no_inventory
   AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);

-- ---------------------------------------------------------------------------
-- PART 5 — Sabor Michelada -> Clamato, 150 ml each.
-- Salsas negras / sal / limon remain untracked by decision.
-- ---------------------------------------------------------------------------
INSERT INTO modifier_inventory_rules (id, modifier_id, inventory_item_id, quantity)
SELECT gen_random_uuid()::varchar, m.id, '3a6e6fb2-0d47-4ec3-80d9-9361502e45b7', 150
  FROM modifiers m
  JOIN modifier_groups g ON g.id = m.modifier_group_id AND btrim(g.name) = 'Sabor Michelada'
 WHERE m.is_active AND NOT m.deducts_no_inventory
   AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);

-- ---------------------------------------------------------------------------
-- PART 6 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('031b','modifier_coverage',
        'portion_size added; missing sauce/soda items created at 0; all modifier rules seeded.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 7 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int; z int;
BEGIN
    -- the whole point of this migration
    SELECT count(*) INTO n FROM v_modifier_coverage_gaps;
    IF n <> 0 THEN
        RAISE EXCEPTION '031b: % modifier coverage gaps remain (expected 0)', n;
    END IF;

    -- Every ACTIVE wing modifier must have a rule. Deliberately not a fixed count:
    -- first run this is 21 (7 sauces x 3 groups); after 032b consolidates the three
    -- groups into one it is 7. The invariant is "no active wing option lacks a rule".
    SELECT count(*) INTO n
      FROM modifiers m
      JOIN modifier_groups g ON g.id = m.modifier_group_id
     WHERE btrim(g.name) LIKE 'Wing Flavor%' AND m.is_active
       AND NOT m.deducts_no_inventory
       AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);
    IF n <> 0 THEN RAISE EXCEPTION '031b: % active wing options have no sauce rule', n; END IF;

    -- michelada must deduct clamato in ml, not portions
    SELECT count(*) INTO n
      FROM modifier_inventory_rules r
      JOIN modifiers m ON m.id = r.modifier_id
      JOIN modifier_groups g ON g.id = m.modifier_group_id
     WHERE btrim(g.name) = 'Sabor Michelada' AND r.quantity = 150;
    IF n <> 3 THEN RAISE EXCEPTION '031b: % michelada clamato rules at 150ml, expected 3', n; END IF;

    -- clamato portions must now be derivable
    IF (SELECT portions_available FROM v_portion_availability
         WHERE id='3a6e6fb2-0d47-4ec3-80d9-9361502e45b7') IS NULL THEN
        RAISE EXCEPTION '031b: clamato portion_size not set';
    END IF;

    -- new items must be at zero, awaiting a physical count
    SELECT count(*) INTO z FROM inventory_items
     WHERE btrim(name) IN ('Fanta','Red Bull','Hot Bbq','Tamarindo Habanero','Queso Extra')
       AND stock_quantity <> 0;
    IF z <> 0 THEN
        RAISE EXCEPTION '031b: % newly created items have non-zero stock -- counts must come from a physical count', z;
    END IF;

    RAISE NOTICE '031b OK -- coverage gaps 0, 21 wing rules, clamato = % porciones',
        (SELECT portions_available FROM v_portion_availability
          WHERE id='3a6e6fb2-0d47-4ec3-80d9-9361502e45b7');
END $$;

COMMIT;
