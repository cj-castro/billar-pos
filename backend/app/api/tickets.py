import os
import re
import json
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from app.extensions import db, socketio, limiter
from app.models.resource import Resource, PoolTableConfig
from app.models.ticket import (
    Ticket, TicketLineItem, LineItemModifier, LineItemPromotion,
    PoolTimerSession
)
from app.models.print_job import PrintJob
from app.models.menu import MenuItem
from app.models.inventory import InventoryItem, SaleItemCost
from app.models.promotion import Promotion, TicketPromoDecision
from app.models.waiting_list import WaitingListEntry
from app.services import audit_svc, billing, inventory_svc, promotion_svc, settings_svc
from app.config import Config

PRINT_AGENT_URL = os.environ.get('PRINT_AGENT_URL', 'http://host.docker.internal:9191')

tickets_bp = Blueprint('tickets', __name__)


def _emit_floor_update():
    socketio.emit('floor:update', {}, room='floor')


class _MoneyError(ValueError):
    """Raised by _money() when a monetary field fails validation."""


def _money(value, field: str, *, allow_none: bool = True) -> int | None:
    """Validate a monetary field arriving from the client.

    Money is stored as integer cents everywhere in this schema. Accepting a
    bare JSON value meant a string reached an Integer column and blew up at
    commit time, and a negative tip flowed straight into the cash-session
    reconciliation (tip_payout is subtracted from expected_cash), producing a
    phantom drawer shortfall that nobody could trace back to a ticket.

    bool is rejected explicitly because bool is a subclass of int in Python,
    so `True` would otherwise be accepted and stored as 1 cent.
    """
    if value is None or value == '':
        if allow_none:
            return None
        raise _MoneyError(f'{field} is required')
    if isinstance(value, bool) or not isinstance(value, int):
        raise _MoneyError(f'{field} must be an integer number of cents')
    if value < 0:
        raise _MoneyError(f'{field} cannot be negative')
    if value > 100_000_000:  # $1,000,000.00 — far beyond any real bar ticket
        raise _MoneyError(f'{field} is implausibly large')
    return value


def _spawn_auto_print_chit(app, item_id: str, chit_payload: dict) -> None:
    """Fire-and-forget: print a kitchen/bar chit when an order is placed.
    Runs in an eventlet greenlet via socketio.start_background_task — safe with
    eventlet workers. Print failure NEVER blocks or fails the order."""

    def _run() -> None:
        with app.app_context():
            from app.models.ticket import TicketLineItem
            from app.models.print_job import PrintJob
            from app.extensions import db as _db, socketio as _sio
            import requests as _req

            item = TicketLineItem.query.get(item_id)
            if not item:
                return

            job = PrintJob(queue_item_id=item_id, type='CHIT', status='SENT')
            _db.session.add(job)
            _db.session.commit()

            try:
                r = _req.post(
                    f'{PRINT_AGENT_URL}/chit',
                    json={**chit_payload, 'job_id': job.id},
                    timeout=8,
                )
                if r.ok:
                    job.status = 'PRINTED'
                    job.printed_at = datetime.now(timezone.utc)
                    _db.session.commit()
                else:
                    raise RuntimeError(f'agent {r.status_code}: {r.text[:120]}')
            except Exception as exc:
                try:
                    job.status = 'FAILED'
                    job.error_msg = str(exc)
                    item.needs_reprint = True
                    _db.session.commit()
                    routing = item.routing_dest.lower()
                    _sio.emit(f'{routing}:item_update',
                              {'item_id': item_id, 'needs_reprint': True},
                              room=routing)
                    _sio.emit('print:failed', {
                        'job_id':        job.id,
                        'queue_item_id': item_id,
                        'type':          'CHIT',
                        'error':         str(exc),
                    }, room='manager')
                except Exception:
                    pass  # never raise from background greenlet

    # Use socketio.start_background_task (eventlet-safe greenlet) instead of
    # threading.Thread, which is incompatible with eventlet's cooperative scheduler.
    socketio.start_background_task(_run)


def _required_total_cents(*, total_cents: int, tip_cents: int,
                          timer_charge: int,
                          expected_total_cents: int | None) -> int:
    """Minimum tender that may close a ticket, in integer cents.

    Normally this is simply the final total plus the tip. When the close
    stopped a running timer the bill kept growing between the moment the UI
    quoted a total and the moment the timer was stopped server-side, so the
    quoted total (expected_total_cents) is the fair bar instead. It is clamped
    to [total before the timer stopped, final total] so a stale or forged quote
    can never authorize paying less than the ticket was already worth.
    """
    if not timer_charge:
        return total_cents + tip_cents
    pre_timer_total = max(0, total_cents - timer_charge)
    quoted = pre_timer_total if expected_total_cents is None else expected_total_cents
    return min(max(quoted, pre_timer_total), total_cents) + tip_cents


def _stop_active_timer(ticket: Ticket, user_id: str) -> int:
    """Stop any running timer session, compute charge, return charge_cents."""
    session = PoolTimerSession.query.filter_by(
        ticket_id=ticket.id, end_time=None
    ).first()
    if not session:
        return 0

    now = datetime.now(timezone.utc)
    session.end_time = now
    session.status = 'COMPLETED'
    result = billing.calculate_charge(
        session.start_time, now,
        session.billing_mode, session.rate_cents,
        session.effective_free_seconds(now)
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
    # Only touch entries that are still active. Including 'ASSIGNED' here
    # caused historical entries to be rewritten (e.g. cancel of a follow-up
    # ticket flipped ASSIGNED→CANCELLED on a fulfilled party). Once an entry
    # reaches a terminal state it must be immutable.
    wl = (WaitingListEntry.query
          .with_for_update()
          .filter(
              or_(
                  WaitingListEntry.floor_ticket_id == ticket_id,
                  WaitingListEntry.assigned_ticket_id == ticket_id,
              ),
              WaitingListEntry.status.in_(('WAITING', 'SEATED')),
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
    ticket_type = data.get('ticket_type', 'TABLE')  # TABLE, EXPRESS, DELIVERY
    rappi_order_id = (data.get('rappi_order_id') or '').strip() or None

    if ticket_type not in ('TABLE', 'EXPRESS', 'DELIVERY'):
        return jsonify({'error': 'INVALID_TICKET_TYPE'}), 422
    if ticket_type == 'DELIVERY' and not rappi_order_id:
        return jsonify({'error': 'RAPPI_ID_REQUIRED', 'message': 'Rappi order ID is required for delivery tickets'}), 422

    # Block ticket creation if bar has never been opened today (no open cash session)
    open_session = CashSession.query.filter_by(status='OPEN').first()
    if not open_session:
        return jsonify({'error': 'BAR_CLOSED', 'message': 'Bar is not open. Manager must open the cash session first.'}), 403

    # EXPRESS and DELIVERY tickets: no resource required
    if ticket_type in ('EXPRESS', 'DELIVERY'):
        ticket = Ticket(
            resource_id=None,
            ticket_type=ticket_type,
            rappi_order_id=rappi_order_id,
            opened_by=user_id,
            customer_name=data.get('customer_name', '').strip() or None,
        )
        db.session.add(ticket)
        audit_svc.log(user_id, 'TICKET_OPEN', 'ticket', ticket.id,
                      after={'ticket_type': ticket_type, 'rappi_order_id': rappi_order_id})
        db.session.commit()
        return jsonify(ticket.to_dict()), 201

    # Lock row and check availability for ALL resource types
    resource = Resource.query.with_for_update().get(resource_id)
    if resource is None:
        return jsonify({'error': 'NOT_FOUND'}), 404
    if resource.status == 'IN_USE':
        return jsonify({'error': 'RESOURCE_OCCUPIED',
                        'message': f'{resource.code} ya está en uso'}), 409

    ticket = Ticket(resource_id=resource_id, ticket_type='TABLE', opened_by=user_id,
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
            promo_free_seconds=promo_free_seconds,
            status='ACTIVE',
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
    d = ticket.to_dict()
    # Promotions that qualify right now but need the waiter to confirm them.
    if ticket.status == 'OPEN':
        try:
            d['available_promotions'] = promotion_svc.preview_pending_quantity_promos(ticket)
        except Exception:
            d['available_promotions'] = []
    else:
        d['available_promotions'] = []
    return jsonify(d)


@tickets_bp.route('/<ticket_id>/promotions/<promotion_id>', methods=['POST'])
@jwt_required()
def decide_promotion(ticket_id, promotion_id):
    """Accept or decline a promotion that requires confirmation.

    ACCEPTED makes the engine apply it from now on; DECLINED suppresses it for
    this ticket without prompting again. The decision can be changed later, so
    a waiter who declines by mistake can still apply the promotion.
    """
    user_id = get_jwt_identity()
    data = request.get_json() or {}
    decision = (data.get('decision') or '').upper()
    if decision not in ('ACCEPTED', 'DECLINED'):
        return jsonify({'error': 'INVALID_DECISION',
                        'message': 'decision must be ACCEPTED or DECLINED'}), 422

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED'}), 403

    promo = Promotion.query.get(promotion_id)
    if promo is None or not promo.is_active:
        return jsonify({'error': 'PROMO_NOT_FOUND'}), 404
    if not promo.requires_confirmation:
        return jsonify({'error': 'PROMO_NOT_CONFIRMABLE',
                        'message': 'This promotion applies automatically'}), 409

    row = TicketPromoDecision.query.filter_by(
        ticket_id=ticket_id, promotion_id=promotion_id).first()
    if row is None:
        row = TicketPromoDecision(ticket_id=ticket_id, promotion_id=promotion_id)
        db.session.add(row)
    row.decision = decision
    row.decided_by = user_id
    row.decided_at = datetime.now(timezone.utc)
    db.session.flush()

    from app.models.promotion import QUANTITY_PROMO_TYPES
    # POOL_TIME_FREE_MINUTES grants seconds, not a discount: the decision row
    # itself is the grant, so there is nothing to write to line items here.
    if (decision == 'ACCEPTED' and promo.promo_type not in QUANTITY_PROMO_TYPES
            and promo.promo_type != 'POOL_TIME_FREE_MINUTES'):
        promotion_svc.apply_confirmable_item_promo(promo, ticket)
    promotion_svc.recompute_quantity_promos(ticket)
    ticket.recalculate_totals()
    ticket.version += 1

    audit_svc.log(user_id, 'PROMO_DECISION', 'ticket', ticket_id,
                  after={'promotion_id': promotion_id, 'name': promo.name,
                         'decision': decision, 'discount_cents': ticket.discount_cents})
    db.session.commit()

    socketio.emit('ticket:updated', {'ticket_id': ticket_id}, room=f'ticket:{ticket_id}')
    _emit_floor_update()

    d = ticket.to_dict()
    d['available_promotions'] = promotion_svc.preview_pending_quantity_promos(ticket)
    return jsonify(d)


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

    # Optional idempotency key (mobile retries). Same (ticket, key) => same line.
    idem_key = request.headers.get('Idempotency-Key')
    if idem_key is not None and not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', idem_key):
        return jsonify({'error': 'INVALID_IDEMPOTENCY_KEY',
                        'message': 'Idempotency-Key must be 1-64 chars of [A-Za-z0-9_-]'}), 422

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)

    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED', 'message': 'Cannot modify a closed ticket'}), 403

    # Replay: checked BEFORE the version check, because the first attempt
    # bumped the version. No side effects on this path.
    if idem_key:
        existing = TicketLineItem.query.filter_by(
            ticket_id=ticket_id, client_request_id=idem_key).first()
        if existing:
            return jsonify({**existing.to_dict(), 'ticket_version': ticket.version}), 200

    if client_version is not None and ticket.version != client_version:
        return jsonify({'error': 'VERSION_CONFLICT'}), 409

    data = request.get_json(silent=True) or {}
    if not data.get('menu_item_id'):
        return jsonify({'error': 'VALIDATION',
                        'message': 'menu_item_id is required'}), 422
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

    # Validate quantity BEFORE it reaches the stock engine or the bill.
    # Without this a negative quantity inverted both sides of the sale: the
    # line's gross went negative (silently crediting the customer) and
    # consume_for_line_item deducted a negative amount, i.e. it *created*
    # stock out of nothing. Mirrors the bounds enforced by update_item_quantity.
    quantity = data.get('quantity', 1)
    if quantity is None:
        quantity = 1
    if not isinstance(quantity, int) or isinstance(quantity, bool):
        return jsonify({'error': 'INVALID_QUANTITY',
                        'message': 'La cantidad debe ser un número entero.'}), 422
    if quantity < 1 or quantity > 99:
        return jsonify({'error': 'INVALID_QUANTITY',
                        'message': 'La cantidad debe estar entre 1 y 99.'}), 422

    # performed_by is what enables auto-conversion: when the loose item is short
    # but a full pack or bottle is on the shelf, fn_ensure_available opens one
    # and writes the CONVERSION_OUT/IN pair against this user. Without it the
    # sale is refused with stock physically present.
    shortages = inventory_svc.check_stock_for_item(
        menu_item, data.get('modifiers', []), quantity, performed_by=user_id
    )
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
        quantity=quantity,
        unit_price_cents=menu_item.price_cents,
        routing_dest=menu_item.category.routing,
        notes=data.get('notes'),
        status='SENT',
        sent_at=datetime.now(timezone.utc),
        client_request_id=idem_key or None,
    )
    db.session.add(line_item)
    try:
        db.session.flush()
    except IntegrityError:
        # Lost a race on the (ticket_id, client_request_id) unique index.
        db.session.rollback()
        existing = TicketLineItem.query.filter_by(
            ticket_id=ticket_id, client_request_id=idem_key).first()
        if existing is None:
            raise
        return jsonify({**existing.to_dict(),
                        'ticket_version': Ticket.query.get(ticket_id).version}), 200

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
    promotion_svc.recompute_quantity_promos(ticket)
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

# Auto-print chit to kitchen/bar printer (non-blocking — runs in background)
# BAR chits were hardcoded off here; the print_bar_tickets setting now owns
# that decision (default False, so behaviour is unchanged until a manager
# opts in). KITCHEN is never gated.
    if settings_svc.should_print(line_item.routing_dest):
        mod_map: dict[str, int] = {}
        _mod_mult = max(1, int(line_item.quantity or 1))
        for lim in line_item.modifiers:
            n = lim.name_snapshot or '?'
            mod_map[n] = mod_map.get(n, 0) + _mod_mult
        _spawn_auto_print_chit(
            current_app._get_current_object(),
            line_item.id,
            {
                'type':          line_item.routing_dest,
                'resource_code': ticket.resource.code if ticket.resource else '?',
                'items': [{
                    'quantity':  line_item.quantity,
                    'name':      menu_item.name,
                    'modifiers': [{'name': k, 'count': v} for k, v in mod_map.items()],
                    'notes':     line_item.notes or '',
                }],
                'sent_at': datetime.now(timezone.utc).isoformat(),
            }
        )
    else:
        # Validation log – confirms the bar print skip is working
        current_app.logger.info(
            f'BAR CHIT SKIPPED (no print): item={line_item.id} name={menu_item.name} ticket={ticket_id}'
        )
    return jsonify({**line_item.to_dict(), 'ticket_version': ticket.version}), 201

    # # Auto-print chit to kitchen/bar printer (non-blocking — runs in background)
    # # Modifier rows are stored once per line item, so scale them by the line
    # # quantity: 2x a bucket carrying 10 beer modifiers must be prepared as 20.
    # mod_map: dict[str, int] = {}
    # _mod_mult = max(1, int(line_item.quantity or 1))
    # for lim in line_item.modifiers:
    #     n = lim.name_snapshot or '?'
    #     mod_map[n] = mod_map.get(n, 0) + _mod_mult
    # _spawn_auto_print_chit(
    #     current_app._get_current_object(),
    #     line_item.id,
    #     {
    #         'type':          line_item.routing_dest,
    #         'resource_code': ticket.resource.code if ticket.resource else '?',
    #         'items': [{
    #             'quantity':  line_item.quantity,
    #             'name':      menu_item.name,
    #             'modifiers': [{'name': k, 'count': v} for k, v in mod_map.items()],
    #             'notes':     line_item.notes or '',
    #         }],
    #         'sent_at': datetime.now(timezone.utc).isoformat(),
    #     }
    # )
    # return jsonify(line_item.to_dict()), 201


@tickets_bp.route('/<ticket_id>/items/<item_id>', methods=['DELETE'])
@jwt_required()
def void_item(ticket_id, item_id):
    """Void a line item. Requires a manager PIN, verified server-side.

    HOTFIX: this previously trusted a 'manager_id' string from the request body
    with no PIN check, no existence check and no role check, then wrote it to
    item.voided_by and used it as performed_by for the inventory reversal. Any
    caller could void a line item and attribute it to a colleague.
    """
    user_id = get_jwt_identity()
    data = request.get_json() or {}
    reason = data.get('reason', '')

    if 'manager_id' in data:
        return jsonify({
            'error': 'DEPRECATED_PARAMETER',
            'message': "manager_id is no longer accepted; send 'pin' instead.",
        }), 422

    pin = (data.get('pin') or '').strip()
    if not pin:
        return jsonify({'error': 'MANAGER_REQUIRED',
                        'message': 'Manager PIN required to void items'}), 403

    from app.api.auth import verify_manager_pin
    manager = verify_manager_pin(pin)
    if manager is None:
        audit_svc.log(user_id, 'MANAGER_PIN_FAILED', 'line_item', item_id,
                      ip_address=request.remote_addr)
        db.session.commit()
        return jsonify({'error': 'INVALID_PIN', 'message': 'Invalid manager PIN'}), 401
    manager_id = manager.id

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED'}), 403

    item = TicketLineItem.query.get_or_404(item_id)
    if item.ticket_id != ticket_id:
        return jsonify({'error': 'NOT_FOUND'}), 404

    # Idempotency guard. Without this, a double-click / retry / duplicate
    # request re-ran reverse_for_line_item against the SAME SaleItemCost rows,
    # restoring the ingredients a second time and inventing stock that was
    # never returned. Voiding is terminal: say so instead of re-reversing.
    if item.status == 'VOIDED':
        return jsonify({
            'error': 'ALREADY_VOIDED',
            'message': 'Este artículo ya fue anulado.',
            'item_id': item.id,
        }), 409

    before = item.to_dict()

    # Reverse inventory if item was sent
    if item.status not in ('STAGED',):
        inventory_svc.reverse_for_line_item(item, manager_id)

    item.status = 'VOIDED'
    item.voided_at = datetime.now(timezone.utc)
    item.voided_by = manager_id
    item.void_reason = reason

    # Drop this line's promotion rows. recalculate_totals already ignores
    # promos on voided items, but leaving the rows behind would still show a
    # discount on the line and skew any query that reads the table directly.
    LineItemPromotion.query.filter_by(line_item_id=item.id).delete(
        synchronize_session=False)

    db.session.flush()
    promotion_svc.recompute_quantity_promos(ticket)
    ticket.recalculate_totals()
    ticket.version += 1

    audit_svc.log(user_id, 'ITEM_VOID', 'line_item', item_id,
                  before=before,
                  after={'status': 'VOIDED', 'reason': reason, 'approved_by': manager_id},
                  ip_address=request.remote_addr)
    db.session.commit()

    socketio.emit('ticket:updated', {'ticket_id': ticket_id}, room=f'ticket:{ticket_id}')
    return jsonify({'message': 'Item voided'})


@tickets_bp.route('/<ticket_id>/items/<item_id>', methods=['PATCH'])
@jwt_required()
def update_item_quantity(ticket_id, item_id):
    """Change the quantity of an existing line item.

    Inventory is re-synced by reversing the original deduction and consuming
    again at the new quantity, so ingredient stock and the COGS rows in
    sale_item_costs always reflect what was actually served. Quantity promos
    are recomputed afterwards, so bumping a bucket from 1 to 2 makes a 2x1
    fire without the waiter adding a second line.

    Lowering the quantity gives product back and therefore needs a manager PIN,
    exactly like voiding. Raising it does not.
    """
    user_id = get_jwt_identity()
    data = request.get_json() or {}
    new_qty = data.get('quantity')

    if not isinstance(new_qty, int) or isinstance(new_qty, bool):
        return jsonify({'error': 'INVALID_QUANTITY',
                        'message': 'quantity must be an integer'}), 422
    if new_qty < 1 or new_qty > 99:
        return jsonify({'error': 'INVALID_QUANTITY',
                        'message': 'quantity must be between 1 and 99'}), 422

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_CLOSED'}), 403

    item = TicketLineItem.query.get_or_404(item_id)
    if item.ticket_id != ticket_id:
        return jsonify({'error': 'NOT_FOUND'}), 404
    if item.status == 'VOIDED':
        return jsonify({'error': 'ITEM_VOIDED',
                        'message': 'Cannot change the quantity of a voided item'}), 409

    old_qty = int(item.quantity or 1)
    if new_qty == old_qty:
        return jsonify(item.to_dict())

    # ── Manager authorization for value-reducing changes ──────────────────────
    # HOTFIX: this previously accepted any 'manager_id' string from the request
    # body without verifying a PIN, that the id belonged to a real user, or that
    # the user held MANAGER/ADMIN role -- and then wrote it to performed_by. A
    # caller could reduce a quantity with no PIN and have the action attributed
    # to a colleague. The PIN is now verified server-side and performed_by comes
    # only from the verified manager. Superseded by the grant framework in 028.
    if 'manager_id' in data:
        return jsonify({
            'error': 'DEPRECATED_PARAMETER',
            'message': "manager_id is no longer accepted; send 'pin' instead.",
        }), 422

    performed_by = user_id
    approved_by = None          # set whenever a PIN was actually verified, even
                                # if the approver is the requester (self-approval)
    if new_qty < old_qty:
        pin = (data.get('pin') or '').strip()
        if not pin:
            return jsonify({'error': 'MANAGER_REQUIRED',
                            'message': 'Manager PIN required to reduce quantities'}), 403

        from app.api.auth import verify_manager_pin
        manager = verify_manager_pin(pin)
        if manager is None:
            audit_svc.log(user_id, 'MANAGER_PIN_FAILED', 'line_item', item_id,
                          ip_address=request.remote_addr)
            db.session.commit()
            return jsonify({'error': 'INVALID_PIN',
                            'message': 'Invalid manager PIN'}), 401
        performed_by = manager.id
        approved_by = manager.id

    before = item.to_dict()

    try:
        # Re-sync inventory: undo the original deduction, drop its COGS rows so
        # they cannot be double counted at close, then deduct at the new qty.
        if item.status != 'STAGED':
            inventory_svc.reverse_for_line_item(item, performed_by)
            SaleItemCost.query.filter_by(ticket_line_item_id=item.id).delete(
                synchronize_session=False)
            db.session.flush()

        item.quantity = new_qty
        if new_qty > old_qty:
            item.needs_reprint = True
        db.session.flush()

        if item.status != 'STAGED':
            inventory_svc.consume_for_line_item(item, performed_by)
    except ValueError as e:
        db.session.rollback()
        msg = str(e)
        if msg.startswith('OUT_OF_STOCK:'):
            return jsonify({'error': 'OUT_OF_STOCK', 'message': msg}), 422
        return jsonify({'error': 'INVENTORY_ERROR', 'message': msg}), 422

    # Re-evaluate this line's per-item promos at the NEW quantity. HAPPY_HOUR /
    # ITEM_DISCOUNT discounts are computed as unit_price * quantity, so the row
    # written for the old quantity is now wrong: dropping 5 units to 1 left a
    # discount sized for 5, which could exceed the line's own value and hand the
    # product away for free. recompute_quantity_promos only rebuilds BOGO /
    # QTY_PERCENT rows, so these have to be refreshed explicitly.
    LineItemPromotion.query.filter_by(line_item_id=item.id).delete(
        synchronize_session=False)
    db.session.flush()
    # Anchor the re-evaluation to when the line was ORDERED, not to now:
    # HAPPY_HOUR windows are time-of-day gated, so re-evaluating at wall-clock
    # time would silently strip a discount the ticket already earned when the
    # qty is corrected after the window closes (and would invent one for a line
    # ordered before it opened). This matches PromoUnit.ordered_at, which
    # exists for exactly this reason. STAGED lines have no sent_at yet, so they
    # are still priced at now.
    promo_at = item.sent_at or datetime.now(timezone.utc)
    if promo_at.tzinfo is None:
        promo_at = promo_at.replace(tzinfo=timezone.utc)
    promotion_svc.apply_promos_to_line_item(item, ticket, now=promo_at)
    db.session.flush()

    promotion_svc.recompute_quantity_promos(ticket)
    ticket.recalculate_totals()
    ticket.version += 1

    # actor = who made the request; approved_by = the verified manager (None when
    # raising quantity, which needs no authorization). Keeping them distinct is
    # what makes the trail non-repudiable -- see 028's requested_by/authorized_by.
    audit_svc.log(user_id, 'ITEM_QTY_CHANGE', 'line_item', item_id,
                  before=before,
                  after={'quantity': new_qty, 'approved_by': approved_by},
                  ip_address=request.remote_addr)
    db.session.commit()

    socketio.emit('ticket:updated', {'ticket_id': ticket_id}, room=f'ticket:{ticket_id}')
    if item.routing_dest == 'BAR':
        socketio.emit('bar:update', {}, room='bar')
    else:
        socketio.emit('kitchen:update', {}, room='kitchen')
    _emit_floor_update()

    return jsonify(item.to_dict())


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
    # here is where the ticket to thebar is send
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

    # Reject if target is already occupied (any resource type — pool, regular,
    # or bar seat). Previously only POOL_TABLE was checked, allowing a transfer
    # onto an occupied floor table to silently create two OPEN tickets sharing
    # the same resource_id. The floor view then showed only the newest one.
    if new_resource.status == 'IN_USE':
        return jsonify({'error': 'RESOURCE_OCCUPIED',
                        'message': f'{new_resource.code} ya está en uso'}), 409

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
    data = request.get_json() or {}
    payment_type = data.get('payment_type')        # CASH or CARD (primary)
    tip_source = data.get('tip_source')             # CASH, CARD, SPLIT
    payment_type_2 = data.get('payment_type_2')    # optional second payment

    if payment_type not in ('CASH', 'CARD', 'EXTERNAL'):
        return jsonify({'error': 'INVALID_PAYMENT_TYPE'}), 422
    if payment_type_2 and payment_type_2 not in ('CASH', 'CARD'):
        return jsonify({'error': 'INVALID_PAYMENT_TYPE_2'}), 422
    if tip_source and tip_source not in ('CASH', 'CARD', 'SPLIT'):
        return jsonify({'error': 'INVALID_TIP_SOURCE'}), 422
    # Mobile sends Idempotency-Key; its presence also opts in to the stricter
    # AMOUNT_MISMATCH contract. The web never sends it, so it is unaffected.
    close_key = (request.headers.get('Idempotency-Key') or '').strip()[:64] or None

    # Every monetary field is validated before it can reach an Integer column
    # or the cash-session reconciliation.
    try:
        tendered_cents   = _money(data.get('tendered_cents'), 'tendered_cents')
        tendered_cents_2 = _money(data.get('tendered_cents_2'), 'tendered_cents_2')
        tip_cents        = _money(data.get('tip_cents'), 'tip_cents') or 0
        tip_cash_cents   = _money(data.get('tip_cash_cents'), 'tip_cash_cents')
        tip_card_cents   = _money(data.get('tip_card_cents'), 'tip_card_cents')
        # What the client was shown as the total when it quoted the tender.
        expected_total_cents = _money(data.get('expected_total_cents'),
                                      'expected_total_cents')
    except _MoneyError as exc:
        return jsonify({'error': 'INVALID_AMOUNT', 'message': str(exc)}), 422

    # A SPLIT tip must account for exactly the tip that was taken, otherwise
    # _build_summary splits it across cash/card using numbers that don't add up.
    if tip_cash_cents is not None or tip_card_cents is not None:
        if (tip_cash_cents or 0) + (tip_card_cents or 0) != tip_cents:
            return jsonify({
                'error': 'TIP_SPLIT_MISMATCH',
                'message': ('La propina en efectivo y en tarjeta debe sumar '
                            'exactamente el total de la propina.'),
            }), 422
    if (close_key and tip_source == 'SPLIT' and tip_cents
            and (tip_cash_cents or 0) + (tip_card_cents or 0) != tip_cents):
        return jsonify({'error': 'AMOUNT_MISMATCH',
                        'message': 'SPLIT tip parts must sum to tip_cents',
                        'tip_cents': tip_cents}), 422
    if payment_type_2 and tendered_cents_2 is None:
        return jsonify({
            'error': 'TENDERED_2_REQUIRED',
            'message': 'tendered_cents_2 is required when a second payment method is used',
        }), 422

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)

    # EXTERNAL is only valid for DELIVERY tickets
    if payment_type == 'EXTERNAL' and ticket.ticket_type != 'DELIVERY':
        return jsonify({'error': 'EXTERNAL_PAYMENT_DELIVERY_ONLY'}), 422
    if ticket.status == 'CLOSED':
        # Mobile retry after network timeout — ticket was already closed successfully.
        if close_key and ticket.close_request_id != close_key:
            return jsonify({'error': 'TICKET_NOT_OPEN', 'status': 'CLOSED'}), 409
        result = ticket.to_dict()
        if close_key:
            paid = (ticket.tendered_cents or 0) + (ticket.tendered_cents_2 or 0)
            has_cash = 'CASH' in (ticket.payment_type, ticket.payment_type_2)
            result['change_due'] = (max(0, paid - (ticket.total_cents + (ticket.tip_cents or 0)))
                                    if has_cash and paid else 0)
        return jsonify(result), 200
    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_NOT_OPEN'}), 409

    if (close_key and get_jwt().get('role') == 'WAITER'
            and not settings_svc.get_bool('waiter_can_close_ticket', True)):
        from datetime import timedelta
        from app.api.auth import verify_manager_pin
        from app.models.audit import AuditLog
        pin = (data.get('manager_pin') or '').strip()
        # ponytail: DB-backed per-user lockout (works across workers); 5 bad PINs / 10 min.
        if pin and AuditLog.query.filter(
                AuditLog.user_id == user_id, AuditLog.action == 'MANAGER_PIN_FAILED',
                AuditLog.created_at > datetime.now(timezone.utc) - timedelta(minutes=10)
        ).count() >= 5:
            db.session.rollback()
            return jsonify({'error': 'PIN_LOCKED'}), 429
        if verify_manager_pin(pin) is None:
            if pin:
                audit_svc.log(user_id, 'MANAGER_PIN_FAILED', 'ticket', ticket.id,
                              ip_address=request.remote_addr)
                db.session.commit()
            return jsonify({'error': 'PIN_REQUIRED'}), 403

    # Stop any running timer — flush so recalculate_totals sees the charge
    timer_charge = _stop_active_timer(ticket, user_id)
    db.session.flush()

    promotion_svc.recompute_quantity_promos(ticket)
    ticket.recalculate_totals()

    # The bill is only final once totals are recalculated, so underpayment is
    # checked here. The check applies ONLY when the client actually supplied a
    # tendered amount: the UI omits tendered_cents for CARD (the terminal
    # settles the exact amount) and for EXTERNAL/Rappi, and blocking those
    # would make every card sale uncloseable.
    tendered_supplied = tendered_cents is not None or tendered_cents_2 is not None
    total_tendered = (tendered_cents or 0) + (tendered_cents_2 or 0)
    amount_owed = ticket.total_cents + tip_cents

    # A pool charge keeps accruing (~2.4c/s at the default rate) between the
    # moment the UI quotes a total and the moment we stop the timer here, so an
    # exact-amount tender is legitimately a few cents short by the time it
    # lands. Enforcing against the post-stop total would 422 every exact-amount
    # close on a timed table, with no field the waiter can raise. When this
    # close stopped a timer we therefore enforce against the total the client
    # was shown (expected_total_cents), clamped so it can never be used to
    # underpay below what the ticket was already worth before the timer stopped
    # nor above the real total. The residual accrual is settled as a shortfall
    # in change, not a dead-end rejection.
    required_total = _required_total_cents(
        total_cents=ticket.total_cents, tip_cents=tip_cents,
        timer_charge=timer_charge, expected_total_cents=expected_total_cents)

    if (payment_type != 'EXTERNAL' and tendered_supplied
            and total_tendered < required_total):
        db.session.rollback()
        return jsonify({
            'error': 'AMOUNT_MISMATCH' if close_key else 'INSUFFICIENT_PAYMENT',
            'expected_total_cents': amount_owed,
            'message': (f'El monto recibido (${total_tendered / 100:.2f}) es menor al total '
                        f'a pagar (${amount_owed / 100:.2f}).'),
            'total_cents': ticket.total_cents,
            'tip_cents': tip_cents,
            'tendered_cents': total_tendered,
        }), 422

    # Free the resource (all types)
    if ticket.resource_id:
        resource = Resource.query.get(ticket.resource_id)
        if resource:
            resource.status = 'AVAILABLE'
            # Auto-remove temp tables when their ticket is closed
            if resource.is_temp:
                resource.is_active = False

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
    ticket.close_request_id = close_key

    # Change: total tendered across all methods minus bill+tip
    change_due = max(0, total_tendered - amount_owed) if total_tendered else 0

    # Freeze cost snapshot on each non-voided line item.
    # Primary source: sale_item_costs rows written at SENT time (inventory v2).
    # Fallback for pre-migration tickets: sum recipe cost from insumos_base.
    active_items = ticket.line_items.filter(TicketLineItem.status != 'VOIDED').all()
    menu_ids = [li.menu_item_id for li in active_items if li.menu_item_id]
    if menu_ids:
        from sqlalchemy import text as _text

        # v2: sum COGS already captured in sale_item_costs at item-send time
        sic_rows = db.session.execute(
            _text("""
                SELECT ticket_line_item_id,
                       SUM(total_cost_cents) AS total_cost_cents
                FROM sale_item_costs
                WHERE ticket_line_item_id IN :ids
                GROUP BY ticket_line_item_id
            """),
            {'ids': tuple(li.id for li in active_items)}
        ).mappings().all()
        sic_by_line = {r['ticket_line_item_id']: int(r['total_cost_cents']) for r in sic_rows}

        # v1 fallback: compute from insumos_base + unit_cost_cents for items
        # that predate the v2 migration (no sale_item_costs rows)
        legacy_menu_ids = [
            li.menu_item_id for li in active_items
            if li.menu_item_id and li.id not in sic_by_line
        ]
        legacy_cost: dict = {}
        if legacy_menu_ids:
            recipe_rows = db.session.execute(
                _text("""
                    SELECT ib.menu_item_id,
                           SUM(ib.quantity * ii.unit_cost_cents) AS unit_cost_cents
                    FROM insumos_base ib
                    JOIN inventory_items ii ON ii.id = ib.inventory_item_id
                    WHERE ib.menu_item_id IN :ids
                    GROUP BY ib.menu_item_id
                """),
                {'ids': tuple(legacy_menu_ids)}
            ).mappings().all()
            legacy_cost = {r['menu_item_id']: int(r['unit_cost_cents']) for r in recipe_rows}

        for li in active_items:
            if li.id in sic_by_line:
                li.cost_snapshot_cents = sic_by_line[li.id]
            elif li.menu_item_id and li.menu_item_id in legacy_cost:
                li.cost_snapshot_cents = li.quantity * legacy_cost[li.menu_item_id]

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
    data = request.get_json() or {}

    session = PoolTimerSession.query.get_or_404(session_id)
    if session.ticket_id != ticket_id:
        return jsonify({'error': 'NOT_FOUND'}), 404

    before = session.to_dict()

    # Timestamps arrive as ISO strings from the manager UI. They must be
    # parsed defensively and forced tz-aware: the columns are TIMESTAMPTZ, so a
    # naive value makes billing.calculate_charge subtract an offset-naive from
    # an offset-aware datetime, raising TypeError and 500-ing mid-transaction.
    def _parse_ts(raw, field):
        try:
            parsed = datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
        except (ValueError, TypeError):
            raise ValueError(f'{field} must be an ISO-8601 datetime')
        if parsed.tzinfo is None:
            # Naive input is interpreted as venue-local time, which is what the
            # manager typed, then normalised to UTC for storage.
            parsed = parsed.replace(tzinfo=ZoneInfo(Config.TZ))
        return parsed.astimezone(timezone.utc)

    try:
        new_start = _parse_ts(data['start_time'], 'start_time') if 'start_time' in data else session.start_time
        new_end = (_parse_ts(data['end_time'], 'end_time')
                   if data.get('end_time') else session.end_time)
    except ValueError as exc:
        return jsonify({'error': 'INVALID_TIMESTAMP', 'message': str(exc)}), 422

    if new_start is None:
        return jsonify({'error': 'INVALID_TIMESTAMP',
                        'message': 'La hora de inicio es obligatoria.'}), 422
    if new_end is not None and new_end <= new_start:
        return jsonify({'error': 'INVALID_TIME_RANGE',
                        'message': 'La hora de fin debe ser posterior a la de inicio.'}), 422

    now = datetime.now(timezone.utc)
    if new_start > now:
        return jsonify({'error': 'INVALID_TIME_RANGE',
                        'message': 'La hora de inicio no puede estar en el futuro.'}), 422
    if new_end is not None and new_end > now:
        return jsonify({'error': 'INVALID_TIME_RANGE',
                        'message': 'La hora de fin no puede estar en el futuro.'}), 422

    session.start_time = new_start
    session.end_time = new_end

    if session.end_time:
        result = billing.calculate_charge(
            session.start_time, session.end_time,
            session.billing_mode, session.rate_cents,
            session.effective_free_seconds(session.end_time)
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


@tickets_bp.route('/<ticket_id>/void-timer', methods=['POST'])
@jwt_required()
def void_timer(ticket_id):
    """Manager-only: cancel a running pool timer with zero charge.
    Use when a table was opened by mistake. Frees the table immediately."""
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403

    user_id = get_jwt_identity()
    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)

    if ticket.status != 'OPEN':
        return jsonify({'error': 'TICKET_NOT_OPEN'}), 409

    # Find the active timer (end_time=None)
    active_session = PoolTimerSession.query.filter_by(
        ticket_id=ticket_id, end_time=None
    ).first()
    if not active_session:
        return jsonify({'error': 'NO_ACTIVE_TIMER', 'message': 'No active timer found for this ticket'}), 404

    now = datetime.now(timezone.utc)
    active_session.end_time = now
    active_session.status = 'CANCELLED'
    active_session.charge_cents = 0
    active_session.duration_seconds = max(0, int((now - active_session.start_time).total_seconds()))
    active_session.cancelled_at = now
    active_session.cancelled_by = user_id

    voided_resource_id = ticket.resource_id

    # Free the resource
    if ticket.resource_id:
        resource = Resource.query.get(ticket.resource_id)
        if resource:
            resource.status = 'AVAILABLE'

    ticket.pool_time_cents = 0
    ticket.recalculate_totals()
    ticket.version += 1

    # Detach ticket from the table so the partial unique index is released.
    # If the ticket has no items (true "opened by mistake"), auto-close it.
    # If it has items, convert to EXPRESS so it can still be served tableless.
    has_items = ticket.line_items.filter(TicketLineItem.status != 'VOIDED').count() > 0
    if has_items:
        ticket.ticket_type = 'EXPRESS'
        ticket.resource_id = None
    else:
        ticket.status = 'CLOSED'
        ticket.payment_type = 'CASH'
        ticket.tendered_cents = 0
        ticket.closed_by = user_id
        ticket.closed_at = now
        ticket.resource_id = None  # must clear BEFORE commit due to check constraint

    audit_svc.log(user_id, 'TIMER_VOID', 'pool_timer', active_session.id,
                  after={'status': 'CANCELLED', 'charge_cents': 0,
                         'resource_id': voided_resource_id,
                         'ticket_closed': not has_items,
                         'reason': 'Opened by mistake'})
    db.session.commit()
    _emit_floor_update()
    socketio.emit('pool:timer_voided', {
        'ticket_id': ticket_id,
        'resource_id': voided_resource_id,
        'session_id': active_session.id,
        'ticket_closed': not has_items,
    })
    return jsonify({'ok': True, 'ticket_closed': not has_items, 'ticket': ticket.to_dict()})


_EDITABLE_PAYMENT_FIELDS = {
    'payment_type', 'tendered_cents', 'tip_cents', 'tip_source',
    'tip_cash_cents', 'tip_card_cents', 'payment_type_2', 'tendered_cents_2',
}


@tickets_bp.route('/<ticket_id>/edit-payment', methods=['POST'])
@jwt_required()
@limiter.limit("5 per minute")
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
        if field == 'payment_type' and new_val not in ('CASH', 'CARD', 'EXTERNAL'):
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
    data = request.get_json(silent=True) or {}
    reason = (data.get('reason') or '').strip()

    ticket = Ticket.query.with_for_update().get_or_404(ticket_id)
    if ticket.status == 'OPEN':
        return jsonify({'error': 'ALREADY_OPEN'}), 409

    # A reopened ticket stops being CLOSED, and _build_summary only counts
    # CLOSED tickets. Reopening one that belongs to an already-reconciled cash
    # session silently rewrites that session's historical sales and tips after
    # the drawer was counted and signed off. Block it; the correct tool for a
    # settled ticket is /edit-payment, which is PIN-gated and fully audited.
    from app.models.cash_session import CashSession
    owning_session = (CashSession.query
                      .filter(CashSession.opened_at <= ticket.opened_at)
                      .order_by(CashSession.opened_at.desc())
                      .first())
    if owning_session is not None and owning_session.status == 'CLOSED':
        return jsonify({
            'error': 'CASH_SESSION_CLOSED',
            'message': ('Este ticket pertenece a un corte de caja ya cerrado. '
                        'Usa "Editar pago" para corregirlo sin alterar el corte.'),
            'cash_session_id': owning_session.id,
        }), 409

    before_payment = {
        'status': ticket.status,
        'payment_type': ticket.payment_type,
        'payment_type_2': ticket.payment_type_2,
        'tendered_cents': ticket.tendered_cents,
        'tendered_cents_2': ticket.tendered_cents_2,
        'tip_cents': ticket.tip_cents,
        'tip_source': ticket.tip_source,
        'tip_cash_cents': ticket.tip_cash_cents,
        'tip_card_cents': ticket.tip_card_cents,
        'total_cents': ticket.total_cents,
        'closed_at': ticket.closed_at.isoformat() if ticket.closed_at else None,
        'closed_by': ticket.closed_by,
    }

    # Re-occupy the resource. Without this, the resource stays AVAILABLE
    # while the ticket goes back to OPEN, which (a) lets a second ticket be
    # opened on the same resource (the older one then disappears from the
    # floor view) and (b) makes the reopened ticket eligible for the
    # ghost-cleanup sweep, which would auto-close it again.
    resource = None
    if ticket.resource_id:
        resource = Resource.query.with_for_update().get(ticket.resource_id)
        if resource is None or not resource.is_active:
            return jsonify({
                'error': 'RESOURCE_UNAVAILABLE',
                'message': 'La mesa original ya no está disponible. Asigna una mesa nueva al reabrir.',
            }), 409
        other_open = Ticket.query.filter(
            Ticket.resource_id == ticket.resource_id,
            Ticket.status == 'OPEN',
            Ticket.id != ticket.id,
        ).first()
        if other_open:
            return jsonify({
                'error': 'RESOURCE_OCCUPIED',
                'message': f'{resource.code} ya tiene un ticket abierto',
                'ticket_id': other_open.id,
            }), 409

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

    if resource is not None:
        resource.status = 'IN_USE'

    # Reopening wipes every payment field. Snapshot them first: _build_summary
    # attributes tickets by opened_at and counts only CLOSED ones, so without
    # this trail there is no way to explain why a session's historical totals
    # changed, or to restore the original tip if the reopen was a mistake.
    audit_svc.log(user_id, 'TICKET_REOPEN', 'ticket', ticket_id,
                  before=before_payment, after={'status': 'OPEN'},
                  reason=reason, ip_address=request.remote_addr)
    db.session.commit()
    _emit_floor_update()
    return jsonify(ticket.to_dict())


@tickets_bp.route('/reopened', methods=['GET'])
@jwt_required()
def list_reopened_tickets():
    """Return all OPEN tickets that were previously closed and re-opened."""
    tickets = Ticket.query.filter_by(status='OPEN', was_reopened=True).order_by(Ticket.reopened_at.desc()).all()
    return jsonify([t.to_dict() for t in tickets])


@tickets_bp.route('/active-express', methods=['GET'])
@jwt_required()
def list_active_express():
    """Return all OPEN EXPRESS and DELIVERY tickets (no table assigned)."""
    tickets = (Ticket.query
               .filter(Ticket.status == 'OPEN',
                       Ticket.ticket_type.in_(['EXPRESS', 'DELIVERY']))
               .order_by(Ticket.opened_at.asc())
               .all())
    return jsonify([t.to_dict(include_items=False, include_timer=False) for t in tickets])


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

    # Stop active pool timer and free the table if applicable.
    # Delegates to _stop_active_timer so promo_free_seconds is always honoured.
    if ticket.resource_id:
        resource = Resource.query.get(ticket.resource_id)
        if resource and resource.type == 'POOL_TABLE':
            _stop_active_timer(ticket, user_id)
            db.session.flush()
            # Free the pool table
            resource.status = 'AVAILABLE'
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

    # A ticket is a true ghost only if its resource is already free, no
    # payment was requested, it wasn't reopened (reopened tabs deliberately
    # stay OPEN even though their resource may have briefly been AVAILABLE
    # before the F-1 fix), and it carries no real work — zero non-voided
    # line items AND zero pool timer sessions. Without these guards a
    # manager pressing "Limpiar fantasmas" right after reopening a tab
    # would silently force-close it with payment_type='CASH' and corrupt
    # the day's revenue.
    has_active_item = (
        db.session.query(TicketLineItem.id)
        .filter(
            TicketLineItem.ticket_id == Ticket.id,
            TicketLineItem.status != 'VOIDED',
        )
        .exists()
    )
    has_timer_session = (
        db.session.query(PoolTimerSession.id)
        .filter(PoolTimerSession.ticket_id == Ticket.id)
        .exists()
    )
    ghosts = (Ticket.query
              .join(Resource, Resource.id == Ticket.resource_id)
              .filter(
                  Ticket.status == 'OPEN',
                  Resource.status == 'AVAILABLE',
                  Ticket.payment_requested.is_(False),
                  Ticket.was_reopened.isnot(True),
                  ~has_active_item,
                  ~has_timer_session,
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
    """Send ticket receipt to the Windows thermal printer via the print agent.
    Accepts optional {job_id} in the JSON body for idempotent retries."""
    ticket  = Ticket.query.get_or_404(ticket_id)
    user_id = get_jwt_identity()
    unpaid  = request.args.get('unpaid', 'false').lower() == 'true'
    data    = request.get_json(silent=True) or {}
    job_id  = data.get('job_id')

    # ── Idempotency: if the frontend retries with the same job_id and it
    #    already succeeded, return success without printing again.
    if job_id:
        existing = PrintJob.query.get(job_id)
        if existing and existing.status == 'PRINTED':
            return jsonify({'ok': True, 'job_id': job_id, 'duplicate': True})

    # Create or reuse job record
    if job_id and existing:
        job = existing
        job.retry_count += 1
        job.status = 'PENDING'
        job.error_msg = None
    else:
        job = PrintJob(ticket_id=ticket_id, type='RECEIPT',
                       requested_by=user_id)
        db.session.add(job)

    job.status = 'SENT'
    db.session.commit()

    payload = ticket.to_dict()
    payload['unpaid'] = unpaid
    payload['job_id'] = job.id

    try:
        body = json.dumps(payload).encode('utf-8')
        req  = Request(f'{PRINT_AGENT_URL}/print', data=body,
                       headers={'Content-Type': 'application/json'}, method='POST')
        with urlopen(req, timeout=8) as resp:
            if resp.status == 200:
                job.status = 'PRINTED'
                job.printed_at = datetime.now(timezone.utc)
                db.session.commit()
                return jsonify({'ok': True, 'job_id': job.id})
            err = resp.read().decode()
            raise RuntimeError(err)
    except HTTPError as http_err:
        # Print agent responded but with an error (e.g., formatting crash)
        try:
            body = http_err.read().decode()
        except Exception:
            body = str(http_err)
        err_msg = f'Print agent error ({http_err.code}): {body}'
    except URLError:
        err_msg = 'Print agent not running. Start it on the Windows host.'
    except Exception as exc:
        err_msg = str(exc)

    job.status = 'FAILED'
    job.error_msg = err_msg
    db.session.commit()

    socketio.emit('print:failed', {
        'job_id':    job.id,
        'ticket_id': ticket_id,
        'type':      job.type,
        'error':     err_msg,
    }, room='manager')

    code = 503 if 'not running' in err_msg else 500
    return jsonify({'ok': False, 'job_id': job.id, 'error': err_msg}), code


@tickets_bp.route('/<ticket_id>/reprint', methods=['POST'])
@jwt_required()
def reprint_ticket(ticket_id):
    """Manager-authorised reprint. Prints with REPRINT flag so the agent adds
    a 'REIMPRESIÓN' header to distinguish from the original receipt.
    Expects {manager_id} already verified by /auth/verify-pin."""
    from app.models.user import User
    ticket     = Ticket.query.get_or_404(ticket_id)
    user_id    = get_jwt_identity()
    data       = request.get_json(silent=True) or {}
    manager_id = data.get('manager_id', '')

    manager = User.query.get(manager_id)
    if not manager or manager.role not in ('MANAGER', 'ADMIN') or not manager.is_active:
        return jsonify({'error': 'UNAUTHORIZED', 'message': 'Manager authorization required'}), 401

    job = PrintJob(ticket_id=ticket_id, type='REPRINT',
                   requested_by=user_id, status='SENT')
    db.session.add(job)
    db.session.commit()

    payload = ticket.to_dict()
    payload['reprint'] = True
    payload['job_id']  = job.id

    try:
        body = json.dumps(payload).encode('utf-8')
        req  = Request(f'{PRINT_AGENT_URL}/print', data=body,
                       headers={'Content-Type': 'application/json'}, method='POST')
        with urlopen(req, timeout=8) as resp:
            if resp.status == 200:
                job.status = 'PRINTED'
                job.printed_at = datetime.now(timezone.utc)
                db.session.commit()
                return jsonify({'ok': True, 'job_id': job.id})
            raise RuntimeError(resp.read().decode())
    except HTTPError as http_err:
        try:
            body = http_err.read().decode()
        except Exception:
            body = str(http_err)
        err_msg = f'Print agent error ({http_err.code}): {body}'
    except URLError:
        err_msg = 'Print agent not running.'
    except Exception as exc:
        err_msg = str(exc)

    job.status = 'FAILED'
    job.error_msg = err_msg
    db.session.commit()

    socketio.emit('print:failed', {
        'job_id':    job.id,
        'ticket_id': ticket_id,
        'type':      'REPRINT',
        'error':     err_msg,
    }, room='manager')

    return jsonify({'ok': False, 'job_id': job.id, 'error': err_msg}), 500
