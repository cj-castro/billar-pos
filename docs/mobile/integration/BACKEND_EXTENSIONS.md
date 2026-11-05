# Backend Extensions B1-B4 (mobile companion)

All four changes are additive and backward compatible with the web frontend (no existing field removed or renamed; no status code changed for existing flows; the only new non-2xx is B3's 409 on a voided line).

**Deployment: these changes must be deployed to the bar machine (backend image rebuild + `flask apply-migrations`). They are NOT deployed anywhere by this work; only the local `billarmobile` docker stack (port 8090) runs them.**

Also added: root `.gitattributes` (`backend/entrypoint.sh` and `*.sh` -> `eol=lf`) so a Windows CRLF checkout no longer breaks the container (`exec /entrypoint.sh: no such file or directory`).

## B1 - Idempotent item add

**Problem.** A mobile retry (flaky Wi-Fi) of `POST /tickets/<id>/items` created a duplicate line, consuming inventory and printing a second chit.

**Change.**
- `backend/app/api/tickets.py` `add_item`: reads optional `Idempotency-Key`; validates; looks up an existing line for `(ticket_id, key)` after the ticket lock and TICKET_CLOSED check but **before** the `X-Ticket-Version` check; on IntegrityError (race on the unique index) rolls back and returns the existing line with 200.
- `backend/app/models/ticket.py`: `TicketLineItem.client_request_id` column; `to_dict()` now includes `client_request_id`.
- `backend/migrations/sql/002_line_item_client_request_id.sql`, registered in `manifest.txt`.

**Contract.**

| Case | Result |
|---|---|
| no header | unchanged behaviour, 201, `client_request_id: null` |
| key not matching `[A-Za-z0-9_-]{1,64}` (incl. empty) | 422 `{"error":"INVALID_IDEMPOTENCY_KEY"}` |
| new key | 201, line JSON + `ticket_version` (int, current ticket version) |
| existing `(ticket, key)` | **200**, existing line JSON + current `ticket_version`; no inventory consumption, no version bump, no socket emit, no print, no audit; a stale `X-Ticket-Version` is ignored on this path |

Keys are scoped per ticket (same key on another ticket is a new line).

**Migration** (`002_line_item_client_request_id.sql`, idempotent, single transaction):
```sql
ALTER TABLE ticket_line_items ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tli_ticket_client_request
    ON ticket_line_items (ticket_id, client_request_id) WHERE client_request_id IS NOT NULL;
```
Fresh install: `init-db` -> `create_all` creates the column from the model; `apply-migrations` finds it present (no-op) and creates the index. Existing DB: the migration adds both. Either way exactly one column and one index (verified on the local DB by re-applying the file by hand: still 1 index, 1 column). The model deliberately declares no index, so the index has a single owner.

**Rollback** (also in the SQL file header):
```sql
BEGIN;
DROP INDEX IF EXISTS uq_tli_ticket_client_request;
ALTER TABLE ticket_line_items DROP COLUMN IF EXISTS client_request_id;
DELETE FROM schema_migrations WHERE version = '002';
COMMIT;
```
Roll the backend image back first (older code never touches the column).

**Feature detection.** `ticket_version` present in the add-item response => B1 deployed. Absent => refetch the ticket after send and do not rely on idempotency.

## B2 - Richer ready payloads

**Problem.** `item_update` / `item_status` carried only `item_id, status`, so the mobile app had to refetch to notify "Table 4: Nachos ready".

**Change.** `backend/app/api/queue.py` `update_status`: both `<routing>:item_update` (rooms `kitchen`/`bar`) and `ticket:item_status` (room `ticket:<id>`) emit the same payload:
```json
{"item_id": "...", "status": "READY", "ticket_id": "...", "resource_code": "M1",
 "menu_item_name": "...", "quantity": 1, "opened_by": "<user id of ticket opener>"}
```
`item_id`, `status` unchanged. `resource_code` is `null` for resource-less tickets (express/delivery). The HTTP response body is unchanged. Detection: `ticket_id` present in the event.

## B3 - Voided items reject status changes

**Problem.** `PATCH /queue/<id>/status` could flip a VOIDED line back to IN_PROGRESS/READY/SERVED, so it would reappear in queues.

**Change.** `queue.py` `update_status`: if `item.status == 'VOIDED'` -> **409** `{"error":"ITEM_VOIDED","message":"Item was voided and cannot change status"}`; nothing written, nothing emitted. No role-check changes. Detection: 409 `ITEM_VOIDED`.

## B4 - Manager socket room join

**Problem.** `on_join` validated token/role for room `manager`, then fell through to a public-room check that excludes it, so nobody ever joined and no `joined` ack was sent.

**Change.** `backend/app/sockets/events.py`: after successful validation (role MANAGER/ADMIN) -> `join_room('manager')` + `emit('joined', {'room': 'manager'})`. Invalid token -> `error: Unauthorized`; other roles -> `error: Forbidden` (unchanged). Public rooms (`floor, kitchen, bar, waiting`, `ticket:*`) untouched. Detection: `joined` ack for `manager`.

## Compatibility with the web frontend
- Line JSON only gains `client_request_id` and (add-item only) `ticket_version`; the web ignores unknown fields.
- The web never sends `Idempotency-Key`, so its path is identical (201, same side effects).
- Socket consumers read `item_id`/`status` and ignore extra keys.
- The only new rejection (B3) targets a voided line, which the web UI does not offer to update.

## Test evidence
Live run against the local stack (`billarmobile`, `http://localhost:8090`) after `up -d --build backend`.

Migration log: `002_line_item_client_request_id  002 OK -- ticket_line_items.client_request_id + uq_tli_ticket_client_request  (80 ms)` then `Migrations: 1 applied, 1 already present, 0 failed`.
`\d ticket_line_items`: `client_request_id | character varying(64)` and `"uq_tli_ticket_client_request" UNIQUE, btree (ticket_id, client_request_id) WHERE client_request_id IS NOT NULL`.

`cd backend && python -m tests.test_mobile_extensions_live` -> 29 PASS, 0 FAIL:
```
PASS: cash session opened
PASS: found AVAILABLE REGULAR_TABLE
PASS: waiter opened ticket (201)
PASS: B4 manager join -> joined
PASS: B4 public rooms still join
PASS: B4 waiter token denied manager room
PASS: B1 add with key -> 201
PASS: B1 201 carries ticket_version (int)
PASS: B1 201 carries client_request_id
PASS: B1 ticket_version == ticket.version
PASS: B1 replay same key -> 200
PASS: B1 replay same line id
PASS: B1 replay ticket_version unchanged
PASS: B1 replay with stale X-Ticket-Version -> 200 (not 409)
PASS: B1 replay: line count, subtotal, version unchanged
PASS: B1 new key -> 201
PASS: B1 new key bumps version
PASS: B1 new key -> distinct line
PASS: B1 invalid key 'bad key!' -> 422 INVALID_IDEMPOTENCY_KEY
PASS: B1 invalid key 'xxxxxxxxxx' -> 422 INVALID_IDEMPOTENCY_KEY
PASS: B1 invalid key '' -> 422 INVALID_IDEMPOTENCY_KEY
PASS: B1 no header -> 201 (legacy), key null
PASS: B2 PATCH READY -> 200
PASS: B2 kitchen:item_update has all fields
PASS: B2 field values
PASS: B2 other queue READY -> 200
PASS: void line with manager PIN -> 200
PASS: B3 PATCH status on voided -> 409 ITEM_VOIDED
PASS: B3 voided status unchanged
PASS: cleanup: ticket force-closed
```
Existing suites (`python -m tests.<module>`) unchanged: close_required_total 9/9, manifest_baseline 24/24, modifier_promotions 17/17, money_columns 9/9, pool_free_time 49/49, promo_time_window 31/31, promotions 27/27. (modifier_promotions only fails inside the container because `scripts/` is not in the image; pre-existing, passes on host.)

Notes: the Python socket client had no `websocket-client`, so the test used long-polling (sufficient for these checks). "No inventory change" on replay is asserted via unchanged line count / subtotal / ticket version, not by reading stock tables. The concurrent-race path (IntegrityError) is implemented but not exercised by the live test, since the ticket row lock serializes same-ticket adds.
