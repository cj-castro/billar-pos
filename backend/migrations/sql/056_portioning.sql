-- ============================================================================
-- 056_portioning.sql
-- Portioning in house: raw by the kilo -> packs (batch E8).
--
-- Fried products (alitas, boneless, tenders, papas, dedos de queso, aros de
-- cebolla...) arrive by the case (~15 kg) and are portioned on arrival into
-- packs (300 g, 700 g...). Until now only the packs existed, restocked by hand
-- at $0: purchases (kg) could not be reconciled with sales (packs), the real
-- yield of a case was unknown and so was the cost of a pack.
--
--   raw item        stocked in kg (or g / l / ml), bought by the case
--   pack item       base unit "paquete", portion_size = its weight (g / ml),
--                   portion_source_id = the raw item it is made from
--   portion_batches one portioning: raw used, packs out per size, waste, yield,
--                   the case's cost spread over the packs by weight
--
-- Ledger: PRODUCTION_CONSUME (raw, -kg) and PRODUCTION_YIELD (pack, +n) -- an internal move,
-- never "usage". Sales keep deducting 1 pack.
-- Depends on: 055
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('055') THEN RAISE EXCEPTION '055 must be applied before 056.'; END IF;
END $$;

INSERT INTO unit_catalog (key, name_es, name_en, active, allows_fraction)
VALUES ('paquete', 'Paquete', 'Pack', TRUE, FALSE)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE inventory_items
    ADD COLUMN IF NOT EXISTS portion_source_id VARCHAR(36) REFERENCES inventory_items(id);
CREATE INDEX IF NOT EXISTS idx_items_portion_source ON inventory_items (portion_source_id) WHERE portion_source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS portion_batches (
    id               VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    batch_number     BIGSERIAL UNIQUE,
    raw_item_id      VARCHAR(36) NOT NULL REFERENCES inventory_items(id),
    raw_used         NUMERIC(12,4) NOT NULL CHECK (raw_used > 0),   -- in the raw item's unit (kg)
    raw_used_g       NUMERIC(14,2) NOT NULL,                        -- same, in g / ml
    output_g         NUMERIC(14,2) NOT NULL,
    waste_g          NUMERIC(14,2) NOT NULL,
    yield_pct        NUMERIC(6,2)  NOT NULL,
    input_cost_cents BIGINT        NOT NULL DEFAULT 0,
    performed_by     VARCHAR(36) NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    notes            TEXT
);
CREATE INDEX IF NOT EXISTS idx_portion_batches_at ON portion_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS portion_batch_outputs (
    id              VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    batch_id        VARCHAR(36) NOT NULL REFERENCES portion_batches(id) ON DELETE CASCADE,
    item_id         VARCHAR(36) NOT NULL REFERENCES inventory_items(id),
    packs           INTEGER NOT NULL CHECK (packs > 0),
    pack_size       NUMERIC(10,2) NOT NULL,          -- g / ml per pack at the time
    unit_cost_cents NUMERIC(14,4) NOT NULL DEFAULT 0 -- cost of ONE pack from this batch
);
CREATE INDEX IF NOT EXISTS idx_portion_outputs_batch ON portion_batch_outputs (batch_id);

INSERT INTO schema_migrations (version, name, notes)
VALUES ('056', 'portioning', 'Raw (kg) -> packs: portion_source_id, unit paquete, portion_batches(+outputs); PRODUCTION_CONSUME/YIELD.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '056_portioning: OK'; END $done$;

COMMIT;
