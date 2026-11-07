# Test Results V2 - Bola 8 Staff (debug APK on emulator, local backend)

Run date: 2026-11-06. Nothing here is claimed beyond the logs in `logs/` and the PNGs in `screenshots/` (raw Maestro output in `out/`).

## 1. Environment

| Item | Value |
|---|---|
| Worktree | `D:/Projects/Code/billar-pos-worktrees/mobile-pos-companion`, `mobile/` (Expo ~58, RN 0.88) |
| Env check | `check-android-env.ps1`: java 21.0.7, SDK, platform-tools, emulator 37.1.11, android-35 google_apis x86_64, WHPX usable: all OK |
| Emulator | AVD `billar_mobile_api35`, `emulator-5554`, already running (1080x2400) |
| Backend | docker project `billarmobile`, `http://localhost:8090`, `/api/v1/health` -> `status ok, server_version 1.1.0`; app uses `10.0.2.2:8090` |
| Build | `scripts/mobile/build-android-debug.ps1` (no clean prebuild; `android/` existed). Gradle `BUILD SUCCESSFUL in 3m 42s` (script wall time 223 s), 526 tasks. Output `mobile/dist/bola8-staff-debug.apk`, 135.9 MB, ABIs x86_64 + arm64-v8a. Log: `logs/build-debug.log` |
| JS delivery | The debug APK has NO embedded JS bundle (no `index.android.bundle`). It needs Metro: `npx expo start --port 8081` + `adb reverse tcp:8081 tcp:8081` (log `logs/metro.log`). The previous session used a release APK, which does not need this |
| Runner | Maestro 2.12.1 (`D:/tools/maestro-dl/maestro/bin`), `maestro --device emulator-5554 test --test-output-dir ...` |
| Data | Backend DB already seeded (users waiter1/kitchen/manager/admin, Soda, Chicken Wings, Loaded Nachos). Register was OPEN from a previous session. Leftover OPEN tickets (T01,T02,T05) were force-closed through the API before J1. T05 was re-seeded via API (`seed-t05.mjs`, Soda) for J12 retry. Wings ticket for J15 came from re-running J1. Open tickets were force-closed again before J16 (shows as "6 anulaciones hoy" in Resumen) |

## 2. Per-flow results

| Flow | Result | Notes |
|---|---|---|
| j1-waiter-order | PASS (3rd attempt) | Attempt 1 failed in `_login`: first launch, cold Metro bundle (6 s), `server-input` not yet visible. Attempt 2: T05 already occupied by leftover ticket (data, not app). Attempt 3 PASS after cleanup. Re-run for J15 PASS |
| j12-pay-cash | PASS after YAML fix | First run: the tap on `pay-dialog-confirm` did not register (dialog was animating in); payment not made (T05 stayed OPEN). Manually tapping Confirmar paid it and showed "Mesa T05 cerrada". Fix: `extendedWaitUntil` + `waitForAnimationToEnd` before the tap. Rerun PASS |
| j13-express-order | PASS after YAML fix | Everything passed; the last step assumed `header-back` from the ticket reaches the floor. It lands on the menu ("Agregar a"). Fix: second `header-back`. See bug 2 |
| j14-waiting-assign | PASS | first run |
| j15-kds-undo | PASS | first run |
| j16-manager-cash | PASS after YAML fix | Run A (open tickets present) failed at `count-pad-4`: close blocked by open tickets (data). Run B passed (register already open: open-with-float branch SKIPPED). Run C (open $500 float path, expense, close) failed at `count-pad-4` because the tap on `cash-close-btn` raced the layout; fixed with `waitForAnimationToEnd` + `extendedWaitUntil`; rerun PASS (open-float branch skipped again because C left the register open). So the open-with-float branch (`fund-pad-5`, `fund-pad-00`, `open-cash-confirm`) ran only in C and reached `cash-summary` (screenshot `caja-open.png` shows Fondo $500.00), but the full open+close sequence in one passing run is not demonstrated |
| j17-admin-reports | PASS | first run: Reportes Hoy/Semana/Mes, caja fuerte sheet |

Flows edited (selector/timing only): `j12-pay-cash.yaml`, `j13-express-order.yaml`, `j16-manager-cash.yaml`. No app code changed. Helper screenshot flows are in `flows/` (`ss_*.yaml`; they were run from `mobile/e2e/maestro/` and removed from there).
Final state: register CLOSED (J16 ended with close), no open tickets.

## 3. Screenshot index (`screenshots/`)

| Requested screen | File |
|---|---|
| Floor with timer + name tiles | `floor-timer-names.png` |
| Open-table sheet | `open-table-sheet.png` |
| Menu with Frecuentes | `menu-frecuentes.png` (Soda under "Frecuentes") |
| Pay screen, cash | `pay-cash.png` |
| Pay success | `pay-success.png`, `j12-end.png` |
| Waiting list | `waiting-list.png`, `waiting-assign-sheet.png` |
| KDS with undo snackbar | `kds-undo-snackbar.png` ("Marcado como listo" / Deshacer) |
| Manager tabs bar | `manager-resumen-tabs.png` (Resumen/Tickets/Piso/Caja/Mas) and admin variant (Resumen/Tickets/Caja/Reportes/Mas) in `mas-menu.png` |
| Resumen with Ventas (now labelled "Ventas de la sesión") | `manager-resumen-tabs.png` ($454.40 Ventas hoy) |
| Caja open state | `caja-open.png`, `caja-close-sheet.png`, `caja-closed-summary.png` |
| Reportes Hoy | `reportes-hoy.png`, `reportes-caja-fuerte.png` |
| Sistema | `sistema.png` (bug 1 fixed). Before the fix: `sistema-NOT-REACHED-lands-on-resumen.png` shows what the app displays instead |
| Other | `j1-end.png`, `j1-configurator.png`, `j13-end.png`, `j14-end.png` |

## 4. App bugs found

1. **FIXED. Admin cannot open Sistema (High).** Repro: login `admin/admin123` -> Mas -> Sistema (`more-system`, `router.push('/system')`), or `adb shell am start -a android.intent.action.VIEW -d bola8staff:///system`. Expected `screen-system`; actual: the app shows Resumen (`screen-overview`); `screen-system` never appears (uiautomator dump: only `screen-header`, `screen-overview`). `app/(manager)/(tabs)/system.tsx` exists with `href: null`; Root cause: expo-router 58 turns `href: null` into a `hidden` tab, and focusing a hidden tab redirects to the initial tab (Resumen); this also broke `/kds`, `/profile`, `/floor-view` (ADMIN). Fix: `app/(manager)/(tabs)/_layout.tsx` hides them with `tabBarItemStyle: { display: 'none' }` instead (route stays navigable). Verified with Maestro `j18-admin-more-system.yaml` (`screenshots/sistema.png`) and deep links to `/system`, `/kds`, `/profile`, `/floor-view`, `/waiting`. Original screenshot: `sistema-NOT-REACHED-lands-on-resumen.png`. The earlier release APK run had a working admin Sistema (v1).
2. **Back from a freshly sent ticket returns to the menu, not the floor (Low/UX).** Repro: J13: after "Pedido enviado", `header-back` goes to "Agregar a" (menu). A waiter needs two backs to reach the floor. Could be intended history behaviour.
3. **Pay confirm dialog tap race (Low, possibly test-only).** Tapping Confirmar while the dialog animates is ignored; no app error. Treated as a flow timing issue.

No JS exception seen in logcat (`ReactNativeJS` only the "Running main" line; only `FrameTracker` IME-animation noise at E level).

## 5. Not tested / caveats

- Flows were run on a debug build served by Metro, not on a release bundle.
- Only the 7 listed flows (plus helper screenshot flows) were run; j2-j11 and the old v1 flows were not re-run.
- Sistema screen, Reportes Semana/Mes content correctness, caja fuerte save, card/mixed payment, tips, express "Rapidos" row on the floor, waiting-list edit/delete, KDS landscape, offline behaviour: not verified in this run.
- Numbers on screen (e.g. $454.40 sales) were not reconciled against the API.
- J16 open-with-float then close in one passing run was not demonstrated (see table).
- Metro was left running on port 8081 with `adb reverse` active; the installed debug app needs it.
