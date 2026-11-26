# iOS test results: Jest + Maestro flows on the simulator

Date: 2026-11-06. Branch `feature/mobile-ios`. No app code or backend code was changed; only Maestro YAML.

## Environment

| Item | Value |
| --- | --- |
| Xcode | 26.6 (17F113) |
| Simulator | iPhone 17 Pro, iOS 26.5, UDID `D4E25880-92A1-4D2E-B500-7381D6016023` |
| macOS | 27.3 |
| Maestro | 2.12.1 (Java 17), `MAESTRO_DRIVER_STARTUP_TIMEOUT=300000` |
| App | Expo dev build `com.bola8.staff`, Metro on 8081 |
| Backend | local Flask on `localhost:8090`, DB `billiardbar_mobile` (the `billiardbar` DB was not touched) |
| Server entered in the app | `localhost:8090` (the iOS simulator shares the host network; `10.0.2.2` is Android-only) |

## Jest

`cd mobile && npx jest`: **59 suites, 619/619 tests passed** (8.6 s, no retry needed). Only a watchman recrawl warning and the usual "worker failed to exit gracefully" notice.

## Maestro flows (iOS simulator)

Command: `maestro --device D4E25880-92A1-4D2E-B500-7381D6016023 test <flow>`, run in `mobile/e2e/maestro`.

| Flow | Result | Notes |
| --- | --- | --- |
| `j1-waiter-order` | PASS | Floor, T05, mandatory Wing Flavor configurator, Soda, send. Cards picked by name on iOS (menu ids differ per DB). |
| `j12-touch-targets-waiter` | PASS | Login-only helper. The host-side `uiautomator dump` touch-target audit that follows it on Android does not exist on iOS; not run. |
| `j12-pay-cash` | PASS | Cobrar, Efectivo, Exacto, Confirmar, "cerrada". Needs the open ticket left on T05 by j1. |
| `j13-express-order` | PASS | Rapido ticket, Soda, send, back to the floor. |
| `j14-waiting-assign` | PASS | Waiting list entry, assign to T06, lands on menu. |
| `j15-kds-undo` | PASS | Kitchen marks a line Listo, undo, long-press the logo. Needs a fresh Chicken Wings line on the KDS (from j1). |
| `j16-manager-cash` | PASS | Run twice: once with the register already open (expense, close, diff) and once from the closed state (open with float 500, expense, close). |
| `j17-admin-reports` | PASS | Reportes tab, week and month presets, safe sheet. |
| `j18-admin-more-system` | PASS | Más, Sistema. |

All nine passed on the final YAML. Not run (out of scope): j2 to j11 and the legacy `*-flow.yaml` files; they still use `10.0.2.2` and `hideKeyboard` and were not converted.

## YAML changes and why

Everything is platform-conditional (`runFlow` with `when: platform:`) or a shared subflow. There are no forked iOS copies. Android paths keep their original steps.

1. `_login.yaml`
   - Server URL: Android keeps `${SERVER}` (`10.0.2.2:8090`); iOS types `${IOS_SERVER}` (default `localhost:8090`, overridable with the flow env).
   - After `clearState` the iOS app auto-discovers a POS on the LAN (port 8080) and skips the setup screen, landing on login with that server. On this network it found a POS at `192.168.1.22:8080`. The flow now waits for `server-input|change-server|splash-change-server`, taps change-server when needed, and always ends up on setup. This stops the test credentials from being sent to a server we did not intend to use. On iOS the setup field is prefilled, so `eraseText: 60` runs before typing.
   - After login on iOS, dismisses the system "Save Password?" sheet (`Not Now`, optional).
   - Login submit: on iOS the Return key (`returnKeyType="go"`) already submits, so the explicit `login-submit` tap runs on Android only.
2. `_hide-keyboard.yaml` (new subflow): Android `hideKeyboard`; iOS `pressKey: Enter`. Maestro's `hideKeyboard` fails on iOS ("Couldn't hide the keyboard"), and a keyboard left open covers bottom buttons, so Maestro taps the keyboard instead (this typed a stray `/` into the server field). Used by `_login`, j14, j16.
3. `j1`, `j13`: menu cards. Android keeps `menu-item-<uuid>`; iOS taps by name (`Chicken Wings.*`, `Soda.*`). The uuids are per database and the local DB has different ones. (A `-e` override does not work: values in the flow's `env:` block win over `-e`.)
4. `j14`: the waiting-list assertion uses `.*Familia Ruiz.*` on iOS, because iOS merges the card texts into one accessibility element.
5. `j15`: KDS row taps use `.*Chicken Wings.*` on iOS for the same reason.
6. `j16`, `j17`, `j18`: tab bar taps use `<Name>, tab.*` on iOS (iOS labels tabs like `Más, tab, 6 of 9`). The bare regex `Más.*` tapped the wrong element.
7. `j16` (both platforms): the "pad" was replaced by text input. `fund-pad-5`/`fund-pad-00` and `count-pad-4/5/0` no longer exist; `AmountPad` in `CashScreen.tsx` is now a decimal text field with testID `fund-pad` / `count-pad`. The old flow would fail on Android too. It now does `tapOn id: fund-pad`, `inputText: 500` (and `count-pad`, `450`). This is the only change that alters Android steps, and it is a fix for flow/app drift, not an iOS adaptation. It was not run on Android here.
8. `j16` iOS only: `scrollUntilVisible` with `centerElement: true` before tapping `cash-close-btn`. The default scroll stops when the button is within the screen bounds but still under the tab bar, so a plain tap hit the Piso tab.

## Known flakiness and environment issues

- **XCUITest runner launches suspended (state `T`).** On this host the Maestro driver never starts: `maestro-driver-iosUITests-Runner` sits stopped and Maestro times out ("iOS driver not ready in time") even at 180 s and 420 s. Sending `SIGCONT` to the runner resumes it immediately. Workaround used for every run above (background loop):
  ```bash
  while true; do for p in $(pgrep -f "maestro-driver-iosUITests-Runner$"); do
    case "$(ps -o stat= -p $p)" in T*) kill -CONT $p;; esac; done; sleep 1; done
  ```
  Also `pkill -f "xcodebuild test-without-building"` between failed attempts. Root cause not investigated (a host load average of 17 to 30 from Spotlight/ANE after the reboot may contribute).
- **Simulator first-run keyboard sheet** ("Type English and Spanish", Continue) appears the first time the keyboard opens after a simulator reboot and blocks input; tap Continue once manually. Not handled in YAML.
- **Auto-discovery** (above): never rely on `clearState` leaving the server field empty on iOS.
- **Stateful flows.** j1 leaves an open ticket on T05 (j12-pay-cash needs it; rerunning j1 requires T05 free or `force-close`), j14 leaves a seated ticket on T06, j15 needs a fresh kitchen line, j16 needs no open tickets to close. Order used: j12-touch, j1, j15, j12-pay-cash, j13, j14, j17, j18, j16 (force-closing leftover tickets via the API before j16).
- **Decimal-pad keyboards have no Return key.** `pressKey: Enter` worked in the j16 amount fields here (the flows passed), but a layout where a bottom button is hidden behind the keyboard would need a different dismiss step.
- Maestro's `tapOn` regexes are matched against combined iOS accessibility labels; exact-text selectors written for Android often fail on iOS.

## Test data state left behind

Cash register closed (j16 closed it), no open tickets (T05, T06 and express tickets were force-closed), the j14 waiting-list entry is SEATED; users from `backend/seed.py` unchanged. Restart with `scripts/mobile/start-local-backend.sh` if a clean DB is needed.
