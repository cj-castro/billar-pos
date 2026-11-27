"""Schema for cash counts by denomination and safe envelopes (058).

Runs against a SCRATCH database after init-db + seed + migrations:
    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_x \\
        billar-pos-backend -m tests.test_cash_counts_schema
"""
import os
import sys
import uuid

url = os.environ.get('DATABASE_URL', '')
if 'scratch' not in url.rsplit('/', 1)[-1]:
    sys.exit(f'REFUSING: DATABASE_URL must point at a *scratch* database, got {url!r}')

from sqlalchemy import text  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402

PASS = FAIL = 0


def check(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'PASS: {label}')
    else:
        FAIL += 1
        print(f'FAIL: {label}  {detail}')


def refused(sql, params=None):
    """True when the statement is rejected by the database."""
    try:
        with db.session.begin_nested():
            db.session.execute(text(sql), params or {})
        return False
    except Exception:
        return True


app = create_app()
with app.app_context():
    S = db.session
    q = lambda sql, **p: S.execute(text(sql), p).scalar()

    for t in ('cash_counts', 'cash_count_lines', 'cash_envelopes'):
        check(f'1. table {t} exists', q("SELECT to_regclass(:n)", n=t) is not None)

    check('2. schema_migrations has 058',
          q("SELECT count(*) FROM schema_migrations WHERE version='058'") == 1)
    check('3a. count_by_denomination defaults to off',
          q("SELECT value FROM settings WHERE key='cash.count_by_denomination'") == 'off')
    check('3b. drawer fund defaults to 200000',
          q("SELECT value FROM settings WHERE key='cash.drawer_fund_cents'") == '200000')

    for tbl, col in (('cash_counts', 'total_cents'), ('cash_count_lines', 'denom_cents'),
                     ('cash_envelopes', 'declared_cents')):
        dt = q("SELECT data_type FROM information_schema.columns "
               "WHERE table_name=:t AND column_name=:c", t=tbl, c=col)
        check(f'4. {tbl}.{col} is integer', dt == 'integer', dt)

    user_id = q("SELECT id FROM users LIMIT 1")
    sid = str(uuid.uuid4())
    S.execute(text("INSERT INTO cash_sessions (id, date, status, opened_by) "
                   "VALUES (:i, CURRENT_DATE, 'CLOSED', :u)"), {'i': sid, 'u': user_id})
    cid = str(uuid.uuid4())
    S.execute(text("INSERT INTO cash_counts (id, session_id, kind, total_cents, counted_by) "
                   "VALUES (:i, :s, 'CLOSE', 50000, :u)"), {'i': cid, 's': sid, 'u': user_id})
    check('5a. counted_at defaults to now',
          q("SELECT counted_at FROM cash_counts WHERE id=:i", i=cid) is not None)
    check('5b. unknown kind is refused',
          refused("INSERT INTO cash_counts (id, session_id, kind, total_cents, counted_by) "
                  "VALUES (:i, :s, 'BOGUS', 1, :u)",
                  {'i': str(uuid.uuid4()), 's': sid, 'u': user_id}))
    for k in ('OPENING', 'DRAWER_LEFT'):
        ok = not refused("INSERT INTO cash_counts (id, session_id, kind, total_cents, counted_by) "
                         "VALUES (:i, :s, :k, 1, :u)",
                         {'i': str(uuid.uuid4()), 's': sid, 'k': k, 'u': user_id})
        check(f'5c. kind {k} accepted', ok)

    S.execute(text("INSERT INTO cash_count_lines (count_id, denom_key, denom_cents, quantity) "
                   "VALUES (:c, 'B500', 50000, 1)"), {'c': cid})
    check('6a. negative quantity is refused',
          refused("INSERT INTO cash_count_lines (count_id, denom_key, denom_cents, quantity) "
                  "VALUES (:c, 'B200', 20000, -1)", {'c': cid}))
    check('6b. duplicate denomination for one count is refused',
          refused("INSERT INTO cash_count_lines (count_id, denom_key, denom_cents, quantity) "
                  "VALUES (:c, 'B500', 50000, 2)", {'c': cid}))
    check('6c. deleting a count that has lines is refused',
          refused("DELETE FROM cash_counts WHERE id=:c", {'c': cid}))

    e1 = str(uuid.uuid4())
    S.execute(text("INSERT INTO cash_envelopes (id, session_id, declared_cents, created_by) "
                   "VALUES (:i, :s, 50000, :u)"), {'i': e1, 's': sid, 'u': user_id})
    n1 = q("SELECT number FROM cash_envelopes WHERE id=:i", i=e1)
    check('7a. envelope gets a number', isinstance(n1, int), n1)
    check('7b. envelope status defaults to IN_SAFE',
          q("SELECT status FROM cash_envelopes WHERE id=:i", i=e1) == 'IN_SAFE')
    sid2 = str(uuid.uuid4())
    S.execute(text("INSERT INTO cash_sessions (id, date, status, opened_by) "
                   "VALUES (:i, CURRENT_DATE, 'CLOSED', :u)"), {'i': sid2, 'u': user_id})
    S.execute(text("INSERT INTO cash_envelopes (id, session_id, declared_cents, created_by) "
                   "VALUES (:i, :s, 1, :u)"), {'i': str(uuid.uuid4()), 's': sid2, 'u': user_id})
    n2 = S.execute(text("SELECT max(number) FROM cash_envelopes")).scalar()
    check('7d. next envelope number is n1 + 1', n2 == n1 + 1, (n1, n2))

    check('7c. a second envelope for the same session is refused',
          refused("INSERT INTO cash_envelopes (id, session_id, declared_cents, created_by) "
                  "VALUES (:i, :s, 1, :u)", {'i': str(uuid.uuid4()), 's': sid, 'u': user_id}))

    check('8. cash_counts index on (session_id, kind, counted_at) exists',
          q("SELECT count(*) FROM pg_indexes WHERE tablename='cash_counts' "
            "AND indexdef LIKE '%(session_id, kind, counted_at)%'") >= 1)

    S.rollback()   # leave the scratch DB as it was

    # ---- both install paths must end with the same catalogue -----------------
    sql_path = os.path.join(os.path.dirname(__file__), '..', 'migrations', 'sql', '058_cash_counts.sql')
    sql058 = open(sql_path, encoding='utf-8').read()
    TABLES = ('cash_counts', 'cash_count_lines', 'cash_envelopes')

    def snapshot():
        S.rollback()
        snap = {}
        for t in TABLES:
            snap[t] = {
                'indexes': sorted(r[0] for r in S.execute(text(
                    "SELECT indexdef FROM pg_indexes WHERE tablename=:t"), {'t': t})),
                'constraints': sorted(tuple(r) for r in S.execute(text(
                    "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conrelid = to_regclass(:t)"), {'t': t})),
                'columns': sorted(tuple(r) for r in S.execute(text(
                    "SELECT column_name, data_type, is_nullable, column_default "
                    "FROM information_schema.columns WHERE table_name=:t"), {'t': t})),
            }
        snap['sequence'] = S.execute(text(
            "SELECT count(*) FROM pg_class WHERE relkind='S' AND relname='cash_envelope_number_seq'")).scalar()
        S.rollback()
        return snap

    def run058():
        S.rollback()
        raw = db.engine.raw_connection()
        try:
            cur = raw.cursor()
            cur.execute(sql058)
            raw.commit()
        finally:
            raw.close()

    base = snapshot()
    env = base['cash_envelopes']
    uniq = [i for i in env['indexes'] if 'UNIQUE' in i]
    check('9a. cash_envelopes has exactly 3 unique indexes (pk, number, session_id)',
          len(uniq) == 3, uniq)
    check('9b. number defaults to nextval(cash_envelope_number_seq)',
          any(c[0] == 'number' and "nextval('cash_envelope_number_seq" in (c[3] or '')
              for c in env['columns']), env['columns'])
    check('9c. sequence exists', base['sequence'] == 1)

    run058()
    check('10. re-running 058 changes nothing (idempotent)', snapshot() == base)

    for t in ('cash_count_lines', 'cash_counts', 'cash_envelopes'):
        S.execute(text(f'DROP TABLE {t}'))
    S.execute(text('DROP SEQUENCE cash_envelope_number_seq'))
    S.commit()
    run058()
    after = snapshot()
    check('11. tables built by 058 alone match the create_all-first catalogue', after == base,
          [k for k in base if base[k] != after[k]])

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
