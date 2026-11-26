"""Batch E8 -- portioning in house (raw kg -> packs) -- against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Expects 040-056. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_portioning
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
from app.models.ticket import TicketLineItem  # noqa: E402
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
    from app.analytics_views import ensure_analytics_views
    ensure_analytics_views(db)
    db.session.commit()
    adm = User.query.filter_by(role='ADMIN', is_active=True).first()
    mgr = User.query.filter_by(role='MANAGER', is_active=True).first()

    def tok(u, role):
        return {'Authorization': 'Bearer ' + create_access_token(
            identity=u.id, additional_claims={'role': role, 'name': u.name})}
    HA, HM = tok(adm, 'ADMIN'), tok(mgr, 'MANAGER')

    def item(name):
        db.session.expire_all()
        return InventoryItem.query.filter_by(name=name).first()

    viol0 = scalar("SELECT count(*) FROM ledger_violations WHERE resolved_at IS NULL")
    a3, a7 = item('Alitas 300gr'), item('Alitas 700gr')
    s3, s7 = Decimal(a3.stock_quantity), Decimal(a7.stock_quantity)

    print("== 1. set up: raw by the case, packs linked to it ==")
    r = client.post('/api/v1/inventory', headers=HA, json={
        'name': 'Alitas crudas', 'category': 'food', 'base_unit_key': 'kilogramo',
        'purchase_unit_key': 'caja', 'purchase_pack_size': 15})
    raw_id = (r.get_json() or {}).get('id')
    check('1a. raw item "Alitas crudas" in kg, bought by the case of 15 kg', r.status_code == 201, f'{r.status_code} {r.get_json()}')
    r = client.post(f'/api/v1/inventory/{raw_id}/restock', headers=HA,
                    json={'purchase_quantity': 2, 'unit_cost_per_purchase_unit_cents': 150000})
    raw = item('Alitas crudas')
    check('1b. 2 cases at $1,500 -> 30 kg at $100.00/kg', r.status_code == 200 and Decimal(raw.stock_quantity) == 30
          and Decimal(raw.unit_cost_cents) == 10000, f'{r.status_code} {raw.stock_quantity} @ {raw.unit_cost_cents}')
    for it, g in ((a3, 300), (a7, 700)):
        r = client.patch(f'/api/v1/inventory/{it.id}', headers=HA, json={'portion_source_id': raw_id, 'portion_size': g})
        check(f'1c. "{it.name}" is a {g} g pack of Alitas crudas', r.status_code == 200, f'{r.status_code} {r.get_json()}')
    a3, a7 = item('Alitas 300gr'), item('Alitas 700gr')
    check('1d. ... counted in paquetes, the count untouched',
          a3.base_unit_key == 'paquete' and a7.stock_nature == 'PORTION'
          and Decimal(a3.stock_quantity) == s3 and Decimal(a7.stock_quantity) == s7)
    r = client.post(f'/api/v1/inventory/{a3.id}/restock', headers=HA,
                    json={'purchase_quantity': 10, 'unit_cost_per_purchase_unit_cents': 3000})
    check('1e. packs cannot be restocked by hand: they come from portioning', r.status_code == 422
          and 'Porcionar' in (r.get_json() or {}).get('message', ''), f'{r.status_code}')

    print("\n== 2. 🔪 Porcionar one case ==")
    out = [{'item_id': a7.id, 'packs': 14}, {'item_id': a3.id, 'packs': 12}]
    r = client.post(f'/api/v1/inventory/{raw_id}/portion', headers=HA, json={'raw_used': 15, 'outputs': out})
    j = r.get_json() or {}
    check('2a. 15 kg -> 14 x 700 g + 12 x 300 g = 13.4 kg in packs, 1.6 kg waste, yield 89.33%',
          r.status_code == 201 and j['output_g'] == 13400 and j['waste_g'] == 1600 and j['yield_pct'] == 89.33,
          f"{r.status_code} {j.get('message') or (j.get('output_g'), j.get('waste_g'), j.get('yield_pct'))}")
    a3, a7, raw = item('Alitas 300gr'), item('Alitas 700gr'), item('Alitas crudas')
    check('2b. raw 30 -> 15 kg; packs +12 and +14', Decimal(raw.stock_quantity) == 15
          and Decimal(a3.stock_quantity) == s3 + 12 and Decimal(a7.stock_quantity) == s7 + 14)
    p7 = next(o for o in j['outputs'] if o['item_id'] == a7.id)['pack_cost_cents']
    p3 = next(o for o in j['outputs'] if o['item_id'] == a3.id)['pack_cost_cents']
    check('2c. the case\'s $1,500 spread by weight over the packs: 700 g = $78.36, 300 g = $33.58 (waste included)',
          abs(p7 - 7835.8209) < 0.01 and abs(p3 - 3358.2090) < 0.01, f'{p7} {p3}')
    mv = db.session.execute(text("""SELECT i.name, m.event_type, m.quantity_delta, m.unit_cost_cents
        FROM inventory_movements m JOIN inventory_items i ON i.id = m.inventory_item_id
        WHERE m.reason LIKE 'Porcionado #%' ORDER BY m.seq"""), {}).all()
    check('2d. ledger: PRODUCTION_CONSUME -15 kg on the raw, PRODUCTION_YIELD on each pack (an internal move)',
          [(x.event_type, Decimal(x.quantity_delta)) for x in mv[-3:]][0] == ('PRODUCTION_CONSUME', Decimal(-15))
          and {x.event_type for x in mv[-2:]} == {'PRODUCTION_YIELD'}, f'{[tuple(x) for x in mv[-3:]]}')

    print("\n== 3. guards ==")
    r = client.post(f'/api/v1/inventory/{raw_id}/portion', headers=HA,
                    json={'raw_used': 1, 'outputs': [{'item_id': a7.id, 'packs': 5}]})
    check('3a. more grams in packs than came in (3.5 kg from 1 kg) is refused', r.status_code == 422
          and r.get_json()['error'] == 'TOO_MUCH')
    r = client.post(f'/api/v1/inventory/{raw_id}/portion', headers=HA,
                    json={'raw_used': 20, 'outputs': [{'item_id': a7.id, 'packs': 5}]})
    check('3b. using more raw than there is is refused', r.status_code == 422 and r.get_json()['error'] == 'NO_STOCK')
    r = client.post(f'/api/v1/inventory/{raw_id}/portion', headers=HA,
                    json={'raw_used': 2, 'outputs': [{'item_id': a7.id, 'packs': 1.5}]})
    check('3c. half a pack is refused', r.status_code == 422)
    corona = item('Corona')
    r = client.post(f'/api/v1/inventory/{raw_id}/portion', headers=HA,
                    json={'raw_used': 2, 'outputs': [{'item_id': corona.id, 'packs': 1}]})
    check('3d. only its own packs can come out of a raw item', r.status_code == 422)
    r = client.post(f'/api/v1/inventory/{raw_id}/portion', headers=HM,
                    json={'raw_used': 0.7, 'outputs': [{'item_id': a7.id, 'packs': 1}]})
    j = r.get_json() or {}
    check('3e. a manager can portion but does not see costs', r.status_code == 201
          and j.get('input_cost_cents') is None and j['outputs'][0]['pack_cost_cents'] is None)

    print("\n== 4. selling, reports, purchase forecast ==")
    if not scalar("SELECT 1 FROM cash_sessions WHERE status = 'OPEN'"):
        db.session.execute(text("""INSERT INTO cash_sessions (id, date, status, opening_fund_cents, opened_by, opened_at)
                                   VALUES (gen_random_uuid()::text, CURRENT_DATE, 'OPEN', 0, :u, now())"""), {'u': adm.id})
        db.session.commit()
    t = client.post('/api/v1/tickets', headers=HA, json={'ticket_type': 'EXPRESS', 'customer_name': 'prueba alitas'}).get_json()['id']
    st7 = Decimal(item('Alitas 700gr').stock_quantity)
    menu7 = scalar("SELECT id FROM menu_items WHERE name = 'Alitas 700gr'")
    # wings need a flavor; prefer one that deducts no sauce
    flavor = scalar("""
        SELECT mo.id FROM menu_item_modifier_groups mg
          JOIN modifier_groups g ON g.id = mg.modifier_group_id
          JOIN modifiers mo ON mo.modifier_group_id = g.id
         WHERE mg.menu_item_id = :m AND COALESCE(mo.is_active, TRUE)
         ORDER BY (SELECT count(*) FROM modifier_inventory_rules r WHERE r.modifier_id = mo.id), mo.name
         LIMIT 1""", m=menu7)
    r = client.post(f'/api/v1/tickets/{t}/items', headers=HA,
                    json={'menu_item_id': menu7, 'quantity': 1, 'modifiers': [{'modifier_id': flavor}] if flavor else []})
    lid = r.get_json()['id']
    if TicketLineItem.query.get(lid).status == 'STAGED':
        client.post(f'/api/v1/tickets/{t}/send-order', headers=HA)
    cost = scalar("SELECT SUM(total_cost_cents) FROM sale_item_costs WHERE ticket_line_item_id = :l", l=lid)
    check('4a. selling Alitas 700gr deducts 1 pack, at the pack\'s portioned cost',
          Decimal(item('Alitas 700gr').stock_quantity) == st7 - 1 and cost and cost > 0, f'cost {cost}')
    r = client.get('/api/v1/inventory/portioning', headers=HM)
    check('4b. managers cannot see the portioning history (403)', r.status_code == 403)
    from app.services.venue_svc import business_today
    with app.test_request_context():
        today = business_today().isoformat()
    h = client.get(f'/api/v1/inventory/portioning?from={today}&to={today}', headers=HA).get_json()
    b = next((x for x in h['lotes'] if x['raw_used'] == 15), None)
    check('4c. the owner sees each batch: kg in, packs out, waste, yield, who',
          b is not None and b['yield_pct'] == 89.33 and len(b['salidas']) == 2 and b['por'] == adm.name)
    f = db.session.execute(text("SELECT * FROM v_purchase_forecast WHERE name = 'Alitas crudas'")).mappings().first()
    check('4d. purchase forecast: one line for the RAW item (packs are made, not bought)',
          f is not None and scalar("SELECT count(*) FROM v_purchase_forecast WHERE name IN ('Alitas 300gr','Alitas 700gr')") == 0
          and 'Alitas 700gr' in (f['producto_abierto'] or ''))
    a3, a7, raw = item('Alitas 300gr'), item('Alitas 700gr'), item('Alitas crudas')
    exp_disp = Decimal(raw.stock_quantity) + Decimal(a3.stock_quantity) * Decimal('0.3') + Decimal(a7.stock_quantity) * Decimal('0.7')
    check('4e. ... its stock = raw kg + packs on hand converted to kg',
          abs(Decimal(f['disponible']) - exp_disp) < Decimal('0.02'), f"{f['disponible']} vs {exp_disp}")
    check('5a. no ledger violations', scalar("SELECT count(*) FROM ledger_violations WHERE resolved_at IS NULL") == viol0)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
