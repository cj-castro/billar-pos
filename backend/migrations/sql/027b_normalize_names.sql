-- ============================================================================
-- 027b_normalize_names.sql
-- Trim and collapse whitespace so downstream exact-name matches are reliable.
--
-- Motivation: 14 active names carry leading/trailing/double whitespace, e.g.
-- '[Red bull ]' and '[Vaso Ruso ]'. Migrations 031d and 034b match on exact
-- names and would have SILENTLY seeded nothing -- the worst failure mode,
-- because the migration reports success.
--
-- Depends on: 027 (needs schema_migrations)
-- MUST precede: 031d, 034b, 035b
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '027') THEN
        RAISE EXCEPTION '027 must be applied before 027b.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Collision guard. inventory_items.name is UNIQUE, so abort rather
-- than fail mid-way if normalising would merge two distinct rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_dup int;
BEGIN
    SELECT count(*) INTO v_dup FROM (
        SELECT regexp_replace(btrim(name), '\s+', ' ', 'g') AS clean
          FROM inventory_items GROUP BY 1 HAVING count(*) > 1) d;
    IF v_dup > 0 THEN
        RAISE EXCEPTION 'ABORT: normalising would create % duplicate inventory name(s)', v_dup
            USING HINT = 'Merge or rename the colliding items first.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 2 — Normalise. Historical snapshots (ticket_line_items.item_name,
-- line_item_modifiers.name_snapshot) are deliberately NOT touched: they record
-- what was actually printed on the ticket.
-- ---------------------------------------------------------------------------
UPDATE inventory_items  SET name = regexp_replace(btrim(name), '\s+', ' ', 'g')
 WHERE name <> regexp_replace(btrim(name), '\s+', ' ', 'g');
UPDATE menu_items       SET name = regexp_replace(btrim(name), '\s+', ' ', 'g')
 WHERE name <> regexp_replace(btrim(name), '\s+', ' ', 'g');
UPDATE modifiers        SET name = regexp_replace(btrim(name), '\s+', ' ', 'g')
 WHERE name <> regexp_replace(btrim(name), '\s+', ' ', 'g');
UPDATE modifier_groups  SET name = regexp_replace(btrim(name), '\s+', ' ', 'g')
 WHERE name <> regexp_replace(btrim(name), '\s+', ' ', 'g');
UPDATE menu_categories  SET name = regexp_replace(btrim(name), '\s+', ' ', 'g')
 WHERE name <> regexp_replace(btrim(name), '\s+', ' ', 'g');

-- ---------------------------------------------------------------------------
-- PART 3 — Prevent recurrence
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_normalize_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.name IS NOT NULL THEN
        NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_normalize_name ON inventory_items;
CREATE TRIGGER trg_normalize_name BEFORE INSERT OR UPDATE OF name ON inventory_items
    FOR EACH ROW EXECUTE FUNCTION fn_normalize_name();

DROP TRIGGER IF EXISTS trg_normalize_name ON menu_items;
CREATE TRIGGER trg_normalize_name BEFORE INSERT OR UPDATE OF name ON menu_items
    FOR EACH ROW EXECUTE FUNCTION fn_normalize_name();

DROP TRIGGER IF EXISTS trg_normalize_name ON modifiers;
CREATE TRIGGER trg_normalize_name BEFORE INSERT OR UPDATE OF name ON modifiers
    FOR EACH ROW EXECUTE FUNCTION fn_normalize_name();

DROP TRIGGER IF EXISTS trg_normalize_name ON modifier_groups;
CREATE TRIGGER trg_normalize_name BEFORE INSERT OR UPDATE OF name ON modifier_groups
    FOR EACH ROW EXECUTE FUNCTION fn_normalize_name();

DROP TRIGGER IF EXISTS trg_normalize_name ON menu_categories;
CREATE TRIGGER trg_normalize_name BEFORE INSERT OR UPDATE OF name ON menu_categories
    FOR EACH ROW EXECUTE FUNCTION fn_normalize_name();

-- ---------------------------------------------------------------------------
-- PART 4 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('027b','normalize_names','Trimmed stray whitespace; trigger prevents recurrence.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM (
        SELECT 1 FROM inventory_items WHERE name <> btrim(name) OR name LIKE '%  %'
        UNION ALL SELECT 1 FROM menu_items      WHERE name <> btrim(name) OR name LIKE '%  %'
        UNION ALL SELECT 1 FROM modifiers       WHERE name <> btrim(name) OR name LIKE '%  %'
        UNION ALL SELECT 1 FROM modifier_groups WHERE name <> btrim(name) OR name LIKE '%  %'
        UNION ALL SELECT 1 FROM menu_categories WHERE name <> btrim(name) OR name LIKE '%  %'
    ) x;
    IF n <> 0 THEN RAISE EXCEPTION '027b: % names still carry stray whitespace', n; END IF;

    -- the two names that would have silently broken 031d and 034b
    IF NOT EXISTS (SELECT 1 FROM menu_items WHERE name = 'Red bull') THEN
        RAISE EXCEPTION '027b: expected menu item "Red bull" after normalisation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM menu_items WHERE name = 'Vaso Ruso') THEN
        RAISE EXCEPTION '027b: expected menu item "Vaso Ruso" after normalisation';
    END IF;

    RAISE NOTICE '027b OK -- whitespace clean; Red bull and Vaso Ruso now match exactly';
END $$;

COMMIT;
