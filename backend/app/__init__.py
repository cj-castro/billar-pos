"""billar-pos Flask application factory — inventory v2.

Migration strategy: all DDL runs inside flask init-db on startup using idempotent
SQL (IF NOT EXISTS, DO $$ blocks with information_schema checks). No separate
Alembic runner is needed; the entrypoint calls flask init-db before gunicorn starts.
"""
import logging
from flask import Flask
from .config import Config
from .extensions import db, migrate, jwt, socketio, cors, limiter


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    logging.basicConfig(
        level=getattr(logging, app.config['LOG_LEVEL'], logging.INFO),
        format='%(asctime)s %(levelname)s %(name)s %(message)s'
    )

    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    cors.init_app(app, resources={r"/api/*": {"origins": "*"}})
    limiter.init_app(app)
    socketio.init_app(app)

    # ── Blueprints ────────────────────────────────────────────────────────────
    from .api.auth import auth_bp
    from .api.resources import resources_bp
    from .api.tickets import tickets_bp
    from .api.queue import queue_bp
    from .api.inventory import inventory_bp
    from .api.reports import reports_bp
    from .api.earnings import earnings_bp
    from .api.menu import menu_bp
    from .api.users import users_bp
    from .api.waiting_list import waiting_list_bp
    from .api.cash_session import cash_bp
    from .api.safe import safe_bp
    from .api.suppliers import suppliers_bp
    from .api.settings import settings_bp

    app.register_blueprint(auth_bp,          url_prefix='/api/v1/auth')
    app.register_blueprint(resources_bp,     url_prefix='/api/v1/resources')
    app.register_blueprint(tickets_bp,       url_prefix='/api/v1/tickets')
    app.register_blueprint(queue_bp,         url_prefix='/api/v1/queue')
    app.register_blueprint(inventory_bp,     url_prefix='/api/v1/inventory')
    app.register_blueprint(reports_bp,       url_prefix='/api/v1/reports')
    app.register_blueprint(earnings_bp,      url_prefix='/api/v1/reports/earnings')
    app.register_blueprint(menu_bp,          url_prefix='/api/v1/menu')
    app.register_blueprint(users_bp,         url_prefix='/api/v1/users')
    app.register_blueprint(waiting_list_bp,  url_prefix='/api/v1/waiting-list')
    app.register_blueprint(cash_bp,          url_prefix='/api/v1/cash')
    app.register_blueprint(safe_bp,          url_prefix='/api/v1/safe')
    app.register_blueprint(suppliers_bp,     url_prefix='/api/v1/suppliers')
    app.register_blueprint(settings_bp,      url_prefix='/api/v1/settings')

    from .sockets import events  # noqa: F401

    # ── CLI: init-db ──────────────────────────────────────────────────────────
    @app.cli.command('init-db')
    def init_db():
        """Create/migrate all tables. Safe to run on every startup (idempotent)."""
        from sqlalchemy import text

        def run(sql, label=''):
            """Execute one SQL statement; rollback and warn on error (non-fatal)."""
            try:
                db.session.execute(text(sql))
                db.session.commit()
            except Exception as exc:
                db.session.rollback()
                tag = f' [{label}]' if label else ''
                print(f'⚠️  Migration skipped{tag}: {exc}')

        # ── STEP 1: Pre-create renames (must run before db.create_all) ────────
        # Rename stock_movements → inventory_movements so SQLAlchemy sees the
        # correct table name when it skips create for existing tables.
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='stock_movements'
              ) AND NOT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='inventory_movements'
              ) THEN
                ALTER TABLE stock_movements RENAME TO inventory_movements;
              END IF;
            END $$;
        """, 'rename stock_movements→inventory_movements')

        # ── STEP 2: Import models and create any missing tables ───────────────
        from .models import (  # noqa: F401
            User, Resource, PoolTableConfig,
            Ticket, TicketLineItem, LineItemModifier, LineItemPromotion, PoolTimerSession,
            MenuCategory, MenuItem, ModifierGroup, MenuItemModifierGroup, Modifier,
            UnitCatalog, InventoryItem, InventoryMovement, StockMovement,
            InsumoBase, MenuItemIngredient, ModifierInventoryRule, SaleItemCost,
            OpenCigaretteBox, Promotion, AuditLog, CashSession, Expense, TipDistributionConfig,
            Supplier, PrintJob,
        )
        from .models.waiting_list import WaitingListEntry  # noqa: F401

        # Creates new tables; skips existing ones (unit_catalog, insumos_base,
        # sale_item_costs, inventory_movements are created here on fresh installs).
        db.create_all()

        # ── STEP 3: Ticket table columns (pre-existing migrations) ────────────
        for stmt in [
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_name VARCHAR(200)",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_cents INTEGER DEFAULT 0",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS was_reopened BOOLEAN DEFAULT FALSE",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMP WITH TIME ZONE",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_by VARCHAR(36)",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS manual_discount_pct INTEGER DEFAULT 0",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS edited_after_close BOOLEAN DEFAULT FALSE",
            "ALTER TABLE ticket_line_items ADD COLUMN IF NOT EXISTS cost_snapshot_cents INTEGER DEFAULT NULL",
            "ALTER TABLE ticket_line_items ADD COLUMN IF NOT EXISTS needs_reprint BOOLEAN DEFAULT FALSE",
            "ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS allow_multiple BOOLEAN DEFAULT FALSE",
        ]:
            run(stmt)

        # ── STEP 4: inventory_items — legacy columns that seed-beer still needs ─
        for stmt in [
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'other'",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS shots_per_bottle INTEGER",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS yields_item_id VARCHAR(36)",
        ]:
            run(stmt)

        # ── STEP 5: inventory_items — inventory v2 new columns ────────────────
        for stmt in [
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sku VARCHAR(100)",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier VARCHAR(150)",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS base_unit_key VARCHAR(50)",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_unit_key VARCHAR(50)",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_pack_size NUMERIC(12,4) DEFAULT 1",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()",
        ]:
            run(stmt)

        # ── STEP 6: Rename quantity → stock_quantity (idempotent) ────────────
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='inventory_items' AND column_name='quantity'
              ) THEN
                ALTER TABLE inventory_items RENAME COLUMN quantity TO stock_quantity;
              END IF;
            END $$;
        """, 'rename quantity→stock_quantity')

        # ── STEP 7: Rename cost_cents → unit_cost_cents (idempotent) ─────────
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='inventory_items' AND column_name='cost_cents'
              ) THEN
                ALTER TABLE inventory_items RENAME COLUMN cost_cents TO unit_cost_cents;
              END IF;
            END $$;
        """, 'rename cost_cents→unit_cost_cents')

        # ── STEP 8: Change stock_quantity / low_stock_threshold to NUMERIC ───
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='inventory_items' AND column_name='stock_quantity'
                  AND data_type='integer'
              ) THEN
                ALTER TABLE inventory_items
                  ALTER COLUMN stock_quantity TYPE NUMERIC(12,4);
              END IF;
            END $$;
        """, 'stock_quantity INTEGER→NUMERIC')

        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='inventory_items' AND column_name='low_stock_threshold'
                  AND data_type='integer'
              ) THEN
                ALTER TABLE inventory_items
                  ALTER COLUMN low_stock_threshold TYPE NUMERIC(12,4);
              END IF;
            END $$;
        """, 'low_stock_threshold INTEGER→NUMERIC')

        # ── STEP 9: inventory_movements — new columns (post-rename) ──────────
        for stmt in [
            "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS quantity_after NUMERIC(12,4)",
            "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_cost_cents INTEGER",
            "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_quantity NUMERIC(12,4)",
            "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_unit_key VARCHAR(50)",
            "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_cost_cents INTEGER",
        ]:
            run(stmt)

        # Change quantity_delta from INTEGER to NUMERIC (idempotent)
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='inventory_movements' AND column_name='quantity_delta'
                  AND data_type='integer'
              ) THEN
                ALTER TABLE inventory_movements
                  ALTER COLUMN quantity_delta TYPE NUMERIC(12,4);
              END IF;
            END $$;
        """, 'quantity_delta INTEGER→NUMERIC')

        # ── STEP 10: modifier_inventory_rules quantity → NUMERIC ──────────────
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='modifier_inventory_rules' AND column_name='quantity'
                  AND data_type='integer'
              ) THEN
                ALTER TABLE modifier_inventory_rules
                  ALTER COLUMN quantity TYPE NUMERIC(12,4);
              END IF;
            END $$;
        """, 'modifier_inventory_rules.quantity INTEGER→NUMERIC')

        # Legacy table: also migrate to NUMERIC for consistency
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='menu_item_ingredients' AND column_name='quantity'
                  AND data_type='integer'
              ) THEN
                ALTER TABLE menu_item_ingredients
                  ALTER COLUMN quantity TYPE NUMERIC(12,4);
              END IF;
            END $$;
        """, 'menu_item_ingredients.quantity INTEGER→NUMERIC')

        # ── STEP 11: Unique constraint on inventory_items.sku ─────────────────
        run("""
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname='uq_inventory_items_sku' AND conrelid='inventory_items'::regclass
              ) THEN
                ALTER TABLE inventory_items
                  ADD CONSTRAINT uq_inventory_items_sku UNIQUE (sku);
              END IF;
            END $$;
        """, 'uq_inventory_items_sku')

        # ── STEP 11b: Ticket / waitlist integrity invariants (Tier-1 fixes) ───
        # Enforce at the DB level the rules the application now also enforces:
        #   - At most one OPEN ticket per resource_id
        #   - An OPEN ticket must have a resource_id
        #   - At most one active waiting-list entry per floor_ticket_id /
        #     assigned_ticket_id (active = WAITING or SEATED)
        # These are the structural backstops for findings F-1, F-3, F-8 and F-9.
        run("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_open_per_resource
            ON tickets (resource_id)
            WHERE status = 'OPEN'
        """, 'uq_tickets_open_per_resource')

        run("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_waiting_list_floor_ticket_active
            ON waiting_list (floor_ticket_id)
            WHERE status IN ('WAITING', 'SEATED') AND floor_ticket_id IS NOT NULL
        """, 'uq_waiting_list_floor_ticket_active')

        run("""
            CREATE UNIQUE INDEX IF NOT EXISTS uq_waiting_list_assigned_ticket_active
            ON waiting_list (assigned_ticket_id)
            WHERE status IN ('WAITING', 'SEATED') AND assigned_ticket_id IS NOT NULL
        """, 'uq_waiting_list_assigned_ticket_active')

        run("""
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'chk_open_ticket_has_resource'
                  AND conrelid = 'tickets'::regclass
              ) THEN
                ALTER TABLE tickets
                  ADD CONSTRAINT chk_open_ticket_has_resource
                  CHECK ((status <> 'OPEN') OR (resource_id IS NOT NULL))
                  NOT VALID;
                ALTER TABLE tickets VALIDATE CONSTRAINT chk_open_ticket_has_resource;
              END IF;
            END $$;
        """, 'chk_open_ticket_has_resource')

        # ── STEP 11c: Repair waitlist entries silently flipped ASSIGNED→CANCELLED
        # by the old _close_linked_waiting_entry filter. Restores any entry whose
        # latest WAITLIST_CLEAR_ON_TICKET_END audit row shows the bad transition
        # and which is still CANCELLED. Idempotent (no-op once repaired).
        run("""
            UPDATE waiting_list w
               SET status = 'ASSIGNED'
             WHERE w.status = 'CANCELLED'
               AND EXISTS (
                 SELECT 1 FROM audit_log a
                  WHERE a.entity_id = w.id
                    AND a.action = 'WAITLIST_CLEAR_ON_TICKET_END'
                    AND a.before_state->>'status' = 'ASSIGNED'
                    AND a.after_state->>'status' = 'CANCELLED'
               )
        """, 'repair waitlist ASSIGNED→CANCELLED rewrites')

        db.session.commit()

        # ── STEP 12: Seed unit_catalog ────────────────────────────────────────
        print('  → Seeding unit catalog...')
        seed_units = [
            ('pieza',     'Pieza',      'Piece'),
            ('porcion',   'Porción',    'Serving'),
            ('botella',   'Botella',    'Bottle'),
            ('lata',      'Lata',       'Can'),
            ('caballito', 'Caballito',  'Shot'),
            ('six_pack',  'Six Pack',   'Six Pack'),
            ('caja',      'Caja',       'Case'),
            ('barril',    'Barril',     'Keg'),
            ('ml',        'Mililitro',  'Milliliter'),
            ('litro',     'Litro',      'Liter'),
            ('gramo',     'Gramo',      'Gram'),
            ('kilogramo', 'Kilogramo',  'Kilogram'),
            ('frasco',    'Frasco',     'Jar'),
            ('charola',   'Charola',    'Tray'),
            ('onza',      'Onza',       'Oz'),
            ('taza',      'Taza',       'Cup'),
        ]
        for key, es, en in seed_units:
            run(
                f"INSERT INTO unit_catalog (key, name_es, name_en, active) "
                f"VALUES ('{key}', '{es}', '{en}', TRUE) "
                f"ON CONFLICT (key) DO NOTHING",
                f'seed unit {key}'
            )

        # ── STEP 13: Backfill base_unit_key from legacy unit column ───────────
        # Mapping: old free-text unit → unit_catalog.key
        unit_map = {
            'bottle':  'botella',
            'shot':    'caballito',
            'can':     'lata',
            'serving': 'porcion',
            'ramekin': 'porcion',
            'ml':      'ml',
            'oz':      'onza',
            'cup':     'taza',
            'lb':      'kilogramo',
            'unit':    'pieza',
            # Spanish variants (entered by managers manually)
            'botella':   'botella',
            'caballito': 'caballito',
            'lata':      'lata',
            'porcion':   'porcion',
            'pieza':     'pieza',
        }
        for old_val, new_key in unit_map.items():
            run(
                f"UPDATE inventory_items "
                f"SET base_unit_key = '{new_key}' "
                f"WHERE base_unit_key IS NULL "
                f"AND unit = '{old_val}'",
                f'backfill unit {old_val}→{new_key}'
            )

        # Fallback: any unmapped unit value → 'pieza'
        run("""
            UPDATE inventory_items
            SET base_unit_key = 'pieza'
            WHERE base_unit_key IS NULL
        """, 'backfill unit fallback→pieza')

        # ── STEP 14: FK constraint base_unit_key → unit_catalog ───────────────
        run("""
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname='fk_inventory_items_base_unit'
                  AND conrelid='inventory_items'::regclass
              ) THEN
                ALTER TABLE inventory_items
                  ADD CONSTRAINT fk_inventory_items_base_unit
                  FOREIGN KEY (base_unit_key) REFERENCES unit_catalog(key) ON DELETE RESTRICT;
              END IF;
            END $$;
        """, 'fk base_unit_key')

        # ── STEP 15: NOT NULL on base_unit_key (safe only after backfill) ─────
        run("""
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='inventory_items' AND column_name='base_unit_key'
                  AND is_nullable='YES'
              ) AND NOT EXISTS (
                SELECT 1 FROM inventory_items WHERE base_unit_key IS NULL
              ) THEN
                ALTER TABLE inventory_items
                  ALTER COLUMN base_unit_key SET NOT NULL;
              END IF;
            END $$;
        """, 'base_unit_key SET NOT NULL')

        # ── STEP 16: Populate insumos_base from menu_item_ingredients ─────────
        # Only migrates rows where unit_catalog entry exists for the item's base_unit_key.
        # Uses ON CONFLICT DO NOTHING so this is safe to re-run.
        run("""
            INSERT INTO insumos_base
              (id, menu_item_id, inventory_item_id, quantity, deduction_unit_key, created_at)
            SELECT
              mii.id,
              mii.menu_item_id,
              mii.inventory_item_id,
              mii.quantity,
              COALESCE(ii.base_unit_key, 'pieza'),
              NOW()
            FROM menu_item_ingredients mii
            JOIN inventory_items ii ON ii.id = mii.inventory_item_id
            WHERE ii.base_unit_key IS NOT NULL
            ON CONFLICT (menu_item_id, inventory_item_id) DO NOTHING
        """, 'populate insumos_base from menu_item_ingredients')

        # ── STEP 17: Indexes ──────────────────────────────────────────────────
        indexes = [
            ("idx_inventory_items_category",
             "CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items (category)"),
            ("idx_inventory_items_is_active",
             "CREATE INDEX IF NOT EXISTS idx_inventory_items_is_active ON inventory_items (is_active)"),
            ("idx_inventory_items_base_unit_key",
             "CREATE INDEX IF NOT EXISTS idx_inventory_items_base_unit_key ON inventory_items (base_unit_key)"),
            ("idx_inventory_items_category_name",
             "CREATE INDEX IF NOT EXISTS idx_inventory_items_category_name ON inventory_items (category, name)"),
            ("idx_inventory_movements_item_created",
             "CREATE INDEX IF NOT EXISTS idx_inventory_movements_item_created "
             "ON inventory_movements (inventory_item_id, created_at DESC)"),
            ("idx_inventory_movements_event_type",
             "CREATE INDEX IF NOT EXISTS idx_inventory_movements_event_type "
             "ON inventory_movements (event_type)"),
            ("idx_inventory_movements_reference_id",
             "CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference_id "
             "ON inventory_movements (reference_id) WHERE reference_id IS NOT NULL"),
            ("idx_inventory_movements_restock",
             "CREATE INDEX IF NOT EXISTS idx_inventory_movements_restock "
             "ON inventory_movements (inventory_item_id, created_at) "
             "WHERE event_type = 'RESTOCK'"),
            ("idx_insumos_base_inventory_item",
             "CREATE INDEX IF NOT EXISTS idx_insumos_base_inventory_item "
             "ON insumos_base (inventory_item_id)"),
            ("idx_sale_item_costs_line_item",
             "CREATE INDEX IF NOT EXISTS idx_sale_item_costs_line_item "
             "ON sale_item_costs (ticket_line_item_id)"),
            ("idx_sale_item_costs_inventory_item",
             "CREATE INDEX IF NOT EXISTS idx_sale_item_costs_inventory_item "
             "ON sale_item_costs (inventory_item_id)"),
            ("idx_sale_item_costs_recorded_at",
             "CREATE INDEX IF NOT EXISTS idx_sale_item_costs_recorded_at "
             "ON sale_item_costs (recorded_at)"),
        ]
        for name, stmt in indexes:
            run(stmt, name)

        # ── STEP 18: TipDistributionConfig seed ───────────────────────────────
        from .models.cash_session import TipDistributionConfig as TDC
        if not TDC.query.get(1):
            db.session.add(TDC(id=1))
            db.session.commit()
            print('  + TipDistributionConfig default row created')

        print('✅ Database tables created / schema updated (inventory v2).')

        # ── STEP 19: Suppliers table index (table itself created by db.create_all) ─
        run(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name "
            "ON suppliers (lower(name)) WHERE is_active = TRUE",
            'uq_suppliers_name'
        )

        # ── STEP 20: Fix duplicate sort_order on menu categories ──────────────
        db.session.execute(db.text(
            "UPDATE menu_categories SET sort_order = 35 "
            "WHERE name = 'Cubetas de Cerveza' AND sort_order = 3"
        ))
        db.session.commit()
        print("STEP 20: menu_categories sort_order conflict fixed")

        # ── STEP 21: Express Sale / Rappi / Pool-cancel columns ───────────────
        for stmt in [
            # Ticket type discriminator (TABLE | EXPRESS | DELIVERY)
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type VARCHAR(20) NOT NULL DEFAULT 'TABLE'",
            # Rappi order reference (required for DELIVERY tickets)
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rappi_order_id VARCHAR(100)",
            # Widen payment_type to hold 'EXTERNAL' (was VARCHAR(10))
            "ALTER TABLE tickets ALTER COLUMN payment_type TYPE VARCHAR(20)",
            # Pool timer status for explicit cancellation (ACTIVE | CANCELLED | COMPLETED)
            "ALTER TABLE pool_timer_sessions ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'",
            "ALTER TABLE pool_timer_sessions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE",
            "ALTER TABLE pool_timer_sessions ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(36)",
            # Backfill existing completed sessions so status is consistent
            "UPDATE pool_timer_sessions SET status = 'COMPLETED' WHERE end_time IS NOT NULL AND status = 'ACTIVE'",
            # Replace the old "open ticket must have resource" constraint so that
            # EXPRESS and DELIVERY tickets (which intentionally have no resource)
            # can be created while still enforcing the rule for TABLE tickets.
            "ALTER TABLE tickets DROP CONSTRAINT IF EXISTS chk_open_ticket_has_resource",
            """ALTER TABLE tickets ADD CONSTRAINT chk_open_ticket_has_resource
               CHECK (
                 (status <> 'OPEN')
                 OR (resource_id IS NOT NULL)
                 OR (ticket_type IN ('EXPRESS', 'DELIVERY'))
               )""",
        ]:
            run(stmt, 'step21')
        print("STEP 21: express/rappi/void-timer columns added")


    @app.cli.command('seed-beer')
    def seed_beer():
        """Idempotently add beer brands, cocktail ingredients, and recipes."""
        from .models.inventory import InventoryItem, MenuItemIngredient, ModifierInventoryRule
        from .models.menu import MenuItem, MenuCategory, ModifierGroup, Modifier, MenuItemModifierGroup
        import uuid as _uuid

        def get_or_create_inv(name, unit, qty, category, threshold=6, shots=None):
            item = InventoryItem.query.filter_by(name=name).first()
            if not item:
                # Map legacy unit to catalog key
                unit_map = {
                    'bottle': 'botella', 'shot': 'caballito', 'can': 'lata',
                    'serving': 'porcion', 'ml': 'ml', 'unit': 'pieza',
                }
                base_unit = unit_map.get(unit, 'pieza')
                item = InventoryItem(
                    name=name, base_unit_key=base_unit,
                    stock_quantity=qty, low_stock_threshold=threshold,
                    category=category, shots_per_bottle=shots,
                )
                db.session.add(item)
                db.session.flush()
                print(f'  + Inventory: {name}')
            return item

        def get_or_create_menu_item(name, category_name, price_cents):
            item = MenuItem.query.filter_by(name=name).first()
            if item:
                return item, False
            cat = MenuCategory.query.filter_by(name=category_name).first()
            if not cat:
                print(f'  ⚠ Category not found: {category_name}')
                return None, False
            item = MenuItem(category_id=cat.id, name=name,
                            price_cents=price_cents, is_active=True, sort_order=50)
            db.session.add(item)
            db.session.flush()
            print(f'  + Menu item: {name}')
            return item, True

        def link_ingredient(menu_item_id, inv_item, quantity=1):
            """Write to both MenuItemIngredient (legacy) and InsumoBase (new)."""
            from .models.inventory import InsumoBase
            # Legacy
            if not MenuItemIngredient.query.filter_by(
                menu_item_id=menu_item_id, inventory_item_id=inv_item.id
            ).first():
                db.session.add(MenuItemIngredient(
                    menu_item_id=menu_item_id,
                    inventory_item_id=inv_item.id,
                    quantity=quantity,
                ))
            # New
            if not InsumoBase.query.filter_by(
                menu_item_id=menu_item_id, inventory_item_id=inv_item.id
            ).first():
                db.session.add(InsumoBase(
                    menu_item_id=menu_item_id,
                    inventory_item_id=inv_item.id,
                    quantity=quantity,
                    deduction_unit_key=inv_item.base_unit_key,
                ))

        print('🍺 Seeding beer & cocktail inventory...')

        beer_brands = [
            ('Corona Bottle', 48), ('XX Lager Bottle', 48), ('Pacifico Bottle', 48),
            ('Sol Bottle', 48), ('Tecate Bottle', 48), ('Modelo Negra Bottle', 24),
            ('Victoria Bottle', 24),
        ]
        beer_inv = {}
        for name, qty in beer_brands:
            beer_inv[name] = get_or_create_inv(name, 'bottle', qty, 'beer', threshold=12)

        tb_shot   = get_or_create_inv('Tequila Blanco Shot',    'shot', 30, 'spirit', threshold=5)
        tb_bottle = get_or_create_inv('Tequila Blanco Bottle',  'bottle', 6, 'spirit', threshold=2, shots=15)
        if tb_bottle.yields_item_id is None:
            tb_bottle.yields_item_id = tb_shot.id

        tr_shot   = get_or_create_inv('Tequila Reposado Shot',   'shot', 30, 'spirit', threshold=5)
        tr_bottle = get_or_create_inv('Tequila Reposado Bottle', 'bottle', 4, 'spirit', threshold=2, shots=15)
        if tr_bottle.yields_item_id is None:
            tr_bottle.yields_item_id = tr_shot.id

        clamato    = get_or_create_inv('Clamato',    'ml',  5000, 'mixer', threshold=500)
        triple_sec = get_or_create_inv('Triple Sec', 'ml',   700, 'mixer', threshold=100)
        lime_juice = get_or_create_inv('Lime Juice', 'ml',   500, 'mixer', threshold=100)
        soda_can   = get_or_create_inv('Soda Can',   'can',  120, 'mixer', threshold=12)

        db.session.flush()

        beer_prices = {
            'Corona': 8000, 'XX Lager': 8000, 'Pacifico': 8000,
            'Sol': 7500,    'Tecate': 7500,    'Modelo Negra': 9000, 'Victoria': 7500,
        }
        for brand, price in beer_prices.items():
            menu_item, created = get_or_create_menu_item(brand, 'Beer & Drafts', price)
            if menu_item and created:
                inv_item = beer_inv.get(f'{brand} Bottle')
                if inv_item:
                    link_ingredient(menu_item.id, inv_item, quantity=1)

        michelada, _ = get_or_create_menu_item('Michelada', 'Beer & Drafts', 11000)
        if michelada:
            link_ingredient(michelada.id, clamato, quantity=90)

            mg = ModifierGroup.query.filter_by(name='Beer Brand').first()
            if not mg:
                mg = ModifierGroup(name='Beer Brand', is_mandatory=True,
                                   min_selections=1, max_selections=1)
                db.session.add(mg)
                db.session.flush()
                for brand in ['Corona', 'XX Lager', 'Pacifico', 'Sol',
                              'Tecate', 'Modelo Negra', 'Victoria']:
                    mod = Modifier(modifier_group_id=mg.id, name=brand, price_cents=0)
                    db.session.add(mod)
                    db.session.flush()
                    inv_item = beer_inv.get(f'{brand} Bottle')
                    if inv_item:
                        db.session.add(ModifierInventoryRule(
                            modifier_id=mod.id, inventory_item_id=inv_item.id, quantity=1))
                print('  + Modifier group: Beer Brand')

            existing_link = MenuItemModifierGroup.query.filter_by(
                menu_item_id=michelada.id, modifier_group_id=mg.id).first()
            if not existing_link:
                db.session.add(MenuItemModifierGroup(
                    menu_item_id=michelada.id, modifier_group_id=mg.id))

        margarita = MenuItem.query.filter_by(name='Margarita').first()
        if margarita:
            if not MenuItemIngredient.query.filter_by(menu_item_id=margarita.id).first():
                link_ingredient(margarita.id, tb_shot,    quantity=1)
                link_ingredient(margarita.id, triple_sec, quantity=30)
                print('  + Margarita recipe: 1 tequila shot + 30ml triple sec')

        bs_blanco, bs_b_created = get_or_create_menu_item(
            'Bottle Service - Tequila Blanco', 'Cocktails', 80000)
        if bs_blanco and bs_b_created:
            link_ingredient(bs_blanco.id, tb_bottle, quantity=1)
            link_ingredient(bs_blanco.id, soda_can,  quantity=3)

        bs_repo, bs_r_created = get_or_create_menu_item(
            'Bottle Service - Tequila Reposado', 'Cocktails', 95000)
        if bs_repo and bs_r_created:
            link_ingredient(bs_repo.id, tr_bottle, quantity=1)
            link_ingredient(bs_repo.id, soda_can,  quantity=3)

        db.session.commit()
        print('✅ Beer & cocktail inventory seeded.')

    # ── CLI: seed-buckets ─────────────────────────────────────────────────────
    @app.cli.command('seed-buckets')
    def seed_buckets():
        """Idempotently add Beer Bucket menu items with per-brand beer selection."""
        from .models.inventory import InventoryItem, ModifierInventoryRule
        from .models.menu import MenuItem, MenuCategory, ModifierGroup, Modifier, MenuItemModifierGroup

        def get_inv(name):
            return InventoryItem.query.filter_by(name=name).first()

        def get_or_create_category(name, routing, sort_order):
            cat = MenuCategory.query.filter_by(name=name).first()
            if not cat:
                cat = MenuCategory(name=name, routing=routing, sort_order=sort_order)
                db.session.add(cat)
                db.session.flush()
                print(f'  + Category: {name}')
            return cat

        def build_bucket_group(group_name, brand_names, beer_count):
            mg = ModifierGroup.query.filter_by(name=group_name).first()
            if not mg:
                mg = ModifierGroup(name=group_name, is_mandatory=True,
                                   min_selections=beer_count, max_selections=beer_count,
                                   allow_multiple=True)
                db.session.add(mg)
                db.session.flush()
                for brand in brand_names:
                    inv = get_inv(f'{brand} Bottle')
                    if not inv:
                        print(f'  ⚠ Inventory not found: {brand} Bottle — run seed-beer first')
                        continue
                    mod = Modifier(modifier_group_id=mg.id, name=brand, price_cents=0)
                    db.session.add(mod)
                    db.session.flush()
                    db.session.add(ModifierInventoryRule(
                        modifier_id=mod.id, inventory_item_id=inv.id, quantity=1))
                print(f'  + Modifier group: {group_name}')
            return mg

        print('🪣 Seeding beer buckets...')
        cat_buckets = get_or_create_category('Beer Buckets', 'BAR', sort_order=3)
        all_brands     = ['Corona', 'XX Lager', 'Pacifico', 'Sol',
                          'Tecate', 'Modelo Negra', 'Victoria']
        premium_brands = ['Corona', 'Modelo Negra', 'Victoria', 'Pacifico']

        simple_group  = build_bucket_group('Bucket Beers - Simple',  all_brands,     beer_count=10)
        premium_group = build_bucket_group('Bucket Beers - Premium', premium_brands, beer_count=10)

        simple = MenuItem.query.filter_by(name='Simple Beer Bucket (10 beers)').first()
        if not simple:
            simple = MenuItem(category_id=cat_buckets.id,
                              name='Simple Beer Bucket (10 beers)',
                              price_cents=70000, is_active=True, sort_order=1)
            db.session.add(simple)
            db.session.flush()
            db.session.add(MenuItemModifierGroup(
                menu_item_id=simple.id, modifier_group_id=simple_group.id))
            print('  + Menu item: Simple Beer Bucket (10 beers)')

        premium = MenuItem.query.filter_by(name='Premium Beer Bucket (10 beers)').first()
        if not premium:
            premium = MenuItem(category_id=cat_buckets.id,
                               name='Premium Beer Bucket (10 beers)',
                               price_cents=95000, is_active=True, sort_order=2)
            db.session.add(premium)
            db.session.flush()
            db.session.add(MenuItemModifierGroup(
                menu_item_id=premium.id, modifier_group_id=premium_group.id))
            print('  + Menu item: Premium Beer Bucket (10 beers)')

        db.session.commit()
        print('✅ Beer buckets seeded.')

    # ── Health check ──────────────────────────────────────────────────────────
    @app.route('/api/v1/health')
    def health():
        return {'status': 'ok'}

    return app
