# Bola 8 Companion — Design System

Dark-only, Android-first (iOS later). Source of truth for values: [`tokens.json`](./tokens.json) (camelCase keys; numbers = dp, colours = `#rrggbb`). The app imports that file directly; never hard-code a value that exists there. Visual reference: [`prototypes/index.html`](./prototypes/index.html).

Design drivers (from the users): waiter = one hand, dim light, wet/gloved thumbs; kitchen = phone propped on the pass, read from 1 m, greasy fingers; manager/admin = glance and leave.

## 1. Colour

Derived from the web POS palette (slate surfaces, sky accent, brand `#0ea5e9`) so the phone and the bar PC feel like one product. Roles, not raw hues, are used in code (`colors.surfaceRaised`, never `slate-800`).

### 1.1 Surfaces and text

| Role | Token | Hex | Use |
|---|---|---|---|
| Canvas | `bg` | `#020617` | Screen background, behind lists |
| Surface | `surface` | `#0f172a` | Top bar, tab bar, action bar, sheets, KDS card body |
| Raised | `surfaceRaised` | `#1e293b` | Cards, inputs, menu tiles, KDS card header |
| Overlay | `surfaceOverlay` | `#334155` | Card headers on raised, avatar, switch track, keypad keys |
| Divider | `border` | `#334155` | Hairlines (decorative only) |
| Input outline | `textMuted` | `#94a3b8` | Interactive control outline (6.96:1; `borderStrong` is 2.36:1 and is NOT used for controls) |
| Text | `textPrimary` / `textSecondary` / `textMuted` | `#f1f5f9` / `#cbd5e1` / `#94a3b8` | Primary, supporting, meta. Meta text is never smaller than 12 dp |
| Disabled | `textDisabled` | `#64748b` | Disabled controls only (exempt from contrast rule). Sold-out names use `textMuted`, not this |

### 1.2 Accent and feedback

| Role | Token | Hex | Notes |
|---|---|---|---|
| Primary action | `primary` | `#0ea5e9` | Fill for primary buttons/selected chips; text on it is **`textOnAccent` `#020617`** (white on sky-500 is only 2.8:1 — do not use white) |
| Primary pressed | `primaryPressed` | `#38bdf8` | Pressed state is *lighter* (dark UI) |
| Accent as text/icon | `primaryText` | `#38bdf8` | Links, qty numbers, active tab |
| Danger fill | `danger` | `#dc2626` | Destructive fill, red KDS age; text `textOnDanger` `#ffffff` |
| Danger text | `dangerText` | `#fca5a5` | Error text/icons on dark surfaces |
| Success / Warning / Info | `success` `#4ade80`, `warning` `#fbbf24`, `info` `#38bdf8` | with `*Tint` backgrounds `#052e16`, `#422006`, `#082f49` |
| Focus ring | `focusRing` | `#7dd3fc` | 2 dp, offset 2 dp (hardware keyboards / switch access) |

### 1.3 Status colours — table states (Floor)

State is **never colour alone**: each has an icon and a word (accessibility + dim bars). Tile = tinted bg + 1.5 dp border + label.

| State (ES) | Server derivation | fg / bg / border | Icon (MDI) |
|---|---|---|---|
| Libre | resource AVAILABLE, no open ticket | `#4ade80` / `#052e16` / `#16a34a` | `check` |
| Ocupada | resource IN_USE, ticket OPEN | `#38bdf8` / `#082f49` / `#0284c7` | `account-outline` |
| Cuenta solicitada | ticket `payment_requested = true` (**overrides** Ocupada; for pool, the resource may read AVAILABLE with an OPEN ticket — derive from `active_ticket_id` + `payment_requested`, verify in contract tests) | `#fbbf24` / `#422006` / `#d97706` | `bell-outline` |
| Inactiva | `is_active=false` or status INACTIVE | `#94a3b8` / `#0f172a` / `#334155`, dashed border | `close` |

Tile shows the short label "Cuenta" (width); the full "Cuenta solicitada" appears in the accessibility label, legend and Ticket header.

### 1.4 Status colours — item (line) states

Chip = icon + word + tinted pill. `Servido` is deliberately quiet (done work recedes); `Listo` is the loudest (needs action by the waiter).

| Server status | ES label | fg / bg | Icon |
|---|---|---|---|
| SENT | Enviado | `#e2e8f0` / `#334155` | `send` |
| IN_PROGRESS | En preparación | `#fbbf24` / `#422006` | `fire` |
| READY | Listo | `#052e16` / `#4ade80` (solid) | `check` |
| SERVED | Servido | `#94a3b8` / `#1e293b` | `check-all` |
| VOIDED | Cancelado | `#fca5a5` / `#450a0a` + strikethrough on name and price | `close` |
| (client) draft | Por enviar / Enviando… / No se envió | `#e2e8f0`/`#334155`, `#fbbf24`/`#422006`, `#fca5a5`/`#450a0a` | `clock-outline` / `refresh` / `alert-circle-outline` |

### 1.5 KDS age thresholds

Thresholds come from `tokens.json -> kds` (`warnAfterMin: 10`, `alertAfterMin: 20`); the age is the oldest un-READY item on the ticket, measured from `sent_at`, ticking every second client-side with server-offset correction.

| Age | Badge fg / bg | Card border | Contrast |
|---|---|---|---|
| < 10 min | `#f1f5f9` / `#334155` | `border` | 9.45:1 |
| 10–20 min | `#020617` / `#f59e0b` | `#f59e0b` 2 dp | 9.39:1 |
| > 20 min | `#ffffff` / `#dc2626` | `#dc2626` 2 dp | 4.83:1 (large bold text, passes AA large 3:1 and AA normal) |

Cards are also **sorted oldest first**, so colour is redundant with position; the badge always has a clock icon + numeric time.

### 1.6 Connection

`connOnline #4ade80`, `connReconnecting #fbbf24`, `connOffline #f87171`; pill = dot + word ("En línea / Reconectando / Sin conexión"). Offline banner `#fde68a` on `#78350f` (7.28:1); error banner `#fecaca` on `#7f1d1d` (6.93:1).

### 1.7 Computed contrast (WCAG 2.x relative luminance)

Computed from `tokens.json` with a script (`(L1+0.05)/(L2+0.05)`). Text requirement: ≥ 4.5:1 (≥ 3:1 for ≥ 24 dp / ≥ 18.66 dp bold).

| Foreground | Background | Ratio |
|---|---|---|
| `textPrimary` #f1f5f9 | `bg` #020617 | 18.41:1 |
| `textPrimary` | `surface` #0f172a | 16.30:1 |
| `textPrimary` | `surfaceRaised` #1e293b | 13.35:1 |
| `textSecondary` #cbd5e1 | `surface` | 12.02:1 |
| `textSecondary` | `surfaceRaised` | 9.85:1 |
| `textMuted` #94a3b8 | `bg` | 7.87:1 |
| `textMuted` | `surface` | 6.96:1 |
| `textMuted` | `surfaceRaised` | 5.71:1 |
| `textDisabled` #64748b | `surface` | 3.75:1 (disabled only, exempt) |
| `textOnAccent` #020617 | `primary` #0ea5e9 | 7.28:1 |
| `textOnAccent` | `primaryPressed` #38bdf8 | 9.42:1 |
| `primaryText` #38bdf8 | `surface` | 8.33:1 |
| `primaryText` | `surfaceRaised` | 6.83:1 |
| `textOnDanger` #ffffff | `danger` #dc2626 | 4.83:1 |
| `textOnDanger` | `dangerPressed` #b91c1c | 6.47:1 |
| `dangerText` #fca5a5 | `surface` | 9.41:1 |
| `dangerText` | `dangerTint` #450a0a | 8.51:1 |
| `success` #4ade80 / `warning` #fbbf24 / `info` #38bdf8 | `surface` | 10.25 / 10.69 / 8.33:1 |
| `focusRing` #7dd3fc | `surface` | 10.71:1 |
| Table Libre `#4ade80` | `#052e16` | 8.55:1 |
| Table Ocupada `#38bdf8` | `#082f49` | 6.48:1 |
| Table Cuenta `#fbbf24` | `#422006` | 8.73:1 |
| Table Inactiva `#94a3b8` | `#0f172a` | 6.96:1 |
| Item Enviado `#e2e8f0` | `#334155` | 8.40:1 |
| Item En preparación `#fbbf24` | `#422006` | 8.73:1 |
| Item Listo `#052e16` | `#4ade80` | 8.55:1 |
| Item Servido `#94a3b8` | `#1e293b` | 5.71:1 |
| Item Cancelado `#fca5a5` | `#450a0a` | 8.51:1 |
| Age neutral `#f1f5f9` | `#334155` | 9.45:1 |
| Age warn `#020617` | `#f59e0b` | 9.39:1 |
| Age alert `#ffffff` | `#dc2626` | 4.83:1 |
| Offline banner `#fde68a` | `#78350f` | 7.28:1 |
| Error banner `#fecaca` | `#7f1d1d` | 6.93:1 |
| `connOnline` / `connReconnecting` / `connOffline` | `surface` | 10.25 / 10.69 / 6.45:1 |

Non-text: decorative dividers (`border` on `bg` 1.95:1) are exempt; every interactive outline uses `textMuted` (≥ 5.7:1). Re-run the check if any colour token changes (the script is trivial: see `DESIGN_DECISIONS.md` D-14).

## 2. Typography

System font (Roboto on Android, SF on iOS later): zero bundle cost, best rendering on cheap panels. Numerals that tick or align (timers, prices, ages) use `fontVariant: ['tabular-nums']`.

| Style | dp / line | Weight | Use |
|---|---|---|---|
| `caption` | 12 / 16 | 500–700 | Chip labels, tile state label, helper footnotes |
| `label` | 14 / 20 | 600 | Field labels, secondary rows, notes |
| `body` | 16 / 24 | 400–600 | Default text, line names, buttons (md) |
| `bodyLg` | 18 / 26 | 600–700 | Primary buttons, line quantities |
| `title` | 20 / 28 | 700 | Top-bar title, table code |
| `headline` | 24 / 32 | 700 | Empty/error titles, KDS station name |
| `display` | 32 / 40 | 700 | Stat tile values |
| `timer` | 28 / 32 | 700 | Pool timer on Ticket hero |

**KDS large variant** (`fontSizesKds`, designed for 1 m): ticket code 32, age 28, item name 22 (bold), item qty 26, modifier 18, note 18 (bold, on amber chip). Rows ≥ 72 dp tall. KDS ignores the OS font scale (fixed 1.0) and instead offers its own "Texto grande" toggle (×1.25) in settings; all other screens honour OS font scale up to 1.3 (`maxFontSizeMultiplier={1.3}`) and must not clip at 1.3.

Weights: 400/500/600/700 (`fontWeights`, strings per RN). No italics, no light weights (low contrast in dim light). Copy is sentence case; only section headers on Floor/Settings use small caps-style uppercase 14 dp.

## 3. Spacing, radii, elevation

- **4-pt grid**: `s1 4, s2 8, s3 12, s4 16, s5 20, s6 24, s8 32, s10 40, s12 48, s16 64`. Screen gutter 16 (`layout.screenPad`). Gap between tiles 8; between cards 12; inside cards 12–14.
- **Radii**: `sm 6` (checkbox), `md 12` (buttons, inputs, tiles, chips-rows), `lg 16` (cards, KDS cards), `xl 24` (sheets, dialogs, logo), `pill 999` (chips, pills).
- **Elevation**: dark UI expresses depth by surface lightness (`bg` < `surface` < `surfaceRaised` < `surfaceOverlay`), not shadows. Real shadows only for floating layers: toast `e2` (6), sheet/dialog `e3` (12); scrim `#000` at 62 %.

## 4. Touch targets

| Target | Min (dp) | Token |
|---|---|---|
| Any tappable | 48 × 48 | `touch.min` |
| **Primary waiter actions** (Enviar, Agregar productos, Pedir cuenta, Marcar servido, Agregar al pedido, stepper +/−) | **56** high | `touch.primary` |
| KDS item row (whole row is the hit area) / its action button | 64 row, 56 button | `touch.kdsRow` |
| Icon buttons | 48 (+ `hitSlop` 8) | `touch.iconButton` |
| Floor tile | ≥ 68 high × ≥ 118 wide (3-col) | — |
| Spacing between adjacent targets | ≥ 8 | `s2` |

Bottom action bar sits 12 dp from the gesture area so the thumb zone is reachable one-handed; destructive actions are never in the bar's primary slot and always need a confirm.

## 5. Iconography

`@expo/vector-icons` → `MaterialCommunityIcons`. 24 dp default, 20 in chips/banners, 44 in empty/error states. Icon always accompanies colour-coded state. (Prototype uses inline SVG stand-ins; real names below.)

| Concept | Icon name | Concept | Icon name |
|---|---|---|---|
| Mesas / Piso | `table-furniture` | Billar | `billiards` |
| Listos | `bell-outline` / `bell-ring` | Yo / usuario | `account-outline` |
| Cocina | `silverware-fork-knife` | Barra | `glass-cocktail` |
| Enviado | `send` | En preparación | `fire` |
| Listo / Servido | `check` / `check-all` | Cancelado | `close` |
| Hora / edad | `clock-outline` | Nota | `note-text-outline` |
| Cuenta | `receipt-text-outline` | Caja | `cash` |
| Agregar / quitar | `plus` / `minus` | Buscar | `magnify` |
| En línea / sin conexión | `wifi` / `wifi-off` | Reintentar | `refresh` |
| Error / aviso | `alert-circle-outline` | Acceso denegado | `shield-alert-outline` |
| Servidor | `server` | Resumen | `chart-box-outline` |
| Ajustes | `tune-variant` | Idioma | `translate` |
| Bloqueo / PIN | `lock-outline` | Borrar dígito | `backspace-outline` |
| Cerrar sesión | `logout` | Sonido | `volume-high` |
| Ver / ocultar clave | `eye-outline` / `eye-off-outline` | Copiar | `content-copy` |
| Atrás / más | `arrow-left` / `chevron-right` | Tickets | `receipt-text-outline` |

## 6. Motion (minimal)

Dim bars + busy hands → motion must never delay a tap. Durations: `fast 120`, `normal 200`, `slow 320` ms; ease-out; transform/opacity only.

- Press feedback: opacity/colour change within `fast`, no scale bounce.
- Sheet/dialog: slide-up/fade `normal`. Toast: slide-down `normal`, auto-dismiss 4 s (6 s with action), swipe to dismiss.
- List changes (new KDS card, line status change): 200 ms fade of the new/changed row; **no** layout-shifting reorders animation on KDS (cards must not jump under a finger — new cards append by age and the list is frozen while a touch is down).
- Timers update text in place; no pulsing except the offline pill's reconnect dot (1 s opacity loop).
- Respect `AccessibilityInfo.isReduceMotionEnabled`: replace slides with fades, drop the pulse.

## 7. Haptics (`expo-haptics`)

| Moment | Haptic |
|---|---|
| Chip/segment/stepper change, selecting a modifier | `selectionAsync` |
| Add item to draft | `impactAsync(Light)` |
| Draft sent OK; ticket line served; bill requested | `notificationAsync(Success)` |
| New "Listo" arrives for my table (toast shown) | `notificationAsync(Success)` + system notification sound if enabled |
| Send failed / PIN wrong / validation block | `notificationAsync(Error)` |
| KDS item advanced (tap) | `impactAsync(Medium)`; "Todo listo" `notificationAsync(Success)` |
| New KDS ticket arrives | `notificationAsync(Warning)` + optional sound (`kds_sound_enabled` setting) |
| Connection lost | `notificationAsync(Warning)` once (not on every retry) |
| Background refetch, timers, scrolling | none |

All haptics gated by the "Vibración" setting; never use haptics as the only feedback.

## 8. Accessibility checklist (build gate)

- Contrast table above; re-check on token edits.
- Every pressable has `accessibilityRole`, `accessibilityLabel` incl. state ("Mesa T4, ocupada, Sofía, abierta hace 1 hora"); status chips read their word.
- Targets per §4; focus order top→bottom; sheets trap focus; Android back closes sheet before screen.
- No state by colour alone; no information only in a toast (toasts mirror persistent lists: Listos tab).
- Spanish default; strings via i18next keys, formats `es-MX` (`$1,145.00`, 24 h clock).

## 9. Token consumption

```ts
import tokens from '../../docs/mobile/design/tokens.json'; // or copied to mobile/src/theme/tokens.json by a script
const { colors, spacing, radii, fontSizes, fontSizesKds, fontWeights, touch } = tokens;
```

**Implementation note (shell phase):** Metro cannot import outside the project root, so the app consumes a *copy*: `mobile/src/theme/tokens.json`. This file (`docs/mobile/design/tokens.json`) stays the source of truth; after editing it run `node mobile/scripts/sync-tokens.mjs` (or `cd mobile && node scripts/sync-tokens.mjs`) and re-run `node docs/mobile/design/check-contrast.mjs`. The typed re-export is `mobile/src/theme/tokens.ts` (`colors, spacing, radii, fontSizes, fontWeights, touch, ...` plus `tableStatusStyle`, `lineStatusStyle`, `draftStatusStyle`, `kdsAgeLevel`, `ageStyle`).

Keep one generated `theme.ts` that re-exports typed objects; screens import `theme`, never the JSON. Prototype CSS variables (`--c-surface-raised`, `--sp-4`, `--fs-body`, `--kfs-item`, `--t-primary`) are generated 1:1 from the same file by `prototypes/_build.mjs`.
