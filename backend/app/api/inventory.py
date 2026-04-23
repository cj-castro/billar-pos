from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from app.extensions import db
from app.models.inventory import InventoryItem, StockMovement, MenuItemIngredient
from app.services import inventory_svc, audit_svc

inventory_bp = Blueprint('inventory', __name__)


@inventory_bp.route('', methods=['GET'])
@jwt_required()
def list_inventory():
    items = InventoryItem.query.order_by(InventoryItem.category, InventoryItem.name).all()
    return jsonify([i.to_dict() for i in items])


@inventory_bp.route('/<item_id>/movements', methods=['GET'])
@jwt_required()
def get_movements(item_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    item = InventoryItem.query.get_or_404(item_id)
    movements = StockMovement.query.filter_by(inventory_item_id=item_id)\
        .order_by(StockMovement.created_at.desc()).limit(200).all()

    # Compute running balance: current qty, then subtract deltas going back in time
    balance = item.quantity
    result = []
    for m in movements:
        d = m.to_dict()
        d['quantity_after'] = balance
        d['performer_name'] = m.performer.username if m.performer else '—'
        balance -= m.quantity_delta
        result.append(d)
    return jsonify(result)


@inventory_bp.route('/<item_id>/adjust', methods=['POST'])
@jwt_required()
def adjust_inventory(item_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    data = request.get_json()
    qty_delta = data.get('qty_delta')
    reason = data.get('reason', '').strip()

    if qty_delta is None:
        return jsonify({'error': 'qty_delta required'}), 422
    if not reason:
        return jsonify({'error': 'REASON_REQUIRED', 'message': 'Reason is required for manual adjustments'}), 422

    item = inventory_svc.manual_adjust(item_id, qty_delta, reason, user_id)
    audit_svc.log(user_id, 'INVENTORY_ADJUSTMENT', 'inventory', item_id,
                  after={'qty_delta': qty_delta, 'reason': reason})
    db.session.commit()
    return jsonify(item.to_dict())


@inventory_bp.route('', methods=['POST'])
@jwt_required()
def create_inventory_item():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    data = request.get_json()
    item = InventoryItem(
        name=data['name'],
        unit=data.get('unit', 'serving'),
        quantity=data.get('quantity', 0),
        low_stock_threshold=data.get('low_stock_threshold', 10),
        cost_cents=data.get('cost_cents', 0),
        category=data.get('category', 'other'),
        item_type=data.get('item_type', 'STANDARD'),
        shots_per_bottle=data.get('shots_per_bottle'),
        yields_item_id=data.get('yields_item_id'),
    )
    db.session.add(item)
    db.session.commit()
    return jsonify(item.to_dict()), 201


@inventory_bp.route('/<item_id>', methods=['PATCH'])
@jwt_required()
def update_inventory_item(item_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    item = InventoryItem.query.get_or_404(item_id)
    data = request.get_json()
    if 'name' in data:
        item.name = data['name']
    if 'unit' in data:
        item.unit = data['unit']
    if 'category' in data:
        item.category = data['category']
    if 'low_stock_threshold' in data:
        item.low_stock_threshold = data['low_stock_threshold']
    if 'shots_per_bottle' in data:
        item.shots_per_bottle = data['shots_per_bottle'] or None
    if 'item_type' in data:
        item.item_type = data['item_type'] or 'STANDARD'
    if 'yields_item_id' in data:
        item.yields_item_id = data['yields_item_id'] or None
    if 'cost_cents' in data:
        item.cost_cents = data['cost_cents']
    db.session.commit()
    return jsonify(item.to_dict())


@inventory_bp.route('/<item_id>', methods=['DELETE'])
@jwt_required()
def delete_inventory_item(item_id):
    claims = get_jwt()
    if claims.get('role') != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN', 'message': 'Solo un administrador puede eliminar artículos de inventario.'}), 403

    item = InventoryItem.query.get_or_404(item_id)
    item_snapshot = item.to_dict()

    from app.models.inventory import StockMovement, ModifierInventoryRule, OpenCigaretteBox, MenuItemIngredient

    # Count history for audit record
    movement_count = StockMovement.query.filter_by(inventory_item_id=item_id).count()

    # Cascade delete all dependent records
    StockMovement.query.filter_by(inventory_item_id=item_id).delete()
    ModifierInventoryRule.query.filter_by(inventory_item_id=item_id).delete()
    OpenCigaretteBox.query.filter_by(box_item_id=item_id).delete()
    MenuItemIngredient.query.filter_by(inventory_item_id=item_id).delete()

    # Also unlink if this item was a yields_item_id (bottle/box child item)
    InventoryItem.query.filter_by(yields_item_id=item_id).update({'yields_item_id': None})

    db.session.delete(item)

    # Audit log
    user_id = get_jwt_identity()
    audit_svc.log(
        user_id=user_id,
        action='INVENTORY_ITEM_DELETED',
        entity_type='inventory_item',
        entity_id=item_id,
        before=item_snapshot,
        reason=f'Admin hard-delete. {movement_count} movimientos de stock eliminados.',
    )

    db.session.commit()
    return jsonify({'ok': True, 'movements_deleted': movement_count})



@inventory_bp.route('/<item_id>/open-bottle', methods=['POST'])
@jwt_required()
def open_bottle(item_id):
    """Manager opens a sealed spirit bottle → decrements bottles, increments shots."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    bottle_item = InventoryItem.query.get(item_id)
    if not bottle_item:
        return jsonify({'error': 'NOT_FOUND'}), 404
    if not bottle_item.shots_per_bottle or not bottle_item.yields_item_id:
        return jsonify({'error': 'NOT_A_BOTTLE', 'message': 'This item is not configured as a bottle'}), 422
    if bottle_item.quantity < 1:
        return jsonify({'error': 'NO_STOCK', 'message': 'No sealed bottles in stock'}), 422

    shot_item = InventoryItem.query.get(bottle_item.yields_item_id)
    if not shot_item:
        return jsonify({'error': 'YIELDS_ITEM_NOT_FOUND'}), 404

    # Decrement bottle
    bottle_item.quantity -= 1
    db.session.add(StockMovement(
        inventory_item_id=bottle_item.id,
        event_type='BOTTLE_OPENING',
        quantity_delta=-1,
        reason=f'Opened bottle → {bottle_item.shots_per_bottle} shots added to {shot_item.name}',
        performed_by=user_id
    ))

    # Increment shots
    shot_item.quantity += bottle_item.shots_per_bottle
    db.session.add(StockMovement(
        inventory_item_id=shot_item.id,
        event_type='BOTTLE_OPENING',
        quantity_delta=bottle_item.shots_per_bottle,
        reason=f'Opened from {bottle_item.name}',
        performed_by=user_id
    ))

    audit_svc.log(user_id, 'BOTTLE_OPENED', 'inventory', item_id,
                  after={'shots_added': bottle_item.shots_per_bottle, 'shot_item': shot_item.name})
    db.session.commit()
    return jsonify({
        'bottle': bottle_item.to_dict(),
        'shots': shot_item.to_dict()
    })


@inventory_bp.route('/stock-check', methods=['GET'])
@jwt_required()
def stock_check():
    """
    Returns sets of menu_item_ids and modifier_ids that cannot be sold
    because at least one required inventory item is at 0.
    """
    from app.models.menu import MenuItem, Modifier
    from app.models.inventory import ModifierInventoryRule

    # Build a quick lookup: inventory_item_id -> quantity
    inv_qty = {i.id: i.quantity for i in InventoryItem.query.all()}

    blocked_items = []
    for mi in MenuItem.query.filter_by(is_active=True).all():
        for ing in MenuItemIngredient.query.filter_by(menu_item_id=mi.id).all():
            if inv_qty.get(ing.inventory_item_id, 0) < ing.quantity:
                blocked_items.append(mi.id)
                break

    blocked_modifiers = []
    for mod in Modifier.query.all():
        for rule in ModifierInventoryRule.query.filter_by(modifier_id=mod.id).all():
            if inv_qty.get(rule.inventory_item_id, 0) < rule.quantity:
                blocked_modifiers.append(mod.id)
                break

    # Items that are low on stock (not blocked, but close)
    # Also compute max servings per menu item (min across all ingredients)
    low_stock_item_ids = []
    remaining_by_item: dict = {}  # menu_item_id -> max servings remaining

    inv_obj = {i.id: i for i in InventoryItem.query.all()}

    for mi in MenuItem.query.filter_by(is_active=True).all():
        if mi.id in blocked_items:
            remaining_by_item[mi.id] = 0
            continue
        ings = MenuItemIngredient.query.filter_by(menu_item_id=mi.id).all()
        if not ings:
            continue  # no inventory tracking for this item
        max_servings = None
        is_low = False
        for ing in ings:
            inv = inv_obj.get(ing.inventory_item_id)
            if inv:
                servings = inv.quantity // ing.quantity if ing.quantity > 0 else inv.quantity
                if max_servings is None or servings < max_servings:
                    max_servings = servings
                if 0 < inv.quantity <= inv.low_stock_threshold:
                    is_low = True
        if max_servings is not None:
            remaining_by_item[mi.id] = max_servings
            if is_low:
                low_stock_item_ids.append(mi.id)

    return jsonify({
        'blocked_items': blocked_items,
        'blocked_modifiers': blocked_modifiers,
        'low_stock_item_ids': low_stock_item_ids,
        'remaining_by_item': remaining_by_item,
        'low_stock_items': [
            {'id': i.id, 'name': i.name, 'quantity': i.quantity, 'threshold': i.low_stock_threshold}
            for i in InventoryItem.query.filter(
                InventoryItem.quantity > 0,
                InventoryItem.quantity <= InventoryItem.low_stock_threshold
            ).all()
        ]
    })



@inventory_bp.route('/item-ingredients/<menu_item_id>', methods=['GET'])
@jwt_required()
def get_item_ingredients(menu_item_id):
    """Get recipe/ingredients for a menu item."""
    ingredients = MenuItemIngredient.query.filter_by(menu_item_id=menu_item_id).all()
    return jsonify([i.to_dict() for i in ingredients])


@inventory_bp.route('/item-ingredients', methods=['POST'])
@jwt_required()
def add_item_ingredient():
    """Add an ingredient to a menu item recipe (manager only). Upserts on duplicate."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    data = request.get_json()
    # Check for existing link to prevent duplicates
    existing = MenuItemIngredient.query.filter_by(
        menu_item_id=data['menu_item_id'],
        inventory_item_id=data['inventory_item_id']
    ).first()
    if existing:
        existing.quantity = data.get('quantity', existing.quantity)
        db.session.commit()
        return jsonify(existing.to_dict()), 200
    ing = MenuItemIngredient(
        menu_item_id=data['menu_item_id'],
        inventory_item_id=data['inventory_item_id'],
        quantity=data.get('quantity', 1),
    )
    db.session.add(ing)
    db.session.commit()
    return jsonify(ing.to_dict()), 201


@inventory_bp.route('/item-ingredients/<ingredient_id>', methods=['DELETE'])
@jwt_required()
def delete_item_ingredient(ingredient_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    ing = MenuItemIngredient.query.get(ingredient_id)
    if not ing:
        return jsonify({'error': 'NOT_FOUND'}), 404
    db.session.delete(ing)
    db.session.commit()
    return jsonify({'ok': True})


# ── Cigarette Box Management ─────────────────────────────────────────────────

@inventory_bp.route('/open-boxes', methods=['GET'])
@jwt_required()
def list_open_boxes():
    """Return all currently open (not finished) cigarette boxes."""
    from app.models.inventory import OpenCigaretteBox
    boxes = OpenCigaretteBox.query.filter_by(is_finished=False)\
        .order_by(OpenCigaretteBox.opened_at.desc()).all()
    return jsonify([b.to_dict() for b in boxes])


@inventory_bp.route('/<item_id>/open-box', methods=['POST'])
@jwt_required()
def open_cigarette_box(item_id):
    """
    Manager opens a sealed cigarette box:
    - Decrements box quantity by 1
    - Increments single-cig quantity by cigs_per_box
    - Creates an OpenCigaretteBox tracking record
    """
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    from app.models.inventory import OpenCigaretteBox

    box_item = InventoryItem.query.with_for_update().get(item_id)
    if not box_item:
        return jsonify({'error': 'NOT_FOUND'}), 404
    if box_item.item_type != 'CIG_BOX':
        return jsonify({'error': 'NOT_A_CIG_BOX', 'message': 'Este artículo no es una caja de cigarros'}), 422
    if not box_item.shots_per_bottle or not box_item.yields_item_id:
        return jsonify({'error': 'NOT_CONFIGURED', 'message': 'La caja no tiene configurada la cantidad de cigarros o el artículo individual'}), 422
    if box_item.quantity < 1:
        return jsonify({'error': 'NO_STOCK', 'message': 'No hay cajas selladas en inventario'}), 422

    single_item = InventoryItem.query.with_for_update().get(box_item.yields_item_id)
    if not single_item:
        return jsonify({'error': 'SINGLE_ITEM_NOT_FOUND'}), 404

    cigs_per_box = box_item.shots_per_bottle

    # Decrement sealed boxes
    box_item.quantity -= 1
    db.session.add(StockMovement(
        inventory_item_id=box_item.id,
        event_type='BOX_OPENING',
        quantity_delta=-1,
        reason=f'Caja abierta → {cigs_per_box} cigarros individuales añadidos a {single_item.name}',
        performed_by=user_id
    ))

    # Increment singles
    single_item.quantity += cigs_per_box
    db.session.add(StockMovement(
        inventory_item_id=single_item.id,
        event_type='BOX_OPENING',
        quantity_delta=cigs_per_box,
        reason=f'Apertura de caja: {box_item.name}',
        performed_by=user_id
    ))

    # Create open box tracking record
    open_box = OpenCigaretteBox(
        box_item_id=box_item.id,
        brand=box_item.name,
        cigs_per_box=cigs_per_box,
        cigs_sold=0,
        opened_by=user_id,
    )
    db.session.add(open_box)

    audit_svc.log(user_id, 'BOX_OPENED', 'inventory', item_id,
                  after={'cigs_added': cigs_per_box, 'single_item': single_item.name})
    db.session.commit()

    from app.extensions import socketio
    socketio.emit('inventory:box_opened', {
        'brand': box_item.name,
        'cigs_per_box': cigs_per_box,
        'open_box_id': open_box.id,
    })

    return jsonify({'box': box_item.to_dict(), 'singles': single_item.to_dict(), 'open_box': open_box.to_dict()})
