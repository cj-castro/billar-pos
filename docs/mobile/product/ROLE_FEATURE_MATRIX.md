# Role Feature Matrix

Evidence: `PROJECT_STATE.md` (D1-D13, B1-B4), `discovery/API_CAPABILITY_MATRIX.md` ("API"), `BUSINESS_RULES.md` ("BR"), `POS_FEATURE_INVENTORY.md`. Status of every row: **Not started**.

## Legend

- **Priority:** P0 = v1 ship blocker, P1 = v1.1, P2 = later. See `FEATURE_PRIORITIZATION.md`.
- **Permission:** `SRV` = server enforces (role claim or PIN). `UX` = mobile-UX-only: server accepts any authenticated role (BR §A.9, G5, G6, G7), so the app hides/blocks it but this is not security.
- **Tests:** U = unit (Jest), I = integration (RNTL), C = contract vs real backend :8090 (D12), E = E2E Maestro.
- **Screens:** SETUP server URL, LOGIN, DENIED, FLOOR, TICKET, MENU, MODS (modifier sheet), DRAFT (unsent lines), KDS, OPS, DIAG, SETTINGS.
- **Backend:** endpoints under `/api/v1`. `B1..B4` = planned extensions; `MISSING` = nothing on server (none needed in P0).

## 1. Cross-cutting (all roles)

| ID | Feature | Business purpose | Pri | Screens | Backend | Perm | Deps | Status | Tests |
|---|---|---|---|---|---|---|---|---|---|
| F-X-01 | Server URL config + health check; "change server" reachable from LOGIN | Phones need the bar's LAN address without hardcoding (D8) | P0 | SETUP, LOGIN | `GET /health` | n/a (PUB) | LAN reachability (see DEPENDENCIES_AND_GAPS E1-E3) | Not started | U, I, C, E |
| F-X-02 | Login username/password | Identify staff, obtain JWT | P0 | LOGIN | `POST /auth/login`, `GET /auth/me` | SRV | F-X-01; shared rate-limit bucket N1 | Not started | U, I, C, E |
| F-X-03 | Session restore + token refresh (single-flight, like web `client.ts`) | Staff shouldn't re-login every shift start; 8h access / 7d refresh | P0 | (none) | `POST /auth/refresh` | SRV | F-X-02, SecureStore | Not started | U, C |
| F-X-04 | Role-based entry (D9) + access-denied for unknown role | Right first screen per role | P0 | DENIED + role home | claim `role` / `GET /auth/me` | UX | F-X-02; G25 (stale role until refresh) | Not started | U, I |
| F-X-05 | Connection indicator + offline/"last updated" banner; reads from cache, mutations disabled offline (D7) | Staff must know when data is stale before acting | P0 | all | `GET /health` poll; socket state | n/a | F-X-09 | Not started | U, I, E |
| F-X-06 | Logout | Shared/lost phones | P0 | SETTINGS | `POST /auth/logout` (G3: refresh not revoked; app wipes it locally) | SRV (access jti) | F-X-02 | Not started | U, C |
| F-X-07 | Spanish UI (default) | Spanish-first staff | P0 | all | none | n/a | reuse web `es` bundle | Not started | U |
| F-X-08 | English toggle | Secondary language | P1 | SETTINGS | none | n/a | F-X-07 | Not started | U |
| F-X-09 | Socket.IO connect, join rooms by role, reconnect, refetch on reconnect/foreground (D8) | Live floor/KDS | P0 | all | Socket `join` rooms floor/kitchen/bar/`ticket:<id>` | UX (G1: rooms unauthenticated) | nginx `/socket.io/` | Not started | U, C |
| F-X-10 | Error normalisation: JSON `{error,message}`, `{msg}`, `{valid:false}`, HTML, 429, 413 -> typed app errors + Spanish messages | Server errors are inconsistent (G17) | P0 | all | all | n/a | none | Not started | U |
| F-X-11 | Persistent local draft store (per user+ticket) | D5/D7 | P0 | DRAFT | none (local) | n/a | AsyncStorage/MMKV | Not started | U, I |

## 2. WAITER

| ID | Feature | Business purpose | Pri | Screens | Backend | Perm | Deps | Status | Tests |
|---|---|---|---|---|---|---|---|---|---|
| F-W-01 | Floor overview: tables grouped by type (POOL/REGULAR/BAR), status, customer name, pool timer start, payment-requested flag | Know which tables are free/busy at a glance | P0 | FLOOR | `GET /resources` (adds `active_ticket_id, customer_name, timer_start`); socket `floor:update` | UX | F-X-09. Payment-requested flag is on ticket, not resource: fetch via `GET /tickets/pending-payment` (see PM note 4) | Not started | U, I, C |
| F-W-02 | "Bar closed" banner; disable Open table | Server returns 403 BAR_CLOSED; avoid dead-end | P0 | FLOOR | `GET /cash/status` | SRV (on open) | none | Not started | I, C |
| F-W-03 | Open table (TABLE ticket) | Start a tab | P0 | FLOOR -> TICKET | `POST /tickets` {resource_id, ticket_type:TABLE}; 403 BAR_CLOSED, 409 RESOURCE_OCCUPIED | SRV (session/occupancy) | F-W-02. POOL table starts timer automatically | Not started | I, C, E |
| F-W-04 | Ticket detail: lines + kitchen status, server total, pool timer estimate (labelled "estimado", D3) | See what the table owes | P0 | TICKET | `GET /tickets/<id>`; socket `ticket:updated`, `ticket:item_status` | UX | F-X-09 | Not started | U, I, C |
| F-W-05 | Menu browse by category + search | Find items fast | P0 | MENU | `GET /menu/categories`, `GET /menu/items?category_id=` | UX | cache (D7) | Not started | I, C |
| F-W-06 | Modifier selection; enforce `is_mandatory`, `min/max_selections`, `allow_multiple` client-side (BR §E.63, §K.136) | Server only checks `requires_flavor` | P0 | MODS | `GET /menu/modifiers`, `GET /menu/items/<id>`; server 422 `FLAVOR_REQUIRED` as backstop | UX (client) + SRV (flavor) | F-W-05 | Not started | U, I, C |
| F-W-07 | Line quantity (1-99) and line notes | Order accuracy; notes can only be set at add (BR §E.80) | P0 | MODS, DRAFT | payload of `POST /tickets/<id>/items` (`quantity`, `notes`) | SRV (422 INVALID_QUANTITY) | F-W-06 | Not started | U, I |
| F-W-08 | Local draft + explicit Send (Enviar); per-line UUID Idempotency-Key; button locked while in flight; per-line result (sent/failed); retry only failed lines with same key | D5/D6: no staged step on server | P0 | DRAFT, TICKET | `POST /tickets/<id>/items` + `Idempotency-Key` (B1), `X-Ticket-Version` optional; 422 OUT_OF_STOCK/FLAVOR_REQUIRED; 403 TICKET_CLOSED | SRV | B1 (feature-detect; without it: no auto-retry of ambiguous failures, refetch ticket and reconcile, see G13); F-X-11 | Not started | U, I, C, E |
| F-W-09 | Ready notifications in-app (banner/badge + vibration) when own-table item turns READY | Food gets served hot | P0 | all (global toast), TICKET | socket `kitchen:item_update`/`bar:item_update` (status READY) enriched by B2 (`ticket_id, resource_code, menu_item_name, quantity, opened_by`); `ticket:item_status` | UX | B2; fallback without B2: join public `kitchen`/`bar` rooms + refetch open tickets on event, derive diff locally | Not started | U, I, C |
| F-W-10 | Mark item served | Close the loop; clears KDS | P0 | TICKET | `PATCH /queue/<item>/status` {status:SERVED} | UX (G5: ungated; B3 blocks VOIDED) | F-W-09; B3 | Not started | I, C |
| F-W-11 | Request bill (confirm dialog; warn that pool table will be freed/timer stopped, G11) | D4: waiter signals cashier, no settlement | P0 | TICKET | `POST /tickets/<id>/request-payment` | UX (G7) | none | Not started | I, C, E |
| F-W-12 | Cancel empty ticket (opened by mistake) | Without it a misopened table is stuck (no close in v1) | P0 | TICKET | `POST /tickets/<id>/cancel`; 422 HAS_ITEMS / HAS_POOL_TIME | SRV (empty check) | none. Pool table with timer: not cancellable -> "ask manager" message | Not started | I, C |
| F-W-13 | Void item (manager PIN prompt) | Fix ordering mistakes | P1 | TICKET, PIN sheet | `DELETE /tickets/<id>/items/<item>` {pin, reason}; 401 INVALID_PIN, 409 ALREADY_VOIDED | SRV (PIN) | G12: kitchen not told; show warning if line already IN_PROGRESS/READY | Not started | I, C |
| F-W-14 | Decrease qty (PIN); increase (no PIN) | Order edits | P1 | TICKET | `PATCH /tickets/<id>/items/<item>` {quantity, pin?}; 403 MANAGER_REQUIRED | SRV | F-W-13 PIN sheet | Not started | I, C |
| F-W-15 | Manual discount (only if role MANAGER/ADMIN) with PIN UX | Manager comps | P1 | TICKET | `POST /auth/verify-pin`, `PATCH /tickets/<id>/discount` | SRV (role claim); PIN is UX only (BR §F.82-83) | verify-pin 5/min shared (N1) | Not started | I, C |
| F-W-16 | Transfer table | Guests move | P1 | TICKET | `POST /tickets/<id>/transfer`; 409 RESOURCE_OCCUPIED | SRV (target AVAILABLE) | FLOOR picker | Not started | I, C |
| F-W-17 | Set customer name | Identify tabs | P1 | TICKET | `PATCH /tickets/<id>/customer-name` | SRV (OPEN only) | none | Not started | I, C |
| F-W-18 | Promo accept/decline | Promos with `requires_confirmation` | P1 | TICKET | `POST /tickets/<id>/promotions/<pid>` {decision}; list in `GET /tickets/<id>` `available_promotions` | UX | none | Not started | I, C |
| F-W-19 | Waiting list view (read-only) | Know who is queued | P1 | FLOOR tab | `GET /waiting-list`; socket `waiting:update` | UX | G16 (use `waiting:update` only) | Not started | I, C |
| F-W-20 | Express ticket (no table) | Counter sales | P1 | FLOOR | `POST /tickets` {ticket_type:EXPRESS}; `GET /tickets/active-express` | SRV (session) | No idempotency: duplicate-tap guard only (G13) | Not started | I, C |
| F-W-21 | Print pre-bill | Hand guest a bill preview | P1 | TICKET | `POST /tickets/<id>/print` (unpaid); 503 agent down | UX (G6) | print agent (E4) | Not started | I, C |
| F-W-22 | Grey out sold-out items | Avoid 422 OUT_OF_STOCK round trips | P1 | MENU | `GET /inventory/stock-check` (`blocked_items`, `blocked_modifiers`) | n/a | none (server still authoritative) | Not started | I, C |
| F-W-23 | Waiting list add/assign | Seat parties | P2 | FLOOR | `POST /waiting-list`, `POST /waiting-list/<id>/assign` | UX | none | Not started | I, C |
| F-W-24 | Temp tables create/delete | Floating tables | P2 | FLOOR | `POST /resources` {is_temp}, `DELETE /resources/<id>` | SRV | none | Not started | I, C |

## 3. KITCHEN_STAFF / BAR_STAFF (one KDS screen, station = role; manager/admin can switch)

| ID | Feature | Business purpose | Pri | Screens | Backend | Perm | Deps | Status | Tests |
|---|---|---|---|---|---|---|---|---|---|
| F-K-01 | Station queue grouped by ticket/table (KITCHEN for KITCHEN_STAFF, BAR for BAR_STAFF) | Know what to prepare | P0 | KDS | `GET /queue/kitchen` or `/queue/bar` | UX (G5: any role can read either) | F-X-09 | Not started | I, C |
| F-K-02 | Item age with colour thresholds (default green <5 min, amber 5-10, red >10; constants, tunable later) | Spot late items | P0 | KDS | `sent_at` from queue item | n/a | none; thresholds are operational patterns (see Research notes) | Not started | U |
| F-K-03 | Notes + modifiers shown prominently (qty x modifier names, notes highlighted) | Prevent wrong preparation | P0 | KDS | queue item `notes`, `modifiers[]` | n/a | none | Not started | U, I |
| F-K-04 | Advance SENT -> IN_PROGRESS -> READY (then READY -> SERVED by "bump"); order enforced client-side (BR §E.72); button locked in flight | Core KDS action | P0 | KDS | `PATCH /queue/<item>/status`; B3 rejects VOIDED | UX (G5: server has no transition check) | B3 | Not started | U, I, C, E |
| F-K-05 | Live updates + fallback poll every 15 s (void is not pushed, G12) | Queue stays correct | P0 | KDS | socket `kitchen:update`/`bar:update`/`*:item_update`; `GET /queue/counts` | n/a | F-X-09 | Not started | I, C |
| F-K-06 | KDS stale warning (socket down > 30 s: red banner, actions disabled) | Cooks must not trust a frozen list | P0 | KDS | socket state | n/a | F-X-05 | Not started | I |
| F-K-07 | Sound/vibration on new item | Attention | P1 | KDS | socket events; `GET /settings/kds_sound_enabled` | n/a | F-K-05 | Not started | I |
| F-K-08 | Print chit again for an item | Printer jam | P2 | KDS | `POST /queue/<item>/print` | UX (G6) | print agent (E4) | Not started | C |

## 4. MANAGER

Inherits all WAITER features (F-W-*) plus KDS read/advance. Entry = OPS.

| ID | Feature | Business purpose | Pri | Screens | Backend | Perm | Deps | Status | Tests |
|---|---|---|---|---|---|---|---|---|---|
| F-M-01 | Ops overview: cash session open/closed, open-tickets count + list, kitchen/bar counts, oldest waiting item age | Run the floor remotely | P0 | OPS | `GET /cash/status`, `GET /tickets/open-all`, `GET /queue/counts`, `GET /queue/kitchen`+`/bar` (oldest `sent_at`) | SRV (`open-all` MGR); rest UX | F-X-09 | Not started | I, C |
| F-M-02 | Pending-payment list | Know who waits for the cashier | P0 | OPS | `GET /tickets/pending-payment` | UX | none | Not started | I, C |
| F-M-03 | Open any ticket (read-only) + waiter actions | Support waiters | P0 | TICKET | `GET /tickets/<id>` + F-W actions | as F-W | F-M-01 | Not started | I |
| F-M-04 | View/advance KDS (read) | Check kitchen without leaving | P1 | KDS | as F-K | UX | F-K-01 | Not started | I |
| F-M-05 | Discount / void with PIN (same as F-W-13/15) | Manager overrides | P1 | TICKET | see F-W | SRV | F-W-13, F-W-15 | Not started | I, C |
| F-M-06 | Cash session open/close from phone | Convenience | P2 | OPS | `POST /cash/open`, `POST /cash/close` (409 OPEN_TICKETS, SESSION_ALREADY_OPEN) | SRV (MGR) | not idempotent but state-guarded | Not started | I, C |

## 5. ADMIN

Inherits all MANAGER features.

| ID | Feature | Business purpose | Pri | Screens | Backend | Perm | Deps | Status | Tests |
|---|---|---|---|---|---|---|---|---|---|
| F-A-01 | Diagnostics: server URL, health result, socket state/rooms, app version, user/role, last sync, last error | Field debugging without a laptop | P0 | DIAG | `GET /health`, `GET /auth/me`, socket client | UX | F-X-01, F-X-09 | Not started | U, I |
| F-A-02 | Settings toggles `kds_sound_enabled`, `print_bar_tickets` | Operate KDS/printing | P1 | SETTINGS | `GET/PUT /settings/<key>`; socket `settings:changed` | SRV (MGR) | none | Not started | I, C |
| F-A-03 | Users list (read-only) | Who exists | P2 | SETTINGS | `GET /users` | SRV (ADM) | none | Not started | C |
