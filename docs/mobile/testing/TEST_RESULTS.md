# Test Results - Bola 8 Staff (Android release APK vs local POS backend)

Run date: 2026-11-05. Evidence: command output captured during this run; screenshots in `docs/mobile/testing/screenshots/final/`; Maestro run logs in `docs/mobile/testing/logs/maestro/`. Anything not listed as PASS with evidence is NOT VERIFIED.

## 1. Environment

| Item | Value |
|---|---|
| App | `mobile/dist/bola8-staff-0.1.0-local.apk` (55,588,077 bytes, sha256 prefix 1c2408d310ffc969), versionName 0.1.0, release build (Metro not running; port 8081 empty) |
| Stack | Expo ~58.0.23, React Native 0.88.1, React 19.3.0, Node v24.21.0 |
| Emulator | AVD `billar_mobile_api35`, `emulator-5554`, Android 15 (google/sdk_gphone64_x86_64, userdebug), x86_64, 1080x2400 @ 420 dpi, headless, left running |
| Backend | docker project `billarmobile` (backend, postgres, frontend), http://localhost:8090, emulator uses http://10.0.2.2:8090. `/health` -> `{"status":"ok"}` |
| E2E runner | Maestro 2.12.1 (`D:\tools\maestro-dl\maestro\bin`), JDK 21. Flows in `mobile/e2e/maestro/` |
| Cash session | OPEN (opened 22:01 UTC, fund $0.00) |
| Seed users | waiter1/2, kitchen, barstaff, manager, admin |

## 2. Automated suites (A)

| Suite | Command | Result line |
|---|---|---|
| Unit/component | `npm test` (mobile/) | `Test Suites: 34 passed, 34 total / Tests: 443 passed, 443 total` (Jest prints a "worker failed to exit gracefully" warning; no failures) |
| Typecheck | `npx tsc --noEmit` | no output, exit 0 |
| Lint | `npx expo lint` | no findings, exit 0 (only an npm `.npmrc allow-scripts` warning) |
| Contract (real backend) | `npm run test:contract` | `Test Suites: 3 passed, 3 total / Tests: 56 passed, 56 total` |
| Backend live | `python -m tests.test_mobile_extensions_live` (backend/) | ends `ALL PASSED`; counted 30 `PASS`, 0 `FAIL` lines |

## 3. E2E journeys on the RELEASE APK (B)

Method: Maestro for UI steps; host `curl` against the API for server-side verification; host `adb` for airplane mode and rotation. `_login.yaml` was fixed (it needs an `appId:`/`---` config header as a Maestro subflow; added `hideKeyboard` after the server URL). Flows were run with `maestro --device emulator-5554 test --test-output-dir ...`.

| # | Journey | Method | Steps / evidence | Result |
|---|---|---|---|---|
| 1 | Waiter order with mandatory modifier, no duplicates | Maestro `j1-waiter-order.yaml` + API | waiter1 login, T05 opened, "Chicken Wings" (seed name for Alitas) with mandatory "Wing Flavor" -> tapping Add with none chosen blocked (`06b`), Buffalo chosen, + Soda, Send, toast "Pedido enviado a cocina y barra". API after: `ticket OPEN v 3 subtotal 1500 lines 2 / Soda x1 SENT / Chicken Wings x1 SENT ['Buffalo']` (each line exactly once). Shots `02`-`07`, `04b` | PASS |
| 2 | Chef receives and advances | Maestro `j2-kitchen-chef.yaml` (+ continuation) + API | kitchen login, KDS shows Chicken Wings (`09-kds-portrait`). Tap -> API `IN_PROGRESS` (row accessibility text "1 Chicken Wings, Buffalo, En preparación, Listo"); tap -> API `READY`, UI "Esperando mesero" (`09c`). Caveat: first run's UI assertion on "En preparación" failed because the row's label is a combined string; the flow now uses a regex. The IN_PROGRESS step was confirmed by API + hierarchy text, no screenshot (`09b` missing) | PASS (IN_PROGRESS evidenced by API, not screenshot) |
| 3 | Waiter sees Listo, marks served | Maestro `j3-waiter-serve.yaml` + API | waiter login after READY: Listos tab shows the line (`08-ready-list`), ticket chip "Listo" + "Marcar servido" (`04c`), tap -> API `Chicken Wings x1 SERVED`. The live toast/badge while already logged in was NOT exercised (waiter logged in after READY) | PASS (chip + serve); realtime toast NOT VERIFIED |
| 4 | Manager overview vs API | Maestro `j4-manager-overview.yaml` + API | UI tiles: Tickets abiertos 1 / Total abierto $15.00; Cuentas solicitadas 0; Cocina 0 en cola; Barra 1 en cola; Caja abierta "desde 16:01 Fondo $0.00"; Sin alertas. API: open tickets 1, total_cents 1500, payment_requested False; `/queue/kitchen` = `[]`; `/queue/bar` = 1 item (Soda); `cash/status` open true, fund 0, opened 22:01Z (= 16:01 local). `11-manager-overview.png`; "Sistema" tab absent for manager | PASS |
| 5a | Waiter denied manager/kitchen routes | Maestro `j5a-waiter-denied.yaml` | deep links `bola8staff:///overview`, `/system`, `/queue` -> "Esta sección no es para tu rol" each; "Ir a mi pantalla" returns to floor (`16-access-denied`) | PASS |
| 5b | Kitchen cannot reach waiter floor | Maestro `j5b-kitchen-denied.yaml` | `/floor`, `/ready`, `/overview` -> denied, `screen-floor` not visible (`16b`) | PASS |
| 6 | Network interruption and recovery | Maestro `j6a/b/c` + host `adb shell cmd connectivity airplane-mode enable/disable` + API | draft with 1 Soda on T06; airplane ON: header pill "Reconectando…" then "Sin conexión", banner "Sin conexión · última actualización", message "Tu pedido se guarda aquí; envíalo cuando vuelva", Send disabled (`13-offline-draft`, `13b`). API during outage: T06 subtotal 0, no lines. Airplane OFF: banner clears, tap Send -> toast, API `ticket OPEN v 2 subtotal 300 lines 1 / Soda x1 SENT` (once). The "No se envió" line state (failure of an in-flight send) is NOT exercised because Send is disabled while offline | PASS (disabled-send path); in-flight failure/retry NOT VERIFIED |
| 7 | Logout, switch waiter | Maestro `j7-logout-switch-waiter.yaml` | waiter1 built an unsent draft (`07b`), Yo -> logout shows confirm dialog (`17-logout-with-drafts-dialog`), login waiter2, floor loads (`02b`), T06 ticket shows no draft bar (`18-waiter2-no-draft`) | PASS |
| 8a | Invalid credentials | Maestro `j8-negative-setup-login.yaml` | waiter1/wrongpass -> `login-error` visible, stays on login (`02c`) | PASS |
| 8b | Server unreachable on setup | same flow | `10.0.2.2:9999` -> "No se pudo conectar con el servidor. Revisa la dirección y el Wi-Fi.", Continue disabled (`14-setup-unreachable`), then valid URL connects | PASS |

Also run: `manager-ops-flow.yaml` (manager login, Resumen/Tickets/Piso/Cocina-Barra tabs, no Sistema): all steps COMPLETED. Admin Sistema tab opened (`12-admin-diagnostics`, health 16 ms, websocket connected).

Pre-existing flows `waiter-order-flow.yaml`, `waiter-logout-login-flow.yaml`, `kitchen-chef-flow.yaml`, `manager-unauthorized-flow.yaml` were not re-run; superseded by the `j*.yaml` flows above. Ticket cleanup after the run: T01/T05/T06 force-closed; `GET /tickets?status=OPEN` -> `[]`.

## 4. Visual validation (C)

Compared each screenshot with `docs/mobile/design/prototypes/screenshots/*.png` (side-by-side). Layout, hierarchy, colours, chips and copy match the prototypes closely. The data differs (prototype mock data vs real seed). Defects found:

| Sev | Screen | Description | Screenshot |
|---|---|---|---|
| High | Item configurator (notes) | With the keyboard open the "Notas para cocina" input is hidden under the keyboard (only the label's top edge shows) and the "Agregar al pedido" button is off screen, so the waiter types blind. Even without the keyboard (6-option group) the notes field is squeezed to a sliver above the Cantidad row | `20-notes-keyboard-open.png`, `06c-configurator-chosen.png` |
| Medium | Native splash (cold start) | The OS splash shows the default Expo "A" logo on a dark background, not the Bola 8 logo used by the prototype `17-splash` | `17-splash-cold-2.png` |
| Low | Floor/KDS after fresh login | Green "Conectado de nuevo" banner appears right after a normal login with no prior disconnect | `02b-floor-waiter2.png`, `09-kds-portrait.png` |
| Low | Yo tab | ES/EN language toggle buttons measure 64x40 dp (<48 dp height) per Maestro hierarchy bounds | `lang-toggle-es/en` (hierarchy; see `docs/.../02-login.png` for the same control) |
| Low | KDS landscape | Cards stay in one column about 47% wide, leaving the right half empty; status pill sits higher than the title baseline. Prototype `10-kds-landscape` uses multi-column | `10-kds-landscape.png` |
| Low | Manager PIN sheet | Keypad has no clear key (prototype has an "x" key); sheet is a bottom sheet, prototype is a centred dialog (acceptable) | `15-manager-pin.png` |
| Low | Ticket after send | The success toast covers the hero total and the first line header for a few seconds | `04b-ticket-sent.png` |
| Low | Ticket READY line | "Marcar servido" button sits flush against the line card (~9 px gap) | `04c-ticket-ready-chip.png` |
| Info | Setup/login keyboard | With the keyboard open the setup and login fields and primary button stay visible; no overlap | `21-setup-keyboard-open.png`, `22-login-keyboard-open.png` |

Other checks: no text overflow or truncation seen on setup, login, floor, ticket, menu, draft, ready, KDS, overview, system, denied, PIN, offline screens. Contrast looked adequate (white/light text on dark navy; coloured chips legible). Loading/empty/error states: setup error and access-denied captured; KDS empty (`09-kds-portrait-empty.png`, `10-kds-landscape-empty.png`) renders a blank dark area. The prototype's list-error screen (`14-error`) and the in-app "Restaurando tu sesión" splash were NOT captured. Touch-target audit was done only via Maestro hierarchy on the floor, Listos and Yo tabs (only the language toggle failed); other screens NOT VERIFIED numerically.

## 5. Defects found (app)

1. **Configurator notes field unusable with keyboard** (High). Repro: waiter -> table -> Agregar productos -> tap "Chicken Wings" -> tap "Notas para cocina" -> keyboard covers the field and the Add button. Expected: sheet resizes/scrolls so the focused field and Add stay visible.
2. **Splash uses Expo default icon** (Medium). Repro: force-stop, launch from cold; native splash frame shows the Expo logo. Fix in `app.config.ts` splash config (not changed here).
3. **Spurious "Conectado de nuevo" banner after login** (Low). Repro: login as any role; banner shows on the first screen.
4. **Language toggle height 40 dp** (Low).
5. **KDS landscape layout single column** (Low).

No functional defects were found in the seven mandatory journeys.

## 6. Test-tooling notes

- Maestro `takeScreenshot` only accepts paths inside the run output folder, so flows use bare names and the host copies PNGs out of the `--test-output-dir`.
- Maestro on this host intermittently reports `device offline`/driver died on a `clearState` launch; re-running succeeds. Not an app issue. Trailing `IOException ... device offline` after a passing flow is harmless.
- Login is rate limited (10/min): flows were paced by 20-45 s sleeps; no 429 was hit.
- Windows: YAML flows must be saved as UTF-8 (accented asserts such as "Esta sección no es para tu rol").

## 7. NOT verified

- Real bar network (Wi-Fi roaming, latency, captive portals), real data volumes.
- Physical phones and tablets, other screen sizes/densities, Android versions other than 15.
- iOS.
- Print agent / printer hardware ("Imprimir pre-cuenta" was not pressed).
- Multi-device concurrency (two waiters on one ticket, KDS on a second device) and realtime push while a second client is active (waiter toast on READY).
- In-flight send failure ("No se envió" + Reintentar), duplicate-tap guard under slow network, token refresh/expiry in the field.
- Manager PIN success/failure paths (only the PIN sheet display, then cancelled), discounts, request-bill, payment, cash close.
- Bar-staff (`barstaff`) station flow and the manager Cocina/Barra toggle behaviour beyond opening the tab.
- Accessibility (TalkBack), font scaling, dark/light theme variants, Spanish/English switch.
- In-app splash "Restaurando tu sesión" and prototype `14-error` list-error screen.

## 8. Defect fixes and re-test (final-QA fix round)

New release APK: `mobile/dist/bola8-staff-0.1.0-local.apk` (56,078,743 bytes, 53.5 MB; x86_64 + arm64-v8a; prebuild --clean, then a second incremental build for the KDS tweak). Installed on emulator-5554, no Metro. Gates: `npm test` 34 suites / 443 tests passed, `npx tsc --noEmit` clean, `npx expo lint` clean. New screenshots are in `screenshots/final/fixed/`.

| # | Defect | Status | Evidence / change |
|---|---|---|---|
| 1 | High: configurator notes + Add hidden by keyboard | **Fixed** | `Sheet.tsx` lifts the sheet by the covered keyboard height (measured, so it also works if the window resizes), notes field scrolls into view on focus, `android.softwareKeyboardLayoutMode: 'resize'`. `fixed/20-notes-keyboard-open.png`: notes field, Cantidad and "Agregar al pedido" all visible above the keyboard. Note: the notes box bottom border is slightly clipped by the scroll area (cosmetic). Setup/login/open-table share the same patterns and were fine/covered by Sheet. |
| 2 | Medium: splash shows Expo logo | **Fixed** | Bola 8 logo (from `logo.jpg`, upscaled from 199 px, so slightly soft) rendered to `splash-icon.png` (rounded square), `icon.png`, adaptive foreground, favicon via System.Drawing; adaptive background = solid `#0f172a`; template background/monochrome images removed. `fixed/17-splash-cold-fixed.png`; launcher icon also shows the logo. |
| 3a | Low: spurious "Conectado de nuevo" | **Fixed** | `OfflineBanner` only shows it after the connection was previously online and went down. KDS/Floor screenshots after fresh login show no banner. (Unit tests unchanged and pass; no new dedicated test.) |
| 3b | Low: ES/EN toggle 40 dp | **Fixed** | `minHeight: touch.min` (48). Not re-measured via hierarchy on device. |
| 3c | Low: KDS landscape single column | **Fixed** | Threshold 3 columns at >= 840 dp plus 1 px floor so the third column does not wrap. `fixed/10-kds-landscape.png` shows 3 cards in a row (T01-T03). |
| 3d | Low: PIN pad clear key | **Fixed / already present in source** | Backspace key is in `PinPad.tsx` and appears in `fixed/15-manager-pin.png`. (It may have been missing from the QA build.) Bottom-sheet vs dialog remains an accepted difference. |
| 3e | Low: toast covers ticket total | **Fixed** | Toast moved from under the header to just above the bottom action bar. `fixed/04b-ticket-sent-toast.png` (shown on the draft screen after send; total not covered). The ticket screen was not captured with a toast. |
| 3f | Low: "Marcar servido" flush to card | Still open | Not in this round's scope. |

Re-run: Maestro `waiter-order-flow.yaml` (TABLE=T02, plus one extra screenshot step) against the first rebuilt APK: all steps COMPLETED (login, open table, Soda, send, toast "Pedido enviado a cocina y barra", "Enviado"). The final APK differs only by the KDS card-width line; the kitchen login flow and KDS landscape capture were run on it. Test tickets were force-closed afterwards.
