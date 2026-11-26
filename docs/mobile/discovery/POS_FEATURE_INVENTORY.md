# POS Feature Inventory

Static review of `backend/app` (BE), `frontend/src` (FE), `backend/migrations/sql` (MIG), `telegram-bot/bot.py` (BOT). Nothing executed.
Read fully: `api/tickets.py, cash_session.py, auth.py, resources.py, queue.py, services/billing.py`, core models, `App.tsx`, `NavBar.tsx`, `authStore.ts`, `ManagerPinDialog.tsx`. Sampled: reports, analytics, earnings, inventory, inventory_svc, waiting_list, promotion_svc, TicketPage (~60%).

Classifications: **USABLE** = IMPLEMENTED AND USABLE (BE route + FE wired) · **INCOMPLETE** = IMPLEMENTED BUT INCOMPLETE · **NOT INTEGRATED** = PRESENT IN CODE BUT NOT INTEGRATED · **PLANNED** · **MISSING** · **UNKNOWN** = requires live verification.

README is stale ("28 migrations"); `MIG/manifest.txt` lists only `001_baseline_squash`.

## Users, roles, auth, shifts

| Area | Class | Evidence | Notes |
|---|---|---|---|
| User management | INCOMPLETE | `BE/api/users.py`; `FE/pages/manager/UsersPage.tsx` | API ADMIN-only; FE route admits MANAGER → 403 (UNVERIFIED) |
| Roles | INCOMPLETE | `BE/models/user.py`; `FE/App.tsx` | WAITER, KITCHEN_STAFF, BAR_STAFF, MANAGER, ADMIN; mixed per-endpoint enforcement |
| Permissions | INCOMPLETE | per-module `require_manager/admin` | many money routes ungated; `authorization_grants` framework unused |
| Login/JWT/refresh/logout | USABLE | `BE/api/auth.py`; `FE/pages/LoginPage.tsx`; `FE/api/client.ts` | 8h/7d; 10/min login |
| Manager PIN | USABLE | `auth.py:verify_manager_pin`; `FE/components/ManagerPinDialog.tsx` | any active MANAGER/ADMIN PIN; no lockout (`fn_pin_is_locked` unused) |
| Shift (cash session) open/close | USABLE | `BE/api/cash_session.py`; `FE/pages/manager/CashSessionPage.tsx`; FloorMap bar-closed banner | MGR only; one OPEN (`uq_cash_sessions_open`); close blocked by OPEN tickets; not audited |
| Cash reconciliation | USABLE | `cash_session.py:_build_summary` | readable by any role |
| Expenses | INCOMPLETE | `cash_session.py:add_expense` | no sign/upper check; create not audited |
| Tip distribution % | INCOMPLETE | `cash_session.py:*tip_distribution` | sum 100; informational only |
| Safe collections | USABLE | `BE/api/safe.py`; `SafeCollectionsPage.tsx` | ADMIN only |

## Floor, tables, billiards

| Area | Class | Evidence | Notes |
|---|---|---|---|
| Floor grouping | USABLE | `resources.py:list_resources`; `FE/pages/FloorMapPage.tsx` | by type, `sort_order`, `code` |
| Spatial layout (x/y) | MISSING | `models/resource.py` | no coordinates |
| Pool tables | USABLE | `models/resource.py:PoolTableConfig`; `PoolTableConfigPage.tsx`, `TableManagementPage.tsx` | code prefix `BT`; per-table mode/rate/free minutes |
| Pool rate default | UNKNOWN | model default 8600, `config.py POOL_RATE_CENTS` 150, seed 150 | read live DB |
| Regular tables / bar seats | USABLE | `resources.py` (`T`, `B` prefixes) | permanent create MGR |
| Floating/temp tables | USABLE | `resources.py:create/delete_resource`; `WaitingListPanel.tsx`, FloorMap | staff may create/delete unused temp; FE shows manager-only |
| Occupancy | USABLE | resource `status` | AVAILABLE/IN_USE/INACTIVE |
| Ghost tickets | USABLE | `cash_session.py:get_status`; `tickets.py:clean_ghost_tickets` | manager cleanup |
| Pool timer start/stop/bill | USABLE | `models/ticket.py:PoolTimerSession`; `services/billing.py:calculate_charge`; TicketPage live estimate | rate/mode snapshotted at start |
| Timer manual edit | NOT INTEGRATED | `tickets.py:edit_timer` | no FE caller |
| Void timer | USABLE | `tickets.py:void_timer`; `TicketPage.tsx:handleVoidTimer` | MGR, no PIN |

## Orders, items, menu, kitchen

| Area | Class | Evidence | Notes |
|---|---|---|---|
| Open ticket | USABLE | `tickets.py:open_ticket`; FloorMap | TABLE/EXPRESS/DELIVERY; needs OPEN cash session; any role |
| Transfer | USABLE | `tickets.py:transfer_ticket`; `TransferModal.tsx` | target AVAILABLE |
| Cancel empty | USABLE | `tickets.py:cancel_ticket` | no items, no timer |
| Request payment | USABLE | `tickets.py:request_payment`, `list_pending_payment` | pool: stops timer, frees table, ticket stays OPEN |
| Clear payment request | NOT INTEGRATED | `tickets.py:clear_payment_request` | no FE caller |
| Force-close | USABLE | `tickets.py:force_close_ticket`; CashSessionPage | MGR + reason; CASH placeholder |
| Reopen | USABLE | `tickets.py:reopen_ticket` | MGR; blocked if session CLOSED |
| Edit payment post-close | USABLE | `tickets.py:edit_payment`; `EditPaymentModal.tsx` | MGR + PIN + reason |
| Express / Rappi delivery | USABLE | `tickets.py:list_active_express`, close EXTERNAL | DELIVERY needs `rappi_order_id` |
| Add item | USABLE | `tickets.py:add_item`; `AddItemModal.tsx` | created SENT immediately |
| Void item | USABLE | `tickets.py:void_item`; `TicketPage.tsx:confirmVoid` | manager PIN server-side |
| Quantity change | USABLE | `tickets.py:update_item_quantity` | decrease needs PIN |
| Item notes | INCOMPLETE | `add_item` `notes` | set at add only; FE entry UNKNOWN |
| Modifiers (groups, min/max) | INCOMPLETE | `BE/api/menu.py`; `models/menu.py:ModifierGroup`; `ModifiersPage.tsx` | min/max/allow_multiple never enforced; only `requires_flavor` checked |
| Modifier inventory rules | USABLE | `PUT /menu/modifiers/<id>/inventory-rules` | |
| Categories + routing | INCOMPLETE | `menu.py` | routing default BAR, unvalidated |
| Menu items | USABLE | `menu.py`; `MenuManagementPage.tsx` | |
| Kitchen queue (KDS) | USABLE | `queue.py:kitchen_queue, update_status`; `FE/pages/KitchenQueuePage.tsx` | SENT/IN_PROGRESS/READY on OPEN tickets; no transition/role check |
| Bar queue | USABLE | `queue.py:bar_queue`; `BarQueuePage.tsx` | |
| Routing | USABLE | `add_item` copies `category.routing` | |
| Explicit "send" | NOT INTEGRATED | `tickets.py:send_order`; `TicketPage.tsx:handleSendOrder` unrendered | items go to KDS on add |
| Line status | USABLE | `models/ticket.py:TicketLineItem.status`; `KitchenQueuePage.tsx NEXT_STATUS` | STAGED unused |
| Queue counts | USABLE | `queue.py:queue_counts`; NavBar polls 20s | |
| Ticket version lock | INCOMPLETE | `X-Ticket-Version` in `add_item` only | |

## Bills, payments, discounts, tips, tax

| Area | Class | Evidence | Notes |
|---|---|---|---|
| Totals | USABLE | `Ticket.recalculate_totals` | server-side every mutation |
| Receipts (pre-bill/final) | USABLE | `tickets.py:print_ticket ?unpaid`; `scripts/print_agent/print_agent.py` | needs Windows print agent :9191 |
| CASH | USABLE | `close_ticket` | underpay check when tender sent |
| CARD | INCOMPLETE | `close_ticket` | no terminal; amount unchecked |
| EXTERNAL | USABLE | DELIVERY only | |
| Split tender (2 methods) | USABLE | `payment_type_2`, `tendered_cents_2` | split math client-side |
| Split bill by item/guest | MISSING | — | |
| Manual % discount | INCOMPLETE | `tickets.py:set_discount` | role-gated only; FE PIN not sent |
| Promotions | USABLE | `services/promotion_svc.py`; `promotions.py`; `PromotionsPage.tsx` | |
| Price override | MISSING | — | |
| Tips | USABLE | `close_ticket` tip fields; TicketPage presets 10/15/20% | client-supplied |
| Tax (IVA) | MISSING | — | |

## Inventory, promotions, waitlist, notifications, reporting, config

| Area | Class | Evidence | Notes |
|---|---|---|---|
| Inventory CRUD/restock/adjust | USABLE | `BE/api/inventory.py`; `services/inventory_svc.py`; `InventoryPage.tsx` | MGR; units/delete ADMIN |
| Stock check at order | USABLE | `check_stock_for_item`; `AddItemModal.tsx` uses `/inventory/stock-check` | 422 `OUT_OF_STOCK` |
| Stock consume/reverse | USABLE | `consume_for_line_item`, `reverse_for_line_item` | |
| Pack/bottle auto-open | INCOMPLETE | `open_bottle`, `open_box` | FE calls missing `GET /inventory/open-boxes` |
| Recipes | USABLE | `/insumos-base` | |
| Production batches | NOT INTEGRATED | `MIG/035_*` | DB only |
| Suppliers | USABLE | `suppliers.py` | |
| Promotions BUNDLE | NOT INTEGRATED | no evaluator | |
| Pool free-minute promos | USABLE | `promotion_svc.py:earned_free_seconds` | |
| Promo waiter confirmation | USABLE | `tickets.py:decide_promotion`; `TicketPage.tsx:decidePromo` | any role |
| Waiting list | USABLE | `waiting_list.py`; `WaitingListPanel.tsx` | move MGR only |
| Reservations | MISSING | — | |
| Real-time Socket.IO | INCOMPLETE | `sockets/events.py`; `FE/hooks/useSocket.ts` | manager room never joined |
| Print-failure alerts | INCOMPLETE | `print:failed` → manager room | undeliverable |
| Daily email report | UNKNOWN | `scheduler.py`, `email_report_svc.py` | needs SMTP |
| Telegram reports | INCOMPLETE | BOT | reads DB directly; only `/report` checks chat id |
| Kitchen/bar chit auto-print | USABLE | `_spawn_auto_print_chit`; `settings_svc.should_print` | BAR only if `print_bar_tickets` |
| Receipt reprint | INCOMPLETE | `tickets.py:reprint_ticket` | `manager_id`, no PIN |
| Print jobs/retry | USABLE | `models/print_job.py`; `PrintRetryBanner.tsx` | `job_id` dedupe |
| Audit trail | INCOMPLETE | `models/audit.py`, `services/audit_svc.py` | none for cash open/close, expense create, safe create; no viewer |
| Reports | USABLE | `reports.py`; `ReportsPage.tsx` | FE ADMIN, API MGR |
| Analytics | USABLE | `analytics.py`, `analytics_views.py` | ADMIN |
| Earnings | USABLE | `earnings.py` | ADMIN |
| Settings | USABLE | `settings.py`; `SettingsPage.tsx` | `kds_sound_enabled`, `print_bar_tickets` |
| Env config | INCOMPLETE | `config.py` | HAPPY_HOUR_* unused |
| i18n es/en | USABLE | `FE/i18n` | many hardcoded Spanish strings |
| Backend tests | UNKNOWN | `backend/tests/` | not run |
| DB consistency guards | USABLE | `MIG/001_baseline_squash.sql` | see BUSINESS_RULES §J |
| Inventory ledger triggers | INCOMPLETE | `trg_ledger_guard_movement`, `ledger_violations` | no reader |
| KDS event outbox | NOT INTEGRATED | `MIG/030_kds_event_outbox.sql` | unused by app |
| Authorization grant framework | NOT INTEGRATED | `MIG/028_authorization_framework.sql` | unused |
| Telegram bot | INCOMPLETE | BOT | bypasses API role checks |

## Web screens (`FE/App.tsx`)

| Screen | Route | Roles (FE guard) | Notes |
|---|---|---|---|
| Login | `/login` | public | KITCHEN_STAFF→`/queue/kitchen`, BAR_STAFF→`/queue/bar`, else `/floor` |
| Floor map | `/floor` | any | floating tables + "Abrir Bar" manager-only in UI |
| Ticket | `/ticket/:id` | any | void timer/edit payment manager-only UI; discount buttons shown to all |
| Kitchen queue | `/queue/kitchen` | KITCHEN_STAFF, BAR_STAFF, WAITER, MANAGER, ADMIN | |
| Bar queue | `/queue/bar` | same | |
| Manager hub | `/manager` | MANAGER, ADMIN | |
| Reports / Safe / Earnings / Analytics | `/manager/{reports,safe,earnings,analytics}` | ADMIN | |
| Inventory / Menu / Users / Pool config / Tables / Cash / Settings / Modifiers / Promotions | `/manager/*` | MANAGER, ADMIN | Users API is ADMIN-only |

FE↔BE gaps: `GET /inventory/open-boxes` missing route; timer edit & clear-payment-request no UI; send-order never rendered; users page MANAGER vs ADMIN API.
