"""Batch E5 -- comps (cortesías) and staff consumption -- against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Expects 040-054. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_comps_staff
"""
import os
import sys
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
from app.models.ticket import Ticket, TicketLineItem  # noqa: E402
from app.models.user import User  # noqa: E402

passed = failed = 0
MPIN, OPIN = '7391', '8462'


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
    check('0a. analytics views (incl. v_consumo_sin_venta) build', ensure_analytics_views(db) is True)
    db.session.commit()
    adm = User.query.filter_by(role='ADMIN', is_active=True).first()
    mgr = User.query.filter_by(role='MANAGER', is_active=True).first()
    waiter = User.query.filter_by(role='WAITER', is_active=True).first() or mgr
    mgr.set_pin(MPIN)
    adm.set_pin(OPIN)
    db.session.commit()

    def tok(u, role):
        return {'Authorization': 'Bearer ' + create_access_token(
            identity=u.id, additional_claims={'role': role, 'name': u.name})}
    HW, HA = tok(waiter, waiter.role), tok(adm, 'ADMIN')

    def stock(name):
        db.session.expire_all()
        return Decimal(InventoryItem.query.filter_by(name=name).first().stock_quantity)

    corona = InventoryItem.query.filter_by(name='Corona').first()
    db.session.execute(text("SELECT fn_count_adjustment(:i, 50, :u, 'test E5')"), {'i': corona.id, 'u': adm.id})
    from app.services import cost_svc
    cost_svc.set_cost(corona.id, unit_cost_cents=1850, reason='test E5')
    if not scalar("SELECT 1 FROM cash_sessions WHERE status = 'OPEN'"):
        db.session.execute(text("""INSERT INTO cash_sessions (id, date, status, opening_fund_cents, opened_by, opened_at)
                                   VALUES (gen_random_uuid()::text, CURRENT_DATE, 'OPEN', 0, :u, now())"""), {'u': adm.id})
    db.session.commit()
    corona_menu = scalar("SELECT id FROM menu_items WHERE name = 'Corona'")
    price = scalar("SELECT price_cents FROM menu_items WHERE id = :i", i=corona_menu)

    def new_ticket():
        t = Ticket(ticket_type='EXPRESS', resource_id=None, opened_by=waiter.id, status='OPEN', version=1)
        db.session.add(t)
        db.session.commit()
        return t.id

    def add(tid, menu, qty=1, h=HW):
        r = client.post(f'/api/v1/tickets/{tid}/items', headers=h, json={'menu_item_id': menu, 'quantity': qty})
        lid = (r.get_json() or {}).get('id')
        if r.status_code == 201 and TicketLineItem.query.get(lid).status == 'STAGED':
            client.post(f'/api/v1/tickets/{tid}/send-order', headers=h)
        return lid

    def ticket(tid):
        db.session.expire_all()
        return Ticket.query.get(tid)

    print("== 1. cortesía ==")
    T = new_ticket()
    s0 = stock('Corona')
    l1 = add(T, corona_menu, 2)
    l2 = add(T, corona_menu, 1)
    total0 = ticket(T).total_cents
    r = client.post(f'/api/v1/tickets/{T}/items/{l1}/comp', headers=HW, json={'reason': 'Cumpleaños'})
    check('1a. no PIN, no cortesía (403)', r.status_code == 403)
    r = client.post(f'/api/v1/tickets/{T}/items/{l1}/comp', headers=HW, json={'pin': MPIN, 'reason': 'porque sí'})
    check('1b. the reason must be one of the list (422)', r.status_code == 422, f'{r.status_code}')
    r = client.post(f'/api/v1/tickets/{T}/items/{l1}/comp', headers=HW, json={'pin': MPIN, 'reason': 'Cumpleaños'})
    li = TicketLineItem.query.get(l1)
    check('1c. 2 Coronas comped: the bill drops by their price, the line stays at $0 with its list value',
          r.status_code == 200 and ticket(T).total_cents == total0 - 2 * price and li.unit_price_cents == 0
          and li.comp_list_cents == 2 * price and li.comp_reason == 'Cumpleaños' and li.comped_by == mgr.id,
          f'{r.status_code} total {total0} -> {ticket(T).total_cents}')
    check('1d. ... and the beer still left stock (it was served): -3 in total', stock('Corona') == s0 - 3)
    r = client.post(f'/api/v1/tickets/{T}/items/{l1}/comp', headers=HW, json={'pin': MPIN, 'reason': 'Cumpleaños'})
    check('1e. comping twice is refused (409)', r.status_code == 409)
    r = client.patch(f'/api/v1/tickets/{T}/items/{l1}', headers=HW, json={'quantity': 3})
    check('1f. a comped line\'s quantity is locked (409)', r.status_code == 409)
    r = client.delete(f'/api/v1/tickets/{T}/items/{l1}/comp', headers=HW, json={'pin': MPIN})
    check('1g. undo before close: the price is back', r.status_code == 200 and ticket(T).total_cents == total0
          and TicketLineItem.query.get(l1).comp_reason is None)
    client.post(f'/api/v1/tickets/{T}/items/{l1}/comp', headers=HW, json={'pin': MPIN, 'reason': 'Otro: cliente de la casa'})
    db.session.execute(text("""INSERT INTO settings (key, value) VALUES ('comps.owner_above_cents', '1000')
                               ON CONFLICT (key) DO UPDATE SET value = '1000'"""))
    db.session.commit()
    r = client.post(f'/api/v1/tickets/{T}/items/{l2}/comp', headers=HW, json={'pin': MPIN, 'reason': 'Cliente frecuente'})
    check('1h. above the owner\'s limit a manager PIN is not enough (403 OWNER_REQUIRED)',
          r.status_code == 403 and r.get_json()['error'] == 'OWNER_REQUIRED', f'{r.status_code}')
    r = client.post(f'/api/v1/tickets/{T}/items/{l2}/comp', headers=HW, json={'pin': OPIN, 'reason': 'Cliente frecuente'})
    check('1i. ... the owner\'s PIN is', r.status_code == 200)
    db.session.execute(text("DELETE FROM settings WHERE key = 'comps.owner_above_cents'"))
    db.session.commit()

    print("\n== 2. not sales, but cost ==")
    t = ticket(T)
    t.status, t.closed_at, t.payment_type = 'CLOSED', db.func.now(), 'CASH'
    db.session.commit()
    check('2a. comped lines are out of the sales lines (margins)',
          scalar("SELECT count(*) FROM v_bola8_lineas_venta WHERE line_item_id IN (:a, :b)", a=l1, b=l2) == 0)
    rows = db.session.execute(text("""SELECT tipo, motivo, autorizo, valor_lista_cents, costo_cents
        FROM v_consumo_sin_venta WHERE ticket_id = :t ORDER BY valor_lista_cents DESC"""), {'t': T}).all()
    check('2b. ... and in "consumo sin venta" as CORTESIA with reason, who authorized, list value and cost (3 x $18.50)',
          len(rows) == 2 and all(r.tipo == 'CORTESIA' for r in rows)
          and sum(r.costo_cents for r in rows) == 3 * 1850 and rows[0].motivo.startswith('Otro'),
          f'{[tuple(r) for r in rows]}')

    # Regression: app startup (init-db) used to re-create the "open ticket
    # needs a table" constraint WITHOUT staff orders, undoing 054 on restart.
    res = app.test_cli_runner().invoke(args=['init-db'])
    check("3-. after the app's startup setup runs, staff orders are still allowed without a table",
          "'STAFF'" in (scalar("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                              "WHERE conname = 'chk_open_ticket_has_resource'") or ''), f'exit {res.exit_code}')
    print("\n== 3. consumo de personal ==")
    r = client.post('/api/v1/tickets/staff', headers=HW, json={'staff_user_id': waiter.id, 'reason': 'Bebida de turno'})
    check('3a. a staff order needs a manager PIN (403)', r.status_code == 403)
    r = client.post('/api/v1/tickets/staff', headers=HW,
                    json={'pin': MPIN, 'staff_user_id': waiter.id, 'reason': 'Bebida de turno'})
    S = (r.get_json() or {}).get('id')
    check('3b. opened as a STAFF order without a table, named after the employee',
          r.status_code == 201 and r.get_json()['ticket_type'] == 'STAFF' and r.get_json()['staff_name'] == waiter.name,
          f'{r.status_code} {r.get_json()}')
    s1 = stock('Corona')
    ls = add(S, corona_menu, 1)
    check('3c. its beer goes through the bar like any order and leaves stock',
          TicketLineItem.query.get(ls).status != 'STAGED' and stock('Corona') == s1 - 1)
    r = client.post(f'/api/v1/tickets/{S}/close', headers=HW, json={'payment_type': 'CASH'})
    check('3d. it can never be paid / go through the cash drawer (409)', r.status_code == 409, f'{r.status_code}')
    db.session.execute(text("""INSERT INTO settings (key, value) VALUES ('staff.allowance_cents', '1')
                               ON CONFLICT (key) DO UPDATE SET value = '1'"""))
    db.session.commit()
    r = client.post(f'/api/v1/tickets/{S}/staff-close', headers=HW, json={})
    check('3e. over the daily allowance it needs the owner (403)', r.status_code == 403 and r.get_json()['error'] == 'OWNER_REQUIRED')
    r = client.post(f'/api/v1/tickets/{S}/staff-close', headers=HW, json={'pin': OPIN})
    check('3f. ... the owner closes it: STAFF_DONE, nothing charged',
          r.status_code == 200 and ticket(S).status == 'STAFF_DONE' and ticket(S).total_cents == 0, f'{r.status_code}')
    db.session.execute(text("DELETE FROM settings WHERE key = 'staff.allowance_cents'"))
    db.session.commit()
    check('3g. it is not a sale: not in closed tickets, not in sales lines',
          scalar("SELECT count(*) FROM v_bola8_tickets_cerrados WHERE ticket_id = :t", t=S) == 0
          and scalar("SELECT count(*) FROM v_bola8_lineas_venta WHERE ticket_id = :t", t=S) == 0)
    p = db.session.execute(text("SELECT tipo, empleado, motivo, costo_cents FROM v_consumo_sin_venta WHERE ticket_id = :t"),
                           {'t': S}).first()
    check('3h. it is "consumo de personal" for that employee, at cost',
          p is not None and p.tipo == 'PERSONAL' and p.empleado == waiter.name and p.costo_cents == 1850, f'{p and tuple(p)}')

    r = client.post('/api/v1/tickets/staff', headers=HW,
                    json={'pin': MPIN, 'staff_user_id': waiter.id, 'reason': 'Comida de turno'})
    E = r.get_json()['id']
    r = client.post(f'/api/v1/tickets/{E}/staff-close', headers=HW, json={})
    r2 = client.post(f'/api/v1/tickets/{E}/cancel', headers=HW)
    check('3i. an EMPTY staff order cannot be closed but can be cancelled',
          r.status_code == 422 and r2.status_code == 200 and ticket(E).status == 'CANCELLED', f'{r.status_code} {r2.status_code}')

    print("\n== 4. reasons for voids and discounts ==")
    T2 = new_ticket()
    l3 = add(T2, corona_menu, 1)
    r = client.delete(f'/api/v1/tickets/{T2}/items/{l3}', headers=HW, json={'pin': MPIN, 'reason': 'Void'})
    check('4a. a void with the old default reason "Void" is refused (422)', r.status_code == 422)
    r = client.delete(f'/api/v1/tickets/{T2}/items/{l3}', headers=HW, json={'pin': MPIN, 'reason': 'Error de captura'})
    check('4b. with a real reason it goes through', r.status_code == 200)
    r = client.patch(f'/api/v1/tickets/{T2}/discount', headers=HA, json={'pct': 10})
    check('4c. a discount without a reason is refused (422)', r.status_code == 422)
    r = client.patch(f'/api/v1/tickets/{T2}/discount', headers=HA, json={'pct': 10, 'reason': 'Cliente frecuente'})
    check('4d. with a reason it is applied and stored', r.status_code == 200 and ticket(T2).discount_reason == 'Cliente frecuente')

    print("\n== 5. owner reports ==")
    from app.services.venue_svc import business_today
    with app.test_request_context():
        today = business_today().isoformat()
    r = client.get(f'/api/v1/analytics/comps?from={today}&to={today}', headers=HA)
    j = r.get_json() or {}
    check('5a. Cortesías y personal: totals by kind at cost and list value',
          r.status_code == 200 and j['cortesias']['costo_cents'] >= 3 * 1850 and j['personal']['costo_cents'] >= 1850
          and j['cortesias']['valor_lista_cents'] >= 3 * price, f"{j.get('cortesias')} {j.get('personal')}")
    check('5b. ... by reason, by who authorized, by employee',
          any(x['nombre'] == 'Cumpleaños' or x['nombre'].startswith('Otro') for x in j['por_motivo'])
          and any(x['nombre'] in (mgr.name, adm.name) for x in j['por_autorizo'])
          and any(x['nombre'] == waiter.name for x in j['por_empleado']))
    emp = next((x for x in j['por_empleado'] if x['nombre'] == waiter.name), {})
    det = [x for x in j.get('personal_detalle', []) if x['empleado'] == waiter.name]
    check('5e. staff items are counted as ITEMS (not ticket lines), with who consumed what',
          emp.get('unidades', 0) >= 1 and det and det[0]['producto'] and det[0]['unidades'] >= 1, f'{emp} {det[:2]}')
    r = client.get(f'/api/v1/analytics/profitability?from={today}&to={today}', headers=HA)
    res = (r.get_json() or {}).get('resultado', {})
    check('5c. Rentabilidad shows cortesías and staff consumption as their own cost lines',
          res.get('cortesias_cents', 0) >= 3 * 1850 and res.get('consumo_personal_cents', 0) >= 1850, f'{res}')
    r = client.get(f'/api/v1/analytics/comps?from={today}&to={today}', headers=tok(mgr, 'MANAGER'))
    check('5d. managers cannot see it (owner only)', r.status_code == 403, f'{r.status_code}')

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
