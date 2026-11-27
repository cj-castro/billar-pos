-- ============================================================================
-- 058_cash_counts.sql
-- Cash counts by denomination and the safe envelope (cash handoff, phase 1).
--
-- A manager counts the drawer bill by bill at opening and at close. The close
-- also counts what stays in the drawer (DRAWER_LEFT); the rest goes into one
-- numbered envelope per session, which goes into the safe.
--   cash_counts       one counted total per (session, kind); append-only. A
--                     correction is a new row with supersedes_id set. The
--                     "current" count is the row no other row supersedes.
--   cash_count_lines  quantity per denomination (keys like B500, C0.50).
--   cash_envelopes    one per session; number comes from cash_envelope_number_seq.
-- Settings: cash.count_by_denomination ('off' until the owner turns it on) and
-- cash.drawer_fund_cents (the float that stays in the drawer, 200000 = $2,000).
-- All money is integer cents.
-- On a fresh install init-db runs db.create_all() BEFORE migrations, so the
-- tables may already exist from the models. Every constraint, default, index
-- and the sequence is therefore also added idempotently below.
-- Depends on: 057
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('057') THEN RAISE EXCEPTION '057 must be applied before 058.'; END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS cash_envelope_number_seq;

CREATE TABLE IF NOT EXISTS cash_counts (
    id            varchar(36) PRIMARY KEY,
    session_id    varchar(36) NOT NULL REFERENCES cash_sessions(id),
    kind          varchar(12) NOT NULL,
    total_cents   integer     NOT NULL,
    counted_by    varchar(36) NOT NULL REFERENCES users(id),
    counted_at    timestamptz DEFAULT now(),
    note          text,
    supersedes_id varchar(36) REFERENCES cash_counts(id),
    reason        text
);
ALTER TABLE cash_counts ALTER COLUMN counted_at SET DEFAULT now();
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_counts_kind_check' AND conrelid = 'cash_counts'::regclass) THEN
        ALTER TABLE cash_counts ADD CONSTRAINT cash_counts_kind_check
            CHECK (kind IN ('OPENING','CLOSE','DRAWER_LEFT'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_cash_counts_session_kind_counted
    ON cash_counts (session_id, kind, counted_at);

CREATE TABLE IF NOT EXISTS cash_count_lines (
    count_id    varchar(36) NOT NULL REFERENCES cash_counts(id) ON DELETE RESTRICT,
    denom_key   varchar(8)  NOT NULL,
    denom_cents integer     NOT NULL,
    quantity    integer     NOT NULL,
    PRIMARY KEY (count_id, denom_key)
);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_count_lines_quantity_check' AND conrelid = 'cash_count_lines'::regclass) THEN
        ALTER TABLE cash_count_lines ADD CONSTRAINT cash_count_lines_quantity_check CHECK (quantity >= 0);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS cash_envelopes (
    id             varchar(36) PRIMARY KEY,
    number         integer     NOT NULL DEFAULT nextval('cash_envelope_number_seq'),
    session_id     varchar(36) NOT NULL REFERENCES cash_sessions(id),
    declared_cents integer     NOT NULL,
    created_by     varchar(36) REFERENCES users(id),
    created_at     timestamptz DEFAULT now(),
    status         varchar(12) DEFAULT 'IN_SAFE'
);
ALTER TABLE cash_envelopes ALTER COLUMN number SET DEFAULT nextval('cash_envelope_number_seq');
ALTER TABLE cash_envelopes ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE cash_envelopes ALTER COLUMN status SET DEFAULT 'IN_SAFE';
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_cash_envelopes_number' AND conrelid = 'cash_envelopes'::regclass) THEN
        ALTER TABLE cash_envelopes ADD CONSTRAINT uq_cash_envelopes_number UNIQUE (number);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_cash_envelopes_session' AND conrelid = 'cash_envelopes'::regclass) THEN
        ALTER TABLE cash_envelopes ADD CONSTRAINT uq_cash_envelopes_session UNIQUE (session_id);
    END IF;
END $$;

INSERT INTO settings (key, value) VALUES ('cash.count_by_denomination', 'off') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('cash.drawer_fund_cents', '200000') ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('058', 'cash_counts', 'cash_counts, cash_count_lines, cash_envelopes + settings for the denomination count at close/opening.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '058_cash_counts: OK'; END $done$;

COMMIT;
