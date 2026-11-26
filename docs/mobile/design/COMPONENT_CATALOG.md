# Component Catalog

React Native components (Expo). All styling comes from `tokens.json` via the `theme` module ([DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)). Components are presentational: data fetching/mutations live in screens/hooks. Money props are **integer cents** (format with the shared `formatMXN`). Every component takes `testID` and forwards `accessibilityLabel`.

Conventions: `i18n` keys not literals; `state` props are exhaustive unions so screens can't invent states; minimum target sizes per design system §4.

## Index

| Group | Components |
|---|---|
| Actions | AppButton, QuantityStepper, BottomActionBar, IconButton |
| Status & feedback | StatusChip, ConnectionPill, OfflineBanner, Toast, ConfirmDialog, PinPad, LoadingSkeleton, EmptyState, ErrorState |
| Floor / ticket | TableCard, TicketLine, StatTile |
| Menu / order | MenuItemTile, ModifierGroup, DraftLineRow |
| KDS | KdsTicketCard, KdsAgeBadge, KdsItemRow |
| Layout | ScreenScaffold, TopBar, TabBar |

---

## AppButton
Primary interactive control.

| Prop | Type | Notes |
|---|---|---|
| `label` | `string` | Required |
| `onPress` | `() => void` | |
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger' \| 'dangerOutline' \| 'success'` | `primary` = `primary` fill + `textOnAccent`; `secondary` = raised + 1.5 dp `textMuted` outline; `danger` = `danger` + white; `success` = `success` + `successTint` text (Marcar servido) |
| `size` | `'md' (48) \| 'lg' (56, default for waiter primary actions)` | |
| `icon?` | MCI name | Left of label |
| `loading?` | `boolean` | Spinner replaces icon, label stays, **disables press** (idempotency D6) |
| `disabled?` | `boolean` | `surfaceRaised` + `textDisabled`; still focusable, announces "no disponible" |
| `fullWidth?` | `boolean` | |

States: default, pressed (`primaryPressed` lighter / opacity .85 for others), focus (2 dp `focusRing`), loading, disabled. Haptic: none by default (caller decides). Never place two `primary` buttons in one view.

## IconButton
48 dp circular, `hitSlop` 8, `accessibilityLabel` required (no visible text). Variants: `plain`, `tonal` (raised bg). Used for back, close, search clear, show/hide password.

## StatusChip
Pill with icon + word. Props: `kind: 'item' | 'table' | 'draft'`, `status` (union below), `size?: 'sm'(26) | 'lg'(44, KDS)`.
- item: `SENT | IN_PROGRESS | READY | SERVED | VOIDED` -> Enviado, En preparación, Listo, Servido, Cancelado (colours §1.4).
- table: `FREE | OCCUPIED | BILL_REQUESTED | INACTIVE` -> Libre, Ocupada, Cuenta solicitada, Inactiva (§1.3).
- draft: `PENDING | SENDING | SENT | FAILED` -> Por enviar, Enviando…, Enviado, No se envió.
States: static. a11y: reads label only ("En preparación"). Text ≥ 12 dp bold.

## TableCard
Floor tile. Props: `code`, `kind: 'POOL' | 'TABLE' | 'BAR'`, `state` (table union), `customerName?`, `timerStart?` (ISO; pool only), `timerStopped?`, `onPress`, `stale?`, `disabled?`.
Variants: `pool` (76 dp tall, 2-col, shows live timer `h:mm:ss`, 20 dp bold tabular), `reg` (68 dp, 3-col). Content: code (title), state label+icon (caption bold, colour per state), customer name (label, 1 line ellipsis), timer.
States: default; pressed (opacity .85); `stale` (offline: 70 % opacity, timer frozen with "~" prefix); `disabled` (read-only roles with no action; still tappable if opens read-only ticket); Inactiva is dashed and not pressable.
Behaviour: Libre -> "Abrir mesa" sheet; Ocupada/Cuenta -> Ticket. Label: `"Mesa T4, ocupada, Sofía, 1 hora 23 minutos"`. Timer text is *time elapsed*, never an amount.

## TicketLine
One order line on Ticket detail. Props: `quantity`, `name`, `modifiers: string[]`, `note?`, `status` (item union), `netCents`, `promoLabel?`, `onLongPress?` (manager menu, P1), `onPress?`.
Layout: `qty×` (bodyLg, `primaryText`) | name (body 600) + modifiers (label, secondary) + note (label bold, `warning`, note icon) | price (body bold) + StatusChip. Min height 64.
Variants: `served` (name in `textSecondary`), `voided` (strikethrough name+price, price shown as is, excluded from total). States: default, pressed; long-press only for roles with manager actions. a11y: "2 Alitas BBQ 10 pz, salsa BBQ, en preparación, 290 pesos".

## DraftLineRow
Line in "Pedido por enviar". Props: `quantity`, `name`, `modifiers`, `note?`, `status: 'PENDING'|'SENDING'|'SENT'|'FAILED'`, `error?`, `onChangeQty`, `onRemove`, `onRetry`.
- PENDING: shows QuantityStepper (sm) and swipe-left/long-press "Quitar" (also an explicit button in a11y actions).
- SENDING: chip "Enviando…", stepper hidden, row not editable.
- SENT: chip "Enviado" (green), row collapses to history after the sheet closes.
- FAILED: chip "No se envió" + `AppButton secondary md` "Reintentar" (same Idempotency-Key reused).

## MenuItemTile
Grid tile (2 columns, ≥ 92 dp tall, 12 gap). Props: `name`, `priceCents`, `routing: 'KITCHEN'|'BAR'`, `soldOut?`, `draftQty?`, `onPress`.
States: default; `inDraft` (1.5 dp `primary` border + qty badge top-right); `soldOut` (surface bg, dashed border, name `textMuted`, price replaced by red "Agotado", **not pressable**, a11y "agotado"); pressed (opacity). Sold-out comes from `GET /inventory/stock-check` (`blocked_items`). Items needing options open ItemConfigurator; items without options add directly with qty 1 (long-press = configurator).

## ModifierGroup
Inside ItemConfigurator. Props: `title`, `mandatory`, `min`, `max`, `allowMultiple`, `options: {id,name,priceDeltaCents}[]`, `selectedIds`, `onChange`, `error?`.
Header: title + requirement badge — `Obligatorio · elige 1` / `elige 1 a 2` (warning tint) or `Opcional` (neutral). Options: 52 dp rows, checkbox (multi) or radio (max 1). Footer line: "2 de 2 elegidas · quita una para cambiar".
Rules (mobile re-implements, server doesn't — rules K.136): when `selected = max`, unselected options are disabled with that hint; `selected < min` -> `error` "Elige al menos {min}" and the parent CTA disabled. Price delta shown right (`+ $10.00`).

## QuantityStepper
`−  n  +` Props: `value`, `min=1`, `max=99`, `onChange`, `size: 'lg'(56) | 'sm'(48)`. Long-press repeats at 5 Hz. Disabled at bounds (the disabled button keeps its target). Haptic `selectionAsync`. a11y: `adjustable` role with increment/decrement actions, announces "2".

## BottomActionBar
Pinned bar above the gesture area: surface bg, top hairline, 12 dp padding, 1–2 buttons. Props: `primary: AppButtonProps`, `secondary?: AppButtonProps`, `helper?: string` (one line above buttons, e.g. offline reason).
Rules: primary on the right/dominant (flex 1.45 when two); disabled state must show *why* in `helper`. Keyboard-aware (lifts above keyboard). Used on Ticket (Agregar productos | Pedir cuenta), Menu (Revisar pedido (n)), Draft (Enviar (n)), Configurator (stepper + Agregar).

## ConnectionPill
Props: `state: 'online' | 'reconnecting' | 'offline'`, `compact?`. Dot + word (`En línea`, `Reconectando`, `Sin conexión`); colours §1.6; `reconnecting` pulses (reduced-motion: static). Derived from socket + last successful request (not only OS NetInfo). Tapping it opens connection details sheet (admin: diagnostics link). `accessibilityLiveRegion="polite"` announces changes.

## OfflineBanner
36 dp strip under the top bar. Props: `lastUpdated: Date`, `kind: 'offline' | 'stale' | 'demo'`. Text "Sin conexión · datos de hace 3 min" (offline), "Datos desactualizados · actualizando…" (stale), "DATOS DE DEMOSTRACIÓN" (demo, D13, `warning` colours). Persistent (not dismissible) until recovered; on recover turns green "Conectado de nuevo" for 2 s. Mutating buttons below disable with explanatory `helper`.

## Toast
Top overlay (below top bar), 56+ dp, 12 dp radius, `e2`. Props: `tone: 'success' | 'info' | 'error' | 'warning'`, `title`, `message?`, `action?: {label,onPress}`, `durationMs` (4000; 6000 with action).
Ready notification = `success` toast with action "Ver" (deep link to ticket). Queue max 1 visible; extra "Listo" events coalesce: "3 productos listos". Not the only record: Listos tab badge persists. Swipe up to dismiss.

## ConfirmDialog
Centered, `xl` radius, scrim. Props: `title`, `message`, `confirmLabel`, `cancelLabel`, `destructive?`, `loading?`, `onConfirm`, `onCancel`. Destructive: confirm is `danger` button, cancel is default-focused `secondary` (never the destructive one). Back/outside-tap = cancel unless `loading`. Used for: Pedir cuenta, Cerrar sesión, discard draft, void item.

## PinPad
Manager PIN dialog body. Props: `length=4`, `title`, `message`, `error?`, `onSubmit(pin)`, `loading?`, `lockedUntil?`.
Layout: dots row, 3×4 keypad (60 dp keys, 8 gap; `0`, backspace, close), Cancelar | Confirmar. Auto-submits at `length`; wrong PIN: dots shake once (disabled under reduced motion), clears, `Error` haptic, message "PIN incorrecto. Intenta de nuevo."; after 3 wrong in a row show "Pídele a un gerente que escriba su PIN" (server limit is 5/min; 429 -> "Demasiados intentos, espera 1 minuto", keypad disabled with countdown). PIN is never stored/logged; secure keypad, no system keyboard, dots only.

## LoadingSkeleton
Shimmer placeholders matching final layout. Props: `variant: 'floor' | 'ticket' | 'menu' | 'kds' | 'list' | 'stats'`, `count?`. Raised-colour blocks, 1.2 s shimmer (static under reduced motion). Shown only on first load without cache; background refetch uses a 2 dp top progress line, never skeletons.

## EmptyState
Props: `icon`, `title`, `message?`, `action?`. Centered, 88 dp icon disc. Copy examples: Listos "Nada por servir. Tus pedidos listos aparecen aquí."; KDS "Sin pedidos pendientes"; Tickets "No hay tickets abiertos"; Menu search "No encontramos \"{q}\"".

## ErrorState
Props: `title`, `message`, `code?`, `onRetry`, `onDetails?`, `kind: 'generic' | 'network' | 'server' | 'forbidden' | 'notFound'`. Full-screen or inline (inside a card). Shows code + time for support. Retry = primary `lg`; "Ver detalles" ghost opens sheet with request id/status (admin sees raw). `network` -> shown only when no cache exists; with cache we show OfflineBanner instead.

## StatTile
Manager overview tile. Props: `value: string|number`, `label`, `footnote?`, `tone: 'neutral' | 'warning' | 'alert'`, `onPress?`. Value `display` 32 bold, ≥ 96 dp tall. `warning` = bill tint (Cuentas solicitadas > 0), `alert` = danger tint. Tappable tiles navigate to the filtered list (a11y role button). Skeleton variant for loading; shows "—" when the endpoint failed (never a stale 0).

## KdsTicketCard
Props: `ticket: {code, customerName?, items: KdsItem[], oldestSentAt}`, `station`, `onAdvanceItem(itemId)`, `onAllReady()`, `landscape?`.
Structure: header (code 32 bold, customer 16, **KdsAgeBadge**) -> KdsItemRow × n -> footer `AppButton secondary lg` "Todo listo". Border 2 dp by age level. Variants: portrait (full width, 1 col), landscape (286 dp wide, horizontal scroll, header "Todo listo" stays reachable). States: default; `advancing` (row shows spinner, 1 request in flight per item); `allReady` (footer replaced by "Esperando mesero" muted); `error` (row red outline + retry). Cards sort by oldest `sent_at`; list frozen while touching.

## KdsItemRow
Whole row = target (64+ dp). Props: `quantity`, `name`, `modifiers[]`, `note?`, `status: 'SENT'|'IN_PROGRESS'|'READY'`, `onAdvance`.
Left stripe 8 dp by state (slate / amber / green), qty 26, name 22 bold, modifiers 18 secondary, **note on solid `warning` chip, 18 bold dark text with note icon** (always highlighted), right action button 56 dp: SENT -> "Iniciar" (outline), IN_PROGRESS -> "Listo" (primary), READY -> "Listo ✓" (green, inert). Tap anywhere on row advances **exactly one step** (SENT -> IN_PROGRESS -> READY); server accepts any order, so order is enforced client-side (rule E.72). Optimistic UI with rollback on failure. 3 s undo toast on READY ("Deshacer") sends IN_PROGRESS.

## KdsAgeBadge
Props: `since: ISO`, `now`, `size?`. Clock icon + `m:ss` (or `h:mm` ≥ 60 min) in 28 dp bold. Level from `tokens.kds`: neutral < 10, `a-warn` 10–20, `a-alert` > 20. Tick 1 s; uses server-offset-corrected clock. a11y: "23 minutos 10 segundos, urgente".

## ScreenScaffold / TopBar / TabBar
- `ScreenScaffold`: status-bar-aware container (`bg`), slots `topBar`, `banner` (Offline/Error), `content`, `actionBar`/`tabBar`; handles safe area, keyboard.
- `TopBar`: 56 dp, `surface`, title (title 20 bold) + optional subtitle (label), back `IconButton`, right slot (`ConnectionPill`, avatar). Landscape KDS variant 48 dp.
- `TabBar`: 64 dp, icon + 12 dp label always visible, active = `primaryText` + 3 dp top indicator, badge (red `danger`, white 12 bold, ≥ 20 dp). Per role tab sets in NAVIGATION_ARCHITECTURE.md.

---

## Component × screen matrix

| Component | Screens |
|---|---|
| AppButton | all |
| StatusChip | W-02, W-05, W-06, K-01 |
| TableCard | W-01, M-03 |
| TicketLine | W-02, M-02 detail |
| MenuItemTile / ModifierGroup / QuantityStepper | W-03, W-04, W-05 |
| DraftLineRow | W-05 |
| BottomActionBar | W-02, W-03, W-04, W-05 |
| ConnectionPill / OfflineBanner | all signed-in |
| Toast | W-01..W-06 (ready), all (errors) |
| ConfirmDialog / PinPad | W-02 (cuenta, anular), W-05 (descartar), Yo (logout), M-02 |
| LoadingSkeleton / EmptyState / ErrorState | all data screens |
| KdsTicketCard / KdsItemRow / KdsAgeBadge | K-01 |
| StatTile | M-01 |
