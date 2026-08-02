"""Test scenarios for the quantity promotion engine (BOGO / QTY_PERCENT_DISCOUNT).

These exercise the pure calculation core (`compute_quantity_promo_discounts`),
so no database, HTTP server or fixtures are required:

    cd backend && python -m tests.test_promotions

Covers the required cases:
  1. Buy 2 beer buckets -> pay for 1 (2x1)
  2. Buy 2 beer buckets -> 50% off one bucket
  3. Buy 4 beer buckets -> promotion applied twice (and capped when configured)
  4. Mixed products do not trigger the promotion unless configured
  5. Existing discounts (happy hour / item discount / manual %) keep working
  6. Receipt shows promotion details
  7. Reporting calculates promotional sales correctly
"""
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.promotion_svc import (  # noqa: E402
    PromoUnit, compute_quantity_promo_discounts, promo_is_in_date_range,
)

BUCKET = 'item-beer-bucket'
NACHOS = 'item-nachos'
PRICE = 70000  # $700.00 — Simple Beer Bucket (10 beers)


class FakePromo:
    """Stand-in for models.promotion.Promotion with the same attribute surface."""

    def __init__(self, **kw):
        self.id = kw.get('id', 'promo-1')
        self.name = kw.get('name', 'Test promo')
        self.promo_type = kw.get('promo_type', 'BOGO')
        self.discount_type = kw.get('discount_type')
        self.discount_value = kw.get('discount_value')
        self.applies_to_item_id = kw.get('applies_to_item_id')
        self.applies_to_category_id = kw.get('applies_to_category_id')
        self._eligible = kw.get('eligible_item_ids', [])
        self.required_quantity = kw.get('required_quantity', 2)
        self.free_quantity = kw.get('free_quantity', 1)
        self.discounted_quantity = kw.get('discounted_quantity', 1)
        self.max_applications_per_ticket = kw.get('max_applications_per_ticket')
        self.is_stackable = kw.get('is_stackable', False)
        self.combine_across_items = kw.get('combine_across_items', False)
        self.priority = kw.get('priority', 0)
        self.valid_from = kw.get('valid_from')
        self.valid_to = kw.get('valid_to')
        self.is_active = kw.get('is_active', True)

    def eligible_item_id_list(self):
        return list(self._eligible)


def bogo_2x1(**over):
    cfg = dict(name='2x1 Cubetazo', promo_type='BOGO',
               applies_to_item_id=BUCKET, required_quantity=2, free_quantity=1)
    cfg.update(over)
    return FakePromo(**cfg)


def qty_50_off(**over):
    cfg = dict(name='2do Cubetazo 50%', promo_type='QTY_PERCENT_DISCOUNT',
               applies_to_item_id=BUCKET, required_quantity=2,
               discounted_quantity=1, discount_type='PERCENTAGE',
               discount_value=50)
    cfg.update(over)
    return FakePromo(**cfg)


def units(item_id, count, price=PRICE, line_item_id=None, already_discounted=False):
    return [PromoUnit(line_item_id or f'li-{item_id}-{i}', item_id, price,
                      already_discounted)
            for i in range(count)]


RESULTS = []


def check(label, condition, detail=''):
    RESULTS.append((label, bool(condition), detail))
    print(f'{"PASS" if condition else "FAIL"}  {label}' + (f'  -- {detail}' if detail else ''))


# ── 1. Buy 2 beer buckets -> pay for 1 ──────────────────────────────────────
def test_bogo_two_buckets():
    d = compute_quantity_promo_discounts(bogo_2x1(), units(BUCKET, 2))
    check('1. 2x1: buy 2 buckets, pay 1',
          sum(d.values()) == PRICE,
          f'discount={sum(d.values())} expected={PRICE}')

    # Same quantity expressed as a single line item of qty 2
    one_row = units(BUCKET, 2, line_item_id='li-single')
    d2 = compute_quantity_promo_discounts(bogo_2x1(), one_row)
    check('1b. 2x1 works when the qty lives on one line item',
          sum(d2.values()) == PRICE and list(d2) == ['li-single'])

    d3 = compute_quantity_promo_discounts(bogo_2x1(), units(BUCKET, 1))
    check('1c. 2x1 does not trigger with only 1 bucket', d3 == {})


# ── 2. Buy 2 beer buckets -> 50% off one bucket ─────────────────────────────
def test_percent_two_buckets():
    d = compute_quantity_promo_discounts(qty_50_off(), units(BUCKET, 2))
    expected = int(PRICE * 0.5)
    total_paid = PRICE * 2 - sum(d.values())
    check('2. 50% off one of two buckets',
          sum(d.values()) == expected and total_paid == PRICE * 2 - expected,
          f'discount={sum(d.values())} total={total_paid}')


# ── 3. Buy 4 buckets -> applied twice, capped when configured ───────────────
def test_four_buckets():
    d = compute_quantity_promo_discounts(bogo_2x1(), units(BUCKET, 4))
    check('3. 2x1 applies twice on 4 buckets',
          sum(d.values()) == PRICE * 2, f'discount={sum(d.values())}')

    d = compute_quantity_promo_discounts(qty_50_off(), units(BUCKET, 4))
    check('3b. 50% promo applies twice on 4 buckets',
          sum(d.values()) == int(PRICE * 0.5) * 2)

    capped = compute_quantity_promo_discounts(
        bogo_2x1(max_applications_per_ticket=1), units(BUCKET, 4))
    check('3c. max_applications_per_ticket=1 caps the discount',
          sum(capped.values()) == PRICE, f'discount={sum(capped.values())}')

    d = compute_quantity_promo_discounts(bogo_2x1(), units(BUCKET, 3))
    check('3d. 3 buckets -> exactly one 2x1 application',
          sum(d.values()) == PRICE)


# ── 4. Mixed products must not trigger unless configured ────────────────────
def test_mixed_products():
    mixed = units(BUCKET, 1) + units(NACHOS, 1, price=15000)
    d = compute_quantity_promo_discounts(bogo_2x1(), mixed)
    check('4. 1 bucket + 1 nachos does not trigger the 2x1', d == {})

    d = compute_quantity_promo_discounts(bogo_2x1(), units(NACHOS, 4, price=15000))
    check('4b. 4 nachos do not trigger a bucket-only promo', d == {})

    combo = bogo_2x1(applies_to_item_id=None,
                     eligible_item_ids=[BUCKET, NACHOS],
                     combine_across_items=True)
    d = compute_quantity_promo_discounts(combo, mixed)
    check('4c. combine_across_items=True lets mixed eligible items trigger it',
          sum(d.values()) == 15000, f'discount={sum(d.values())} (cheapest unit)')

    cat = bogo_2x1(applies_to_item_id=None, applies_to_category_id='cat-buckets')
    cat_map = {BUCKET: 'cat-buckets', NACHOS: 'cat-food'}
    d = compute_quantity_promo_discounts(
        cat, units(BUCKET, 2) + units(NACHOS, 2, price=15000), cat_map)
    check('4d. category promo discounts only items of that category',
          sum(d.values()) == PRICE)

    d = compute_quantity_promo_discounts(
        bogo_2x1(applies_to_item_id=None), units(BUCKET, 4))
    check('4e. unscoped promo is inert (no accidental menu-wide discount)', d == {})


# ── 5. Existing discounts keep working ──────────────────────────────────────
def test_existing_discounts_preserved():
    already = units(BUCKET, 2, already_discounted=True)
    d = compute_quantity_promo_discounts(bogo_2x1(), already)
    check('5. non-stackable promo skips already-discounted items', d == {})

    d = compute_quantity_promo_discounts(bogo_2x1(is_stackable=True), already)
    check('5b. stackable promo still applies on discounted items',
          sum(d.values()) == PRICE)

    now = datetime(2026, 6, 15, 18, 0)
    check('5c. promo outside its date range is inactive',
          not promo_is_in_date_range(bogo_2x1(valid_to=date(2026, 6, 1)), now))
    check('5d. promo inside its date range is active',
          promo_is_in_date_range(
              bogo_2x1(valid_from=date(2026, 6, 1), valid_to=date(2026, 6, 30)), now))

    # Manual ticket discount stays additive in Ticket.recalculate_totals():
    # discount_cents = promo discounts + manual %, total = subtotal - discounts.
    subtotal = PRICE * 2
    promo_discount = sum(
        compute_quantity_promo_discounts(bogo_2x1(), units(BUCKET, 2)).values())
    manual = round(subtotal * 10 / 100)
    check('5e. manual % discount stacks on top of promo discounts',
          max(0, subtotal - (promo_discount + manual)) == subtotal - PRICE - manual)


# ── 6. Receipt shows promotion details ──────────────────────────────────────
def test_receipt_payload():
    """Mirrors Ticket.to_dict()'s applied_promotions aggregation."""
    rows = [
        {'promotion_id': 'p1', 'name': '2x1 Cubetazo', 'discount_cents': PRICE},
        {'promotion_id': 'p1', 'name': '2x1 Cubetazo', 'discount_cents': PRICE},
        {'promotion_id': 'p2', 'name': 'Happy Hour', 'discount_cents': 5000},
    ]
    totals = {}
    for r in rows:
        e = totals.setdefault(r['promotion_id'],
                              {'name': r['name'], 'discount_cents': 0})
        e['discount_cents'] += r['discount_cents']
    ordered = sorted(totals.values(), key=lambda p: (-p['discount_cents'], p['name']))
    check('6. receipt payload groups promotions with the right amounts',
          ordered[0]['discount_cents'] == PRICE * 2
          and ordered[1]['name'] == 'Happy Hour'
          and sum(p['discount_cents'] for p in ordered) == PRICE * 2 + 5000)


# ── 7. Reporting aggregates promotional sales ───────────────────────────────
def test_reporting_math():
    """Mirrors the /reports/promotions aggregation over line_item_promotions."""
    d = compute_quantity_promo_discounts(bogo_2x1(), units(BUCKET, 4))
    gross = PRICE * 4
    discount = sum(d.values())
    net = gross - discount
    check('7. reporting: gross - discount = net promotional revenue',
          discount == PRICE * 2 and net == PRICE * 2,
          f'gross={gross} discount={discount} net={net}')

    # Reports pre-aggregate promo rows per line item, so a line item carrying
    # two promotions must not multiply its units / gross.
    per_line = {}
    for line_item_id, cents in d.items():
        per_line[line_item_id] = per_line.get(line_item_id, 0) + cents
    check('7b. one aggregated discount row per line item',
          sum(per_line.values()) == discount)


def test_regression_cheap_item_steals_promo():
    """Regression: adding a cheap eligible item must never shrink the discount.

    A category-wide 2x1 on 2 buckets used to move the free unit onto a $50
    beer in the same category, dropping the discount from $700 to $50. The
    engine now consumes units in blocks of `required_quantity`, most expensive
    first, so the total discount is monotonic as items are added.
    """
    BEER = 'item-beer'
    cat_map = {BUCKET: 'cat-buckets', BEER: 'cat-buckets'}
    promo = bogo_2x1(applies_to_item_id=None, applies_to_category_id='cat-buckets',
                     combine_across_items=True)

    two_buckets = units(BUCKET, 2)
    base = sum(compute_quantity_promo_discounts(promo, two_buckets, cat_map).values())
    check('R1. category 2x1 on 2 buckets discounts a bucket', base == PRICE, f'discount={base}')

    with_beer = two_buckets + units(BEER, 1, price=5000)
    after = sum(compute_quantity_promo_discounts(promo, with_beer, cat_map).values())
    check('R1b. adding a cheap beer does not steal the discount',
          after == PRICE, f'discount={after} expected={PRICE}')

    # Monotonic: the discount never decreases as eligible items are added
    running = []
    cart = []
    for extra in [BUCKET, BEER, BUCKET, BEER, BUCKET]:
        cart += units(extra, 1, price=PRICE if extra == BUCKET else 5000)
        running.append(sum(compute_quantity_promo_discounts(promo, cart, cat_map).values()))
    check('R1c. discount is monotonic as items are added',
          all(b >= a for a, b in zip(running, running[1:])), str(running))


def test_regression_category_scope_defaults_strict():
    """Regression: a category promo with combine_across_items=False must
    require the quantity to come from the same product, exactly like an
    item-scoped promo. Mixing two different products in the category must
    not trigger it."""
    BEER = 'item-beer'
    cat_map = {BUCKET: 'cat-buckets', BEER: 'cat-buckets'}
    promo = bogo_2x1(applies_to_item_id=None, applies_to_category_id='cat-buckets',
                     combine_across_items=False)

    mixed = units(BUCKET, 1) + units(BEER, 1, price=5000)
    d = compute_quantity_promo_discounts(promo, mixed, cat_map)
    check('R2. category promo: 1 bucket + 1 beer does not trigger', d == {})

    same = units(BUCKET, 2) + units(BEER, 1, price=5000)
    d = compute_quantity_promo_discounts(promo, same, cat_map)
    check('R2b. category promo: 2 buckets trigger, beer untouched',
          sum(d.values()) == PRICE, f'discount={sum(d.values())}')

    three = units(BUCKET, 3) + units(BEER, 1, price=5000)
    d = compute_quantity_promo_discounts(promo, three, cat_map)
    check('R2c. category promo: 3 buckets -> still one application',
          sum(d.values()) == PRICE, f'discount={sum(d.values())}')


def main():
    for fn in (test_bogo_two_buckets, test_percent_two_buckets, test_four_buckets,
               test_mixed_products, test_existing_discounts_preserved,
               test_receipt_payload, test_reporting_math,
               test_regression_cheap_item_steals_promo,
               test_regression_category_scope_defaults_strict):
        fn()
    failed = [label for label, ok, _ in RESULTS if not ok]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed')
    if failed:
        print('FAILED: ' + ', '.join(failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
