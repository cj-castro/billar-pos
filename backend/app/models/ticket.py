import uuid
from datetime import datetime, timezone
from app.extensions import db

class Ticket(db.Model):
    __tablename__ = 'tickets'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    resource_id = db.Column(db.String(36), db.ForeignKey('resources.id'))
    status = db.Column(db.String(10), default='OPEN')  # OPEN, CLOSED, VOID
    customer_name = db.Column(db.String(200))           # party/guest name
    opened_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    opened_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    closed_by = db.Column(db.String(36), db.ForeignKey('users.id'))
    closed_at = db.Column(db.DateTime(timezone=True))
    payment_type = db.Column(db.String(10))  # CASH, CARD
    tendered_cents = db.Column(db.Integer)
    tip_cents = db.Column(db.Integer, default=0)
    tip_source = db.Column(db.String(10))           # CASH, CARD, SPLIT
    tip_cash_cents = db.Column(db.Integer)          # explicit cash portion (when SPLIT)
    tip_card_cents = db.Column(db.Integer)          # explicit card portion (when SPLIT)
    payment_type_2 = db.Column(db.String(10))   # optional second payment method
    tendered_cents_2 = db.Column(db.Integer)
    manual_discount_pct = db.Column(db.Integer, default=0)   # 0–100 manual % discount
    was_reopened = db.Column(db.Boolean, default=False)
    reopened_at = db.Column(db.DateTime(timezone=True))
    reopened_by = db.Column(db.String(36), db.ForeignKey('users.id'))
    payment_requested = db.Column(db.Boolean, default=False)
    payment_requested_at = db.Column(db.DateTime(timezone=True))
    subtotal_cents = db.Column(db.Integer, default=0)
    discount_cents = db.Column(db.Integer, default=0)
    pool_time_cents = db.Column(db.Integer, default=0)
    total_cents = db.Column(db.Integer, default=0)
    version = db.Column(db.Integer, default=1)
    notes = db.Column(db.Text)

    opener = db.relationship('User', foreign_keys=[opened_by])
    closer = db.relationship('User', foreign_keys=[closed_by])
    line_items = db.relationship('TicketLineItem', backref='ticket', lazy='dynamic', cascade='all,delete-orphan')
    timer_sessions = db.relationship('PoolTimerSession', backref='ticket', lazy='dynamic', cascade='all,delete-orphan')
    applied_promos = db.relationship('LineItemPromotion', backref='ticket_ref', lazy='dynamic')

    def recalculate_totals(self):
        items = self.line_items.filter(TicketLineItem.status != 'VOIDED').all()
        self.subtotal_cents = sum(i.quantity * i.unit_price_cents for i in items)
        mod_total = sum(
            lim.price_cents
            for i in items
            for lim in i.modifiers
        )
        self.subtotal_cents += mod_total

        discounts = sum(p.discount_cents for p in self.applied_promos.all())
        manual = round(self.subtotal_cents * (self.manual_discount_pct or 0) / 100)
        self.discount_cents = discounts + manual

        pool_total = sum(
            (s.charge_cents or 0)
            for s in self.timer_sessions.all()
            if s.charge_cents is not None
        )
        self.pool_time_cents = pool_total

        self.total_cents = max(0, self.subtotal_cents - self.discount_cents + self.pool_time_cents)

    def to_dict(self, include_items=True, include_timer=True):
        d = {
            'id': self.id,
            'resource_id': self.resource_id,
            'resource_code': self.resource.code if self.resource else None,
            'status': self.status,
            'opened_by': self.opened_by,
            'opened_at': self.opened_at.isoformat() if self.opened_at else None,
            'closed_at': self.closed_at.isoformat() if self.closed_at else None,
            'payment_type': self.payment_type,
            'tendered_cents': self.tendered_cents,
            'tip_cents': self.tip_cents or 0,
            'tip_source': self.tip_source,
            'tip_cash_cents': self.tip_cash_cents,
            'tip_card_cents': self.tip_card_cents,
            'payment_type_2': self.payment_type_2,
            'tendered_cents_2': self.tendered_cents_2,
            'manual_discount_pct': self.manual_discount_pct or 0,
            'was_reopened': self.was_reopened or False,
            'reopened_at': self.reopened_at.isoformat() if self.reopened_at else None,
            'payment_requested': self.payment_requested or False,
            'payment_requested_at': self.payment_requested_at.isoformat() if self.payment_requested_at else None,
            'subtotal_cents': self.subtotal_cents,
            'discount_cents': self.discount_cents,
            'pool_time_cents': self.pool_time_cents,
            'total_cents': self.total_cents,
            'version': self.version,
            'notes': self.notes,
            'customer_name': self.customer_name,
        }
        if include_items:
            d['line_items'] = [i.to_dict() for i in self.line_items.all()]
        if include_timer:
            d['timer_sessions'] = [s.to_dict() for s in self.timer_sessions.all()]
        # Include linked waiting list entry if any (floor ticket OR assigned pool ticket)
        from app.models.waiting_list import WaitingListEntry
        from sqlalchemy import or_
        wl = WaitingListEntry.query.filter(
            or_(
                WaitingListEntry.assigned_ticket_id == self.id,
                WaitingListEntry.floor_ticket_id == self.id,
            ),
            WaitingListEntry.status.in_(['WAITING', 'SEATED'])
        ).first()
        d['waiting_list_entry'] = {
            'id': wl.id, 'party_name': wl.party_name, 'party_size': wl.party_size,
            'position': wl.position,
        } if wl else None
        return d


class TicketLineItem(db.Model):
    __tablename__ = 'ticket_line_items'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id = db.Column(db.String(36), db.ForeignKey('tickets.id'), nullable=False)
    menu_item_id = db.Column(db.String(36), db.ForeignKey('menu_items.id'), nullable=True)
    item_name = db.Column(db.String(100))
    quantity = db.Column(db.Integer, nullable=False, default=1)
    unit_price_cents = db.Column(db.Integer, nullable=False)
    status = db.Column(db.String(15), default='STAGED')
    routing_dest = db.Column(db.String(10), nullable=False)
    sent_at = db.Column(db.DateTime(timezone=True))
    served_at = db.Column(db.DateTime(timezone=True))
    voided_at = db.Column(db.DateTime(timezone=True))
    voided_by = db.Column(db.String(36), db.ForeignKey('users.id'))
    void_reason = db.Column(db.Text)
    notes = db.Column(db.Text)
    sort_order = db.Column(db.Integer, default=0)

    menu_item = db.relationship('MenuItem')
    modifiers = db.relationship('LineItemModifier', backref='line_item', cascade='all,delete-orphan')
    promos = db.relationship('LineItemPromotion', backref='line_item_ref', lazy='dynamic')

    def to_dict(self):
        return {
            'id': self.id,
            'ticket_id': self.ticket_id,
            'menu_item_id': self.menu_item_id,
            'menu_item_name': self.menu_item.name if self.menu_item else self.item_name,
            'quantity': self.quantity,
            'unit_price_cents': self.unit_price_cents,
            'status': self.status,
            'routing_dest': self.routing_dest,
            'sent_at': self.sent_at.isoformat() if self.sent_at else None,
            'served_at': self.served_at.isoformat() if self.served_at else None,
            'voided_at': self.voided_at.isoformat() if self.voided_at else None,
            'void_reason': self.void_reason,
            'notes': self.notes,
            'modifiers': [m.to_dict() for m in self.modifiers]
        }


class LineItemModifier(db.Model):
    __tablename__ = 'line_item_modifiers'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    line_item_id = db.Column(db.String(36), db.ForeignKey('ticket_line_items.id'), nullable=False)
    modifier_id = db.Column(db.String(36), db.ForeignKey('modifiers.id'), nullable=False)
    name_snapshot = db.Column(db.String(100), nullable=False)
    price_cents = db.Column(db.Integer, default=0)

    modifier = db.relationship('Modifier')

    def to_dict(self):
        return {
            'id': self.id,
            'modifier_id': self.modifier_id,
            'name': self.name_snapshot,
            'price_cents': self.price_cents
        }


class LineItemPromotion(db.Model):
    __tablename__ = 'line_item_promotions'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    line_item_id = db.Column(db.String(36), db.ForeignKey('ticket_line_items.id'))
    ticket_id = db.Column(db.String(36), db.ForeignKey('tickets.id'))
    promotion_id = db.Column(db.String(36), db.ForeignKey('promotions.id'), nullable=False)
    discount_cents = db.Column(db.Integer, nullable=False)
    applied_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    promotion = db.relationship('Promotion')


class PoolTimerSession(db.Model):
    __tablename__ = 'pool_timer_sessions'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id = db.Column(db.String(36), db.ForeignKey('tickets.id'), nullable=False)
    resource_id = db.Column(db.String(36), db.ForeignKey('resources.id'), nullable=False)
    start_time = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    end_time = db.Column(db.DateTime(timezone=True))
    duration_seconds = db.Column(db.Integer)
    billing_mode = db.Column(db.String(20), nullable=False)
    rate_cents = db.Column(db.Integer, nullable=False)
    promo_free_seconds = db.Column(db.Integer, default=0)
    charge_cents = db.Column(db.Integer)
    is_manual_edit = db.Column(db.Boolean, default=False)
    manual_edit_reason = db.Column(db.Text)

    resource = db.relationship('Resource')

    def to_dict(self):
        return {
            'id': self.id,
            'ticket_id': self.ticket_id,
            'resource_id': self.resource_id,
            'resource_code': self.resource.code if self.resource else None,
            'start_time': self.start_time.isoformat() if self.start_time else None,
            'end_time': self.end_time.isoformat() if self.end_time else None,
            'duration_seconds': self.duration_seconds,
            'billing_mode': self.billing_mode,
            'rate_cents': self.rate_cents,
            'promo_free_seconds': self.promo_free_seconds,
            'charge_cents': self.charge_cents,
            'is_manual_edit': self.is_manual_edit
        }
