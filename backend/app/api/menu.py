from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity
from app.extensions import db
from app.models.menu import MenuCategory, MenuItem, ModifierGroup, Modifier, MenuItemModifierGroup
from app.services import audit_svc

menu_bp = Blueprint('menu', __name__)


@menu_bp.route('/categories', methods=['GET'])
@jwt_required()
def list_categories():
    cats = MenuCategory.query.order_by(MenuCategory.sort_order).all()
    return jsonify([c.to_dict() for c in cats])


@menu_bp.route('/categories', methods=['POST'])
@jwt_required()
def create_category():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    data = request.get_json()
    if not data.get('name', '').strip():
        return jsonify({'error': 'NAME_REQUIRED'}), 422
    cat = MenuCategory(
        name=data['name'].strip(),
        routing=data.get('routing', 'BAR').upper(),
        sort_order=data.get('sort_order', 0),
    )
    db.session.add(cat)
    db.session.commit()
    return jsonify(cat.to_dict()), 201


@menu_bp.route('/categories/<cat_id>', methods=['PATCH'])
@jwt_required()
def update_category(cat_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    cat = MenuCategory.query.get_or_404(cat_id)
    data = request.get_json()
    if 'name' in data: cat.name = data['name'].strip()
    if 'routing' in data: cat.routing = data['routing'].upper()
    if 'sort_order' in data: cat.sort_order = data['sort_order']
    db.session.commit()
    return jsonify(cat.to_dict())


@menu_bp.route('/categories/<cat_id>', methods=['DELETE'])
@jwt_required()
def delete_category(cat_id):
    claims = get_jwt()
    if claims.get('role') not in ('ADMIN',):
        return jsonify({'error': 'FORBIDDEN'}), 403
    cat = MenuCategory.query.get_or_404(cat_id)
    item_count = MenuItem.query.filter_by(category_id=cat_id).count()
    if item_count > 0:
        return jsonify({'error': f'La categoría tiene {item_count} productos. Elimínalos o muévelos primero.'}), 409
    db.session.delete(cat)
    db.session.commit()
    return jsonify({'ok': True})


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
    if 'requires_flavor' in data: item.requires_flavor = data['requires_flavor']
    if 'category_id' in data:
        from app.models.menu import MenuCategory
        if not MenuCategory.query.get(data['category_id']):
            return jsonify({'error': 'Categoría no encontrada'}), 404
        item.category_id = data['category_id']
    db.session.commit()
    return jsonify(item.to_dict())


@menu_bp.route('/items/<item_id>', methods=['DELETE'])
@jwt_required()
def delete_item(item_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'Solo un manager o administrador puede eliminar productos del menú.'}), 403
    item = MenuItem.query.get_or_404(item_id)

    # Snapshot before deletion for audit trail
    from app.models.menu import MenuCategory
    cat = MenuCategory.query.get(item.category_id)
    snapshot = {
        'name': item.name,
        'price_cents': item.price_cents,
        'category': cat.name if cat else None,
        'category_id': item.category_id,
        'is_active': item.is_active,
    }

    # Remove modifier group links and inventory ingredient links
    MenuItemModifierGroup.query.filter_by(menu_item_id=item_id).delete()
    from app.models.inventory import MenuItemIngredient
    MenuItemIngredient.query.filter_by(menu_item_id=item_id).delete()
    db.session.delete(item)

    user_id = get_jwt_identity()
    audit_svc.log(user_id, 'MENU_ITEM_DELETED', 'menu_item', item_id,
                  before=snapshot, reason=request.json.get('reason') if request.is_json else None)

    db.session.commit()
    return jsonify({'ok': True})


@menu_bp.route('/modifiers', methods=['GET'])
@jwt_required()
def list_modifiers():
    include_inactive = request.args.get('include_inactive', '0') == '1'
    groups = ModifierGroup.query.order_by(ModifierGroup.name).all()
    return jsonify([g.to_dict(include_inactive=include_inactive) for g in groups])


# ── Modifier Groups CRUD ─────────────────────────────────────────────────────

@menu_bp.route('/modifier-groups', methods=['POST'])
@jwt_required()
def create_modifier_group():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    data = request.get_json()
    if not data.get('name', '').strip():
        return jsonify({'error': 'NAME_REQUIRED'}), 422
    group = ModifierGroup(
        name=data['name'].strip(),
        is_mandatory=data.get('is_mandatory', True),
        min_selections=data.get('min_selections', 1),
        max_selections=data.get('max_selections', 1),
        allow_multiple=data.get('allow_multiple', False),
    )
    db.session.add(group)
    db.session.commit()
    return jsonify(group.to_dict()), 201


@menu_bp.route('/modifier-groups/<group_id>', methods=['PATCH'])
@jwt_required()
def update_modifier_group(group_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    group = ModifierGroup.query.get_or_404(group_id)
    data = request.get_json()
    if 'name' in data: group.name = data['name'].strip()
    if 'is_mandatory' in data: group.is_mandatory = data['is_mandatory']
    if 'min_selections' in data: group.min_selections = data['min_selections']
    if 'max_selections' in data: group.max_selections = data['max_selections']
    if 'allow_multiple' in data: group.allow_multiple = data['allow_multiple']
    db.session.commit()
    return jsonify(group.to_dict())


@menu_bp.route('/modifier-groups/<group_id>', methods=['DELETE'])
@jwt_required()
def delete_modifier_group(group_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    group = ModifierGroup.query.get_or_404(group_id)
    # Unlink from menu items first
    MenuItemModifierGroup.query.filter_by(modifier_group_id=group_id).delete()
    # Deactivate all modifiers in group instead of hard-delete (preserve history)
    for mod in group.modifiers:
        mod.is_active = False
    db.session.commit()
    db.session.delete(group)
    db.session.commit()
    return jsonify({'ok': True})


# ── Individual Modifiers CRUD ────────────────────────────────────────────────

@menu_bp.route('/modifier-groups/<group_id>/modifiers', methods=['POST'])
@jwt_required()
def create_modifier(group_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    group = ModifierGroup.query.get_or_404(group_id)
    data = request.get_json()
    if not data.get('name', '').strip():
        return jsonify({'error': 'NAME_REQUIRED'}), 422
    mod = Modifier(
        modifier_group_id=group.id,
        name=data['name'].strip(),
        price_cents=data.get('price_cents', 0),
        is_active=True,
    )
    db.session.add(mod)
    db.session.commit()
    return jsonify(mod.to_dict()), 201


@menu_bp.route('/modifiers/<modifier_id>', methods=['PATCH'])
@jwt_required()
def update_modifier(modifier_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    mod = Modifier.query.get_or_404(modifier_id)
    data = request.get_json()
    if 'name' in data: mod.name = data['name'].strip()
    if 'price_cents' in data: mod.price_cents = data['price_cents']
    if 'is_active' in data: mod.is_active = data['is_active']
    db.session.commit()
    return jsonify(mod.to_dict())


@menu_bp.route('/modifiers/<modifier_id>', methods=['DELETE'])
@jwt_required()
def delete_modifier(modifier_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    mod = Modifier.query.get_or_404(modifier_id)

    # Check if this modifier has ever been used in a ticket
    from app.models.ticket import LineItemModifier
    used = db.session.execute(
        db.select(LineItemModifier.id).where(LineItemModifier.modifier_id == modifier_id).limit(1)
    ).first()

    if used:
        # Soft-delete: preserve historical ticket data
        mod.is_active = False
        db.session.commit()
        return jsonify({'ok': True, 'soft': True})
    else:
        # Hard delete: remove inventory rules then the modifier itself
        from app.models.inventory import ModifierInventoryRule
        ModifierInventoryRule.query.filter_by(modifier_id=modifier_id).delete()
        db.session.delete(mod)
        db.session.commit()
        return jsonify({'ok': True, 'soft': False})


@menu_bp.route('/modifiers/<modifier_id>/inventory-rules', methods=['PUT'])
@jwt_required()
def set_modifier_inventory_rules(modifier_id):
    """Replace inventory consumption rules for a modifier."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    from app.models.inventory import ModifierInventoryRule, InventoryItem
    mod = Modifier.query.get_or_404(modifier_id)
    data = request.get_json()
    rules = data.get('rules', [])  # [{inventory_item_id, quantity}]

    # Replace all rules
    ModifierInventoryRule.query.filter_by(modifier_id=modifier_id).delete()
    for r in rules:
        inv = InventoryItem.query.get(r.get('inventory_item_id'))
        if not inv:
            continue
        qty = max(1, int(r.get('quantity', 1)))
        db.session.add(ModifierInventoryRule(
            modifier_id=modifier_id,
            inventory_item_id=inv.id,
            quantity=qty
        ))
    db.session.commit()
    # Return updated modifier
    mod_dict = mod.to_dict()
    mod_dict['inventory_rules'] = [
        {'inventory_item_id': r.inventory_item_id,
         'inventory_item_name': r.inventory_item.name,
         'inventory_item_unit': r.inventory_item.unit,
         'quantity': r.quantity}
        for r in ModifierInventoryRule.query.filter_by(modifier_id=modifier_id).all()
    ]
    return jsonify(mod_dict)


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
