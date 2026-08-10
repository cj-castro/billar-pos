# Print Path Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the receipt/chit print path from 4.0/10 to ≥8/10 (robustness, scalability, reusability, shock-proof, fail-proof, bulletproof, reliable) using the printers already installed — one USB, one Bluetooth-paired ("Cocina Comandas", bound to COM3) — with no new hardware and no new external/cloud service.

**Architecture:** Three independent, non-overlapping file sets — the Windows print agent (`scripts/print_agent/`), the backend Flask services that talk to it (`backend/app/services/`, `backend/app/api/`), and the frontend call sites that surface its errors (`frontend/src/`) — hardened in place. No protocol change: `win32print` still talks to both printers exactly as today: Windows' Bluetooth driver already presents "Cocina Comandas" as a normal printer object on a virtual COM port.

**Tech Stack:** Flask, `waitress` (new — production WSGI for the print agent), `python-escpos`'s existing `win32print` dependency, SQLite (stdlib `sqlite3`, agent-local durable state), eventlet/`socketio.start_background_task` (existing pattern), react-i18next (existing, not extended — see Global Constraints).

Full design rationale: `docs/superpowers/specs/2026-08-09-print-path-hardening-design.md`. Full audit: `https://claude.ai/code/artifact/d474bf2e-cfe6-4539-b812-92a79d8e4695`.

## Global Constraints

- Stay on branch `rust-backend-migration`. Never touch `main` or `ui-refactor-goldy` (CLAUDE.md branch safety).
- No new hardware purchase, no new external/cloud printing service, no protocol change for either printer.
- Background work on the backend MUST use `socketio.start_background_task`, never `threading.Thread` — the backend runs a single eventlet worker (CLAUDE.md, and see `tickets.py::_spawn_auto_print_chit`'s existing comment on this exact point).
- Schema changes are idempotent raw-SQL STEP blocks inside `flask init-db` in `backend/app/__init__.py` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), never a real Alembic migration.
- Money/receipt content logic is out of scope — do not touch `_group_line_items`, `_group_modifiers`, `format_receipt_escpos`, or `format_receipt_html`'s formatting logic.
- Error **toasts** in this codebase are hardcoded Spanish strings, not `react-i18next` keys (verified: every `toast.error(...)` fallback in `TicketPage.tsx`, `KitchenQueuePage.tsx`, `BarQueuePage.tsx`, `CashSessionPage.tsx` is a raw Spanish literal, not a `t(...)` call — only static UI *labels* like button text go through `t()`). Match this existing convention for the new print-error copy; do not add print-error keys to `frontend/src/i18n/es.ts`/`en.ts`.
- No pytest/vitest exists in this repo. Backend tests are hand-rolled `test_*` functions with a local `check(label, condition, detail)` helper called from `main()`, run via `python -m tests.test_X` (see `backend/tests/`). Frontend has no test runner — `npm run build` (`tsc && vite build`) is the verification step for frontend changes.
- This is a live production system. No task in this plan touches the bar machine. The one task that touches the staging machine (`WIDOWSVAIL`) is explicitly called out and runs last, after everything else is verified.

---

## Parallel Execution Structure

This plan is split into **three independent lanes** that touch disjoint files and can be implemented in parallel, isolated git worktrees, plus **one final integration task** that must run after all three lanes are merged.

| Lane | Owns | Tasks |
|---|---|---|
| **A — Print Agent** | `scripts/print_agent/` | A1–A6 |
| **B — Backend Services** | `backend/app/services/`, `backend/app/api/tickets.py`, `backend/app/api/queue.py`, `backend/app/models/print_job.py`, `backend/app/__init__.py` | B1–B5 |
| **C — Frontend + Cleanup** | `frontend/src/utils/`, `frontend/src/pages/TicketPage.tsx`, `frontend/src/pages/KitchenQueuePage.tsx`, `frontend/src/pages/BarQueuePage.tsx`, `frontend/src/pages/manager/CashSessionPage.tsx`, `backend/app/services/printer_service.py` (deletion only) | C1–C2 |

**Contract between Lane B and Lane C** (so both can build without waiting on each other): on print failure, the backend returns `{'ok': false, 'job_id': <str>, 'error': <str>, 'error_code': <str|null>}` where `error_code` is one of `PRINTER_OFFLINE`, `PRINTER_ERROR`, `AGENT_UNREACHABLE`, `PRINT_UNKNOWN`, or absent/null (treat as `PRINT_UNKNOWN`). This key is **additive** — existing `error` string stays as-is, so Lane C's fallback logic (`error_code ?? 'PRINT_UNKNOWN'`) works correctly even before Lane B merges.

**Task D1 (final, sequential, not parallel)** depends on A + B being merged and runs after both complete.

---

## Lane A — Print Agent (`scripts/print_agent/`)

### Task A1: Durable job-id dedup store

**Files:**
- Create: `scripts/print_agent/dedup_store.py`
- Create: `scripts/print_agent/test_dedup_store.py`
- Modify: `scripts/print_agent/print_agent.py:38-57` (remove in-memory dict + `_dedup_check`/`_dedup_record`), and call sites at the `/print` handler (`:956-958`) and `/chit` handler (`:1044-1046`)

**Interfaces:**
- Produces: `dedup_store.was_printed(job_id: str | None) -> bool`, `dedup_store.record_printed(job_id: str | None) -> None`

- [ ] **Step 1: Write `dedup_store.py`**

```python
"""Durable job-id dedup store — survives agent restarts (crash, NSSM bounce,
Windows update) where an in-memory dict would silently forget in-flight jobs."""
import sqlite3
import time
import os

_DB_PATH = os.path.join(os.path.dirname(__file__), 'dedup.sqlite3')
_TTL_SECONDS = 60.0


def _connect():
    conn = sqlite3.connect(_DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS printed_jobs (job_id TEXT PRIMARY KEY, printed_at REAL NOT NULL)"
    )
    return conn


def was_printed(job_id) -> bool:
    """Return True if job_id was recorded within the TTL window."""
    if not job_id:
        return False
    now = time.time()
    conn = _connect()
    try:
        conn.execute("DELETE FROM printed_jobs WHERE printed_at < ?", (now - _TTL_SECONDS,))
        conn.commit()
        row = conn.execute("SELECT 1 FROM printed_jobs WHERE job_id = ?", (job_id,)).fetchone()
        return row is not None
    finally:
        conn.close()


def record_printed(job_id) -> None:
    if not job_id:
        return
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO printed_jobs (job_id, printed_at) VALUES (?, ?)",
            (job_id, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
```

- [ ] **Step 2: Write `test_dedup_store.py`**

```python
"""Run: python test_dedup_store.py"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import dedup_store


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


def main():
    if os.path.exists(dedup_store._DB_PATH):
        os.remove(dedup_store._DB_PATH)

    ok = True
    ok &= check('unknown job_id is not printed', dedup_store.was_printed('job-1') is False)

    dedup_store.record_printed('job-1')
    ok &= check('recorded job_id is printed', dedup_store.was_printed('job-1') is True)

    ok &= check('empty job_id is never printed', dedup_store.was_printed('') is False)
    ok &= check('None job_id is never printed', dedup_store.was_printed(None) is False)

    dedup_store._TTL_SECONDS = 0.05
    dedup_store.record_printed('job-2')
    time.sleep(0.1)
    ok &= check('expired job_id is no longer printed', dedup_store.was_printed('job-2') is False)

    os.remove(dedup_store._DB_PATH)

    if ok:
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        sys.exit(1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd scripts/print_agent && python test_dedup_store.py`
Expected: `All tests passed.`

- [ ] **Step 4: Wire into `print_agent.py`**

Delete lines 38–57 (the `_DEDUP_TTL`, `_printed_jobs` dict, `_dedup_check`, `_dedup_record`). Add near the top imports (after the `flask` import):

```python
import dedup_store
```

Replace the call in the `/print` handler:
```python
    if _dedup_check(job_id):
```
with:
```python
    if dedup_store.was_printed(job_id):
```
and the corresponding record call:
```python
        _dedup_record(job_id)
```
with:
```python
        dedup_store.record_printed(job_id)
```

Do the same replacement in the `/chit` handler (both the check near the top of `print_chit()` and the record call after a successful print).

- [ ] **Step 5: Manual verification**

Run: `cd scripts/print_agent && python -c "import print_agent"` — must import without error (confirms no leftover reference to the deleted names).

- [ ] **Step 6: Commit**

```bash
git add scripts/print_agent/dedup_store.py scripts/print_agent/test_dedup_store.py scripts/print_agent/print_agent.py
git commit -m "feat(print-agent): durable SQLite-backed job dedup store"
```

---

### Task A2: Shared-secret auth on `/print`, `/chit`, `/printers`

**Files:**
- Modify: `scripts/print_agent/print_agent.py` (config section `:32-34`, and the three route handlers at `:949`, `:1034`, `:1054`)
- Create: `scripts/print_agent/test_auth.py`

**Interfaces:**
- Produces: `PRINT_AGENT_TOKEN` env var; a rejected request returns HTTP 401 with `{'error': 'UNAUTHORIZED'}`

- [ ] **Step 1: Add the token config and a check helper**

In the config section (after `PORT = int(os.environ.get('PRINT_PORT', 9191))`):

```python
PRINT_AGENT_TOKEN = os.environ.get('PRINT_AGENT_TOKEN', '')  # empty = auth disabled (dev only)


def _check_auth() -> bool:
    """True if the request carries the correct token, or auth is disabled
    (PRINT_AGENT_TOKEN unset — dev mode only, never leave unset in production)."""
    if not PRINT_AGENT_TOKEN:
        return True
    return request.headers.get('X-Print-Token') == PRINT_AGENT_TOKEN
```

- [ ] **Step 2: Guard the three routes**

At the top of `print_receipt()` (the `/print` handler, currently starting `data = request.get_json(force=True)`), add before that line:
```python
    if not _check_auth():
        return jsonify({'error': 'UNAUTHORIZED'}), 401
```

Do the same at the top of `print_chit()` (the `/chit` handler) and `list_printers()` (the `/printers` handler). Leave `/health` unguarded — it's a read-only liveness check used by the backend's `_check_print_agent_reachability` and the PS1 smoke test's first step.

- [ ] **Step 3: Write `test_auth.py`**

```python
"""Run: python test_auth.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
os.environ['PRINT_AGENT_TOKEN'] = 'test-token-123'
import print_agent


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


def main():
    client = print_agent.app.test_client()
    ok = True

    r = client.post('/print', json={'id': 'x'})
    ok &= check('POST /print without token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.post('/print', json={'id': 'x'}, headers={'X-Print-Token': 'wrong'})
    ok &= check('POST /print with wrong token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.post('/chit', json={'type': 'KITCHEN', 'items': []})
    ok &= check('POST /chit without token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.get('/printers')
    ok &= check('GET /printers without token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.get('/health')
    ok &= check('GET /health without token still works', r.status_code == 200, f'got {r.status_code}')

    r = client.post('/chit', json={'type': 'KITCHEN', 'items': []}, headers={'X-Print-Token': 'test-token-123'})
    ok &= check('POST /chit with correct token is not rejected', r.status_code != 401, f'got {r.status_code}')

    if ok:
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        sys.exit(1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/print_agent && python test_auth.py`
Expected: `All tests passed.` (the last check hits the Mac/Linux dev fallback `print_html_dev`, which succeeds locally without a real printer)

- [ ] **Step 5: Commit**

```bash
git add scripts/print_agent/print_agent.py scripts/print_agent/test_auth.py
git commit -m "feat(print-agent): require shared-secret token on /print, /chit, /printers"
```

---

### Task A3: Per-printer circuit breaker

**Files:**
- Create: `scripts/print_agent/circuit_breaker.py`
- Create: `scripts/print_agent/test_circuit_breaker.py`

**Interfaces:**
- Produces: `circuit_breaker.is_open(printer_name: str) -> bool`, `circuit_breaker.record_success(printer_name: str) -> None`, `circuit_breaker.record_failure(printer_name: str) -> None`

- [ ] **Step 1: Write `circuit_breaker.py`**

```python
"""Per-printer circuit breaker: after repeated failures, fail fast instead
of repeating a call that's likely to hang or fail again — e.g. the
Bluetooth-paired kitchen printer dropping its pairing mid-service."""
import time

_FAILURE_THRESHOLD = 3
_COOLDOWN_SECONDS = 30.0

_state: dict = {}  # printer_name -> {'failures': int, 'opened_at': float|None}


def _get(printer_name: str) -> dict:
    return _state.setdefault(printer_name, {'failures': 0, 'opened_at': None})


def is_open(printer_name: str) -> bool:
    """True if this printer should be skipped (too many recent failures)."""
    s = _get(printer_name)
    if s['opened_at'] is None:
        return False
    if time.time() - s['opened_at'] >= _COOLDOWN_SECONDS:
        s['opened_at'] = None
        s['failures'] = 0
        return False
    return True


def record_success(printer_name: str) -> None:
    _state[printer_name] = {'failures': 0, 'opened_at': None}


def record_failure(printer_name: str) -> None:
    s = _get(printer_name)
    s['failures'] += 1
    if s['failures'] >= _FAILURE_THRESHOLD and s['opened_at'] is None:
        s['opened_at'] = time.time()
```

- [ ] **Step 2: Write `test_circuit_breaker.py`**

```python
"""Run: python test_circuit_breaker.py"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import circuit_breaker as cb


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


def main():
    ok = True
    printer = 'Cocina Comandas'

    ok &= check('fresh printer is not open', cb.is_open(printer) is False)

    for _ in range(3):
        cb.record_failure(printer)
    ok &= check('opens after threshold failures', cb.is_open(printer) is True)

    cb.record_success(printer)
    ok &= check('success resets breaker', cb.is_open(printer) is False)

    cb._FAILURE_THRESHOLD = 1
    cb._COOLDOWN_SECONDS = 0.05
    cb.record_failure(printer)
    ok &= check('opens immediately at threshold=1', cb.is_open(printer) is True)
    time.sleep(0.1)
    ok &= check('closes again after cooldown elapses', cb.is_open(printer) is False)

    if ok:
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        sys.exit(1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd scripts/print_agent && python test_circuit_breaker.py`
Expected: `All tests passed.`

- [ ] **Step 4: Commit**

```bash
git add scripts/print_agent/circuit_breaker.py scripts/print_agent/test_circuit_breaker.py
git commit -m "feat(print-agent): add per-printer circuit breaker"
```

---

### Task A4: Production WSGI server + bounded timeout + wire circuit breaker into `print_raw`

**Files:**
- Modify: `scripts/print_agent/print_agent.py:910-936` (`print_raw`), `:1064-1067` (`__main__` block)
- Modify: `scripts/print_agent/requirements.txt`

**Interfaces:**
- Consumes: `circuit_breaker.is_open/record_success/record_failure` (Task A3), `dedup_store` (Task A1, already wired)

- [ ] **Step 1: Add `waitress` to requirements**

Add a line to `scripts/print_agent/requirements.txt`:
```
waitress>=3.0; sys_platform == "win32"
```

- [ ] **Step 2: Rewrite `print_raw` with a bounded timeout and circuit breaker**

Replace the body of `print_raw` (currently `:910-936`) with:

```python
def print_raw(raw_bytes: bytes, data: dict = None, unpaid: bool = False, kind: str = 'receipt') -> bool:
    """Send raw ESC/POS bytes to the correct Windows printer, or HTML preview on Mac/Linux."""
    import sys
    if sys.platform != 'win32':
        return print_html_dev(data or {}, unpaid=unpaid)
    printer_name = get_printer_name(kind=kind)
    if not printer_name:
        log.error('No printer found')
        return False

    if circuit_breaker.is_open(printer_name):
        log.warning(f'Circuit open for "{printer_name}" — skipping attempt, printer likely unreachable')
        return False

    import concurrent.futures

    def _do_print():
        import win32print
        handle = win32print.OpenPrinter(printer_name)
        try:
            job = win32print.StartDocPrinter(handle, 1, ('Receipt', None, 'RAW'))
            try:
                win32print.StartPagePrinter(handle)
                win32print.WritePrinter(handle, raw_bytes)
                win32print.EndPagePrinter(handle)
            finally:
                win32print.EndDocPrinter(handle)
        finally:
            win32print.ClosePrinter(handle)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            ex.submit(_do_print).result(timeout=10)
        log.info(f'Printed {len(raw_bytes)} bytes to "{printer_name}" (kind={kind})')
        circuit_breaker.record_success(printer_name)
        return True
    except concurrent.futures.TimeoutError:
        log.error(f'Print timed out on "{printer_name}" after 10s — printer may be offline/stuck')
        circuit_breaker.record_failure(printer_name)
        return False
    except Exception as e:
        log.error(f'Print error on "{printer_name}": {e}')
        circuit_breaker.record_failure(printer_name)
        return False
```

- [ ] **Step 3: Import `circuit_breaker`**

Add near the top imports (with the `dedup_store` import from Task A1):
```python
import circuit_breaker
```

- [ ] **Step 4: Switch the server to waitress**

Replace the `__main__` block (currently `:1064-1067`):
```python
if __name__ == '__main__':
    log.info(f'Bola 8 Print Agent starting on port {PORT}')
    log.info(f'Configured printer: "{PRINTER_NAME or "(auto-detect)"}"')
    app.run(host='0.0.0.0', port=PORT, debug=False)
```
with:
```python
if __name__ == '__main__':
    log.info(f'Bola 8 Print Agent starting on port {PORT}')
    log.info(f'Configured printer: "{PRINTER_NAME or "(auto-detect)"}"')
    bind_host = os.environ.get('PRINT_AGENT_BIND', '127.0.0.1')
    if sys.platform == 'win32':
        from waitress import serve
        serve(app, host=bind_host, port=PORT, threads=4)
    else:
        # Dev fallback (Mac/Linux) — waitress isn't declared as a dependency
        # there; the Flask dev server is fine for local receipt-HTML preview.
        app.run(host=bind_host, port=PORT, debug=False)
```

`127.0.0.1` is correct as the default here: this branch's target deployment (Phase 2+ native Windows Services) runs the backend and the print agent as sibling processes on the same Windows host — confirmed by `backend/app/api/queue.py:12`, which already defaults `PRINT_AGENT_URL` to `http://127.0.0.1:9191` with a comment explaining why. `PRINT_AGENT_BIND` remains overridable via env var for any deployment shape where that isn't true.

- [ ] **Step 5: Manual verification**

Run: `cd scripts/print_agent && python -c "import print_agent"` — must import without error.
Run: `cd scripts/print_agent && python test_auth.py && python test_circuit_breaker.py && python test_dedup_store.py` — all must still pass (confirms this task didn't break Tasks A1–A3).

- [ ] **Step 6: Commit**

```bash
git add scripts/print_agent/print_agent.py scripts/print_agent/requirements.txt
git commit -m "feat(print-agent): waitress WSGI server, bounded print timeout, circuit breaker wiring"
```

---

### Task A5: Real printer health status on `/health`

**Files:**
- Modify: `scripts/print_agent/print_agent.py:884-908` (`get_printer_name`, add a sibling `get_printer_status`), `:941-947` (`/health` route)

**Interfaces:**
- Produces: `/health` response gains `receipt_printer_status` and `kitchen_printer_status` keys, each one of `'ok' | 'offline' | 'paper_out' | 'error' | 'busy' | 'unknown'`

- [ ] **Step 1: Add `get_printer_status`**

Add after `get_printer_name` (`:908`):

```python
# win32 printer status bit flags (winspool.h) — decoded here so /health can
# tell "temporarily unreachable, safe to retry" (offline) apart from
# "needs a human" (paper out), which the backend retry worker relies on.
_STATUS_OFFLINE   = 0x00000080
_STATUS_PAPER_OUT = 0x00000010
_STATUS_ERROR     = 0x00000002
_STATUS_BUSY      = 0x00000200


def get_printer_status(kind: str = 'receipt') -> str:
    if sys.platform != 'win32':
        return 'unknown'
    name = get_printer_name(kind=kind)
    if not name:
        return 'unknown'
    try:
        import win32print
        handle = win32print.OpenPrinter(name)
        try:
            info = win32print.GetPrinter(handle, 2)
        finally:
            win32print.ClosePrinter(handle)
        status = info.get('Status', 0)
        if status & _STATUS_OFFLINE:
            return 'offline'
        if status & _STATUS_PAPER_OUT:
            return 'paper_out'
        if status & _STATUS_ERROR:
            return 'error'
        if status & _STATUS_BUSY:
            return 'busy'
        return 'ok'
    except Exception as e:
        log.warning(f'Could not read status for "{name}": {e}')
        return 'unknown'
```

- [ ] **Step 2: Extend `/health`**

Replace the `health()` route body:
```python
@app.route('/health')
def health():
    return jsonify({
        'status':           'ok',
        'printer':          get_printer_name('receipt'),
        'kitchen_printer':  get_printer_name('kitchen'),
    })
```
with:
```python
@app.route('/health')
def health():
    return jsonify({
        'status':                  'ok',
        'printer':                 get_printer_name('receipt'),
        'kitchen_printer':         get_printer_name('kitchen'),
        'receipt_printer_status':  get_printer_status('receipt'),
        'kitchen_printer_status':  get_printer_status('kitchen'),
    })
```

- [ ] **Step 3: Manual verification**

Run: `cd scripts/print_agent && python -c "import print_agent; c = print_agent.app.test_client(); r = c.get('/health'); print(r.status_code, r.get_json())"`
Expected: 200, JSON includes `receipt_printer_status` and `kitchen_printer_status` (both `'unknown'` on macOS dev, since `sys.platform != 'win32'`).

- [ ] **Step 4: Commit**

```bash
git add scripts/print_agent/print_agent.py
git commit -m "feat(print-agent): expose real per-printer status on /health"
```

---

### Task A6: Delete dead `format_receipt()`

**Files:**
- Modify: `scripts/print_agent/print_agent.py:671-880` (delete the function and its section comment)

**Interfaces:** None — this function has zero callers (verified: only `format_receipt_escpos` is called by `print_receipt_html`, which is the live path).

- [ ] **Step 1: Confirm it's unused**

Run: `cd scripts/print_agent && grep -n "format_receipt(" print_agent.py`
Expected: exactly one match — the `def format_receipt(...)` line itself. If any other match appears, stop and do not delete.

- [ ] **Step 2: Delete the function**

Delete lines `671`–`880` in `print_agent.py`: the `# ---... Receipt formatter ...` section comment and the entire `def format_receipt(data, unpaid=False, reprint=False) -> bytes:` function through its closing `return bytes(buf)`.

- [ ] **Step 3: Manual verification**

Run: `cd scripts/print_agent && python -c "import print_agent"` — must import without error.
Run: `cd scripts/print_agent && python test_auth.py && python test_circuit_breaker.py && python test_dedup_store.py` — all must still pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/print_agent/print_agent.py
git commit -m "chore(print-agent): remove dead format_receipt() — format_receipt_escpos is the live path"
```

---

## Lane B — Backend Services

### Task B1: Shared print-agent HTTP client with error classification

**Files:**
- Create: `backend/app/services/print_client.py`
- Create: `backend/tests/test_print_client.py`

**Interfaces:**
- Produces: `send_print_job(endpoint: str, payload: dict, timeout: int = 8) -> tuple[bool, str | None, str | None]` returning `(ok, error_code, error_message)`; error codes: `ERROR_AGENT_UNREACHABLE`, `ERROR_PRINTER_OFFLINE`, `ERROR_PRINTER_ERROR`, `ERROR_UNKNOWN` (string values `'AGENT_UNREACHABLE'`, `'PRINTER_OFFLINE'`, `'PRINTER_ERROR'`, `'PRINT_UNKNOWN'`). Reads `PRINT_AGENT_URL` (default `http://127.0.0.1:9191`) and `PRINT_AGENT_TOKEN` (default `''`) from env.

- [ ] **Step 1: Write `print_client.py`**

```python
"""Shared HTTP client for talking to the Windows print agent.
Used by both tickets.py and queue.py so the auth header, timeout, and error
classification logic live in exactly one place."""
import os
import json
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

PRINT_AGENT_URL = os.environ.get('PRINT_AGENT_URL', 'http://127.0.0.1:9191')
PRINT_AGENT_TOKEN = os.environ.get('PRINT_AGENT_TOKEN', '')

ERROR_AGENT_UNREACHABLE = 'AGENT_UNREACHABLE'
ERROR_PRINTER_OFFLINE   = 'PRINTER_OFFLINE'
ERROR_PRINTER_ERROR     = 'PRINTER_ERROR'
ERROR_UNKNOWN           = 'PRINT_UNKNOWN'


def send_print_job(endpoint: str, payload: dict, timeout: int = 8):
    """POST payload to {PRINT_AGENT_URL}{endpoint}.

    Returns (ok, error_code, error_message). Never raises — every failure
    mode is caught and classified.
    """
    body = json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if PRINT_AGENT_TOKEN:
        headers['X-Print-Token'] = PRINT_AGENT_TOKEN
    req = Request(f'{PRINT_AGENT_URL}{endpoint}', data=body, headers=headers, method='POST')

    try:
        with urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return True, None, None
            return False, ERROR_UNKNOWN, resp.read().decode()
    except HTTPError as http_err:
        try:
            detail = http_err.read().decode()
        except Exception:
            detail = str(http_err)
        if http_err.code == 401:
            return False, ERROR_UNKNOWN, f'Print agent rejected the request (401): {detail}'
        if 'offline' in detail.lower() or 'not found' in detail.lower():
            return False, ERROR_PRINTER_OFFLINE, f'Print agent error ({http_err.code}): {detail}'
        return False, ERROR_PRINTER_ERROR, f'Print agent error ({http_err.code}): {detail}'
    except URLError:
        return False, ERROR_AGENT_UNREACHABLE, 'Print agent not running. Start it on the Windows host.'
    except Exception as exc:
        return False, ERROR_UNKNOWN, str(exc)
```

- [ ] **Step 2: Write `test_print_client.py`**

```python
"""Run: cd backend && python -m tests.test_print_client"""
import io
import urllib.error
from unittest import mock

from app.services import print_client


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


class _FakeResp:
    def __init__(self, status):
        self.status = status
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return b'{}'


def test_success():
    with mock.patch('app.services.print_client.urlopen', return_value=_FakeResp(200)):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check('200 response is success', ok is True and code is None)


def test_agent_unreachable():
    with mock.patch('app.services.print_client.urlopen', side_effect=urllib.error.URLError('refused')):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check(
        'connection refused classifies as AGENT_UNREACHABLE',
        ok is False and code == print_client.ERROR_AGENT_UNREACHABLE,
        detail=f'got code={code}',
    )


def test_printer_error_500():
    err = urllib.error.HTTPError('url', 500, 'Internal Server Error', {}, io.BytesIO(b'{"ok":false}'))
    with mock.patch('app.services.print_client.urlopen', side_effect=err):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check(
        '500 with generic body classifies as PRINTER_ERROR',
        ok is False and code == print_client.ERROR_PRINTER_ERROR,
        detail=f'got code={code}',
    )


def test_printer_offline_keyword():
    err = urllib.error.HTTPError('url', 500, 'Internal Server Error', {}, io.BytesIO(b'No printer found - offline'))
    with mock.patch('app.services.print_client.urlopen', side_effect=err):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check(
        '"offline" in body classifies as PRINTER_OFFLINE',
        ok is False and code == print_client.ERROR_PRINTER_OFFLINE,
        detail=f'got code={code}',
    )


def main():
    results = [
        test_success(),
        test_agent_unreachable(),
        test_printer_error_500(),
        test_printer_offline_keyword(),
    ]
    if all(results):
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd backend && python -m tests.test_print_client`
Expected: `All tests passed.`

- [ ] **Step 4: Commit**

```bash
git add backend/app/services/print_client.py backend/tests/test_print_client.py
git commit -m "feat(backend): shared print-agent HTTP client with error classification"
```

---

### Task B2: `print_jobs.error_code` column

**Files:**
- Modify: `backend/app/models/print_job.py`
- Modify: `backend/app/__init__.py` (new STEP 28, appended after STEP 27 which currently ends at line 756 with `print("STEP 27: ghost-ticket structural invariant trigger installed")`)

**Interfaces:**
- Produces: `PrintJob.error_code` column (nullable `VARCHAR(30)`), included in `PrintJob.to_dict()`

- [ ] **Step 1: Add the column to the model**

In `backend/app/models/print_job.py`, add after `error_msg`:
```python
    error_code    = db.Column(db.String(30), nullable=True)
```
And add `'error_code': self.error_code,` to `to_dict()` (alongside the existing `'error_msg': self.error_msg,`).

- [ ] **Step 2: Add STEP 28**

In `backend/app/__init__.py`, immediately after the line `print("STEP 27: ghost-ticket structural invariant trigger installed")` (currently line 756) and before the blank line that precedes `@app.cli.command('restate-costs')`, add:

```python

        # ── STEP 28: print_jobs.error_code (print-path hardening) ─────────────
        # Structured failure classification (PRINTER_OFFLINE / PRINTER_ERROR /
        # AGENT_UNREACHABLE / PRINT_UNKNOWN) alongside the existing free-text
        # error_msg, so the frontend can show actionable copy instead of the
        # raw agent error string.
        run(
            "ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS error_code VARCHAR(30)",
            'step28',
        )
        print("STEP 28: print_jobs.error_code added")
```

- [ ] **Step 3: Manual verification**

Run `cd backend && flask init-db` against a local dev Postgres (see CLAUDE.md backend dev setup). Expected: `STEP 28: print_jobs.error_code added` prints with no error, and re-running the same command a second time also succeeds with no error (confirms idempotency).

- [ ] **Step 4: Commit**

```bash
git add backend/app/models/print_job.py backend/app/__init__.py
git commit -m "feat(backend): add print_jobs.error_code for structured failure classification"
```

---

### Task B3: Migrate `tickets.py` print routes to `print_client`

**Files:**
- Modify: `backend/app/api/tickets.py:1-23` (imports/constant), `:32-85` (`_spawn_auto_print_chit`), `:1416-1489` (`print_ticket`), `:1491-1549` (`reprint_ticket`)

**Interfaces:**
- Consumes: `print_client.send_print_job` (Task B1), `PrintJob.error_code` (Task B2)

- [ ] **Step 1: Confirm `urlopen`/`Request`/`URLError`/`HTTPError`/`PRINT_AGENT_URL` are only used for printing in this file**

Run: `grep -n "urlopen\|URLError\|HTTPError\|PRINT_AGENT_URL" backend/app/api/tickets.py`
Expected: all matches are within `_spawn_auto_print_chit`, `print_ticket`, or `reprint_ticket`. If anything else uses them, keep the import and only remove what's safe.

- [ ] **Step 2: Replace the import and constant**

Replace:
```python
import os
import json
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
```
with:
```python
import os
```
(keep `import json` only if still used elsewhere in the file — check with `grep -n "json\." backend/app/api/tickets.py`; the STEP 2 payload-building code below no longer needs `json.dumps` since `print_client` handles serialization).

Delete the line `PRINT_AGENT_URL = os.environ.get('PRINT_AGENT_URL', 'http://localhost:9191')` (this also fixes a pre-existing inconsistency: `queue.py` already defaults to `127.0.0.1` with a documented reason; `print_client.py` now owns the one correct default for both files).

Add, with the other `from app.services import ...` import:
```python
from app.services.print_client import send_print_job
```

- [ ] **Step 3: Rewrite `_spawn_auto_print_chit`'s inner `_run`**

Replace the `try/except` block inside `_run()` (currently):
```python
            try:
                r = _req.post(
                    f'{PRINT_AGENT_URL}/chit',
                    json={**chit_payload, 'job_id': job.id},
                    timeout=8,
                )
                if r.ok:
                    job.status = 'PRINTED'
                    job.printed_at = datetime.now(timezone.utc)
                    _db.session.commit()
                else:
                    raise RuntimeError(f'agent {r.status_code}: {r.text[:120]}')
            except Exception as exc:
                try:
                    job.status = 'FAILED'
                    job.error_msg = str(exc)
                    item.needs_reprint = True
                    _db.session.commit()
                    routing = item.routing_dest.lower()
                    _sio.emit(f'{routing}:item_update',
                              {'item_id': item_id, 'needs_reprint': True},
                              room=routing)
                    _sio.emit('print:failed', {
                        'job_id':        job.id,
                        'queue_item_id': item_id,
                        'type':          'CHIT',
                        'error':         str(exc),
                    }, room='manager')
                except Exception:
                    pass  # never raise from background greenlet
```
with:
```python
            from app.services.print_client import send_print_job as _send_print_job
            ok, error_code, error_message = _send_print_job('/chit', {**chit_payload, 'job_id': job.id})
            if ok:
                job.status = 'PRINTED'
                job.printed_at = datetime.now(timezone.utc)
                _db.session.commit()
            else:
                try:
                    job.status = 'FAILED'
                    job.error_msg = error_message
                    job.error_code = error_code
                    item.needs_reprint = True
                    _db.session.commit()
                    routing = item.routing_dest.lower()
                    _sio.emit(f'{routing}:item_update',
                              {'item_id': item_id, 'needs_reprint': True},
                              room=routing)
                    _sio.emit('print:failed', {
                        'job_id':        job.id,
                        'queue_item_id': item_id,
                        'type':          'CHIT',
                        'error':         error_message,
                        'error_code':    error_code,
                    }, room='manager')
                except Exception:
                    pass  # never raise from background greenlet
```
(remove the now-unused `import requests as _req` line inside `_run` if nothing else in that function uses `_req`.)

- [ ] **Step 4: Rewrite `print_ticket`**

Replace the `try/except HTTPError/URLError/Exception` block (from `try:\n        body = json.dumps(payload).encode('utf-8')` through the line before `job.status = 'FAILED'`) with:
```python
    ok, error_code, error_message = send_print_job('/print', payload)
    if ok:
        job.status = 'PRINTED'
        job.printed_at = datetime.now(timezone.utc)
        db.session.commit()
        return jsonify({'ok': True, 'job_id': job.id})
    err_msg = error_message
```
Keep the rest of the function (the `job.status = 'FAILED'` block onward) but add `job.error_code = error_code` next to the existing `job.error_msg = err_msg`, and add `'error_code': error_code` to both the `socketio.emit('print:failed', {...})` payload and the final `jsonify({'ok': False, 'job_id': job.id, 'error': err_msg, ...})` — add `'error_code': error_code` there too. Keep the existing `code = 503 if 'not running' in err_msg else 500` line as-is (it still works since `error_message` text is unchanged for the `AGENT_UNREACHABLE` case).

- [ ] **Step 5: Rewrite `reprint_ticket`**

Apply the identical transformation to `reprint_ticket`: replace its `try/except` HTTP block with a `send_print_job('/print', payload)` call, add `job.error_code = error_code`, and add `'error_code': error_code` to both the socket emit and the final `jsonify(...)` response.

- [ ] **Step 6: Manual verification**

Run: `cd backend && python -c "import app; app.create_app()"` — must construct the app without import errors (confirms no dangling references to removed imports/constants).
Run: `grep -n "urlopen\|URLError\|HTTPError\|PRINT_AGENT_URL" backend/app/api/tickets.py` — expected: no matches remain.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/tickets.py
git commit -m "refactor(backend): route tickets.py print calls through shared print_client"
```

---

### Task B4: Migrate `queue.py` print route to `print_client`

**Files:**
- Modify: `backend/app/api/queue.py:1-12` (imports/constant), `:112-197` (`print_queue_chit`)

**Interfaces:**
- Consumes: `print_client.send_print_job` (Task B1), `PrintJob.error_code` (Task B2)

- [ ] **Step 1: Replace the import and constant**

Remove:
```python
PRINT_AGENT_URL = os.environ.get('PRINT_AGENT_URL', 'http://127.0.0.1:9191')
```
Add, near the other imports:
```python
from app.services.print_client import send_print_job
```
(keep `import os` if still used elsewhere in the file — check with `grep -n "os\." backend/app/api/queue.py`.)

- [ ] **Step 2: Rewrite the print-and-handle-failure block**

Replace:
```python
    try:
        import requests as http_requests
        r = http_requests.post(f'{PRINT_AGENT_URL}/chit', json=chit_data, timeout=8)
        if r.ok:
            job.status = 'PRINTED'
            job.printed_at = datetime.now(timezone.utc)
            item.needs_reprint = False
            db.session.commit()
            return jsonify({'ok': True, 'job_id': job.id})
        raise RuntimeError(r.text)
    except Exception as e:
        err_msg = str(e)

    job.status = 'FAILED'
    job.error_msg = err_msg
    item.needs_reprint = True
    db.session.commit()

    routing = item.routing_dest.lower()
    socketio.emit(f'{routing}:item_update',
                  {'item_id': item_id, 'needs_reprint': True},
                  room=routing)
    socketio.emit('print:failed', {
        'job_id':        job.id,
        'queue_item_id': item_id,
        'type':          'CHIT',
        'error':         err_msg,
    }, room='manager')

    return jsonify({'ok': False, 'job_id': job.id, 'error': err_msg}), 503
```
with:
```python
    ok, error_code, error_message = send_print_job('/chit', chit_data)
    if ok:
        job.status = 'PRINTED'
        job.printed_at = datetime.now(timezone.utc)
        item.needs_reprint = False
        db.session.commit()
        return jsonify({'ok': True, 'job_id': job.id})

    job.status = 'FAILED'
    job.error_msg = error_message
    job.error_code = error_code
    item.needs_reprint = True
    db.session.commit()

    routing = item.routing_dest.lower()
    socketio.emit(f'{routing}:item_update',
                  {'item_id': item_id, 'needs_reprint': True},
                  room=routing)
    socketio.emit('print:failed', {
        'job_id':        job.id,
        'queue_item_id': item_id,
        'type':          'CHIT',
        'error':         error_message,
        'error_code':    error_code,
    }, room='manager')

    return jsonify({'ok': False, 'job_id': job.id, 'error': error_message, 'error_code': error_code}), 503
```

- [ ] **Step 3: Manual verification**

Run: `cd backend && python -c "import app; app.create_app()"` — must construct without import errors.

- [ ] **Step 4: Commit**

```bash
git add backend/app/api/queue.py
git commit -m "refactor(backend): route queue.py print calls through shared print_client"
```

---

### Task B5: Backend auto-retry worker for FAILED print jobs

**Files:**
- Create: `backend/app/services/print_retry_svc.py`
- Modify: `backend/app/__init__.py` (near `return app`, currently line 1109)

**Interfaces:**
- Consumes: `print_client.send_print_job` (Task B1), `PrintJob` (Task B2's `error_code` field)
- Produces: `print_retry_svc.start(app, socketio)`, called once at app creation

- [ ] **Step 1: Write `print_retry_svc.py`**

```python
"""Background worker that automatically retries FAILED print jobs before a
human ever needs to tap the manual retry banner. Runs as an eventlet
greenlet via socketio.start_background_task — see the note in
tickets.py::_spawn_auto_print_chit about why threading.Thread is unsafe
here (single eventlet worker, cooperative scheduling)."""
from datetime import datetime, timedelta, timezone

_BACKOFF_SECONDS = [5, 30, 120]
_MAX_JOB_AGE_MINUTES = 10


def _rebuild_payload(job, ticket_model, ticket_line_item_model):
    """Reconstruct the print payload for a FAILED job from its source row.
    Returns (endpoint, payload) or (None, None) if the source row is gone."""
    if job.type in ('RECEIPT', 'REPRINT'):
        ticket = ticket_model.query.get(job.ticket_id)
        if not ticket:
            return None, None
        payload = ticket.to_dict()
        if job.type == 'REPRINT':
            payload['reprint'] = True
        payload['job_id'] = job.id
        return '/print', payload

    if job.type == 'CHIT':
        item = ticket_line_item_model.query.get(job.queue_item_id)
        if not item:
            return None, None
        mod_map: dict = {}
        mult = max(1, int(item.quantity or 1))
        for m in item.modifiers:
            name = m.modifier.name if hasattr(m, 'modifier') and m.modifier else getattr(m, 'name', '?')
            mod_map[name] = mod_map.get(name, 0) + mult
        payload = {
            'job_id': job.id,
            'type': item.routing_dest,
            'resource_code': (item.ticket.resource.code if item.ticket and item.ticket.resource else '?'),
            'items': [{
                'quantity': item.quantity,
                'name': (item.menu_item.name if item.menu_item else getattr(item, 'item_name', '?')),
                'modifiers': [{'name': k, 'count': v} for k, v in mod_map.items()],
                'notes': item.notes or '',
            }],
            'sent_at': item.sent_at.isoformat() if item.sent_at else '',
        }
        return '/chit', payload

    return None, None


def run_retry_cycle(app):
    """One pass over eligible FAILED jobs."""
    from app.extensions import db, socketio
    from app.models.print_job import PrintJob
    from app.models.ticket import Ticket, TicketLineItem
    from app.services.print_client import send_print_job

    with app.app_context():
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=_MAX_JOB_AGE_MINUTES)
        jobs = PrintJob.query.filter(
            PrintJob.status == 'FAILED',
            PrintJob.created_at >= cutoff,
            PrintJob.retry_count < len(_BACKOFF_SECONDS),
        ).all()

        for job in jobs:
            endpoint, payload = _rebuild_payload(job, Ticket, TicketLineItem)
            if not payload:
                continue

            ok, error_code, error_message = send_print_job(endpoint, payload)
            job.retry_count += 1
            if ok:
                job.status = 'PRINTED'
                job.printed_at = datetime.now(timezone.utc)
                job.error_msg = None
                job.error_code = None
            else:
                job.error_msg = error_message
                job.error_code = error_code
            db.session.commit()

            if not ok:
                continue

            if job.type == 'CHIT' and job.queue_item_id:
                item = TicketLineItem.query.get(job.queue_item_id)
                if item:
                    item.needs_reprint = False
                    db.session.commit()
                    room = item.routing_dest.lower()
                    socketio.emit(f'{room}:item_update',
                                  {'item_id': job.queue_item_id, 'needs_reprint': False},
                                  room=room)
            socketio.emit('print:retry_succeeded', {'job_id': job.id}, room='manager')


def start(app, socketio) -> None:
    """Schedule run_retry_cycle on a repeating background greenlet."""
    def _loop():
        import eventlet
        while True:
            eventlet.sleep(_BACKOFF_SECONDS[0])
            try:
                run_retry_cycle(app)
            except Exception as exc:  # noqa: BLE001
                app.logger.warning(f'print_retry_svc cycle failed: {exc}')

    socketio.start_background_task(_loop)
```

- [ ] **Step 2: Wire into the app factory**

In `backend/app/__init__.py`, immediately before `return app` (currently line 1109), add:
```python
    from app.services import print_retry_svc
    print_retry_svc.start(app, socketio)

    return app
```
(replacing the bare `return app` line). This follows the same unconditional-at-creation pattern already used by `_check_print_agent_reachability(app)` near the top of `create_app()` — harmless for one-off `flask` CLI commands since those processes exit before the greenlet does meaningful work.

- [ ] **Step 3: Manual verification**

Run: `cd backend && python -c "import app; app.create_app()"` — must construct without import errors.
Run: `cd backend && flask init-db` against a local dev Postgres — must complete normally (confirms the retry worker starting doesn't interfere with the CLI command).

- [ ] **Step 4: Commit**

```bash
git add backend/app/services/print_retry_svc.py backend/app/__init__.py
git commit -m "feat(backend): automatic backoff retry for FAILED print jobs"
```

---

## Lane C — Frontend + Dead Code Cleanup

### Task C1: Delete confirmed-dead code

**Files:**
- Delete: `backend/app/services/printer_service.py`
- Delete: `frontend/src/utils/printReceipt.ts`

**Interfaces:** None.

- [ ] **Step 1: Confirm zero importers**

Run: `grep -rn "printer_service\|ThermalPrinterService" backend/app --include="*.py"` — expected: no matches outside the file itself.
Run: `grep -rln "utils/printReceipt'" frontend/src --include="*.tsx" --include="*.ts"` — expected: no matches.

- [ ] **Step 2: Delete both files**

```bash
git rm backend/app/services/printer_service.py
git rm frontend/src/utils/printReceipt.ts
```

- [ ] **Step 3: Verify the frontend still builds**

Run: `cd frontend && npm run build`
Expected: builds successfully (confirms nothing was silently importing `printReceipt.ts`).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove dead ThermalPrinterService and unused printReceipt.ts (zero importers, confirmed by grep)"
```

---

### Task C2: Human-readable print error messages

**Files:**
- Create: `frontend/src/utils/printErrorText.ts`
- Modify: `frontend/src/pages/TicketPage.tsx:228-268` (`thermalPrint`, `handleReprint`)
- Modify: `frontend/src/pages/KitchenQueuePage.tsx` (`handlePrint`, around line 168-175)
- Modify: `frontend/src/pages/BarQueuePage.tsx` (`handlePrint`, around line 158-165)
- Modify: `frontend/src/pages/manager/CashSessionPage.tsx:220-227` (`handleThermalPrint`)

**Interfaces:**
- Produces: `getPrintErrorMessage(errorCode?: string): string`
- Consumes: backend's `error_code` field (contract defined at the top of this plan — works whether or not Lane B has merged yet, since `error_code` being `undefined` correctly falls through to the generic message)

- [ ] **Step 1: Write `printErrorText.ts`**

```typescript
const MESSAGES: Record<string, string> = {
  PRINTER_OFFLINE: 'Impresora desconectada — revisa el Bluetooth/USB y vuelve a intentar',
  PRINTER_ERROR: 'La impresora reportó un error — revisa que tenga papel',
  AGENT_UNREACHABLE: 'El agente de impresión no está corriendo en la computadora del bar',
  PRINT_UNKNOWN: 'No se pudo imprimir — intenta de nuevo',
}

export function getPrintErrorMessage(errorCode?: string): string {
  if (errorCode && errorCode in MESSAGES) return MESSAGES[errorCode]
  return MESSAGES.PRINT_UNKNOWN
}
```

- [ ] **Step 2: Wire `TicketPage.tsx`**

Add the import near the top of the file (with the other `utils` imports):
```typescript
import { getPrintErrorMessage } from '../utils/printErrorText'
```

In `thermalPrint` (currently `:242-249`), replace:
```typescript
    } catch (err: any) {
      const jobId: string | undefined = err.response?.data?.job_id
      const msg = err.response?.data?.error || 'No se pudo imprimir'
      if (jobId) {
        storePendingJob({ job_id: jobId, ticketId, type: 'RECEIPT', timestamp: Date.now() })
        setReprintBannerKey((k) => k + 1)
      }
      toast.error(msg)
    } finally { setPrintingThermal(false) }
```
with:
```typescript
    } catch (err: any) {
      const jobId: string | undefined = err.response?.data?.job_id
      if (jobId) {
        storePendingJob({ job_id: jobId, ticketId, type: 'RECEIPT', timestamp: Date.now() })
        setReprintBannerKey((k) => k + 1)
      }
      toast.error(getPrintErrorMessage(err.response?.data?.error_code))
    } finally { setPrintingThermal(false) }
```

In `handleReprint` (currently `:258-267`), replace:
```typescript
      toast.error(err.response?.data?.error || 'Error al reimprimir')
```
with:
```typescript
      toast.error(getPrintErrorMessage(err.response?.data?.error_code))
```

- [ ] **Step 3: Wire `KitchenQueuePage.tsx` and `BarQueuePage.tsx`**

In both files, add the import:
```typescript
import { getPrintErrorMessage } from '../utils/printErrorText'
```
and replace `handlePrint`'s catch block:
```typescript
  const handlePrint = async (itemId: string) => {
    try {
      await client.post(`/queue/${itemId}/print`)
      toast.success('Comanda enviada a imprimir')
    } catch {
      toast.error('Error al imprimir')
    }
  }
```
with:
```typescript
  const handlePrint = async (itemId: string) => {
    try {
      await client.post(`/queue/${itemId}/print`)
      toast.success('Comanda enviada a imprimir')
    } catch (err: any) {
      toast.error(getPrintErrorMessage(err.response?.data?.error_code))
    }
  }
```

- [ ] **Step 4: Wire `CashSessionPage.tsx`**

Add the import:
```typescript
import { getPrintErrorMessage } from '../../utils/printErrorText'
```
Replace, in `handleThermalPrint`:
```typescript
      toast.error(err.response?.data?.error || 'No se pudo imprimir')
```
with:
```typescript
      toast.error(getPrintErrorMessage(err.response?.data?.error_code))
```

- [ ] **Step 5: Verify the frontend builds**

Run: `cd frontend && npm run build`
Expected: builds successfully with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/utils/printErrorText.ts frontend/src/pages/TicketPage.tsx frontend/src/pages/KitchenQueuePage.tsx frontend/src/pages/BarQueuePage.tsx frontend/src/pages/manager/CashSessionPage.tsx
git commit -m "feat(frontend): show actionable print-error messages instead of raw agent errors"
```

---

## Task D1 (final, sequential — not part of the parallel lanes): Test script + staging validation

**Runs after Lanes A, B, and C are merged back into `rust-backend-migration`.** Touches the staging Windows machine (`WIDOWSVAIL`), which CLAUDE.md designates as disposable/safe to test on — never the bar machine.

**Files:**
- Modify: `scripts/test-print-agent.ps1`

**Interfaces:** None — this is a validation task.

- [ ] **Step 1: Extend the PS1 smoke test**

Add to `scripts/test-print-agent.ps1`, after the existing T1 (reachability) block:
```powershell
# ── T-AUTH: Auth is enforced ────────────────────────────────────────────────
Write-Host "--- T-AUTH: Token enforcement ---"
try {
    $resp = Invoke-WebRequest -Uri "$AgentUrl/printers" -TimeoutSec 5 -SkipHttpErrorCheck
    if ($resp.StatusCode -eq 401) { ok "GET /printers without token returns 401" }
    else { fail "GET /printers without token returned $($resp.StatusCode), expected 401" }
} catch { fail "T-AUTH request failed: $_" }

# ── T-HEALTH2: printer status fields present ────────────────────────────────
Write-Host "--- T-HEALTH2: printer status fields ---"
$h = GET "/health"
if ($h -and $h.PSObject.Properties.Name -contains "receipt_printer_status") { ok "health includes receipt_printer_status: $($h.receipt_printer_status)" }
else { fail "health missing receipt_printer_status" }
if ($h -and $h.PSObject.Properties.Name -contains "kitchen_printer_status") { ok "health includes kitchen_printer_status: $($h.kitchen_printer_status)" }
else { fail "health missing kitchen_printer_status" }
```

- [ ] **Step 2: Deploy to staging and run**

SSH to the staging machine per CLAUDE.md's documented pattern, sync the merged branch, set `PRINT_AGENT_TOKEN` and confirm `PRINT_AGENT_BIND` in the staging `.env`, restart the print agent service (`scripts/restart-print-agent.ps1`), then run:
```powershell
.\scripts\test-print-agent.ps1
```
Expected: all tests pass, including the two new ones, plus a real printed test receipt on the staging printer(s) — check the T4 print test still succeeds with the token now required (confirms the backend's `PRINT_AGENT_TOKEN` env var reaches the request headers end-to-end, not just the agent-side check in isolation).

- [ ] **Step 3: Commit**

```bash
git add scripts/test-print-agent.ps1
git commit -m "test(print-agent): add auth-enforcement and health-status checks to smoke test"
```

---

## Post-Merge Corrections

Found while preparing Task D1, after all three lanes were merged and full-suite-verified:

1. **`test_modifier_promotions.py` dynamic-load regression.** `backend/tests/test_modifier_promotions.py` loads `print_agent.py` via `importlib.util.spec_from_file_location`, which doesn't add the module's own directory to `sys.path`. Harmless while `print_agent.py` was self-contained; broken once Task A1/A3 gave it sibling imports (`dedup_store`, `circuit_breaker`). Fixed by inserting the agent's directory into `sys.path` before `exec_module` in the test loader. Commit `40e04cb6`.
2. **Task A4's default bind was wrong.** The task as written defaulted `PRINT_AGENT_BIND` to `127.0.0.1`, reasoning only from the backend-to-agent path (same host under native Windows Services). It missed that `scripts/install-nssm-print-agent.ps1` deliberately opens the Windows Firewall on port 9191 for LAN/mobile access — a real, intentional capability, not an oversight — and `test-print-agent.ps1`'s existing T4 already checks it. Narrowing the default would have silently broken that. Reverted the default to `0.0.0.0`; `PRINT_AGENT_TOKEN` (Task A2) is the actual access control, `PRINT_AGENT_BIND` remains an opt-in override. Commit `9161d8e3`.

Both were caught by integration verification *before* touching the staging machine — exactly the value of not skipping that step.

3. **Retry-worker greenlet started under unpatched CLI processes.** `print_retry_svc.start()` called `socketio.start_background_task` unconditionally; harmless (exit 0) but noisy under `flask init-db` and other CLI commands, which never call `eventlet.monkey_patch()` (only `wsgi.py`/`service_entry.py` do). Guarded with `eventlet.patcher.is_monkey_patched('socket')`. Commit `fc4473d7`. **Note:** staging testing then showed the exact same "RLock not greened" / "Working outside of application context" noise persists on `flask init-db` even with this guard *and* with the retry-worker call removed entirely — confirmed pre-existing on this codebase's `flask init-db` + `wsgi.py` + Flask-SocketIO(`async_mode='eventlet'`) combination on Windows, unrelated to this plan. Left as-is; out of scope here.

## Task D1 — Completed

Ran on staging (`WIDOWSVAIL`, USB printer only — no Bluetooth hardware there, see design spec). Deployed via file sync (staging has no `.git`; confirmed pre-existing), `PRINT_AGENT_TOKEN` set via `nssm set <service> AppEnvironmentExtra` on both `BilliardBarPrintAgent` and `BilliardBarBackend`, `waitress` installed into the agent's venv, both services restarted (nginx stopped/started around the backend restart — it's a declared Windows service dependency).

`test-print-agent.ps1`: **11 PASS, 1 WARN (pre-existing, Docker-era check — not applicable to the native-Windows-Services architecture), 0 FAIL.** Auth enforced (401 without token, works with token), a real ESC/POS receipt printed successfully, LAN/mobile reachability confirmed intact (validates the Post-Merge Correction #2 fix above).

**Caveat found, not fixed (out of scope):** `/health`'s `receipt_printer_status` reported `'error'` for the USB printer even though it printed successfully seconds later — `win32print.GetPrinter` returns raw status `0x2` (`PRINTER_STATUS_ERROR`) for this driver's idle state, which apparently doesn't block RAW ESC/POS jobs. Nothing in this plan wires `/health`'s status into retry-gating or circuit-breaker logic, so this has zero functional impact today — worth refining the status-bit interpretation if that field is ever surfaced to a manager UI or used to gate retries later.

**Untested:** the actual Bluetooth/COM3 transport, since staging has no Bluetooth printer. The code path is identical to USB (Windows presents both as normal printer objects), but real-world radio-layer behavior (pairing drift, disconnect/reconnect) can only be validated against the bar's actual "Cocina Comandas" printer — not attempted here, per production caution.

## Self-Review Notes

- **Spec coverage:** All 8 design-doc items map to tasks — #1 auth → A2; #2 production server/timeout/breaker → A3+A4; #3 durable state → A1; #4 printer health → A5; #5 auto-retry → B5; #6 human-readable errors → B1+B3+B4+C2; #7 dead code → A6+C1; #8 testing/rollout → D1.
- **Type consistency:** `send_print_job` signature (`endpoint, payload, timeout=8) -> (ok, error_code, error_message)`) is identical across its Task B1 definition and every consumer (B3, B4, B5). `getPrintErrorMessage(errorCode?: string): string` signature is identical across its Task C2 definition and all five call sites.
- **No placeholders:** every step above contains real, complete code — nothing deferred to "add error handling" or "similar to Task N."
