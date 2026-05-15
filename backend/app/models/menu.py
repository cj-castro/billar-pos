import uuid
from app.extensions import db

class MenuCategory(db.Model):
    __tablename__ = 'menu_categories'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(100), nullable=False)
    routing = db.Column(db.String(10), nullable=False)  # KITCHEN, BAR
    sort_order = db.Column(db.Integer, default=0)
    items = db.relationship('MenuItem', backref='category', lazy='dynamic')

    def to_dict(self):
        return {'id': self.id, 'name': self.name, 'routing': self.routing, 'sort_order': self.sort_order}


class MenuItem(db.Model):
    __tablename__ = 'menu_items'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    category_id = db.Column(db.String(36), db.ForeignKey('menu_categories.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    price_cents = db.Column(db.Integer, nullable=False)
    requires_flavor = db.Column(db.Boolean, default=False)
    is_active = db.Column(db.Boolean, default=True)
    sort_order = db.Column(db.Integer, default=0)

    modifier_groups = db.relationship('ModifierGroup', secondary='menu_item_modifier_groups', backref='items')
    ingredients = db.relationship('MenuItemIngredient', backref='menu_item', lazy='dynamic',
                                  foreign_keys='MenuItemIngredient.menu_item_id')

    def to_dict(self, with_modifiers=False):
        d = {
            'id': self.id,
            'category_id': self.category_id,
            'name': self.name,
            'price_cents': self.price_cents,
            'requires_flavor': self.requires_flavor,
            'is_active': self.is_active,
            'sort_order': self.sort_order,
            'routing': self.category.routing if self.category else None,
            'ingredient_count': self.ingredients.count(),
        }
        if with_modifiers:
            d['modifier_groups'] = [mg.to_dict() for mg in self.modifier_groups]
        return d


class ModifierGroup(db.Model):
    __tablename__ = 'modifier_groups'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(100), nullable=False)
    is_mandatory = db.Column(db.Boolean, default=True)
    min_selections = db.Column(db.Integer, default=1)
    max_selections = db.Column(db.Integer, default=1)
    # When True, the same modifier can be selected multiple times (e.g., beer bucket picks)
    allow_multiple = db.Column(db.Boolean, default=False)
    # When True, inventory rule qty is divided by the number of distinct modifiers selected
    # from this group (e.g., 2 wing flavors each get half the sauce portion)
    split_modifier_qty = db.Column(db.Boolean, default=False)
    modifiers = db.relationship('Modifier', backref='group', lazy='dynamic')

    def to_dict(self, include_inactive=False):
        mods = self.modifiers.all() if include_inactive else self.modifiers.filter_by(is_active=True).all()
        return {
            'id': self.id,
            'name': self.name,
            'is_mandatory': self.is_mandatory,
            'min_selections': self.min_selections,
            'max_selections': self.max_selections,
            'allow_multiple': self.allow_multiple,
            'split_modifier_qty': self.split_modifier_qty,
            'modifiers': [m.to_dict() for m in mods]
        }


class MenuItemModifierGroup(db.Model):
    __tablename__ = 'menu_item_modifier_groups'

    menu_item_id = db.Column(db.String(36), db.ForeignKey('menu_items.id'), primary_key=True)
    modifier_group_id = db.Column(db.String(36), db.ForeignKey('modifier_groups.id'), primary_key=True)


class Modifier(db.Model):
    __tablename__ = 'modifiers'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    modifier_group_id = db.Column(db.String(36), db.ForeignKey('modifier_groups.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    price_cents = db.Column(db.Integer, default=0)
    is_active = db.Column(db.Boolean, default=True)

    inventory_rules = db.relationship('ModifierInventoryRule', backref='modifier', lazy='dynamic')

    def to_dict(self):
        rules = [
            {'inventory_item_id': r.inventory_item_id,
             'inventory_item_name': r.inventory_item.name if r.inventory_item else None,
             'inventory_item_unit': r.inventory_item.base_unit_key if r.inventory_item else None,
             'quantity': r.quantity}
            for r in self.inventory_rules.all()
        ]
        return {
            'id': self.id,
            'name': self.name,
            'price_cents': self.price_cents,
            'modifier_group_id': self.modifier_group_id,
            'is_active': self.is_active,
            'inventory_rules': rules
        }
