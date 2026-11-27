"""Cash drawer count by denomination (pure functions: no Flask, no database).

Money is integer cents. A count is a dict {denomination key: quantity}.
"""
from typing import TypedDict


class Denom(TypedDict):
    key: str
    cents: int
    kind: str


# (key, cents, kind) in display order.
_MXN = (
    ('B1000', 100000, 'BILL'),
    ('B500', 50000, 'BILL'),
    ('B200', 20000, 'BILL'),
    ('B100', 10000, 'BILL'),
    ('B50', 5000, 'BILL'),
    ('B20', 2000, 'BILL'),
    ('C20', 2000, 'COIN'),
    ('C10', 1000, 'COIN'),
    ('C5', 500, 'COIN'),
    ('C2', 200, 'COIN'),
    ('C1', 100, 'COIN'),
    ('C0.50', 50, 'COIN'),
)
_TABLES = {'MXN': _MXN}


class CountError(ValueError):
    """code: UNKNOWN_DENOMINATION | NEGATIVE | NOT_INTEGER | LEFT_EXCEEDS_COUNTED."""

    def __init__(self, code, key=None):
        super().__init__(f'{code}: {key}' if key else code)
        self.code = code
        self.key = key


def denominations(currency):
    """Denomination table for a currency; [] when the currency has none. Fresh list each call."""
    return [{'key': k, 'cents': c, 'kind': kind} for k, c, kind in _TABLES.get(currency, ())]


def _cents_by_key(currency):
    return {k: c for k, c, _ in _TABLES.get(currency, ())}


def parse_lines(raw, currency):
    """[{'key','qty'}, ...] -> {key: qty}. Merges duplicates, drops zero rows."""
    cents = _cents_by_key(currency)
    out = {}
    for row in raw or []:
        key = row.get('key')
        if key not in cents:
            raise CountError('UNKNOWN_DENOMINATION', key)
        qty = row.get('qty')
        if type(qty) is not int:
            raise CountError('NOT_INTEGER', key)
        if qty < 0:
            raise CountError('NEGATIVE', key)
        out[key] = out.get(key, 0) + qty
    return {k: q for k, q in out.items() if q}


def total_cents(lines, currency):
    cents = _cents_by_key(currency)
    total = 0
    for key, qty in lines.items():
        if key not in cents:
            raise CountError('UNKNOWN_DENOMINATION', key)
        total += cents[key] * qty
    return total


def split(counted, left):
    """Envelope lines = counted - left per key."""
    for key, qty in left.items():
        if qty > counted.get(key, 0):
            raise CountError('LEFT_EXCEEDS_COUNTED', key)
    out = {k: q - left.get(k, 0) for k, q in counted.items()}
    return {k: q for k, q in out.items() if q}
