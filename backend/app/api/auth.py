from datetime import timedelta
from flask import Blueprint, request, jsonify
from flask_jwt_extended import (
    create_access_token, create_refresh_token,
    jwt_required, get_jwt_identity
)
from app.extensions import db, limiter
from app.models.user import User
from app.services import audit_svc

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login', methods=['POST'])
@limiter.limit("10 per minute")
def login():
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')

    user = User.query.filter_by(username=username, is_active=True).first()
    if not user or not user.check_password(password):
        audit_svc.log(None, 'USER_LOGIN_FAILED', 'user', None,
                      after={'username': username},
                      ip_address=request.remote_addr)
        db.session.commit()
        return jsonify({'error': 'INVALID_CREDENTIALS', 'message': 'Invalid username or password'}), 401

    access_token = create_access_token(
        identity=user.id,
        additional_claims={'role': user.role, 'name': user.name},
        expires_delta=timedelta(hours=8)
    )
    refresh_token = create_refresh_token(identity=user.id, expires_delta=timedelta(days=7))

    audit_svc.log(user.id, 'USER_LOGIN', 'user', user.id, ip_address=request.remote_addr)
    db.session.commit()

    return jsonify({
        'access_token': access_token,
        'refresh_token': refresh_token,
        'user': user.to_dict()
    })


@auth_bp.route('/refresh', methods=['POST'])
@jwt_required(refresh=True)
def refresh():
    identity = get_jwt_identity()
    access_token = create_access_token(identity=identity, expires_delta=timedelta(hours=8))
    return jsonify({'access_token': access_token})


@auth_bp.route('/logout', methods=['POST'])
@jwt_required()
def logout():
    user_id = get_jwt_identity()
    audit_svc.log(user_id, 'USER_LOGOUT', 'user', user_id, ip_address=request.remote_addr)
    db.session.commit()
    return jsonify({'message': 'Logged out'})


def verify_manager_pin(pin: str):
    """Return the active MANAGER/ADMIN user whose PIN matches, or None.
    Caller is responsible for audit-logging and committing the session."""
    if not pin:
        return None
    managers = User.query.filter(
        User.role.in_(['MANAGER', 'ADMIN']),
        User.is_active == True
    ).all()
    for manager in managers:
        if manager.check_pin(pin):
            return manager
    return None


@auth_bp.route('/verify-pin', methods=['POST'])
@jwt_required()
def verify_pin():
    data = request.get_json()
    pin = data.get('pin', '')
    user_id = get_jwt_identity()

    manager = verify_manager_pin(pin)
    if manager:
        audit_svc.log(user_id, 'MANAGER_PIN_USED', 'user', manager.id,
                      after={'manager_id': manager.id},
                      ip_address=request.remote_addr)
        db.session.commit()
        return jsonify({'valid': True, 'manager_id': manager.id, 'manager_name': manager.name})

    audit_svc.log(user_id, 'MANAGER_PIN_FAILED', 'user', None, ip_address=request.remote_addr)
    db.session.commit()
    return jsonify({'valid': False, 'message': 'Invalid PIN'}), 400


@auth_bp.route('/me', methods=['GET'])
@jwt_required()
def me():
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'NOT_FOUND'}), 404
    return jsonify(user.to_dict())
