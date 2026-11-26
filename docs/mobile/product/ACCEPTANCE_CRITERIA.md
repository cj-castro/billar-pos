# Acceptance Criteria

G = Given, W = When, T = Then. All P0 stories; a few cheap P1. "B1 absent" = backend extension not deployed (feature-detected). Negative cases marked **(neg)**. Messages are Spanish in-app; English here for brevity.

## Cross-cutting

**US-X-01 Server URL + health**
- G first launch (no stored URL) W app opens T SETUP screen is shown; no login possible.
- G user types `192.168.1.50:8080` W taps Connect T app normalises to `http://192.168.1.50:8080`, calls `GET /api/v1/health`, on `{"status":"ok"}` stores URL and goes to LOGIN.
- **(neg)** G host unreachable/timeout (>5 s) W Connect T "No se pudo conectar" with hint (same Wi-Fi? port 8080?), URL not stored.
- **(neg)** G host answers 200 but not `{"status":"ok"}` (e.g. a router page) T rejected as "not a POS server".
- **(neg)** G invalid text (empty, spaces, no host) T inline validation, no request.

**US-X-02 Change server**
- G on LOGIN W tapping "Cambiar servidor" T SETUP opens prefilled; saving a new valid URL clears tokens and caches.
- G unsent draft exists W URL changes T app warns drafts belong to the old server and keeps them keyed by server+user.

**US-X-03 Login**
- G valid creds W submit T `POST /auth/login` 200; tokens saved in SecureStore (never AsyncStorage/logs); user from response; navigates to role home (US-X-05).
- **(neg)** 401 `INVALID_CREDENTIALS` T "Usuario o contraseña incorrectos", password field cleared, no lockout assumed.
- **(neg)** 429 (login 10/min is one shared bucket for all phones, N1) T "Demasiados intentos, espera 1 minuto" with countdown; no auto-retry loop.
- **(neg)** network failure T "Sin conexión con el servidor" and does not clear typed username.
- G submit tapped twice quickly T only one request in flight (button disabled).

**US-X-04 Session restore + refresh**
- G stored tokens, app cold start W server reachable T app calls `GET /auth/me`; success -> role home without LOGIN.
- G any API call returns 401 (expired access) W refresh available T exactly one `POST /auth/refresh` (single-flight even with N concurrent calls), then original calls retry once.
- **(neg)** refresh returns 401/422 or `USER_INACTIVE` T tokens wiped, LOGIN shown with "Sesión expirada"; unsent drafts preserved.
- **(neg)** G app cold start with no network T last-known role home loads from cache with offline banner (US-X-06); no forced logout.
- G role changed server-side (G25) W next refresh T role claim re-read; if home screen differs, app re-routes.

**US-X-05 Role entry**
- G role WAITER -> FLOOR; KITCHEN_STAFF -> KDS(kitchen); BAR_STAFF -> KDS(bar); MANAGER and ADMIN -> OPS.
- **(neg)** role string not in set T DENIED screen with logout button; no API calls beyond `/auth/me`.
- **(neg 403)** G any call returns 403 `FORBIDDEN`/`MANAGER_REQUIRED` T inline "No tienes permiso", state unchanged, no logout.
- G KITCHEN_STAFF W navigates T cannot reach OPS or FLOOR actions (UX gate; not security, see G5).

**US-X-06 Connection indicator / offline**
- G socket connected T green dot in header. G disconnected T amber/red chip "Sin conexión".
- G offline W viewing FLOOR/TICKET/MENU T last cached data shown with "Actualizado hace N min" banner.
- **(neg)** G offline W tapping any mutating action (open table, Send, served, request bill, cancel, KDS advance) T action disabled/blocked with message; nothing queued (D7).
- G connection restored T banner clears and active queries refetch within 3 s.

**US-X-07 Logout**
- G logged in W Logout T `POST /auth/logout` called best-effort; SecureStore tokens, query cache, socket and room joins cleared; LOGIN shown.
- **(neg)** G logout call fails (offline) T local logout still completes.
- G unsent draft exists W Logout T confirmation "Tienes pedidos sin enviar"; drafts retained keyed by user+ticket.

**US-X-08 Spanish default**
- G fresh install T all strings Spanish; no raw keys, no English leaking from server `message` (server messages mapped by `error` code; unknown codes -> generic Spanish).

**US-X-09 (P1) English toggle**
- G toggle to EN T all screens switch immediately and choice persists across restart.

**US-X-10 Reconnect/refresh**
- G Wi-Fi drops 30 s then returns T socket reconnects, re-joins role rooms and open `ticket:<id>` rooms, and all visible queries refetch.
- G app backgrounded > 30 s then foregrounded T refetch visible screen and reconnect if needed.

**US-X-11 Error handling**
- G response is HTML (404/500), `{"msg":...}` (JWT lib), `{"error":"Forbidden"}`, `{"valid":false}` or empty body T mapped to a typed error and a Spanish message; never `JSON.parse` exception surfaced.
- G 413 or 5xx T "Error del servidor", with Reintentar for reads only.

## Waiter

**US-W-01 Floor**
- G open session W FLOOR loads T `GET /resources` grouped POOL / REGULAR / BAR sorted by `sort_order` then `code`; each card shows code, status, customer name (if any), timer start time (pool), bill-requested chip.
- G `floor:update` socket event T list refetches in <=2 s.
- **(neg)** INACTIVE resources not shown.
- **(neg)** G empty list T empty-state text, not blank screen.

**US-W-02 Bar closed**
- G `GET /cash/status` `open:false` T banner "Bar cerrado: pide a un gerente abrir caja"; Open-table buttons disabled.
- **(neg)** G status stale (cached) and server actually closed W open table T server 403 `BAR_CLOSED` is shown with the same banner and no ticket created.

**US-W-03 Open table**
- G table AVAILABLE and bar open W tap Abrir T `POST /tickets {resource_id, ticket_type:"TABLE"}` -> 201; navigate to TICKET.
- G POOL table T timer starts server-side; ticket shows the timer start.
- **(neg)** 409 `RESOURCE_OCCUPIED` T "Mesa ocupada" and floor refetches; if `active_ticket_id` is returned the app offers "Abrir ticket existente".
- **(neg)** 403 `BAR_CLOSED` T banner (US-W-02).
- **(neg duplicate tap)** double tap T one request; if a second hits the server it gets 409 and the app resolves to the existing ticket.
- **(neg)** network loss mid-request T unknown outcome: app refetches floor; if table now has a ticket opened by this user, opens it; otherwise offers retry.

**US-W-04 Ticket detail**
- G OPEN ticket T lines show qty, name, modifiers, notes, `net_cents` price, status chip (SENT/IN_PROGRESS/READY/SERVED/VOIDED); VOIDED lines struck through; totals (subtotal, discount, pool, total) are server values only.
- G pool ticket T timer shown as "Estimado" with ticking elapsed; labelled non-final; never added into the total locally.
- G `ticket:updated` or `ticket:item_status` T refetch within 2 s.
- **(neg)** CLOSED/CANCELLED ticket T read-only, all mutation controls hidden.
- **(neg)** `GET` 404 (HTML) T "Ticket no encontrado" and back to floor.

**US-W-05 Menu**
- G categories load T tabs ordered by `sort_order`; items filtered by category; search filters cached items case/diacritic-insensitively by name.
- **(neg)** G offline T cached menu usable for drafting; Send is blocked.
- G inactive items T hidden.

**US-W-06 Modifiers**
- G item has mandatory group T Add stays disabled until the group's `min_selections` (>=1 if mandatory) are chosen.
- G `max_selections` reached or `allow_multiple=false` T further options in group are disabled.
- **(neg FLAVOR_REQUIRED)** G a stale client lets an incomplete item through W Send T server 422 `FLAVOR_REQUIRED`; the line stays in draft flagged "Falta elegir sabor" and does not block other lines.
- Modifier price deltas displayed per line as an estimate; server price after send is authoritative.

**US-W-07 Quantity + notes**
- G quantity stepper T bounded 1-99. **(neg)** Typing 0/100 clamped.
- G note up to 200 chars (client limit) sent as `notes`.
- **(neg)** server 422 `INVALID_QUANTITY` T line flagged, not dropped.
- G line already sent T note not editable (server sets notes at add only, BR §E.80).

**US-W-08 Draft + Send**
- G items added T stored in local draft (persisted across app kill); nothing is sent to the server; kitchen sees nothing.
- G Send tapped T each draft line is posted sequentially with its own `Idempotency-Key` (UUID created when the line was added); Send button disabled until all calls resolve; header `X-Ticket-Version` optional.
- G all 201 T draft emptied, ticket refetched, lines show SENT.
- **(neg duplicate tap)** double tap Send T one in-flight batch only.
- **(neg network loss mid-send)** G line 2 of 4 gets no response T lines 1 sent, 2 unknown, 3-4 not attempted; UI shows per-line state (enviado / pendiente / incierto). Retry resends only non-confirmed lines with the **same** keys. With B1 the server returns the existing line (200) so no duplicate. **B1 absent:** app refetches the ticket first and shows "Revisa antes de reenviar" for uncertain lines; user decides; no automatic resend.
- **(neg OUT_OF_STOCK)** 422 `OUT_OF_STOCK` with `shortages[]` T that line stays in draft marked "Agotado: <insumo>"; other lines continue; user can remove or edit.
- **(neg TICKET_CLOSED)** 403 T Send halts, draft kept, message "El ticket ya fue cerrado".
- **(neg 401)** mid-send T one refresh then resume; if refresh fails T draft preserved, LOGIN shown, resume after login.
- **(neg VERSION_CONFLICT)** 409 T refetch ticket, retry once with the new version.
- **(neg 403 role)** not expected; shown as generic no-permission, draft kept.
- G B1 present T response includes `ticket_version`; app uses it, no extra refetch.

**US-W-09 Ready notification**
- G item on a ticket opened by me turns READY T within 3 s an in-app banner "Mesa B3: 2x Alitas listo" appears with vibration, on any screen; tapping goes to that ticket.
- **(neg)** item ready on someone else's ticket T no banner (filtered by `opened_by`, B2). B2 absent: filter using locally refetched own-ticket diff.
- **(neg)** G app backgrounded T no push (out of scope); on foreground, the app lists items that became READY since last seen.
- **(neg)** duplicate socket delivery T notified once per item+status.
- **(neg)** G socket down T banner of connection state (US-X-06), and READY state still appears on next refetch.

**US-W-10 Mark served**
- G line READY W tap Servido T `PATCH /queue/<id>/status {SERVED}` -> chip SERVED.
- **(neg)** line not READY T control hidden (client-enforced).
- **(neg B3)** line VOIDED meanwhile T 409 `ITEM_VOIDED` handled: refetch, "Este producto fue anulado". B3 absent: client filters VOIDED lines.
- **(neg duplicate tap)** one request; idempotent status.

**US-W-11 Request bill**
- G ticket has >=1 non-voided line W Pedir cuenta T confirm dialog (pool table: "se detendrá el cronómetro y la mesa quedará libre"); on confirm `POST /tickets/<id>/request-payment` -> `{ok,total_cents}`; ticket shows total and "Cuenta pedida".
- **(neg)** ticket with no lines/time T action disabled with reason.
- **(neg)** 409 (already requested/closed) T refetch and show current state.
- **(neg)** network loss mid-send T refetch ticket; if `payment_requested` is true treat as success.
- No payment/close controls exist anywhere in the app (D4).

**US-W-12 Cancel empty**
- G ticket has zero non-voided lines and no timer W Cancelar mesa (confirm) T `POST /tickets/<id>/cancel` -> floor shows table AVAILABLE.
- **(neg)** 422 `HAS_ITEMS` T "Ya tiene productos".
- **(neg)** 422 `HAS_POOL_TIME` T "Mesa de billar con tiempo: pide a un gerente".

## Kitchen / Bar

**US-K-01 Queue**
- G KITCHEN_STAFF T `GET /queue/kitchen`; BAR_STAFF T `/queue/bar`; items grouped by ticket (resource code, opened-by), ordered by oldest `sent_at`.
- **(neg)** empty queue T "Sin pedidos" state.
- **(neg)** items on non-OPEN tickets never appear (server filter).

**US-K-02 Age colours**
- G item age = now (server-time-corrected) - `sent_at` T <5 min green, 5-10 amber, >=10 red (unit-tested boundaries 4:59/5:00/9:59/10:00).
- **(neg)** device clock skew > 2 min vs server `Date` header T compute from skew-corrected clock.

**US-K-03 Notes/modifiers**
- G item has notes or modifiers T rendered at same size as item name, notes highlighted; qty shown large.

**US-K-04 Advance status**
- G SENT W tap Empezar T `PATCH status IN_PROGRESS`; then Listo -> READY; then Entregado/bump -> SERVED.
- **(neg)** skipping steps not possible in UI (SENT cannot go straight to READY).
- **(neg duplicate tap)** one request in flight per item; controls disabled until response.
- **(neg)** failed request (network) T item reverts to prior status with toast; no optimistic state kept after failure.
- **(neg B3)** item VOIDED just now T 409 `ITEM_VOIDED` -> item removed from list.
- **(neg 401)** one refresh then retry.
- **(neg)** another device advanced the item first T socket/refetch shows new status; stale tap yields no regression (client sends only forward transitions).

**US-K-05 Live updates**
- G waiter sends an item T appears on KDS in <=3 s via `kitchen:update`/`bar:update`.
- G item voided at POS (no socket event, G12) T disappears within 15 s via poll.
- **(neg)** reconnect T full refetch.

**US-K-06 Stale warning**
- G socket disconnected > 30 s T full-width red banner "Sin conexión: la lista puede estar desactualizada" and advance buttons disabled; poll continues if HTTP works.

## Manager / Admin

**US-M-01 Ops overview**
- G MANAGER W OPS loads T shows cash session open/closed (`/cash/status`), open ticket count and list (`/tickets/open-all`: code, customer, age, item_count, total), kitchen/bar counts (`/queue/counts`), oldest waiting item age (min `sent_at` across `/queue/kitchen` + `/queue/bar`).
- **(neg 403)** G WAITER token (mis-routed) T `open-all` 403 handled; OPS not reachable by UX gate.
- **(neg)** one of the calls fails T that card shows error/stale, others still render.
- **(neg)** cash closed T prominent "Caja cerrada" and zero open tickets is not shown as healthy "all clear".

**US-M-02 Pending payment**
- G `GET /tickets/pending-payment` has entries T listed with table code, total, wait time since `payment_requested_at`; tapping opens ticket.

**US-M-03 Open any ticket**
- G manager opens ticket T same TICKET screen; waiter actions available (P0 set); no payment/close controls.

**US-A-01 Diagnostics**
- G ADMIN T DIAG shows server URL, last `/health` result + latency, socket connected/id/rooms joined, app version/build, username/role, last successful sync timestamp, last error code.
- **(neg)** no tokens or passwords displayed; copy-to-clipboard of diagnostics excludes secrets.
- **(neg)** non-ADMIN cannot see DIAG.

**US-A-04** Admin sees all of OPS (US-M-01..03) unchanged.

## P1 (cheap ones)

**US-W-13 Void item**
- G line SENT W Anular T PIN sheet; `DELETE .../items/<id> {pin, reason}` -> line VOIDED.
- **(neg)** 401 `INVALID_PIN` T "PIN incorrecto"; sheet stays open. 5 attempts/min shared limit: 429 shown as wait message (N1).
- **(neg)** 409 `ALREADY_VOIDED` T refetch, no error loop.
- G line IN_PROGRESS/READY T extra warning "cocina ya la preparó" (G12 kitchen isn't told).

**US-W-15 Discount**
- G role MANAGER/ADMIN only sees control. **(neg)** server 403 `FORBIDDEN` for other roles T message. `pct` 0-100 validated client-side.

**US-W-16 Transfer**
- G picker lists only AVAILABLE tables. **(neg)** 409 `RESOURCE_OCCUPIED` T refetch, message.

**US-K-07 Sound**
- G `kds_sound_enabled=false` T silent; true T sound/vibration only for new items for this station.
