from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from app.extensions import db, socketio
from app.models.ticket import TicketLineItem, Ticket
from app.models.print_job import PrintJob
import os

# Lazy prune: delete print_jobs older than 1 day, runs at most once per hour.
_last_prune: float = 0.0

def _maybe_prune_jobs():
    import time
    global _last_prune
    now = time.time()
    if now - _last_prune < 3600:
        return
    _last_prune = now
    try:
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None)
        from sqlalchemy import text
        db.session.execute(text(
            "DELETE FROM print_jobs WHERE created_at < NOW() - INTERVAL '1 day'"
        ))
        db.session.commit()
    except Exception:
        db.session.rollback()

queue_bp = Blueprint('queue', __name__)

VALID_STATUSES = ('IN_PROGRESS', 'READY', 'SERVED')


def _get_queue_items(routing_dest: str):
    items = (
        TicketLineItem.query
        .join(Ticket)
        .filter(
            TicketLineItem.routing_dest == routing_dest,
            TicketLineItem.status.in_(['SENT', 'IN_PROGRESS', 'READY']),
            Ticket.status == 'OPEN'
        )
        .order_by(TicketLineItem.sent_at)
        .all()
    )
    result = []
    for item in items:
        d = item.to_dict()
        if item.ticket and item.ticket.resource:
            d['resource_code'] = item.ticket.resource.code
        result.append(d)
    return result


@queue_bp.route('/kitchen', methods=['GET'])
@jwt_required()
def kitchen_queue():
    return jsonify(_get_queue_items('KITCHEN'))


@queue_bp.route('/counts', methods=['GET'])
@jwt_required()
def queue_counts():
    """Count of all active (SENT + IN_PROGRESS + READY) items per queue for nav badges."""
    kitchen = TicketLineItem.query.join(Ticket).filter(
        TicketLineItem.routing_dest == 'KITCHEN',
        TicketLineItem.status.in_(['SENT', 'IN_PROGRESS', 'READY']),
        Ticket.status == 'OPEN'
    ).count()
    bar = TicketLineItem.query.join(Ticket).filter(
        TicketLineItem.routing_dest == 'BAR',
        TicketLineItem.status.in_(['SENT', 'IN_PROGRESS', 'READY']),
        Ticket.status == 'OPEN'
    ).count()
    return jsonify({'kitchen': kitchen, 'bar': bar})


@queue_bp.route('/bar', methods=['GET'])
@jwt_required()
def bar_queue():
    return jsonify(_get_queue_items('BAR'))


@queue_bp.route('/<item_id>/status', methods=['PATCH'])
@jwt_required()
def update_status(item_id):
    data = request.get_json()
    new_status = data.get('status')

    if new_status not in VALID_STATUSES:
        return jsonify({'error': 'INVALID_STATUS'}), 422

    item = TicketLineItem.query.get_or_404(item_id)
    item.status = new_status
    if new_status == 'SERVED':
        item.served_at = datetime.now(timezone.utc)

    db.session.commit()

    routing = item.routing_dest.lower()
    socketio.emit(f'{routing}:item_update',
                  {'item_id': item_id, 'status': new_status},
                  room=routing)
    socketio.emit('ticket:item_status',
                  {'item_id': item_id, 'status': new_status},
                  room=f'ticket:{item.ticket_id}')
    return jsonify({'item_id': item_id, 'status': new_status})


@queue_bp.route('/<item_id>/print', methods=['POST'])
@jwt_required()
def print_queue_chit(item_id):
    """Send a kitchen/bar command chit to the thermal printer via the print agent."""
    _maybe_prune_jobs()
    item    = TicketLineItem.query.get_or_404(item_id)
    user_id = get_jwt_identity()
    data    = request.get_json(silent=True) or {}
    job_id  = data.get('job_id')

    # Idempotency: don't print again if this job already succeeded
    if job_id:
        existing = PrintJob.query.get(job_id)
        if existing and existing.status == 'PRINTED':
            return jsonify({'ok': True, 'job_id': job_id, 'duplicate': True})

    if job_id and existing:
        job = existing
        job.retry_count += 1
        job.status = 'PENDING'
        job.error_msg = None
    else:
        job = PrintJob(queue_item_id=item_id, type='CHIT',
                       requested_by=user_id, status='SENT')
        db.session.add(job)

    job.status = 'SENT'
    db.session.commit()

    # Group modifiers by name
    mod_map: dict[str, int] = {}
    for m in item.modifiers:
        name = m.modifier.name if hasattr(m, 'modifier') and m.modifier else getattr(m, 'name', '?')
        mod_map[name] = mod_map.get(name, 0) + 1

    chit_data = {
        'job_id': job.id,
        'type': item.routing_dest,
        'resource_code': (
            item.ticket.resource.code
            if item.ticket and item.ticket.resource else '?'
        ),
        'items': [{
            'quantity': item.quantity,
            'name': (item.menu_item.name if item.menu_item else getattr(item, 'item_name', '?')),
            'modifiers': [{'name': k, 'count': v} for k, v in mod_map.items()],
            'notes': item.notes or '',
        }],
        'sent_at': item.sent_at.isoformat() if item.sent_at else '',
    }

    PRINT_AGENT_URL = os.getenv('PRINT_AGENT_URL', 'http://localhost:9191')
    try:
        import requests as http_requests
        r = http_requests.post(f'{PRINT_AGENT_URL}/chit', json=chit_data, timeout=8)
        if r.ok:
            job.status = 'PRINTED'
            job.printed_at = datetime.now(timezone.utc)
            item.needs_reprint = False
            db.session.commit()
            return jsonify({'ok': True, 'job_id': job.id})
        raise RuntimeError(r.text)
    except Exception as e:
        err_msg = str(e)

    job.status = 'FAILED'
    job.error_msg = err_msg
    item.needs_reprint = True
    db.session.commit()

    routing = item.routing_dest.lower()
    socketio.emit(f'{routing}:item_update',
                  {'item_id': item_id, 'needs_reprint': True},
                  room=routing)
    socketio.emit('print:failed', {
        'job_id':        job.id,
        'queue_item_id': item_id,
        'type':          'CHIT',
        'error':         err_msg,
    }, room='manager')

    return jsonify({'ok': False, 'job_id': job.id, 'error': err_msg}), 503
