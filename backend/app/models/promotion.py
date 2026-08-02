import json
from datetime import datetime, timezone
import uuid
from app.extensions import db

# Quantity-driven promotion types evaluated across the whole ticket (as opposed
# to HAPPY_HOUR / ITEM_DISCOUNT, which are evaluated per individual line item).
QUANTITY_PROMO_TYPES = ('BOGO', 'QTY_PERCENT_DISCOUNT')


class Promotion(db.Model):
    __tablename__ = 'promotions'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(100), nullable=False)
    # HAPPY_HOUR, ITEM_DISCOUNT, BUNDLE, POOL_TIME_FREE_MINUTES,
    # BOGO, QTY_PERCENT_DISCOUNT
    promo_type = db.Column(db.String(30), nullable=False)
    discount_type = db.Column(db.String(20))  # PERCENTAGE, FLAT_CENTS
    discount_value = db.Column(db.Integer)
    applies_to_item_id = db.Column(db.String(36), db.ForeignKey('menu_items.id'))
    applies_to_category_id = db.Column(db.String(36), db.ForeignKey('menu_categories.id'))
    free_pool_minutes = db.Column(db.Integer)
    happy_hour_start = db.Column(db.String(5))  # 'HH:MM'
    happy_hour_end = db.Column(db.String(5))
    valid_from = db.Column(db.Date)
    valid_to = db.Column(db.Date)
    is_active = db.Column(db.Boolean, default=True)

    # ── Quantity-promotion configuration (BOGO / QTY_PERCENT_DISCOUNT) ────────
    # JSON array of extra eligible menu_item_ids, on top of applies_to_item_id /
    # applies_to_category_id. Stored as text so no association table is needed.
    eligible_item_ids = db.Column(db.Text)
    # Units that must be purchased for one application of the promotion.
    required_quantity = db.Column(db.Integer, default=2)
    # BOGO: how many units become free per application.
    free_quantity = db.Column(db.Integer, default=1)
    # QTY_PERCENT_DISCOUNT: units receiving discount_value % per application.
    discounted_quantity = db.Column(db.Integer, default=1)
    # NULL = unlimited applications per ticket.
    max_applications_per_ticket = db.Column(db.Integer)
    # False = units already discounted by another promotion are skipped.
    is_stackable = db.Column(db.Boolean, default=False)
    # False = the required quantity must be reached by a single menu item, so
    # mixed products never trigger the promotion. True = all eligible items
    # count together toward the required quantity.
    combine_across_items = db.Column(db.Boolean, default=False)
    # Lower runs first; gives deterministic ordering when promos compete.
    priority = db.Column(db.Integer, default=0)
    # When True the promotion is never applied automatically: the waiter is
    # shown it on the ticket and must confirm it. Defaults to False so every
    # pre-existing promotion keeps applying automatically.
    requires_confirmation = db.Column(db.Boolean, default=False)

    def eligible_item_id_list(self) -> list:
        """Parse eligible_item_ids (JSON array) defensively; never raises."""
        if not self.eligible_item_ids:
            return []
        try:
            parsed = json.loads(self.eligible_item_ids)
        except (ValueError, TypeError):
            return []
        return [str(i) for i in parsed] if isinstance(parsed, list) else []

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'promo_type': self.promo_type,
            'discount_type': self.discount_type,
            'discount_value': self.discount_value,
            'applies_to_item_id': self.applies_to_item_id,
            'applies_to_category_id': self.applies_to_category_id,
            'free_pool_minutes': self.free_pool_minutes,
            'happy_hour_start': self.happy_hour_start,
            'happy_hour_end': self.happy_hour_end,
            'valid_from': str(self.valid_from) if self.valid_from else None,
            'valid_to': str(self.valid_to) if self.valid_to else None,
            'is_active': self.is_active,
            'eligible_item_ids': self.eligible_item_id_list(),
            'required_quantity': self.required_quantity,
            'free_quantity': self.free_quantity,
            'discounted_quantity': self.discounted_quantity,
            'max_applications_per_ticket': self.max_applications_per_ticket,
            'is_stackable': bool(self.is_stackable),
            'combine_across_items': bool(self.combine_across_items),
            'priority': self.priority or 0,
            'requires_confirmation': bool(self.requires_confirmation),
        }


class TicketPromoDecision(db.Model):
    """Waiter's answer for a promotion that requires confirmation.

    One row per (ticket, promotion). Absent means "not asked yet", so the
    promotion shows up as available on the ticket; ACCEPTED makes the engine
    apply it, DECLINED keeps it suppressed without re-prompting.
    """
    __tablename__ = 'ticket_promo_decisions'
    __table_args__ = (
        db.UniqueConstraint('ticket_id', 'promotion_id', name='uq_ticket_promo_decision'),
    )

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id = db.Column(db.String(36), db.ForeignKey('tickets.id'), nullable=False, index=True)
    promotion_id = db.Column(db.String(36), db.ForeignKey('promotions.id'), nullable=False)
    decision = db.Column(db.String(10), nullable=False)   # ACCEPTED, DECLINED
    decided_by = db.Column(db.String(36), db.ForeignKey('users.id'))
    decided_at = db.Column(db.DateTime(timezone=True),
                           default=lambda: datetime.now(timezone.utc))

    promotion = db.relationship('Promotion')

    def to_dict(self):
        return {
            'promotion_id': self.promotion_id,
            'decision': self.decision,
            'decided_by': self.decided_by,
            'decided_at': self.decided_at.isoformat() if self.decided_at else None,
        }
