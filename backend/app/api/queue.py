from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from app.extensions import db, socketio
from app.models.ticket import TicketLineItem, Ticket

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


@queue_bp.route('/bar', methods=['GET'])
@jwt_required()
def bar_queue():
    return jsonify(_get_queue_items('BAR'))


@queue_bp.route('/<item_id>/status', methods=['PATCH'])
@jwt_required()
def update_status(item_id):
    user_id = get_jwt_identity()
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
