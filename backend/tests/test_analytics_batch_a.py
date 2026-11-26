"""Analytics batch A -- "the numbers are right" checks against a SCRATCH database.

Rebuilds the analytics views from app/analytics_views.py (exactly what
`flask init-db` STEP 26 does on every start), then compares what the owner sees
with the source of truth. Refuses to run unless DATABASE_URL names a database
containing "scratch". Run from the repo root:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_analytics_batch_a

Each check names the bug it guards (A1..A12, see docs/INVENTORY-ANALYTICS-REVIEW.md).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

url = os.environ.get('DATABASE_URL', '')
if 'scratch' not in url.rsplit('/', 1)[-1]:
    sys.exit(f'REFUSING: DATABASE_URL must point at a *scratch* database, got {url!r}')

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


def rows(sql, **kw):
    return db.session.execute(text(sql), kw).mappings().all()


def scalar(sql, **kw):
    return db.session.execute(text(sql), kw).scalar()


app = create_app()
app.config['TESTING'] = True

with app.app_context():
    from app.analytics_views import ensure_analytics_views
    check('0. analytics views rebuild cleanly from analytics_views.py',
          ensure_analytics_views(db) is True)

    # ── A1/A2: drawer = POS ──────────────────────────────────────────────────
    print("\n== A1/A2. cash-flow dashboard agrees with the POS close screen ==")
    from app.api.cash_session import _build_summary
    from app.models.cash_session import CashSession

    view = {r['session_id']: r for r in rows(
        "SELECT session_id, diferencia_mxn, efectivo_esperado_mxn, diagnostico_caja "
        "FROM v_bola8_flujo_caja WHERE closing_cash_counted_cents IS NOT NULL" if False else
        "SELECT session_id, diferencia_mxn, efectivo_esperado_mxn, diagnostico_caja "
        "FROM v_bola8_flujo_caja WHERE efectivo_contado_mxn IS NOT NULL")}
    closed = CashSession.query.filter(CashSession.closing_cash_counted_cents.isnot(None)).all()
    worst, mismatches = 0, []
    for cs in closed:
        pos = _build_summary(cs)
        v = view.get(cs.id)
        if v is None:
            mismatches.append((str(cs.date), 'missing in view'))
            continue
        pos_diff = pos['cash_over_short_cents']
        view_diff = round(float(v['diferencia_mxn']) * 100)
        gap = abs(pos_diff - view_diff)
        worst = max(worst, gap)
        if gap > 100:                                   # > $1.00
            mismatches.append((str(cs.date), pos_diff / 100, view_diff / 100))
    check(f'A1. every closed session ({len(closed)}) within $1 of the POS',
          not mismatches, f'worst gap ${worst / 100:.2f}; mismatches: {mismatches[:5]}')
    may24 = rows("SELECT diferencia_mxn, diagnostico_caja FROM v_bola8_flujo_caja "
                 "WHERE fecha_mx = '2026-05-24'")
    check('A1b. 2026-05-24 is no longer a +$17,923 "Sobrante"',
          may24 and abs(float(may24[0]['diferencia_mxn'])) < 50,
          f'{[dict(r) for r in may24]}')

    # Every peso of sales and tips lands on exactly one leg.
    recon = rows("""
        SELECT (SELECT COALESCE(SUM(total_cents),0) FROM v_bola8_tickets_cerrados) AS sales,
               (SELECT COALESCE(SUM(monto_cents),0) FROM v_bola8_pagos_desglosados) AS legs,
               (SELECT COALESCE(SUM(tip_cents),0)   FROM v_bola8_tickets_cerrados) AS tips,
               (SELECT COALESCE(SUM(propina_cents),0) FROM v_bola8_pagos_desglosados) AS leg_tips
    """)[0]
    check('A2. payment legs reconcile to total sales and total tips',
          recon['sales'] == recon['legs'] and recon['tips'] == recon['leg_tips'],
          f"{dict(recon)}")
    cash_tip_on_card = scalar("""
        SELECT COUNT(*) FROM v_bola8_pagos_desglosados p JOIN tickets t ON t.id = p.ticket_id
         WHERE t.payment_type = 'CARD' AND t.payment_type_2 IS NULL AND t.tip_source = 'CASH'
           AND t.tip_cents > 0 AND p.metodo_pago = 'CASH' AND p.propina_cents = t.tip_cents""")
    expected_n = scalar("""SELECT COUNT(*) FROM tickets WHERE status = 'CLOSED'
           AND payment_type = 'CARD' AND payment_type_2 IS NULL AND tip_source = 'CASH'
           AND tip_cents > 0""")
    check('A2b. a cash tip on a card payment is reported under CASH',
          cash_tip_on_card == expected_n, f'{cash_tip_on_card}/{expected_n}')

    # ── HTTP checks as an ADMIN ──────────────────────────────────────────────
    from flask_jwt_extended import create_access_token
    from app.models.user import User
    admin = User.query.filter_by(role='ADMIN', is_active=True).first()
    H = {'Authorization': 'Bearer ' + create_access_token(
        identity=admin.id, additional_claims={'role': admin.role, 'name': admin.name})}
    client = app.test_client()
    db.session.commit()

    def day_total(d):
        return int(scalar("SELECT COALESCE(SUM(total_cents),0) FROM tickets WHERE status='CLOSED' "
                          "AND (closed_at AT TIME ZONE 'America/Mexico_City')::date = :d", d=d))

    # ── A3: a single-day range is the whole day ──────────────────────────────
    # (The separate Earnings page/endpoint that had this bug was retired in batch
    # B and merged into Analytics; the guarantee is checked there.)
    print("\n== A3. a single day covers the whole day ==")
    r = client.get('/api/v1/analytics/overview?from=2026-07-31&to=2026-07-31', headers=H)
    j = (r.get_json() or {}).get('totales', {})
    check('A3. analytics for 2026-07-31 alone == that day\'s tickets (not $0)',
          r.status_code == 200 and j.get('ventas_cents') == day_total('2026-07-31') > 0,
          f"{r.status_code} ventas={j.get('ventas_cents')} expected={day_total('2026-07-31')}")

    # ── A4: Telegram bot timezone ────────────────────────────────────────────
    print("\n== A4. Telegram bot uses the bar's day ==")
    bot = (Path(__file__).resolve().parents[2] / 'telegram-bot' / 'bot.py')
    src = bot.read_text(encoding='utf-8') if bot.exists() else ''
    check('A4. no double "AT TIME ZONE \'UTC\' AT TIME ZONE" and no CURRENT_DATE',
          bot.exists() and "AT TIME ZONE 'UTC' AT TIME ZONE" not in src and 'CURRENT_DATE' not in src,
          'bot.py not mounted' if not bot.exists() else '')
    jul26 = scalar("SELECT COALESCE(SUM(total_cents),0) FROM tickets WHERE status='CLOSED' "
                   "AND DATE(closed_at AT TIME ZONE 'America/Mexico_City') = DATE '2026-07-26'")
    check('A4b. the corrected expression gives 2026-07-26 = $4,902.64', jul26 == 490264,
          f'${jul26 / 100:,.2f}')

    # ── A5: payment mix sums to revenue ──────────────────────────────────────
    print("\n== A5. payment report: methods sum to revenue, tips excluded ==")
    r = client.get('/api/v1/reports/payments?from=2026-07-01&to=2026-07-31', headers=H)
    methods = r.get_json() or []
    rev = int(scalar("SELECT COALESCE(SUM(total_cents),0) FROM tickets WHERE status='CLOSED' "
                     "AND closed_at BETWEEN :a AND :b",
                     a='2026-07-01T06:00:00+00:00', b='2026-08-01T05:59:59.999999+00:00'))
    tips = int(scalar("SELECT COALESCE(SUM(tip_cents),0) FROM tickets WHERE status='CLOSED' "
                      "AND closed_at BETWEEN :a AND :b",
                      a='2026-07-01T06:00:00+00:00', b='2026-08-01T05:59:59.999999+00:00'))
    check('A5. July: sum of methods == revenue',
          r.status_code == 200 and sum(m['total_cents'] for m in methods) == rev,
          f"methods={sum(m['total_cents'] for m in methods)} revenue={rev}")
    check('A5b. July: sum of method tips == tips',
          sum(m['tips_cents'] for m in methods) == tips,
          f"{sum(m['tips_cents'] for m in methods)} vs {tips}")
    r = client.get('/api/v1/reports/staff?from=2026-07-01&to=2026-07-31', headers=H)
    staff = r.get_json() or []
    check('A5c. staff report: cash + card never exceeds sales',
          r.status_code == 200 and all(s['cash_sales_cents'] + s['card_sales_cents']
                                       <= s['total_sales_cents'] for s in staff),
          f'{[(s["staff_name"], s["cash_sales_cents"] + s["card_sales_cents"], s["total_sales_cents"]) for s in staff][:3]}')

    # ── A6: clean labels; below-minimum items reach the purchase list ────────
    print("\n== A6. no mojibake; below-minimum reaches the shopping list ==")
    bad = scalar("SELECT COUNT(*) FROM pg_views WHERE schemaname='public' "
                 "AND (definition LIKE '%├%' OR definition LIKE '%Ã%')")
    check('A6. no view definition contains mojibake', bad == 0, f'{bad} views')
    # Batch E3: the shopping list is v_purchase_forecast. Every purchasable item
    # strictly BELOW its minimum must be on it (at the minimum is enough; shots
    # roll up into their bottle).
    below = scalar("""SELECT COUNT(*) FROM v_purchase_forecast WHERE minimo > 0 AND disponible < minimo""")
    missing = scalar("""SELECT COUNT(*) FROM v_purchase_forecast
                        WHERE minimo > 0 AND disponible < minimo AND comprar_unidades <= 0""")
    r = client.get('/api/v1/analytics/inventory', headers=H)
    j = r.get_json() or {}
    por_comprar = (j.get('resumen') or {}).get('por_comprar', j.get('por_comprar'))
    check('A6b. below-minimum items exist and every one is on the shopping list',
          below > 0 and missing == 0 and por_comprar >= below, f'below_min={below} missing={missing} por_comprar={por_comprar}')

    # ── A7: cancelled tickets with consumption are visible ───────────────────
    print("\n== A7. anomalies show cancelled-with-consumption and force-closed ==")
    exp_cancel = scalar("""SELECT COUNT(*) FROM tickets t WHERE t.status='CANCELLED' AND (
          EXISTS (SELECT 1 FROM ticket_line_items li WHERE li.ticket_id=t.id
                   AND COALESCE(li.status,'') <> 'VOIDED')
       OR EXISTS (SELECT 1 FROM pool_timer_sessions p WHERE p.ticket_id=t.id
                   AND COALESCE(p.status,'') <> 'CANCELLED' AND COALESCE(p.charge_cents,0) > 0))""")
    got_cancel = scalar("SELECT COUNT(*) FROM v_bola8_anomalias_operativas WHERE tipo='TICKET_CANCELADO'")
    check('A7. every cancelled ticket with consumption appears', got_cancel == exp_cancel and exp_cancel > 0,
          f'{got_cancel}/{exp_cancel}')
    exp_force = scalar("SELECT COUNT(*) FROM audit_log WHERE action='TICKET_FORCE_CLOSE'")
    got_force = scalar("SELECT COUNT(*) FROM v_bola8_anomalias_operativas WHERE tipo='CIERRE_FORZADO'")
    check('A7b. every force-close appears', got_force == exp_force, f'{got_force}/{exp_force}')

    # ── A8: bar-local "today" ────────────────────────────────────────────────
    print("\n== A8. views use the bar's calendar day ==")
    from datetime import datetime
    from zoneinfo import ZoneInfo
    bar_today = datetime.now(ZoneInfo('America/Mexico_City')).date()
    check('A8. fn_bar_today() == today in Mexico City', scalar('SELECT fn_bar_today()') == bar_today,
          f"{scalar('SELECT fn_bar_today()')} vs {bar_today}")
    first_fc = scalar('SELECT MIN(fecha_forecast) FROM v_bola8_forecast_semanal')
    check('A8b. weekly forecast starts today (bar time)', first_fc == bar_today, f'{first_fc}')

    # ── A10: CSV export ──────────────────────────────────────────────────────
    print("\n== A10. CSV export works for every table tab ==")
    tabs = ['sales', 'pool', 'payments', 'staff', 'voids', 'modifiers', 'peak-hours',
            'promotions', 'menu-deletions', 'inv-deletions']   # cigarettes removed in D3
    results = {}
    for tab in tabs:
        r = client.get(f'/api/v1/reports/export?type={tab}&format=csv'
                       f'&from=2026-07-01T00:00:00&to=2026-07-31T23:59:59', headers=H)
        results[tab] = (r.status_code, len(r.data))
    check('A10. every tab exports (200)', all(c == 200 for c, _ in results.values()), f'{results}')
    check('A10b. July sales/payments/staff/peak-hours exports are not empty',
          all(results[t][1] > 50 for t in ('sales', 'payments', 'staff', 'peak-hours')), f'{results}')
    r = client.get('/api/v1/reports/export?type=charts&format=csv', headers=H)
    check('A10c. a non-table tab says so (422) instead of an empty file', r.status_code == 422,
          f'{r.status_code}')

    # ── A11: hours by order time ─────────────────────────────────────────────
    print("\n== A11. peak hours: revenue by when it was generated ==")
    r = client.get('/api/v1/reports/peak-hours?from=2026-07-01&to=2026-07-31', headers=H)
    ph = r.get_json() or []
    items = int(scalar("""SELECT COALESCE(SUM(v.net_sales_cents),0) FROM v_bola8_lineas_venta v
        JOIN tickets t ON t.id=v.ticket_id WHERE t.closed_at BETWEEN :a AND :b""",
        a='2026-07-01T06:00:00+00:00', b='2026-08-01T05:59:59.999999+00:00'))
    pool = int(scalar("""SELECT COALESCE(SUM(p.charge_cents),0) FROM pool_timer_sessions p
        JOIN tickets t ON t.id=p.ticket_id WHERE t.status='CLOSED' AND COALESCE(p.status,'') <> 'CANCELLED'
        AND t.closed_at BETWEEN :a AND :b""",
        a='2026-07-01T06:00:00+00:00', b='2026-08-01T05:59:59.999999+00:00'))
    check('A11. hourly revenue == item sales + pool charges (nothing lost or doubled)',
          r.status_code == 200 and sum(h['revenue_cents'] for h in ph) == items + pool,
          f"hours={sum(h['revenue_cents'] for h in ph)} items+pool={items + pool}")
    check('A11b. hourly tips == tips', sum(h['tips_cents'] for h in ph) == tips,
          f"{sum(h['tips_cents'] for h in ph)} vs {tips}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
