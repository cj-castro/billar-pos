import os
import json
from urllib.request import urlopen, Request
from urllib.error import URLError
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from sqlalchemy import or_
from app.extensions import db, socketio
from app.models.resource import Resource, PoolTableConfig
from app.models.ticket import (
    Ticket, TicketLineItem, LineItemModifier,
    PoolTimerSession
)
from app.models.menu import MenuItem
from app.models.inventory import MenuItemIngredient, InventoryItem
from app.models.waiting_list import WaitingListEntry
from app.services import audit_svc, billing, inventory_svc, promotion_svc
from app.config import Config

PRINT_AGENT_URL = os.environ.get('PRINT_AGENT_URL', 'http://host.docker.internal:9191')

tickets_bp = Blueprint('tickets', __name__)


def _emit_floor_update():
    socketio.emit('floor:update', {}, room='floor')


def _stop_active_timer(ticket: Ticket, user_id: str) -> int:
    """Stop any running timer session, compute charge, return charge_cents."""
    session = PoolTimerSession.query.filter_by(
        ticket_id=ticket.id, end_time=None
    ).first()
    if not session:
        return 0

    now = datetime.now(timezone.utc)
    session.end_time = now
    result = billing.calculate_charge(
        session.start_time, now,
        session.billing_mode, session.rate_cents,
        session.promo_free_seconds
    )
    session.duration_seconds = result['duration_seconds']
    session.charge_cents = result['charge_cents']

    audit_svc.log(user_id, 'TIMER_STOP', 'pool_timer', session.id,
                  before={'end_time': None},
                  after={'end_time': now.isoformat(), 'charge_cents': result['charge_cents']})
    return result['charge_cents']


def _close_linked_waiting_entry(ticket_id: str, user_id: str, terminal_status: str = 'ASSIGNED') -> bool:
    """When a ticket terminates (close/cancel/force-close), drop its linked
    waiting-list entry from the active queue. Looks up by floor_ticket_id or
    assigned_ticket_id and transitions to ASSIGNED (fulfilled) or CANCELLED.
    Returns True if a row was updated. Caller is responsible for committing
    and emitting `waiting:update`.
    """
    wl = (WaitingListEntry.query
          .with_for_update()
          .filter(
              or_(
                  WaitingListEntry.floor_ticket_id == ticket_id,
                  WaitingListEntry.assigned_ticket_id == ticket_id,
              ),
              WaitingListEntry.status.in_(('WAITING', 'SEATED', 'ASSIGNED')),
          )
          .first())
    if not wl:
        return False
    before = {'status': wl.status}
    wl.status = terminal_status
    if terminal_status == 'ASSIGNED' and not wl.assigned_at:
        wl.assigned_at = datetime.now(timezone.utc)
    # Renumber 1..N for whatever's still active
    actives = (WaitingListEntry.query
               .filter(WaitingListEntry.status.in_(('WAITING', 'SEATED')))
               .order_by(WaitingListEntry.created_at)
               .all())
    for i, e in enumerate(actives, start=1):
        e.position = i
    audit_svc.log(user_id, 'WAITLIST_CLEAR_ON_TICKET_END', 'waiting_list', wl.id,
                  before=before,
                  after={'status': terminal_status, 'closed_ticket_id': ticket_id})
    return True


@tickets_bp.route('', methods=['POST'])
@jwt_required()
def open_ticket():
    from app.models.cash_session import CashSession
    user_id = get_jwt_identity()
    data = request.get_json()
    resource_id = data.get('resource_id')

    # Block ticket creation if bar has never been opened today (no open cash session)
    open_session = CashSession.query.filter_by(status='OPEN').first()
    if not open_session:
        return jsonify({'error': 'BAR_CLOSED', 'message': 'Bar is not open. Manager must open the cash session first.'}), 403

    # Lock row and check availability for ALL resource types
    resource = Resource.query.with_for_update().get(resource_id)
    if resource is None:
        return jsonify({'error': 'NOT_FOUND'}), 404
    if resource.status == 'IN_USE':
        return jsonify({'error': 'RESOURCE_OCCUPIED',
                        'message': f'{resource.code} ya está en uso'}), 409

    ticket = Ticket(resource_id=resource_id, opened_by=user_id,
                    customer_name=data.get('customer_name', '').strip() or None)
    db.session.add(ticket)
    db.session.flush()

    # Mark resource as IN_USE for all types
    resource.status = 'IN_USE'

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
            promo_free_seconds=promo_free_seconds
        )
        db.session.add(timer)
        audit_svc.log(user_id, 'TIMER_START', 'pool_timer', ticket.id)

    # If ticket is linked to a waiting list entry, mark it assigned (always removes from list)
    wl_entry_id = data.get('waiting_list_entry_id')
    if wl_entry_id:
        wl_entry = WaitingListEntry.query.filter(
            WaitingListEntry.id == wl_entry_id,
            WaitingListEntry.status.in_(['WAITING', 'SEATED'])
        ).first()
        if wl_entry:
            wl_entry.status = 'ASSIGNED'
            wl_entry.assigned_at = datetime.now(timezone.utc)
            wl_entry.assigned_resource_id = resource_id
            wl_entry.assigned_ticket_id = ticket.id
            audit_svc.log(user_id, 'WAITLIST_ASSIGN', 'waiting_list', wl_entry.id,
                          after={'resource_id': resource_id, 'ticket_id': ticket.id})
            socketio.emit('waiting_list:update', {}, room='floor')

    audit_svc.log(user_id, 'TICKET_OPEN', 'ticket', ticket.id, after={'resource_id': resource_id})
    db.session.commit()
    _emit_floor_update()
    return jsonify(ticket.to_dict()), 201


@tickets_bp.route('/<ticket_id>', methods=['GET'])
@jwt_required()
def get_ticket(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    return jsonify(ticket.to_dict())


@tickets_bp.route('/<ticket_id>/customer-name', methods=['PATCH'])
@jwt_required()
def set_customer_name(ticket_id):
    user_id = get_jwt_identity()
    ticket = Ticket.query.get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED'}), 403
    data = request.get_json()
    old_name = ticket.customer_name
    ticket.customer_name = (data.get('customer_name') or '').strip() or None
    audit_svc.log(user_id, 'CUSTOMER_NAME_SET', 'ticket', ticket.id,
                  before={'customer_name': old_name},
                  after={'customer_name': ticket.customer_name})
    db.session.commit()
    _emit_floor_update()
    return jsonify(ticket.to_dict())


@tickets_bp.route('', methods=['GET'])
@jwt_required()
def list_tickets():
    q = Ticket.query
    status = request.args.get('status')
    resource_id = request.args.get('resource_id')
    if status: q = q.filter_by(status=status)
    if resource_id: q = q.filter_by(resource_id=resource_id)
    tickets = q.order_by(Ticket.opened_at.desc()).limit(100).all()
    return jsonify([t.to_dict(include_items=False, include_timer=False) for t in tickets])


@tickets_bp.route('/<ticket_id>/items', methods=['POST'])
@jwt_required()
def add_item(ticket_id):
    user_id = get_jwt_identity()
    client_version = request.headers.get('X-Ticket-Version', type=int)

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)

    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED', 'message': 'Cannot modify a closed ticket'}), 403

    if client_version is not None and ticket.version != client_version:
        return jsonify({'error': 'VERSION_CONFLICT'}), 409

    data = request.get_json()
    menu_item = MenuItem.query.get_or_404(data['menu_item_id'])

    # Validate mandatory flavor
    if menu_item.requires_flavor:
        modifier_ids = [m.get('modifier_id') for m in data.get('modifiers', [])]
        flavor_groups = [mg for mg in menu_item.modifier_groups if mg.is_mandatory]
        for fg in flavor_groups:
            fg_modifier_ids = [m.id for m in fg.modifiers.all()]
            if not any(mid in fg_modifier_ids for mid in modifier_ids):
                return jsonify({
                    'error': 'FLAVOR_REQUIRED',
                    'message': f'{menu_item.name} requires a flavor selection from "{fg.name}"'
                }), 422

    # Validate inventory availability
    quantity = data.get('quantity', 1)
    shortages = inventory_svc.check_stock_for_item(menu_item, data.get('modifiers', []), quantity)
    if shortages:
        items_str = ', '.join(f"{s['name']} (disponible: {s['available']}, necesario: {s['needed']})" for s in shortages)
        return jsonify({
            'error': 'OUT_OF_STOCK',
            'message': f'Sin inventario suficiente: {items_str}',
            'shortages': shortages
        }), 422

    line_item = TicketLineItem(
        ticket_id=ticket_id,
        menu_item_id=menu_item.id,
        item_name=menu_item.name,
        quantity=data.get('quantity', 1),
        unit_price_cents=menu_item.price_cents,
        routing_dest=menu_item.category.routing,
        notes=data.get('notes'),
        status='SENT',
        sent_at=datetime.now(timezone.utc),
    )
    db.session.add(line_item)
    db.session.flush()

    for mod_data in data.get('modifiers', []):
        from app.models.menu import Modifier
        mod = Modifier.query.get(mod_data['modifier_id'])
        if mod:
            lim = LineItemModifier(
                line_item_id=line_item.id,
                modifier_id=mod.id,
                name_snapshot=mod.name,
                price_cents=mod.price_cents
            )
            db.session.add(lim)

    db.session.flush()
    inventory_svc.consume_for_line_item(line_item, user_id)
    promotion_svc.apply_promos_to_line_item(line_item, ticket)
    ticket.recalculate_totals()
    ticket.version += 1

    audit_svc.log(user_id, 'ITEM_ADD', 'line_item', line_item.id,
                  after=line_item.to_dict())
    db.session.commit()

    # Immediately notify the correct queue
    if line_item.routing_dest == 'BAR':
        socketio.emit('bar:update', {}, room='bar')
    else:
        socketio.emit('kitchen:update', {}, room='kitchen')
    socketio.emit('ticket:updated', {'ticket_id': ticket_id, 'version': ticket.version}, room=f'ticket:{ticket_id}')
    return jsonify(line_item.to_dict()), 201


@tickets_bp.route('/<ticket_id>/items/<item_id>', methods=['DELETE'])
@jwt_required()
def void_item(ticket_id, item_id):
    """Void a line item. Requires manager_id in body (from PIN verification)."""
    user_id = get_jwt_identity()
    data = request.get_json() or {}
    manager_id = data.get('manager_id')
    reason = data.get('reason', '')

    if not manager_id:
        return jsonify({'error': 'MANAGER_REQUIRED', 'message': 'Manager PIN required to void items'}), 403

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED'}), 403

    item = TicketLineItem.query.get_or_404(item_id)
    if item.ticket_id != ticket_id:
        return jsonify({'error': 'NOT_FOUND'}), 404

    before = item.to_dict()

    # Reverse inventory if item was sent
    if item.status not in ('STAGED',):
        inventory_svc.reverse_for_line_item(item, manager_id)

    item.status = 'VOIDED'
    item.voided_at = datetime.now(timezone.utc)
    item.voided_by = manager_id
    item.void_reason = reason

    ticket.recalculate_totals()
    ticket.version += 1

    audit_svc.log(manager_id, 'ITEM_VOID', 'line_item', item_id,
                  before=before, after={'status': 'VOIDED', 'reason': reason})
    db.session.commit()

    socketio.emit('ticket:updated', {'ticket_id': ticket_id}, room=f'ticket:{ticket_id}')
    return jsonify({'message': 'Item voided'})


@tickets_bp.route('/<ticket_id>/send-order', methods=['POST'])
@jwt_required()
def send_order(ticket_id):
    user_id = get_jwt_identity()
    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)

    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED'}), 403

    now = datetime.now(timezone.utc)
    staged = ticket.line_items.filter_by(status='STAGED').all()

    if not staged:
        return jsonify({'error': 'NO_STAGED_ITEMS', 'message': 'No staged items to send'}), 400

    for item in staged:
        item.status = 'SENT'
        item.sent_at = now
        inventory_svc.consume_for_line_item(item, user_id)
        audit_svc.log(user_id, 'ITEM_SENT', 'line_item', item.id, after={'status': 'SENT'})

    ticket.version += 1
    db.session.commit()

    # Emit to kitchen/bar queues
    socketio.emit('kitchen:update', {}, room='kitchen')
    socketio.emit('bar:update', {}, room='bar')
    socketio.emit('ticket:updated', {'ticket_id': ticket_id}, room=f'ticket:{ticket_id}')

    return jsonify({'message': f'{len(staged)} items sent'})


@tickets_bp.route('/<ticket_id>/transfer', methods=['POST'])
@jwt_required()
def transfer_ticket(ticket_id):
    user_id = get_jwt_identity()
    data = request.get_json()
    target_resource_id = data.get('target_resource_id')

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED'}), 403

    old_resource = (Resource.query.with_for_update().get(ticket.resource_id)
                    if ticket.resource_id else None)
    new_resource = Resource.query.with_for_update().get_or_404(target_resource_id)

    # Check target availability for pool tables
    if new_resource.type == 'POOL_TABLE' and new_resource.status == 'IN_USE':
        return jsonify({'error': 'POOL_TABLE_OCCUPIED',
                        'message': f'{new_resource.code} is already in use'}), 409

    # Stop timer if leaving pool table — flush so recalculate_totals sees the charge
    if old_resource and old_resource.type == 'POOL_TABLE':
        _stop_active_timer(ticket, user_id)
        db.session.flush()
    # Free old resource for all types
    if old_resource:
        old_resource.status = 'AVAILABLE'
        # Auto-remove temp tables when ticket transfers away
        if old_resource.is_temp:
            old_resource.is_active = False

    # Start timer if moving to pool table
    if new_resource.type == 'POOL_TABLE':
        cfg = PoolTableConfig.query.get(target_resource_id)
        billing_mode = cfg.billing_mode if cfg else Config.BILLING_MODE
        rate_cents = cfg.rate_cents if cfg else Config.POOL_RATE_CENTS
        promo_free_seconds = (cfg.promo_free_minutes * 60) if cfg else 0

        timer = PoolTimerSession(
            ticket_id=ticket.id,
            resource_id=target_resource_id,
            billing_mode=billing_mode,
            rate_cents=rate_cents,
            promo_free_seconds=promo_free_seconds
        )
        db.session.add(timer)
        audit_svc.log(user_id, 'TIMER_START', 'pool_timer', ticket.id)

    # Mark new resource IN_USE for all types
    new_resource.status = 'IN_USE'

    before_resource = old_resource.code if old_resource else None
    ticket.resource_id = target_resource_id
    # Once reassigned to a table, it's no longer a "pending" reopened tab
    ticket.was_reopened = False
    ticket.recalculate_totals()
    ticket.version += 1

    # Keep any linked waiting-list entry in sync with the ticket's new home.
    # Without this, a SEATED party whose floor ticket is transferred via this
    # endpoint disappears from the floor view and a follow-up /transfer-to-pool
    # on the stale entry can spawn a duplicate PoolTimerSession.
    wl_entry = (WaitingListEntry.query
                .with_for_update()
                .filter(
                    or_(
                        WaitingListEntry.floor_ticket_id == ticket.id,
                        WaitingListEntry.assigned_ticket_id == ticket.id,
                    ),
                    WaitingListEntry.status.in_(('WAITING', 'SEATED', 'ASSIGNED')),
                )
                .first())
    if wl_entry:
        before_wl = {
            'status': wl_entry.status,
            'floor_resource_id': wl_entry.floor_resource_id,
            'floor_ticket_id': wl_entry.floor_ticket_id,
            'assigned_resource_id': wl_entry.assigned_resource_id,
            'assigned_ticket_id': wl_entry.assigned_ticket_id,
        }
        if new_resource.type == 'POOL_TABLE':
            wl_entry.status = 'ASSIGNED'
            wl_entry.assigned_at = wl_entry.assigned_at or datetime.now(timezone.utc)
            wl_entry.assigned_resource_id = target_resource_id
            wl_entry.assigned_ticket_id = ticket.id
        else:
            # Still on a floor/bar resource — keep them seated, follow the ticket.
            wl_entry.status = 'SEATED'
            wl_entry.floor_resource_id = target_resource_id
            wl_entry.floor_ticket_id = ticket.id
        audit_svc.log(user_id, 'WAITLIST_SYNC_ON_TRANSFER', 'waiting_list', wl_entry.id,
                      before=before_wl,
                      after={
                          'status': wl_entry.status,
                          'floor_resource_id': wl_entry.floor_resource_id,
                          'floor_ticket_id': wl_entry.floor_ticket_id,
                          'assigned_resource_id': wl_entry.assigned_resource_id,
                          'assigned_ticket_id': wl_entry.assigned_ticket_id,
                      })

    audit_svc.log(user_id, 'TRANSFER', 'ticket', ticket.id,
                  before={'resource': before_resource},
                  after={'resource': new_resource.code})
    db.session.commit()
    _emit_floor_update()
    socketio.emit('waiting:update', {}, room='floor')
    return jsonify(ticket.to_dict())


@tickets_bp.route('/<ticket_id>/close', methods=['POST'])
@jwt_required()
def close_ticket(ticket_id):
    user_id = get_jwt_identity()
    data = request.get_json()
    payment_type = data.get('payment_type')        # CASH or CARD (primary)
    tendered_cents = data.get('tendered_cents')
    tip_cents = data.get('tip_cents', 0) or 0
    tip_source = data.get('tip_source')             # CASH, CARD, SPLIT
    tip_cash_cents = data.get('tip_cash_cents')      # explicit split amounts
    tip_card_cents = data.get('tip_card_cents')
    payment_type_2 = data.get('payment_type_2')    # optional second payment
    tendered_cents_2 = data.get('tendered_cents_2')

    if payment_type not in ('CASH', 'CARD'):
        return jsonify({'error': 'INVALID_PAYMENT_TYPE'}), 422
    if payment_type_2 and payment_type_2 not in ('CASH', 'CARD'):
        return jsonify({'error': 'INVALID_PAYMENT_TYPE_2'}), 422

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_NOT_OPEN'}), 409

    # Stop any running timer — flush so recalculate_totals sees the charge
    _stop_active_timer(ticket, user_id)
    db.session.flush()

    # Free the resource (all types)
    if ticket.resource_id:
        resource = Resource.query.get(ticket.resource_id)
        if resource:
            resource.status = 'AVAILABLE'
            # Auto-remove temp tables when their ticket is closed
            if resource.is_temp:
                resource.is_active = False

    ticket.recalculate_totals()
    ticket.payment_type = payment_type
    ticket.tendered_cents = tendered_cents
    ticket.tip_cents = tip_cents
    ticket.tip_source = tip_source or ('SPLIT' if payment_type_2 else payment_type)
    ticket.tip_cash_cents = tip_cash_cents
    ticket.tip_card_cents = tip_card_cents
    ticket.payment_type_2 = payment_type_2 or None
    ticket.tendered_cents_2 = tendered_cents_2 or None
    ticket.status = 'CLOSED'
    ticket.closed_by = user_id
    ticket.closed_at = datetime.now(timezone.utc)
    ticket.payment_requested = False
    ticket.version += 1

    # Change: total tendered across all methods minus bill+tip
    total_tendered = (tendered_cents or 0) + (tendered_cents_2 or 0)
    change_due = max(0, total_tendered - ticket.total_cents - tip_cents) if total_tendered else 0

    # Freeze cost snapshot on each non-voided line item.
    # One query: sum(ingredient.qty × ii.cost_cents) per menu_item_id.
    active_items = ticket.line_items.filter(TicketLineItem.status != 'VOIDED').all()
    menu_ids = [li.menu_item_id for li in active_items if li.menu_item_id]
    if menu_ids:
        from sqlalchemy import text as _text
        recipe_rows = db.session.execute(
            _text("""
                SELECT mii.menu_item_id,
                       SUM(mii.quantity * ii.cost_cents) AS unit_cost_cents
                FROM menu_item_ingredients mii
                JOIN inventory_items ii ON ii.id = mii.inventory_item_id
                WHERE mii.menu_item_id IN :ids
                GROUP BY mii.menu_item_id
            """),
            {'ids': tuple(menu_ids)}
        ).mappings().all()
        recipe_cost = {r['menu_item_id']: int(r['unit_cost_cents']) for r in recipe_rows}
        for li in active_items:
            if li.menu_item_id and li.menu_item_id in recipe_cost:
                li.cost_snapshot_cents = li.quantity * recipe_cost[li.menu_item_id]

    wl_changed = _close_linked_waiting_entry(ticket.id, user_id, terminal_status='ASSIGNED')

    audit_svc.log(user_id, 'TICKET_CLOSE', 'ticket', ticket.id,
                  after={'total_cents': ticket.total_cents, 'tip_cents': tip_cents,
                         'payment_type': payment_type, 'payment_type_2': payment_type_2})
    db.session.commit()
    _emit_floor_update()
    if wl_changed:
        socketio.emit('waiting:update', {}, room='floor')

    result = ticket.to_dict()
    result['change_due'] = change_due
    return jsonify(result)


@tickets_bp.route('/<ticket_id>/timer/<session_id>', methods=['PATCH'])
@jwt_required()
def edit_timer(ticket_id, session_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    data = request.get_json()

    session = PoolTimerSession.query.get_or_404(session_id)
    if session.ticket_id != ticket_id:
        return jsonify({'error': 'NOT_FOUND'}), 404

    before = session.to_dict()
    if 'start_time' in data:
        session.start_time = datetime.fromisoformat(data['start_time'])
    if 'end_time' in data and data['end_time']:
        session.end_time = datetime.fromisoformat(data['end_time'])

    if session.end_time:
        result = billing.calculate_charge(
            session.start_time, session.end_time,
            session.billing_mode, session.rate_cents,
            session.promo_free_seconds
        )
        session.duration_seconds = result['duration_seconds']
        session.charge_cents = result['charge_cents']

    session.is_manual_edit = True
    session.manual_edit_reason = data.get('reason', '')

    ticket = Ticket.query.get(ticket_id)
    if ticket:
        ticket.recalculate_totals()
        ticket.version += 1

    audit_svc.log(user_id, 'TIMER_MANUAL_EDIT', 'pool_timer', session_id,
                  before=before, after=session.to_dict(), reason=data.get('reason'))
    db.session.commit()
    return jsonify(session.to_dict())


@tickets_bp.route('/<ticket_id>/discount', methods=['PATCH'])
@jwt_required()
def set_discount(ticket_id):
    """Manager-only: apply a manual % discount to the whole ticket."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    data = request.get_json()
    pct = data.get('pct', 0)
    if not isinstance(pct, (int, float)) or pct < 0 or pct > 100:
        return jsonify({'error': 'pct must be 0–100'}), 422

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_NOT_OPEN'}), 409

    before_pct = ticket.manual_discount_pct or 0
    ticket.manual_discount_pct = int(pct)
    ticket.recalculate_totals()
    ticket.version += 1

    audit_svc.log(user_id, 'DISCOUNT_APPLIED', 'ticket', ticket_id,
                  before={'manual_discount_pct': before_pct},
                  after={'manual_discount_pct': int(pct)},
                  reason=data.get('reason', ''))
    db.session.commit()
    _emit_floor_update()
    return jsonify(ticket.to_dict())


@tickets_bp.route('/<ticket_id>/cancel', methods=['POST'])
@jwt_required()
def cancel_ticket(ticket_id):
    """Cancel an empty ticket (no items, no pool time) — frees the table immediately."""
    user_id = get_jwt_identity()
    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)

    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_NOT_OPEN'}), 409

    # Guard: must have zero non-voided items
    active_items = ticket.line_items.filter(
        TicketLineItem.status != 'VOIDED'
    ).count()
    if active_items > 0:
        return jsonify({'error': 'HAS_ITEMS', 'message': 'Ticket still has active items'}), 422

    # Guard: must have no pool time sessions
    if ticket.timer_sessions.count() > 0:
        return jsonify({'error': 'HAS_POOL_TIME', 'message': 'Ticket has pool time recorded'}), 422

    # Free the resource. Floating tables auto-deactivate on terminate, same as close_ticket.
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

    wl_changed = _close_linked_waiting_entry(ticket_id, user_id, terminal_status='CANCELLED')

    audit_svc.log(user_id, 'TICKET_CANCEL', 'ticket', ticket_id,
                  after={'reason': 'Opened by mistake — no items, no pool time'})
    db.session.commit()
    _emit_floor_update()
    if wl_changed:
        socketio.emit('waiting:update', {}, room='floor')
    return jsonify({'ok': True, 'message': 'Ticket cancelled and table freed'})



_EDITABLE_PAYMENT_FIELDS = {
    'payment_type', 'tendered_cents', 'tip_cents', 'tip_source',
    'tip_cash_cents', 'tip_card_cents', 'payment_type_2', 'tendered_cents_2',
}


@tickets_bp.route('/<ticket_id>/edit-payment', methods=['POST'])
@jwt_required()
def edit_payment(ticket_id):
    """Edit payment fields on a CLOSED ticket. Manager/admin only, PIN-gated.
    Logs every change to audit_log; sets edited_after_close=True. Does NOT
    allow editing of items, total_cents, discounts, or pool time — those
    require the full reopen flow because they affect kitchen / inventory /
    invariants on the bill total."""
    from app.api.auth import verify_manager_pin
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    data = request.get_json() or {}
    pin = data.get('pin', '')
    reason = (data.get('reason') or '').strip()

    if not reason:
        return jsonify({'error': 'REASON_REQUIRED',
                        'message': 'Razón requerida para editar un ticket cerrado.'}), 422

    manager = verify_manager_pin(pin)
    if not manager:
        audit_svc.log(user_id, 'TICKET_EDIT_PAYMENT_BAD_PIN', 'ticket', ticket_id,
                      ip_address=request.remote_addr)
        db.session.commit()
        return jsonify({'error': 'INVALID_PIN', 'message': 'PIN incorrecto'}), 401

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'CLOSED':
        return jsonify({'error': 'TICKET_NOT_CLOSED',
                        'message': 'Sólo tickets cerrados pueden editarse con esta vía. Usa "Reabrir" para tickets abiertos.'}), 409

    before = {}
    after = {}
    for field in _EDITABLE_PAYMENT_FIELDS:
        if field not in data:
            continue
        new_val = data[field]
        old_val = getattr(ticket, field)
        if old_val == new_val:
            continue
        # Field-specific validation
        if field == 'payment_type' and new_val not in ('CASH', 'CARD'):
            return jsonify({'error': 'INVALID_PAYMENT_TYPE'}), 422
        if field == 'payment_type_2' and new_val not in (None, '', 'CASH', 'CARD'):
            return jsonify({'error': 'INVALID_PAYMENT_TYPE_2'}), 422
        if field == 'tip_source' and new_val not in (None, '', 'CASH', 'CARD', 'SPLIT'):
            return jsonify({'error': 'INVALID_TIP_SOURCE'}), 422
        # Normalize empty strings to None for nullable fields
        if new_val == '' and field in ('payment_type_2', 'tip_source'):
            new_val = None
        before[field] = old_val
        after[field] = new_val
        setattr(ticket, field, new_val)

    if not after:
        return jsonify({'error': 'NO_CHANGES',
                        'message': 'No se enviaron cambios.'}), 422

    ticket.edited_after_close = True
    ticket.version += 1

    audit_svc.log(user_id, 'TICKET_EDIT_PAYMENT', 'ticket', ticket_id,
                  before=before, after=after,
                  reason=f'Manager PIN ({manager.username}): {reason}',
                  ip_address=request.remote_addr)
    db.session.commit()
    return jsonify(ticket.to_dict())


@tickets_bp.route('/<ticket_id>/edit-history', methods=['GET'])
@jwt_required()
def edit_history(ticket_id):
    """Return chronological list of TICKET_EDIT_PAYMENT entries for this ticket."""
    from app.models.audit import AuditLog
    logs = (AuditLog.query
            .filter(AuditLog.entity_type == 'ticket',
                    AuditLog.entity_id == ticket_id,
                    AuditLog.action == 'TICKET_EDIT_PAYMENT')
            .order_by(AuditLog.created_at.desc())
            .all())
    return jsonify([l.to_dict() for l in logs])


@tickets_bp.route('/<ticket_id>/reopen', methods=['POST'])
@jwt_required()
def reopen_ticket(ticket_id):
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status == 'OPEN':
        return jsonify({'error': 'ALREADY_OPEN'}), 409

    before = {'status': ticket.status}
    ticket.status = 'OPEN'
    ticket.was_reopened = True
    ticket.reopened_at = datetime.now(timezone.utc)
    ticket.reopened_by = user_id
    ticket.closed_at = None
    ticket.closed_by = None
    ticket.payment_type = None
    ticket.tendered_cents = None
    ticket.tip_cents = 0
    ticket.version += 1

    audit_svc.log(user_id, 'TICKET_REOPEN', 'ticket', ticket_id, before=before, after={'status': 'OPEN'})
    db.session.commit()
    _emit_floor_update()
    return jsonify(ticket.to_dict())


@tickets_bp.route('/reopened', methods=['GET'])
@jwt_required()
def list_reopened_tickets():
    """Return all OPEN tickets that were previously closed and re-opened."""
    tickets = Ticket.query.filter_by(status='OPEN', was_reopened=True).order_by(Ticket.reopened_at.desc()).all()
    return jsonify([t.to_dict() for t in tickets])


@tickets_bp.route('/pending-payment', methods=['GET'])
@jwt_required()
def list_pending_payment():
    """Return all OPEN tickets where the check has been requested (cuenta solicitada)."""
    tickets = Ticket.query.filter_by(status='OPEN', payment_requested=True)\
        .order_by(Ticket.payment_requested_at.desc()).all()
    return jsonify([t.to_dict() for t in tickets])


@tickets_bp.route('/<ticket_id>/request-payment', methods=['POST'])
@jwt_required()
def request_payment(ticket_id):
    """Mark ticket as cuenta solicitada. If on a pool table, stops the timer and frees the table."""
    user_id = get_jwt_identity()
    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_NOT_OPEN'}), 409

    # Stop active pool timer and free the table if applicable
    if ticket.resource_id:
        resource = Resource.query.get(ticket.resource_id)
        if resource and resource.type == 'POOL_TABLE':
            active_session = PoolTimerSession.query.filter_by(
                ticket_id=ticket.id, end_time=None
            ).first()
            if active_session:
                now = datetime.now(timezone.utc)
                active_session.end_time = now
                cfg = PoolTableConfig.query.get(resource.id)
                mode = cfg.billing_mode if cfg else 'PER_MINUTE'
                rate = cfg.rate_cents if cfg else 8600
                result = billing.calculate_charge(active_session.start_time, now, mode, rate)
                active_session.duration_seconds = result['duration_seconds']
                active_session.charge_cents = result['charge_cents']
                audit_svc.log(user_id, 'TIMER_STOP', 'timer_session', active_session.id,
                               after={'duration_seconds': result['duration_seconds'],
                                      'charge_cents': result['charge_cents'],
                                      'reason': 'Pedir cuenta'})
            # Free the pool table
            resource.status = 'AVAILABLE'
            resource.timer_start = None
            ticket.recalculate_totals()

    ticket.payment_requested = True
    ticket.payment_requested_at = datetime.now(timezone.utc)
    audit_svc.log(user_id, 'PAYMENT_REQUESTED', 'ticket', ticket_id)
    db.session.commit()
    _emit_floor_update()
    return jsonify({'ok': True, 'total_cents': ticket.total_cents})


@tickets_bp.route('/<ticket_id>/clear-payment-request', methods=['POST'])
@jwt_required()
def clear_payment_request(ticket_id):
    """Clear the cuenta solicitada flag (e.g. customer is still ordering)."""
    user_id = get_jwt_identity()
    ticket = Ticket.query.get_or_404(ticket_id)
    ticket.payment_requested = False
    audit_svc.log(user_id, 'PAYMENT_REQUEST_CLEARED', 'ticket', ticket_id)
    db.session.commit()
    _emit_floor_update()
    return jsonify({'ok': True})


@tickets_bp.route('/open-all', methods=['GET'])
@jwt_required()
def list_all_open_tickets():
    """Manager: list every OPEN ticket so ghost/stuck tabs can be identified and force-closed."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    tickets = Ticket.query.filter_by(status='OPEN').order_by(Ticket.opened_at).all()
    result = []
    for t in tickets:
        resource = Resource.query.get(t.resource_id) if t.resource_id else None
        result.append({
            'id': t.id,
            'resource_code': resource.code if resource else None,
            'resource_status': resource.status if resource else None,
            'customer_name': t.customer_name,
            'opened_at': t.opened_at.isoformat() if t.opened_at else None,
            'item_count': sum(1 for i in t.line_items if i.status != 'VOIDED'),
            'total_cents': t.total_cents or 0,
        })
    return jsonify(result)


@tickets_bp.route('/<ticket_id>/force-close', methods=['POST'])
@jwt_required()
def force_close_ticket(ticket_id):
    """Manager/Admin: force-close a ghost/stuck ticket with a reason. Frees resource, stops timers."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    data = request.get_json() or {}
    reason = (data.get('reason') or '').strip()
    if not reason:
        return jsonify({'error': 'reason required'}), 422

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_NOT_OPEN'}), 409

    # Stop any running timer
    _stop_active_timer(ticket, user_id)
    db.session.flush()

    # Free the resource
    if ticket.resource_id:
        resource = Resource.query.get(ticket.resource_id)
        if resource:
            resource.status = 'AVAILABLE'
            if resource.is_temp:
                resource.is_active = False

    ticket.recalculate_totals()
    ticket.status = 'CLOSED'
    ticket.closed_by = user_id
    ticket.closed_at = datetime.now(timezone.utc)
    ticket.payment_type = 'CASH'   # neutral placeholder
    ticket.version += 1

    wl_changed = _close_linked_waiting_entry(ticket.id, user_id, terminal_status='ASSIGNED')

    audit_svc.log(user_id, 'TICKET_FORCE_CLOSE', 'ticket', ticket.id,
                  before={'status': 'OPEN'},
                  after={'status': 'CLOSED', 'reason': reason})
    db.session.commit()
    _emit_floor_update()
    if wl_changed:
        socketio.emit('waiting:update', {}, room='floor')
    return jsonify({'ok': True, 'ticket_id': ticket.id})


@tickets_bp.route('/clean-ghosts', methods=['POST'])
@jwt_required()
def clean_ghost_tickets():
    """Manager: auto-close all OPEN tickets whose resource is already AVAILABLE (true ghosts)."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    data = request.get_json() or {}
    reason = (data.get('reason') or 'Auto-limpieza de cuentas fantasma').strip()

    ghosts = (Ticket.query
              .join(Resource, Resource.id == Ticket.resource_id)
              .filter(
                  Ticket.status == 'OPEN',
                  Resource.status == 'AVAILABLE',
                  Ticket.payment_requested.is_(False),
              )
              .with_for_update()
              .all())

    closed_ids = []
    wl_any_changed = False
    for ticket in ghosts:
        _stop_active_timer(ticket, user_id)
        db.session.flush()
        ticket.recalculate_totals()
        ticket.status = 'CLOSED'
        ticket.closed_by = user_id
        ticket.closed_at = datetime.now(timezone.utc)
        ticket.payment_type = 'CASH'
        ticket.version += 1
        if _close_linked_waiting_entry(ticket.id, user_id, terminal_status='ASSIGNED'):
            wl_any_changed = True
        audit_svc.log(user_id, 'TICKET_FORCE_CLOSE', 'ticket', ticket.id,
                      before={'status': 'OPEN'},
                      after={'status': 'CLOSED', 'reason': reason, 'auto_ghost_clean': True})
        closed_ids.append(ticket.id)

    db.session.commit()
    _emit_floor_update()
    if wl_any_changed:
        socketio.emit('waiting:update', {}, room='floor')
    return jsonify({'ok': True, 'cleaned': len(closed_ids), 'ticket_ids': closed_ids})


@tickets_bp.route('/<ticket_id>/print', methods=['POST'])
@jwt_required()
def print_ticket(ticket_id):
    """Send ticket receipt to the Windows USB thermal printer via the print agent."""
    ticket = Ticket.query.get_or_404(ticket_id)
    unpaid = request.args.get('unpaid', 'false').lower() == 'true'

    payload = ticket.to_dict()
    payload['unpaid'] = unpaid

    try:
        body = json.dumps(payload).encode('utf-8')
        req = Request(
            f'{PRINT_AGENT_URL}/print',
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urlopen(req, timeout=8) as resp:
            if resp.status == 200:
                return jsonify({'ok': True})
            return jsonify({'ok': False, 'error': resp.read().decode()}), 502
    except URLError as e:
        return jsonify({'ok': False, 'error': 'Print agent not running. Start it on the Windows host.'}), 503
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500
