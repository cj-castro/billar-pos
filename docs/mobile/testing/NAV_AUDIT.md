# Navigation header / back-button audit (Bola 8 Staff, Android)

Method: static read of every route + runtime walk on emulator-5556 (billar_mobile_api35_b, 1080x2400 @420dpi; narrow check 720x1600 @300dpi) with adb taps, uiautomator dumps and screenshots (`docs/mobile/testing/screenshots/nav-audit/`). "-" = not applicable (tab / login root). Screens marked (code) were only read, not exercised.

## The reported defect
Admin (or manager) taps the Cocina/Barra tile on Resumen -> `router.push('/queue')` -> kitchen KDS screen shown as a *pushed* screen with the kiosk header:
- custom header (logo + title + station switch + connection pill + account button) squeezed the title into ~60 px: "C..." / "0 pe-ndie-ntes" (`admin-queue-before.png`);
- no back arrow (kiosk header never had one);
- `KdsFocusEffects blockBack` swallowed hardware back unconditionally -> dead end (only escape: account icon -> Yo -> back, which is a different path).

## Results (before -> after)
| Screen | Role | Header | Back visible | Header back | HW back | Title fits |
|---|---|---|---|---|---|---|
| /queue pushed from Resumen | admin | yes | **NO -> yes** | n/a -> OK | **swallowed (trap) -> pops to Resumen** | **crushed -> fits (also 720x1600)** |
| /queue root | kitchen | yes | - (root) | - | swallowed by design (stays in app) | yes -> yes |
| /kds-me | admin, kitchen | yes | yes | OK | OK | yes |
| Cocina/Barra tab | manager | yes | - (tab) | - | exits app from tab root (Android default) | tight but fit at 1080; now switch on own row |
| Tickets, Piso, Sistema, Yo tabs, Resumen | admin/manager | yes | - (tab) | - | n/a | yes (Sistema/Yo/Piso only screenshot-checked) |
| /tickets/[id] | admin | yes | yes | OK | OK | yes |
| Floor tab | waiter | yes | - | - | leaves app (root) | yes |
| open-table sheet | waiter | sheet | close X + backdrop | OK | OK (closes) | yes |
| ticket/[id] | waiter | yes | yes | (code: canGoBack fallback) | OK | yes |
| ticket/[id]/menu | waiter | yes | yes | (code) | OK | yes |
| ticket/[id]/draft | waiter | yes | yes | (code) | OK | yes |
| configure/[itemId] sheet | waiter | sheet | (code) close/backdrop | (code) | not reached on device | (code) |
| setup, login, denied, Ready, Yo (waiter) | - | - | - | - | **not exercised** (code only; no pushed-without-back found) | - |
| bar_staff root | - | - | - | - | not exercised (same component as kitchen) | - |

## Fixes
- `mobile/src/components/ScreenHeader.tsx`: title column `minWidth: 0` (ellipsizes instead of crushing), right slot and new `leading` slot `flexShrink: 0`, new `subtitleTestID`.
- `mobile/src/features/kitchen/KdsScreen.tsx`: the non-tab KDS header now reuses `ScreenHeader` (back arrow only when the screen is pushed, logo as `leading`); the station switch moved to its own row under the header instead of sharing the row with title/pill.
- `mobile/app/(kitchen)/queue.tsx`: hardware back is swallowed only on the kiosk root, not when pushed.
- `mobile/src/utils/useCanGoBack.ts` (new): `router.canGoBack()` read after mount (a render-time read is false for a freshly pushed route; first attempt had exactly that bug and showed no arrow).
- Tests: `mobile/src/components/__tests__/ScreenHeader.test.tsx` (new, 2 tests); KdsScreen test router mock gained `canGoBack`.

## Verification
`npm test` 458/458 (35 suites), `npm run typecheck` clean, `npm run lint` clean. Release APK rebuilt after the last change (includes the serverConfig `.ts.net` change): `mobile/dist/bola8-staff-0.1.0-local.apk`, reinstalled on emulator-5556; admin Resumen -> Cocina verified at 1080 and 720x1600: arrow visible, tap and hardware back both return to Resumen, title "Cocina / 0 pendientes" fits (`*-after*.png`). Kitchen root re-verified: no arrow, hw back keeps app open.

## Open / not verified
- Configurator sheet, setup, login, denied, Ready, bar_staff, manager floor/profile pushed variants not exercised on device after the change.
- Manager Cocina/Barra tab after the switch-row change not re-screenshotted.
- Resumen screen keeps a continuous animation, so uiautomator dumps fail there; those checks used screenshots.
- Narrowest check was 384dp wide, not a very small phone.
- Kitchen/bar kiosk root: hw back is intentionally swallowed (spec K-01); there is no way to exit besides the home button.
