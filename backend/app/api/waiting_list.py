from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from app.extensions import db, socketio
from app.models.waiting_list import WaitingListEntry
from app.models.resource import Resource, PoolTableConfig
from app.models.ticket import Ticket, PoolTimerSession
from app.services import audit_svc
from app.config import Config

waiting_list_bp = Blueprint('waiting_list', __name__)


def _emit_waiting_update():
    socketio.emit('waiting:update', {}, room='floor')


def _reorder_positions():
    """Renumber positions 1..N for all WAITING entries."""
    entries = WaitingListEntry.query.filter_by(status='WAITING')\
        .order_by(WaitingListEntry.created_at).all()
    for i, e in enumerate(entries, start=1):
        e.position = i


@waiting_list_bp.route('', methods=['GET'])
@jwt_required()
def list_waiting():
    entries = WaitingListEntry.query.filter_by(status='WAITING')\
        .order_by(WaitingListEntry.position, WaitingListEntry.created_at).all()
    return jsonify([e.to_dict() for e in entries])


@waiting_list_bp.route('/history', methods=['GET'])
@jwt_required()
def list_history():
    entries = WaitingListEntry.query\
        .order_by(WaitingListEntry.created_at.desc()).limit(50).all()
    return jsonify([e.to_dict() for e in entries])


@waiting_list_bp.route('', methods=['POST'])
@jwt_required()
def add_to_waiting():
    user_id = get_jwt_identity()
    data = request.get_json()

    party_name = (data.get('party_name') or '').strip()
    if not party_name:
        return jsonify({'error': 'party_name required'}), 400

    # Next position
    last = WaitingListEntry.query.filter_by(status='WAITING')\
        .order_by(WaitingListEntry.position.desc()).first()
    next_pos = (last.position or 0) + 1 if last else 1

    entry = WaitingListEntry(
        party_name=party_name,
        party_size=int(data.get('party_size', 1)),
        notes=data.get('notes', ''),
        position=next_pos,
        created_by=user_id,
    )
    db.session.add(entry)
    audit_svc.log(user_id, 'WAITLIST_ADD', 'waiting_list', None,
                  after={'party_name': party_name, 'position': next_pos})
    db.session.commit()
    _emit_waiting_update()
    return jsonify(entry.to_dict()), 201


@waiting_list_bp.route('/<entry_id>/assign', methods=['POST'])
@jwt_required()
def assign_entry(entry_id):
    """Assign the waiting party to a pool table and open a ticket."""
    user_id = get_jwt_identity()
    data = request.get_json()
    resource_id = data.get('resource_id')

    entry = WaitingListEntry.query.get_or_404(entry_id)
    if entry.status != 'WAITING':
        return jsonify({'error': 'Entry is not WAITING'}), 409

    resource = Resource.query.with_for_update().get_or_404(resource_id)
    if resource.status == 'IN_USE':
        return jsonify({'error': 'POOL_TABLE_OCCUPIED',
                        'message': f'{resource.code} is currently in use'}), 409

    # Open ticket with party name
    ticket = Ticket(
        resource_id=resource_id,
        opened_by=user_id,
        customer_name=entry.party_name,
    )
    db.session.add(ticket)
    db.session.flush()

    resource.status = 'IN_USE'

    # Start pool timer if it's a pool table
    if resource.type == 'POOL_TABLE':
        cfg = PoolTableConfig.query.get(resource_id)
        billing_mode = cfg.billing_mode if cfg else Config.BILLING_MODE
        rate_cents = cfg.rate_cents if cfg else Config.POOL_RATE_CENTS
        promo_free_seconds = (cfg.promo_free_minutes * 60) if cfg else 0
        timer = PoolTimerSession(
            ticket_id=ticket.id,
            resource_id=resource_id,
            billing_mode=billing_mode,
            rate_cents=rate_cents,
            promo_free_seconds=promo_free_seconds,
        )
        db.session.add(timer)
        audit_svc.log(user_id, 'TIMER_START', 'pool_timer', ticket.id)

    # Mark entry as assigned
    entry.status = 'ASSIGNED'
    entry.assigned_at = datetime.now(timezone.utc)
    entry.assigned_resource_id = resource_id
    entry.assigned_ticket_id = ticket.id

    _reorder_positions()
    audit_svc.log(user_id, 'WAITLIST_ASSIGN', 'waiting_list', entry.id,
                  after={'resource_id': resource_id, 'ticket_id': ticket.id})
    audit_svc.log(user_id, 'TICKET_OPEN', 'ticket', ticket.id,
                  after={'resource_id': resource_id, 'customer_name': entry.party_name})
    db.session.commit()
    _emit_waiting_update()
    socketio.emit('floor:update', {}, room='floor')
    return jsonify({'entry': entry.to_dict(), 'ticket': ticket.to_dict()}), 201


@waiting_list_bp.route('/<entry_id>/status', methods=['PATCH'])
@jwt_required()
def update_status(entry_id):
    """Cancel or mark no-show."""
    user_id = get_jwt_identity()
    data = request.get_json()
    new_status = data.get('status')
    if new_status not in ('CANCELLED', 'NO_SHOW'):
        return jsonify({'error': 'status must be CANCELLED or NO_SHOW'}), 400

    entry = WaitingListEntry.query.get_or_404(entry_id)
    if entry.status != 'WAITING':
        return jsonify({'error': 'Entry not in WAITING state'}), 409

    entry.status = new_status
    _reorder_positions()
    audit_svc.log(user_id, 'WAITLIST_STATUS', 'waiting_list', entry.id,
                  before={'status': 'WAITING'}, after={'status': new_status})
    db.session.commit()
    _emit_waiting_update()
    return jsonify(entry.to_dict())


@waiting_list_bp.route('/<entry_id>/move', methods=['PATCH'])
@jwt_required()
def move_position(entry_id):
    """Move an entry up or down in the queue (manager only)."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    data = request.get_json()
    direction = data.get('direction')  # 'up' | 'down'

    entry = WaitingListEntry.query.get_or_404(entry_id)
    entries = WaitingListEntry.query.filter_by(status='WAITING')\
        .order_by(WaitingListEntry.position).all()

    idx = next((i for i, e in enumerate(entries) if e.id == entry_id), None)
    if idx is None:
        return jsonify({'error': 'Not in waiting list'}), 404

    swap_idx = idx - 1 if direction == 'up' else idx + 1
    if 0 <= swap_idx < len(entries):
        entries[idx].position, entries[swap_idx].position = \
            entries[swap_idx].position, entries[idx].position

    db.session.commit()
    _emit_waiting_update()
    return jsonify({'ok': True})
