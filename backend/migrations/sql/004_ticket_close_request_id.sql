-- 004_ticket_close_request_id.sql
-- Mobile: POST /tickets/<id>/close accepts Idempotency-Key, stored here.
-- DOWN: ALTER TABLE tickets DROP COLUMN IF EXISTS close_request_id; DELETE FROM schema_migrations WHERE version='004';
BEGIN;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS close_request_id VARCHAR(64);
INSERT INTO schema_migrations (version, name, notes)
VALUES ('004', '004_ticket_close_request_id', 'tickets.close_request_id (mobile close idempotency)')
ON CONFLICT (version) DO NOTHING;
DO $$ BEGIN RAISE NOTICE '004 OK -- tickets.close_request_id'; END $$;
COMMIT;
