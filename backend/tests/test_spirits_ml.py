"""Batch E2 step 1 -- opened spirits in ml -- against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Expects 040-049. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_spirits_ml
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
    H = {'Authorization': 'Bearer ' + create_access_token(
        identity=adm.id, additional_claims={'role': 'ADMIN', 'name': adm.name})}

    def item(name):
        db.session.expire_all()
        return InventoryItem.query.filter_by(name=name).first()

    def stock(name):
        return Decimal(item(name).stock_quantity)

    def count_to(name, qty):
        db.session.execute(text("SELECT fn_count_adjustment(:i, :q, :u, 'test E2')"),
                           {'i': item(name).id, 'q': qty, 'u': adm.id})
        db.session.commit()

    def restock(name, n, cost=30000):
        client.post(f'/api/v1/inventory/{item(name).id}/restock', headers=H,
                    json={'purchase_quantity': n, 'unit_cost_per_purchase_unit_cents': cost})

    def menu_id(name):
        return scalar("SELECT id FROM menu_items WHERE name = :n", n=name)

    def sell(ticket_id, menu_name, qty=1):
        r = client.post(f'/api/v1/tickets/{ticket_id}/items', headers=H,
                        json={'menu_item_id': menu_id(menu_name), 'quantity': qty})
        j = r.get_json() or {}
        if r.status_code == 201 and TicketLineItem.query.get(j['id']).status == 'STAGED':
            r = client.post(f'/api/v1/tickets/{ticket_id}/send-order', headers=H)
        return r, j

    print("== 1. the migration converted exactly ==")
    ml_items = db.session.execute(text("""
        SELECT i.id, i.name, i.stock_quantity, i.portion_size,
               (SELECT m.quantity_after FROM inventory_movements m WHERE m.inventory_item_id = i.id
                  AND m.quantity_after IS NOT NULL ORDER BY m.seq DESC LIMIT 1) AS last_after
        FROM inventory_items i
        WHERE EXISTS (SELECT 1 FROM inventory_conversions c WHERE c.to_item_id = i.id
                       AND c.conversion_type = 'BOTTLE_TO_SHOT')""")).all()
    check('1a. every open-spirit item is in ml with a 50 ml pour',
          ml_items and all(scalar("SELECT base_unit_key FROM inventory_items WHERE id=:i", i=r.id) == 'ml'
                           and r.portion_size == 50 for r in ml_items), f'{len(ml_items)} items')
    check('1b. ... and its ledger still ends at its stock',
          all(r.last_after is None or Decimal(r.last_after) == Decimal(r.stock_quantity) for r in ml_items))
    check('1c. bottles convert 750 ml',
          scalar("SELECT bool_and(ratio = 750) FROM inventory_conversions WHERE conversion_type='BOTTLE_TO_SHOT'"))
    azu = {r.name: Decimal(r.quantity) for r in db.session.execute(text("""
        SELECT ii.name, ib.quantity FROM insumos_base ib JOIN inventory_items ii ON ii.id = ib.inventory_item_id
        WHERE ib.menu_item_id = :m AND ii.base_unit_key = 'ml'"""), {'m': menu_id('Azulito')}).all()}
    check('1d. Azulito: 50 ml vodka + 50 ml Curazao (what "1 shot each" meant)',
          azu == {'Vodka Shot': 50, 'Curazao Azul Shot': 50}, f'{azu}')
    check('1e. no ledger violations', scalar("SELECT count(*) FROM ledger_violations WHERE resolved_at IS NULL") == 0)

    print("\n== 2. Azulito with a real splash of Curazao ==")
    for b in ('Vodka Bottle', 'Curazao Azul Bottle'):
        restock(b, 1, 16000)
    count_to('Vodka Shot', 0)
    count_to('Curazao Azul Shot', 0)
    for b in ('Vodka Bottle', 'Curazao Azul Bottle'):
        client.post(f"/api/v1/inventory/{item(b).id}/open-bottle", headers=H)
    r = client.post('/api/v1/inventory/insumos-base', headers=H, json={
        'menu_item_id': menu_id('Azulito'), 'inventory_item_id': item('Curazao Azul Shot').id, 'quantity': 20})
    check('2a. the recipe takes 20 ml of Curazao (a splash) -- impossible in whole shots',
          r.status_code in (200, 201), f'{r.status_code} {r.get_json()}')
    restock('Sprite', 5, 1500) if item('Sprite').item_type != 'BOTTLE' else None
    t = Ticket(ticket_type='EXPRESS', resource_id=None, opened_by=adm.id, status='OPEN', version=1)
    db.session.add(t)
    db.session.commit()
    v0, c0 = stock('Vodka Shot'), stock('Curazao Azul Shot')
    r, j = sell(t.id, 'Azulito')
    check('2b. one Azulito: vodka -50 ml, Curazao -20 ml',
          r.status_code in (200, 201) and stock('Vodka Shot') == v0 - 50 and stock('Curazao Azul Shot') == c0 - 20,
          f"{r.status_code} vodka {v0}->{stock('Vodka Shot')} curazao {c0}->{stock('Curazao Azul Shot')}")
    cost = db.session.execute(text("""
        SELECT ii.name, sic.quantity_deducted, sic.total_cost_cents FROM sale_item_costs sic
        JOIN inventory_items ii ON ii.id = sic.inventory_item_id WHERE sic.ticket_line_item_id = :l"""),
        {'l': j.get('id')}).all()
    cur = next((x for x in cost if x.name == 'Curazao Azul Shot'), None)
    check('2c. Curazao costs 20 ml worth: 16000/750 x 20 = 427 centavos (was a full shot, 1067)',
          cur is not None and cur.total_cost_cents == 427, f'{[tuple(x) for x in cost]}')
    check('2d. so one Curazao bottle now lasts 37 Azulitos instead of 15', int(750 // 20) == 37)

    print("\n== 3. shots, doubles, 2x1 ==")
    restock('Tequila Blanco Bottle', 2)
    count_to('Tequila Blanco Shot', 0)
    client.post(f"/api/v1/inventory/{item('Tequila Blanco Bottle').id}/open-bottle", headers=H)
    s0 = stock('Tequila Blanco Shot')
    r, j = sell(t.id, 'Tequila Blanco Shot', qty=2)
    check('3a. 2 shots on one line (e.g. a 2x1): -100 ml -- the promo changes the price, never the pour',
          r.status_code in (200, 201) and stock('Tequila Blanco Shot') == s0 - 100, f"{s0}->{stock('Tequila Blanco Shot')}")

    print("\n== 4. opening rules in ml ==")
    count_to('Tequila Blanco Shot', 100)                      # 2 shots left
    r = client.post(f"/api/v1/inventory/{item('Tequila Blanco Bottle').id}/open-bottle", headers=H)
    jj = r.get_json() or {}
    check('4a. 100 ml left -> 409 "Todavía quedan 2 shots (100 ml)"',
          r.status_code == 409 and jj.get('remaining') == 2 and jj.get('remaining_ml') == 100
          and 'Todavía quedan 2 shots (100 ml)' in jj.get('message', ''), f'{r.status_code} {jj}')
    count_to('Tequila Blanco Shot', 30)                       # less than one pour
    r, _ = sell(t.id, 'Tequila Blanco Shot')
    check('4b. 30 ml left: a 50 ml shot cannot be sold (no auto-open)', r.status_code == 422, f'{r.status_code}')
    r = client.post(f"/api/v1/inventory/{item('Tequila Blanco Bottle').id}/open-bottle", headers=H)
    check('4c. ... and opening needs no question (less than a shot left): 30 + 750 = 780 ml',
          r.status_code == 200 and stock('Tequila Blanco Shot') == 780
          and (r.get_json() or {}).get('shots_added') == 15, f'{r.status_code} {stock("Tequila Blanco Shot")}')
    r, _ = sell(t.id, 'Tequila Blanco Shot')
    check('4d. the shot finishes the old bottle from the new one: 780 -> 730',
          r.status_code in (200, 201) and stock('Tequila Blanco Shot') == 730)

    print("\n== 5. configuring a bottle ==")
    r = client.post('/api/v1/inventory', headers=H, json={
        'name': 'Ron Prueba Litro Botella', 'category': 'spirit', 'item_type': 'BOTTLE',
        'base_unit_key': 'botella', 'stock_quantity': 1, 'purchase_cost_cents': 40000,
        'bottle_ml': 1000, 'pour_ml': 40})
    b = r.get_json() or {}
    child = item('Ron Prueba Litro Shot')
    check('5a. a 1 L bottle with a 40 ml pour: 25 shots, open item in ml with pour 40',
          r.status_code == 201 and b.get('bottle_ml') == 1000 and b.get('shots_per_bottle') == 25
          and child is not None and child.base_unit_key == 'ml' and child.portion_size == 40,
          f'{r.status_code} {b.get("bottle_ml")} {b.get("shots_per_bottle")}')
    r = client.post(f"/api/v1/inventory/{b.get('id')}/open-bottle", headers=H)
    check('5b. it opens: +1000 ml = 25 shots', r.status_code == 200
          and (r.get_json() or {}).get('ml_added') == 1000 and (r.get_json() or {}).get('shots_added') == 25)
    r = client.patch(f"/api/v1/inventory/{b.get('id')}", headers=H, json={'bottle_ml': 1000, 'pour_ml': 2000})
    check('5c. a pour bigger than the bottle is refused (422)', r.status_code == 422, f'{r.status_code}')
    r = client.patch(f"/api/v1/inventory/{b.get('id')}", headers=H, json={'bottle_ml': 1000, 'pour_ml': 50})
    check('5d. changing the pour to 50 ml: 20 shots per bottle',
          r.status_code == 200 and item('Ron Prueba Litro Botella').shots_per_bottle == 20
          and item('Ron Prueba Litro Shot').portion_size == 50, f'{r.status_code}')

    clam = item('Clamato')
    check('5e. Clamato (ml, 150 ml serving) is NOT treated as a shot',
          clam is None or clam.to_dict().get('pour_ml') is None,
          f"{clam and clam.to_dict().get('pour_ml')}")
    check('5f. ... while an open spirit is (50 ml)', item('Vodka Shot').to_dict().get('pour_ml') == 50)

    print("\n== 6. Inicio asks to open a bottle with less than a shot left ==")
    count_to('Tequila Blanco Shot', 30)
    home = client.get('/api/v1/home', headers=H).get_json() or {}
    abrir = [x['producto'] for x in (home.get('pendientes') or {}).get('por_abrir', [])]
    check('6a. "Tequila Blanco Shot" (30 ml, sealed bottle on the shelf) is in "por abrir"',
          'Tequila Blanco Shot' in abrir, f'{abrir}')

    t.status = 'CANCELLED'
    db.session.commit()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
