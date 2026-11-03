"""Test scenarios for the POOL_TIME_FREE_MINUTES grant (free pool hour).

Exercises the pure helpers `window_overlap_seconds` and `earned_free_seconds`,
so no database is required:

    cd backend && python -m tests.test_pool_free_time

The promotion under test: buying an eligible beer bucket between 15:00 and
19:00 local time grants 1 free hour of pool, redeemable only against play that
happens inside that same window, at most once per ticket.

Covers:
  1. Window overlap boundaries (inside, outside, straddling, enveloping)
  2. Degenerate and misconfigured spans never produce negative or bogus time
  3. Multi-day and overnight spans
  4. Eligibility: promo type, active flag, date range, item/category match
  5. The grant is capped by BOTH free_pool_minutes and the in-window overlap
  6. max_applications_per_ticket = 1 holds no matter how many buckets are sold
  7. The result is always integer SECONDS and never derived from cents
  8. requires_confirmation makes the grant opt-in: nothing until the waiter accepts
"""
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from zoneinfo import ZoneInfo  # noqa: E402

from app.config import Config  # noqa: E402
from app.services.promotion_svc import (  # noqa: E402
    PromoUnit, earned_free_seconds, window_overlap_seconds,
)

TZ = ZoneInfo(Config.TZ)
HOUR = 3600
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
    """Stands in for a Promotion row; only the read attributes are needed."""

    def __init__(self, start='15:00', end='19:00', **kw):
        self.id = kw.get('id', 'promo-free-pool')
        self.name = kw.get('name', 'Bucket = 1h free pool')
        self.promo_type = kw.get('promo_type', 'POOL_TIME_FREE_MINUTES')
        self.is_active = kw.get('is_active', True)
        self.free_pool_minutes = kw.get('free_pool_minutes', 60)
        self.happy_hour_start = start
        self.happy_hour_end = end
        self.valid_from = kw.get('valid_from')
        self.valid_to = kw.get('valid_to')
        self.applies_to_item_id = kw.get('applies_to_item_id', 'bucket')
        self.applies_to_category_id = kw.get('applies_to_category_id')
        self.max_applications_per_ticket = kw.get('max_applications_per_ticket', 1)
        self.requires_confirmation = kw.get('requires_confirmation', False)
        self._eligible = kw.get('eligible_item_ids', [])

    def eligible_item_id_list(self):
        return list(self._eligible)


def local(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=TZ)


def unit(hh, mm=0, item='bucket', price=15000, day=1):
    """One purchased unit, ordered at the given local time."""
    return PromoUnit('li-1', item, price, ordered_at=local(2024, 6, day, hh, mm))


PROMO = FakePromo()
CATS = {'bucket': 'cat-beer', 'taco': 'cat-food'}

print("== 1. overlap boundaries against a 15:00-19:00 window ==")
check('1a. fully inside the window',
      window_overlap_seconds(local(2024, 6, 1, 16), local(2024, 6, 1, 17), PROMO) == HOUR)
check('1b. entirely before the window',
      window_overlap_seconds(local(2024, 6, 1, 12), local(2024, 6, 1, 14), PROMO) == 0)
check('1c. entirely after the window',
      window_overlap_seconds(local(2024, 6, 1, 20), local(2024, 6, 1, 22), PROMO) == 0)
check('1d. straddles the opening edge -> only the inside half counts',
      window_overlap_seconds(local(2024, 6, 1, 14, 30), local(2024, 6, 1, 15, 30), PROMO) == 1800)
check('1e. straddles the closing edge -> only the inside half counts',
      window_overlap_seconds(local(2024, 6, 1, 18, 30), local(2024, 6, 1, 19, 30), PROMO) == 1800)
check('1f. envelopes the window entirely -> the whole 4h window',
      window_overlap_seconds(local(2024, 6, 1, 13), local(2024, 6, 1, 23), PROMO) == 4 * HOUR)
check('1g. exactly the window',
      window_overlap_seconds(local(2024, 6, 1, 15), local(2024, 6, 1, 19), PROMO) == 4 * HOUR)
check('1h. touching the opening edge from outside is zero, not negative',
      window_overlap_seconds(local(2024, 6, 1, 14), local(2024, 6, 1, 15), PROMO) == 0)
check('1i. touching the closing edge from outside is zero',
      window_overlap_seconds(local(2024, 6, 1, 19), local(2024, 6, 1, 20), PROMO) == 0)

print()
print("== 2. degenerate and misconfigured spans ==")
check('2a. zero-length span',
      window_overlap_seconds(local(2024, 6, 1, 16), local(2024, 6, 1, 16), PROMO) == 0)
check('2b. end before start never goes negative',
      window_overlap_seconds(local(2024, 6, 1, 18), local(2024, 6, 1, 16), PROMO) == 0)
check('2c. a promo with no window is unrestricted -> whole span',
      window_overlap_seconds(local(2024, 6, 1, 2), local(2024, 6, 1, 4),
                             FakePromo(None, None)) == 2 * HOUR)
check('2d. a garbage window never silently kills the grant',
      window_overlap_seconds(local(2024, 6, 1, 2), local(2024, 6, 1, 4),
                             FakePromo('nope', '19:00')) == 2 * HOUR)
naive = datetime(2024, 6, 1, 22, 0, tzinfo=timezone.utc)  # 16:00 in Mexico City
check('2e. naive UTC input is read as UTC, not as local',
      window_overlap_seconds(naive.replace(tzinfo=None),
                             (naive + timedelta(hours=1)).replace(tzinfo=None),
                             PROMO) == HOUR)

print()
print("== 3. multi-day and overnight spans ==")
check('3a. a span crossing midnight collects both days of window',
      window_overlap_seconds(local(2024, 6, 1, 13), local(2024, 6, 2, 23), PROMO) == 8 * HOUR)
check('3b. overnight window 22:00-02:00 is supported',
      window_overlap_seconds(local(2024, 6, 1, 23), local(2024, 6, 2, 1),
                             FakePromo('22:00', '02:00')) == 2 * HOUR)

print()
print("== 4. eligibility gates ==")
played = (local(2024, 6, 1, 15), local(2024, 6, 1, 19))
bucket_at_16 = [unit(16)]


def earned(promos, units, span=played, cats=CATS, decisions=None):
    return earned_free_seconds(promos, units, cats, span[0], span[1],
                               decisions=decisions)


check('4a. eligible bucket bought in-window earns the full hour',
      earned([PROMO], bucket_at_16) == HOUR)
check('4b. bucket bought outside the window earns nothing',
      earned([PROMO], [unit(21)]) == 0)
check('4c. an inactive promo never grants',
      earned([FakePromo(is_active=False)], bucket_at_16) == 0)
check('4d. a non-pool promo type is ignored',
      earned([FakePromo(promo_type='HAPPY_HOUR')], bucket_at_16) == 0)
check('4e. an out-of-date-range promo never grants',
      earned([FakePromo(valid_from=date(2024, 7, 1))], bucket_at_16) == 0)
check('4f. a non-eligible item earns nothing',
      earned([PROMO], [unit(16, item='taco')]) == 0)
check('4g. category-configured promo matches on category',
      earned([FakePromo(applies_to_item_id=None, applies_to_category_id='cat-beer')],
             bucket_at_16) == HOUR)
check('4h. no units at all earns nothing', earned([PROMO], []) == 0)
check('4i. no promos configured earns nothing', earned([], bucket_at_16) == 0)

print()
print("== 5. the grant is capped by free_pool_minutes AND by the overlap ==")
check('5a. only 20 min played in-window -> only 20 min free',
      earned([PROMO], bucket_at_16,
             span=(local(2024, 6, 1, 16), local(2024, 6, 1, 16, 20))) == 1200)
check('5b. 3h played in-window -> still only the 1h granted',
      earned([PROMO], bucket_at_16,
             span=(local(2024, 6, 1, 15), local(2024, 6, 1, 18))) == HOUR)
check('5c. play entirely outside the window redeems nothing',
      earned([PROMO], bucket_at_16,
             span=(local(2024, 6, 1, 20), local(2024, 6, 1, 23))) == 0)
check('5d. a 30-minute promo grants at most 30 minutes',
      earned([FakePromo(free_pool_minutes=30)], bucket_at_16) == 1800)
check('5e. free_pool_minutes = 0 grants nothing',
      earned([FakePromo(free_pool_minutes=0)], bucket_at_16) == 0)

print()
print("== 6. max_applications_per_ticket = 1 ==")
two_buckets = [unit(16), unit(17)]
check('6a. two buckets still earn a single hour',
      earned([PROMO], two_buckets) == HOUR)
check('6b. five buckets still earn a single hour',
      earned([PROMO], [unit(16) for _ in range(5)]) == HOUR)
check('6c. an uncapped promo scales with the buckets, bounded by the overlap',
      earned([FakePromo(max_applications_per_ticket=None)], two_buckets) == 2 * HOUR)
check('6d. an uncapped promo still cannot exceed in-window play',
      earned([FakePromo(max_applications_per_ticket=None)], two_buckets,
             span=(local(2024, 6, 1, 16), local(2024, 6, 1, 17))) == HOUR)

print()
print("== 7. seconds, never cents ==")
r = earned([PROMO], bucket_at_16)
check('7a. the grant is an int', isinstance(r, int) and not isinstance(r, bool),
      f"type={type(r).__name__}")
check('7b. the grant is a whole number of seconds (3600), not a money value',
      r == HOUR, f"value={r}")
check('7c. unit price does not influence the grant',
      earned([PROMO], [unit(16, price=1)]) == earned([PROMO], [unit(16, price=999999)]))
check('7d. the grant never exceeds the elapsed span',
      earned([PROMO], bucket_at_16,
             span=(local(2024, 6, 1, 16), local(2024, 6, 1, 16, 5))) == 300)

print()
print("== 8. opt-in confirmation (requires_confirmation) ==")
ASK = FakePromo(requires_confirmation=True)
check('8a. a confirmable promo grants nothing while undecided',
      earned([ASK], bucket_at_16) == 0)
check('8b. an empty decision map is treated as undecided',
      earned([ASK], bucket_at_16, decisions={}) == 0)
check('8c. a DECLINED decision grants nothing',
      earned([ASK], bucket_at_16, decisions={ASK.id: 'DECLINED'}) == 0)
check('8d. an ACCEPTED decision grants the full hour',
      earned([ASK], bucket_at_16, decisions={ASK.id: 'ACCEPTED'}) == HOUR)
check('8e. a decision for another promo does not unlock this one',
      earned([ASK], bucket_at_16, decisions={'other-promo': 'ACCEPTED'}) == 0)
check('8f. acceptance does not bypass window eligibility',
      earned([ASK], [unit(21)], decisions={ASK.id: 'ACCEPTED'}) == 0)
check('8g. acceptance does not bypass the in-window overlap cap',
      earned([ASK], bucket_at_16, decisions={ASK.id: 'ACCEPTED'},
             span=(local(2024, 6, 1, 16), local(2024, 6, 1, 16, 10))) == 600)
check('8h. acceptance does not bypass max_applications_per_ticket',
      earned([ASK], [unit(16), unit(17)], decisions={ASK.id: 'ACCEPTED'}) == HOUR)
check('8i. a non-confirmable promo still applies automatically',
      earned([PROMO], bucket_at_16, decisions={}) == HOUR)
check('8j. a stale ACCEPTED row cannot revive an inactive promo',
      earned([FakePromo(is_active=False, requires_confirmation=True)], bucket_at_16,
             decisions={'promo-free-pool': 'ACCEPTED'}) == 0)
check('8k. mixed promos: only the accepted confirmable one contributes',
      earned([FakePromo(id='p-ask', requires_confirmation=True,
                        max_applications_per_ticket=None)],
             bucket_at_16, decisions={'p-ask': 'ACCEPTED'}) == HOUR)

print()
print(f"{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
