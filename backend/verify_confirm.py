"""Integration checks for the promo confirmation + time window (real Postgres)."""
import os, sys, uuid
from datetime import datetime, timedelta, timezone, date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ['DATABASE_URL'] = 'postgresql://postgres:pos@localhost:55432/posverify'
os.environ['JWT_SECRET_KEY'] = 'test'
os.environ['SECRET_KEY'] = 'test'

from app import create_app
from app.extensions import db
from app.models.user import User
from app.models.menu import MenuItem, MenuCategory
from app.models.ticket import Ticket, TicketLineItem
from app.models.promotion import Promotion, TicketPromoDecision
from app.services import promotion_svc

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
    db.drop_all()
    db.create_all()

    cat = MenuCategory(id=uid(), name='Cubetas', routing='BAR', sort_order=1)
    db.session.add(cat)
    bucket = MenuItem(id=uid(), name='Cubeta Premium', price_cents=70000,
                      category_id=cat.id, is_active=True)
    nachos = MenuItem(id=uid(), name='Nachos', price_cents=15000,
                      category_id=cat.id, is_active=True)
    waiter = User(id=uid(), username='w1', name='Mesero', role='WAITER')
    waiter.set_password('x')
    db.session.add_all([bucket, nachos, waiter])
    db.session.commit()

    def new_ticket():
        t = Ticket(id=uid(), status='OPEN', opened_by=waiter.id)
        db.session.add(t)
        db.session.flush()
        return t

    def add(t, item, qty=1, sent_at=None):
        li = TicketLineItem(id=uid(), ticket_id=t.id, menu_item_id=item.id,
                            item_name=item.name, quantity=qty,
                            unit_price_cents=item.price_cents, routing_dest='BAR',
                            status='SENT', sent_at=sent_at or datetime.now(timezone.utc))
        db.session.add(li)
        db.session.flush()
        return li

    def mk_promo(**kw):
        p = Promotion(id=uid(), name=kw.pop('name', '2x1 Cubeta'),
                      promo_type=kw.pop('promo_type', 'BOGO'),
                      applies_to_item_id=bucket.id, required_quantity=2,
                      free_quantity=1, discounted_quantity=1, priority=0,
                      is_active=True, is_stackable=False,
                      combine_across_items=False, **kw)
        db.session.add(p)
        db.session.commit()
        return p

    # ── A. Migration / schema ────────────────────────────────────────────────
    from sqlalchemy import inspect, text
    cols = {c['name'] for c in inspect(db.engine).get_columns('promotions')}
    check('A1. promotions.requires_confirmation exists', 'requires_confirmation' in cols)
    check('A2. ticket_promo_decisions table exists',
          'ticket_promo_decisions' in inspect(db.engine).get_table_names())

    # ── B. Backward compatibility: no confirmation -> auto applies ───────────
    auto = mk_promo(name='2x1 auto')
    check('B1. requires_confirmation defaults to False', auto.requires_confirmation is False,
          repr(auto.requires_confirmation))
    t = new_ticket(); add(t, bucket); add(t, bucket); db.session.flush()
    promotion_svc.recompute_quantity_promos(t); t.recalculate_totals(); db.session.commit()
    check('B2. auto promo still applies without any decision', t.discount_cents == 70000,
          f"discount={t.discount_cents}")
    check('B3. nothing offered for an auto promo',
          promotion_svc.preview_pending_quantity_promos(t) == [])

    auto.is_active = False; db.session.commit()

    # ── C. Confirmation gate ────────────────────────────────────────────────
    confirm = mk_promo(name='2x1 confirmar', requires_confirmation=True)
    t2 = new_ticket(); add(t2, bucket); add(t2, bucket); db.session.flush()
    promotion_svc.recompute_quantity_promos(t2); t2.recalculate_totals(); db.session.commit()
    check('C1. promo needing confirmation does NOT auto-apply', t2.discount_cents == 0,
          f"discount={t2.discount_cents}")
    offers = promotion_svc.preview_pending_quantity_promos(t2)
    check('C2. it is offered instead', len(offers) == 1, str(offers))
    check('C3. offer carries the right discount',
          offers and offers[0]['discount_cents'] == 70000, str(offers))
    check('C4. offer carries id/name/type',
          offers and offers[0]['promotion_id'] == confirm.id
          and offers[0]['name'] == '2x1 confirmar' and offers[0]['promo_type'] == 'BOGO')

    # Accept it
    db.session.add(TicketPromoDecision(id=uid(), ticket_id=t2.id,
                                       promotion_id=confirm.id, decision='ACCEPTED'))
    db.session.flush()
    promotion_svc.recompute_quantity_promos(t2); t2.recalculate_totals(); db.session.commit()
    check('C5. ACCEPTED applies the discount', t2.discount_cents == 70000,
          f"discount={t2.discount_cents}")
    check('C6. accepted promo is no longer offered',
          promotion_svc.preview_pending_quantity_promos(t2) == [])
    check('C7. it shows in applied_promotions',
          any(p['promotion_id'] == confirm.id for p in t2.to_dict()['applied_promotions']))

    # Decline on a fresh ticket
    t3 = new_ticket(); add(t3, bucket); add(t3, bucket); db.session.flush()
    db.session.add(TicketPromoDecision(id=uid(), ticket_id=t3.id,
                                       promotion_id=confirm.id, decision='DECLINED'))
    db.session.flush()
    promotion_svc.recompute_quantity_promos(t3); t3.recalculate_totals(); db.session.commit()
    check('C8. DECLINED keeps the discount off', t3.discount_cents == 0,
          f"discount={t3.discount_cents}")
    check('C9. declined promo is not re-offered',
          promotion_svc.preview_pending_quantity_promos(t3) == [])

    # Decisions are per-ticket
    check('C10. the other ticket is unaffected by this decline', t2.discount_cents == 70000)

    # Changing your mind
    row = TicketPromoDecision.query.filter_by(ticket_id=t3.id).first()
    row.decision = 'ACCEPTED'; db.session.flush()
    promotion_svc.recompute_quantity_promos(t3); t3.recalculate_totals(); db.session.commit()
    check('C11. a declined promo can be accepted later', t3.discount_cents == 70000,
          f"discount={t3.discount_cents}")

    # Adding more items after accepting scales the promo, no drift
    add(t3, bucket); add(t3, bucket); db.session.flush()
    promotion_svc.recompute_quantity_promos(t3); t3.recalculate_totals(); db.session.commit()
    check('C12. 4 buckets after accepting -> promo applies twice',
          t3.discount_cents == 140000, f"discount={t3.discount_cents}")
    add(t3, nachos); db.session.flush()
    promotion_svc.recompute_quantity_promos(t3); t3.recalculate_totals(); db.session.commit()
    check('C13. adding an unrelated item does not change the promo',
          t3.discount_cents == 140000, f"discount={t3.discount_cents}")

    confirm.is_active = False; db.session.commit()

    # ── D. Time window ──────────────────────────────────────────────────────
    from zoneinfo import ZoneInfo
    from app.config import Config
    TZ = ZoneInfo(Config.TZ)

    def at(h):
        d = datetime.now(TZ).replace(hour=h, minute=0, second=0, microsecond=0)
        return d.astimezone(timezone.utc)

    hh = mk_promo(name='2x1 happy hour', happy_hour_start='16:00', happy_hour_end='18:00')
    t4 = new_ticket(); add(t4, bucket, sent_at=at(17)); add(t4, bucket, sent_at=at(17))
    db.session.flush()
    promotion_svc.recompute_quantity_promos(t4); t4.recalculate_totals(); db.session.commit()
    check('D1. both buckets ordered at 17:00 -> promo applies', t4.discount_cents == 70000,
          f"discount={t4.discount_cents}")

    # Recompute much later (simulating close_ticket after the window ends)
    promotion_svc.recompute_quantity_promos(t4); t4.recalculate_totals(); db.session.commit()
    check('D2. promo survives a recompute after the window closed',
          t4.discount_cents == 70000, f"discount={t4.discount_cents}")

    t5 = new_ticket(); add(t5, bucket, sent_at=at(20)); add(t5, bucket, sent_at=at(20))
    db.session.flush()
    promotion_svc.recompute_quantity_promos(t5); t5.recalculate_totals(); db.session.commit()
    check('D3. buckets ordered at 20:00 get no promo', t5.discount_cents == 0,
          f"discount={t5.discount_cents}")

    t6 = new_ticket(); add(t6, bucket, sent_at=at(17)); add(t6, bucket, sent_at=at(20))
    db.session.flush()
    promotion_svc.recompute_quantity_promos(t6); t6.recalculate_totals(); db.session.commit()
    check('D4. one in-window + one out -> not enough units', t6.discount_cents == 0,
          f"discount={t6.discount_cents}")

    # A third in-window bucket completes the pair
    add(t6, bucket, sent_at=at(16)); db.session.flush()
    promotion_svc.recompute_quantity_promos(t6); t6.recalculate_totals(); db.session.commit()
    check('D5. adding a second in-window bucket triggers it once',
          t6.discount_cents == 70000, f"discount={t6.discount_cents}")

    # Overnight window
    hh.happy_hour_start, hh.happy_hour_end = '22:00', '02:00'
    db.session.commit()
    t7 = new_ticket(); add(t7, bucket, sent_at=at(23)); add(t7, bucket, sent_at=at(1))
    db.session.flush()
    promotion_svc.recompute_quantity_promos(t7); t7.recalculate_totals(); db.session.commit()
    check('D6. overnight window covers 23:00 and 01:00', t7.discount_cents == 70000,
          f"discount={t7.discount_cents}")

    # Window + confirmation together
    hh.happy_hour_start, hh.happy_hour_end = '16:00', '18:00'
    hh.requires_confirmation = True
    db.session.commit()
    t8 = new_ticket(); add(t8, bucket, sent_at=at(20)); add(t8, bucket, sent_at=at(20))
    db.session.flush()
    check('D7. out-of-window promo is not even offered',
          promotion_svc.preview_pending_quantity_promos(t8) == [])
    t9 = new_ticket(); add(t9, bucket, sent_at=at(17)); add(t9, bucket, sent_at=at(17))
    db.session.flush()
    check('D8. in-window promo needing confirmation IS offered',
          len(promotion_svc.preview_pending_quantity_promos(t9)) == 1)

    # Expired date range beats the time window
    hh.valid_to = date.today() - timedelta(days=1)
    db.session.commit()
    check('D9. expired promo is not offered even inside the window',
          promotion_svc.preview_pending_quantity_promos(t9) == [])

print()
print(f"{P}/{P + F} checks passed")
sys.exit(1 if F else 0)
