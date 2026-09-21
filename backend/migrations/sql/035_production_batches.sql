-- ============================================================================
-- 035_production_batches.sql
-- Stage 8 — Production with MEASURED yield variance
--
-- Three distinct mechanisms now exist, and keeping them apart matters because
-- they fail differently:
--   conversion (029) ratio is fixed and exact      -- pack->loose, bottle->shot
--   portion    (031b) derived by division          -- clamato ml, salchicha g
--   production (this) yield is ESTIMATED and varies -- bottle -> N ramekins
--
-- The defining feature of production is that actual differs from expected, and
-- that difference IS the information: shrinkage, over-portioning, spoilage.
-- Ships disabled until sauce bulk stock is counted.
-- Depends on: 029
-- ============================================================================
BEGIN;
DO $$ BEGIN
    IF NOT _applied('029') THEN RAISE EXCEPTION '029 must be applied before 035.'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS production_recipes (
    id                varchar(36)   PRIMARY KEY,
    output_item_id    varchar(36)   NOT NULL REFERENCES inventory_items(id),
    expected_yield    numeric(12,4) NOT NULL,
    yield_unit_key    varchar(50)   REFERENCES unit_catalog(key),
    variance_warn_pct numeric(5,2)  NOT NULL DEFAULT 10,
    notes             text,
    is_active         boolean       NOT NULL DEFAULT true,
    created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_prod_yield_positive CHECK (expected_yield > 0),
    CONSTRAINT uq_prod_recipe_output  UNIQUE (output_item_id)
);

CREATE TABLE IF NOT EXISTS production_recipe_inputs (
    id                   varchar(36)   PRIMARY KEY,
    production_recipe_id varchar(36)   NOT NULL REFERENCES production_recipes(id) ON DELETE CASCADE,
    input_item_id        varchar(36)   NOT NULL REFERENCES inventory_items(id),
    quantity             numeric(12,4) NOT NULL,
    unit_key             varchar(50)   REFERENCES unit_catalog(key),
    CONSTRAINT ck_prod_input_positive CHECK (quantity > 0),
    CONSTRAINT uq_prod_input UNIQUE (production_recipe_id, input_item_id)
);

CREATE TABLE IF NOT EXISTS production_batches (
    id                     varchar(36)   PRIMARY KEY,
    batch_number           bigserial     UNIQUE,
    production_recipe_id   varchar(36)   REFERENCES production_recipes(id),
    output_item_id         varchar(36)   NOT NULL REFERENCES inventory_items(id),
    expected_yield         numeric(12,4) NOT NULL,
    actual_yield           numeric(12,4),
    variance               numeric(12,4) GENERATED ALWAYS AS (actual_yield - expected_yield) STORED,
    variance_pct           numeric(8,2),
    status                 varchar(20)   NOT NULL DEFAULT 'OPEN',
    produced_by            varchar(36)   NOT NULL REFERENCES users(id),
    started_at             timestamptz   NOT NULL DEFAULT clock_timestamp(),
    completed_at           timestamptz,
    input_cost_cents       integer,
    output_unit_cost_cents integer,
    grant_id               varchar(36)   REFERENCES authorization_grants(id),
    notes                  text,
    CONSTRAINT ck_batch_status CHECK (status IN ('OPEN','COMPLETED','CANCELLED')),
    CONSTRAINT ck_batch_completed CHECK (
        (status = 'COMPLETED' AND actual_yield IS NOT NULL AND completed_at IS NOT NULL)
        OR status <> 'COMPLETED')
);

CREATE TABLE IF NOT EXISTS production_batch_inputs (
    id                varchar(36)   PRIMARY KEY,
    batch_id          varchar(36)   NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
    inventory_item_id varchar(36)   NOT NULL REFERENCES inventory_items(id),
    quantity_consumed numeric(12,4) NOT NULL,
    unit_key          varchar(50),
    unit_cost_cents   integer,
    movement_id       varchar(36)
);

CREATE INDEX IF NOT EXISTS idx_batches_open   ON production_batches (started_at DESC) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS idx_batches_output ON production_batches (output_item_id, started_at DESC);

-- Complete a batch: consume inputs, yield output, roll cost up on ACTUAL yield.
CREATE OR REPLACE FUNCTION fn_complete_batch(
    p_batch_id varchar(36), p_actual_yield numeric, p_user varchar(36),
    p_grant_id varchar(36) DEFAULT NULL)
RETURNS TABLE (out_variance numeric, out_variance_pct numeric,
               out_unit_cost_cents integer, out_needs_authorization boolean)
LANGUAGE plpgsql AS $$
DECLARE b record; i record; v_new numeric; v_cost numeric := 0;
        v_pct numeric; v_warn numeric; v_unit integer;
BEGIN
    SELECT * INTO b FROM production_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown batch %', p_batch_id; END IF;
    IF b.status <> 'OPEN' THEN RAISE EXCEPTION 'Batch % is %', p_batch_id, b.status; END IF;
    IF p_actual_yield < 0 THEN RAISE EXCEPTION 'actual_yield cannot be negative'; END IF;

    v_pct := round(((p_actual_yield - b.expected_yield) / b.expected_yield) * 100, 2);
    SELECT COALESCE(pr.variance_warn_pct, 10) INTO v_warn
      FROM production_recipes pr WHERE pr.id = b.production_recipe_id;

    IF abs(v_pct) > COALESCE(v_warn, 10) AND p_grant_id IS NULL THEN
        RETURN QUERY SELECT (p_actual_yield - b.expected_yield), v_pct, NULL::integer, true;
        RETURN;
    END IF;

    FOR i IN SELECT * FROM production_batch_inputs WHERE batch_id = p_batch_id LOOP
        PERFORM 1 FROM inventory_items WHERE id = i.inventory_item_id FOR UPDATE;
        SELECT ii.stock_quantity - i.quantity_consumed INTO v_new
          FROM inventory_items ii WHERE ii.id = i.inventory_item_id;
        IF v_new < 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_INPUT: item % would go negative', i.inventory_item_id;
        END IF;
        UPDATE inventory_items SET stock_quantity = v_new, updated_at = clock_timestamp()
         WHERE id = i.inventory_item_id;
        INSERT INTO inventory_movements (id, inventory_item_id, event_type, quantity_delta,
            quantity_after, reference_id, reason, performed_by, created_at)
        VALUES (gen_random_uuid()::varchar, i.inventory_item_id, 'PRODUCTION_CONSUME',
                -i.quantity_consumed, v_new, p_batch_id,
                format('Lote produccion #%s', b.batch_number), p_user, clock_timestamp());
        v_cost := v_cost + COALESCE(i.unit_cost_cents,0) * i.quantity_consumed;
    END LOOP;

    PERFORM 1 FROM inventory_items WHERE id = b.output_item_id FOR UPDATE;
    SELECT ii.stock_quantity + p_actual_yield INTO v_new
      FROM inventory_items ii WHERE ii.id = b.output_item_id;
    UPDATE inventory_items SET stock_quantity = v_new, updated_at = clock_timestamp()
     WHERE id = b.output_item_id;

    v_unit := CASE WHEN p_actual_yield > 0 THEN round(v_cost / p_actual_yield)::integer END;

    INSERT INTO inventory_movements (id, inventory_item_id, event_type, quantity_delta,
        quantity_after, reference_id, reason, performed_by, unit_cost_cents, created_at)
    VALUES (gen_random_uuid()::varchar, b.output_item_id, 'PRODUCTION_YIELD',
            p_actual_yield, v_new, p_batch_id,
            format('Lote #%s (esperado %s, real %s)', b.batch_number, b.expected_yield, p_actual_yield),
            p_user, v_unit, clock_timestamp());

    UPDATE inventory_items SET unit_cost_cents = v_unit
     WHERE id = b.output_item_id AND v_unit IS NOT NULL;

    UPDATE production_batches
       SET status='COMPLETED', actual_yield=p_actual_yield, completed_at=clock_timestamp(),
           variance_pct=v_pct, input_cost_cents=v_cost::integer,
           output_unit_cost_cents=v_unit, grant_id=p_grant_id
     WHERE id = p_batch_id;

    RETURN QUERY SELECT (p_actual_yield - b.expected_yield), v_pct, v_unit, false;
END $$;

INSERT INTO authorized_actions
 (action_code, description_es, category, min_role, requires_pin, requires_reason,
  reduces_value, increases_inventory) VALUES
 -- increases_inventory = FALSE: a batch is a TRANSFORMATION (inputs consumed,
 -- outputs yielded), not stock appearing from nowhere -- same reasoning as
 -- INVENTORY.PACK_OPEN. Marking it true would violate 028's invariant that
 -- every inventory-increasing action demands a manager PIN, and would force a
 -- PIN every time a bartender fills ramekins. The manager gate belongs on
 -- PRODUCTION.VARIANCE_APPROVE, which does require one.
 ('PRODUCTION.BATCH_CREATE','Registrar lote de produccion','INVENTORY','BAR_STAFF',false,false,false,false),
 ('PRODUCTION.VARIANCE_APPROVE','Aprobar merma fuera de rango','INVENTORY','MANAGER',true,true,false,false),
 ('PRODUCTION.BATCH_CANCEL','Cancelar lote','INVENTORY','MANAGER',true,true,false,true)
ON CONFLICT (action_code) DO NOTHING;

UPDATE authorized_actions SET increases_inventory = false
 WHERE action_code = 'PRODUCTION.BATCH_CREATE' AND increases_inventory;

INSERT INTO settings (key, value) VALUES
    ('production.default_variance_warn_pct','10'),
    ('production.require_grant_above_pct','15'),
    ('production.enabled','false')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE VIEW v_production_variance AS
SELECT b.batch_number, i.name AS producto, b.expected_yield, b.actual_yield,
       b.variance, b.variance_pct, b.status, u.name AS producido_por,
       b.started_at::date AS fecha, b.input_cost_cents/100.0 AS costo_insumos,
       b.output_unit_cost_cents/100.0 AS costo_unitario,
       (b.grant_id IS NOT NULL) AS requirio_autorizacion
  FROM production_batches b
  JOIN inventory_items i ON i.id = b.output_item_id
  JOIN users u ON u.id = b.produced_by
 ORDER BY b.started_at DESC;

CREATE OR REPLACE VIEW v_production_yield_trend AS
SELECT i.name AS producto, count(*) AS lotes,
       round(avg(b.variance_pct),2) AS variacion_promedio_pct,
       round(stddev(b.variance_pct),2) AS desviacion,
       min(b.variance_pct) AS peor, max(b.variance_pct) AS mejor,
       round(avg(b.output_unit_cost_cents))::integer AS costo_unitario_promedio
  FROM production_batches b JOIN inventory_items i ON i.id = b.output_item_id
 WHERE b.status='COMPLETED'
 GROUP BY i.name HAVING count(*) >= 2;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('035','production_batches','Production recipes + batches with measured variance and cost rollup.')
ON CONFLICT (version) DO NOTHING;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM authorized_actions WHERE action_code='PRODUCTION.VARIANCE_APPROVE'
                    AND requires_pin AND requires_reason) THEN
        RAISE EXCEPTION '035: VARIANCE_APPROVE must require PIN + reason';
    END IF;
    IF (SELECT lower(value) FROM settings WHERE key='production.enabled') <> 'false' THEN
        RAISE EXCEPTION '035: production must ship disabled';
    END IF;
    RAISE NOTICE '035 OK -- production tables + fn_complete_batch, disabled pending sauce counts';
END $$;
COMMIT;
