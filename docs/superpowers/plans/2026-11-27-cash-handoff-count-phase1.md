# Cash handoff count — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The manager counts the drawer by denomination (bills and coins) at close and at opening; the close splits the count into "queda en caja" (the expense fund) and the envelope; two slips print and go into the envelope; the owner sees the overnight difference.

**Architecture:** A pure service (`cash_count_svc.py`) owns denominations, validation and the split. Migration 058 adds append-only `cash_counts` / `cash_count_lines` and `cash_envelopes`. `POST /cash/open` and `/cash/close` accept counts; a setting flag decides whether counts are required. Web and mobile share one grid behaviour; slips print through the existing browser-print helper.

**Tech Stack:** Flask + SQLAlchemy + PostgreSQL 15; React + TypeScript + Vite; Expo / React Native + jest.

**Spec:** `docs/superpowers/specs/2026-11-27-cash-handoff-count-design.md` (approved by CJ 2026-11-27). Read it first.

## Global Constraints

- High-risk area (cash sessions). The PR description must say so; never weaken an existing test.
- Money in integer cents everywhere (DB, API, TS). Denominations are cents: MXN = `[100000, 50000, 20000, 10000, 5000, 2000, 2000, 1000, 500, 200, 100, 50]` where the first `2000` is the $20 bill and the second the $20 coin — keep them as two rows with `kind: 'BILL' | 'COIN'`.
- Settings keys (exact): `cash.count_by_denomination` (bool, default off), `cash.drawer_fund_cents` (int, default `200000`).
- A MANAGER never sees expected cash or variance before the close is submitted, never sees the opening variance, and never sees the drawer-left lines/total after the close. ADMIN sees everything.
- Counts are append-only. Only ADMIN corrects, via recount, with a reason, audited.
- Printing never blocks a close.
- UI strings in both `frontend/src/i18n/es.ts` and `en.ts`. Spanish is primary.
- Backend tests are plain scripts (`python -m tests.<name>`) printing PASS/FAIL, exit non-zero on failure; DB tests refuse a database whose name lacks `scratch`. Add each new test to `backend/tests/ci_suite.txt`.
- Schema only through `backend/migrations/sql/058_cash_counts.sql` in `manifest.txt`, BEGIN/COMMIT, guarded on `_applied('057')`, inserts its own `schema_migrations` row. Copy 057's shape. Tables must be `CREATE TABLE IF NOT EXISTS` because `init-db` runs `db.create_all()` from the models before migrations.
- CJ does every commit and deploy. "Commit" steps below mean: stage the files and stop; CJ commits.

## Review Focus

1. **Two closes racing** (double-tap Submit, or web and mobile at once): exactly one session closes and exactly one envelope exists. → Task 3 test `close twice creates one envelope`.
2. **Fund larger than what was counted** (slow night, tips paid out): drawer_left above counted per row is refused; drawer_left below target is accepted only with a note. → Task 3 tests.
3. **First opening after the flag is turned on** (no previous drawer-left): opening succeeds, variance is `null`, not 0. → Task 4 test.
4. **Manager reading drawer-left through another door** (`/cash/sessions`, `/cash/<id>/summary`, the close response, `/cash/status`): none carries it for MANAGER. → Task 4 test loops over all four.
5. **Legacy client with the flag on** (an old mobile build): gets a 422 with a Spanish message naming the POS screen, not a 500 or a silent zero count. → Task 3 test.

---

### Task 1: Denomination service (pure, no DB)

**Files:**
- Create: `backend/app/services/cash_count_svc.py`
- Test: `backend/tests/test_cash_count_svc.py` (add to `ci_suite.txt`)

**Interfaces:**
- Produces:
  - `Denom = TypedDict('Denom', {'key': str, 'cents': int, 'kind': str})` — `key` is stable, e.g. `'B1000'`, `'C20'`, `'C0.50'`.
  - `denominations(currency: str) -> list[Denom]` — MXN table above; any other currency → `[]`. With `[]` the flag cannot be turned on (Task 3), so other currencies keep today's single-total close until their table is added.
  - `class CountError(ValueError)` with `.code: str` (`'UNKNOWN_DENOMINATION' | 'NEGATIVE' | 'NOT_INTEGER' | 'LEFT_EXCEEDS_COUNTED'`) and `.key: str | None`.
  - `parse_lines(raw: list[dict], currency: str) -> dict[str, int]` — input `[{'key': 'B500', 'qty': 3}, ...]`; merges duplicates; drops zero rows; raises `CountError`.
  - `total_cents(lines: dict[str, int], currency: str) -> int`
  - `split(counted: dict[str, int], left: dict[str, int]) -> dict[str, int]` — envelope lines = counted − left per key; raises `CountError('LEFT_EXCEEDS_COUNTED', key)`.

- [ ] **Step 1: Write the failing test** — checks:
  - `denominations('MXN')` has 12 rows; `B20` and `C20` both `cents == 2000` with kinds `BILL` / `COIN`; `C0.50` is `50`.
  - `total_cents({'B500': 3, 'C0.50': 3}, 'MXN') == 150150`.
  - `parse_lines([{'key':'B500','qty':2},{'key':'B500','qty':1}], 'MXN') == {'B500': 3}`.
  - `parse_lines` raises code `UNKNOWN_DENOMINATION` for `'B300'`, `NEGATIVE` for `qty: -1`, `NOT_INTEGER` for `qty: 1.5` and for `'2'`.
  - `split({'B500': 4, 'C10': 20}, {'C10': 20, 'B500': 2}) == {'B500': 2}`; `split({'C10': 5}, {'C10': 6})` raises `LEFT_EXCEEDS_COUNTED` with `key == 'C10'`.
  - `denominations('USD') == []`.
- [ ] **Step 2:** `cd backend && python -m tests.test_cash_count_svc` → FAIL (module missing).
- [ ] **Step 3:** Implement `cash_count_svc.py` with the signatures above. No DB, no Flask imports.
- [ ] **Step 4:** Run again → all PASS, exit 0.
- [ ] **Step 5:** Stage for CJ.

### Task 2: Migration 058 and models

**Files:**
- Create: `backend/migrations/sql/058_cash_counts.sql`; Modify: `backend/migrations/sql/manifest.txt`
- Modify: `backend/app/models/cash_session.py` (add `CashCount`, `CashCountLine`, `CashEnvelope`)
- Test: `backend/tests/test_cash_counts_schema.py` (scratch DB; add to `ci_suite.txt`)

**Interfaces:**
- Produces tables / models:
  - `cash_counts(id varchar(36) pk, session_id fk cash_sessions not null, kind varchar(12) check in ('OPENING','CLOSE','DRAWER_LEFT') not null, total_cents integer not null, counted_by fk users not null, counted_at timestamptz default now(), note text, supersedes_id fk cash_counts null, reason text)`; index `(session_id, kind, counted_at)`.
  - `cash_count_lines(count_id fk cash_counts on delete restrict, denom_key varchar(8), denom_cents integer, quantity integer check >= 0, primary key (count_id, denom_key))`.
  - `cash_envelopes(id varchar(36) pk, number integer unique not null, session_id fk unique not null, declared_cents integer not null, created_by fk users, created_at timestamptz default now(), status varchar(12) default 'IN_SAFE')`; `number` from a sequence `cash_envelope_number_seq`.
  - "Current" count of a kind for a session = the row with that kind not referenced by any `supersedes_id`.
  - Settings rows inserted `ON CONFLICT DO NOTHING`: `cash.count_by_denomination='off'`, `cash.drawer_fund_cents='200000'`.
- [ ] **Step 1: Write the failing test** — on a scratch DB after migrations: the three tables exist; `cash_count_lines.quantity = -1` insert is refused; a second envelope for the same session is refused (unique); `number` increments; both settings rows exist with the default values; `schema_migrations` has `058`.
- [ ] **Step 2:** Run against a fresh scratch DB (`scripts/ci/run_backend_tests.sh` style: init-db, seed, apply-migrations) → FAIL.
- [ ] **Step 3:** Write `058_cash_counts.sql` (057's shape, `IF NOT EXISTS` everywhere) and the three models with matching columns; add `058_cash_counts` to `manifest.txt`.
- [ ] **Step 4:** New test PASS; `test_money_columns` and `test_manifest_baseline` still PASS (all new `*_cents` are integer).
- [ ] **Step 5:** Stage for CJ.

### Task 3: Open and close with counts (server)

**Files:**
- Modify: `backend/app/api/cash_session.py` (`open_session`, `close_session`)
- Create: `backend/app/services/cash_handoff_svc.py` (DB side: write counts, envelope, read current counts)
- Modify: `backend/app/api/settings.py` (`_NUMERIC_KEYS['cash.drawer_fund_cents'] = (0, 10_000_000, 'Fondo de caja (centavos)')`)
- Test: `backend/tests/test_cash_handoff.py` (scratch DB; add to `ci_suite.txt`)

**Interfaces:**
- Consumes: Task 1 functions; Task 2 models; `settings_svc.get_bool`.
- Produces:
  - Request `POST /cash/open`: `{count: [{key, qty}]}` or legacy `{opening_fund_cents}`.
  - Request `POST /cash/close`: `{count: [...], drawer_left: [...], notes}` or legacy `{closing_cash_counted_cents, notes}`.
  - `cash_handoff_svc.record_open(session, lines, user_id) -> int` (total), `record_close(session, counted, left, user_id, note) -> CashEnvelope`, `current_count(session_id, kind) -> CashCount | None`, `fund_target_cents() -> int`.
  - Close response adds `envelope: {number, declared_cents, lines: [{key, qty}]}` and, **only for ADMIN**, `drawer_left: {total_cents, lines}`. For MANAGER the drawer-left lines are returned **once**, in the close response field `slip_drawer_left`, solely so the browser can print the slip that goes into the envelope; no other endpoint ever returns them to a MANAGER.
  - Errors (HTTP 422, `{error, message, key?}`): `COUNT_REQUIRED` ("Cuenta billetes y monedas en la pantalla de Caja del POS para cerrar." — also returned to legacy bodies when the flag is on), `UNKNOWN_DENOMINATION`, `NEGATIVE`, `NOT_INTEGER`, `LEFT_EXCEEDS_COUNTED`, `NOTE_REQUIRED` (drawer_left total ≠ `fund_target_cents()` and `notes` empty).
- [ ] **Step 1: Write the failing tests** (ADMIN/MANAGER tokens as in `test_batch_c.py`):
  - `PUT /settings/cash.count_by_denomination` value `on` while `venue.currency` is not MXN → 422 ("No hay tabla de billetes y monedas para esta moneda").
  - flag off: legacy open/close bodies still work exactly as today.
  - flag on: legacy close → 422 `COUNT_REQUIRED`; legacy open → 422 `COUNT_REQUIRED`.
  - open with count `B1000×1, B500×2` → `opening_fund_cents == 200000`.
  - close with count totaling 580000 and drawer_left totaling 200000 → `closing_cash_counted_cents == 580000`, envelope `declared_cents == 380000`, envelope lines = counted − left.
  - drawer_left row above counted → 422 `LEFT_EXCEEDS_COUNTED` with `key`; session stays OPEN.
  - drawer_left 150000 with empty notes → 422 `NOTE_REQUIRED`; with notes → 200.
  - `close twice creates one envelope`: second close → 404 `NO_OPEN_SESSION`; `SELECT count(*) FROM cash_envelopes WHERE session_id=…` == 1.
  - MANAGER close response: has `envelope` and `slip_drawer_left`, has no `drawer_left`.
  - `PUT /settings/cash.drawer_fund_cents` value `-1` → 422.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Close does the count write, envelope insert and session update in one transaction; lock the open session row with `SELECT … FOR UPDATE` before checking status.
- [ ] **Step 4:** New test PASS; `tests.test_batch_c` (not in CI; run manually against scratch) still PASS.
- [ ] **Step 5:** Stage for CJ.

### Task 4: Owner-only visibility and the overnight difference

**Files:**
- Modify: `backend/app/api/cash_session.py` (`_for_viewer`, `/status`, `/sessions`, `/<id>/summary`)
- Modify: `backend/app/api/home.py` (owner card near the last-close block, ~line 186)
- Test: extend `backend/tests/test_cash_handoff.py`

**Interfaces:**
- Produces, ADMIN only, in `/<id>/summary` and `/sessions` rows: `opening_variance_cents: int | null` (= this session's OPENING total − previous closed session's current DRAWER_LEFT total; `null` when either is missing), `drawer_left_cents`, `envelope_number`, `envelope_declared_cents`. MANAGER rows carry `envelope_number` and `envelope_declared_cents` only.
- Home (ADMIN): `ultimo_cierre.diferencia_apertura_cents` with the same rule.
- [ ] **Step 1: Write the failing tests:**
  - night 1 close leaves 200000; night 2 open counts 195000 → ADMIN sees `opening_variance_cents == -5000`.
  - first open after flag on (no previous DRAWER_LEFT) → `opening_variance_cents is None`.
  - MANAGER: for each of `/cash/status`, `/cash/sessions`, `/cash/<id>/summary`, and the open response, assert no key among `opening_variance_cents`, `drawer_left_cents`, `drawer_left` appears anywhere in the JSON (recursive key scan, like `money_keys` in `test_batch_c.py`).
  - existing blind rule: MANAGER on an OPEN session still gets no `expected_cash_cents`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement in `_for_viewer` (single place that strips fields) plus the home query.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Stage for CJ.

### Task 5: Owner recount (correction)

**Files:**
- Modify: `backend/app/api/cash_session.py` (new route), `backend/app/services/cash_handoff_svc.py`
- Test: extend `backend/tests/test_cash_handoff.py`

**Interfaces:**
- Produces `POST /cash/sessions/<id>/recount` (ADMIN only): `{kind: 'OPENING'|'CLOSE'|'DRAWER_LEFT', count: [...], reason: str}` → 200 with the updated summary. Writes a new `cash_counts` row with `supersedes_id`, then rewrites `opening_fund_cents` (OPENING), `closing_cash_counted_cents` (CLOSE) and/or `cash_envelopes.declared_cents` (CLOSE or DRAWER_LEFT: envelope = current CLOSE − current DRAWER_LEFT). Audit: `audit_svc.log(user_id, 'CASH_RECOUNT', 'cash_session', id, before=…, after=…, reason=reason)`.
- [ ] **Step 1: Write the failing tests:** MANAGER → 403; empty reason → 422; ADMIN CLOSE recount changes `closing_cash_counted_cents` and envelope declared; old count row still exists; one `audit_logs` row with action `CASH_RECOUNT`; recount making DRAWER_LEFT exceed CLOSE → 422 `LEFT_EXCEEDS_COUNTED`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Stage for CJ.

### Task 6: Web count grid, open/close flow and owner settings

**Files:**
- Create: `frontend/src/components/CashCountGrid.tsx`, `frontend/src/utils/cashCount.ts`
- Modify: `frontend/src/pages/manager/CashSessionPage.tsx`, `frontend/src/components/OwnerLimits.tsx` (flag toggle + fund amount), `frontend/src/i18n/es.ts`, `en.ts`

**Interfaces:**
- Consumes: Task 3 request/response shapes. Denominations come from a new field `denominations: Denom[]` and `fund_target_cents` on `GET /cash/status` (add in Task 3's file; same shape as Task 1).
- Produces: `CashCountGrid({denoms, value, onChange, max?, autoFocus?})` where `value`/`max` are `Record<string, number>`; `cashCount.ts`: `totalCents(lines, denoms)`, `splitEnvelope(counted, left)`, `toApi(lines)` → `[{key, qty}]`.
- Behaviour: Enter/Tab moves to the next row; totals live; `max` greys a row's input above the counted qty. Close flow when `count_by_denomination` is on: reminder line ("Paga las propinas y registra todos los gastos antes de contar") → grid "Contar caja" → grid "¿Qué se queda en caja?" with live faltan/sobran vs `fund_target_cents` and a required note when ≠ → read-only envelope list → Submit. Open flow: grid instead of the fund input. Flag off: today's screens unchanged.
- [ ] **Step 1:** `cd frontend && npx tsc --noEmit` baseline passes.
- [ ] **Step 2:** Implement; strings in both i18n files.
- [ ] **Step 3:** `npm run build` passes.
- [ ] **Step 4:** Manual check on the local stack (`docker compose up -d --build backend frontend`, never scheduler/telegram-bot) against a scratch-copied DB with the flag on: open → close → envelope shown; a MANAGER never sees expected before submit. Record screenshots for CJ.
- [ ] **Step 5:** Stage for CJ.

### Task 7: Slips

**Files:**
- Modify: `frontend/src/utils/printCashReconciliation.ts` (add `printEnvelopeSlips(envelope, drawerLeft, meta)`), `CashSessionPage.tsx` (call after close, before the existing reconciliation print; session view: ADMIN can reprint both, MANAGER only the Sobre slip)

**Interfaces:**
- Consumes: close response `envelope` and `slip_drawer_left` (Task 3).
- Produces: one print window with two slips separated by a cut line: **SOBRE #N** (number in large type, business date, manager, lines `qty × denom = amount`, total) and **QUEDA EN CAJA — va dentro del sobre** (same layout, coins listed). 48 mm style from `SHARED_STYLE`. Wrapped in try/catch; failure shows a toast, never blocks.
- [ ] **Step 1:** Implement. **Step 2:** `npm run build` passes. **Step 3:** Print preview screenshot for CJ (Chrome "Save as PDF" at 48 mm). **Step 4:** Stage for CJ.

### Task 8: Mobile app

**Files:**
- Modify: `mobile/src/api/endpoints/cash.ts` (`openCash(count | fundCents)`, `closeCash({count, drawerLeft, notes} | countedCents)`), `mobile/src/features/manager/cash/cashModel.ts`, `CashScreen.tsx`, `mobile/src/test/contractClient.ts`
- Test: `mobile/src/features/manager/__tests__/cashModel.test.ts`, `CashScreen.test.tsx`

**Interfaces:**
- Consumes: `/cash/status` `denominations`, `fund_target_cents`, `count_by_denomination`; Task 3 bodies and errors.
- Produces in `cashModel.ts`: `totalCents`, `splitEnvelope`, `toApi` with the same semantics as web `cashCount.ts`; `canCloseCounted(counted, left, fundTarget, note): {ok: boolean, reason?: 'LEFT_EXCEEDS'|'NOTE_REQUIRED'}`.
- Mobile does not print slips (no printer); after a mobile close it shows "Imprime los comprobantes del sobre desde el POS" and the envelope number. The manager reprints the Sobre slip from the web session view; the drawer slip is printed by the owner.
- [ ] **Step 1: Write failing jest tests:** `splitEnvelope` and `canCloseCounted` cases mirroring Task 3; `CashScreen` with flag on renders the grid and sends `{count, drawer_left, notes}`; flag off sends the legacy body; 422 `COUNT_REQUIRED` shows its message.
- [ ] **Step 2:** `cd mobile && npm test -- --ci` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx tsc --noEmit` and `npm test -- --ci` PASS.
- [ ] **Step 5:** Stage for CJ.

### Task 9: Runbook

**Files:**
- Create: `docs/DEPLOY-2026-11-xx-cash-handoff.md` (date set at deploy)

- [ ] **Step 1:** Write CJ's steps: Windows backup (`pg_dump -Fc` inside the container, `docker cp` out; never through the PowerShell pipeline), zip deploy, `docker compose build` **then** `up -d`, check `flask migration-status` shows 058 applied, check the screens with the flag **off**, then the owner turns on `cash.count_by_denomination` in Límites del dueño **only after** the mobile build with Task 8 is installed on the managers' phones. First night after turning it on: no overnight difference is shown (expected).
- [ ] **Step 2:** Stage for CJ.
