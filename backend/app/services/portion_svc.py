"""Portioning in house (batch E8): raw by the kilo -> packs.

A raw item (stocked in kg / g / l / ml, bought by the case) feeds one or more
pack items (base unit "paquete", portion_size = grams or ml per pack,
portion_source_id = the raw item). Packs are not restocked: they come from
portioning, which records

    raw used (kg)  ->  packs out per size  =  output (g)  +  waste (g)
    yield % = output / raw used
    the raw's cost for what was used, spread over the packs BY WEIGHT, so each
    pack carries its share of the waste (a 700 g pack costs more than 0.7 kg
    of the case's price when the case yields 94%).

Ledger: PRODUCTION_CONSUME on the raw item, PRODUCTION_YIELD on each pack -- an
internal move, like opening a bottle; sales keep deducting 1 pack.
"""
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import text

from app.extensions import db
from app.models.inventory import InventoryItem
from app.services.inventory_svc import _compute_wac, _d, _exact_cost, _lock_sorted, _now, _write_movement

# grams (or ml) per unit of the raw item's stock unit
FACTOR = {'kilogramo': Decimal(1000), 'gramo': Decimal(1), 'litro': Decimal(1000), 'ml': Decimal(1)}
OVER_TOLERANCE = Decimal('1.02')     # packs may weigh up to 2% more than the raw used (scale error)


def _size_unit(raw: InventoryItem) -> str:
    return 'ml' if raw.base_unit_key in ('litro', 'ml') else 'gramo'


def link_portion(item: InventoryItem, raw: InventoryItem | None, size) -> dict:
    """Make `item` a pack of `size` g/ml cut from `raw` -- or unlink (raw None).
    The item's stock unit becomes "paquete" (its count does not change: a pack
    was already one piece)."""
    before = {'portion_source_id': item.portion_source_id,
              'portion_size': float(item.portion_size) if item.portion_size else None}
    if raw is None:
        item.portion_source_id = None
        if item.stock_nature == 'PORTION':
            item.stock_nature = 'SIMPLE'
        return {'before': before, 'after': {'portion_source_id': None}}
    if raw.id == item.id:
        raise ValueError('BAD_PORTION: un artículo no se porciona de sí mismo')
    if raw.base_unit_key not in FACTOR:
        raise ValueError('BAD_PORTION: lo que se porciona se guarda en kg, g, litros o ml')
    if raw.portion_source_id:
        raise ValueError(f'BAD_PORTION: "{raw.name}" ya es un paquete; elige el producto crudo')
    try:
        size = _d(size)
    except Exception:
        raise ValueError('BAD_PORTION: escribe el peso del paquete')
    if size <= 0 or size > 100000:
        raise ValueError('BAD_PORTION: el peso del paquete va de 1 a 100,000 g')
    item.portion_source_id = raw.id
    item.portion_size = size
    item.portion_unit_key = _size_unit(raw)
    item.base_unit_key = 'paquete'
    item.unit = 'paquete'
    item.stock_nature = 'PORTION'
    if raw.stock_nature in (None, 'SIMPLE'):
        raw.stock_nature = 'BULK'
    return {'before': before, 'after': {'portion_source_id': raw.id, 'portion_size': float(size)}}


def portions_of(raw_id: str) -> list[InventoryItem]:
    return (InventoryItem.query.filter_by(portion_source_id=raw_id, is_active=True)
            .order_by(InventoryItem.portion_size).all())


def portion(raw_id: str, raw_used, outputs: list[dict], performed_by: str, notes: str | None = None) -> dict:
    """outputs = [{'item_id': ..., 'packs': 14}, ...]. Caller commits."""
    raw0 = InventoryItem.query.get(raw_id)
    if raw0 is None:
        raise ValueError('NOT_FOUND: no existe ese producto')
    if raw0.base_unit_key not in FACTOR:
        raise ValueError('BAD_PORTION: este producto no se porciona (no se guarda en kg / g / l / ml)')
    try:
        used = _d(raw_used)
    except Exception:
        raise ValueError('BAD_QTY: escribe cuánto se usó')
    if used <= 0:
        raise ValueError('BAD_QTY: escribe cuánto se usó (más de 0)')
    clean = []
    for o in outputs or []:
        try:
            packs = int(o.get('packs') or 0)
        except (TypeError, ValueError):
            raise ValueError('BAD_QTY: los paquetes se cuentan en números enteros')
        if packs < 0 or _d(o.get('packs') or 0) != packs:
            raise ValueError('BAD_QTY: los paquetes se cuentan en números enteros')
        if packs:
            clean.append((o.get('item_id'), packs))
    if not clean:
        raise ValueError('BAD_QTY: anota cuántos paquetes salieron')

    locked = _lock_sorted(raw_id, *[i for i, _ in clean])
    raw = locked[raw_id]
    if used > _d(raw.stock_quantity):
        raise ValueError(f'NO_STOCK: hay {_d(raw.stock_quantity).normalize():f} '
                         f'{raw.base_unit_key} de "{raw.name}"; no alcanza para {used.normalize():f}')
    items = []
    for iid, packs in clean:
        it = locked[iid]
        if it.portion_source_id != raw.id or not it.portion_size:
            raise ValueError(f'BAD_PORTION: "{it.name}" no es un paquete de "{raw.name}"')
        items.append((it, packs, _d(it.portion_size)))

    factor = FACTOR[raw.base_unit_key]
    used_g = used * factor
    output_g = sum(Decimal(p) * s for _, p, s in items)
    if output_g > used_g * OVER_TOLERANCE:
        raise ValueError(f'TOO_MUCH: salen {output_g.normalize():f} g en paquetes pero entraron '
                         f'{used_g.normalize():f} g; revisa los paquetes o lo que se usó')
    waste_g = max(used_g - output_g, Decimal(0))
    yield_pct = (output_g / used_g * 100).quantize(Decimal('0.01'))
    raw_cost = _exact_cost(raw.unit_cost_cents)                 # per kg (raw unit)
    input_cost = used * raw_cost                                # centavos, exact

    count = db.session.execute(text("SELECT COALESCE(MAX(batch_number), 0) + 1 FROM portion_batches")).scalar()
    reason = f'Porcionado #{count}'
    raw.stock_quantity = _d(raw.stock_quantity) - used
    raw.updated_at = _now()
    _write_movement(raw, 'PRODUCTION_CONSUME', -used, performed_by, unit_cost_cents=raw_cost, reason=reason)

    batch_id = db.session.execute(text("""
        INSERT INTO portion_batches (raw_item_id, raw_used, raw_used_g, output_g, waste_g, yield_pct,
                                     input_cost_cents, performed_by, notes)
        VALUES (:r, :u, :ug, :og, :w, :y, :c, :p, :n) RETURNING id"""),
        {'r': raw.id, 'u': used, 'ug': used_g, 'og': output_g, 'w': waste_g, 'y': yield_pct,
         'c': int(input_cost.to_integral_value(rounding=ROUND_HALF_UP)), 'p': performed_by,
         'n': (notes or '').strip() or None}).scalar()

    out = []
    for it, packs, size in items:
        # the case's cost spread by weight: the waste is paid by the packs
        pack_cost = (input_cost * size / output_g).quantize(Decimal('0.0001')) if output_g else Decimal(0)
        it.unit_cost_cents = _compute_wac(_d(it.stock_quantity), it.unit_cost_cents, Decimal(packs), pack_cost)
        it.stock_quantity = _d(it.stock_quantity) + packs
        it.updated_at = _now()
        _write_movement(it, 'PRODUCTION_YIELD', Decimal(packs), performed_by, unit_cost_cents=pack_cost,
                        reference_id=batch_id, reason=reason)
        db.session.execute(text("""
            INSERT INTO portion_batch_outputs (batch_id, item_id, packs, pack_size, unit_cost_cents)
            VALUES (:b, :i, :n, :s, :c)"""), {'b': batch_id, 'i': it.id, 'n': packs, 's': size, 'c': pack_cost})
        out.append({'item_id': it.id, 'name': it.name, 'packs': packs, 'pack_size': float(size),
                    'pack_cost_cents': float(pack_cost)})
    db.session.flush()
    return {'batch_id': batch_id, 'batch_number': count, 'raw': raw.name, 'raw_used': float(used),
            'raw_used_g': float(used_g), 'output_g': float(output_g), 'waste_g': float(waste_g),
            'yield_pct': float(yield_pct), 'input_cost_cents': int(input_cost.to_integral_value()),
            'outputs': out}


def history(f, t) -> dict:
    rows = db.session.execute(text("""
        SELECT b.id, b.batch_number, b.created_at, r.name AS raw, r.base_unit_key AS unit, b.raw_used,
               b.raw_used_g, b.output_g, b.waste_g, b.yield_pct, b.input_cost_cents, u.name AS por, b.notes
          FROM portion_batches b JOIN inventory_items r ON r.id = b.raw_item_id
          LEFT JOIN users u ON u.id = b.performed_by
         WHERE b.created_at BETWEEN :f AND :t ORDER BY b.created_at DESC"""), {'f': f, 't': t}).mappings().all()
    outs = {}
    if rows:
        for o in db.session.execute(text("""
            SELECT o.batch_id, i.name, o.packs, o.pack_size, o.unit_cost_cents
              FROM portion_batch_outputs o JOIN inventory_items i ON i.id = o.item_id
             WHERE o.batch_id = ANY(:ids) ORDER BY o.pack_size"""), {'ids': [r['id'] for r in rows]}).mappings():
            outs.setdefault(o['batch_id'], []).append({'name': o['name'], 'packs': o['packs'],
                                                       'pack_size': float(o['pack_size']),
                                                       'pack_cost_cents': float(o['unit_cost_cents'])})
    por_producto = {}
    for r in rows:
        p = por_producto.setdefault(r['raw'], {'raw': r['raw'], 'lotes': 0, 'used_g': 0.0, 'output_g': 0.0})
        p['lotes'] += 1
        p['used_g'] += float(r['raw_used_g'])
        p['output_g'] += float(r['output_g'])
    for p in por_producto.values():
        p['yield_pct'] = round(p['output_g'] / p['used_g'] * 100, 2) if p['used_g'] else None
    return {
        'lotes': [{**{k: r[k] for k in ('id', 'batch_number', 'raw', 'unit', 'por', 'notes')},
                   'created_at': r['created_at'].isoformat(), 'raw_used': float(r['raw_used']),
                   'raw_used_g': float(r['raw_used_g']), 'output_g': float(r['output_g']),
                   'waste_g': float(r['waste_g']), 'yield_pct': float(r['yield_pct']),
                   'input_cost_cents': int(r['input_cost_cents']), 'salidas': outs.get(r['id'], [])}
                  for r in rows],
        'por_producto': sorted(por_producto.values(), key=lambda x: x['raw']),
    }
