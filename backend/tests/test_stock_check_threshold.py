"""Stock check must survive items without a low-stock threshold (057).

Bola 8, 2026-11-26: 18 items had low_stock_threshold NULL; once the wing sauces
were restocked, GET /inventory/stock-check crashed (Decimal <= None) every 10 s
and the order picker lost its "Sin stock" labels and "Stock bajo" banner.

Runs against a SCRATCH database at 057:
    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_x \\
        billar-pos-backend -m tests.test_stock_check_threshold
"""
import os
import sys

url = os.environ.get('DATABASE_URL', '')
if 'scratch' not in url.rsplit('/', 1)[-1]:
    sys.exit(f'REFUSING: DATABASE_URL must point at a *scratch* database, got {url!r}')

from flask_jwt_extended import create_access_token  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models.user import User  # noqa: E402

PASS = FAIL = 0


def check(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'PASS: {label}')
    else:
        FAIL += 1
        print(f'FAIL: {label}  {detail}')


app = create_app()
with app.app_context():
    col = db.session.execute(text(
        "SELECT is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name='inventory_items' AND column_name='low_stock_threshold'")).one()
    check('1a. low_stock_threshold is NOT NULL', col[0] == 'NO', col)
    check('1b. low_stock_threshold defaults to 0', col[1] is not None and col[1].startswith('0'), col)
    check('1c. no item is left without a threshold',
          db.session.execute(text(
              'SELECT count(*) FROM inventory_items WHERE low_stock_threshold IS NULL')).scalar() == 0)

    # (1b covers inserts that leave the column out: they now get 0, not NULL.)

    try:
        db.session.execute(text(
            "UPDATE inventory_items SET low_stock_threshold = NULL WHERE id = "
            "(SELECT id FROM inventory_items LIMIT 1)"))
        db.session.flush()
        check('2b. setting a threshold to NULL is refused', False, 'NULL was accepted')
    except Exception:
        check('2b. setting a threshold to NULL is refused', True)
    db.session.rollback()

    u = User.query.filter_by(role='WAITER').first() or User.query.first()
    tok = create_access_token(identity=str(u.id), additional_claims={'role': u.role})
    r = app.test_client().get('/api/v1/inventory/stock-check',
                              headers={'Authorization': 'Bearer ' + tok})
    body = r.get_json(silent=True) or {}
    check('3a. stock-check answers 200 for a waiter', r.status_code == 200, r.status_code)
    check('3b. it returns the picker fields',
          all(k in body for k in ('blocked_items', 'remaining_by_item', 'low_stock_items')), list(body))

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
