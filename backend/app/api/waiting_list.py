from datetime import datetime, timezone
from contextlib import contextmanager
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from sqlalchemy.exc import SQLAlchemyError
from app.extensions import db, socketio
from app.models.waiting_list import WaitingListEntry
from app.models.resource import Resource, PoolTableConfig
from app.models.ticket import Ticket, TicketLineItem, PoolTimerSession
from app.services import audit_svc
# Shared with tickets.py so both transfer paths stop pool timers identically.
# tickets.py does not import this module, so there is no import cycle.
from app.api.tickets import _stop_active_timer
from app.config import Config

waiting_list_bp = Blueprint('waiting_list', __name__)


class _Abort(Exception):
    """Carries an HTTP response out of an atomic block without committing."""

    def __init__(self, payload, status):
        super().__init__(payload.get('error', 'ABORT'))
        self.payload = payload
        self.status = status


@contextmanager
def _atomic(action: str):
    """Run a waiting-list mutation as one all-or-nothing PostgreSQL transaction.

    Seating a party touches several rows at once -- the entry, the resource, a
    new ticket and possibly a pool timer. Without an explicit rollback a failure
    partway through could leave a resource marked IN_USE with no ticket, or an
    entry pointing at a ticket that was never committed, which is exactly how
    parties and tabs went missing.

    Raise _Abort inside the block to return a client error without committing.
    """
    try:
        yield
        db.session.commit()
    except _Abort:
        db.session.rollback()
        raise
    except SQLAlchemyError:
        db.session.rollback()
        current_app.logger.exception('waiting-list %s failed; rolled back', action)
        raise


def _emit_waiting_update():
    socketio.emit('waiting:update', {}, room='floor')


# Sorts unpositioned entries last without relying on the backend's NULL
# ordering, which differs between ASC (last) and DESC (first) in Postgres.
_POS_SORT = db.func.coalesce(WaitingListEntry.position, 2147483647)


def _active_entries():
    """Active queue in display order: manual position first, arrival as tiebreak."""
    return WaitingListEntry.query.filter(
        WaitingListEntry.status.in_(['WAITING', 'SEATED'])
    ).order_by(_POS_SORT, WaitingListEntry.created_at).all()


def _reorder_positions():
    """Renumber positions 1..N for all active (WAITING/SEATED) entries.

    Ordered by CURRENT position, not created_at. Ordering by created_at here
    silently undid every manual `move`: the moment any other party was
    assigned or cancelled the queue snapped back to arrival order, which is
    why reordering never appeared to work.
    """
    for i, e in enumerate(_active_entries(), start=1):
        e.position = i


def _start_pool_timer(ticket, resource_id):
    cfg = PoolTableConfig.query.get(resource_id)
    return PoolTimerSession(
        ticket_id=ticket.id,
        resource_id=resource_id,
        billing_mode=cfg.billing_mode if cfg else Config.BILLING_MODE,
        rate_cents=cfg.rate_cents if cfg else Config.POOL_RATE_CENTS,
        promo_free_seconds=(cfg.promo_free_minutes * 60) if cfg else 0,
    )


def _seat_entry(entry, ticket, resource):
    """Point the entry at the table the ticket now sits on."""
    if resource.type == 'POOL_TABLE':
        # Got what they were queuing for: leaves the active list.
        entry.status = 'ASSIGNED'
        entry.assigned_at = datetime.now(timezone.utc)
        entry.assigned_resource_id = resource.id
        entry.assigned_ticket_id = ticket.id
    else:
        # Seated on the floor but still queuing for a pool table.
        entry.status = 'SEATED'
        entry.floor_resource_id = resource.id
        entry.floor_ticket_id = ticket.id


def _relocate_ticket(entry, ticket, target, user_id):
    """Move an existing OPEN ticket to `target`, freeing the table it was on.

    Used whenever a party that already has a tab changes table, to a pool
    table or to another floor table. Opening a SECOND ticket here was the bug
    that left one party with two tabs -- the abandoned one still holding its
    table IN_USE and its items unpaid.
    """
    old = (Resource.query.with_for_update().get(ticket.resource_id)
           if ticket.resource_id else None)
    old_code = old.code if old else '?'

    # Stop any running pool timer BEFORE detaching the table, mirroring
    # tickets.transfer_ticket. Without this the old session keeps end_time
    # NULL: moving to another pool table leaves two ACTIVE timers on one
    # ticket (only one of which _stop_active_timer's .first() will ever
    # close), and moving to a floor table keeps billing pool time for a
    # party that is no longer on a pool table.
    _stop_active_timer(ticket, user_id)
    db.session.flush()

    if old is not None and old.id != target.id:
        old.status = 'AVAILABLE'
        if old.is_temp:
            old.is_active = False

    target.status = 'IN_USE'
    ticket.resource_id = target.id
    ticket.version += 1

    if target.type == 'POOL_TABLE':
        db.session.add(_start_pool_timer(ticket, target.id))
        audit_svc.log(user_id, 'TIMER_START', 'pool_timer', ticket.id)
        db.session.flush()

    # Recalculate AFTER the timer transitions are flushed so the stopped
    # session's charge_cents is included in pool_time_cents.
    ticket.recalculate_totals()

    _seat_entry(entry, ticket, target)
    audit_svc.log(user_id, 'TRANSFER', 'ticket', ticket.id,
                  before={'resource': old_code},
                  after={'resource': target.code})
    return ticket


def _cancel_seated_ticket(entry, user_id):
    """Cascade-terminate the floor ticket linked to a SEATED entry that is
    being marked NO_SHOW or CANCELLED. Mirrors `cancel_ticket`'s rules:
    only proceeds if the ticket is empty (no active items, no pool time).
    Returns (ok, err_response, changed). On HAS_ITEMS / HAS_POOL_TIME
    returns ok=False with a 422 the caller should propagate so a started
    tab can't be silently destroyed.
    """
    if not entry.floor_ticket_id:
        return True, None, False
    ticket = Ticket.query.with_for_update().get(entry.floor_ticket_id)
    if ticket is None or ticket.status != 'OPEN':
        return True, None, False

    active_items = ticket.line_items.filter(
        TicketLineItem.status != 'VOIDED'
    ).count()
    if active_items > 0:
        return False, (jsonify({
            'error': 'TICKET_HAS_ITEMS',
            'message': f'El ticket de "{ticket.customer_name or entry.party_name}" tiene productos. Ciérralo o páguelo antes.',
            'ticket_id': ticket.id,
        }), 422), False
    if ticket.timer_sessions.count() > 0:
        return False, (jsonify({
            'error': 'TICKET_HAS_POOL_TIME',
            'message': 'El ticket tiene tiempo de pool registrado. Ciérralo antes.',
            'ticket_id': ticket.id,
        }), 422), False

    if ticket.resource_id:
        resource = Resource.query.get(ticket.resource_id)
        if resource:
            resource.status = 'AVAILABLE'
            if resource.is_temp:
                resource.is_active = False

    ticket.status = 'CANCELLED'
    ticket.closed_at = datetime.now(timezone.utc)
    ticket.closed_by = user_id
    ticket.version += 1
    audit_svc.log(user_id, 'TICKET_CANCEL', 'ticket', ticket.id,
                  after={'reason': 'Waiting-list entry marked NO_SHOW/CANCELLED'})
    return True, None, True


@waiting_list_bp.route('', methods=['GET'])
@jwt_required()
def list_waiting():
    entries = WaitingListEntry.query.filter(
        WaitingListEntry.status.in_(['WAITING', 'SEATED'])
    ).order_by(WaitingListEntry.position, WaitingListEntry.created_at).all()
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

    # Optional: immediately seat at a floor table (from ticket page "join waiting list")
    floor_ticket_id = data.get('floor_ticket_id')
    floor_resource_id = data.get('floor_resource_id')

    # These are raw client-supplied FKs. Unvalidated they could point at any
    # ticket -- including one already on a pool table, which made a later
    # /transfer-to-pool start a second timer on a ticket that already had one.
    if floor_ticket_id:
        floor_ticket = Ticket.query.get(floor_ticket_id)
        if floor_ticket is None:
            return jsonify({'error': 'TICKET_NOT_FOUND',
                            'message': 'El ticket indicado no existe.'}), 404
        if floor_ticket.status != 'OPEN':
            return jsonify({'error': 'TICKET_NOT_OPEN',
                            'message': 'El ticket indicado no está abierto.'}), 409
        linked = WaitingListEntry.query.filter(
            WaitingListEntry.floor_ticket_id == floor_ticket_id,
            WaitingListEntry.status.in_(['WAITING', 'SEATED']),
        ).first()
        if linked:
            return jsonify({
                'error': 'TICKET_ALREADY_QUEUED',
                'message': f'Ese ticket ya está en la lista como "{linked.party_name}".',
                'waiting_list_entry_id': linked.id,
            }), 409
        # Trust the ticket's own table over whatever the client sent.
        floor_resource_id = floor_ticket.resource_id
    elif floor_resource_id:
        # A floor resource without a ticket cannot be seated.
        return jsonify({'error': 'TICKET_REQUIRED',
                        'message': 'floor_resource_id requiere floor_ticket_id.'}), 422

    # max(), not ORDER BY position DESC LIMIT 1: in Postgres a DESC sort puts
    # NULLs FIRST, so a single unpositioned row handed every new party
    # position 1 and collided the whole queue.
    max_pos = db.session.query(db.func.max(WaitingListEntry.position)).filter(
        WaitingListEntry.status.in_(['WAITING', 'SEATED'])
    ).scalar()
    next_pos = (max_pos or 0) + 1

    try:
        party_size = max(1, int(data.get('party_size') or 1))
    except (TypeError, ValueError):
        return jsonify({'error': 'party_size must be a number'}), 400

    initial_status = 'SEATED' if floor_ticket_id else 'WAITING'

    entry = WaitingListEntry(
        party_name=party_name,
        party_size=party_size,
        notes=data.get('notes', ''),
        position=next_pos,
        status=initial_status,
        created_by=user_id,
        floor_ticket_id=floor_ticket_id or None,
        floor_resource_id=floor_resource_id or None,
    )
    db.session.add(entry)
    audit_svc.log(user_id, 'WAITLIST_ADD', 'waiting_list', None,
                  after={'party_name': party_name, 'position': next_pos, 'status': initial_status})
    db.session.commit()
    _emit_waiting_update()
    return jsonify(entry.to_dict()), 201


@waiting_list_bp.route('/<entry_id>/assign', methods=['POST'])
@jwt_required()
def assign_entry(entry_id):
    """Seat the waiting party at a resource.

    - No tab yet      -> open a ticket on the target.
    - Already has a tab (SEATED) -> MOVE that ticket to the target.
    - Floor table     -> status SEATED, stays queued for a pool table.
    - Pool table      -> status ASSIGNED, leaves the queue.
    """
    user_id = get_jwt_identity()
    data = request.get_json() or {}
    resource_id = data.get('resource_id')
    if not resource_id:
        return jsonify({'error': 'resource_id required'}), 400

    # Lock the entry: without this, two waiters assigning the same party at
    # the same time each opened a ticket, on two different tables.
    entry = WaitingListEntry.query.with_for_update().get_or_404(entry_id)
    if entry.status not in ('WAITING', 'SEATED'):
        return jsonify({'error': 'Entry is not active'}), 409

    resource = Resource.query.with_for_update().get_or_404(resource_id)
    if not resource.is_active:
        return jsonify({'error': 'RESOURCE_INACTIVE',
                        'message': f'{resource.code} ya no está disponible'}), 409
    # A party may be "reassigned" to the table it is already on; that is a
    # no-op move, not an occupancy conflict.
    if resource.status == 'IN_USE' and resource.id != entry.floor_resource_id:
        return jsonify({'error': 'RESOURCE_OCCUPIED',
                        'message': f'{resource.code} ya está en uso'}), 409

    existing = (Ticket.query.with_for_update().get(entry.floor_ticket_id)
                if entry.floor_ticket_id else None)

    try:
        with _atomic('assign'):
            if existing is not None and existing.status == 'OPEN':
                ticket = _relocate_ticket(entry, existing, resource, user_id)
            else:
                # Same guard as tickets.open_ticket: a ticket created while the bar is
                # closed falls outside _build_summary's session window and is invisible
                # to cash reconciliation. Relocating an EXISTING tab is exempt -- that
                # tab is already part of an open session.
                from app.models.cash_session import CashSession
                if not CashSession.query.filter_by(status='OPEN').first():
                    raise _Abort({
                        'error': 'BAR_CLOSED',
                        'message': 'La caja no está abierta. El gerente debe abrir el turno primero.',
                    }, 403)

                ticket = Ticket(
                    resource_id=resource_id,
                    ticket_type='TABLE',
                    opened_by=user_id,
                    customer_name=entry.party_name,
                )
                db.session.add(ticket)
                db.session.flush()
                resource.status = 'IN_USE'
                if resource.type == 'POOL_TABLE':
                    db.session.add(_start_pool_timer(ticket, resource_id))
                    audit_svc.log(user_id, 'TIMER_START', 'pool_timer', ticket.id)
                _seat_entry(entry, ticket, resource)
                audit_svc.log(user_id, 'TICKET_OPEN', 'ticket', ticket.id,
                              after={'resource_id': resource_id,
                                     'customer_name': entry.party_name})

            _reorder_positions()
            audit_svc.log(user_id, 'WAITLIST_ASSIGN', 'waiting_list', entry.id,
                          after={'resource_id': resource_id, 'ticket_id': ticket.id,
                                 'resource_type': resource.type})
    except _Abort as abort:
        return jsonify(abort.payload), abort.status
    except SQLAlchemyError:
        return jsonify({'error': 'ASSIGN_FAILED',
                        'message': 'No se pudo sentar a la fila. Intenta de nuevo.'}), 500

    _emit_waiting_update()
    socketio.emit('floor:update', {}, room='floor')
    return jsonify({'entry': entry.to_dict(), 'ticket': ticket.to_dict()}), 201


@waiting_list_bp.route('/<entry_id>/status', methods=['PATCH'])
@jwt_required()
def update_status(entry_id):
    """Cancel or mark no-show. If the entry is SEATED, the linked floor
    ticket cascades to CANCELLED — but only when empty (no items, no pool
    time). A started tab refuses with 422 so it can't be silently lost."""
    user_id = get_jwt_identity()
    data = request.get_json()
    new_status = data.get('status')
    if new_status not in ('CANCELLED', 'NO_SHOW'):
        return jsonify({'error': 'status must be CANCELLED or NO_SHOW'}), 400

    entry = WaitingListEntry.query.with_for_update().get_or_404(entry_id)
    if entry.status not in ('WAITING', 'SEATED'):
        return jsonify({'error': 'Entry not active'}), 409

    before_status = entry.status
    floor_changed = False
    if entry.status == 'SEATED':
        ok, err, floor_changed = _cancel_seated_ticket(entry, user_id)
        if not ok:
            return err

    entry.status = new_status
    _reorder_positions()
    audit_svc.log(user_id, 'WAITLIST_STATUS', 'waiting_list', entry.id,
                  before={'status': before_status}, after={'status': new_status})
    db.session.commit()
    _emit_waiting_update()
    if floor_changed:
        socketio.emit('floor:update', {}, room='floor')
    return jsonify(entry.to_dict())


@waiting_list_bp.route('/<entry_id>/dequeue', methods=['POST'])
@jwt_required()
def dequeue_entry(entry_id):
    """Remove a SEATED party from the queue while keeping their floor
    ticket and table intact. Used when the customer no longer wants to
    wait for a pool table but stays at their assigned floor seat.
    For WAITING entries (no ticket yet) use /status with NO_SHOW/CANCELLED.
    """
    user_id = get_jwt_identity()
    entry = WaitingListEntry.query.with_for_update().get_or_404(entry_id)
    if entry.status != 'SEATED':
        return jsonify({
            'error': 'NOT_SEATED',
            'message': 'Sólo se puede sacar de la cola a una mesa ya sentada.',
        }), 409
    before_status = entry.status
    entry.status = 'ASSIGNED'
    if not entry.assigned_at:
        entry.assigned_at = datetime.now(timezone.utc)
    _reorder_positions()
    audit_svc.log(user_id, 'WAITLIST_DEQUEUE', 'waiting_list', entry.id,
                  before={'status': before_status},
                  after={'status': 'ASSIGNED', 'reason': 'Customer left queue, kept tab'})
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

    data = request.get_json() or {}
    direction = data.get('direction')
    # Previously any value that wasn't 'up' fell through to 'down', so a typo
    # or a missing field silently moved the party the wrong way.
    if direction not in ('up', 'down'):
        return jsonify({'error': "direction must be 'up' or 'down'"}), 400

    # Normalise to a contiguous 1..N first: a swap between duplicated or
    # NULL positions is a no-op, which looked like the button doing nothing.
    entries = _active_entries()
    for i, e in enumerate(entries, start=1):
        e.position = i

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


@waiting_list_bp.route('/<entry_id>/transfer-to-pool', methods=['POST'])
@jwt_required()
def transfer_to_pool(entry_id):
    """Transfer a SEATED party's floor ticket to a pool table, freeing the floor table."""
    user_id = get_jwt_identity()
    data = request.get_json() or {}
    pool_resource_id = data.get('pool_resource_id')
    if not pool_resource_id:
        return jsonify({'error': 'pool_resource_id required'}), 400

    entry = WaitingListEntry.query.with_for_update().get_or_404(entry_id)
    if entry.status != 'SEATED' or not entry.floor_ticket_id:
        return jsonify({'error': 'Entry is not SEATED or has no floor ticket'}), 409

    pool_resource = Resource.query.with_for_update().get_or_404(pool_resource_id)
    if pool_resource.type != 'POOL_TABLE':
        return jsonify({'error': 'Target must be a POOL_TABLE'}), 400
    if not pool_resource.is_active:
        return jsonify({'error': 'RESOURCE_INACTIVE',
                        'message': f'{pool_resource.code} ya no está disponible'}), 409
    if pool_resource.status == 'IN_USE':
        return jsonify({'error': 'POOL_TABLE_OCCUPIED',
                        'message': f'{pool_resource.code} ya está en uso'}), 409

    ticket = Ticket.query.with_for_update().get_or_404(entry.floor_ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'Floor ticket is not open'}), 409

    try:
        with _atomic('transfer-to-pool'):
            _relocate_ticket(entry, ticket, pool_resource, user_id)
            _reorder_positions()
            audit_svc.log(user_id, 'WAITLIST_ASSIGN', 'waiting_list', entry.id,
                          after={'pool_resource_id': pool_resource_id})
    except SQLAlchemyError:
        return jsonify({'error': 'TRANSFER_FAILED',
                        'message': 'No se pudo mover la cuenta a la mesa. Intenta de nuevo.'}), 500

    _emit_waiting_update()
    socketio.emit('floor:update', {}, room='floor')
    return jsonify({'entry': entry.to_dict(), 'ticket': ticket.to_dict()}), 200
