from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt_identity
from ..extensions import db, socketio
from ..models.setting import Setting
from ..models.user import User

settings_bp = Blueprint('settings', __name__)

# Server-side defaults — used when no DB row exists yet
_DEFAULTS: dict[str, str] = {
    'kds_sound_enabled': 'true',
}


@settings_bp.route('/<key>', methods=['GET'])
@jwt_required()
def get_setting(key: str):
    s = Setting.query.get(key)
    value = s.value if s else _DEFAULTS.get(key, '')
    return jsonify({'key': key, 'value': value})


@settings_bp.route('/<key>', methods=['PUT'])
@jwt_required()
def put_setting(key: str):
    uid  = get_jwt_identity()
    user = User.query.get(uid)
    if not user or user.role not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'Forbidden'}), 403

    body  = request.get_json(force=True) or {}
    value = str(body.get('value', ''))

    s = Setting.query.get(key)
    if s:
        s.value = value
    else:
        s = Setting(key=key, value=value)
        db.session.add(s)
    db.session.commit()

    # Broadcast to all connected clients so KDS pages update without reload
    socketio.emit('settings:changed', {'key': key, 'value': value})
    return jsonify(s.to_dict())
