"""Test scenarios for the promotion time-of-day window and waiter confirmation.

The window part exercises the pure helper `promo_time_window_contains`, so no
database is required:

    cd backend && python -m tests.test_promo_time_window

Covers:
  1. Inside / outside / boundary of a normal window (16:00-18:00)
  2. Overnight windows that wrap past midnight (22:00-02:00)
  3. Missing or malformed windows never disable a promotion
  4. Naive timestamps are read as UTC
  5. Unit filtering keeps only units ordered inside the window
  6. Stability: a promo earned at 17:00 survives a recompute at 21:00,
     because the window is judged against sent_at, not "now"
"""
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from zoneinfo import ZoneInfo  # noqa: E402

from app.config import Config  # noqa: E402
from app.services.promotion_svc import (  # noqa: E402
    PromoUnit, _units_in_time_window, compute_quantity_promo_discounts,
    promo_time_window_contains,
)

TZ = ZoneInfo(Config.TZ)
BUCKET = 'item-beer-bucket'
PRICE = 70000

passed = failed = 0


def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  -- {detail}" if detail else ''))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  -- {detail}" if detail else ''))


class FakePromo:
    def __init__(self, start=None, end=None, **kw):
        self.id = kw.get('id', 'promo-hh')
        self.name = kw.get('name', '2x1 happy hour')
        self.promo_type = kw.get('promo_type', 'BOGO')
        self.discount_type = kw.get('discount_type')
        self.discount_value = kw.get('discount_value')
        self.required_quantity = kw.get('required_quantity', 2)
        self.free_quantity = kw.get('free_quantity', 1)
        self.discounted_quantity = kw.get('discounted_quantity', 1)
        self.max_applications_per_ticket = kw.get('max_applications_per_ticket')
        self.applies_to_item_id = kw.get('applies_to_item_id', BUCKET)
        self.applies_to_category_id = kw.get('applies_to_category_id')
        self.combine_across_items = kw.get('combine_across_items', False)
        self.is_stackable = kw.get('is_stackable', False)
        self.priority = kw.get('priority', 0)
        self.valid_from = kw.get('valid_from')
        self.valid_to = kw.get('valid_to')
        self.requires_confirmation = kw.get('requires_confirmation', False)
        self.happy_hour_start = start
        self.happy_hour_end = end
        self._eligible = kw.get('eligible_item_ids', [])

    def eligible_item_id_list(self):
        return list(self._eligible)


def local(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=TZ)


# --- 1. Normal window 16:00-18:00 -------------------------------------------
p = FakePromo('16:00', '18:00')
check('1a. 17:00 is inside 16:00-18:00', promo_time_window_contains(p, local(2024, 6, 1, 17)))
check('1b. 15:59 is outside', not promo_time_window_contains(p, local(2024, 6, 1, 15, 59)))
check('1c. 18:01 is outside', not promo_time_window_contains(p, local(2024, 6, 1, 18, 1)))
check('1d. 16:00 boundary is inclusive', promo_time_window_contains(p, local(2024, 6, 1, 16)))
check('1e. 18:00 boundary is inclusive', promo_time_window_contains(p, local(2024, 6, 1, 18)))
check('1f. 04:00 next morning is outside', not promo_time_window_contains(p, local(2024, 6, 2, 4)))

# --- 2. Overnight window 22:00-02:00 ----------------------------------------
n = FakePromo('22:00', '02:00')
check('2a. 23:30 is inside 22:00-02:00', promo_time_window_contains(n, local(2024, 6, 1, 23, 30)))
check('2b. 01:00 is inside (after midnight)', promo_time_window_contains(n, local(2024, 6, 2, 1)))
check('2c. 22:00 boundary is inclusive', promo_time_window_contains(n, local(2024, 6, 1, 22)))
check('2d. 02:00 boundary is inclusive', promo_time_window_contains(n, local(2024, 6, 2, 2)))
check('2e. 03:00 is outside', not promo_time_window_contains(n, local(2024, 6, 2, 3)))
check('2f. 12:00 midday is outside', not promo_time_window_contains(n, local(2024, 6, 1, 12)))

# --- 3. Missing / malformed windows never disable the promo -----------------
check('3a. no window at all -> always on',
      promo_time_window_contains(FakePromo(), local(2024, 6, 1, 3)))
check('3b. only a start -> always on',
      promo_time_window_contains(FakePromo('16:00', None), local(2024, 6, 1, 3)))
check('3c. only an end -> always on',
      promo_time_window_contains(FakePromo(None, '18:00'), local(2024, 6, 1, 3)))
check('3d. empty strings -> always on',
      promo_time_window_contains(FakePromo('', ''), local(2024, 6, 1, 3)))
check('3e. garbage string -> always on (never silently kills the promo)',
      promo_time_window_contains(FakePromo('abc', 'def'), local(2024, 6, 1, 3)))
check('3f. missing colon -> always on',
      promo_time_window_contains(FakePromo('1600', '1800'), local(2024, 6, 1, 3)))
check('3g. non-string -> always on',
      promo_time_window_contains(FakePromo(16, 18), local(2024, 6, 1, 3)))
check('3h. moment is None -> always on', promo_time_window_contains(p, None))

# --- 4. Naive timestamps are read as UTC ------------------------------------
# 23:00 UTC is 17:00 in America/Mexico_City (UTC-6), i.e. inside 16:00-18:00.
utc_1700_local = datetime(2024, 6, 1, 23, 0)
aware = utc_1700_local.replace(tzinfo=timezone.utc)
check('4a. naive UTC matches the same aware UTC instant',
      promo_time_window_contains(p, utc_1700_local) == promo_time_window_contains(p, aware),
      f"naive={promo_time_window_contains(p, utc_1700_local)}")
check('4b. that instant is inside the local window',
      promo_time_window_contains(p, aware) is True)

# --- 5. Unit filtering -------------------------------------------------------
def unit(hour, li):
    return PromoUnit(li, BUCKET, PRICE, ordered_at=local(2024, 6, 1, hour))


units = [unit(17, 'li-1'), unit(17, 'li-2'), unit(20, 'li-3')]
kept = _units_in_time_window(p, units, local(2024, 6, 1, 21))
check('5a. only the in-window units survive', len(kept) == 2, f"kept={len(kept)}")
check('5b. the 20:00 unit is dropped', all(u.line_item_id != 'li-3' for u in kept))
check('5c. promo without a window keeps every unit',
      len(_units_in_time_window(FakePromo(), units, local(2024, 6, 1, 21))) == 3)
staged = [PromoUnit('li-4', BUCKET, PRICE, ordered_at=None)]
check('5d. staged unit (no sent_at) judged against now — inside',
      len(_units_in_time_window(p, staged, local(2024, 6, 1, 17))) == 1)
check('5e. staged unit judged against now — outside',
      len(_units_in_time_window(p, staged, local(2024, 6, 1, 21))) == 0)

# --- 6. Stability across a late close ---------------------------------------
# Two buckets ordered at 17:00, ticket paid at 21:00 (window already closed).
ordered = [unit(17, 'li-1'), unit(17, 'li-2')]
at_close = _units_in_time_window(p, ordered, local(2024, 6, 1, 21))
d = compute_quantity_promo_discounts(p, at_close, {})
check('6a. 2x1 still applies when the ticket is paid after happy hour',
      sum(d.values()) == PRICE, f"discount={sum(d.values())}")

# One bucket at 17:00 and one at 20:00 -> not enough in-window units.
mixed = [unit(17, 'li-1'), unit(20, 'li-2')]
d2 = compute_quantity_promo_discounts(p, _units_in_time_window(p, mixed, local(2024, 6, 1, 21)), {})
check('6b. one in-window bucket does not reach the quantity',
      sum(d2.values()) == 0, f"discount={sum(d2.values())}")

# Four buckets all inside the window -> two applications.
four = [unit(16, 'li-1'), unit(16, 'li-2'), unit(17, 'li-3'), unit(17, 'li-4')]
d3 = compute_quantity_promo_discounts(p, _units_in_time_window(p, four, local(2024, 6, 1, 21)), {})
check('6c. four in-window buckets apply the promo twice',
      sum(d3.values()) == PRICE * 2, f"discount={sum(d3.values())}")

# Date range and time window are independent gates.
dated = FakePromo('16:00', '18:00', valid_from=date(2024, 6, 2))
check('6d. date range still gates independently of the time window',
      promo_time_window_contains(dated, local(2024, 6, 1, 17)) is True)

print()
print(f"{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
