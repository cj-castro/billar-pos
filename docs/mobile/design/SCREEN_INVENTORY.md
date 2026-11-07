# Screen Inventory

Route paths follow **expo-router** file conventions: groups `(auth)`, `(waiter)`, `(kds)`, `(manager)`. Admin screens live inside `(manager)` (role-gated tab) to avoid a fourth tab tree. Prototype file per screen in `prototypes/`. Roles: W = WAITER, K = KITCHEN_STAFF, B = BAR_STAFF, M = MANAGER, A = ADMIN. API refs: [API_CAPABILITY_MATRIX.md](../discovery/API_CAPABILITY_MATRIX.md); BE-ext = backend extensions B1–B4 in PROJECT_STATE.

Total: **21 screens/overlays** (3 auth, 3 shared, 7 waiter screens + 2 overlays, 1 KDS in 2 orientations, 4 manager (2 are reuse), 1 admin) plus the global connection/offline layer. **17 prototype pages** (`prototypes/index.html`).

## A. Cross-cutting

| ID | Name | Route | Roles | Purpose | Data / API | Components | Prototype |
|---|---|---|---|---|---|---|---|
| SCR-AUTH-00 | Splash / session restore | `/` (index redirect) | all | Restore tokens from SecureStore, validate, route by role | SecureStore tokens, `POST /auth/refresh`, `GET /auth/me`, `GET /health` | Logo, progress bar | `17-splash.html` |
| SCR-AUTH-01 | ServerSetup | `/(auth)/server` | all (first launch / "Cambiar") | Enter `http://<host>:8080`, **Probar conexión**, save | `GET /api/v1/health` (D8) | AppButton, field, result row, language toggle | `01-server-setup.html` |
| SCR-AUTH-02 | Login | `/(auth)/login` | all | Username + password -> role entry | `POST /auth/login` | AppButton, fields, server pill, ErrorBanner inline | `02-login.html` |
| SCR-X-01 | AccessDenied | `/access-denied` | any signed-in | Role not allowed for a route / unknown role (D9) | JWT `role` | ErrorState(forbidden) | `16-access-denied.html` |
| SCR-X-02 | GenericError (fatal boundary) | `/error` (+ inline ErrorState everywhere) | all | Unhandled error / server error; retry | last error code | ErrorState | `14-error.html` |
| SCR-X-03 | Yo (profile & session) | `/(waiter)/me`, `/(manager)/me`, `/(kds)/me` (same component) | all signed-in | Name/role, language ES/EN, connection details, sound/vibration, **Cerrar sesión** | `GET /auth/me`, `POST /auth/logout`, local settings | ConnectionPill, toggles, ConfirmDialog | (shown inside 12 settings block) |
| (global) | Connection indicator + OfflineBanner | in `ScreenScaffold` | all signed-in | Always-visible link state; offline/stale banner | socket state, NetInfo, last-success timestamp | ConnectionPill, OfflineBanner | `13-offline.html` |

## B. Waiter (WAITER; MANAGER/ADMIN read-only variants)

| ID | Name | Route | Roles | Purpose | Data / API | Components | Prototype |
|---|---|---|---|---|---|---|---|
| SCR-W-01 | Floor | `/(waiter)/floor` | W, M, A | Tables grouped **Billar / Mesas / Barra** with state, customer, pool timer; "Bar cerrado" banner when no OPEN cash session; ready toast | `GET /resources` (adds `active_ticket_id, customer_name, timer_start, pool_config`), `GET /cash/status`, socket room `floor` (`floor:update`) | ScreenScaffold, TableCard, OfflineBanner, banner "Bar cerrado", Toast, LoadingSkeleton, EmptyState, ErrorState, TabBar | `03-floor.html`, `13-offline.html` |
| SCR-W-02 | Ticket detail | `/(waiter)/ticket/[ticketId]` (also `/(manager)/tickets/[ticketId]`) | W, M, A | Lines with kitchen-status chips, server total, pool time **estimado**, draft hint; actions **Agregar productos**, **Pedir cuenta** (manager: + void/discount, no add) | `GET /tickets/{id}`, socket `ticket:<id>` (`ticket:updated`, `ticket:item_status`), `POST /tickets/{id}/request-payment`, `DELETE /tickets/{id}/items/{item}` (pin), `PATCH /tickets/{id}/discount` (MGR) | TopBar, StatusChip, TicketLine, BottomActionBar, ConfirmDialog, PinPad | `04-ticket.html` |
| SCR-W-03 | Menu | `/(waiter)/ticket/[ticketId]/menu` | W | Category chips + search + item grid; sold-out greyed | `GET /menu/categories`, `GET /menu/items`, `GET /menu/modifiers`, `GET /inventory/stock-check` | MenuItemTile, search field, category chips, BottomActionBar | `05-menu.html` |
| SCR-W-04 | ItemConfigurator (sheet) | `/(waiter)/ticket/[ticketId]/configure/[itemId]` (modal) | W | Mandatory/optional modifier groups with min/max, notes, quantity | menu item + modifier groups (cached) | ModifierGroup, QuantityStepper, notes field, AppButton | `06-item-configurator.html` |
| SCR-W-05 | DraftReview "Pedido por enviar" | `/(waiter)/ticket/[ticketId]/draft` | W | Review local draft; **Enviar (n)**; per-line pendiente/enviando/enviado/falló; retry | local persisted draft; `POST /tickets/{id}/items` per line with `Idempotency-Key` (B1) + `X-Ticket-Version`; fallback refetch ticket | DraftLineRow, BottomActionBar, banner, ConfirmDialog (descartar) | `07-draft-review.html` |
| SCR-W-06 | Ready ("Listos") | `/(waiter)/ready` | W | List of READY lines for *my* tickets, oldest first; **Marcar servido** (per line / todo) | `GET /queue/kitchen`, `/queue/bar` (READY, filter by `opened_by` — BE-ext B2 adds it; else join to `GET /tickets?status=OPEN`), `PATCH /queue/{item}/status` SERVED, sockets `kitchen`,`bar`, `ticket:<id>` | StatusChip, card, AppButton(success), EmptyState, tab badge | `08-ready-list.html` |
| SCR-W-07 | OpenTable (sheet) | `/(waiter)/floor/open/[resourceId]` (modal) | W | Tap a Libre table -> optional customer name -> open ticket | `POST /tickets {resource_id, ticket_type:'TABLE', customer_name?}` (403 `BAR_CLOSED`, 409 `RESOURCE_OCCUPIED`) | field, AppButton | (wireframe in mockups/waiter-flow.md) |
| OV-01 | ManagerPin dialog | overlay (no route) | W (void / protected action) | Wait for a manager PIN, then perform action | `POST /auth/verify-pin`; void sends `pin` in body | PinPad, ConfirmDialog | `15-manager-pin.html` |
| OV-02 | Ready toast | overlay | W | In-app alert when a line of mine turns READY | sockets as W-06 | Toast | in `03-floor.html` |

Deep-link target for the ready toast: `bola8://ticket/{ticketId}`.

## C. Kitchen / Bar (KDS)

| ID | Name | Route | Roles | Purpose | Data / API | Components | Prototype |
|---|---|---|---|---|---|---|---|
| SCR-K-01 | KDS queue | `/(kds)/queue/[station]` (`station` = `kitchen` \| `bar`); managers also via `/(manager)/kds/[station]` | K (kitchen), B (bar), M, A (switch) | Ticket cards oldest-first, age colour, per-item tap to advance, **Todo listo**, station switch (M/A only), connection pill; portrait + landscape; keep-awake | `GET /queue/{station}`, `GET /queue/counts`, `PATCH /queue/{item}/status`, sockets `kitchen`/`bar` (`*:update`, `*:item_update`), `GET /settings/kds_sound_enabled` | KdsTicketCard, KdsItemRow, KdsAgeBadge, ConnectionPill, OfflineBanner, EmptyState | `09-kds-portrait.html`, `10-kds-landscape.html` |

K/B users are locked to their station (no switch, no other tabs); a role-mismatched deep link -> SCR-X-01.

## D. Manager / Admin

| ID | Name | Route | Roles | Purpose | Data / API | Components | Prototype |
|---|---|---|---|---|---|---|---|
| SCR-M-01 | Ops overview | `/(manager)/overview` | M, A | Cash session state; open tickets; **cuentas solicitadas**; kitchen/bar counts; oldest item age; alerts | `GET /cash/status`, `GET /tickets/open-all` (MGR), `GET /queue/counts`, `GET /queue/kitchen`+`/bar` (oldest `sent_at`), derived alerts; sockets `floor`,`kitchen`,`bar` | StatTile, KdsAgeBadge, alert rows, TabBar | `11-manager-overview.html` |
| SCR-M-02 | Open tickets | `/(manager)/tickets` (+ `/(manager)/tickets/[ticketId]` = W-02 read mode) | M, A | List all OPEN tickets: table, customer, opened, items, total, flags (cuenta solicitada); filter All / Cuenta solicitada | `GET /tickets/open-all`, socket `floor` | list rows, StatusChip, EmptyState | (wireframe in mockups/manager-flow.md) |
| SCR-M-03 | Floor (read-only) | `/(manager)/floor` | M, A | Same Floor as W-01; taps open W-02 read mode; no "Abrir mesa" | as W-01 | TableCard | reuses `03-floor.html` |
| SCR-M-04 | KDS (manager) | `/(manager)/kds/[station]` | M, A | Same as K-01 with station switch | as K-01 | as K-01 | reuses `09`/`10` |
| SCR-A-01 | System (diagnostics + settings) | `/(manager)/system` (tab hidden unless ADMIN) | A | Server URL, `/health`, socket state + rooms, app/server version, user/role, last sync; toggles (sound, vibration, keep awake, KDS large text); actions Probar conexión, Copiar datos; language | `GET /health`, socket status, `GET /auth/me`, local settings, `PATCH /settings/*` (MGR+) only for `kds_sound_enabled` | ConnectionPill, toggles, AppButton | `12-admin-diagnostics.html` |

## E. Coverage vs scope

| Scope item | Screen |
|---|---|
| First-launch server setup (URL + Probar conexión) | AUTH-01 |
| Login | AUTH-02 |
| Session restore splash | AUTH-00 |
| Role routing | AUTH-00/02 -> D9 map (NAVIGATION_ARCHITECTURE §3) |
| Connection indicator + offline banner | global (ScreenScaffold) |
| Logout | X-03 (+ Admin screen) |
| Language toggle | AUTH-01/02, X-03, A-01 |
| Access denied / generic error | X-01 / X-02 |
| Waiter: Floor, Ticket, Menu, Configurator, Draft, Ready + toast, PIN | W-01..W-06, OV-01/02 (+ W-07 open table) |
| KDS | K-01 |
| Manager | M-01, M-02 (+ M-03/04 reuse) |
| Admin | A-01 |

## F. Route tree

```
app/
  _layout.tsx                 # providers, auth gate, socket, offline
  index.tsx                   # AUTH-00
  access-denied.tsx           # X-01
  error.tsx                   # X-02
  (auth)/server.tsx  (auth)/login.tsx
  (waiter)/_layout.tsx        # Tabs: floor, ready, me   (role gate WAITER)
    floor/index.tsx  floor/open/[resourceId].tsx(modal)
    ready.tsx  me.tsx
    ticket/[ticketId]/index.tsx  .../menu.tsx  .../configure/[itemId].tsx(modal)  .../draft.tsx
  (kds)/_layout.tsx           # Stack, no tabs (role KITCHEN/BAR)
    queue/[station].tsx  me.tsx
  (manager)/_layout.tsx       # Tabs: overview, tickets, floor, kds, me, system(admin only)
    overview.tsx  tickets/index.tsx  tickets/[ticketId].tsx  floor.tsx  kds/[station].tsx  me.tsx  system.tsx
```

## G. v2 additions (2026-11-06)

Routes use the current `app/` tree (groups `(waiter)`, `(manager)`, `(kitchen)`). Spec: [../v2/DESIGN_SPEC_V2.md](../v2/DESIGN_SPEC_V2.md).

| ID | Name | Route | Roles | Purpose | Data / API |
|---|---|---|---|---|---|
| SCR-W-08 | Cobrar (pay) | `/(waiter)/ticket/[ticketId]/pay` | W, M, A | Tip chips, Efectivo (pre-selected) / Tarjeta / Mixto, cash pad with exacto chip, confirm dialog, success with change due and print. Manager/admin return to Tickets, waiter to Mesas | `POST /tickets/{id}/close` (`Idempotency-Key`; 422 `INSUFFICIENT_PAYMENT`/`AMOUNT_MISMATCH`; 403 `PIN_REQUIRED` opens PinPad), `POST /tickets/{id}/print?unpaid=false` |
| SCR-W-09 | Lista de espera | `/(waiter)/waiting` | W, M, A | Add, seat and remove waiting parties; badge on Mesas header | waiting-list endpoints, sockets `waiting:update`, `waiting_list:update` |
| SCR-W-10 | Rapido / express open-table | `/(waiter)/open-table/[resourceId]` and Mesas header `Rapido` | W, M, A | Open an EXPRESS ticket (no table) or a table with optional customer name; `Abrir y pedir` goes straight to the menu | `POST /tickets` (EXPRESS or TABLE; 403 `BAR_CLOSED` links to Caja for managers) |
| SCR-M-05 | Caja | `/(manager)/(tabs)/caja` | M, A | Open session with fund, live summary, expenses, session tickets, close with counted cash, history | `/cash/status`, `/cash/open`, `/cash/current/summary`, `/cash/current/tickets`, `/cash/current/expenses`, `/cash/close`, `/cash/sessions` |
| SCR-M-06 | Mas | `/(manager)/(tabs)/mas` | M, A | Menu of Cocina/Barra, Lista de espera, Piso, Sistema (A), Yo | local navigation |
| SCR-A-02 | Reportes | `/(manager)/(tabs)/reportes` | A | Date presets and range; sales, payments, pool time, promos, voids, staff, peak hours, earnings, safe, cash sessions; CSV share | `/reports/*`, `/earnings*`, `/safe`, `/cash/sessions`, `/cash/{id}/summary` |
| OV-03 | KdsMeSheet | overlay on KDS (account icon in the header) | K, B | Name, language, mute, station switch, logout. Replaces the old `kds-me` route | local prefs, `POST /auth/logout` |
