"""
Initial seed data for the billiard bar POS system.
Run once on startup if tables are empty.
"""
import os
import sys

# Add the app directory to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import create_app
from app.extensions import db
from app.models.user import User
from app.models.resource import Resource, PoolTableConfig
from app.models.menu import MenuCategory, MenuItem, ModifierGroup, MenuItemModifierGroup, Modifier
from app.models.inventory import InventoryItem, ModifierInventoryRule


def seed():
    app = create_app()
    with app.app_context():
        # Check if already seeded
        if User.query.count() > 0:
            print("Database already seeded, skipping.")
            return

        print("Seeding database...")

        # ── Users ──────────────────────────────────────────
        # Passwords read from env so they survive fresh deploys correctly.
        admin = User(username='admin', name='Admin User', role='ADMIN')
        admin.set_password(os.environ.get('ADMIN_PASSWORD', 'admin123'))
        admin.set_pin(os.environ.get('ADMIN_PIN', '1234'))
        db.session.add(admin)

        manager = User(username='manager', name='Floor Manager', role='MANAGER')
        manager.set_password(os.environ.get('MANAGER_PASSWORD', 'manager123'))
        manager.set_pin(os.environ.get('MANAGER_PIN', '5678'))
        db.session.add(manager)

        waiter1 = User(username='waiter1', name='Alice Waiter', role='WAITER')
        waiter1.set_password(os.environ.get('WAITER1_PASSWORD', 'waiter123'))
        db.session.add(waiter1)

        waiter2 = User(username='waiter2', name='Bob Waiter', role='WAITER')
        waiter2.set_password(os.environ.get('WAITER2_PASSWORD', 'waiter123'))
        db.session.add(waiter2)

        kitchen = User(username='kitchen', name='Kitchen Staff', role='KITCHEN_STAFF')
        kitchen.set_password(os.environ.get('KITCHEN_PASSWORD', 'kitchen123'))
        db.session.add(kitchen)

        bar_staff = User(username='barstaff', name='Bar Staff', role='BAR_STAFF')
        bar_staff.set_password(os.environ.get('BARSTAFF_PASSWORD', 'bar123'))
        db.session.add(bar_staff)

        # ── Pool Tables ────────────────────────────────────
        for i in range(1, 6):
            pt = Resource(code=f'PT{i}', name=f'Pool Table {i}', type='POOL_TABLE', sort_order=i)
            db.session.add(pt)
            db.session.flush()
            cfg = PoolTableConfig(resource_id=pt.id, billing_mode='PER_MINUTE', rate_cents=150)
            db.session.add(cfg)

        # ── Regular Tables ─────────────────────────────────
        for i in range(1, 9):
            t = Resource(code=f'T{i:02d}', name=f'Table {i}', type='REGULAR_TABLE', sort_order=10 + i)
            db.session.add(t)

        # ── Bar Seats ──────────────────────────────────────
        for i in range(1, 7):
            b = Resource(code=f'Bar-{i:02d}', name=f'Bar Seat {i}', type='BAR_SEAT', sort_order=20 + i)
            db.session.add(b)

        db.session.flush()

        # ── Menu Categories ────────────────────────────────
        cat_wings = MenuCategory(name='Wings & Tenders', routing='KITCHEN', sort_order=1)
        cat_food = MenuCategory(name='Food', routing='KITCHEN', sort_order=2)
        cat_beer = MenuCategory(name='Beer & Drafts', routing='BAR', sort_order=3)
        cat_cocktails = MenuCategory(name='Cocktails', routing='BAR', sort_order=4)
        cat_softs = MenuCategory(name='Soft Drinks', routing='BAR', sort_order=5)
        cat_sauces = MenuCategory(name='Sauces & Extras', routing='KITCHEN', sort_order=6)

        for cat in [cat_wings, cat_food, cat_beer, cat_cocktails, cat_softs, cat_sauces]:
            db.session.add(cat)
        db.session.flush()

        # ── Modifier Groups ────────────────────────────────
        flavor_group = ModifierGroup(name='Wing Flavor', is_mandatory=True, min_selections=1, max_selections=1)
        db.session.add(flavor_group)
        db.session.flush()

        flavors_data = [
            ('Buffalo', 0),
            ('BBQ', 0),
            ('Garlic Parmesan', 0),
            ('Honey Mustard', 0),
            ('Lemon Pepper', 0),
            ('Mango Habanero', 0),
        ]
        flavors = []
        for fname, price in flavors_data:
            f = Modifier(modifier_group_id=flavor_group.id, name=fname, price_cents=price)
            db.session.add(f)
            flavors.append(f)
        db.session.flush()

        # ── Inventory Items ────────────────────────────────
        inv_map = {}
        inventory_items_data = [
            ('Buffalo Sauce', 'serving', 100),
            ('BBQ Sauce', 'serving', 100),
            ('Garlic Sauce', 'serving', 100),
            ('Parmesan', 'serving', 100),
            ('Honey Mustard Sauce', 'serving', 100),
            ('Lemon Pepper Seasoning', 'serving', 100),
            ('Mango Habanero Sauce', 'serving', 100),
            ('Ranch Dressing', 'serving', 100),
            ('Blue Cheese Dressing', 'serving', 100),
            ('Chicken Wings (raw)', 'portion', 50),
            ('Boneless Chicken', 'portion', 50),
            ('Chicken Tenders (raw)', 'portion', 50),
        ]
        for name, unit, qty in inventory_items_data:
            inv = InventoryItem(name=name, unit=unit, quantity=qty)
            db.session.add(inv)
            inv_map[name] = inv
        db.session.flush()

        # ── Modifier Inventory Rules ───────────────────────
        flavor_inv_map = {
            'Buffalo': [('Buffalo Sauce', 1)],
            'BBQ': [('BBQ Sauce', 1)],
            'Garlic Parmesan': [('Garlic Sauce', 1), ('Parmesan', 1)],
            'Honey Mustard': [('Honey Mustard Sauce', 1)],
            'Lemon Pepper': [('Lemon Pepper Seasoning', 1)],
            'Mango Habanero': [('Mango Habanero Sauce', 1)],
        }
        for flavor in flavors:
            rules = flavor_inv_map.get(flavor.name, [])
            for inv_name, qty in rules:
                rule = ModifierInventoryRule(
                    modifier_id=flavor.id,
                    inventory_item_id=inv_map[inv_name].id,
                    quantity=qty
                )
                db.session.add(rule)

        # ── Menu Items ─────────────────────────────────────
        wings = MenuItem(category_id=cat_wings.id, name='Chicken Wings', price_cents=1200, requires_flavor=True, sort_order=1)
        boneless = MenuItem(category_id=cat_wings.id, name='Boneless Wings', price_cents=1100, requires_flavor=True, sort_order=2)
        tenders = MenuItem(category_id=cat_wings.id, name='Chicken Tenders', price_cents=1150, requires_flavor=True, sort_order=3)

        nachos = MenuItem(category_id=cat_food.id, name='Loaded Nachos', price_cents=950, sort_order=1)
        fries = MenuItem(category_id=cat_food.id, name='Basket of Fries', price_cents=600, sort_order=2)
        burger = MenuItem(category_id=cat_food.id, name='Cheeseburger', price_cents=1100, sort_order=3)

        draft_beer = MenuItem(category_id=cat_beer.id, name='Draft Beer (Pint)', price_cents=600, sort_order=1)
        pitcher = MenuItem(category_id=cat_beer.id, name='Beer Pitcher', price_cents=1500, sort_order=2)
        bottle_beer = MenuItem(category_id=cat_beer.id, name='Bottle Beer', price_cents=500, sort_order=3)

        margarita = MenuItem(category_id=cat_cocktails.id, name='Margarita', price_cents=900, sort_order=1)
        mojito = MenuItem(category_id=cat_cocktails.id, name='Mojito', price_cents=900, sort_order=2)
        whiskey = MenuItem(category_id=cat_cocktails.id, name='Whiskey on the Rocks', price_cents=800, sort_order=3)

        soda = MenuItem(category_id=cat_softs.id, name='Soda', price_cents=300, sort_order=1)
        water = MenuItem(category_id=cat_softs.id, name='Bottled Water', price_cents=200, sort_order=2)

        ranch = MenuItem(category_id=cat_sauces.id, name='Ranch Dressing', price_cents=150, sort_order=1)
        blue_cheese = MenuItem(category_id=cat_sauces.id, name='Blue Cheese Dressing', price_cents=150, sort_order=2)
        extra_sauce = MenuItem(category_id=cat_sauces.id, name='Extra Sauce', price_cents=100, sort_order=3)

        all_items = [
            wings, boneless, tenders,
            nachos, fries, burger,
            draft_beer, pitcher, bottle_beer,
            margarita, mojito, whiskey,
            soda, water,
            ranch, blue_cheese, extra_sauce
        ]
        for item in all_items:
            db.session.add(item)
        db.session.flush()

        # Link flavor modifier group to wing items
        for item in [wings, boneless, tenders]:
            link = MenuItemModifierGroup(menu_item_id=item.id, modifier_group_id=flavor_group.id)
            db.session.add(link)

        db.session.commit()
        print("✅ Seed complete.")
        print("  Default credentials:")
        print("    admin / admin123  (PIN: 1234)")
        print("    manager / manager123  (PIN: 5678)")
        print("    waiter1 / waiter123")
        print("    kitchen / kitchen123")
        print("    barstaff / bar123")


if __name__ == '__main__':
    seed()
