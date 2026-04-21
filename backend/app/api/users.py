from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity
from app.extensions import db
from app.models.user import User
from app.services import audit_svc

users_bp = Blueprint('users', __name__)


def require_admin():
    claims = get_jwt()
    if claims.get('role') != 'ADMIN':
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


@users_bp.route('', methods=['GET'])
@jwt_required()
def list_users():
    err = require_admin()
    if err: return err
    users = User.query.filter_by(is_active=True).all()
    return jsonify([u.to_dict() for u in users])


@users_bp.route('', methods=['POST'])
@jwt_required()
def create_user():
    err = require_admin()
    if err: return err
    data = request.get_json()
    u = User(
        username=data['username'],
        name=data['name'],
        role=data['role']
    )
    u.set_password(data['password'])
    if data.get('pin'):
        u.set_pin(data['pin'])
    db.session.add(u)
    db.session.flush()
    audit_svc.log(get_jwt_identity(), 'USER_CREATE', 'user', u.id, after={'username': u.username, 'role': u.role})
    db.session.commit()
    return jsonify(u.to_dict()), 201


@users_bp.route('/<user_id>', methods=['PATCH'])
@jwt_required()
def update_user(user_id):
    err = require_admin()
    if err: return err
    u = User.query.get_or_404(user_id)
    data = request.get_json()
    if 'name' in data: u.name = data['name']
    if 'role' in data: u.role = data['role']
    if 'is_active' in data: u.is_active = data['is_active']
    if 'password' in data: u.set_password(data['password'])
    if 'pin' in data:
        if data['pin'] is None:
            u.pin_hash = None   # explicitly clear
        else:
            u.set_pin(data['pin'])
    db.session.commit()
    return jsonify(u.to_dict())


@users_bp.route('/<user_id>', methods=['DELETE'])
@jwt_required()
def delete_user(user_id):
    err = require_admin()
    if err: return err
    u = User.query.get_or_404(user_id)
    u.is_active = False
    audit_svc.log(get_jwt_identity(), 'USER_DEACTIVATE', 'user', user_id)
    db.session.commit()
    return jsonify({'message': 'User deactivated'})
