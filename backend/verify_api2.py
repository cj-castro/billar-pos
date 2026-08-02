"""HTTP checks for the promo decision endpoint and time-window CRUD validation."""
import os, sys, uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ['DATABASE_URL'] = 'postgresql://postgres:pos@localhost:55432/posverify'
os.environ['JWT_SECRET_KEY'] = 'test'
os.environ['SECRET_KEY'] = 'test'

from app import create_app
from app.extensions import db
from app.models.user import User
from app.models.menu import MenuItem, MenuCategory
from app.models.ticket import Ticket, TicketLineItem
from app.models.promotion import Promotion

app = create_app()
P, F = 0, 0


def check(label, cond, detail=''):
    global P, F
    if cond:
        P += 1; print(f"PASS  {label}" + (f"  -- {detail}" if detail else ''))
    else:
        F += 1; print(f"FAIL  {label}" + (f"  -- {detail}" if detail else ''))


def uid():
    return str(uuid.uuid4())


with app.app_context():
    db.drop_all(); db.create_all()
    cat = MenuCategory(id=uid(), name='Cubetas', routing='BAR', sort_order=1)
    db.session.add(cat)
    bucket = MenuItem(id=uid(), name='Cubeta Premium', price_cents=70000,
                      category_id=cat.id, is_active=True)
    mgr = User(id=uid(), username='m1', name='Gerente', role='MANAGER')
    mgr.set_password('x')
    waiter = User(id=uid(), username='w1', name='Mesero', role='WAITER')
    waiter.set_password('x')
    db.session.add_all([bucket, mgr, waiter])
    db.session.commit()
    bucket_id, mgr_id, waiter_id = bucket.id, mgr.id, waiter.id

    from flask_jwt_extended import create_access_token
    mgr_tok = create_access_token(identity=mgr_id, additional_claims={'role': 'MANAGER'})
    w_tok = create_access_token(identity=waiter_id, additional_claims={'role': 'WAITER'})

MH = {'Authorization': f'Bearer {mgr_tok}'}
WH = {'Authorization': f'Bearer {w_tok}'}
c = app.test_client()
BASE = '/api/v1'

# ── A. CRUD validation of the time window ───────────────────────────────────
def mk(**extra):
    body = {'name': extra.pop('name', '2x1 Cubeta'), 'promo_type': 'BOGO',
            'applies_to_item_id': bucket_id, 'required_quantity': 2,
            'free_quantity': 1, **extra}
    return c.post(f'{BASE}/promotions', json=body, headers=MH)

r = mk(name='sin horario')
check('A1. promo without a window is accepted', r.status_code == 201, r.get_json())
check('A2. requires_confirmation defaults to false',
      r.get_json().get('requires_confirmation') is False, r.get_json().get('requires_confirmation'))
no_window_id = r.get_json()['id']

r = mk(name='con horario', happy_hour_start='16:00', happy_hour_end='18:00')
check('A3. valid window accepted', r.status_code == 201, r.get_json())
check('A4. window echoed back',
      r.get_json().get('happy_hour_start') == '16:00'
      and r.get_json().get('happy_hour_end') == '18:00', r.get_json())

r = mk(name='overnight', happy_hour_start='22:00', happy_hour_end='02:00')
check('A5. overnight window accepted (start > end)', r.status_code == 201, r.get_json())

r = mk(name='solo inicio', happy_hour_start='16:00')
check('A6. only a start is rejected',
      r.status_code == 422 and r.get_json()['error'] == 'INCOMPLETE_TIME_RANGE', r.get_json())
r = mk(name='solo fin', happy_hour_end='18:00')
check('A7. only an end is rejected',
      r.status_code == 422 and r.get_json()['error'] == 'INCOMPLETE_TIME_RANGE', r.get_json())
r = mk(name='basura', happy_hour_start='2500', happy_hour_end='18:00')
check('A8. malformed time is rejected',
      r.status_code == 422 and r.get_json()['error'] == 'INVALID_TIME_FORMAT', r.get_json())
r = mk(name='24h', happy_hour_start='24:00', happy_hour_end='25:00')
check('A9. out-of-range hour is rejected',
      r.status_code == 422 and r.get_json()['error'] == 'INVALID_TIME_FORMAT', r.get_json())
r = mk(name='iguales', happy_hour_start='16:00', happy_hour_end='16:00')
check('A10. identical start/end is rejected',
      r.status_code == 422 and r.get_json()['error'] == 'INVALID_TIME_RANGE', r.get_json())

r = mk(name='confirmar', requires_confirmation=True,
       happy_hour_start='16:00', happy_hour_end='18:00')
check('A11. requires_confirmation accepted', r.status_code == 201, r.get_json())
check('A12. requires_confirmation echoed back',
      r.get_json().get('requires_confirmation') is True)
confirm_id = r.get_json()['id']

r = c.patch(f'{BASE}/promotions/{confirm_id}',
            json={'happy_hour_start': None, 'happy_hour_end': None}, headers=MH)
check('A13. window can be cleared via PATCH',
      r.status_code == 200 and not r.get_json().get('happy_hour_start'), r.get_json())
r = c.patch(f'{BASE}/promotions/{confirm_id}', json={'happy_hour_start': '16:00'}, headers=MH)
check('A14. PATCH with only one end is rejected',
      r.status_code == 422 and r.get_json()['error'] == 'INCOMPLETE_TIME_RANGE', r.get_json())

# deactivate the extra promos so only `confirm_id` is live
with app.app_context():
    for p in Promotion.query.all():
        if p.id != confirm_id:
            p.is_active = False
    db.session.commit()

# ── B. Decision endpoint ────────────────────────────────────────────────────
with app.app_context():
    t = Ticket(id=uid(), status='OPEN', opened_by=waiter_id)
    db.session.add(t); db.session.flush()
    for _ in range(2):
        db.session.add(TicketLineItem(
            id=uid(), ticket_id=t.id, menu_item_id=bucket_id, item_name='Cubeta Premium',
            quantity=1, unit_price_cents=70000, routing_dest='BAR', status='SENT',
            sent_at=datetime.now(timezone.utc)))
    db.session.commit()
    tid = t.id

r = c.get(f'{BASE}/tickets/{tid}', headers=WH)
check('B1. GET ticket returns available_promotions',
      r.status_code == 200 and 'available_promotions' in r.get_json(), r.status_code)
offers = r.get_json()['available_promotions']
check('B2. the confirmable promo is offered', len(offers) == 1, str(offers))
check('B3. no discount applied yet', r.get_json()['discount_cents'] == 0)

r = c.post(f'{BASE}/tickets/{tid}/promotions/{confirm_id}', json={'decision': 'BOGUS'}, headers=WH)
check('B4. invalid decision rejected',
      r.status_code == 422 and r.get_json()['error'] == 'INVALID_DECISION', r.get_json())

r = c.post(f'{BASE}/tickets/{tid}/promotions/{uid()}', json={'decision': 'ACCEPTED'}, headers=WH)
check('B5. unknown promotion -> 404',
      r.status_code == 404 and r.get_json()['error'] == 'PROMO_NOT_FOUND', r.get_json())

r = c.post(f'{BASE}/tickets/{tid}/promotions/{no_window_id}',
           json={'decision': 'ACCEPTED'}, headers=WH)
check('B6. inactive/auto promo -> 404 or 409', r.status_code in (404, 409), r.get_json())

r = c.post(f'{BASE}/tickets/{tid}/promotions/{confirm_id}',
           json={'decision': 'DECLINED'}, headers=WH)
check('B7. DECLINE returns 200', r.status_code == 200, r.get_json())
check('B8. DECLINE leaves the discount at 0', r.get_json()['discount_cents'] == 0)
check('B9. DECLINE removes it from the offers', r.get_json()['available_promotions'] == [])

r = c.post(f'{BASE}/tickets/{tid}/promotions/{confirm_id}',
           json={'decision': 'ACCEPTED'}, headers=WH)
check('B10. ACCEPT returns 200', r.status_code == 200, r.get_json())
check('B11. ACCEPT applies the discount', r.get_json()['discount_cents'] == 70000,
      r.get_json()['discount_cents'])
check('B12. ACCEPT clears the offer', r.get_json()['available_promotions'] == [])
check('B13. the promo appears in applied_promotions',
      any(p['promotion_id'] == confirm_id for p in r.get_json()['applied_promotions']))
check('B14. per-line promo attribution is present',
      sum(i.get('promo_discount_cents', 0) for i in r.get_json()['line_items']) == 70000,
      [i.get('promo_discount_cents') for i in r.get_json()['line_items']])

r = c.get(f'{BASE}/tickets/{tid}', headers=WH)
check('B15. GET is stable after accepting',
      r.get_json()['discount_cents'] == 70000 and r.get_json()['available_promotions'] == [])

r = c.post(f'{BASE}/tickets/{tid}/promotions/{confirm_id}', json={'decision': 'ACCEPTED'},
           headers=WH)
check('B16. accepting twice is idempotent',
      r.status_code == 200 and r.get_json()['discount_cents'] == 70000, r.get_json())

r = c.post(f'{BASE}/tickets/{tid}/promotions/{confirm_id}')
check('B17. endpoint requires auth', r.status_code in (401, 422), r.status_code)

with app.app_context():
    tk = Ticket.query.get(tid); tk.status = 'CLOSED'; db.session.commit()
r = c.post(f'{BASE}/tickets/{tid}/promotions/{confirm_id}', json={'decision': 'DECLINED'},
           headers=WH)
check('B18. closed ticket rejects decisions',
      r.status_code == 403 and r.get_json()['error'] == 'TICKET_CLOSED', r.get_json())
r = c.get(f'{BASE}/tickets/{tid}', headers=WH)
check('B19. closed ticket offers nothing', r.get_json()['available_promotions'] == [])

print()
print(f"{P}/{P + F} checks passed")
sys.exit(1 if F else 0)
