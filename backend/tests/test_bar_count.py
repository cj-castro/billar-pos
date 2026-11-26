"""Batch E2 step 2 -- open bottles and the blind bar count -- against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Expects 040-050. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_bar_count
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
    adm = User.query.filter_by(role='ADMIN', is_active=True).first()
    mgr = User.query.filter_by(role='MANAGER', is_active=True).first()

    def tok(u, role):
        return {'Authorization': 'Bearer ' + create_access_token(
            identity=u.id, additional_claims={'role': role, 'name': u.name})}
    HA, HM = tok(adm, 'ADMIN'), tok(mgr, 'MANAGER')

    def item(name):
        db.session.expire_all()
        return InventoryItem.query.filter_by(name=name).first()

    def stock(name):
        return Decimal(item(name).stock_quantity)

    def count_to(name, qty):
        db.session.execute(text("SELECT fn_count_adjustment(:i, :q, :u, 'test E2b')"),
                           {'i': item(name).id, 'q': qty, 'u': adm.id})
        db.session.commit()

    def open_list(shot):
        return db.session.execute(text("""SELECT id, size_ml FROM open_bottles
            WHERE shot_item_id = :s AND finished_at IS NULL ORDER BY opened_at, id"""), {'s': item(shot).id}).all()

    TB, TBS = 'Tequila Blanco Bottle', 'Tequila Blanco Shot'
    viol0 = scalar("SELECT count(*) FROM ledger_violations WHERE resolved_at IS NULL")

    print("== 1. every open bottle has a record ==")
    check('1a. existing open stock was given open-bottle records (050)',
          all(len(open_list(s)) >= 1 for s in ('Vodka Shot', 'Curazao Azul Shot', TBS)
              if stock(s) > 0))

    print("\n== 2. bottle sizes vary: asked when opening ==")
    client.post(f'/api/v1/inventory/{item(TB).id}/restock', headers=HA,
                json={'purchase_quantity': 3, 'unit_cost_per_purchase_unit_cents': 30000})
    count_to(TBS, 0)
    r = client.post(f'/api/v1/inventory/{item(TB).id}/open-bottle', headers=HM, json={'size_ml': 1000})
    ob = open_list(TBS)
    check('2a. a 1000 ml bottle opens as 1000 ml (the product says 750)',
          r.status_code == 200 and stock(TBS) == 1000 and (r.get_json() or {}).get('ml_added') == 1000,
          f'{r.status_code} {stock(TBS)}')
    check('2b. ... the bottles the books said were empty were closed; one open record of 1000 ml',
          [float(x.size_ml) for x in ob] == [1000.0], f'{[float(x.size_ml) for x in ob]}')
    r = client.post(f'/api/v1/inventory/{item(TB).id}/open-bottle', headers=HM, json={'size_ml': 20})
    check('2c. an impossible size is refused (422)', r.status_code == 422, f'{r.status_code}')

    t = Ticket(ticket_type='EXPRESS', resource_id=None, opened_by=adm.id, status='OPEN', version=1)
    db.session.add(t)
    db.session.commit()
    menu = scalar("SELECT id FROM menu_items WHERE name = 'Tequila Blanco Shot'")
    r = client.post(f'/api/v1/tickets/{t.id}/items', headers=HA, json={'menu_item_id': menu, 'quantity': 3})
    if r.status_code == 201 and TicketLineItem.query.get(r.get_json()['id']).status == 'STAGED':
        client.post(f'/api/v1/tickets/{t.id}/send-order', headers=HA)
    check('2d. 3 shots sold: 1000 -> 850 ml', stock(TBS) == 850, f'{stock(TBS)}')

    print("\n== 3. the count sheet is blind ==")
    r = client.get('/api/v1/inventory/bar-count', headers=HM)
    sheet = (r.get_json() or {}).get('spirits', [])
    tb = next((s for s in sheet if s['shot_item_id'] == item(TBS).id), None)
    check('3a. a manager gets the sheet with the open bottles and their size',
          r.status_code == 200 and tb is not None and [b['size_ml'] for b in tb['open_bottles']] == [1000.0])
    flat = str(sheet)
    check('3b. ... and nothing the system expects (no stock, no estimate)',
          'pooled_ml' not in flat and 'expected_ml' not in flat and "'sealed'" not in flat)

    print("\n== 4. posting a count ==")
    sealed0 = stock(TB)
    bid = tb['open_bottles'][0]['id']
    base = {'shot_item_id': item(TBS).id}
    r = client.post('/api/v1/inventory/bar-count', headers=HM, json={'spirits': [{**base, 'bottles': [], 'sealed': 1}]})
    check('4a. leaving an open bottle out is refused (422)', r.status_code == 422, f'{r.status_code}')
    r = client.post('/api/v1/inventory/bar-count', headers=HM,
                    json={'spirits': [{**base, 'bottles': [{'id': bid, 'ml': 1200}], 'sealed': 1}]})
    check('4b. more ml than the bottle holds is refused (422)', r.status_code == 422)
    r = client.post('/api/v1/inventory/bar-count', headers=HM,
                    json={'spirits': [{**base, 'bottles': [{'id': bid, 'fraction': 'HALF'}], 'sealed': 1.5}]})
    check('4c. half a sealed bottle is refused (422)', r.status_code == 422)

    cost_ml = Decimal(item(TBS).unit_cost_cents)
    r = client.post('/api/v1/inventory/bar-count', headers=HM, json={
        'spirits': [{**base, 'bottles': [{'id': bid, 'fraction': 'HALF'}], 'sealed': int(sealed0) - 1}],
        'notes': 'cierre test'})
    j = r.get_json() or {}
    check('4d. a manager posts the count and gets only "Conteo guardado" (no differences)',
          r.status_code == 201 and j.get('message') == 'Conteo guardado' and 'lines' not in j
          and 'total_variance_cents' not in j, f'{r.status_code} {j}')
    check('4e. the open stock is now what was counted: half of 1000 = 500 ml (was 850)', stock(TBS) == 500)
    check('4f. the sealed bottles too: one fewer than the books', stock(TB) == sealed0 - 1)
    lines = db.session.execute(text("""SELECT kind, expected_qty, counted_qty, variance_qty, variance_cents
        FROM bar_count_lines WHERE bar_count_id = :c ORDER BY kind DESC"""), {'c': j.get('id')}).all()
    op = next((l for l in lines if l.kind == 'OPEN'), None)
    check('4g. the line records 850 expected, 500 counted, -350 ml, valued at cost',
          op is not None and Decimal(op.expected_qty) == 850 and Decimal(op.counted_qty) == 500
          and Decimal(op.variance_qty) == -350
          and op.variance_cents == int((Decimal(-350) * cost_ml).to_integral_value(rounding='ROUND_HALF_UP')),
          f'{op and tuple(op)} @ {cost_ml}/ml')
    mv = db.session.execute(text("""SELECT event_type, quantity_delta, reason FROM inventory_movements
        WHERE inventory_item_id = :i ORDER BY seq DESC LIMIT 1"""), {'i': item(TBS).id}).one()
    check('4h. ... and the ledger got a COUNT_ADJUSTMENT of -350',
          mv.event_type == 'COUNT_ADJUSTMENT' and Decimal(mv.quantity_delta) == -350 and 'Conteo de barra' in (mv.reason or ''),
          f'{tuple(mv)}')

    print("\n== 5. an empty bottle is closed ==")
    r = client.post('/api/v1/inventory/bar-count', headers=HA, json={
        'spirits': [{**base, 'bottles': [{'id': bid, 'fraction': 'EMPTY'}], 'sealed': int(stock(TB))}]})
    j = r.get_json() or {}
    check('5a. the owner posts and sees the differences right away',
          r.status_code == 201 and isinstance(j.get('lines'), list) and j.get('total_variance_cents') is not None)
    check('5b. a bottle counted "Vacía" is closed and leaves the next sheet', open_list(TBS) == [] and stock(TBS) == 0)

    print("\n== 6. the owner's history ==")
    r = client.get('/api/v1/inventory/bar-counts', headers=HM)
    check('6a. a manager cannot see count differences (403)', r.status_code == 403)
    from app.services.venue_svc import business_today
    with app.test_request_context():
        today = business_today().isoformat()
    r = client.get(f'/api/v1/inventory/bar-counts?from={today}&to={today}', headers=HA)
    h = r.get_json() or {}
    mine = [c for c in h.get('counts', []) if c.get('notes') == 'cierre test']
    check('6b. the owner sees the count, who did it, and the pesos',
          r.status_code == 200 and mine and mine[0]['counted_by'] == mgr.name
          and mine[0]['total_variance_cents'] == sum(int(l.variance_cents) for l in lines), f'{mine and mine[0]["total_variance_cents"]}')
    now = next((s for s in h.get('now', []) if s['shot_item_id'] == item('Vodka Shot').id), None)
    check('6c. ... and what is open now, with the system\'s estimate per bottle',
          now is not None and 'pooled_ml' in now and all('expected_ml' in b for b in now['open_bottles']))

    check('7a. no ledger violations', scalar("SELECT count(*) FROM ledger_violations WHERE resolved_at IS NULL") == viol0)
    t.status = 'CANCELLED'
    db.session.commit()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
