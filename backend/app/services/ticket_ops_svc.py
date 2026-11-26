"""Moving lines between accounts (batch E6) and pool time control (batch E7).

E6 -- "Mover a otra cuenta". ~60 voids were really moves ("cambio de mesa",
"pago por separado", "cambio por cubeta"): a line was voided on one account and
typed again on another. Now a line (or part of its quantity) MOVES. Nothing is
deducted or returned twice: the product already left stock when it was sent,
and its recorded cost (sale_item_costs) moves with it -- split proportionally
when only part of the quantity moves.

E7 -- pool time. A table's time could only stop by closing or transferring the
ticket. Now, on the ticket:
  stop_timer     players stop, the account stays open (they keep drinking)
  start_timer    they play again: a new session on the same table; the free
                 minutes of the table apply once per visit, not per session
  edit_session   correct start / end (with a reason): charge recalculated
"""
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP

from app.extensions import db
from app.models.inventory import SaleItemCost
from app.models.ticket import (LineItemModifier, LineItemPromotion, PoolTimerSession,
                               Ticket, TicketLineItem)

_Q4 = Decimal('0.0001')


def _d(v) -> Decimal:
    return Decimal(str(v or 0))


# ── E6: move lines ────────────────────────────────────────────────────────────

def move_lines(source: Ticket, target: Ticket, moves: list[tuple[TicketLineItem, int]]) -> list[dict]:
    """Move [(line, quantity)] from source to target. Caller recomputes promos /
    totals on both tickets, audits and commits. Returns what moved."""
    if source.id == target.id:
        raise ValueError('SAME_TICKET: elige otra cuenta')
    for t in (source, target):
        if t.status != 'OPEN':
            raise ValueError('TICKET_CLOSED: las dos cuentas deben estar abiertas')
    if 'STAFF' in ((source.ticket_type or ''), (target.ticket_type or '')):
        raise ValueError('STAFF_TICKET: el consumo de personal no se mezcla con cuentas de clientes')
    if not moves:
        raise ValueError('NOTHING: elige qué mover')

    done = []
    for item, qty in moves:
        if item.ticket_id != source.id:
            raise ValueError('NOT_FOUND: ese artículo no es de esta cuenta')
        if item.status == 'VOIDED':
            raise ValueError('ITEM_VOIDED: ese artículo está anulado')
        have = int(item.quantity or 1)
        qty = int(qty or have)
        if qty < 1 or qty > have:
            raise ValueError(f'BAD_QTY: se pueden mover de 1 a {have}')

        LineItemPromotion.query.filter_by(line_item_id=item.id).delete(synchronize_session=False)
        if qty == have:
            item.ticket_id = target.id                      # the whole line moves
            done.append({'line_item_id': item.id, 'name': item.item_name, 'quantity': qty, 'split': False})
            continue

        # Part of the line: a new line on the target, the cost split by share.
        if any(int(m.price_cents or 0) for m in item.modifiers) or item.comped_at is not None:
            raise ValueError('MOVE_WHOLE: esta línea tiene extras con precio o es cortesía; muévela completa')
        new = TicketLineItem(
            ticket_id=target.id, menu_item_id=item.menu_item_id, item_name=item.item_name,
            quantity=qty, unit_price_cents=item.unit_price_cents, status=item.status,
            routing_dest=item.routing_dest, sent_at=item.sent_at, served_at=item.served_at,
            notes=item.notes, sort_order=item.sort_order, cost_snapshot_cents=item.cost_snapshot_cents,
        )
        if hasattr(item, 'kds_sent_quantity') and item.kds_sent_quantity is not None:
            sent = min(int(item.kds_sent_quantity), qty)
            new.kds_sent_quantity = sent
            item.kds_sent_quantity = int(item.kds_sent_quantity) - sent
        db.session.add(new)
        db.session.flush()
        for m in item.modifiers:
            db.session.add(LineItemModifier(line_item_id=new.id, modifier_id=m.modifier_id,
                                            name_snapshot=m.name_snapshot, price_cents=0))
        share = Decimal(qty) / Decimal(have)
        for r in SaleItemCost.query.filter_by(ticket_line_item_id=item.id).all():
            moved = (_d(r.quantity_deducted) * share).quantize(_Q4)
            if moved <= 0:
                continue
            unit = _d(r.unit_cost_cents)
            db.session.add(SaleItemCost(
                ticket_line_item_id=new.id, inventory_item_id=r.inventory_item_id,
                # the movement stays linked to the original row (1:1 by design);
                # the split-off share is the same deduction, already in the ledger
                inventory_movement_id=None, insumos_base_id=r.insumos_base_id,
                quantity_deducted=moved, unit_cost_cents=unit,
                total_cost_cents=int((moved * unit).to_integral_value(rounding=ROUND_HALF_UP))))
            r.quantity_deducted = _d(r.quantity_deducted) - moved
            r.total_cost_cents = int((_d(r.quantity_deducted) * unit).to_integral_value(rounding=ROUND_HALF_UP))
        item.quantity = have - qty
        done.append({'line_item_id': item.id, 'new_line_item_id': new.id, 'name': item.item_name,
                     'quantity': qty, 'split': True})
    db.session.flush()
    return done


# ── E7: pool time ─────────────────────────────────────────────────────────────

def _charge(session: PoolTimerSession, end: datetime) -> dict:
    from app.services import billing
    return billing.calculate_charge(session.start_time, end, session.billing_mode,
                                    session.rate_cents, session.effective_free_seconds(end))


def running_session(ticket: Ticket):
    return PoolTimerSession.query.filter_by(ticket_id=ticket.id, end_time=None).first()


def stop_timer(ticket: Ticket) -> PoolTimerSession:
    """Players stopped; the account stays open on the table."""
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: la cuenta ya está cerrada')
    s = running_session(ticket)
    if s is None:
        raise ValueError('NO_ACTIVE_TIMER: el tiempo no está corriendo')
    now = datetime.now(timezone.utc)
    r = _charge(s, now)
    s.end_time, s.status = now, 'COMPLETED'
    s.duration_seconds, s.charge_cents = r['duration_seconds'], r['charge_cents']
    return s


def start_timer(ticket: Ticket) -> PoolTimerSession:
    """They play again: a new session on the ticket's pool table."""
    from app.config import Config
    from app.models.resource import PoolTableConfig, Resource
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: la cuenta ya está cerrada')
    res = Resource.query.get(ticket.resource_id) if ticket.resource_id else None
    if res is None or res.type != 'POOL_TABLE':
        raise ValueError('NOT_POOL_TABLE: esta cuenta no está en una mesa de billar; usa Transferir a una mesa')
    if running_session(ticket) is not None:
        raise ValueError('ALREADY_RUNNING: el tiempo ya está corriendo')
    cfg = PoolTableConfig.query.get(res.id)
    had_time = PoolTimerSession.query.filter(PoolTimerSession.ticket_id == ticket.id,
                                             PoolTimerSession.status != 'CANCELLED').count() > 0
    s = PoolTimerSession(
        ticket_id=ticket.id, resource_id=res.id,
        billing_mode=cfg.billing_mode if cfg else Config.BILLING_MODE,
        rate_cents=cfg.rate_cents if cfg else Config.POOL_RATE_CENTS,
        # The table's free minutes are once per visit, not per session.
        promo_free_seconds=0 if had_time else ((cfg.promo_free_minutes * 60) if cfg else 0),
        start_time=datetime.now(timezone.utc), status='ACTIVE')
    db.session.add(s)
    res.status = 'IN_USE'
    db.session.flush()
    return s


def edit_session(ticket: Ticket, s: PoolTimerSession, new_start: datetime, new_end, reason: str) -> None:
    """Correct start / end. Validates order, the future, and overlap with the
    ticket's other sessions; recalculates the charge."""
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: la cuenta ya está cerrada')
    if s.status == 'CANCELLED':
        raise ValueError('CANCELLED: ese tiempo se canceló sin cargo; no se edita')
    if not (reason or '').strip():
        raise ValueError('REASON_REQUIRED: escribe por qué se corrige el tiempo')
    now = datetime.now(timezone.utc)
    if new_start > now or (new_end is not None and new_end > now):
        raise ValueError('INVALID_TIME_RANGE: no puede ser en el futuro')
    if new_end is not None and new_end <= new_start:
        raise ValueError('INVALID_TIME_RANGE: el fin debe ser después del inicio')
    if new_end is None and s.end_time is not None:
        raise ValueError('INVALID_TIME_RANGE: un tiempo terminado necesita su hora de fin')
    for o in PoolTimerSession.query.filter(PoolTimerSession.ticket_id == ticket.id,
                                           PoolTimerSession.id != s.id,
                                           PoolTimerSession.status != 'CANCELLED').all():
        o_end = o.end_time or now
        n_end = new_end or now
        if new_start < o_end and o.start_time < n_end:
            raise ValueError('OVERLAP: se encima con otro tiempo de esta cuenta')
    s.start_time, s.end_time = new_start, new_end
    if new_end is not None:
        r = _charge(s, new_end)
        s.duration_seconds, s.charge_cents = r['duration_seconds'], r['charge_cents']
    s.is_manual_edit = True
    s.manual_edit_reason = reason.strip()


def estimate(s: PoolTimerSession) -> int | None:
    """What a running session would charge right now (same rules as the close)."""
    if s.end_time is not None or s.start_time is None:
        return None
    try:
        return int(_charge(s, datetime.now(timezone.utc))['charge_cents'])
    except Exception:          # never break a ticket payload over an estimate
        return None


# ── Free table time without a promotion (055) ────────────────────────────────

def _target_session(ticket: Ticket):
    """The running session, else the last one played (not cancelled)."""
    s = running_session(ticket)
    if s is not None:
        return s
    return (PoolTimerSession.query
            .filter(PoolTimerSession.ticket_id == ticket.id, PoolTimerSession.status != 'CANCELLED')
            .order_by(PoolTimerSession.start_time.desc()).first())


def grant_free_time(ticket: Ticket, approver, minutes: int, reason: str) -> PoolTimerSession:
    """"Una hora gratis": free minutes on the account's pool time, as a cortesía.
    Sets (not adds) the gift on the running / last session; recalculates a
    finished session's charge. Above comps.owner_above_cents (at the table's
    rate) only the owner can give it."""
    from app.services import comp_svc
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: la cuenta ya está cerrada')
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        raise ValueError('BAD_MINUTES: escribe los minutos')
    if minutes < 1 or minutes > 24 * 60:
        raise ValueError('BAD_MINUTES: de 1 minuto a 24 horas')
    s = _target_session(ticket)
    if s is None:
        raise ValueError('NO_POOL_TIME: esta cuenta no tiene tiempo de billar')
    reason = comp_svc._reason(reason, comp_svc.COMP_REASONS)
    value = int(round(minutes * 60 * (s.rate_cents or 0) / 3600))
    limit = comp_svc._int_setting('comps.owner_above_cents')
    if limit and value > limit and approver.role != 'ADMIN':
        raise PermissionError(f'OWNER_REQUIRED: tiempo gratis de más de ${limit / 100:,.2f} lo autoriza el dueño')
    s.manual_free_seconds = minutes * 60
    s.manual_free_reason = reason
    s.manual_free_by = approver.id
    s.manual_free_at = datetime.now(timezone.utc)
    if s.end_time is not None:
        r = _charge(s, s.end_time)
        s.duration_seconds, s.charge_cents = r['duration_seconds'], r['charge_cents']
    return s


def remove_free_time(ticket: Ticket) -> PoolTimerSession:
    if ticket.status != 'OPEN':
        raise ValueError('TICKET_CLOSED: la cuenta ya está cerrada')
    s = (PoolTimerSession.query.filter(PoolTimerSession.ticket_id == ticket.id,
                                       PoolTimerSession.manual_free_seconds > 0)
         .order_by(PoolTimerSession.start_time.desc()).first())
    if s is None:
        raise ValueError('NO_FREE_TIME: no hay tiempo gratis que quitar')
    s.manual_free_seconds, s.manual_free_reason, s.manual_free_by, s.manual_free_at = 0, None, None, None
    if s.end_time is not None:
        r = _charge(s, s.end_time)
        s.duration_seconds, s.charge_cents = r['duration_seconds'], r['charge_cents']
    return s
