"""Inventory service layer — billar-pos inventory v2.

All public functions that modify stock must be called inside a transaction
managed by the caller (API endpoint or tickets service). The caller commits.

Concurrency strategy:
- Every stock read that precedes a write uses SELECT FOR UPDATE (pessimistic locking).
- When multiple rows must be locked, they are acquired in ascending id (UUID string)
  order to guarantee a consistent lock-acquisition sequence and prevent deadlock.
- lock_timeout is set at the session level by the API layer for long-wait protection.
"""
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone

from sqlalchemy import text

from app.extensions import db
from app.models.inventory import (
    InventoryItem,
    InventoryConversion,
    InventoryMovement,
    InsumoBase,
    ModifierInventoryRule,
    SaleItemCost,
    OpenCigaretteBox,
    UnitCatalog,
)
from app.models.menu import ModifierGroup


# ── Internal helpers ──────────────────────────────────────────────────────────

def _now():
    return datetime.now(timezone.utc)


def _d(value) -> Decimal:
    """Coerce any numeric value to Decimal for precision arithmetic."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _round_cents(value: Decimal) -> int:
    """Round a Decimal to the nearest integer centavo using ROUND_HALF_UP."""
    return int(value.quantize(Decimal('1'), rounding=ROUND_HALF_UP))


_COST_Q = Decimal('0.0001')


def _exact_cost(value) -> Decimal:
    """Unit cost in centavos with 4 decimals (NUMERIC(14,4), migration 044).

    Whole centavos per BASE unit were too coarse for anything stocked in ml or
    grams: catsup at 3.1746 ¢/ml was stored as 3 (5.5% low), cheap ingredients
    as 0 ("no cost"). Money TOTALS are still rounded to whole centavos, once,
    where a quantity is multiplied by this.
    """
    return _d(value or 0).quantize(_COST_Q, rounding=ROUND_HALF_UP)


def _compute_wac(old_qty: Decimal, old_wac_cents,
                 delta_qty: Decimal, new_unit_cost_cents) -> Decimal:
    """Return the new weighted average cost per base unit (centavos, 4 decimals).

    Formula: (old_qty * old_wac + delta_qty * new_cost) / (old_qty + delta_qty)
    If old_qty <= 0 the result is simply new_unit_cost_cents (no prior stock to weight).
    """
    old_qty = _d(old_qty)
    delta_qty = _d(delta_qty)

    if old_qty <= 0:
        return _exact_cost(new_unit_cost_cents)

    numerator   = old_qty * _d(old_wac_cents or 0) + delta_qty * _d(new_unit_cost_cents)
    denominator = old_qty + delta_qty
    return _exact_cost(numerator / denominator)


def _write_movement(
    item: InventoryItem,
    event_type: str,
    quantity_delta: Decimal,
    performed_by: str,
    *,
    unit_cost_cents: int = None,
    purchase_quantity: Decimal = None,
    purchase_unit_key: str = None,
    purchase_cost_cents: int = None,
    reference_id: str = None,
    reason: str = None,
) -> InventoryMovement:
    """Insert an InventoryMovement and flush to obtain its id.

    quantity_after is read from item.stock_quantity, so the caller MUST update
    item.stock_quantity BEFORE calling this function. The flush makes the movement
    id available immediately for SaleItemCost foreign key insertion.
    """
    mv = InventoryMovement(
        inventory_item_id   = item.id,
        event_type          = event_type,
        quantity_delta      = quantity_delta,
        quantity_after      = item.stock_quantity,
        unit_cost_cents     = unit_cost_cents,
        purchase_quantity   = purchase_quantity,
        purchase_unit_key   = purchase_unit_key,
        purchase_cost_cents = purchase_cost_cents,
        reference_id        = reference_id,
        reason              = reason,
        performed_by        = performed_by,
    )
    db.session.add(mv)
    db.session.flush()
    return mv


def _lock_one(item_id: str):
    """SELECT ... FOR UPDATE one InventoryItem and return it with FRESH values.

    populate_existing() is not optional. Without it, SQLAlchemy 2.x emits the
    FOR UPDATE (so the lock is taken) but, if the object is already in the
    session's identity map, keeps the attribute values loaded BEFORE the lock
    was acquired. A caller that read the row unlocked earlier in the request
    would then compute stock from a stale snapshot and overwrite a concurrent
    sale's deduction -- a lost update the lock was supposed to prevent.
    Autoflush runs before the query, so pending changes are flushed, not lost.
    """
    return (InventoryItem.query
            .with_for_update()
            .populate_existing()
            .get(item_id))


def _lock_sorted(*item_ids: str) -> dict:
    """Lock InventoryItem rows in ascending id order and return {id: item} dict.

    Raises ValueError for any id that does not resolve to an existing row.
    The ascending sort prevents deadlock when concurrent transactions need
    overlapping sets of rows.
    """
    locked = {}
    for iid in sorted(set(item_ids)):
        row = _lock_one(iid)
        if row is None:
            raise ValueError(f'InventoryItem not found: {iid}')
        locked[iid] = row
    return locked


# Conversion families whose child only ever comes into existence by opening a
# parent. Buying "15 shots" or "20 loose cigarettes" from a supplier is not a
# thing that happens; recording it as a RESTOCK creates child stock out of
# nothing and leaves the parent (bottle / pack) un-deducted on the books.
_OPEN_ONLY_CONVERSIONS = ('BOTTLE_TO_SHOT', 'PACK_TO_LOOSE')


def _open_only_parent_name(item: InventoryItem) -> str | None:
    """Name of the bottle/box `item` is opened from, or None if it is not a
    shot / loose-cigarette item. These items may only GAIN stock by opening
    their parent: shots appear when a bottle is opened, never otherwise."""
    conv = (InventoryConversion.query
            .filter(InventoryConversion.to_item_id == item.id,
                    InventoryConversion.is_active.is_(True),
                    InventoryConversion.conversion_type.in_(_OPEN_ONLY_CONVERSIONS))
            .first())
    if conv is None:
        return None
    parent = InventoryItem.query.get(conv.from_item_id)
    return parent.name if parent else conv.from_item_id


def _assert_restockable(item: InventoryItem) -> None:
    """Refuse a RESTOCK on an item that only exists by opening a parent, or a
    pack that only exists by portioning its raw item (E8)."""
    if item.portion_source_id:
        src = InventoryItem.query.get(item.portion_source_id)
        raise ValueError(
            f'RESTOCK_PORTION_ITEM: "{item.name}" se produce porcionando "{src.name if src else "el crudo"}". '
            f'Reabastece el crudo y usa 🔪 Porcionar.')
    parent_name = _open_only_parent_name(item)
    if parent_name is None:
        return
    raise ValueError(
        f'RESTOCK_DERIVED_ITEM: "{item.name}" no se reabastece directamente. '
        f'Reabastece "{parent_name}" y ábrelo (Abrir botella / Abrir caja).'
    )


def assert_whole(qty, unit_key: str | None, label: str) -> None:
    """Refuse a fractional MANUAL quantity in a counted unit (migration 041).

    Nobody restocks, wastes or counts 0.01 of a bottle; a decimal in a counted
    unit is a typo that leaves stock no physical count can match. Measured
    units (ml, gramo...) are exempt. Sales never call this -- a split bucket
    legitimately deducts thirds.
    """
    if unit_key is None:
        return
    q = _d(qty)
    if q == q.to_integral_value():
        return
    unit = UnitCatalog.query.get(unit_key)
    if unit is None or unit.allows_fraction:
        return
    raise ValueError(
        f'WHOLE_UNITS_ONLY: {label} se cuenta en "{unit.name_es}"; '
        f'usa un número entero (recibido {q.normalize()}).'
    )


def _assert_no_increase_without_opening(item: InventoryItem, delta: Decimal,
                                        allow_owner_override: bool = False) -> None:
    """Shots / loose cigarettes can only go UP by opening a bottle / box.

    Decreases (spillage, a count that comes up short) are always allowed.
    allow_owner_override lets an ADMIN raise a physical count -- the escape
    hatch for "the open bottle really has 7 shots but the system says 2".
    It is audited like every adjustment.
    """
    if delta <= 0:
        return
    parent_name = _open_only_parent_name(item)
    if parent_name is None or allow_owner_override:
        return
    raise ValueError(
        f'OPEN_TO_ADD: "{item.name}" solo aumenta al abrir "{parent_name}". '
        f'Usa Abrir botella / Abrir caja. (Solo el administrador puede '
        f'corregir un conteo hacia arriba.)'
    )


def _automatic_parents(item_ids) -> dict[str, str]:
    """{child_item_id: parent_item_id} for active automatic conversions.

    Only conversions that need no human: a cigarette pack becoming loose
    cigarettes, a bottle becoming shots. Production recipes (a sauce bottle
    becoming ramekins) are excluded by construction — they live in
    production_recipes because someone has to actually portion them, and
    counting them as available would let a waiter sell 84 ramekins that do not
    physically exist.
    """
    ids = [i for i in set(item_ids) if i]
    if not ids:
        return {}
    rows = InventoryConversion.query.filter(
        InventoryConversion.to_item_id.in_(ids),
        InventoryConversion.is_active.is_(True),
        InventoryConversion.is_automatic.is_(True),
    ).all()
    return {r.to_item_id: r.from_item_id for r in rows}


def _ensure_available(needed: dict, performed_by: str | None,
                      reference_id: str | None = None) -> dict:
    """Lock every row this transaction may touch, converting from parents if short.

    This is what makes auto-conversion actually fire. Before it existed, a sale
    of a loose cigarette checked only the loose item's stock: full packs on the
    shelf were invisible, so the sale was refused with cartons sitting in the
    drawer. fn_effective_available() reports the same combined figure but is
    explicitly advisory — it takes no locks and reserves nothing — so it cannot
    be used to gate a sale. fn_ensure_available() is the transactional
    counterpart: it locks, converts, and writes the CONVERSION_OUT/IN movement
    pair so the ledger stays balanced.

    Locking rule: the union of children AND their parents is locked in one
    ascending-id pass. Locking children first and letting the conversion take
    the parent lock later would give two concurrent sales the opposite lock
    order on a (child, parent) pair — a textbook deadlock, and one that would
    only show up under exactly the Friday-night concurrency where it hurts.

    Returns {item_id: InventoryItem} for the children, refreshed after any
    conversion. Parents are locked but not returned; callers do not deduct them.
    """
    parents = _automatic_parents(needed.keys())
    locked = _lock_sorted(*(set(needed) | set(parents.values())))

    if not parents:
        return {iid: locked[iid] for iid in needed}

    # performed_by is required: fn_convert_stock writes movements, and a
    # movement with a NULL actor is exactly the untraceable adjustment this
    # whole project exists to eliminate.
    if performed_by:
        for iid in sorted(needed):
            if iid not in parents:
                continue
            item = locked.get(iid)
            if item is None or _d(item.stock_quantity) >= needed[iid]:
                continue

            # Returns 0 when the family's gate is closed, when no automatic
            # conversion exists, or when the parent is itself short. All three
            # leave the shortage for the caller to report.
            db.session.execute(
                text('SELECT fn_ensure_available(:item, :needed, :user, :ref)'),
                {'item': iid, 'needed': needed[iid],
                 'user': performed_by, 'ref': reference_id},
            )
            # fn_convert_stock updated both rows in SQL, behind the ORM's back.
            # Expire so the next read reflects the conversion instead of the
            # pre-conversion snapshot still sitting in the identity map.
            db.session.expire(item)
            parent = locked.get(parents[iid])
            if parent is not None:
                db.session.expire(parent)

    return {iid: locked[iid] for iid in needed}


# def _track_cig_sale(item: InventoryItem, qty_sold: Decimal):
#     """Update OpenCigaretteBox tracking when CIG_SINGLE inventory is consumed."""
#     if item.item_type != 'CIG_SINGLE':
#         return
#     from app.extensions import socketio

#     open_box = (
#         OpenCigaretteBox.query
#         .filter_by(is_finished=False)
#         .join(InventoryItem, OpenCigaretteBox.box_item_id == InventoryItem.id)
#         .filter(InventoryItem.yields_item_id == item.id)
#         .order_by(OpenCigaretteBox.opened_at.desc())
#         .first()
#     )
#     if not open_box:
#         return

#     open_box.cigs_sold += int(qty_sold)

#     if open_box.cigs_sold >= open_box.cigs_per_box:
#         open_box.is_finished = True
#         open_box.finished_at = _now()
#         db.session.flush()
#         socketio.emit('inventory:box_finished', {
#             'brand':        open_box.brand,
#             'open_box_id':  open_box.id,
#             'cigs_per_box': open_box.cigs_per_box,
#         })
#     elif open_box.cigs_per_box - open_box.cigs_sold <= 3:
#         db.session.flush()
#         socketio.emit('inventory:box_low', {
#             'brand':           open_box.brand,
#             'open_box_id':     open_box.id,
#             'cigs_remaining':  open_box.cigs_per_box - open_box.cigs_sold,
#         })

def _track_cig_sale(item: InventoryItem, qty_sold: Decimal):
    """Cigarette tracking is now lot‑based (inventory_pack_lots). Stub only."""
    return

# ── Unit Catalog ──────────────────────────────────────────────────────────────

def list_units(active_only: bool = True) -> list:
    """Return unit catalog entries ordered by Spanish name.

    Args:
        active_only: If True (default), exclude inactive entries.

    Returns:
        List of UnitCatalog instances.
    """
    q = UnitCatalog.query
    if active_only:
        q = q.filter_by(active=True)
    return q.order_by(UnitCatalog.name_es).all()


def create_unit(key: str, name_es: str, name_en: str,
                allows_fraction: bool = False) -> UnitCatalog:
    """Create a new unit catalog entry.

    Args:
        key: Lowercase internal identifier (e.g. 'botella'). Must be unique.
        name_es: Spanish display name.
        name_en: English display name.

    Returns:
        New UnitCatalog instance (not yet committed).

    Raises:
        ValueError: If key is empty or contains invalid characters.
    """
    key = key.strip().lower()
    if not key:
        raise ValueError('Unit key must not be empty')

    unit = UnitCatalog(key=key, name_es=name_es.strip(), name_en=name_en.strip(),
                       allows_fraction=bool(allows_fraction))
    db.session.add(unit)
    return unit


def update_unit(key: str, **fields) -> UnitCatalog:
    """Update an existing unit catalog entry.

    Accepted fields: name_es, name_en, active.

    Args:
        key: The unit key to update.
        **fields: Field values to set.

    Returns:
        Updated UnitCatalog instance (not yet committed).

    Raises:
        ValueError: If unit not found.
    """
    unit = UnitCatalog.query.get(key)
    if not unit:
        raise ValueError(f'Unit not found: {key}')
    for field, value in fields.items():
        if field in ('name_es', 'name_en', 'active', 'allows_fraction'):
            setattr(unit, field, value)
    return unit


# ── Restock ───────────────────────────────────────────────────────────────────

def restock_drinks(
    item_id: str,
    purchase_quantity,
    unit_cost_per_purchase_unit_cents: int,
    performed_by: str,
    *,
    pack_size_override=None,
    purchase_unit_key_override: str = None,
    reason: str = None,
) -> InventoryItem:
    """Restock a drinks or general item purchased in purchase units (e.g. cases).

    Converts purchase_quantity × effective_pack_size to base-unit delta.
    Recalculates weighted average cost using the new unit cost.
    Writes a RESTOCK movement with full purchase audit fields.

    Args:
        item_id: UUID of the InventoryItem.
        purchase_quantity: Number of purchase units received (e.g. 5 cases).
        unit_cost_per_purchase_unit_cents: Cost paid per purchase unit (centavos).
        performed_by: User ID executing the restock.
        pack_size_override: Overrides item.purchase_pack_size for this restock only.
            Use when supplier ships non-standard pack sizes.
        purchase_unit_key_override: Overrides item.purchase_unit_key for this restock.
        reason: Optional note stored on the movement record.

    Returns:
        Updated InventoryItem (not yet committed by caller).

    Raises:
        ValueError: Item not found, inactive, purchase_quantity ≤ 0,
            cost < 0, or effective pack size ≤ 0.
    """
    item = _lock_one(item_id)
    if not item:
        raise ValueError('InventoryItem not found')
    if not item.is_active:
        raise ValueError('Cannot restock an inactive inventory item')
    _assert_restockable(item)

    purchase_qty = _d(purchase_quantity)
    if purchase_qty <= 0:
        raise ValueError('purchase_quantity must be > 0')
    if unit_cost_per_purchase_unit_cents < 0:
        raise ValueError('unit_cost_per_purchase_unit_cents must be >= 0')

    eff_pack = _d(pack_size_override if pack_size_override is not None
                  else item.purchase_pack_size)
    if eff_pack <= 0:
        raise ValueError('Effective pack size must be > 0')

    eff_pu_key = purchase_unit_key_override or item.purchase_unit_key

    quantity_delta = (purchase_qty * eff_pack).quantize(
        Decimal('0.0001'), rounding=ROUND_HALF_UP
    )
    # Both sides of the purchase must make sense physically: "1.5 cajas" of a
    # whole-number purchase unit is a typo, and so is ending up with 1.01 bottles.
    assert_whole(purchase_qty, eff_pu_key or item.base_unit_key, 'La cantidad comprada')
    assert_whole(quantity_delta, item.base_unit_key, f'"{item.name}"')
    # The case price divided into its units, kept exact: $350 / 24 = 1458.3333 ¢.
    cost_per_base = _exact_cost(Decimal(unit_cost_per_purchase_unit_cents) / eff_pack)
    new_wac = _compute_wac(
        _d(item.stock_quantity), item.unit_cost_cents,
        quantity_delta, cost_per_base,
    )

    item.stock_quantity      = _d(item.stock_quantity) + quantity_delta
    item.unit_cost_cents     = new_wac
    item.purchase_cost_cents = unit_cost_per_purchase_unit_cents
    item.updated_at          = _now()

    _write_movement(
        item, 'RESTOCK', quantity_delta, performed_by,
        unit_cost_cents     = new_wac,
        purchase_quantity   = purchase_qty,
        purchase_unit_key   = eff_pu_key,
        purchase_cost_cents = unit_cost_per_purchase_unit_cents,
        reason              = reason or 'Reabasto',
    )
    return item


def restock_food_portions(
    item_id: str,
    portion_count,
    total_purchase_cost_cents: int,
    performed_by: str,
    *,
    reason: str = None,
) -> InventoryItem:
    """Restock a food item by entering prepared portion count and total batch cost.

    Food restocking bypasses pack-size conversion: portion_count IS the base-unit
    delta. The per-portion cost is derived as total_purchase_cost_cents / portion_count.
    Recalculates WAC and writes a RESTOCK movement.

    Args:
        item_id: UUID of the InventoryItem (category must be 'food').
        portion_count: Number of portions added to stock.
        total_purchase_cost_cents: Total cost of this batch in centavos.
        performed_by: User ID.
        reason: Optional note.

    Returns:
        Updated InventoryItem (not yet committed).

    Raises:
        ValueError: Item not found, inactive, not food, portion_count ≤ 0, cost < 0.
    """
    item = _lock_one(item_id)
    if not item:
        raise ValueError('InventoryItem not found')
    if not item.is_active:
        raise ValueError('Cannot restock an inactive inventory item')
    _assert_restockable(item)
    if item.category != 'food':
        raise ValueError(
            'restock_food_portions is only for food items; use restock_drinks for others'
        )

    portions = _d(portion_count)
    if portions <= 0:
        raise ValueError('portion_count must be > 0')
    assert_whole(portions, item.base_unit_key, f'"{item.name}"')
    if total_purchase_cost_cents < 0:
        raise ValueError('total_purchase_cost_cents must be >= 0')

    cost_per_portion = _exact_cost(Decimal(total_purchase_cost_cents) / portions)
    new_wac = _compute_wac(
        _d(item.stock_quantity), item.unit_cost_cents,
        portions, cost_per_portion,
    )

    item.stock_quantity  = _d(item.stock_quantity) + portions
    item.unit_cost_cents = new_wac
    item.updated_at      = _now()

    _write_movement(
        item, 'RESTOCK', portions, performed_by,
        unit_cost_cents     = new_wac,
        purchase_quantity   = portions,
        purchase_unit_key   = item.base_unit_key,
        purchase_cost_cents = _round_cents(cost_per_portion),   # integer column
        reason              = reason or 'Reabasto de porciones',
    )
    return item


# ── Sale Deduction + COGS ─────────────────────────────────────────────────────

def _needed_for(menu_item_id: str, modifiers_data: list, quantity: int = 1) -> dict:
    """Aggregate {inventory_item_id: quantity} for a prospective sale.

    Recipe (InsumoBase) plus modifier rules, with split_modifier_qty applied.
    Extracted so the pre-check and the deduction cannot drift apart.
    """
    needed: dict[str, Decimal] = {}

    for ing in InsumoBase.query.filter_by(menu_item_id=menu_item_id).all():
        qty = _d(ing.quantity) * quantity
        needed[ing.inventory_item_id] = needed.get(ing.inventory_item_id, Decimal(0)) + qty

    from app.models.menu import Modifier
    # Build split factors: for groups with split_modifier_qty, divide qty by distinct modifier count
    group_split: dict[str, Decimal] = {}
    group_modifier_ids: dict[str, set] = {}
    for mod_data in modifiers_data:
        mod = Modifier.query.get(mod_data.get('modifier_id'))
        if not mod:
            continue
        gid = mod.modifier_group_id
        group_modifier_ids.setdefault(gid, set()).add(mod.id)
    for mod_data in modifiers_data:
        mod = Modifier.query.get(mod_data.get('modifier_id'))
        if not mod:
            continue
        gid = mod.modifier_group_id
        if gid not in group_split:
            group = mod.group
            if group and group.split_modifier_qty:
                n = len(group_modifier_ids.get(gid, {1}))
                group_split[gid] = Decimal(max(n, 1))
            else:
                group_split[gid] = Decimal(1)

    for mod_data in modifiers_data:
        mod = Modifier.query.get(mod_data.get('modifier_id'))
        if not mod:
            continue
        for rule in ModifierInventoryRule.query.filter_by(modifier_id=mod.id).all():
            sf = group_split.get(mod.modifier_group_id, Decimal(1))
            qty = _d(rule.quantity) / sf * quantity
            needed[rule.inventory_item_id] = (
                needed.get(rule.inventory_item_id, Decimal(0)) + qty
            )

    return needed


def check_stock_for_item(menu_item, modifiers_data: list, quantity: int = 1,
                         performed_by: str | None = None,
                         reference_id: str | None = None) -> list:
    """Check stock availability before allowing a sale. Acquires row locks.

    Locks every row the sale may touch — ingredients, modifier items, and any
    auto-convertible parent — in ascending id order, then converts from parents
    where the child is short and the family's gate is open. Must be called in
    the same transaction as consume_for_line_item so the locks are held through
    the deduction.

    Passing performed_by enables auto-conversion; omitting it makes this a pure
    read-only check, because a conversion writes movements and a movement needs
    a named actor.

    Args:
        menu_item: MenuItem ORM instance.
        modifiers_data: List of {'modifier_id': str} dicts from the request.
        quantity: Line item quantity (multiplies each ingredient deduction).
        performed_by: User ID placing the order. Required for auto-conversion.
        reference_id: Id of the line item this check is for. Written on any
            CONVERSION_OUT/IN pair it triggers, so an auto-opened bottle is
            traceable to the order that opened it. add_item generates the line
            id up front precisely so it can pass it here.

    Returns:
        List of shortage dicts {name, available, needed}. Empty = all in stock.
    """
    needed = _needed_for(menu_item.id, modifiers_data, quantity)
    if not needed:
        return []

    try:
        locked = _ensure_available(needed, performed_by, reference_id=reference_id)
    except ValueError as exc:
        # A recipe references an inventory item that no longer exists.
        return [{'name': str(exc), 'available': 0, 'needed': 0}]

    shortages = []
    for inv_id in sorted(needed.keys()):
        item = locked.get(inv_id)
        if item is None:
            shortages.append({'name': f'[missing: {inv_id}]',
                              'available': 0, 'needed': float(needed[inv_id])})
            continue
        avail = _d(item.stock_quantity)
        if avail < needed[inv_id]:
            shortages.append({
                'name':      item.name,
                'available': float(avail),
                'needed':    float(needed[inv_id]),
            })
    return shortages


def consume_for_line_item(line_item, performed_by: str, units: int | None = None):
    """Deduct inventory and write COGS records when a line item is sent.

    Processes InsumoBase (recipe) and ModifierInventoryRule (modifier) deductions.
    Acquires locks in ascending id order to prevent deadlock.
    Writes one InventoryMovement (SALE_DEDUCTION) and one SaleItemCost per deduction.

    Must be called within the outer transaction of add_item or send_order.
    The caller is responsible for db.session.commit().

    Args:
        line_item: TicketLineItem ORM instance (already flushed, has .id).
        performed_by: User ID of the staff member who placed the order.
        units: how many units of the line to deduct (default: the whole line).
            A quantity increase deducts only the added units (batch E).

    Raises:
        ValueError: If any ingredient item is missing or stock would go negative.
    """
    if not line_item.menu_item_id:
        return
    units = int(line_item.quantity) if units is None else int(units)
    if units <= 0:
        return

    # Collect all deductions: {inventory_item_id, needed, insumos_base_id}
    deductions = []

    for ing in InsumoBase.query.filter_by(menu_item_id=line_item.menu_item_id).all():
        deductions.append({
            'inventory_item_id': ing.inventory_item_id,
            'needed':            _d(ing.quantity) * units,
            'insumos_base_id':   ing.id,
        })

    for lim in line_item.modifiers:
        for rule in ModifierInventoryRule.query.filter_by(modifier_id=lim.modifier_id).all():
            # Determine split factor: if the modifier group uses split_modifier_qty,
            # divide the portion equally among the distinct flavors selected.
            split_factor = Decimal(1)
            group = lim.modifier.group if lim.modifier else None
            if group and group.split_modifier_qty:
                distinct_mod_ids = {m.modifier_id for m in line_item.modifiers
                                    if m.modifier and m.modifier.modifier_group_id == group.id}
                n = len(distinct_mod_ids)
                if n > 1:
                    split_factor = Decimal(n)
            deductions.append({
                'inventory_item_id': rule.inventory_item_id,
                'needed':            _d(rule.quantity) / split_factor * units,
                'insumos_base_id':   None,
            })

    if not deductions:
        return

    # Aggregate totals per item for the sufficiency check
    total_needed: dict[str, Decimal] = {}
    for d in deductions:
        iid = d['inventory_item_id']
        total_needed[iid] = total_needed.get(iid, Decimal(0)) + d['needed']

    # Lock everything (ingredients + auto-convertible parents) in ascending id
    # order and convert where short. This must happen HERE and not only in
    # check_stock_for_item: of the three call sites, only add_item pre-checks —
    # the two send_order paths call this function directly. Doing the conversion
    # solely in the pre-check would mean a loose cigarette sells fine when added
    # to a ticket but fails when the order is sent.
    locked = _ensure_available(total_needed, performed_by, reference_id=line_item.id)

    for iid, total in total_needed.items():
        item = locked[iid]
        if _d(item.stock_quantity) < total:
            raise ValueError(
                f'OUT_OF_STOCK:{item.name}:'
                f'available={float(item.stock_quantity)},needed={float(total)}'
            )

    # Apply deductions sequentially; quantity_after accumulates within this loop
    for d in deductions:
        item         = locked[d['inventory_item_id']]
        needed       = d['needed']
        snapshot_wac = _exact_cost(item.unit_cost_cents)
        # Exact unit cost x quantity, rounded to whole centavos ONCE here.
        total_cost   = _round_cents(needed * snapshot_wac)

        item.stock_quantity = _d(item.stock_quantity) - needed
        item.updated_at     = _now()

        mv = _write_movement(
            item, 'SALE_DEDUCTION', -needed, performed_by,
            unit_cost_cents = snapshot_wac,
            reference_id    = line_item.id,
        )

        db.session.add(SaleItemCost(
            ticket_line_item_id   = line_item.id,
            inventory_item_id     = item.id,
            inventory_movement_id = mv.id,
            insumos_base_id       = d['insumos_base_id'],
            quantity_deducted     = needed,
            unit_cost_cents       = snapshot_wac,
            total_cost_cents      = total_cost,
        ))

        _track_cig_sale(item, needed)


RETURNED, WASTED = 'RETURNED', 'WASTED'
_Q4 = Decimal('0.0001')


def reverse_for_line_item(line_item, performed_by: str, *, disposition: str = RETURNED,
                          units: int | None = None, of_units: int | None = None,
                          reason: str = '') -> None:
    """Undo the sale of all or part of a line item (void or quantity decrease).

    What happened to the product decides the stock (batch E, "honest voids"):

      RETURNED  it went back on the shelf untouched (a sealed beer): stock is
                restored -- VOID_REVERSAL.
      WASTED    it was poured, cooked or opened: it is gone. The sale is undone
                (VOID_REVERSAL) and the same quantity is written off as WASTE,
                valued at the cost it was sold at, so stock stays down and the
                loss shows as shrinkage in pesos instead of vanishing.

    Either way the line's COGS rows (sale_item_costs) shrink by the same share:
    an undone sale was never a sale.

    `units` of `of_units` (default: all of them) is the share to undo; rows are
    trimmed newest first, so a line raised in steps gives back its latest units.
    Idempotent for a full void: the rows are gone after the first call.
    Does NOT recompute WAC; WAC is forward-only.
    """
    if disposition not in (RETURNED, WASTED):
        raise ValueError(f'INVALID_DISPOSITION:{disposition}')
    cost_rows = (SaleItemCost.query.filter_by(ticket_line_item_id=line_item.id)
                 .order_by(SaleItemCost.recorded_at.desc(), SaleItemCost.id.desc()).all())
    if not cost_rows:
        return
    of_units = int(of_units or line_item.quantity or 1)
    units = of_units if units is None else int(units)
    if units <= 0:
        return
    full = units >= of_units

    # Quantity to give back per inventory item: its share of what the line took.
    taken: dict[str, Decimal] = {}
    for r in cost_rows:
        taken[r.inventory_item_id] = taken.get(r.inventory_item_id, Decimal(0)) + _d(r.quantity_deducted)
    give = {iid: (q if full else (q * units / of_units).quantize(_Q4)) for iid, q in taken.items()}

    locked: dict[str, InventoryItem] = {}
    for iid in sorted(give):
        row = _lock_one(iid)
        if row is not None:
            locked[iid] = row

    why = (reason or '').strip()
    waste_reason = ('Anulación' if full else 'Cantidad reducida') + ' — se tiró' + (f': {why}' if why else '')

    for iid, qty in give.items():
        if qty <= 0:
            continue
        # Trim this item's COGS rows newest first; remember the cost of what we take back.
        left, cost_back = qty, Decimal(0)
        for r in (x for x in cost_rows if x.inventory_item_id == iid):
            if left <= 0:
                break
            q = _d(r.quantity_deducted)
            take = min(q, left)
            cost_back += take * _exact_cost(r.unit_cost_cents)
            if take >= q:
                db.session.delete(r)
            else:
                r.quantity_deducted = q - take
                r.total_cost_cents = _round_cents(r.quantity_deducted * _exact_cost(r.unit_cost_cents))
            left -= take

        item = locked.get(iid)
        if item is None:
            continue  # item deleted after the sale: nothing to put back
        sold_cost = (cost_back / qty).quantize(_Q4) if qty else None
        item.stock_quantity = _d(item.stock_quantity) + qty
        item.updated_at = _now()
        _write_movement(item, 'VOID_REVERSAL', qty, performed_by,
                        unit_cost_cents=item.unit_cost_cents, reference_id=line_item.id)
        if disposition == WASTED:
            item.stock_quantity = _d(item.stock_quantity) - qty
            _write_movement(item, 'WASTE', -qty, performed_by,
                            unit_cost_cents=sold_cost, reference_id=line_item.id,
                            reason=waste_reason)
    db.session.flush()


# ── Adjustments ───────────────────────────────────────────────────────────────

def record_waste(
    item_id: str, waste_quantity, reason: str, performed_by: str
) -> InventoryItem:
    """Deduct stock explicitly recorded as waste.

    Args:
        item_id: UUID of the InventoryItem.
        waste_quantity: Amount to deduct in item's base_unit (must be > 0).
        reason: Required non-empty explanation.
        performed_by: User ID.

    Returns:
        Updated InventoryItem (not yet committed).

    Raises:
        ValueError: Item not found, reason empty, qty ≤ 0, or would exceed stock.
    """
    if not reason or not reason.strip():
        raise ValueError('Reason is required for waste recording')

    item = _lock_one(item_id)
    if not item:
        raise ValueError('InventoryItem not found')

    waste_qty = _d(waste_quantity)
    if waste_qty <= 0:
        raise ValueError('waste_quantity must be > 0')
    assert_whole(waste_qty, item.base_unit_key, 'La merma')

    stock = _d(item.stock_quantity)
    if waste_qty > stock:
        raise ValueError(
            f'WASTE_EXCEEDS_STOCK: cannot waste {float(waste_qty)}, '
            f'only {float(stock)} available'
        )

    item.stock_quantity = stock - waste_qty
    item.updated_at     = _now()

    _write_movement(item, 'WASTE', -waste_qty, performed_by, reason=reason.strip())
    return item


def record_count_adjustment(
    item_id: str, counted_quantity, reason: str, performed_by: str,
    *, allow_owner_override: bool = False,
) -> InventoryItem:
    """Set stock to a physically counted quantity; records the signed delta.

    A zero delta is valid and records that a count confirmed the book balance.

    Args:
        item_id: UUID of the InventoryItem.
        counted_quantity: Actual quantity observed (>= 0).
        reason: Required non-empty explanation.
        performed_by: User ID.

    Returns:
        Updated InventoryItem (not yet committed).

    Raises:
        ValueError: Item not found, reason empty, or counted_quantity < 0.
    """
    if not reason or not reason.strip():
        raise ValueError('Reason is required for count adjustments')

    item = _lock_one(item_id)
    if not item:
        raise ValueError('InventoryItem not found')

    counted = _d(counted_quantity)
    if counted < 0:
        raise ValueError('counted_quantity must be >= 0')
    assert_whole(counted, item.base_unit_key, 'El conteo')

    delta = counted - _d(item.stock_quantity)
    # A count may lower shots freely, but raising them is "adding shots
    # without opening a bottle" -- owner (ADMIN) only.
    _assert_no_increase_without_opening(item, delta, allow_owner_override)
    item.stock_quantity = counted
    item.updated_at     = _now()

    _write_movement(item, 'COUNT_ADJUSTMENT', delta, performed_by, reason=reason.strip())
    return item


def manual_adjust(
    item_id: str, qty_delta, reason: str, performed_by: str
) -> InventoryItem:
    """Apply a signed delta to stock for general manual corrections.

    Args:
        item_id: UUID of the InventoryItem.
        qty_delta: Signed Numeric delta (negative reduces stock).
        reason: Required non-empty explanation.
        performed_by: User ID.

    Returns:
        Updated InventoryItem (not yet committed).

    Raises:
        ValueError: Item not found, reason empty, or result would be negative.
    """
    if not reason or not reason.strip():
        raise ValueError('Reason is required for manual adjustments')

    item = _lock_one(item_id)
    if not item:
        raise ValueError('InventoryItem not found')

    delta     = _d(qty_delta)
    projected = _d(item.stock_quantity) + delta
    assert_whole(delta, item.base_unit_key, 'El ajuste')

    # No override here: an upward correction of shots goes through a physical
    # count (owner only), never a free-form "+N".
    _assert_no_increase_without_opening(item, delta)

    if projected < 0:
        raise ValueError(
            f'WOULD_GO_NEGATIVE: current={float(item.stock_quantity)}, '
            f'delta={float(delta)}, result would be {float(projected)}'
        )

    item.stock_quantity = projected
    item.updated_at     = _now()

    _write_movement(item, 'MANUAL_ADJUSTMENT', delta, performed_by, reason=reason.strip())
    return item


# ── Purchase unit vs stock unit (batch E4) ────────────────────────────────────
# Stocked by Botella, bought by Caja -> "how many botellas per caja" must be a
# real count (> 1). It used to default to 1, silently turning a $380 case into
# "$380 por botella". Bought in the same unit it is stocked in -> the pack is 1.

def _unit_name(key, plural: bool = False):
    u = UnitCatalog.query.get(key) if key else None
    w = (u.name_es if u and u.name_es else (key or 'unidad')).lower()
    if plural and not w.endswith('s') and w not in ('ml',):
        w += 's' if w[-1] in 'aeiouáéó' else 'es'
    return w


def assert_pack(base_key, purchase_key, pack, *, same_unit_strict: bool = True) -> None:
    """Raise ValueError (PACK_REQUIRED / PACK_SAME_UNIT) for a pack size that
    cannot be right. same_unit_strict=False skips the same-unit check (restocks
    of existing items keep working while the owner fixes old data)."""
    p = _d(pack) if pack not in (None, '') else None
    if not purchase_key or purchase_key == base_key:
        if same_unit_strict and p is not None and p != 1:
            raise ValueError(
                f'PACK_SAME_UNIT: Lo compras y lo guardas por {_unit_name(base_key)}, así que el '
                f'paquete es de 1. Si la {_unit_name(purchase_key or base_key)} trae {p.normalize():f} piezas, '
                f'guárdalo por pieza (unidad base) y cómpralo por {_unit_name(purchase_key or base_key)}.')
        return
    if p is None or p <= 1:
        raise ValueError(f'PACK_REQUIRED: ¿Cuántas {_unit_name(base_key, plural=True)} trae la '
                         f'{_unit_name(purchase_key)}? Escribe un número mayor a 1.')

# ── Openable items: bottle -> shots, cigarette box -> loose ───────────────────
#
# Bottles (batch E2, migration 049) are measured in ml: an owner configures
# "750 ml bottle, 50 ml shot". The conversion ratio is ml per bottle, the open
# item is stocked in ml, and its portion_size is the standard pour, so a recipe
# can take a 50 ml shot, a 60 ml double or a 20 ml splash. Cigarette boxes stay
# "20 per box". Internally that is an
# inventory_conversions row (the ONLY thing open_bottle / auto-conversion read)
# plus a child item for the shots. configure_yield() is the single writer of
# both, so the form, the "Abrir" button and the conversion can no longer drift
# apart -- which is how a bottle came to "yield" Agua Mineral.

_OPENABLE = {
    'BOTTLE':  {'conversion_type': 'BOTTLE_TO_SHOT', 'child_unit': 'ml',
                'child_type': 'STANDARD', 'parent_words': ('bottle', 'botella'),
                'child_word': 'Shot'},
    'CIG_BOX': {'conversion_type': 'PACK_TO_LOOSE', 'child_unit': 'pieza',
                'child_type': 'CIG_SINGLE', 'parent_words': ('caja', 'cajetilla', 'box'),
                'child_word': 'Suelto'},
}


def _child_name(parent_name: str, spec: dict) -> str:
    """'Mezcal Bottle' -> 'Mezcal Shot'; 'Marlboro Rojo Caja' -> 'Marlboro Rojo Suelto';
    anything else gets the word appended ('Don Julio 70' -> 'Don Julio 70 Shot')."""
    words = parent_name.split()
    if words and words[-1].lower() in spec['parent_words']:
        words[-1] = spec['child_word']
        return ' '.join(words)
    return f"{parent_name} {spec['child_word']}"


def _active_conversion_from(item_id: str):
    return (InventoryConversion.query
            .filter(InventoryConversion.from_item_id == item_id,
                    InventoryConversion.is_active.is_(True))
            .first())


DEFAULT_BOTTLE_ML = 750
DEFAULT_POUR_ML = 50


def _yield_state(item: InventoryItem) -> dict:
    conv = _active_conversion_from(item.id) if item.id else None
    child = InventoryItem.query.get(item.yields_item_id) if item.yields_item_id else None
    st = {'item_type': item.item_type,
          'units_per_parent': item.shots_per_bottle,
          'child_item_id': item.yields_item_id}
    if item.item_type == 'BOTTLE' and conv is not None:
        st['bottle_ml'] = float(conv.ratio)
        st['pour_ml'] = float(child.portion_size) if child is not None and child.portion_size else None
    return st


def pour_ml(child: InventoryItem) -> Decimal | None:
    """The standard pour of an open-spirit item (ml), or None for non-ml items."""
    if (child is not None and child.base_unit_key == 'ml' and child.stock_nature == 'DERIVED'
            and child.portion_size):
        return _d(child.portion_size)
    return None


def configure_yield(item: InventoryItem, units_per_parent, child_item_id,
                    performed_by: str, *, pour=None) -> dict:
    """Make a bottle / cigarette box openable -- or stop it being openable.

    Args:
        item: the parent (already flushed, has an id). Its item_type decides
            the family: BOTTLE -> shots, CIG_BOX -> loose cigarettes. Any other
            type is made non-openable.
        units_per_parent: BOTTLE: millilitres per bottle (e.g. 750).
            CIG_BOX: cigarettes per box. Empty or None means "not openable".
        pour: BOTTLE only -- the standard pour in ml ("1 shot", e.g. 50).
            None keeps the open item's current pour, else 50.
        child_item_id: the shot / loose item to produce. None means: keep the
            current child if there is one, otherwise CREATE it (named after the
            parent, e.g. "Mezcal Bottle" -> "Mezcal Shot"), so an owner only has
            to type "15 shots per bottle".
        performed_by: user id (kept for symmetry with the other writers; the
            API writes the audit row from the returned dict).

    Returns:
        {'before': {...}, 'after': {...}, 'child_created': bool, 'changed': bool}

    Raises:
        ValueError: invalid count, unknown/inactive child, a child that is
            itself openable, the item as its own child, or an auto-created
            child name already taken by an item that cannot be reused.
    """
    before = _yield_state(item)
    spec = _OPENABLE.get(item.item_type)
    current = _active_conversion_from(item.id)
    child_created = False

    # ── Not openable ─────────────────────────────────────────────────────────
    if spec is None or units_per_parent in (None, '', 0):
        if current is not None and current.conversion_type in _OPEN_ONLY_CONVERSIONS:
            current.is_active = False
        item.shots_per_bottle = None
        item.yields_item_id = None
        if item.stock_nature == 'CONVERTIBLE':
            item.stock_nature = 'SIMPLE'
        db.session.flush()
        after = _yield_state(item)
        return {'before': before, 'after': after, 'child_created': False,
                'changed': before != after}

    # ── Validate the count ───────────────────────────────────────────────────
    is_bottle = item.item_type == 'BOTTLE'
    what = 'ml por botella' if is_bottle else 'cigarros por caja'
    try:
        units = int(units_per_parent)
    except (TypeError, ValueError):
        raise ValueError(f'INVALID_YIELD: {what} debe ser un número entero')
    if units < 1 or units != _d(units_per_parent):
        raise ValueError(f'INVALID_YIELD: {what} debe ser un entero mayor a 0')
    if is_bottle and not (50 <= units <= 5000):
        raise ValueError('INVALID_YIELD: el tamaño de botella va de 50 a 5000 ml (p. ej. 750)')

    # ── Resolve the child ────────────────────────────────────────────────────
    if child_item_id:
        child = InventoryItem.query.get(child_item_id)
        if child is None or not child.is_active:
            raise ValueError('INVALID_YIELD: el artículo que produce no existe o está inactivo')
        if child.id == item.id:
            raise ValueError('INVALID_YIELD: un artículo no puede producirse a sí mismo')
        if child.item_type in _OPENABLE:
            raise ValueError(
                f'INVALID_YIELD: "{child.name}" también se abre ({child.item_type}); '
                f'elige el artículo individual (shot / suelto), no otra botella o caja')
        if is_bottle and child.base_unit_key != 'ml':
            raise ValueError(
                f'INVALID_YIELD: "{child.name}" se mide en {child.base_unit_key}; '
                f'lo que sale de una botella se mide en ml')
    elif current is not None and current.conversion_type == spec['conversion_type']:
        child = InventoryItem.query.get(current.to_item_id)
    else:
        name = _child_name(item.name, spec)
        child = InventoryItem.query.filter(db.func.lower(InventoryItem.name) == name.lower()).first()
        if child is not None:
            reusable = (child.is_active and child.item_type not in _OPENABLE
                        and child.id != item.id
                        and (not is_bottle or child.base_unit_key == 'ml'))
            if not reusable:
                raise ValueError(
                    f'INVALID_YIELD: ya existe "{child.name}" y no se puede usar como '
                    f'producto de esta {item.item_type.lower()}; elígelo o renómbralo')
        else:
            child = InventoryItem(
                name=name, unit=spec['child_unit'], base_unit_key=spec['child_unit'],
                category=item.category, item_type=spec['child_type'],
                stock_quantity=0, low_stock_threshold=0, unit_cost_cents=0,
                purchase_pack_size=1, stock_nature='DERIVED',
            )
            db.session.add(child)
            db.session.flush()
            child_created = True

    # ── Bottle: the standard pour ────────────────────────────────────────────
    if is_bottle:
        p = _d(pour) if pour not in (None, '') else (_d(child.portion_size) if child.portion_size
                                                      else Decimal(DEFAULT_POUR_ML))
        if not (Decimal(5) <= p <= Decimal(500)) or p > units:
            raise ValueError('INVALID_YIELD: el shot estándar va de 5 a 500 ml y no puede ser mayor que la botella')
        child.portion_size = p
        child.portion_unit_key = 'ml'

    # ── Upsert the conversion ────────────────────────────────────────────────
    # Two constraints shape this: uq_conv_one_active_per_source (one ACTIVE row
    # per parent) and uq_conv_pair (one row per parent/child pair, active or
    # not). So a pair that ever existed is UPDATED/reactivated, never re-inserted,
    # and any other active row is switched off first.
    same = (current is not None
            and current.conversion_type == spec['conversion_type']
            and current.to_item_id == child.id
            and _d(current.ratio) == units)
    if not same:
        pair = (InventoryConversion.query
                .filter_by(from_item_id=item.id, to_item_id=child.id)
                .first())
        if current is not None and current is not pair:
            current.is_active = False
            db.session.flush()          # free the one-active-per-source slot first
        if pair is None:
            db.session.add(InventoryConversion(
                from_item_id=item.id, to_item_id=child.id, ratio=units,
                conversion_type=spec['conversion_type'], is_automatic=True,
                notes='configure_yield',
            ))
        else:
            pair.ratio = units
            pair.conversion_type = spec['conversion_type']
            pair.is_automatic = True
            pair.is_active = True

    # Mirror onto the display columns the inventory screen reads. For a bottle
    # shots_per_bottle is the number of standard pours (display only).
    item.shots_per_bottle = int(units // _d(child.portion_size)) if is_bottle else units
    item.yields_item_id = child.id
    item.stock_nature = 'CONVERTIBLE'
    child.stock_nature = 'DERIVED'
    db.session.flush()

    after = _yield_state(item)
    return {'before': before, 'after': after, 'child_created': child_created,
            'child_name': child.name, 'changed': (before != after) or child_created}


# ── Bottle / Box Opening ──────────────────────────────────────────────────────

class StillHasUnits(ValueError):
    """Opening another bottle/box while the current one still has units left.

    Allowed -- a bar may keep two bottles open -- but only after the person
    confirms "Todavía quedan N shots, ¿abrir otra?". Raised so the API can
    answer 409 with the count instead of opening early by accident.
    """
    def __init__(self, remaining: Decimal, child_name: str, noun: str, ml: Decimal | None = None):
        self.remaining = remaining
        self.child_name = child_name
        self.noun = noun
        self.ml = ml
        n = remaining.normalize()
        extra = f' ({ml.normalize():f} ml)' if ml is not None else ''
        super().__init__(f'STILL_HAS_UNITS: Todavía quedan {n:f} {noun}{extra} de "{child_name}", '
                         f'¿abrir otra?')


def _assert_confirmed_if_remaining(child: InventoryItem, confirm_remaining: bool,
                                   noun: str) -> None:
    remaining = _d(child.stock_quantity)
    if remaining > 0 and not confirm_remaining:
        raise StillHasUnits(remaining, child.name, noun)


def open_bottle(item_id: str, performed_by: str, *, confirm_remaining: bool = False,
                size_ml=None):
    """Manually open one sealed bottle into shots.

    Goes through fn_convert_stock(), the same path auto-conversion uses, so the
    yield, the cost carried to the shots, and the CONVERSION_OUT/IN ledger pair
    are identical whichever way a bottle gets opened. The yield comes from
    inventory_conversions -- NOT from inventory_items.shots_per_bottle /
    yields_item_id, which were edited by hand, disagreed with the conversion,
    and in production pointed a whisky bottle at "Agua Mineral" and a shot item
    back at its own bottle.

    Args:
        item_id: UUID of the bottle InventoryItem.
        performed_by: User ID.

    Returns:
        Tuple (bottle_item, shots_item, units_added), refreshed after the open.
        units_added is in the open item's unit (ml since 049).

    Raises:
        ValueError: NOT_FOUND, NOT_A_BOTTLE (no active BOTTLE_TO_SHOT conversion
            from this item), or NO_STOCK.
    """
    conv = (InventoryConversion.query
            .filter(InventoryConversion.from_item_id == item_id,
                    InventoryConversion.is_active.is_(True),
                    InventoryConversion.conversion_type == 'BOTTLE_TO_SHOT')
            .first())
    if conv is None:
        if InventoryItem.query.get(item_id) is None:
            raise ValueError('NOT_FOUND: InventoryItem not found')
        raise ValueError('NOT_A_BOTTLE: item is not the source of a bottle-to-shot conversion')

    # Bottle sizes vary (batch E2): the size of THIS bottle, default the product's.
    size = None
    if size_ml not in (None, ''):
        size = _d(size_ml)
        if not (Decimal(50) <= size <= Decimal(5000)):
            raise ValueError('BAD_SIZE: el tamaño de la botella va de 50 a 5000 ml')

    locked = _lock_sorted(conv.from_item_id, conv.to_item_id)
    if _d(locked[conv.from_item_id].stock_quantity) < 1:
        raise ValueError('NO_STOCK: no sealed bottles available')
    # Checked under the lock, so the count in the question is the real one.
    # In ml: ask only while at least one full pour is left -- a 20 ml remainder
    # is finished from the new bottle and needs no question.
    child = locked[conv.to_item_id]
    pour = pour_ml(child)
    if pour:
        left = _d(child.stock_quantity)
        shots_left = (left / pour).to_integral_value(rounding='ROUND_FLOOR')
        if shots_left >= 1 and not confirm_remaining:
            raise StillHasUnits(shots_left, child.name, 'shots', ml=left)
    else:
        _assert_confirmed_if_remaining(child, confirm_remaining, 'shots')

    # Bottles the books say are already empty are closed before the new one
    # is recorded (they would otherwise pile up in the bar count).
    from app.services import bar_count_svc
    bar_count_svc.finish_empty(conv.to_item_id, performed_by)
    row = db.session.execute(
        text('SELECT units_created FROM fn_convert_stock(:item, 1, :user, NULL, :reason, :size)'),
        {'item': conv.from_item_id, 'user': performed_by,
         'reason': 'Apertura manual de botella' + (f' ({size.normalize():f} ml)' if size else ''),
         'size': size},
    ).one()

    # fn_convert_stock wrote both rows in SQL, behind the ORM's back.
    bottle = _lock_one(conv.from_item_id)
    shots  = _lock_one(conv.to_item_id)
    return bottle, shots, int(row.units_created)

def open_cigarette_box(item_id: str, performed_by: str, *, confirm_remaining: bool = False):
    """Open a sealed cigarette box via the FIFO pack-lot function.

    The caller commits and THEN emits 'inventory:box_opened'; emitting from here
    told clients to refetch before the transaction was committed (or after it
    was rolled back).
    """
    # Quick validation of the item type
    box = InventoryItem.query.get(item_id)
    if not box:
        raise ValueError('InventoryItem not found')
    if box.item_type != 'CIG_BOX':
        raise ValueError('NOT_A_CIG_BOX')
    if not box.yields_item_id:
        raise ValueError('Box missing yields_item_id')

    locked = _lock_sorted(box.id, box.yields_item_id)
    _assert_confirmed_if_remaining(locked[box.yields_item_id], confirm_remaining,
                                   'cigarros sueltos')

    # The stored procedure does everything: lock, deduct, add, movements.
    # p_reference lands in inventory_movements.reference_id, a varchar(36) that
    # holds document ids. A manual open has no document, so pass NULL: the old
    # free-text "Manual open-box for <name>" overflowed 36 chars for any box
    # name longer than 16 characters and made the open fail outright.
    result = db.session.execute(
        text("SELECT * FROM fn_open_pack_fifo(:box_id, :user_id, NULL)"),
        {"box_id": box.id, "user_id": performed_by},
    ).fetchone()

    if result is None:
        raise Exception("fn_open_pack_fifo returned no row – conversion failed")

    lot_id, units_per_pack, packs_remaining, loose_total = result

    # Re-read with fresh values: the function changed both rows in SQL, and a
    # plain .get() would hand back the pre-open snapshot from the identity map.
    box_updated = _lock_one(box.id)
    single = _lock_one(box.yields_item_id)

    # Build a dict for the open_info (third return value) instead of an ORM object
    open_info = {
        "lot_id": lot_id,
        "brand": box_updated.name,
        "units_per_pack": int(units_per_pack),
        "packs_remaining": int(packs_remaining),
        "loose_total": int(loose_total),
    }

    return box_updated, single, open_info
