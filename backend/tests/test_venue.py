"""Batch D1 -- the venue (name, timezone, currency) -- against a SCRATCH database.

COMMITS (changes settings, then restores them). Refuses to run unless
DATABASE_URL names a database containing "scratch". Expects 040-045. Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_b1 \\
        billar-pos-backend -m tests.test_venue
"""
import os
import sys
from datetime import datetime
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


app = create_app()
app.config['TESTING'] = True
client = app.test_client()

with app.app_context():
    from app.services import venue_svc
    from app.analytics_views import ensure_analytics_views
    check('0a. env defaults copied into settings (idempotent)',
          venue_svc.ensure_defaults() >= 0 and venue_svc.ensure_defaults() == 0)
    check('0b. analytics views rebuild with fn_bar_tz()', ensure_analytics_views(db) is True)
    tok = {r: {'Authorization': 'Bearer ' + create_access_token(
        identity=u.id, additional_claims={'role': u.role, 'name': u.name})}
        for r in ('ADMIN', 'MANAGER') for u in [User.query.filter_by(role=r, is_active=True).first()]}
    db.session.commit()

    print("== 1. public venue endpoint ==")
    r = client.get('/api/v1/venue')
    v = r.get_json() or {}
    check('1a. GET /api/v1/venue works without logging in (login screen needs it)',
          r.status_code == 200 and {'name', 'timezone', 'currency', 'locale', 'logo'} <= set(v), f'{v}')

    print("\n== 2. who can change what ==")
    r = client.put('/api/v1/settings/venue.name', headers=tok['MANAGER'], json={'value': 'Hack'})
    check('2a. a manager cannot rename the venue (403)', r.status_code == 403, f'{r.status_code}')
    r = client.put('/api/v1/settings/spirits.auto_convert_enabled', headers=tok['MANAGER'], json={'value': 'true'})
    check('2b. a manager can no longer flip system switches (auto-convert) (403)', r.status_code == 403,
          f'{r.status_code}')
    r = client.put('/api/v1/settings/kds_sound_enabled', headers=tok['MANAGER'], json={'value': 'true'})
    check('2c. a manager can still change their screen preferences', r.status_code == 200, f'{r.status_code}')
    r = client.put('/api/v1/settings/venue.timezone', headers=tok['ADMIN'], json={'value': 'Mars/Olympus'})
    check('2d. an invalid timezone is refused (422)', r.status_code == 422, f'{r.status_code}')
    r = client.put('/api/v1/settings/venue.currency', headers=tok['ADMIN'], json={'value': 'pesos'})
    check('2e. an invalid currency is refused (422)', r.status_code == 422, f'{r.status_code}')
    r = client.put('/api/v1/settings/venue.logo', headers=tok['ADMIN'], json={'value': 'javascript:alert(1)'})
    check('2f. a logo must be an image data URL (422)', r.status_code == 422, f'{r.status_code}')

    print("\n== 3. the timezone drives every date ==")
    orig = {k: scalar("SELECT value FROM settings WHERE key = :k", k=k)
            for k in ('venue.name', 'venue.timezone', 'venue.currency', 'venue.day_cutoff')}
    # Section 3 tests the timezone alone: calendar days (section 5 tests the cutoff).
    db.session.execute(text("DELETE FROM settings WHERE key = 'venue.day_cutoff'"))
    db.session.commit()
    check('3a. no view hard-codes America/Mexico_City any more',
          scalar("SELECT count(*) FROM pg_views WHERE schemaname='public' "
                 "AND definition LIKE '%America/Mexico_City%'") == 0)
    # a ticket closed 05:30 UTC: 23:30 previous day in Mexico City, 00:30 next day in Bogotá? no --
    # Bogotá is UTC-5 => 00:30 same UTC day. Pick one where the two zones disagree.
    tk = db.session.execute(text("""
        SELECT id, closed_at FROM tickets WHERE status = 'CLOSED'
          AND (closed_at AT TIME ZONE 'America/Mexico_City')::date
              <> (closed_at AT TIME ZONE 'America/Bogota')::date
        LIMIT 1""")).first()
    day_mx = scalar("SELECT fecha_mx FROM v_bola8_tickets_cerrados WHERE ticket_id = :i", i=tk.id)
    r = client.put('/api/v1/settings/venue.timezone', headers=tok['ADMIN'], json={'value': 'America/Bogota'})
    db.session.commit()
    day_bo = scalar("SELECT fecha_mx FROM v_bola8_tickets_cerrados WHERE ticket_id = :i", i=tk.id)
    check('3b. owner switches to America/Bogota -> the same sale lands on the Bogotá day',
          r.status_code == 200 and day_bo != day_mx
          and day_bo == scalar("SELECT (CAST(:c AS timestamptz) AT TIME ZONE 'America/Bogota')::date",
                               c=tk.closed_at.isoformat()), f'{day_mx} -> {day_bo}')
    with app.test_request_context():
        check('3c. Python agrees: bar_tz() is America/Bogota', str(venue_svc.bar_tz()) == 'America/Bogota')
    from zoneinfo import ZoneInfo
    check('3d. fn_bar_today() follows the setting',
          scalar('SELECT fn_bar_today()') == datetime.now(ZoneInfo('America/Bogota')).date())

    print("\n== 4. name and currency ==")
    client.put('/api/v1/settings/venue.name', headers=tok['ADMIN'], json={'value': 'Billar La Esquina'})
    client.put('/api/v1/settings/venue.currency', headers=tok['ADMIN'], json={'value': 'cop'})
    v = client.get('/api/v1/venue').get_json()
    check('4a. renamed venue and currency (normalised to COP) are served',
          v['name'] == 'Billar La Esquina' and v['currency'] == 'COP', f'{v}')

    print("\n== 5. closing-hour cutoff (business day) ==")
    client.put('/api/v1/settings/venue.timezone', headers=tok['ADMIN'], json={'value': 'America/Mexico_City'})
    r = client.put('/api/v1/settings/venue.day_cutoff', headers=tok['ADMIN'], json={'value': '25:00'})
    check('5a. an invalid closing hour is refused (422)', r.status_code == 422, f'{r.status_code}')
    late = db.session.execute(text("""
        SELECT id, closed_at, total_cents,
               (closed_at AT TIME ZONE 'America/Mexico_City')::date AS cal_day,
               EXTRACT(hour FROM closed_at AT TIME ZONE 'America/Mexico_City')::int AS hr
        FROM tickets WHERE status = 'CLOSED' AND total_cents > 0
          AND EXTRACT(hour FROM closed_at AT TIME ZONE 'America/Mexico_City') BETWEEN 0 AND 5
        ORDER BY closed_at DESC LIMIT 1""")).first()
    r = client.put('/api/v1/settings/venue.day_cutoff', headers=tok['ADMIN'], json={'value': '06:00'})
    db.session.commit()
    row = db.session.execute(text("SELECT fecha_mx, hora_mx FROM v_bola8_tickets_cerrados WHERE ticket_id = :i"),
                             {'i': late.id}).first()
    from datetime import timedelta
    biz = late.cal_day - timedelta(days=1)
    check('5b. with a 06:00 close, an after-midnight sale belongs to the PREVIOUS business day',
          r.status_code == 200 and row.fecha_mx == biz, f'{late.closed_at} -> {row.fecha_mx} (calendar {late.cal_day})')
    check('5c. ... but keeps its real clock hour on hourly charts', row.hora_mx == late.hr, f'{row.hora_mx}')
    def biz_total(d):
        return int(scalar("""SELECT COALESCE(SUM(total_cents),0) FROM tickets WHERE status='CLOSED'
                              AND fn_bar_date(closed_at) = :d""", d=d))
    pay = client.get(f'/api/v1/reports/payments?from={biz}&to={biz}', headers=tok['ADMIN']).get_json()
    check('5d. Reportes for that business day include the late sale (same total as SQL)',
          sum(m['total_cents'] for m in pay) == biz_total(biz), f"{sum(m['total_cents'] for m in pay)} vs {biz_total(biz)}")
    ov = client.get(f'/api/v1/analytics/overview?from={biz}&to={biz}', headers=tok['ADMIN']).get_json()
    check('5e. Analítica agrees on the same business day', ov['totales']['ventas_cents'] == biz_total(biz),
          f"{ov['totales']['ventas_cents']}")
    with app.test_request_context():
        from datetime import datetime as _dt
        from zoneinfo import ZoneInfo as _Z
        venue_svc.invalidate()
        exp = (_dt.now(_Z('America/Mexico_City')) - timedelta(hours=6)).date()
        check('5f. Python business_today() applies the cutoff', venue_svc.business_today() == exp,
              f'{venue_svc.business_today()} vs {exp}')
    check('5g. SQL fn_bar_today() applies the cutoff', scalar('SELECT fn_bar_today()') == exp)

    print("\n== 6. safe pickups use the venue's day ==")
    db.session.execute(text("DELETE FROM settings WHERE key = 'venue.day_cutoff'"))
    sid = scalar("""INSERT INTO safe_collections (amount_cents, notes, collected_by, created_at)
                     VALUES (12345, 'test-d3-evening', (SELECT id FROM users WHERE role='ADMIN' LIMIT 1),
                             TIMESTAMPTZ '2026-07-15 20:30:00 America/Mexico_City') RETURNING id""")
    db.session.commit()
    day = client.get('/api/v1/safe?from=2026-07-15&to=2026-07-15', headers=tok['ADMIN']).get_json()
    nxt = client.get('/api/v1/safe?from=2026-07-16&to=2026-07-16', headers=tok['ADMIN']).get_json()
    check('6a. a pickup at 8:30 pm shows on THAT day (it used to land on the next one: UTC)',
          any(r['id'] == sid for r in day) and not any(r['id'] == sid for r in nxt),
          f"day={len(day)} next={len(nxt)}")
    db.session.execute(text("DELETE FROM safe_collections WHERE id = :i"), {'i': sid})
    db.session.commit()

    # restore whatever the install had
    for k, val in orig.items():
        db.session.execute(text("DELETE FROM settings WHERE key = :k"), {'k': k})
        if val is not None:
            db.session.execute(text("INSERT INTO settings (key, value) VALUES (:k, :v)"), {'k': k, 'v': val})
    db.session.commit()
    check('4b. settings restored', scalar("SELECT value FROM settings WHERE key='venue.timezone'")
          == orig['venue.timezone'])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
