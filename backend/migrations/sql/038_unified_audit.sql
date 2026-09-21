-- ============================================================================
-- 038_unified_audit.sql
-- Stage 11 — one timeline across all six sources; location dimension
--
-- audit_log is in good shape (all 15k rows carry before AND after state) but
-- ip_address is captured ONLY on authentication events. For ITEM_VOID (452),
-- ITEM_QTY_CHANGE, DISCOUNT_APPLIED and INVENTORY_ADJUSTMENT -- exactly the
-- actions where you would want to know which terminal and which shift -- there
-- is no location data at all. No backfill is possible; it was never captured.
-- Depends on: 035b
-- ============================================================================
BEGIN;
DO $$ BEGIN
    IF NOT _applied('035b') THEN RAISE EXCEPTION '035b must be applied before 038.'; END IF;
END $$;

ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS device_id  varchar(64),
    ADD COLUMN IF NOT EXISTS location   varchar(60),
    ADD COLUMN IF NOT EXISTS event_type varchar(40);

ALTER TABLE inventory_movements
    ADD COLUMN IF NOT EXISTS device_id  varchar(64),
    ADD COLUMN IF NOT EXISTS location   varchar(60),
    ADD COLUMN IF NOT EXISTS ip_address varchar(45);

CREATE INDEX IF NOT EXISTS idx_audit_log_device ON audit_log (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);

COMMENT ON COLUMN audit_log.location IS
    'Physical station (BARRA / COCINA / CAJA / MESA_N). NULL before Stage 11 -- '
    'ip_address was only ever captured on auth events.';

CREATE TABLE IF NOT EXISTS terminals (
    device_id    varchar(64) PRIMARY KEY,
    label        varchar(60) NOT NULL,
    location     varchar(60) NOT NULL,
    last_seen_at timestamptz,
    last_ip      varchar(45),
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE VIEW v_audit_timeline AS
SELECT 'AUDIT'::text AS source, a.created_at AS occurred_at, a.action AS event,
       a.entity_type, a.entity_id, u.name AS actor, NULL::varchar AS approver,
       a.before_state, a.after_state, a.reason, a.ip_address, a.device_id, a.location,
       NULL::numeric AS quantity_delta, NULL::integer AS value_cents
  FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
UNION ALL
SELECT 'INVENTORY', m.created_at, m.event_type, 'inventory_item', m.inventory_item_id,
       u.name, NULL, NULL, jsonb_build_object('quantity_after', m.quantity_after)::json,
       m.reason, m.ip_address, m.device_id, m.location, m.quantity_delta, m.unit_cost_cents
  FROM inventory_movements m LEFT JOIN users u ON u.id = m.performed_by
UNION ALL
SELECT 'OVERRIDE', o.created_at, o.action_code, o.target_type, o.target_id,
       ur.name, ua.name, o.before_state::json, o.after_state::json,
       COALESCE(o.reason_text, o.reason_code), o.ip_address, o.device_id, o.location,
       NULL, o.value_delta_cents
  FROM authorization_overrides o
  JOIN users ur ON ur.id = o.requested_by
  JOIN users ua ON ua.id = o.authorized_by
UNION ALL
SELECT 'VIOLATION', v.detected_at, v.violation_type, 'inventory_item', v.inventory_item_id,
       NULL, NULL, NULL, v.context::json, v.resolution_note, NULL, NULL, NULL, v.drift, NULL
  FROM ledger_violations v
UNION ALL
SELECT 'PRODUCTION', b.completed_at, 'PRODUCTION_BATCH', 'inventory_item', b.output_item_id,
       u.name, NULL, NULL,
       jsonb_build_object('expected', b.expected_yield, 'actual', b.actual_yield,
                          'variance_pct', b.variance_pct)::json,
       b.notes, NULL, NULL, NULL, b.variance, b.input_cost_cents
  FROM production_batches b JOIN users u ON u.id = b.produced_by
 WHERE b.status = 'COMPLETED';

COMMENT ON VIEW v_audit_timeline IS
    'Single chronological trail. Unindexed UNION ALL -- ALWAYS constrain occurred_at. '
    'Materialise nightly beyond ~500k rows.';

CREATE OR REPLACE VIEW v_manager_override_summary AS
SELECT date_trunc('day', o.created_at)::date AS fecha, ua.name AS gerente, a.category,
       count(*) AS overrides, sum(COALESCE(o.value_delta_cents,0))/100.0 AS valor_removido,
       count(DISTINCT o.requested_by) AS solicitantes,
       count(*) FILTER (WHERE o.outcome='WARN_ONLY') AS sin_autorizacion
  FROM authorization_overrides o
  JOIN users ua ON ua.id = o.authorized_by
  LEFT JOIN authorized_actions a ON a.action_code = o.action_code
 GROUP BY 1,2,3 ORDER BY 1 DESC, 4 DESC;

CREATE OR REPLACE VIEW v_shrinkage_summary AS
SELECT date_trunc('day', m.created_at)::date AS fecha, i.name AS producto, i.category,
       sum(m.quantity_delta) FILTER (WHERE m.event_type='WASTE')             AS merma,
       sum(m.quantity_delta) FILTER (WHERE m.event_type='COUNT_ADJUSTMENT')  AS ajuste_conteo,
       sum(m.quantity_delta) FILTER (WHERE m.event_type='MANUAL_ADJUSTMENT') AS ajuste_manual,
       sum(m.quantity_delta * COALESCE(m.unit_cost_cents,0))/100.0           AS impacto_costo
  FROM inventory_movements m JOIN inventory_items i ON i.id = m.inventory_item_id
 WHERE m.event_type IN ('WASTE','COUNT_ADJUSTMENT','MANUAL_ADJUSTMENT')
   AND m.created_at >= ledger_cutover()
 GROUP BY 1,2,3 ORDER BY 1 DESC;

INSERT INTO settings (key, value) VALUES
    ('audit.retention_months','36'),
    ('audit.require_device_id','false'),
    ('audit.violation_alert_threshold','1')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE audit_log IS
    'Permanent. Never pruned below audit.retention_months (36 = fiscal requirement). '
    'Only kds_events and authorization_grants are ephemeral.';

INSERT INTO schema_migrations (version, name, notes)
VALUES ('038','unified_audit','Location dimension, unified timeline, manager + shrinkage reporting.')
ON CONFLICT (version) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM v_audit_timeline
     WHERE occurred_at > clock_timestamp() - interval '7 days';
    IF n = 0 THEN RAISE EXCEPTION '038: timeline returned nothing for the last 7 days'; END IF;

    SELECT count(DISTINCT source) INTO n FROM v_audit_timeline
     WHERE occurred_at > clock_timestamp() - interval '90 days';
    IF n < 2 THEN RAISE EXCEPTION '038: timeline only surfaces % source(s)', n; END IF;

    RAISE NOTICE '038 OK -- timeline live across % sources, % events in last 7 days',
        n, (SELECT count(*) FROM v_audit_timeline
             WHERE occurred_at > clock_timestamp() - interval '7 days');
END $$;
COMMIT;
