from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity
from app.extensions import db
from app.models.menu import MenuCategory, MenuItem, ModifierGroup, Modifier, MenuItemModifierGroup

menu_bp = Blueprint('menu', __name__)


@menu_bp.route('/categories', methods=['GET'])
@jwt_required()
def list_categories():
    cats = MenuCategory.query.order_by(MenuCategory.sort_order).all()
    return jsonify([c.to_dict() for c in cats])


@menu_bp.route('/items', methods=['GET'])
@jwt_required()
def list_items():
    cat_id = request.args.get('category_id')
    include_inactive = request.args.get('include_inactive', 'false').lower() == 'true'
    q = MenuItem.query if include_inactive else MenuItem.query.filter_by(is_active=True)
    if cat_id:
        q = q.filter_by(category_id=cat_id)
    items = q.order_by(MenuItem.sort_order).all()
    return jsonify([i.to_dict(with_modifiers=True) for i in items])


@menu_bp.route('/items/<item_id>', methods=['GET'])
@jwt_required()
def get_item(item_id):
    item = MenuItem.query.get_or_404(item_id)
    return jsonify(item.to_dict(with_modifiers=True))


@menu_bp.route('/items', methods=['POST'])
@jwt_required()
def create_item():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    data = request.get_json()
    item = MenuItem(
        category_id=data['category_id'],
        name=data['name'],
        price_cents=data['price_cents'],
        requires_flavor=data.get('requires_flavor', False),
        sort_order=data.get('sort_order', 0)
    )
    db.session.add(item)
    db.session.commit()
    return jsonify(item.to_dict(with_modifiers=True)), 201


@menu_bp.route('/items/<item_id>', methods=['PATCH'])
@jwt_required()
def update_item(item_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    item = MenuItem.query.get_or_404(item_id)
    data = request.get_json()
    if 'price_cents' in data: item.price_cents = data['price_cents']
    if 'is_active' in data: item.is_active = data['is_active']
    if 'name' in data: item.name = data['name']
    db.session.commit()
    return jsonify(item.to_dict())


@menu_bp.route('/modifiers', methods=['GET'])
@jwt_required()
def list_modifiers():
    groups = ModifierGroup.query.all()
    return jsonify([g.to_dict() for g in groups])


@menu_bp.route('/items/<item_id>/modifier-groups', methods=['PUT'])
@jwt_required()
def set_item_modifier_groups(item_id):
    """Replace the modifier groups attached to an item."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    item = MenuItem.query.get_or_404(item_id)
    data = request.get_json()
    group_ids = data.get('modifier_group_ids', [])
    # Remove all existing links
    MenuItemModifierGroup.query.filter_by(menu_item_id=item_id).delete()
    # Add new links
    for gid in group_ids:
        db.session.add(MenuItemModifierGroup(menu_item_id=item_id, modifier_group_id=gid))
    db.session.commit()
    return jsonify(item.to_dict(with_modifiers=True))
