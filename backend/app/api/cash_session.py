from datetime import date, datetime, timezone
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity
from app.extensions import db
from app.models.cash_session import CashSession, Expense, TipDistributionConfig
from app.models.ticket import Ticket
from app.models.resource import Resource

cash_bp = Blueprint('cash', __name__)


def _require_manager():
    claims = get_jwt()
    if claims.get('role') not in ('MANAGER', 'ADMIN'):
        return jsonify({'error': 'FORBIDDEN'}), 403
    return None


def _current_session():
    return CashSession.query.filter_by(status='OPEN').order_by(CashSession.opened_at.desc()).first()


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
        'session': session.to_dict() if session else None,
        'open_tickets_count': open_tickets,
        'ghost_tickets_count': ghost_tickets,
    })


@cash_bp.route('/open', methods=['POST'])
@jwt_required()
def open_session():
    err = _require_manager()
    if err: return err
    user_id = get_jwt_identity()

    if _current_session():
        return jsonify({'error': 'SESSION_ALREADY_OPEN'}), 409

    data = request.get_json()
    session = CashSession(
        date=date.today(),
        opening_fund_cents=data.get('opening_fund_cents', 0),
        opened_by=user_id,
    )
    db.session.add(session)
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

    data = request.get_json()
    session.closing_cash_counted_cents = data.get('closing_cash_counted_cents')
    session.notes = data.get('notes')
    session.closed_by = user_id
    session.closed_at = datetime.now(timezone.utc)
    session.status = 'CLOSED'
    db.session.commit()

    tip_cfg = TipDistributionConfig.query.get(1)
    return jsonify({'session': session.to_dict(), 'summary': _build_summary(session, tip_cfg)})


@cash_bp.route('/current/summary', methods=['GET'])
@jwt_required()
def current_summary():
    session = _current_session()
    if not session:
        return jsonify({'error': 'NO_OPEN_SESSION'}), 404
    tip_cfg = TipDistributionConfig.query.get(1)
    return jsonify({'session': session.to_dict(), 'summary': _build_summary(session, tip_cfg)})


@cash_bp.route('/<session_id>/summary', methods=['GET'])
@jwt_required()
def session_summary(session_id):
    session = CashSession.query.get_or_404(session_id)
    tip_cfg = TipDistributionConfig.query.get(1)
    return jsonify({'session': session.to_dict(), 'summary': _build_summary(session, tip_cfg)})


@cash_bp.route('/sessions', methods=['GET'])
@jwt_required()
def list_sessions():
    err = _require_manager()
    if err: return err
    sessions = CashSession.query.order_by(CashSession.opened_at.desc()).limit(30).all()
    return jsonify([s.to_dict() for s in sessions])


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
    session = _current_session()
    if not session:
        return jsonify([])
    tickets = Ticket.query.filter(
        Ticket.status == 'CLOSED',
        Ticket.closed_at >= session.opened_at,
    ).order_by(Ticket.closed_at.desc()).all()
    return jsonify([_ticket_summary(t) for t in tickets])


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
    """Compute reconciliation numbers for a cash session."""
    tickets = Ticket.query.filter(
        Ticket.status == 'CLOSED',
        Ticket.closed_at >= session.opened_at,
    )
    if session.closed_at:
        tickets = tickets.filter(Ticket.closed_at <= session.closed_at)
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
            # Split ticket — tendered_cents = cash portion, tendered_cents_2 = card portion
            t1 = t.tendered_cents or 0
            t2 = t.tendered_cents_2 or 0
            grand = (t1 + t2) if (t1 + t2) > 0 else max(t.total_cents, 1)
            if t.payment_type == 'CASH':
                cash_sales += t1 * t.total_cents // grand
                card_sales += t.total_cents - (t1 * t.total_cents // grand)
            else:
                card_sales += t1 * t.total_cents // grand
                cash_sales += t.total_cents - (t1 * t.total_cents // grand)
            # Tip source for split payments
            if tip_src == 'CASH':
                cash_tips += tip
            elif tip_src == 'CARD':
                card_tips += tip
            else:  # SPLIT or None — split proportionally
                cash_frac = (t1 / grand) if grand > 0 else 0.5
                cash_tips += round(tip * cash_frac)
                card_tips += tip - round(tip * cash_frac)
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

