"""Open bottles and the blind bar count (batch E2, step 2).

Sales draw from each spirit's pooled ml (oldest bottle first). The open_bottles
rows are what a closer physically counts: for each open bottle, "Vacía / ¼ / ½ /
¾ / Llena" (or exact ml), plus the sealed bottles on the shelf. The count is
BLIND -- the screen never shows what the system expects -- and every difference
is written to the ledger as a COUNT_ADJUSTMENT and valued in pesos for the owner.
"""
import json
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import text

from app.extensions import db

FRACTIONS = {'EMPTY': Decimal(0), 'QUARTER': Decimal('0.25'), 'HALF': Decimal('0.5'),
             'THREE_QUARTERS': Decimal('0.75'), 'FULL': Decimal(1)}


def _d(v) -> Decimal:
    return Decimal(str(v or 0))


def _rows(sql, **kw):
    return db.session.execute(text(sql), kw).mappings().all()


def open_bottles_of(shot_item_id: str) -> list[dict]:
    return [dict(r) for r in _rows("""
        SELECT id, size_ml, opened_at, notes FROM open_bottles
         WHERE shot_item_id = :s AND finished_at IS NULL ORDER BY opened_at, id""", s=shot_item_id)]


def expected_per_bottle(bottles: list[dict], pooled) -> dict:
    """Split the pooled ml over the open bottles, oldest consumed first: the
    newest is filled first and the oldest gets what is left (plus any excess)."""
    left, out = _d(pooled), {}
    for b in reversed(bottles):
        take = min(_d(b['size_ml']), max(left, Decimal(0)))
        out[b['id']] = take
        left -= take
    if bottles and left > 0:
        out[bottles[0]['id']] += left
    return out


def finish_empty(shot_item_id: str, user_id: str | None) -> int:
    """Close open-bottle records the books say are empty (expected 0 ml)."""
    bottles = open_bottles_of(shot_item_id)
    pooled = db.session.execute(text("SELECT stock_quantity FROM inventory_items WHERE id = :i"),
                                {'i': shot_item_id}).scalar()
    exp = expected_per_bottle(bottles, pooled)
    empty = [b['id'] for b in bottles if exp.get(b['id'], 0) <= 0]
    if empty:
        db.session.execute(text("""
            UPDATE open_bottles SET finished_at = clock_timestamp(), finished_by = :u,
                   notes = COALESCE(notes || ' · ', '') || 'vacía según el sistema'
             WHERE id = ANY(:ids)"""), {'u': user_id, 'ids': empty})
    return len(empty)


def spirits(with_expected: bool = False) -> list[dict]:
    """Every openable bottle product with its open bottles, for the count screen.

    Blind by default: no stock, no expected amounts. with_expected=True (owner
    views) adds the pooled ml, the per-bottle estimate and the sealed stock.
    """
    out = []
    for r in _rows("""
        SELECT c.from_item_id AS bottle_id, b.name AS bottle_name, b.stock_quantity AS sealed,
               c.to_item_id AS shot_id, s.name AS shot_name, s.portion_size AS pour_ml,
               s.stock_quantity AS pooled_ml, c.ratio AS bottle_ml
          FROM inventory_conversions c
          JOIN inventory_items b ON b.id = c.from_item_id
          JOIN inventory_items s ON s.id = c.to_item_id
         WHERE c.is_active AND c.conversion_type = 'BOTTLE_TO_SHOT' AND COALESCE(b.is_active, TRUE)
         ORDER BY b.name"""):
        bottles = open_bottles_of(r['shot_id'])
        item = {'bottle_item_id': r['bottle_id'], 'name': r['bottle_name'],
                'shot_item_id': r['shot_id'], 'bottle_ml': float(r['bottle_ml']),
                'pour_ml': float(r['pour_ml']) if r['pour_ml'] else None,
                'open_bottles': [{'id': b['id'], 'size_ml': float(b['size_ml']),
                                  'opened_at': b['opened_at'].isoformat() if b['opened_at'] else None}
                                 for b in bottles]}
        if with_expected:
            exp = expected_per_bottle(bottles, r['pooled_ml'])
            item['pooled_ml'] = float(r['pooled_ml'])
            item['sealed'] = float(r['sealed'])
            for b in item['open_bottles']:
                b['expected_ml'] = float(exp.get(b['id'], 0))
        out.append(item)
    return out


def _bottle_ml(entry: dict, size: Decimal) -> Decimal:
    if entry.get('ml') not in (None, ''):
        ml = _d(entry['ml'])
    elif entry.get('fraction') in FRACTIONS:
        ml = (size * FRACTIONS[entry['fraction']])
    else:
        raise ValueError('BAD_COUNT: cada botella abierta necesita Vacía / ¼ / ½ / ¾ / Llena o los ml')
    if ml < 0 or ml > size:
        raise ValueError(f'BAD_COUNT: {ml} ml no cabe en una botella de {size} ml')
    return ml.quantize(Decimal('0.01'))


def _count_to(item_id: str, qty: Decimal, user_id: str, note: str) -> None:
    db.session.execute(text("SELECT fn_count_adjustment(:i, :q, :u, :n)"),
                       {'i': item_id, 'q': qty, 'u': user_id, 'n': note})


def submit(user_id: str, spirits_counted: list[dict], notes: str | None = None) -> dict:
    """Post a bar count. Each entry:

        {"shot_item_id": ..., "bottles": [{"id": <open_bottle_id>, "fraction": "HALF"} | {"id":..., "ml": 320}],
         "sealed": 4}          # sealed bottles on the shelf (optional)

    Every open bottle of a counted spirit must be listed. Writes COUNT_ADJUSTMENT
    movements for any difference, closes bottles counted empty, and returns the
    variance per item (the API shows it to the owner only).
    """
    if not spirits_counted:
        raise ValueError('BAD_COUNT: no hay nada que contar')
    now = datetime.now(timezone.utc)
    session_id = db.session.execute(text(
        "SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")).scalar()
    count_id = db.session.execute(text("""
        INSERT INTO bar_counts (counted_by, cash_session_id, notes) VALUES (:u, :s, :n) RETURNING id"""),
        {'u': user_id, 's': session_id, 'n': notes}).scalar()
    from app.services.venue_svc import bar_tz
    note = f'Conteo de barra {now.astimezone(bar_tz()).strftime("%Y-%m-%d %H:%M")}'
    lines, total = [], 0

    def line(item_id, kind, expected, counted, cost, detail=None):
        nonlocal total
        var = counted - expected
        cents = int((var * cost).to_integral_value(rounding=ROUND_HALF_UP))
        total += cents
        db.session.execute(text("""
            INSERT INTO bar_count_lines (bar_count_id, inventory_item_id, kind, expected_qty, counted_qty,
                                         variance_qty, unit_cost_cents, variance_cents, detail)
            VALUES (:c, :i, :k, :e, :q, :v, :uc, :vc, CAST(:d AS jsonb))"""),
            {'c': count_id, 'i': item_id, 'k': kind, 'e': expected, 'q': counted, 'v': var,
             'uc': cost, 'vc': cents, 'd': json.dumps(detail) if detail else None})
        lines.append({'inventory_item_id': item_id, 'kind': kind, 'expected': float(expected),
                      'counted': float(counted), 'variance': float(var), 'variance_cents': cents})

    for sp in spirits_counted:
        shot_id = sp.get('shot_item_id')
        conv = db.session.execute(text("""
            SELECT c.from_item_id FROM inventory_conversions c
             WHERE c.to_item_id = :s AND c.is_active AND c.conversion_type = 'BOTTLE_TO_SHOT'"""),
            {'s': shot_id}).scalar()
        if conv is None:
            raise ValueError('BAD_COUNT: ese licor no sale de una botella')
        # Lock both items so no sale moves stock between "expected" and the adjustment.
        db.session.execute(text("SELECT 1 FROM inventory_items WHERE id IN (:a, :b) ORDER BY id FOR UPDATE"),
                           {'a': shot_id, 'b': conv})
        shot = db.session.execute(text("SELECT name, stock_quantity, unit_cost_cents FROM inventory_items WHERE id=:i"),
                                  {'i': shot_id}).mappings().one()
        bottles = open_bottles_of(shot_id)
        given = {b.get('id'): b for b in (sp.get('bottles') or [])}
        missing = [b for b in bottles if b['id'] not in given]
        if missing:
            raise ValueError(f'BAD_COUNT: faltan botellas abiertas de {shot["name"]} por contar')
        unknown = set(given) - {b['id'] for b in bottles}
        if unknown:
            raise ValueError('BAD_COUNT: una botella contada ya no está abierta; recarga la pantalla')

        expected = _d(shot['stock_quantity'])
        exp_each = expected_per_bottle(bottles, expected)
        detail, counted = [], Decimal(0)
        for b in bottles:
            ml = _bottle_ml(given[b['id']], _d(b['size_ml']))
            counted += ml
            detail.append({'open_bottle_id': b['id'], 'size_ml': float(b['size_ml']),
                           'counted_ml': float(ml), 'expected_ml': float(exp_each[b['id']])})
            if ml <= 0:
                db.session.execute(text("""UPDATE open_bottles SET finished_at = :t, finished_by = :u,
                    last_count_ml = 0, last_counted_at = :t WHERE id = :i"""), {'t': now, 'u': user_id, 'i': b['id']})
            else:
                db.session.execute(text("""UPDATE open_bottles SET last_count_ml = :m, last_counted_at = :t
                    WHERE id = :i"""), {'m': ml, 't': now, 'i': b['id']})
        if counted != expected:
            _count_to(shot_id, counted, user_id, note)
        line(shot_id, 'OPEN', expected, counted, _d(shot['unit_cost_cents']), detail)

        if sp.get('sealed') not in (None, ''):
            try:
                sealed = int(sp['sealed'])
            except (TypeError, ValueError):
                raise ValueError('BAD_COUNT: las botellas cerradas se cuentan en números enteros')
            if sealed < 0 or Decimal(str(sp['sealed'])) != sealed:
                raise ValueError('BAD_COUNT: las botellas cerradas se cuentan en números enteros')
            b = db.session.execute(text("SELECT stock_quantity, unit_cost_cents FROM inventory_items WHERE id=:i"),
                                   {'i': conv}).mappings().one()
            if Decimal(sealed) != _d(b['stock_quantity']):
                _count_to(conv, Decimal(sealed), user_id, note)
            line(conv, 'SEALED', _d(b['stock_quantity']), Decimal(sealed), _d(b['unit_cost_cents']))

    db.session.execute(text("UPDATE bar_counts SET total_variance_cents = :t WHERE id = :c"),
                       {'t': total, 'c': count_id})
    db.session.flush()
    return {'id': count_id, 'total_variance_cents': total, 'lines': lines, 'cash_session_id': session_id}


def history(from_dt, to_dt) -> list[dict]:
    counts = _rows("""
        SELECT bc.id, bc.counted_at, bc.total_variance_cents, bc.notes, bc.cash_session_id,
               u.name AS counted_by
          FROM bar_counts bc LEFT JOIN users u ON u.id = bc.counted_by
         WHERE bc.counted_at BETWEEN :f AND :t ORDER BY bc.counted_at DESC""", f=from_dt, t=to_dt)
    out = []
    for c in counts:
        lines = _rows("""
            SELECT l.kind, i.name, i.base_unit_key AS unit, l.expected_qty, l.counted_qty, l.variance_qty,
                   l.variance_cents, l.detail
              FROM bar_count_lines l JOIN inventory_items i ON i.id = l.inventory_item_id
             WHERE l.bar_count_id = :c ORDER BY abs(l.variance_cents) DESC, i.name""", c=c['id'])
        out.append({**{k: c[k] for k in ('id', 'total_variance_cents', 'notes', 'cash_session_id', 'counted_by')},
                    'counted_at': c['counted_at'].isoformat(),
                    'lines': [{'kind': l['kind'], 'name': l['name'], 'unit': l['unit'],
                               'expected': float(l['expected_qty']), 'counted': float(l['counted_qty']),
                               'variance': float(l['variance_qty']), 'variance_cents': int(l['variance_cents']),
                               'detail': l['detail']} for l in lines]})
    return out
