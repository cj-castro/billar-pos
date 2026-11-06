# Mobile Staff App: Code Review

Scope: `mobile/app/**`, `mobile/src/**`, `mobile/jest*.js`, `mobile/e2e/**` (Expo SDK 58 / RN 0.88). The review is independent and was done by reading the code. Backend checks covered `backend/app/api/{tickets,queue,resources,settings}.py`, `backend/app/models/{ticket,resource}.py` and `001_baseline_squash.sql` (trigger `fn_line_item_bump_version`).

Checks I ran from `mobile/` (read-only; I did not run the contract tests):

| Check | Result |
|---|---|
| `npx jest` | **383 / 384 pass, 1 FAIL**: `TicketDetailScreen.test.tsx` "draft hint bar opens the draft". Jest also warned that a worker failed to exit gracefully (a timer leak). |
| `npx tsc --noEmit` | clean |
| `npx expo lint` | clean |

## Summary

Overall the architecture is sound and the code is clean:
- The send orchestrator is pure and well tested.
- Error normalisation handles every backend error shape.
- The token refresh is single-flight.
- Socket reconnect re-joins every room.
- The UI sticks to design tokens.

The serious problems are in the parts that only show up in a real bar:
1. **F1 is a Critical blocker.** On a Wi-Fi network without internet, the app reports "offline" and blocks every mutation.
2. **Without B1 the duplicate guard does not work.** Retrying a line whose result is unknown posts it again with a freshly read version, so a duplicate line goes through.
3. **Draft lines that may already be on the server can still be edited.** If a failed send actually reached the server, the waiter can change the quantity, retry, and get "sent" while the server keeps the old quantity.

| ID | Sev | Category | Title | File:line |
|---|---|---|---|---|
| C1 | Critical | Correctness / connectivity | Internet reachability means "offline" on a POS LAN without internet; every mutation is disabled | `src/components/connection.ts:18`, `src/state/queryClient.ts:31-32` |
| H1 | High | Correctness / duplicates | Without B1, retrying an ambiguous line re-posts it with a freshly read `X-Ticket-Version`, so a duplicate line is created | `src/features/waiter/draft/useSendDraft.ts:42-46`, `draftStore.ts:117`, `sendOrchestrator.ts:153-155` |
| H2 | High | Correctness / data integrity | Ambiguous failed lines stay editable with the same Idempotency-Key; a B1 replay returns the old quantity and the app marks the line sent | `src/features/waiter/draft/DraftScreen.tsx:169-170`, `src/components/DraftLineRow.tsx:84` |
| M1 | Medium | Correctness / API | `X-Ticket-Version` is still sent when B1 is present; concurrent adds cause spurious `VERIFY` stops | `src/features/waiter/draft/sendOrchestrator.ts:96,110-120` |
| M2 | Medium | Correctness / offline | Global mutation `networkMode: 'online'` (F4); the settings mutation inherits it and runs later from a hidden queue | `src/state/queryClient.ts:18`, `src/features/admin/useDiagnostics.ts:51-54`, `src/features/README.md:28` |
| M3 | Medium | Correctness / API | A wrong-PIN 401 (`INVALID_PIN`) triggers a token refresh and an automatic replay of the PIN call | `src/api/client.ts:133-137` |
| M4 | Medium | Correctness | No default port 8080 in server URL normalisation (F3) | `src/config/serverConfig.ts:14-22` |
| M5 | Medium | Correctness / realtime | Without B2, ready events produce no notification (only a refetch); the AC requires a fallback that filters on the waiter's own tickets | `src/features/waiter/ready/readyEvents.ts:28`, `useReadyNotifications.ts:36-39` |
| M6 | Medium | Correctness / KDS | No server clock-skew correction for KDS age (D-10, US-K-02); `clockOffsetMs` is never supplied | `src/components/KdsAgeBadge.tsx:21-30`, `KdsTicketCard.tsx:99` |
| M7 | Medium | Correctness / KDS | A tap based on a stale cached status can move an item backwards (server has no transition guard) | `src/features/kitchen/kdsActions.ts:33-38` |
| M8 | Medium | Correctness / KDS | Stale warning (>15 s) does not disable the advance buttons (US-K-06) | `src/features/kitchen/KdsScreen.tsx:98-107`, `useKds.ts:75` |
| M9 | Medium | Correctness / session | Changing the server keeps tokens, cache and drafts; drafts are keyed by ticket only, not by server and user | `app/setup.tsx:48-51`, `src/features/waiter/draft/draftStore.ts:43` |
| M10 | Medium | Performance | Each KDS card re-renders its whole tree every second, and its age badge runs a second 1 s interval | `src/components/KdsTicketCard.tsx:99-101`, `KdsAgeBadge.tsx:27` |
| M11 | Medium | Testing | The suite is red: one assertion is inverted | `src/features/waiter/__tests__/TicketDetailScreen.test.tsx:146` |
| L1 | Low | Maintainability | Floor state is derived twice with diverging rules; `listPendingPayment` is duplicated and cached under two keys | `src/features/manager/floorModel.ts:18-36` vs `src/features/waiter/floor/floorState.ts:41-58`; `ticketOps.ts:21`, `managerTickets.ts:21` |
| L2 | Low | Correctness / realtime | `resyncAll` and `floor:update` skip cash status, manager ticket lists and stock | `src/realtime/socket.ts:23-24,52-55` |
| L3 | Low | Correctness | The request-bill `onError` reads a stale `billMutation.error`, so the message is always generic | `src/features/waiter/ticket/TicketDetailScreen.tsx:109` |
| L4 | Low | Correctness | A same-frame double `send()` returns `null`, which replaces the mutation state; the real result (toast, auto-return, stop banners) is lost | `src/features/waiter/draft/useSendDraft.ts:31,82` |
| L5 | Low | Correctness | Login has no synchronous double-submit guard and no 429 countdown (shared 10/min bucket) | `app/login.tsx:30-35` |
| L6 | Low | Realtime | No AppState background disconnect, foreground reconnect or proactive refresh; manager room joined with a possibly expired token, never re-joined after refresh | `src/realtime/socket.ts:100-106`, `src/state/queryClient.ts:27-35` |
| L7 | Low | Leak | `s.io.on('reconnect_attempt')` builds up on the cached (multiplexed) Manager across reconnects; `removeAllListeners` only clears the Socket | `src/realtime/socket.ts:128,136-140` |
| L8 | Low | Correctness | PIN errors: any 400/401/403 (e.g. 403 `TICKET_CLOSED`) is shown as "PIN incorrecto" | `src/features/waiter/ticket/TicketExtras.tsx:100` |
| L9 | Low | Spec drift | KDS thresholds are 10/20 min (D-10) while ACCEPTANCE US-K-02 says 5/10; note limit is 120 while AC says 200 | `src/theme/tokens.ts:102-105`, `src/features/waiter/configure/configurator.ts:5` |
| L10 | Low | Dead code | `useTicketRoom`, `tickets.addItem`, `auth.refresh`, `DraftErrorCode 'CONFLICT'` and the never-set `clockOffsetMs` prop | `socket.ts:175`, `api/endpoints/tickets.ts:42`, `auth.ts:18`, `draftStore.ts:14` |

---

## Critical / High

### C1: The app is "offline" on a bar LAN without internet (F1)
**Evidence**
```ts
// connection.ts:17-19
const net = useNetInfo();
const online = net.isConnected !== false && net.isInternetReachable !== false;
// queryClient.ts:31-32
onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((s) => setOnline(s.isConnected !== false && s.isInternetReachable !== false)));
```
No code calls `NetInfo.configure`. On Android, a Wi-Fi network without internet is never marked "validated", so `isInternetReachable` is `false`. As a result:
- `useConnectionLevel()` returns `'offline'`.
- The offline banner shows on every screen.
- Send, open table, request bill, serve, KDS advance and every TicketExtras action are disabled, because each of them checks `level === 'offline'`.
- TanStack `onlineManager` goes offline, which pauses query retries, `refetchOnReconnect`, and the settings mutation (M2).

The tests do not catch this because they use `netinfo-mock`, which reports internet. The emulator in E2E has internet too.

**Expected:** NETWORKING_AND_SYNC §7: reachability means "the POS answers `/api/v1/health`".

**Fix:** At boot, once the server URL is known, call `NetInfo.configure({ reachabilityUrl: `${base}/api/v1/health`, reachabilityTest: r => Promise.resolve(r.status === 200), useNativeReachability: false, reachabilityShortTimeout: 5000 })`. Call it again whenever the URL changes. Alternatively, use only `isConnected`, plus the socket state and a REST-failure counter. Add a test with `isInternetReachable: false, isConnected: true` and assert the app is not offline.

### H1: Without B1, a retry creates a duplicate line
**Evidence**
```ts
// useSendDraft.ts:42-46: every run, including "Reintentar", reads the CURRENT version first
version = await fetchVersion(ticketId);
// sendOrchestrator.ts:154: FAILED NETWORK/SERVER lines are re-sent by the global button
return lines.filter((l) => l.state === 'PENDING' || (l.state === 'FAILED' && (l.error === 'NETWORK' || l.error === 'SERVER')));
// draftStore.ts:117: after an app kill, SENDING becomes FAILED NETWORK, so it is sendable again
```
Here is the sequence when the line did reach the server:
1. Line L1 times out, but the server applied it.
2. The ticket version moved from v to v+1.
3. The retry reads v+1 and sends `X-Ticket-Version: v+1`.
4. A server without B1 accepts it, which means a second line, a second stock deduction and a second chit.

The `VERSION_CONFLICT` safety net that PROJECT_STATE describes ("Without B1: retry → 409 → verificar — never duplicates") only works if the retry sends the version from *before* the ambiguous attempt. The `DraftScreen` per-line Retry (`retryLine`, :78-82) also re-sends `VERIFY` lines with no check step.

**Expected:** US-W-08: "B1 absent: refetch, 'Revisa antes de reenviar', user decides; no automatic resend". D6/PROJECT_STATE: never duplicates.

**Fix:**
- Store the `X-Ticket-Version` used by each line's last attempt (`attemptVersion`) in the draft line.
- When retrying a line in `FAILED NETWORK/SERVER` state, send `attemptVersion`, not the fresh one. Without B1, the 409 then lands on `VERIFY`.
- Alternatively, feature-detect B1 (`/health` `api_features`, or a persisted `b1Known`). When B1 is absent, keep ambiguous lines out of `sendableLines` and route them to verify.
- Add an orchestrator test: "no B1, network fail, server applied → retry yields VERIFY, no second POST accepted".

### H2: Ambiguous lines can be edited but keep their original key
**Evidence**
```tsx
// DraftScreen.tsx:169-170: only SENDING locks the line
onQuantityChange={sending ? undefined : (q) => setQuantity(ticketId, l.key, q)}
// DraftLineRow.tsx:84: the stepper is shown for FAILED lines too
{onQuantityChange && (status === 'PENDING' || status === 'FAILED') && ( <QuantityStepper ... /> )}
```
With B1:
1. L1 (qty 2) times out, but the server applied it.
2. The waiter changes the quantity to 3 and retries.
3. The server finds the key and returns 200 with the qty-2 line.
4. The app removes L1 from the draft as SENT.

The kitchen and the bill now have 2 while the waiter believes 3 were sent, and nothing tells them. NETWORKING §3 says that lines in `sending`/`failed` state are locked.

**Fix:** For `FAILED` with error `NETWORK | SERVER | VERIFY`, hide the stepper. These lines can only be retried, or removed after the ticket has been checked. Lines failed with `OUT_OF_STOCK`/`FLAVOR_REQUIRED`/`INVALID_QUANTITY` were never created on the server, so they can stay editable, ideally with a fresh key after the edit.

---

## Medium

### M1: `X-Ticket-Version` with B1 produces false `VERIFY` stops
**Evidence:** `sendOrchestrator.ts:96` always sends `ticketVersion` when it is known. On a 409, `:112-119` retries once, then marks the line `VERIFY` and stops the whole run. When B1 is present, replay is decided *before* the version check (`tickets.py:417-426`). A 409 therefore proves the line was not created, and sending again with the same key is always safe. A web-POS cashier or a second waiter adding to the same ticket bumps the version, so in a busy service this gives false "check the ticket" stops. NETWORKING_AND_SYNC §3 (line 49) says not to send the header.

**Fix:** Once B1 has been seen, either omit `X-Ticket-Version`, or retry the 409 with a fresh version up to N times without ever going to `VERIFY`. Keep the version header only for the non-B1 path (see H1).

### M2: Mutations default to `networkMode: 'online'` (F4)
**Evidence:** `queryClient.ts:18` has `mutations: { retry: 0, networkMode: 'online' }`, and `features/README.md:28` tells contributors to rely on that default. `useServerSetting` (`useDiagnostics.ts:51`) does not override it. Offline, or on a LAN without internet (C1), the PUT pauses and runs later on its own. D7 and NETWORKING §7 forbid that hidden queue.

**Fix:** Set the default to `'always'`, fix the README, and drop the per-call overrides.

### M3: A wrong PIN causes a refresh and a replay
**Evidence:** `client.ts:133` treats *every* 401 as an expired JWT. Void (`DELETE …/items/<id>`) and qty-decrease return 401 `INVALID_PIN`. Each wrong PIN therefore leads to:
- a `POST /auth/refresh`;
- a second DELETE with the same bad PIN;
- two `MANAGER_PIN_FAILED` audit rows.

**Fix:** Refresh only when the body is the flask-jwt `{msg}` shape, or when `error` is not an app code (`INVALID_PIN`, `INVALID_CREDENTIALS`, `USER_INACTIVE`).

### M4: No default port (F3)
**Evidence:** `normalizeServerUrl('192.168.1.50')` returns `http://192.168.1.50` (port 80), and health then fails as "unreachable". NETWORKING §1.1 requires 8080 as the default. There is also no private-host policy check (§1.2).

**Fix:** When `m[3]` is absent and the scheme is http, append `:8080`. Add a test for it.

### M5: No ready notification without B2
**Evidence:** `readyEvents.ts:28` returns `{action:'refetch'}` when B2 fields are missing, and the hook then only invalidates lists. US-W-09 and NETWORKING §6 require looking up `item_id` in the waiter's cached tickets (refetching `open-tickets` once) and then notifying. The foreground summary ("x items ready since last seen") is not implemented either.

**Fix:** After the refetch, diff the READY ids for tickets where `opened_by === me` and notify for new ones (dedupe on `item_id:READY`).

### M6: No clock-skew correction on KDS age
**Evidence:** `KdsAgeBadge` accepts `clockOffsetMs` but nothing passes it. The border colour in `KdsTicketCard.tsx:99-101` uses the raw device clock. With a tablet 3 minutes fast, every card shows the alert colour early. D-10 and US-K-02 require the correction.

**Fix:** In an axios response interceptor, take the offset from the `Date` header as a median of the last N responses. Keep it in a store and feed both the badge and the card.

### M7: A stale tap can move an item backwards
**Evidence:** `canTransition(item.status, to)` checks only the cached status. If another device has already set READY and this tablet's cache still says SENT, tapping sends `IN_PROGRESS`. The server accepts any status (G5; B3 only blocks VOIDED), so the item goes from READY back to IN_PROGRESS. US-K-04 says "stale tap yields no regression".

**Fix:** The proper fix is a forward-only transition guard on the server (a small B3 extension, `409 INVALID_TRANSITION`). A client-only mitigation is to refetch before a non-optimistic advance when `dataUpdatedAt` is older than a few seconds.

### M8: Stale KDS still allows actions
**Evidence:** `useStaleLive()` only shows the `kds-stale` banner. `useKdsActions` blocks only when the level is `'offline'`. US-K-06 says advance buttons are disabled once the stale state is reached.

**Fix:** Pass `stale` to `KdsTicketCard`, disable the item, "Todo listo" and "Entregado" buttons, and add a test.

### M9: Changing the server leaves the old session; drafts are not scoped
**Evidence:** `setup.tsx:48-51` calls only `saveServerUrl` and then `router.replace('/login')`. Tokens, the query cache and drafts from the previous server stay in place (US-X-02: they must be cleared, after a warning about drafts). Drafts are stored as `byTicket[ticketId]` (`draftStore.ts:43`). On a shared phone, the next waiter on the same ticket sees and can send the previous user's draft. US-X-07 requires drafts keyed by user and ticket, and a "Tienes pedidos sin enviar" prompt at logout, which is also missing (`ProfileScreen.tsx`).

**Fix:** Key drafts by `${serverUrl}|${userId}|${ticketId}` and filter by the current session. On server change, after confirmation, clear tokens, the cache and the socket. Warn on logout when drafts exist.

### M10: 1 s re-renders across the KDS
**Evidence:** `KdsTicketCard` calls `useNow(now)` (1 s), so the whole card and all its `KdsItemRow` children re-render every second, only to recompute a border colour that changes at minute boundaries. The nested `KdsAgeBadge` runs its own second 1 s interval. N cards therefore mean 2N intervals and N full card re-renders per second on a low-end kitchen tablet.

**Fix:** Move the ticking into a small leaf component that reports only the age level (or tick the card at 15–30 s), and wrap `KdsItemRow` in `React.memo`.

### M11: The suite is red
**Evidence:** `TicketDetailScreen.test.tsx:146` has `expect(screen.queryByText('1 producto por enviar')).toBeNull()`. The draft bar renders exactly that text (`i18n/mobile.ts:216`, `TicketDetailScreen.tsx:268`). The assertion is inverted. Jest also reports a timer leak ("worker failed to exit gracefully").

**Fix:** Change the assertion to `getByText(...)`, then run `--detectOpenHandles` and clear the `useNow`/`useElapsed`/Toast timers in teardown.

---

## Low (one line each)

- **L1:** `floorModel.ts` (manager) and `floorState.ts` (waiter) use different rules for bill matching, timer display and sort order, so the two floors can disagree. Make the manager screen use `FloorScreen mode="manager"`, which already exists. Remove one of the two `listPendingPayment` functions and merge `wqk.pendingPayment` with `mk.pending`.
- **L2:** `resyncAll` leaves out `qk.cash`, `qk.tickets` and `qk.stock`, so manager lists and the bar-closed banner can be stale for up to the poll interval after a reconnect.
- **L3:** Use the `onError` error parameter instead of the stale `billMutation.error` (409 `TICKET_NOT_OPEN` currently shows a generic message).
- **L4:** Return early in `send()` when `guard.current` is set, instead of calling `mutate()` again, which replaces the observed mutation with a `null` result.
- **L5:** Add a `useRef` guard and a 429 countdown to login. Double taps use up the shared 10/min bucket.
- **L6:** Add an AppState handler: disconnect after 30 s in the background; on foreground, refresh the token if `exp` is less than 5 min away, reconnect, and re-join `manager` after a refresh.
- **L7:** Remove the `reconnect_attempt` listener in `disconnectSocket` (`socket.io.off`), or pass `forceNew: true`.
- **L8:** Map only `INVALID_PIN`/`MANAGER_REQUIRED`/`valid:false` to "PIN incorrecto". Route the other codes through `errorMessage`.
- **L9:** Decide between the ACCEPTANCE and DESIGN_DECISIONS values and update the losing document. The tests assert 10/20.
- **L10:** Delete the dead code, or wire it up (`clockOffsetMs`, see M6).

## Checked and correct (no finding)

- **Send loop basics:** lines are posted sequentially; a confirmed 2xx is removed from the persisted draft at once (`useSendDraft.ts:56-61`), so an app kill can never re-send it. The key is generated once per line and never regenerated. With B1, a 200 replay counts as sent. The module-level `inFlight` set and the ref make concurrent runs no-ops.
- **409 handling with B1** is correct: the replay lookup comes before the version check on the server, and the orchestrator retries with the same key. The remaining problem is false stops, M1.
- **Token refresh:** single-flight through a module-level `refreshPromise`. Network or 5xx errors during refresh do not log out; only 401/422 does. Replay happens once.
- **Socket:** every `connect` re-joins the role rooms, the `ticket:<id>` rooms and the extra rooms (waiter kitchen/bar), then runs `resyncAll`. Event names match the backend, including the G16 `waiting_list:update` alias. The B2 `ticket_id` is used for `ticket:item_status`. Feature listeners (`onRealtimeEvent`) return unsubscribes and every caller cleans up; I found no leaks apart from L7.
- **KDS:** forward-only and one step at a time; "Todo listo" sends two sequential PATCHes per SENT item. Optimistic rollback is per item, 409 `ITEM_VOIDED` removes the item, and SERVED is a separate explicit action.
- **Ready filtering with B2:** status READY plus `opened_by === me`, deduped per `item_id:READY`.
- **Floor derivation:** a pool table that is AVAILABLE with a pending bill shows as BILL_REQUESTED. This is correct, because `uq_tickets_open_per_resource` blocks a new ticket until the billed one closes.
- **API contract:** every endpoint path, method and body matches API_CAPABILITY_MATRIX: `print ?unpaid=true` as a query param (`tickets.py:1790`), `DELETE` body `{pin, reason}`, `PATCH /discount {pct, reason}`, `PUT /settings/<key> {value}`. Types match `Ticket/TicketLineItem/PoolTimerSession/Resource.to_dict`. Money is integer cents throughout.
- **Lists and styles:** FlatList is used with stable keys for the menu and manager tickets; the KDS and floor `ScrollView`s are bounded and fine at bar scale. Design tokens are respected; the only ad-hoc literal is the shared `rgba(0,0,0,0.62)` scrim, used twice.

## F1–F6 verdicts

| F | Verdict | Evidence |
|---|---|---|
| F1 | **CONFIRMED, Critical** (C1) | `connection.ts:18` and `queryClient.ts:32` use `isInternetReachable`; `NetInfo.configure` appears nowhere; OfflineBanner and every mutation button follow it. |
| F2 | **CONFIRMED (still open)** | `scripts/mobile/build-android-debug.ps1:51` only runs `assembleDebug`; the only output is `app-debug.apk`. No standalone release variant. |
| F3 | **CONFIRMED** (M4) | `serverConfig.ts:14-22` keeps the URL without a port. |
| F4 | **PARTIALLY CONFIRMED** (M2) | Global default is still `'online'` (`queryClient.ts:18`) and README tells contributors to rely on it. 5 of 6 `useMutation`s override to `'always'`; `useServerSetting` does not. KDS actions bypass TanStack (gated by the UI offline check). |
| F5 | **CONFIRMED** | `NETWORKING_AND_SYNC.md:49` still says not to send `X-Ticket-Version`; `INTEGRATION_STRATEGY.md:82,91` still say 400 / `VARCHAR(36)` (actual 422 / 64). M1 argues the NETWORKING doc is the better design when B1 is present. |
| F6 | **RESOLVED** | `useKds.ts:15,24` has `refetchInterval: 15_000`; `package.json` defines `test:contract` and `jest.contract.config.js` exists. |

## P0 criteria without tests

- **US-X-01:** default `:8080` normalisation; Setup screen flow (URL not stored on failure). `normalizeServerUrl` has no test.
- **US-X-02:** server change clears tokens and caches; draft warning (not implemented).
- **US-X-03:** double submit sends one request; 429 countdown; network failure keeps the username.
- **US-X-04:** cold start in `boot()` (`/auth/me` success; offline keeps the session; rejection goes to login). `boot.ts` is untested. Re-routing on role change after refresh (not implemented).
- **US-X-05:** an inline 403 "No tienes permiso" without logging out (generic screens).
- **US-X-06:** "connection restored → active queries refetch ≤3 s"; LAN-without-internet reachability (the NetInfo mock always reports internet).
- **US-X-07:** logout clears the socket and room joins; unsent-draft confirmation at logout.
- **US-X-10:** reconnect re-joins role, ticket and extra rooms and resyncs (`socket.test.ts` covers only the map, the role list and unsubscribe); AppState foreground refetch and reconnect.
- **US-W-01:** `floor:update` → floor refetch at screen level.
- **US-W-08:**
  - Without B1, a retry of an ambiguous line must not duplicate (H1).
  - Ambiguous lines locked (H2).
  - A 401 mid-send resumes after login.
- **US-W-09:** ownership fallback without B2 (M5); summary of READY items on foreground.
- **US-W-10:** a double tap on "Servido" sends one request.
- **US-W-11:** network loss → refetch → `payment_requested: true` treated as success; 409 path.
- **US-W-12:** 422 `HAS_ITEMS` / `HAS_POOL_TIME` messages.
- **US-K-02:** the AC boundaries 4:59/5:00/9:59/10:00 (the tests assert 10/20, see L9); skew correction.
- **US-K-04:** a double tap keeps one request in flight; a stale tap does not move the item backwards (M7).
- **US-K-05:** an item voided at the POS disappears within 15 s through the poll.
- **US-K-06:** stale banner and disabled buttons after the threshold (M8).
- **US-A-01:** diagnostics and copy contain no secrets; joined rooms and last error code are shown.

---

## Resolution (fix pass)

Status: **Fixed** (file / test), **Won't fix** (reason), **Deferred** (reason). Gate after the pass: `npm test` 443/443, `tsc --noEmit` clean, `expo lint` clean, `npm run test:contract` 56/56, backend live test 31/31.

| ID | Resolution |
|---|---|
| C1 | **Fixed.** `src/realtime/connectivity.ts` (NetInfo.configure to POS `/api/v1/health`, re-configured on URL change via `onServerUrlChange`; own health probe; online = health OR socket; `onlineManager.setOnline`), `components/connection.ts`. Tests: `realtime/__tests__/connectivity.test.tsx` (isInternetReachable=false + health OK -> online, Enviar enabled; health down -> offline). |
| H1 | **Fixed.** `firstAttemptVersion` per draft line + per-ticket `b1Confirmed` (`draftStore.ts`, `sendOrchestrator.ts`, `useSendDraft.ts`). Same key always; no B1 -> resend first version, 409 -> verify, never refresh. Tests: `sendOrchestrator.test.ts` "H1" (fake POS that applies the request and loses the response), `DraftScreen.test.tsx` "H1 end to end without B1". |
| H2 | **Fixed.** Uncertain lines have no stepper, store refuses `setQuantity`, remove asks "Ya verifiqué, descartar" (`DraftScreen.tsx`, `draftStore.isUncertain`). Tests: `DraftScreen.test.tsx` "H2". |
| M1 | **Won't fix** (orchestrator decision): the version header is kept because it is the no-B1 duplicate guard (H1); with B1 a 409 refreshes the version and retries once with the same key. The residual false "verify" stop needs two concurrent edits in one send. |
| M2 | **Fixed.** Global `mutations.networkMode: 'always'`, per-call overrides removed, README corrected. Test: `authStore.test.ts` "F4". |
| M3 | **Fixed.** `api/client.ts`: no refresh when the 401 body has an app `error` code. Test: `client.test.ts` "M3". |
| M4 | **Fixed.** `serverConfig.ts` default `:8080` for http, https keeps 443; tests updated. |
| M5 | **Fixed (core).** Ownership via OPEN tickets set (`ready/readyEvents.ts`, `useReadyNotifications.ts`, `menuAndReady.test.ts`, `ConfiguratorAndReady.test.tsx`). **Deferred:** foreground "x items ready" summary (UX addition). |
| M6 | **Fixed.** `api/clockSkew.ts` (median of `Date` header offsets), used by `KdsTicketCard`/`KdsAgeBadge`. Test: `KdsTicketCard.test.tsx`. |
| M7 | **Deferred.** Proper fix is a server-side forward-only transition guard (backend contract change, `409 INVALID_TRANSITION`). |
| M8 | **Fixed.** `KdsTicketCard` `disabled`; `KdsScreen` locks when disconnected and no successful poll for 45 s. Test: `KdsTicketCard.test.tsx`. |
| M9 | **Fixed.** Server change = confirm + full logout (SEC-02); logout wipes drafts, login as another user wipes them (`claimDrafts`); logout dialog warns about unsent lines (`ProfileScreen.tsx`). Tests: `setup.test.tsx`, `authStore.test.ts`, `draftStore.test.ts`. |
| M10 | **Fixed.** Card ticks every 15 s (badge keeps its own 1 s), `KdsItemRow` memoised. |
| M11 | **Fixed.** The assertion was wrong, the code is right (the hint bar renders "1 producto por enviar"): `TicketDetailScreen.test.tsx` now expects it. **Deferred:** the Jest "worker failed to exit gracefully" warning still appears (not traced to one suite). |
| L1 | **Deferred** (refactor, no behaviour bug). |
| L2 | **Fixed.** `resyncAll` also invalidates cash, stock, tickets. |
| L3 | **Fixed.** `onError(billErr)`. |
| L4 | **Fixed.** `send()` returns early while a run is in flight. |
| L5 | **Fixed (guard).** Synchronous `submitting` ref in `app/login.tsx`. **Deferred:** 429 countdown. |
| L6 | **Deferred** (AppState background disconnect / proactive refresh: new behaviour). |
| L7 | **Fixed.** `forceNew: true` on the socket. |
| L8 | **Fixed.** Only `INVALID_PIN`/`MANAGER_REQUIRED` show "PIN incorrecto"; `verifyPin` maps 400 to `INVALID_PIN`. |
| L9 | **Deferred** (needs a product decision on 5/10 vs 10/20 min; tests assert 10/20). |
| L10 | **Deferred** (dead code removal; `clockOffsetMs` is now wired). |

P0 test gaps closed in this pass: US-X-01 (normalisation + setup flow), US-X-02 (server change), US-X-06 (LAN without internet), US-X-07 (logout clears drafts), US-W-05/08 (H1/H2), US-W-09 (ownership fallback), US-K-02 skew, US-K-06. Still open: boot() cold start, AppState foreground refetch, double-tap on Servido, 429 login countdown.

F1-F6: F1 fixed (C1), F2 fixed (`scripts/mobile/build-android-release.ps1`), F3 fixed, F4 fixed, F5 fixed (NETWORKING_AND_SYNC.md, INTEGRATION_STRATEGY.md), F6 already resolved.
