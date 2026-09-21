-- ============================================================================
-- 028_authorization_framework.sql
-- Stage 1 — Authorization Framework & PIN Escalation
--
-- Replaces the boolean "was a PIN verified somewhere?" model with single-use,
-- target-bound grants. A grant authorises exactly ONE action on ONE target,
-- once, within a short TTL -- so a PIN approved for deleting one line item can
-- no longer be reused for anything else.
--
-- Additive. Ships DISABLED (auth.enforcement_mode = 'off').
-- Depends on: 027
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 0 — Guards
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name='users') THEN
        RAISE EXCEPTION 'WRONG DATABASE: users table not found in "%".', current_database();
    END IF;
    IF NOT _applied('027') THEN
        RAISE EXCEPTION 'Migration 027 must be applied before 028.'
            USING HINT = 'Apply 027_ledger_integrity.sql first.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART 1 — Reason codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authorization_reason_codes (
    code          varchar(40)  PRIMARY KEY,
    label_es      varchar(120) NOT NULL,
    label_en      varchar(120) NOT NULL,
    requires_text boolean      NOT NULL DEFAULT false,
    sort_order    int          NOT NULL DEFAULT 100,
    is_active     boolean      NOT NULL DEFAULT true
);

INSERT INTO authorization_reason_codes (code,label_es,label_en,requires_text,sort_order) VALUES
    ('CUSTOMER_CHANGED_MIND','Cliente cambio de opinion','Customer changed mind', false, 10),
    ('WRONG_ITEM_ENTERED',   'Articulo mal capturado',   'Wrong item entered',     false, 20),
    ('ITEM_UNAVAILABLE',     'Producto agotado',         'Item unavailable',       false, 30),
    ('KITCHEN_ERROR',        'Error de cocina',          'Kitchen error',          false, 40),
    ('CUSTOMER_COMPLAINT',   'Queja del cliente',        'Customer complaint',     true,  50),
    ('SPILLAGE',             'Derrame / merma',          'Spillage / waste',       false, 60),
    ('COURTESY',             'Cortesia',                 'Courtesy / comp',        true,  70),
    ('PRICE_MATCH',          'Ajuste de precio',         'Price match',            true,  80),
    ('TRAINING',             'Capacitacion',             'Training',               false, 90),
    ('SYSTEM_ERROR',         'Error del sistema',        'System error',           true, 100),
    ('OTHER',                'Otro',                     'Other',                  true, 999)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 2 — Action registry.
-- The single source of truth for "what needs a manager". Adding a privileged
-- action becomes an INSERT here rather than remembering to add an if-statement.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authorized_actions (
    action_code         varchar(60)  PRIMARY KEY,
    description_es      varchar(200) NOT NULL,
    category            varchar(40)  NOT NULL,
    min_role            varchar(20)  NOT NULL DEFAULT 'MANAGER',
    requires_pin        boolean      NOT NULL DEFAULT true,
    requires_reason     boolean      NOT NULL DEFAULT true,
    reduces_value       boolean      NOT NULL DEFAULT false,
    increases_inventory boolean      NOT NULL DEFAULT false,
    grant_ttl_seconds   int          NOT NULL DEFAULT 120,
    is_active           boolean      NOT NULL DEFAULT true,
    CONSTRAINT ck_authorized_actions_role CHECK (min_role IN
        ('WAITER','BAR_STAFF','KITCHEN_STAFF','MANAGER','ADMIN'))
);

COMMENT ON COLUMN authorized_actions.reduces_value IS
    'Action lowers ticket/sales value. Per design rule, always requires a manager PIN.';
COMMENT ON COLUMN authorized_actions.increases_inventory IS
    'Action restores stock. Per design rule, always requires a manager PIN.';

INSERT INTO authorized_actions
 (action_code, description_es, category, min_role, requires_reason, reduces_value, increases_inventory) VALUES
 -- Ticket line lifecycle
 ('LINE_ITEM.DELETE',          'Eliminar partida del ticket',    'TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.QTY_DECREASE',    'Reducir cantidad',               'TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.VOID',            'Cancelar partida enviada',       'TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.MODIFIER_REMOVE', 'Quitar modificador con precio',  'TICKET','MANAGER',true, true, true),
 ('LINE_ITEM.PRICE_OVERRIDE',  'Cambiar precio unitario',        'TICKET','MANAGER',true, true, false),
 -- Ticket level
 ('TICKET.VOID',               'Cancelar ticket completo',       'TICKET','MANAGER',true, true, true),
 ('TICKET.DISCOUNT_APPLY',     'Aplicar descuento manual',       'TICKET','MANAGER',true, true, false),
 ('TICKET.COMP',               'Cortesia / no cobrar',           'TICKET','MANAGER',true, true, true),
 ('TICKET.REOPEN',             'Reabrir ticket cerrado',         'TICKET','MANAGER',true, false,false),
 ('TICKET.TRANSFER',           'Transferir ticket a otra mesa',  'TICKET','MANAGER',false,false,false),
 -- Payments
 ('PAYMENT.REFUND',            'Reembolso',                      'PAYMENT','MANAGER',true, true, true),
 -- Inventory
 ('INVENTORY.MANUAL_ADJUSTMENT','Ajuste manual de inventario',   'INVENTORY','MANAGER',true,false,true),
 ('INVENTORY.WASTE',           'Registrar merma',                'INVENTORY','MANAGER',true, false,false),
 ('INVENTORY.COUNT_ADJUSTMENT','Ajuste por conteo fisico',       'INVENTORY','MANAGER',true, false,true),
 -- Cash
 ('CASH.DRAWER_OPEN_NOSALE',   'Abrir cajon sin venta',          'CASH','MANAGER',true, false,false),
 ('CASH.SESSION_CLOSE_VARIANCE','Cerrar caja con diferencia',    'CASH','MANAGER',true, false,false),
 ('CASH.SAFE_COLLECTION',      'Retiro a caja fuerte',           'CASH','MANAGER',true, false,false),
 -- Promotions
 ('PROMO.OVERRIDE',            'Forzar/anular promocion',        'PROMO','MANAGER',true, true, false),
 -- Pool tables
 ('POOL.TIMER_CANCEL',         'Cancelar temporizador de mesa',  'POOL','MANAGER',true, true, false),
 ('POOL.TIME_ADJUST',          'Ajustar tiempo cobrado',         'POOL','MANAGER',true, true, false)
ON CONFLICT (action_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 3 — Grants: short-lived, single-use, target-bound
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authorization_grants (
    id              varchar(36)  PRIMARY KEY,
    token_hash      varchar(64)  NOT NULL UNIQUE,   -- sha256(token); raw never stored
    action_code     varchar(60)  NOT NULL REFERENCES authorized_actions(action_code),
    target_type     varchar(40)  NOT NULL,
    target_id       varchar(36),
    target_snapshot jsonb        NOT NULL,          -- state at approval time
    requested_by    varchar(36)  NOT NULL REFERENCES users(id),
    authorized_by   varchar(36)  NOT NULL REFERENCES users(id),
    reason_code     varchar(40)  REFERENCES authorization_reason_codes(code),
    reason_text     text,
    issued_at       timestamptz  NOT NULL DEFAULT clock_timestamp(),
    expires_at      timestamptz  NOT NULL,
    consumed_at     timestamptz,
    revoked_at      timestamptz,
    ip_address      varchar(45),
    device_id       varchar(64),
    location        varchar(60)
);

CREATE INDEX IF NOT EXISTS idx_auth_grants_open
    ON authorization_grants (expires_at) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_grants_target
    ON authorization_grants (target_type, target_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_grants_authorizer
    ON authorization_grants (authorized_by, issued_at DESC);

COMMENT ON TABLE authorization_grants IS
    'Ephemeral. One grant authorises exactly one action on one target, once. '
    'Consumption is an atomic conditional UPDATE, so replay fails under concurrency.';

-- ---------------------------------------------------------------------------
-- PART 4 — Permanent override record. Survives grant cleanup; this is the
-- audit artefact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authorization_overrides (
    id                bigserial    PRIMARY KEY,
    grant_id          varchar(36)  REFERENCES authorization_grants(id) ON DELETE SET NULL,
    action_code       varchar(60)  NOT NULL,
    target_type       varchar(40)  NOT NULL,
    target_id         varchar(36),
    requested_by      varchar(36)  NOT NULL REFERENCES users(id),
    authorized_by     varchar(36)  NOT NULL REFERENCES users(id),
    before_state      jsonb        NOT NULL,
    after_state       jsonb,
    value_delta_cents int,
    reason_code       varchar(40),
    reason_text       text,
    ip_address        varchar(45),
    device_id         varchar(64),
    location          varchar(60),
    outcome           varchar(20)  NOT NULL DEFAULT 'APPLIED',
    created_at        timestamptz  NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_override_outcome CHECK (outcome IN ('APPLIED','FAILED','WARN_ONLY'))
);

CREATE INDEX IF NOT EXISTS idx_auth_overrides_created ON authorization_overrides (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_overrides_action  ON authorization_overrides (action_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_overrides_manager ON authorization_overrides (authorized_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_overrides_target  ON authorization_overrides (target_type, target_id);

COMMENT ON COLUMN authorization_overrides.value_delta_cents IS
    'Negative = sales value removed. Feeds the manager override report.';
COMMENT ON COLUMN authorization_overrides.outcome IS
    'WARN_ONLY = enforcement_mode was warn; the action proceeded without a valid grant.';

-- ---------------------------------------------------------------------------
-- PART 5 — PIN attempts, for per-user/per-device lockout.
-- Flask-Limiter is per-IP, which is useless when every POS terminal shares one
-- NAT address: terminals compete for the same budget and lockouts are collective.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pin_attempts (
    id           bigserial   PRIMARY KEY,
    attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    requested_by varchar(36) REFERENCES users(id),
    action_code  varchar(60),
    succeeded    boolean     NOT NULL,
    matched_user varchar(36) REFERENCES users(id),
    ip_address   varchar(45),
    device_id    varchar(64)
);

CREATE INDEX IF NOT EXISTS idx_pin_attempts_recent ON pin_attempts (requested_by, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_pin_attempts_device
    ON pin_attempts (device_id, attempted_at DESC) WHERE NOT succeeded;

COMMENT ON TABLE pin_attempts IS
    'Never stores the submitted PIN -- only whether it matched.';

-- ---------------------------------------------------------------------------
-- PART 6 — Configuration
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('auth.enforcement_mode',     'off'),
    ('auth.grant_ttl_seconds',    '120'),
    ('auth.pin_max_failures',     '5'),
    ('auth.pin_lockout_seconds',  '300'),
    ('auth.pin_min_length',       '4'),
    ('auth.grant_retention_days', '30'),
    ('auth.allow_self_authorize', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION auth_mode() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT lower(value) FROM settings WHERE key='auth.enforcement_mode'),'off');
$$;

-- ---------------------------------------------------------------------------
-- PART 7 — Lockout helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_pin_is_locked(p_user varchar(36), p_device varchar(64))
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT count(*) >= COALESCE(
             (SELECT value::int FROM settings WHERE key='auth.pin_max_failures'), 5)
      FROM pin_attempts
     WHERE NOT succeeded
       AND (requested_by = p_user OR (p_device IS NOT NULL AND device_id = p_device))
       AND attempted_at > clock_timestamp() - (COALESCE(
             (SELECT value::int FROM settings WHERE key='auth.pin_lockout_seconds'), 300)
             || ' seconds')::interval;
$$;

-- ---------------------------------------------------------------------------
-- PART 8 — Reporting
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_authorization_overrides_daily AS
SELECT date_trunc('day', o.created_at)::date       AS business_date,
       o.action_code,
       a.category,
       a.description_es,
       u_req.name                                  AS requested_by_name,
       u_auth.name                                 AS authorized_by_name,
       count(*)                                    AS override_count,
       sum(COALESCE(o.value_delta_cents,0))        AS total_value_delta_cents,
       count(*) FILTER (WHERE o.outcome='WARN_ONLY') AS unauthorized_warn_count
  FROM authorization_overrides o
  JOIN users u_req  ON u_req.id  = o.requested_by
  JOIN users u_auth ON u_auth.id = o.authorized_by
  LEFT JOIN authorized_actions a ON a.action_code = o.action_code
 GROUP BY 1,2,3,4,5,6;

-- Actions that SHOULD have produced an override row but did not. Once
-- auth.enforcement_mode = enforce, this must return zero rows.
CREATE OR REPLACE VIEW v_unauthorized_value_reductions AS
SELECT a.created_at, a.action, a.entity_type, a.entity_id,
       u.name AS actor, a.before_state, a.after_state, a.ip_address
  FROM audit_log a
  LEFT JOIN users u ON u.id = a.user_id
 WHERE a.action IN ('ITEM_VOID','ITEM_QTY_CHANGE','DISCOUNT_APPLIED','TICKET_CANCEL',
                    'INVENTORY_ADJUSTMENT','TIMER_VOID','TICKET_REOPEN')
   AND NOT EXISTS (
        SELECT 1 FROM authorization_overrides o
         WHERE o.target_id = a.entity_id
           AND o.created_at BETWEEN a.created_at - interval '30 seconds'
                               AND a.created_at + interval '30 seconds')
 ORDER BY a.created_at DESC;

-- ---------------------------------------------------------------------------
-- PART 9 — Register
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name, notes)
VALUES ('028','authorization_framework',
        'Grant-based auth: 20 actions, 11 reason codes. Ships auth.enforcement_mode=off.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 10 — Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM authorized_actions;
    IF n < 20 THEN RAISE EXCEPTION '028: % actions registered, expected >= 20', n; END IF;

    SELECT count(*) INTO n FROM authorization_reason_codes;
    IF n < 11 THEN RAISE EXCEPTION '028: % reason codes, expected >= 11', n; END IF;

    -- every value-reducing or inventory-increasing action must demand a PIN
    SELECT count(*) INTO n FROM authorized_actions
     WHERE (reduces_value OR increases_inventory) AND NOT requires_pin;
    IF n <> 0 THEN
        RAISE EXCEPTION '028: % value-reducing actions do not require a PIN', n;
    END IF;

    -- and a reason, so overrides are explainable after the fact
    SELECT count(*) INTO n FROM authorized_actions
     WHERE reduces_value AND NOT requires_reason;
    IF n <> 0 THEN
        RAISE EXCEPTION '028: % value-reducing actions do not require a reason', n;
    END IF;

    RAISE NOTICE '028 OK -- % actions, % reason codes, mode: %',
        (SELECT count(*) FROM authorized_actions),
        (SELECT count(*) FROM authorization_reason_codes),
        auth_mode();
END $$;

COMMIT;
