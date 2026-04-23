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

    # Init extensions
    db.init_app(app)
    migrate.init_app(app, db)
    jwt.init_app(app)
    cors.init_app(app, resources={r"/api/*": {"origins": "*"}})
    limiter.init_app(app)
    socketio.init_app(app)

    # Register blueprints
    from .api.auth import auth_bp
    from .api.resources import resources_bp
    from .api.tickets import tickets_bp
    from .api.queue import queue_bp
    from .api.inventory import inventory_bp
    from .api.reports import reports_bp
    from .api.menu import menu_bp
    from .api.users import users_bp
    from .api.waiting_list import waiting_list_bp
    from .api.cash_session import cash_bp
    from .api.safe import safe_bp

    app.register_blueprint(auth_bp, url_prefix='/api/v1/auth')
    app.register_blueprint(resources_bp, url_prefix='/api/v1/resources')
    app.register_blueprint(tickets_bp, url_prefix='/api/v1/tickets')
    app.register_blueprint(queue_bp, url_prefix='/api/v1/queue')
    app.register_blueprint(inventory_bp, url_prefix='/api/v1/inventory')
    app.register_blueprint(reports_bp, url_prefix='/api/v1/reports')
    app.register_blueprint(menu_bp, url_prefix='/api/v1/menu')
    app.register_blueprint(users_bp, url_prefix='/api/v1/users')
    app.register_blueprint(waiting_list_bp, url_prefix='/api/v1/waiting-list')
    app.register_blueprint(cash_bp, url_prefix='/api/v1/cash')
    app.register_blueprint(safe_bp, url_prefix='/api/v1/safe')

    # Register socket events
    from .sockets import events  # noqa: F401

    @app.cli.command('init-db')
    def init_db():
        from sqlalchemy import text
        # Import all models so SQLAlchemy knows about them
        from .models import (  # noqa: F401
            User, Resource, PoolTableConfig,
            Ticket, TicketLineItem, LineItemModifier, LineItemPromotion, PoolTimerSession,
            MenuCategory, MenuItem, ModifierGroup, MenuItemModifierGroup, Modifier,
            InventoryItem, ModifierInventoryRule, StockMovement,
            Promotion, AuditLog, CashSession, Expense, TipDistributionConfig
        )
        from .models.waiting_list import WaitingListEntry  # noqa: F401
        from .models.inventory import MenuItemIngredient  # noqa: F401
        db.create_all()

        # Add new columns to existing tables without dropping data
        migrations = [
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_name VARCHAR(200)",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_cents INTEGER DEFAULT 0",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS was_reopened BOOLEAN DEFAULT FALSE",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMP WITH TIME ZONE",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_by VARCHAR(36)",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS manual_discount_pct INTEGER DEFAULT 0",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'other'",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS shots_per_bottle INTEGER",
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS yields_item_id VARCHAR(36)",
            "ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS allow_multiple BOOLEAN DEFAULT FALSE",
        ]
        for stmt in migrations:
            try:
                db.session.execute(text(stmt))
            except Exception as e:
                print(f'⚠️  Migration skipped ({e})')
                db.session.rollback()
        db.session.commit()
        # Seed default TipDistributionConfig (id=1) if not exists
        from .models.cash_session import TipDistributionConfig as TDC
        if not TDC.query.get(1):
            db.session.add(TDC(id=1))
            db.session.commit()
            print('  + TipDistributionConfig default row created')
        print('✅ Database tables created / schema updated.')

    @app.cli.command('seed-beer')
    def seed_beer():
        """Idempotently add beer brands, cocktail ingredients, and recipes."""
        from .models.inventory import InventoryItem, MenuItemIngredient, ModifierInventoryRule
        from .models.menu import MenuItem, MenuCategory, ModifierGroup, Modifier, MenuItemModifierGroup
        import uuid as _uuid

        def get_or_create_inv(name, unit, qty, category, threshold=6, shots=None):
            item = InventoryItem.query.filter_by(name=name).first()
            if not item:
                item = InventoryItem(name=name, unit=unit, quantity=qty,
                                     low_stock_threshold=threshold, category=category,
                                     shots_per_bottle=shots)
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
            item = MenuItem(category_id=cat.id, name=name, price_cents=price_cents, is_active=True, sort_order=50)
            db.session.add(item)
            db.session.flush()
            print(f'  + Menu item: {name}')
            return item, True

        print('🍺 Seeding beer & cocktail inventory...')

        # ── Beer Bottle Inventory ──────────────────────────────
        beer_brands = [
            ('Corona Bottle', 48), ('XX Lager Bottle', 48), ('Pacifico Bottle', 48),
            ('Sol Bottle', 48), ('Tecate Bottle', 48), ('Modelo Negra Bottle', 24),
            ('Victoria Bottle', 24),
        ]
        beer_inv = {}
        for name, qty in beer_brands:
            beer_inv[name] = get_or_create_inv(name, 'bottle', qty, 'beer', threshold=12)

        # ── Spirit bottles + shots ────────────────────────────
        # Tequila Blanco
        tb_shot = get_or_create_inv('Tequila Blanco Shot', 'shot', 30, 'spirit', threshold=5)
        tb_bottle = get_or_create_inv('Tequila Blanco Bottle', 'bottle', 6, 'spirit', threshold=2, shots=15)
        if tb_bottle.yields_item_id is None:
            tb_bottle.yields_item_id = tb_shot.id

        # Tequila Reposado
        tr_shot = get_or_create_inv('Tequila Reposado Shot', 'shot', 30, 'spirit', threshold=5)
        tr_bottle = get_or_create_inv('Tequila Reposado Bottle', 'bottle', 4, 'spirit', threshold=2, shots=15)
        if tr_bottle.yields_item_id is None:
            tr_bottle.yields_item_id = tr_shot.id

        # ── Mixers ───────────────────────────────────────────
        clamato = get_or_create_inv('Clamato', 'ml', 5000, 'mixer', threshold=500)
        triple_sec = get_or_create_inv('Triple Sec', 'ml', 700, 'mixer', threshold=100)
        lime_juice = get_or_create_inv('Lime Juice', 'ml', 500, 'mixer', threshold=100)
        soda_can = get_or_create_inv('Soda Can', 'can', 120, 'mixer', threshold=12)

        db.session.flush()

        # ── Menu: individual beer brand items ─────────────────
        beer_prices = {
            'Corona': 8000, 'XX Lager': 8000, 'Pacifico': 8000,
            'Sol': 7500, 'Tecate': 7500, 'Modelo Negra': 9000, 'Victoria': 7500,
        }
        for brand, price in beer_prices.items():
            menu_item, created = get_or_create_menu_item(brand, 'Beer & Drafts', price)
            if menu_item and created:
                inv_name = f'{brand} Bottle'
                inv_item = beer_inv.get(inv_name)
                if inv_item:
                    ing = MenuItemIngredient(menu_item_id=menu_item.id, inventory_item_id=inv_item.id, quantity=1)
                    db.session.add(ing)

        # ── Menu: Michelada ───────────────────────────────────
        michelada, mich_created = get_or_create_menu_item('Michelada', 'Beer & Drafts', 11000)
        if michelada:
            # Clamato ingredient on the item itself (90ml per michelada)
            existing_clamato_ing = MenuItemIngredient.query.filter_by(
                menu_item_id=michelada.id, inventory_item_id=clamato.id).first()
            if not existing_clamato_ing:
                db.session.add(MenuItemIngredient(menu_item_id=michelada.id,
                                                   inventory_item_id=clamato.id, quantity=90))

            # Beer brand modifier group for Michelada
            mg = ModifierGroup.query.filter_by(name='Beer Brand').first()
            if not mg:
                mg = ModifierGroup(name='Beer Brand', is_mandatory=True, min_selections=1, max_selections=1)
                db.session.add(mg)
                db.session.flush()
                for brand in ['Corona', 'XX Lager', 'Pacifico', 'Sol', 'Tecate', 'Modelo Negra', 'Victoria']:
                    mod = Modifier(modifier_group_id=mg.id, name=brand, price_cents=0)
                    db.session.add(mod)
                    db.session.flush()
                    # Link modifier to its beer bottle inventory
                    inv_item = beer_inv.get(f'{brand} Bottle')
                    if inv_item:
                        db.session.add(ModifierInventoryRule(
                            modifier_id=mod.id, inventory_item_id=inv_item.id, quantity=1))
                print('  + Modifier group: Beer Brand')

            # Link Beer Brand modifier group to Michelada
            existing_link = MenuItemModifierGroup.query.filter_by(
                menu_item_id=michelada.id, modifier_group_id=mg.id).first()
            if not existing_link:
                db.session.add(MenuItemModifierGroup(menu_item_id=michelada.id, modifier_group_id=mg.id))

        # ── Update existing Margarita with tequila shot ingredient ──
        margarita = MenuItem.query.filter_by(name='Margarita').first()
        if margarita:
            existing = MenuItemIngredient.query.filter_by(menu_item_id=margarita.id).first()
            if not existing:
                db.session.add(MenuItemIngredient(menu_item_id=margarita.id,
                                                   inventory_item_id=tb_shot.id, quantity=1))
                db.session.add(MenuItemIngredient(menu_item_id=margarita.id,
                                                   inventory_item_id=triple_sec.id, quantity=30))
                print('  + Margarita recipe: 1 tequila shot + 30ml triple sec')

        # ── Bottle Service menu items ─────────────────────────
        bs_blanco, bs_b_created = get_or_create_menu_item(
            'Bottle Service - Tequila Blanco', 'Cocktails', 80000)
        if bs_blanco and bs_b_created:
            db.session.add(MenuItemIngredient(menu_item_id=bs_blanco.id,
                                               inventory_item_id=tb_bottle.id, quantity=1))
            db.session.add(MenuItemIngredient(menu_item_id=bs_blanco.id,
                                               inventory_item_id=soda_can.id, quantity=3))

        bs_repo, bs_r_created = get_or_create_menu_item(
            'Bottle Service - Tequila Reposado', 'Cocktails', 95000)
        if bs_repo and bs_r_created:
            db.session.add(MenuItemIngredient(menu_item_id=bs_repo.id,
                                               inventory_item_id=tr_bottle.id, quantity=1))
            db.session.add(MenuItemIngredient(menu_item_id=bs_repo.id,
                                               inventory_item_id=soda_can.id, quantity=3))

        db.session.commit()
        print('✅ Beer & cocktail inventory seeded.')

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
                print(f'  + Modifier group: {group_name} ({len(brand_names)} brands, {beer_count} beers)')
            return mg

        print('🪣 Seeding beer buckets...')

        cat_buckets = get_or_create_category('Beer Buckets', 'BAR', sort_order=3)

        all_brands = ['Corona', 'XX Lager', 'Pacifico', 'Sol', 'Tecate', 'Modelo Negra', 'Victoria']
        premium_brands = ['Corona', 'Modelo Negra', 'Victoria', 'Pacifico']

        simple_group = build_bucket_group('Bucket Beers - Simple', all_brands, beer_count=10)
        premium_group = build_bucket_group('Bucket Beers - Premium', premium_brands, beer_count=10)

        # ── Simple Bucket ─────────────────────────────────────
        simple = MenuItem.query.filter_by(name='Simple Beer Bucket (10 beers)').first()
        if not simple:
            simple = MenuItem(category_id=cat_buckets.id, name='Simple Beer Bucket (10 beers)',
                              price_cents=70000, is_active=True, sort_order=1)
            db.session.add(simple)
            db.session.flush()
            db.session.add(MenuItemModifierGroup(menu_item_id=simple.id, modifier_group_id=simple_group.id))
            print('  + Menu item: Simple Beer Bucket (10 beers)')

        # ── Premium Bucket ────────────────────────────────────
        premium = MenuItem.query.filter_by(name='Premium Beer Bucket (10 beers)').first()
        if not premium:
            premium = MenuItem(category_id=cat_buckets.id, name='Premium Beer Bucket (10 beers)',
                               price_cents=95000, is_active=True, sort_order=2)
            db.session.add(premium)
            db.session.flush()
            db.session.add(MenuItemModifierGroup(menu_item_id=premium.id, modifier_group_id=premium_group.id))
            print('  + Menu item: Premium Beer Bucket (10 beers)')

        db.session.commit()
        print('✅ Beer buckets seeded.')

    # Health check
    @app.route('/api/v1/health')
    def health():
        return {'status': 'ok'}

    return app
