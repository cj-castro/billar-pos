from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt_identity
from ..extensions import db, socketio
from ..models.setting import Setting
from ..models.user import User

settings_bp = Blueprint('settings', __name__)
venue_bp = Blueprint('venue', __name__)

# What a MANAGER may change: their own screen/device preferences. Everything
# else -- venue identity, and system switches such as spirits.auto_convert_enabled,
# inventory.negative_stock_mode or ledger.enforcement_mode -- is owner-only.
# (Any manager used to be able to set ANY key, including those.)
_MANAGER_KEYS = {'kds_sound_enabled', 'print_bar_tickets'}


@venue_bp.route('', methods=['GET'])
def get_venue():
    """Public: the login screen needs the venue's name and logo before anyone
    signs in. Contains nothing sensitive."""
    from ..services import venue_svc
    return jsonify(venue_svc.get_venue())

# Server-side defaults — used when no DB row exists yet
_DEFAULTS: dict[str, str] = {
    'kds_sound_enabled': 'true',
    # Off by default: bar service is screen-only unless a manager opts in.
    'print_bar_tickets': 'false',
}


@settings_bp.route('/<key>', methods=['GET'])
@jwt_required()
def get_setting(key: str):
    s = Setting.query.get(key)
    value = s.value if s else _DEFAULTS.get(key, '')
    return jsonify({'key': key, 'value': value})


_NUMERIC_KEYS = {
    'comps.owner_above_cents': (0, 10_000_000, 'Cortesías que autoriza el dueño (centavos)'),
    'staff.allowance_cents':   (0, 10_000_000, 'Consumo libre de personal por día (centavos)'),
    'purchasing.safety_pct':   (0, 200, 'Colchón del pronóstico de compras (%)'),
    'cash.drawer_fund_cents':  (0, 10_000_000, 'Fondo de caja (centavos)'),
}


@settings_bp.route('/<key>', methods=['PUT', 'PATCH'])
@jwt_required()
def put_setting(key: str):
    """Upsert one setting. PATCH is an alias of PUT: the row is a single
    scalar, so a partial update and a replacement are the same operation."""
    uid  = get_jwt_identity()
    user = User.query.get(uid)
    if not user or user.role not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'Forbidden'}), 403
    if user.role != 'ADMIN' and key not in _MANAGER_KEYS:
        return jsonify({'error': 'FORBIDDEN',
                        'message': 'Solo el administrador puede cambiar este ajuste'}), 403

    body  = request.get_json(force=True) or {}
    value = str(body.get('value', ''))
    if key.startswith('venue.'):
        from ..services import venue_svc
        if key not in venue_svc.KEYS:
            return jsonify({'error': 'VALIDATION', 'message': f'Ajuste desconocido: {key}'}), 422
        if key == 'venue.currency':
            value = value.strip().upper()
        err = venue_svc.validate(key, value)
        if err:
            return jsonify({'error': 'VALIDATION', 'message': err}), 422

    # Owner limits (batches E3 / E5): whole, non-negative numbers.
    if key in _NUMERIC_KEYS:
        lo, hi, what = _NUMERIC_KEYS[key]
        try:
            n = int(float(value or 0))
        except ValueError:
            return jsonify({'error': 'VALIDATION', 'message': f'{what}: escribe un número'}), 422
        if n < lo or n > hi:
            return jsonify({'error': 'VALIDATION', 'message': f'{what}: entre {lo} y {hi}'}), 422
        value = str(n)

    # Counting by denomination needs a bill/coin table for the venue currency.
    # Turning it OFF is always allowed.
    if key == 'cash.count_by_denomination':
        from ..services import cash_count_svc, settings_svc, venue_svc
        if settings_svc.is_truthy(value) and not cash_count_svc.denominations(venue_svc.get_venue()['currency']):
            return jsonify({'error': 'VALIDATION',
                            'message': 'No hay tabla de billetes y monedas para esta moneda'}), 422

    s = Setting.query.get(key)
    if s:
        s.value = value
    else:
        s = Setting(key=key, value=value)
        db.session.add(s)
    db.session.commit()
    if key.startswith('venue.'):
        from ..services import venue_svc
        venue_svc.invalidate()

    # Broadcast to all connected clients so KDS pages update without reload
    socketio.emit('settings:changed', {'key': key, 'value': value})
    return jsonify(s.to_dict())
