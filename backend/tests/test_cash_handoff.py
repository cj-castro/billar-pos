"""Cash handoff phase 1: open and close the drawer with a count by denomination.

The manager counts the drawer bill by bill at opening and at close. The close
also says what stays in the drawer ("queda en caja", the ~$2,000 expense fund);
the rest goes into one numbered envelope that goes into the safe.

COMMITS (opens/closes cash sessions, changes settings). Refuses to run unless
DATABASE_URL names a database containing "scratch". Run:

    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_handoff \\
        billar-pos-backend -m tests.test_cash_handoff
"""
import os
import secrets
import sys
import threading
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


def lines(**qty):
    """lines(B1000=1, C0_50=2) -> [{'key': 'B1000', 'qty': 1}, {'key': 'C0.50', 'qty': 2}]"""
    return [{'key': k.replace('_', '.'), 'qty': q} for k, q in qty.items()]


def as_dict(rows):
    return {r['key']: r['qty'] for r in rows}


COUNT_REQUIRED_MSG = 'Cuenta billetes y monedas en la pantalla de Caja del POS para cerrar.'
COUNT_REQUIRED_OPEN_MSG = 'Cuenta billetes y monedas en la pantalla de Caja del POS para abrir.'
API = '/api/v1'

app = create_app()
app.config['TESTING'] = True
client = app.test_client()

with app.app_context():
    users = {r: User.query.filter_by(role=r, is_active=True).first() for r in ('ADMIN', 'MANAGER')}
    tok = {r: {'Authorization': 'Bearer ' + create_access_token(
        identity=u.id, additional_claims={'role': u.role, 'name': u.name})} for r, u in users.items()}

    def put_setting(key, value, who='ADMIN'):
        return client.put(f'{API}/settings/{key}', headers=tok[who], json={'value': value})

    def open_session_id():
        return scalar("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")

    # Start clean: no open tickets (they block a close), no open drawer, flag off.
    db.session.execute(text("UPDATE tickets SET status = 'CANCELLED' WHERE status = 'OPEN'"))
    db.session.execute(text("UPDATE cash_sessions SET status = 'CLOSED', closed_at = now() WHERE status = 'OPEN'"))
    db.session.commit()
    put_setting('cash.count_by_denomination', 'off')
    put_setting('cash.drawer_fund_cents', '200000')

    # ── settings ─────────────────────────────────────────────────────────────
    print('== 1. settings ==')
    old_currency = client.get(f'{API}/venue').get_json()['currency']
    r = put_setting('venue.currency', 'USD')
    check('1a. (setup) venue currency set to USD', r.status_code == 200, f'{r.status_code}')
    r = put_setting('cash.count_by_denomination', 'on')
    j = r.get_json() or {}
    check('1b. count_by_denomination=on refused when the currency has no denomination table (422)',
          r.status_code == 422 and j.get('message') == 'No hay tabla de billetes y monedas para esta moneda',
          f'{r.status_code} {j}')
    check('1c. ... and the flag stayed off',
          scalar("SELECT value FROM settings WHERE key = 'cash.count_by_denomination'") == 'off')
    r = put_setting('cash.count_by_denomination', 'off')
    check('1d. turning it OFF is always allowed, even without a table', r.status_code == 200, f'{r.status_code}')
    r = put_setting('venue.currency', 'MXN')
    check('1e. (setup) venue currency back to MXN', r.status_code == 200, f'{r.status_code} (was {old_currency})')

    r = put_setting('cash.drawer_fund_cents', '-1')
    check('1f. drawer_fund_cents = -1 refused (422)', r.status_code == 422, f'{r.status_code}')
    r = put_setting('cash.drawer_fund_cents', '250000')
    check('1g. drawer_fund_cents = 250000 accepted', r.status_code == 200, f'{r.status_code}')
    st = client.get(f'{API}/cash/status', headers=tok['MANAGER']).get_json()
    check('1h. /cash/status shows the fund target', st.get('fund_target_cents') == 250000,
          f"{st.get('fund_target_cents')}")
    put_setting('cash.drawer_fund_cents', '200000')
    r = put_setting('cash.drawer_fund_cents', '200000', who='MANAGER')
    check('1i. a manager cannot change the fund target (403)', r.status_code == 403, f'{r.status_code}')

    st = client.get(f'{API}/cash/status', headers=tok['MANAGER']).get_json()
    den = st.get('denominations') or []
    check('1j. /cash/status lists the 12 MXN denominations in order',
          [d['key'] for d in den] == ['B1000', 'B500', 'B200', 'B100', 'B50', 'B20',
                                      'C20', 'C10', 'C5', 'C2', 'C1', 'C0.50']
          and den[0] == {'key': 'B1000', 'cents': 100000, 'kind': 'BILL'}, f'{den[:2]}')
    check('1k. /cash/status: fund_target_cents 200000, count_by_denomination false',
          st.get('fund_target_cents') == 200000 and st.get('count_by_denomination') is False,
          f"{st.get('fund_target_cents')} {st.get('count_by_denomination')}")

    # ── flag off: legacy bodies work exactly as before ───────────────────────
    print('\n== 2. flag off: legacy open / close ==')
    counts_before = scalar('SELECT count(*) FROM cash_counts')
    env_before = scalar('SELECT count(*) FROM cash_envelopes')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'opening_fund_cents': 150000})
    j = r.get_json() or {}
    check('2a. legacy open -> 201 with opening_fund_cents',
          r.status_code == 201 and j.get('opening_fund_cents') == 150000 and j.get('status') == 'OPEN',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'closing_cash_counted_cents': 99900, 'notes': 'legacy'})
    j = r.get_json() or {}
    check('2b. legacy close -> 200, response has only session + summary',
          r.status_code == 200 and set(j) == {'session', 'summary'}
          and j['session']['closing_cash_counted_cents'] == 99900 and j['session']['notes'] == 'legacy'
          and j['summary']['closing_cash_counted_cents'] == 99900, f'{r.status_code} {sorted(j)}')
    check('2c. legacy open/close wrote no counts and no envelope',
          scalar('SELECT count(*) FROM cash_counts') == counts_before
          and scalar('SELECT count(*) FROM cash_envelopes') == env_before)

    # ── flag on ──────────────────────────────────────────────────────────────
    print('\n== 3. flag on: open ==')
    r = put_setting('cash.count_by_denomination', 'on')
    check('3a. count_by_denomination=on accepted with MXN', r.status_code == 200, f'{r.status_code}')
    st = client.get(f'{API}/cash/status', headers=tok['MANAGER']).get_json()
    check('3b. /cash/status count_by_denomination true', st.get('count_by_denomination') is True)

    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'opening_fund_cents': 200000})
    j = r.get_json() or {}
    check('3c. legacy open -> 422 COUNT_REQUIRED with the Spanish message',
          r.status_code == 422 and j.get('error') == 'COUNT_REQUIRED' and j.get('message') == COUNT_REQUIRED_OPEN_MSG,
          f'{r.status_code} {j}')
    check('3d. ... and no session was opened', open_session_id() is None)

    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json=[{'key': 'B1000', 'qty': 1}])
    check('3d2. a JSON body that is not an object -> 422, no session',
          r.status_code == 422 and open_session_id() is None, f'{r.status_code}')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': 'B1000'})
    j = r.get_json() or {}
    check('3e. count that is not a list -> 422 BAD_COUNT', r.status_code == 422 and j.get('error') == 'BAD_COUNT',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': ['B1000']})
    j = r.get_json() or {}
    check('3f. count row that is not an object -> 422 BAD_COUNT',
          r.status_code == 422 and j.get('error') == 'BAD_COUNT', f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': lines(B999=1)})
    j = r.get_json() or {}
    check('3g. unknown denomination -> 422 UNKNOWN_DENOMINATION with key',
          r.status_code == 422 and j.get('error') == 'UNKNOWN_DENOMINATION' and j.get('key') == 'B999',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': lines(B500=-1)})
    j = r.get_json() or {}
    check('3h. negative quantity -> 422 NEGATIVE', r.status_code == 422 and j.get('error') == 'NEGATIVE'
          and j.get('key') == 'B500', f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': [{'key': 'B500', 'qty': 1.5}]})
    j = r.get_json() or {}
    check('3i. fractional quantity -> 422 NOT_INTEGER', r.status_code == 422 and j.get('error') == 'NOT_INTEGER',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': lines(B1000=10**9)})
    j = r.get_json() or {}
    check('3j. absurd quantity -> 422 TOO_LARGE (not a database error)',
          r.status_code == 422 and j.get('error') == 'TOO_LARGE', f'{r.status_code} {j}')
    check('3k. ... still no session opened by any refused body', open_session_id() is None)

    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': lines(B1000=1, B500=2)})
    j = r.get_json() or {}
    sid = j.get('id')
    check('3l. open with B1000x1 + B500x2 -> opening_fund_cents 200000',
          r.status_code == 201 and j.get('opening_fund_cents') == 200000, f'{r.status_code} {j}')
    check('3m. one OPENING count of 200000 with 2 lines',
          scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind = 'OPENING'", s=sid) == 1
          and scalar("SELECT total_cents FROM cash_counts WHERE session_id = :s AND kind = 'OPENING'", s=sid) == 200000
          and scalar("""SELECT count(*) FROM cash_count_lines l JOIN cash_counts c ON c.id = l.count_id
                        WHERE c.session_id = :s AND c.kind = 'OPENING'""", s=sid) == 2)

    print('\n== 4. flag on: close refusals ==')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'closing_cash_counted_cents': 580000, 'notes': 'x'})
    j = r.get_json() or {}
    check('4a. legacy close -> 422 COUNT_REQUIRED with the Spanish message',
          r.status_code == 422 and j.get('error') == 'COUNT_REQUIRED' and j.get('message') == COUNT_REQUIRED_MSG,
          f'{r.status_code} {j}')

    # counted 580000: 3x1000 + 4x500 + 2x200 + 3x100 + 10x10
    counted = lines(B1000=3, B500=4, B200=2, B100=3, C10=10)
    # left 200000: 3x500 + 2x200 + 10x10   ->  envelope: 3x1000 + 1x500 + 3x100 = 380000
    left = lines(B500=3, B200=2, C10=10)

    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': lines(B500=3, B200=3, C10=10), 'notes': ''})
    j = r.get_json() or {}
    check('4b. drawer_left row above counted -> 422 LEFT_EXCEEDS_COUNTED with key',
          r.status_code == 422 and j.get('error') == 'LEFT_EXCEEDS_COUNTED' and j.get('key') == 'B200',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': lines(C5=1)})
    j = r.get_json() or {}
    check('4c. drawer_left denomination not counted at all -> LEFT_EXCEEDS_COUNTED key C5',
          r.status_code == 422 and j.get('error') == 'LEFT_EXCEEDS_COUNTED' and j.get('key') == 'C5',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'], json=None, data='null',
                    content_type='application/json')
    check('4c2. close with a JSON null body -> 422 (was a 500), session stays open',
          r.status_code == 422 and scalar('SELECT status FROM cash_sessions WHERE id = :s', s=sid) == 'OPEN',
          f'{r.status_code}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': {'B500': 3}})
    j = r.get_json() or {}
    check('4d. drawer_left not a list -> 422 BAD_COUNT', r.status_code == 422 and j.get('error') == 'BAD_COUNT',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': lines(B500=3), 'notes': '   '})
    j = r.get_json() or {}
    check('4e. drawer_left 150000 (not the 200000 fund) with blank notes -> 422 NOTE_REQUIRED',
          r.status_code == 422 and j.get('error') == 'NOTE_REQUIRED' and j.get('message'), f'{r.status_code} {j}')
    check('4f. after every refusal the session is still OPEN, with no close counts and no envelope',
          scalar('SELECT status FROM cash_sessions WHERE id = :s', s=sid) == 'OPEN'
          and scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind <> 'OPENING'", s=sid) == 0
          and scalar('SELECT count(*) FROM cash_envelopes WHERE session_id = :s', s=sid) == 0)

    print('\n== 5. flag on: manager close ==')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': left, 'notes': ''})
    j = r.get_json() or {}
    env = j.get('envelope') or {}
    check('5a. close -> 200, closing_cash_counted_cents 580000',
          r.status_code == 200 and j['session']['closing_cash_counted_cents'] == 580000
          and j['session']['status'] == 'CLOSED', f'{r.status_code} {j}')
    check('5b. envelope declared_cents 380000 with a number',
          env.get('declared_cents') == 380000 and isinstance(env.get('number'), int), f'{env}')
    check('5c. envelope lines = counted - left',
          as_dict(env.get('lines') or []) == {'B1000': 3, 'B500': 1, 'B100': 3}, f"{env.get('lines')}")
    slip = j.get('slip_drawer_left') or {}
    check('5d. manager gets slip_drawer_left once (for the slip in the envelope)',
          slip.get('total_cents') == 200000 and as_dict(slip.get('lines') or []) == {'B500': 3, 'B200': 2, 'C10': 10},
          f'{slip}')
    check('5e. manager response has NO drawer_left', 'drawer_left' not in j, f'{sorted(j)}')
    check('5f. the summary is still there (expected / difference revealed after the close)',
          'expected_cash_cents' in j.get('summary', {}) and 'total_sales_cents' not in j.get('summary', {}))
    check('5g. stored: CLOSE 580000, DRAWER_LEFT 200000, envelope 380000',
          scalar("SELECT total_cents FROM cash_counts WHERE session_id = :s AND kind = 'CLOSE'", s=sid) == 580000
          and scalar("SELECT total_cents FROM cash_counts WHERE session_id = :s AND kind = 'DRAWER_LEFT'", s=sid) == 200000
          and scalar('SELECT declared_cents FROM cash_envelopes WHERE session_id = :s', s=sid) == 380000)
    check('5h. stored lines carry the denomination value in cents',
          scalar("""SELECT sum(l.denom_cents * l.quantity) FROM cash_count_lines l JOIN cash_counts c
                    ON c.id = l.count_id WHERE c.session_id = :s AND c.kind = 'CLOSE'""", s=sid) == 580000)

    from app.services import cash_handoff_svc
    cur = cash_handoff_svc.current_count(sid, 'CLOSE')
    check('5i. current_count(session, CLOSE) returns the close count',
          cur is not None and cur.total_cents == 580000)
    check('5j. fund_target_cents() == 200000', cash_handoff_svc.fund_target_cents() == 200000)

    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': left, 'notes': ''})
    j = r.get_json() or {}
    check('5k. close twice: second close -> 404 NO_OPEN_SESSION',
          r.status_code == 404 and j.get('error') == 'NO_OPEN_SESSION', f'{r.status_code} {j}')
    check('5l. close twice creates one envelope',
          scalar('SELECT count(*) FROM cash_envelopes WHERE session_id = :s', s=sid) == 1)
    db.session.commit()

    print('\n== 6. flag on: admin close with a note ==')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': left})
    sid2 = (r.get_json() or {}).get('id')
    check('6a. next opening counted 200000', r.status_code == 201
          and (r.get_json() or {}).get('opening_fund_cents') == 200000, f'{r.status_code}')
    r = client.post(f'{API}/cash/close', headers=tok['ADMIN'],
                    json={'count': lines(B500=4, B100=2), 'drawer_left': lines(B500=3),
                          'notes': 'Pagué propinas grandes'})
    j = r.get_json() or {}
    check('6b. drawer_left 150000 with a note -> 200', r.status_code == 200, f'{r.status_code} {j}')
    check('6c. admin response carries drawer_left',
          (j.get('drawer_left') or {}).get('total_cents') == 150000
          and as_dict(j['drawer_left']['lines']) == {'B500': 3}, f"{j.get('drawer_left')}")
    check('6d. envelope 70000 (1x500 + 2x100), number above the first envelope',
          (j.get('envelope') or {}).get('declared_cents') == 70000
          and as_dict(j['envelope']['lines']) == {'B500': 1, 'B100': 2}
          and j['envelope']['number'] > env.get('number', 0), f"{j.get('envelope')}")
    check('6e. the note is stored on the session and on the DRAWER_LEFT count',
          j['session']['notes'] == 'Pagué propinas grandes'
          and scalar("SELECT note FROM cash_counts WHERE session_id = :s AND kind = 'DRAWER_LEFT'",
                     s=sid2) == 'Pagué propinas grandes')

    print('\n== 7. two closes at the same moment ==')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': left})
    sid3 = (r.get_json() or {}).get('id')
    db.session.commit()
    results = []
    # Force a real overlap: close_session reads the fund target AFTER it has
    # seen the session as OPEN and BEFORE it takes the row lock. Holding both
    # requests there until both arrive means both believe the drawer is open;
    # only the row lock can stop the second one from closing it again.
    barrier = threading.Barrier(2, timeout=15)
    real_fund_target = cash_handoff_svc.fund_target_cents

    def fund_target_at_barrier():
        barrier.wait()
        return real_fund_target()

    def racer():
        with app.app_context():
            c = app.test_client()
            try:
                rr = c.post(f'{API}/cash/close', headers=tok['MANAGER'],
                            json={'count': counted, 'drawer_left': left, 'notes': ''})
                results.append(rr.status_code)
            except Exception as e:      # noqa: BLE001  (an unhandled DB error)
                results.append(repr(e)[:80])
            finally:
                db.session.remove()

    cash_handoff_svc.fund_target_cents = fund_target_at_barrier
    try:
        threads = [threading.Thread(target=racer) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
    finally:
        cash_handoff_svc.fund_target_cents = real_fund_target
    check('7a. one close wins (200), the other gets 404 -- never a 500',
          sorted(map(str, results)) == ['200', '404'], f'{results}')
    check('7b. exactly one envelope for that session',
          scalar('SELECT count(*) FROM cash_envelopes WHERE session_id = :s', s=sid3) == 1)
    check('7c. exactly one CLOSE and one DRAWER_LEFT count for that session',
          scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind = 'CLOSE'", s=sid3) == 1
          and scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind = 'DRAWER_LEFT'", s=sid3) == 1)

    print('\n== 8. flag off, body with a count: still accepted and recorded ==')
    put_setting('cash.count_by_denomination', 'off')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': lines(B500=4)})
    sid4 = (r.get_json() or {}).get('id')
    check('8a. open with a count while the flag is off -> 201, count recorded',
          r.status_code == 201 and (r.get_json() or {}).get('opening_fund_cents') == 200000
          and scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind = 'OPENING'", s=sid4) == 1,
          f'{r.status_code}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': lines(B500=6), 'drawer_left': lines(B500=4)})
    j = r.get_json() or {}
    check('8b. close with a count while the flag is off -> 200 with an envelope of 100000',
          r.status_code == 200 and (j.get('envelope') or {}).get('declared_cents') == 100000, f'{r.status_code} {j}')

    # ── Task 4: owner-only figures and the overnight difference ──────────────
    # A MANAGER must never learn what was left in the drawer: not the amount,
    # not the lines, and not the envelope amount (counted - envelope = left).
    OWNER_ONLY = {'opening_variance_cents', 'drawer_left_cents', 'drawer_left',
                  'envelope_declared_cents', 'declared_cents', 'envelope_lines',
                  'diferencia_apertura_cents'}

    def keys_found(obj, wanted, path=''):
        """Every key in `wanted` anywhere in a JSON response (recursive)."""
        found = []
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in wanted:
                    found.append(path + k)
                found += keys_found(v, wanted, path + k + '.')
        elif isinstance(obj, list):
            for v in obj:
                found += keys_found(v, wanted, path)
        return found

    def row_of(rows, session_id):
        return next((x for x in rows if x.get('id') == session_id), None)

    print('\n== 9. small fixes from the Task 3 review ==')
    put_setting('cash.count_by_denomination', 'on')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': [{'key': ['B1000'], 'qty': 1}]})
    j = r.get_json() or {}
    check('9a. a key that is not a string -> 422 BAD_COUNT (was a 500)',
          r.status_code == 422 and j.get('error') == 'BAD_COUNT' and j.get('field') == 'count',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': [{'key': None, 'qty': 1}]})
    j = r.get_json() or {}
    check('9b. a null key -> 422 BAD_COUNT', r.status_code == 422 and j.get('error') == 'BAD_COUNT',
          f'{r.status_code} {j}')
    check('9c. ... no session opened', open_session_id() is None)

    # Night 1: opened with 200000 (B1000x1 + B500x2).
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': lines(B1000=1, B500=2)})
    night1 = (r.get_json() or {}).get('id')
    check('9d. (setup) night 1 opened', r.status_code == 201 and night1, f'{r.status_code}')
    db.session.commit()

    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': lines(B500=3), 'notes': 123})
    j = r.get_json() or {}
    check('9e. notes that are not a string -> 422 VALIDATION on field notes (was a 500)',
          r.status_code == 422 and j.get('error') == 'VALIDATION' and j.get('field') == 'notes',
          f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': left, 'notes': {'a': 1}})
    j = r.get_json() or {}
    check('9e2. ... also when the fund is exact (no note needed): 422 VALIDATION, not a 500',
          r.status_code == 422 and j.get('error') == 'VALIDATION', f'{r.status_code} {j}')
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'closing_cash_counted_cents': 1, 'notes': ['x']})
    check('9f. ... also on the legacy body', r.status_code == 422
          and (r.get_json() or {}).get('error') == 'VALIDATION', f'{r.status_code}')
    check('9g. ... session still OPEN, no close counts, no envelope',
          scalar('SELECT status FROM cash_sessions WHERE id = :s', s=night1) == 'OPEN'
          and scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind <> 'OPENING'", s=night1) == 0
          and scalar('SELECT count(*) FROM cash_envelopes WHERE session_id = :s', s=night1) == 0)

    # Night 1 close: counted 580000, leaves exactly the 200000 fund, envelope 380000.
    r = client.post(f'{API}/cash/close', headers=tok['MANAGER'],
                    json={'count': counted, 'drawer_left': left, 'notes': '  Todo bien  '})
    j = r.get_json() or {}
    env1 = (j.get('envelope') or {}).get('number')
    check('9h. night 1 closed by the MANAGER, envelope 380000',
          r.status_code == 200 and (j.get('envelope') or {}).get('declared_cents') == 380000, f'{r.status_code} {j}')
    check('9i. notes stripped once: same value on the session and on the DRAWER_LEFT count',
          j['session']['notes'] == 'Todo bien'
          and scalar("SELECT note FROM cash_counts WHERE session_id = :s AND kind = 'DRAWER_LEFT'",
                     s=night1) == 'Todo bien', f"{j['session']['notes']!r}")
    db.session.commit()

    print('\n== 10. reprint slips (GET /cash/sessions/<id>/slips) ==')
    mgr2 = User.query.filter_by(username='handoff_test_manager2').first()
    if mgr2 is None:
        mgr2 = User(username='handoff_test_manager2', name='Segundo Gerente', role='MANAGER', is_active=True)
        mgr2.set_password(secrets.token_urlsafe(16))  # throwaway scratch-DB user
        db.session.add(mgr2)
        db.session.commit()
    tok['MANAGER2'] = {'Authorization': 'Bearer ' + create_access_token(
        identity=mgr2.id, additional_claims={'role': 'MANAGER', 'name': mgr2.name})}
    waiter = User.query.filter_by(role='WAITER', is_active=True).first()

    r = client.get(f'{API}/cash/sessions/{night1}/slips', headers=tok['ADMIN'])
    j = r.get_json() or {}
    check('10a. ADMIN -> 200 with envelope, drawer_left and session',
          r.status_code == 200 and set(j) == {'envelope', 'drawer_left', 'session'}, f'{r.status_code} {j}')
    check('10b. envelope: number, declared 380000, lines = counted - left',
          j.get('envelope', {}).get('number') == env1 and j['envelope'].get('declared_cents') == 380000
          and j['envelope'].get('lines') == [{'key': 'B1000', 'qty': 3}, {'key': 'B500', 'qty': 1},
                                             {'key': 'B100', 'qty': 3}], f"{j.get('envelope')}")
    check('10c. drawer_left: total 200000 with its lines in display order',
          j.get('drawer_left') == {'total_cents': 200000, 'lines': [{'key': 'B500', 'qty': 3},
                                                                    {'key': 'B200', 'qty': 2},
                                                                    {'key': 'C10', 'qty': 10}]},
          f"{j.get('drawer_left')}")
    s = j.get('session') or {}
    check('10d. session: date, closed_at, closed_by_name',
          s.get('date') and s.get('closed_at') and s.get('closed_by_name') == users['MANAGER'].name, f'{s}')
    r = client.get(f'{API}/cash/sessions/{night1}/slips', headers=tok['MANAGER'])
    check('10e. the MANAGER who closed it -> 200 while no later session is open',
          r.status_code == 200 and (r.get_json() or {}).get('drawer_left', {}).get('total_cents') == 200000,
          f'{r.status_code}')
    r = client.get(f'{API}/cash/sessions/{night1}/slips', headers=tok['MANAGER2'])
    j = r.get_json() or {}
    check('10f. a different MANAGER -> 403 FORBIDDEN with the Spanish message',
          r.status_code == 403 and j == {'error': 'FORBIDDEN',
                                         'message': 'Solo el dueño puede reimprimir estos comprobantes.'},
          f'{r.status_code} {j}')
    if waiter is not None:
        wt = {'Authorization': 'Bearer ' + create_access_token(
            identity=waiter.id, additional_claims={'role': 'WAITER', 'name': waiter.name})}
        r = client.get(f'{API}/cash/sessions/{night1}/slips', headers=wt)
        check('10g. a WAITER -> 403', r.status_code == 403, f'{r.status_code}')
    legacy_sid = scalar("""SELECT s.id FROM cash_sessions s
                           WHERE s.status = 'CLOSED'
                             AND NOT EXISTS (SELECT 1 FROM cash_envelopes e WHERE e.session_id = s.id)
                           ORDER BY s.opened_at DESC LIMIT 1""")
    r = client.get(f'{API}/cash/sessions/{legacy_sid}/slips', headers=tok['ADMIN'])
    check('10h. a session without an envelope -> 404 NO_ENVELOPE',
          r.status_code == 404 and (r.get_json() or {}).get('error') == 'NO_ENVELOPE', f'{r.status_code} {r.get_json()}')
    r = client.get(f'{API}/cash/sessions/no-such-session/slips', headers=tok['ADMIN'])
    check('10i. an unknown session -> 404', r.status_code == 404, f'{r.status_code}')

    print('\n== 11. night 2: blind opening, owner sees the overnight difference ==')
    # Night 2 opens with 195000: B500x3 + B200x2 + C10x5. Last night left 200000.
    r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'count': lines(B500=3, B200=2, C10=5)})
    j = r.get_json() or {}
    night2 = j.get('id')
    check('11a. (setup) night 2 opened with 195000',
          r.status_code == 201 and j.get('opening_fund_cents') == 195000, f'{r.status_code} {j}')
    check('11b. MANAGER open response carries no owner-only key', not keys_found(j, OWNER_ONLY),
          f'{keys_found(j, OWNER_ONLY)}')
    db.session.commit()

    r = client.get(f'{API}/cash/{night2}/summary', headers=tok['ADMIN'])
    summ = (r.get_json() or {}).get('summary') or {}
    check('11c. ADMIN /cash/<night 2>/summary: opening_variance_cents == -5000',
          r.status_code == 200 and summ.get('opening_variance_cents') == -5000, f"{summ.get('opening_variance_cents')}")
    r = client.get(f'{API}/cash/current/summary', headers=tok['ADMIN'])
    summ = (r.get_json() or {}).get('summary') or {}
    check('11d. ADMIN /cash/current/summary (the owner cash page): opening_variance_cents == -5000',
          summ.get('opening_variance_cents') == -5000, f"{summ.get('opening_variance_cents')}")
    r = client.get(f'{API}/cash/{night1}/summary', headers=tok['ADMIN'])
    summ = (r.get_json() or {}).get('summary') or {}
    check('11e. ADMIN /cash/<night 1>/summary: drawer_left 200000, envelope number + 380000',
          summ.get('drawer_left_cents') == 200000 and summ.get('envelope_number') == env1
          and summ.get('envelope_declared_cents') == 380000, f'{summ}')
    rows = client.get(f'{API}/cash/sessions', headers=tok['ADMIN']).get_json() or []
    r1, r2 = row_of(rows, night1) or {}, row_of(rows, night2) or {}
    check('11f. ADMIN /cash/sessions: night 2 row opening_variance_cents == -5000', r2.get('opening_variance_cents') == -5000,
          f'{r2}')
    check('11g. ADMIN /cash/sessions: night 1 row drawer_left 200000, envelope number + 380000',
          r1.get('drawer_left_cents') == 200000 and r1.get('envelope_number') == env1
          and r1.get('envelope_declared_cents') == 380000, f'{r1}')
    check('11h. ADMIN: night 2 (still open) has no drawer_left and no envelope yet',
          'drawer_left_cents' in r2 and r2['drawer_left_cents'] is None
          and r2.get('envelope_number') is None and r2.get('envelope_declared_cents') is None, f'{r2}')
    r = client.get(f'{API}/cash/{sid}/summary', headers=tok['ADMIN'])
    summ = (r.get_json() or {}).get('summary') or {}
    check('11i. first opening after the flag went on (previous close had no drawer_left) -> null, not 0',
          'opening_variance_cents' in summ and summ['opening_variance_cents'] is None, f'{summ}')
    r = client.get(f'{API}/cash/{sid2}/summary', headers=tok['ADMIN'])
    summ = (r.get_json() or {}).get('summary') or {}
    check('11j. an opening that matched the drawer left exactly -> 0', summ.get('opening_variance_cents') == 0,
          f"{summ.get('opening_variance_cents')}")
    r = client.get(f'{API}/home', headers=tok['ADMIN'])
    uc = ((r.get_json() or {}).get('alertas') or {}).get('ultimo_cierre') or {}
    check('11k. ADMIN home: ultimo_cierre.diferencia_apertura_cents == -5000 (the opening after the last close)',
          r.status_code == 200 and uc.get('diferencia_apertura_cents') == -5000, f'{r.status_code} {uc}')

    print('\n== 12. a MANAGER never sees the drawer-left, by any door ==')
    doors = {
        '/cash/status': client.get(f'{API}/cash/status', headers=tok['MANAGER']),
        '/cash/sessions': client.get(f'{API}/cash/sessions', headers=tok['MANAGER']),
        '/cash/<night 1>/summary': client.get(f'{API}/cash/{night1}/summary', headers=tok['MANAGER']),
        '/cash/<night 2>/summary': client.get(f'{API}/cash/{night2}/summary', headers=tok['MANAGER']),
        '/cash/current/summary': client.get(f'{API}/cash/current/summary', headers=tok['MANAGER']),
        '/home': client.get(f'{API}/home', headers=tok['MANAGER']),
    }
    for name, resp in doors.items():
        found = keys_found(resp.get_json(), OWNER_ONLY)
        check(f'12. MANAGER {name}: 200 and no owner-only key anywhere', resp.status_code == 200 and not found,
              f'{resp.status_code} {found}')
    mrows = doors['/cash/sessions'].get_json() or []
    m1 = row_of(mrows, night1) or {}
    check('12a. MANAGER /cash/sessions: night 1 row carries envelope_number (to find the envelope)',
          m1.get('envelope_number') == env1, f'{m1}')
    msumm = (doors['/cash/<night 1>/summary'].get_json() or {}).get('summary') or {}
    check('12b. MANAGER /cash/<night 1>/summary carries envelope_number only',
          msumm.get('envelope_number') == env1 and 'envelope_declared_cents' not in msumm, f'{msumm}')
    for name in ('/cash/<night 2>/summary', '/cash/current/summary'):
        found = keys_found(doors[name].get_json(), {'expected_cash_cents', 'cash_over_short_cents'})
        check(f'12c. blind count still holds: MANAGER {name} on the OPEN session has no expected cash',
              not found, f'{found}')
    r = client.get(f'{API}/cash/sessions/{night1}/slips', headers=tok['MANAGER'])
    j = r.get_json() or {}
    check('12d. after night 2 opened, the MANAGER who closed night 1 can no longer reprint (403)',
          r.status_code == 403 and j.get('message') == 'Solo el dueño puede reimprimir estos comprobantes.',
          f'{r.status_code} {j}')
    r = client.get(f'{API}/cash/sessions/{night1}/slips', headers=tok['ADMIN'])
    check('12e. ... the owner still can (200)', r.status_code == 200, f'{r.status_code}')

    print('\n== 13. owner recount ==')
    RC = f'{API}/cash/sessions/{night1}/recount'
    close_c = lambda: scalar('SELECT closing_cash_counted_cents FROM cash_sessions WHERE id = :s', s=night1)
    env_c = lambda: scalar('SELECT declared_cents FROM cash_envelopes WHERE session_id = :s', s=night1)
    n_counts = lambda: scalar('SELECT count(*) FROM cash_counts WHERE session_id = :s', s=night1)
    n_audit = lambda: scalar("SELECT count(*) FROM audit_log WHERE action = 'CASH_RECOUNT'")
    db.session.commit()
    base_counts, base_audit = n_counts(), n_audit()
    body = {'kind': 'CLOSE', 'count': lines(B1000=1, B500=1, B100=1), 'reason': 'Conteo mal hecho'}
    r = client.post(RC, headers=tok['MANAGER'], json=body)
    check('13a. MANAGER recount -> 403', r.status_code == 403, f'{r.status_code}')
    r = client.post(RC, headers=tok['ADMIN'], json={**body, 'reason': '   '})
    check('13b. blank reason -> 422 REASON_REQUIRED',
          r.status_code == 422 and (r.get_json() or {}).get('error') == 'REASON_REQUIRED', f'{r.status_code} {r.get_json()}')
    r = client.post(RC, headers=tok['ADMIN'], json={k: v for k, v in body.items() if k != 'reason'})
    check('13c. missing reason -> 422', r.status_code == 422, f'{r.status_code}')
    r = client.post(RC, headers=tok['ADMIN'], json={**body, 'kind': 'ENVELOPE'})
    check('13d. bad kind -> 422', r.status_code == 422, f'{r.status_code}')
    r = client.post(RC, headers=tok['ADMIN'], json={**body, 'count': [{'key': 'B7', 'qty': 1}]})
    check('13e. bad count -> 422 UNKNOWN_DENOMINATION',
          r.status_code == 422 and (r.get_json() or {}).get('error') == 'UNKNOWN_DENOMINATION', f'{r.status_code}')
    r = client.post(f'{API}/cash/sessions/no-such/recount', headers=tok['ADMIN'], json=body)
    check('13f. unknown session -> 404', r.status_code == 404, f'{r.status_code}')
    db.session.rollback()
    check('13g. nothing written by the refused calls',
          n_counts() == base_counts and n_audit() == base_audit and close_c() == 580000 and env_c() == 380000,
          f'{n_counts()} {n_audit()} {close_c()} {env_c()}')

    # Recount DRAWER_LEFT above CLOSE: refused before writing anything.
    r = client.post(RC, headers=tok['ADMIN'], json={'kind': 'DRAWER_LEFT', 'count': lines(B1000=7), 'reason': 'x'})
    check('13h. DRAWER_LEFT more than CLOSE -> 422 LEFT_EXCEEDS_COUNTED',
          r.status_code == 422 and (r.get_json() or {}).get('error') == 'LEFT_EXCEEDS_COUNTED', f'{r.status_code} {r.get_json()}')
    db.session.rollback()
    check('13i. ... nothing written', n_counts() == base_counts and n_audit() == base_audit and env_c() == 380000)

    # CLOSE recount that makes the current DRAWER_LEFT exceed it: also refused.
    r = client.post(RC, headers=tok['ADMIN'], json={**body, 'count': lines(B500=1)})
    check('13j. CLOSE below DRAWER_LEFT -> 422 LEFT_EXCEEDS_COUNTED',
          r.status_code == 422 and (r.get_json() or {}).get('error') == 'LEFT_EXCEEDS_COUNTED', f'{r.status_code} {r.get_json()}')
    db.session.rollback()
    check('13k. ... nothing written', n_counts() == base_counts and close_c() == 580000 and env_c() == 380000)

    old_close_id = scalar("SELECT id FROM cash_counts WHERE session_id = :s AND kind = 'CLOSE'", s=night1)
    r = client.post(RC, headers=tok['ADMIN'], json={'kind': 'CLOSE', 'count': lines(B1000=3, B500=4, B200=2, B100=2, C10=10),
                                                    'reason': ' Faltó un billete '})
    j = r.get_json() or {}
    db.session.rollback()
    check('13l. ADMIN CLOSE recount -> 200, summary has the new figures',
          r.status_code == 200 and (j.get('summary') or {}).get('envelope_declared_cents') == 370000
          and (j.get('summary') or {}).get('drawer_left_cents') == 200000, f'{r.status_code} {j}')
    check('13m. closing_cash_counted_cents is the new count (570000)', close_c() == 570000, f'{close_c()}')
    check('13n. envelope declared == 370000', env_c() == 370000, f'{env_c()}')
    check('13o. old CLOSE row still exists; new row supersedes it with the trimmed reason',
          scalar('SELECT count(*) FROM cash_counts WHERE id = :i', i=old_close_id) == 1
          and scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind = 'CLOSE' AND supersedes_id = :i "
                     "AND reason = 'Faltó un billete' AND total_cents = 570000", s=night1, i=old_close_id) == 1
          and n_counts() == base_counts + 1)
    check('13p. exactly one audit row CASH_RECOUNT with the reason',
          n_audit() == base_audit + 1 and scalar(
              "SELECT count(*) FROM audit_log WHERE action = 'CASH_RECOUNT' AND entity_id = :s AND reason = 'Faltó un billete'",
              s=night1) == 1)

    r = client.post(RC, headers=tok['ADMIN'], json={'kind': 'DRAWER_LEFT', 'count': lines(B1000=1, B500=2, B200=2, C10=10),
                                                    'reason': 'Se dejó menos'})
    db.session.rollback()
    check('13q. DRAWER_LEFT recount -> envelope = CLOSE - DRAWER_LEFT (570000 - 250000 = 320000)',
          r.status_code == 200 and env_c() == 570000 - 250000 and close_c() == 570000, f'{r.status_code} {env_c()} {close_c()}')
    check('13r. current DRAWER_LEFT total is the new one',
          scalar("SELECT total_cents FROM cash_counts c WHERE session_id = :s AND kind = 'DRAWER_LEFT' AND NOT EXISTS "
                 "(SELECT 1 FROM cash_counts n WHERE n.supersedes_id = c.id)", s=night1) == 250000)

    check('13s. a MANAGER can still read the summary after the recount',
          client.get(f'{API}/cash/{night1}/summary', headers=tok['MANAGER']).status_code == 200)
    db.session.rollback()

    # OPENING recount works on an OPEN session; CLOSE/DRAWER_LEFT need a CLOSED one.
    r = client.post(f'{API}/cash/sessions/{night2}/recount', headers=tok['ADMIN'],
                    json={'kind': 'OPENING', 'count': lines(B500=4), 'reason': 'Apertura mal contada'})
    j = r.get_json() or {}
    db.session.rollback()
    check('13t. OPENING recount on an OPEN session -> 200, opening_fund_cents 200000',
          r.status_code == 200 and (j.get('session') or {}).get('opening_fund_cents') == 200000
          and scalar('SELECT opening_fund_cents FROM cash_sessions WHERE id = :s', s=night2) == 200000, f'{r.status_code} {j}')
    check('13u. ... and the owner summary shows opening_variance_cents -50000 (200000 - the 250000 left after recount)',
          (j.get('summary') or {}).get('opening_variance_cents') == -50000, f"{(j.get('summary') or {}).get('opening_variance_cents')}")
    r = client.post(f'{API}/cash/sessions/{night2}/recount', headers=tok['ADMIN'],
                    json={'kind': 'CLOSE', 'count': lines(B500=1), 'reason': 'x'})
    check('13v. CLOSE recount on an OPEN session -> 422 VALIDATION',
          r.status_code == 422 and (r.get_json() or {}).get('error') == 'VALIDATION', f'{r.status_code} {r.get_json()}')

    # Legacy session (closed, no counts, no envelope).
    r = client.post(f'{API}/cash/sessions/{legacy_sid}/recount', headers=tok['ADMIN'],
                    json={'kind': 'DRAWER_LEFT', 'count': lines(B500=1), 'reason': 'x'})
    check('13w. legacy session DRAWER_LEFT recount -> 422 NO_ENVELOPE',
          r.status_code == 422 and (r.get_json() or {}).get('error') == 'NO_ENVELOPE', f'{r.status_code} {r.get_json()}')
    r = client.post(f'{API}/cash/sessions/{legacy_sid}/recount', headers=tok['ADMIN'],
                    json={'kind': 'CLOSE', 'count': lines(B500=2), 'reason': 'Dueño contó'})
    db.session.rollback()
    check('13x. legacy session CLOSE recount -> 200, new count has supersedes_id NULL, no envelope made',
          r.status_code == 200
          and scalar("SELECT closing_cash_counted_cents FROM cash_sessions WHERE id = :s", s=legacy_sid) == 100000
          and scalar("SELECT count(*) FROM cash_counts WHERE session_id = :s AND kind = 'CLOSE' AND supersedes_id IS NULL",
                     s=legacy_sid) == 1
          and scalar('SELECT count(*) FROM cash_envelopes WHERE session_id = :s', s=legacy_sid) == 0,
          f'{r.status_code} {r.get_json()}')

    print('\n== 14. close notes of an envelope session are owner-only ==')
    # The server forces a note exactly when what stays in the drawer is not
    # the fund, so that note usually says the amount. A manager must not read
    # it later (blind opening count). The owner keeps it. A legacy close (no
    # envelope) keeps its note visible to managers, as before.
    legacy_note_sid = scalar("SELECT id FROM cash_sessions WHERE notes = 'legacy' ORDER BY opened_at DESC LIMIT 1")
    rows_m = {d['id']: d for d in client.get(f'{API}/cash/sessions', headers=tok['MANAGER']).get_json() or []}
    rows_a = {d['id']: d for d in client.get(f'{API}/cash/sessions', headers=tok['ADMIN']).get_json() or []}
    check('14a. MANAGER /cash/sessions: the envelope session row has no notes',
          sid2 in rows_m and 'notes' not in rows_m[sid2], f"{sorted(rows_m.get(sid2, {}))}")
    check('14b. ADMIN /cash/sessions: the same row keeps its note',
          (rows_a.get(sid2) or {}).get('notes') == 'Pagué propinas grandes', f"{(rows_a.get(sid2) or {}).get('notes')}")
    check('14c. MANAGER /cash/sessions: a legacy close (no envelope) still shows its note',
          (rows_m.get(legacy_note_sid) or {}).get('notes') == 'legacy', f"{legacy_note_sid}")
    jm = client.get(f'{API}/cash/{sid2}/summary', headers=tok['MANAGER']).get_json() or {}
    ja = client.get(f'{API}/cash/{sid2}/summary', headers=tok['ADMIN']).get_json() or {}
    check('14d. MANAGER /cash/<id>/summary: session object has no notes',
          'session' in jm and 'notes' not in jm['session'], f"{sorted(jm.get('session') or {})}")
    check('14e. ADMIN /cash/<id>/summary: session object keeps the note',
          (ja.get('session') or {}).get('notes') == 'Pagué propinas grandes')
    found = keys_found(jm, {'notes'})
    check('14f. the note appears nowhere in the MANAGER summary response', not found, f'{found}')
    jl = client.get(f'{API}/cash/{legacy_note_sid}/summary', headers=tok['MANAGER']).get_json() or {}
    check('14g. MANAGER /cash/<legacy id>/summary keeps the note', (jl.get('session') or {}).get('notes') == 'legacy')
    db.session.rollback()

    # Leave the scratch database with no open drawer and the flag off.
    r = client.post(f'{API}/cash/close', headers=tok['ADMIN'],
                    json={'count': lines(B500=3, B200=2, C10=5), 'drawer_left': lines(B500=3, B200=2, C10=5),
                          'notes': 'fin de prueba'})
    check('12f. (cleanup) night 2 closed', r.status_code == 200, f'{r.status_code} {r.get_json()}')

    print('\n== 15. flag on but the currency has no denomination table ==')
    # The flag can only be turned on with a table, but the currency can change
    # afterwards. Then nobody can count, so a count must not be required:
    # open and close fall back to the legacy bodies instead of being blocked.
    r = put_setting('venue.currency', 'USD')
    check('15a. (setup) flag still on, venue currency set to USD',
          r.status_code == 200 and scalar("SELECT value FROM settings WHERE key = 'cash.count_by_denomination'") == 'on',
          f'{r.status_code}')
    try:
        check('15b. count_required() is False', cash_handoff_svc.count_required() is False)
        st = client.get(f'{API}/cash/status', headers=tok['MANAGER']).get_json() or {}
        check('15c. /cash/status: count_by_denomination false, no denominations',
              st.get('count_by_denomination') is False and st.get('denominations') == [], f'{st}')
        r = client.post(f'{API}/cash/open', headers=tok['MANAGER'], json={'opening_fund_cents': 200000})
        check('15d. legacy open -> 201 (not COUNT_REQUIRED)', r.status_code == 201, f'{r.status_code} {r.get_json()}')
        r = client.post(f'{API}/cash/close', headers=tok['MANAGER'], json={'closing_cash_counted_cents': 200000})
        check('15e. legacy close -> 200 (not COUNT_REQUIRED)', r.status_code == 200, f'{r.status_code} {r.get_json()}')
    finally:
        r = put_setting('venue.currency', 'MXN')
        check('15f. (cleanup) venue currency back to MXN', r.status_code == 200, f'{r.status_code}')
    check('15g. with MXN again, count_required() is True', cash_handoff_svc.count_required() is True)
    put_setting('cash.count_by_denomination', 'off')

    db.session.commit()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
