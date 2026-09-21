-- ============================================================================
-- 030_kds_event_outbox.sql
-- Stage 3 — Ticket lifecycle + KDS delta event stream
--
-- Today the KDS gets socketio.emit('kitchen:update', {}) -- an EMPTY payload.
-- It is told "something changed" and must refetch everything, and it also polls
-- every 5s regardless (KitchenQueuePage.tsx:129). So no delta is possible: no
-- event carries data. This migration adds the two things needed for deltas:
--   1. a watermark on each line (what the KDS currently believes)
--   2. an append-only, sequenced outbox with idempotency keys
--
-- Additive. Ships DISABLED (kds.enforcement_mode = 'off').
-- Depends on: 027
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT _applied('027') THEN
        RAISE EXCEPTION 'Migration 027 must be applied before 030.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Watermark + per-line version
-- delta to emit = quantity - kds_sent_quantity. Self-healing: a missed event is
-- corrected by the next emission rather than duplicated.
-- ---------------------------------------------------------------------------
ALTER TABLE ticket_line_items
    ADD COLUMN IF NOT EXISTS kds_sent_quantity integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS version           integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN ticket_line_items.kds_sent_quantity IS
    'Quantity the KDS has been told about. Delta = quantity - kds_sent_quantity.';
COMMENT ON COLUMN ticket_line_items.version IS
    'Bumped on every material change; drives deterministic idempotency keys.';

-- Backfill: anything already routed is assumed fully known to the KDS.
UPDATE ticket_line_items
   SET kds_sent_quantity = CASE
        WHEN status IN ('SENT','IN_PROGRESS','READY','SERVED') THEN quantity
        ELSE 0 END
 WHERE kds_sent_quantity = 0
   AND status IN ('SENT','IN_PROGRESS','READY','SERVED');

CREATE INDEX IF NOT EXISTS idx_line_items_kds_pending
    ON ticket_line_items (ticket_id)
 WHERE quantity <> kds_sent_quantity AND status <> 'VOIDED';

-- ---------------------------------------------------------------------------
-- PART 2 — Append-only outbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kds_events (
    sequence        bigserial    PRIMARY KEY,
    id              varchar(36)  NOT NULL UNIQUE,
    idempotency_key varchar(120) NOT NULL UNIQUE,
    event_type      varchar(40)  NOT NULL,
    destination     varchar(20)  NOT NULL,
    ticket_id       varchar(36)  NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    line_item_id    varchar(36)  REFERENCES ticket_line_items(id) ON DELETE CASCADE,
    payload         jsonb        NOT NULL,
    line_version    integer,
    created_at      timestamptz  NOT NULL DEFAULT clock_timestamp(),
    created_by      varchar(36)  REFERENCES users(id),
    delivered_at    timestamptz,
    acked_at        timestamptz,
    acked_by        varchar(64),
    attempt_count   integer      NOT NULL DEFAULT 0,
    CONSTRAINT ck_kds_event_type CHECK (event_type IN
        ('line.added','line.qty_delta','line.voided','line.modifier_changed',
         'line.status_changed','ticket.closed')),
    CONSTRAINT ck_kds_destination CHECK (destination IN ('BAR','KITCHEN','BOTH'))
);

CREATE INDEX IF NOT EXISTS idx_kds_events_replay  ON kds_events (destination, sequence);
CREATE INDEX IF NOT EXISTS idx_kds_events_unacked ON kds_events (destination, created_at)
    WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kds_events_ticket  ON kds_events (ticket_id, sequence);

COMMENT ON TABLE kds_events IS
    'Append-only. sequence is the replay cursor; clients reconnect with '
    'last_seen_sequence. Written in the SAME transaction as the line change, so a '
    'rollback leaves no event -- that is what makes the outbox pattern correct.';
COMMENT ON COLUMN kds_events.idempotency_key IS
    'Deterministic: {line_item_id}:{event_type}:{line_version}. A retry of the same '
    'logical change collides on the UNIQUE index instead of duplicating.';

-- ---------------------------------------------------------------------------
-- PART 3 — Bump line version on material changes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_line_item_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.quantity         IS DISTINCT FROM OLD.quantity
       OR NEW.status        IS DISTINCT FROM OLD.status
       OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents THEN
        NEW.version := COALESCE(OLD.version, 1) + 1;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_line_item_bump_version ON ticket_line_items;
CREATE TRIGGER trg_line_item_bump_version
    BEFORE UPDATE ON ticket_line_items
    FOR EACH ROW EXECUTE FUNCTION fn_line_item_bump_version();

-- ---------------------------------------------------------------------------
-- PART 4 — Configuration
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('kds.event_retention_hours', '72'),
    ('kds.replay_window_hours',   '12'),
    ('kds.ack_timeout_seconds',   '30'),
    ('kds.enforcement_mode',      'off'),
    ('kds.poll_fallback_seconds', '30')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 5 — Monitoring
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_kds_undelivered AS
SELECT e.sequence, e.event_type, e.destination, e.ticket_id, e.line_item_id,
       e.created_at, e.attempt_count,
       EXTRACT(epoch FROM (clock_timestamp() - e.created_at))::int AS age_seconds,
       li.item_name, li.quantity, li.kds_sent_quantity
  FROM kds_events e
  LEFT JOIN ticket_line_items li ON li.id = e.line_item_id
 WHERE e.acked_at IS NULL
   AND e.created_at > clock_timestamp() - interval '24 hours'
 ORDER BY e.sequence;

-- Lines whose KDS view is known to be stale
CREATE OR REPLACE VIEW v_kds_watermark_drift AS
SELECT li.id AS line_item_id, li.ticket_id, li.item_name, li.routing_dest,
       li.quantity, li.kds_sent_quantity,
       (li.quantity - li.kds_sent_quantity) AS pending_delta, li.status
  FROM ticket_line_items li
  JOIN tickets t ON t.id = li.ticket_id
 WHERE t.status = 'OPEN' AND li.status <> 'VOIDED'
   AND li.quantity <> li.kds_sent_quantity;

-- ---------------------------------------------------------------------------
-- PART 6 — Retention (called by the scheduler alongside Stage 0 reconciliation)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_kds_events_prune() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_deleted integer;
BEGIN
    DELETE FROM kds_events
     WHERE acked_at IS NOT NULL
       AND created_at < clock_timestamp() - (COALESCE(
             (SELECT value::int FROM settings WHERE key='kds.event_retention_hours'), 72)
             || ' hours')::interval;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END $$;

-- ---------------------------------------------------------------------------
-- PART 7 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('030','kds_event_outbox',
        'Watermark + append-only sequenced outbox. Ships kds.enforcement_mode=off.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 8 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    -- backfill must leave no OPEN-ticket line mid-flight
    SELECT count(*) INTO n FROM v_kds_watermark_drift;
    IF n <> 0 THEN
        RAISE EXCEPTION '030: % open lines have watermark drift after backfill', n;
    END IF;

    -- served/sent lines must all be marked as known to the KDS
    SELECT count(*) INTO n FROM ticket_line_items
     WHERE status IN ('SENT','IN_PROGRESS','READY','SERVED')
       AND kds_sent_quantity <> quantity;
    IF n <> 0 THEN
        RAISE EXCEPTION '030: % routed lines were not backfilled', n;
    END IF;

    -- STAGED lines must be zero (nothing sent to the KDS yet)
    SELECT count(*) INTO n FROM ticket_line_items
     WHERE status = 'STAGED' AND kds_sent_quantity <> 0;
    IF n <> 0 THEN
        RAISE EXCEPTION '030: % STAGED lines wrongly marked as sent', n;
    END IF;

    RAISE NOTICE '030 OK -- % lines backfilled, drift %, mode %',
        (SELECT count(*) FROM ticket_line_items WHERE kds_sent_quantity > 0),
        (SELECT count(*) FROM v_kds_watermark_drift),
        (SELECT value FROM settings WHERE key='kds.enforcement_mode');
END $$;

COMMIT;
