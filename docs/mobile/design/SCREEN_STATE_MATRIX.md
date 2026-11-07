# Screen State Matrix

Every screen, every state. Columns per screen (rows here): **Default · Loading · Empty · Error · Offline · Success feedback · Permission-restricted · Validation · Navigation actions · Confirmations / destructive**. Copy is Spanish (tú); English via i18n.

Global rules that apply to all signed-in screens unless overridden:
- **Offline (D7)**: reads from last cache + `OfflineBanner` ("Sin conexión · datos de hace N min"); `ConnectionPill` red; **mutating buttons disabled** with a `helper` line ("Necesitas conexión para enviar"); nothing is queued. Draft order is kept locally.
- **Loading**: `LoadingSkeleton` only when there is no cache; otherwise show cache + 2 dp progress line.
- **Error**: inline `ErrorState` if no data; if data exists, show it + red `banner` ("No pudimos actualizar. Reintentar"). HTTP mapping: network -> offline logic; 401 -> silent refresh once then Login with "Tu sesión expiró"; 403 -> Toast "No tienes permiso para eso"; 409/422 -> screen-specific; 429 -> "Demasiados intentos, espera un momento"; 5xx / HTML body -> generic "El servidor tuvo un problema (código)".
- **Permission**: UI hides what a role can't do (server is still the authority; many endpoints are ungated, so hiding is UX, not security).

---

## SCR-AUTH-00 Splash / session restore
| State | Behaviour |
|---|---|
| Default | Logo + "Restaurando tu sesión…" + progress bar; max 3 s before showing a "Reintentar / Cambiar servidor" row |
| Loading | = default (this is the loading state) |
| Empty | No server URL stored -> go to AUTH-01. No tokens -> AUTH-02 |
| Error | Refresh 401/422 (`USER_INACTIVE`, expired) -> clear tokens -> AUTH-02 with toast "Tu sesión expiró. Entra de nuevo." Server 5xx -> stay with cached user and enter role home in offline mode |
| Offline | Valid stored token + no network -> enter role home from cache with OfflineBanner (no forced login) |
| Success feedback | Immediate route to role home; no toast |
| Permission | Unknown role claim -> SCR-X-01 |
| Validation | n/a |
| Navigation | -> role home (D9) / AUTH-01 / AUTH-02 |
| Destructive | none |

## SCR-AUTH-01 ServerSetup
| State | Behaviour |
|---|---|
| Default | Empty field prefilled `http://` ; Continuar disabled until a successful test; "Probar conexión" secondary |
| Loading | Probar -> button spinner, 5 s timeout, field locked |
| Empty | n/a (first launch is the empty state: helper "Tu gerente te da la dirección") |
| Error | Red result row: "No se pudo conectar. Revisa la dirección y que estés en el WiFi del bar." Specific: timeout, DNS, 404 ("Esa dirección no es un POS Bola 8"), `status != ok`, cleartext blocked (documented Android cleartext config) |
| Offline | Device offline -> "Sin red. Conéctate al WiFi del bar." (Probar disabled) |
| Success feedback | Green row "Conexión exitosa · Servidor responde en 38 ms"; Continuar enabled; haptic Success |
| Permission | n/a |
| Validation | Must match `^https?://host(:port)?$`; trailing slash/`/api/v1` stripped; "Agrega http://" quick-fix; port default 8080 suggested |
| Navigation | Continuar -> AUTH-02. Reached later via "Cambiar" in Login (only when signed out) |
| Destructive | Changing URL while signed in requires Logout first (warn: "Cerrarás sesión") |

## SCR-AUTH-02 Login
| State | Behaviour |
|---|---|
| Default | Server pill (host:port + Cambiar), Usuario, Contraseña (show/hide), Entrar; language toggle |
| Loading | Entrar spinner, fields disabled |
| Empty | n/a |
| Error | 401 `INVALID_CREDENTIALS` -> red row "Usuario o contraseña incorrectos. Revísalos e inténtalo otra vez." field outlines red, password cleared, focus on password. 429 -> "Demasiados intentos. Espera 1 minuto." (login limit is shared by all devices behind nginx — expect it). 5xx -> generic row |
| Offline | Banner "Sin conexión"; Entrar disabled |
| Success feedback | Brief haptic, route by role (no toast) |
| Permission | Inactive user -> same as invalid credentials (server message) ; unknown role -> X-01 |
| Validation | Both fields required ("Escribe tu usuario"); trim username; no client password rules; Entrar disabled while either empty |
| Navigation | Cambiar -> AUTH-01; success -> role home |
| Destructive | none |

## SCR-W-01 Floor
| State | Behaviour |
|---|---|
| Default | Sections Billar (2-col) / Mesas / Barra (3-col) with tile states; summary per section; pool timers tick; tabs |
| Loading | Skeleton tiles (3 sections) first load |
| Empty | No resources: EmptyState "No hay mesas configuradas. Avisa a tu gerente." |
| Error | ErrorState (`kind=server`) with Reintentar if no cache; else banner |
| Offline | Banner + tiles 70 % opacity, timers frozen with "~"; tapping tile opens cached ticket read-only; "Abrir mesa" disabled |
| Success feedback | Toast "Listo: Alitas BBQ 10 pz · T4" [Ver] when my line is READY; tile updates live via `floor:update` |
| Permission | Manager/Admin: same view, tiles open read-only ticket, no "Abrir mesa". No cash session -> amber **"Bar cerrado"** banner under top bar ("La caja está cerrada. Pide a un gerente que abra turno."); Libre tiles stay visible but "Abrir mesa" shows `BAR_CLOSED` message |
| Validation | n/a |
| Navigation | Libre -> W-07 -> W-02; Ocupada/Cuenta -> W-02; Listos tab; Yo tab; toast Ver -> W-02 |
| Destructive | none |

## SCR-W-07 OpenTable (sheet)
| State | Behaviour |
|---|---|
| Default | "Abrir BT2" + optional "Nombre del cliente" + Abrir mesa (56) |
| Loading | Button spinner; sheet not dismissible |
| Empty | n/a |
| Error | 409 `RESOURCE_OCCUPIED` -> Toast "Alguien más ya abrió esta mesa" + refresh floor + open that ticket; 403 `BAR_CLOSED` -> "La caja está cerrada"; 5xx -> inline retry |
| Offline | Abrir mesa disabled ("Necesitas conexión") |
| Success feedback | Success haptic, navigate to W-02 (empty ticket, pool timer starts on server for billar) |
| Permission | Manager/Admin: sheet not offered |
| Validation | Name optional, max 40 chars |
| Navigation | -> W-02; close sheet -> Floor |
| Destructive | none (an accidental empty ticket can be cancelled from W-02: `POST /cancel` allowed only with no items/timer — pool tables start a timer immediately, so for BT tables a confirm mentions "El tiempo empieza al abrir") |

## SCR-W-02 Ticket detail
| State | Behaviour |
|---|---|
| Default | Hero (table, state, timer or total), draft hint bar if draft exists, lines with chips, totals, BottomActionBar (Agregar productos / Pedir cuenta) |
| Loading | Skeleton lines; actions disabled |
| Empty | No lines: EmptyState "Aún no hay productos. Toca Agregar productos." |
| Error | 404/not OPEN (closed from POS) -> ErrorState "Esta cuenta ya no está abierta" + Volver al piso; `TICKET_CLOSED` 403 on add -> same |
| Offline | Cached ticket + banner; Agregar productos still allowed (**builds the draft locally**); Pedir cuenta disabled |
| Success feedback | Line chip changes live (`ticket:item_status`); after Pedir cuenta: Toast "Cuenta solicitada. Avisamos a caja" + state chip -> "Cuenta solicitada"; Success haptic |
| Permission | Manager/Admin: no Agregar productos; long-press line -> Anular (PIN not needed if manager is the user? still ask PIN per D10: server needs `pin`) and Descuento (manager JWT). Waiter long-press -> Anular opens PIN dialog |
| Validation | Pedir cuenta blocked while draft has unsent lines: dialog "Tienes 2 productos por enviar. Envíalos o descártalos primero." |
| Navigation | Agregar productos -> W-03; draft bar -> W-05; back -> Floor; customer name tap -> edit sheet |
| Destructive | **Pedir cuenta** = ConfirmDialog ("¿Pedir la cuenta de BT1? El tiempo de mesa se detiene.") for pool tables (server stops timer and frees the table). **Anular producto** = PinPad then ConfirmDialog (destructive red, "Esto ya se envió a cocina") |

## SCR-W-03 Menu
| State | Behaviour |
|---|---|
| Default | Search, category chips (Todo first), 2-col grid; items in draft show qty badge; BottomActionBar "Revisar pedido (n)" hidden when n=0 |
| Loading | Skeleton grid; chips skeleton |
| Empty | Search no results: "No encontramos \"{q}\"" + Limpiar búsqueda; category empty: "No hay productos aquí" |
| Error | ErrorState retry; if menu cache exists use it (menu changes rarely; refetch on focus) |
| Offline | Menu from cache with banner; sold-out info flagged "podría estar desactualizado"; draft building works |
| Success feedback | Tap adds 1 (no-option items): qty badge pops, `impactLight`, snackbar-free; configurator add closes sheet with badge update |
| Permission | WAITER only (M/A never see it) |
| Validation | Sold-out item tap -> `selectionAsync` + inline "Agotado" tooltip (no navigation) |
| Navigation | Item with options -> W-04; Revisar pedido -> W-05; back -> W-02 (draft kept) |
| Destructive | Back with non-empty draft: **no dialog** (draft persists; D5), hint bar on W-02 reminds |

## SCR-W-04 ItemConfigurator (sheet)
| State | Behaviour |
|---|---|
| Default | Item, price, groups (mandatory first), notes, stepper, CTA "Agregar al pedido" |
| Loading | Groups skeleton (usually cached, instant) |
| Empty | Item without groups: sheet shows only notes + qty |
| Error | Modifier data failed to load -> "No pudimos cargar las opciones" + Reintentar; CTA disabled |
| Offline | Works from cache |
| Success feedback | Sheet closes, qty badge on tile, `impactLight` |
| Permission | n/a |
| Validation | Mandatory group below `min` -> red helper "Elige al menos 1" + CTA disabled (explain why in `helper`); at `max` others disabled with hint; qty 1–99; note max 120 chars. Mirrors server `FLAVOR_REQUIRED` (422) |
| Navigation | Close (X / back / scrim) discards sheet changes |
| Destructive | Close with changes -> none (cheap to redo) |

## SCR-W-05 DraftReview ("Pedido por enviar")
| State | Behaviour |
|---|---|
| Default | Lines PENDING with stepper, subtotal **estimado**, button "Enviar (n)" |
| Loading | **Sending**: per-line chips Enviando…, button spinner+disabled (D6), sheet not dismissible except back = "Seguirá enviando" |
| Empty | "Tu pedido está vacío" + Agregar productos |
| Error | Per-line **No se envió** + Reintentar (same Idempotency-Key); banner "1 producto no se envió. Revisa la conexión y reintenta."; 422 `OUT_OF_STOCK` -> line chip "Agotado" + shortage text, line must be removed/edited; 422 `FLAVOR_REQUIRED` -> line returns to configurator; 403 `TICKET_CLOSED` -> ErrorState "Esta cuenta ya no está abierta", draft kept for copy-over; 409 `VERSION_CONFLICT` -> silent refetch + retry once |
| Offline | Enviar disabled: helper "Sin conexión. Tu pedido se guarda aquí y se envía cuando vuelva." Network loss *during* send -> lines in flight become FAILED/unknown; on reconnect "Reintentar" resends same keys (dedupe by B1; without B1: refetch ticket and compare before resend — see recovery flow) |
| Success feedback | All lines **Enviado** (green) -> Success haptic -> Toast "Pedido enviado a cocina y barra" -> auto-return to W-02 after 1.2 s; draft cleared |
| Permission | WAITER only |
| Validation | Qty 1–99; removing last line -> empty state; no sending with 0 lines |
| Navigation | Back -> Menu (draft kept); success -> Ticket |
| Destructive | **Descartar pedido** (overflow) -> ConfirmDialog "¿Descartar 4 productos sin enviar?"; removing a PENDING line = swipe/button with undo snackbar (no dialog) |

## SCR-W-06 Ready (Listos)
| State | Behaviour |
|---|---|
| Default | Cards per ticket (oldest ready first); each line "Marcar servido"; "Servir todo (n)" on multi-line cards; tab badge = count |
| Loading | Skeleton cards |
| Empty | "Nada por servir. Tus pedidos listos aparecen aquí." |
| Error | ErrorState/banner; failed PATCH on a line -> line shake + Toast "No se pudo marcar. Reintenta." (line stays) |
| Offline | Cached list, buttons disabled ("Necesitas conexión") — marking served is a mutation (not queued) |
| Success feedback | Row slides out (fade), `Success` haptic, Toast-free; badge decrements |
| Permission | WAITER only; shows only lines of tickets I opened (`opened_by`). Managers have no Listos tab |
| Validation | Line already served elsewhere (409/no-op) -> row disappears silently |
| Navigation | Tap card header -> W-02; toast Ver (from anywhere) -> W-02 |
| Destructive | "Servir todo (n)" has no confirm dialog (low risk, same as n single taps) but the label always states the count; there is no undo endpoint, so no undo toast |

## SCR-OV-01 Manager PIN dialog
| State | Behaviour |
|---|---|
| Default | 4 dots, keypad, Cancelar/Confirmar(disabled until 4) |
| Loading | Dots filled, keypad disabled, spinner on Confirmar |
| Empty | n/a |
| Error | 400 `{valid:false}` -> shake, clear, "PIN incorrecto"; 429 -> "Demasiados intentos, espera 1 minuto" + countdown, keypad disabled |
| Offline | Confirmar disabled ("Necesitas conexión") |
| Success feedback | Dialog closes, protected action proceeds, haptic Success; manager name shown in the follow-up confirm ("Autorizado por Rodrigo V.") |
| Permission | If current user is MANAGER/ADMIN the dialog still asks (server needs `pin` for void/qty-decrease) |
| Validation | Digits only, length 4–6 (accept 6 if server PINs are longer — confirm in contract test) |
| Navigation | Cancelar/back/outside -> close, no action |
| Destructive | The PIN guards the destructive action; the following ConfirmDialog is `destructive` |

## SCR-K-01 KDS queue
| State | Behaviour |
|---|---|
| Default | Header: station, seg switch (M/A only), counts, pill, sound icon; cards oldest-first; age colours; whole-row tap advances one step; "Todo listo" per ticket |
| Loading | KDS skeleton (3 cards) |
| Empty | Large check icon "Sin pedidos pendientes" + last update time (stays awake, still live) |
| Error | Red banner "No se pudo actualizar" + last good data; item advance failure -> row red outline + Toast, state rolled back |
| Offline | Banner + pill red; **advance disabled** (rows dim) to prevent diverging state; data frozen with last-updated clock; auto-resync on reconnect, then banner "Conectado de nuevo" |
| Success feedback | Row stripe/state changes instantly (optimistic), `impactMedium`; READY row shows undo toast 3 s; new ticket: `Warning` haptic + optional sound + card fades in at its age position |
| Permission | KITCHEN_STAFF locked to kitchen, BAR_STAFF to bar; no switch. Other roles reach K-01 only via manager tab. Voided lines never shown (server fix B3) |
| Validation | Client enforces SENT -> IN_PROGRESS -> READY single steps (server doesn't); double-tap ignored while request in flight |
| Navigation | Station switch (M/A); Yo/exit via long-press top-left logo or menu (prevents accidental exit); hardware back = ignored on KDS root |
| Destructive | **Todo listo** advances every non-ready line: if any line is still SENT show ConfirmDialog "¿Marcar todo como listo? 1 producto aún no empieza." ; otherwise no dialog |

## SCR-M-01 Ops overview
| State | Behaviour |
|---|---|
| Default | Caja card (Abierta/Cerrada + since + fondo), tiles (tickets abiertos, cuentas solicitadas, cocina pend., barra pend.), oldest item (age badge), alerts list |
| Loading | `stats` skeleton |
| Empty | Caja cerrada: card warning "Caja cerrada · No hay turno abierto"; tiles show 0; alerts "Sin alertas" |
| Error | Per-tile "—" when its endpoint failed + banner; never show 0 for unknown |
| Offline | Cached values + banner with "datos de hace N min"; tiles 70 % opacity |
| Success feedback | Live tick via sockets (`floor`, `kitchen`, `bar`) with 200 ms value flash |
| Permission | MANAGER/ADMIN only; waiter/kitchen deep link -> X-01. `/tickets/open-all` is MGR-only (403 -> tile "—") |
| Validation | n/a |
| Navigation | Tile -> M-02 (filtered) / K-01 station; alert -> relevant ticket W-02; tabs |
| Destructive | none (v1 read-only; cash open/close stays on POS) |

## SCR-M-02 Open tickets
| State | Behaviour |
|---|---|
| Default | Rows: code, customer, opened-at/age, item count, total (server), cuenta chip; filter chips Todos / Cuenta solicitada |
| Loading | list skeleton |
| Empty | "No hay tickets abiertos" |
| Error | ErrorState retry |
| Offline | cached + banner |
| Success feedback | Live updates; pull-to-refresh |
| Permission | M/A |
| Validation | n/a |
| Navigation | Row -> W-02 read mode (manager actions) |
| Destructive | via W-02 only (anular with PIN, descuento with confirm) |

## SCR-A-01 System (diagnostics + settings)
| State | Behaviour |
|---|---|
| Default | Connection block, account/app block, settings toggles, actions |
| Loading | Health row "Probando…" spinner; other rows static |
| Empty | n/a |
| Error | Health fail: red "Sin respuesta" + last OK time; socket down: "Desconectado · reintentando en 8 s" |
| Offline | Shows local info; server rows "—" |
| Success feedback | Probar conexión -> green row + Success haptic; Copiar datos -> Toast "Copiado" |
| Permission | ADMIN only (tab hidden otherwise; deep link -> X-01). Toggles are local, except `kds_sound_enabled` (server key, MGR+) |
| Validation | n/a |
| Navigation | Back via tabs; Cambiar servidor (requires logout) |
| Destructive | **Cerrar sesión** (also in Yo): ConfirmDialog "¿Cerrar sesión? Se borrará tu pedido sin enviar en este equipo." (only if draft exists; otherwise plain confirm); logout calls `/auth/logout`, wipes tokens + drafts of that user |

## SCR-X-01 AccessDenied / SCR-X-02 GenericError
| State | Behaviour |
|---|---|
| Default | X-01: shield icon, "Esta sección no es para tu rol", [Ir a mi pantalla] [Cerrar sesión]. X-02: alert icon, title, message, code + time, [Reintentar] [Ver detalles] |
| Loading | Reintentar spinner |
| Empty | n/a |
| Error | X-02 repeated failure -> suggest "Avisa a tu gerente" |
| Offline | X-02 `network` kind -> offline copy "Sin conexión" |
| Success feedback | Reintentar OK -> returns to origin route |
| Permission | X-01 *is* the permission state; also shown for 403 on a whole-screen load |
| Validation | n/a |
| Navigation | Ir a mi pantalla -> role home (D9); Ver detalles -> sheet (admin: raw status/body) |
| Destructive | Cerrar sesión -> ConfirmDialog |

## Global: connection / offline layer
| State | Behaviour |
|---|---|
| Online | Pill green; no banner |
| Reconnecting | Pill amber pulsing; after 3 s without link show banner "Reconectando…" |
| Offline | Pill red; banner "Sin conexión · datos de hace N min"; mutation buttons disabled; Warning haptic once |
| Recovery | Socket reconnect -> refetch all active queries + rejoin rooms; banner green "Conectado de nuevo" 2 s; draft Send/Retry re-enabled |
| Auth expiry while offline | Keep cached screens; on reconnect refresh token silently; if fails -> Login |
