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
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.inventory import (
    InventoryItem, InventoryMovement, InsumoBase,
    UnitCatalog, SaleItemCost, OpenCigaretteBox,
)
from app.services import inventory_svc, audit_svc, cost_svc

inventory_bp = Blueprint('inventory', __name__)


# ── Every purchase carries its price (batch E4) ───────────────────────────────
# A restock (or a new item with starting stock) at $0 is how 82% of the cost
# rows ended up empty and why the purchase forecast can't price its list. So:
#   * the price is required and must be > 0;
#   * the one exception is goods that really came free (a supplier "cortesía"):
#     body {"sin_costo": true, "reason": "..."} -- owner only, reason required,
#     audited as INVENTORY_RESTOCK_FREE;
#   * a price more than 3x or under 1/3 of what was last paid needs
#     {"confirm_price": true} -- catches $4,500 typed for $450.
PRICE_JUMP = Decimal(3)


def _free_goods(claims, data):
    """None if the request is a normal priced purchase, else an error response or True."""
    if not data.get('sin_costo'):
        return None
    if claims.get('role') != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN',
                        'message': 'Solo el dueño puede registrar mercancía sin costo (cortesía).'}), 403
    if not (data.get('reason') or '').strip():
        return jsonify({'error': 'REASON_REQUIRED',
                        'message': 'Escribe por qué entra sin costo (p. ej. cortesía del proveedor).'}), 422
    return True


def _price_check(item, new_unit_cost, data):
    """409 PRICE_CHECK when the new per-unit price is far from the last one."""
    old = Decimal(str(item.unit_cost_cents or 0))
    new = Decimal(str(new_unit_cost or 0))
    if old <= 0 or new <= 0 or data.get('confirm_price'):
        return None
    ratio = new / old
    if ratio <= PRICE_JUMP and ratio >= 1 / PRICE_JUMP:
        return None
    times = f'{ratio:.1f}× más' if ratio > 1 else f'{(1 / ratio):.1f}× menos'
    return jsonify({
        'error': 'PRICE_CHECK',
        'message': (f'Este precio es {times} de lo que pagaste la última vez '
                    f'(${old / 100:,.2f} por unidad, ahora ${new / 100:,.2f}). ¿Es correcto?'),
        'previous_unit_cost_cents': float(old), 'new_unit_cost_cents': float(new),
    }), 409


def _d_or_none(v):
    return Decimal(str(v)).normalize() if v not in (None, '') else None


def _yield_input(item_type, data) -> tuple:
    """(units per parent, pour ml) from a create/edit body.

    BOTTLE (ml since 049): 'bottle_ml' + 'pour_ml'. An old client that still
    sends only 'shots_per_bottle' gets shots x pour (default 50 ml) -- so
    "15 shots" keeps meaning a 750 ml bottle. CIG_BOX: 'shots_per_bottle' is
    cigarettes per box, unchanged.
    """
    if item_type != 'BOTTLE':
        return data.get('shots_per_bottle') or None, None
    pour = data.get('pour_ml') or None
    if data.get('bottle_ml'):
        return data['bottle_ml'], pour
    if data.get('shots_per_bottle'):
        p = pour or inventory_svc.DEFAULT_POUR_ML
        try:
            return int(data['shots_per_bottle']) * int(p), p
        except (TypeError, ValueError):
            return data['shots_per_bottle'], pour        # configure_yield reports it
    return None, pour

VALID_CATEGORIES = ('beer', 'spirit', 'mixer', 'food', 'cigarette', 'other')
VALID_ITEM_TYPES = ('STANDARD', 'BOTTLE', 'CIG_BOX', 'CIG_SINGLE')
VALID_ADJUST_TYPES = ('WASTE', 'COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT')


def _role(claims):
    return claims.get('role', '')


def _d(value) -> Decimal:
    """Coerce a stock value to Decimal, tolerating None and float columns."""
    if value is None:
        return Decimal(0)
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(0)


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
        unit = inventory_svc.create_unit(key, name_es, name_en,
                                         allows_fraction=bool(data.get('allows_fraction', False)))
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
    if 'allows_fraction' in data:
        fields['allows_fraction'] = bool(data['allows_fraction'])

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
    try:
        inventory_svc.assert_pack(data.get('base_unit_key'), data.get('purchase_unit_key') or None, pack_size)
    except ValueError as e:
        code, msg = str(e).split(': ', 1)
        return jsonify({'error': code, 'message': msg}), 422

    initial_qty  = data.get('stock_quantity', 0)
    # Cost the way it is BOUGHT: the price of one purchase unit (a case, a
    # 3,780 ml bottle) divided by the units in it -- the system does the
    # division, exactly (migration 044). unit_cost_cents (per base unit) is
    # still accepted for API callers that already have it.
    try:
        if data.get('purchase_cost_cents') not in (None, ''):
            purchase_cost = Decimal(str(data['purchase_cost_cents']))
            initial_cost = purchase_cost / Decimal(str(pack_size or 1))
        else:
            purchase_cost = None
            initial_cost = Decimal(str(data.get('unit_cost_cents') or 0))
    except (InvalidOperation, ValueError, TypeError):
        return jsonify({'error': 'VALIDATION', 'message': 'Costo inválido'}), 422
    if initial_cost < 0:
        return jsonify({'error': 'VALIDATION',
                        'message': 'El costo no puede ser negativo'}), 422
    initial_cost = initial_cost.quantize(Decimal('0.0001'))
    # Starting stock is a purchase too: it needs its price (batch E4).
    try:
        has_stock = float(initial_qty or 0) > 0
    except (TypeError, ValueError):
        has_stock = False
    free = _free_goods(get_jwt(), data)
    if isinstance(free, tuple):
        return free
    if has_stock and initial_cost <= 0 and not free:
        return jsonify({'error': 'PRICE_REQUIRED',
                        'message': 'Con existencia inicial, escribe cuánto costó (precio de la caja o de la pieza).'}), 422
    try:
        inventory_svc.assert_whole(initial_qty or 0, base_unit_key, 'La existencia inicial')
    except ValueError as e:
        return jsonify({'error': 'WHOLE_UNITS_ONLY', 'message': str(e)}), 422

    item = InventoryItem(
        name                = name,
        sku                 = (data.get('sku') or '').strip() or None,
        supplier            = (data.get('supplier') or '').strip() or None,
        category            = category,
        item_type           = item_type,
        # 'unit' is NOT NULL. Accept it if the client sends one, otherwise fall
        # back to the catalog key so the column is always populated.
        unit                = (data.get('unit') or '').strip() or base_unit_key,
        base_unit_key       = base_unit_key,
        stock_quantity      = initial_qty,
        low_stock_threshold = data.get('low_stock_threshold', 0),
        unit_cost_cents     = initial_cost,
        purchase_cost_cents = (int(purchase_cost.to_integral_value())
                               if purchase_cost is not None else None),
        purchase_unit_key   = purchase_unit_key or None,
        purchase_pack_size  = pack_size,
    )
    db.session.add(item)

    # Bottle: "750 ml, shot de 50 ml"; cigarette box: "20 per box". The
    # conversion, and the open item itself when none was picked, are created
    # here so the new bottle can be opened immediately.
    units, pour = _yield_input(item_type, data)
    if item_type in ('BOTTLE', 'CIG_BOX') and units:
        try:
            db.session.flush()
            yield_result = inventory_svc.configure_yield(
                item, units, data.get('yields_item_id') or None,
                get_jwt_identity(), pour=pour)
        except ValueError as e:
            db.session.rollback()
            return jsonify({'error': 'INVALID_YIELD', 'message': str(e)}), 422
        except IntegrityError as exc:
            db.session.rollback()
            if getattr(getattr(exc, 'orig', None), 'pgcode', None) == '23505':
                return jsonify({'error': 'DUPLICATE_NAME',
                                'message': f"An item named '{name}' already exists"}), 409
            raise
        audit_svc.log(get_jwt_identity(), 'INVENTORY_YIELD_SET', 'inventory_item', item.id,
                      before=yield_result['before'], after=yield_result['after'],
                      reason=(f"Creado: {yield_result['child_name']}"
                              if yield_result['child_created'] else None))

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
            unit_cost_cents   = initial_cost,
            reason            = ('Stock inicial sin costo: ' + data['reason'].strip()
                                 if free else 'Stock inicial'),
            performed_by      = user_id,
        )
        db.session.add(mv)

    try:
        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        # Do NOT report every integrity error as a duplicate name. A NOT NULL
        # violation was previously surfaced as "already exists", sending the
        # operator hunting for a duplicate that did not exist.
        pgcode = getattr(getattr(exc, 'orig', None), 'pgcode', None)
        if pgcode == '23505':                      # unique_violation
            return jsonify({'error': 'DUPLICATE_NAME',
                            'message': f"An item named '{name}' already exists"}), 409
        current_app.logger.error('create_inventory_item integrity error: %s', exc)
        return jsonify({'error': 'INTEGRITY_ERROR',
                        'message': str(getattr(exc, 'orig', exc))}), 422

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
    original_item_type = item.item_type

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
    if 'base_unit_key' in data and data['base_unit_key'] != item.base_unit_key:
        if not UnitCatalog.query.get(data['base_unit_key']):
            return jsonify({'error': 'INVALID_UNIT',
                            'message': f"Unit '{data['base_unit_key']}' not in catalog"}), 422
        # Changing the unit re-labels every number already recorded: 1 "botella"
        # silently becomes 1 "caballito". Only allow it while there is nothing
        # on hand to re-label and no recipe deducts in the old unit (the recipe
        # unit guard only fires when a recipe row is written, not when the
        # item's unit changes underneath it).
        if _d(item.stock_quantity) != 0:
            return jsonify({
                'error': 'UNIT_LOCKED',
                'message': (f'No se puede cambiar la unidad de "{item.name}" con existencia '
                            f'({_d(item.stock_quantity).normalize()}). Haz un conteo físico a 0, '
                            f'cambia la unidad y vuelve a registrar la existencia.'),
            }), 422
        if InsumoBase.query.filter(InsumoBase.inventory_item_id == item.id,
                                   InsumoBase.deduction_unit_key != data['base_unit_key']).first():
            return jsonify({
                'error': 'UNIT_LOCKED',
                'message': (f'"{item.name}" se usa en recetas con la unidad actual; '
                            f'actualiza esas recetas antes de cambiar la unidad.'),
            }), 422
        item.base_unit_key = data['base_unit_key']
    if 'purchase_cost_cents' in data:
        item.purchase_cost_cents = int(data['purchase_cost_cents']) if data['purchase_cost_cents'] is not None else None
    if 'purchase_cost_pesos' in data:
        pesos = data['purchase_cost_pesos']
        item.purchase_cost_cents = round(float(pesos) * 100) if pesos is not None else None
    units_before = (item.base_unit_key, item.purchase_unit_key, _d_or_none(item.purchase_pack_size))
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
    # Only when the edit CHANGES how it is stocked / bought: the edit form
    # re-sends every field, and an old inconsistent item must stay editable.
    if (item.base_unit_key, item.purchase_unit_key, _d_or_none(item.purchase_pack_size)) != units_before:
        try:
            inventory_svc.assert_pack(item.base_unit_key, item.purchase_unit_key, item.purchase_pack_size)
        except ValueError as e:
            db.session.rollback()
            code, msg = str(e).split(': ', 1)
            return jsonify({'error': code, 'message': msg}), 422
    if 'low_stock_threshold' in data:
        item.low_stock_threshold = data['low_stock_threshold']
    # Yield (bottle -> shots, box -> loose) goes through configure_yield, the
    # single writer of the conversion. Writing these two columns directly used
    # to change what the screen showed without changing what "Abrir" did, and
    # left no trace. Only runs when something actually differs, because the
    # edit form always sends both fields.
    if any(k in data for k in ('item_type', 'shots_per_bottle', 'yields_item_id', 'bottle_ml', 'pour_ml')):
        cur = inventory_svc._yield_state(item)
        cur_units = cur.get('bottle_ml') if item.item_type == 'BOTTLE' else item.shots_per_bottle
        new_type = data.get('item_type', item.item_type)
        req_units, req_pour = _yield_input(new_type, data)
        sent_units = any(k in data for k in ('shots_per_bottle', 'bottle_ml'))
        want_units = (req_units if sent_units else cur_units) or None
        want_pour = req_pour if 'pour_ml' in data else None
        want_child = (data['yields_item_id'] if 'yields_item_id' in data
                      else item.yields_item_id) or None
        type_changed = 'item_type' in data and data['item_type'] != original_item_type
        differs = (type_changed
                   or (float(want_units) if want_units else None) != (float(cur_units) if cur_units else None)
                   or (want_pour is not None and float(want_pour) != (cur.get('pour_ml') or 0))
                   or (want_child is not None and want_child != item.yields_item_id))
        if differs:
            try:
                res = inventory_svc.configure_yield(item, want_units, want_child,
                                                    get_jwt_identity(), pour=want_pour)
            except ValueError as e:
                db.session.rollback()
                return jsonify({'error': 'INVALID_YIELD', 'message': str(e)}), 422
            if res['changed']:
                audit_svc.log(get_jwt_identity(), 'INVENTORY_YIELD_SET', 'inventory_item',
                              item.id, before=res['before'], after=res['after'],
                              reason=(f"Creado: {res['child_name']}"
                                      if res.get('child_created') else None))
    # Portioning (E8): this item is a pack of N g cut from a raw item.
    if 'portion_source_id' in data:
        from app.services import portion_svc
        raw = InventoryItem.query.get(data['portion_source_id']) if data['portion_source_id'] else None
        if data['portion_source_id'] and raw is None:
            return jsonify({'error': 'NOT_FOUND', 'message': 'No existe el producto crudo'}), 404
        if raw is not None or item.portion_source_id:
            try:
                res = portion_svc.link_portion(item, raw, data.get('portion_size'))
            except ValueError as e:
                db.session.rollback()
                return jsonify({'error': 'BAD_PORTION', 'message': str(e).split(': ', 1)[-1]}), 422
            if res['before'] != res['after']:
                audit_svc.log(get_jwt_identity(), 'INVENTORY_PORTION_LINK', 'inventory_item', item.id,
                              before=res['before'], after=res['after'])
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
    """Retire an inventory item. ADMIN only.

    Items that have never participated in a sale are hard-deleted along with
    their configuration rows. Items with movement or COGS history are
    SOFT-deleted (is_active=False) instead: sale_item_costs and
    inventory_movements are the ledger behind already-closed, already-reported
    tickets. Erasing them silently rewrites historical margin reports and
    destroys the stock audit trail. Pass ?force=true to retire an item that
    still holds stock.
    """
    claims = get_jwt()
    err = _require_admin(claims)
    if err:
        return err

    item = InventoryItem.query.with_for_update().get_or_404(item_id)
    snapshot = item.to_dict()
    user_id = get_jwt_identity()

    from app.models.inventory import ModifierInventoryRule, OpenCigaretteBox, InventoryConversion

    movement_count = InventoryMovement.query.filter_by(inventory_item_id=item_id).count()
    cost_count = SaleItemCost.query.filter_by(inventory_item_id=item_id).count()

    # ── Historical item: soft-delete, preserve the ledger ─────────────────────
    if movement_count or cost_count:
        if not item.is_active:
            return jsonify({
                'error': 'ALREADY_INACTIVE',
                'message': f'"{item.name}" ya está desactivado.',
            }), 409

        # Unhook it from anything that would keep selling it, but keep every
        # historical row intact.
        ModifierInventoryRule.query.filter_by(inventory_item_id=item_id).delete()
        InsumoBase.query.filter_by(inventory_item_id=item_id).delete()
        from app.models.inventory import MenuItemIngredient
        MenuItemIngredient.query.filter_by(inventory_item_id=item_id).delete()
        InventoryConversion.query.filter(
            (InventoryConversion.from_item_id == item_id) |
            (InventoryConversion.to_item_id == item_id)
        ).delete()
        InventoryItem.query.filter_by(yields_item_id=item_id).update({'yields_item_id': None})

        item.is_active = False
        item.updated_at = datetime.now(timezone.utc)

        audit_svc.log(
            user_id, 'INVENTORY_ITEM_DEACTIVATED', 'inventory_item', item_id,
            before=snapshot,
            after={'is_active': False},
            reason=(f'Admin retire. Soft-deleted to preserve {movement_count} movement '
                    f'and {cost_count} COGS records.'),
        )
        db.session.commit()
        return jsonify({
            'ok': True,
            'soft_deleted': True,
            'movements_preserved': movement_count,
            'sale_costs_preserved': cost_count,
            'message': (f'"{item.name}" se desactivó. Su historial de movimientos y '
                        f'costos se conserva para los reportes.'),
        })

    # ── Never sold: safe to hard-delete ───────────────────────────────────────
    if _d(item.stock_quantity) != 0 and request.args.get('force', '').lower() != 'true':
        return jsonify({
            'error': 'ITEM_HAS_STOCK',
            'message': (f'"{item.name}" todavía tiene {float(item.stock_quantity)} en existencia. '
                        f'Ajusta a cero o usa ?force=true.'),
            'stock_quantity': float(item.stock_quantity),
        }), 409

    ModifierInventoryRule.query.filter_by(inventory_item_id=item_id).delete()
    OpenCigaretteBox.query.filter_by(box_item_id=item_id).delete()
    InsumoBase.query.filter_by(inventory_item_id=item_id).delete()
    # Legacy table
    from app.models.inventory import MenuItemIngredient
    MenuItemIngredient.query.filter_by(inventory_item_id=item_id).delete()
    InventoryItem.query.filter_by(yields_item_id=item_id).update({'yields_item_id': None})

    # Delete any conversion rules that reference this item
    InventoryConversion.query.filter(
        (InventoryConversion.from_item_id == item_id) |
        (InventoryConversion.to_item_id == item_id)
    ).delete()

    db.session.delete(item)

    audit_svc.log(
        user_id, 'INVENTORY_ITEM_DELETED', 'inventory_item', item_id,
        before=snapshot,
        reason='Admin delete. Item had no movement or COGS history.',
    )
    db.session.commit()
    return jsonify({'ok': True, 'soft_deleted': False, 'movements_deleted': 0})
# @inventory_bp.route('/<item_id>', methods=['DELETE'])
# @jwt_required()
# def delete_inventory_item(item_id):
#     """Hard-delete an inventory item and all its dependent records. ADMIN only."""
#     claims = get_jwt()
#     err = _require_admin(claims)
#     if err:
#         return err

#     item = InventoryItem.query.get_or_404(item_id)
#     snapshot = item.to_dict()

#     from app.models.inventory import ModifierInventoryRule, OpenCigaretteBox

#     movement_count = InventoryMovement.query.filter_by(inventory_item_id=item_id).count()

#     SaleItemCost.query.filter_by(inventory_item_id=item_id).delete()
#     InventoryMovement.query.filter_by(inventory_item_id=item_id).delete()
#     ModifierInventoryRule.query.filter_by(inventory_item_id=item_id).delete()
#     OpenCigaretteBox.query.filter_by(box_item_id=item_id).delete()
#     InsumoBase.query.filter_by(inventory_item_id=item_id).delete()
#     # Legacy table
#     from app.models.inventory import MenuItemIngredient
#     MenuItemIngredient.query.filter_by(inventory_item_id=item_id).delete()
#     InventoryItem.query.filter_by(yields_item_id=item_id).update({'yields_item_id': None})

#     db.session.delete(item)

#     user_id = get_jwt_identity()
#     audit_svc.log(
#         user_id, 'INVENTORY_ITEM_DELETED', 'inventory_item', item_id,
#         before=snapshot,
#         reason=f'Admin delete. {movement_count} movement records deleted.',
#     )
#     db.session.commit()
#     return jsonify({'ok': True, 'movements_deleted': movement_count})


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
    free = _free_goods(claims, data)
    if isinstance(free, tuple):
        return free
    item0 = InventoryItem.query.get(item_id)
    if item0 is None:
        return jsonify({'error': 'NOT_FOUND', 'message': 'InventoryItem not found'}), 404
    # The price question is asked only about an otherwise valid purchase: it is
    # computed first but returned after the restock validates (and rolled back).
    pending_check = None

    try:
        if 'portion_count' in data:
            # Food portion mode
            portion_count = data.get('portion_count')
            total_cost    = data.get('total_purchase_cost_cents')
            if portion_count is None:
                return jsonify({'error': 'VALIDATION',
                                'message': 'portion_count is required'}), 422
            if free:
                total_cost = 0
            elif total_cost in (None, '') or Decimal(str(total_cost)) <= 0:
                return jsonify({'error': 'PRICE_REQUIRED',
                                'message': 'Escribe cuánto costó esta compra.'}), 422
            elif float(portion_count) > 0:
                pending_check = _price_check(item0, Decimal(str(total_cost)) / Decimal(str(portion_count)), data)

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
            if free:
                cost_per_unit = 0
            elif cost_per_unit in (None, '') or Decimal(str(cost_per_unit)) <= 0:
                return jsonify({'error': 'PRICE_REQUIRED',
                                'message': 'Escribe cuánto costó (precio de la caja o de la pieza).'}), 422
            else:
                pack = Decimal(str(data.get('pack_size_override') or item0.purchase_pack_size or 1))
                try:
                    inventory_svc.assert_pack(item0.base_unit_key,
                                              data.get('purchase_unit_key_override') or item0.purchase_unit_key,
                                              pack, same_unit_strict=False)
                except ValueError as e:
                    code, msg = str(e).split(': ', 1)
                    return jsonify({'error': code, 'message': msg}), 422
                if pack > 0:
                    pending_check = _price_check(item0, Decimal(str(cost_per_unit)) / pack, data)

            item = inventory_svc.restock_drinks(
                item_id,
                purchase_quantity                    = purchase_qty,
                unit_cost_per_purchase_unit_cents    = int(cost_per_unit),
                performed_by                         = user_id,
                pack_size_override                   = data.get('pack_size_override'),
                purchase_unit_key_override           = data.get('purchase_unit_key_override'),
                reason                               = data.get('reason'),
            )

        if pending_check:
            db.session.rollback()
            return pending_check
        audit_svc.log(user_id, 'INVENTORY_RESTOCK_FREE' if free else 'INVENTORY_RESTOCK',
                      'inventory_item', item_id,
                      after={'stock_quantity': float(item.stock_quantity),
                             'unit_cost_cents': item.unit_cost_cents,
                             'price_confirmed': bool(data.get('confirm_price'))},
                      reason=(data.get('reason') or '').strip() or None)
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
            item = inventory_svc.record_count_adjustment(
                item_id, counted, reason, user_id,
                # Raising a shot / loose-cigarette count is owner-only.
                allow_owner_override=(_role(claims) == 'ADMIN'))

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
        if msg.startswith('OPEN_TO_ADD'):
            return jsonify({'error': 'OPEN_TO_ADD', 'message': msg}), 422
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

@inventory_bp.route('/<item_id>/set-cost', methods=['POST'])
@jwt_required()
def set_item_cost(item_id):
    """Set an item's cost the way it is bought, or correct a wrong one. ADMIN only.

    Body (one of):
      { purchase_cost_cents, pack_size? }  price of one purchase unit (a case of
                                           24, a 3,780 ml bottle...); the system
                                           divides. pack_size overrides the
                                           item's units-per-case for this entry.
      { unit_cost_cents }                  price per base unit (may have decimals)
    plus { reason } -- required when the item ALREADY has a cost (correction).

    First cost -> INVENTORY_COST_SET. Correction -> INVENTORY_COST_CORRECTED with
    before/after and the reason. A bottle/box also sets its shots/loose items.
    """
    claims = get_jwt()
    err = _require_admin(claims)
    if err:
        return err
    user_id = get_jwt_identity()
    data = request.get_json(silent=True) or {}
    try:
        res = cost_svc.set_cost(
            item_id,
            unit_cost_cents=data.get('unit_cost_cents'),
            purchase_cost_cents=data.get('purchase_cost_cents'),
            pack_size=data.get('pack_size'),
            reason=(data.get('reason') or '').strip() or None,
        )
    except cost_svc.CostAlreadySet as e:
        db.session.rollback()
        return jsonify({'error': 'COST_ALREADY_SET', 'message': str(e)}), 409
    except (ValueError, ArithmeticError) as e:
        db.session.rollback()
        msg = str(e)
        if msg.startswith('NOT_FOUND'):
            return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
        return jsonify({'error': 'VALIDATION', 'message': msg}), 422

    item = res['item']
    action = 'INVENTORY_COST_SET' if res['mode'] == 'INICIAL' else 'INVENTORY_COST_CORRECTED'
    reason = (data.get('reason') or '').strip() or (
        'Costo inicial capturado' if res['mode'] == 'INICIAL' else None)
    audit_svc.log(user_id, action, 'inventory_item', item.id,
                  before={'unit_cost_cents': float(res['before'])},
                  after={'unit_cost_cents': float(res['after']),
                         'purchase_cost_cents': data.get('purchase_cost_cents'),
                         'pack_size': data.get('pack_size') or float(item.purchase_pack_size or 1)},
                  reason=reason)
    for child, before, after in res['children']:
        audit_svc.log(user_id, action, 'inventory_item', child.id,
                      before={'unit_cost_cents': float(before)},
                      after={'unit_cost_cents': float(after)},
                      reason=f'Derivado de {item.name}' + (f': {reason}' if reason else ''))
    db.session.commit()
    return jsonify({
        'mode': res['mode'],
        'item': item.to_dict(),
        'derivados': [{'id': c.id, 'name': c.name, 'unit_cost_cents': float(a)}
                      for c, _, a in res['children']],
    })


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
        body = request.get_json(silent=True) or {}
        confirm = bool(body.get('confirm_remaining'))
        bottle, shots, added = inventory_svc.open_bottle(
            item_id, user_id, confirm_remaining=confirm, size_ml=body.get('size_ml'))
        pour = inventory_svc.pour_ml(shots)
        shots_added = int(added // pour) if pour else added
        audit_svc.log(user_id, 'BOTTLE_OPENED', 'inventory', item_id,
                      after={'ml_added': added if pour else None, 'shots_added': shots_added,
                             'shot_item': shots.name})
        db.session.commit()
        return jsonify({'bottle': bottle.to_dict(), 'shots': shots.to_dict(),
                        'shots_added': shots_added, 'ml_added': added if pour else None})
    except inventory_svc.StillHasUnits as e:
        db.session.rollback()
        # Not an error: the client shows this question and resends with
        # confirm_remaining=true if the person says yes.
        return jsonify({'error': 'STILL_HAS_UNITS', 'message': str(e).split(': ', 1)[-1],
                        'remaining': float(e.remaining), 'item': e.child_name,
                        'remaining_ml': float(e.ml) if e.ml is not None else None}), 409
    except ValueError as e:
        db.session.rollback()
        msg = str(e)
        if 'NOT_FOUND' in msg:
            return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
        if 'NO_STOCK' in msg:
            return jsonify({'error': 'NO_STOCK', 'message': msg}), 422
        if 'BAD_SIZE' in msg:
            return jsonify({'error': 'BAD_SIZE', 'message': msg.split(': ', 1)[-1]}), 422
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
        # Call the service – this is where the real work happens
        confirm = bool((request.get_json(silent=True) or {}).get('confirm_remaining'))
        box, single, open_info = inventory_svc.open_cigarette_box(
            item_id, user_id, confirm_remaining=confirm)

        audit_svc.log(user_id, 'BOX_OPENED', 'inventory', item_id,
                      after={'cigs_added': open_info['units_per_pack'],
                             'single_item': single.name})
        db.session.commit()

        # Only after the commit: a client that refetches on this event must see
        # the opened box, never the pre-open state or a rolled-back attempt.
        from app.extensions import socketio
        socketio.emit('inventory:box_opened', {
            'brand':        open_info['brand'],
            'cigs_per_box': open_info['units_per_pack'],
            'open_box_id':  open_info['lot_id'] or '',
        })

        return jsonify({
            'box':      box.to_dict(),
            'singles':  single.to_dict(),
            'open_box': open_info,          # dictionary, not an ORM object
        })
    except inventory_svc.StillHasUnits as e:
        db.session.rollback()
        # Not an error: the client shows this question and resends with
        # confirm_remaining=true if the person says yes.
        return jsonify({'error': 'STILL_HAS_UNITS', 'message': str(e).split(': ', 1)[-1],
                        'remaining': float(e.remaining), 'item': e.child_name}), 409
    except ValueError as e:
        db.session.rollback()
        msg = str(e)
        if 'NOT_FOUND' in msg:
            return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
        if 'NO_STOCK' in msg:
            return jsonify({'error': 'NO_STOCK', 'message': msg}), 422
        return jsonify({'error': 'VALIDATION', 'message': msg}), 422

# def open_cigarette_box(item_id: str, performed_by: str):
#     """Open a sealed cigarette box using the FIFO pack-lot function.

#     The database function fn_open_pack_fifo handles:
#       - Selecting the oldest lot (or falling back to the default ratio)
#       - Deducting 1 pack from the source inventory item (CIG_BOX)
#       - Adding the correct number of singles to the target item
#       - Writing CONVERSION_OUT / CONVERSION_IN inventory movements
#       - Updating lot pack counts

#     Returns:
#         Tuple (box_item, single_item, open_info_dict)
#         open_info_dict contains:
#             lot_id          – UUID of the lot used (or None)
#             brand           – Name of the cigarette box
#             units_per_pack  – Actual number of singles opened from this pack
#             packs_remaining – Remaining sealed packs after opening
#             loose_total     – New total of singles after conversion
#     """
#     from sqlalchemy import text

#     # Basic validation of the item
#     box = InventoryItem.query.get(item_id)
#     if not box:
#         raise ValueError('InventoryItem not found')
#     if box.item_type != 'CIG_BOX':
#         raise ValueError('NOT_A_CIG_BOX: item is not a cigarette box')
#     if not box.yields_item_id:
#         raise ValueError('NOT_CONFIGURED: box missing yields_item_id')

#     # Call the stored procedure. It acquires its own locks internally.
#     result = db.session.execute(
#         text("SELECT * FROM fn_open_pack_fifo(:box_id, :user_id, :ref)"),
#         {
#             "box_id": box.id,
#             "user_id": performed_by,
#             "ref": f"Manual open-box for {box.name}"
#         }
#     ).fetchone()

#     if result is None:
#         raise Exception("fn_open_pack_fifo returned no row – conversion failed")

#     lot_id, units_per_pack, packs_remaining, loose_total = result

#     # Re-fetch the inventory items to reflect the changes made by the procedure.
#     # The items were modified inside the same transaction, so this query will
#     # see the updated quantities.
#     box_updated = InventoryItem.query.get(box.id)
#     single = InventoryItem.query.get(box.yields_item_id)

#     # Construct a dictionary for the third return value (previously OpenCigaretteBox)
#     open_info = {
#         "lot_id": lot_id,
#         "brand": box_updated.name,
#         "units_per_pack": int(units_per_pack),
#         "packs_remaining": int(packs_remaining),
#         "loose_total": int(loose_total),
#     }

#     # Emit a socket event (optional). The frontend may rely on this.
#     from app.extensions import socketio
#     socketio.emit('inventory:box_opened', {
#         'brand':        box_updated.name,
#         'cigs_per_box': int(units_per_pack),
#         'open_box_id':  lot_id or '',   # can be NULL if no lot; fallback to empty string
#     })

#     return box_updated, single, open_info




# def open_cigarette_box(item_id):
#     """Open a sealed cigarette box. MANAGER/ADMIN only."""
#     claims = get_jwt()
#     err = _require_manager(claims)
#     if err:
#         return err

#     user_id = get_jwt_identity()
#     try:
#         box, single, open_box = inventory_svc.open_cigarette_box(item_id, user_id)
#         audit_svc.log(user_id, 'BOX_OPENED', 'inventory', item_id,
#                       after={'cigs_added': box.shots_per_bottle,
#                              'single_item': single.name})
#         db.session.commit()
#         return jsonify({
#             'box':      box.to_dict(),
#             'singles':  single.to_dict(),
#             'open_box': open_box.to_dict(),
#         })
#     except ValueError as e:
#         db.session.rollback()
#         msg = str(e)
#         if 'NOT_FOUND' in msg:
#             return jsonify({'error': 'NOT_FOUND', 'message': msg}), 404
#         if 'NO_STOCK' in msg:
#             return jsonify({'error': 'NO_STOCK', 'message': msg}), 422
#         return jsonify({'error': 'VALIDATION', 'message': msg}), 422


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


# ── Bar count (batch E2, step 2) ──────────────────────────────────────────────
# Blind: the screen lists the open bottles of every spirit (with their size) but
# never what the system expects. Managers post counts; only the owner sees the
# variance (units and pesos), as with the blind cash count.

@inventory_bp.route('/bar-count', methods=['GET'])
@jwt_required()
def bar_count_sheet():
    err = _require_manager(get_jwt())
    if err:
        return err
    from app.services import bar_count_svc
    return jsonify({'spirits': bar_count_svc.spirits(with_expected=False)})


@inventory_bp.route('/bar-count', methods=['POST'])
@jwt_required()
def bar_count_submit():
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err
    from app.services import bar_count_svc
    data = request.get_json() or {}
    user_id = get_jwt_identity()
    try:
        res = bar_count_svc.submit(user_id, data.get('spirits') or [], data.get('notes'))
    except ValueError as e:
        db.session.rollback()
        return jsonify({'error': 'BAD_COUNT', 'message': str(e).split(': ', 1)[-1]}), 422
    audit_svc.log(user_id, 'BAR_COUNT', 'bar_count', res['id'],
                  after={'total_variance_cents': res['total_variance_cents'],
                         'items': len(res['lines'])})
    db.session.commit()
    if claims.get('role') == 'ADMIN':
        return jsonify(res), 201
    return jsonify({'id': res['id'], 'message': 'Conteo guardado'}), 201


@inventory_bp.route('/bar-counts', methods=['GET'])
@jwt_required()
def bar_count_history():
    if get_jwt().get('role') != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN', 'message': 'Solo el dueño ve las diferencias de conteo'}), 403
    from app.api.reports import parse_dates
    from app.services import bar_count_svc
    f, t = parse_dates()
    return jsonify({'counts': bar_count_svc.history(f, t),
                    'now': bar_count_svc.spirits(with_expected=True)})


# ── Portioning (batch E8) ─────────────────────────────────────────────────────

@inventory_bp.route('/<item_id>/portion', methods=['POST'])
@jwt_required()
def portion_raw(item_id):
    """🔪 Porcionar: {raw_used, outputs: [{item_id, packs}], notes?}. MANAGER/ADMIN."""
    claims = get_jwt()
    err = _require_manager(claims)
    if err:
        return err
    from app.services import portion_svc
    data = request.get_json() or {}
    try:
        res = portion_svc.portion(item_id, data.get('raw_used'), data.get('outputs') or [],
                                  get_jwt_identity(), data.get('notes'))
    except ValueError as e:
        db.session.rollback()
        code, _, msg = str(e).partition(': ')
        return jsonify({'error': code, 'message': msg or code}), 404 if code == 'NOT_FOUND' else 422
    audit_svc.log(get_jwt_identity(), 'INVENTORY_PORTION', 'inventory_item', item_id,
                  after={k: res[k] for k in ('batch_number', 'raw_used', 'output_g', 'waste_g', 'yield_pct')})
    db.session.commit()
    if claims.get('role') != 'ADMIN':          # managers don't see costs
        res = {**res, 'input_cost_cents': None,
               'outputs': [{**o, 'pack_cost_cents': None} for o in res['outputs']]}
    return jsonify(res), 201


@inventory_bp.route('/portioning', methods=['GET'])
@jwt_required()
def portioning_history():
    if get_jwt().get('role') != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN', 'message': 'Solo el dueño ve el historial de porcionado'}), 403
    from app.api.reports import parse_dates
    from app.services import portion_svc
    f, t = parse_dates()
    return jsonify(portion_svc.history(f, t))
