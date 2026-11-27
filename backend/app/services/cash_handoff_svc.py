"""Cash handoff, database side: store the drawer counts and the safe envelope.

At opening the manager counts the drawer by denomination (OPENING count). At
close they count it again (CLOSE) and say what stays in the drawer as the
expense fund (DRAWER_LEFT); the rest goes into one numbered envelope for the
safe. Pure arithmetic lives in cash_count_svc; this module writes rows.

Nothing here commits: the caller writes the counts, the envelope and the
session update, then commits once (one transaction).

Only the CLOSE and DRAWER_LEFT counts are stored for a close. The envelope's
lines are not stored: they are always CLOSE - DRAWER_LEFT per denomination,
and storing a third copy could only disagree with the other two. The
envelope's declared_cents is stored (the safe needs it without a recount).
"""
import uuid

from sqlalchemy.orm import aliased

from app.extensions import db
from app.models.cash_session import CashCount, CashCountLine, CashEnvelope
from app.services import cash_count_svc, settings_svc
from app.services.cash_count_svc import CountError

COUNT_FLAG = 'cash.count_by_denomination'
FUND_KEY = 'cash.drawer_fund_cents'
DEFAULT_FUND_CENTS = 200000

# Sanity limits: a typo such as 1000000000 must be a clear 422, not an
# integer overflow inside the database. 1,000,000 pieces of one denomination
# and $10,000,000 in one count are far beyond any real drawer.
MAX_QTY = 1_000_000
MAX_TOTAL_CENTS = 1_000_000_000

COUNT_REQUIRED_CLOSE = 'Cuenta billetes y monedas en la pantalla de Caja del POS para cerrar.'
COUNT_REQUIRED_OPEN = 'Cuenta billetes y monedas en la pantalla de Caja del POS para abrir.'

_MESSAGES = {
    'BAD_COUNT': 'La cuenta de billetes y monedas no es válida. Vuelve a contar en la pantalla de Caja.',
    'UNKNOWN_DENOMINATION': 'Billete o moneda desconocido: {key}',
    'NEGATIVE': 'La cantidad de {key} no puede ser negativa.',
    'NOT_INTEGER': 'La cantidad de {key} debe ser un número entero.',
    'TOO_LARGE': 'La cantidad es demasiado grande. Revisa lo que escribiste.',
    'LEFT_EXCEEDS_COUNTED': 'Lo que se queda en caja de {key} es más de lo que contaste.',
}


def message(err: CountError) -> str:
    return _MESSAGES.get(err.code, err.code).format(key=err.key or '')


def currency() -> str:
    from app.services import venue_svc
    return venue_svc.get_venue()['currency']


def count_required() -> bool:
    """True when open and close must send a count by denomination.

    False when the venue currency has no denomination table, even with the
    flag on: nobody can count in a currency we have no bills and coins for,
    so requiring a count would block every open and close."""
    if not settings_svc.get_bool(COUNT_FLAG, False):
        return False
    return bool(cash_count_svc.denominations(currency()))


def fund_target_cents() -> int:
    return settings_svc.get_int(FUND_KEY, DEFAULT_FUND_CENTS)


def money(cents: int) -> str:
    """200000 -> '$2,000.00' (integer arithmetic, display only)."""
    sign = '-' if cents < 0 else ''
    cents = abs(cents)
    return f'{sign}${cents // 100:,}.{cents % 100:02d}'


def parse(raw, cur: str) -> dict:
    """Request rows [{key, qty}] -> {key: qty}, fully validated.

    Raises CountError: BAD_COUNT (not a list, a row that is not an object, or
    a key that is not a string), UNKNOWN_DENOMINATION, NEGATIVE, NOT_INTEGER,
    TOO_LARGE.
    """
    if not isinstance(raw, list) or any(not isinstance(row, dict) or not isinstance(row.get('key'), str)
                                        for row in raw):
        raise CountError('BAD_COUNT')
    lines = cash_count_svc.parse_lines(raw, cur)
    for key, qty in lines.items():
        if qty > MAX_QTY:
            raise CountError('TOO_LARGE', key)
    if cash_count_svc.total_cents(lines, cur) > MAX_TOTAL_CENTS:
        raise CountError('TOO_LARGE')
    return lines


def rows(lines: dict, cur: str) -> list:
    """{key: qty} -> [{key, qty}] in the denomination table's display order.

    Stored keys that are not in the current table (the venue currency changed
    after the count) are kept at the end, so a reprint never drops cash."""
    order = [d['key'] for d in cash_count_svc.denominations(cur)]
    known = [k for k in order if lines.get(k)]
    extra = sorted(k for k in lines if k not in order and lines[k])
    return [{'key': k, 'qty': lines[k]} for k in known + extra]


def _write_count(session_id, kind, lines, cur, user_id, note=None) -> CashCount:
    cents = {d['key']: d['cents'] for d in cash_count_svc.denominations(cur)}
    count = CashCount(id=str(uuid.uuid4()), session_id=session_id, kind=kind,
                      total_cents=cash_count_svc.total_cents(lines, cur),
                      counted_by=user_id, note=note)
    db.session.add(count)
    for key, qty in lines.items():
        db.session.add(CashCountLine(count_id=count.id, denom_key=key,
                                     denom_cents=cents[key], quantity=qty))
    return count


def record_open(session, lines: dict, user_id) -> int:
    """Store the OPENING count and set session.opening_fund_cents. Returns the total.

    `lines` must come from parse(). The session must already be flushed (has an id).
    """
    count = _write_count(session.id, 'OPENING', lines, currency(), user_id)
    session.opening_fund_cents = count.total_cents
    return count.total_cents


def record_close(session, counted: dict, left: dict, user_id, note) -> CashEnvelope:
    """Store the CLOSE and DRAWER_LEFT counts and the envelope; set
    session.closing_cash_counted_cents. Does not change the session status.

    `counted` and `left` must come from parse(). Raises CountError
    LEFT_EXCEEDS_COUNTED before writing anything. The caller holds the
    session row lock and commits.
    """
    cur = currency()
    envelope_lines = cash_count_svc.split(counted, left)
    note = note.strip() if isinstance(note, str) and note.strip() else None
    close = _write_count(session.id, 'CLOSE', counted, cur, user_id)
    _write_count(session.id, 'DRAWER_LEFT', left, cur, user_id, note=note)
    env = CashEnvelope(session_id=session.id,
                       declared_cents=cash_count_svc.total_cents(envelope_lines, cur),
                       created_by=user_id)
    db.session.add(env)
    session.closing_cash_counted_cents = close.total_cents
    db.session.flush()          # assigns env.number from cash_envelope_number_seq
    return env


class RecountError(Exception):
    """A recount the owner asked for that cannot be done (code + Spanish message)."""

    def __init__(self, code, message, status=422):
        super().__init__(code)
        self.code, self.message, self.status = code, message, status


RECOUNT_KINDS = ('OPENING', 'CLOSE', 'DRAWER_LEFT')


def _snapshot(session, env, kind_total):
    return {'kind_total_cents': kind_total,
            'opening_fund_cents': session.opening_fund_cents,
            'closing_cash_counted_cents': session.closing_cash_counted_cents,
            'envelope_declared_cents': env.declared_cents if env else None}


def recount(session, kind, lines: dict, reason, user_id) -> dict:
    """Owner correction of one count. Appends a new cash_counts row that
    supersedes the current one (the old row and its lines stay), then rewrites
    what was derived from it: opening_fund_cents (OPENING),
    closing_cash_counted_cents (CLOSE) and the envelope's declared_cents
    (CLOSE or DRAWER_LEFT: current CLOSE - current DRAWER_LEFT).

    `lines` must come from parse(). Raises RecountError (REASON_REQUIRED,
    VALIDATION, NO_ENVELOPE) or CountError (LEFT_EXCEEDS_COUNTED); everything
    is validated before anything is written. The caller holds the session row
    lock, writes the audit row and commits. Returns {'before', 'after', 'reason'}.
    """
    reason = reason.strip() if isinstance(reason, str) else ''
    if not reason:
        raise RecountError('REASON_REQUIRED', 'Escribe el motivo de la corrección.')
    if kind not in RECOUNT_KINDS:
        raise RecountError('VALIDATION', 'Tipo de conteo no válido.')
    if kind != 'OPENING' and session.status != 'CLOSED':
        raise RecountError('VALIDATION', 'Solo se puede corregir el cierre de una caja ya cerrada.')
    cur = currency()
    env = CashEnvelope.query.filter_by(session_id=session.id).first()
    old = current_count(session.id, kind)
    old_close = current_count(session.id, 'CLOSE')
    old_left = current_count(session.id, 'DRAWER_LEFT')
    if kind == 'DRAWER_LEFT' and env is None:
        raise RecountError('NO_ENVELOPE', 'Esta caja no tiene sobre; no hay "queda en caja" que corregir.')

    new_close = lines if kind == 'CLOSE' else count_lines(old_close)
    new_left = lines if kind == 'DRAWER_LEFT' else count_lines(old_left)
    new_declared = None
    if env is not None and kind in ('CLOSE', 'DRAWER_LEFT'):
        new_declared = cash_count_svc.total_cents(cash_count_svc.split(new_close, new_left), cur)

    before = _snapshot(session, env, old.total_cents if old else None)
    before['lines'] = count_lines(old)
    count = _write_count(session.id, kind, lines, cur, user_id,
                         note=old.note if old is not None and kind == 'DRAWER_LEFT' else None)
    count.supersedes_id = old.id if old is not None else None
    count.reason = reason
    if kind == 'OPENING':
        session.opening_fund_cents = count.total_cents
    elif kind == 'CLOSE':
        session.closing_cash_counted_cents = count.total_cents
    if new_declared is not None:
        env.declared_cents = new_declared
    after = _snapshot(session, env, count.total_cents)
    after['lines'] = dict(lines)
    db.session.flush()
    return {'before': before, 'after': after, 'reason': reason}


def current_count(session_id, kind):
    """The count of `kind` for the session that no later count supersedes, or None."""
    newer = aliased(CashCount)
    return (CashCount.query
            .filter(CashCount.session_id == session_id, CashCount.kind == kind)
            .filter(~db.session.query(newer.id).filter(newer.supersedes_id == CashCount.id).exists())
            .order_by(CashCount.counted_at.desc())
            .first())


def current_totals(session_ids, kind) -> dict:
    """{session_id: total_cents} of the current count of `kind`, for each of
    the sessions that has one. Same "current" rule as current_count()."""
    session_ids = list(session_ids)
    if not session_ids:
        return {}
    newer = aliased(CashCount)
    found = (db.session.query(CashCount.session_id, CashCount.total_cents)
             .filter(CashCount.session_id.in_(session_ids), CashCount.kind == kind)
             .filter(~db.session.query(newer.id).filter(newer.supersedes_id == CashCount.id).exists())
             .order_by(CashCount.counted_at.asc())
             .all())
    return {sid: total for sid, total in found}     # ascending: the latest wins


def count_lines(count) -> dict:
    """A stored CashCount -> {key: qty}; {} for None."""
    return {} if count is None else {ln.denom_key: ln.quantity for ln in count.lines}
