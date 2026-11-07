# Design Decisions

Each decision: what, why, trade-off, and what would change it. IDs `D-n` (design) are separate from project decisions `D1–D13` in [PROJECT_STATE.md](../PROJECT_STATE.md).

## D-1 Local draft + explicit **Enviar** (implements D5/D6)
The server creates every line as SENT (kitchen sees it immediately, inventory consumed — rule E.58). A waiter taking an order table-side needs to compose, fix, and *then* commit. So the phone keeps a persisted local draft per ticket and a single explicit "Enviar (n)" button.
- *Why not send-on-tap*: every mis-tap would hit the kitchen and need a PIN-protected void.
- *Safety nets*: per-line `Idempotency-Key`, button disabled while in flight, per-line status (Por enviar / Enviando… / Enviado / No se envió), draft survives app kill, "n productos por enviar" bar on the ticket so unsent food is never forgotten. Pedir cuenta is blocked while unsent lines exist.
- *Trade-off*: one extra tap per order. Offset by "Revisar pedido (n)" always one thumb-reach away.

## D-2 Bottom action bar for the primary action
Primary actions (Agregar productos, Enviar, Agregar al pedido) are pinned to the bottom 80 dp, 56 dp tall, over the gesture area's safe inset. One-handed, thumb zone, consistent muscle memory; top bars only hold navigation and status. Two buttons max; destructive never primary. When disabled it explains why in a helper line (offline, empty, validation) instead of silently greying out.

## D-3 No floor-plan map
Floor is a **grouped grid** (Billar / Mesas / Barra), not the physical layout.
- Bar has 6 + 8 + 6 resources; a scaled map on a 6" phone yields tiles < 48 dp and needs pan/zoom (fat-finger errors, two-hand use).
- No layout/coordinates exist in the API (`/resources` has `sort_order`, no x/y); building a map editor is scope creep.
- Waiters already know where T4 is; they need *state + name + timer*, in code order, glanceable. Grouping matches how they think (pool vs tables vs bar).
- Revisit if the owner supplies coordinates and asks; the TableCard component is layout-agnostic.

## D-4 KDS: tap-to-advance, not swipe
Whole item row is the target; one tap = one step (SENT → IN_PROGRESS → READY). Swipe was rejected: greasy/wet fingers drag unreliably, swipes conflict with scrolling a long queue, they're not discoverable, they have no accessibility equivalent, and a half-swipe is an ambiguous state. Tap has a visible next-action label ("Iniciar" / "Listo"), 64 dp row, haptic confirmation, 3 s undo on READY. Client enforces single-step order because the server accepts any transition (rule E.72, G5). "Todo listo" is separate and confirms if some lines haven't started.

## D-5 Dark theme only (no light mode in v1)
Bars are dark; a white screen at a waiter's hip lights their face and the room, is glare-heavy on a KDS, and burns OLED power. Palette is the web POS's slate/sky so it feels like the same product. Consequence: no theming system, half the QA, contrast verified once (DESIGN_SYSTEM §1.7). Light mode is a token swap later if requested.

## D-6 Spanish copy tone: "tú", short, imperative, operational
Staff are young, informal, in a hurry: "Agregar productos", "Pedir cuenta", "Revisa tu pedido", "Pídele a un gerente…". No "usted", no corporate hedging, no exclamation marks, no emojis. Errors say what happened + what to do ("Sin conexión. Tu pedido se guarda aquí y se envía cuando vuelva."). Mexican Spanish terms: *cuenta* (not factura), *mesero*, *gerente*, *cocina/barra*, "Enviar a cocina". Money `$1,145.00` (es-MX), 24 h clock. English toggle covers the same keys; ES is default and the fallback (matches web i18n).

## D-7 Status = colour + icon + word, always
Dim bars + 8 % of men colour-blind + cheap panels: colour is redundant everywhere. Table tiles, item chips, age badges, connection pill all carry an icon and a word. KDS age is additionally ordered by position (oldest first).

## D-8 Black-ish but not black: surface stepping instead of shadows
`#020617` canvas, `#0f172a` bars, `#1e293b` cards. Gives depth without shadows (which vanish on dark). Pure `#000` is reserved for scrims. Text never pure white except on red/age-alert fills.

## D-9 Sky `#0ea5e9` fill with **dark** label text
White on `#0ea5e9` is 2.8:1 (fails AA). Dark `#020617` on it is 7.28:1. Primary buttons therefore have dark text — unusual but correct and more readable in glare. Pressed state is lighter (`#38bdf8`) because darkening on a dark UI loses the feedback.

## D-10 KDS age thresholds are tokens, not constants
`kds.warnAfterMin = 10`, `alertAfterMin = 20` live in `tokens.json`; later move to a server setting (`kds_age_warn_min`) without UI changes. Age = oldest not-READY item's time since `sent_at`, with server clock offset correction (device clocks drift; a phone 3 min fast would show false red).

## D-11 Timer and totals are **estimates** on the phone (implements D3)
Pool time on Ticket is labelled "estimado" in warning colour with ≈; the footnote says the server computes the final amount. Draft subtotal is "Subtotal estimado". Server `total_cents` is the only figure presented without a qualifier. Prevents a waiter quoting a client a number the POS later contradicts (rule D.56).

## D-12 Offline: read-only, never queue (implements D7)
Reads show cache + banner; every mutation button disables with a reason. Only the *draft* is local (and it is explicit, visible state, not a hidden queue). Rationale: queued mutations replayed minutes later (voids, close requests) are dangerous in a bar with no idempotency server-side. KDS advance is also disabled offline so two screens never diverge silently.

## D-13 Ready alerts: toast + persistent list + badge
A toast alone is lost if the waiter is mid-carry. Three layers: transient toast (with "Ver"), Listos tab badge (count), Listos list (source of truth, oldest first). Toasts coalesce ("3 productos listos") to avoid spamming during a rush. Sound/vibration user-configurable.

## D-14 Accessibility gate is automated
`check-contrast.mjs` (next to `tokens.json`) recomputes every text pair from the tokens and fails below 4.5:1 (3:1 for ≥ 24 dp); run it in CI/pre-commit when `tokens.json` changes. Keeps §1.7 honest.

## D-15 Manager PIN UX: dedicated keypad, not the system keyboard
`POST /auth/verify-pin` (5/min per IP, shared across all devices behind nginx!) and void with `pin`. A dot-only keypad avoids keyboard pop (hides half the screen), avoids IME suggestion/leak, and is faster to type with wet hands. We design for lock-out: after 429 the pad shows a countdown. The PIN is held in memory only for the one request.

## D-16 Waiter vs manager capability by hiding, not just disabling
Server permissions are loose (G-series gaps), so the app enforces *intent* in UX: waiters never see discount or edit-payment; managers don't see Agregar productos in v1; K/B users are locked to one station. This is UX, not security — documented so nobody mistakes hiding for protection.

## D-17 No payment settlement (implements D4)
"Pedir cuenta" only; no tender/tip/close UI. Keeps the mobile app low-risk and the screens small. The ticket shows state "Cuenta solicitada" so cashier + waiter stay in sync.

## D-18 KDS is single-screen, kiosk-ish
No tab bar, back ignored, keep-awake, orientation free. Exit via menu (hold logo 1 s). Prevents a cook accidentally leaving the queue and missing tickets. Landscape shows 3 columns (286 dp cards) for a propped phone/tablet; portrait shows 1 column with larger rows.

## D-19 Floor tile density: 2 columns for billar, 3 for mesas/barra
Pool tables need the live timer (20 dp bold) so they get width; tables/bar need only code + state + name. Whole floor (20 resources) fits in ~1 screen + a short scroll; state labels shortened on tiles ("Cuenta") with the long form in the legend/a11y label.

## D-20 Prototype is static HTML generated from `tokens.json`
`prototypes/_build.mjs` emits one page per screen with CSS variables generated from the tokens, so palette edits propagate and the prototype can't drift from the spec. No external CDN, system fonts, inline SVG icons (stand-ins for MaterialCommunityIcons). Screenshots via headless Edge (`sh shoot.sh`).

## Open questions for product/engineering (not blocking)
1. `GET /resources` for a pool table after *request-payment* returns AVAILABLE with an OPEN ticket — confirm `active_ticket_id`/`payment_requested` is present so Floor can show "Cuenta solicitada" (contract test).
2. Is the manager PIN 4 or 6 digits? PinPad supports `length`.
3. Ready filtering by `opened_by` needs B2 (payload) or a join to `GET /tickets`; confirm B2 lands before the Listos screen.
4. Local notifications when the app is backgrounded depend on the socket staying alive on Android (foreground service) — decide in architecture (no FCM in scope).
5. Menu images: none in the API; tiles are text-only by design (faster to scan). Revisit if the owner adds photos.
