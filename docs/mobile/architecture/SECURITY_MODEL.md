# Security Model - Staff Phones on Shared Wi-Fi

Status: Accepted (elaborates D3, D10, D13). Facts: `discovery/REPOSITORY_AUDIT.md` sections 4, 5, 6, 11, 12; `API_CAPABILITY_MATRIX.md` section 12 (G-numbers). Scope: the mobile app and its interaction with the existing backend. It does not re-audit the whole POS.

## 1. Assets, actors, trust boundaries

Assets: access/refresh tokens (act as the staff member), manager PINs (authorise void/qty decrease), order integrity (what the kitchen prepares), ticket data (table codes, customer names, totals), cash totals visible to manager roles.

Actors considered:
- A: patron or neighbour on the same Wi-Fi (sniffing, replay, port scanning).
- B: ex-employee or lost/stolen phone holder.
- C: another staff member overreaching their role.
- D: other apps on a staff phone.
- E: a staff member sharing a device (KDS tablet, shared phone).
- Not considered: a compromised POS host, a malicious manager, nation-state adversaries, rooted-device attackers (accepted residual).

Trust boundaries: phone <-> Wi-Fi/LAN <-> nginx :8080 <-> Flask. The phone is semi-trusted; the **server is the only authority**.

## 2. Threat table

| # | Threat (actor) | Impact | Mitigation | Residual |
|---|---|---|---|---|
| T1 | Sniff cleartext HTTP, steal access/refresh tokens, replay (A) | Act as staff for up to 8 h (access) or 7 d (refresh, never revoked, G3) | Short term: private-network URL guard, no tokens in URLs/logs, tokens in Keystore. Roadmap: HTTPS (section 3) | **HIGH until HTTPS**: cleartext + non-revocable refresh token |
| T2 | Sniff the manager PIN or `verify-pin` calls (A) | Void/discount authority | PIN only in request body, never in URL; same cleartext residual as T1 | HIGH until HTTPS |
| T3 | Join socket rooms without auth (A, G1) | Observe table codes, item names, quantities, opener id after B2; learn ticket ids and versions | B2 restricted to minimum fields (no prices/customer names); mobile treats socket as hint only | Low-medium: metadata disclosure |
| T4 | Manager-room events unreachable (G2) | Managers miss `print:failed` | B4 fixes; mobile degrades (no alerts, no crash) | Low |
| T5 | Role bypass by calling the API directly (C, A) | Any authenticated role can close tickets, change queue status, etc. (G7, G5, G6, G9) | **Server-side enforcement is the only control.** Mobile hides UI only (D10); the doc set tracks the gaps in DEPENDENCIES_AND_GAPS | Medium: several gaps are server-side and out of mobile scope |
| T6 | Lost or stolen unlocked phone (B) | Session usable until tokens expire; local drafts and cached tickets readable | Screen lock is required by the ops checklist; admin deactivates the user (refresh then fails with `USER_INACTIVE`); proposal P3 makes inactive users fail on access tokens too; logout wipes tokens and cache | Medium: up to 8 h of access token validity after deactivation (G3) |
| T7 | Stale role after demotion (C, G25) | Old privileges for up to 8 h | App re-reads `/auth/me` after every refresh and on foreground; server remains authority | Low |
| T8 | Tokens or PINs leaked via logs, crash reports, screenshots, recents thumbnail (D, E) | Credential disclosure | Section 6 | Low |
| T9 | Other app reads app data (D) | Token theft | SecureStore (Android Keystore AES key; app-private storage); `allowBackup=false`; no tokens in AsyncStorage/query cache | Low (rooted device out of scope) |
| T10 | Login brute force / lockout of staff (A) | Denial of login for everyone: 10/min shared bucket (no ProxyFix) | P1 ProxyFix; app never retries login automatically; 429 countdown | Medium operational |
| T11 | Duplicate or unauthorised order submission (C, double tap) | Wrong food, double stock deduction | Idempotency key (B1), UI locks, server authorisation unchanged | Low once B1 is deployed |
| T12 | Malicious server URL entry (phishing a staff member to a rogue host) (A) | Credentials typed into a rogue server | URL guard (private ranges; HTTPS otherwise); server identity shown in the header and login screen; admin pre-configures the URL on handover | Low-medium |

## 3. Transport: cleartext HTTP on the LAN

Current state: `http://` end to end; Android release builds need `usesCleartextTraffic` (TECH_STACK_DECISION section 6). Wi-Fi WPA2/WPA3 encryption protects against outsiders without the Wi-Fi password, but **not** against anyone who has it (staff, former staff, anyone who was told the password), and many bars share it with patrons.

Mitigation roadmap (decide a date with the owner before the real bar rollout):

| Step | What | Effort | Notes |
|---|---|---|---|
| 0 (now) | Staff-only SSID separate from patron Wi-Fi, WPA2/3 password rotated when staff leave | Ops | Cheapest, biggest risk reduction |
| 1 | HTTPS via reverse proxy with a real domain pointing to the LAN IP (DNS-01 certificate) | Small | Phones need no CA install; flip cleartext off in the app |
| 2 | HTTPS via local CA (mkcert/step-ca); Android needs a network security config trusting user CAs, and CA installed on each phone | Medium | Works without a domain; heavier phone setup |
| 3 | Self-signed with certificate pinning in the app | Medium | Rotation needs an app release |
| 4 | Backend hardening: P3 (refresh revocation on logout, inactive-user check), shorter access lifetime | Small | Reduces the value of a stolen token |

The server URL is configuration, so steps 1-3 need no app architecture change; only the URL validator and the build property change.

## 4. Token storage and session lifecycle

- Access and refresh tokens are stored **only** in `expo-secure-store` (Android Keystore). Never AsyncStorage, never zustand `persist`, never the TanStack persisted cache (the persister has a query allow-list; tokens are not queries).
- The auth store persists only the non-secret `user {id, username, name, role}` and the server URL.
- Optional hardening (not v1): `requireAuthentication` biometrics on read for MANAGER/ADMIN sessions.
- `android.allowBackup=false` so cloud backup never copies app data.
- **Logout:** call `POST /auth/logout` best effort (it blocklists the access `jti` only), then regardless of the result delete both tokens, clear the TanStack cache and persisted cache, clear draft orders after confirmation, dispose the socket. G3: the server keeps the refresh token valid for up to 7 days, so a token copied *before* logout stays usable; deletion on the device only prevents a later device holder. Proposal P3 closes this.
- Role enforcement: the app derives navigation from the `role` returned at login and `/auth/me`; it re-checks after every refresh. Unknown role -> access-denied screen (D9). All real authorisation is server-side (T5).
- Session expiry: refresh 401/422 or `USER_INACTIVE` -> automatic logout with a message. A network error during refresh never logs the user out.

## 5. Manager PIN handling (D10)

- Entered in a modal `PinDialog`: numeric keypad, `secureTextEntry`, no autofill, `expo-screen-capture` prevention active while visible.
- Held in a component `useRef` string only. Not in zustand, not in navigation params, not in the draft.
- **TanStack caveat:** `useMutation` keeps `variables` in the mutation cache. PIN-bearing actions (void, qty decrease, `verify-pin`) run through repository calls wrapped in a mutation with `gcTime: 0`, or are invoked directly without a mutation object, so the PIN never sits in a cache that devtools or a persister could read. The persister already excludes mutations.
- Sent only in the request body over the network (never URL, never headers, never logged). After the response (success or failure) the ref is overwritten with `''` and the dialog unmounts. Closing the dialog or backgrounding the app clears it.
- Not stored, not remembered, no "remember PIN". Wrong PIN -> 401 `INVALID_PIN`; the dialog shows the server message and offers retry. The 5/min `verify-pin` bucket is shared by every client behind nginx, so 429 shows a countdown and no auto-retry.
- Discount: server needs a MANAGER JWT, not the PIN (rules 81-83). The UX may ask for a PIN via `/auth/verify-pin` for parity with the web ceremony (rule 131), but must be explicit that the server does not re-check it. Do not imply security the server does not provide.

## 6. Logging, screenshots, diagnostics

- A single `logger` wrapper is the only allowed logging path. It redacts keys matching `authorization|token|pin|password|refresh` and truncates bodies. Lint rule `no-console` in `src`. Release builds strip `console.*` via the Babel preset option.
- axios interceptors never log headers or bodies. Error objects shown in the UI come from `AppError.message`, not raw responses.
- No crash reporter or analytics SDK (nothing leaves the LAN; Rule 2). Admin diagnostics screen shows server URL, health, capabilities, socket state, app version; it never shows tokens.
- `usePreventScreenCapture` on login, PIN dialog, and manager financial screens. Android also hides the recents thumbnail for those screens through the same flag.
- Error toasts for 5xx do not echo server stack traces (HTML bodies are discarded).

## 7. Shared and unattended devices

- Each staff member logs in with a personal account; the audit log depends on it. Document that sharing a phone defeats attribution.
- KDS tablets: dedicated KITCHEN_STAFF or BAR_STAFF account, Android screen pinning/kiosk, keep-awake, no manager access. If the tablet is lost, deactivate that user.
- Drafts are namespaced by user id. Logging in as a different user than the draft owner offers "discard previous user's draft"; drafts are never sent under another identity.
- Idle behaviour: no auto-lock timer in v1 (the 8 h token is the boundary). Revisit if phones are routinely left unlocked on the bar.

## 8. Backend gaps that affect mobile (not fixable in the app)

| Gap | Effect on mobile | Handling |
|---|---|---|
| G1 sockets unauthenticated | Section 2 T3 | B2 minimal payload; REST remains authoritative |
| G2 manager room never joined | Managers miss print failures | B4; graceful degradation |
| G3 refresh survives logout; deactivated user's access valid 8 h | T1, T6 | P3; deactivate user and rotate on theft; HTTPS |
| G5 queue PATCH ungated and revives VOIDED | A waiter can alter KDS state via API | B3 for VOIDED; role check is a server-side follow-up (any role may PATCH today). KDS UI is shown only to KITCHEN/BAR/MANAGER/ADMIN |
| G7 close/request-payment ungated | Waiter could close via API | D4: the app never calls `close`; server hardening is separate |
| G-ProxyFix shared bucket | All phones and the web UI share login 10/min and verify-pin 5/min; shift start with many logins, or several managers voiding items, can return 429 | P1 ProxyFix; stagger logins; 429 countdown; never auto-retry |
| G14 cost/cash summaries readable by any role | A waiter's token can read them via API | Mobile does not request them for non-manager roles |

## 9. Verification plan

- Contract tests: wrong role gets 403 where the server enforces it; socket `manager` join cases (B4); idempotency replay does not duplicate (B1).
- Unit tests: logger redaction; PIN ref cleared; auth store persists no tokens; query persister allow-list excludes tokens and mutations; URL guard cases.
- Manual: `adb shell run-as <pkg>` on a debug build confirms no tokens in `shared_prefs` outside the SecureStore blob and none in the AsyncStorage database; Wireshark/mitmproxy on the emulator confirms the cleartext residual is exactly as documented (and that PINs are only in bodies).

## 10. Residual risks

Risks that remain after the fix pass (SECURITY_REVIEW.md carries the per-finding resolution).

| ID | Residual risk | Mitigation today | Plan |
|---|---|---|---|
| SEC-01 | **Cleartext LAN traffic.** The app uses `usesCleartextTraffic` and talks plain `http://` to the POS (nginx :8080). Passwords, JWTs, refresh tokens, manager PINs and the socket `join` token cross the venue Wi-Fi unencrypted. | The URL guard (SEC-03) limits `http://` to private/LAN hosts and `https://` is accepted anywhere, so credentials never go cleartext to a public host. Use a staff-only SSID, separate from patron Wi-Fi. | Roadmap: terminate TLS on the bar machine (local CA or a reverse proxy with a certificate that the phones trust), then drop `usesCleartextTraffic` and reject `http://` in release builds. Until then the owner accepts the risk in writing. |
| SEC-06 | **Debug-keystore signing.** The local `assembleRelease` build (`scripts/mobile/build-android-release.ps1`) is signed with the Expo template's public debug keystore, so anyone can build an APK that Android installs as an update of the app. | Local/emulator use only; the script prints a warning; the APK lives in the git-ignored `mobile/dist/`. | Before any APK goes to a staff phone, re-sign with a **venue-owned keystore** (kept outside the repo, `*.jks` is git-ignored; inject the release `signingConfig` through a config plugin or `gradle.properties`). Never distribute the debug-signed build. |
| SEC-07 | **Manager PIN brute force on void / quantity-decrease.** These endpoints have no server-side rate limit (only `/auth/login` and `/auth/verify-pin` are limited). | Client-side only: after 3 consecutive `INVALID_PIN` answers the PIN pad locks for 30 s with a countdown (the counter survives closing the sheet). A modified client bypasses this. | **Recommended backend follow-up:** one shared per-user failure budget in `verify_manager_pin` (count `MANAGER_PIN_FAILED` audit rows, 429 after 5 per minute) or `@limiter.limit` on `void_item` and `update_item_quantity`. Needs ProxyFix (P1) for a meaningful IP key. |
| SEC-05 | `kitchen`/`bar`/`ticket:*` rooms remain joinable without a token (G1) and still carry table codes, item names and ticket ids. | `opened_by` was removed from the payload (B2). | Authenticate the socket in `on_connect`. |
| SEC-09/SEC-12 | The manager room accepts blocklisted / deactivated users' tokens (G25); a B1 replay ignores the request body. | Mobile locks uncertain lines so a body change cannot be silently dropped. | Backend: validate room joins like REST; store a request hash and answer 422 `IDEMPOTENCY_KEY_REUSED`. |

