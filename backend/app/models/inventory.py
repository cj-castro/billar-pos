"""Inventory models for billar-pos inventory v2.

Schema changes from v1:
- UnitCatalog: new bilingual unit catalog table
- InventoryItem: quantity→stock_quantity (Numeric), cost_cents→unit_cost_cents,
  base_unit_key (FK), purchase_unit_key, purchase_pack_size, sku, supplier, is_active
- InventoryMovement: replaces StockMovement; quantity_delta Numeric; adds quantity_after,
  purchase fields, unit_cost_cents snapshot
- InsumoBase: replaces MenuItemIngredient; quantity Numeric, deduction_unit_key
- SaleItemCost: new COGS capture table written at sale time (not ticket close)
- ModifierInventoryRule: quantity Numeric
- MenuItemIngredient: kept for backward compat with seed commands; deprecated
"""
import uuid
from decimal import Decimal
from datetime import datetime, timezone
from app.extensions import db


# ── Unit Catalog ──────────────────────────────────────────────────────────────

class UnitCatalog(db.Model):
    """Bilingual measurement unit catalog.

    key is the canonical internal identifier (e.g. 'botella', 'ml').
    Frontend resolves display name via name_es or name_en based on current lang.
    Rows are never deleted; inactive rows are hidden from dropdowns.
    """
    __tablename__ = 'unit_catalog'

    key     = db.Column(db.String(50), primary_key=True)
    name_es = db.Column(db.String(100), nullable=False)
    name_en = db.Column(db.String(100), nullable=False)
    active  = db.Column(db.Boolean, nullable=False, default=True)

    def to_dict(self):
        return {
            'key':     self.key,
            'name_es': self.name_es,
            'name_en': self.name_en,
            'active':  self.active,
        }


# ── Inventory Item ────────────────────────────────────────────────────────────

class InventoryItem(db.Model):
    """A single tracked inventory item.

    stock_quantity is always expressed in base_unit_key units (e.g. ml, botella).
    unit_cost_cents is the weighted average cost per one base unit, in centavos.
    purchase_pack_size converts purchase units to base units:
      - Bohemia: base_unit='botella', purchase_unit='caja', pack_size=12 → 1 caja = 12 botellas
      - Clamato: base_unit='ml', purchase_unit='botella', pack_size=1000 → 1 botella = 1000 ml
    WAC is recalculated on every restock; not directly editable after initial creation.
    """
    __tablename__ = 'inventory_items'

    id                  = db.Column(db.String(36), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    name                = db.Column(db.String(100), unique=True, nullable=False)
    sku                 = db.Column(db.String(100), unique=True)
    supplier            = db.Column(db.String(150))
    category            = db.Column(db.String(50), nullable=False, default='other')
    item_type           = db.Column(db.String(20), nullable=False, default='STANDARD')

    base_unit_key       = db.Column(db.String(50),
                                    db.ForeignKey('unit_catalog.key', ondelete='RESTRICT'),
                                    nullable=False)
    stock_quantity      = db.Column(db.Numeric(12, 4), nullable=False, default=0)
    low_stock_threshold = db.Column(db.Numeric(12, 4), nullable=False, default=0)
    unit_cost_cents     = db.Column(db.Integer, nullable=False, default=0)

    purchase_unit_key   = db.Column(db.String(50),
                                    db.ForeignKey('unit_catalog.key', ondelete='RESTRICT'))
    purchase_pack_size  = db.Column(db.Numeric(12, 4), nullable=False, default=1)

    # For BOTTLE items: shots per bottle. For CIG_BOX: cigs per box.
    shots_per_bottle    = db.Column(db.Integer)
    yields_item_id      = db.Column(db.String(36),
                                    db.ForeignKey('inventory_items.id', ondelete='SET NULL'))

    is_active           = db.Column(db.Boolean, nullable=False, default=True)
    created_at          = db.Column(db.DateTime(timezone=True),
                                    default=lambda: datetime.now(timezone.utc))
    updated_at          = db.Column(db.DateTime(timezone=True),
                                    default=lambda: datetime.now(timezone.utc))

    movements     = db.relationship('InventoryMovement', backref='item', lazy='dynamic')
    yields_item   = db.relationship('InventoryItem', foreign_keys=[yields_item_id],
                                    remote_side='InventoryItem.id')
    base_unit     = db.relationship('UnitCatalog', foreign_keys=[base_unit_key])
    purchase_unit = db.relationship('UnitCatalog', foreign_keys=[purchase_unit_key])

    def to_dict(self):
        qty = float(self.stock_quantity) if self.stock_quantity is not None else 0
        thr = float(self.low_stock_threshold) if self.low_stock_threshold is not None else 0
        return {
            'id':                  self.id,
            'name':                self.name,
            'sku':                 self.sku,
            'supplier':            self.supplier,
            'category':            self.category,
            'item_type':           self.item_type,
            'base_unit_key':       self.base_unit_key,
            'stock_quantity':      qty,
            'low_stock_threshold': thr,
            'unit_cost_cents':     self.unit_cost_cents,
            'purchase_unit_key':   self.purchase_unit_key,
            'purchase_pack_size':  float(self.purchase_pack_size),
            'shots_per_bottle':    self.shots_per_bottle,
            'yields_item_id':      self.yields_item_id,
            'is_active':           self.is_active,
            'is_low':              qty <= thr,
        }


# ── Inventory Movement Ledger ─────────────────────────────────────────────────

class InventoryMovement(db.Model):
    """Immutable ledger entry for every inventory stock change.

    quantity_delta: signed Numeric; negative = outflow (SALE_DEDUCTION, WASTE, etc.)
    quantity_after: denormalized snapshot of stock_quantity after this movement.
                    NULL for rows migrated from the old stock_movements table.
    purchase_* fields are populated only for RESTOCK events.
    reference_id polymorphically points to ticket_line_items.id for SALE/VOID events.
    """
    __tablename__ = 'inventory_movements'

    id                  = db.Column(db.String(36), primary_key=True,
                                    default=lambda: str(uuid.uuid4()))
    inventory_item_id   = db.Column(db.String(36),
                                    db.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                                    nullable=False)
    event_type          = db.Column(db.String(30), nullable=False)
    quantity_delta      = db.Column(db.Numeric(12, 4), nullable=False)
    quantity_after      = db.Column(db.Numeric(12, 4))          # NULL for pre-migration rows
    unit_cost_cents     = db.Column(db.Integer)                 # WAC snapshot
    purchase_quantity   = db.Column(db.Numeric(12, 4))          # RESTOCK: purchase units
    purchase_unit_key   = db.Column(db.String(50),
                                    db.ForeignKey('unit_catalog.key', ondelete='RESTRICT'))
    purchase_cost_cents = db.Column(db.Integer)                 # RESTOCK: cost/purchase unit
    reference_id        = db.Column(db.String(36))              # no FK: polymorphic
    reason              = db.Column(db.Text)
    performed_by        = db.Column(db.String(36),
                                    db.ForeignKey('users.id', ondelete='RESTRICT'),
                                    nullable=False)
    created_at          = db.Column(db.DateTime(timezone=True),
                                    default=lambda: datetime.now(timezone.utc))

    performer = db.relationship('User')

    def to_dict(self):
        return {
            'id':                  self.id,
            'inventory_item_id':   self.inventory_item_id,
            'event_type':          self.event_type,
            'quantity_delta':      float(self.quantity_delta),
            'quantity_after':      float(self.quantity_after) if self.quantity_after is not None else None,
            'unit_cost_cents':     self.unit_cost_cents,
            'purchase_quantity':   float(self.purchase_quantity) if self.purchase_quantity else None,
            'purchase_unit_key':   self.purchase_unit_key,
            'purchase_cost_cents': self.purchase_cost_cents,
            'reference_id':        self.reference_id,
            'reason':              self.reason,
            'performed_by':        self.performed_by,
            'created_at':          self.created_at.isoformat() if self.created_at else None,
        }


# Alias so existing imports of StockMovement continue to work without change.
StockMovement = InventoryMovement


# ── Insumos Base ──────────────────────────────────────────────────────────────

class InsumoBase(db.Model):
    """Recipe link: menu item → inventory item with deduction quantity per sale.

    Replaces MenuItemIngredient for all new code paths.
    quantity and deduction_unit_key define how much stock to deduct per unit sold.
    Typically deduction_unit_key matches inventory_item.base_unit_key.
    DB-level UNIQUE constraint prevents duplicate links and eliminates concurrent-insert races.
    """
    __tablename__ = 'insumos_base'

    id                 = db.Column(db.String(36), primary_key=True,
                                   default=lambda: str(uuid.uuid4()))
    menu_item_id       = db.Column(db.String(36),
                                   db.ForeignKey('menu_items.id', ondelete='CASCADE'),
                                   nullable=False)
    inventory_item_id  = db.Column(db.String(36),
                                   db.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                                   nullable=False)
    quantity           = db.Column(db.Numeric(12, 4), nullable=False, default=1)
    deduction_unit_key = db.Column(db.String(50),
                                   db.ForeignKey('unit_catalog.key', ondelete='RESTRICT'),
                                   nullable=False)
    notes              = db.Column(db.Text)
    created_at         = db.Column(db.DateTime(timezone=True),
                                   default=lambda: datetime.now(timezone.utc))

    inventory_item = db.relationship('InventoryItem')
    deduction_unit = db.relationship('UnitCatalog')

    __table_args__ = (
        db.UniqueConstraint('menu_item_id', 'inventory_item_id',
                            name='uq_insumos_base_link'),
    )

    def to_dict(self):
        return {
            'id':                  self.id,
            'menu_item_id':        self.menu_item_id,
            'inventory_item_id':   self.inventory_item_id,
            'inventory_item_name': self.inventory_item.name if self.inventory_item else None,
            'stock_quantity':      float(self.inventory_item.stock_quantity) if self.inventory_item else None,
            'quantity':            float(self.quantity),
            'deduction_unit_key':  self.deduction_unit_key,
            'notes':               self.notes,
        }


# ── Legacy Menu Item Ingredient (backward compat) ─────────────────────────────

class MenuItemIngredient(db.Model):
    """Legacy recipe link superseded by InsumoBase.

    Kept so existing seed commands (seed-beer, seed-buckets) continue to work.
    Data is migrated to insumos_base on startup; new application code uses InsumoBase.
    This table will be dropped in migration R010 after deployment is verified.
    """
    __tablename__ = 'menu_item_ingredients'

    id                = db.Column(db.String(36), primary_key=True,
                                  default=lambda: str(uuid.uuid4()))
    menu_item_id      = db.Column(db.String(36),
                                  db.ForeignKey('menu_items.id'), nullable=False)
    inventory_item_id = db.Column(db.String(36),
                                  db.ForeignKey('inventory_items.id'), nullable=False)
    quantity          = db.Column(db.Numeric(12, 4), nullable=False, default=1)

    inventory_item = db.relationship('InventoryItem')

    def to_dict(self):
        return {
            'id':                  self.id,
            'menu_item_id':        self.menu_item_id,
            'inventory_item_id':   self.inventory_item_id,
            'inventory_item_name': self.inventory_item.name if self.inventory_item else None,
            'inventory_item_unit': self.inventory_item.base_unit_key if self.inventory_item else None,
            'quantity':            float(self.quantity),
        }


# ── Modifier Inventory Rule ───────────────────────────────────────────────────

class ModifierInventoryRule(db.Model):
    """Deducts inventory when a specific modifier is selected on a line item."""
    __tablename__ = 'modifier_inventory_rules'

    id                = db.Column(db.String(36), primary_key=True,
                                  default=lambda: str(uuid.uuid4()))
    modifier_id       = db.Column(db.String(36),
                                  db.ForeignKey('modifiers.id'), nullable=False)
    inventory_item_id = db.Column(db.String(36),
                                  db.ForeignKey('inventory_items.id'), nullable=False)
    quantity          = db.Column(db.Numeric(12, 4), nullable=False, default=1)

    inventory_item = db.relationship('InventoryItem')


# ── Sale Item Cost (COGS Capture) ─────────────────────────────────────────────

class SaleItemCost(db.Model):
    """COGS record written at the moment inventory is deducted (when item is SENT).

    One row per ingredient deduction per line item (multiple rows per line item
    when several inventory items are consumed).
    unit_cost_cents is the WAC snapshot at deduction time — not at ticket close.
    total_cost_cents = ROUND(quantity_deducted × unit_cost_cents), stored explicitly.
    inventory_movement_id: UNIQUE — enforces 1:1 between movement and cost record.
    """
    __tablename__ = 'sale_item_costs'

    id                    = db.Column(db.String(36), primary_key=True,
                                      default=lambda: str(uuid.uuid4()))
    ticket_line_item_id   = db.Column(db.String(36),
                                      db.ForeignKey('ticket_line_items.id', ondelete='RESTRICT'),
                                      nullable=False)
    inventory_item_id     = db.Column(db.String(36),
                                      db.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                                      nullable=False)
    inventory_movement_id = db.Column(db.String(36),
                                      db.ForeignKey('inventory_movements.id', ondelete='SET NULL'),
                                      unique=True)
    insumos_base_id       = db.Column(db.String(36),
                                      db.ForeignKey('insumos_base.id', ondelete='SET NULL'))

    quantity_deducted = db.Column(db.Numeric(12, 4), nullable=False)
    unit_cost_cents   = db.Column(db.Integer, nullable=False)
    total_cost_cents  = db.Column(db.Integer, nullable=False)
    recorded_at       = db.Column(db.DateTime(timezone=True),
                                  default=lambda: datetime.now(timezone.utc))

    def to_dict(self):
        return {
            'id':                    self.id,
            'ticket_line_item_id':   self.ticket_line_item_id,
            'inventory_item_id':     self.inventory_item_id,
            'inventory_movement_id': self.inventory_movement_id,
            'insumos_base_id':       self.insumos_base_id,
            'quantity_deducted':     float(self.quantity_deducted),
            'unit_cost_cents':       self.unit_cost_cents,
            'total_cost_cents':      self.total_cost_cents,
            'recorded_at':           self.recorded_at.isoformat() if self.recorded_at else None,
        }


# ── Open Cigarette Box Tracking (unchanged from v1) ──────────────────────────

class OpenCigaretteBox(db.Model):
    __tablename__ = 'open_cigarette_boxes'

    id           = db.Column(db.String(36), primary_key=True,
                             default=lambda: str(uuid.uuid4()))
    box_item_id  = db.Column(db.String(36),
                             db.ForeignKey('inventory_items.id'), nullable=False)
    brand        = db.Column(db.String(100), nullable=False)
    cigs_per_box = db.Column(db.Integer, nullable=False, default=20)
    cigs_sold    = db.Column(db.Integer, nullable=False, default=0)
    opened_at    = db.Column(db.DateTime(timezone=True),
                             default=lambda: datetime.now(timezone.utc))
    opened_by    = db.Column(db.String(36), db.ForeignKey('users.id'))
    is_finished  = db.Column(db.Boolean, default=False, nullable=False)
    finished_at  = db.Column(db.DateTime(timezone=True))

    box_item = db.relationship('InventoryItem', foreign_keys=[box_item_id])

    def to_dict(self):
        from app.models.user import User
        opener = User.query.get(self.opened_by) if self.opened_by else None
        return {
            'id':             self.id,
            'box_item_id':    self.box_item_id,
            'brand':          self.brand,
            'cigs_per_box':   self.cigs_per_box,
            'cigs_sold':      self.cigs_sold,
            'cigs_remaining': self.cigs_per_box - self.cigs_sold,
            'opened_at':      self.opened_at.isoformat() if self.opened_at else None,
            'opened_by':      opener.name if opener else None,
            'is_finished':    self.is_finished,
            'finished_at':    self.finished_at.isoformat() if self.finished_at else None,
        }
