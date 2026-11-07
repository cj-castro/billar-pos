"""Test scenarios for the close-ticket underpayment threshold.

Exercises the pure helper `_required_total_cents`, so no database is required:

    cd backend && python -m tests.test_close_required_total

Covers:
  1. Tickets with no running timer are held to the exact total + tip
  2. A timed ticket accepts the total the UI quoted, even though the pool
     charge grew between the quote and the server-side timer stop
  3. A quote can never be used to pay less than the ticket was worth before
     the timer stopped, nor is more than the real total ever required
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.tickets import _required_total_cents  # noqa: E402

passed = failed = 0


def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  -- {detail}" if detail else ''))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  -- {detail}" if detail else ''))


def req(total, tip=0, timer=0, quoted=None):
    return _required_total_cents(total_cents=total, tip_cents=tip,
                                 timer_charge=timer, expected_total_cents=quoted)


print("== 1. no timer: the exact bill is required ==")
check('1a. plain ticket requires total + tip', req(10000, tip=1500) == 11500)
check('1b. a quote cannot lower a non-timed bill',
      req(10000, tip=0, timer=0, quoted=9000) == 10000)

print()
print("== 2. timed ticket: the quoted total is the bar ==")
# Items 10000 + pool 5000 = 15000 at stop time; the UI quoted 14988 a few
# seconds earlier. Paying exactly what was quoted must close the ticket.
check('2a. exact-amount tender on a pool table is accepted',
      req(15000, tip=0, timer=5000, quoted=14988) == 14988)
check('2b. tip is still required on top of the quote',
      req(15000, tip=2000, timer=5000, quoted=14988) == 16988)
check('2c. without a quote, the whole timer accrual is absorbed',
      req(15000, tip=0, timer=5000, quoted=None) == 10000)

print()
print("== 3. the quote is clamped on both ends ==")
check('3a. a stale/forged low quote cannot underpay the pre-timer bill',
      req(15000, tip=0, timer=5000, quoted=1) == 10000)
check('3b. a quote above the real total never over-charges',
      req(15000, tip=0, timer=5000, quoted=99000) == 15000)
check('3c. a pure pool ticket still owes its pre-timer total of 0',
      req(5000, tip=0, timer=5000, quoted=4990) == 4990)
check('3d. timer charge larger than the total cannot go negative',
      req(5000, tip=0, timer=9000, quoted=None) == 0)

print()
print(f"{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
