# Integration Strategy

Status: Accepted (elaborates D12, D13, B1-B4). Backend facts from `discovery/API_CAPABILITY_MATRIX.md`; migration facts from `backend/migrations/sql/manifest.txt` (only `001_baseline_squash` applied today).

## 1. Adapter layering

```
app/ screens  ->  features/*/hooks (TanStack Query / mutations)
                      |
                      v
              src/repositories   <- the only seam (RepositoryProvider)
               |             |
        real adapter     mock adapter (demo + tests)
               |
               v
          src/api (axios client, endpoint functions, error normaliser)
               |
               v
        POS backend over nginx :8080 (or :8090 in docker dev)
```

| Layer | Responsibility | Must not |
|---|---|---|
| `api/` | One function per endpoint: URL, verb, body, typed result. Auth header, timeout, 401 single-flight, error normalisation | Know about React, caching, or drafts |
| `repositories/` | Feature-oriented operations (`TicketRepository.addItem`, `FloorRepository.list`, `QueueRepository.setStatus`). Combine endpoints (adopt-existing-ticket, send-draft loop), apply feature detection, convert to domain types | Import React or TanStack |
| `hooks` (in `features/`) | `useQuery`/`useMutation` over repositories, query keys, invalidation, cache policy | Call `api/` directly |
| `app/` | Routing, composition | Contain business logic |

Seam placement: there is **one** seam (repositories), not one per layer. Two implementations genuinely exist (real and mock), which is the only justification for an interface. Domain types equal the wire shapes (snake_case `to_dict()` mirrors in `src/domain`), so repositories do not run a mapping layer; they validate only what the UI depends on and fail loudly in contract tests when the backend drifts.

Server authority (D3): repositories never compute totals, pool charges or payment rules. Timer displays are computed in the UI from `timer_start` and labelled "estimado".

## 2. Real adapter vs mock/demo adapter (D13)

- The real adapter is the only default. There is no automatic fallback to mock on failure.
- The mock adapter is selected in exactly two ways: (a) tests inject it through `RepositoryProvider adapter={mock}`; (b) the user explicitly enables "Modo demo" on the Server Setup screen (shown in debug builds, or release builds when `EXPO_PUBLIC_ALLOW_DEMO=1`). Demo mode sets a persisted `demoMode` flag.
- While `demoMode` is true: a non-dismissible DEMO DATA banner is rendered by the root layout, writes only mutate in-memory fixtures, the socket client is not created (or is replaced by a scripted event emitter), and the server URL field is disabled. Leaving demo mode clears the flag, the mock state and the query cache.
- The mock implements the same quirks that matter: HTML error bodies, 409 codes (`RESOURCE_OCCUPIED`, `TICKET_CLOSED`), idempotency replay, `OUT_OF_STOCK` with `shortages[]`. Fixtures are generated from recorded real responses (captured by the contract tests) so they cannot drift silently.

## 3. Contract tests against the local docker backend

Backend: docker compose project `billarmobile`, nginx published on host port `8090`, fresh seed users (`admin`, `manager`, `waiter1`, `kitchen`, `barstaff`; credentials and the start/stop scripts are in `LOCAL_DEV_ENVIRONMENT.md`).

Addressing:

| Caller | Base URL |
|---|---|
| Jest contract project (Node on the Windows host) | `http://localhost:8090` |
| App in Android emulator (`billar_mobile_api35`), Maestro E2E | `http://10.0.2.2:8090` |
| Physical phone against the dev machine | `http://<host LAN IP>:8090` (firewall inbound rule) |

Layout: `mobile/src/test/contract/*.contract.test.ts`, run by a separate Jest project (`testEnvironment: node`, `maxWorkers: 1`, `POS_API_URL` env var). They call the real `src/api` and `src/repositories` code, so they test the client as shipped.

Suites (each creates and cleans up its own data; never relies on pre-existing tickets):

| Suite | Asserts |
|---|---|
| health | `GET /health` 200 `{status:"ok"}`; `api_features` shape if present |
| auth | login per role, `/me`, refresh, logout then access token rejected, refresh still works (documents G3), bad credentials -> 401 `INVALID_CREDENTIALS`, rate-limit 429 shape (run last, resets on restart) |
| error shapes | 404 HTML, 401/422 `{msg}`, `{error,message}`, `{error}` only: the normaliser maps all to `AppError` |
| catalog | resources, menu (categories, items, modifiers), settings, stock-check shapes |
| cash and tickets | manager opens cash session; waiter opens table ticket; double-open -> 409 `RESOURCE_OCCUPIED`; add item -> 201 line SENT; request-payment; cancel empty ticket |
| void and qty (PIN) | `DELETE /items/<id>` **with JSON body** works through axios on the RN/XHR path and via Node; wrong PIN -> 401 `INVALID_PIN`; `verify-pin` 5/min bucket |
| queue | PATCH status SENT->IN_PROGRESS->READY->SERVED; voided item (B3 -> 409 `ITEM_VOIDED`, before B3 documents G5) |
| idempotency (B1) | same key twice -> one line, second 200; different content same key -> 409 `IDEMPOTENCY_KEY_REUSED`; no second stock deduction (compare `/inventory/stock-check`); no second print job |
| socket | connect via nginx path `/socket.io`, websocket and polling both; join `floor`, receive `floor:update` after ticket open; `kitchen:item_update` payload fields (B2); `manager` join without token / with waiter token -> `error`; with manager token -> `joined` and receives `print:failed`-class events (B4) |

Tests that need B1-B4 are tagged `@b1`..`@b4` and run only when the target advertises the capability; otherwise they are reported as **skipped: capability absent**, not passed. A CI-style run against a fully extended backend must have zero skips.

**Production safety:** contract tests mutate data. They refuse to run unless `POS_API_URL` host is in an allow-list (`localhost`, `127.0.0.1`, `10.0.2.2`) or `POS_CONTRACT_I_KNOW=1`. A read-only `smoke` tag (health, login, resources, menu, queue reads) is the only subset allowed against the bar machine.

## 4. Backend extensions (worktree only; deploy to the bar machine to take effect)

All are additive and backward compatible with the web app. Each ships with backend tests in `backend/tests/` and contract tests above.

### B1 - Idempotency-Key on `POST /tickets/<id>/items`

Request: unchanged body (`menu_item_id`, `quantity`, `modifiers`, `notes`) plus optional header `Idempotency-Key: <uuid v4>`.

Behaviour:
1. Header absent: exactly today's behaviour (plus `ticket_version` in the response).
2. Header present but not matching `[A-Za-z0-9_-]{1,64}`: **422** `{error:"INVALID_IDEMPOTENCY_KEY"}` (as implemented, see BACKEND_EXTENSIONS.md).
3. Lookup `(ticket_id, client_request_id)` **before** the `TICKET_CLOSED`, stock and version checks. If found: return **200** with the existing line, no new row, no stock consumption, no chit print, no socket emit. The body of a replay is **not** compared with the stored line (a `409 IDEMPOTENCY_KEY_REUSED` check was planned but is not implemented; follow-up SEC-12), which is why the mobile app locks uncertain lines against editing. If the existing line is VOIDED: still 200 with `status:"VOIDED"` so the client does not resend.
4. Not found: normal create (201), storing the key. A unique-violation race (`IntegrityError` on the partial index) rolls back (which also undoes the stock consumption, same transaction), re-selects and returns 200.
5. Response (201 and 200): the line `to_dict()` plus `client_request_id` and `ticket_version` (the ticket's `version` after commit). Replays add `idempotent_replay: true`.

Migration outline (next file after the baseline, `backend/migrations/sql/002_line_item_client_request_id.sql`, stem appended to `manifest.txt`):

```sql
ALTER TABLE ticket_line_items
  ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_line_item_client_request
  ON ticket_line_items (ticket_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
```

Also add the column to the SQLAlchemy model (`TicketLineItem`) and to the legacy idempotent DDL path in `init-db` only if the clean-install validation suite requires parity (check `scripts/verify_clean_install.sh`). Rollback: drop the index and column; nothing else depends on them.

Compatibility: old web and old mobile builds do not send the header, so behaviour is unchanged. Rows created before the migration have a NULL key and never collide (partial index). Retention: keys live as long as the line; storage cost is negligible.

Feature detection: (1) preferred - proposal P2 below adds `api_features: ["idempotency-key", ...]` to `GET /health`; (2) fallback - the first successful item add returns `ticket_version`; until one is observed the client assumes B1 is **absent** and does not auto-retry sends (NETWORKING_AND_SYNC section 3). The client never relies on (2) for the first send of a session, which is why P2 is strongly recommended.

### B2 - Richer item-update socket payloads

Add to `kitchen:item_update`, `bar:item_update` and `ticket:item_status` (emitters in `queue.py:104-110` and `tickets.py:101`): `ticket_id`, `resource_code`, `menu_item_name`, `quantity`. **Not** `opened_by`: the `kitchen`/`bar`/`ticket:*` rooms are joinable without a token (G1), so the opener's user id must not be broadcast (SEC-05). The mobile app matches "my tickets" against `GET /tickets?status=OPEN`. Existing keys `item_id`, `status` (or `needs_reprint`) are unchanged. One query joins `TicketLineItem -> Ticket -> Resource` on the already-loaded item. Web ignores unknown keys. Detection: presence of `ticket_id` in the first payload, or `socket-payload-v2` in `api_features`.

Privacy note: `kitchen`/`bar`/`ticket:*` rooms are joinable without authentication (G1). The added fields (table code, item name, quantity, opener id) are the minimum for the ready notification; do **not** add prices or customer names.

### B3 - Reject status changes on VOIDED lines

`PATCH /queue/<item>/status`: if `item.status == 'VOIDED'` return 409 `{error:"ITEM_VOIDED", message}` before any write or emit. No other change. Mobile maps it to "refetch queue, drop the item, toast". Today (G5) a voided item can be revived into the queue.

### B4 - `manager` room is actually joined

`sockets/events.py:on_join`: after the existing token validation passes for `manager`, call `join_room('manager')` and emit `joined`. Strengthen the check slightly: reject tokens whose `jti` is in the blocklist. Side effect: web managers will start receiving `print:failed` toasts that were meant to work (intended behaviour, mention in release notes). Detection: `joined {room:'manager'}` arrives.

### Proposals not in PROJECT_STATE (for orchestrator decision)

| ID | Change | Why |
|---|---|---|
| P1 | `ProxyFix(x_for=1)` in `create_app` (nginx already sets `X-Forwarded-For`) | Rate-limit buckets and audit IPs become per client instead of one shared bucket (login 10/min and verify-pin 5/min across all phones) |
| P2 | `GET /health` returns `{"status":"ok","api_features":[...]}` | Reliable, side-effect-free feature detection before the first send; web ignores it |
| P3 | `logout` also revokes the refresh token; `jwt_required` paths reject inactive users; honour `JWT_ACCESS_HOURS` | Closes G3/G25 for lost phones (see SECURITY_MODEL) |
| P4 | Restrict `request-payment` on POOL tickets, or return a warning flag | It stops the timer and frees the table (G11); a waiter tapping "request bill" by mistake changes billing |
| P5 | `POST /tickets/<id>/items/batch` (array with per-line keys, one transaction, one chit, one socket burst) | Removes partial-send states and N chits per send; per-line send stays as the fallback |

## 5. Checklist: switching from docker dev to the real bar machine

Prerequisite: the Mac/iOS and bar-machine access blockers in PROJECT_STATE are external. Do not start until the owner approves.

Backend
- [ ] Take a database backup with the existing backup script and note the restore command.
- [ ] Deploy B1-B4 (and any accepted P-items) with the normal update script; confirm `flask apply-migrations` applied `002_...` (check logs and `\d ticket_line_items`).
- [ ] Web UI smoke test after deploy (login, open ticket, add item, KDS, print) to prove back-compat.
- [ ] `GET /api/v1/health` shows the expected `api_features`.
- [ ] Rotate defaults: `ADMIN_PASSWORD`, `SECRET_KEY`, seeded manager/admin PINs; create one user per staff member with the right role.
- [ ] Cash session is open during the pilot (otherwise ticket creation returns 403 `BAR_CLOSED`).

Network
- [ ] DHCP reservation (or static IP) for the POS host; record the IP.
- [ ] Windows Firewall inbound rule for the published nginx port on the active network profile.
- [ ] Staff SSID has no client isolation and reaches the POS host; test from a phone browser: `http://<ip>:8080/api/v1/health`.
- [ ] Decide mobile-data policy for staff phones (see NETWORKING_AND_SYNC section 11).
- [ ] Decide the HTTPS roadmap date (SECURITY_MODEL section 3).

App
- [ ] Release APK built locally (`assembleRelease`) with the local keystore; version string recorded.
- [ ] Sideload via `adb install` or file transfer; allow "install unknown apps" for the file manager only.
- [ ] Server Setup: enter the bar URL; health passes; DEMO banner is **absent**.
- [ ] Run the read-only `smoke` contract subset against the bar URL (the allow-list guard needs `POS_CONTRACT_I_KNOW=1` for it; mutating suites stay off).
- [ ] Pilot with one waiter in a quiet shift: send a one-line order, confirm kitchen chit prints once, confirm the READY alert, check Postgres for no duplicate lines after a deliberate Wi-Fi toggle mid-send.
- [ ] Verify the real printer and print agent behaviour (not exercised in docker).

Rollback
- [ ] Uninstall the APK (no server state to undo).
- [ ] Backend extensions are additive; disabling is optional. If needed, redeploy the previous image; the nullable column and unused index are harmless.
