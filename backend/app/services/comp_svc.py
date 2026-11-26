"""Comps (cortesías) and staff consumption (batch E5).

  Cortesía           a line served FREE to a customer. The line stays on the
                     ticket at $0; list value, reason, who authorized and when
                     are kept, and the original prices go to comp_snapshot so
                     it can be undone before the ticket closes. Stock moves as
                     for any served line; the cost is reported as "costo de
                     cortesías", never as sales margin.

  Consumo de         a ticket of type STAFF for one employee, authorized by a
  personal           manager PIN, routed to kitchen / bar like any order, and
                     closed as STAFF_DONE -- never through payment, so it is
                     never sales and never touches the cash drawer.

Owner settings (Ajustes; 0 / empty = off):
  comps.owner_above_cents     comps worth more than this need the OWNER's PIN
  staff.allowance_cents       an employee's free consumption per business day
                              (at list value); above it the owner's PIN closes it
"""
from datetime import datetime, timezone

from sqlalchemy import text

from app.extensions import db
from app.models.ticket import LineItemPromotion, Ticket, TicketLineItem

COMP_REASONS = ('Cumpleaños', 'Compensación por servicio', 'Cliente frecuente',
                'Promoción del dueño', 'Otro')
STAFF_REASONS = ('Comida de turno', 'Bebida de turno', 'Capacitación / prueba', 'Otro')


def _int_setting(key: str) -> int:
    v = db.session.execute(text("SELECT value FROM settings WHERE key = :k"), {'k': key}).scalar()
    try:
        return max(int(float(v)), 0) if v not in (None, '') else 0
    except (TypeError, ValueError):
        return 0


def line_value_cents(item: TicketLineItem) -> int:
    return int(item.quantity or 1) * int(item.unit_price_cents or 0) + sum(
        int(m.price_cents or 0) for m in item.modifiers)


def _reason(reason: str, allowed: tuple) -> str:
    r = (reason or '').strip()
    if not r:
        raise ValueError('REASON_REQUIRED: elige o escribe el motivo')
    head = r.split(':', 1)[0].strip()
    if head not in allowed:
        raise ValueError(f'BAD_REASON: el motivo debe ser uno de: {", ".join(allowed)}')
    if head == 'Otro' and len(r.split(':', 1)[-1].strip()) < 3:
        raise ValueError('REASON_REQUIRED: con "Otro", escribe el motivo')
    return r


# ── Cortesía ──────────────────────────────────────────────────────────────────

def comp_line(ticket: Ticket, item: TicketLineItem, approver, reason: str) -> dict:
    """Make a line free. approver = the PIN-verified User. Caller commits."""
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: la cuenta ya está cerrada')
    if (ticket.ticket_type or '') == 'STAFF':
        raise ValueError('NOT_FOR_STAFF: el consumo de personal ya es sin cargo')
    if item.status == 'VOIDED':
        raise ValueError('ITEM_VOIDED: ese artículo está anulado')
    if item.comped_at is not None:
        raise ValueError('ALREADY_COMPED: ese artículo ya es cortesía')
    reason = _reason(reason, COMP_REASONS)
    value = line_value_cents(item)
    limit = _int_setting('comps.owner_above_cents')
    if limit and value > limit and approver.role != 'ADMIN':
        raise PermissionError(f'OWNER_REQUIRED: una cortesía de más de ${limit / 100:,.2f} la autoriza el dueño')

    item.comp_snapshot = {'unit_price_cents': int(item.unit_price_cents or 0),
                          'modifiers': {m.id: int(m.price_cents or 0) for m in item.modifiers}}
    item.comp_list_cents = value
    item.comp_reason = reason
    item.comped_by = approver.id
    item.comped_at = datetime.now(timezone.utc)
    item.unit_price_cents = 0
    for m in item.modifiers:
        m.price_cents = 0
    # A free line carries no promotion.
    LineItemPromotion.query.filter_by(line_item_id=item.id).delete(synchronize_session=False)
    return {'list_value_cents': value, 'reason': reason}


def uncomp_line(ticket: Ticket, item: TicketLineItem) -> dict:
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: la cuenta ya está cerrada')
    if item.comped_at is None or not item.comp_snapshot:
        raise ValueError('NOT_COMPED: ese artículo no es cortesía')
    snap = item.comp_snapshot
    item.unit_price_cents = int(snap.get('unit_price_cents') or 0)
    mods = snap.get('modifiers') or {}
    for m in item.modifiers:
        if m.id in mods:
            m.price_cents = int(mods[m.id])
    before = {'reason': item.comp_reason, 'list_value_cents': item.comp_list_cents}
    item.comp_reason = item.comped_by = item.comped_at = item.comp_list_cents = None
    item.comp_snapshot = None
    return before


# ── Consumo de personal ──────────────────────────────────────────────────────

def open_staff_ticket(opened_by: str, employee_id: str, approver, reason: str) -> Ticket:
    from app.models.user import User
    emp = User.query.get(employee_id)
    if emp is None or not emp.is_active:
        raise ValueError('NO_EMPLOYEE: elige a quién es el consumo')
    reason = _reason(reason, STAFF_REASONS)
    t = Ticket(resource_id=None, ticket_type='STAFF', opened_by=opened_by,
               customer_name=f'Personal: {emp.name}', staff_user_id=emp.id,
               staff_reason=reason, staff_authorized_by=approver.id)
    db.session.add(t)
    db.session.flush()
    return t


def staff_allowance_state(ticket: Ticket) -> dict:
    """This employee's free consumption today (business day), with this ticket."""
    allowance = _int_setting('staff.allowance_cents')
    from app.services.venue_svc import business_day_bounds, business_today
    start, end = business_day_bounds(business_today())
    used = db.session.execute(text("""
        SELECT COALESCE(SUM(li.quantity * li.unit_price_cents
                            + COALESCE((SELECT SUM(m.price_cents) FROM line_item_modifiers m
                                         WHERE m.line_item_id = li.id), 0)), 0)
          FROM tickets t JOIN ticket_line_items li ON li.ticket_id = t.id
         WHERE t.ticket_type = 'STAFF' AND t.status = 'STAFF_DONE'
           AND t.staff_user_id = :e AND t.closed_at >= :s AND t.closed_at < :x
           AND li.status <> 'VOIDED'"""), {'e': ticket.staff_user_id, 's': start, 'x': end}).scalar()
    this = sum(line_value_cents(i) for i in ticket.line_items.filter(TicketLineItem.status != 'VOIDED'))
    return {'allowance_cents': allowance, 'used_cents': int(used or 0), 'this_cents': int(this),
            'over': bool(allowance) and int(used or 0) + int(this) > allowance}


def close_staff_ticket(ticket: Ticket, closer_id: str, approver=None) -> dict:
    """Close a staff order. approver (PIN-verified User) is needed only when it
    goes over the daily allowance, and must then be the owner."""
    if (ticket.ticket_type or '') != 'STAFF':
        raise ValueError('NOT_STAFF: esta no es una cuenta de personal')
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: ya está cerrada')
    if ticket.line_items.filter(TicketLineItem.status == 'STAGED').count():
        raise ValueError('UNSENT_ITEMS: envía la orden a cocina / barra antes de cerrarla')
    if not ticket.line_items.filter(TicketLineItem.status != 'VOIDED').count():
        raise ValueError('EMPTY: no hay nada que cerrar; cancélala')
    st = staff_allowance_state(ticket)
    if st['over'] and (approver is None or approver.role != 'ADMIN'):
        raise PermissionError(
            f"OWNER_REQUIRED: pasa el consumo libre del día (${st['allowance_cents'] / 100:,.2f}); "
            f"lo autoriza el dueño")
    ticket.recalculate_totals()
    # List value stays visible on the ticket; nothing is charged.
    ticket.discount_cents = ticket.subtotal_cents
    ticket.total_cents = 0
    ticket.status = 'STAFF_DONE'
    ticket.closed_at = datetime.now(timezone.utc)
    if hasattr(ticket, 'closed_by'):
        ticket.closed_by = closer_id
    return st
