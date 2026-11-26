# Business Rules

Tags: **[BE]** backend-enforced · **[DB]** PostgreSQL constraint/trigger · **[FE]** web-frontend only (a mobile client calling the API bypasses it) · **[GAP]** implied but not server-enforced · **[UNVERIFIED]** inferred, not run.
Paths: BE = `backend/app`, FE = `frontend/src`, MIG = `backend/migrations/sql`.

**Mobile rule of thumb:** the server is authoritative for every rule tagged [BE]/[DB]. Rules tagged [FE] must be re-implemented in mobile UX (not trusted as security). [GAP] items are documented in `DEPENDENCIES_AND_GAPS.md`; mobile must not rely on them being enforced.

## A. Auth and roles

1. [BE] Access JWT 8h, refresh 7d (`auth.py:login`).
2. [BE] Login 10/min, verify-pin 5/min, in-memory limiter (resets on restart) (`auth.py`, `config.py`).
3. [BE] Refresh re-reads user; inactive → 401 `USER_INACTIVE` (`auth.py:refresh`).
4. [BE] Logout blocklists access jti (`auth.py:logout`).
5. [BE] Roles via JWT `role` claim: WAITER, KITCHEN_STAFF, BAR_STAFF, MANAGER, ADMIN.
6. [BE] "Manager PIN" = PIN of any active MANAGER/ADMIN; bcrypt compared across all (`auth.py:verify_manager_pin`).
7. [BE] Failed PINs audited (`MANAGER_PIN_FAILED`); no lockout.
8. [BE] Role groups — **MGR|ADMIN:** cash open/close, expenses, tip-distribution write, timer edit, void timer, discount, reopen, force-close, clean-ghosts, open-all, edit-payment, promotions/menu/resources/pool-config/settings writes, reports, inventory writes, suppliers writes, waitlist move. **ADMIN only:** users, analytics, earnings, safe, category delete, unit catalog, inventory delete.
9. [GAP] Any authenticated role (incl. KITCHEN_STAFF/BAR_STAFF) can: open ticket, add item, transfer, close (any payment), request/clear payment, cancel empty ticket, customer name, promo decision, print, queue status update, waitlist status/assign/dequeue/transfer-to-pool.
10. [GAP] Cash summaries and ticket lists readable by any role (`cash_session.py`, `GET /tickets`).
11. [FE] Web route guards (`App.tsx`, `NavBar.tsx`) are visibility only.
12. [GAP] `GET /users` ADMIN-only vs FE route admits MANAGER.
13. [GAP] `POST /tickets/<id>/reprint` accepts `manager_id` with no PIN.
14. [BE] Settings write MGR; read any.
15. [BE] Socket public rooms open to any connection; `manager` room validated but never joined (`sockets/events.py:on_join`).

## B. Cash session (shift)

16. [BE] Only MGR|ADMIN open/close.
17. [DB] One OPEN session (`uq_cash_sessions_open`); [BE] 409 `SESSION_ALREADY_OPEN`.
18. [BE] **Opening a ticket requires an OPEN cash session → else 403 `BAR_CLOSED`** (`tickets.py:open_ticket`).
19. [BE] Close blocked (409 `OPEN_TICKETS`) while any OPEN ticket opened since session start.
20. [BE] Counted cash optional at close; no validation.
21. [BE] Opening fund any integer, default 0.
22. [BE] Tickets attributed to session by `opened_at`; only CLOSED counted.
23. [BE] Expected cash = opening_fund + cash_sales + cash_tips − cash_expenses − total_tips (all tips paid from drawer since 2026-04-26). Over/short = counted − expected.
24. [BE] Split tickets split by per-method tender; tips by `tip_source`.
25. [BE] Expenses need amount/payee/description; no sign/max check [GAP].
26. [BE] Expense delete MGR + audited; create not audited.
27. [BE] Reopen blocked (409 `CASH_SESSION_CLOSED`) if owning session CLOSED.
28. [BE] Tip distribution pcts sum 100 (default 30/40/30), informational.

## C. Tables and sessions

29. [DB] One OPEN ticket per resource (`uq_tickets_open_per_resource`); [BE] 409 `RESOURCE_OCCUPIED`.
30. [DB] OPEN ticket needs resource unless EXPRESS/DELIVERY (`chk_open_ticket_has_resource`).
31. [BE] Ticket types TABLE/EXPRESS/DELIVERY; DELIVERY needs `rappi_order_id`.
32. [BE] Staff may create only temp REGULAR_TABLE/BAR_SEAT; POOL_TABLE/permanent need MGR. Staff may delete unused temp only.
33. [BE] Cannot deactivate table with OPEN ticket or active waitlist entry.
34. [BE] Temp tables deactivate when ticket leaves.
35. [BE] Transfer target must be AVAILABLE; pool target starts timer.
36. [BE] Cancel only with zero non-voided items and zero timer sessions; any role.
37. [BE] Request-payment on pool table stops timer, frees table, ticket stays OPEN.
38. [BE] Void timer (MGR, no PIN): session CANCELLED charge 0; no items → ticket CLOSED CASH 0; else → EXPRESS detached.
39. [BE] Force-close MGR + reason; CASH placeholder, no tender.
40. [BE] Clean ghosts: only empty, unrequested, non-reopened tickets on AVAILABLE resources.
41. [BE] Force-closed tickets with non-zero total count as CASH sales in reconciliation [UNVERIFIED impact].
42. [BE] Close/cancel closes linked waitlist entry (ASSIGNED / CANCELLED).

## D. Pool billing (`services/billing.py:calculate_charge`)

43. [BE] Modes `PER_MINUTE`, `ROUND_15`, `PER_HOUR`; `rate_cents` = hourly rate.
44. [BE] PER_MINUTE: `round(seconds/60 × rate/60)` (Python banker's rounding).
45. [BE] ROUND_15: ceil minutes, round up to 15, `round(blocks × rate/60)`.
46. [BE] PER_HOUR: `ceil(seconds/3600) × rate`.
47. [BE] Effective minimums: 15 min (ROUND_15), 1 h (PER_HOUR); none PER_MINUTE.
48. [GAP] Unknown `billing_mode` accepted and charges 0.
49. [BE] Free seconds (table `promo_free_minutes` snapshot + POOL_TIME_FREE_MINUTES grants) subtracted before pricing.
50. [BE] Free-minute grants capped by `max_applications_per_ticket` and window overlap.
51. [BE] Rate/mode snapshotted at session start.
52. [BE] Timer stops on close, transfer off pool, request-payment, force-close, clean-ghosts, void-timer.
53. [BE] Pool total = sum of non-cancelled session charges; 100% discount zeroes it.
54. [BE] Manual timer edit MGR; no future times; naive = venue TZ.
55. [BE] On close, required tender clamped to `[quoted total, final total] + tip` via `expected_total_cents`; only when tender supplied.
56. [FE] Web live estimate mirrors formula in JS with differences — **server charge is authoritative; mobile must label timer amounts as estimates.**
57. [BE] `pool_time_cents` excludes CANCELLED sessions.

## E. Orders, items, kitchen routing

58. [BE] **Add item creates line `SENT` with `sent_at=now` and consumes inventory immediately** — there is no draft/staged step server-side.
59. [FE] Send-order not rendered; `POST /send-order` always 400 `NO_STAGED_ITEMS`.
60. [BE] Item add/qty/void/transfer only on OPEN tickets (403 `TICKET_CLOSED`).
61. [BE] Quantity integer 1–99 (422 `INVALID_QUANTITY`).
62. [BE] `requires_flavor` items need ≥1 modifier from each mandatory group (422 `FLAVOR_REQUIRED`).
63. [GAP] Modifier `min_selections/max_selections/allow_multiple` not enforced server-side.
64. [BE] Prices snapshotted at add (item + modifier `price_cents`, `name_snapshot`).
65. [UNVERIFIED] Modifier prices not multiplied by line quantity in `recalculate_totals`.
66. [BE] Stock pre-check → 422 `OUT_OF_STOCK` with `shortages[]`.
67. [UNVERIFIED] Race after pre-check may 500 in `add_item`.
68. [BE] `routing_dest` copied from category `routing` (KITCHEN/BAR).
69. [GAP] Category routing unvalidated, default BAR. Seed: Wings/Food/Sauces → KITCHEN; Beer/Cocktails/Soft Drinks → BAR.
70. [BE] Queue = SENT/IN_PROGRESS/READY lines on OPEN tickets.
71. [BE] Queue PATCH accepts IN_PROGRESS/READY/SERVED from any state; no role check; `served_at` on SERVED.
72. [FE] Kitchen UI advances SENT→IN_PROGRESS→READY→SERVED; bulk serve READY. **Mobile KDS must enforce this order client-side.**
73. [BE] KITCHEN chit always auto-prints; BAR only if `print_bar_tickets`; failure sets `needs_reprint`, never fails order.
74. [BE] Chit modifier counts × quantity.
75. [BE] Void needs manager `pin` in body (server-verified); reverses inventory; 409 `ALREADY_VOIDED`; `manager_id` → 422.
76. [GAP] Void allowed on READY/SERVED; kitchen not notified.
77. [BE] Qty decrease needs PIN; increase no PIN; re-consumes inventory.
78. [BE] `X-Ticket-Version` checked only on add (409 `VERSION_CONFLICT`).
79. [BE] Customer name only on OPEN.
80. [BE] Line notes set at add only.

## F. Discounts and promotions

81. [BE] Manual discount 0–100 whole ticket, MGR role claim (403 `FORBIDDEN`).
82. [FE] Web shows discount buttons to all roles, verifies PIN, then sends no PIN.
83. [BE] Manager JWT can discount without PIN.
84. [BE] No price override.
85. [BE] Promo types HAPPY_HOUR, ITEM_DISCOUNT, BOGO, QTY_PERCENT_DISCOUNT, POOL_TIME_FREE_MINUTES; BUNDLE accepted, no effect.
86. [BE] Percentage line discounts truncate (`int()`).
87. [UNVERIFIED] FLAT_CENTS not capped at line gross.
88. [BE] `requires_confirmation` promos: waiter ACCEPT/DECLINE per ticket, changeable.
89. [BE] Line promos re-run on add/qty change/accept; stacking uncapped [UNVERIFIED].
90. [BE] Promo windows in venue TZ.
91. [GAP] `Config.HAPPY_HOUR_*` unused.

## G. Payments, tips, totals, tax

92. [BE] Total = max(0, subtotal − discount + pool_time); recalculated every mutation.
93. [BE] Payment types CASH/CARD/EXTERNAL.
94. [BE] EXTERNAL only for DELIVERY.
95. [BE] `payment_type_2` CASH/CARD with `tendered_cents_2`.
96. [BE] Underpay check only when tender supplied; CARD/EXTERNAL without tender unchecked.
97. [BE] **Close idempotent: already CLOSED → 200.**
98. [BE] Change due returned, not stored.
99. [BE] Tip non-negative int ≤ 100,000,000; source CASH/CARD/SPLIT; SPLIT parts must sum.
100. [FE] Tip presets/split math client-side.
101. [FE] Split card amount = total − cash, client-side.
102. [BE] COGS snapshot frozen at close.
103. [BE] Close frees resource, waitlist → ASSIGNED.
104. [BE] Edit payment: MGR + PIN + reason, 5/min, audited.
105. [BE] Reopen: MGR, no PIN.
106. [BE] No sales tax computed.
107. [BE] Rappi closes as EXTERNAL tip 0.

## H. Inventory

108. [DB] No negative stock (`trg_prevent_negative_stock`).
109. [DB] Ledger guard trigger + `ledger_violations` (unread).
110. [DB] Recipe/unit/conversion guards.
111. [DB] Pack lot constraints.
112. [DB] Production batch constraints (unused by app).
113. [BE] Consumed on add, reversed on void, re-consumed on qty change.
114. [BE] Adjust/waste/count need reason.
115. [BE] Inactive items cannot be restocked.
116. [BE] FIFO auto-conversion from packs/bottles.
117. [BE] Inventory writes MGR; units/delete ADMIN.

## I. Audit, reporting, notifications

118. [BE] Audit (`audit_log`, same tx) for login/logout, ticket open/close/reopen/force-close/edit-payment, item add/void/qty, discount, transfer, timer events, promo decision, waitlist, resources, pool config, expense delete, PIN use/fail.
119. [GAP] No audit for cash open/close, expense create, safe create.
120. [BE] Reports MGR; analytics/earnings ADMIN (web UI stricter).
121. [UNVERIFIED] Daily email 08:00 needs SMTP.
122. [BE] Telegram daily 09:00, weekly Mon 08:00; only `/report` checks chat id.

## J. DB invariants

123. `uq_tickets_open_per_resource` · 124. `chk_open_ticket_has_resource` · 125. `uq_cash_sessions_open` · 126. `uq_waiting_list_floor_ticket_active`, `uq_waiting_list_assigned_ticket_active` · 127. `resources.code` unique, `uq_ticket_promo_decision`, `uq_suppliers_name`, `ix_token_blocklist_jti` · 128. `ck_mg_min_le_max` (NOT VALID) · 129. triggers `trg_line_item_bump_version`, `trg_normalize_name`, `trg_prevent_negative_stock`, `trg_ledger_guard_movement`, `trg_conv_no_cycle`, `trg_recipe_unit_guard`, `trg_block_legacy_recipe_write`, `trg_block_cig_box_insert` · 130. manifest applies only `001_baseline_squash`.

## K. Frontend-only rules mobile must reproduce in UX

131. Discount PIN ceremony (server ignores PIN) · 132. hide discount from non-managers · 133. edit-payment/void-timer/reopen controls manager-only · 134. tip presets, split math, change due · 135. card/external amounts unreconciled · 136. modifier min/max/allow_multiple · 137. no send step · 138. timer estimate is display-only · 139. role route guards · 140. floating tables manager-only in web UI.

UI language: **Spanish default (`es`), English secondary.**
