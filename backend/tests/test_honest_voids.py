"""Batch E -- honest voids and delta-only quantity changes -- against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Expects 040-048. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_honest_voids
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
from app.models.ticket import Ticket, TicketLineItem  # noqa: E402
from app.models.user import User  # noqa: E402

passed = failed = 0
PIN = '7391'


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
    mgr = User.query.filter_by(role='MANAGER', is_active=True).first()
    waiter = User.query.filter_by(role='WAITER', is_active=True).first() or mgr
    mgr.set_pin(PIN)
    db.session.commit()
    H = {'Authorization': 'Bearer ' + create_access_token(
        identity=waiter.id, additional_claims={'role': waiter.role, 'name': waiter.name})}

    corona = scalar("SELECT id FROM inventory_items WHERE name = 'Corona'")
    corona_menu = scalar("SELECT id FROM menu_items WHERE name = 'Corona'")
    db.session.execute(text("SELECT fn_count_adjustment(:i, 20, :u, 'test E setup')"), {'i': corona, 'u': mgr.id})
    db.session.commit()
    from app.services import cost_svc
    cost_svc.set_cost(corona, purchase_cost_cents=44400, pack_size=24, reason='test E: real cost')  # $18.50 each
    db.session.commit()

    def stock():
        db.session.expire_all()
        return Decimal(scalar("SELECT stock_quantity FROM inventory_items WHERE id = :i", i=corona))

    def cogs(line):
        return Decimal(scalar("SELECT COALESCE(SUM(quantity_deducted),0) FROM sale_item_costs "
                              "WHERE ticket_line_item_id = :l", l=line))

    def moves(line, since):
        return db.session.execute(text(
            "SELECT event_type, quantity_delta, performed_by, reason, unit_cost_cents FROM inventory_movements "
            "WHERE reference_id = :l AND seq > :s ORDER BY seq"), {'l': line, 's': since}).all()

    def last_seq():
        return scalar("SELECT COALESCE(MAX(seq),0) FROM inventory_movements")

    merma0 = Decimal(scalar("SELECT COALESCE(merma_declarada_28d,0) FROM v_bola8_varianza_inventario "
                            "WHERE inventory_item_id = :i", i=corona) or 0)
    viol0 = scalar("SELECT count(*) FROM ledger_violations")

    t = Ticket(ticket_type='EXPRESS', resource_id=None, opened_by=waiter.id, status='OPEN', version=1)
    db.session.add(t)
    db.session.commit()
    T = t.id

    print("== 1. quantity changes move only the difference ==")
    r = client.post(f'/api/v1/tickets/{T}/items', headers=H, json={'menu_item_id': corona_menu, 'quantity': 3})
    line = (r.get_json() or {}).get('id')
    if TicketLineItem.query.get(line).status == 'STAGED':
        client.post(f'/api/v1/tickets/{T}/send-order', headers=H)
    check('1a. 3 Coronas sold: stock 20 -> 17, COGS for 3', stock() == 17 and cogs(line) == 3,
          f'{stock()} / {cogs(line)}')

    s = last_seq()
    r = client.patch(f'/api/v1/tickets/{T}/items/{line}', headers=H, json={'quantity': 5})
    mv = moves(line, s)
    check('1b. 3 -> 5 deducts only the 2 added (one movement, no reversal)',
          r.status_code == 200 and [(m.event_type, Decimal(m.quantity_delta)) for m in mv] == [('SALE_DEDUCTION', Decimal(-2))]
          and stock() == 15 and cogs(line) == 5, f'{[(m.event_type, m.quantity_delta) for m in mv]} stock={stock()}')
    check('1c. ... credited to the waiter who asked, not a manager', all(m.performed_by == waiter.id for m in mv))

    s = last_seq()
    r = client.patch(f'/api/v1/tickets/{T}/items/{line}', headers=H,
                     json={'quantity': 4, 'pin': PIN, 'disposition': 'RETURNED'})
    mv = moves(line, s)
    check('1d. 5 -> 4 RETURNED: one bottle back on the shelf (stock 16), COGS 4',
          r.status_code == 200 and [(m.event_type, Decimal(m.quantity_delta)) for m in mv] == [('VOID_REVERSAL', Decimal(1))]
          and stock() == 16 and cogs(line) == 4, f'{r.status_code} {[(m.event_type, m.quantity_delta) for m in mv]} {stock()}')

    s = last_seq()
    r = client.patch(f'/api/v1/tickets/{T}/items/{line}', headers=H,
                     json={'quantity': 3, 'pin': PIN, 'disposition': 'WASTED'})
    mv = moves(line, s)
    check('1e. 4 -> 3 WASTED: stock stays 16, the bottle is written off as WASTE, COGS 3',
          r.status_code == 200 and [(m.event_type, Decimal(m.quantity_delta)) for m in mv]
          == [('VOID_REVERSAL', Decimal(1)), ('WASTE', Decimal(-1))] and stock() == 16 and cogs(line) == 3,
          f'{[(m.event_type, m.quantity_delta) for m in mv]} {stock()}')
    w = mv[-1] if mv else None
    check('1f. the waste says why and carries the cost it was sold at ($18.50)',
          w is not None and 'se tiró' in (w.reason or '') and Decimal(w.unit_cost_cents or 0) == 1850
          and Decimal(w.unit_cost_cents or 0)
          == Decimal(scalar("SELECT unit_cost_cents FROM sale_item_costs WHERE ticket_line_item_id=:l LIMIT 1", l=line)),
          f'{w.reason if w else None} @ {w.unit_cost_cents if w else None}')

    print("\n== 2. voids ask what happened ==")
    s = last_seq()
    r = client.delete(f'/api/v1/tickets/{T}/items/{line}', headers=H,
                      json={'pin': PIN, 'reason': 'se cayó', 'disposition': 'WASTED'})
    mv = moves(line, s)
    li = TicketLineItem.query.get(line)
    check('2a. void WASTED: stock stays 16, 3 written off, no COGS left, recorded as WASTED',
          r.status_code == 200 and stock() == 16 and cogs(line) == 0 and li.void_disposition == 'WASTED'
          and sum(Decimal(m.quantity_delta) for m in mv if m.event_type == 'WASTE') == -3,
          f'{r.status_code} stock={stock()} disp={li.void_disposition}')
    check('2b. ... the waste reason carries the void reason', any('se cayó' in (m.reason or '') for m in mv))
    r = client.delete(f'/api/v1/tickets/{T}/items/{line}', headers=H, json={'pin': PIN, 'reason': 'Error de captura', 'disposition': 'WASTED'})
    check('2c. voiding twice is still refused (409) and changes nothing', r.status_code == 409 and stock() == 16)

    r = client.post(f'/api/v1/tickets/{T}/items', headers=H, json={'menu_item_id': corona_menu, 'quantity': 2})
    l2 = r.get_json()['id']
    if TicketLineItem.query.get(l2).status == 'STAGED':
        client.post(f'/api/v1/tickets/{T}/send-order', headers=H)
    r = client.delete(f'/api/v1/tickets/{T}/items/{l2}', headers=H, json={'pin': PIN, 'reason': 'Error de captura', 'disposition': 'RETURNED'})
    check('2d. void RETURNED: both bottles back (16 -> 14 -> 16), recorded as RETURNED',
          r.status_code == 200 and stock() == 16 and TicketLineItem.query.get(l2).void_disposition == 'RETURNED',
          f'{stock()}')

    r = client.post(f'/api/v1/tickets/{T}/items', headers=H, json={'menu_item_id': corona_menu, 'quantity': 1})
    l3 = r.get_json()['id']
    if TicketLineItem.query.get(l3).status == 'STAGED':
        client.post(f'/api/v1/tickets/{T}/send-order', headers=H)
    r = client.delete(f'/api/v1/tickets/{T}/items/{l3}', headers=H, json={'pin': PIN, 'reason': 'Error de captura'})
    check('2e. a screen that does not ask (old tab) defaults to WASTED -- never invents stock',
          r.status_code == 200 and stock() == 15 and TicketLineItem.query.get(l3).void_disposition == 'WASTED',
          f'{stock()}')
    r = client.delete(f'/api/v1/tickets/{T}/items/{l3}', headers=H, json={'pin': PIN, 'reason': 'Error de captura', 'disposition': 'maybe'})
    check('2f. an unknown disposition is refused (422)', r.status_code == 422, f'{r.status_code}')

    staged = TicketLineItem(ticket_id=T, menu_item_id=corona_menu, item_name='Corona', quantity=1,
                            unit_price_cents=5000, routing_dest='BAR', status='STAGED')
    db.session.add(staged)
    db.session.commit()
    r = client.delete(f'/api/v1/tickets/{T}/items/{staged.id}', headers=H, json={'pin': PIN, 'reason': 'Error de captura', 'disposition': 'WASTED'})
    check('2g. a line voided before it was sent is NONE (nothing left stock, nothing wasted)',
          r.status_code == 200 and TicketLineItem.query.get(staged.id).void_disposition == 'NONE' and stock() == 15)

    print("\n== 3. books stay consistent ==")
    check('3a. the ledger matches stock (no new violations)', scalar("SELECT count(*) FROM ledger_violations") == viol0)
    check('3b. last quantity_after == stock',
          Decimal(scalar("SELECT quantity_after FROM inventory_movements WHERE inventory_item_id=:i "
                         "ORDER BY seq DESC LIMIT 1", i=corona)) == stock())
    merma1 = Decimal(scalar("SELECT merma_declarada_28d FROM v_bola8_varianza_inventario WHERE inventory_item_id = :i",
                            i=corona) or 0)
    check('3c. the variance report now shows the 5 thrown away as shrinkage (1 + 3 + 1)',
          merma1 - merma0 == 5, f'{merma0} -> {merma1}')

    from app.services.venue_svc import business_today
    with app.test_request_context():
        today = business_today().isoformat()
    MH = {'Authorization': 'Bearer ' + create_access_token(
        identity=mgr.id, additional_claims={'role': 'ADMIN', 'name': 'x'})}
    rep = client.get(f'/api/v1/reports/voids?from={today}&to={today}', headers=MH).get_json()
    row = next((x for x in rep if x.get('disposition') == 'WASTED' and x.get('reason') == 'se cayó'), None)
    check('3d. Anulaciones shows the disposition and everything this line threw away '
          '(1 on the decrease + 3 on the void = 4 x $18.50)',
          row is not None and int(row['waste_cost_cents']) == 7400, f"{row and row['waste_cost_cents']}")

    t.status = 'CANCELLED'
    db.session.commit()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
