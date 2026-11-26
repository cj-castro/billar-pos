"""Batch E4 -- every purchase carries its price -- against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_purchase_price
"""
import json
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

    def restock(name, h=HM, **body):
        return client.post(f'/api/v1/inventory/{item(name).id}/restock', headers=h, json=body)

    corona = item('Corona')
    from app.services import cost_svc
    cost_svc.set_cost(corona.id, purchase_cost_cents=44400, pack_size=24, reason='test E4')   # $18.50
    corona = item('Corona')
    corona.purchase_pack_size = 24
    db.session.commit()
    s0 = Decimal(item('Corona').stock_quantity)

    print("== 1. no purchase without its price ==")
    r = restock('Corona', purchase_quantity=1, unit_cost_per_purchase_unit_cents=0)
    check('1a. a case at $0 is refused (422 PRICE_REQUIRED)',
          r.status_code == 422 and r.get_json()['error'] == 'PRICE_REQUIRED', f'{r.status_code}')
    r = restock('Corona', purchase_quantity=1)
    check('1b. a case with no price is refused', r.status_code == 422 and r.get_json()['error'] == 'PRICE_REQUIRED')
    food = scalar("SELECT name FROM inventory_items WHERE category = 'food' AND is_active LIMIT 1")
    r = restock(food, portion_count=10)
    check('1c. a food batch with no total cost is refused', r.status_code == 422, f'{food} {r.status_code}')
    check('1d. ... and nothing entered stock', Decimal(item('Corona').stock_quantity) == s0)
    r = client.post('/api/v1/inventory', headers=HA, json={
        'name': 'Prueba Sin Precio', 'category': 'beer', 'base_unit_key': 'botella', 'stock_quantity': 12})
    check('1e. a new item WITH starting stock needs its price (422)', r.status_code == 422
          and r.get_json()['error'] == 'PRICE_REQUIRED', f'{r.status_code}')
    r = client.post('/api/v1/inventory', headers=HA, json={
        'name': 'Prueba Sin Existencia', 'category': 'beer', 'base_unit_key': 'botella'})
    check('1f. ... without stock it is fine: the price comes with the first purchase', r.status_code == 201)

    print("\n== 2. normal purchases ==")
    r = restock('Corona', purchase_quantity=2, unit_cost_per_purchase_unit_cents=45600)   # $19 / bottle
    check('2a. 2 cases at a normal price: 200, +48 bottles', r.status_code == 200
          and Decimal(item('Corona').stock_quantity) == s0 + 48, f'{r.status_code}')
    r = restock('Prueba Sin Existencia', purchase_quantity=6, unit_cost_per_purchase_unit_cents=2500)
    check('2b. first purchase of an item with no cost yet: no question, sets its cost', r.status_code == 200
          and Decimal(item('Prueba Sin Existencia').unit_cost_cents) == 2500)

    print("\n== 3. a price far from the last one asks first ==")
    s1 = Decimal(item('Corona').stock_quantity)
    r = restock('Corona', purchase_quantity=1, unit_cost_per_purchase_unit_cents=456000)   # $190 / bottle (typo)
    j = r.get_json() or {}
    check('3a. 10x the usual price -> 409 PRICE_CHECK with the last price in the message',
          r.status_code == 409 and j.get('error') == 'PRICE_CHECK' and '$18' in j.get('message', ''), f"{j.get('message')}")
    check('3b. ... and nothing was recorded', Decimal(item('Corona').stock_quantity) == s1)
    r = restock('Corona', purchase_quantity=1, unit_cost_per_purchase_unit_cents=4560)     # $1.90 / bottle
    check('3c. 10x cheaper asks too', r.status_code == 409)
    r = restock('Corona', purchase_quantity=0.5, unit_cost_per_purchase_unit_cents=456000)
    check('3d. an invalid quantity is reported first (not the price question)',
          r.status_code == 422, f'{r.status_code} {(r.get_json() or {}).get("message")}')
    r = restock('Corona', purchase_quantity=1, unit_cost_per_purchase_unit_cents=456000, confirm_price=True)
    check('3e. confirmed: recorded', r.status_code == 200 and Decimal(item('Corona').stock_quantity) == s1 + 24)
    a = db.session.execute(text("""SELECT after_state FROM audit_log WHERE action = 'INVENTORY_RESTOCK'
        AND entity_id = :i ORDER BY created_at DESC LIMIT 1"""), {'i': item('Corona').id}).scalar()
    a = a if isinstance(a, dict) else json.loads(a or '{}')
    check('3f. ... and the audit says the price was confirmed', a.get('price_confirmed') is True, f'{a}')

    print("\n== 4. goods that came free: owner only, with a reason ==")
    s2 = Decimal(item('Corona').stock_quantity)
    r = restock('Corona', purchase_quantity=1, sin_costo=True, reason='cortesía')
    check('4a. a manager cannot enter free goods (403)', r.status_code == 403, f'{r.status_code}')
    r = restock('Corona', h=HA, purchase_quantity=1, sin_costo=True)
    check('4b. the owner must say why (422)', r.status_code == 422 and r.get_json()['error'] == 'REASON_REQUIRED')
    r = restock('Corona', h=HA, purchase_quantity=1, sin_costo=True, reason='1 caja de cortesía de la cervecería')
    check('4c. owner + reason: recorded at $0 (+24)', r.status_code == 200 and Decimal(item('Corona').stock_quantity) == s2 + 24,
          f'{r.status_code}')
    fr = db.session.execute(text("""SELECT reason FROM audit_log WHERE action = 'INVENTORY_RESTOCK_FREE'
        AND entity_id = :i ORDER BY created_at DESC LIMIT 1"""), {'i': item('Corona').id}).scalar()
    check('4d. audited as INVENTORY_RESTOCK_FREE with the reason', fr and 'cortesía' in fr, f'{fr}')
    mv = db.session.execute(text("""SELECT event_type, purchase_cost_cents, reason FROM inventory_movements
        WHERE inventory_item_id = :i ORDER BY seq DESC LIMIT 1"""), {'i': item('Corona').id}).one()
    check('4e. the ledger row is a RESTOCK paid $0 carrying the reason (free goods lower the average cost)',
          mv.event_type == 'RESTOCK' and mv.purchase_cost_cents == 0 and 'cortesía' in (mv.reason or ''),
          f'{tuple(mv)}')

    print("\n== 5. purchase unit vs stock unit (no silent 1) ==")
    base = {'category': 'beer', 'base_unit_key': 'botella', 'purchase_unit_key': 'caja',
            'stock_quantity': 12, 'purchase_cost_cents': 38000}
    r = client.post('/api/v1/inventory', headers=HA, json={**base, 'name': 'Prueba Caja De Uno', 'purchase_pack_size': 1})
    check('5a. your screenshot: stocked by botella, bought by caja "of 1" -> refused, asks how many',
          r.status_code == 422 and r.get_json()['error'] == 'PACK_REQUIRED'
          and '¿Cuántas botellas trae la caja?' in r.get_json()['message'], f"{r.status_code} {(r.get_json() or {}).get('message')}")
    r = client.post('/api/v1/inventory', headers=HA, json={**base, 'name': 'Prueba Caja De 24', 'purchase_pack_size': 24})
    check('5b. a case of 24 at $380 -> $15.83 per bottle',
          r.status_code == 201 and abs(Decimal(str(item('Prueba Caja De 24').unit_cost_cents)) - Decimal('1583.3333')) < Decimal('0.001'),
          f"{r.status_code} {item('Prueba Caja De 24') and item('Prueba Caja De 24').unit_cost_cents}")
    r = client.post('/api/v1/inventory', headers=HA, json={**base, 'name': 'Prueba Caja Caja', 'base_unit_key': 'caja',
                                                          'purchase_pack_size': 60})
    check('5c. stocked AND bought by caja but "60 per caja" -> refused (PACK_SAME_UNIT)',
          r.status_code == 422 and r.get_json()['error'] == 'PACK_SAME_UNIT', f'{r.status_code}')
    pac = item('Pacifico')
    r = client.patch(f'/api/v1/inventory/{pac.id}', headers=HA, json={'purchase_unit_key': 'caja', 'purchase_pack_size': 1})
    check('5d. editing an item into "caja of 1 botella" is refused', r.status_code == 422, f'{r.status_code}')
    papas = scalar("SELECT name FROM inventory_items WHERE base_unit_key = purchase_unit_key AND purchase_pack_size > 1 LIMIT 1")
    if papas:
        it = item(papas)
        r = client.patch(f'/api/v1/inventory/{it.id}', headers=HA, json={
            'name': it.name, 'base_unit_key': it.base_unit_key, 'purchase_unit_key': it.purchase_unit_key,
            'purchase_pack_size': float(it.purchase_pack_size), 'low_stock_threshold': float(it.low_stock_threshold or 0)})
        check(f'5e. an old inconsistent item ({papas}) stays editable when its units are not touched',
              r.status_code == 200, f'{r.status_code}')
    r = restock('Pacifico', purchase_quantity=1, unit_cost_per_purchase_unit_cents=45600, pack_size_override=1)
    check('5f. a restock "case of 1" for a bottle item is refused', r.status_code == 422
          and r.get_json()['error'] == 'PACK_REQUIRED', f'{r.status_code}')
    check('5g. after 052 no active item is bought in another unit by the "1"',
          scalar("""SELECT count(*) FROM inventory_items WHERE is_active AND purchase_unit_key IS NOT NULL
                    AND purchase_unit_key <> base_unit_key AND COALESCE(purchase_pack_size, 1) <= 1""") == 0)
    check('5h. ... and every bottle that opens is counted in botellas',
          scalar("""SELECT count(*) FROM inventory_items i JOIN inventory_conversions c ON c.from_item_id = i.id
                    WHERE c.is_active AND c.conversion_type = 'BOTTLE_TO_SHOT' AND i.base_unit_key <> 'botella'""") == 0)

    pap = item('Papas Doradas Caseras')
    if pap is not None:
        p0 = Decimal(pap.stock_quantity)
        check('5i. Papas Doradas: stocked by pieza, bought by caja of 60 (053; stock untouched)',
              pap.base_unit_key == 'pieza' and pap.purchase_unit_key == 'caja' and Decimal(pap.purchase_pack_size) == 60)
        r = restock('Papas Doradas Caseras', purchase_quantity=1, unit_cost_per_purchase_unit_cents=80000)
        check('5j. restocking 1 caja at $800 adds 60 pieces at $13.33 each, no price question',
              r.status_code == 200 and Decimal(item('Papas Doradas Caseras').stock_quantity) == p0 + 60
              and abs(Decimal(item('Papas Doradas Caseras').unit_cost_cents) - Decimal('1333.33')) < 1,
              f"{r.status_code} {item('Papas Doradas Caseras').unit_cost_cents}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
