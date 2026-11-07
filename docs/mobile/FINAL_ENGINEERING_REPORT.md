# Bola 8 Staff (Android mobile POS companion) - Final Engineering Report

Date of evidence: 2026-11-05. Written strictly from repo contents (docs, scripts, test logs, git history). Anything without cited evidence is marked NOT VERIFIED.

Status legend used throughout:

| Tag | Meaning |
|---|---|
| **VERIFIED** | Implemented and verified by a recorded run (command output, Maestro log, screenshot, API check) |
| **IMPL-UNVERIFIED** | Implemented in code, not fully verified (unit tests only, or a path not exercised end to end) |
| **SIMULATED** | Verified only against the local Docker backend (`billarmobile`) and Android emulator, not the real bar |
| **BLOCKED** | Needs resources not available to this work (bar machine, admin rights, Mac, physical devices) |
| **NOT IMPLEMENTED** | Not built (deferred or out of scope) |

Important framing: every runtime result below was obtained against a **local Docker copy of the backend and an Android 15 x86_64 emulator**. Nothing was run against the real bar machine, real network, or a physical phone. So "VERIFIED" means "verified in the local simulated environment" unless stated otherwise.

---

## 1. Worktree, branch, commits

- Worktree: `D:/Projects/Code/billar-pos-worktrees/mobile-pos-companion`
- Branch: `feature/mobile-pos-companion`, based on `main` @ `4e4430ff`. HEAD `35ba5b3c`. Never pushed (no upstream).
- Working tree was clean before this report was added (`git status --short` empty).
- Diff vs base: 446 files changed, 97,864 insertions, 8 deletions (`git diff --stat 4e4430ff..HEAD`).

| Commit | Subject |
|---|---|
| 9acb6b59 | discovery, product docs, local env scripts, backend extensions B1-B4 |
| a8c241d9 | architecture docs and ADRs |
| fb0c7ed0 | design system, tokens, screen inventory, flows, HTML prototypes + screenshots |
| 98fd7a1a | Expo SDK 58 foundation (config, auth, API client, socket, i18n, routing, tests) |
| 53e1caf5 | UI kit, navigation shell, screen-to-code mapping, Android debug build script |
| 7161f29b | bar-machine requirements, real-backend validation plan, iOS handoff, test strategy |
| a0127117 | waiter, KDS (kitchen/bar), manager and admin vertical slices |
| 1d97bbb9 | Restore reference data lost in baseline squash (migration 003) |
| 5c32e26f | independent security and code review reports |
| b77474aa | fix pass for security and code review findings |
| 7d3ac634 | final QA evidence (E2E journeys on release APK, visual validation) |
| 35ba5b3c | fix QA UI defects (keyboard-aware configurator, branded splash/icon, KDS landscape columns, reconnect banner, toast position) |

## 2. Original repository architecture (brief)

Source: `docs/mobile/discovery/REPOSITORY_AUDIT.md`, `API_CAPABILITY_MATRIX.md`.

- Flask + Flask-SocketIO + PostgreSQL backend, REST under `/api/v1`, JWT (8 h access, refresh token) auth, roles WAITER / KITCHEN_STAFF / BAR_STAFF / MANAGER / ADMIN.
- React 18 / TypeScript web POS (zustand, TanStack Query, socket.io-client, i18next es/en) served through nginx; only nginx `:8080` is published on the bar machine.
- Backend authority: totals, pool charges, payment rules are server-side. Known gaps G1-G26 are catalogued in `discovery/DEPENDENCIES_AND_GAPS.md` (e.g. unauthenticated socket rooms, no idempotency on item add, queue PATCH without transition guard, rate limits keyed on `remote_addr` with no ProxyFix).
- Print agent and scheduler are separate; not touched.

## 3. Selected mobile technology and rationale

Expo SDK 58 / React Native 0.88.1 / React 19.3 / TypeScript, Expo Router, TanStack Query 5, zustand, axios, socket.io-client, i18next, expo-secure-store. Package `com.bola8.staff`. Decision records: `architecture/TECH_STACK_DECISION.md`, `architecture/ADR/ADR-001..006`.

Why: highest reuse of the web stack's TS logic and i18n bundles (weighted score 87/100 vs Capacitor 80, bare RN 79, Flutter 65, native 58, KMP 54 in the decision doc; these are the team's own estimates, not measurements); one codebase for Android and later iOS; builds from the command line on Windows (JDK 21 + Android SDK, no Android Studio). Local builds only (ADR-002): no EAS cloud, no store publishing.

## 4. Implemented features by role

Status key: VERIFIED (V) = seen in a recorded run on the release APK against the local backend (so also SIMULATED w.r.t. the real bar); IMPL-UNVERIFIED (U) = implemented, covered by unit/contract tests only or partly exercised; NOT IMPLEMENTED (N). Evidence from `testing/TEST_RESULTS.md` journeys J1-J8.

### All roles

| Feature | Status | Evidence |
|---|---|---|
| Server URL setup + `/health` validation, default port 8080, private-host guard | V | J8b (unreachable shown, valid URL connects); unit tests `serverConfig.test.ts`, `setup.test.tsx` |
| Login (invalid credentials handled) | V | J8a |
| Session restore, single-flight token refresh | U | token refresh/expiry in the field NOT VERIFIED |
| Role routing + access-denied | V | J5a, J5b |
| Offline banner, reconnect (airplane mode) | V | J6 |
| LAN-without-internet handling (fix C1) | U | unit tests only; emulator always had a route |
| Logout (clears tokens, cache, drafts), user switch | V | J7 |
| Spanish UI | V (visible in all captures) | |
| English toggle | U | ES/EN switch NOT VERIFIED on device |
| Error normalisation (HTML / `{msg}` / 429 shapes) | U | unit tests |

### Waiter

| Feature | Status | Evidence |
|---|---|---|
| Floor overview (Libre / Ocupada / Cuenta solicitada / Inactiva) | V | `final/02-floor-waiter.png`, J1 |
| Open table | V | J1 |
| Menu browse/search, configurator with mandatory modifier, qty, notes | V | J1 (blocked when mandatory choice missing, `06b`) |
| Local draft + explicit Send, per-line Idempotency-Key, no duplicates | V for normal send (J1, J6; each line exactly once per API); U for in-flight failure + retry ("No se envio") | in-flight failure NOT exercised |
| Ready list + mark served | V | J3. Realtime toast to an already logged-in waiter NOT VERIFIED |
| Request bill with confirm | U | not pressed in final QA (slice-phase screenshots only: `screenshots/waiter/13,14`) |
| Cancel empty ticket | U | unit tests; not in E2E |
| Void item / decrease qty / discount / transfer with manager PIN | U | PIN sheet display only (`15-manager-pin`); PIN success/failure NOT VERIFIED |
| Payment / close ticket | N (by design D4) | stays on the bar POS |

### Kitchen / Bar

| Feature | Status | Evidence |
|---|---|---|
| KDS queue (portrait; landscape 3 columns), age colours, advance status | V (kitchen) | J2 (IN_PROGRESS confirmed by API, no screenshot) |
| Bar-staff station flow | U | not in final E2E; slice-phase screenshots `kitchen/kds-bar-*` only |
| Stale warning, disabled advance when disconnected, clock-skew correction | U | unit tests |
| Keep-awake for KDS | N | `expo-keep-awake` absent |

### Manager / Admin

| Feature | Status | Evidence |
|---|---|---|
| Ops overview (tickets, pending bills, queues, cash status) | V | J4 matched API values |
| Open tickets, read-only floor, KDS tabs | V (tabs open) / U (ticket detail) | manager-ops-flow |
| Admin diagnostics (health ms, websocket status) | V | `final/12-admin-diagnostics.png` |
| Admin settings mutation | U | `screenshots/admin/settings-confirm.png` (slice phase) |
| Manager PIN actions, discounts, cash close | U / NOT VERIFIED | |

## 5. Implemented screens

Source: `implementation/SCREEN_TO_CODE_MAPPING.md` (all rows DONE) cross-checked with E2E evidence. Status here: V = seen on the release APK in final QA; U = implemented and unit-tested, not captured in final QA.

| Screen ID | Route | Status |
|---|---|---|
| SCR-AUTH-00 splash/boot | `app/index.tsx` | V (native cold splash `17-splash-cold-fixed`); in-app "Restaurando tu sesion" state not captured |
| SCR-AUTH-01 server setup | `app/setup.tsx` | V |
| SCR-AUTH-02 login | `app/login.tsx` | V |
| SCR-X-01 access denied | `app/denied.tsx` | V |
| SCR-X-02 fatal error boundary | root `ErrorBoundary` | U (list-error screen not captured) |
| SCR-X-03 profile / Yo | `(waiter)/(tabs)/me`, `(manager)/(tabs)/profile`, `(kitchen)/kds-me` | V (waiter), U (others) |
| SCR-W-01 floor | `(waiter)/(tabs)/floor` | V |
| SCR-W-07 open table | `(waiter)/open-table/[resourceId]` | V |
| SCR-W-02 ticket detail | `(waiter)/ticket/[ticketId]/index` | V |
| SCR-W-03 menu | `(waiter)/ticket/[ticketId]/menu` | V |
| SCR-W-04 configurator | `(waiter)/ticket/[ticketId]/configure/[itemId]` | V (keyboard defect fixed, `final/fixed/20`) |
| SCR-W-05 draft/send | `(waiter)/ticket/[ticketId]/draft` | V |
| SCR-W-06 ready list | `(waiter)/(tabs)/ready` | V |
| OV-01 manager PIN pad | modal in `TicketExtras` | V (display only) |
| OV-02 ready toast | `useReadyNotifications` in `(waiter)/_layout` | U |
| SCR-K-01 KDS queue | `(kitchen)/queue` | V (kitchen) |
| SCR-M-01 ops overview | `(manager)/(tabs)/overview` | V |
| SCR-M-02 open tickets | `(manager)/(tabs)/tickets`, `tickets/[ticketId]` | tab opened; detail U |
| SCR-M-03 floor (read-only) | `(manager)/(tabs)/floor-view` | tab opened |
| SCR-M-04 KDS view | `(manager)/(tabs)/kds` | tab opened; Cocina/Barra toggle behaviour NOT VERIFIED |
| SCR-A-01 system/diagnostics | `(manager)/(tabs)/system` (ADMIN only) | V |

ADMIN lives in the `(manager)` group (decision R1); there is no `(admin)` group.

## 6. Design and mockup locations

- Design system, tokens, components: `docs/mobile/design/DESIGN_SYSTEM.md`, `tokens.json`, `COMPONENT_CATALOG.md`, `DESIGN_DECISIONS.md`, `check-contrast.mjs`.
- Flows and states: `design/ROLE_BASED_USER_FLOWS.md`, `SCREEN_INVENTORY.md`, `SCREEN_STATE_MATRIX.md`, `NAVIGATION_ARCHITECTURE.md`, `design/mockups/*.md`.
- 17 HTML prototypes + index: `design/prototypes/*.html`; screenshots in `design/prototypes/screenshots/*.png`.
- Claude Design was **not used** (D11 / ADR-006): prototypes were produced locally as HTML/CSS.
- Product: `docs/mobile/product/` (FEATURE_PRIORITIZATION, USER_STORIES, ACCEPTANCE_CRITERIA, ROLE_FEATURE_MATRIX).

## 7. API integration status

Existing endpoints used (from SCREEN_TO_CODE_MAPPING): `GET /api/v1/health`; `POST /auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/verify-pin`; `GET /resources`, `/tickets/pending-payment`, `/tickets/open-all`; ticket open / add-item / serve / request-payment; `GET /menu/categories`, `/menu/items`; `GET/PATCH /queue/{kitchen|bar}` and `/queue/counts`; `GET /cash/status`; settings read/write (admin). Realtime via Socket.IO rooms `floor`, `kitchen`, `bar`, `manager`.

Deliberately not called: `send-order` (dead endpoint, G24), `/reprint` (G4), close/payment endpoints (D4), `/cash/current/summary` (G14).

Backend extensions (see `integration/BACKEND_EXTENSIONS.md`). **All are local only. None is deployed to the bar machine; they must be deployed (image rebuild + apply-migrations, after a backup) before they take effect there.** The app feature-detects B1/B2 and degrades without them (verification stop instead of a duplicate).

| ID | Change | Status |
|---|---|---|
| B1 | `Idempotency-Key` on `POST /tickets/<id>/items` (migration `002_line_item_client_request_id.sql`: nullable column + partial unique index); replay returns 200 with the existing line; response adds `ticket_version` | VERIFIED locally (backend live test, contract tests, J1/J6 API checks); not deployed |
| B2 | `item_update` / `item_status` socket payloads add `ticket_id, resource_code, menu_item_name, quantity`. `opened_by` was **removed** in the fix pass (SEC-05); the app matches OPEN tickets it owns instead | VERIFIED locally; not deployed |
| B3 | `PATCH /queue/<item>/status` returns 409 `ITEM_VOIDED` for voided items | VERIFIED locally; not deployed. A general forward-only transition guard is NOT implemented (finding M7) |
| B4 | Socket `join` of room `manager` now joins after token/role check | VERIFIED locally; not deployed |
| Migration 003 | Restores reference data dropped by baseline squash 2b72b157 | VERIFIED locally on a clean DB; not deployed (section 16) |
| `.gitattributes` | `*.sh` forced to LF so a Windows checkout does not break `entrypoint.sh` | in repo |

## 8. Local emulator and build results

| Item | Result | Source |
|---|---|---|
| Emulator | AVD `billar_mobile_api35`, `emulator-5554`, Android 15, x86_64, 1080x2400 @420dpi, headless; AVD stored in `D:\android-avd` | TEST_RESULTS section 1 |
| Local backend | Docker compose project `billarmobile` (postgres, backend, frontend), `http://localhost:8090`; emulator uses `http://10.0.2.2:8090` | `scripts/mobile/start-local-backend.ps1` |
| Debug APK | built, needs Metro: `mobile/dist/bola8-staff-debug.apk`, 135,982,775 bytes (older build) | `build-android-debug.ps1` |
| Release APK | `mobile/dist/bola8-staff-0.1.0-local.apk`, 56,078,743 bytes (53.5 MB), x86_64 + arm64-v8a, installed on the emulator, runs without Metro | TEST_RESULTS section 8 |
| Windows long-path workaround | private CMake 3.22 + ninja 1.13.2 at `E:\b8\cmake322`, written into `android/local.properties` by the scripts | `mobile/README.md` |
| Physical device | NOT VERIFIED (arm64 slice built, never run) | |

The build environment is specific to this workstation (E:\ and D:\ tool paths). Elsewhere, pass `-CmakeDir` / set `BOLA8_CMAKE_DIR`, or use a short project path.

## 9. Test results

Counts are as recorded in `testing/TEST_RESULTS.md` and the `CODE_REVIEW.md` Resolution section. I did **not** re-run the suites while writing this report.

| Layer | Command | Result |
|---|---|---|
| Unit / component | `npm test` in `mobile/` | 34 suites, **443 / 443 passed**. Jest prints a "worker failed to exit gracefully" warning (timer leak, not traced; deferred) |
| Typecheck | `npx tsc --noEmit` | clean |
| Lint | `npx expo lint` | clean |
| Contract (real local backend) | `npm run test:contract` | 3 suites, **56 / 56 passed** |
| Backend live (B1-B4) | `python -m tests.test_mobile_extensions_live` | ends `ALL PASSED`, 0 FAIL. Pass counts differ between docs: 29 (BACKEND_EXTENSIONS first run), 31/31 (fix-pass note), 30 PASS lines (QA count). The test was extended during the fix pass; no failure anywhere |
| E2E (Maestro 2.12.1, release APK) | `mobile/e2e/maestro/j*.yaml` | Journeys J1 order, J2 chef, J3 serve, J4 manager overview, J5a/b role denial, J6 offline recovery, J7 logout/switch, J8a/b negative setup/login: **all PASS** per TEST_RESULTS. `manager-ops-flow.yaml` all steps completed. After the final UI fix round only `waiter-order-flow.yaml` (T02), the kitchen login flow and the KDS landscape capture were re-run; the other journeys were not re-run on the final APK |

Caveats recorded in TEST_RESULTS:
- J2: IN_PROGRESS step confirmed by API + hierarchy text, no screenshot.
- J3: realtime toast/badge while already logged in NOT exercised.
- J6: only "send disabled while offline, send after reconnect"; in-flight send failure and retry NOT exercised.
- Maestro intermittently reports `device offline` on `clearState` launches; re-running succeeds.
- Not verified at all: TalkBack/accessibility, font scaling, light theme, multi-device concurrency, manager PIN success/failure, discounts, request-bill, print, bar-staff station flow.

## 10. Verified screenshots

Root: `docs/mobile/testing/screenshots/`

- `final/` (release APK, final QA): `01-server-setup`, `02-floor-waiter`, `02-login`, `02b-floor-waiter2`, `02c-login-invalid-credentials`, `03-open-table`, `04-ticket-empty`, `04b-ticket-sent`, `04c-ticket-ready-chip`, `04d-ticket-served`, `05-menu`, `06-configurator-mandatory`, `06b-configurator-missing-choice`, `06c-configurator-chosen`, `07-draft-review`, `07b-unsent-draft-waiter1`, `08-ready-list`, `09-kds-portrait*`, `09c-kds-ready`, `10-kds-landscape*`, `11-manager-overview`, `12-admin-diagnostics`, `13-offline-draft`, `13b-offline-after-send`, `13c-reconnected`, `13d-sent-after-reconnect`, `14-setup-unreachable`, `15-manager-pin`, `15a-void-confirm-dialog`, `16-access-denied`, `16b-kitchen-denied-floor`, `17-logout-with-drafts-dialog`, `17-splash-cold*`, `18-waiter2-no-draft`, `19-line-actions`, `20-notes-keyboard-open`, `21-setup-keyboard-open`, `22-login-keyboard-open` (all `.png`).
- `final/fixed/` (after the last fix round): `04b-ticket-sent-toast`, `10-kds-landscape`, `15-manager-pin`, `17-splash-cold-fixed`, `20-notes-keyboard-open`.
- Earlier slice-phase captures (not final-QA evidence): `waiter/`, `kitchen/`, `manager/`, `admin/`, `shell/`, `release/`.
- Maestro logs: `docs/mobile/testing/logs/maestro/*.log` (19 files; several are failed first attempts kept next to the passing re-runs).
- Prototype comparison images: `design/prototypes/screenshots/`.

## 11. Remaining defects and limitations

### Code-review findings still open or deferred (`testing/reviews/CODE_REVIEW.md`, Resolution)

| ID | Sev | Status |
|---|---|---|
| C1 offline on LAN without internet | Critical | Fixed (unit tests; real no-internet LAN NOT VERIFIED) |
| H1, H2 duplicate guard without B1 / editable ambiguous lines | High | Fixed (unit tests) |
| M1 X-Ticket-Version with B1 can cause false "verify" stops | Medium | Won't fix, accepted (needs two concurrent edits) |
| M5 foreground "x items ready" summary | Medium | Deferred (core ownership fix done) |
| M7 stale tap can move an item backwards | Medium | **Deferred** (needs server forward-only transition guard) |
| M11 Jest open-handle warning | Medium | Deferred (assertion fixed; warning remains) |
| L1 duplicated floor-state logic | Low | Deferred |
| L5 login 429 countdown | Low | Deferred (double-submit guard done) |
| L6 AppState background disconnect / proactive refresh | Low | Deferred |
| L9 KDS thresholds 10/20 min vs AC 5/10 min | Low | Deferred (product decision needed) |
| L10 dead code | Low | Deferred |
| Test gaps still open | - | boot() cold start, AppState foreground refetch, double-tap on Servido, 429 login countdown |

### Security findings still open or deferred (`testing/reviews/SECURITY_REVIEW.md`, Resolution)

| ID | Sev | Status |
|---|---|---|
| SEC-01 cleartext HTTP/WS | High | Won't fix this pass (needs TLS on the bar machine); only mitigated by a private-network URL guard (SEC-03) |
| SEC-05 B2 broadcast to unauthenticated rooms | Medium | Partly fixed (`opened_by` removed); socket authentication deferred |
| SEC-06 debug-keystore signing, debuggable debug APK | Medium | Deferred; no production keystore created |
| SEC-07 manager PIN brute force on void/qty | Medium | Client cooldown only (3 wrong -> 30 s); server limiter deferred |
| SEC-09 manager room accepts revoked/deactivated tokens | Low | Deferred |
| SEC-10 queued retries after logout | Low | Refresh part fixed; retry replay deferred |
| SEC-11 deep-link params unencoded in API paths | Low | Deferred ("needs verification") |
| SEC-12 B1 replay ignores body | Low | Client-side lock only; server request-hash deferred |
| SEC-14 no screenshot/recents protection | Low | Deferred (needs `expo-screen-capture`) |
| SEC-16 role refreshed only at cold boot | Info | Deferred |
| SEC-18 discount PIN is UX only (any manager PIN passes) | Info | Deferred |

Residual security risks, stated plainly:
1. **Cleartext LAN HTTP.** Passwords, JWTs, refresh tokens, manager PINs and the socket join token cross venue Wi-Fi unencrypted. Anyone on the staff Wi-Fi can sniff them.
2. **Debug-keystore signing.** The release APK is signed with the Expo template's public debug keystore; anyone can build an APK that installs as an update of this app. Not for staff phones.
3. **Refresh token is not revoked server-side on logout** (gap G3). A stolen refresh token stays usable (7 days per SECURITY_MODEL); the app only wipes its local copy.
4. **Unauthenticated socket rooms** (`floor`, `kitchen`, `bar`, `ticket:*`) stay joinable by any LAN client (G1); they still carry table codes, item names and ticket ids.

### Other limitations

- Visual leftovers: "Marcar servido" button sits about 9 px from the line card (open); notes field bottom border slightly clipped (cosmetic); ES/EN toggle 48 dp not re-measured on device; touch-target audit covered only the floor, Listos and Yo tabs.
- `mobile/README.md` is stale: it still says P0 screens are placeholders and launcher icons are Expo placeholders. Both are no longer true; `SCREEN_TO_CODE_MAPPING.md` and this report are current.
- No offline mutation queue by design (ADR-005): Send requires connectivity.
- No payment/close in the app by design (D4).

## 12. Dependencies requiring bar-machine access (all BLOCKED, none executed)

Source: `integration/BAR_MACHINE_REQUIREMENTS.md`, `REAL_BACKEND_VALIDATION.md`.

| Need | Why | Who |
|---|---|---|
| Windows Firewall inbound rule TCP **8080**, **Private** profile | Phones cannot reach nginx otherwise. Needs administrator. Not changed | Bar owner / admin |
| DHCP reservation (or static IP) for the POS host | The app stores a fixed URL; IP drift breaks every phone | Network admin |
| Wi-Fi client isolation off on the staff SSID | Isolated clients cannot reach the POS | Network admin |
| Deploy backend changes: rebuild image + `apply-migrations` (B1-B4, migrations 002 and 003) after a backup | Without B1 the duplicate guard falls back to "verify" stops; without B2 ready notifications fall back to refetch | Developer on site |
| Per-staff accounts and PINs; rotate default credentials (local seed users are test data) | Needed for real use | Bar owner |
| ProxyFix (or equivalent) so rate limits are per client | Login 10/min and verify-pin 5/min are shared by every phone behind nginx; shift-start logins can lock out staff. UNVERIFIED at runtime | Developer on site |
| Venue-owned signing keystore | Re-sign the APK before it goes on staff phones | Developer |
| Run the real-backend validation plan | Real network, latency, print agent, real data | Developer + staff |

## 13. iOS compatibility and Mac setup

- Nothing was built or run on iOS (no Mac). Status: **NOT IMPLEMENTED / BLOCKED**.
- Pointers: `docs/mobile/ios/IOS_READINESS.md` (library matrix, gaps, validation checklist mirroring the Android journeys, effort) and `docs/mobile/ios/MAC_SETUP.md` (toolchain, prebuild, ATS and local-network config, device steps).
- Readiness gaps: ATS cleartext exception and `NSLocalNetworkUsageDescription` not configured (blocking for any iOS run); Android-only `elevation` styling (visual); Keychain survives uninstall (hygiene); keep-awake and screen-capture decisions open.
- Estimate in the readiness doc: about 4-6 engineer days plus Mac and device availability (an engineering estimate, not measured).
- Doc drift to fix before the Mac session: MAC_SETUP section 9.

## 14. Commands to run the Android app

Run from the worktree root unless noted.

```powershell
# Backend (isolated docker project "billarmobile", http://localhost:8090; dev-only secrets)
pwsh scripts/mobile/start-local-backend.ps1
pwsh scripts/mobile/stop-local-backend.ps1

# Check Android toolchain
pwsh scripts/mobile/check-android-env.ps1

# Emulator (AVD stored in D:\android-avd)
emulator -avd billar_mobile_api35 -no-window      # omit -no-window for a visible window

# Build debug APK (needs Metro at run time) -> mobile/dist/bola8-staff-debug.apk
pwsh scripts/mobile/build-android-debug.ps1        # -Clean regenerates android/
# Build standalone release APK -> mobile/dist/bola8-staff-0.1.0-local.apk
pwsh scripts/mobile/build-android-release.ps1      # -Prebuild after changing app.config.ts

# Install
adb -s emulator-5554 install -r mobile/dist/bola8-staff-0.1.0-local.apk

# Metro (debug build only)
cd mobile ; npx expo start
```

In the app, enter the server URL `http://10.0.2.2:8090` (emulator to host). Seed users: `waiter1`, `waiter2`, `kitchen`, `barstaff`, `manager`, `admin` (passwords come from the local seed and are not reproduced here).

```bash
# Tests (from mobile/)
npm test                 # 443 unit/component tests
npx tsc --noEmit ; npx expo lint
npm run test:contract    # 56 tests against the real local backend (docker must be up)
# Backend live (from backend/)
python -m tests.test_mobile_extensions_live
# Maestro (JDK 21; Maestro at D:\tools\maestro-dl\maestro\bin on PATH)
maestro --device emulator-5554 test --test-output-dir <dir> mobile/e2e/maestro/j1-waiter-order.yaml
```

Pace login-heavy flows (rate limit 10/min); save YAML flows as UTF-8. Script parameters are documented in the `.ps1` headers. The `emulator` line is the standard Android SDK invocation; it is not scripted in the repo.

## 15. APK location

- Path: `mobile/dist/bola8-staff-0.1.0-local.apk` (inside the worktree).
- Size: 56,078,743 bytes (53.5 MB); sha256 begins `e1b3d3aa9f0c0de56d0e`; ABIs x86_64 + arm64-v8a; versionName 0.1.0.
- **Gitignored** (`mobile/.gitignore`: `dist/`). It is in no commit; rebuild with the release script.
- **Signing caveat:** signed with the public Expo debug keystore. LOCAL/EMULATOR USE ONLY. Do not install on staff phones until re-signed with a venue-owned keystore kept outside the repo.
- Only the emulator install was tested.
- `bola8-staff-debug.apk` (136 MB, debuggable, older build) is also in `dist/`; do not distribute.

## 16. Safety confirmation

Orchestrator-verified facts (carried verbatim):

- Main checkout `D:/Projects/Code/billar-pos` is still at `4e4430ff` (= origin/main); its pre-existing untracked dirs (`.planning/`, `e2e/`, `electron/`, `installer/`) are untouched.
- Branch `feature/mobile-pos-companion` has no upstream (never pushed).
- No remote deployment, no app-store publishing, no EAS cloud builds. Only the local Docker project `billarmobile` and local emulators were used.
- One stray empty file `d:\tmp_ready.cjs` was created by an agent outside the worktree; deletion was blocked by a safety check. **The user should delete it manually.**
- Temp build tools remain at `E:\b8\cmake322` (private CMake 3.22 + ninja 1.13.2 used by the build scripts) and Maestro at `D:\tools\maestro-dl`.
- Clean-install defect found in the existing repo: migration squash `2b72b157` dropped reference data (fixed by migration 003 on this branch). Production is likely unaffected (it applied 027..039 incrementally before the squash). Verify on the bar machine with `SELECT count(*) FROM movement_event_types;` (expect 14). Details: `integration/DB_REFERENCE_DATA_FINDING.md`.

---

## Definition-of-Done checklist

The original mandate section 16 text is not in the repo, so this checklist is built from the project's stated scope (PROJECT_STATE D1-D13 and the task brief). Marks: ✅ done and evidenced (in the local environment), ⚠️ NOT VERIFIED (built or partly evidenced, gap remains), ⛔ BLOCKED (needs external resources).

| # | Item | Mark | One-line reason |
|---|---|---|---|
| 1 | Isolated worktree/branch, main checkout untouched | ✅ | Orchestrator-verified; main at 4e4430ff |
| 2 | Repository discovery and gap analysis documented | ✅ | `docs/mobile/discovery/*` |
| 3 | Product scope, stories, acceptance criteria, prioritisation | ✅ | `docs/mobile/product/*` |
| 4 | Technology chosen with rationale and ADRs | ✅ | TECH_STACK_DECISION + ADR-001..006 |
| 5 | Design system, mockups, prototypes | ✅ | 17 HTML prototypes + tokens (Claude Design not used) |
| 6 | Local backend + emulator environment working | ✅ | `billarmobile` on :8090, AVD API 35 |
| 7 | Waiter flow (open table, menu, modifiers, send, serve) | ✅ | J1, J3 on release APK, API-confirmed (local) |
| 8 | Waiter extras (void/discount/transfer with PIN, request bill, cancel empty) | ⚠️ NOT VERIFIED | Unit tests only; PIN success/failure and request-bill not run in final QA |
| 9 | Kitchen KDS flow | ✅ | J2; landscape layout fixed and captured |
| 10 | Bar-staff KDS station flow | ⚠️ NOT VERIFIED | Only slice-phase screenshots; not in final E2E |
| 11 | Manager overview and role isolation | ✅ | J4, J5a, J5b |
| 12 | Manager PIN actions, discounts, cash | ⚠️ NOT VERIFIED | PIN sheet display only |
| 13 | Admin diagnostics | ✅ | `12-admin-diagnostics.png`, health 16 ms |
| 14 | No duplicate orders (idempotency) | ✅ | B1 live tests, J1/J6 API checks (in-flight failure path untested) |
| 15 | Offline / reconnect behaviour | ⚠️ NOT VERIFIED | Airplane path passes (J6); LAN-without-internet and in-flight failure untested on device |
| 16 | Realtime ready notification to a logged-in waiter | ⚠️ NOT VERIFIED | Not exercised live; no multi-device test |
| 17 | Unit / contract / backend-live suites green | ✅ | 443/443, 56/56, backend live ALL PASSED (docs differ on count: 29/30/31) |
| 18 | E2E on release APK, mandatory journeys | ✅ | J1-J8 pass; most not re-run on the final APK after UI fixes |
| 19 | Independent code and security review with fix pass | ✅ | Both reports have Resolution sections |
| 20 | High/Critical review findings closed | ⚠️ NOT VERIFIED | SEC-01 (High, cleartext) open; C1/H1/H2 fixed with unit tests only |
| 21 | Standalone installable release APK | ✅ | 56 MB APK runs on emulator without Metro |
| 22 | APK safe for staff phones | ⛔ BLOCKED | Debug-keystore signed; needs venue keystore |
| 23 | Install/run on a physical Android device | ⛔ BLOCKED | No device used; arm64 slice never run |
| 24 | Validation on real bar network and data | ⛔ BLOCKED | Needs bar-machine access |
| 25 | Backend extensions deployed to bar machine | ⛔ BLOCKED | Local only; needs deploy + migrations |
| 26 | Firewall rule, DHCP reservation, Wi-Fi isolation, ProxyFix | ⛔ BLOCKED | Admin/network access required, not executed |
| 27 | HTTPS / TLS transport | ⛔ BLOCKED | Needs TLS at nginx; cleartext remains |
| 28 | Print agent / pre-bill printing | ⚠️ NOT VERIFIED | Not pressed or tested |
| 29 | Accessibility (TalkBack, font scaling) | ⚠️ NOT VERIFIED | Not tested; touch targets partly audited |
| 30 | iOS build and run | ⛔ BLOCKED | No Mac; handoff docs written (IOS_READINESS, MAC_SETUP) |
| 31 | Docs current and traceable (PROJECT_STATE, mapping, report) | ✅ | Updated; `mobile/README.md` still stale (noted) |
| 32 | No remote side effects (push, deploy, EAS, store) | ✅ | Orchestrator-verified |

Tally (32 items): ✅ 17, ⚠️ NOT VERIFIED 8, ⛔ BLOCKED 7.
