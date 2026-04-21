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
    movements = StockMovement.query.filter_by(inventory_item_id=item_id)\
        .order_by(StockMovement.created_at.desc()).limit(200).all()
    return jsonify([m.to_dict() for m in movements])


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
    if 'cost_cents' in data:
        item.cost_cents = data['cost_cents']
    db.session.commit()
    return jsonify(item.to_dict())



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

    return jsonify({
        'blocked_items': blocked_items,
        'blocked_modifiers': blocked_modifiers
    })



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
