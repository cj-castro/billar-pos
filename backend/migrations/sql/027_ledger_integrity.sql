-- ============================================================================
-- 027_ledger_integrity.sql
-- Stage 0 — Ledger Integrity & Safety Net
--
-- Additive. Modifies ZERO existing rows except backfilling the new seq column.
-- Ships DISABLED (ledger.enforcement_mode = 'off').
--
-- Apply:  docker exec -i billar-pos-postgres-1 \
--           psql -U billiard -d billiardbar -v ON_ERROR_STOP=1 < 027_ledger_integrity.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 0 — Wrong-database guard
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = 'inventory_movements') THEN
        RAISE EXCEPTION 'WRONG DATABASE: inventory_movements not found in "%".', current_database()
            USING HINT = 'Re-run with -d billiardbar.';
    END IF;
    IF (SELECT count(*) FROM inventory_movements) = 0 THEN
        RAISE EXCEPTION 'WRONG DATABASE: inventory_movements is empty in "%".', current_database()
            USING HINT = 'This looks like a blank database.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Migration registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    varchar(20)  PRIMARY KEY,
    name       varchar(200) NOT NULL,
    applied_at timestamptz  NOT NULL DEFAULT now(),
    applied_by varchar(100) NOT NULL DEFAULT current_user,
    notes      text
);

CREATE OR REPLACE FUNCTION _applied(p_version text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = p_version);
$$;

-- ---------------------------------------------------------------------------
-- PART 2 — Monotonic ordering key
-- created_at is UNRELIABLE for ordering: the ORM sets it per-row via Python
-- (microsecond precision, fine), but SQL functions use now() =
-- transaction_timestamp(), which is CONSTANT across a transaction. And id is a
-- random uuid4, so it is not a usable tiebreak. seq is the authority.
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS seq bigint;

WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at NULLS FIRST, id) AS rn
      FROM inventory_movements)
UPDATE inventory_movements m SET seq = o.rn
  FROM ordered o WHERE o.id = m.id AND m.seq IS NULL;

CREATE SEQUENCE IF NOT EXISTS inventory_movements_seq_seq;
SELECT setval('inventory_movements_seq_seq',
              COALESCE((SELECT max(seq) FROM inventory_movements), 0) + 1, false);

ALTER TABLE inventory_movements
    ALTER COLUMN seq SET DEFAULT nextval('inventory_movements_seq_seq');

DO $$ BEGIN
    ALTER TABLE inventory_movements ALTER COLUMN seq SET NOT NULL;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'seq NOT NULL deferred -- % rows still null',
        (SELECT count(*) FROM inventory_movements WHERE seq IS NULL);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_movements_seq ON inventory_movements (seq);
CREATE INDEX IF NOT EXISTS idx_movements_item_seq
    ON inventory_movements (inventory_item_id, seq DESC);

COMMENT ON COLUMN inventory_movements.seq IS
    'Monotonic insertion order -- THE ordering key. Backfilled in (created_at, id) '
    'order, which was verified chain-consistent for all post-cutover rows.';

-- ---------------------------------------------------------------------------
-- PART 3 — Configuration
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('ledger.cutover_at',       '2026-06-01T00:00:00-06:00'),
    ('ledger.enforcement_mode', 'off'),
    ('ledger.reconcile_hour',   '4')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION ledger_cutover() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT value::timestamptz FROM settings WHERE key = 'ledger.cutover_at'),
                    '2026-06-01T00:00:00-06:00'::timestamptz);
$$;

CREATE OR REPLACE FUNCTION ledger_mode() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT lower(value) FROM settings WHERE key='ledger.enforcement_mode'),'off');
$$;

-- ---------------------------------------------------------------------------
-- PART 4 — Violation log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_violations (
    id                bigserial   PRIMARY KEY,
    detected_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    violation_type    varchar(40) NOT NULL,
    source            varchar(20) NOT NULL,
    inventory_item_id varchar(36) REFERENCES inventory_items(id),
    movement_id       varchar(36),
    expected_value    numeric(12,4),
    actual_value      numeric(12,4),
    drift             numeric(12,4) GENERATED ALWAYS AS (actual_value - expected_value) STORED,
    context           jsonb,
    resolved_at       timestamptz,
    resolved_by       varchar(36) REFERENCES users(id),
    resolution_note   text,
    CONSTRAINT ck_ledger_violation_type CHECK (violation_type IN
        ('CHAIN_BREAK','STOCK_MISMATCH','NULL_TIMESTAMP','NEGATIVE_STOCK',
         'ORPHAN_MOVEMENT','STOCK_WITHOUT_LEDGER')),
    CONSTRAINT ck_ledger_violation_source CHECK (source IN ('TRIGGER','RECONCILE','MANUAL'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_violations_unresolved
    ON ledger_violations (detected_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_violations_item
    ON ledger_violations (inventory_item_id, detected_at DESC);

-- ---------------------------------------------------------------------------
-- PART 5 — Movement chain guard (BEFORE INSERT)
--   a) never allow a NULL created_at
--   b) derive quantity_after when omitted
--   c) validate it when supplied
-- The codebase convention (inventory_svc.py:78-83) is that stock_quantity is
-- updated BEFORE the movement is written, so on the first movement
-- quantity_after = current stock. Adding the delta would double-count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ledger_guard_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_mode text := ledger_mode(); v_prev numeric(12,4); v_expected numeric(12,4);
BEGIN
    IF v_mode = 'off' THEN RETURN NEW; END IF;

    IF NEW.created_at IS NULL THEN
        NEW.created_at := clock_timestamp();
    END IF;

    IF NEW.created_at < ledger_cutover() THEN RETURN NEW; END IF;

    PERFORM 1 FROM inventory_items WHERE id = NEW.inventory_item_id FOR UPDATE;

    -- ordered by seq, so movements written in the SAME transaction resolve correctly
    SELECT m.quantity_after INTO v_prev
      FROM inventory_movements m
     WHERE m.inventory_item_id = NEW.inventory_item_id
       AND m.quantity_after IS NOT NULL
       AND m.created_at IS NOT NULL
       AND m.created_at >= ledger_cutover()
     ORDER BY m.seq DESC
     LIMIT 1;

    IF v_prev IS NULL THEN
        -- First post-cutover movement. stock_quantity ALREADY reflects it.
        IF NEW.quantity_after IS NULL THEN
            SELECT i.stock_quantity INTO NEW.quantity_after
              FROM inventory_items i WHERE i.id = NEW.inventory_item_id;
        END IF;
        RETURN NEW;
    END IF;

    v_expected := v_prev + NEW.quantity_delta;

    IF NEW.quantity_after IS NULL THEN
        NEW.quantity_after := v_expected;
        RETURN NEW;
    END IF;

    IF NEW.quantity_after <> v_expected THEN
        IF v_mode = 'enforce' THEN
            RAISE EXCEPTION
                'LEDGER CHAIN BREAK on item %: quantity_after=% but previous(%) + delta(%) = %',
                NEW.inventory_item_id, NEW.quantity_after, v_prev, NEW.quantity_delta, v_expected
                USING HINT = 'Stock changed without a matching movement row.';
        ELSE
            INSERT INTO ledger_violations
                (violation_type, source, inventory_item_id, movement_id,
                 expected_value, actual_value, context)
            VALUES ('CHAIN_BREAK','TRIGGER', NEW.inventory_item_id, NEW.id,
                    v_expected, NEW.quantity_after,
                    jsonb_build_object('event_type', NEW.event_type, 'delta', NEW.quantity_delta,
                                       'prev_after', v_prev, 'seq', NEW.seq,
                                       'performed_by', NEW.performed_by,
                                       'reference_id', NEW.reference_id));
        END IF;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ledger_guard_movement ON inventory_movements;
CREATE TRIGGER trg_ledger_guard_movement
    BEFORE INSERT ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION fn_ledger_guard_movement();

-- ---------------------------------------------------------------------------
-- PART 6 — Stock/ledger agreement (DEFERRED to COMMIT)
-- Covers INSERT as well as UPDATE: a new item created with stock but no
-- OPENING_STOCK movement previously escaped every check.
-- Distinguishes "no ledger at all" (a gap) from "no POST-CUTOVER ledger"
-- (legitimate for slow-moving pre-cutover items).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ledger_verify_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_mode text := ledger_mode(); v_latest numeric(12,4);
        v_current numeric(12,4); v_name varchar(100); v_any boolean;
BEGIN
    IF v_mode = 'off' THEN RETURN NULL; END IF;

    -- CRITICAL: in a DEFERRED constraint trigger, NEW is the row image from the
    -- time of the UPDATE, not the committed state. update_item_quantity does
    -- reverse-then-reconsume, so it updates stock TWICE and this trigger fires
    -- twice -- the earlier firing carries a stale NEW. Verified empirically on
    -- 2026-08-07: a 1->3 quantity change produced a false STOCK_MISMATCH
    -- (expected 21, NEW said 24). In enforce mode that would abort every
    -- quantity change in the POS. Always re-read the current row.
    SELECT stock_quantity, name INTO v_current, v_name
      FROM inventory_items WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;   -- row removed later in the txn

    SELECT m.quantity_after INTO v_latest
      FROM inventory_movements m
     WHERE m.inventory_item_id = NEW.id
       AND m.quantity_after IS NOT NULL
       AND m.created_at IS NOT NULL
       AND m.created_at >= ledger_cutover()
     ORDER BY m.seq DESC
     LIMIT 1;

    IF v_latest IS NULL THEN
        SELECT EXISTS (SELECT 1 FROM inventory_movements WHERE inventory_item_id = NEW.id)
          INTO v_any;

        -- Stock exists but the item has NO movements whatsoever -> unbacked stock
        IF NOT v_any AND v_current <> 0 THEN
            IF v_mode = 'enforce' THEN
                RAISE EXCEPTION 'STOCK WITHOUT LEDGER: % has stock % and no movements',
                    v_name, v_current
                    USING HINT = 'Create stock via an OPENING_STOCK movement.';
            ELSE
                INSERT INTO ledger_violations
                    (violation_type, source, inventory_item_id, expected_value, actual_value, context)
                VALUES ('STOCK_WITHOUT_LEDGER','TRIGGER', NEW.id, 0, v_current,
                        jsonb_build_object('item_name', v_name, 'tg_op', TG_OP));
            END IF;
        END IF;
        RETURN NULL;   -- pre-cutover-only history: correctly skipped
    END IF;

    IF v_current <> v_latest THEN
        IF v_mode = 'enforce' THEN
            RAISE EXCEPTION 'STOCK/LEDGER MISMATCH on %: stock=% but latest movement=%',
                v_name, v_current, v_latest
                USING HINT = 'stock_quantity changed without a movement row.';
        ELSE
            INSERT INTO ledger_violations
                (violation_type, source, inventory_item_id, expected_value, actual_value, context)
            VALUES ('STOCK_MISMATCH','TRIGGER', NEW.id, v_latest, v_current,
                    jsonb_build_object('item_name', v_name, 'tg_op', TG_OP));
        END IF;
    END IF;

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_ledger_verify_stock ON inventory_items;
CREATE CONSTRAINT TRIGGER trg_ledger_verify_stock
    AFTER INSERT OR UPDATE OF stock_quantity ON inventory_items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_ledger_verify_stock();

-- ---------------------------------------------------------------------------
-- PART 7 — Reconciliation view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ledger_reconciliation AS
WITH latest AS (
    SELECT DISTINCT ON (m.inventory_item_id)
           m.inventory_item_id, m.quantity_after, m.created_at
      FROM inventory_movements m
     WHERE m.quantity_after IS NOT NULL AND m.created_at IS NOT NULL
       AND m.created_at >= ledger_cutover()
     ORDER BY m.inventory_item_id, m.seq DESC
),
counts AS (
    SELECT inventory_item_id,
           count(*) FILTER (WHERE created_at >= ledger_cutover()) AS post_moves,
           count(*) FILTER (WHERE created_at <  ledger_cutover()) AS pre_moves,
           count(*) FILTER (WHERE created_at IS NULL)             AS undated_moves
      FROM inventory_movements GROUP BY 1
)
SELECT i.id AS inventory_item_id, i.name, i.item_type, i.stock_quantity,
       l.quantity_after AS ledger_balance,
       (i.stock_quantity - l.quantity_after) AS drift,
       (l.quantity_after IS NOT NULL AND i.stock_quantity <> l.quantity_after) AS is_drifted,
       (l.quantity_after IS NULL) AS no_post_cutover_ledger,
       COALESCE(c.post_moves,0) AS post_cutover_movements,
       COALESCE(c.pre_moves,0)  AS pre_ledger_movements,
       COALESCE(c.undated_moves,0) AS undated_movements,
       l.created_at AS last_movement_at
  FROM inventory_items i
  LEFT JOIN latest l ON l.inventory_item_id = i.id
  LEFT JOIN counts c ON c.inventory_item_id = i.id
 WHERE i.is_active;

-- ---------------------------------------------------------------------------
-- PART 8 — Chain scanner (ordered by seq, not created_at)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ledger_scan_chain(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (inventory_item_id varchar(36), item_name varchar(100), movement_id varchar(36),
               seq bigint, occurred_at timestamptz, prev_after numeric(12,4),
               delta numeric(12,4), recorded_after numeric(12,4), expected_after numeric(12,4))
LANGUAGE sql STABLE AS $$
    WITH chain AS (
        SELECT m.inventory_item_id, m.id, m.seq, m.created_at, m.quantity_delta, m.quantity_after,
               lag(m.quantity_after) OVER (PARTITION BY m.inventory_item_id ORDER BY m.seq) AS prev_after
          FROM inventory_movements m
         WHERE m.created_at IS NOT NULL
           AND m.created_at >= COALESCE(p_since, ledger_cutover())
           AND m.quantity_after IS NOT NULL)
    SELECT c.inventory_item_id, i.name, c.id, c.seq, c.created_at,
           c.prev_after, c.quantity_delta, c.quantity_after, c.prev_after + c.quantity_delta
      FROM chain c JOIN inventory_items i ON i.id = c.inventory_item_id
     WHERE c.prev_after IS NOT NULL
       AND c.quantity_after <> c.prev_after + c.quantity_delta;
$$;

-- ---------------------------------------------------------------------------
-- PART 9 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('027','ledger_integrity',
        'Additive. Cutover 2026-06-01. seq ordering. INSERT+UPDATE coverage. mode=off.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 10 — Assertions: RAISE on failure, not NOTICE
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM inventory_movements WHERE seq IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION '027: % movements have NULL seq', n; END IF;

    SELECT count(*) INTO n FROM (SELECT seq FROM inventory_movements GROUP BY seq HAVING count(*)>1) d;
    IF n <> 0 THEN RAISE EXCEPTION '027: % duplicate seq values', n; END IF;

    SELECT count(*) INTO n FROM v_ledger_reconciliation WHERE is_drifted;
    IF n <> 0 THEN RAISE EXCEPTION '027: % items drifted, expected 0', n; END IF;

    SELECT count(*) INTO n FROM fn_ledger_scan_chain();
    IF n <> 0 THEN RAISE EXCEPTION '027: % chain breaks, expected 0', n; END IF;

    -- NOTE: deliberately not asserting mode = 'off'. The settings INSERT uses
    -- ON CONFLICT DO NOTHING, so this file can never enable enforcement; and
    -- asserting it would make the migration un-rerunnable once an operator has
    -- legitimately advanced the ladder to warn/enforce.
    RAISE NOTICE '027 OK -- movements: %, cutover: %, mode: %',
        (SELECT count(*) FROM inventory_movements), ledger_cutover(), ledger_mode();
END $$;

COMMIT;
