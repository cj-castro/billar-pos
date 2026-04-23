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
    # STANDARD | BOTTLE | CIG_BOX | CIG_SINGLE
    item_type = db.Column(db.String(20), default='STANDARD', nullable=False)

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
            'item_type': self.item_type,
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


class OpenCigaretteBox(db.Model):
    __tablename__ = 'open_cigarette_boxes'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    box_item_id = db.Column(db.String(36), db.ForeignKey('inventory_items.id'), nullable=False)
    brand = db.Column(db.String(100), nullable=False)
    cigs_per_box = db.Column(db.Integer, nullable=False, default=20)
    cigs_sold = db.Column(db.Integer, nullable=False, default=0)
    opened_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    opened_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    is_finished = db.Column(db.Boolean, default=False, nullable=False)
    finished_at = db.Column(db.DateTime(timezone=True), nullable=True)

    box_item = db.relationship('InventoryItem', foreign_keys=[box_item_id])

    def to_dict(self):
        from app.models.user import User
        opener = User.query.get(self.opened_by) if self.opened_by else None
        return {
            'id': self.id,
            'box_item_id': self.box_item_id,
            'brand': self.brand,
            'cigs_per_box': self.cigs_per_box,
            'cigs_sold': self.cigs_sold,
            'cigs_remaining': self.cigs_per_box - self.cigs_sold,
            'opened_at': self.opened_at.isoformat() if self.opened_at else None,
            'opened_by': opener.name if opener else None,
            'is_finished': self.is_finished,
            'finished_at': self.finished_at.isoformat() if self.finished_at else None,
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
