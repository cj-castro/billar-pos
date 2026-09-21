-- ============================================================================
-- 031_modifier_inventory.sql
-- Stage 4 — Modifier quantity, deduction coverage, restore-on-remove
--
-- 34 of 65 active modifiers currently deduct NOTHING, including every option of
-- 'Servicio Tequila y Whisky' (the bottle-service mixers) -- so every soda served
-- with an $800-979 bottle is untracked loss whose cost never reaches
-- sale_item_costs, overstating bottle-service margin.
--
-- Also: removing a modifier is currently a hard DELETE, leaving no audit trail
-- and no record that stock should be restored.
--
-- Depends on: 027, 027b, 029
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('029') THEN
        RAISE EXCEPTION 'Migration 029 must be applied before 031.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Modifier quantity + soft-void
-- ---------------------------------------------------------------------------
ALTER TABLE line_item_modifiers
    ADD COLUMN IF NOT EXISTS quantity           numeric(12,4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS inventory_deducted boolean       NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS voided_at          timestamptz,
    ADD COLUMN IF NOT EXISTS voided_by          varchar(36) REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS void_reason        varchar(40),
    ADD COLUMN IF NOT EXISTS grant_id           varchar(36) REFERENCES authorization_grants(id);

COMMENT ON COLUMN line_item_modifiers.quantity IS
    'Modifier units consumed. Replaces implicit line-quantity multiplication and '
    'the modifier_groups.split_modifier_qty workaround.';
COMMENT ON COLUMN line_item_modifiers.inventory_deducted IS
    'Guards against double-deduct on retry and no-op restore on removal.';

-- Backfill: existing rows are 1 unit x parent line quantity, matching the
-- _mod_mult behaviour at tickets.py:434.
UPDATE line_item_modifiers lm
   SET quantity = GREATEST(1, COALESCE(li.quantity, 1))
  FROM ticket_line_items li
 WHERE li.id = lm.line_item_id AND lm.quantity = 1;

-- Modifiers on already-routed lines were deducted, where a rule existed.
UPDATE line_item_modifiers lm SET inventory_deducted = true
  FROM ticket_line_items li
 WHERE li.id = lm.line_item_id
   AND li.status IN ('SENT','IN_PROGRESS','READY','SERVED')
   AND EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = lm.modifier_id);

CREATE INDEX IF NOT EXISTS idx_lim_active
    ON line_item_modifiers (line_item_id) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- PART 2 — Encoding repair.
-- UTF-8 bytes were reinterpreted as CP437 and re-encoded: n-tilde (C3 B1)
-- became two box-drawing chars, O-acute (C3 93) likewise. Two substitutions
-- fix all affected rows. Ticket snapshots are NOT touched -- they record what
-- was actually printed.
-- ---------------------------------------------------------------------------
UPDATE menu_items      SET name = replace(replace(name,'├▒','ñ'),'├ô','Ó') WHERE name ~ '├';
UPDATE modifiers       SET name = replace(replace(name,'├▒','ñ'),'├ô','Ó') WHERE name ~ '├';
UPDATE inventory_items SET name = replace(replace(name,'├▒','ñ'),'├ô','Ó') WHERE name ~ '├';
UPDATE menu_categories SET name = replace(replace(name,'├▒','ñ'),'├ô','Ó') WHERE name ~ '├';

-- ---------------------------------------------------------------------------
-- PART 3 — Group config integrity.
-- 'promo cubeta' (min 20 > max 1) and 'ttt' (mandatory, zero options) were
-- present earlier in this project and appear to have been removed manually;
-- these statements no-op if absent.
-- ---------------------------------------------------------------------------
UPDATE modifier_groups SET min_selections = 0, max_selections = 1, is_mandatory = false
 WHERE min_selections > max_selections;

UPDATE modifier_groups SET is_mandatory = false
 WHERE is_mandatory
   AND NOT EXISTS (SELECT 1 FROM modifiers m
                    WHERE m.modifier_group_id = modifier_groups.id AND m.is_active);

DO $$ BEGIN
    ALTER TABLE modifier_groups ADD CONSTRAINT ck_mg_min_le_max
        CHECK (min_selections <= max_selections) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A group is only unsatisfiable if it has NO active options, or if it needs more
-- distinct options than exist AND repetition is not allowed. Cubeta Regular has
-- min_selections=10 with only 5 options and is perfectly satisfiable because
-- allow_multiple lets the same beer be picked repeatedly.
CREATE OR REPLACE VIEW v_modifier_groups_unsatisfiable AS
SELECT g.id, g.name, g.min_selections, g.max_selections, g.allow_multiple,
       count(m.id) FILTER (WHERE m.is_active) AS active_options
  FROM modifier_groups g
  LEFT JOIN modifiers m ON m.modifier_group_id = g.id
 -- Only groups ATTACHED to a live product can make anything unsellable. Groups
 -- retired by 032b/032c (Wing Flavor 300gr/700gr, Rusa Refresco) have zero active
 -- options by design and are attached to nothing, so they are not a problem.
 WHERE EXISTS (SELECT 1 FROM menu_item_modifier_groups mg
                JOIN menu_items mi ON mi.id = mg.menu_item_id AND mi.is_active
               WHERE mg.modifier_group_id = g.id)
 GROUP BY g.id, g.name, g.min_selections, g.max_selections, g.allow_multiple
HAVING count(m.id) FILTER (WHERE m.is_active) = 0
    OR (NOT g.allow_multiple
        AND g.min_selections > count(m.id) FILTER (WHERE m.is_active));

-- ---------------------------------------------------------------------------
-- PART 4 — Seed the unambiguous missing rules.
-- Bottle-service mixers (1 unit each) + the one bucket beer that was missed.
-- Matched by explicit inventory UUID and a prefix on the option name, so the
-- encoding repair in PART 2 cannot break the join.
-- 'Sin refresco' deliberately gets NO rule.
-- ---------------------------------------------------------------------------
INSERT INTO modifier_inventory_rules (id, modifier_id, inventory_item_id, quantity)
SELECT gen_random_uuid()::varchar, m.id, v.inv_id, 1
  FROM (VALUES
    ('Agua Mineral%',    'ab8a7cc0-3f00-45ea-99e4-e3d64a5bf4f4'),
    ('Coca cola',        '3fc75811-6878-450a-950a-31ebf965fbac'),
    ('Coca cola Light%', 'e80bdaf9-144a-4eaf-a8f2-0eee38e8b8d2'),
    ('Fresca%',          'e3943616-1412-4fa1-91d6-d57a30c447eb'),
    ('Manzanita%',       '7e739b18-d4ae-4ea9-95b8-df999c6d0c9a'),
    ('Sprite%',          '409dec79-c454-4569-adc8-99af8ae43461')
  ) AS v(opt_pattern, inv_id)
  JOIN modifier_groups g ON btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio')
  JOIN modifiers m ON m.modifier_group_id = g.id AND m.is_active
                  AND btrim(m.name) LIKE v.opt_pattern
 WHERE NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);

-- Cubeta Regular: XX Ambar was the only beer without a rule
INSERT INTO modifier_inventory_rules (id, modifier_id, inventory_item_id, quantity)
SELECT gen_random_uuid()::varchar, m.id, '969633af-dec0-4cd5-8ec4-71e6af666ae3', 1
  FROM modifiers m
  JOIN modifier_groups g ON g.id = m.modifier_group_id AND btrim(g.name) = 'Cubeta Regular'
 WHERE btrim(m.name) = 'XX Ambar' AND m.is_active
   AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);

-- ---------------------------------------------------------------------------
-- PART 5 — Coverage tracking.
-- Some modifiers legitimately consume nothing ('Sin refresco'). Make that
-- explicit so it is distinguishable from an unconfigured modifier.
-- ---------------------------------------------------------------------------
ALTER TABLE modifiers
    ADD COLUMN IF NOT EXISTS deducts_no_inventory boolean NOT NULL DEFAULT false;

UPDATE modifiers SET deducts_no_inventory = true
 WHERE (btrim(name) ILIKE 'Sin %' OR btrim(name) ILIKE 'No %')
   AND NOT deducts_no_inventory;

COMMENT ON COLUMN modifiers.deducts_no_inventory IS
    'true = intentionally consumes nothing. Distinguishes a deliberate no-op from '
    'an unconfigured modifier in v_modifier_coverage_gaps.';

CREATE OR REPLACE VIEW v_modifier_coverage_gaps AS
SELECT g.name AS group_name, m.id AS modifier_id, m.name AS modifier_name,
       m.price_cents, m.deducts_no_inventory,
       (SELECT count(*) FROM line_item_modifiers lm WHERE lm.modifier_id = m.id) AS times_sold
  FROM modifiers m JOIN modifier_groups g ON g.id = m.modifier_group_id
 WHERE m.is_active AND NOT m.deducts_no_inventory
   AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id)
 ORDER BY times_sold DESC;

COMMENT ON VIEW v_modifier_coverage_gaps IS
    'Modifiers that should deduct but do not. Target is zero after 031b.';

-- ---------------------------------------------------------------------------
-- PART 6 — Deprecate the split-quantity workaround
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN modifier_groups.split_modifier_qty IS
    'DEPRECATED (031). Superseded by line_item_modifiers.quantity.';

-- ---------------------------------------------------------------------------
-- PART 7 — Authorization hook
-- ---------------------------------------------------------------------------
UPDATE authorized_actions
   SET description_es = 'Quitar modificador (precio o inventario)'
 WHERE action_code = 'LINE_ITEM.MODIFIER_REMOVE';

-- ---------------------------------------------------------------------------
-- PART 8 — Configuration
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('modifiers.enforce_option_stock',  'false'),
    ('modifiers.block_on_missing_rule', 'false'),
    ('modifiers.low_stock_warn_qty',    '5')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 9 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('031','modifier_inventory',
        'Modifier quantity + soft-void. Encoding repaired. Mixer + XX Ambar rules seeded.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 10 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT (SELECT count(*) FROM menu_items      WHERE name ~ '├')
         + (SELECT count(*) FROM modifiers       WHERE name ~ '├')
         + (SELECT count(*) FROM inventory_items WHERE name ~ '├')
         + (SELECT count(*) FROM menu_categories WHERE name ~ '├') INTO n;
    IF n <> 0 THEN RAISE EXCEPTION '031: % mojibake rows remain', n; END IF;

    SELECT count(*) INTO n FROM v_modifier_groups_unsatisfiable;
    IF n <> 0 THEN RAISE EXCEPTION '031: % unsatisfiable modifier groups', n; END IF;

    -- Every bottle-service mixer must now deduct EXCEPT Fanta, whose inventory
    -- item does not exist until 031b creates it. 031b asserts zero.
    SELECT count(*) INTO n
      FROM modifiers m
      JOIN modifier_groups g ON g.id = m.modifier_group_id
                            AND btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio')
     WHERE m.is_active AND NOT m.deducts_no_inventory
       AND btrim(m.name) NOT ILIKE 'Fanta%'
       AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);
    IF n <> 0 THEN
        RAISE EXCEPTION '031: % bottle-service mixers (excluding Fanta) still deduct nothing', n;
    END IF;

    -- and Fanta must be the ONLY remaining gap in that group
    SELECT count(*) INTO n
      FROM modifiers m
      JOIN modifier_groups g ON g.id = m.modifier_group_id
                            AND btrim(g.name) IN ('Servicio Tequila y Whisky','Refresco Servicio')
     WHERE m.is_active AND NOT m.deducts_no_inventory
       AND NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r WHERE r.modifier_id = m.id);
    -- At most one may remain, and only Fanta. On a FIRST run this is 1 (Fanta's
    -- inventory item does not exist until 031b); on a RE-RUN of the full suite it
    -- is 0 because 031b has since filled it. Asserting an exact intermediate value
    -- would make the file non-rerunnable.
    IF n > 1 THEN
        RAISE EXCEPTION '031: expected at most 1 pending mixer (Fanta), found %', n;
    END IF;

    -- XX Ambar specifically
    IF NOT EXISTS (SELECT 1 FROM modifier_inventory_rules r
                    JOIN modifiers m ON m.id = r.modifier_id
                   WHERE btrim(m.name) = 'XX Ambar') THEN
        RAISE EXCEPTION '031: XX Ambar still has no inventory rule';
    END IF;

    -- every modifier row must carry a positive quantity
    SELECT count(*) INTO n FROM line_item_modifiers WHERE quantity < 1;
    IF n <> 0 THEN RAISE EXCEPTION '031: % line_item_modifiers have quantity < 1', n; END IF;

    RAISE NOTICE '031 OK -- coverage gaps now %, mojibake 0, unsatisfiable 0',
        (SELECT count(*) FROM v_modifier_coverage_gaps);
END $$;

COMMIT;
