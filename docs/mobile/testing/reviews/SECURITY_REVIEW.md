# Security Review - Bola 8 Staff mobile app + backend extensions B1-B4

Reviewer: independent AppSec review (code-first; docs used only to compare claims against code).
Date: 2026-11-05. Branch: `feature/mobile-pos-companion`.
Scope: `mobile/` (excluding `node_modules/`, `android/`, `ios/`; the generated `android/` was read only to check the effective manifest/gradle output), `mobile/app.config.ts`, backend code for B1 (`backend/app/api/tickets.py` `add_item`), B2/B3 (`backend/app/api/queue.py` `update_status`), B4 (`backend/app/sockets/events.py`).
Method note: per the "no git commands" rule, the backend diff `4e4430ff..HEAD` was not run. The changed backend code was located from `docs/mobile/integration/BACKEND_EXTENSIONS.md` and read directly. Known gaps G1-G26 are reported only where the mobile app or B1-B4 make them worse or rely on them.

## Summary

| ID | Severity | Title | File:line |
|---|---|---|---|
| SEC-01 | High | Cleartext HTTP/WS enabled app-wide: passwords, JWTs, refresh tokens, manager PINs, socket join token sent unencrypted over venue Wi-Fi | `mobile/app.config.ts:40`; `mobile/android/app/src/main/AndroidManifest.xml:14` |
| SEC-02 | Medium | Changing the server URL does not end the session: stored access and refresh tokens are later sent to the new host | `mobile/app/index.tsx:66`, `mobile/app/setup.tsx:48-51`, `mobile/src/config/serverConfig.ts:63-68`, `mobile/app/_layout.tsx:28` |
| SEC-03 | Medium | No private-network / HTTPS guard on the server URL (SECURITY_MODEL T1/T12 mitigation not implemented) | `mobile/src/config/serverConfig.ts:14-23` |
| SEC-04 | Medium | Order drafts survive logout and user switch, are not owner-namespaced, and can be sent under the next user's identity | `mobile/src/features/waiter/draft/draftStore.ts:43,106`; `mobile/src/state/authStore.ts:77-84` |
| SEC-05 | Medium | B2 broadcasts order stream + staff user ids + ticket ids to unauthenticated `kitchen`/`bar` rooms | `backend/app/api/queue.py:108-117` |
| SEC-06 | Medium | Distribution artefacts: debuggable debug APK in `dist/`; release variant signed with the public debug keystore | `mobile/android/app/build.gradle:115`; `mobile/dist/bola8-staff-debug.apk` |
| SEC-07 | Medium | (Pre-existing backend, relied on by mobile) Manager PIN is brute-forceable via void / qty endpoints: no rate limit | `backend/app/api/tickets.py:589-620, 674-676` |
| SEC-08 | Low | Wrong manager PIN (401 INVALID_PIN) triggers a token refresh and an automatic resend of the PIN; a failed refresh logs the user out | `mobile/src/api/client.ts:133-137` |
| SEC-09 | Low | B4 manager-room join accepts revoked (logged-out) and deactivated users' access tokens | `backend/app/sockets/events.py:20-33` |
| SEC-10 | Low | Refresh / retry is not bound to the session: a late refresh re-persists a token after logout; queued retries run after logout | `mobile/src/api/client.ts:107-127, 133-137`; `mobile/src/state/authStore.ts:67-70` |
| SEC-11 | Low | Route params from deep links are interpolated unencoded into API paths (Needs verification) | `mobile/src/api/endpoints/tickets.ts:4-5`; `mobile/src/api/endpoints/ticketOps.ts:16`; scheme `bola8staff` (`AndroidManifest.xml:28`) |
| SEC-12 | Low | B1 replay ignores the request body; editing an ambiguous FAILED line keeps its key, so the server replays the old line and the app reports success | `backend/app/api/tickets.py:418-423`; `mobile/src/features/waiter/draft/DraftScreen.tsx:169` |
| SEC-13 | Low | Unneeded Android permissions in the release manifest (SYSTEM_ALERT_WINDOW, READ/WRITE_EXTERNAL_STORAGE) | `mobile/android/app/src/main/AndroidManifest.xml:3-6`; `mobile/app.config.ts:16-25` |
| SEC-14 | Low | No screenshot / recents-thumbnail protection on login and PIN screens (SECURITY_MODEL section 6 claim not implemented) | `mobile/src/components/PinPad.tsx`; `mobile/app/login.tsx`; `mobile/package.json` |
| SEC-15 | Info | `allowBackup="true"` contradicts SECURITY_MODEL (effective backup scope is small) | `AndroidManifest.xml:14` |
| SEC-16 | Info | UI role refreshed only at cold boot (doc T7 says after every refresh and on foreground) | `mobile/src/auth/boot.ts:19-23` |
| SEC-17 | Info | Idempotency key: CSPRNG UUID, but silent `Math.random` fallback | `mobile/src/features/waiter/uuid.ts:4-15` |
| SEC-18 | Info | Discount PIN is UX only (any manager PIN passes; server does not re-check) and the UI does not say so | `mobile/src/features/waiter/ticket/TicketExtras.tsx:245-251` |

Counts: Critical 0, High 1, Medium 6, Low 7, Info 4.

Verified OK (no finding): tokens only in `expo-secure-store` (`authStore.ts:57-61`), AsyncStorage holds only the non-secret user `{id, username, name, role, is_active, has_pin, created_at}` (matches `backend/app/models/user.py:32-41`), server URL and language; no `console.*` anywhere in `src/` or `app/`; `ApiError` keeps only status/code/message, never config/headers/body (`client.ts:7-55`); UI error text is localized, never raw server text (`utils/errorMessage.ts:34-40`); PIN never stored, not in zustand/query cache/mutation variables/navigation params, digits cleared on submit and on unmount (`PinPad.tsx:56-59`, `TicketExtras.tsx:131-135`), sent only in request bodies; query cache cleared on login, logout and session expiry; socket disconnected when the user goes null (`_layout.tsx:17-29`); refresh is single-flight and network/5xx errors do not log out; `/system` is guarded inside the screen against deep links (`SystemScreen.tsx`, `role !== 'ADMIN'` -> `/denied`); group guards cover every role group; refresh tokens carry no `role` claim, so they cannot join the manager room; no DEMO/mock adapter in app code (only an unused `OfflineBanner kind="demo"` string); dependencies match the documented stack, `test-renderer` is the legitimate RNTL peer, only `@parcel/watcher` and `fsevents` have install scripts; B1 uses ORM-parameterised queries, `re.fullmatch` key validation, row lock + unique-index IntegrityError fallback; B3 rejects VOIDED before writing or emitting.

---

## SEC-01 - High - Cleartext transport enabled app-wide

**Evidence** (`mobile/app.config.ts:37-40`; effective manifest `AndroidManifest.xml:14` has `android:usesCleartextTraffic="true"`):
```ts
// LAN-ONLY: the POS backend is plain http:// on the venue LAN (nginx :8080).
// Android blocks cleartext by default, so we opt in. ROADMAP: terminate TLS
usesCleartextTraffic: true,
```
`serverConfig.ts:17` defaults any input to `http://`. Over this channel the app sends: login password, access token (8 h), refresh token (7 d, not revoked on logout, G3), manager PINs in void/qty/verify-pin bodies, and the access token inside the socket `join` payload (`socket.ts:103`).

**Expected behaviour.** Credentials and bearer tokens never cross Wi-Fi unencrypted. If cleartext must stay for a pilot, it is limited to the one POS host, and an accountable owner signs off on the risk. The flag is global here: it permits cleartext to any host, not just the LAN POS. SECURITY_MODEL rates T1/T2 HIGH until HTTPS, so this is a documented risk, but the app adds several Wi-Fi clients that send these secrets where the web POS may have had none.

**Recommended correction.**
1. Before rollout: TLS at nginx with a real domain resolving to the LAN IP (DNS-01 cert; SECURITY_MODEL section 3 step 1). Then drop `usesCleartextTraffic` and reject `http://` in `normalizeServerUrl` for release builds.
2. Interim: replace the global flag with a `network_security_config.xml` via a small config plugin: `<base-config cleartextTrafficPermitted="false">` plus a `<domain-config cleartextTrafficPermitted="true"><domain>192.168.x.y</domain></domain-config>` for the configured POS host.
3. Ops: a staff-only SSID separate from patron Wi-Fi (step 0). Record a written risk acceptance with an end date.

**Effort.** S for the interim network config, M for TLS (nginx + DNS + app flag flip).

## SEC-02 - Medium - Server URL change keeps the session; tokens leak to the new host

**Evidence.** The splash screen offers "change server" after 3 s, after `hydrate()` has already loaded the tokens (`boot.ts:15-16`, `index.tsx:66`):
```tsx
<AppButton label={t('setup.change')} ... onPress={() => router.replace('/setup')} />
```
`setup.tsx:48-51` and `serverConfig.ts:63-68` only overwrite the URL:
```ts
const onContinue = async () => { await saveServerUrl(value); router.replace('/login'); };
```
Nothing clears `accessToken`/`refreshToken` in memory or in SecureStore. The socket effect depends on `[userId, role]` only (`_layout.tsx:28`), so it stays on the old host. On the next cold start `boot()` calls `GET {newHost}/api/v1/auth/me` with the old `Authorization: Bearer <access>`. If that host answers 401, the client sends the **refresh token** to it as well (`client.ts:113-116`). The new host only has to return `{"status":"ok"}` from `/api/v1/health` to be accepted.

**Expected behaviour.** Credentials are bound to the origin that issued them. A URL change ends the session first.

**Recommended correction.** In `saveServerUrl` (one place, all callers route through it): if the normalized URL differs from `current`, call `useAuthStore.getState().logout()` (or a local-only clear when offline) and `disconnectSocket()` before persisting. Defence in depth: persist the issuing origin next to the tokens (`bola8.tokenOrigin` in SecureStore) and have the request interceptor drop the `Authorization` header when `getServerUrl() !== tokenOrigin`. Add `getServerUrl` to the realtime effect dependencies.

**Effort.** S.

## SEC-03 - Medium - No private-network / HTTPS guard on the server URL

**Evidence** (`serverConfig.ts:14-23`): any `http(s)` host is accepted, public or private:
```ts
if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
...
const m = /^(https?):\/\/([^\s/?#:@]+)(?::(\d{1,5}))?$/i.exec(s);
```
SECURITY_MODEL T1 and T12 list "private-network URL guard (private ranges; HTTPS otherwise)" as an implemented mitigation. It is absent. The only server identity check is `/health` returning `{"status":"ok"}`, which any phishing host can fake.

**Expected behaviour.** `http://` is accepted only for RFC 1918 / link-local / `10.0.2.2` / `localhost` literals. Any other host requires `https://`.

**Recommended correction.** After the regex in `normalizeServerUrl`, when `m[1] === 'http'` require that the host matches `^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)` or is `localhost`. Otherwise return null and show a new `setup.errInsecure` message. Add cases to `config/__tests__/serverConfig.test.ts`. Together with SEC-02 this blocks the "rogue host" scenario in T12.

**Effort.** S.

## SEC-04 - Medium - Drafts persist across logout/user switch and can be sent as another user

**Evidence.** The store is keyed by ticket only and persisted in AsyncStorage (`draftStore.ts:43, 105-109`):
```ts
byTicket: Record<string, DraftLine[]>;
...
name: 'bola8.waiter.drafts', version: 1, storage: createJSONStorage(() => AsyncStorage),
```
`logout()` (`authStore.ts:77-84`), `login()` and `onSessionExpired` never touch the draft store (`clearAll` has no callers). After waiter A logs out on a shared phone, waiter B opens the same table: A's unsent lines show (`TicketDetailScreen.tsx:58`) and B's "Enviar" posts them under B's JWT. Audit and `ITEM_ADD` attribution then name B. SECURITY_MODEL section 4 ("clear draft orders after confirmation") and section 7 ("drafts are namespaced by user id ... never sent under another identity") claim controls that are not in the code.

**Expected behaviour.** Drafts belong to one user. Another user never sees or sends them.

**Recommended correction.** Add `ownerId` to the persisted state, so `byUser: Record<userId, Record<ticketId, DraftLine[]>>`, or a single `ownerId` field set on first `addLine`. On `login()`: if `ownerId !== res.user.id` and drafts exist, prompt "discard previous user's draft". Without a prompt, call `useDraftStore.getState().clearAll()`. On explicit `logout()`: confirm, then `clearAll()`. Keep drafts on `onSessionExpired` only when the same user logs back in. Add an `authStore` test asserting drafts are not visible after a user switch.

**Effort.** S-M.

## SEC-05 - Medium - B2 broadcasts order data and staff ids to unauthenticated rooms

**Evidence** (`backend/app/api/queue.py:108-117`):
```python
payload = {
    'item_id': item_id, 'status': new_status,
    'ticket_id': item.ticket_id,
    'resource_code': ticket.resource.code if ticket and ticket.resource else None,
    'menu_item_name': ..., 'quantity': item.quantity,
    'opened_by': ticket.opened_by if ticket else None,
}
socketio.emit(f'{routing}:item_update', payload, room=routing)
```
`events.py:35-37` lets any socket join `kitchen`/`bar`/`ticket:*` without a token (G1), and `cors_allowed_origins="*"` (`extensions.py:12`). Before B2, these rooms carried `item_id/status` only. Now any LAN client, a patron included if the Wi-Fi is shared, gets a live stream of what each table orders, with ticket UUIDs (which also let it join each `ticket:<id>` room) and the staff UUID that opened each ticket. Staff UUIDs are not pure identifiers in this system: `reprint_ticket` accepts a manager UUID as its only authorization factor (G4, `tickets.py:1868-1871`). A manager-opened ticket therefore broadcasts a working G4 credential. Exploiting it still needs some staff JWT. SECURITY_MODEL T3 rates this "Low-medium". I rate it Medium because of the G4 coupling.

**Expected behaviour.** Unauthenticated rooms carry no personal or authorization-relevant data. The mobile app needs `opened_by` only to decide "is this mine".

**Recommended correction.** Pick one:
- (a) Preferred: authenticate the socket. Validate `auth.token` in `on_connect` with the same checks as REST (signature, expiry, blocklist, `is_active`), `return False` otherwise. Mobile `io(..., { auth: (cb) => cb({ token: getToken() }) })`.
- (b) Minimal: drop `opened_by` from the public-room payload. Emit a per-user event `ready:mine` to a room `user:<id>` that is joined only with a validated token (same pattern as B4). Keep `menu_item_name`/`resource_code` only if the owner accepts the disclosure.

Fix G4 independently: require a PIN, not a UUID.

**Effort.** (b) S; (a) M (web frontend must send the token too).

## SEC-06 - Medium - Debuggable APK and debug-keystore release signing for a sideloaded app

**Evidence.** `mobile/android/app/build.gradle:112-115`:
```gradle
release {
    // Caution! In production, you need to generate your own keystore file.
    signingConfig signingConfigs.debug
```
`mobile/dist/bola8-staff-debug.apk` (136 MB, `assembleDebug`, debuggable) is the only build artefact. `DEPENDENCIES_AND_GAPS.md` E6 plans "install debug APK on 1-2 staff phones". `PROJECT_STATE.md` F2 plans a "release variant signed with debug keystore". The app is sideloaded (ADR-002), so no store re-signs it. Anyone with the widely distributed RN/AOSP debug key can build an APK with package `com.bola8.staff` that Android installs as an update. The update keeps the app UID, so it can read SecureStore through the same Keystore key. On a debuggable build, anyone with USB access can `adb shell run-as com.bola8.staff`, attach a debugger, or open the RN dev menu to repoint the JS bundle host.

**Expected behaviour.** Staff phones run a non-debuggable release build signed with a private keystore (ADR-002 already says so).

**Recommended correction.** Generate a venue keystore that stays outside the repo (`*.jks` is already gitignored). Inject the `signingConfigs.release` block through a config plugin or `gradle.properties` (`BOLA8_UPLOAD_STORE_FILE`, ...), because `android/` is regenerated. Never install `assembleDebug` output on staff phones. Add a check to the build script that refuses to copy a release APK whose signer SHA-256 equals the debug key's.

**Effort.** S.

## SEC-07 - Medium - (pre-existing backend; mobile relies on it) Manager PIN brute force via void / qty endpoints

**Evidence.** Only `/auth/login` (10/min), `/auth/verify-pin` (5/min) and one tickets route (`tickets.py:1386`) are rate limited. `void_item` and `update_item_quantity` check the PIN with no limiter (`tickets.py:589-620`):
```python
@tickets_bp.route('/<ticket_id>/items/<item_id>', methods=['DELETE'])
@jwt_required()
def void_item(ticket_id, item_id):
    ...
    manager = verify_manager_pin(pin)
    if manager is None:
        ... return jsonify({'error': 'INVALID_PIN', ...}), 401
```
A 4-6 digit PIN matched against every active manager (`auth.py:86-98`) lets any waiter JWT enumerate the 10^4 space. The mobile UI presents a PIN lockout on 429 (`TicketExtras.tsx:38-39, 99`), which assumes server-side throttling exists on these endpoints. It does not. This gap is not in G1-G26.

**Expected behaviour.** Every endpoint that verifies a PIN shares one per-user (and per-IP) failure budget.

**Recommended correction.** Apply `@limiter.limit("5 per minute", key_func=lambda: get_jwt_identity() or get_remote_address())` to `void_item` and `update_item_quantity`, or better, move the limit and lockout into `verify_manager_pin`: count `MANAGER_PIN_FAILED` audit rows per user in the last N minutes, and return 429 after 5. Requires ProxyFix (P1) so the IP key is meaningful.

**Effort.** S.

## SEC-08 - Low - Wrong PIN causes refresh + automatic PIN resend

**Evidence.** The backend answers a wrong PIN with **401** `INVALID_PIN` (`tickets.py:620`, and the qty path). The client treats every 401 as an expired access token (`client.ts:133-137`):
```ts
if (axios.isAxiosError(error) && error.response?.status === 401 && cfg && !cfg._retry && !cfg._isRefresh && !cfg._noAuth) {
  cfg._retry = true;
  const token = await refreshOnce();
  ...
  return client(cfg);
```
Each wrong PIN therefore costs a refresh round-trip and resends the same PIN body in cleartext (SEC-01). The server writes two `MANAGER_PIN_FAILED` audit rows, which halves the effective budget once SEC-07 is fixed. If the refresh token has expired, a mistyped PIN wipes the session (`onSessionExpired`).

**Expected behaviour.** Only an auth-token failure triggers refresh. Application-level 401s are returned to the caller as they are.

**Recommended correction.** In the response interceptor, skip refresh when `error.response.data?.error` is a business code (`INVALID_PIN`, `MANAGER_REQUIRED`, `USER_INACTIVE`). Or refresh only when the body matches flask-jwt-extended's `{msg: ...}` shape. Alternative: pass `_noRefresh: true` from `voidItem`/`updateQty` when a PIN is present. Add a `client.test.ts` case.

**Effort.** S.

## SEC-09 - Low - B4 accepts revoked / deactivated managers' tokens

**Evidence** (`backend/app/sockets/events.py:21-33`):
```python
token = data.get('token', '')
try:
    payload = decode_token(token)
    role = payload.get('sub') and payload.get('role', '')
    if role not in ('MANAGER', 'ADMIN'): ...
join_room(room)
```
`decode_token` verifies the signature and expiry only. The `token_in_blocklist_loader` (`extensions.py:17-26`) runs only inside `@jwt_required` view decorators, and `is_active` is not checked. A manager access token blocklisted by `/auth/logout`, or one belonging to a deactivated manager, joins the manager room for up to 8 h. Membership then lasts for the life of the socket, past token expiry. Current manager-room payloads (`print:failed`) are low sensitivity, which is why this is Low. B4 makes the room usable for the first time (G2), so whatever is added to it later inherits this weakness.

**Expected behaviour.** Room authorization applies the same checks as REST.

**Recommended correction.** After `decode_token`, add: `if payload.get('type') != 'access' or check_if_token_revoked(None, payload): emit('error', {'msg': 'Unauthorized'}); return`. Then load `User.query.get(payload['sub'])` and require `is_active` and a current `role in ('MANAGER','ADMIN')`, which also closes G25 for this path. Add the cases to `tests/test_mobile_extensions_live.py`.

**Effort.** S.

## SEC-10 - Low - Refresh/retry not bound to the session that started it

**Evidence.** `doRefresh` writes whatever it gets back, unconditionally (`client.ts:118-119`), and the retried request always runs (`client.ts:135-137`):
```ts
const token = res.data.access_token;
await bridge?.setAccessToken(token);   // -> SecureStore.setItemAsync(ACCESS_KEY, token)
```
If `logout()` finishes while a refresh is in flight (for example, `authApi.logout()` fails fast on a network error and is swallowed at `authStore.ts:80`), the late refresh writes a valid 8 h access token back into SecureStore and memory after `clearPersisted()`. The original request is also replayed after logout. `hydrate()` discards a partial state, so this is a token-at-rest residue, not a live session.

**Expected behaviour.** Responses that belong to an ended session are discarded.

**Recommended correction.** Keep a `sessionEpoch` counter in `authStore` and increment it in `logout`, `login` and `onSessionExpired`. Capture the epoch when a refresh or retry starts. If the epoch has changed when the response arrives, throw `ApiError('SESSION_ENDED')` without calling `setAccessToken` or replaying the request.

**Effort.** S.

## SEC-11 - Low - Unencoded route params in API paths (Needs verification)

**Evidence.** `tickets.ts:4-5` and `ticketOps.ts:16`:
```ts
const { data } = await client.get<Ticket>(`/tickets/${id}`);
await client.post<AddItemResult>(`/tickets/${ticketId}/items`, body, { headers });
```
`ticketId`/`itemId`/`resourceId` come from `useLocalSearchParams` (`app/(waiter)/ticket/[ticketId]/index.tsx:5`, etc.). The activity is exported with the `bola8staff` scheme (`AndroidManifest.xml:22-28`), so any app on the phone can open `bola8staff://ticket/<anything>`. If expo-router decodes `%2F`/`%3F` in segment params (likely) and OkHttp normalises `..` (it does), a crafted link makes the app send an authenticated GET to another `/api/v1/...` path. That is limited to the signed-in user's own permissions, and the response is not returned to the attacker. Mutations still need a user tap. Not verified on a device.

**Expected behaviour.** Route params are validated as UUIDs before use.

**Recommended correction.** Add `const isId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)` in each `app/**/[param].tsx` wrapper and render `<Redirect href="/denied" />` otherwise. Also wrap path segments in `encodeURIComponent` inside the endpoint helpers.

**Effort.** S.

## SEC-12 - Low - B1 replay ignores the body; edited ambiguous lines report false success

**Evidence.** The server replays any existing `(ticket, key)` without comparing the payload (`tickets.py:418-423`):
```python
if idem_key:
    existing = TicketLineItem.query.filter_by(ticket_id=ticket_id, client_request_id=idem_key).first()
    if existing:
        return jsonify({**existing.to_dict(), 'ticket_version': ticket.version}), 200
```
On the client, a FAILED `NETWORK`/`SERVER` line (outcome unknown) stays editable and keeps its key (`DraftScreen.tsx:169`, `draftStore.ts:77-80`). Scenario: a qty 1 POST times out but lands; the waiter changes it to 3 and retries; the server returns the qty 1 line with 200; the app marks it SENT and deletes the draft (`useSendDraft.ts:362-366`). The kitchen prepares 1. A replay of a line that has since been VOIDED also returns 200 and is reported as sent. This is an order-integrity issue, not an exploitable vulnerability. SQL is parameterised, validation uses `re.fullmatch`, and the IntegrityError fallback is correct.

**Expected behaviour.** A key reused with a different body is rejected (IETF idempotency-key draft: 422).

**Recommended correction.** Server: store `client_request_hash` (SHA-256 of canonical `menu_item_id, quantity, sorted modifier ids, notes`). On replay with a hash mismatch, return 422 `IDEMPOTENCY_KEY_REUSED`. Client: disable the stepper and modifier edits on `FAILED` `NETWORK`/`SERVER` lines (offer retry or discard only). Also, on a 200 replay, compare the returned `quantity`/`status` with the draft and mark the line `VERIFY` on mismatch.

**Effort.** S (client), S-M (server + migration).

## SEC-13 - Low - Unneeded Android permissions

**Evidence.** The generated release manifest (`AndroidManifest.xml:3-6`):
```xml
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" .../>
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW"/>
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" .../>
```
These are Expo template defaults. The app never draws overlays and never touches shared storage. `app.config.ts:16-25` neither declares `permissions` nor `blockedPermissions`. (Derived from the existing prebuild output, not a fresh `expo config --type introspect`.)

**Expected behaviour.** Least privilege: INTERNET, VIBRATE (haptics) and, if used, ACCESS_NETWORK_STATE.

**Recommended correction.** In `app.config.ts` `android`: `blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE']`. Then re-run prebuild and verify the merged manifest of the release variant.

**Effort.** S.

## SEC-14 - Low - No screen-capture protection on login / PIN

**Evidence.** SECURITY_MODEL section 6 and section 5 call for `usePreventScreenCapture` on login, the PIN dialog and financial screens. `expo-screen-capture` is not in `mobile/package.json`, and no screen uses FLAG_SECURE. The PIN pad shows a digit-by-digit press highlight on screen (`PinPad.tsx:137`), so a screen recorder or another app's overlay can capture the PIN. The recents thumbnail also shows the manager tickets and cash screens.

**Expected behaviour.** FLAG_SECURE is set while the PIN sheet or the login form is visible.

**Recommended correction.** `npx expo install expo-screen-capture`. Call `usePreventScreenCapture('pin')` inside `PinPad` and `usePreventScreenCapture('login')` in `app/login.tsx`. Consider the manager overview too.

**Effort.** S.

## SEC-15 - Info - `allowBackup="true"` contradicts SECURITY_MODEL

**Evidence.** `AndroidManifest.xml:14`: `android:allowBackup="true" android:fullBackupContent="@xml/secure_store_backup_rules"`. The expo-secure-store rules include only `sharedpref` minus `SecureStore`, so tokens and the AsyncStorage database are excluded. The real exposure is small, but SECURITY_MODEL section 4 and T9 state `allowBackup=false`.

**Recommended correction.** Set `android.allowBackup: false` in `app.config.ts` to match the model, or correct the doc. **Effort.** S.

## SEC-16 - Info - UI role only refreshed at boot

**Evidence.** `boot.ts:19-23` is the only `/auth/me` call. SECURITY_MODEL T7 says "after every refresh and on foreground". A demoted user keeps the old navigation until the next cold start. The server enforces the new role after refresh (`auth.py:59-68`), so the effect is UI-only.

**Recommended correction.** Call `authApi.me()` after a successful `doRefresh`, and from an AppState `active` listener throttled to once per 5 min. Then `setUser`. If the role changed, `router.replace(routeForRole(role).href)`. **Effort.** S.

## SEC-17 - Info - Idempotency key fallback

**Evidence** (`uuid.ts:4-15`): `Crypto.randomUUID()` (native CSPRNG) is used. On failure it silently falls back to `Math.random()`. Keys need uniqueness, not secrecy, and the collision risk is negligible, but the fallback hides a broken native module in production.

**Recommended correction.** Use the fallback only under `process.env.NODE_ENV === 'test'`. Otherwise rethrow, so the add-to-draft action fails visibly. **Effort.** S.

## SEC-18 - Info - Discount PIN is a ceremony only

**Evidence** (`TicketExtras.tsx:248-250`):
```ts
const v = await verifyPin(pin); // PIN UX only; the discount call itself is gated by the manager JWT
if (!v.valid) throw new Error('invalid');
await setDiscount(ticketId, flow.pct, 'mobile');
```
The button only shows in manager mode (`:153`), and the server gates on the JWT role. Any manager's PIN passes, and the discount is attributed to the logged-in manager, not to the PIN owner. Each attempt also spends the shared 5/min `verify-pin` bucket. SECURITY_MODEL section 5 asks that the UI "must be explicit that the server does not re-check it". The copy (`i18n/mobile.ts:266`) is not explicit.

**Recommended correction.** Drop the PIN step for discounts (the JWT is the control), or reword the copy to say it is a confirmation, not an authorization. **Effort.** S.
