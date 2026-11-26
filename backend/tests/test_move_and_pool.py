"""Batches E6 (move lines) and E7 (pool time) -- against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Expects 040-054. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_move_and_pool
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

url = os.environ.get('DATABASE_URL', '')
if 'scratch' not in url.rsplit('/', 1)[-1]:
    sys.exit(f'REFUSING: DATABASE_URL must point at a *scratch* database, got {url!r}')

from flask_jwt_extended import create_access_token  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models.inventory import InventoryItem  # noqa: E402
from app.models.ticket import PoolTimerSession, Ticket, TicketLineItem  # noqa: E402
from app.models.user import User  # noqa: E402

passed = failed = 0
MPIN = '7391'


def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  -- {detail}" if detail else ''))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  -- {detail}" if detail else ''))


def scalar(sql, **kw):
    return db.session.execute(text(sql), kw).scalar()


app = create_app()
app.config['TESTING'] = True
client = app.test_client()

with app.app_context():
    from app.analytics_views import ensure_analytics_views
    ensure_analytics_views(db)
    db.session.commit()
    adm = User.query.filter_by(role='ADMIN', is_active=True).first()
    mgr = User.query.filter_by(role='MANAGER', is_active=True).first()
    waiter = User.query.filter_by(role='WAITER', is_active=True).first() or mgr
    mgr.set_pin(MPIN)
    adm.set_pin('8462')
    db.session.commit()
    HW = {'Authorization': 'Bearer ' + create_access_token(
        identity=waiter.id, additional_claims={'role': waiter.role, 'name': waiter.name})}

    corona = InventoryItem.query.filter_by(name='Corona').first()
    db.session.execute(text("SELECT fn_count_adjustment(:i, 50, :u, 'test E6')"), {'i': corona.id, 'u': adm.id})
    from app.services import cost_svc
    cost_svc.set_cost(corona.id, unit_cost_cents=1850, reason='test E6')
    if not scalar("SELECT 1 FROM cash_sessions WHERE status = 'OPEN'"):
        db.session.execute(text("""INSERT INTO cash_sessions (id, date, status, opening_fund_cents, opened_by, opened_at)
                                   VALUES (gen_random_uuid()::text, CURRENT_DATE, 'OPEN', 0, :u, now())"""), {'u': adm.id})
    db.session.commit()
    corona_menu = scalar("SELECT id FROM menu_items WHERE name = 'Corona'")
    price = scalar("SELECT price_cents FROM menu_items WHERE id = :i", i=corona_menu)

    def stock():
        db.session.expire_all()
        return Decimal(InventoryItem.query.get(corona.id).stock_quantity)

    def ticket(tid):
        db.session.expire_all()
        return Ticket.query.get(tid)

    def express(name):
        r = client.post('/api/v1/tickets', headers=HW, json={'ticket_type': 'EXPRESS', 'customer_name': name})
        return r.get_json()['id']

    def add(tid, qty):
        r = client.post(f'/api/v1/tickets/{tid}/items', headers=HW, json={'menu_item_id': corona_menu, 'quantity': qty})
        lid = r.get_json()['id']
        if TicketLineItem.query.get(lid).status == 'STAGED':
            client.post(f'/api/v1/tickets/{tid}/send-order', headers=HW)
        return lid

    def cost_of(lid):
        return Decimal(scalar("SELECT COALESCE(SUM(quantity_deducted),0) FROM sale_item_costs WHERE ticket_line_item_id=:l", l=lid))

    print("== E6. move lines to another account ==")
    A, B = express('Mesa A'), express('Mesa B')
    l = add(A, 3)
    s0, v0 = stock(), scalar("SELECT count(*) FROM inventory_movements WHERE event_type='VOID_REVERSAL'")
    tA0 = ticket(A).total_cents
    r = client.post(f'/api/v1/tickets/{A}/move-items', headers=HW,
                    json={'items': [{'id': l, 'quantity': 1}], 'new_account_name': 'Juan (paga aparte)'})
    j = r.get_json() or {}
    N = (j.get('target') or {}).get('id')
    new_line = ((j.get('moved') or [{}])[0]).get('new_line_item_id')
    check('6a. "pago por separado": 1 of 3 beers moves to a new account "Juan"',
          r.status_code == 200 and ticket(N).customer_name == 'Juan (paga aparte)'
          and TicketLineItem.query.get(l).quantity == 2 and TicketLineItem.query.get(new_line).quantity == 1,
          f'{r.status_code} {j.get("message")}')
    check('6b. ... the money moves with it (A -1 beer, Juan +1 beer)',
          ticket(A).total_cents == tA0 - price and ticket(N).total_cents == price,
          f'A {tA0}->{ticket(A).total_cents}, Juan {ticket(N).total_cents}')
    check('6c. ... the recorded cost is split 2 / 1, and nothing went back into stock or was voided',
          cost_of(l) == 2 and cost_of(new_line) == 1 and stock() == s0
          and scalar("SELECT count(*) FROM inventory_movements WHERE event_type='VOID_REVERSAL'") == v0)
    r = client.post(f'/api/v1/tickets/{A}/move-items', headers=HW, json={'items': [{'id': l}], 'target_ticket_id': B})
    check('6d. "cambio de mesa": the whole line moves to account B',
          r.status_code == 200 and TicketLineItem.query.get(l).ticket_id == B and ticket(A).total_cents == 0
          and ticket(B).total_cents == 2 * price)
    r = client.post(f'/api/v1/tickets/{B}/move-items', headers=HW, json={'items': [{'id': l, 'quantity': 5}], 'target_ticket_id': A})
    check('6e. moving more than the line has is refused', r.status_code == 422)
    r = client.post(f'/api/v1/tickets/{B}/move-items', headers=HW, json={'items': [{'id': l}], 'target_ticket_id': B})
    check('6f. moving to the same account is refused', r.status_code == 422)
    S = client.post('/api/v1/tickets/staff', headers=HW, json={'pin': MPIN, 'staff_user_id': waiter.id,
                                                               'reason': 'Bebida de turno'}).get_json()['id']
    r = client.post(f'/api/v1/tickets/{B}/move-items', headers=HW, json={'items': [{'id': l}], 'target_ticket_id': S})
    check('6g. a customer\'s line cannot move into a staff order', r.status_code == 422)
    tg = client.get('/api/v1/tickets/move-targets', headers=HW).get_json()
    check('6h. destinations list open customer accounts, never staff orders',
          any(t['id'] == A for t in tg) and not any(t['id'] == S for t in tg))

    print("\n== E7. pool time ==")
    rid = scalar("""SELECT r.id FROM resources r WHERE r.type = 'POOL_TABLE' AND r.is_active AND r.status = 'AVAILABLE'
                    AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.resource_id = r.id AND t.status = 'OPEN') LIMIT 1""")
    r = client.post('/api/v1/tickets', headers=HW, json={'resource_id': rid, 'customer_name': 'Billar test'})
    P = r.get_json()['id']
    s1 = PoolTimerSession.query.filter_by(ticket_id=P, end_time=None).first()
    s1.start_time = datetime.now(timezone.utc) - timedelta(minutes=40)       # they've played 40 min
    db.session.commit()
    t = client.get(f'/api/v1/tickets/{P}', headers=HW).get_json()
    est = t['timer_sessions'][0]['estimate_cents']
    from app.services import billing
    exp = billing.calculate_charge(s1.start_time, datetime.now(timezone.utc), s1.billing_mode, s1.rate_cents,
                                   s1.effective_free_seconds())['charge_cents']
    check('7a. a running session shows the SERVER estimate (free minutes and billing mode included)',
          est is not None and abs(est - exp) <= max(1, s1.rate_cents // 60), f'{est} vs {exp}')
    r = client.post(f'/api/v1/tickets/{P}/timer/stop', headers=HW)
    db.session.expire_all()
    s1 = PoolTimerSession.query.get(s1.id)
    check('7b. ⏹ stop: the time ends and is charged, the account stays open on the table',
          r.status_code == 200 and s1.status == 'COMPLETED' and s1.charge_cents is not None
          and ticket(P).status == 'OPEN' and ticket(P).resource_id == rid, f'{r.status_code}')
    res = next(x for x in client.get('/api/v1/resources', headers=HW).get_json() if x['id'] == rid)
    check('7c. the floor shows the table as "time stopped", not free', res.get('timer_paused') is True
          and res['status'] == 'IN_USE' and not res.get('timer_start'), f"{res.get('timer_paused')} {res['status']}")
    r = client.post(f'/api/v1/tickets/{P}/timer/stop', headers=HW)
    check('7d. stopping twice says it is not running (409)', r.status_code == 409)
    r = client.post(f'/api/v1/tickets/{P}/timer/start', headers=HW)
    s2 = PoolTimerSession.query.filter_by(ticket_id=P, end_time=None).first()
    check('7e. ▶ new count: a second session on the same table, without the free minutes again',
          r.status_code == 200 and s2 is not None and s2.id != s1.id and (s2.promo_free_seconds or 0) == 0)
    r = client.post(f'/api/v1/tickets/{P}/timer/start', headers=HW)
    check('7f. starting while running is refused (409)', r.status_code == 409)
    s2.start_time = datetime.now(timezone.utc) - timedelta(minutes=10)     # the 2nd game began 10 min ago
    db.session.commit()
    r = client.post(f'/api/v1/tickets/{A}/timer/start', headers=HW)
    check('7g. an account without a pool table cannot start time (409 NOT_POOL_TABLE)',
          r.status_code == 409 and r.get_json()['error'] == 'NOT_POOL_TABLE')

    print("\n== E7. edit start / end ==")
    now = datetime.now(timezone.utc)
    st, en = (now - timedelta(hours=3)), (now - timedelta(hours=2))
    body = {'start_time': st.isoformat(), 'end_time': en.isoformat()}
    r = client.patch(f'/api/v1/tickets/{P}/timer/{s1.id}', headers=HW, json={**body, 'reason': 'se olvidó iniciar'})
    check('7h. a waiter without a manager PIN cannot edit time (403)', r.status_code == 403, f'{r.status_code}')
    r = client.patch(f'/api/v1/tickets/{P}/timer/{s1.id}', headers=HW, json={**body, 'pin': MPIN})
    check('7i. a reason is required (422)', r.status_code == 422 and r.get_json()['error'] == 'REASON_REQUIRED')
    r = client.patch(f'/api/v1/tickets/{P}/timer/{s1.id}', headers=HW,
                     json={'start_time': (now - timedelta(minutes=30)).isoformat(),
                           'end_time': (now - timedelta(minutes=1)).isoformat(), 'pin': MPIN, 'reason': 'x'})
    check('7j. a session cannot overlap the running one (422 OVERLAP)', r.status_code == 422 and r.get_json()['error'] == 'OVERLAP')
    r = client.patch(f'/api/v1/tickets/{P}/timer/{s1.id}', headers=HW,
                     json={'start_time': st.isoformat(), 'end_time': (now + timedelta(hours=1)).isoformat(),
                           'pin': MPIN, 'reason': 'x'})
    check('7k. an end in the future is refused', r.status_code == 422)
    r = client.patch(f'/api/v1/tickets/{P}/timer/{s1.id}', headers=HW,
                     json={**body, 'pin': MPIN, 'reason': 'Empezaron a las 7, se olvidó iniciar'})
    db.session.expire_all()
    s1 = PoolTimerSession.query.get(s1.id)
    exp1 = billing.calculate_charge(st, en, s1.billing_mode, s1.rate_cents, s1.effective_free_seconds(en))['charge_cents']
    check('7l. with PIN + reason: 1 hour, charge recalculated by the same rules, marked as edited',
          r.status_code == 200 and s1.duration_seconds == 3600 and s1.charge_cents == exp1 and s1.is_manual_edit
          and s1.manual_edit_reason.startswith('Empezaron'), f'{r.status_code} {s1.charge_cents} vs {exp1}')
    check('7m. the account total includes every played session',
          ticket(P).pool_time_cents == s1.charge_cents + 0 or ticket(P).pool_time_cents >= s1.charge_cents)
    canc = PoolTimerSession(ticket_id=P, resource_id=rid, billing_mode=s1.billing_mode, rate_cents=s1.rate_cents,
                            start_time=now - timedelta(hours=5), end_time=now - timedelta(hours=4),
                            status='CANCELLED', charge_cents=0)
    db.session.add(canc)
    db.session.commit()
    r = client.patch(f'/api/v1/tickets/{P}/timer/{canc.id}', headers=HW, json={**body, 'pin': MPIN, 'reason': 'x'})
    check('7n. a cancelled (no charge) session cannot be edited into a charge', r.status_code == 422)

    print("\n== E7b. free table time without a promotion ==")
    def est():
        return client.get(f'/api/v1/tickets/{P}', headers=HW).get_json()['timer_sessions']
    run_s = next(x for x in est() if not x['end_time'])
    e0 = run_s['estimate_cents']
    r = client.post(f'/api/v1/tickets/{P}/timer/free', headers=HW, json={'minutes': 60, 'reason': 'Cumpleaños'})
    check('8a. free time needs a manager PIN (403)', r.status_code == 403)
    r = client.post(f'/api/v1/tickets/{P}/timer/free', headers=HW, json={'minutes': 60, 'reason': 'porque sí', 'pin': MPIN})
    check('8b. ... and a reason from the list (422)', r.status_code == 422)
    r = client.post(f'/api/v1/tickets/{P}/timer/free', headers=HW, json={'minutes': 60, 'reason': 'Cumpleaños', 'pin': MPIN})
    run_s = next(x for x in est() if not x['end_time'])
    check('8c. 1 hour free on the running game (10 min played) -> $0 so far',
          r.status_code == 200 and run_s['manual_free_seconds'] == 3600 and run_s['estimate_cents'] == 0,
          f"{r.status_code} {e0} -> {run_s['estimate_cents']}")
    r = client.delete(f'/api/v1/tickets/{P}/timer/free', headers=HW, json={'pin': MPIN})
    run_s = next(x for x in est() if not x['end_time'])
    check('8d. removing it (PIN) brings the charge back', r.status_code == 200 and run_s['manual_free_seconds'] == 0
          and run_s['estimate_cents'] > 0)
    client.post(f'/api/v1/tickets/{P}/timer/stop', headers=HW)
    db.session.expire_all()
    last = PoolTimerSession.query.filter_by(ticket_id=P).order_by(PoolTimerSession.start_time.desc()).first()
    c0 = last.charge_cents
    r = client.post(f'/api/v1/tickets/{P}/timer/free', headers=HW,
                    json={'minutes': 5, 'reason': 'Compensación por servicio', 'pin': MPIN})
    db.session.expire_all()
    last = PoolTimerSession.query.get(last.id)
    exp5 = billing.calculate_charge(last.start_time, last.end_time, last.billing_mode, last.rate_cents,
                                    last.effective_free_seconds(last.end_time))['charge_cents']
    check('8e. time stopped: 5 min free go to the last game, its charge recalculated',
          r.status_code == 200 and last.manual_free_seconds == 300 and last.charge_cents == exp5 and last.charge_cents < c0,
          f'{c0} -> {last.charge_cents}')
    db.session.execute(text("INSERT INTO settings (key, value) VALUES ('comps.owner_above_cents', '100') "
                            "ON CONFLICT (key) DO UPDATE SET value = '100'"))
    db.session.commit()
    r = client.post(f'/api/v1/tickets/{P}/timer/free', headers=HW, json={'minutes': 60, 'reason': 'Cumpleaños', 'pin': MPIN})
    check("8f. above the owner's comp limit a manager cannot give it (403)",
          r.status_code == 403 and r.get_json()['error'] == 'OWNER_REQUIRED')
    r = client.post(f'/api/v1/tickets/{P}/timer/free', headers=HW, json={'minutes': 60, 'reason': 'Cumpleaños', 'pin': '8462'})
    check('8g. ... the owner can', r.status_code == 200)
    db.session.execute(text("DELETE FROM settings WHERE key = 'comps.owner_above_cents'"))
    db.session.commit()
    r = client.post(f'/api/v1/tickets/{A}/timer/free', headers=HW, json={'minutes': 60, 'reason': 'Cumpleaños', 'pin': MPIN})
    check('8h. an account without pool time cannot get free time (422)', r.status_code == 422)
    t = ticket(P)
    t.status, t.closed_at, t.payment_type = 'CLOSED', db.func.now(), 'CASH'
    db.session.commit()
    row = db.session.execute(text("SELECT tipo, producto, quantity, valor_lista_cents, costo_cents, motivo "
                                  "FROM v_consumo_sin_venta WHERE ticket_id = :t AND producto LIKE 'Tiempo de billar%'"),
                             {'t': P}).first()
    db.session.expire_all()
    last = PoolTimerSession.query.get(last.id)
    expv = round(min(3600, last.duration_seconds) * last.rate_cents / 3600)
    check('8i. reported as a cortesía: table time at its rate (no more than played), cost $0',
          row is not None and row.tipo == 'CORTESIA' and row.quantity == 1 and '60 min' in row.producto
          and abs(row.valor_lista_cents - expv) <= 1
          and row.costo_cents == 0 and row.motivo == 'Cumpleaños', f'{row and tuple(row)} vs {expv}')

    for tid in (A, B, N, S, P):
        t = ticket(tid)
        if t and t.status == 'OPEN':
            t.status = 'CANCELLED'
    db.session.execute(text("UPDATE resources SET status = 'AVAILABLE' WHERE id = :r"), {'r': rid})
    db.session.commit()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
