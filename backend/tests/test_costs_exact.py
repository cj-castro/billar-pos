"""Cost entry done right (batch C0) -- checks against a SCRATCH database.

COMMITS. Refuses to run unless DATABASE_URL names a database containing
"scratch". Expects migrations 040-044. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_costs_exact

  1. 044: unit cost columns are NUMERIC(14,4); every dependent view still works
  2. per-ml cost is exact (catsup $120 / 3,780 ml = 3.1746 ¢/ml) and a recipe
     using 30 ml costs 95 ¢, not 90 ¢ as with whole-centavo rounding
  3. new item priced per CASE: $350 per case of 24 -> 1458.3333 ¢ per can
  4. Costos: first cost from a case price, with a one-off pack size override
  5. corrections: refused without a reason, applied with one, audited, and a
     bottle's correction re-prices its shots
  6. "Costos a revisar" flags counted items under $1 (e.g. a $0.91 box)
  7. bottle -> shots conversion keeps the precision
  8. API returns costs as numbers, not strings
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
from app.models.user import User  # noqa: E402
from app.services import inventory_svc  # noqa: E402

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


def cost(name):
    db.session.expire_all()
    return Decimal(str(InventoryItem.query.filter_by(name=name).one().unit_cost_cents))


app = create_app()
app.config['TESTING'] = True
client = app.test_client()

with app.app_context():
    from app.analytics_views import ensure_analytics_views
    check('0. analytics views rebuild on top of 044', ensure_analytics_views(db) is True)
    admin = User.query.filter_by(role='ADMIN', is_active=True).first()
    mgr = User.query.filter_by(role='MANAGER', is_active=True).first()
    tok = lambda u: {'Authorization': 'Bearer ' + create_access_token(  # noqa: E731
        identity=u.id, additional_claims={'role': u.role, 'name': u.name})}
    HA, HM = tok(admin), tok(mgr)
    db.session.commit()

    # ── 1 ────────────────────────────────────────────────────────────────────
    print("== 1. schema ==")
    types = dict(db.session.execute(text("""
        SELECT table_name, data_type || ':' || numeric_scale FROM information_schema.columns
         WHERE column_name = 'unit_cost_cents'
           AND table_name IN ('inventory_items','inventory_movements','sale_item_costs')""")).all())
    check('1a. unit_cost_cents is numeric(14,4) on all three tables',
          set(types.values()) == {'numeric:4'} and len(types) == 3, f'{types}')
    broken = []
    for (v,) in db.session.execute(text("SELECT viewname FROM pg_views WHERE schemaname='public'")).all():
        try:
            with db.session.begin_nested():
                db.session.execute(text(f'SELECT 1 FROM public."{v}" LIMIT 1'))
        except Exception as exc:                          # noqa: BLE001
            broken.append((v, str(exc).splitlines()[0][:80]))
    db.session.rollback()
    check('1b. every view in the database still runs', not broken, f'{broken[:3]}')

    # ── 2 ────────────────────────────────────────────────────────────────────
    print("\n== 2. per-ml cost is exact ==")
    r = client.post('/api/v1/inventory', headers=HA, json={
        'name': 'Catsup Prueba', 'category': 'food', 'base_unit_key': 'ml',
        'purchase_unit_key': 'botella', 'purchase_pack_size': 3780,
        'purchase_cost_cents': 12000})
    check('2a. item bought as "$120 per 3,780 ml bottle"', r.status_code == 201, f'{r.status_code} {r.get_json()}')
    check('2b. stored unit cost = 12000 / 3780 = 3.1746 ¢/ml (was 3)',
          cost('Catsup Prueba') == Decimal('3.1746'), f"{cost('Catsup Prueba')}")
    catsup = InventoryItem.query.filter_by(name='Catsup Prueba').one()
    inventory_svc.restock_drinks(catsup.id, 1, 12000, admin.id)      # 1 bottle in stock
    db.session.commit()
    # a sale that uses 30 ml: exact unit cost x 30, rounded once
    from app.models.ticket import Ticket, TicketLineItem
    from app.models.inventory import InsumoBase
    from app.models.menu import MenuItem
    mi = MenuItem.query.filter_by(is_active=True).first()
    t = Ticket(ticket_type='EXPRESS', resource_id=None, opened_by=admin.id, status='OPEN', version=1)
    db.session.add(t); db.session.flush()
    li = TicketLineItem(ticket_id=t.id, menu_item_id=None, item_name='test', quantity=1,
                        unit_price_cents=100, routing_dest='BAR', status='SENT')
    db.session.add(li); db.session.flush()
    # consume 30 ml directly through the same code path a sale uses
    from app.models.inventory import SaleItemCost
    locked = inventory_svc._lock_sorted(catsup.id)
    wac = inventory_svc._exact_cost(locked[catsup.id].unit_cost_cents)
    total = inventory_svc._round_cents(Decimal(30) * wac)
    db.session.rollback()
    check('2c. 30 ml cost 95 ¢ (exact) instead of 90 ¢ (whole-centavo)', total == 95, f'{total}')

    # ── 3 ────────────────────────────────────────────────────────────────────
    print("\n== 3. new item priced per case ==")
    r = client.post('/api/v1/inventory', headers=HA, json={
        'name': 'Cerveza Prueba Lata', 'category': 'beer', 'base_unit_key': 'lata',
        'purchase_unit_key': 'caja', 'purchase_pack_size': 24,
        'purchase_cost_cents': 35000, 'stock_quantity': 24})
    j = r.get_json() or {}
    check('3a. $350 per case of 24 -> 1458.3333 ¢ per can',
          r.status_code == 201 and cost('Cerveza Prueba Lata') == Decimal('1458.3333'),
          f"{r.status_code} {cost('Cerveza Prueba Lata') if r.status_code == 201 else j}")
    check('3b. the case price is kept as the reference price',
          j.get('purchase_cost_cents') == 35000, f"{j.get('purchase_cost_cents')}")
    check('3c. API returns unit cost as a number', isinstance(j.get('unit_cost_cents'), (int, float)),
          f"{type(j.get('unit_cost_cents'))}")

    # ── 4 ────────────────────────────────────────────────────────────────────
    print("\n== 4. Costos: first cost from a case price ==")
    target = db.session.execute(text("""
        SELECT id, name FROM inventory_items
        WHERE is_active AND COALESCE(unit_cost_cents,0) = 0 AND base_unit_key IN ('botella','lata','pieza')
          AND NOT EXISTS (SELECT 1 FROM inventory_conversions c WHERE c.from_item_id = inventory_items.id)
        ORDER BY name LIMIT 1""")).first()
    r = client.post(f'/api/v1/inventory/{target.id}/set-cost', headers=HA,
                    json={'purchase_cost_cents': 28800, 'pack_size': 12})
    check('4a. "$288 per case, this time of 12" -> 2400 ¢ each, mode INICIAL',
          r.status_code == 200 and (r.get_json() or {}).get('mode') == 'INICIAL'
          and cost(target.name) == Decimal('2400.0000'), f'{target.name} {r.status_code} {cost(target.name)}')
    r = client.post(f'/api/v1/inventory/{target.id}/set-cost', headers=HM,
                    json={'purchase_cost_cents': 1000})
    check('4b. a MANAGER cannot set costs (ADMIN only)', r.status_code == 403, f'{r.status_code}')

    # ── 5 ────────────────────────────────────────────────────────────────────
    print("\n== 5. corrections ==")
    r = client.post(f'/api/v1/inventory/{target.id}/set-cost', headers=HA,
                    json={'purchase_cost_cents': 30000, 'pack_size': 12})
    check('5a. changing an existing cost WITHOUT a reason is refused (409)',
          r.status_code == 409 and cost(target.name) == Decimal('2400.0000'), f'{r.status_code}')
    r = client.post(f'/api/v1/inventory/{target.id}/set-cost', headers=HA,
                    json={'purchase_cost_cents': 30000, 'pack_size': 12,
                          'reason': 'precio de caja mal capturado'})
    check('5b. with a reason it is corrected (2500 ¢), mode CORRECCION',
          r.status_code == 200 and (r.get_json() or {}).get('mode') == 'CORRECCION'
          and cost(target.name) == Decimal('2500.0000'), f'{r.status_code} {cost(target.name)}')
    check('5c. the correction is audited with before, after and reason',
          scalar("""SELECT count(*) FROM audit_log WHERE action = 'INVENTORY_COST_CORRECTED'
                    AND entity_id = :i AND reason = 'precio de caja mal capturado'""", i=target.id) == 1)
    bottle = db.session.execute(text("""
        SELECT f.id, f.name, t.name AS child, c.ratio FROM inventory_conversions c
        JOIN inventory_items f ON f.id = c.from_item_id JOIN inventory_items t ON t.id = c.to_item_id
        WHERE c.is_active AND c.conversion_type = 'BOTTLE_TO_SHOT' ORDER BY f.name LIMIT 1""")).first()
    first = client.post(f'/api/v1/inventory/{bottle.id}/set-cost', headers=HA,
                        json={'unit_cost_cents': 29999, 'reason': 'prueba'})
    check('5d. correcting a bottle re-prices its shots: 29999 / 15 = 1999.9333',
          first.status_code == 200 and cost(bottle.child) == (Decimal(29999) / Decimal(bottle.ratio)).quantize(Decimal('0.0001')),
          f'{bottle.name}: shot {cost(bottle.child)}')

    # ── 6 ────────────────────────────────────────────────────────────────────
    print("\n== 6. suspicious costs are flagged ==")
    cc = client.get('/api/v1/analytics/cost-coverage', headers=HA).get_json()
    flagged = {i['insumo'] for i in cc['revisar']['insumos']}
    under_1 = {r[0] for r in db.session.execute(text("""
        SELECT ii.name FROM inventory_items ii JOIN unit_catalog u ON u.key = ii.base_unit_key
        WHERE ii.is_active AND ii.unit_cost_cents > 0 AND ii.unit_cost_cents < 100
          AND NOT u.allows_fraction""")).all()}
    check('6a. every counted item under $1 is listed for review', under_1 and under_1 <= flagged,
          f'{sorted(under_1)[:4]}')
    check('6b. measured items (ml) are never flagged for being cheap per ml',
          'Catsup Prueba' not in flagged)
    check('6c. rows carry how the item is bought (for case-price entry)',
          all('unidad_compra' in i and 'unidades_por_compra' in i for i in cc['insumos']))

    # ── 7 ────────────────────────────────────────────────────────────────────
    print("\n== 7. bottle -> shots keeps the precision ==")
    db.session.execute(text("SELECT fn_count_adjustment(:i, 0, :u, 'test')"),
                       {'i': scalar("SELECT id FROM inventory_items WHERE name = :n", n=bottle.child),
                        'u': admin.id})
    client.post(f'/api/v1/inventory/{bottle.id}/restock', headers=HA,
                json={'purchase_quantity': 1, 'unit_cost_per_purchase_unit_cents': 29999,
                      'pack_size_override': 1})
    db.session.commit()
    before_bottle = cost(bottle.name)
    r = client.post(f'/api/v1/inventory/{bottle.id}/open-bottle', headers=HA, json={'confirm_remaining': True})
    expect = (before_bottle / Decimal(bottle.ratio)).quantize(Decimal('0.0001'))
    check('7a. opening a bottle gives each shot bottle_cost / shots, to 4 decimals',
          r.status_code == 200 and cost(bottle.child) == expect, f'{cost(bottle.child)} vs {expect}')

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
