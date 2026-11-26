-- ============================================================================
-- 002_line_item_client_request_id.sql
-- Mobile companion (B1): idempotent item add.
--
-- POST /tickets/<id>/items accepts an optional Idempotency-Key header, stored
-- here. A partial unique index makes (ticket_id, key) unique while leaving all
-- existing / web-created lines (NULL key) unconstrained.
--
-- Idempotent: safe after `flask init-db` (db.create_all already adds the column
-- on a fresh DB) and on an existing production DB.
--
-- DOWN (manual, reversible; run only if rolling back the backend too):
--   BEGIN;
--   DROP INDEX IF EXISTS uq_tli_ticket_client_request;
--   ALTER TABLE ticket_line_items DROP COLUMN IF EXISTS client_request_id;
--   DELETE FROM schema_migrations WHERE version = '002';
--   COMMIT;
-- ============================================================================
BEGIN;

ALTER TABLE ticket_line_items ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tli_ticket_client_request
    ON ticket_line_items (ticket_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('002', '002_line_item_client_request_id', 'ticket_line_items.client_request_id + partial unique index (mobile idempotency)')
ON CONFLICT (version) DO NOTHING;

DO $$ BEGIN RAISE NOTICE '002 OK -- ticket_line_items.client_request_id + uq_tli_ticket_client_request'; END $$;
COMMIT;
