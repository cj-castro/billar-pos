"""Entering and correcting costs; restating past $0 cost rows.

Owner actions on Analítica → Costos (and the inventory screen):

1. set_cost(): give an item its cost the way it is BOUGHT -- "$350 per case of
   24" -- and let the system do the division (1458.3333 ¢ per can, exact; see
   migration 044). Two modes:
     * INICIAL     the item had no cost. No reason needed.
     * CORRECCION  the item already had a cost that is wrong (e.g. a box costed
                   at $0.91). ADMIN only, reason required, audited. Before this
                   existed a wrong cost could only be "fixed" by restocking,
                   which BLENDS it into the average instead of replacing it.
   Routine price changes are NOT corrections: they come in through
   Reabastecer at the new price and average in, as before.
   A bottle's / box's cost also sets its shots' / loose items' cost
   (parent ÷ units per parent), since that is the only way they get a cost.
   Past sales keep the cost they were recorded at.

2. restate(): fill historical sale_item_costs rows captured at $0 with the
   item's CURRENT cost so past periods become analysable. A current-cost
   estimate, so every restated row is stamped cost_restated_at and the
   dashboards report the share (reexpresado_pct). Rows that had a cost at the
   time are never touched.
"""
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import text

from app.extensions import db
from app.models.inventory import InventoryConversion, InventoryItem

_Q = Decimal('0.0001')


class CostAlreadySet(ValueError):
    pass


def _d(v) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v))


def unit_cost_from(item: InventoryItem, *, unit_cost_cents=None,
                   purchase_cost_cents=None, pack_size=None) -> Decimal:
    """Exact cost per BASE unit (centavos, 4 dp) from what the owner typed.

    purchase_cost_cents is the price of one PURCHASE unit (a case, a bottle of
    3,780 ml...); pack_size overrides the item's purchase_pack_size for this
    entry (a supplier sends 12s one week and 24s the next).
    """
    if purchase_cost_cents is not None:
        price = _d(purchase_cost_cents)
        pack = _d(pack_size if pack_size not in (None, '') else (item.purchase_pack_size or 1))
        if pack <= 0:
            raise ValueError('Las unidades por paquete deben ser mayores a 0')
        from app.services.inventory_svc import assert_pack
        assert_pack(item.base_unit_key, item.purchase_unit_key, pack, same_unit_strict=False)
        unit = price / pack
    elif unit_cost_cents is not None:
        unit = _d(unit_cost_cents)
    else:
        raise ValueError('Indica el costo (por paquete o por unidad)')
    if unit <= 0:
        raise ValueError('El costo debe ser mayor a $0')
    return unit.quantize(_Q, rounding=ROUND_HALF_UP)


def set_cost(item_id: str, *, unit_cost_cents=None, purchase_cost_cents=None,
             pack_size=None, reason: str | None = None) -> dict:
    """Set (first time) or correct (with a reason) an item's unit cost.

    Caller checks the role, commits and audits. Returns
    {'item', 'mode', 'before', 'after', 'children': [(child, before, after)]}.
    """
    item = InventoryItem.query.with_for_update().populate_existing().get(item_id)
    if item is None:
        raise ValueError('NOT_FOUND: InventoryItem not found')

    unit = unit_cost_from(item, unit_cost_cents=unit_cost_cents,
                          purchase_cost_cents=purchase_cost_cents, pack_size=pack_size)
    before = _d(item.unit_cost_cents or 0)
    mode = 'INICIAL' if before <= 0 else 'CORRECCION'
    if mode == 'CORRECCION' and not (reason and reason.strip()):
        raise CostAlreadySet(
            f'"{item.name}" ya tiene costo (${before / 100:,.4f} por unidad). Para corregirlo '
            f'indica el motivo. Si solo cambió el precio, usa Reabastecer al precio nuevo.')

    now = datetime.now(timezone.utc)
    item.unit_cost_cents = unit
    if purchase_cost_cents is not None:
        item.purchase_cost_cents = int(_d(purchase_cost_cents).to_integral_value(ROUND_HALF_UP))
    item.updated_at = now

    # Shots / loose items get their cost from their bottle / box. On a first
    # cost only unpriced children are filled; on a correction they follow the
    # parent, because their current cost was derived from the wrong one.
    children = []
    for conv in InventoryConversion.query.filter_by(from_item_id=item.id, is_active=True).all():
        child = InventoryItem.query.with_for_update().populate_existing().get(conv.to_item_id)
        if child is None:
            continue
        child_before = _d(child.unit_cost_cents or 0)
        if mode == 'INICIAL' and child_before > 0:
            continue
        per_unit = (unit / (_d(conv.ratio) * (1 - _d(conv.loss_factor or 0)))).quantize(
            _Q, rounding=ROUND_HALF_UP)
        if per_unit > 0 and per_unit != child_before:
            children.append((child, child_before, per_unit))
            child.unit_cost_cents = per_unit
            child.updated_at = now

    db.session.flush()
    return {'item': item, 'mode': mode, 'before': before, 'after': unit, 'children': children}


# Backwards-compatible name used by batch B callers.
def set_initial_cost(item_id: str, unit_cost_cents) -> dict:
    return set_cost(item_id, unit_cost_cents=unit_cost_cents)


_RESTATABLE = """
    FROM sale_item_costs s
    JOIN inventory_items ii ON ii.id = s.inventory_item_id
    WHERE COALESCE(s.total_cost_cents, 0) = 0
      AND COALESCE(ii.unit_cost_cents, 0) > 0
      AND COALESCE(s.quantity_deducted, 0) > 0
"""


def restate_preview() -> dict:
    row = db.session.execute(text(f"""
        SELECT count(*)                                         AS filas,
               count(DISTINCT s.ticket_line_item_id)            AS lineas,
               COALESCE(sum(round(s.quantity_deducted * ii.unit_cost_cents)), 0)
                                                                AS nuevo_costo_cents
        {_RESTATABLE}
    """)).mappings().first()
    still_zero = db.session.execute(text("""
        SELECT count(*) FROM inventory_items
        WHERE COALESCE(is_active, TRUE) AND COALESCE(unit_cost_cents, 0) = 0
    """)).scalar()
    return {
        'filas': int(row['filas']),
        'lineas': int(row['lineas']),
        'nuevo_costo_cents': int(row['nuevo_costo_cents']),
        'insumos_sin_costo': int(still_zero),
    }


def restate() -> int:
    """Fill restatable $0 rows with today's cost and stamp them. Caller commits."""
    result = db.session.execute(text("""
        UPDATE sale_item_costs s
           SET unit_cost_cents  = ii.unit_cost_cents,
               total_cost_cents = round(s.quantity_deducted * ii.unit_cost_cents),
               cost_restated_at = clock_timestamp()
          FROM inventory_items ii
         WHERE ii.id = s.inventory_item_id
           AND COALESCE(s.total_cost_cents, 0) = 0
           AND COALESCE(ii.unit_cost_cents, 0) > 0
           AND COALESCE(s.quantity_deducted, 0) > 0
    """))
    return result.rowcount
