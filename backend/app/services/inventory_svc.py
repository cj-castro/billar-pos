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


def _compute_wac(old_qty: Decimal, old_wac_cents: int,
                 delta_qty: Decimal, new_unit_cost_cents: int) -> int:
    """Return new weighted average cost in integer centavos per base unit.

    Formula: (old_qty * old_wac + delta_qty * new_cost) / (old_qty + delta_qty)
    If old_qty == 0 the result is simply new_unit_cost_cents (no prior stock to weight).
    Rounding is ROUND_HALF_UP to avoid systematic truncation bias on repeated restocks.
    """
    old_qty = _d(old_qty)
    delta_qty = _d(delta_qty)

    if old_qty <= 0:
        return new_unit_cost_cents

    numerator   = old_qty * old_wac_cents + delta_qty * new_unit_cost_cents
    denominator = old_qty + delta_qty
    return _round_cents(numerator / denominator)


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


def _lock_sorted(*item_ids: str) -> dict:
    """Lock InventoryItem rows in ascending id order and return {id: item} dict.

    Raises ValueError for any id that does not resolve to an existing row.
    The ascending sort prevents deadlock when concurrent transactions need
    overlapping sets of rows.
    """
    locked = {}
    for iid in sorted(set(item_ids)):
        row = InventoryItem.query.with_for_update().get(iid)
        if row is None:
            raise ValueError(f'InventoryItem not found: {iid}')
        locked[iid] = row
    return locked


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


def create_unit(key: str, name_es: str, name_en: str) -> UnitCatalog:
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

    unit = UnitCatalog(key=key, name_es=name_es.strip(), name_en=name_en.strip())
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
        if field in ('name_es', 'name_en', 'active'):
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
    item = InventoryItem.query.with_for_update().get(item_id)
    if not item:
        raise ValueError('InventoryItem not found')
    if not item.is_active:
        raise ValueError('Cannot restock an inactive inventory item')

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
    cost_per_base = _round_cents(
        Decimal(unit_cost_per_purchase_unit_cents) / eff_pack
    )
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
    item = InventoryItem.query.with_for_update().get(item_id)
    if not item:
        raise ValueError('InventoryItem not found')
    if not item.is_active:
        raise ValueError('Cannot restock an inactive inventory item')
    if item.category != 'food':
        raise ValueError(
            'restock_food_portions is only for food items; use restock_drinks for others'
        )

    portions = _d(portion_count)
    if portions <= 0:
        raise ValueError('portion_count must be > 0')
    if total_purchase_cost_cents < 0:
        raise ValueError('total_purchase_cost_cents must be >= 0')

    cost_per_portion = _round_cents(
        Decimal(total_purchase_cost_cents) / portions
    )
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
        purchase_cost_cents = cost_per_portion,
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
                         performed_by: str | None = None) -> list:
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

    Returns:
        List of shortage dicts {name, available, needed}. Empty = all in stock.
    """
    needed = _needed_for(menu_item.id, modifiers_data, quantity)
    if not needed:
        return []

    try:
        locked = _ensure_available(needed, performed_by)
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


def consume_for_line_item(line_item, performed_by: str):
    """Deduct inventory and write COGS records when a line item is sent.

    Processes InsumoBase (recipe) and ModifierInventoryRule (modifier) deductions.
    Acquires locks in ascending id order to prevent deadlock.
    Writes one InventoryMovement (SALE_DEDUCTION) and one SaleItemCost per deduction.

    Must be called within the outer transaction of add_item or send_order.
    The caller is responsible for db.session.commit().

    Args:
        line_item: TicketLineItem ORM instance (already flushed, has .id).
        performed_by: User ID of the staff member who placed the order.

    Raises:
        ValueError: If any ingredient item is missing or stock would go negative.
    """
    if not line_item.menu_item_id:
        return

    # Collect all deductions: {inventory_item_id, needed, insumos_base_id}
    deductions = []

    for ing in InsumoBase.query.filter_by(menu_item_id=line_item.menu_item_id).all():
        deductions.append({
            'inventory_item_id': ing.inventory_item_id,
            'needed':            _d(ing.quantity) * line_item.quantity,
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
                'needed':            _d(rule.quantity) / split_factor * line_item.quantity,
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
        snapshot_wac = item.unit_cost_cents or 0
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


def reverse_for_line_item(line_item, performed_by: str):
    """Restore inventory when a line item is voided.

    Uses SaleItemCost rows as the authoritative source of what was deducted,
    restoring the exact quantity deducted per ingredient.
    If no SaleItemCost rows exist the item was never deducted (STAGED) — no-op.
    Does NOT recompute WAC; WAC is forward-only.

    Args:
        line_item: TicketLineItem ORM instance being voided.
        performed_by: Manager user ID (PIN-verified by caller).
    """
    cost_rows = SaleItemCost.query.filter_by(ticket_line_item_id=line_item.id).all()
    if not cost_rows:
        return

    all_ids = sorted({r.inventory_item_id for r in cost_rows})
    locked: dict[str, InventoryItem] = {}
    for iid in all_ids:
        row = InventoryItem.query.with_for_update().get(iid)
        if row is not None:
            locked[iid] = row

    for cost_row in cost_rows:
        item = locked.get(cost_row.inventory_item_id)
        if item is None:
            continue  # item deleted after sale; skip restoration
        restore = _d(cost_row.quantity_deducted)
        item.stock_quantity = _d(item.stock_quantity) + restore
        item.updated_at     = _now()

        _write_movement(
            item, 'VOID_REVERSAL', restore, performed_by,
            unit_cost_cents = item.unit_cost_cents,
            reference_id    = line_item.id,
        )


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

    item = InventoryItem.query.with_for_update().get(item_id)
    if not item:
        raise ValueError('InventoryItem not found')

    waste_qty = _d(waste_quantity)
    if waste_qty <= 0:
        raise ValueError('waste_quantity must be > 0')

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
    item_id: str, counted_quantity, reason: str, performed_by: str
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

    item = InventoryItem.query.with_for_update().get(item_id)
    if not item:
        raise ValueError('InventoryItem not found')

    counted = _d(counted_quantity)
    if counted < 0:
        raise ValueError('counted_quantity must be >= 0')

    delta = counted - _d(item.stock_quantity)
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

    item = InventoryItem.query.with_for_update().get(item_id)
    if not item:
        raise ValueError('InventoryItem not found')

    delta     = _d(qty_delta)
    projected = _d(item.stock_quantity) + delta

    if projected < 0:
        raise ValueError(
            f'WOULD_GO_NEGATIVE: current={float(item.stock_quantity)}, '
            f'delta={float(delta)}, result would be {float(projected)}'
        )

    item.stock_quantity = projected
    item.updated_at     = _now()

    _write_movement(item, 'MANUAL_ADJUSTMENT', delta, performed_by, reason=reason.strip())
    return item


# ── Bottle / Box Opening ──────────────────────────────────────────────────────

def open_bottle(item_id: str, performed_by: str):
    """Open a sealed spirit bottle: deduct 1 bottle, add shots_per_bottle shots.

    Distributes the bottle's unit cost to the shots item via WAC update.
    Acquires locks on both items in ascending id order.

    Args:
        item_id: UUID of the BOTTLE InventoryItem.
        performed_by: User ID.

    Returns:
        Tuple (bottle_item, shots_item).

    Raises:
        ValueError: Item not found, not a bottle, or no stock.
    """
    bottle = InventoryItem.query.get(item_id)
    if not bottle:
        raise ValueError('InventoryItem not found')
    if bottle.item_type != 'BOTTLE' or not bottle.shots_per_bottle or not bottle.yields_item_id:
        raise ValueError('NOT_A_BOTTLE: item not configured as a spirit bottle')

    locked = _lock_sorted(bottle.id, bottle.yields_item_id)
    bottle = locked[bottle.id]
    shots  = locked[bottle.yields_item_id]

    if _d(bottle.stock_quantity) < 1:
        raise ValueError('NO_STOCK: no sealed bottles available')

    sppb          = bottle.shots_per_bottle
    cost_per_shot = _round_cents(Decimal(bottle.unit_cost_cents) / sppb)
    new_shots_wac = _compute_wac(
        _d(shots.stock_quantity), shots.unit_cost_cents,
        Decimal(sppb), cost_per_shot,
    )

    bottle.stock_quantity = _d(bottle.stock_quantity) - 1
    bottle.updated_at     = _now()
    _write_movement(
        bottle, 'BOTTLE_OPENING', Decimal(-1), performed_by,
        reason=f'Opened → {sppb} shots added to {shots.name}',
    )

    shots.stock_quantity  = _d(shots.stock_quantity) + sppb
    shots.unit_cost_cents = new_shots_wac
    shots.updated_at      = _now()
    _write_movement(
        shots, 'BOTTLE_OPENING', Decimal(sppb), performed_by,
        unit_cost_cents = new_shots_wac,
        reason          = f'Apertura de botella: {bottle.name}',
    )

    return bottle, shots

def open_cigarette_box(item_id: str, performed_by: str):
    """Open a sealed cigarette box via the FIFO pack-lot function."""
    from sqlalchemy import text

    # Quick validation of the item type
    box = InventoryItem.query.get(item_id)
    if not box:
        raise ValueError('InventoryItem not found')
    if box.item_type != 'CIG_BOX':
        raise ValueError('NOT_A_CIG_BOX')
    if not box.yields_item_id:
        raise ValueError('Box missing yields_item_id')

    # The stored procedure does everything: lock, deduct, add, movements.
    result = db.session.execute(
        text("SELECT * FROM fn_open_pack_fifo(:box_id, :user_id, :ref)"),
        {
            "box_id": box.id,
            "user_id": performed_by,
            "ref": f"Manual open-box for {box.name}"
        }
    ).fetchone()

    if result is None:
        raise Exception("fn_open_pack_fifo returned no row – conversion failed")

    lot_id, units_per_pack, packs_remaining, loose_total = result

    # Re-fetch the updated items to return current state
    box_updated = InventoryItem.query.get(box.id)
    single = InventoryItem.query.get(box.yields_item_id)

    # Build a dict for the open_info (third return value) instead of an ORM object
    open_info = {
        "lot_id": lot_id,
        "brand": box_updated.name,
        "units_per_pack": int(units_per_pack),
        "packs_remaining": int(packs_remaining),
        "loose_total": int(loose_total),
    }

    # Emit socket event (if needed)
    from app.extensions import socketio
    socketio.emit('inventory:box_opened', {
        'brand':        box_updated.name,
        'cigs_per_box': int(units_per_pack),
        'open_box_id':  lot_id or '',
    })

    return box_updated, single, open_info