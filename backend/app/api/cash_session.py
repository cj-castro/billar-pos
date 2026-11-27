from datetime import date, datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity
from sqlalchemy import text
from app.extensions import db
from app.models.cash_session import CashEnvelope, CashSession, Expense, TipDistributionConfig
from app.models.ticket import Ticket
from app.models.resource import Resource
from app.services import audit_svc, cash_count_svc, cash_handoff_svc
from app.services.cash_count_svc import CountError

cash_bp = Blueprint('cash', __name__)


def _require_manager():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


def _current_session():
    return CashSession.query.filter_by(status='OPEN').order_by(CashSession.opened_at.desc()).first()


def _lock_open_session(session_id):
    """Lock the session row (SELECT ... FOR UPDATE) and re-read it. Returns the
    session if it is still OPEN, else None. A second close that raced the first
    waits here, then sees CLOSED and gets 404 instead of closing it again."""
    s = (CashSession.query.filter_by(id=session_id)
         .with_for_update().populate_existing().first())
    return s if s is not None and s.status == 'OPEN' else None


def _json_body():
    """The JSON object sent, or None when the body is JSON but not an object
    (null, a list...). That used to crash with a 500; now it is a 422, and it
    never closes a drawer with no amount."""
    data = request.get_json()
    return data if isinstance(data, dict) else None


def _bad_body():
    return jsonify({'error': 'VALIDATION', 'message': 'Solicitud inválida'}), 422


def _count_error(err: CountError, field: str):
    body = {'error': err.code, 'message': cash_handoff_svc.message(err), 'field': field}
    if err.key is not None:
        body['key'] = err.key
    return jsonify(body), 422


def _count_required(message: str):
    return jsonify({'error': 'COUNT_REQUIRED', 'message': message}), 422


# ── Blind count (batch C) ──────────────────────────────────────────────────────
# While a drawer is OPEN, a MANAGER does not see sales or expected cash: they
# count, submit the close, and only then see the expected amount and the
# difference. Showing "expected" next to the count box invites counting TO the
# number. Tips, the tip split and expenses stay visible (managers pay tips out
# and record expenses). Sales are owner-only anyway. The owner (ADMIN) always
# sees everything.
# Sales figures are owner-only (policy, Nov 2026): a manager never receives them,
# for an open OR a closed session. While the drawer is open a manager also does
# not get the expected cash / difference (blind count); after the close they do,
# because reconciling the drawer is their job.
_SALES_FIELDS = ('total_sales_cents', 'cash_sales_cents', 'card_sales_cents')
_BLIND_FIELDS = ('expected_cash_cents', 'cash_over_short_cents')
# Cash handoff (count by denomination): what stays in the drawer overnight is
# owner-only, for open AND closed sessions. The next manager counts the drawer
# blind at opening; knowing last night's "queda en caja" would let them count
# TO it. The envelope amount is owner-only too: a manager sees the counted cash
# of a closed session, and counted - envelope = what was left. A manager keeps
# envelope_number (to find the envelope), nothing else.
_OWNER_ONLY_FIELDS = ('opening_variance_cents', 'drawer_left_cents', 'envelope_declared_cents')


def _is_owner() -> bool:
    return get_jwt().get('role') == 'ADMIN'


def _is_blind(session) -> bool:
    return session is not None and session.status == 'OPEN' and not _is_owner()


def _strip_for_viewer(session, data: dict, has_envelope: bool = False) -> dict:
    """The single place that removes what this viewer may not see.

    has_envelope: the session was closed with a count by denomination. Its
    close note is then owner-only too. The server forces a note exactly when
    what stays in the drawer is not the fund, so the note usually says the
    amount ("solo dejé $1,800") -- the figure the next manager must not know.
    The owner keeps the note (it is also on the DRAWER_LEFT count)."""
    if _is_owner():
        return dict(data)
    drop = _SALES_FIELDS + _OWNER_ONLY_FIELDS + (_BLIND_FIELDS if _is_blind(session) else ())
    if has_envelope:
        drop += ('notes',)
    return {k: v for k, v in data.items() if k not in drop}


def _session_for_viewer(session) -> dict:
    """session.to_dict() for this viewer: a manager does not get the close
    note of a session that has an envelope (see _strip_for_viewer)."""
    data = session.to_dict()
    if _is_owner() or session.notes is None:
        return data
    has_envelope = db.session.query(
        CashEnvelope.query.filter_by(session_id=session.id).exists()).scalar()
    return _strip_for_viewer(session, data, has_envelope)


def _for_viewer(session, summary: dict) -> dict:
    return {**_strip_for_viewer(session, summary),
            'conteo_ciego': _is_blind(session), 'ventas_ocultas': not _is_owner()}


def _handoff_fields(sessions) -> dict:
    """{session_id: {opening_variance_cents, drawer_left_cents, envelope_number,
    envelope_declared_cents}} for each session. Values are null when unknown.

    opening_variance_cents = this session's OPENING count - the DRAWER_LEFT of
    the session right before it (by opened_at), if that one is CLOSED. Null
    when either count is missing (legacy open/close, or the first opening
    after the flag went on): null, never 0. Callers pass the result through
    _strip_for_viewer: all but envelope_number are owner-only."""
    sessions = [s for s in sessions if s is not None]
    if not sessions:
        return {}
    ids = [s.id for s in sessions]
    prev = {r.id: r.prev_id for r in db.session.execute(text("""
        SELECT s.id, p.id AS prev_id
        FROM cash_sessions s
        LEFT JOIN LATERAL (
            SELECT c.id, c.status FROM cash_sessions c
            WHERE c.opened_at < s.opened_at ORDER BY c.opened_at DESC LIMIT 1
        ) p ON p.status = 'CLOSED'
        WHERE s.id = ANY(:ids)"""), {'ids': ids})}
    opening = cash_handoff_svc.current_totals(ids, 'OPENING')
    left = cash_handoff_svc.current_totals(set(ids) | {p for p in prev.values() if p}, 'DRAWER_LEFT')
    envs = {e.session_id: e for e in CashEnvelope.query.filter(CashEnvelope.session_id.in_(ids)).all()}
    out = {}
    for sid in ids:
        before = left.get(prev.get(sid))
        env = envs.get(sid)
        out[sid] = {
            'opening_variance_cents': (opening[sid] - before
                                       if sid in opening and before is not None else None),
            'drawer_left_cents': left.get(sid),
            'envelope_number': env.number if env else None,
            'envelope_declared_cents': env.declared_cents if env else None,
        }
    return out


def _summary_for_viewer(session, tip_cfg) -> dict:
    """Session summary + the cash-handoff fields, stripped for this viewer."""
    summary = {**_build_summary(session, tip_cfg), **_handoff_fields([session])[session.id]}
    return _for_viewer(session, summary)


@cash_bp.route('/status', methods=['GET'])
@jwt_required()
def get_status():
    session = _current_session()
    open_tickets = 0
    ghost_tickets = 0
    if session:
        open_tickets = Ticket.query.filter(
            Ticket.status == 'OPEN',
            Ticket.opened_at >= session.opened_at
        ).count()
        # Ghosts: OPEN ticket but its resource is already AVAILABLE
        ghost_tickets = (Ticket.query
                         .join(Resource, Resource.id == Ticket.resource_id)
                         .filter(Ticket.status == 'OPEN',
                                 Resource.status == 'AVAILABLE',
                                 Ticket.opened_at >= session.opened_at)
                         .count())
    return jsonify({
        'open': session is not None,
        'session': _session_for_viewer(session) if session else None,
        'open_tickets_count': open_tickets,
        'ghost_tickets_count': ghost_tickets,
        # Count-by-denomination screen (web + mobile) reads these.
        'denominations': cash_count_svc.denominations(cash_handoff_svc.currency()),
        'fund_target_cents': cash_handoff_svc.fund_target_cents(),
        'count_by_denomination': cash_handoff_svc.count_required(),
    })


@cash_bp.route('/open', methods=['POST'])
@jwt_required()
def open_session():
    err = _require_manager()
    if err: return err
    user_id = get_jwt_identity()

    if _current_session():
        return jsonify({'error': 'SESSION_ALREADY_OPEN'}), 409

    # Body: {count: [{key, qty}]} (count by denomination) or the legacy
    # {opening_fund_cents}. With cash.count_by_denomination on, the legacy body
    # is refused. With it off, a body that has a count is still accepted and
    # the count is recorded (the count wins over opening_fund_cents).
    data = _json_body()
    if data is None:
        return _bad_body()
    has_count = data.get('count') is not None
    if not has_count and cash_handoff_svc.count_required():
        return _count_required(cash_handoff_svc.COUNT_REQUIRED_OPEN)
    lines = None
    if has_count:
        try:
            lines = cash_handoff_svc.parse(data['count'], cash_handoff_svc.currency())
        except CountError as e:
            return _count_error(e, 'count')

    session = CashSession(
        date=date.today(),
        opening_fund_cents=0 if has_count else data.get('opening_fund_cents', 0),
        opened_by=user_id,
    )
    db.session.add(session)
    if has_count:
        db.session.flush()
        cash_handoff_svc.record_open(session, lines, user_id)
    db.session.commit()
    return jsonify(session.to_dict()), 201


@cash_bp.route('/close', methods=['POST'])
@jwt_required()
def close_session():
    err = _require_manager()
    if err: return err
    user_id = get_jwt_identity()

    session = _current_session()
    if not session:
        return jsonify({'error': 'NO_OPEN_SESSION'}), 404

    # Block close if there are open tickets
    open_tickets = Ticket.query.filter(
        Ticket.status == 'OPEN',
        Ticket.opened_at >= session.opened_at
    ).count()
    if open_tickets:
        return jsonify({
            'error': 'OPEN_TICKETS',
            'message': f'No se puede cerrar la caja: hay {open_tickets} cuenta{"s" if open_tickets != 1 else ""} abierta{"s" if open_tickets != 1 else ""} pendiente{"s" if open_tickets != 1 else ""}. Ciérralas primero.'
        }), 409

    # Body: {count, drawer_left, notes} (count by denomination) or the legacy
    # {closing_cash_counted_cents, notes}. Same flag rules as open_session.
    data = _json_body()
    if data is None:
        return _bad_body()
    # Notes: text or nothing, stripped once. The same value goes on the
    # session and on the DRAWER_LEFT count. Anything else used to be a 500.
    notes = data.get('notes')
    if notes is not None and not isinstance(notes, str):
        return jsonify({'error': 'VALIDATION', 'message': 'La nota debe ser texto.', 'field': 'notes'}), 422
    notes = (notes or '').strip() or None
    has_count = data.get('count') is not None
    if not has_count and cash_handoff_svc.count_required():
        return _count_required(cash_handoff_svc.COUNT_REQUIRED_CLOSE)

    counted = left = None
    if has_count:
        cur = cash_handoff_svc.currency()
        try:
            counted = cash_handoff_svc.parse(data['count'], cur)
        except CountError as e:
            return _count_error(e, 'count')
        raw_left = data.get('drawer_left')
        try:
            left = cash_handoff_svc.parse([] if raw_left is None else raw_left, cur)
            cash_count_svc.split(counted, left)
        except CountError as e:
            return _count_error(e, 'drawer_left')
        left_total = cash_count_svc.total_cents(left, cur)
        target = cash_handoff_svc.fund_target_cents()
        if left_total != target and not notes:
            return jsonify({
                'error': 'NOTE_REQUIRED',
                'message': (f'Lo que se queda en caja ({cash_handoff_svc.money(left_total)}) no es el '
                            f'fondo de {cash_handoff_svc.money(target)}. Escribe una nota que explique por qué.'),
                'field': 'notes',
            }), 422

    # Lock the row and re-check: the counts, the envelope and the session
    # update are written in this one transaction, at most once per session.
    session = _lock_open_session(session.id)
    if session is None:
        db.session.rollback()
        return jsonify({'error': 'NO_OPEN_SESSION'}), 404

    envelope = None
    if has_count:
        envelope = cash_handoff_svc.record_close(session, counted, left, user_id, notes)
    else:
        session.closing_cash_counted_cents = data.get('closing_cash_counted_cents')
    session.notes = notes
    session.closed_by = user_id
    session.closed_at = datetime.now(timezone.utc)
    session.status = 'CLOSED'
    db.session.commit()

    tip_cfg = TipDistributionConfig.query.get(1)
    out = {'session': session.to_dict(),
           'summary': _for_viewer(session, _build_summary(session, tip_cfg))}
    if envelope is not None:
        out['envelope'] = {
            'number': envelope.number,
            'declared_cents': envelope.declared_cents,
            'lines': cash_handoff_svc.rows(cash_count_svc.split(counted, left), cur),
        }
        drawer_left = {'total_cents': left_total, 'lines': cash_handoff_svc.rows(left, cur)}
        # The "queda en caja" figures are owner-only after the close. The
        # closing manager gets them here, only to print the slip that goes INTO
        # the envelope. GET /cash/sessions/<id>/slips returns them again to
        # that same manager until the next opening; after that, owner only.
        out['slip_drawer_left'] = drawer_left
        if _is_owner():
            out['drawer_left'] = drawer_left
    return jsonify(out)


@cash_bp.route('/sessions/<session_id>/recount', methods=['POST'])
@jwt_required()
def recount_session(session_id):
    """Owner-only correction of a count. Body: {kind, count, reason}. Appends a
    new count (the old one stays), rewrites the derived totals, audits it."""
    if not _is_owner():
        return jsonify({'error': 'FORBIDDEN', 'message': 'Solo el dueño puede corregir un conteo.'}), 403
    data = _json_body()
    if data is None:
        return _bad_body()
    kind = data.get('kind')
    if kind not in cash_handoff_svc.RECOUNT_KINDS:
        return jsonify({'error': 'VALIDATION', 'message': 'Tipo de conteo no válido.', 'field': 'kind'}), 422
    reason = data.get('reason')
    if not isinstance(reason, str) or not reason.strip():
        return jsonify({'error': 'REASON_REQUIRED', 'message': 'Escribe el motivo de la corrección.',
                        'field': 'reason'}), 422
    try:
        lines = cash_handoff_svc.parse(data.get('count'), cash_handoff_svc.currency())
    except CountError as e:
        return _count_error(e, 'count')
    session = (CashSession.query.filter_by(id=session_id)
               .with_for_update().populate_existing().first())
    if session is None:
        return jsonify({'error': 'NOT_FOUND'}), 404
    try:
        result = cash_handoff_svc.recount(session, kind, lines, reason, get_jwt_identity())
    except CountError as e:
        db.session.rollback()
        return _count_error(e, 'count')
    except cash_handoff_svc.RecountError as e:
        db.session.rollback()
        return jsonify({'error': e.code, 'message': e.message}), e.status
    audit_svc.log(get_jwt_identity(), 'CASH_RECOUNT', 'cash_session', session.id,
                  before={'kind': kind, **result['before']}, after={'kind': kind, **result['after']},
                  reason=result['reason'], ip_address=request.remote_addr)
    db.session.commit()
    tip_cfg = TipDistributionConfig.query.get(1)
    return jsonify({'session': _session_for_viewer(session),
                    'summary': _summary_for_viewer(session, tip_cfg)})


@cash_bp.route('/current/summary', methods=['GET'])
@jwt_required()
def current_summary():
    # Was readable by ANY logged-in user (a waiter's token could read the
    # night's sales). Money is manager/owner territory.
    err = _require_manager()
    if err: return err
    session = _current_session()
    if not session:
        return jsonify({'error': 'NO_OPEN_SESSION'}), 404
    tip_cfg = TipDistributionConfig.query.get(1)
    return jsonify({'session': _session_for_viewer(session),
                    'summary': _summary_for_viewer(session, tip_cfg)})


@cash_bp.route('/<session_id>/summary', methods=['GET'])
@jwt_required()
def session_summary(session_id):
    err = _require_manager()
    if err: return err
    session = CashSession.query.get_or_404(session_id)
    tip_cfg = TipDistributionConfig.query.get(1)
    return jsonify({'session': _session_for_viewer(session),
                    'summary': _summary_for_viewer(session, tip_cfg)})


@cash_bp.route('/sessions', methods=['GET'])
@jwt_required()
def list_sessions():
    err = _require_manager()
    if err: return err
    from app.models.user import User
    sessions = CashSession.query.order_by(CashSession.opened_at.desc()).limit(30).all()
    names = {u.id: u.name for u in User.query.filter(User.id.in_(
        {s.opened_by for s in sessions} | {s.closed_by for s in sessions if s.closed_by})).all()}
    handoff = _handoff_fields(sessions)
    out = []
    for s in sessions:
        d = {**s.to_dict(), **handoff[s.id]}
        d['opened_by_name'] = names.get(s.opened_by)
        d['closed_by_name'] = names.get(s.closed_by)
        # History shows each close's result (over/short) -- the record that
        # makes a pattern of shortages visible. Open sessions stay blind.
        if s.status == 'CLOSED' and s.closing_cash_counted_cents is not None:
            summ = _build_summary(s)
            d['expected_cash_cents'] = summ['expected_cash_cents']
            d['cash_over_short_cents'] = summ['cash_over_short_cents']
        out.append(_strip_for_viewer(s, d, has_envelope=d['envelope_number'] is not None))
    return jsonify(out)


_REPRINT_FORBIDDEN = 'Solo el dueño puede reimprimir estos comprobantes.'


@cash_bp.route('/sessions/<session_id>/slips', methods=['GET'])
@jwt_required()
def session_slips(session_id):
    """The two close slips (Sobre #N and Queda en caja), for a reprint.

    ADMIN: always. MANAGER: only the manager who closed this session, and only
    until the next session opens. After that the next manager has counted the
    drawer and the "queda en caja" figures are owner-only."""
    err = _require_manager()
    if err: return err
    session = CashSession.query.get(session_id)
    if session is None:
        return jsonify({'error': 'NOT_FOUND'}), 404
    if not _is_owner():
        reopened = session.closed_at is not None and db.session.query(
            CashSession.query.filter(CashSession.opened_at > session.closed_at).exists()).scalar()
        if session.closed_at is None or session.closed_by != get_jwt_identity() or reopened:
            return jsonify({'error': 'FORBIDDEN', 'message': _REPRINT_FORBIDDEN}), 403
    envelope = CashEnvelope.query.filter_by(session_id=session.id).first()
    if envelope is None:
        return jsonify({'error': 'NO_ENVELOPE', 'message': 'Esta caja no tiene sobre.'}), 404
    cur = cash_handoff_svc.currency()
    counted = cash_handoff_svc.count_lines(cash_handoff_svc.current_count(session.id, 'CLOSE'))
    left_count = cash_handoff_svc.current_count(session.id, 'DRAWER_LEFT')
    left = cash_handoff_svc.count_lines(left_count)
    return jsonify({
        'envelope': {
            'number': envelope.number,
            'declared_cents': envelope.declared_cents,
            'lines': cash_handoff_svc.rows(cash_count_svc.split(counted, left), cur),
        },
        'drawer_left': {
            'total_cents': left_count.total_cents if left_count else 0,
            'lines': cash_handoff_svc.rows(left, cur),
        },
        'session': {
            'date': session.date.isoformat() if session.date else None,
            'closed_at': session.closed_at.isoformat() if session.closed_at else None,
            'closed_by_name': session.closer.name if session.closer else None,
        },
    })


# ── Tip Distribution Config ────────────────────────────────────────────────────

@cash_bp.route('/tip-distribution', methods=['GET'])
@jwt_required()
def get_tip_distribution():
    cfg = TipDistributionConfig.query.get(1)
    if not cfg:
        cfg = TipDistributionConfig(id=1)
        db.session.add(cfg)
        db.session.commit()
    return jsonify(cfg.to_dict())


@cash_bp.route('/tip-distribution', methods=['PUT'])
@jwt_required()
def update_tip_distribution():
    err = _require_manager()
    if err: return err

    data = request.get_json()
    floor = data.get('floor_pct', 30)
    bar = data.get('bar_pct', 40)
    kitchen = data.get('kitchen_pct', 30)

    if floor + bar + kitchen != 100:
        return jsonify({'error': 'Percentages must sum to 100'}), 422

    cfg = TipDistributionConfig.query.get(1)
    if not cfg:
        cfg = TipDistributionConfig(id=1)
        db.session.add(cfg)
    cfg.floor_pct = floor
    cfg.bar_pct = bar
    cfg.kitchen_pct = kitchen
    cfg.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify(cfg.to_dict())


# ── Session Tickets ────────────────────────────────────────────────────────────

@cash_bp.route('/current/tickets', methods=['GET'])
@jwt_required()
def list_session_tickets():
    err = _require_manager()
    if err: return err
    session = _current_session()
    if not session:
        return jsonify([])
    tickets = Ticket.query.filter(
        Ticket.status == 'CLOSED',
        Ticket.closed_at >= session.opened_at,
    ).order_by(Ticket.closed_at.desc()).all()
    rows = [_ticket_summary(t) for t in tickets]
    if _is_blind(session):
        # Per-ticket amounts + payment method would let the expected cash be
        # rebuilt by hand, defeating the blind count.
        rows = [{k: v for k, v in r.items() if k not in ('total_cents', 'payment_type')}
                for r in rows]
    return jsonify(rows)


def _ticket_summary(t: Ticket):
    return {
        'id': t.id,
        'customer_name': t.customer_name,
        'resource_code': t.resource.code if t.resource else None,
        'resource_type': t.resource.type if t.resource else None,
        'status': t.status,
        'payment_type': t.payment_type,
        'total_cents': t.total_cents,
        'tip_cents': t.tip_cents or 0,
        'closed_at': t.closed_at.isoformat() if t.closed_at else None,
        'was_reopened': t.was_reopened or False,
    }


def _build_summary(session: CashSession, tip_cfg=None):
    """Compute reconciliation numbers for a cash session.

    Tickets are attributed to the session in which they were OPENED,
    not when they were closed — so a ticket opened at 11 pm Sunday
    and closed at 1 am Monday belongs to Sunday's session.
    """
    tickets = Ticket.query.filter(
        Ticket.status == 'CLOSED',
        Ticket.opened_at >= session.opened_at,
    )
    if session.closed_at:
        tickets = tickets.filter(Ticket.opened_at <= session.closed_at)
    tickets = tickets.all()

    cash_tickets = [t for t in tickets if t.payment_type == 'CASH']
    card_tickets = [t for t in tickets if t.payment_type == 'CARD']

    total_sales = sum(t.total_cents for t in tickets)
    total_tips = sum((t.tip_cents or 0) for t in tickets)

    # For split-payment tickets, split sales/tips by actual tendered amounts
    cash_sales = 0
    card_sales = 0
    cash_tips = 0
    card_tips = 0
    for t in tickets:
        tip = t.tip_cents or 0
        tip_src = t.tip_source  # CASH, CARD, SPLIT, or None
        if t.payment_type_2:
            # Split ticket — tendered_cents = first method, tendered_cents_2 = second method.
            # Correct approach: sale_per_method = tendered_per_method − tip_per_method
            # (avoids the cross-ratio bug where total_cents and grand have different tip bases)
            t1 = t.tendered_cents or 0
            t2 = t.tendered_cents_2 or 0
            first_is_cash = (t.payment_type == 'CASH')

            # Determine how the tip was collected per method
            if tip_src == 'CASH':
                t1_tip = tip if first_is_cash else 0
                t2_tip = 0 if first_is_cash else tip
            elif tip_src == 'CARD':
                t1_tip = 0 if first_is_cash else tip
                t2_tip = tip if first_is_cash else 0
            elif tip_src == 'SPLIT' and t.tip_cash_cents is not None:
                t1_tip = (t.tip_cash_cents or 0) if first_is_cash else (t.tip_card_cents or 0)
                t2_tip = tip - t1_tip
            else:  # SPLIT proportional or None
                grand = (t1 + t2) if (t1 + t2) > 0 else 1
                t1_tip = round(tip * t1 / grand)
                t2_tip = tip - t1_tip

            # Sale = tendered − tip (clamped to avoid negative on rounding edge cases)
            t1_sale = max(0, t1 - t1_tip)
            t2_sale = max(0, t2 - t2_tip)

            if first_is_cash:
                cash_sales += t1_sale
                card_sales += t2_sale
                cash_tips  += t1_tip
                card_tips  += t2_tip
            else:
                card_sales += t1_sale
                cash_sales += t2_sale
                card_tips  += t1_tip
                cash_tips  += t2_tip
        elif t.payment_type == 'CASH':
            cash_sales += t.total_cents
            # Honor explicit tip_source if set, else default to payment type
            if tip_src == 'CARD':
                card_tips += tip
            elif tip_src == 'SPLIT':
                cash_tips += tip // 2
                card_tips += tip - tip // 2
            else:
                cash_tips += tip
        else:
            card_sales += t.total_cents
            if tip_src == 'CASH':
                cash_tips += tip
            elif tip_src == 'SPLIT':
                cash_tips += tip // 2
                card_tips += tip - tip // 2
            else:
                card_tips += tip

    expenses = session.expenses.all()
    cash_expenses = sum(e.amount_cents for e in expenses if e.payment_method == 'CASH')
    card_expenses = sum(e.amount_cents for e in expenses if e.payment_method == 'CARD')
    total_expenses = cash_expenses + card_expenses

    # Bar policy (since 2026-04-26): all tips — both cash and card — are paid
    # out to staff in cash from the register at close. We auto-deduct the full
    # tip total so expected_cash reflects what should physically remain in the
    # drawer after tip payouts. This eliminates the daily phantom shortfall
    # that came from card tips leaving the register without a matching expense.
    tip_payout = total_tips

    expected_cash = (
        session.opening_fund_cents
        + cash_sales
        + cash_tips
        - cash_expenses
        - tip_payout
    )
    cash_over_short = None
    if session.closing_cash_counted_cents is not None:
        cash_over_short = session.closing_cash_counted_cents - expected_cash

    # Tip distribution breakdown
    tip_distribution = None
    if tip_cfg:
        tip_distribution = {
            'floor_pct': tip_cfg.floor_pct,
            'bar_pct': tip_cfg.bar_pct,
            'kitchen_pct': tip_cfg.kitchen_pct,
            'floor_cents': round(total_tips * tip_cfg.floor_pct / 100),
            'bar_cents': round(total_tips * tip_cfg.bar_pct / 100),
            'kitchen_cents': round(total_tips * tip_cfg.kitchen_pct / 100),
        }

    return {
        'ticket_count': len(tickets),
        'total_sales_cents': total_sales,
        'total_tips_cents': total_tips,
        'cash_sales_cents': cash_sales,
        'card_sales_cents': card_sales,
        'cash_tips_cents': cash_tips,
        'card_tips_cents': card_tips,
        'total_expenses_cents': total_expenses,
        'cash_expenses_cents': cash_expenses,
        'card_expenses_cents': card_expenses,
        'tip_payout_cents': tip_payout,
        'opening_fund_cents': session.opening_fund_cents,
        'expected_cash_cents': expected_cash,
        'closing_cash_counted_cents': session.closing_cash_counted_cents,
        'cash_over_short_cents': cash_over_short,
        'expenses': [e.to_dict() for e in expenses],
        'tip_distribution': tip_distribution,
    }


# ── Expenses ──────────────────────────────────────────────────────────────────

@cash_bp.route('/current/expenses', methods=['GET'])
@jwt_required()
def list_current_expenses():
    session = _current_session()
    if not session:
        return jsonify([])
    return jsonify([e.to_dict() for e in session.expenses.order_by(Expense.created_at.desc()).all()])


@cash_bp.route('/current/expenses', methods=['POST'])
@jwt_required()
def add_expense():
    err = _require_manager()
    if err: return err
    user_id = get_jwt_identity()

    session = _current_session()
    if not session:
        return jsonify({'error': 'NO_OPEN_SESSION'}), 404

    data = request.get_json()
    if not data.get('amount_cents') or not data.get('payee') or not data.get('description'):
        return jsonify({'error': 'amount_cents, payee, description required'}), 422

    expense = Expense(
        session_id=session.id,
        amount_cents=data['amount_cents'],
        payment_method=data.get('payment_method', 'CASH'),
        payee=data['payee'],
        description=data['description'],
        created_by=user_id,
    )
    db.session.add(expense)
    db.session.commit()
    return jsonify(expense.to_dict()), 201


@cash_bp.route('/expenses/<expense_id>', methods=['DELETE'])
@jwt_required()
def delete_expense(expense_id):
    err = _require_manager()
    if err: return err
    expense = Expense.query.get_or_404(expense_id)
    user_id = get_jwt_identity()
    from app.services import audit_svc
    audit_svc.log(user_id, 'EXPENSE_DELETED', 'expense', expense_id, before=expense.to_dict())
    db.session.delete(expense)
    db.session.commit()
    return jsonify({'ok': True})

