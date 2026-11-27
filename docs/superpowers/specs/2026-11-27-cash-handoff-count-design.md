# Design: count the cash at every handoff (drawer, envelope, safe)

**Status:** for CJ's approval, 2026-11-27 (questions answered). No code yet.
**High-risk area:** cash sessions and the safe. Human review required.

---

## 1. Why

On 26 Nov 2026 Bola 8 ran its first blind cash count and came out $450.19 short.
$412 of that was two card payments rung as cash (found by matching the BBVA
statement). The investigation exposed two places where the POS loses track of
physical cash:

1. **The opening fund is typed, not counted.** Every night the manager types
   "$2,000". Nobody checks that $2,000 is actually in the drawer.
2. **The envelope disappears.** At close the manager takes the cash out of the
   drawer, puts it in an envelope and drops it in the safe. The POS records one
   number (the total counted) and nothing about the envelope. The safe page
   exists but is admin-only, not linked to any session, and unused since August.

If money goes missing between the close and the bank, today nobody can say
which step lost it.

**Goal:** every time cash changes hands, the person receiving it counts it
blind, by denomination, and the POS keeps the count. A difference then points
at one step: the shift, the drawer overnight, or the trip to the safe.

## 2. What CJ decided

- The manager takes the cash at close, puts it in an envelope and drops it in
  the safe.
- **The opening fund never leaves the drawer.** The envelope holds everything
  except the fund.
- **The ~$2,000 fund is for daily expenses** (ice, supplies, shift cover), not
  just change. Cash expenses are paid from the drawer and recorded in Gastos.
  Leaving the full fund at close refills it from the day's sales, so the
  envelope = sales − expenses − tips. This replaces the manual "FONDO CAJA:
  faltante ... para completar los 2K" expense entries seen on 20 Nov 2026.
  An unrecorded cash purchase shows up as a shortage; the close screen should
  remind the manager to record all purchases before counting.
- **Coins are counted too**, not just bills.
- **Print what stays in the drawer**, by denomination including coins. The
  slip goes **into the envelope**, not the drawer, so the next manager's
  opening count stays blind.
- **Managers cannot open the safe**: envelopes go in through a drop slot; only
  the owner opens it. No second PIN at close.
- **All safe cash is deposited at the bank in full.** No supplier payments or
  drawer change come out of the safe.
- Approach A (below): the whole chain in the POS, in two phases.

## 3. Goals, non-goals, anti-goals

**Goals**
- Close: count by denomination; split into "stays in drawer" and "envelope";
  print both.
- Opening: the next manager counts the drawer by denomination; the counted
  amount becomes the opening fund.
- Owner: count each envelope out of the safe, record bank deposits, see any
  difference per step.

**Non-goals**
- No change to the expected-cash formula (`_build_summary`). Only its input
  `opening_fund_cents` changes from typed to counted.
- No "Transferencia" payment method, no Rappi display fix, no receipt timezone
  fix: separate changes.
- No automatic import of the bank statement (phase 2 is manual entry).

**Anti-goals (failure even if it works)**
- A close at 5 am that takes much longer than today. The count grid must be
  fast: numeric keypad, Tab/Enter moves to the next denomination, totals live.
- A manager seeing the expected cash or any variance before the close is
  submitted (breaks the blind count). Opening variances are owner-only.
- A close blocked because the printer failed. Printing is best-effort; the
  slips can be reprinted from the session.
- Breaking the mobile app's close (see section 7).

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Whole chain in the POS: close split + slips + counted opening (phase 1); owner envelope count + bank deposit (phase 2). | Most work, but every gap is attributed to a step automatically. |
| B | Phase 1 only; owner tracks envelopes on paper or a spreadsheet. | Faster, but the owner's count is never compared by the system. |
| C | Paper envelope form with signatures, no code. | Free, but paper counts were copied before 26 Nov; no evidence it would be different. |

## 5. The flow

### 5.1 Close (manager) — phase 1

1. The manager pays the tips out of the drawer (existing step; the screen says
   "Paga las propinas antes de contar").
2. **Contar caja.** A grid, one row per denomination, the manager types how
   many of each. The total is calculated live. Expected cash is not shown.
3. **¿Qué se queda en caja?** A second grid: how many of each denomination stay
   in the drawer. Pre-filled with nothing; the target (the configured fund,
   default $2,000) is shown with a live "faltan / sobran" against the target.
   Each row cannot exceed what was counted in step 2.
4. The envelope is calculated: counted − stays, per denomination. Shown as a
   read-only list with its total.
5. Submit. The session closes as today; the manager then sees the close result
   as today (expected, counted, difference).
6. **Prints**, in this order:
   - **Sobre #N** slip: envelope number (large), business date, manager,
     amount by denomination, total. Goes inside the envelope.
   - **Queda en caja** slip: amount by denomination including coins, total,
     date, manager. **Goes into the envelope with the Sobre slip** (CJ's
     decision), so only the owner sees it.
   - After the close, managers cannot see or reprint the "queda en caja"
     figures (screen, `/cash/sessions`, session summary or reprint); only the
     owner can. The envelope slip may be reprinted by the manager.
   - The existing reconciliation and tip slips, unchanged.

### 5.2 Opening (next manager) — phase 1

1. The manager opens the drawer screen. Instead of typing a fund, they count the
   drawer by denomination (same grid). They do not see last night's slip
   figures on screen.
2. Submit. `opening_fund_cents` = counted total.
3. The POS compares with last night's "queda en caja". The difference is
   **owner-only**: on the owner's cash page and the Inicio home, never to the
   manager.

### 5.3 Safe (owner) — phase 2

1. The owner opens the safe page: a list of envelopes with number, date,
   manager, declared total, status (En caja fuerte / Contado / Depositado).
2. For each envelope the owner types the amount found (optionally by
   denomination). The difference vs declared is shown to the owner.
3. **Depósito al banco:** the owner selects envelopes, enters the amount
   deposited, the date and an optional reference (e.g. the folio from "DEPOSITO
   EFECTIVO PRACTIC"). The page shows envelopes total vs deposited.

## 6. Data (migration 058, phase 1 tables; phase 2 adds its own)

- `cash_counts`: id, session_id, kind (`CLOSE`, `DRAWER_LEFT`, `OPENING`),
  counted_by, counted_at, total_cents (integer).
- `cash_count_lines`: count_id, denomination_cents (integer), quantity
  (integer ≥ 0). Total = Σ denomination × quantity, computed by the server.
- `cash_envelopes`: id, number (sequential, human-readable), session_id
  (unique), declared_cents, created_by, created_at, status. Phase 2 adds
  counted_cents, counted_by, counted_at, deposit_id.
- Phase 2: `bank_deposits`: id, amount_cents, deposited_on, reference,
  created_by, created_at.
- `cash_sessions` unchanged. `opening_fund_cents` is written from the OPENING
  count; `closing_cash_counted_cents` from the CLOSE count.
- Settings: `cash.drawer_fund_cents` (default 200000) and
  `cash.denominations` (default from the venue currency; MXN = bills 1000, 500,
  200, 100, 50, 20; coins 20, 10, 5, 2, 1, 0.50). Generic, since the POS is sold
  to other bars.

All money in integer cents. Counts are append-only (no edit/delete endpoint);
corrections go through a new count with a reason, audited.

## 7. API and compatibility

- `POST /cash/open` and `POST /cash/close` accept `count` (list of
  denomination/quantity) and, for close, `drawer_left` (same shape). The server
  computes totals and the envelope.
- The old body (`opening_fund_cents` / `closing_cash_counted_cents` only) keeps
  working while setting `cash.count_by_denomination` is off. When it is on, the
  server refuses a close/open without counts, with a clear Spanish message.
- **Mobile app:** its cash screen sends totals only. Phase 1 updates the mobile
  cash screen to the same grid, or (builder's choice if mobile is not ready)
  the server's refusal message tells the manager to close from the POS screen.
  The setting is turned on only after the mobile app handles it.

## 8. Tests (plain-script style, added to ci_suite.txt)

- Close with counts: total = Σ lines; envelope = counted − drawer_left per
  denomination; drawer_left above counted is refused; negative quantities
  refused; unknown denomination refused.
- Opening with counts writes `opening_fund_cents`; the opening variance vs the
  previous night's drawer_left is returned to ADMIN only, never to MANAGER.
- While the session is open, a MANAGER still receives no expected cash
  (existing blind-count test stays and must still pass).
- Legacy total-only bodies work with the setting off and are refused with it on.
- After the close, a MANAGER never receives the drawer-left lines or total
  (status, sessions list, session summary, reprint); ADMIN does.
- Only ADMIN can call the recount endpoint; it keeps the old count row and
  writes an audit entry.
- Envelope numbers are sequential and unique per session.
- Phase 2: owner envelope count and deposit totals; MANAGER cannot read or write
  them.

## 9. Rollout

Phase 1 ships with the setting **off**; CJ deploys, checks the screens, then
turns it on. The first night after turning it on has no previous "queda en caja",
so no opening variance is computed that night.

## 10. Calls made by Claude (CJ to check)

- **Less than the fund after tips.** The close is not blocked. If "queda en
  caja" differs from the target, the manager must type a short note. The next
  opening is compared with what was actually left, not with the target.
  Since nothing comes out of the safe (CJ), topping up the drawer is not
  modeled; if the owner adds cash, the next opening shows it as an owner-only
  surplus and the close note explains it.
- **Corrections.** Managers cannot change a count after submitting it. Only the
  owner (ADMIN) can, at any time, through `POST /cash/sessions/<id>/recount`
  with the kind, the new lines and a reason. It adds a new count row (the old
  one stays), rewrites `closing_cash_counted_cents`, `opening_fund_cents` or the
  envelope's declared amount as appropriate, and writes an audit entry.
- **Old safe page.** Phase 1 does not touch `safe_collections`, its page, the
  mobile Reports card or the cash-flow analytics view
  (`analytics_views.py`). Phase 2 decides whether envelopes replace it.

## 11. Open questions for CJ

None. Answered 2026-11-27: the drawer slip goes into the envelope; managers
cannot open the safe (drop slot); all safe cash is deposited in full, so phase
2 needs no safe withdrawals or partial deposits (one envelope belongs to one
deposit; a deposit holds one or more envelopes).

## 12. Left to the builder

Screen layout of the grids, slip layout within the 48 mm thermal format, how
the Inicio home shows the owner's opening variance, exact Spanish/English
strings (both `es.ts` and `en.ts`).
