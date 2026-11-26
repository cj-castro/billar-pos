# Bola 8 Staff — v2 Design Spec

Author: Fable 5.1 (orchestrator). Date: 2026-11-05. Status: locked for build.
Supersedes scope decisions D4, D9, D16, D17 of `PROJECT_STATE.md`. Keeps design system, tokens, navigation shell, draft/send architecture, and all v1 screens unless stated.

## 0. Goals

1. Every role can do its daily job from the phone, not just watch it.
2. Waiter: open → order → send → serve → **cobrar** without touching the bar machine.
3. Manager: fix mistakes (void, reopen, discount, promo), run the cash drawer, reprint.
4. Owner: see today's money in 2 taps.
5. Keep v1 craft: tokens, pure models, idempotency, offline read-only, Spanish-first.

Non-goals (still desk work): menu/modifier CRUD, inventory restock/adjust, users CRUD, promo CRUD, fixed costs, analytics deep-dives, email reports, iOS.

## 1. Role → tabs

| Role | Tabs (bottom) | Notes |
|---|---|---|
| WAITER | Mesas · Listos · Yo | unchanged shell; Mesas gains header actions |
| KITCHEN/BAR | (no tabs) Cola | + undo snackbar, sound, keep-awake |
| MANAGER | Resumen · Tickets · Piso · Caja · Más | Más = Cocina/Barra, Lista de espera, Yo |
| ADMIN | Resumen · Tickets · Caja · Reportes · Más | Más = Piso, Cocina/Barra, Lista de espera, Sistema, Yo |

Manager/Admin can also act as a waiter (open table, add items) — remove D16 restriction. Guard: same screens, `GroupGuard` allows MANAGER/ADMIN into `(waiter)` routes (already true for reads).

## 2. Waiter

### 2.1 Floor (`(waiter)/(tabs)/floor`)
- Tile (v1 + restore prototype density): code, state icon+word, **customer name** (if any), **pool timer mm:ss** live for POOL tables, **"Cuenta" bell** when `payment_requested`.
- Header right: `Lista de espera` icon with badge count → §2.8. Header left: `Rápido` button → §2.6 (EXPRESS).
- Hardware back on Floor root: show "Salir de la app?" confirm (fix UX #4).
- Tap free table → **Open-table sheet** (name optional) → `Abrir y pedir` (primary) goes straight to Menu with ticket created; secondary `Solo abrir` goes to ticket. Saves 1 tap.
- Tap occupied table → Ticket.

### 2.2 Menu (`menu`)
- New top row **"Frecuentes"**: 8 chips, computed locally from this waiter's sent lines (last 30 days, AsyncStorage). Tap = quick-add (no sheet if no mandatory modifier).
- Ticket screen gets **"Repetir última ronda"** in overflow: copies the last sent batch into the draft.
- Category chips: show fade gradient at right edge to signal scroll.

### 2.3 Configurator sheet
- Sticky footer with stepper + `Agregar`. Notes field moves ABOVE modifier groups when groups ≥ 2 (so it is never below the fold). Sheet snaps to 90%.

### 2.4 Draft
- Unchanged. Rename ghost "Descartar pedido" icon to `close-circle` (not trash).
- If draft has unsent lines and user navigates to Floor: persistent amber bar on Floor "1 pedido sin enviar · Mesa 3 → Enviar" (fix UX #6).

### 2.5 Ticket (`ticket/[ticketId]`)
Header: table code · customer name · pool timer (POOL only) with `Detener` ghost button.
Body: lines grouped by batch, totals card (subtotal, descuento, tiempo de mesa, propina, **total**).
Bottom bar (2 buttons, 56 dp): `Agregar` (secondary) · **`Cobrar`** (primary, sky). Replaces "Pedir cuenta" as primary; "Pedir cuenta" (request-payment) stays in overflow for venues where cashier pays at bar.
Overflow `Más acciones` (full-width list rows, fix UX #10): Pedir cuenta · Pre-cuenta (print) · Nombre del cliente · Transferir mesa · Descuento (PIN) · Promoción (manager) · Repetir última ronda · Cancelar ticket.
POOL header `Detener tiempo` (waiter): server has no waiter-callable stop; it maps to `request-payment` (stops timer, frees table, flags cuenta pedida) → confirm sheet showing elapsed + estimated cost. `Cobrar` also stops it. Manager mode adds `Anular tiempo` (void-timer) and `Corregir tiempo` (timer PATCH start/end), role-gated, no PIN per server.
Pool cost estimate on client: `rate_cents` × elapsed per `billing_mode` (PER_MINUTE / ROUND_15 / PER_HOUR) minus `promo_free_minutes`; label "aprox." because server recomputes on stop.
If ticket create returns 403 `BAR_CLOSED`: toast "Caja cerrada. Pide al gerente abrir caja." (manager sees `Abrir caja` link).

### 2.6 EXPRESS ticket
Floor header `Rápido` → creates EXPRESS ticket (customer name optional sheet) → Menu → Draft → Ticket. Ticket header shows "Rápido #N" instead of table. Appears in Floor under new group row "Rápidos" (chips) while open.

### 2.7 Cobrar (NEW `ticket/[ticketId]/pay`)
Layout (single screen, no scroll on 6"):
1. Total due, big (32 dp). Below: breakdown line "Subtotal · Desc. · Tiempo".
2. **Propina** chip row: `Sin propina` · `10%` · `15%` · `20%` · `Otro` (numpad). Tip source auto = payment method; for Mixto show `Efectivo/Tarjeta` toggle.
3. **Método** segmented: `Efectivo` · `Tarjeta` · `Mixto`. (`EXTERNAL` only when ticket is DELIVERY → auto-selected, no numpad.)
4. Efectivo: **Recibido** numpad with quick chips (exact, next 50/100/200/500) → **Cambio** computed, green, large.
   Tarjeta: no amount input; `Recibido` = total+tip.
   Mixto: two rows `Efectivo $___` + `Tarjeta $___`; remaining auto-fills second; validation sum = total+tip.
5. Primary `Cobrar $X` (56 dp). Disabled until valid. On tap: confirm sheet "Cobrar $X en efectivo · Cambio $Y" → `Confirmar`.
6. Success state (same screen morphs): big check, "Mesa 3 cerrada", buttons `Imprimir recibo` · `Volver al piso` (auto after 3 s). Table frees; pool timer stops server-side.
Rules: idempotency key per pay attempt (UUID stored in draft store under ticket, cleared on success); 409 `TICKET_VERSION` → refetch and show "El ticket cambió, revisa el total"; 403 → "Pide a un gerente" (if server limits waiter closing — see §6).
Discount: not editable here; link `Descuento` opens PIN flow then returns.

### 2.8 Lista de espera (NEW `waiting`)
List rows: name, party size, wait time (live), `Asignar` button. Header `+ Agregar` sheet: name, personas stepper, prefers Billar/Mesa toggle. `Asignar` → picks free table from a compact grid sheet → opens ticket with customer name prefilled → Menu. Swipe row → `Quitar` (dequeue) with undo snackbar.

### 2.9 Listos + alerts
- Keep 2-tap serve. Add **sound** (short chime, `expo-audio`) + vibration on `ticket:item_status READY` for this waiter's tickets. Toggle in Yo.
- When app backgrounded: **local notification** via `expo-notifications` "Listo: Mesa 3 · Alitas" (tap → Listos). Scheduled from socket event while JS alive; accept that a killed process will miss it (documented limit; no push server).

## 3. Kitchen / Bar KDS
- **Undo**: after `Listo` or `Todo listo`, snackbar 3 s `Deshacer` (reverts via status PATCH to IN_PROGRESS). Implements documented D-4 undo.
- **Sound** on new ticket in station (`kitchen:update`/`bar:update` with new SENT lines); respects `kds_sound_enabled` server setting AND local mute. Remove the raw-key hint text.
- `expo-keep-awake` while on Cola.
- Header shows `N en cola · más viejo 12 min`.
- Age thresholds: keep 10/20 min tokens; make them server settings `kds_warn_min`, `kds_late_min` (read via settings endpoint, fallback tokens).
- `kds-me`: wire long-press on logo (TODO fix) → profile sheet (station switch for MANAGER, logout, mute).

## 4. Manager

### 4.1 Resumen
Stat tiles (2×3): **Ventas hoy** (closed tickets sum, cents) · **Efectivo / Tarjeta hoy** · Tickets abiertos (count + unpaid total) · Cuentas pedidas · Cola cocina/barra (oldest age) · Caja (abierta desde HH:MM, fondo). Alerts list: print failures, tickets > 2 h, cash closed while tickets open, void count today > threshold.
Source: reports sales/payments for today (see API sheet); refresh on `ticket:updated` + 60 s.

### 4.2 Tickets
Filters chips: Abiertos · Cuenta pedida · Cerrados hoy · Cancelados. Row: table/express, name, total, age, waiter. Tap → §4.3.

### 4.3 Ticket (manager mode)
Everything a waiter has, plus `Acciones de gerente` section (PIN each, single PIN sheet reused): Anular línea (exists) · **Anular ticket** (cancel non-empty) · **Reabrir** (closed) · **Cerrar forzado** · **Editar pago** (reopens Cobrar prefilled, shows edit history) · **Aplicar promoción** (picker of active promos) · Descuento % · **Reimprimir comanda** (kitchen/bar chit) · Anular tiempo de mesa.
PIN: MANAGER/ADMIN JWT already satisfies server; PIN sheet only when server replies 403 `PIN_REQUIRED` (keep v1 behaviour).

### 4.4 Caja (NEW)
State A closed: `Abrir caja` → sheet: fondo inicial numpad → open.
State B open: summary card (fondo, ventas efectivo, ventas tarjeta, propinas, gastos, **esperado en caja**), `Gastos` list + `+ Gasto` sheet (concepto, monto), `Tickets de la sesión` link, **`Cerrar caja`** → sheet: efectivo contado numpad → shows diferencia (green/red) → confirm (PIN) → closed summary; `Distribuir propinas` link if endpoint exists.
Guard: cannot close with open tickets → show count + link to Tickets.

### 4.5 Piso (manager)
Same Floor as waiter including Abrir mesa (D16 removed).

## 5. Admin / Owner

### 5.1 Reportes (NEW tab)
Period selector chips: Hoy · Ayer · Semana · Mes · Rango (date pickers).
Cards (vertical scroll, each card = one endpoint, lazy):
1. **Ventas**: total, tickets, ticket promedio; by method (efectivo/tarjeta/externo); propinas.
2. **Por categoría**: horizontal bar rows (View-based bars, no chart lib).
3. **Por mesero**: name, ventas, tickets, propinas.
4. **Tiempo de mesas (billar)**: horas vendidas, ingreso, por mesa.
5. **Horas pico**: 24 mini bars.
6. **Anulaciones**: count, total, list (who/why) → drill.
7. **Promociones**: uses, descuento total.
8. **Sesiones de caja**: list with diferencia; tap → session detail.
9. **Caja fuerte**: collections list + `+ Retiro a caja fuerte` (PIN).
Export: `Compartir CSV` via share sheet if export endpoint exists; else omit.

### 5.2 Sistema
v1 diagnostics + settings: kds sound, print bar tickets, kds thresholds, **server min app version** display, app version/build.

## 6. Backend additions (Phase 1 prerequisite)
- Close-ticket endpoint: server computes total from DB; validate `tendered ≥ total+tip` (cash), `cash+card = total+tip` (mixto), tip sub-parts sum; reject with 422 `AMOUNT_MISMATCH`. Accept `Idempotency-Key` header; replay returns same closed ticket.
- Allow WAITER to close? Setting `waiter_can_close_ticket` (default true). If false → 403 `PIN_REQUIRED`.
- `/api/v1/health` adds `min_mobile_version` and `server_version`. App blocks with "Actualiza la app" screen when below.
- Socket: authenticate on `connect` (auth token in handshake), drop per-join token (SEC-05).
- Reports endpoints accept `date_from/date_to`; verify roles allow MANAGER for sales today (frontend restricts to ADMIN, backend allows MANAGER — keep backend).

## 7. Production (Phase 0)
- Release keystore generated once, stored outside repo, path via env `BOLA8_KEYSTORE`; script fails if absent. `versionCode` = build number from `app.config.ts`; `version` single source = `app.config.ts`, `package.json` synced by script.
- Update path: Sistema + Yo show version; health `min_mobile_version` gate; APK served from the bar machine at `/mobile/latest.apk` via nginx (static) with QR on the web `/manager/settings` page.
- CI: GitHub Actions `mobile.yml` → `npm ci`, `tsc --noEmit`, `jest`. Contract/Maestro stay local.
- Delete B1 legacy path (server always has idempotency), `PendingScreen`, unused i18n keys, copied `i18n/web` → import from `../frontend/src/i18n` via path alias or a sync script.

## 8. Tap budgets (acceptance)
| Flow | Max taps |
|---|---|
| Open table + 2 items (1 modifier) + send | 7 |
| Serve ready | 2 |
| Cobrar efectivo exacto | 4 (Cobrar · Efectivo · exacto chip · Confirmar) |
| Express 1 item + send | 5 |
| Manager open cash | 3 |
| Owner today's sales | 1 (Resumen) / 2 (Reportes) |

## 9. States every new screen must define
loading skeleton · empty · offline (read-only w/ reason) · error w/ retry · 409 version conflict · 403 PIN. Reuse v1 `SCREEN_STATE_MATRIX` format; add rows for pay, caja, waiting, reportes.

## 10. Phase order
0 Production blockers + backend §6 → 1 Waiter (pay, express, timer, floor density, favourites, alerts, waiting list) → 2 KDS undo/sound + Manager (ticket actions, Caja) → 3 Owner Reportes → 4 polish/copy pass. Each phase: contract tests for new endpoints, unit tests for new models (`payModel`, `cashModel`, `reportsModel`), one Maestro flow per phase, screenshots into `docs/mobile/testing/v2/`.
