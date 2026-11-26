# Test Strategy - Mobile POS Companion (Bola 8 Staff)

Status: strategy and inventory. Written from the repo state on 2026-11-05. Items marked **PLANNED** do not exist yet. Items marked **EXISTS** were confirmed by listing the files in the worktree. Results go in `TEST_RESULTS.md` (written later by others; see section 10).

Principles (from `PROJECT_STATE.md` D12 and `TECH_STACK_DECISION.md` section 7):
- Prefer the **real local backend** over HTTP mocks. The mock repository adapter exists only for unit tests and the demo mode (D13).
- The server is the authority. Tests assert server behaviour and the UI's reaction to it, never client-computed totals (D3).
- Nothing leaves the LAN. No test may call an external service.

---

## 1. Test pyramid

```
                 E2E (manual emulator journeys -> Maestro later)     7 journeys, section 6
              ----------------------------------------------------
           Visual checks (screenshots vs design prototypes)          section 7
        ----------------------------------------------------------
     Contract (Jest node project -> real local backend :8090)       PLANNED, section 4
   -------------------------------------------------------------
  Backend live (python -m tests.test_mobile_extensions_live)        EXISTS, section 5
 ---------------------------------------------------------------
  Component / integration (RNTL + mock repositories)                 EXISTS (partial)
-------------------------------------------------------------------
  Unit (jest-expo: client, config, stores, utils, routing)           EXISTS
```

| Level | Runner | Lives in | Status | Runs against | Speed |
|---|---|---|---|---|---|
| Unit | jest-expo (`preset: jest-expo`) | `mobile/src/**/__tests__/` | EXISTS | Nothing external | seconds |
| Component | RNTL `^14.1.0` | `mobile/src/components/__tests__/`, `mobile/src/test/__tests__/` | EXISTS (partial) | Mocks | seconds |
| Backend live | `python -m tests.test_mobile_extensions_live` | `backend/tests/` | EXISTS | Local docker `billarmobile` | about a minute |
| Contract | Jest `node` project | `mobile/src/test/contract/` | **PLANNED** (dir and script absent) | Local docker `:8090` | about a minute |
| E2E | Maestro (preferred) or manual | `mobile/e2e/maestro/` | **PLANNED** (dir absent). Manual journeys only | Emulator `billar_mobile_api35` at `10.0.2.2:8090` | minutes |
| Visual | Manual screenshot diff | `docs/mobile/testing/screenshots/`, `docs/mobile/design/prototypes/screenshots/` | EXISTS (assets only) | Emulator | manual |
| Bar network | Manual, scripted steps | `docs/mobile/integration/REAL_BACKEND_VALIDATION.md` | Plan only | Bar LAN, real data | supervised shift |

Commands that exist today (run from `mobile/`):

```bash
npm test              # jest (preset jest-expo, setup jest.setup.ts)
npm run typecheck     # tsc --noEmit
npm run lint          # expo lint (eslint-config-expo)
```

`jest.setup.ts` mocks `@react-native-community/netinfo` (netinfo-mock) and `expo-secure-store` (in-memory store, so tests can assert nothing sensitive persisted).

---

## 2. Unit tests (EXISTS)

| Module | Test file | What it covers |
|---|---|---|
| API client | `src/api/__tests__/client.test.ts` | Error normalisation (`ApiError` kinds, HTML/`{msg}`/`{error}` bodies), 401 single-flight refresh, no logout on network blip |
| Server config | `src/config/__tests__/serverConfig.test.ts` | URL normalisation (scheme, trailing slash, pasted `/api/v1`), health validation outcomes |
| Auth store | `src/state/__tests__/authStore.test.ts` | Tokens only in SecureStore; user only in AsyncStorage; logout clears SecureStore, user key and query cache (journey 7) |
| Socket | `src/realtime/__tests__/socket.test.ts` | Event -> query-key invalidation map, room list per role (`roomsForRole`) |
| Role routing | `src/auth/__tests__/roleRouting.test.ts` | Role -> route group; unknown role -> denied (D9); `canAccess` guard (unauthorised operation restriction, journey 5) |
| Money | `src/utils/__tests__/money.test.ts` | Integer-cent formatting, es-MX MXN. Verifies `Intl` on Hermes (`TECH_STACK` section 5) |
| Modifiers | `src/utils/__tests__/modifiers.test.ts` | Min/max selection rules (US-W-06), client-side enforcement (N3) |
| Error messages | `src/utils/__tests__/errorMessage.test.ts` | Server code -> Spanish message; unknown codes -> generic (US-X-08) |
| Theme tokens | `src/theme/__tests__/tokens.test.ts` | `tokens.json` (copy of `docs/mobile/design/tokens.json`) is in sync and typed |

Rules for new unit tests:
- Logger redaction (`authorization|token|pin|password|refresh`) is **PLANNED** (SECURITY_MODEL section 6). Add when the logger exists.
- PIN ref cleared after submit: **PLANNED** with the PIN dialog (`SECURITY_MODEL` section 5).
- Query persister allow-list excludes tokens and mutations: **PLANNED** with D-10 (persister not wired yet).
- Age colour boundaries 4:59 / 5:00 / 9:59 / 10:00 (US-K-02): **PLANNED** with the KDS slice.
- Draft line reducer (`draft` -> `sending` -> `sent` / `failed`, locked states, retry rules from `NETWORKING_AND_SYNC.md` section 3): **PLANNED** with the order-draft feature.

---

## 3. Component and integration tests (EXISTS, partial)

| Test file | Covers |
|---|---|
| `src/components/__tests__/components.test.tsx` | Shared UI kit rendering (buttons, chips, cards) |
| `src/components/__tests__/ConfirmDialog.test.tsx` | Confirm/cancel behaviour (used for request bill, cancel empty, logout with drafts) |
| `src/components/__tests__/PinPad.test.tsx` | Keypad input, digit limit |
| `src/test/__tests__/login.test.tsx` | Login form: submit, error display, disabled button while in flight (US-X-03) |

Test helpers: `src/test/utils.tsx` (`render` wrapper with `SafeAreaProvider`, `QueryClientProvider`, i18n). Use it for every screen test.

Still needed (PLANNED, with the feature slices):
- Duplicate-tap guard: second tap during an in-flight mutation is a no-op (`NETWORKING_AND_SYNC.md` section 3, layers 1-3).
- Offline banner states: DEMO > offline > reconnecting > none (`NETWORKING_AND_SYNC.md` section 7).
- Waiter floor: INACTIVE resources hidden; empty state text (US-W-01).
- KDS: advance buttons disabled when socket down > 30 s (US-K-06).
- Modifier group disables Add until `min_selections` met (US-W-06).

---

## 4. Contract tests (PLANNED)

Purpose: prove the **shipped** `src/api` and `src/repositories` code talks correctly to the real backend, including the RN/XHR DELETE-with-body path and the B1-B4 extensions. Source of the suite list: `INTEGRATION_STRATEGY.md` section 3.

Current state (checked):
- No `mobile/src/test/contract/` directory.
- No `test:contract` script in `mobile/package.json`. Scripts are `start`, `android`, `ios`, `test`, `lint`, `typecheck`.
- The variable name differs between docs: `INTEGRATION_STRATEGY.md` says `POS_API_URL`; the brief for this work says `CONTRACT_BASE_URL`. **Pick one before writing the suite** and document it in `mobile/README.md`.

Planned shape:
- A separate Jest project: `testEnvironment: node`, `maxWorkers: 1`, file pattern `*.contract.test.ts`.
- Base URL from env, default `http://localhost:8090`. Emulator-side runs use `http://10.0.2.2:8090` (Maestro/adb).
- Allow-list guard: refuse to run unless the host is `localhost`, `127.0.0.1` or `10.0.2.2`, or `POS_CONTRACT_I_KNOW=1` is set. The `smoke` tag (read-only) is the only subset allowed on the bar machine.
- Each suite creates and cleans up its own data. No reliance on pre-existing tickets.

| Suite | Asserts | Capability tag |
|---|---|---|
| health | `GET /health` 200 `{status:"ok"}`; `api_features` shape if present | smoke |
| auth | Login per role; `/me`; refresh; logout then access token rejected; refresh still works (documents G3); bad credentials -> 401 `INVALID_CREDENTIALS`; 429 shape (run last) | smoke (login only) |
| error shapes | 404 HTML, 401/422 `{msg}`, `{error,message}`, `{error}` only -> normaliser maps all | - |
| catalog | resources, menu (categories, items, modifiers), settings, stock-check shapes | smoke |
| cash and tickets | Manager opens cash; waiter opens table; double-open -> 409 `RESOURCE_OCCUPIED`; add item -> 201 SENT; request-payment; cancel empty ticket | mutating |
| void and qty (PIN) | `DELETE /items/<id>` **with JSON body** works through axios on RN/XHR path and via Node; wrong PIN -> 401 `INVALID_PIN`; `verify-pin` 5/min | mutating |
| queue | PATCH SENT -> IN_PROGRESS -> READY -> SERVED; VOIDED line -> 409 `ITEM_VOIDED` (B3) | mutating, `@b3` |
| idempotency | Same key twice -> one line, second 200; same key different content -> 409 `IDEMPOTENCY_KEY_REUSED`; no second stock deduction (compare `stock-check`); bad key -> 422 `INVALID_IDEMPOTENCY_KEY` | mutating, `@b1` |
| socket | Connect via `/socket.io` (websocket and polling); join `floor`; `kitchen:item_update` payload has B2 fields; `manager` join without token / waiter token -> `error`; manager token -> `joined` (B4) | `@b2`, `@b4` |

Tagged tests (`@b1`..`@b4`) are reported **skipped: capability absent**, not passed, when the target lacks the capability. A run against a fully extended backend must show zero skips.

Rate-limit caveat (`PROJECT_STATE.md` section Blockers, `BAR_MACHINE_REQUIREMENTS.md` section 9):
- Login is 10/min and `verify-pin` 5/min, shared by all clients on that backend (no ProxyFix).
- Reuse tokens across suites: log in once per role in a `beforeAll` and cache the tokens for the run.
- Put the 429 test last. It exhausts the bucket for about a minute.

Verified limits of the current backend tests (reference): `backend/tests/test_mobile_extensions_live.py` runs 29 checks (the BACKEND_EXTENSIONS evidence) and uses long-polling because the Python socket client lacks `websocket-client`. It does **not** cover the mobile HTTP client.

---

## 5. Backend live test (EXISTS)

```bash
cd backend
python -m tests.test_mobile_extensions_live
```

- Covers B1 (idempotent add, stale `X-Ticket-Version` ignored on replay, invalid key 422), B2 (`kitchen:item_update` fields and values), B3 (`ITEM_VOIDED` 409 and no status change), B4 (manager join, waiter denied).
- Creates a ticket, force-closes it at cleanup.
- Target URL: the script's own base-URL setting. This review did not read the file header, so **confirm the variable and default before running**. Do not point it at the bar machine (it mutates data).
- Other suites in `backend/tests/` (close_required_total, manifest_baseline, modifier_promotions, money_columns, pool_free_time, promo_time_window, promotions) are backend business-rule tests. They are out of mobile scope. `modifier_promotions` fails inside the container because `scripts/` is not in the image (pre-existing, per `BACKEND_EXTENSIONS.md`).

---

## 6. E2E journeys (manual now, Maestro later)

Status: `mobile/e2e/` does not exist. Maestro is **unverified on this Windows host** (`TECH_STACK_DECISION.md` section 7). Until flows exist, run the journeys by hand on `billar_mobile_api35` against `http://10.0.2.2:8090` and record results in `TEST_RESULTS.md`.

Emulator setup and commands: `docs/mobile/architecture/LOCAL_DEV_ENVIRONMENT.md`.

The seven mandatory journeys:

| # | Journey | Steps (summary) | Automated coverage today | Manual / E2E step | Bar validation ref |
|---|---|---|---|---|---|
| J1 | Waiter login -> table -> items -> send | Setup URL, login `waiter1`, open table, add 3 items, Send, verify 3 SENT lines | Login: `login.test.tsx`. Client: `client.test.ts`. Idempotency: backend live test + contract (PLANNED) | Full manual run; send once and check `ticket_line_items` count | T-14, T-16, T-17 |
| J2 | Chef login -> receive -> status | Login `kitchen`, KDS shows J1's items, advance SENT -> IN_PROGRESS -> READY | Queue PATCH: backend live (READY only) + contract queue suite (PLANNED) | Manual KDS run; advance all three statuses | T-30, T-32 |
| J3 | Waiter sees updated status | With J1 ticket open on waiter phone, chef sets READY, waiter gets banner and chip updates | Socket map: `socket.test.ts`. B2 payload: backend live. Ready notify handler: PLANNED | Manual: two phones, banner timing <= 3 s | T-23, T-24 |
| J4 | Manager login -> ops state | Login `manager`, Ops shows cash, open count, queue counts, oldest item age | Role routing: `roleRouting.test.ts`. Endpoint shapes: contract catalog/cash (PLANNED) | Manual: compare numbers with web dashboard | T-39, T-41 |
| J5 | Unauthorized role restricted op | Waiter opens manager/admin route, and waiter calls a manager endpoint | Route guard: `roleRouting.test.ts` (`canAccess`). Server 403: contract (PLANNED). Manager room denied: backend live (B4 waiter case) | Manual: type the manager URL route, check denied screen; no API call beyond `/auth/me` (US-X-05) | T-29, T-46 |
| J6 | Network interruption and recovery | Airplane mode during draft send and during KDS action; restore; check banner, blocked actions, no auto-send | NetInfo mock in `jest.setup.ts`. Socket reconnect: `socket.test.ts` (partial). Blocked-mutation behaviour: PLANNED | Manual, section 8 | T-18, T-19, T-21, T-34, T-48 |
| J7 | Logout and re-login | Logout (with and without unsent draft), relaunch, log in as the same and a different user | `authStore.test.ts` (tokens, user, cache cleared). Draft per-user keying: PLANNED | Manual: relaunch shows login, not a restored session | T-10, T-11 |

Known blockers to J1-J3 and J6 (from `PROJECT_STATE.md` workstreams and `REAL_BACKEND_VALIDATION.md` section 0): waiter, KDS and manager slices are marked "next"; mutation network mode (D-1); reachability (D-2); persister (D-10). Expect these journeys to fail until those land. Record a fail with the reason, do not skip.

### 6.1 Manual emulator commands

```powershell
$adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
& $adb shell cmd connectivity airplane-mode enable      # J6 airplane on (verify on this emulator image)
& $adb shell cmd connectivity airplane-mode disable     # J6 off
& $adb shell svc wifi disable                           # J6 Wi-Fi only (verify)
& $adb shell svc wifi enable
& $adb shell am force-stop com.bola8.staff              # J7 relaunch test / draft persistence (T-16 analogue)
& $adb shell monkey -p com.bola8.staff 1                # relaunch
& $adb logcat -c; & $adb logcat -d | Select-String 'ReactNativeJS|bola8'   # JS logs, check for token leaks (redaction)
```

The airplane and svc commands were not run in this review. Verify each on the emulator image before relying on it.

---

## 7. Visual validation (EXISTS as assets, manual comparison)

| Asset | Location |
|---|---|
| Shell screenshots from the built app (file names: 01-setup, 02-login, 03-waiter-home, 04-yo, 05-yo-fixed-header; content of 04/05 not reviewed here) | `docs/mobile/testing/screenshots/shell/` |
| Design prototypes, 17 HTML screens | `docs/mobile/design/prototypes/*.html` |
| Prototype screenshots | `docs/mobile/design/prototypes/screenshots/` (01-server-setup ... 17-splash, plus `index.png`) |
| Tokens | `docs/mobile/design/tokens.json` (copied to `mobile/src/theme/tokens.json`; the unit test checks it) |

Method:
1. Take an emulator screenshot per screen: `adb exec-out screencap -p > <file>.png` (PowerShell: pipe into a file, mind the encoding).
2. Compare with the matching prototype screenshot by number. Check layout, colours from tokens, Spanish strings, and the banners.
3. Record a deviation list in `TEST_RESULTS.md`, not a pass/fail on pixels. Font rendering and status-bar height differ between emulator and prototype.
4. Check the `elevation` cards: they render on Android only. iOS needs shadow props (see `IOS_READINESS.md`).

Contrast: `docs/mobile/design/check-contrast.mjs` exists. Run it against tokens when colours change.

---

## 8. Role authorization tests

Three layers, each with a different owner:

| Layer | What it proves | Where |
|---|---|---|
| UI routing | Each role lands on its group; unknown role -> denied; the guard blocks deep links | `roleRouting.test.ts` (EXISTS) |
| Server enforcement | Wrong role gets 403 where the server enforces it; waiter token rejected from manager socket room | Contract (PLANNED), backend live B4 case (EXISTS) |
| Known server gaps (not fixable in the app) | G5 queue PATCH ungated, G7 close and request-payment ungated, G14 cost summaries readable by all roles | `SECURITY_MODEL.md` section 8. Record as "server gap" in results, not as app pass |

The app hides controls only (D10). A passing UI test does not prove authorisation. Always pair a UI check with a server check.

---

## 9. Network-failure tests

Source: `NETWORKING_AND_SYNC.md` sections 7-9, `ACCEPTANCE_CRITERIA.md` US-X-06, US-X-10, US-W-08.

| Case | Method | Expected |
|---|---|---|
| Airplane mode before a send | Emulator airplane on, Send | Blocked with reason; draft kept; nothing sent on reconnect (D-1 today: may fail) |
| Connection drops mid-send | Turn Wi-Fi off after line 1 returns | Per-line states; retry with same keys; no duplicate (`alarm` query in `REAL_BACKEND_VALIDATION.md` section 8) |
| POS restarts during a request | `docker compose restart backend` on the local stack during a request (local only) | nginx 502 treated as retryable for GET; mutation shows "server unavailable" |
| LAN with no internet | Emulator with DNS off but backend reachable | Still online (D-2 today: may fail) |
| Background > 30 s | Home button, wait, return | Visible screen refetches (US-X-10). 30 s disconnect not implemented yet |

Server-side duplicate check (local stack):

```powershell
docker compose -p billarmobile exec -T postgres psql -U billiard -d billiardbar -c `
  "SELECT ticket_id, client_request_id, COUNT(*) FROM ticket_line_items WHERE client_request_id IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1;"
```

Expect zero rows.

---

## 10. Results

Results are not recorded in this document. They are written to:

- **`docs/mobile/testing/TEST_RESULTS.md`** (to be written later by the test owner; this file does not exist yet).

Use the results template in `docs/mobile/integration/REAL_BACKEND_VALIDATION.md` section 9 for bar runs. For local runs, one row per journey (J1-J7) plus one row per automated command with its pass count.

---

## 11. What is NOT covered

| Gap | Why | Mitigation |
|---|---|---|
| Real bar network (AP behaviour, client isolation, Wi-Fi roaming, real firewall) | No bar access | `REAL_BACKEND_VALIDATION.md` on site |
| iOS (any test) | No Mac | `docs/mobile/ios/MAC_SETUP.md`, `IOS_READINESS.md` |
| Print agent hardware and ESC/POS output | No printer on this host (E4) | Owner check on site; chit counts via DB |
| Load and concurrency beyond two-to-three phones | Single gunicorn worker; no load rig | Keep the concurrency checks in `REAL_BACKEND_VALIDATION.md` section 8; treat as smoke only |
| Long-running stability (multi-hour shifts, battery) | Time and devices | Pilot observation; battery optimisation checklist |
| Rooted devices, MITM on the LAN | Out of scope (`SECURITY_MODEL.md` section 1) | Accepted residual; HTTPS roadmap |
| Real push or background alerts | Out of scope (no push in v1) | Foreground-only test cases |
| Release signing and store behaviour | Local builds only (D2) | Install test only |
| Accessibility (screen reader) | Not in the current test plan | Add a TalkBack pass before pilot if the owner requires it |

---

## 12. Adding a test: checklist

- [ ] Unit or component test next to the module (`__tests__/`), no network
- [ ] Anything that needs the backend goes to the contract project (once it exists), not into unit tests
- [ ] Mutating tests create their own data and clean up
- [ ] Capability-dependent tests are tagged `@b1`..`@b4`, not silently passed
- [ ] Journey impact recorded in section 6 table above
- [ ] Results go to `TEST_RESULTS.md`, not into this file

## Related

- `docs/mobile/integration/REAL_BACKEND_VALIDATION.md`
- `docs/mobile/integration/INTEGRATION_STRATEGY.md`
- `docs/mobile/product/ACCEPTANCE_CRITERIA.md`
- `docs/mobile/architecture/SECURITY_MODEL.md`
- `docs/mobile/architecture/LOCAL_DEV_ENVIRONMENT.md`
