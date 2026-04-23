from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from app.extensions import db
from app.models.resource import Resource, PoolTableConfig
from app.models.ticket import Ticket
from app.services import audit_svc

resources_bp = Blueprint('resources', __name__)


def require_manager():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


@resources_bp.route('', methods=['GET'])
@jwt_required()
def list_resources():
    include_inactive = request.args.get('include_inactive', 'false').lower() == 'true'
    q = Resource.query
    if not include_inactive:
        q = q.filter_by(is_active=True)
    resources = q.order_by(Resource.sort_order, Resource.code).all()
    result = []
    for r in resources:
        d = r.to_dict()
        # Find active ticket — always use the most recently opened one
        active = Ticket.query.filter_by(resource_id=r.id, status='OPEN').order_by(Ticket.opened_at.desc()).first()
        d['active_ticket_id'] = active.id if active else None
        d['customer_name'] = active.customer_name if active else None
        if active and r.type == 'POOL_TABLE':
            from app.models.ticket import PoolTimerSession
            session = PoolTimerSession.query.filter_by(ticket_id=active.id, end_time=None).first()
            if session:
                d['timer_start'] = session.start_time.isoformat()
                d['timer_session_id'] = session.id
        if r.type == 'POOL_TABLE':
            cfg = PoolTableConfig.query.get(r.id)
            d['pool_config'] = cfg.to_dict() if cfg else None
        result.append(d)
    return jsonify(result)


@resources_bp.route('/<resource_id>', methods=['GET'])
@jwt_required()
def get_resource(resource_id):
    r = Resource.query.get_or_404(resource_id)
    return jsonify(r.to_dict())


@resources_bp.route('', methods=['POST'])
@jwt_required()
def create_resource():
    err = require_manager()
    if err: return err
    data = request.get_json()
    r = Resource(
        code=data['code'],
        name=data['name'],
        type=data['type'],
        sort_order=data.get('sort_order', 0),
        is_temp=data.get('is_temp', False)
    )
    db.session.add(r)
    if r.type == 'POOL_TABLE':
        cfg = PoolTableConfig(resource_id=r.id)
        db.session.add(cfg)
    db.session.flush()
    audit_svc.log(get_jwt_identity(), 'RESOURCE_CREATE', 'resource', r.id, after=r.to_dict())
    db.session.commit()
    return jsonify(r.to_dict()), 201


@resources_bp.route('/<resource_id>', methods=['PATCH'])
@jwt_required()
def update_resource(resource_id):
    err = require_manager()
    if err: return err
    r = Resource.query.get_or_404(resource_id)
    before = r.to_dict()
    data = request.get_json()
    if 'name' in data: r.name = data['name']
    if 'is_active' in data: r.is_active = data['is_active']
    if 'sort_order' in data: r.sort_order = data['sort_order']
    audit_svc.log(get_jwt_identity(), 'RESOURCE_UPDATE', 'resource', r.id, before=before, after=r.to_dict())
    db.session.commit()
    return jsonify(r.to_dict())


@resources_bp.route('/<resource_id>', methods=['DELETE'])
@jwt_required()
def delete_resource(resource_id):
    err = require_manager()
    if err: return err
    r = Resource.query.get_or_404(resource_id)
    active = Ticket.query.filter_by(resource_id=r.id, status='OPEN').first()
    if active:
        return jsonify({'error': 'TABLE_HAS_OPEN_TICKET'}), 409
    # Soft-delete: deactivate instead of hard delete to preserve ticket history
    before = r.to_dict()
    r.is_active = False
    r.status = 'INACTIVE'
    audit_svc.log(get_jwt_identity(), 'RESOURCE_DELETE', 'resource', r.id, before=before, after={'is_active': False})
    db.session.commit()
    return jsonify({'ok': True})


@resources_bp.route('/<resource_id>/pool-config', methods=['GET'])
@jwt_required()
def get_pool_config(resource_id):
    cfg = PoolTableConfig.query.get_or_404(resource_id)
    return jsonify(cfg.to_dict())


@resources_bp.route('/<resource_id>/pool-config', methods=['PATCH'])
@jwt_required()
def update_pool_config(resource_id):
    err = require_manager()
    if err: return err
    cfg = PoolTableConfig.query.get(resource_id)
    if not cfg:
        cfg = PoolTableConfig(resource_id=resource_id)
        db.session.add(cfg)
    before = cfg.to_dict()
    data = request.get_json()
    if 'billing_mode' in data: cfg.billing_mode = data['billing_mode']
    if 'rate_cents' in data: cfg.rate_cents = data['rate_cents']
    if 'promo_free_minutes' in data: cfg.promo_free_minutes = data['promo_free_minutes']
    audit_svc.log(get_jwt_identity(), 'POOL_CONFIG_UPDATE', 'pool_config', resource_id, before=before, after=cfg.to_dict())
    db.session.commit()
    return jsonify(cfg.to_dict())
