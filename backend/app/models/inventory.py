import uuid
from datetime import datetime, timezone
from app.extensions import db

class InventoryItem(db.Model):
    __tablename__ = 'inventory_items'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(100), unique=True, nullable=False)
    unit = db.Column(db.String(50), nullable=False, default='serving')
    quantity = db.Column(db.Integer, nullable=False, default=0)
    low_stock_threshold = db.Column(db.Integer, default=10)
    cost_cents = db.Column(db.Integer, default=0)
    # Category: beer | spirit | mixer | food | other
    category = db.Column(db.String(50), default='other')
    # For spirit bottles: how many shots per bottle and which shot item to yield
    shots_per_bottle = db.Column(db.Integer, nullable=True)
    yields_item_id = db.Column(db.String(36), db.ForeignKey('inventory_items.id'), nullable=True)

    movements = db.relationship('StockMovement', backref='item', lazy='dynamic')
    yields_item = db.relationship('InventoryItem', foreign_keys=[yields_item_id], remote_side='InventoryItem.id')

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'unit': self.unit,
            'quantity': self.quantity,
            'low_stock_threshold': self.low_stock_threshold,
            'cost_cents': self.cost_cents,
            'category': self.category,
            'shots_per_bottle': self.shots_per_bottle,
            'yields_item_id': self.yields_item_id,
            'is_low': self.quantity <= self.low_stock_threshold
        }


class ModifierInventoryRule(db.Model):
    __tablename__ = 'modifier_inventory_rules'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    modifier_id = db.Column(db.String(36), db.ForeignKey('modifiers.id'), nullable=False)
    inventory_item_id = db.Column(db.String(36), db.ForeignKey('inventory_items.id'), nullable=False)
    quantity = db.Column(db.Integer, nullable=False, default=1)

    inventory_item = db.relationship('InventoryItem')


class MenuItemIngredient(db.Model):
    """Recipe: links a menu item directly to inventory items it consumes."""
    __tablename__ = 'menu_item_ingredients'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    menu_item_id = db.Column(db.String(36), db.ForeignKey('menu_items.id'), nullable=False)
    inventory_item_id = db.Column(db.String(36), db.ForeignKey('inventory_items.id'), nullable=False)
    quantity = db.Column(db.Integer, nullable=False, default=1)

    inventory_item = db.relationship('InventoryItem')

    def to_dict(self):
        return {
            'id': self.id,
            'menu_item_id': self.menu_item_id,
            'inventory_item_id': self.inventory_item_id,
            'inventory_item_name': self.inventory_item.name if self.inventory_item else None,
            'inventory_item_unit': self.inventory_item.unit if self.inventory_item else None,
            'quantity': self.quantity,
        }


class StockMovement(db.Model):
    __tablename__ = 'stock_movements'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    inventory_item_id = db.Column(db.String(36), db.ForeignKey('inventory_items.id'), nullable=False)
    event_type = db.Column(db.String(30), nullable=False)  # SALE_CONSUMPTION, VOID_REVERSAL, MANUAL_ADJUSTMENT, OPENING_STOCK
    quantity_delta = db.Column(db.Integer, nullable=False)
    reference_id = db.Column(db.String(36))
    reason = db.Column(db.Text)
    performed_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    performer = db.relationship('User')

    def to_dict(self):
        return {
            'id': self.id,
            'inventory_item_id': self.inventory_item_id,
            'event_type': self.event_type,
            'quantity_delta': self.quantity_delta,
            'reference_id': self.reference_id,
            'reason': self.reason,
            'performed_by': self.performed_by,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }
