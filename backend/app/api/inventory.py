"""Inventory API — billar-pos inventory v2.

Endpoints:
  Unit catalog:
    GET    /inventory/units
    POST   /inventory/units
    PATCH  /inventory/units/<key>

  Inventory items:
    GET    /inventory
    POST   /inventory
    PATCH  /inventory/<item_id>
    DELETE /inventory/<item_id>

  Stock operations:
    POST   /inventory/<item_id>/restock
    POST   /inventory/<item_id>/adjust
    GET    /inventory/<item_id>/movements
    GET    /inventory/stock-check

  Bottle / box opening:
    POST   /inventory/<item_id>/open-bottle
    POST   /inventory/<item_id>/open-box
    GET    /inventory/open-boxes

  Insumos Base (recipe links):
    GET    /inventory/insumos-base/<menu_item_id>
    POST   /inventory/insumos-base
    DELETE /inventory/insumos-base/<ingredient_id>
"""
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.inventory import (
    InventoryItem, InventoryMovement, InsumoBase,
    UnitCatalog, SaleItemCost, OpenCigaretteBox,
)
from app.services import inventory_svc, audit_svc

inventory_bp = Blueprint('inventory', __name__)

VALID_CATEGORIES = ('beer', 'spirit', 'mixer', 'food', 'cigarette', 'other')
VALID_ITEM_TYPES = ('STANDARD', 'BOTTLE', 'CIG_BOX', 'CIG_SINGLE')
VALID_ADJUST_TYPES = ('WASTE', 'COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')


def _role(claims):
    return claims.get('role', '')


def _require_manager(claims):
    if _role(claims) not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


def _require_admin(claims):
    if _role(claims) != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN', 'message': 'Solo administradores'}), 403
    return None


# ── Unit Catalog ──────────────────────────────────────────────────────────────

@inventory_bp.route('/units', methods=['GET'])
@jwt_required()
def list_units():
    """Return all active unit catalog entries ordered by Spanish name.

    Query params:
        all=true — include inactive entries (MANAGER/ADMIN only).
    """
    claims    = get_jwt()
    show_all  = request.args.get('all', 'false').lower() == 'true'
    active_only = not (show_all and _role(claims) in ('MANAGER', 'ADMIN'))
    units = inventory_svc.list_units(active_only=active_only)
    return jsonify([u.to_dict() for u in units])


@inventory_bp.route('/units', methods=['POST'])
@jwt_required()
def create_unit():
    """Create a new unit catalog entry. ADMIN only."""
    claims = get_jwt()
    err = _require_admin(claims)
    if err:
        return err

    data = request.get_json() or {}
    key     = (data.get('key') or '').strip()
    name_es = (data.get('name_es') or '').strip()
    name_en = (data.get('name_en') or '').strip()

    if not key:
        return jsonify({'error': 'VALIDATION', 'message': 'key is required'}), 422
    if not name_es:
        return jsonify({'error': 'VALIDATION', 'message': 'name_es is required'}), 422
    if not name_en:
        return jsonify({'error': 'VALIDATION', 'message': 'name_en is required'}), 422

    try:
        unit = inventory_svc.create_unit(key, name_es, name_en)
        db.session.commit()
        return jsonify(unit.to_dict()), 201
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'DUPLICATE_KEY',
                        'message': f"Unit key '{key}' already exists"}), 409
    except ValueError as e:
        return jsonify({'error': 'VALIDATION', 'message': str(e)}), 422


@inventory_bp.route('/units/<key>', methods=['PATCH'])
@jwt_required()
def update_unit(key):
    """Update an existing unit catalog entry. ADMIN only."""
    claims = get_jwt()
    err = _require_admin(claims)
    if err:
        return err

    data = request.get_json() or {}
    fields = {}
    if 'name_es' in data:
        fields['name_es'] = (data['name_es'] or '').strip()
    if 'name_en' in data:
        fields['name_en'] = (data['name_en'] or '').strip()
    if 'active' in data:
        fields['active'] = bool(data['active'])

    try:
        unit = inventory_svc.update_unit(key, **fields)
        db.session.commit()
        return jsonify(unit.to_dict())
    except ValueError as e:
        return jsonify({'error': 'NOT_FOUND', 'message': str(e)}), 404


# ── Inventory Items ───────────────────────────────────────────────────────────

@inventory_bp.route('', methods=['GET'])
@jwt_required()
def list_inventory():
    """Return all inventory items sorted by category then name."""
    items = (InventoryItem.query
             .order_by(InventoryItem.category, InventoryItem.name)
             .all())
    return jsonify([i.to_dict() for i in items])


@inventory_bp.route('', methods=['POST'])
@jwt_required()
def create_inventory_item():
    """Create a new inventory item. MANAGER/ADMIN only.

    Required fields: name, base_unit_key.
    Optional: sku, supplier, category, item_type, stock_quantity (initial),
              unit_cost_cents (initial WAC), low_stock_threshold,
              purchase_unit_key, purchase_pack_size, shots_per_bottle, yields_item_id.
    """
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    base_unit_key = (data.get('base_unit_key') or '').strip()

    if not name:
        return jsonify({'error': 'VALIDATION', 'message': 'name is required'}), 422
    if not base_unit_key:
        return jsonify({'error': 'VALIDATION', 'message': 'base_unit_key is required'}), 422

    # Validate base_unit_key exists
    if not UnitCatalog.query.get(base_unit_key):
        return jsonify({'error': 'INVALID_UNIT',
                        'message': f"Unit '{base_unit_key}' not found in catalog"}), 422

    category  = data.get('category', 'other')
    item_type = data.get('item_type', 'STANDARD')

    if category not in VALID_CATEGORIES:
        return jsonify({'error': 'VALIDATION',
                        'message': f'category must be one of {VALID_CATEGORIES}'}), 422
    if item_type not in VALID_ITEM_TYPES:
        return jsonify({'error': 'VALIDATION',
                        'message': f'item_type must be one of {VALID_ITEM_TYPES}'}), 422

    purchase_unit_key = data.get('purchase_unit_key')
    if purchase_unit_key and not UnitCatalog.query.get(purchase_unit_key):
        return jsonify({'error': 'INVALID_UNIT',
                        'message': f"purchase_unit_key '{purchase_unit_key}' not in catalog"}), 422

    pack_size = data.get('purchase_pack_size', 1)
    if float(pack_size) <= 0:
        return jsonify({'error': 'VALIDATION',
                        'message': 'purchase_pack_size must be > 0'}), 422

    initial_qty  = data.get('stock_quantity', 0)
    initial_cost = data.get('unit_cost_cents', 0)
    if int(initial_cost) < 0:
        return jsonify({'error': 'VALIDATION',
                        'message': 'unit_cost_cents must be >= 0'}), 422

    item = InventoryItem(
        name                = name,
        sku                 = (data.get('sku') or '').strip() or None,
        supplier            = (data.get('supplier') or '').strip() or None,
        category            = category,
        item_type           = item_type,
        base_unit_key       = base_unit_key,
        stock_quantity      = initial_qty,
        low_stock_threshold = data.get('low_stock_threshold', 0),
        unit_cost_cents     = int(initial_cost),
        purchase_unit_key   = purchase_unit_key or None,
        purchase_pack_size  = pack_size,
        shots_per_bottle    = data.get('shots_per_bottle') or None,
        yields_item_id      = data.get('yields_item_id') or None,
    )
    db.session.add(item)

    # Write OPENING_STOCK movement if initial quantity > 0
    if float(initial_qty) > 0:
        from datetime import datetime, timezone
        from app.models.inventory import InventoryMovement
        db.session.flush()
        user_id = get_jwt_identity()
        mv = InventoryMovement(
            inventory_item_id = item.id,
            event_type        = 'OPENING_STOCK',
            quantity_delta    = initial_qty,
            quantity_after    = initial_qty,
            unit_cost_cents   = int(initial_cost),
            reason            = 'Stock inicial',
            performed_by      = user_id,
        )
        db.session.add(mv)

    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'DUPLICATE_NAME',
                        'message': f"An item named '{name}' already exists"}), 409

    return jsonify(item.to_dict()), 201


@inventory_bp.route('/<item_id>', methods=['PATCH'])
@jwt_required()
def update_inventory_item(item_id):
    """Update item metadata. MANAGER/ADMIN only.

    Note: unit_cost_cents (WAC) is NOT accepted here — it is managed exclusively
    by restock operations. To correct WAC, use a restock with the correct cost.
    """
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    item = InventoryItem.query.get_or_404(item_id)
    data = request.get_json() or {}

    if 'name' in data:
        item.name = (data['name'] or '').strip()
    if 'sku' in data:
        item.sku = (data['sku'] or '').strip() or None
    if 'supplier' in data:
        item.supplier = (data['supplier'] or '').strip() or None
    if 'category' in data:
        if data['category'] not in VALID_CATEGORIES:
            return jsonify({'error': 'VALIDATION',
                            'message': f'category must be one of {VALID_CATEGORIES}'}), 422
        item.category = data['category']
    if 'item_type' in data:
        if data['item_type'] not in VALID_ITEM_TYPES:
            return jsonify({'error': 'VALIDATION',
                            'message': f'item_type must be one of {VALID_ITEM_TYPES}'}), 422
        item.item_type = data['item_type']
    if 'base_unit_key' in data:
        if not UnitCatalog.query.get(data['base_unit_key']):
            return jsonify({'error': 'INVALID_UNIT',
                            'message': f"Unit '{data['base_unit_key']}' not in catalog"}), 422
        item.base_unit_key = data['base_unit_key']
    if 'purchase_cost_cents' in data:
        item.purchase_cost_cents = int(data['purchase_cost_cents']) if data['purchase_cost_cents'] is not None else None
    if 'purchase_cost_pesos' in data:
        pesos = data['purchase_cost_pesos']
        item.purchase_cost_cents = round(float(pesos) * 100) if pesos is not None else None
    if 'purchase_unit_key' in data:
        pu = data['purchase_unit_key'] or None
        if pu and not UnitCatalog.query.get(pu):
            return jsonify({'error': 'INVALID_UNIT',
                            'message': f"purchase_unit_key '{pu}' not in catalog"}), 422
        item.purchase_unit_key = pu
    if 'purchase_pack_size' in data:
        ps = data['purchase_pack_size']
        if float(ps) <= 0:
            return jsonify({'error': 'VALIDATION',
                            'message': 'purchase_pack_size must be > 0'}), 422
        item.purchase_pack_size = ps
    if 'low_stock_threshold' in data:
        item.low_stock_threshold = data['low_stock_threshold']
    if 'shots_per_bottle' in data:
        item.shots_per_bottle = data['shots_per_bottle'] or None
    if 'yields_item_id' in data:
        item.yields_item_id = data['yields_item_id'] or None
    if 'is_active' in data:
        item.is_active = bool(data['is_active'])

    from datetime import datetime, timezone
    item.updated_at = datetime.now(timezone.utc)

    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'DUPLICATE_NAME',
                        'message': 'Another item already has that name or SKU'}), 409

    return jsonify(item.to_dict())


@inventory_bp.route('/<item_id>', methods=['DELETE'])
@jwt_required()
def delete_inventory_item(item_id):
    """Hard-delete an inventory item and all its dependent records. ADMIN only."""
    claims = get_jwt()
    err = _require_admin(claims)
    if err:
        return err

    item = InventoryItem.query.get_or_404(item_id)
    snapshot = item.to_dict()

    from app.models.inventory import ModifierInventoryRule, OpenCigaretteBox

    movement_count = InventoryMovement.query.filter_by(inventory_item_id=item_id).count()

    SaleItemCost.query.filter_by(inventory_item_id=item_id).delete()
    InventoryMovement.query.filter_by(inventory_item_id=item_id).delete()
    ModifierInventoryRule.query.filter_by(inventory_item_id=item_id).delete()
    OpenCigaretteBox.query.filter_by(box_item_id=item_id).delete()
    InsumoBase.query.filter_by(inventory_item_id=item_id).delete()
    # Legacy table
    from app.models.inventory import MenuItemIngredient
    MenuItemIngredient.query.filter_by(inventory_item_id=item_id).delete()
    InventoryItem.query.filter_by(yields_item_id=item_id).update({'yields_item_id': None})

    db.session.delete(item)

    user_id = get_jwt_identity()
    audit_svc.log(
        user_id, 'INVENTORY_ITEM_DELETED', 'inventory_item', item_id,
        before=snapshot,
        reason=f'Admin delete. {movement_count} movement records deleted.',
    )
    db.session.commit()
    return jsonify({'ok': True, 'movements_deleted': movement_count})


# ── Stock Operations ──────────────────────────────────────────────────────────

@inventory_bp.route('/<item_id>/restock', methods=['POST'])
@jwt_required()
def restock(item_id):
    """Restock an inventory item with WAC recalculation. MANAGER/ADMIN only.

    For drinks/general items (default mode):
      Body: { purchase_quantity, unit_cost_per_purchase_unit_cents,
              pack_size_override?, purchase_unit_key_override?, reason? }

    For food items:
      Body: { portion_count, total_purchase_cost_cents, reason? }

    The backend auto-selects the mode: presence of 'portion_count' triggers food mode.
    Food mode is only permitted for items with category='food'.
    """
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    user_id = get_jwt_identity()
    data    = request.get_json() or {}

    try:
        if 'portion_count' in data:
            # Food portion mode
            portion_count = data.get('portion_count')
            total_cost    = data.get('total_purchase_cost_cents', 0)
            if portion_count is None:
                return jsonify({'error': 'VALIDATION',
                                'message': 'portion_count is required'}), 422

            item = inventory_svc.restock_food_portions(
                item_id,
                portion_count      = portion_count,
                total_purchase_cost_cents = int(total_cost),
                performed_by       = user_id,
                reason             = data.get('reason'),
            )
        else:
            # Drinks / general mode
            purchase_qty  = data.get('purchase_quantity')
            cost_per_unit = data.get('unit_cost_per_purchase_unit_cents')

            if purchase_qty is None:
                return jsonify({'error': 'VALIDATION',
                                'message': 'purchase_quantity is required'}), 422
            if cost_per_unit is None:
                return jsonify({'error': 'VALIDATION',
                                'message': 'unit_cost_per_purchase_unit_cents is required'}), 422

            item = inventory_svc.restock_drinks(
                item_id,
                purchase_quantity                    = purchase_qty,
                unit_cost_per_purchase_unit_cents    = int(cost_per_unit),
                performed_by                         = user_id,
                pack_size_override                   = data.get('pack_size_override'),
                purchase_unit_key_override           = data.get('purchase_unit_key_override'),
                reason                               = data.get('reason'),
            )

        audit_svc.log(user_id, 'INVENTORY_RESTOCK', 'inventory_item', item_id,
                      after={'stock_quantity': float(item.stock_quantity),
                             'unit_cost_cents': item.unit_cost_cents})
        db.session.commit()
        return jsonify(item.to_dict())

    except ValueError as e:
        db.session.rollback()
        msg = str(e)
        if 'not found' in msg.lower():
            return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
        return jsonify({'error': 'VALIDATION', 'message': msg}), 422


@inventory_bp.route('/<item_id>/adjust', methods=['POST'])
@jwt_required()
def adjust_inventory(item_id):
    """Manual stock adjustment. MANAGER/ADMIN only.

    Body: { event_type, qty_delta | waste_quantity | counted_quantity, reason }

    event_type must be one of: WASTE, COUNT_ADJUSTMENT, MANUAL_ADJUSTMENT.
      - WASTE:             requires waste_quantity (> 0, <= stock)
      - COUNT_ADJUSTMENT:  requires counted_quantity (>= 0); qty_delta computed
      - MANUAL_ADJUSTMENT: requires qty_delta (signed); cannot make stock negative
    """
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    user_id = get_jwt_identity()
    data    = request.get_json() or {}
    event_type = (data.get('event_type') or '').strip()
    reason     = (data.get('reason') or '').strip()

    if not event_type:
        return jsonify({'error': 'VALIDATION',
                        'message': 'event_type is required'}), 422
    if event_type not in VALID_ADJUST_TYPES:
        return jsonify({'error': 'VALIDATION',
                        'message': f'event_type must be one of {VALID_ADJUST_TYPES}'}), 422
    if not reason:
        return jsonify({'error': 'REASON_REQUIRED',
                        'message': 'Reason is required for adjustments'}), 422

    try:
        if event_type == 'WASTE':
            waste_qty = data.get('waste_quantity')
            if waste_qty is None:
                return jsonify({'error': 'VALIDATION',
                                'message': 'waste_quantity is required'}), 422
            item = inventory_svc.record_waste(item_id, waste_qty, reason, user_id)

        elif event_type == 'COUNT_ADJUSTMENT':
            counted = data.get('counted_quantity')
            if counted is None:
                return jsonify({'error': 'VALIDATION',
                                'message': 'counted_quantity is required'}), 422
            item = inventory_svc.record_count_adjustment(item_id, counted, reason, user_id)

        else:  # MANUAL_ADJUSTMENT
            qty_delta = data.get('qty_delta')
            if qty_delta is None:
                return jsonify({'error': 'VALIDATION',
                                'message': 'qty_delta is required'}), 422
            item = inventory_svc.manual_adjust(item_id, qty_delta, reason, user_id)

        audit_svc.log(user_id, f'INVENTORY_{event_type}', 'inventory_item', item_id,
                      after={'stock_quantity': float(item.stock_quantity), 'reason': reason})
        db.session.commit()
        return jsonify(item.to_dict())

    except ValueError as e:
        db.session.rollback()
        msg = str(e)
        if 'not found' in msg.lower():
            return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
        if 'WOULD_GO_NEGATIVE' in msg or 'WASTE_EXCEEDS_STOCK' in msg:
            return jsonify({'error': 'WOULD_GO_NEGATIVE', 'message': msg}), 422
        return jsonify({'error': 'VALIDATION', 'message': msg}), 422


@inventory_bp.route('/<item_id>/movements', methods=['GET'])
@jwt_required()
def get_movements(item_id):
    """Return movement history for an item (newest first, capped at 200). MANAGER/ADMIN."""
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    item = InventoryItem.query.get_or_404(item_id)
    movements = (InventoryMovement.query
                 .filter_by(inventory_item_id=item_id)
                 .order_by(InventoryMovement.created_at.desc())
                 .limit(200)
                 .all())

    # For rows with quantity_after (new schema rows), use it directly.
    # For legacy rows (quantity_after = NULL), compute running balance backward.
    result = []
    balance = float(item.stock_quantity)
    for mv in movements:
        d = mv.to_dict()
        if mv.quantity_after is not None:
            d['quantity_after'] = float(mv.quantity_after)
        else:
            # Legacy row: derive from running balance walk
            d['quantity_after'] = balance
            balance -= float(mv.quantity_delta)
        d['performer_name'] = mv.performer.username if mv.performer else '—'
        result.append(d)

    return jsonify(result)


@inventory_bp.route('/stock-check', methods=['GET'])
@jwt_required()
def stock_check():
    """Real-time stock availability check for the POS floor view.

    Returns blocked_items, blocked_modifiers, low_stock_item_ids,
    remaining_by_item, and low_stock_items.
    Uses Numeric quantities throughout (Decimal-safe comparisons).
    """
    from app.models.menu import MenuItem, Modifier
    from app.models.inventory import ModifierInventoryRule
    from decimal import Decimal

    inv_qty = {i.id: i.stock_quantity for i in InventoryItem.query.all()}

    blocked_items = []
    for mi in MenuItem.query.filter_by(is_active=True).all():
        for ing in InsumoBase.query.filter_by(menu_item_id=mi.id).all():
            avail = inv_qty.get(ing.inventory_item_id, Decimal(0))
            if avail < ing.quantity:
                blocked_items.append(mi.id)
                break

    blocked_modifiers = []
    for mod in Modifier.query.all():
        for rule in ModifierInventoryRule.query.filter_by(modifier_id=mod.id).all():
            avail = inv_qty.get(rule.inventory_item_id, Decimal(0))
            if avail < rule.quantity:
                blocked_modifiers.append(mod.id)
                break

    inv_obj = {i.id: i for i in InventoryItem.query.all()}
    low_stock_item_ids = []
    remaining_by_item  = {}

    for mi in MenuItem.query.filter_by(is_active=True).all():
        if mi.id in blocked_items:
            remaining_by_item[mi.id] = 0
            continue
        ings = InsumoBase.query.filter_by(menu_item_id=mi.id).all()
        if not ings:
            continue
        max_servings = None
        is_low = False
        for ing in ings:
            inv = inv_obj.get(ing.inventory_item_id)
            if inv and ing.quantity > 0:
                servings = int(inv.stock_quantity // ing.quantity)
                if max_servings is None or servings < max_servings:
                    max_servings = servings
                if 0 < inv.stock_quantity <= inv.low_stock_threshold:
                    is_low = True
        if max_servings is not None:
            remaining_by_item[mi.id] = max_servings
            if is_low:
                low_stock_item_ids.append(mi.id)

    return jsonify({
        'blocked_items':      blocked_items,
        'blocked_modifiers':  blocked_modifiers,
        'low_stock_item_ids': low_stock_item_ids,
        'remaining_by_item':  remaining_by_item,
        'low_stock_items': [
            {
                'id':        i.id,
                'name':      i.name,
                'quantity':  float(i.stock_quantity),
                'threshold': float(i.low_stock_threshold),
            }
            for i in InventoryItem.query.filter(
                InventoryItem.stock_quantity > 0,
                InventoryItem.stock_quantity <= InventoryItem.low_stock_threshold,
            ).all()
        ],
    })


# ── Bottle / Box Opening ──────────────────────────────────────────────────────

@inventory_bp.route('/<item_id>/open-bottle', methods=['POST'])
@jwt_required()
def open_bottle(item_id):
    """Open a sealed spirit bottle. MANAGER/ADMIN only."""
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    user_id = get_jwt_identity()
    try:
        bottle, shots = inventory_svc.open_bottle(item_id, user_id)
        audit_svc.log(user_id, 'BOTTLE_OPENED', 'inventory', item_id,
                      after={'shots_added': bottle.shots_per_bottle,
                             'shot_item': shots.name})
        db.session.commit()
        return jsonify({'bottle': bottle.to_dict(), 'shots': shots.to_dict()})
    except ValueError as e:
        db.session.rollback()
        msg = str(e)
        if 'NOT_FOUND' in msg:
            return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
        if 'NO_STOCK' in msg:
            return jsonify({'error': 'NO_STOCK', 'message': msg}), 422
        return jsonify({'error': 'NOT_A_BOTTLE', 'message': msg}), 422


@inventory_bp.route('/<item_id>/open-box', methods=['POST'])
@jwt_required()
def open_cigarette_box(item_id):
    """Open a sealed cigarette box. MANAGER/ADMIN only."""
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    user_id = get_jwt_identity()
    try:
        box, single, open_box = inventory_svc.open_cigarette_box(item_id, user_id)
        audit_svc.log(user_id, 'BOX_OPENED', 'inventory', item_id,
                      after={'cigs_added': box.shots_per_bottle,
                             'single_item': single.name})
        db.session.commit()
        return jsonify({
            'box':      box.to_dict(),
            'singles':  single.to_dict(),
            'open_box': open_box.to_dict(),
        })
    except ValueError as e:
        db.session.rollback()
        msg = str(e)
        if 'NOT_FOUND' in msg:
            return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
        if 'NO_STOCK' in msg:
            return jsonify({'error': 'NO_STOCK', 'message': msg}), 422
        return jsonify({'error': 'VALIDATION', 'message': msg}), 422


@inventory_bp.route('/open-boxes', methods=['GET'])
@jwt_required()
def list_open_boxes():
    """Return all currently open (not finished) cigarette boxes."""
    boxes = (OpenCigaretteBox.query
             .filter_by(is_finished=False)
             .order_by(OpenCigaretteBox.opened_at.desc())
             .all())
    return jsonify([b.to_dict() for b in boxes])


# ── Insumos Base ──────────────────────────────────────────────────────────────

@inventory_bp.route('/insumos-base/<menu_item_id>', methods=['GET'])
@jwt_required()
def get_insumos_base(menu_item_id):
    """Return all Insumos Base recipe links for a menu item."""
    links = InsumoBase.query.filter_by(menu_item_id=menu_item_id).all()
    return jsonify([l.to_dict() for l in links])


@inventory_bp.route('/insumos-base', methods=['POST'])
@jwt_required()
def add_insumo_base():
    """Add or update an Insumos Base link (recipe). MANAGER/ADMIN only.

    Body: { menu_item_id, inventory_item_id, quantity, deduction_unit_key?, notes? }

    If a link for (menu_item_id, inventory_item_id) already exists, quantity is updated.
    The DB UNIQUE constraint prevents concurrent-insert duplicates; IntegrityError is
    caught and treated as an update.
    deduction_unit_key defaults to the inventory item's base_unit_key if not provided.
    """
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    data            = request.get_json() or {}
    menu_item_id    = (data.get('menu_item_id') or '').strip()
    inventory_item_id = (data.get('inventory_item_id') or '').strip()
    quantity        = data.get('quantity', 1)
    notes           = (data.get('notes') or '').strip() or None

    if not menu_item_id:
        return jsonify({'error': 'VALIDATION', 'message': 'menu_item_id required'}), 422
    if not inventory_item_id:
        return jsonify({'error': 'VALIDATION', 'message': 'inventory_item_id required'}), 422
    if float(quantity) <= 0:
        return jsonify({'error': 'VALIDATION', 'message': 'quantity must be > 0'}), 422

    # Resolve deduction_unit_key
    inv_item = InventoryItem.query.get(inventory_item_id)
    if not inv_item:
        return jsonify({'error': 'NOT_FOUND', 'message': 'Inventory item not found'}), 404

    deduction_unit_key = (data.get('deduction_unit_key') or '').strip() or inv_item.base_unit_key
    if not UnitCatalog.query.get(deduction_unit_key):
        return jsonify({'error': 'INVALID_UNIT',
                        'message': f"deduction_unit_key '{deduction_unit_key}' not in catalog"}), 422

    # Application-level upsert; DB UNIQUE constraint protects against races
    existing = InsumoBase.query.filter_by(
        menu_item_id=menu_item_id,
        inventory_item_id=inventory_item_id,
    ).first()

    if existing:
        existing.quantity           = quantity
        existing.deduction_unit_key = deduction_unit_key
        existing.notes              = notes
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        return jsonify(existing.to_dict()), 200

    link = InsumoBase(
        menu_item_id       = menu_item_id,
        inventory_item_id  = inventory_item_id,
        quantity           = quantity,
        deduction_unit_key = deduction_unit_key,
        notes              = notes,
    )
    db.session.add(link)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        # Race: another request inserted the same pair; fetch and update
        existing = InsumoBase.query.filter_by(
            menu_item_id=menu_item_id,
            inventory_item_id=inventory_item_id,
        ).first()
        if existing:
            existing.quantity           = quantity
            existing.deduction_unit_key = deduction_unit_key
            existing.notes              = notes
            db.session.commit()
            return jsonify(existing.to_dict()), 200
        return jsonify({'error': 'CONFLICT',
                        'message': 'Could not create or update ingredient link'}), 409

    return jsonify(link.to_dict()), 201


@inventory_bp.route('/insumos-base/<ingredient_id>', methods=['DELETE'])
@jwt_required()
def delete_insumo_base(ingredient_id):
    """Remove an Insumos Base recipe link. MANAGER/ADMIN only."""
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err

    link = InsumoBase.query.get(ingredient_id)
    if not link:
        return jsonify({'error': 'NOT_FOUND'}), 404
    db.session.delete(link)
    db.session.commit()
    return jsonify({'ok': True})


# ── Legacy: item-ingredients (kept for any external callers) ──────────────────

@inventory_bp.route('/item-ingredients/<menu_item_id>', methods=['GET'])
@jwt_required()
def get_item_ingredients_legacy(menu_item_id):
    """Legacy endpoint — redirects to InsumoBase data. Use /insumos-base/ instead."""
    links = InsumoBase.query.filter_by(menu_item_id=menu_item_id).all()
    return jsonify([{
        'id':                  l.id,
        'menu_item_id':        l.menu_item_id,
        'inventory_item_id':   l.inventory_item_id,
        'inventory_item_name': l.inventory_item.name if l.inventory_item else None,
        'inventory_item_unit': l.deduction_unit_key,
        'quantity':            float(l.quantity),
    } for l in links])
