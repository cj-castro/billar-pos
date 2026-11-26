"""Batch E3 -- weekly purchase forecast -- against a SCRATCH database.

COMMITS (changes a few item settings). Never sends email: SMTP is intercepted.
Refuses to run unless DATABASE_URL names a database containing "scratch". Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_purchase_forecast
"""
import math
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
    from app.analytics_views import ensure_analytics_views
    check('0a. analytics views (incl. v_purchase_forecast) build', ensure_analytics_views(db) is True)
    db.session.commit()
    adm = User.query.filter_by(role='ADMIN', is_active=True).first()
    HA = {'Authorization': 'Bearer ' + create_access_token(
        identity=adm.id, additional_claims={'role': 'ADMIN', 'name': adm.name})}

    def item(name):
        db.session.expire_all()
        return InventoryItem.query.filter_by(name=name).first()

    def row(name):
        return db.session.execute(text("SELECT * FROM v_purchase_forecast WHERE name = :n"), {'n': name}).mappings().first()

    hasta = scalar("SELECT max(datos_hasta) FROM v_purchase_forecast")

    def uso(item_id):
        return Decimal(scalar("""
            SELECT COALESCE(SUM(-quantity_delta), 0) FROM inventory_movements
             WHERE inventory_item_id = :i AND created_at > CAST(:h AS timestamptz) - interval '28 days'
               AND created_at <= CAST(:h AS timestamptz)
               AND event_type IN ('SALE_DEDUCTION','SALE_CONSUMPTION','VOID_REVERSAL','WASTE')""",
                              i=item_id, h=hasta.isoformat()))

    print("== 1. based on what sold ==")
    check('1a. the window ends at the last closed sale (not "now" on a stale copy)',
          hasta is not None and abs((hasta - scalar("SELECT max(closed_at) FROM tickets WHERE status='CLOSED'")).total_seconds()) < 1,
          f'{hasta}')
    co = row('Corona')
    exp = uso(item('Corona').id)
    check('1b. Corona: weekly = net sales usage of the 4 weeks / 4 (independent SQL)',
          co is not None and Decimal(co['semanal_4s']) == (exp / 4).quantize(Decimal('0.01')),
          f"{co and co['semanal_4s']} vs {exp / 4}")
    check('1c. shots and loose cigarettes are not purchase lines (only bottles / boxes)',
          scalar("""SELECT count(*) FROM v_purchase_forecast f JOIN inventory_items i ON i.id = f.inventory_item_id
                    WHERE i.stock_nature = 'DERIVED'""") == 0)
    tb, tbs = item('Tequila Blanco Bottle'), item('Tequila Blanco Shot')
    ratio = Decimal(scalar("SELECT ratio FROM inventory_conversions WHERE from_item_id=:i AND is_active", i=tb.id))
    r = row('Tequila Blanco Bottle')
    exp_b = uso(tb.id) + uso(tbs.id) / ratio
    check('1d. Tequila Blanco Bottle: bottle-service sales + shots sold in ml / 750 = bottles per 4 weeks',
          abs(Decimal(r['uso_28d']) - exp_b) < Decimal('0.01'), f"{r['uso_28d']} vs {exp_b}")
    check('1e. ... and the open ml count as available bottles',
          abs(Decimal(r['disponible']) - (Decimal(tb.stock_quantity) + Decimal(tbs.stock_quantity) / ratio)) < Decimal('0.01'))

    print("\n== 2. how much to buy ==")
    corona = item('Corona')
    corona.purchase_pack_size = 24
    corona.purchase_unit_key = 'caja'
    db.session.commit()
    db.session.execute(text("SELECT fn_count_adjustment(:i, 10, :u, 'test E3')"), {'i': corona.id, 'u': adm.id})
    db.session.commit()
    co = row('Corona')
    obj = max(Decimal(co['pronostico_semana']) * Decimal('1.2'), Decimal(co['minimo']))
    exp_buy = math.ceil((obj - 10) / 24) * 24 if obj > 10 else 0
    check('2a. Corona (10 left, case of 24): (forecast + 20%) - stock, rounded UP to whole cases',
          int(co['comprar_unidades']) == exp_buy and (exp_buy == 0 or co['comprar_paquetes'] == exp_buy // 24),
          f"buy {co['comprar_unidades']} = {co['comprar_paquetes']} cajas (forecast {co['pronostico_semana']})")
    check('2b. forecast leans to a rising week: max(4-week avg, avg of that and the last 7 days)',
          Decimal(co['pronostico_semana']) == max(Decimal(co['semanal_4s']),
                                                  ((Decimal(co['uso_28d']) / 4 + Decimal(co['uso_7d'])) / 2)).quantize(Decimal('0.01')))
    db.session.execute(text("""INSERT INTO settings (key, value) VALUES ('purchasing.safety_pct', '50')
                               ON CONFLICT (key) DO UPDATE SET value = '50'"""))
    db.session.commit()
    co50 = row('Corona')
    check('2c. the owner\'s safety margin (purchasing.safety_pct) is applied',
          Decimal(co50['objetivo']) == max(Decimal(co50['pronostico_semana']) * Decimal('1.5'),
                                           Decimal(co50['minimo'])).quantize(Decimal('0.01'), rounding='ROUND_HALF_UP'),
          f"{co50['objetivo']}")
    db.session.execute(text("DELETE FROM settings WHERE key = 'purchasing.safety_pct'"))
    db.session.commit()
    m = db.session.execute(text("""SELECT name, estado FROM v_purchase_forecast
        WHERE uso_28d <= 0 AND minimo > disponible LIMIT 1""")).first()
    check('2d. no sales but below the owner\'s minimum -> MINIMO (not "COMPRAR")', m is None or m.estado == 'MINIMO',
          f'{m and tuple(m)}')
    u = db.session.execute(text("""SELECT count(*) FROM v_purchase_forecast
        WHERE estado = 'URGENTE' AND NOT (dias_cobertura <= 7)""")).scalar()
    check('2e. URGENTE only when it runs out within 7 days (coverage shown rounded to 0.1)', u == 0)

    print("\n== 3. one wording for screen, email and Telegram ==")
    from app.services import purchase_svc
    with app.test_request_context():
        f = purchase_svc.forecast()
        txt = purchase_svc.format_text(f)
        html = purchase_svc.format_html(f)
    check('3a. the forecast is for next Monday-Sunday', f['semana_txt'] and 'al' in f['semana_txt'], f['semana_txt'])
    check('3b. Telegram text: title, data window, and every item to buy (fits 4096)',
          txt.startswith('🛒 Compras — semana del') and 'Según ventas del' in txt and len(txt) <= 3800
          and all(i['nombre'] in txt for i in f['por_comprar'][:10]), f'{len(txt)} chars')
    check('3c. Corona reads in cases: "N caja (M botella)"',
          not f['por_comprar'] or any(i['nombre'] == 'Corona' and 'caja' in i['comprar_txt'] for i in f['items']))
    check('3d. email HTML groups by supplier and shows the estimated cost',
          '<html>' in html and 'Sin proveedor' in html and 'costo estimado' in html.lower())
    r = client.get('/api/v1/analytics/inventory', headers=HA)
    j = r.get_json() or {}
    check('3e. Reportes → Inventario shows the same forecast (same items to buy, same total)',
          r.status_code == 200 and j['resumen']['por_comprar'] == len(f['por_comprar'])
          and j['resumen']['costo_compra_estimado_cents'] == f['costo_total_cents'], f"{j.get('resumen')}")

    print("\n== 4. the Sunday email (SMTP intercepted -- nothing is sent) ==")
    sent = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout=None): sent['host'] = host
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def ehlo(self): pass
        def starttls(self): pass
        def login(self, u, p): sent['login'] = True
        def send_message(self, msg): sent['msg'] = msg

    import smtplib
    from app.config import Config
    real_smtp, real = smtplib.SMTP, (Config.SMTP_USER, Config.SMTP_PASSWORD, Config.REPORT_TO, Config.REPORT_FROM)
    smtplib.SMTP = FakeSMTP
    Config.SMTP_USER, Config.SMTP_PASSWORD = 'test', 'test'
    Config.REPORT_TO, Config.REPORT_FROM = 'owner@example.com', 'pos@example.com'
    try:
        with app.test_request_context():
            purchase_svc.send_weekly_email()
    finally:
        smtplib.SMTP = real_smtp
        Config.SMTP_USER, Config.SMTP_PASSWORD, Config.REPORT_TO, Config.REPORT_FROM = real
    msg = sent.get('msg')
    from email.header import decode_header
    subj = ''.join(p.decode(c or 'utf-8') if isinstance(p, bytes) else p
                   for p, c in decode_header(str(msg['Subject']))) if msg else ''
    check('4a. the weekly email goes to REPORT_TO with "Compras para la semana del …"',
          msg is not None and msg['To'] == 'owner@example.com' and 'Compras para la semana del' in subj, subj)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
