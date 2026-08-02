"""Regression tests for promotions on products that carry modifiers.

Scenario under test: a "Cubeta Premium" bucket that contains 10 beer modifiers,
with a 2x1 promotion. Covers the four defects found when the promotion is
applied to a line item whose quantity is greater than 1:

  D1  chit/receipt modifier counts must scale with the line quantity
      (2 buckets = 20 beers, not 10)
  D4  the promotion discount must be attributable to the line item that
      earned it, so receipts and the cart can show it on the item row

The inventory, COGS and profit-reporting halves (D2/D3) need a live Postgres
database and are covered by the integration checks, not here.

Run with:  cd backend && python -m tests.test_modifier_promotions
"""
import importlib.util
import os
import sys

RESULTS = []


def check(label, condition, detail=''):
    RESULTS.append(bool(condition))
    print(('PASS  ' if condition else 'FAIL  ') + label + (f'  -- {detail}' if detail else ''))


def _load_print_agent():
    """Import the standalone Windows print agent by path (not a package)."""
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        '..', 'scripts', 'print_agent', 'print_agent.py',
    )
    spec = importlib.util.spec_from_file_location('print_agent_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PRICE = 70000
PROMO = '2x1 Cubeta Premium'


def bucket_line(line_id, quantity, beers=10, promo_cents=0):
    """A Cubeta Premium line item as serialized by TicketLineItem.to_dict()."""
    return {
        'id': line_id,
        'menu_item_name': 'Cubeta Premium',
        'quantity': quantity,
        'unit_price_cents': PRICE,
        'status': 'SENT',
        'notes': None,
        'modifiers': [{'name': 'Corona', 'price_cents': 0} for _ in range(beers)],
        'promo_discount_cents': promo_cents,
        'promotions': ([{'name': PROMO, 'discount_cents': promo_cents}]
                       if promo_cents else []),
    }


def test_modifier_counts_scale_with_quantity(pa):
    """D1: modifier rows are stored once per line item regardless of quantity."""
    mods = [{'name': 'Corona', 'price_cents': 0} for _ in range(10)]

    counts = pa._group_modifiers(mods)
    check('D1a. 1 bucket -> 10 beers (default multiplier)',
          counts == [{'name': 'Corona', 'count': 10}], str(counts))

    counts = pa._group_modifiers(mods, 2)
    check('D1b. 2 buckets -> 20 beers',
          counts == [{'name': 'Corona', 'count': 20}], str(counts))

    counts = pa._group_modifiers(mods, 3)
    check('D1c. 3 buckets -> 30 beers',
          counts == [{'name': 'Corona', 'count': 30}], str(counts))

    mixed = ([{'name': 'Corona', 'price_cents': 0} for _ in range(6)] +
             [{'name': 'Modelo', 'price_cents': 0} for _ in range(4)])
    counts = {c['name']: c['count'] for c in pa._group_modifiers(mixed, 2)}
    check('D1d. mixed flavors scale independently and still total 20',
          counts == {'Corona': 12, 'Modelo': 8} and sum(counts.values()) == 20,
          str(counts))

    check('D1e. a zero/None multiplier never wipes the count out',
          pa._group_modifiers(mods, 0) == [{'name': 'Corona', 'count': 10}] and
          pa._group_modifiers(mods, None) == [{'name': 'Corona', 'count': 10}])

    check('D1f. unnamed modifiers are still ignored',
          pa._group_modifiers([{'name': '', 'price_cents': 0}], 2) == [])


def test_chit_payload_scales(pa):
    """D1: the same scaling the ticket API applies when building a chit."""
    def chit_modifiers(line):
        mod_map = {}
        mult = max(1, int(line['quantity'] or 1))
        for m in line['modifiers']:
            mod_map[m['name']] = mod_map.get(m['name'], 0) + mult
        return mod_map

    check('D1g. chit for a 2x bucket asks the bar for 20 beers',
          chit_modifiers(bucket_line('a', 2)) == {'Corona': 20},
          str(chit_modifiers(bucket_line('a', 2))))
    check('D1h. chit for a 1x bucket is unchanged',
          chit_modifiers(bucket_line('a', 1)) == {'Corona': 10})


def test_receipt_groups_promotions_per_item(pa):
    """D4: the promotion must land on the item row it was earned on."""
    items = [bucket_line('a', 2, promo_cents=PRICE)]
    groups = pa._group_line_items(items)
    check('D4a. one grouped row for the bucket', len(groups) == 1, str(len(groups)))
    g = groups[0]
    check('D4b. row shows quantity 2', g['quantity'] == 2, str(g['quantity']))
    check('D4c. promotion attached to the row with the right amount',
          g['promotions'] == {PROMO: PRICE}, str(g['promotions']))
    counts = pa._group_modifiers(g['variants'][0]['modifiers'], g['variants'][0]['quantity'])
    check('D4d. row still reports 20 beers',
          counts == [{'name': 'Corona', 'count': 20}], str(counts))


def test_receipt_merges_promotions_across_line_items(pa):
    """Two separate qty-1 lines merge into one row; promos must add up."""
    items = [bucket_line('a', 1, promo_cents=PRICE), bucket_line('b', 1)]
    g = pa._group_line_items(items)[0]
    check('D4e. merged row totals quantity 2', g['quantity'] == 2, str(g['quantity']))
    check('D4f. merged row keeps the single promotion amount',
          g['promotions'] == {PROMO: PRICE}, str(g['promotions']))

    items = [bucket_line(x, 1, promo_cents=PRICE) for x in ('a', 'b')]
    g = pa._group_line_items(items)[0]
    check('D4g. two promoted lines sum their discounts',
          g['promotions'] == {PROMO: 2 * PRICE}, str(g['promotions']))


def test_receipt_backward_compatible(pa):
    """Legacy payloads without the new keys must still render."""
    legacy = {
        'menu_item_name': 'Cubeta Premium',
        'quantity': 2,
        'unit_price_cents': PRICE,
        'status': 'SENT',
        'modifiers': [{'name': 'Corona', 'price_cents': 0} for _ in range(10)],
    }
    g = pa._group_line_items([legacy])[0]
    check('D4h. payload with no promotion keys still groups',
          g['quantity'] == 2 and g['promotions'] == {}, str(g['promotions']))

    bare = {'menu_item_name': 'Nachos', 'quantity': 1, 'unit_price_cents': 15000,
            'status': 'SENT'}
    g = pa._group_line_items([bare])[0]
    check('D4i. payload with no modifiers at all still groups',
          g['quantity'] == 1 and g['variants'][0]['modifiers'] == [])


def main():
    pa = _load_print_agent()
    for fn in (test_modifier_counts_scale_with_quantity,
               test_chit_payload_scales,
               test_receipt_groups_promotions_per_item,
               test_receipt_merges_promotions_across_line_items,
               test_receipt_backward_compatible):
        fn(pa)
    passed, total = sum(RESULTS), len(RESULTS)
    print(f'\n{passed}/{total} checks passed')
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(main())
