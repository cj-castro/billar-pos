from datetime import datetime, timezone, timedelta, time as dtime
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
    Promos with requires_confirmation only apply when the waiter has already
    accepted them for this ticket.
    """
    if now is None:
        now = datetime.now(ZoneInfo(Config.TZ))

    try:
        decisions = _ticket_decisions(ticket)
    except Exception:
        decisions = {}
    promos = Promotion.query.filter_by(is_active=True).all()
    for promo in promos:
        confirmed = decisions.get(promo.id) == 'ACCEPTED'
        discount = _evaluate_promo(promo, line_item, now, confirmed=confirmed)
        if discount and discount > 0:
            lip = LineItemPromotion(
                line_item_id=line_item.id,
                ticket_id=ticket.id,
                promotion_id=promo.id,
                discount_cents=discount
            )
            db.session.add(lip)


def apply_confirmable_item_promo(promo, ticket, now: datetime = None):
    """Apply a HAPPY_HOUR / ITEM_DISCOUNT promo to all current eligible line items.

    Called when the waiter accepts a confirmable non-quantity promo.  Clears
    any stale rows for this promo on the ticket first so the result is
    idempotent.
    """
    if now is None:
        now = datetime.now(ZoneInfo(Config.TZ))
    for lip in list(ticket.applied_promos):
        if lip.promotion_id == promo.id:
            db.session.delete(lip)
    db.session.flush()
    for item in ticket.line_items:
        if item.status == 'VOIDED':
            continue
        discount = _evaluate_promo(promo, item, now, confirmed=True)
        if discount and discount > 0:
            db.session.add(LineItemPromotion(
                line_item_id=item.id,
                ticket_id=ticket.id,
                promotion_id=promo.id,
                discount_cents=discount,
            ))
    db.session.flush()


def _evaluate_promo(promo, line_item, now: datetime, *, confirmed: bool = False) -> int:
    # Promos that require waiter confirmation are never auto-applied.
    if promo.requires_confirmation and not confirmed:
        return 0

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


def _as_aware(moment: datetime) -> datetime:
    """Naive timestamps are stored in UTC; label them before converting."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment


def window_overlap_seconds(start: datetime, end: datetime, promo) -> int:
    """Seconds of the span [start, end] that fall inside the promo's window.

    Used by POOL_TIME_FREE_MINUTES, where the free time is only redeemable
    against play that happens inside the window: a session running 14:30-19:30
    against a 15:00-19:00 promotion only redeems the 4 hours in between.

    Returns whole SECONDS, never money. The caller converts billable seconds
    to cents exactly once, in billing.calculate_charge, so no rounding or
    currency representation is introduced here.

    A promo with no window (or a malformed one) is unrestricted and returns the
    whole span, matching promo_time_window_contains. Overnight windows
    (22:00 -> 02:00) and spans covering several days are supported.
    """
    if start is None or end is None:
        return 0
    start, end = _as_aware(start), _as_aware(end)
    if end <= start:
        return 0

    span_seconds = int((end - start).total_seconds())
    start_raw, end_raw = promo.happy_hour_start, promo.happy_hour_end
    if not start_raw or not end_raw:
        return span_seconds
    try:
        w_start = _parse_time(start_raw)
        w_end = _parse_time(end_raw)
    except (ValueError, TypeError, AttributeError):
        return span_seconds  # misconfigured window must not silently kill the grant

    tz = ZoneInfo(Config.TZ)
    local_start = start.astimezone(tz)
    local_end = end.astimezone(tz)

    total = 0
    # Walk one day either side so a window opened the previous day (overnight)
    # or closing the next day is still intersected.
    day = local_start.date() - timedelta(days=1)
    last_day = local_end.date() + timedelta(days=1)
    while day <= last_day:
        open_at = datetime.combine(day, w_start, tzinfo=tz)
        close_day = day if w_start <= w_end else day + timedelta(days=1)
        close_at = datetime.combine(close_day, w_end, tzinfo=tz)
        lo = max(open_at, local_start)
        hi = min(close_at, local_end)
        if hi > lo:
            total += int((hi - lo).total_seconds())
        day += timedelta(days=1)
    return total


def _pool_promo_applications(promo, units, category_by_item: dict, tz) -> int:
    """How many times a POOL_TIME_FREE_MINUTES promo is earned on these units.

    Eligibility is judged at PromoUnit.ordered_at and capped by
    max_applications_per_ticket. Deliberately knows nothing about the timer
    session: the "only redeemable inside the window" cap is applied by the
    caller, so the waiter-facing offer can advertise the full entitlement
    while billing still redeems only what was actually played in-window.
    """
    applications = 0
    for unit in units:
        ordered_at = getattr(unit, 'ordered_at', None)
        if ordered_at is None:
            continue
        local_ordered = _as_aware(ordered_at).astimezone(tz)
        if not promo_is_in_date_range(promo, local_ordered):
            continue
        if not promo_time_window_contains(promo, ordered_at):
            continue
        if not unit_is_eligible(promo, unit, category_by_item or {}):
            continue
        applications += 1
    cap = getattr(promo, 'max_applications_per_ticket', None)
    if cap is not None:
        applications = min(applications, int(cap))
    return applications


def earned_free_seconds(promos, units, category_by_item: dict,
                        session_start: datetime, session_end: datetime,
                        decisions: dict = None) -> int:
    """Free pool SECONDS a ticket has earned for one timer session.

    A POOL_TIME_FREE_MINUTES promotion grants free_pool_minutes per eligible
    unit purchased, where eligibility is judged against when the unit was
    ORDERED (PromoUnit.ordered_at) so a bucket bought at 18:50 keeps its free
    hour even when the ticket is paid at 23:00. The grant is then capped by:

      * max_applications_per_ticket (NULL = unlimited), and
      * how much of the session was actually played inside the window, so the
        promotion can never discount time it does not cover.

    A promo with requires_confirmation only grants once the waiter has
    ACCEPTED it for this ticket (`decisions` maps promotion_id -> decision).
    Undecided and DECLINED both grant nothing, so the free hour is opt-in and
    changing the decision later simply changes the next calculation.

    Returns integer seconds. Deliberately has no access to rates or prices:
    the value is subtracted from billable seconds before any cents arithmetic.
    """
    if not promos or not units:
        return 0

    decisions = decisions or {}
    tz = ZoneInfo(Config.TZ)
    total = 0
    for promo in promos:
        if getattr(promo, 'promo_type', None) != 'POOL_TIME_FREE_MINUTES':
            continue
        if not getattr(promo, 'is_active', False):
            continue
        if getattr(promo, 'requires_confirmation', False) \
                and decisions.get(getattr(promo, 'id', None)) != 'ACCEPTED':
            continue
        minutes = int(getattr(promo, 'free_pool_minutes', 0) or 0)
        if minutes <= 0:
            continue

        redeemable = window_overlap_seconds(session_start, session_end, promo)
        if redeemable <= 0:
            continue

        applications = _pool_promo_applications(promo, units, category_by_item, tz)
        if applications <= 0:
            continue

        total += min(applications * minutes * 60, redeemable)
    return int(total)


def _latest_pool_session(ticket):
    """The session free pool time would apply to: the running one, else the last.

    Pool-time promos are meaningless on a ticket with no table, so this
    returning None is what keeps the offer off bar and regular-table tickets.
    """
    try:
        sessions = ticket.timer_sessions.all()
    except AttributeError:
        sessions = list(getattr(ticket, 'timer_sessions', []) or [])
    if not sessions:
        return None
    active = [s for s in sessions if s.status == 'ACTIVE']
    pool = active or sessions
    return max(pool, key=lambda s: s.start_time or datetime.min.replace(tzinfo=timezone.utc))


def free_seconds_for_session(ticket, session, end_time: datetime = None) -> int:
    """Total free SECONDS applying to one timer session.

    Two independent sources, kept separate on purpose:
      * the table's configured baseline, snapshotted onto the session at start
        (PoolTableConfig.promo_free_minutes), and
      * the POOL_TIME_FREE_MINUTES promotion grant, which is DERIVED here on
        every call rather than stored.

    Deriving the grant is what makes clawback free: void the bucket and the
    next calculation simply stops granting, with no bookkeeping to unwind.

    Callers pass the result straight to billing.calculate_charge, which
    subtracts it from billable seconds BEFORE any cents arithmetic, so the
    integer-cents representation is untouched.
    """
    baseline = int(getattr(session, 'promo_free_seconds', 0) or 0)
    if ticket is None or session is None or session.start_time is None:
        return baseline

    end = end_time or session.end_time or datetime.now(timezone.utc)
    promos = Promotion.query.filter_by(
        is_active=True, promo_type='POOL_TIME_FREE_MINUTES').all()
    if not promos:
        return baseline

    units, category_by_item = _ticket_units(ticket)
    return baseline + earned_free_seconds(
        promos, units, category_by_item, session.start_time, end,
        decisions=_ticket_decisions(ticket))


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
        # For confirmed promos, skip the time-window filter so a discount the
        # waiter already accepted doesn't vanish when the window later closes.
        if promo.requires_confirmation and decisions.get(promo.id) == 'ACCEPTED':
            eligible_units = [u for u in units if unit_is_eligible(promo, u, category_by_item)]
        else:
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
    """All confirmable promos that qualify right now but are awaiting waiter decision.

    Covers HAPPY_HOUR, ITEM_DISCOUNT, BOGO, and QTY_PERCENT_DISCOUNT — any
    promo with requires_confirmation=True that the waiter hasn't answered yet.
    Returns each offer with the discount it would produce. Nothing is written.
    """
    if now is None:
        now = datetime.now(ZoneInfo(Config.TZ))
    local_now = now.astimezone(ZoneInfo(Config.TZ))

    promos = (Promotion.query
              .filter(Promotion.is_active.is_(True),
                      Promotion.requires_confirmation.is_(True))
              .all())
    if not promos:
        return []

    decisions = _ticket_decisions(ticket)
    # Only hide the banner once the waiter has ACCEPTED (applied) the promo.
    # A DECLINED decision does not suppress it — the banner stays until confirmed.
    pending = [p for p in promos if decisions.get(p.id) != 'ACCEPTED']
    if not pending:
        return []

    # Pre-compute shared data only when needed.
    _units_cache = None
    _category_cache = None
    _discounted_cache = None

    def _get_units():
        nonlocal _units_cache, _category_cache, _discounted_cache
        if _units_cache is None:
            _units_cache, _category_cache = _ticket_units(ticket)
            _discounted_cache = {
                lip.line_item_id for lip in ticket.applied_promos.all() if lip.line_item_id
            }
        return _units_cache, _category_cache, _discounted_cache

    offers = []
    pending.sort(key=lambda p: (p.priority or 0, p.name or '', p.id))
    for promo in pending:
        if not promo_is_in_date_range(promo, local_now):
            continue

        if promo.promo_type in QUANTITY_PROMO_TYPES:
            # Banner only shown while the time window is currently open.
            # _units_in_time_window uses order time (for application), but for the
            # preview we want the window to gate when the banner appears/disappears.
            if promo.happy_hour_start and promo.happy_hour_end:
                if not promo_time_window_contains(promo, local_now):
                    continue
            units, category_by_item, discounted_line_items = _get_units()
            if not units:
                continue
            eligible_units = [u for u in units if unit_is_eligible(promo, u, category_by_item)]
            if not eligible_units:
                continue
            for u in eligible_units:
                u.already_discounted = u.line_item_id in discounted_line_items
            discounts = compute_quantity_promo_discounts(promo, eligible_units, category_by_item)
            total = sum(c for c in discounts.values() if c > 0)
        elif promo.promo_type == 'POOL_TIME_FREE_MINUTES':
            # Free pool time is offered in MINUTES, never cents, so it cannot go
            # through the discount path or the `total <= 0` skip below.
            minutes = int(getattr(promo, 'free_pool_minutes', 0) or 0)
            if minutes <= 0:
                continue
            if _latest_pool_session(ticket) is None:
                continue  # nothing to discount on a ticket with no table time
            units, category_by_item, _ = _get_units()
            # The offer advertises the full entitlement. The "only redeemable
            # against in-window play" cap is applied later by
            # earned_free_seconds, so a session that has only just started does
            # not show a misleading "1 min de mesa gratis".
            applications = _pool_promo_applications(
                promo, units, category_by_item, ZoneInfo(Config.TZ))
            if applications <= 0:
                continue
            offers.append({
                'promotion_id': promo.id,
                'name': promo.name,
                'promo_type': promo.promo_type,
                'discount_cents': 0,
                'free_pool_minutes': applications * minutes,
            })
            continue
        else:
            # HAPPY_HOUR / ITEM_DISCOUNT — evaluate against each current line item.
            total = sum(
                _evaluate_promo(promo, item, local_now, confirmed=True)
                for item in ticket.line_items
                if item.status != 'VOIDED'
            )

        if total <= 0:
            continue
        offers.append({
            'promotion_id': promo.id,
            'name': promo.name,
            'promo_type': promo.promo_type,
            'discount_cents': total,
        })
    return offers
