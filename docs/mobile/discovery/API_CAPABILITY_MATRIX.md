# API Capability Matrix — billar-pos backend

Source root `backend/`. Static analysis; runtime verification tracked in `docs/mobile/testing/TEST_RESULTS.md`. UNVERIFIED = not confirmed at runtime.

## 0. Conventions

- **Base URL (deployed):** `http://<pos-host>:8080/api/v1` via nginx (backend `:5000` is container-internal; `entrypoint.sh`, `docker-compose.yml`). Prefixes registered `app/__init__.py:61-76`. Health `GET /api/v1/health` → `{"status":"ok"}` (PUB, `app/__init__.py:1230`).
- **Auth:** `Authorization: Bearer <access_token>`. Login → `access_token` (8h, `auth.py:33`) + `refresh_token` (7d, `auth.py:35`). `/auth/refresh` takes refresh token as Bearer. Claims `role`, `name`. Role checks read claim (stale until refresh) except `settings.py:31` (DB).
- **Roles:** `WAITER`, `KITCHEN_STAFF`, `BAR_STAFF`, `MANAGER`, `ADMIN` (`models/user.py:12`, `seed.py:31-53`).
- **Legend:** PUB no JWT · ANY any valid token · MGR MANAGER|ADMIN · ADM ADMIN · REF refresh token.
- **Errors (no central handler):** usually `{"error":"<CODE>","message":"..."}` (`tickets.py:220`); sometimes `{"error":"<CODE>"}` only (`users.py:13`), human string in `error` (`tickets.py:1213`), `{"error":"Forbidden"}` (`settings.py:33`), `{"valid":false,"message":...}` (`auth.py:119`), JWT lib `{"msg":...}` 401/422, `get_or_404`/unhandled → **HTML**, 429 default body, 413 >2 MB. Client must tolerate non-JSON errors.
- **Pagination:** none. Caps: `GET /tickets` 100, `/waiting-list/history` 50, `/cash/sessions` 30, movements 200.
- **Money:** integer cents, except `/reports/charts-data` (peso floats) and `PATCH /inventory/<id>` `purchase_cost_pesos`.
- **Time:** ISO-8601; naive → `Config.TZ` (`America/Mexico_City`).
- **Rate limits** (per remote addr, memory): login 10/min, verify-pin 5/min, edit-payment 5/min. Behind nginx all clients share one bucket (no ProxyFix).
- **CORS:** `*` on `/api/*` and Socket.IO.

## 1. Auth `/auth` (`api/auth.py`)

| M | Path | Role | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| POST | /login | PUB 10/min | `username`, `password` | 200 `{access_token, refresh_token, user}`; 401 `INVALID_CREDENTIALS` | audit `USER_LOGIN[_FAILED]` | auth.py:15 |
| POST | /refresh | REF | — | 200 `{access_token}` (claims re-read from DB); 401 `USER_INACTIVE` | — | auth.py:47 |
| POST | /logout | ANY | — | 200 | blocklists access jti only; refresh NOT revoked | auth.py:73 |
| POST | /verify-pin | ANY 5/min | `pin` | 200 `{valid:true, manager_id, manager_name}`; 400 `{valid:false}` | audit `MANAGER_PIN_USED/FAILED` | auth.py:101 |
| GET | /me | ANY | — | `{id, username, name, role, is_active, has_pin, created_at}` | — | auth.py:122 |

## 2. Resources (tables) `/resources` (`api/resources.py`)

| M | Path | Role | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| GET | / | ANY | `include_inactive` | `Resource.to_dict` + `active_ticket_id, customer_name, timer_start, timer_session_id, pool_config` | — | :72 |
| GET | /<id> | ANY | — | resource | — | :100 |
| POST | / | ANY if `is_temp` & type REGULAR_TABLE/BAR_SEAT; else MGR | `type` (BAR_SEAT/POOL_TABLE/REGULAR_TABLE), `name`, `code?`, `is_temp?` | 201; 409 `CODE_TAKEN` | `floor:update` | :107 |
| PATCH | /<id> | MGR | `name, is_active, sort_order` | 200; 409 `TABLE_HAS_OPEN_TICKET` | `floor:update` | :179 |
| DELETE | /<id> | ANY if unused temp; else MGR | — | `{ok}` | soft delete; `floor:update` | :215 |
| GET/PATCH | /<id>/pool-config | ANY / MGR | `billing_mode, rate_cents, promo_free_minutes` | config | audit | :252/:259 |

## 3. Tickets `/tickets` (`api/tickets.py`) — 28 routes

Ticket shape (`models/ticket.py:84-164`): `id, ticket_type, rappi_order_id, resource_id, resource_code, status, opened_by, opened_at, closed_at, payment_type, tendered_cents, tip_cents, tip_source, tip_cash_cents, tip_card_cents, payment_type_2, tendered_cents_2, manual_discount_pct, was_reopened, reopened_at, edited_after_close, payment_requested, payment_requested_at, subtotal_cents, discount_cents, pool_time_cents, total_cents, version, notes, customer_name, waiting_list_entry`; detail adds `line_items, applied_promotions, timer_sessions`; `GET /<id>` adds `available_promotions` (OPEN only).

Line item (`ticket.py:192-230`): `id, ticket_id, menu_item_id, menu_item_name, quantity, unit_price_cents, promo_discount_cents, net_cents, promotions[], status, routing_dest, sent_at, served_at, voided_at, void_reason, notes, needs_reprint, modifiers[{id, modifier_id, name, price_cents}]`.

| M | Path | Role | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| POST | / | ANY, needs OPEN cash session | `resource_id`, `ticket_type` (TABLE/EXPRESS/DELIVERY), `rappi_order_id` (DELIVERY), `customer_name?`, `waiting_list_entry_id?` | 201 ticket; 403 `BAR_CLOSED`; 409 `RESOURCE_OCCUPIED`; 422 | resource IN_USE; POOL → timer ACTIVE; `floor:update`, `waiting_list:update`; no dedupe | :202 |
| GET | /<id> | ANY | — | detail + `available_promotions` | — | :292 |
| POST | /<id>/promotions/<pid> | ANY | `decision` ACCEPTED/DECLINED | ticket | `ticket:updated`, `floor:update` | :308 |
| PATCH | /<id>/customer-name | ANY (OPEN) | `customer_name` | ticket | `floor:update` | :368 |
| GET | / | ANY | `status`, `resource_id` | list (no items), newest 100 | — | :386 |
| POST | /<id>/items | ANY | header `X-Ticket-Version?` (409 `VERSION_CONFLICT` on mismatch); `menu_item_id`, `quantity` 1-99, `modifiers:[{modifier_id}]`, `notes` | 201 line; 403 `TICKET_CLOSED`; 422 `FLAVOR_REQUIRED`/`INVALID_QUANTITY`/`OUT_OF_STOCK` (`shortages[]`) | **line created SENT immediately**; inventory consumed; promos; `version+=1`; `kitchen:update`/`bar:update`; `ticket:updated {ticket_id, version}`; auto-print chit (KITCHEN always, BAR if `print_bar_tickets`) | :398 |
| DELETE | /<id>/items/<item> | ANY + manager `pin` | `pin`, `reason?` | 200; 401 `INVALID_PIN`; 409 `ALREADY_VOIDED` | VOIDED, inventory reversed; `ticket:updated` only (kitchen not notified) | :562 |
| PATCH | /<id>/items/<item> | ANY increase; `pin` to decrease | `quantity`, `pin?` | line; 403 `MANAGER_REQUIRED` | re-consume inventory; `ticket:updated`, station update, `floor:update` | :647 |
| POST | /<id>/send-order | ANY | — | always 400 `NO_STAGED_ITEMS` (dead: nothing creates STAGED) | — | :790 |
| POST | /<id>/transfer | ANY | `target_resource_id` | ticket; 409 `RESOURCE_OCCUPIED` | timers moved; `floor:update`, `waiting:update` | :823 |
| POST | /<id>/close | ANY (no PIN) | `payment_type` CASH/CARD/EXTERNAL, `payment_type_2?`, `tendered_cents?`, `tendered_cents_2?`, `tip_cents?`, `tip_source?` CASH/CARD/SPLIT, `tip_cash_cents?`, `tip_card_cents?`, `expected_total_cents?` | ticket + `change_due`; 422 codes; 409 `TICKET_NOT_OPEN`; **already CLOSED → 200 (retry-safe)** | timer COMPLETED, resource AVAILABLE, cost snapshot; `floor:update` | :935 |
| PATCH | /<id>/timer/<sid> | MGR | `start_time, end_time, reason?` | session | recalcs even on CLOSED | :1122 |
| PATCH | /<id>/discount | MGR | `pct` 0-100, `reason?` | ticket | `floor:update` | :1201 |
| POST | /<id>/cancel | ANY | — | `{ok}`; 422 `HAS_ITEMS`/`HAS_POOL_TIME` | CANCELLED; `floor:update` | :1233 |
| POST | /<id>/void-timer | MGR | — | `{ok, ticket_closed, ticket}` | broadcast `pool:timer_voided` | :1278 |
| POST | /<id>/edit-payment | MGR 5/min + `pin` | `pin, reason`, payment fields | ticket | amounts unvalidated (G9) | :1357 |
| GET | /<id>/edit-history | ANY | — | audit list | — | :1430 |
| POST | /<id>/reopen | MGR | `reason?` | ticket; 409 `CASH_SESSION_CLOSED` | `floor:update` | :1444 |
| GET | /reopened, /active-express, /pending-payment | ANY | — | lists | — | :1543/:1551/:1563 |
| POST | /<id>/request-payment | ANY | — | `{ok, total_cents}`; 409 | POOL: timer stopped, table AVAILABLE, ticket OPEN; `floor:update` | :1572 |
| POST | /<id>/clear-payment-request | ANY | — | `{ok}` | `floor:update` | :1600 |
| GET | /open-all | MGR | — | `{id, resource_code, resource_status, customer_name, opened_at, item_count, total_cents}[]` | — | :1613 |
| POST | /<id>/force-close | MGR | `reason` | `{ok}` | CLOSED as CASH placeholder | :1636 |
| POST | /clean-ghosts | MGR | `reason?` | `{ok, cleaned, ticket_ids}` | bulk close empty tickets | :1685 |
| POST | /<id>/print | ANY | `unpaid?`, `job_id?` | `{ok, job_id}` / `duplicate:true`; 503 agent down | print agent; `print:failed` | :1756 |
| POST | /<id>/reprint | no caller check; `manager_id` in body | `manager_id` | `{ok, job_id}` | always prints (G4) | :1831 |

## 4. Menu `/menu` (`api/menu.py`) — 18 routes

Reads (ANY): `GET /categories` (sort_order; category has `routing` KITCHEN/BAR), `GET /items?category_id=&include_inactive=` (with modifiers), `GET /items/<id>`, `GET /modifiers` (groups + modifiers; group fields `is_mandatory, min_selections, max_selections, allow_multiple`). Writes (MGR; `DELETE /categories/<id>` ADM): category/item/modifier-group/modifier CRUD, `PUT /modifiers/<id>/inventory-rules`, `PUT /items/<id>/modifier-groups`. Item create has no validation (missing key → 500). Src `menu.py:10-327`.

## 5. Queue (KDS) `/queue` (`api/queue.py`)

Queue item = line item + `resource_code`; includes SENT/IN_PROGRESS/READY on OPEN tickets (`queue.py:43-44`).

| M | Path | Role | Request | Response | Side effects | Src |
|---|---|---|---|---|---|---|
| GET | /kitchen | ANY | — | KITCHEN items by `sent_at` | — | :58 |
| GET | /bar | ANY | — | BAR items | — | :81 |
| GET | /counts | ANY | — | `{kitchen, bar}` | — | :64 |
| PATCH | /<item>/status | ANY (no role/transition check) | `status` ∈ IN_PROGRESS/READY/SERVED | `{item_id, status}` | `<station>:item_update {item_id,status}` → room station; `ticket:item_status` → `ticket:<id>`; can revive VOIDED (G5) | :87 |
| POST | /<item>/print | ANY | `job_id?` | `{ok, job_id}` / `duplicate` / `skipped:PRINTING_DISABLED`; 503 | chit print | :113 |

## 6. Cash sessions (shift) `/cash` (`api/cash_session.py`) — 12 routes

| M | Path | Role | Notes | Src |
|---|---|---|---|---|
| GET | /status | ANY | `{open, session, open_tickets_count, ghost_tickets_count}` | :23 |
| POST | /open | MGR | `opening_fund_cents`; 409 `SESSION_ALREADY_OPEN` | :49 |
| POST | /close | MGR | `closing_cash_counted_cents, notes`; 409 `OPEN_TICKETS` | :70 |
| GET | /current/summary, /<sid>/summary | ANY | reconciliation exposed to all roles (G14) | :104/:114 |
| GET | /sessions | MGR | last 30 | :122 |
| GET/PUT | /tip-distribution | ANY / MGR | pcts sum 100 | :133/:144 |
| GET | /current/tickets | ANY | closed tickets this session | :172 |
| GET/POST | /current/expenses | ANY / MGR | expense add not idempotent | :344/:353 |
| DELETE | /expenses/<id> | MGR | hard delete | :381 |

## 7. Waiting list `/waiting-list` (`api/waiting_list.py`) — 8 routes

Statuses `WAITING, SEATED, ASSIGNED, CANCELLED, NO_SHOW`. `GET /` (active), `GET /history`, `POST /` (`party_name, party_size, notes?, floor_ticket_id?`), `POST /<id>/assign` (`resource_id`; opens ticket), `PATCH /<id>/status` (CANCELLED/NO_SHOW), `POST /<id>/dequeue`, `PATCH /<id>/move` (MGR, up/down), `POST /<id>/transfer-to-pool`. All ANY except move. Emit `waiting:update`, `floor:update`.

## 8. Other groups (mobile relevance low)

| Group | Routes | Role | Summary |
|---|---|---|---|
| Inventory `/inventory` | 17 | mostly MGR; `GET /` ANY (exposes cost, G14); units ADM | items, restock, adjust, movements, open-bottle/box, recipes. `GET /stock-check` (ANY) → `{blocked_items, blocked_modifiers, low_stock_item_ids, remaining_by_item, low_stock_items}` — **useful to grey out sold-out menu items** |
| Settings `/settings/<key>` | GET ANY; PUT/PATCH MGR | defaults `kds_sound_enabled=true`, `print_bar_tickets=false`; broadcast `settings:changed` |
| Promotions `/promotions` | 5 | GET ANY; write MGR | types HAPPY_HOUR, ITEM_DISCOUNT, BUNDLE (no apply branch, UNVERIFIED), POOL_TIME_FREE_MINUTES, BOGO, QTY_PERCENT_DISCOUNT |
| Reports `/reports` | 13 | MGR | sales, pool-time, promotions, payments, modifiers, staff, voids, peak-hours, deletions, charts-data (pesos), cigarettes, export |
| Analytics `/analytics` | 12 | ADM | overview, menu-engineering, cash-flow, inventory, cost-coverage, profitability, fixed-costs, pool-tables, staff, anomalies (Spanish keys) |
| Earnings `/reports/earnings` | 3 | ADM | summary, by-category, by-staff |
| Safe `/safe` | 4 | ADM | collections |
| Users `/users` | 4 | ADM | list/create/patch/deactivate; role not validated; dup username → 500 |
| Suppliers `/suppliers` | 4 | GET ANY; write MGR | |

Total: **148 routes** (auth 5, resources 7, tickets 28, suppliers 4, menu 18, inventory 17, cash 12, safe 4, users 4, settings 2, promotions 5, analytics 12, earnings 3, reports 13, queue 5, waiting-list 8, health 1).

## 9. Socket.IO

Same host, path `/socket.io`, no namespaces. `connect` ignores auth (`sockets/events.py:11-13`).

| Event | Dir | Payload | Room | Src |
|---|---|---|---|---|
| `join` / `leave` | C→S | `{room, token?}` | public: floor, kitchen, bar, waiting, `ticket:<id>`; `manager` validates token but is **never joined** (G2) | events.py:16-37 |
| `joined` / `error` | S→sender | `{room}` / `{msg}` | — | events.py:26-34 |
| `floor:update` | S→room | `{}` | floor | tickets.py:30, resources.py, waiting_list.py |
| `waiting:update` | S→room | `{}` | floor | waiting_list.py:53, tickets.py |
| `waiting_list:update` | S→room | `{}` | floor | tickets.py:284 (name mismatch G16) |
| `ticket:updated` | S→room | `{ticket_id[, version]}` | `ticket:<id>` | tickets.py:360,502,643,780,818 |
| `ticket:item_status` | S→room | `{item_id, status}` | `ticket:<id>` | queue.py:107 |
| `kitchen:update` / `bar:update` | S→room | `{}` | kitchen / bar | tickets.py:499-501,782-784,815-817 |
| `kitchen:item_update` / `bar:item_update` | S→room | `{item_id, status}` or `{item_id, needs_reprint}` | kitchen / bar | queue.py:104,193; tickets.py:101 |
| `print:failed` | S→room | `{job_id, ticket_id|queue_item_id, type, error}` | manager (unreachable) | tickets.py:104,1820,1882; queue.py:196 |
| `pool:timer_voided` | broadcast | `{ticket_id, resource_id, session_id, ticket_closed}` | all | tickets.py:1342 |
| `settings:changed` | broadcast | `{key, value}` | all | settings.py:47 |
| `inventory:box_opened` | broadcast | `{brand, cigs_per_box, open_box_id}` | all | inventory_svc.py:925 |

**Order-ready path:** no dedicated event. READY via `PATCH /queue/<item>/status` → station room + `ticket:<id>`. Waiters see it only if joined to that ticket room (or the station room, which is public), else poll.

## 10. State machines

**Line item** (`models/ticket.py:176`): `STAGED, SENT, IN_PROGRESS, READY, SERVED, VOIDED`. New → SENT (`tickets.py:468`). Any non-VOIDED → VOIDED (PIN). Any (incl. VOIDED!) → IN_PROGRESS/READY/SERVED via queue PATCH (no guard). Queue = SENT/IN_PROGRESS/READY on OPEN tickets.

**Ticket** (`models/ticket.py:10`): `OPEN, CLOSED, CANCELLED` (comment says VOID; unused). OPEN→CLOSED (close, force-close, clean-ghosts, void-timer w/o items); OPEN→CANCELLED (cancel, waitlist no-show); CLOSED/CANCELLED→OPEN (reopen MGR; CANCELLED reachable, G10). Types TABLE/EXPRESS/DELIVERY; TABLE→EXPRESS via void-timer. Flags `payment_requested, was_reopened, edited_after_close`. DB: one OPEN ticket per resource (`uq_tickets_open_per_resource`, `__init__.py:318-322`); OPEN TABLE needs resource (`chk_open_ticket_has_resource`, `:697-703`).

**Pool timer** (`ticket.py:274`): `ACTIVE, COMPLETED, CANCELLED`; active = `end_time IS NULL`. Start on open/transfer/assign; COMPLETED on close/transfer-off/request-payment/force-close; CANCELLED on void-timer.

**Resource** (`models/resource.py:11`): `AVAILABLE, IN_USE, INACTIVE` + `is_active`.

**Cash session** (`models/cash_session.py:30`): `OPEN, CLOSED`. One OPEN (partial unique index `__init__.py:384`). Close blocked by open tickets. New tickets require OPEN session (`tickets.py:218-220`).

**Print job** (`models/print_job.py:17`): `PENDING, SENT, PRINTED, FAILED`; types `RECEIPT, REPRINT, CHIT`.

**Waiting list:** WAITING→SEATED/ASSIGNED/CANCELLED/NO_SHOW; SEATED→ASSIGNED/CANCELLED/NO_SHOW; terminal ASSIGNED/CANCELLED/NO_SHOW.

## 11. Idempotency

**No idempotency key anywhere.** Partial guards: print `job_id` dedupe (`queue.py:131`, `tickets.py:1767`); close-when-closed → 200 (`tickets.py:985`); void-when-voided → 409; optional `X-Ticket-Version` optimistic lock on item add (`tickets.py:402-410`); TABLE open on IN_USE → 409; state-based 409s on cancel/force-close/request-payment/assign.

**Retry double-applies:** `POST /tickets` (EXPRESS/DELIVERY), **`POST /tickets/<id>/items`**, restock, adjust, open-bottle/box, expenses, safe, waiting-list add (no ticket), reprint.

## 12. Gaps (G-numbers referenced across docs)

G1 sockets unauthenticated · G2 manager room never joined · G3 refresh survives logout; deactivated user's access token valid ≤8h · G4 reprint authorized by manager UUID only · G5 queue status PATCH ungated + revives VOIDED · G6 print endpoints ungated · G7 close/request-payment need no manager (intent?) · G8 timer edit on CLOSED tickets · G9 edit-payment amounts unvalidated · G10 reopen CANCELLED · G11 request-payment frees pool table while ticket OPEN · G12 void doesn't notify kitchen · G13 no idempotency · G14 cost/cash summaries readable by all roles · G15 user role unvalidated, dup → 500 · G16 `waiting_list:update` mismatch · G17 inconsistent/HTML errors · G18 no pagination · G19 mixed cents/pesos · G20 empty socket payloads · G21 BUNDLE no apply · G22 VOID enum comment drift · G23 `/inventory/open-boxes` docstring-only · G24 send-order dead · G25 role claim staleness · G26 commented-out legacy code.
