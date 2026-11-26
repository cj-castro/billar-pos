-- ============================================================================
-- 050_open_bottles_bar_count.sql
-- One record per opened bottle, and the blind bar count (batch E2, step 2).
--
--   open_bottles      every bottle opened: product, its own size (sizes vary),
--                     who / when, and when it was finished. Sales still draw
--                     from the spirit's pooled ml (oldest bottle first); the
--                     record is what the closer counts against.
--   bar_counts        one shift count: who, when, the cash session it belongs
--   bar_count_lines   to, and per item expected / counted / variance in units
--                     and pesos. Counted blind -- the closer never sees what
--                     the system expected.
--
-- fn_convert_stock gains p_yield (ml in THIS bottle, default the product's
-- configured size) and writes the open_bottles row itself, so a manual open
-- and an automatic one are recorded the same way.
--
-- Existing open stock becomes open_bottles rows (one per started 750 ml),
-- marked as pre-existing.
-- Depends on: 049
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('049') THEN RAISE EXCEPTION '049 must be applied before 050.'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS open_bottles (
    id               VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    bottle_item_id   VARCHAR(36) NOT NULL REFERENCES inventory_items(id),
    shot_item_id     VARCHAR(36) NOT NULL REFERENCES inventory_items(id),
    size_ml          NUMERIC(10,2) NOT NULL CHECK (size_ml > 0),
    opened_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    opened_by        VARCHAR(36) REFERENCES users(id),
    open_movement_id VARCHAR(36),
    finished_at      TIMESTAMPTZ,
    finished_by      VARCHAR(36) REFERENCES users(id),
    last_count_ml    NUMERIC(10,2),
    last_counted_at  TIMESTAMPTZ,
    notes            TEXT
);
CREATE INDEX IF NOT EXISTS idx_open_bottles_open ON open_bottles (shot_item_id, opened_at) WHERE finished_at IS NULL;

CREATE TABLE IF NOT EXISTS bar_counts (
    id                    VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    counted_by            VARCHAR(36) NOT NULL REFERENCES users(id),
    counted_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    cash_session_id       VARCHAR(36),
    notes                 TEXT,
    total_variance_cents  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bar_counts_at ON bar_counts (counted_at DESC);

CREATE TABLE IF NOT EXISTS bar_count_lines (
    id                VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    bar_count_id      VARCHAR(36) NOT NULL REFERENCES bar_counts(id) ON DELETE CASCADE,
    inventory_item_id VARCHAR(36) NOT NULL REFERENCES inventory_items(id),
    kind              VARCHAR(10) NOT NULL CHECK (kind IN ('OPEN','SEALED')),
    expected_qty      NUMERIC(12,4) NOT NULL,
    counted_qty       NUMERIC(12,4) NOT NULL,
    variance_qty      NUMERIC(12,4) NOT NULL,
    unit_cost_cents   NUMERIC(14,4) NOT NULL DEFAULT 0,
    variance_cents    BIGINT NOT NULL DEFAULT 0,
    detail            JSONB
);
CREATE INDEX IF NOT EXISTS idx_bar_count_lines_count ON bar_count_lines (bar_count_id);

-- fn_convert_stock with an optional per-bottle yield. Dropped first: adding a
-- defaulted parameter would otherwise leave an ambiguous overload.
DROP FUNCTION IF EXISTS fn_convert_stock(varchar, numeric, varchar, varchar, text);
CREATE OR REPLACE FUNCTION fn_convert_stock(
    p_from_item varchar, p_units numeric, p_user varchar,
    p_reference varchar DEFAULT NULL, p_reason text DEFAULT NULL,
    p_yield numeric DEFAULT NULL)
 RETURNS TABLE(from_new_stock numeric, to_item varchar, to_new_stock numeric, units_created numeric)
 LANGUAGE plpgsql
AS $function$
DECLARE c record;
        v_from numeric;   v_from_wac numeric;
        v_to_old numeric; v_to_wac_old numeric;
        v_to numeric;     v_to_wac numeric;
        v_created numeric; v_per_unit numeric;
        v_in_id varchar := gen_random_uuid()::varchar;
BEGIN
    IF p_units <= 0 THEN
        RAISE EXCEPTION 'units must be positive, got %', p_units;
    END IF;
    IF p_yield IS NOT NULL AND p_yield <= 0 THEN
        RAISE EXCEPTION 'yield must be positive, got %', p_yield;
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

    v_per_unit := COALESCE(p_yield, c.ratio);
    v_created := floor(p_units * v_per_unit * (1 - c.loss_factor));
    IF v_created <= 0 THEN
        RAISE EXCEPTION 'CONVERSION_YIELDS_ZERO: % unit(s) of % produce nothing (ratio %, loss %)',
            p_units, p_from_item, v_per_unit, c.loss_factor;
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
    VALUES (v_in_id, c.to_item_id, 'CONVERSION_IN', v_created, v_to,
            v_to_wac, p_reference,
            COALESCE(p_reason, format('Desde %s x %s', p_units, c.conversion_type)),
            p_user, clock_timestamp());

    -- One record per opened bottle (batch E2): each with its own size.
    IF c.conversion_type = 'BOTTLE_TO_SHOT' THEN
        INSERT INTO open_bottles (bottle_item_id, shot_item_id, size_ml, opened_by, open_movement_id)
        SELECT p_from_item, c.to_item_id, v_per_unit * (1 - c.loss_factor), p_user, v_in_id
          FROM generate_series(1, GREATEST(1, floor(p_units)::int));
    END IF;

    RETURN QUERY SELECT v_from, c.to_item_id, v_to, v_created;
END $function$;

-- Existing open stock: one record per started bottle of the configured size.
INSERT INTO open_bottles (bottle_item_id, shot_item_id, size_ml, opened_at, notes)
SELECT c.from_item_id, c.to_item_id, c.ratio, now(), 'Ya abierta al instalar el registro por botella (050)'
  FROM inventory_conversions c
  JOIN inventory_items s ON s.id = c.to_item_id
  CROSS JOIN LATERAL generate_series(1, ceil(s.stock_quantity / c.ratio)::int)
 WHERE c.is_active AND c.conversion_type = 'BOTTLE_TO_SHOT' AND s.stock_quantity > 0
   AND NOT EXISTS (SELECT 1 FROM open_bottles ob WHERE ob.shot_item_id = c.to_item_id);

INSERT INTO schema_migrations (version, name, notes)
VALUES ('050', 'open_bottles_bar_count',
        'open_bottles per opened bottle (own size); blind bar count with variance in pesos; fn_convert_stock p_yield.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '050_open_bottles_bar_count: OK'; END $done$;

COMMIT;
