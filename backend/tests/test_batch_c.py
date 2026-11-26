"""Batch C -- Inicio, blind cash count, fixed costs -- against a SCRATCH database.

COMMITS (opens/closes a cash session, edits fixed costs). Refuses to run unless
DATABASE_URL names a database containing "scratch". Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_batch_c
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

url = os.environ.get('DATABASE_URL', '')
if 'scratch' not in url.rsplit('/', 1)[-1]:
    sys.exit(f'REFUSING: DATABASE_URL must point at a *scratch* database, got {url!r}')

from flask_jwt_extended import create_access_token  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
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


def money_keys(obj, path=''):
    """Every key anywhere in a JSON response that carries money."""
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.endswith('_cents') or k in ('utilidad', 'ventas'):
                found.append(path + k)
            found += money_keys(v, path + k + '.')
    elif isinstance(obj, list):
        for v in obj:
            found += money_keys(v, path)
    return found


app = create_app()
app.config['TESTING'] = True
client = app.test_client()

with app.app_context():
    from app.analytics_views import ensure_analytics_views
    ensure_analytics_views(db)
    users = {r: User.query.filter_by(role=r, is_active=True).first() for r in ('ADMIN', 'MANAGER', 'WAITER')}
    tok = {r: {'Authorization': 'Bearer ' + create_access_token(
        identity=u.id, additional_claims={'role': u.role, 'name': u.name})} for r, u in users.items()}
    db.session.commit()

    # make sure a drawer is open (a fresh scratch copy may have none)
    if not scalar("SELECT count(*) FROM cash_sessions WHERE status = 'OPEN'"):
        r = client.post('/api/v1/cash/open', headers=tok['MANAGER'], json={'opening_fund_cents': 200000})
        check('0. opened a cash session for the test', r.status_code == 201, f'{r.status_code}')

    # ── Inicio ───────────────────────────────────────────────────────────────
    print("== 1. Inicio is role-aware, enforced by the server ==")
    r = client.get('/api/v1/home', headers=tok['WAITER'])
    check('1a. a waiter cannot open Inicio (403)', r.status_code == 403, f'{r.status_code}')
    rm = client.get('/api/v1/home', headers=tok['MANAGER'])
    jm = rm.get_json() or {}
    check('1b. manager gets ahora + pendientes', rm.status_code == 200
          and {'ahora', 'pendientes'} <= set(jm), f'{sorted(jm)}')
    check('1c. manager response has NO money section and NO money field anywhere',
          'hoy' not in jm and 'alertas' not in jm and not money_keys(jm)
          and 'costos_faltantes' not in jm.get('pendientes', {}), f'{money_keys(jm)[:5]}')
    ra = client.get('/api/v1/home', headers=tok['ADMIN'])
    ja = ra.get_json() or {}
    check('1d. owner additionally gets hoy + alertas + cost counts',
          ra.status_code == 200 and {'hoy', 'alertas'} <= set(ja)
          and 'costos_faltantes' in ja['pendientes'], f'{sorted(ja)}')
    w = ja['ventana']
    expected = scalar("""SELECT COALESCE(SUM(total_cents),0) FROM tickets
                         WHERE status='CLOSED' AND closed_at >= CAST(:s AS timestamptz)
                           AND closed_at < CAST(:e AS timestamptz)""", s=w['desde'], e=w['hasta'])
    check('1e. "ventas" == closed tickets in the shift window (since the drawer opened)',
          w['tipo'] == 'turno' and ja['hoy']['ventas_cents'] == expected,
          f"{w['tipo']} {ja['hoy']['ventas_cents']} vs {expected}")
    h = ja['hoy']
    check('1f. billar + barra + cocina never exceed sales', h['billar_cents'] + h['barra_cents']
          + h['cocina_cents'] <= h['ventas_cents'] + h['tickets'],  # rounding of allocated discounts
          f"{h['billar_cents']}+{h['barra_cents']}+{h['cocina_cents']} vs {h['ventas_cents']}")
    check('1g. profit follows batch B (null when costs unknown, with coverage)',
          (h['utilidad_cents'] is None) == (h['margen_pct'] is None) and 'cobertura_costo_pct' in h)

    # a shot at 0 with sealed bottles behind it must appear under "por abrir"
    shot = db.session.execute(text("""
        SELECT ch.id, ch.name, pa.id AS parent, pa.name AS parent_name FROM inventory_conversions c
        JOIN inventory_items ch ON ch.id = c.to_item_id JOIN inventory_items pa ON pa.id = c.from_item_id
        WHERE c.is_active AND c.conversion_type = 'BOTTLE_TO_SHOT'
          AND EXISTS (SELECT 1 FROM insumos_base b WHERE b.inventory_item_id = ch.id)
        ORDER BY pa.name LIMIT 1""")).first()
    db.session.execute(text("SELECT fn_count_adjustment(:i, 0, :u, 'test C')"), {'i': shot.id, 'u': users['ADMIN'].id})
    client.post(f'/api/v1/inventory/{shot.parent}/restock', headers=tok['ADMIN'],
                json={'purchase_quantity': 1, 'unit_cost_per_purchase_unit_cents': 30000, 'pack_size_override': 1})
    db.session.commit()
    pend = client.get('/api/v1/home', headers=tok['MANAGER']).get_json()['pendientes']
    check('1h. "por abrir" lists a bottle whose shots ran out (manager sees it too)',
          any(x['abrir'] == shot.parent_name for x in pend['por_abrir']), f'{pend["por_abrir"][:3]}')

    # ── blind count ──────────────────────────────────────────────────────────
    print("\n== 2. blind cash count ==")
    r = client.get('/api/v1/cash/current/summary', headers=tok['WAITER'])
    check('2a. a waiter can no longer read the drawer summary (403)', r.status_code == 403, f'{r.status_code}')
    sm = client.get('/api/v1/cash/current/summary', headers=tok['MANAGER']).get_json()['summary']
    hidden = ('total_sales_cents', 'cash_sales_cents', 'card_sales_cents',
              'expected_cash_cents', 'cash_over_short_cents')
    check('2b. manager, drawer open: no sales and no expected cash',
          sm.get('conteo_ciego') is True and not any(k in sm for k in hidden), f'{sorted(sm)}')
    check('2c. ... but tips and expenses are there (needed to pay out / record)',
          'total_tips_cents' in sm and 'cash_expenses_cents' in sm and 'tip_payout_cents' in sm)
    sa = client.get('/api/v1/cash/current/summary', headers=tok['ADMIN']).get_json()['summary']
    check('2d. the owner always sees everything', sa.get('conteo_ciego') is False
          and all(k in sa for k in hidden))
    tm = client.get('/api/v1/cash/current/tickets', headers=tok['MANAGER']).get_json()
    check('2e. manager ticket list while open has no amounts / payment method',
          all('total_cents' not in t and 'payment_type' not in t for t in tm), f'{len(tm)} tickets')
    # close (as manager): the result is revealed
    db.session.execute(text("UPDATE tickets SET status = 'CANCELLED' WHERE status = 'OPEN'"))
    db.session.commit()
    r = client.post('/api/v1/cash/close', headers=tok['MANAGER'],
                    json={'closing_cash_counted_cents': 123400, 'notes': 'test C'})
    rs = (r.get_json() or {}).get('summary', {})
    check('2f. after closing, the manager sees expected, counted and the difference',
          r.status_code == 200 and 'expected_cash_cents' in rs and 'cash_over_short_cents' in rs
          and rs['closing_cash_counted_cents'] == 123400, f'{r.status_code}')
    check('2f2. ... but still no sales figures (owner-only, open or closed)',
          not any(k in rs for k in ('total_sales_cents', 'cash_sales_cents', 'card_sales_cents')),
          f'{sorted(rs)}')
    closed_id = (r.get_json() or {}).get('session', {}).get('id')
    old = client.get(f'/api/v1/cash/{closed_id}/summary', headers=tok['MANAGER']).get_json()['summary']
    own = client.get(f'/api/v1/cash/{closed_id}/summary', headers=tok['ADMIN']).get_json()['summary']
    check('2f3. a past session: manager gets the result but no sales; owner gets everything',
          'cash_over_short_cents' in old and 'total_sales_cents' not in old
          and 'total_sales_cents' in own)
    hist = client.get('/api/v1/cash/sessions', headers=tok['MANAGER']).get_json()
    last = hist[0]
    check('2g. history shows over/short and who closed',
          last['status'] == 'CLOSED' and last.get('cash_over_short_cents') == rs.get('cash_over_short_cents')
          and last.get('closed_by_name') == users['MANAGER'].name, f"{last.get('cash_over_short_cents')} {last.get('closed_by_name')}")

    # ── fixed costs ──────────────────────────────────────────────────────────
    print("\n== 3. fixed costs editor ==")
    r = client.post('/api/v1/analytics/fixed-costs', headers=tok['MANAGER'],
                    json={'concepto': 'X', 'mensual_cents': 1})
    check('3a. a manager cannot edit fixed costs (403)', r.status_code == 403, f'{r.status_code}')
    before = client.get('/api/v1/analytics/fixed-costs', headers=tok['ADMIN']).get_json()['total_mensual_cents']
    r = client.post('/api/v1/analytics/fixed-costs', headers=tok['ADMIN'],
                    json={'concepto': 'Internet prueba', 'categoria': 'Servicios', 'mensual_cents': 79900})
    new_id = (r.get_json() or {}).get('id')
    after = client.get('/api/v1/analytics/fixed-costs', headers=tok['ADMIN']).get_json()['total_mensual_cents']
    check('3b. owner adds a fixed cost; the monthly total moves by exactly that',
          r.status_code == 201 and after - before == 79900, f'{before} -> {after}')
    r = client.put(f'/api/v1/analytics/fixed-costs/{new_id}', headers=tok['ADMIN'],
                   json={'mensual_cents': 79900, 'is_active': False})
    gone = client.get('/api/v1/analytics/fixed-costs', headers=tok['ADMIN']).get_json()
    check('3c. "Quitar" removes it from the list and the total',
          r.status_code == 200 and gone['total_mensual_cents'] == before
          and all(c['id'] != new_id for c in gone['conceptos']))
    check('3d. both changes are audited',
          scalar("SELECT count(*) FROM audit_log WHERE entity_id = :i AND action IN "
                 "('FIXED_COST_CREATED','FIXED_COST_UPDATED')", i=new_id) == 2)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
