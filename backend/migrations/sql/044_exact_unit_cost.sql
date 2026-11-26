-- ============================================================================
-- 044_exact_unit_cost.sql
-- Unit cost with sub-centavo precision.
--
-- THE BUG THIS FIXES
--
-- unit_cost_cents was an INTEGER number of centavos per BASE unit. Fine for a
-- bottle; wrong for anything stocked in ml or grams:
--     catsup  3,780 ml for $120   = 3.1746 ¢/ml  -> stored 3  (5.5% low)
--     salt    1 kg for $18        = 1.8 ¢/g      -> stored 2  (11% high)
--     cheaper items                               -> stored 0  ("no cost")
-- Every recipe measured in ml/g (micheladas, sauces, garnish) carried a wrong
-- cost, and very cheap ingredients read as uncosted.
--
-- WHAT CHANGES
--
-- unit_cost_cents becomes NUMERIC(14,4) -- still CENTAVOS (so every reader keeps
-- working), now with 4 decimals -- on:
--     inventory_items       (weighted average cost per base unit)
--     inventory_movements   (cost snapshot on each movement)
--     sale_item_costs       (cost snapshot per deduction)
-- Money totals (sale_item_costs.total_cost_cents) stay INTEGER centavos: the
-- exact unit cost is multiplied by the quantity and rounded ONCE.
--
-- Postgres cannot change a column's type while views read it, so every view
-- that depends on these columns -- and every view that depends on THOSE -- is
-- saved, dropped (deepest first), and re-created from its own definition after
-- the change (shallowest first). Nothing about the views changes except that
-- cost columns become NUMERIC.
--
-- fn_convert_stock (bottle -> shots) is re-created with numeric arithmetic so
-- the cost it carries to the shots keeps the precision.
--
-- Depends on: 043
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('043') THEN RAISE EXCEPTION '043 must be applied before 044.'; END IF;
END $$;

SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1. Save every view that (transitively) depends on the three columns
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _saved_views (name text PRIMARY KEY, def text NOT NULL, depth int NOT NULL)
    ON COMMIT DROP;

WITH RECURSIVE roots AS (
    SELECT DISTINCT r.ev_class AS v
      FROM pg_depend d
      JOIN pg_rewrite r   ON r.oid = d.objid
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE d.classid = 'pg_rewrite'::regclass
       AND d.refobjid IN ('public.inventory_items'::regclass,
                          'public.inventory_movements'::regclass,
                          'public.sale_item_costs'::regclass)
       AND a.attname = 'unit_cost_cents'
       AND r.ev_class <> d.refobjid
), tree (v, depth) AS (
    SELECT v, 0 FROM roots
    UNION ALL
    SELECT r.ev_class, t.depth + 1
      FROM tree t
      JOIN pg_depend d  ON d.refobjid = t.v AND d.classid = 'pg_rewrite'::regclass
      JOIN pg_rewrite r ON r.oid = d.objid
     WHERE r.ev_class <> t.v
)
INSERT INTO _saved_views (name, def, depth)
SELECT c.relname, rtrim(pg_get_viewdef(c.oid), '; ' || chr(10)), max(t.depth)
  FROM tree t
  JOIN pg_class c ON c.oid = t.v
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
 WHERE c.relkind = 'v'
 GROUP BY c.oid, c.relname;

DO $$
DECLARE r record; n int;
BEGIN
    SELECT count(*) INTO n FROM _saved_views;
    RAISE NOTICE '044: % dependent view(s) saved for rebuild', n;
    -- deepest first, so nothing is dropped while something still reads it
    FOR r IN SELECT name FROM _saved_views ORDER BY depth DESC, name LOOP
        EXECUTE format('DROP VIEW public.%I', r.name);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The type change itself
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventory_items     ALTER COLUMN unit_cost_cents TYPE numeric(14,4);
ALTER TABLE public.inventory_movements ALTER COLUMN unit_cost_cents TYPE numeric(14,4);
ALTER TABLE public.sale_item_costs     ALTER COLUMN unit_cost_cents TYPE numeric(14,4);

COMMENT ON COLUMN public.inventory_items.unit_cost_cents IS
    'Weighted average cost per BASE unit, in centavos with 4 decimals (e.g. 3.1746 = $0.031746 per ml)';

-- ---------------------------------------------------------------------------
-- 3. Re-create the saved views, shallowest first
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; n_saved int; n_back int;
BEGIN
    FOR r IN SELECT name, def FROM _saved_views ORDER BY depth, name LOOP
        EXECUTE format('CREATE VIEW public.%I AS %s', r.name, r.def);
    END LOOP;
    SELECT count(*) INTO n_saved FROM _saved_views;
    SELECT count(*) INTO n_back FROM _saved_views s
      JOIN pg_views v ON v.schemaname = 'public' AND v.viewname = s.name;
    IF n_back <> n_saved THEN
        RAISE EXCEPTION '044: rebuilt % of % views', n_back, n_saved;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. fn_convert_stock with numeric cost arithmetic (same logic as 040)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_convert_stock(
    p_from_item character varying,
    p_units     numeric,
    p_user      character varying,
    p_reference character varying DEFAULT NULL::character varying,
    p_reason    text DEFAULT NULL::text)
RETURNS TABLE(from_new_stock numeric, to_item character varying,
              to_new_stock numeric, units_created numeric)
LANGUAGE plpgsql
AS $$
DECLARE c record;
        v_from numeric;   v_from_wac numeric;
        v_to_old numeric; v_to_wac_old numeric;
        v_to numeric;     v_to_wac numeric;
        v_created numeric;
BEGIN
    IF p_units <= 0 THEN
        RAISE EXCEPTION 'units must be positive, got %', p_units;
    END IF;

    SELECT * INTO c FROM inventory_conversions
     WHERE from_item_id = p_from_item AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active conversion defined for item %', p_from_item;
    END IF;

    PERFORM 1 FROM inventory_items
      WHERE id IN (p_from_item, c.to_item_id) ORDER BY id FOR UPDATE;

    SELECT stock_quantity, COALESCE(unit_cost_cents, 0)
      INTO v_from, v_from_wac
      FROM inventory_items WHERE id = p_from_item;
    IF v_from < p_units THEN
        RAISE EXCEPTION 'INSUFFICIENT_SOURCE: % has %, need %', p_from_item, v_from, p_units;
    END IF;

    v_created := floor(p_units * c.ratio * (1 - c.loss_factor));
    IF v_created <= 0 THEN
        RAISE EXCEPTION 'CONVERSION_YIELDS_ZERO: % unit(s) of % produce nothing (ratio %, loss %)',
            p_units, p_from_item, c.ratio, c.loss_factor;
    END IF;

    SELECT stock_quantity, COALESCE(unit_cost_cents, 0)
      INTO v_to_old, v_to_wac_old
      FROM inventory_items WHERE id = c.to_item_id;

    IF v_to_old <= 0 THEN
        v_to_wac := round((p_units * v_from_wac) / v_created, 4);
    ELSE
        v_to_wac := round((v_to_old * v_to_wac_old + p_units * v_from_wac)
                          / (v_to_old + v_created), 4);
    END IF;

    v_from := v_from - p_units;
    v_to   := v_to_old + v_created;

    UPDATE inventory_items SET stock_quantity = v_from, updated_at = clock_timestamp()
     WHERE id = p_from_item;
    INSERT INTO inventory_movements
       (id, inventory_item_id, event_type, quantity_delta, quantity_after,
        unit_cost_cents, reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, p_from_item, 'CONVERSION_OUT', -p_units, v_from,
            v_from_wac, p_reference,
            COALESCE(p_reason, format('Conversion %s -> %s', p_units, v_created)),
            p_user, clock_timestamp());

    UPDATE inventory_items SET stock_quantity = v_to, unit_cost_cents = v_to_wac,
                               updated_at = clock_timestamp()
     WHERE id = c.to_item_id;
    INSERT INTO inventory_movements
       (id, inventory_item_id, event_type, quantity_delta, quantity_after,
        unit_cost_cents, reference_id, reason, performed_by, created_at)
    VALUES (gen_random_uuid()::varchar, c.to_item_id, 'CONVERSION_IN', v_created, v_to,
            v_to_wac, p_reference,
            COALESCE(p_reason, format('Desde %s x %s', p_units, c.conversion_type)),
            p_user, clock_timestamp());

    RETURN QUERY SELECT v_from, c.to_item_id, v_to, v_created;
END $$;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('044', 'exact_unit_cost',
        'unit_cost_cents NUMERIC(14,4) on items/movements/sale costs; dependent views rebuilt.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '044_exact_unit_cost: OK'; END $done$;

COMMIT;
