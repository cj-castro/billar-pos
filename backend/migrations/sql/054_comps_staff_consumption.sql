-- ============================================================================
-- 054_comps_staff_consumption.sql
-- Comps and staff consumption as their own things (batch E5).
--
-- Until now a gift to a customer or an employee's drink could only be entered
-- as a void (90 lines, $50.7k, reason "void") or a 100% discount (33 tickets,
-- $9.2k, no reason stored). Now:
--
--   Cortesía      a line served free to a customer. The line stays on the
--                 ticket at $0; its list value, reason, who authorized and
--                 when are kept (comp_snapshot lets it be undone before close).
--                 Its stock is deducted as served; its COST is reported as
--                 "costo de cortesías", not as sales margin -- so comped lines
--                 leave v_bola8_lineas_venta.
--   Consumo de    a ticket of type STAFF for an employee (staff_user_id),
--   personal      authorized by a manager, routed to the kitchen/bar like any
--                 order, closed as STAFF_DONE. Every sales / payment / cash
--                 query reads status = 'CLOSED', so it never counts as sales.
--   Discounts     the reason is stored (tickets.discount_reason).
--
-- Depends on: 053
-- ============================================================================

BEGIN;

DO $$ BEGIN
    IF NOT _applied('053') THEN RAISE EXCEPTION '053 must be applied before 054.'; END IF;
END $$;

ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS staff_user_id       VARCHAR(36) REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS staff_reason        TEXT,
    ADD COLUMN IF NOT EXISTS staff_authorized_by VARCHAR(36) REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS discount_reason     TEXT;

ALTER TABLE ticket_line_items
    ADD COLUMN IF NOT EXISTS comp_reason   TEXT,
    ADD COLUMN IF NOT EXISTS comped_by     VARCHAR(36) REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS comped_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS comp_list_cents INTEGER,
    ADD COLUMN IF NOT EXISTS comp_snapshot JSONB;

CREATE INDEX IF NOT EXISTS idx_tli_comped ON ticket_line_items (comped_at) WHERE comped_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_staff ON tickets (staff_user_id) WHERE ticket_type = 'STAFF';

-- A staff order has no table, like EXPRESS / DELIVERY.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS chk_open_ticket_has_resource;
ALTER TABLE tickets ADD CONSTRAINT chk_open_ticket_has_resource CHECK (
    status::text <> 'OPEN' OR resource_id IS NOT NULL
    OR ticket_type::text = ANY (ARRAY['EXPRESS','DELIVERY','STAFF']));

-- Comped lines are not sales: drop them from the sales-lines view (same
-- columns, one more condition), so their cost stops eroding product margins.
DO $$
DECLARE d text;
BEGIN
    d := pg_get_viewdef('public.v_bola8_lineas_venta'::regclass);
    IF d NOT LIKE '%comped_at IS NULL%' THEN
        IF d NOT LIKE '%(li.voided_at IS NULL))%' THEN
            RAISE EXCEPTION '054: v_bola8_lineas_venta has an unexpected shape; not rewritten';
        END IF;
        d := replace(d, '(li.voided_at IS NULL))', '(li.voided_at IS NULL) AND (li.comped_at IS NULL))');
        EXECUTE 'CREATE OR REPLACE VIEW public.v_bola8_lineas_venta AS ' || rtrim(d, '; ' || chr(10));
    END IF;
END $$;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('054', 'comps_staff_consumption',
        'Comped lines (reason, authorizer, list value) out of sales; STAFF tickets closed as STAFF_DONE; discount_reason.')
ON CONFLICT (version) DO NOTHING;

DO $done$ BEGIN RAISE NOTICE '054_comps_staff_consumption: OK'; END $done$;

COMMIT;
