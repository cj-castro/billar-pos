"""Inventory review batch 1 -- integration checks against a SCRATCH database.

These tests COMMIT. They refuse to run unless DATABASE_URL names a database
whose name contains "scratch". Typical run (from the repo root):

    docker exec -i billar-pos-postgres-1 psql -U billiard -d postgres \\
        -c "DROP DATABASE IF EXISTS billar_scratch_b1" -c "CREATE DATABASE billar_scratch_b1"
    docker exec -i billar-pos-postgres-1 sh -c \\
        'pg_dump -U billiard -d billiardbar --no-owner | psql -q -U billiard -d billar_scratch_b1'
    docker exec -i billar-pos-postgres-1 psql -U billiard -d billar_scratch_b1 \\
        < backend/migrations/sql/040_bottle_conversion_fixes.sql
    docker run --rm --network billar-pos_billiardbar_net -v "$PWD/backend:/app" -w /app \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend python -m tests.test_inventory_batch1

Covers:
  1. Migration 040: yields mirror inventory_conversions; one active conversion per source
  2. Manual open-bottle goes through fn_convert_stock and carries cost to the shots
  3. Open-bottle refuses a non-bottle; Red Label yields its shot, not Agua Mineral
  4. RESTOCK refused on a shot (derived) item; allowed on its bottle
  5. _lock_one returns post-lock values (the lost-update fix)
  6. add_item auto-conversion writes reference_id = the new line id
  7. send_order with a short item returns 422 and sends nothing
  8. Open-box works for a box name longer than 16 chars (reference overflow fix)
  9. No ledger violations were created by any of the above
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
from sqlalchemy import create_engine, text  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models.inventory import InventoryItem  # noqa: E402
from app.models.ticket import Ticket, TicketLineItem  # noqa: E402
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


app = create_app()
app.config['TESTING'] = True
client = app.test_client()


def item(name) -> InventoryItem:
    return InventoryItem.query.filter_by(name=name).one()


def scalar(sql, **kw):
    return db.session.execute(text(sql), kw).scalar()


def set_setting(key, value):
    db.session.execute(text(
        "INSERT INTO settings (key, value) VALUES (:k, :v) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"), {'k': key, 'v': value})
    db.session.commit()


def count_to(name, qty, user_id):
    """Set an item's stock through the ledger (COUNT_ADJUSTMENT), never directly."""
    inventory_svc.record_count_adjustment(item(name).id, qty, 'test setup', user_id)
    db.session.commit()


with app.app_context():
    mgr = User.query.filter_by(role='MANAGER', is_active=True).first()
    assert mgr, 'need an active MANAGER in the scratch DB'
    H = {'Authorization': 'Bearer ' + create_access_token(
        identity=mgr.id, additional_claims={'role': mgr.role, 'name': mgr.name})}
    violations_before = scalar('SELECT count(*) FROM ledger_violations')

    # ── 1 ────────────────────────────────────────────────────────────────────
    print("== 1. migration 040 ==")
    rl = item('Whisky Red Label Bottle')
    check('1a. Red Label yields its shot, not Agua Mineral',
          rl.yields_item_id == item('Shot Whisky Red label').id)
    check('1b. Tequila Blanco Shot is no longer flagged as a bottle',
          item('Tequila Blanco Shot').item_type == 'STANDARD'
          and item('Tequila Blanco Shot').yields_item_id is None)
    check('1c. Curazao and Vodka bottles now carry a yield',
          item('Curazao Azul Bottle').shots_per_bottle == 15
          and item('Vodka Bottle').shots_per_bottle == 15)
    check('1d. unique index: one active conversion per source',
          scalar("SELECT count(*) FROM pg_indexes "
                 "WHERE indexname = 'uq_conv_one_active_per_source'") == 1)
    check('1e. 040 registered', scalar(
        "SELECT count(*) FROM schema_migrations WHERE version = '040'") == 1)

    # ── 2 ────────────────────────────────────────────────────────────────────
    print("\n== 2. manual open-bottle carries cost ==")
    bottle, shot = item('Tequila Blanco Bottle'), item('Tequila Blanco Shot')
    count_to('Tequila Blanco Shot', 0, mgr.id)
    bottle.unit_cost_cents = 30000           # $300.00 per bottle
    db.session.commit()
    b0 = Decimal(item('Tequila Blanco Bottle').stock_quantity)
    r = client.post(f'/api/v1/inventory/{bottle.id}/open-bottle', headers=H)
    check('2a. open-bottle returns 200', r.status_code == 200, f'{r.status_code} {r.get_json()}')
    db.session.expire_all()
    check('2b. one bottle deducted',
          Decimal(item('Tequila Blanco Bottle').stock_quantity) == b0 - 1)
    # Since 049 an open bottle is measured in ml: 15 shots = 750 ml.
    check('2c. 15 shots (750 ml) added', Decimal(item('Tequila Blanco Shot').stock_quantity) == 750)
    check('2d. WAC per ml = 30000 / 750 = 40 (a 50 ml shot = 2000)',
          item('Tequila Blanco Shot').unit_cost_cents == 40,
          f"got {item('Tequila Blanco Shot').unit_cost_cents}")
    # Order by seq, the ledger's own ordering. created_at DESC would put the
    # legacy rows with NULL created_at first (Postgres sorts NULLs first on DESC).
    mv = db.session.execute(text(
        "SELECT event_type, unit_cost_cents FROM inventory_movements "
        "WHERE inventory_item_id = :i ORDER BY seq DESC LIMIT 1"), {'i': shot.id}).one()
    check('2e. ledger row is CONVERSION_IN with the cost stamped',
          mv.event_type == 'CONVERSION_IN' and mv.unit_cost_cents == 40,
          f'{mv.event_type} {mv.unit_cost_cents}')
    check('2f. response reports shots_added', (r.get_json() or {}).get('shots_added') == 15)

    # ── 3 ────────────────────────────────────────────────────────────────────
    print("\n== 3. open-bottle refuses non-bottles ==")
    r = client.post(f"/api/v1/inventory/{item('Tequila Blanco Shot').id}/open-bottle", headers=H)
    check('3a. opening a SHOT item is refused (422 NOT_A_BOTTLE)',
          r.status_code == 422 and r.get_json()['error'] == 'NOT_A_BOTTLE', f'{r.status_code}')
    water0 = Decimal(item('Agua Mineral').stock_quantity)
    rl_shot0 = Decimal(item('Shot Whisky Red label').stock_quantity)
    # Red Label still has loose shots, so this open needs the confirmation.
    r = client.post(f'/api/v1/inventory/{rl.id}/open-bottle', headers=H,
                    json={'confirm_remaining': True})
    db.session.expire_all()
    check('3b. opening Red Label adds whisky shots',
          r.status_code == 200
          and Decimal(item('Shot Whisky Red label').stock_quantity) == rl_shot0 + 750,
          f'{r.status_code}')
    check('3c. ... and does NOT touch Agua Mineral',
          Decimal(item('Agua Mineral').stock_quantity) == water0)

    # ── 4 ────────────────────────────────────────────────────────────────────
    print("\n== 4. restock guard ==")
    r = client.post(f"/api/v1/inventory/{item('Tequila Blanco Shot').id}/restock", headers=H,
                    json={'purchase_quantity': 15, 'unit_cost_per_purchase_unit_cents': 100})
    check('4a. restocking a shot item is refused (422)',
          r.status_code == 422 and 'RESTOCK_DERIVED_ITEM' in r.get_json()['message'],
          f'{r.status_code}')
    r = client.post(f"/api/v1/inventory/{item('Curazao Azul Bottle').id}/restock", headers=H,
                    json={'purchase_quantity': 1, 'unit_cost_per_purchase_unit_cents': 25000})
    check('4b. restocking the bottle itself still works', r.status_code == 200, f'{r.status_code}')

    # ── 5 ────────────────────────────────────────────────────────────────────
    print("\n== 5. _lock_one sees post-lock values ==")
    bid = item('Tequila Cristalino Bottle').id
    db.session.commit()
    stale = InventoryItem.query.get(bid)            # unlocked read, now in identity map
    before = Decimal(stale.stock_quantity)
    other = create_engine(url)                      # a concurrent writer
    # The concurrent write goes through the ledger (fn_count_adjustment) so the
    # test itself never trips a STOCK_MISMATCH -- check 9 must stay meaningful.
    with other.begin() as conn:
        conn.execute(text("SELECT fn_count_adjustment(:i, :q, :u, 'test 5 concurrent writer')"),
                     {'i': bid, 'q': before + 7, 'u': mgr.id})
    old_way = InventoryItem.query.with_for_update().get(bid)
    check('5a. (control) the OLD lock pattern returns the stale value',
          Decimal(old_way.stock_quantity) == before, f'{old_way.stock_quantity} vs {before}')
    fresh = inventory_svc._lock_one(bid)
    check('5b. _lock_one returns the committed value', Decimal(fresh.stock_quantity) == before + 7,
          f'{fresh.stock_quantity} vs {before + 7}')
    db.session.rollback()
    with other.begin() as conn:                     # put it back exactly
        conn.execute(text("SELECT fn_count_adjustment(:i, :q, :u, 'test 5 restore')"),
                     {'i': bid, 'q': before, 'u': mgr.id})
    other.dispose()
    db.session.expire_all()

    # ── 6 ────────────────────────────────────────────────────────────────────
    print("\n== 6. add_item auto-conversion is traceable to the line ==")
    set_setting('spirits.auto_convert_enabled', 'true')
    count_to('Tequila Cristalino Shot', 0, mgr.id)
    t = Ticket(ticket_type='EXPRESS', resource_id=None, opened_by=mgr.id,
               status='OPEN', version=1)
    db.session.add(t)
    db.session.commit()
    shot_menu = scalar("SELECT id FROM menu_items WHERE name = 'Tequila Cristalino Shot'")
    r = client.post(f'/api/v1/tickets/{t.id}/items', headers=H,
                    json={'menu_item_id': shot_menu, 'quantity': 1})
    check('6a. shot sells with 0 loose shots (bottle auto-opened)', r.status_code == 201,
          f'{r.status_code} {r.get_json()}')
    line_id = (r.get_json() or {}).get('id')
    refs = db.session.execute(text(
        "SELECT event_type, reference_id FROM inventory_movements "
        "WHERE event_type IN ('CONVERSION_OUT','CONVERSION_IN') "
        "ORDER BY seq DESC LIMIT 2")).all()
    check('6b. CONVERSION_OUT/IN both reference the new line item',
          len(refs) == 2 and all(x.reference_id == line_id for x in refs),
          f'{[tuple(x) for x in refs]} vs {line_id}')
    set_setting('spirits.auto_convert_enabled', 'false')

    # ── 7 ────────────────────────────────────────────────────────────────────
    print("\n== 7. send_order out of stock -> 422, nothing sent ==")
    count_to('Vodka Shot', 0, mgr.id)
    count_to('Curazao Azul Shot', 0, mgr.id)
    azulito = scalar("SELECT id FROM menu_items WHERE name = 'Azulito'")
    staged = TicketLineItem(ticket_id=t.id, menu_item_id=azulito, item_name='Azulito',
                            quantity=1, unit_price_cents=8900, routing_dest='BAR',
                            status='STAGED')
    db.session.add(staged)
    db.session.commit()
    r = client.post(f'/api/v1/tickets/{t.id}/send-order', headers=H)
    check('7a. 422 OUT_OF_STOCK instead of 500',
          r.status_code == 422 and r.get_json()['error'] == 'OUT_OF_STOCK', f'{r.status_code}')
    db.session.expire_all()
    check('7b. the line is still STAGED',
          TicketLineItem.query.get(staged.id).status == 'STAGED')

    # ── 8 ────────────────────────────────────────────────────────────────────
    print("\n== 8. open-box with a long box name ==")
    box = item('Marlboro Blanco Caja')
    try:
        with db.session.begin_nested():
            db.session.execute(text("SELECT * FROM fn_open_pack_fifo(:b, :u, :r)"),
                               {'b': box.id, 'u': mgr.id,
                                'r': f'Manual open-box for {box.name}'})
        old_failed = False
    except Exception as exc:                         # noqa: BLE001
        old_failed = 'too long' in str(exc)
    db.session.rollback()
    check('8a. (control) the OLD reference text overflows varchar(36)', old_failed)
    r = client.post(f'/api/v1/inventory/{box.id}/open-box', headers=H,
                    json={'confirm_remaining': True})
    check('8b. open-box now succeeds', r.status_code == 200, f'{r.status_code} {r.get_json()}')

    # ── 10 ───────────────────────────────────────────────────────────────────
    print("\n== 10. a bottle created on the inventory screen can be opened ==")

    def active_convs(item_id):
        return db.session.execute(text(
            "SELECT to_item_id, ratio FROM inventory_conversions "
            "WHERE from_item_id = :i AND is_active"), {'i': item_id}).all()

    # Exactly what the "Nuevo artículo" form sends when the link is left on
    # "— Crear automáticamente —": shots per bottle, no yields_item_id.
    r = client.post('/api/v1/inventory', headers=H, json={
        'name': 'Mezcal Prueba Bottle', 'category': 'spirit', 'item_type': 'BOTTLE',
        'base_unit_key': 'botella', 'stock_quantity': 2, 'unit_cost_cents': 45000,
        'shots_per_bottle': 15})
    check('10a. bottle created', r.status_code == 201, f'{r.status_code} {r.get_json()}')
    mz = r.get_json() or {}
    db.session.expire_all()
    auto = InventoryItem.query.filter_by(name='Mezcal Prueba Shot').first()
    check('10b. its shot item was created automatically',
          auto is not None and auto.base_unit_key == 'ml' and auto.portion_size == 50
          and auto.stock_nature == 'DERIVED')
    check('10c. one active conversion bottle -> shot: 750 ml (an old client\'s "15 shots" x 50 ml)',
          [(c.to_item_id, int(c.ratio)) for c in active_convs(mz.get('id'))]
          == [(auto.id if auto else None, 750)])
    r = client.post(f"/api/v1/inventory/{mz.get('id')}/open-bottle", headers=H)
    db.session.expire_all()
    check('10d. and it OPENS: +15 shots (750 ml) at 45000/750 = 60 per ml (3000 a shot)',
          r.status_code == 200 and (r.get_json() or {}).get('shots_added') == 15
          and (r.get_json() or {}).get('ml_added') == 750
          and item('Mezcal Prueba Shot').unit_cost_cents == 60,
          f'{r.status_code} {r.get_json()}')

    # Name without "Bottle" at the end gets the word appended.
    r = client.post('/api/v1/inventory', headers=H, json={
        'name': 'Don Julio 70', 'category': 'spirit', 'item_type': 'BOTTLE',
        'base_unit_key': 'botella', 'shots_per_bottle': 16})
    db.session.expire_all()
    check('10e. "Don Julio 70" -> child "Don Julio 70 Shot"',
          r.status_code == 201
          and InventoryItem.query.filter_by(name='Don Julio 70 Shot').first() is not None,
          f'{r.status_code} {r.get_json()}')

    # The edit form re-sends every field. Saving without changes must not touch
    # the conversion or write an audit row.
    edit_payload = {'name': 'Mezcal Prueba Bottle', 'category': 'spirit',
                    'item_type': 'BOTTLE', 'base_unit_key': 'botella',
                    'shots_per_bottle': 15, 'yields_item_id': auto.id if auto else None}
    audits0 = scalar("SELECT count(*) FROM audit_log WHERE action = 'INVENTORY_YIELD_SET'")
    r = client.patch(f"/api/v1/inventory/{mz.get('id')}", headers=H, json=edit_payload)
    check('10f. saving the edit form unchanged is a no-op',
          r.status_code == 200 and len(active_convs(mz.get('id'))) == 1
          and scalar("SELECT count(*) FROM audit_log WHERE action = 'INVENTORY_YIELD_SET'") == audits0,
          f'{r.status_code}')

    r = client.patch(f"/api/v1/inventory/{mz.get('id')}", headers=H,
                     json={**edit_payload, 'shots_per_bottle': 20})
    convs = active_convs(mz.get('id'))
    check('10g. changing to 20 shots (old client): still ONE active conversion, now 1000 ml',
          r.status_code == 200 and [int(c.ratio) for c in convs] == [1000], f'{convs}')
    check('10h. ... and the change is audited',
          scalar("SELECT count(*) FROM audit_log WHERE action = 'INVENTORY_YIELD_SET'")
          == audits0 + 1)

    r = client.patch(f"/api/v1/inventory/{mz.get('id')}", headers=H,
                     json={**edit_payload, 'yields_item_id': item('Vodka Bottle').id})
    check('10i. a bottle cannot "produce" another bottle (422)',
          r.status_code == 422 and r.get_json()['error'] == 'INVALID_YIELD', f'{r.status_code}')

    r = client.patch(f"/api/v1/inventory/{mz.get('id')}", headers=H,
                     json={**edit_payload, 'item_type': 'STANDARD', 'shots_per_bottle': None})
    db.session.expire_all()
    r2 = client.post(f"/api/v1/inventory/{mz.get('id')}/open-bottle", headers=H)
    check('10j. switching to STANDARD makes it non-openable',
          r.status_code == 200 and not active_convs(mz.get('id')) and r2.status_code == 422
          and item('Mezcal Prueba Bottle').yields_item_id is None, f'{r.status_code} {r2.status_code}')

    # Same flow for a cigarette box.
    r = client.post('/api/v1/inventory', headers=H, json={
        'name': 'Camel Prueba Caja', 'category': 'cigarette', 'item_type': 'CIG_BOX',
        'base_unit_key': 'pieza', 'stock_quantity': 1, 'shots_per_bottle': 20,
        'purchase_cost_cents': 9000})   # starting stock needs its price (E4)
    db.session.expire_all()
    loose = InventoryItem.query.filter_by(name='Camel Prueba Suelto').first()
    r2 = client.post(f"/api/v1/inventory/{(r.get_json() or {}).get('id')}/open-box", headers=H)
    db.session.expire_all()
    check('10k. new cigarette box: "Suelto" item auto-created and the box opens',
          r.status_code == 201 and loose is not None and loose.item_type == 'CIG_SINGLE'
          and r2.status_code == 200
          and Decimal(item('Camel Prueba Suelto').stock_quantity) == 20,
          f'{r.status_code} {r2.status_code} {r2.get_json()}')

    # ── 11 ───────────────────────────────────────────────────────────────────
    print("\n== 11. shots only exist by opening a bottle ==")
    admin = User.query.filter_by(role='ADMIN', is_active=True).first()
    HA = {'Authorization': 'Bearer ' + create_access_token(
        identity=admin.id, additional_claims={'role': admin.role, 'name': admin.name})}
    set_setting('spirits.auto_convert_enabled', 'false')     # the shipped default
    cris = item('Tequila Cristalino Shot')
    count_to('Tequila Cristalino Shot', 0, mgr.id)

    def adjust(headers, body):
        return client.post(f'/api/v1/inventory/{cris.id}/adjust', headers=headers,
                           json={'reason': 'test 11', **body})

    r = adjust(H, {'event_type': 'MANUAL_ADJUSTMENT', 'qty_delta': 5})
    check('11a. manager cannot "+5" shots (OPEN_TO_ADD)',
          r.status_code == 422 and r.get_json()['error'] == 'OPEN_TO_ADD', f'{r.status_code}')
    r = adjust(HA, {'event_type': 'MANUAL_ADJUSTMENT', 'qty_delta': 5})
    check('11b. not even the owner can "+5" (must be a physical count)',
          r.status_code == 422 and r.get_json()['error'] == 'OPEN_TO_ADD', f'{r.status_code}')
    r = adjust(H, {'event_type': 'COUNT_ADJUSTMENT', 'counted_quantity': 7})
    check('11c. manager cannot count shots UP', r.status_code == 422, f'{r.status_code}')
    r = adjust(HA, {'event_type': 'COUNT_ADJUSTMENT', 'counted_quantity': 7})
    check('11d. owner (ADMIN) can correct a count up, audited', r.status_code == 200
          and scalar("SELECT count(*) FROM audit_log WHERE action = 'INVENTORY_COUNT_ADJUSTMENT' "
                     "AND entity_id = :i AND user_id = :u", i=cris.id, u=admin.id) >= 1,
          f'{r.status_code}')
    r = adjust(H, {'event_type': 'COUNT_ADJUSTMENT', 'counted_quantity': 0})
    check('11e. manager CAN count shots down', r.status_code == 200, f'{r.status_code}')

    # 0 shots, bottles on the shelf, auto-convert off: the shot cannot be sold.
    db.session.expire_all()
    shot_menu = scalar("SELECT id FROM menu_items WHERE name = 'Tequila Cristalino Shot'")
    r = client.get('/api/v1/inventory/stock-check', headers=H)
    check('11f. sales screen shows the shot as blocked',
          shot_menu in (r.get_json() or {}).get('blocked_items', []))
    t2 = Ticket(ticket_type='EXPRESS', resource_id=None, opened_by=mgr.id,
                status='OPEN', version=1)
    db.session.add(t2)
    db.session.commit()
    bottles0 = Decimal(item('Tequila Cristalino Bottle').stock_quantity)
    r = client.post(f'/api/v1/tickets/{t2.id}/items', headers=H,
                    json={'menu_item_id': shot_menu, 'quantity': 1})
    db.session.expire_all()
    check('11g. selling it is refused (422 OUT_OF_STOCK) and no bottle is opened',
          r.status_code == 422 and r.get_json()['error'] == 'OUT_OF_STOCK'
          and Decimal(item('Tequila Cristalino Bottle').stock_quantity) == bottles0,
          f'{r.status_code}')
    r = client.post(f"/api/v1/inventory/{item('Tequila Cristalino Bottle').id}/open-bottle",
                    headers=H)
    r2 = client.post(f'/api/v1/tickets/{t2.id}/items', headers=H,
                     json={'menu_item_id': shot_menu, 'quantity': 1})
    check('11h. after "Abrir botella" the same shot sells', r.status_code == 200
          and r2.status_code == 201, f'{r.status_code} {r2.status_code}')

    # Database backstop: a shot item can never go negative, even in warn mode.
    try:
        with db.session.begin_nested():
            db.session.execute(text("UPDATE inventory_items SET stock_quantity = -1 "
                                    "WHERE id = :i"), {'i': cris.id})
        blocked = False
    except Exception as exc:                         # noqa: BLE001
        blocked = 'NEGATIVE STOCK blocked' in str(exc)
    db.session.rollback()
    check('11i. DB refuses negative stock on a shot item', blocked)

    # ── 12 ───────────────────────────────────────────────────────────────────
    print("\n== 12. whole numbers, 'quedan N shots', unit lock ==")
    check('12a. 041: botella is counted, ml is measured',
          scalar("SELECT allows_fraction FROM unit_catalog WHERE key='botella'") is False
          and scalar("SELECT allows_fraction FROM unit_catalog WHERE key='ml'") is True)
    cz = item('Curazao Azul Bottle')
    r = client.post(f'/api/v1/inventory/{cz.id}/restock', headers=H,
                    json={'purchase_quantity': 0.01, 'unit_cost_per_purchase_unit_cents': 100})
    check('12b. restocking 0.01 bottles is refused',
          r.status_code == 422 and 'WHOLE_UNITS_ONLY' in r.get_json()['message'], f'{r.status_code}')
    r = client.post(f'/api/v1/inventory/{cz.id}/adjust', headers=H,
                    json={'event_type': 'COUNT_ADJUSTMENT', 'counted_quantity': 1.5, 'reason': 't12'})
    check('12c. counting 1.5 bottles is refused', r.status_code == 422, f'{r.status_code}')
    r = client.post('/api/v1/inventory', headers=H, json={
        'name': 'Ron Prueba Bottle', 'category': 'spirit', 'base_unit_key': 'botella',
        'stock_quantity': 2.5})
    check('12d. creating with 2.5 bottles is refused', r.status_code == 422, f'{r.status_code}')
    clam = InventoryItem.query.filter_by(base_unit_key='ml').first()
    if clam is not None:
        r = client.post(f'/api/v1/inventory/{clam.id}/adjust', headers=H,
                        json={'event_type': 'WASTE', 'waste_quantity': 12.5, 'reason': 't12'})
        check('12e. measured units (ml) still take decimals', r.status_code in (200, 422)
              and 'WHOLE_UNITS_ONLY' not in (r.get_json() or {}).get('message', ''),
              f'{clam.name} {r.status_code}')

    # Open a bottle while shots remain: server asks first.
    vb = item('Vodka Bottle')
    client.post(f'/api/v1/inventory/{vb.id}/restock', headers=H,
                json={'purchase_quantity': 2, 'unit_cost_per_purchase_unit_cents': 20000})
    client.post(f'/api/v1/inventory/{vb.id}/open-bottle', headers=H)       # 0 shots: opens
    db.session.expire_all()
    b_before = Decimal(item('Vodka Bottle').stock_quantity)
    r = client.post(f'/api/v1/inventory/{vb.id}/open-bottle', headers=H)
    j = r.get_json() or {}
    db.session.expire_all()
    check('12f. second open with 15 shots left -> 409 "Todavía quedan 15 shots, ¿abrir otra?"',
          r.status_code == 409 and j.get('error') == 'STILL_HAS_UNITS'
          and j.get('remaining') == 15 and 'Todavía quedan 15 shots' in j.get('message', '')
          and Decimal(item('Vodka Bottle').stock_quantity) == b_before, f'{r.status_code} {j}')
    r = client.post(f'/api/v1/inventory/{vb.id}/open-bottle', headers=H,
                    json={'confirm_remaining': True})
    db.session.expire_all()
    check('12g. confirming opens it: 30 shots (1500 ml), one bottle fewer',
          r.status_code == 200 and Decimal(item('Vodka Shot').stock_quantity) == 1500
          and Decimal(item('Vodka Bottle').stock_quantity) == b_before - 1, f'{r.status_code}')

    # Unit lock: no re-labelling stock that is on hand. Make sure there IS stock
    # (the copied database may have any amount by now).
    client.post(f'/api/v1/inventory/{vb.id}/restock', headers=H,
                json={'purchase_quantity': 1, 'unit_cost_per_purchase_unit_cents': 20000})
    r = client.patch(f'/api/v1/inventory/{vb.id}', headers=H, json={'base_unit_key': 'caballito'})
    check('12h. cannot change a bottle\'s unit while it has stock (UNIT_LOCKED)',
          r.status_code == 422 and r.get_json()['error'] == 'UNIT_LOCKED', f'{r.status_code}')
    db.session.expire_all()
    check('12i. ... unit unchanged', item('Vodka Bottle').base_unit_key == 'botella')

    # ── 9 ────────────────────────────────────────────────────────────────────
    print("\n== 9. ledger integrity ==")
    db.session.rollback()
    new_v = db.session.execute(text(
        "SELECT violation_type, context->>'item_name' AS item FROM ledger_violations "
        "ORDER BY id DESC LIMIT :n"), {'n': max(scalar('SELECT count(*) FROM ledger_violations')
                                              - violations_before, 0)}).all()
    check('9a. no new ledger violations', not new_v, f'{[tuple(v) for v in new_v]}')

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
