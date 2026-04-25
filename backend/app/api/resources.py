from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from app.extensions import db, socketio
from app.models.resource import Resource, PoolTableConfig
from app.models.ticket import Ticket
from app.models.waiting_list import WaitingListEntry
from app.services import audit_svc


_CODE_PREFIX = {
    'BAR_SEAT': 'B',
    'POOL_TABLE': 'PT',
    'REGULAR_TABLE': 'T',
}


def _next_free_code(resource_type: str) -> str:
    """Pick the next sequential code for the given type's prefix.

    Uses max(existing numeric suffix) + 1 — matching what the frontend
    auto-coder visually expects — and considers soft-deleted rows so we
    never collide with UNIQUE(code). Codes whose suffix isn't purely
    digits (e.g. seed's 'Bar-01', manual 'T-11', 'TEMP01') are ignored
    when computing the max but still walked over if they collide.
    """
    prefix = _CODE_PREFIX.get(resource_type, 'T')
    rows = (Resource.query
            .filter(Resource.code.like(f'{prefix}%'))
            .with_entities(Resource.code)
            .all())
    nums = []
    for (code,) in rows:
        suffix = code[len(prefix):]
        if suffix.isdigit():
            nums.append(int(suffix))
    n = (max(nums) + 1) if nums else 1
    while Resource.query.filter_by(code=f'{prefix}{n}').first() is not None:
        n += 1
    return f'{prefix}{n}'


def _active_wl_entry_using(resource_id):
    """Return the first active WaitingListEntry that references this resource,
    or None. An entry counts as 'active' while it's WAITING or SEATED — once
    it's ASSIGNED/CANCELLED/NO_SHOW the historical FK reference is harmless."""
    return (WaitingListEntry.query
            .filter(
                or_(
                    WaitingListEntry.floor_resource_id == resource_id,
                    WaitingListEntry.assigned_resource_id == resource_id,
                ),
                WaitingListEntry.status.in_(('WAITING', 'SEATED')),
            )
            .first())

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
    rtype = data['type']
    is_temp = bool(data.get('is_temp', False))
    code = (data.get('code') or '').strip() or None

    # For temp tables the client-supplied code is a hint. Soft-deleted rows
    # are still in `resources` (UNIQUE(code) is enforced regardless of
    # is_active), so the FloorMap auto-coder happily reuses an old code like
    # T11 and trips a 500. Resolve the collision server-side instead.
    if is_temp and (code is None
                    or Resource.query.filter_by(code=code).first() is not None):
        code = _next_free_code(rtype)
    elif code is None:
        return jsonify({'error': 'CODE_REQUIRED'}), 422
    elif Resource.query.filter_by(code=code).first() is not None:
        return jsonify({
            'error': 'CODE_TAKEN',
            'message': f'Ya existe una mesa con el código "{code}"',
        }), 409

    r = Resource(
        code=code,
        name=data['name'],
        type=rtype,
        sort_order=data.get('sort_order', 0),
        is_temp=is_temp,
    )
    db.session.add(r)
    if r.type == 'POOL_TABLE':
        cfg = PoolTableConfig(resource_id=r.id)
        db.session.add(cfg)
    try:
        db.session.flush()
    except IntegrityError:
        # Defense in depth: another request committed the same code between
        # our pre-check and flush. Roll back and surface a clean 409.
        db.session.rollback()
        return jsonify({
            'error': 'CODE_TAKEN',
            'message': f'Ya existe una mesa con el código "{code}"',
        }), 409
    audit_svc.log(get_jwt_identity(), 'RESOURCE_CREATE', 'resource', r.id, after=r.to_dict())
    db.session.commit()
    socketio.emit('floor:update', {}, room='floor')
    return jsonify(r.to_dict()), 201


@resources_bp.route('/<resource_id>', methods=['PATCH'])
@jwt_required()
def update_resource(resource_id):
    err = require_manager()
    if err: return err
    r = Resource.query.with_for_update().get_or_404(resource_id)
    before = r.to_dict()
    data = request.get_json()
    if 'name' in data: r.name = data['name']
    if 'is_active' in data:
        # Deactivating a resource must not orphan an open ticket or an active
        # waiting-list entry. Bail with a clear error so the caller can fix
        # those references first.
        if data['is_active'] is False and r.is_active:
            active_ticket = Ticket.query.filter_by(resource_id=r.id, status='OPEN').first()
            if active_ticket:
                return jsonify({
                    'error': 'TABLE_HAS_OPEN_TICKET',
                    'message': f'{r.code} aún tiene un ticket abierto',
                    'ticket_id': active_ticket.id,
                }), 409
            wl = _active_wl_entry_using(r.id)
            if wl:
                return jsonify({
                    'error': 'TABLE_IN_WAITING_LIST',
                    'message': f'{r.code} está referenciada por la lista de espera de "{wl.party_name}"',
                    'waiting_list_entry_id': wl.id,
                }), 409
        r.is_active = data['is_active']
    if 'sort_order' in data: r.sort_order = data['sort_order']
    audit_svc.log(get_jwt_identity(), 'RESOURCE_UPDATE', 'resource', r.id, before=before, after=r.to_dict())
    db.session.commit()
    socketio.emit('floor:update', {}, room='floor')
    return jsonify(r.to_dict())


@resources_bp.route('/<resource_id>', methods=['DELETE'])
@jwt_required()
def delete_resource(resource_id):
    err = require_manager()
    if err: return err
    r = Resource.query.with_for_update().get_or_404(resource_id)
    active = Ticket.query.filter_by(resource_id=r.id, status='OPEN').first()
    if active:
        return jsonify({
            'error': 'TABLE_HAS_OPEN_TICKET',
            'ticket_id': active.id,
        }), 409
    wl = _active_wl_entry_using(r.id)
    if wl:
        return jsonify({
            'error': 'TABLE_IN_WAITING_LIST',
            'message': f'{r.code} está referenciada por la lista de espera de "{wl.party_name}"',
            'waiting_list_entry_id': wl.id,
        }), 409
    # Soft-delete: deactivate instead of hard delete to preserve ticket history
    before = r.to_dict()
    r.is_active = False
    r.status = 'INACTIVE'
    audit_svc.log(get_jwt_identity(), 'RESOURCE_DELETE', 'resource', r.id, before=before, after={'is_active': False})
    db.session.commit()
    socketio.emit('floor:update', {}, room='floor')
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
