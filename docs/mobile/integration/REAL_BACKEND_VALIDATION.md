# Real Backend Validation (Bar Network) - Plan

Status: **plan only. Not executed.** Run only after `BAR_MACHINE_REQUIREMENTS.md` section 13 is signed off. Every step is `pending bar-machine access`.

Goal: prove on the real bar LAN, with real phones and the real POS data, that the app meets `ACCEPTANCE_CRITERIA.md` for each role, and that the duplicate-order and reconnect guarantees hold. Results go in the table in section 9 and then in `TEST_RESULTS.md` (written later by others).

Ground rules:
- Use **real staff accounts** created per `BAR_MACHINE_REQUIREMENTS.md` section 8. Never the seed defaults.
- Run mutating tests only during a supervised quiet shift, with the owner present. Real tickets are real money.
- Read-only smoke tests may run any time. Mutating contract suites never run against the bar (`INTEGRATION_STRATEGY.md` section 3 production safety).
- Record every failure with a timestamp, phone model, Android version, app build and the server response code.

---

## 0. Pre-flight: resolve code vs doc drift first

These mismatches were found while writing this plan (checked against the code in the worktree). Several would fail on site. Decide, fix or accept each before the pilot.

| # | Item | Code (truth) | Doc says | Risk on bar | Action |
|---|---|---|---|---|---|
| D-1 | Mutation network mode | `mobile/src/state/queryClient.ts:18` `networkMode: 'online'` | `NETWORKING_AND_SYNC.md` section 7: `'always'`, because `'online'` pauses mutations and runs them on reconnect (an implicit offline queue, forbidden by D7/ADR-005) | **High**: a Send tapped offline could fire on reconnect | Change to `'always'` and add test T-19 |
| D-2 | Reachability | `queryClient.ts:31-33` uses `isInternetReachable`. `NetInfo.configure({reachabilityUrl})` is not called anywhere | `NETWORKING_AND_SYNC.md` section 7: reachability must target the POS health URL | **High**: LAN-only Wi-Fi reads as offline | Configure reachability to `{serverUrl}/api/v1/health` and test T-18 |
| D-3 | `X-Ticket-Version` on item add | `mobile/src/api/endpoints/tickets.ts:45` sends it when `ticketVersion` is supplied | `NETWORKING_AND_SYNC.md` section 3: do **not** send on adds. `PROJECT_STATE.md` and `ACCEPTANCE_CRITERIA.md` US-W-08 say send it | Medium: a stale version can 409 a second waiter's add | Decide. Test T-38 records actual behaviour |
| D-4 | Default port | `mobile/src/config/serverConfig.ts` `normalizeServerUrl` does not add `:8080` | `NETWORKING_AND_SYNC.md` section 1 step 1: default 8080 | Medium: a waiter typing only the IP hits port 80 and gets "not a POS" | Add the default or make the setup screen require the port. T-03 |
| D-5 | LAN host guard | `normalizeServerUrl` accepts any `http://` or `https://` host | `TECH_STACK_DECISION.md` section 6: refuse `http://` to non-private hosts | Low on LAN, relevant to T12 phishing | Implement, or accept and document |
| D-6 | KDS poll | No `refetchInterval` anywhere | `DEPENDENCIES_AND_GAPS.md` G12 and `ACCEPTANCE_CRITERIA.md` US-K-05: 15 s poll on KDS. `NETWORKING_AND_SYNC.md` section 11: no interval refetch | Medium: a voided item stays on the KDS until a socket event | Decide. T-27 expects a fail until decided |
| D-7 | Health timeout | `serverConfig.ts` 5 s | `NETWORKING_AND_SYNC.md` 4 s; `ACCEPTANCE_CRITERIA.md` US-X-01 ">5 s" | Low | Align the docs to 5 s |
| D-8 | Idempotency contract | `backend/app/api/tickets.py:408-410`: key regex `[A-Za-z0-9_-]{1,64}`, **422** `INVALID_IDEMPOTENCY_KEY`. Column `VARCHAR(64)` | `INTEGRATION_STRATEGY.md` section 4 says UUID v4, **400**, `VARCHAR(36)` | Low (UUIDs still pass the regex) | Fix `INTEGRATION_STRATEGY.md` |
| D-9 | Dependencies | `mobile/package.json`: no `@tanstack/react-query-persist-client`, no `@tanstack/query-async-storage-persister`, no `expo-screen-capture`, no `expo-keep-awake`. TypeScript `~6.0.3` | `TECH_STACK_DECISION.md` section 5 lists them and TypeScript `~5.9` | **High** for D-10/D-11 below | Reconcile the lock file and the doc |
| D-10 | Offline cache | No persister wired. Cached reads after an app restart are not possible | `NETWORKING_AND_SYNC.md` section 8 (persisted queries) and US-X-04 (offline cold start) | High for the offline journeys | Implement, then re-run T-19 |
| D-11 | PIN and KDS protection | Not implemented: no `expo-screen-capture`, no `expo-keep-awake` | `SECURITY_MODEL.md` section 6, `NETWORKING_AND_SYNC.md` (KDS keep-awake) | Medium | T-28, T-40 expect fail until built |
| D-12 | Config file | Repo uses `mobile/app.config.ts`. `TECH_STACK_DECISION.md` and `mobile/README.md` mention `app.json` in places | Doc drift | Low | Use `app.config.ts` as the source |
| D-13 | Node version | `mobile/README.md`: Node 20+. `TECH_STACK_DECISION.md`: `^22.13 \|\| ^24.3` for SDK 58 | Doc drift | Low | Use the TECH_STACK value |
| D-14 | Contract test command | No `test:contract` script in `package.json`. No `mobile/src/test/contract/`. Brief uses `CONTRACT_BASE_URL`, docs use `POS_API_URL` | Doc/code drift | Medium (no contract suite exists) | See `TEST_STRATEGY.md` |
| D-15 | Debug APK | `scripts/mobile/build-android-debug.ps1` runs `gradlew assembleDebug`. React Native debug builds load the JS bundle from Metro unless it is embedded. The phone would then show a "no JS bundle" error. Release signing is not configured in `app.config.ts` | Unverified by this review | **High** for field install | Build a release or bundled APK for the phone (`TECH_STACK_DECISION.md` section 4: `assembleRelease`, local keystore). Confirm on a phone before the bar visit |
| D-16 | Waiter, KDS and manager slices | `PROJECT_STATE.md`: next. `mobile/README.md`: P0 screens are placeholders. Routes exist under `mobile/app/(waiter)`, `(kitchen)`, `(manager)` | Status | **High**: most journeys cannot pass yet | Confirm which screens are live before scheduling the pilot |

Do not start section 1 until D-1, D-2, D-10 are decided, and D-15 has a confirmed install path.

---

## 1. Preconditions

| Check | Pass condition | Source |
|---|---|---|
| Network sign-off | `BAR_MACHINE_REQUIREMENTS.md` section 13 ticked | Owner |
| Backup | Fresh `billiardbar_*.sql.gz` in `./backups`, restore rehearsed | `BAR_MACHINE_REQUIREMENTS.md` section 6 |
| Backend | B1-B4 live (`ticket_version` in an add response; `ITEM_VOIDED` on a voided PATCH) | `BACKEND_EXTENSIONS.md` |
| Web back-compat | Web login, open ticket, add item, KDS, print all OK | `INTEGRATION_STRATEGY.md` section 5 |
| Cash | Session open | US-W-02 |
| Phones | Android 10+ (min API decided by architect: confirm), Wi-Fi on staff SSID, battery optimisation off for the app, auto date/time on | `DEPENDENCIES_AND_GAPS.md` E6, E9 |
| Test data | One named test table per waiter pair (not a real table in service), 3 menu items with a kitchen routing and 1 with a bar routing | Owner |

---

## 2. Reachability

| Step | Action | Expected | Ref |
|---|---|---|---|
| 2.1 | On the staff phone browser (staff SSID), open `http://<pos-ip>:8080/api/v1/health` | HTTP 200, JSON `{"status":"ok"...}` | US-X-01 |
| 2.2 | Open `http://<pos-ip>:8080/api/v1/health` on the guest SSID | Fails. Expected | BAR section 3 |
| 2.3 | From a laptop on the staff SSID: `curl -i http://<pos-ip>:8080/api/v1/health` | 200 | |
| 2.4 | `curl -i http://<pos-ip>:9191/health` from the laptop | 200 (print agent unchanged) | BAR section 7 |

If 2.1 fails, stop. Do not install the app until the network is fixed. The app cannot diagnose a firewall problem better than the browser can.

---

## 3. Install the APK

Prerequisite (D-15): the APK must be a **release or bundled** build. A plain debug build loads JS from Metro and will not run on a phone.

Option A, adb (dev laptop with USB debugging on the phone):

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices                 # phone shows "device"
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r <path-to-apk>  # -r keeps app data on re-install
& "$env:ANDROID_HOME\platform-tools\adb.exe" shell pm list packages | findstr bola8   # com.bola8.staff
```

Option B, file transfer:
1. Copy the APK to the phone (USB file transfer, or a local share the phone can reach, not a public link).
2. Open it in the file manager. Android asks to allow "install unknown apps" for that file manager only. Allow once, then turn it off.
3. Install. Record the version name and build from the Settings > Apps > Bola 8 Staff screen.

Uninstall (rollback, section 10): `adb uninstall com.bola8.staff`.

---

## 4. Server setup and auth

Expected behaviours are from `ACCEPTANCE_CRITERIA.md` (US-X-01, US-X-03, US-X-05). Current code caveats are in section 0.

| ID | Step | Expected | Ref / note |
|---|---|---|---|
| T-01 | Launch app fresh (no stored server) | Setup screen shown; no login possible | US-X-01 |
| T-02 | Enter `<pos-ip>:8080` | Normalised to `http://<pos-ip>:8080`; health OK; goes to login | US-X-01 |
| T-03 | Enter `<pos-ip>` (no port) | Expected: connects to `:8080`. **Current code does not add the port (D-4); expect a "not a POS / unreachable" failure** | D-4 |
| T-04 | Enter `<pos-ip>:8081` | "No se pudo conectar", URL not stored | US-X-01 neg |
| T-05 | Enter the router's admin URL (`http://<router>`) | "not a POS server" | US-X-01 neg |
| T-06 | DEMO DATA banner | Absent everywhere | `INTEGRATION_STRATEGY.md` section 2 |
| T-07 | Login with a wrong password | "Usuario o contraseña incorrectos", password cleared, username kept | US-X-03 neg |
| T-08 | Login each of 5 accounts (waiter, kitchen, bar, manager, admin) | Waiter -> Floor; kitchen -> KDS kitchen; bar -> KDS bar; manager -> Ops; admin -> Ops + Diagnostics | US-X-05, D9 |
| T-09 | Kill app, reopen with session | Goes to role home after `/auth/me` | US-X-04 |
| T-10 | Logout (then re-login as same user) | Login screen; SecureStore cleared; re-login works | US-X-07 (journey 7) |
| T-11 | Logout with an unsent draft | Confirmation "Tienes pedidos sin enviar"; draft kept per user | US-X-07 |
| T-12 | Login rate limit (only after shift, owner present) | 10 quick attempts from one phone -> 429 with countdown; no auto-retry. **Blocks logins for the whole venue for about a minute** | `BAR` section 9 |

---

## 5. Waiter journeys

Pre-requisite: cash open, test table AVAILABLE.

| ID | Step | Expected | Ref |
|---|---|---|---|
| T-13 | Floor loads | Grouped POOL / REGULAR / BAR, sorted by `sort_order` then `code`; counts match the web floor | US-W-01 |
| T-14 | Open a REGULAR table | `POST /tickets` 201; ticket screen opens | US-W-03 |
| T-15 | Open the same table from a second waiter's phone at the same moment | One 201. Other gets 409 `RESOURCE_OCCUPIED` -> "Mesa ocupada" + floor refetch; if `active_ticket_id` is returned, offers "Abrir ticket existente" | US-W-03 neg |
| T-16 | Add 3 items to the draft; force-stop the app; reopen | Draft intact (persisted) | US-W-08 |
| T-17 | Send the draft (3 lines, one line is a modifier item) | Each line 201 once; ticket shows 3 SENT lines; draft emptied; kitchen chit printed once per line | US-W-08 |
| T-18 | Wi-Fi without internet (router internet off, staff SSID still reaches POS) | App stays **online**; no offline banner; Send works. **Expected to FAIL today (D-2)** | NETWORKING section 7 |
| T-19 | Airplane mode on the phone, tap Send with a draft | Send blocked with reason; draft kept; **nothing sent after airplane mode is turned off**; DB unchanged. **Expected to FAIL today (D-1, D-10)** if mutations resume on reconnect | D7, ADR-005 |
| T-20 | Duplicate tap on Send (two fast taps) | One request per line; no duplicate line in DB | US-W-08 neg duplicate tap |
| T-21 | Wi-Fi toggled off for 2 s mid-send (line 2 of 3) | Lines 1 sent; line 2 unknown; line 3 not attempted. Retry only unconfirmed line with the same key. With B1: retry returns existing line (200), no duplicate. Without B1: "Revisa antes de reenviar" | US-W-08 neg, `NETWORKING_AND_SYNC.md` section 3 |
| T-22 | OUT_OF_STOCK on a line (use a menu item with no stock, if one exists) | Line stays in draft as "Agotado: <insumo>"; other lines continue | US-W-08 neg |
| T-23 | Ready notification: a kitchen phone or the web KDS marks one of this waiter's items READY | Banner "Mesa <code>: <n> x <item> listo" within 3 s, vibration; tap opens the ticket. Only this waiter's items notify (B2 `opened_by`) | US-W-09 |
| T-24 | Same READY item emitted twice (reconnect) | Notified once | US-W-09 neg |
| T-25 | Mark a READY line Servido | Chip SERVED; one request | US-W-10 |
| T-26 | Void a SENT line with a manager PIN (wrong PIN, then right PIN) | Wrong: "PIN incorrecto", sheet stays open. Right: line VOIDED. Warning shown if line is IN_PROGRESS/READY | US-W-13 (P1) |
| T-27 | Request bill on a pool table | Confirm text includes the timer stop and table freed message; `request-payment` returns `{ok,total_cents}`; "Cuenta pedida" | US-W-11 |
| T-28 | Cancel an empty REGULAR ticket | Floor shows AVAILABLE | US-W-12 |
| T-29 | Waiter tries Discount / manager actions | Control hidden. A direct API call with a waiter token returns 403 (server authority) | US-W-15, T5 |

---

## 6. Kitchen and bar journeys

| ID | Step | Expected | Ref |
|---|---|---|---|
| T-30 | KITCHEN_STAFF opens KDS | `GET /queue/kitchen`; items grouped by ticket, oldest `sent_at` first; BAR_STAFF sees `/queue/bar` only | US-K-01 |
| T-31 | Empty queue | "Sin pedidos" state, not a blank screen | US-K-01 neg |
| T-32 | Advance SENT -> IN_PROGRESS -> READY -> SERVED | Each step one PATCH; a skipped step is not possible in UI | US-K-04 |
| T-33 | Duplicate tap on Empezar | One request in flight; controls disabled until response | US-K-04 neg |
| T-34 | Airplane mode, tap Listo | Action blocked; item reverts; no change server-side after reconnect | US-K-04 neg, US-X-06 |
| T-35 | Waiter sends an item | Appears on KDS within 3 s (`kitchen:update` / `bar:update`) | US-K-05 |
| T-36 | Age colours | Under 5 min green, 5-10 amber, 10+ red. Check boundaries on a skewed clock (`w32tm`, BAR section 10) | US-K-02 |
| T-37 | Waiter voids a SENT item at the POS | Item leaves the KDS within 15 s. **Today: no poll, no socket event for void (G12) = expected FAIL until D-6 decided** | US-K-05 |
| T-38 | KDS screen left idle for 10 min | Screen stays on. **Keep-awake not implemented (D-11): expected FAIL** | NETWORKING section 11 |

---

## 7. Manager and admin

| ID | Step | Expected | Ref |
|---|---|---|---|
| T-39 | Manager opens Ops | Cash status, open ticket count and list (code, age, item_count, total), kitchen/bar counts, oldest waiting item age. Numbers match the web dashboard within the refresh window | US-M-01 |
| T-40 | One endpoint fails. No safe way to force this on the bar: test it in the emulator against the local stack (`TEST_STRATEGY.md`), and record N/A here | That card shows error/stale; others render | US-M-01 neg |
| T-41 | Cash closed (off-hours) | "Caja cerrada" prominent; not shown as "all clear" | US-M-01 neg |
| T-42 | Pending payment list | Entries with table code, total, wait time from `payment_requested_at`; tap opens ticket | US-M-02 |
| T-43 | Manager opens any ticket | Waiter actions available; no close or payment controls | US-M-03, D4 |
| T-44 | Admin opens Diagnostics | Server URL, last health result and latency, socket state and rooms, app version, username/role, last sync time, last error code. **No tokens or passwords** | US-A-01 |
| T-45 | Copy diagnostics to clipboard, paste into a note | No secrets present | US-A-01 neg |
| T-46 | Waiter account on Diagnostics route | Not reachable | US-A-01 neg |
| T-47 | Manager socket room (B4) | Manager phone joins `manager` and receives `joined`. Verify through Diagnostics rooms list, or a forced print failure (`print:failed`) on a test ticket | B4, `BACKEND_EXTENSIONS.md` |

---

## 8. Real-time, reconnect and concurrency

| ID | Step | Expected | Ref |
|---|---|---|---|
| T-48 | Turn Wi-Fi off for 30 s, then on | Connection indicator goes amber then green; rooms rejoined; visible queries refetch; banner clears within 3 s of reconnect | US-X-10 |
| T-49 | Background app for more than 30 s, then foreground | Visible screen refetches; socket reconnects if down. Current code has no 30 s disconnect (`NETWORKING_AND_SYNC.md` section 5), so check battery and zombie-socket behaviour with a 10 min background | US-X-10 |
| T-50 | Two waiters each add lines to the **same** open ticket at the same time | Both sets of lines present, no lost line, count matches server; ticket total is server value | Concurrency |
| T-51 | Version conflict: waiter B holds a stale ticket version and adds an item after waiter A added one | Record actual: with `X-Ticket-Version` sent (current code, D-3), expect 409 `VERSION_CONFLICT` -> refetch and retry once (US-W-08 neg). Without it, the add succeeds | D-3 |
| T-52 | Socket connect failure: stop nothing on the server; use airplane mode | Reconnecting state, no error dialog | US-X-06 |
| T-53 | Floor updates | Another phone opens a table; floor on this phone updates within 2 s (`floor:update`) | US-W-01 |
| T-54 | Ticket room join | Open ticket screen, another phone adds an item: ticket refreshes within 2 s (`ticket:item_status` / `ticket:updated`) | US-W-04 |

Database cross-check after T-17, T-20, T-21, T-50 (run on the bar host, read-only):

```bash
docker compose exec -T postgres psql -U billiard -d billiardbar -c \
  "SELECT id, menu_item_id, quantity, status, client_request_id, created_at
     FROM ticket_line_items WHERE ticket_id = '<TICKET_ID>' ORDER BY created_at;"
docker compose exec -T postgres psql -U billiard -d billiardbar -c \
  "SELECT ticket_id, client_request_id, COUNT(*) FROM ticket_line_items
     WHERE client_request_id IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1;"   # expect 0 rows
```

The second query is the duplicate-order alarm: it must return zero rows.

---

## 9. Results table template

Copy this into `TEST_RESULTS.md` (written later by others) or keep it here as the pilot log.

| Check | Expected | Actual | Pass/Fail | Notes |
|---|---|---|---|---|
| T-01 Setup screen on fresh install | Setup shown, no login | | | |
| T-02 Health OK with `<ip>:8080` | Login reached | | | |
| T-03 `<ip>` without port | Connects to 8080 | | | D-4 |
| T-08 Role routing (5 accounts) | Per role | | | |
| T-15 Double-open table | One 201, one 409 | | | |
| T-17 Send 3-line draft | 3 lines once, chit once per line | | | |
| T-18 Wi-Fi without internet | Stays online | | | D-2 |
| T-19 Airplane-mode send | Blocked, nothing later | | | D-1 |
| T-21 Wi-Fi drop mid-send | No duplicate | | | B1 present? |
| T-23 Ready notification | Banner <= 3 s | | | B2 |
| T-37 Void leaves KDS <= 15 s | Gone <= 15 s | | | D-6 |
| T-39 Ops numbers vs web | Match | | | |
| T-47 Manager room join | `joined` | | | B4 |
| T-48 Reconnect after 30 s drop | Rejoin + resync <= 3 s | | | |
| T-50 Concurrent adds | No lost line | | | |
| Duplicate alarm query | 0 rows | | | Section 8 |
| Web back-compat smoke | Unchanged | | | |
| Print agent `/health` | 200 | | | |

Attach: phone model, Android version, app version, backend `git rev-parse --short HEAD` on the bar host, migration log lines.

---

## 10. Rollback plan

| Level | Action | Data effect | When |
|---|---|---|---|
| App (phone) | `adb uninstall com.bola8.staff` or Settings > Apps > Uninstall | Local drafts and cache lost (by design). No server state changed | Any app failure |
| App (phone) | Clear data first if the server URL is wrong | Same | |
| Backend image | Redeploy the previous image with `docker compose up -d` after rebuild from the previous commit | None | If B1-B4 cause a web regression |
| Backend SQL (last resort, after image rollback) | Rollback block from `BACKEND_EXTENSIONS.md`: `DROP INDEX IF EXISTS uq_tli_ticket_client_request; ALTER TABLE ticket_line_items DROP COLUMN IF EXISTS client_request_id; DELETE FROM schema_migrations WHERE version = '002';` inside `BEGIN; ... COMMIT;` | Drops the idempotency column. Lines created with keys lose their key. No money or stock data touched | Only if the migration itself breaks the system |
| Full data | Restore from the backup taken before deploy (`BAR` section 6) | Rolls back everything since the backup. Owner decision | Data corruption only |

Run the SQL rollback only with the owner present and after taking a fresh backup.

---

## 11. Exit criteria

- All T-IDs in sections 4-8 are Pass or have an owner-accepted Fail with a ticket.
- The duplicate alarm query returns zero rows after the whole run.
- Web back-compat smoke passes after the run.
- No secret visible in the app (T-45) and no DEMO banner (T-06).
- D-1, D-2 and D-15 are resolved (they cannot be accepted as Fail for a pilot).

## Related

- `BAR_MACHINE_REQUIREMENTS.md`
- `TEST_STRATEGY.md` (what is already automated, and what this plan adds)
- `docs/mobile/product/ACCEPTANCE_CRITERIA.md`
- `docs/mobile/integration/BACKEND_EXTENSIONS.md`
