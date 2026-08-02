from datetime import datetime, timezone, time as dtime
from zoneinfo import ZoneInfo
from app.models.promotion import Promotion, QUANTITY_PROMO_TYPES
from app.models.ticket import LineItemPromotion
from app.extensions import db
from app.config import Config


def _parse_time(t_str: str) -> dtime:
    h, m = t_str.split(':')
    return dtime(int(h), int(m))


def apply_promos_to_line_item(line_item, ticket, now: datetime = None):
    """Apply all eligible promotions to a staged line item.

    'now' is compared against happy-hour windows in the venue's local timezone
    (Config.TZ), not UTC, so $17:00 happy hour means 17:00 local time.
    """
    if now is None:
        # Use local venue time for all comparisons
        now = datetime.now(ZoneInfo(Config.TZ))

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
    # Ensure we always compare in local time
    local_now = now.astimezone(ZoneInfo(Config.TZ))
    today = local_now.date()

    # Date range check
    if promo.valid_from and today < promo.valid_from:
        return 0
    if promo.valid_to and today > promo.valid_to:
        return 0

    if promo.promo_type == 'HAPPY_HOUR':
        if not promo.happy_hour_start or not promo.happy_hour_end:
            return 0
        current_time = local_now.time().replace(tzinfo=None)
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


# ═══════════════════════════════════════════════════════════════════════════
# Quantity-driven promotions (BOGO / QTY_PERCENT_DISCOUNT)
#
# These cannot be evaluated from a single line item because the qualifying
# quantity may be spread over several line items (2 × "qty 1" rows, or 1 ×
# "qty 2" row). They are therefore recomputed for the whole ticket whenever
# its line items change, and always fully replace their previous rows so the
# result is idempotent. HAPPY_HOUR / ITEM_DISCOUNT keep their original
# per-line-item behaviour and are never touched here.
# ═══════════════════════════════════════════════════════════════════════════

class PromoUnit:
    """One purchasable unit of a line item, used by the pure calculation core."""

    __slots__ = ('line_item_id', 'menu_item_id', 'unit_price_cents', 'already_discounted',
                 'ordered_at')

    def __init__(self, line_item_id, menu_item_id, unit_price_cents,
                 already_discounted: bool = False, ordered_at: datetime = None):
        self.line_item_id = line_item_id
        self.menu_item_id = menu_item_id
        self.unit_price_cents = int(unit_price_cents or 0)
        self.already_discounted = bool(already_discounted)
        # When the unit was ordered. The time-of-day window is evaluated
        # against this, not against "now", so a promotion earned during happy
        # hour is not stripped off when the ticket is paid after it ends.
        self.ordered_at = ordered_at


def promo_is_in_date_range(promo, local_now: datetime) -> bool:
    today = local_now.date()
    if promo.valid_from and today < promo.valid_from:
        return False
    if promo.valid_to and today > promo.valid_to:
        return False
    return True


def promo_time_window_contains(promo, moment: datetime) -> bool:
    """Is `moment` inside the promotion's time-of-day window?

    The window reuses the happy_hour_start / happy_hour_end columns ('HH:MM').
    A promotion with no window (either end missing) runs all day. Windows that
    wrap past midnight (22:00 -> 02:00) are supported. Both ends are
    inclusive, matching the existing HAPPY_HOUR behaviour.
    """
    start_raw, end_raw = promo.happy_hour_start, promo.happy_hour_end
    if not start_raw or not end_raw:
        return True
    try:
        start = _parse_time(start_raw)
        end = _parse_time(end_raw)
    except (ValueError, TypeError, AttributeError):
        return True  # misconfigured window must not silently disable the promo
    if moment is None:
        return True
    if moment.tzinfo is None:
        # Naive timestamps are stored in UTC; label them before converting.
        moment = moment.replace(tzinfo=timezone.utc)
    current = moment.astimezone(ZoneInfo(Config.TZ)).time().replace(tzinfo=None)
    if start <= end:
        return start <= current <= end
    # Overnight window: inside if after the start OR before the end
    return current >= start or current <= end


def _eligible_menu_item_ids(promo) -> set:
    ids = set(promo.eligible_item_id_list())
    if promo.applies_to_item_id:
        ids.add(promo.applies_to_item_id)
    return ids


def unit_is_eligible(promo, unit: PromoUnit, category_by_item: dict) -> bool:
    """A unit qualifies when it matches the promo's item list and/or category."""
    item_ids = _eligible_menu_item_ids(promo)
    if item_ids and unit.menu_item_id not in item_ids:
        return False
    if promo.applies_to_category_id:
        if category_by_item.get(unit.menu_item_id) != promo.applies_to_category_id:
            return False
    # A promo with neither an item nor a category configured is a misconfiguration;
    # never discount the whole menu by accident.
    if not item_ids and not promo.applies_to_category_id:
        return False
    return True


def compute_quantity_promo_discounts(promo, units, category_by_item=None) -> dict:
    """Pure core: return {line_item_id: discount_cents} for one quantity promo.

    No database access, no side effects — this is the unit-testable heart of the
    quantity promotion engine.
    """
    category_by_item = category_by_item or {}

    required = int(promo.required_quantity or 0)
    if required <= 0:
        return {}

    eligible = [u for u in units if unit_is_eligible(promo, u, category_by_item)]
    if not promo.is_stackable:
        eligible = [u for u in eligible if not u.already_discounted]
    if not eligible:
        return {}

    # Non-combinable promos require the qualifying quantity to come from a
    # single menu item, so mixed products never trigger the promotion.
    if promo.combine_across_items:
        groups = [eligible]
    else:
        by_item = {}
        for u in eligible:
            by_item.setdefault(u.menu_item_id, []).append(u)
        groups = [by_item[k] for k in sorted(by_item, key=lambda k: str(k))]

    if promo.promo_type == 'BOGO':
        per_app = max(0, int(promo.free_quantity if promo.free_quantity is not None else 1))
        percent = 100
    elif promo.promo_type == 'QTY_PERCENT_DISCOUNT':
        per_app = max(0, int(promo.discounted_quantity if promo.discounted_quantity is not None else 1))
        percent = int(promo.discount_value or 0)
    else:
        return {}

    if per_app <= 0 or percent <= 0:
        return {}
    percent = min(percent, 100)

    max_apps = promo.max_applications_per_ticket
    remaining_apps = int(max_apps) if max_apps is not None else None
    if remaining_apps is not None and remaining_apps <= 0:
        return {}

    discounts: dict = {}
    for group in groups:
        applications = len(group) // required
        if applications <= 0:
            continue
        if remaining_apps is not None:
            applications = min(applications, remaining_apps)
            if applications <= 0:
                break
            remaining_apps -= applications

        # Qualifying units are consumed in blocks of `required_quantity`, most
        # expensive first, and the discount lands on the cheapest units *inside
        # each block*. Chunking (rather than picking the globally cheapest
        # units) keeps the discount stable: adding another eligible item can
        # only ever increase the total discount, never move it onto an
        # unrelated cheap product or shrink it.
        ordered = sorted(group, key=lambda u: -u.unit_price_cents)
        for app in range(applications):
            block = ordered[app * required:(app + 1) * required]
            for u in sorted(block, key=lambda u: u.unit_price_cents)[:per_app]:
                amount = int(u.unit_price_cents * percent / 100)
                if amount > 0:
                    discounts[u.line_item_id] = discounts.get(u.line_item_id, 0) + amount

    return discounts


def _ticket_units(ticket):
    """Expand a ticket's non-voided line items into individual units."""
    units = []
    category_by_item = {}
    for li in ticket.line_items.all():
        if li.status == 'VOIDED':
            continue
        if li.menu_item:
            category_by_item[li.menu_item_id] = li.menu_item.category_id
        for _ in range(max(0, int(li.quantity or 0))):
            units.append(PromoUnit(li.id, li.menu_item_id, li.unit_price_cents,
                                   ordered_at=li.sent_at))
    return units, category_by_item


def recompute_quantity_promos(ticket, now: datetime = None):
    """Recalculate every quantity promotion for a ticket (idempotent).

    Existing rows for quantity promos are dropped and rebuilt; rows created by
    HAPPY_HOUR / ITEM_DISCOUNT are left untouched so current behaviour and any
    manual discount keep working exactly as before.
    """
    if now is None:
        now = datetime.now(ZoneInfo(Config.TZ))
    local_now = now.astimezone(ZoneInfo(Config.TZ))

    promos = (Promotion.query
              .filter(Promotion.is_active.is_(True),
                      Promotion.promo_type.in_(QUANTITY_PROMO_TYPES))
              .all())

    quantity_promo_ids = {p.id for p in promos}
    # Also clear rows from quantity promos that have since been deactivated or
    # deleted, otherwise a stale discount would stick to the ticket forever.
    for lip in ticket.applied_promos.all():
        promo = lip.promotion
        if lip.promotion_id in quantity_promo_ids or (
                promo is not None and promo.promo_type in QUANTITY_PROMO_TYPES):
            db.session.delete(lip)
    db.session.flush()

    if not promos:
        return

    units, category_by_item = _ticket_units(ticket)
    if not units:
        return

    discounted_line_items = {
        lip.line_item_id for lip in ticket.applied_promos.all() if lip.line_item_id
    }

    promos.sort(key=lambda p: (p.priority or 0, p.name or '', p.id))
    decisions = _ticket_decisions(ticket)
    for promo in promos:
        if not promo_is_in_date_range(promo, local_now):
            continue
        if promo.requires_confirmation and decisions.get(promo.id) != 'ACCEPTED':
            continue
        eligible_units = _units_in_time_window(promo, units, local_now)
        if not eligible_units:
            continue
        for u in eligible_units:
            u.already_discounted = u.line_item_id in discounted_line_items

        discounts = compute_quantity_promo_discounts(promo, eligible_units, category_by_item)
        for line_item_id, cents in discounts.items():
            if cents <= 0:
                continue
            db.session.add(LineItemPromotion(
                line_item_id=line_item_id,
                ticket_id=ticket.id,
                promotion_id=promo.id,
                discount_cents=cents,
            ))
            discounted_line_items.add(line_item_id)
    db.session.flush()


def _ticket_decisions(ticket) -> dict:
    """{promotion_id: 'ACCEPTED'|'DECLINED'} for promos the waiter answered."""
    from app.models.promotion import TicketPromoDecision
    rows = TicketPromoDecision.query.filter_by(ticket_id=ticket.id).all()
    return {r.promotion_id: r.decision for r in rows}


def _units_in_time_window(promo, units: list, local_now: datetime) -> list:
    """Keep only units ordered inside the promotion's time-of-day window.

    Units with no sent_at (still staged) are judged against the current time.
    """
    if not promo.happy_hour_start or not promo.happy_hour_end:
        return units
    return [u for u in units
            if promo_time_window_contains(promo, u.ordered_at or local_now)]


def preview_pending_quantity_promos(ticket, now: datetime = None) -> list:
    """Quantity promos that would apply right now but are awaiting confirmation.

    Returns the promotions the waiter has not answered yet, each with the
    discount it would produce, so the till can offer them. Promotions already
    accepted or declined for this ticket are not returned. Nothing is written.
    """
    if now is None:
        now = datetime.now(ZoneInfo(Config.TZ))
    local_now = now.astimezone(ZoneInfo(Config.TZ))

    promos = (Promotion.query
              .filter(Promotion.is_active.is_(True),
                      Promotion.requires_confirmation.is_(True),
                      Promotion.promo_type.in_(QUANTITY_PROMO_TYPES))
              .all())
    if not promos:
        return []

    decisions = _ticket_decisions(ticket)
    pending = [p for p in promos if p.id not in decisions]
    if not pending:
        return []

    units, category_by_item = _ticket_units(ticket)
    if not units:
        return []

    # Units already carrying a promo row must look discounted to the preview,
    # exactly as they would during a real recompute.
    discounted_line_items = {
        lip.line_item_id for lip in ticket.applied_promos.all() if lip.line_item_id
    }

    offers = []
    pending.sort(key=lambda p: (p.priority or 0, p.name or '', p.id))
    for promo in pending:
        if not promo_is_in_date_range(promo, local_now):
            continue
        eligible_units = _units_in_time_window(promo, units, local_now)
        if not eligible_units:
            continue
        for u in eligible_units:
            u.already_discounted = u.line_item_id in discounted_line_items
        discounts = compute_quantity_promo_discounts(promo, eligible_units, category_by_item)
        total = sum(c for c in discounts.values() if c > 0)
        if total <= 0:
            continue
        offers.append({
            'promotion_id': promo.id,
            'name': promo.name,
            'promo_type': promo.promo_type,
            'discount_cents': total,
        })
    return offers
