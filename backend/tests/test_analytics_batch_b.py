"""Analytics batch B -- "honest margins" checks against a SCRATCH database.

COMMITS (sets costs, restates history). Refuses to run unless DATABASE_URL names
a database containing "scratch". Expects migrations 040-043 applied. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_analytics_batch_b
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
JULY = 'from=2026-07-01&to=2026-07-31'

with app.app_context():
    from app.analytics_views import ensure_analytics_views
    from app.api.analytics import _margin, MARGIN_RELIABLE_PCT
    from app.models.user import User
    check('0. analytics views rebuild on top of 043', ensure_analytics_views(db) is True)
    admin = User.query.filter_by(role='ADMIN', is_active=True).first()
    H = {'Authorization': 'Bearer ' + create_access_token(
        identity=admin.id, additional_claims={'role': admin.role, 'name': admin.name})}
    db.session.commit()

    # ── the rule itself ──────────────────────────────────────────────────────
    print("== 1. the margin rule ==")
    def row(eval_, cov, cost, exento=0, reexp=0):
        return {'net_eval_cents': eval_, 'net_cov_cents': cov, 'cost_cov_cents': cost,
                'net_exento_cents': exento, 'net_reexp_cents': reexp}
    m = _margin(row(100_000, 13_000, 4_000))
    check('1a. 13% coverage: margin measured, but NOT stated as profit',
          m['cobertura_costo_pct'] == 13.0 and m['margen_pct'] == 69.2
          and m['margen_confiable'] is False and m['utilidad_estimada_cents'] is None, f'{m}')
    m = _margin(row(100_000, 90_000, 27_000, exento=5_000, reexp=9_000))
    check('1b. 90% coverage: profit = 70% of all evaluable sales + exempt sales',
          m['margen_confiable'] and m['margen_pct'] == 70.0
          and m['utilidad_estimada_cents'] == 70_000 + 5_000 and m['reexpresado_pct'] == 10.0, f'{m}')
    m = _margin(row(0, 0, 0, exento=3_000))
    check('1c. only exempt sales: all of it is margin', m['utilidad_estimada_cents'] == 3_000, f'{m}')
    check('1d. threshold is 80%', MARGIN_RELIABLE_PCT == 80)

    # ── per-line cost status ─────────────────────────────────────────────────
    print("\n== 2. every sale line has exactly one cost status ==")
    total = scalar("SELECT count(*) FROM v_bola8_lineas_venta")
    parts = scalar("SELECT count(*) FROM v_bola8_lineas_venta WHERE costo_estado IN "
                   "('COMPLETO','PARCIAL','SIN_COSTO','SIN_RECETA','EXENTO')")
    check('2a. statuses partition all lines', total == parts and total > 0, f'{parts}/{total}')
    bad = scalar("""SELECT count(*) FROM v_bola8_lineas_venta v WHERE v.costo_estado = 'COMPLETO'
                    AND EXISTS (SELECT 1 FROM sale_item_costs s WHERE s.ticket_line_item_id = v.line_item_id
                                AND COALESCE(s.unit_cost_cents,0) = 0)""")
    check('2b. no COMPLETO line has a $0 ingredient', bad == 0, f'{bad}')
    partial = scalar("SELECT count(*) FROM v_bola8_lineas_venta WHERE costo_estado = 'PARCIAL'")
    check('2c. partially-costed lines exist and are NOT counted as covered', partial > 0, f'{partial}')
    exempt_names = [r[0] for r in db.session.execute(text(
        "SELECT name FROM menu_categories WHERE exenta_costo ORDER BY name")).fetchall()]
    check('2d. exempt categories are a setting (Bola8: Daños, INGRESOS)',
          set(exempt_names) <= {'Daños', 'INGRESOS'} and len(exempt_names) >= 1, f'{exempt_names}')

    # ── endpoints at today's (low) coverage ──────────────────────────────────
    print("\n== 3. low coverage: no fake profit anywhere ==")
    ov = client.get(f'/api/v1/analytics/overview?{JULY}', headers=H).get_json()
    t = ov['totales']
    check('3a. overview: coverage reported, profit null, note shown',
          t['cobertura_costo_pct'] is not None and t['cobertura_costo_pct'] < MARGIN_RELIABLE_PCT
          and t['utilidad_cents'] is None and t['utilidad_total_cents'] is None
          and t['margen_confiable'] is False and ov['nota_cobertura'],
          f"cov={t['cobertura_costo_pct']} margen={t['margen_pct']}")
    check('3b. overview: no profit delta across periods without cost data',
          ov['variacion_pct']['utilidad'] is None and ov['variacion_pct']['margen_pp'] is None)
    check('3c. daily series: no day reports profit at <80% coverage',
          all(d['utilidad_cents'] is None for d in ov['serie_diaria']
              if (d['cobertura_costo_pct'] or 0) < MARGIN_RELIABLE_PCT))

    me = client.get(f'/api/v1/analytics/menu-engineering?{JULY}', headers=H).get_json()
    prods = me['productos']
    fake_stars = [p['producto'] for p in prods if p['cuadrante'] != 'SIN_COSTO'
                  and not p['margen_confiable']]
    check('3d. menu matrix: unreliable products are never classified', not fake_stars, f'{fake_stars[:5]}')
    check('3e. menu matrix: they appear as SIN_COSTO with no margin',
          me['resumen_cuadrantes']['SIN_COSTO'] > 0
          and all(p['margen_pct'] is None for p in prods if p['cuadrante'] == 'SIN_COSTO'),
          f"{me['resumen_cuadrantes']}")
    check('3f. median margin is no longer 100%', me['medianas']['margen_pct'] < 100,
          f"{me['medianas']}")

    pr = client.get(f'/api/v1/analytics/profitability?{JULY}', headers=H).get_json()
    res = pr['resultado']
    check('3g. profitability: net profit null, scenarios + break-even COGS still given',
          res['utilidad_neta_cents'] is None and res['utilidad_bruta_cents'] is None
          and len(pr['escenarios']) == 5 and pr['equilibrio']['cogs_equilibrio_pct'] is not None,
          f"cov={res['cobertura_costo_pct']}")
    st = client.get(f'/api/v1/analytics/staff?{JULY}', headers=H).get_json()
    check('3h. staff: per-person profit null when uncosted, coverage shown',
          all(e['utilidad_cents'] is None for e in st['empleados']
              if (e['cobertura_costo_pct'] or 0) < MARGIN_RELIABLE_PCT)
          and all('cobertura_costo_pct' in e for e in st['empleados']))
    cc = client.get(f'/api/v1/analytics/cost-coverage?{JULY}', headers=H).get_json()['resumen']
    check('3i. cost-coverage: same coverage as the overview, exempt list from settings',
          cc['cobertura_pct'] == t['cobertura_costo_pct'] and cc['excluidas'] == exempt_names,
          f"{cc['cobertura_pct']} vs {t['cobertura_costo_pct']}; {cc['excluidas']}")
    if scalar("SELECT to_regclass('public.v_bola8_recomendaciones') IS NOT NULL"):
        recs = scalar("SELECT detalle FROM v_bola8_recomendaciones WHERE area = 'Ventas'")
        listed = [n.strip() for n in recs.split(': ', 1)[1].split(', ')] if ': ' in recs else []
        unreliable = [n for n in listed if scalar("""
            SELECT COALESCE(SUM(net_sales_cents) FILTER (WHERE costo_estado = 'COMPLETO'), 0)
                   < 0.8 * NULLIF(SUM(net_sales_cents), 0)
              FROM v_bola8_lineas_venta WHERE btrim(producto) = :p""", p=n)]
        check('3j. recommendations only push products whose cost is >= 80% known',
              not unreliable, f'listed={listed[:4]} unreliable={unreliable}')
    else:
        check('3j. (recommendations view removed in 047 -- nothing left to push zero-cost items)', True)

    # ── fixing it from the screen ────────────────────────────────────────────
    print("\n== 4. enter missing costs, then restate history ==")
    # the zero-cost item with the most sales behind it
    target = db.session.execute(text("""
        SELECT ii.id, ii.name FROM inventory_items ii
        JOIN sale_item_costs s ON s.inventory_item_id = ii.id
        WHERE COALESCE(ii.unit_cost_cents,0) = 0 AND ii.is_active
          AND NOT EXISTS (SELECT 1 FROM inventory_conversions c WHERE c.from_item_id = ii.id AND c.is_active)
        GROUP BY ii.id, ii.name ORDER BY count(*) DESC LIMIT 1""")).first()
    r = client.post(f'/api/v1/inventory/{target.id}/set-cost', headers=H, json={'unit_cost_cents': 1850})
    check('4a. set a first cost on a zero-cost item', r.status_code == 200, f'{target.name} {r.status_code}')
    r = client.post(f'/api/v1/inventory/{target.id}/set-cost', headers=H, json={'unit_cost_cents': 999})
    check('4b. a second set-cost is refused (409): changes go through Reabastecer',
          r.status_code == 409, f'{r.status_code}')
    bottle = db.session.execute(text("""
        SELECT f.id, f.name, t.id AS child_id, c.ratio FROM inventory_conversions c
        JOIN inventory_items f ON f.id = c.from_item_id JOIN inventory_items t ON t.id = c.to_item_id
        WHERE c.is_active AND c.conversion_type = 'BOTTLE_TO_SHOT'
          AND COALESCE(f.unit_cost_cents,0) = 0 AND COALESCE(t.unit_cost_cents,0) = 0 LIMIT 1""")).first()
    if bottle:
        r = client.post(f'/api/v1/inventory/{bottle.id}/set-cost', headers=H, json={'unit_cost_cents': 30000})
        child_cost = scalar("SELECT unit_cost_cents FROM inventory_items WHERE id = :i", i=bottle.child_id)
        check('4c. a bottle\'s cost also prices its shots (cost / shots per bottle)',
              r.status_code == 200 and child_cost == round(30000 / float(bottle.ratio)),
              f'{bottle.name}: shot = {child_cost}')
    r = client.post('/api/v1/analytics/restate-costs', headers=H, json={'dry_run': True})
    prev = (r.get_json() or {}).get('preview', {})
    check('4d. "Recalcular histórico" preview finds the $0 rows now fixable',
          r.status_code == 200 and prev.get('filas', 0) > 0, f'{prev}')
    cov_before = t['cobertura_costo_pct']
    r = client.post('/api/v1/analytics/restate-costs', headers=H, json={})
    j = r.get_json() or {}
    stamped = scalar("SELECT count(*) FROM sale_item_costs WHERE cost_restated_at IS NOT NULL")
    check('4e. restate writes and stamps every row it changed',
          r.status_code == 200 and j.get('filas_reexpresadas') == prev.get('filas') and stamped >= prev.get('filas', 1),
          f"{j.get('filas_reexpresadas')} rows, {stamped} stamped")
    ov2 = client.get(f'/api/v1/analytics/overview?{JULY}', headers=H).get_json()['totales']
    check('4f. coverage went up, and the estimated share is reported',
          ov2['cobertura_costo_pct'] > cov_before and (ov2['reexpresado_pct'] or 0) > 0,
          f"{cov_before}% -> {ov2['cobertura_costo_pct']}%, reexpresado {ov2['reexpresado_pct']}%")
    real = scalar("""SELECT count(*) FROM sale_item_costs WHERE cost_restated_at IS NOT NULL
                     AND recorded_at > now()""")
    check('4g. audit trail: COSTS_RESTATED and INVENTORY_COST_SET logged',
          scalar("SELECT count(*) FROM audit_log WHERE action = 'COSTS_RESTATED'") >= 1
          and scalar("SELECT count(*) FROM audit_log WHERE action = 'INVENTORY_COST_SET'") >= 1
          and real == 0)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
