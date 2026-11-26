# Feature Prioritization

Rule: P0 = a shift cannot run on phones without it, or shipping without it is unsafe. IDs refer to `ROLE_FEATURE_MATRIX.md`. Detail: `USER_STORIES.md`, `ACCEPTANCE_CRITERIA.md`.

## P0 (v1 ship blockers)

| ID | Feature | Justification |
|---|---|---|
| F-X-01 | Server URL + health | No hardcoded IP (D8); first thing that fails on a new phone |
| F-X-02 | Login | Nothing works without a JWT |
| F-X-03 | Session restore + refresh | 8h token would otherwise force mid-shift logins |
| F-X-04 | Role entry + denied | D9; wrong role must not land in wrong tool |
| F-X-05 | Connection indicator / offline banner | D7; stale data must be visible |
| F-X-06 | Logout | Shared/lost phones |
| F-X-07 | Spanish UI | Spanish-first staff |
| F-X-09 | Socket + reconnect + foreground refetch | Floor/KDS are useless if stale |
| F-X-10 | Error normalisation | Server returns HTML/`{msg}`/429 (G17); app must not crash |
| F-X-11 | Persistent draft store | D5/D7 |
| F-W-01 | Floor overview | Waiter home |
| F-W-02 | Bar-closed banner | BAR_CLOSED is the commonest dead-end |
| F-W-03 | Open table | Start of every order |
| F-W-04 | Ticket detail | See state and total |
| F-W-05 | Menu browse + search | Needed to order |
| F-W-06 | Modifiers with client-side min/max | Server doesn't enforce (BR §E.63) |
| F-W-07 | Quantity + notes | Notes can only be set at add |
| F-W-08 | Draft + Send + idempotency | Core value; duplicate orders cost food and money (G13) |
| F-W-09 | Ready notifications | The main reason a waiter wants a phone |
| F-W-10 | Mark served | Closes loop, clears KDS |
| F-W-11 | Request bill | D4's only payment-adjacent action |
| F-W-12 | Cancel empty ticket | Added by PM: without it a mis-tap leaves a table stuck, as close is out of scope |
| F-K-01 | Station queue | KDS core |
| F-K-02 | Item age colours | Late-item visibility |
| F-K-03 | Notes/modifiers prominent | Prevent wrong food |
| F-K-04 | Advance status (client-ordered) | Server has no transition check (G5) |
| F-K-05 | Live updates + 15 s poll | Voids aren't pushed (G12) |
| F-K-06 | KDS stale warning | Frozen list is worse than no list |
| F-M-01 | Ops overview | Manager home |
| F-M-02 | Pending-payment list | Cashier hand-off visibility |
| F-M-03 | Open any ticket | Support waiters |
| F-A-01 | Diagnostics | Only debugging tool in the field; cheap |

## P1 (v1.1)

| ID | Feature | Justification |
|---|---|---|
| F-X-08 | English toggle | Strings exist (reuse web bundle); nobody is blocked without it |
| F-W-13 | Void item (PIN) | Needed but rare; server-enforced, so safe to defer |
| F-W-14 | Decrease qty (PIN) | Same |
| F-W-15 | Manager discount | Manager can do it at the POS |
| F-W-16 | Transfer table | Moderately common; POS fallback |
| F-W-17 | Customer name | Floor shows it, but not essential |
| F-W-18 | Promo accept/decline | Only for `requires_confirmation` promos |
| F-W-19 | Waiting list view | Read-only convenience |
| F-W-20 | Express ticket | Counter flow; POS fallback |
| F-W-21 | Print pre-bill | Depends on print agent (E4) |
| F-W-22 | Sold-out greying | Server 422 already protects |
| F-K-07 | KDS sound/vibration | Visual UI works without |
| F-M-04 | Manager KDS view | Manager can use bar KDS |
| F-M-05 | Manager void/discount | See F-W-13/15 |
| F-A-02 | Settings toggles | Rare |

## P2 (later)

| ID | Feature | Justification |
|---|---|---|
| F-W-23 | Waiting list add/assign | Host-stand job; POS fallback |
| F-W-24 | Temp tables | Rare |
| F-K-08 | Re-print chit | Printer-dependent |
| F-M-06 | Cash session open/close | High-risk money action on a phone; not idempotent |
| F-A-03 | Users list | Low value |

## Out of scope v1

| Item | Reason |
|---|---|
| Payment settlement / close ticket / tips / change due | D4. `POST /close` has no PIN, weak amount checks (G7, G9) |
| Force-close, reopen, edit-payment, void-timer, timer edit | Money-correcting actions; manager at POS |
| Reports, analytics, earnings, safe | Manager/Admin desk work; Telegram bot already covers owner reports |
| Inventory admin (restock, adjust, recipes) | Desk work; `stock-check` read only (P1) |
| User CRUD | ADMIN desk work; G15 (role unvalidated, dup -> 500) |
| Menu / modifier / promotion / pool-config editing | Desk work |
| Spatial floor plan | MISSING server-side (no x/y) |
| Split bill by item/guest | MISSING server-side |
| Tax (IVA) | MISSING server-side |
| Delivery (Rappi) tickets | Needs `rappi_order_id` + EXTERNAL close; not a waiter flow |
| Reservations | MISSING server-side |
| Pool timer edit / manual rate | Server-authoritative (D3) |
| Offline mutation queue | D7 |
| Push notifications when app is killed | Needs FCM/internet; LAN-only (D2). In-app only |
| iOS build | No Mac |

## PM notes (where I diverge from the orchestrator's proposal)

1. **English toggle moved P0 -> P1.** Spanish default is P0; the toggle blocks nobody.
2. **Added P0 F-W-12 Cancel empty ticket.** With close out of scope, a mistaken "open table" would strand the table. Pool tables with a timer return 422 HAS_POOL_TIME: the app says "ask a manager" (void-timer stays on POS).
3. **Request bill needs a confirm dialog.** `request-payment` on a pool table stops the timer and frees the table while the ticket stays OPEN (G11, BR §C.37). This is one tap with side effects; keep it P0 but warn explicitly.
4. **"Payment-requested flag" on the floor is not on `GET /resources`.** It lives on the ticket. Floor merges `GET /tickets/pending-payment` (ANY role). For pool tables this also means the table shows AVAILABLE while a bill is pending; show a "cuenta pedida" chip from the ticket list, not from resource status. Open question for design.
5. **KDS gets a stale-socket lockout (F-K-06) and 15 s poll.** Voids aren't pushed to the kitchen (G12); without polling, cooks make voided food.
6. **Ready notifications are P0 but B2-dependent.** Fallback (public `kitchen`/`bar` rooms + refetch own tickets) works without B2 but is chattier. Note WAITER joins no queue room in the web app; mobile must.
7. **Menu search kept P0** only as a client-side filter of the already-cached item list (no new endpoint, minimal cost). If it slips, drop it first.
8. **Sold-out greying (F-W-22) kept P1.** Server 422 `OUT_OF_STOCK` + shortages is the P0 safety net.
9. **Admin diagnostics kept P0 but must stay thin** (one screen, read-only).
10. **Role UX is not security.** Server lets any role do most actions (BR §A.9). Matrix column "Perm" marks which gates are real; do not market role hiding as protection.
11. **Manager KDS (F-M-04) is P1**, though D9 says "floor/KDS read". Manager P0 covers floor via waiter features plus ops counts.

## Research notes (operational patterns only)

- KDS age colouring is typically 3 states: fresh/warning/late; examples cite green 0-5, yellow 5-10, red 10+ min, or yellow at ~70% and red at 100% of target ticket time, set per device. Used for F-K-02 defaults. Sources are vendor docs, not benchmarks.
  - https://crumb-pos.vercel.app/blog/kds-best-practices
  - https://merchanthelp.bankofamerica.com/Kitchen-Display-Order-Management
  - https://counterfire-docs.pages.dev/kds/age-timers/
- Bump-bar functions: bump, recall last, next/focus, partial (item-level) bump. Suggests a P1 "recall last bumped" on KDS (not yet in matrix).
  - https://doc.toasttab.com/doc/platformguide/platformKitchenUsingBumpBars.html
  - https://docs.oracle.com/en/industries/food-beverage/simphony/19.3/kdscu/c_kds_bump_bar_templates_scancodes.htm
- Nothing useful found on handheld waiter apps (fire/hold, course timing); no design copied.
