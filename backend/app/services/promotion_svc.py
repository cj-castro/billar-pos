from datetime import datetime, timezone, time as dtime
from app.models.promotion import Promotion
from app.models.ticket import LineItemPromotion
from app.extensions import db


def _parse_time(t_str: str) -> dtime:
    h, m = t_str.split(':')
    return dtime(int(h), int(m))


def apply_promos_to_line_item(line_item, ticket, now: datetime = None):
    """Apply all eligible promotions to a staged line item."""
    if now is None:
        now = datetime.now(timezone.utc)

    promos = Promotion.query.filter_by(is_active=True).all()
    for promo in promos:
        discount = _evaluate_promo(promo, line_item, now)
        if discount and discount > 0:
            lip = LineItemPromotion(
                line_item_id=line_item.id,
                ticket_id=ticket.id,
                promotion_id=promo.id,
                discount_cents=discount
            )
            db.session.add(lip)


def _evaluate_promo(promo, line_item, now: datetime) -> int:
    today = now.date()

    # Date range check
    if promo.valid_from and today < promo.valid_from:
        return 0
    if promo.valid_to and today > promo.valid_to:
        return 0

    if promo.promo_type == 'HAPPY_HOUR':
        if not promo.happy_hour_start or not promo.happy_hour_end:
            return 0
        current_time = now.time().replace(tzinfo=None)
        start = _parse_time(promo.happy_hour_start)
        end = _parse_time(promo.happy_hour_end)
        if not (start <= current_time <= end):
            return 0
        # Apply to applicable items
        if promo.applies_to_category_id and line_item.menu_item.category_id != promo.applies_to_category_id:
            return 0
        if promo.applies_to_item_id and line_item.menu_item_id != promo.applies_to_item_id:
            return 0
        if promo.discount_type == 'PERCENTAGE':
            return int(line_item.unit_price_cents * line_item.quantity * promo.discount_value / 100)
        elif promo.discount_type == 'FLAT_CENTS':
            return promo.discount_value * line_item.quantity

    elif promo.promo_type == 'ITEM_DISCOUNT':
        if promo.applies_to_item_id and line_item.menu_item_id != promo.applies_to_item_id:
            return 0
        if promo.applies_to_category_id and line_item.menu_item.category_id != promo.applies_to_category_id:
            return 0
        if promo.discount_type == 'PERCENTAGE':
            return int(line_item.unit_price_cents * line_item.quantity * promo.discount_value / 100)
        elif promo.discount_type == 'FLAT_CENTS':
            return promo.discount_value * line_item.quantity

    return 0
