"""Reconcile historical data damage caused by the P0 defects.

The P0 fixes are forward-only: they stop new corruption but do not repair rows
already written. This script finds and (optionally) repairs that damage.

    python reconcile_p0_damage.py              # dry run, changes nothing
    python reconcile_p0_damage.py --apply      # perform the safe repairs

Three independent scans:

  A. PHANTOM STOCK  (P0-1, repairable)
     A double-void re-ran reverse_for_line_item against the same SaleItemCost
     rows, restoring ingredients that were never returned.

     Detection does NOT count duplicate VOID_REVERSAL rows: update_item_quantity
     legitimately reverses and re-consumes on every quantity edit, so a heavily
     edited line can hold several reversals and still be perfectly balanced.
     Instead the net movement per (inventory_item, line_item) is summed. Sales
     are negative and reversals positive, so a correctly behaved line nets <= 0
     always. A strictly positive net is stock that was invented. That signature
     is immune to legitimate churn.

     Repaired by deducting the excess and writing a MANUAL_ADJUSTMENT ledger
     entry, so the correction is auditable rather than a silent UPDATE.

  B. PHANTOM DISCOUNTS  (P0-2, repairable only while OPEN)
     Voiding a line left its HAPPY_HOUR / ITEM_DISCOUNT rows behind and
     recalculate_totals kept subtracting them, discounting products that were
     never served.

     OPEN tickets are repaired (orphan rows deleted, totals recalculated).
     CLOSED tickets are reported but deliberately NOT modified: their totals
     were already settled against a cash session, and silently rewriting
     historical revenue would corrupt reconciliation and break the audit trail.
     That money is unrecoverable; the figure is reported so it can be booked.

  C. INVALID QUANTITIES  (P0-3, report only)
     Quantities outside 1..99 reached the bill and the stock ledger. The correct
     value cannot be inferred, so these are listed for manual review.
"""
import argparse
import os
import sys
from collections import defaultdict
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import text

from app import create_app
from app.extensions import db
from app.models.inventory import InventoryItem
from app.models.ticket import Ticket, TicketLineItem, LineItemPromotion
from app.models.user import User
from app.services import audit_svc
from app.services.inventory_svc import _write_movement


def _money(cents):
    return f"${cents / 100:,.2f}"


def _hr(title):
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


# ── Scan A — phantom stock ────────────────────────────────────────────────────

PHANTOM_STOCK_SQL = text("""
    SELECT inventory_item_id,
           reference_id,
           SUM(quantity_delta) AS net
    FROM inventory_movements
    WHERE reference_id IS NOT NULL
      AND event_type IN ('SALE_DEDUCTION', 'SALE_CONSUMPTION', 'VOID_REVERSAL',
                         'MANUAL_ADJUSTMENT')
    GROUP BY inventory_item_id, reference_id
    HAVING SUM(quantity_delta) > 0
    ORDER BY SUM(quantity_delta) DESC
""")
# MANUAL_ADJUSTMENT is included so this script's own corrections count toward the
# net and the scan becomes idempotent: once a line is neutralised it nets 0 and
# is never flagged again. Operator adjustments never set reference_id (see
# inventory_svc.adjust_stock), so `reference_id IS NOT NULL` keeps them out.


def scan_phantom_stock():
    rows = db.session.execute(PHANTOM_STOCK_SQL).mappings().all()
    per_item = defaultdict(Decimal)
    for r in rows:
        per_item[r['inventory_item_id']] += Decimal(str(r['net']))
    return rows, per_item


def report_phantom_stock(rows, per_item):
    _hr("A. PHANTOM STOCK  (P0-1 — double-void inflated inventory)")
    if not rows:
        print("  None. Every line item nets <= 0; no stock was invented.")
        return
    print(f"  {len(rows)} line item(s) across {len(per_item)} inventory item(s) "
          f"show net-positive stock.\n")
    print(f"  {'Inventory item':<34} {'Phantom qty':>12} {'Current stock':>14} {'Corrected':>12}")
    print(f"  {'-' * 34} {'-' * 12} {'-' * 14} {'-' * 12}")
    for item_id, excess in sorted(per_item.items(), key=lambda kv: -kv[1]):
        item = db.session.get(InventoryItem, item_id)
        if item is None:
            print(f"  {('<deleted ' + item_id[:8] + '>'):<34} {float(excess):>12.4f} "
                  f"{'n/a':>14} {'n/a':>12}")
            continue
        cur = Decimal(str(item.stock_quantity or 0))
        print(f"  {(item.name or '?')[:34]:<34} {float(excess):>12.4f} "
              f"{float(cur):>14.4f} {float(cur - excess):>12.4f}")


def repair_phantom_stock(rows, actor_id):
    """Neutralise each over-restored line item individually.

    One correcting movement is written per (inventory item, line item) carrying
    that line's reference_id, so the line's net returns to exactly 0. Writing a
    single aggregated adjustment with no reference_id would leave every line
    still netting positive, and a second run would deduct the same quantity all
    over again -- the very non-idempotency this script exists to clean up.
    """
    touched = set()
    for r in rows:
        excess = Decimal(str(r['net']))
        item = db.session.get(InventoryItem, r['inventory_item_id'])
        if item is None or excess <= 0:
            continue
        before = Decimal(str(item.stock_quantity or 0))
        item.stock_quantity = before - excess
        _write_movement(
            item, 'MANUAL_ADJUSTMENT', -excess, actor_id,
            unit_cost_cents=item.unit_cost_cents,
            reference_id=r['reference_id'],
            reason=('Reconciliacion P0-1: retiro de existencia fantasma creada '
                    'por reversas de anulacion duplicadas.'),
        )
        audit_svc.log(actor_id, 'INVENTORY_RECONCILED', 'inventory_item', item.id,
                      before={'stock_quantity': float(before)},
                      after={'stock_quantity': float(item.stock_quantity),
                             'phantom_removed': float(excess),
                             'line_item_id': r['reference_id']})
        touched.add(item.id)
    return len(touched)


# ── Scan B — phantom discounts ────────────────────────────────────────────────

def scan_phantom_discounts():
    """Promotion rows still attached to a VOIDED line item, grouped by ticket."""
    rows = (db.session.query(LineItemPromotion, TicketLineItem, Ticket)
            .join(TicketLineItem, TicketLineItem.id == LineItemPromotion.line_item_id)
            .join(Ticket, Ticket.id == TicketLineItem.ticket_id)
            .filter(TicketLineItem.status == 'VOIDED')
            .all())
    open_t, closed_t = defaultdict(list), defaultdict(list)
    for lip, li, t in rows:
        (open_t if t.status == 'OPEN' else closed_t)[t].append(lip)
    return open_t, closed_t


def report_phantom_discounts(open_t, closed_t):
    _hr("B. PHANTOM DISCOUNTS  (P0-2 — discounts on voided items)")
    if not open_t and not closed_t:
        print("  None. No promotion rows are attached to voided line items.")
        return

    if open_t:
        total = sum(sum(l.discount_cents or 0 for l in v) for v in open_t.values())
        print(f"  OPEN tickets — repairable now: {len(open_t)} ticket(s), "
              f"{_money(total)} of phantom discount still being applied.\n")
        for t, lips in sorted(open_t.items(), key=lambda kv: -sum(l.discount_cents or 0 for l in kv[1])):
            amt = sum(l.discount_cents or 0 for l in lips)
            print(f"    ticket {t.id[:8]}  {len(lips)} row(s)  phantom {_money(amt)}  "
                  f"stored total {_money(t.total_cents or 0)}")

    if closed_t:
        total = sum(sum(l.discount_cents or 0 for l in v) for v in closed_t.values())
        print(f"\n  CLOSED tickets — NOT modified: {len(closed_t)} ticket(s), "
              f"{_money(total)} undercharged historically.")
        print("    These were settled against a cash session. Rewriting them would")
        print("    corrupt reconciliation, so they are reported only. This figure is")
        print("    revenue already lost and should be booked as such.\n")
        worst = sorted(closed_t.items(),
                       key=lambda kv: -sum(l.discount_cents or 0 for l in kv[1]))[:10]
        for t, lips in worst:
            amt = sum(l.discount_cents or 0 for l in lips)
            when = t.closed_at.strftime('%Y-%m-%d') if t.closed_at else '?'
            print(f"    ticket {t.id[:8]}  closed {when}  undercharged {_money(amt)}")
        if len(closed_t) > 10:
            print(f"    ... and {len(closed_t) - 10} more")


def _has_invalid_quantity(ticket):
    """True when any live line item carries a quantity outside 1..99.

    recalculate_totals multiplies quantity by unit price, so a ticket holding a
    negative quantity recomputes to a negative subtotal. Repairing such a ticket
    would replace one corruption with another, so these are deferred to the
    manual review list in scan C instead.
    """
    return (ticket.line_items
            .filter(TicketLineItem.status != 'VOIDED')
            .filter((TicketLineItem.quantity <= 0) | (TicketLineItem.quantity > 99))
            .count() > 0)


def repair_phantom_discounts(open_t, actor_id):
    repaired, deferred = 0, []
    for t, lips in open_t.items():
        if _has_invalid_quantity(t):
            deferred.append(t)
            continue
        before = {'subtotal_cents': t.subtotal_cents,
                  'discount_cents': t.discount_cents,
                  'total_cents': t.total_cents}
        for lip in lips:
            db.session.delete(lip)
        db.session.flush()
        t.recalculate_totals()
        t.version = (t.version or 1) + 1
        audit_svc.log(actor_id, 'TICKET_RECONCILED', 'ticket', t.id,
                      before=before,
                      after={'subtotal_cents': t.subtotal_cents,
                             'discount_cents': t.discount_cents,
                             'total_cents': t.total_cents},
                      reason='Reconciliacion P0-2: descuentos de articulos anulados')
        repaired += 1
    return repaired, deferred


# ── Scan C — invalid quantities ───────────────────────────────────────────────

def scan_invalid_quantities():
    return (db.session.query(TicketLineItem, Ticket)
            .join(Ticket, Ticket.id == TicketLineItem.ticket_id)
            .filter((TicketLineItem.quantity <= 0) | (TicketLineItem.quantity > 99))
            .all())


def report_invalid_quantities(rows):
    _hr("C. INVALID QUANTITIES  (P0-3 — quantity outside 1..99)")
    if not rows:
        print("  None. Every line item quantity is within 1..99.")
        return
    print(f"  {len(rows)} line item(s) found. The intended quantity cannot be")
    print("  inferred, so these are listed for manual review — nothing is changed.\n")
    for li, t in rows[:40]:
        print(f"    ticket {t.id[:8]} [{t.status:<9}] line {li.id[:8]}  "
              f"qty={li.quantity:<6} {(li.item_name or '?')[:30]}")
    if len(rows) > 40:
        print(f"    ... and {len(rows) - 40} more")


# ── Entry point ───────────────────────────────────────────────────────────────

def resolve_actor(explicit):
    if explicit:
        user = db.session.get(User, explicit)
        if user is None:
            sys.exit(f"--user {explicit} does not exist")
        return user.id
    user = (User.query.filter_by(role='ADMIN').order_by(User.created_at).first()
            or User.query.order_by(User.created_at).first())
    if user is None:
        sys.exit("No users exist; cannot attribute the reconciliation.")
    return user.id


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply', action='store_true',
                    help='Perform repairs. Without this nothing is written.')
    ap.add_argument('--user', help='User id to attribute repairs to (default: first ADMIN).')
    args = ap.parse_args()

    app = create_app()
    with app.app_context():
        stock_rows, per_item = scan_phantom_stock()
        open_t, closed_t = scan_phantom_discounts()
        bad_qty = scan_invalid_quantities()

        report_phantom_stock(stock_rows, per_item)
        report_phantom_discounts(open_t, closed_t)
        report_invalid_quantities(bad_qty)

        _hr("SUMMARY")
        lost = sum(sum(l.discount_cents or 0 for l in v) for v in closed_t.values())
        live = sum(sum(l.discount_cents or 0 for l in v) for v in open_t.values())
        print(f"  Phantom stock ...... {len(per_item)} inventory item(s) overstated")
        print(f"  Phantom discounts .. {_money(live)} live on OPEN tickets (repairable)")
        print(f"                       {_money(lost)} already lost on CLOSED tickets")
        print(f"  Invalid quantities . {len(bad_qty)} line item(s) need manual review")

        if not args.apply:
            print("\n  DRY RUN — nothing was written. Re-run with --apply to repair.")
            return

        actor_id = resolve_actor(args.user)
        try:
            items_fixed = repair_phantom_stock(stock_rows, actor_id)
            tickets_fixed, deferred = repair_phantom_discounts(open_t, actor_id)
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        print(f"\n  APPLIED — {items_fixed} inventory item(s) corrected, "
              f"{tickets_fixed} open ticket(s) recalculated.")
        if deferred:
            print(f"\n  DEFERRED — {len(deferred)} open ticket(s) were NOT repaired because")
            print("  they still hold an invalid quantity (scan C). Recalculating them would")
            print("  produce a negative subtotal. Correct the quantity, then re-run:")
            for t in deferred:
                print(f"    ticket {t.id}")
        print("  Every change is recorded in inventory_movements and audit_log.")


if __name__ == '__main__':
    main()
