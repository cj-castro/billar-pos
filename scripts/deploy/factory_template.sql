-- ============================================================================
-- factory_template.sql
-- Turns a COPY of a live Bola 8 database into a factory template: the real
-- menu, recipes, modifiers and resources, with no sales history, no stock and
-- no credentials.
--
-- RUN THIS ONLY AGAINST A THROWAWAY COPY. It truncates every transactional
-- table. New-FactoryTemplate.ps1 restores a dump into a temporary database and
-- runs this there; it never touches the live one.
--
-- Why a template instead of seeding demo data: migrations 029b/031*/032*/034*/
-- 035b assert against the real menu ("exactly 11 Servicio options"), so a
-- demo-seeded database can never satisfy them. See the FRESH INSTALLS note in
-- app/migrations_runner.py. Generating from the real database also means the
-- menu is never maintained in two places.
-- ============================================================================
BEGIN;

-- ── Guard: refuse anything that is not a fully migrated Bola 8 database ─────
-- Without this, a mistyped -d would happily truncate the wrong database.
DO $$
DECLARE n int;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name='schema_migrations') THEN
        RAISE EXCEPTION 'WRONG DATABASE: no schema_migrations in "%"', current_database();
    END IF;

    SELECT count(*) INTO n FROM schema_migrations WHERE version = '039';
    IF n = 0 THEN
        RAISE EXCEPTION 'REFUSING: "%" is not fully migrated (039 missing). Migrate first, then build the template.',
            current_database();
    END IF;

    SELECT count(*) INTO n FROM menu_items WHERE is_active;
    IF n < 50 THEN
        RAISE EXCEPTION 'REFUSING: only % active menu items in "%" -- that is not the real menu.',
            n, current_database();
    END IF;
END $$;

-- ── PART 1 — Drop all transactional history ─────────────────────────────────
-- One statement: these tables reference each other, and TRUNCATE only accepts
-- the group if every FK target is in the same list. Listed explicitly rather
-- than using CASCADE, so a new table that references one of these fails loudly
-- here instead of being silently emptied on a future run.
--
-- RESTART IDENTITY resets inventory_movements.seq, so the new machine's ledger
-- starts from 1 with no gap for the hash chain to explain.
TRUNCATE TABLE
    audit_log,
    authorization_grants,
    authorization_overrides,
    cash_sessions,
    expenses,
    inventory_movements,
    inventory_pack_lots,
    kds_events,
    ledger_violations,
    line_item_modifiers,
    line_item_promotions,
    open_cigarette_boxes,
    pin_attempts,
    pool_timer_sessions,
    print_jobs,
    production_batch_inputs,
    production_batches,
    safe_collections,
    sale_item_costs,
    ticket_line_items,
    ticket_promo_decisions,
    tickets,
    token_blocklist,
    waiting_list
RESTART IDENTITY;

-- ── PART 2 — Zero the stock ─────────────────────────────────────────────────
-- A new machine counts its own stock in. Carrying this bar's counts would show
-- beer that does not exist and let the first shift oversell it. Unit costs are
-- KEPT: they are menu reference data and a sane starting point, and they are
-- corrected by the first purchase anyway.
UPDATE inventory_items
   SET stock_quantity = 0
 WHERE stock_quantity <> 0;

-- ── PART 3 — Scrub credentials and personnel ────────────────────────────────
-- The template keeps user ROWS on purpose: seed.py returns early when any user
-- exists, and that early return is the only thing stopping it from layering its
-- demo wings menu on top of the real one.
--
-- Real staff accounts are dropped -- a template should not carry one bar's
-- employees onto another machine. Only the canonical accounts seed.py knows how
-- to credential survive, so `factory-finalize` can rebuild every one of them
-- from the environment. Their FK references all live in tables PART 1 just
-- truncated, so this cannot orphan anything; if a future table does reference
-- users, this DELETE fails loudly inside the transaction rather than silently
-- cascading.
DELETE FROM users
 WHERE username NOT IN ('admin','manager','waiter1','waiter2','kitchen','barstaff');

-- Staff accounts are commonly deactivated rather than deleted in day-to-day
-- use; a template whose only admin is disabled cannot be logged into at all.
UPDATE users SET is_active = true WHERE NOT is_active;

-- password_hash is NOT NULL, so it gets a sentinel that cannot match any bcrypt
-- verification rather than an empty string. `flask factory-finalize` re-derives
-- real credentials from the environment on first boot.
UPDATE users
   SET password_hash = 'FACTORY_TEMPLATE_AWAITING_RESET',
       pin_hash      = NULL;

INSERT INTO settings (key, value)
VALUES ('factory_template.pending_credential_reset', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true';

-- ── PART 4 — Prove it ───────────────────────────────────────────────────────
DO $$
DECLARE n int; v_menu int; v_recipes int; v_users int;
BEGIN
    SELECT count(*) INTO n FROM tickets;
    IF n <> 0 THEN RAISE EXCEPTION 'factory: % tickets survived', n; END IF;

    SELECT count(*) INTO n FROM inventory_movements;
    IF n <> 0 THEN RAISE EXCEPTION 'factory: % movements survived', n; END IF;

    SELECT count(*) INTO n FROM inventory_items WHERE stock_quantity <> 0;
    IF n <> 0 THEN RAISE EXCEPTION 'factory: % items still hold stock', n; END IF;

    SELECT count(*) INTO n FROM users WHERE password_hash <> 'FACTORY_TEMPLATE_AWAITING_RESET';
    IF n <> 0 THEN RAISE EXCEPTION 'factory: % users kept a usable password', n; END IF;

    -- An admin that factory-finalize can credential is the only way into the
    -- new machine. Without this the template boots into a POS nobody can log in
    -- to, and the failure would only surface at the counter.
    IF NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin' AND is_active) THEN
        RAISE EXCEPTION 'factory: no active admin account survived -- template would be unusable';
    END IF;

    -- The reference data is the entire point of the template; losing it would
    -- produce a dump that boots into an empty POS.
    SELECT count(*) INTO v_menu    FROM menu_items WHERE is_active;
    SELECT count(*) INTO v_recipes FROM insumos_base;
    SELECT count(*) INTO v_users   FROM users;
    IF v_menu < 50    THEN RAISE EXCEPTION 'factory: only % menu items left', v_menu; END IF;
    IF v_recipes < 50 THEN RAISE EXCEPTION 'factory: only % recipe rows left', v_recipes; END IF;
    IF v_users  = 0   THEN RAISE EXCEPTION 'factory: no users left -- seed.py would rebuild the demo menu'; END IF;

    SELECT count(*) INTO n FROM schema_migrations;
    IF n < 28 THEN RAISE EXCEPTION 'factory: only % migrations recorded', n; END IF;

    RAISE NOTICE 'factory OK -- % menu items, % recipe rows, % users, % migrations, 0 tickets, 0 stock',
        v_menu, v_recipes, v_users, n;
END $$;

COMMIT;
