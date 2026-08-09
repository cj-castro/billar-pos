# DATA-03 Verification: Eventlet Single-Worker Constraint Under Native Windows Services

## Constraint Being Verified

DATA-03 requires the single-eventlet-worker/no-raw-threading architecture invariant — the
one that made the Docker-hosted backend safe to run with `gunicorn --worker-class eventlet -w 1`
— be explicitly verified to still hold under the native Windows Services hosting model
introduced in Phase 2 (`backend/wsgi.py`, `backend/service_entry.py`, NSSM-supervised
`socketio.run()`, no gunicorn in the process tree). The constraint has three parts:

1. **Single worker, one OS process/thread** doing all request handling and Socket.IO work.
2. **Cooperative I/O scheduling** — every blocking call (sockets, DB I/O) must yield to
   eventlet's hub via monkey-patched stdlib primitives, or it stalls every other concurrent
   request/WebSocket keepalive/background greenlet for the duration of that call.
3. **No raw `threading.Thread(...)` spawns** anywhere in `backend/` — background work must
   use `socketio.start_background_task`, which schedules eventlet-safe greenlets instead of
   real OS threads.

## Gap Found

Under Docker, `gunicorn --worker-class eventlet` performs `eventlet.monkey_patch()`
**implicitly** inside its own `EventletWorker.init_process()` before the WSGI app is ever
imported. This monkey-patching is what made cooperative scheduling work for the Docker
deployment without any explicit call in the application code itself.

Phase 2's native-hosting entrypoints (`backend/wsgi.py` and `backend/service_entry.py`) call
`socketio.run()` directly — there is no gunicorn process in between, so gunicorn's implicit
`monkey_patch()` call never happens. Neither entrypoint called `eventlet.monkey_patch()`
itself. This meant:

- Under native Windows Services hosting, the process ran with **stock, unpatched** stdlib
  `socket`/`select`/`time` — no cooperative scheduling was actually happening at all, a
  silent regression from the Docker deployment's behavior.
- Separately, and pre-existing even under Docker: `eventlet.monkey_patch()` alone does
  **not** patch `psycopg2`. Psycopg2 is a blocking C-extension driver; without the separate
  `eventlet.support.psycopg2_patcher.make_psycopg_green()` call registering psycopg2's wait
  callback, every Postgres query blocks the entire eventlet hub's OS thread for the duration
  of the query — no other request, WebSocket keepalive, or background greenlet can run until
  it returns. This gap existed in the Docker deployment too; it was never fixed there, just
  masked by request volume being low enough not to surface it as a visible outage.

## Fix Applied (Task 1, this plan)

Both `backend/wsgi.py` and `backend/service_entry.py` now call, as the first executable
statements in the file (before any other import, including `os`/`subprocess`/`sys` in
`service_entry.py`, and before `from app import create_app` in `wsgi.py`):

```python
import eventlet
eventlet.monkey_patch()
from eventlet.support import psycopg2_patcher
psycopg2_patcher.make_psycopg_green()
```

In `service_entry.py`, the module docstring is preserved as the file's first statement
(Python requires this for it to be recognized as a docstring); the patching block is inserted
immediately after the docstring's closing `"""` and before the pre-existing `import os` line.

Both dependencies (`eventlet==0.36.1`, `psycopg2-binary==2.9.9`) were already pinned in
`backend/requirements.txt` — no new dependency was required.

## Grep-Audit Result

```
grep -rn "threading\.Thread(" backend/
```

Returns **zero matches** — no raw `threading.Thread(...)` instantiations exist anywhere in
`backend/`. The only background-task spawning mechanism in the codebase is
`socketio.start_background_task`, used in `backend/app/api/tickets.py`'s
`_spawn_auto_print_chit` (lines 32-86), which already carries an explicit comment noting why
`threading.Thread` is avoided:

> Use `socketio.start_background_task` (eventlet-safe greenlet) instead of
> `threading.Thread`, which is incompatible with eventlet's cooperative scheduler.

This confirms part 3 of the constraint (no raw threading) was already correctly followed
throughout the codebase — the gap found and fixed in this plan was specifically the missing
monkey-patching (parts 1-2), not a threading violation.

## Mechanical Verification Performed

```
python3 -m py_compile backend/wsgi.py backend/service_entry.py
```

Exits 0 for both files — the added import/patching statements are syntactically valid and do
not break module loading.

## Deferred: Runtime Confirmation

This planning/execution environment has no local Windows/eventlet runtime available to
actually run `socketio.run()` and exercise the eventlet hub under concurrent load. Live
confirmation that:

- the eventlet hub remains responsive under concurrent requests post-deploy,
- Socket.IO messages still broadcast correctly to `floor`/`kitchen`/`bar`/`manager` rooms,
- Postgres calls no longer serialize/block all other requests during a query,

happens on the staging machine in Plan 04-04, where the native Windows Services hosting
environment actually exists to test against.
