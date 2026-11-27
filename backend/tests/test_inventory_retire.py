"""A deleted inventory item must leave the inventory list.

Bola 8, 2026-11-27: the owner deleted four Siglo Azul items. Each had stock
movements, so DELETE /inventory/<id> correctly SOFT-deleted them
(is_active=False, history kept for the reports) and answered 200. But
GET /inventory returned every item, active or not, so the items stayed in the
list; a second click got 409 "ya está desactivado". The same list feeds the
ingredient pickers in Menú and Modificadores, which offered retired items.

Now GET /inventory leaves inactive items out unless ?include_inactive=true,
and PATCH is_active=true brings one back.

Runs against a SCRATCH database (init-db + seed + migrations), e.g.:
    docker run --rm --entrypoint python --network billar-pos_billiardbar_net \\
        -v "$PWD:/repo" -w /repo/backend \\
        -e DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billar_scratch_x \\
        billar-pos-backend -m tests.test_inventory_retire
"""
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

url = os.environ.get('DATABASE_URL', '')
if 'scratch' not in url.rsplit('/', 1)[-1]:
    sys.exit(f'REFUSING: DATABASE_URL must point at a *scratch* database, got {url!r}')

from flask_jwt_extended import create_access_token  # noqa: E402

from app import create_app  # noqa: E402
from app.models.inventory import UnitCatalog  # noqa: E402
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
    admin = User.query.filter_by(role='ADMIN').first()
    H = {'Authorization': 'Bearer ' + create_access_token(
        identity=str(admin.id), additional_claims={'role': 'ADMIN'})}
    unit = UnitCatalog.query.first().key
    c = app.test_client()
    tag = uuid.uuid4().hex[:6]

    def listed(item_id, query=''):
        r = c.get('/api/v1/inventory' + query, headers=H)
        return any(i['id'] == item_id for i in r.get_json())

    # An item with history: created, then counted, so it has movements.
    r = c.post('/api/v1/inventory', headers=H,
               json={'name': f'Retire test {tag}', 'base_unit_key': unit, 'stock_quantity': 5, 'unit_cost_cents': 1000})
    check('1a. item created', r.status_code == 201, r.get_json())
    hist_id = r.get_json()['id']
    r = c.post(f'/api/v1/inventory/{hist_id}/adjust', headers=H,
               json={'event_type': 'COUNT_ADJUSTMENT', 'counted_quantity': 3, 'reason': 'test'})
    check('1b. count recorded (item has history)', r.status_code in (200, 201), r.get_json())

    r = c.delete(f'/api/v1/inventory/{hist_id}?force=true', headers=H)
    body = r.get_json() or {}
    check('2a. delete answers 200', r.status_code == 200, body)
    check('2b. item with history is soft-deleted', body.get('soft_deleted') is True, body)
    check('2c. soft-deleted item is NOT in the inventory list', not listed(hist_id))
    check('2d. it is in the list with ?include_inactive=true', listed(hist_id, '?include_inactive=true'))

    r = c.patch(f'/api/v1/inventory/{hist_id}', headers=H, json={'is_active': True})
    check('3a. reactivate answers 200', r.status_code == 200, r.get_json())
    check('3b. reactivated item is back in the list', listed(hist_id))

    # An item with no history is hard-deleted and gone from both lists.
    r = c.post('/api/v1/inventory', headers=H,
               json={'name': f'Retire test new {tag}', 'base_unit_key': unit})
    new_id = r.get_json()['id']
    r = c.delete(f'/api/v1/inventory/{new_id}', headers=H)
    check('4a. item without history is hard-deleted',
          r.status_code == 200 and (r.get_json() or {}).get('soft_deleted') is False, r.get_json())
    check('4b. it is gone even with ?include_inactive=true', not listed(new_id, '?include_inactive=true'))

    # Clean up: retire the test item again.
    c.delete(f'/api/v1/inventory/{hist_id}?force=true', headers=H)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
