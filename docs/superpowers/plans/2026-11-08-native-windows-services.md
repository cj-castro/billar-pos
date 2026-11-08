# Native Windows Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, and test on the dev PC only, a native Windows install of the bar POS: Postgres 15, backend, scheduler, nginx, printing path, and S3 + local backups. It must behave identically to today's Docker stack. **No deployment to the bar PC in this plan.**

**Architecture:**
- Each container becomes either a Windows service under NSSM or Postgres's own `pg_ctl register` service, or a Task Scheduler job.
- The app code runs unchanged apart from one line, through a Windows launcher that replaces gunicorn.
- Each service gets exactly the environment `docker compose config` gives its container, plus a small, tested set of host overrides.
- Every claim is proven by tests that run against the native stack and, where it matters, against the current Docker image as the reference.

**Tech Stack:**
- Python 3.11 (uv standalone build), eventlet 0.36.1, Flask-SocketIO 5.3.6
- PostgreSQL 15.x EDB Windows binaries, nginx 1.27.5 Windows
- NSSM (repo `scripts/nssm.exe`), PowerShell 5.1
- AWS CLI v2 (MSI admin-extract for tests), moto server (S3 mock, tests only)
- pytest

**Spec:** `C:\Users\giris\Documents\ObsidianVault\Bola8 POS\Docker Exit Plan 2026-11-08.md` (native version). Trial evidence: `E:\cache\temp\claude\9efc318728cdca4e\f7027570-54c7-44ae-8d8a-32fbc1191f79\scratchpad\native-spike\` (`scripts\serve_windows.py`, `functional_test.py`, `parity.py`, `blocking_test.py`, `locale_test.sql`, `tz_test.py`, `nginx_run\conf\nginx.conf`).

## Global Constraints

- Work on branch `feature/native-windows` from `main` @ `6bb509e8`, in a git worktree.
- **Never connect to, copy to, or run anything on the bar PC.** All tests run on the dev PC.
- App behavior must not change. The only app-code edit is Task 1. `docker-compose.yml`, the Dockerfiles, `backup/*`, and existing `scripts/*` stay untouched (they are the rollback path).
- All new files go under `deploy/windows/`, except the Task 1 files in `backend/`.
- Versions: Python **3.11.x**, PostgreSQL **15.x**, nginx **1.27.5**. Backend Python packages exactly as the bar `pip freeze` (listed in Task 4), plus `tzdata`.
- Ports:
  - Production defaults: Postgres **5433** (5432 belongs to an unrelated PG18 on the bar PC), backend **127.0.0.1:5000**, web **0.0.0.0:8080**.
  - Tests use: Postgres 55432, backend 55000, web 59080, mock print agent 59191, moto 59000.
  - Before using any port, check it against `netsh int ipv4 show excludedportrange tcp`. The dev PC reserves 58004-58103.
- Postgres database locale: `ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'en-US'`. Server settings: `timezone='UTC'`, `log_timezone='UTC'`, `datestyle='iso, mdy'`, `default_text_search_config='pg_catalog.english'`, `shared_buffers=128MB`, `max_connections=100`, `max_wal_size=1GB`, `min_wal_size=80MB`, `listen_addresses='localhost'`.
- Process environment:
  - backend and scheduler: **`TZ` must be absent**;
  - every Python process: `PYTHONUTF8=1` and `PYTHONUNBUFFERED=1`;
  - `PRINT_AGENT_URL=http://127.0.0.1:9191`;
  - `DATABASE_URL` host `127.0.0.1` and the Postgres port.
- Telegram bot: **excluded** (not in use). No service, no venv, no changes to `telegram-bot/`.
- Secrets never enter git. Env files are written only under the install root `config\`, with an ACL limited to SYSTEM and Administrators. Test env files use throwaway values.
- The prod dump used by tests is referenced by env var `POS_TEST_DUMP`, never copied into the repo. Tests that need it skip with a message when it is unset.
- The Docker reference for parity is image `billiards-backend:g0` on the dev PC. Tests that need it skip when Docker or the image is absent.
- Test tooling and binaries download into `deploy/windows/.native-test/` (gitignored).

## Review Focus

1. **A `TZ=America/Mexico_City` line in the Docker `.env` leaks into the native backend or scheduler.** On Windows that silently makes naive time UTC, so cash-session business dates break after 18:00. The expectation: it is stripped. Owner: Task 3 (`test_tz_stripped_for_backend_and_scheduler`).
2. **The print agent is down, slow, or hangs.** Expectation: the POS keeps serving other requests in under 1 s, the print job is marked FAILED exactly as in Docker, and nothing crashes. Owners: Task 5 (`test_health_not_blocked_when_print_agent_blackholed`) and Task 7 (`test_agent_down_behaviour_matches_docker`).
3. **At boot, Postgres is slower than the backend.** Expectation: the backend keeps retrying (the service restarts) and is serving within 60 s of Postgres becoming ready. It never ends up permanently stopped. Owner: Task 10 (`test_backend_recovers_after_postgres_restart`).
4. **No internet or bad S3 credentials at 02:00.** Expectation: the run fails loudly (non-zero exit, log line `BACKUP FAILED`), the success marker is not touched, and the next service start or missed-run trigger retries it. The local backup still runs independently. Owner: Task 8 (`test_upload_failure_leaves_marker_untouched`, `test_catchup_runs_when_marker_stale`).
5. **Accented Spanish names** (`Ñandú`, `Épico`, `ábaco`) must search case-insensitively and sort exactly as on Docker Postgres. Owner: Task 2 (`test_locale_matches_alpine_reference`).

---

### Task 1: Windows-safe report date label (the only app-code change)

**Files:**
- Modify: `backend/app/services/email_report_svc.py:525`
- Test: `backend/tests/test_email_date_label.py`

**Interfaces:**
- Produces: `_date_label(d: datetime.date) -> str` in `backend/app/services/email_report_svc.py`.

- [ ] **Step 1: Write the failing test**

```python
from datetime import date
from app.services.email_report_svc import _date_label

def test_date_label_single_digit_day():
    assert _date_label(date(2026, 11, 1)) == "1 de November de 2026"

def test_date_label_two_digit_day():
    assert _date_label(date(2026, 8, 15)) == "15 de August de 2026"
```

- [ ] **Step 2: Run** `cd backend && python -m pytest tests/test_email_date_label.py -v`. Expected: FAIL with `ImportError: cannot import name '_date_label'`.
- [ ] **Step 3: Implement `_date_label`.** Body: `return f"{d.day} de {d.strftime('%B de %Y')}"`. Line 525 becomes `date_label = _date_label(target_date)`. Keep the existing comment and add `# Windows has no %-d`. The English month name is today's behavior; keep it.
- [ ] **Step 4: Run** the same test on Windows (venv from Task 4 or any 3.11). Expected: PASS. Then run it in Docker: `docker run --rm -v ${PWD}/backend:/app -w /app billiards-backend:g0 python -m pytest tests/test_email_date_label.py -q` (override the entrypoint with `--entrypoint python`). Expected: PASS. The output is identical on both OSes.
- [ ] **Step 5: Commit** `fix(reports): portable day-of-month in daily report date label`

### Task 2: Postgres cluster init, locale parity, fingerprint

**Files:**
- Create: `deploy/windows/postgres/Initialize-PosCluster.ps1`
- Create: `deploy/windows/postgres/pos-postgresql.conf` (the settings from Global Constraints, appended through `include_if_exists`)
- Create: `deploy/windows/sql/fingerprint.sql`
- Create: `deploy/windows/tests/Setup-TestEnv.ps1`
- Create: `deploy/windows/tests/conftest.py`
- Create: `deploy/windows/tests/requirements-test.txt` (pytest, requests, python-socketio[client]==5.18.1, websocket-client, psycopg2-binary==2.9.9, moto[server])
- Create: `deploy/windows/tests/fixtures/locale_reference.txt`
- Create: `deploy/windows/.gitignore` (`.native-test/`)
- Test: `deploy/windows/tests/test_postgres.py`

**Interfaces:**
- Produces:
  - `Initialize-PosCluster.ps1 -PgBin <dir> -DataDir <dir> -Port <int> -DbUser <str> -DbPassword <str> -DbName <str>`. Effects: initdb `-E UTF8 --locale=C --lc-ctype=en-US`, writes the conf include and pg_hba (`host all all 127.0.0.1/32 scram-sha-256`, same for `::1/128`), creates the role (`SUPERUSER LOGIN`, as in the container) and creates the database with the locale. Idempotent: if `PG_VERSION` already exists it only verifies the settings. Exit 0 on success.
  - `fingerprint.sql`: one result row per check, `(check_name text, value text)`, covering per-table `count(*)` plus `md5(string_agg(t::text,'|' ORDER BY t::text))`, every sequence's `last_value`, all `schema_migrations` rows, and md5s of `pg_get_functiondef`, `pg_get_triggerdef` and `pg_get_viewdef`.
  - Pytest fixtures in `conftest.py`:
    - `pg_bin` (path);
    - `native_pg` (session: a cluster on 55432 started with `pg_ctl start` detached, stopped at teardown);
    - `restored_db(name)` (restores `POS_TEST_DUMP` into a fresh DB `name`, returns a DSN);
    - `run_ps(script, *args, env=None) -> CompletedProcess`.
  - `Setup-TestEnv.ps1`: downloads or reuses into `.native-test/` the PG 15.x zip, the nginx 1.27.5 zip, uv Python 3.11, the AWS CLI v2 MSI admin-extracted (`msiexec /a … TARGETDIR=`), and a test venv from `requirements-test.txt`. Reuse the spike's `downloads\` when present.

- [ ] **Step 1: Write the failing tests** in `test_postgres.py`:
  - `test_cluster_settings`: `SHOW timezone` = `UTC`; datestyle = `ISO, MDY`; `datcollate` = `C`; `datctype` = `en-US`.
  - `test_locale_matches_alpine_reference`: run the spike's `locale_test.sql` and compare its output line-for-line with `fixtures/locale_reference.txt`. Capture that reference once from a `postgres:15-alpine` container loaded with the same SQL: `lower('ÁÉÍÓÚÑ')='áéíóúñ'`, `'é' ILIKE 'É'` is true, and the musl ordering md5 is `17993b41…` per the spike.
  - `test_restore_fingerprint_equals_source`: restore `POS_TEST_DUMP` twice (into `fp_a`, then dump `fp_a` and restore into `fp_b`); `fingerprint.sql` rows are equal.
  - `test_initialize_is_idempotent`: a second run exits 0 and leaves the data unchanged.
- [ ] **Step 2: Run** `.native-test\venv\Scripts\python -m pytest deploy/windows/tests/test_postgres.py -v`. Expected: FAIL (the script is missing).
- [ ] **Step 3: Implement** `Initialize-PosCluster.ps1`, `pos-postgresql.conf`, `fingerprint.sql`, the fixtures, and `Setup-TestEnv.ps1`.
- [ ] **Step 4: Run** the tests. Expected: 4 PASS (the dump-based test is skipped only if `POS_TEST_DUMP` is unset).
- [ ] **Step 5: Commit** `feat(native): postgres cluster init with musl-equivalent locale + fingerprint`

### Task 3: Per-service environment export

**Files:**
- Create: `deploy/windows/Export-ComposeEnv.ps1`
- Create: `deploy/windows/PosCommon.psm1`
- Test: `deploy/windows/tests/test_env_export.py`
- Test fixture: `deploy/windows/tests/fixtures/test.env` (throwaway values, **includes `TZ=America/Mexico_City`**, **omits `CURRENCY`**)

**Interfaces:**
- Produces:
  - `Export-ComposeEnv.ps1 -ComposeDir <dir> -OutDir <dir> -PgPort <int> [-EnvFile <path>]`. It runs `docker compose --env-file <EnvFile> config --format json` and writes `backend.env`, `scheduler.env` and `backup.env`, each containing exactly that service's resolved `environment`, with these overrides:
    - `DATABASE_URL` host `postgres:5432` → `127.0.0.1:<PgPort>` (backend, scheduler);
    - `PRINT_AGENT_URL=http://127.0.0.1:9191` (backend);
    - remove `TZ` (backend, scheduler);
    - keep `TZ` in `backup.env` (only used for log stamps);
    - `PG_HOST=127.0.0.1`, `PG_PORT=<PgPort>` (backup);
    - add `PYTHONUTF8=1` and `PYTHONUNBUFFERED=1` (backend, scheduler).

    It sets the ACL on `OutDir` (SYSTEM + Administrators full; inheritance off) and exits non-zero if Docker is unavailable.
  - `PosCommon.psm1`:
    - `Import-PosEnv -Path <file>` sets process env from `KEY=VALUE` lines (`#` comments and blanks ignored; the value is taken verbatim after the first `=`);
    - `Write-PosLog -Message <str>` prints `yyyy-MM-dd HH:mm:ss` + message.

- [ ] **Step 1: Write the failing tests:**
  - `test_tz_stripped_for_backend_and_scheduler`: no `TZ=` line in `backend.env` or `scheduler.env`.
  - `test_compose_defaults_materialised`: `backend.env` contains `CURRENCY=MXN`. That is the compose default; config.py's default is USD.
  - `test_scheduler_env_is_scheduler_only`: `scheduler.env` keys == the compose scheduler keys − `TZ` + `PYTHONUTF8`/`PYTHONUNBUFFERED`. In particular there is no `CURRENCY` key, matching the container.
  - `test_overrides_applied`: the `DATABASE_URL` host and port and the `PRINT_AGENT_URL`.
  - `test_env_dir_acl`: `Get-Acl` shows only SYSTEM and Administrators.
  - `test_import_posenv_value_with_equals`: a value containing `=` survives intact.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** them. Expected: 6 PASS.
- [ ] **Step 5: Commit** `feat(native): export exact per-service env from compose`

### Task 4: Pinned Python environment

**Files:**
- Create: `deploy/windows/python/requirements-backend.lock.txt`
- Create: `deploy/windows/python/New-PosVenv.ps1`
- Test: `deploy/windows/tests/test_venv.py`

**Interfaces:**
- Produces: `New-PosVenv.ps1 -Python <python.exe> -VenvDir <dir> -Lock <file> [-Wheelhouse <dir>]`. It creates the venv and runs `pip install --no-deps -r <Lock>`, with `--no-index --find-links <Wheelhouse>` when the wheelhouse is given. Exit 0 on success.
- Lock content: the bar backend `pip freeze` from 2026-11-08 verbatim, **minus `gunicorn==22.0.0`**, **plus `tzdata==<latest at implementation, pinned>`**:

  alembic==1.20.1, APScheduler==3.10.4, bcrypt==4.1.3, bidict==0.24.1, blinker==1.9.0, certifi==2026.10.23, charset-normalizer==3.5.2, click==8.5.1, Deprecated==1.3.1, dnspython==2.9.2, eventlet==0.36.1, Flask==3.0.3, Flask-Cors==4.0.1, Flask-JWT-Extended==4.6.0, Flask-Limiter==3.7.0, Flask-Migrate==4.0.7, Flask-SocketIO==5.3.6, Flask-SQLAlchemy==3.1.1, greenlet==3.0.3, h11==0.16.0, idna==3.20, itsdangerous==2.2.0, Jinja2==3.1.6, limits==5.8.0, Mako==1.4.3, markdown-it-py==4.2.0, MarkupSafe==3.0.4, marshmallow==3.21.3, mdurl==0.1.2, ordered-set==4.1.0, packaging==26.3, psycopg2-binary==2.9.9, Pygments==2.21.0, PyJWT==2.15.1, python-dateutil==2.9.0, python-dotenv==1.0.1, python-engineio==4.15.1, python-socketio==5.18.1, pytz==2026.6, requests==2.32.3, rich==13.9.4, simple-websocket==1.1.0, six==1.17.0, SQLAlchemy==2.0.54, typing_extensions==4.16.0, tzlocal==5.4.5, urllib3==2.8.0, Werkzeug==3.1.9, wrapt==2.5.2, wsproto==1.3.2

- [ ] **Step 1: Write the failing tests:**
  - `test_freeze_matches_lock`: `pip freeze` of the new venv == the lock lines (case-insensitive name compare).
  - `test_pip_check_clean`: `pip check` exits 0.
  - `test_zoneinfo_mexico`: `ZoneInfo('America/Mexico_City')` resolves.
  - `test_create_app_imports`: `python -c "from app import create_app"` with a dummy `DATABASE_URL` exits 0.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the lock file and the script.
- [ ] **Step 4: Run** them. Expected: 4 PASS.
- [ ] **Step 5: Commit** `feat(native): pinned backend venv matching production image`

### Task 5: Backend and scheduler launchers (gunicorn + entrypoint replacement)

**Files:**
- Create: `deploy/windows/backend/serve_windows.py`, based on the spike launcher. Drop `--no-patch`. Host and port come from `POS_BIND_HOST`/`POS_BIND_PORT` (defaults `127.0.0.1`/`5000`). `BACKEND_DIR` is required.
- Create: `deploy/windows/backend/run-backend.ps1`
- Create: `deploy/windows/backend/run-scheduler.ps1`
- Create: `deploy/windows/backend/run-flask.ps1` (for the daily-report task)
- Test: `deploy/windows/tests/test_backend_launch.py`

**Interfaces:**
- Consumes: `Import-PosEnv` (Task 3); the venv (Task 4); `native_pg` and `restored_db` (Task 2).
- Produces:
  - `run-backend.ps1 -Root <dir> -EnvFile <file>`. It sets env, `cd`s into `BACKEND_DIR` and runs in order `flask init-db`, `python seed.py`, `flask factory-finalize`, `flask apply-migrations`, then `python serve_windows.py`. Any non-zero step → `Write-PosLog "STARTUP FAILED at <step>"` and `exit 1` (same as `entrypoint.sh` `set -e`).
  - `run-scheduler.ps1 -Root -EnvFile`: env, then `python scheduler.py`.
  - `run-flask.ps1 -Root -EnvFile -Command <str>`: env, then `flask <Command>`.
  - `serve_windows.py` calls `eventlet.monkey_patch()` before any other import, then `eventlet.wsgi.server(eventlet.listen((host, port), backlog=1024), app, max_size=1000, log_output=True, keepalive=True)`.

- [ ] **Step 1: Write the failing tests:**
  - `test_backend_starts_and_health_200`: `GET http://127.0.0.1:55000/api/v1/health` returns 200 within 60 s.
  - `test_migrations_reported_present`: the log contains `0 applied, 4 already present`.
  - `test_startup_fails_fast_when_db_unreachable`: with `DATABASE_URL` on a closed port, exit code ≠ 0 and the log has `STARTUP FAILED at init-db`, with no listener on 55000.
  - `test_health_not_blocked_when_print_agent_blackholed`: point `PRINT_AGENT_URL` at a socket that accepts and never answers, add an item, then `/health` answers in under 1.0 s. Port the spike's `blocking_test.py`.
  - `test_unicode_output_to_file`: stdout redirected to a file, `init-db` runs, exit 0.
  - `test_scheduler_starts`: the log has `Scheduler started` within 30 s.
  - `test_daily_report_reaches_smtp`: `run-flask.ps1 -Command daily-report` with `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1`; the log shows an SMTP connection error, not `ValueError`. This proves Task 1 works end to end.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the 4 files.
- [ ] **Step 4: Run** them. Expected: 7 PASS.
- [ ] **Step 5: Commit** `feat(native): windows launcher and entrypoint-equivalent wrappers`

### Task 6: nginx site, derived from the production config

**Files:**
- Create: `deploy/windows/nginx/nginx.conf.template`. Main config mirroring the `nginx:1.27-alpine` defaults: `worker_processes auto`, `events{worker_connections 1024}`, `include mime.types`, `default_type application/octet-stream`, `sendfile on`, `keepalive_timeout 65`, `access_log`/`error_log` under `{{LOG_DIR}}`, `include pos-site.conf`.
- Create: `deploy/windows/nginx/Convert-NginxSite.ps1`
- Test: `deploy/windows/tests/test_nginx.py`

**Interfaces:**
- Produces: `Convert-NginxSite.ps1 -Source frontend/nginx.conf -Out <dir>\conf\pos-site.conf -ListenPort <int> -BackendPort <int> -DistDir <dir>` and it renders `nginx.conf` from the template. Exactly 3 substitution kinds are allowed:
  - `listen 80` → `listen <ListenPort>`;
  - `http://backend:5000` → `http://127.0.0.1:<BackendPort>`;
  - `root /usr/share/nginx/html` → `root <DistDir with forward slashes>`.

  Throws if any of the 3 patterns is not found.

- [ ] **Step 1: Write the failing tests:**
  - `test_only_three_substitutions`: a line diff between source and output touches only the lines matching those 3 patterns.
  - `test_nginx_config_valid`: `nginx -t -p <prefix>` exits 0.
  - `test_spa_and_assets`: `/` returns index.html; `/assets/*` has `Cache-Control` containing `immutable`; a deep route (`/tables/1`) returns index.html.
  - `test_api_proxied`: `/api/v1/health` through 59080 returns 200.
  - `test_websocket_through_proxy`: a Socket.IO websocket-only client connects through 59080 and receives `ticket:updated` after an item is added.
  - `test_websocket_idle_10min`: marked `slow`; the connection is still alive after 600 s of idle. Must run once before task sign-off.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the template and the converter.
- [ ] **Step 4: Run** them, including `-m slow` once. Expected: 6 PASS.
- [ ] **Step 5: Commit** `feat(native): nginx site generated from production nginx.conf`

### Task 7: Printing parity (native vs Docker)

**Files:**
- Create: `deploy/windows/tests/mock_print_agent.py`. A Flask app on a given port. It records every `POST /chit` and `POST /print` (path + JSON body) to a JSONL file and answers what the real agent answers on success. Read `scripts/print_agent/print_agent.py` for the success response shape and copy it exactly.
- Create: `deploy/windows/tests/print_scenario.py`. One function, `run_scenario(base_url, token) -> None`. Via the API, in this order:
  1. open a ticket;
  2. add one kitchen item and one bar item with a note and quantity 2 (auto-chit path, `tickets.py:86`);
  3. `POST /api/v1/queue/<item_id>/print` (`queue.py:193`);
  4. `POST /api/v1/tickets/<id>/print` (`tickets.py:1859`);
  5. close the ticket;
  6. `POST /api/v1/tickets/<id>/reprint` (`tickets.py:1923`).

  Pick the kitchen and bar items from the restored menu by name: the first active item per routing destination, ordered by name.
- Test: `deploy/windows/tests/test_print_parity.py`

**Interfaces:**
- Consumes: the Task 5 launcher (native backend on 55000 → mock on 59191). The Docker reference runs `billiards-backend:g0` with the default entrypoint and gunicorn on host port 55001, `DATABASE_URL` → `host.docker.internal:55432/print_b` and `PRINT_AGENT_URL=http://host.docker.internal:59192` → a second mock. Two DBs come from the same dump (`print_a`, `print_b`), so the starting state is identical.
- Produces: `normalize(record) -> dict`. It replaces UUIDs with `<uuid>` and ISO/`dd/mm/yyyy HH:MM` timestamps with `<ts>`, and drops ticket and folio numbers if they are sequence-derived.

- [ ] **Step 1: Write the failing tests:**
  - `test_print_payloads_identical`: run the scenario on both stacks; the lists of normalized records are equal (same count, order, paths and bodies). Expected count is 5 (2 auto-chits, 1 queue chit, 1 print, 1 reprint). If the count differs, report it; don't adjust the expectation to match.
  - `test_agent_down_behaviour_matches_docker`: both mocks stopped; same scenario; the HTTP status codes of every step are equal between stacks; no step takes over 9 s; PrintJob rows end in the same status on both DBs.
  - `test_native_uses_loopback_agent`: native backend env `PRINT_AGENT_URL` == `http://127.0.0.1:9191` in the generated `backend.env` (Task 3 output).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the mock, the scenario and the normaliser.
- [ ] **Step 4: Run** them. Expected: 3 PASS. If the payloads differ, stop and report. Don't normalize the difference away.
- [ ] **Step 5: Commit** `test(native): print payload parity native vs docker`

### Task 8: S3 backup (port of `backup/backup.sh` + catch-up)

**Files:**
- Create: `deploy/windows/backup/backup-s3.ps1`
- Test: `deploy/windows/tests/test_backup_s3.py`

**Interfaces:**
- Consumes: `Import-PosEnv`; `backup.env` (Task 3); `pg_dump`/`pg_restore` from `-PgBin`; `aws.exe` from `-AwsExe`.
- Produces: `backup-s3.ps1 -EnvFile <file> -PgBin <dir> -AwsExe <file> -StateDir <dir> [-CatchUp]`. Same contract as `backup.sh`:
  - required env (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`) missing → log `FATAL: missing required environment: <names>` and exit 1;
  - a lock file `StateDir\lock` opened exclusively; if busy, `BACKUP FAILED: another backup is already running`, exit 1;
  - key `<S3_PREFIX|billiardbar>/billiardbar_<yyyy-MM-dd_HHmm>.dump`, local time;
  - `pg_dump -Fc -h $PG_HOST -p $PG_PORT`;
  - size must be > 10240 bytes;
  - `pg_restore --list` must pass;
  - `aws s3 cp --only-show-errors`;
  - on success, touch `StateDir\last_success` and log `OK: <size> bytes -> s3://<bucket>/<key>`;
  - any failure → `BACKUP FAILED: <reason>`, exit 1, marker untouched;
  - temp file always deleted;
  - `-CatchUp` runs only if `last_success` is missing or older than 1440 minutes, otherwise logs `recent backup present, skipping` and exits 0.

  `AWS_ENDPOINT_URL` is honoured through the AWS CLI env, which lets the tests use moto.

- [ ] **Step 1: Write the failing tests** (moto server on 59000, bucket created in a fixture):
  - `test_success_uploads_valid_dump`: exit 0; one object under `billiardbar/` matching `billiardbar_\d{4}-\d{2}-\d{2}_\d{4}\.dump`; the marker exists; the downloaded object passes `pg_restore --list`.
  - `test_uploaded_dump_restores_identically`: download, restore into a fresh DB; `fingerprint.sql` equals the source.
  - `test_upload_failure_leaves_marker_untouched`: wrong endpoint or credentials; exit 1; `BACKUP FAILED: upload` in the log; marker mtime unchanged; no temp file left.
  - `test_tiny_dump_rejected`: dump of an empty DB; exit 1; `dump is only`.
  - `test_missing_env_fatal`: `S3_BUCKET` unset; exit 1; `FATAL: missing required environment: S3_BUCKET`.
  - `test_concurrent_run_refused`: hold the lock; second run exits 1 with `another backup is already running`.
  - `test_catchup_runs_when_marker_stale`: marker mtime 25 h ago; `-CatchUp` uploads.
  - `test_catchup_skips_when_fresh`: marker 1 h ago; `-CatchUp` exits 0 with no upload.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `backup-s3.ps1`.
- [ ] **Step 4: Run** them. Expected: 8 PASS.
- [ ] **Step 5: Commit** `feat(native): S3 backup equivalent to backup sidecar`

### Task 9: Local backup and restore

**Files:**
- Create: `deploy/windows/backup/Backup-Native.ps1`
- Create: `deploy/windows/backup/Restore-Native.ps1`
- Test: `deploy/windows/tests/test_backup_local.py`

**Interfaces:**
- Produces:
  - `Backup-Native.ps1 -EnvFile -PgBin -OutDir [-Label <str>] [-KeepDays 30]`. Writes `db_<label>_<yyyyMMdd_HHmmss>.dump` (`-Fc`), requires `pg_restore --list` to pass and size ≥ 10000, prunes `db_*.dump` older than `KeepDays` (0 = never), and prints the path.
  - `Restore-Native.ps1 -EnvFile -PgBin -DumpFile [-Force]`. Asks for typed `RESTORE` unless `-Force`. **Always takes a safety dump first** through `Backup-Native.ps1 -Label pre-restore -KeepDays 0`, and aborts if that fails. Then it stops `<prefix>-Backend` and `<prefix>-Scheduler` if they exist, terminates connections, drops and recreates the DB with the Global Constraints locale, and runs `pg_restore --no-owner --no-privileges`. It prints row counts for `tickets`, `inventory_items` and `schema_migrations`, and leaves the services stopped (same as `Restore-Database.ps1`).

- [ ] **Step 1: Write the failing tests:**
  - `test_backup_restore_roundtrip_fingerprint`;
  - `test_restore_takes_safety_dump_first` (a `db_pre-restore_*.dump` exists and is valid);
  - `test_restore_aborts_if_safety_dump_fails` (bad `PgBin` → exit ≠ 0, DB untouched by fingerprint);
  - `test_prune_keeps_recent` (files touched at 31 d and 1 d; only the 1 d one remains).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** both scripts.
- [ ] **Step 4: Run** them. Expected: 4 PASS.
- [ ] **Step 5: Commit** `feat(native): local -Fc backup and restore with safety dump`

### Task 10: Install, uninstall, health, as real Windows services

**Files:**
- Create: `deploy/windows/Install-NativePOS.ps1`
- Create: `deploy/windows/Uninstall-NativePOS.ps1`
- Create: `deploy/windows/Health-Native.ps1`
- Test: `deploy/windows/tests/test_services.py` (marked `admin`; skipped unless the shell is elevated)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `Install-NativePOS.ps1 -ReleaseDir <dir> -Root <dir=C:\BilliardsPOS> -Prefix <str=BilliardsPOS> -WebPort 8080 -PgPort 5433 -BackendPort 5000 -StartupType <Automatic|Manual> -EnvDir <dir> [-SkipTasks] [-DailyReportTask]`. Idempotent. It creates:
    - `<Prefix>-Postgres` via `pg_ctl register -N <Prefix>-Postgres -S auto|demand -D <Root>\pgdata`;
    - NSSM services `<Prefix>-Backend` (runs `run-backend.ps1`, `DependOnService <Prefix>-Postgres`), `<Prefix>-Scheduler` (depends on Postgres) and `<Prefix>-Web` (nginx, depends on Backend). Each has `AppExit Default Restart`, `AppRestartDelay 5000`, `AppStdout`/`AppStderr` at `<Root>\logs\<svc>.log`, `AppRotateFiles 1`, `AppRotateBytes 10485760`, and `AppKillProcessTree 1`;
    - SCM recovery `sc failure <svc> reset= 86400 actions= restart/5000/restart/5000/restart/30000`;
    - Task Scheduler jobs, running as SYSTEM with `StartWhenAvailable` on: `<Prefix>-S3Backup` at 02:00 plus at startup (`backup-s3.ps1 -CatchUp`; the 02:00 trigger runs without `-CatchUp`), `<Prefix>-LocalBackup` at 03:00 (`Backup-Native.ps1 -KeepDays 30`), and, only with `-DailyReportTask`, `<Prefix>-DailyReport` at 08:00 (`run-flask.ps1 -Command daily-report`).

    It does **not** touch existing tasks or services (print agent, Rancher, PG18).
  - `Uninstall-NativePOS.ps1 -Prefix <str> [-StopOnly]`. Stops; with `-StopOnly` it disables; otherwise it removes `<Prefix>-*` services and tasks. It never deletes `<Root>\pgdata` or backups.
  - `Health-Native.ps1 -Prefix -WebPort -StateDir`. Prints one line per check: each service Running; `GET http://127.0.0.1:<WebPort>/api/v1/health` 200; `last_success` < 26 h; C: free > 5 GB. Exit 0 only if all checks pass.

- [ ] **Step 1: Write the failing tests** (prefix `BilliardsPOS-Test`, root under `.native-test\root`, test ports; always uninstall in teardown):
  - `test_install_starts_all_services_and_health_green`;
  - `test_backend_restarts_after_kill` (kill the python child; health is 200 again within 30 s);
  - `test_backend_recovers_after_postgres_restart` (`Restart-Service <prefix>-Postgres`; health 200 within 60 s);
  - `test_services_survive_without_logon_settings` (each service `StartName` is LocalSystem or NetworkService; StartType matches the parameter);
  - `test_install_is_idempotent`;
  - `test_uninstall_stoponly_keeps_data`;
  - `test_does_not_touch_foreign_services` (state of every non-`<Prefix>` service unchanged before vs after).
- [ ] **Step 2: Run** them in an **elevated** shell. Expected: FAIL.
- [ ] **Step 3: Implement** the 3 scripts.
- [ ] **Step 4: Run** them, elevated. Expected: 7 PASS. A dev-PC reboot test is **manual and optional**: install with `-StartupType Automatic`, reboot, log in only afterwards, and check the `Health-Native.ps1` exit code. The user decides whether to run it.
- [ ] **Step 5: Commit** `feat(native): service install/uninstall/health`

### Task 11: Full API parity and functional suite

**Files:**
- Create: `deploy/windows/tests/test_parity.py` (port of the spike's `parity.py`)
- Create: `deploy/windows/tests/test_functional.py` (port of the spike's `functional_test.py`)

**Interfaces:**
- Consumes: Task 5 (native on 55000), Task 6 (nginx 59080), and the Docker reference (as in Task 7, against the same DB, read-only GETs).

- [ ] **Step 1: Write the tests:**
  - `test_get_endpoints_identical`: the spike's 95 GET list, including reports for 2026-11-01, 2026-11-03 and 2026-11-06. Volatile keys are scrubbed. Assert 0 differences; `/inventory/stock-check` must return 500 on **both** (a known bug that has to stay the same).
  - `test_functional_flow`: the spike's 25 checks through nginx (login, lists, cash session, ticket, idempotent add 201 then 200 with 1 line, WebSocket event, SPA).
- [ ] **Step 2: Run** them. Expected: PASS if Tasks 1–6 are correct. Any failure is a real regression: fix the cause, never the assertion.
- [ ] **Step 3: Commit** `test(native): API parity and functional suite`

### Task 12: Offline release bundle and runbook (built and installed on the dev PC only)

**Files:**
- Create: `deploy/windows/New-NativeRelease.ps1`
- Create: `deploy/windows/README.md`
- Test: `deploy/windows/tests/test_release.py` (marked `admin`)

**Interfaces:**
- Produces: `New-NativeRelease.ps1 -OutDir <dir> [-DistDir <dir>]`. It writes:
  - `app\backend` (`git archive HEAD backend`);
  - `app\dist`: from `-DistDir` if given (at cutover: `docker cp` from the running frontend container), otherwise `npm ci && vite build` in a temp copy with `VITE_API_URL=/api/v1` and `VITE_SOCKET_URL=/`;
  - `bin\pgsql`, `bin\nginx`, `bin\python`, `bin\nssm.exe` (from `scripts/nssm.exe`), `bin\AWSCLIV2.msi`;
  - `wheelhouse\` (`pip download -r requirements-backend.lock.txt --only-binary=:all: --platform win_amd64 --python-version 3.11`);
  - `deploy\` (all scripts);
  - `SHA256SUMS.txt`.
- README sections:
  1. what runs where (table);
  2. install;
  3. cutover steps: the spec Stage 2, steps 9–16, including disabling the 4 Docker tasks by their exact names (`BilliardBarPOS-Start`, `BilliardBarPOS-Backup`, `PostgreSQL Docker Backup - BilliardBar`, `Billiards_Daily_Report`) and the Rancher HKCU Run entry;
  4. rollback, matching the spec;
  5. daily checks (`Health-Native.ps1`);
  6. Telegram bot, explicitly not installed, with how to add it later.

- [ ] **Step 1: Write the failing test** `test_release_installs_offline`: build the release, then install it with `-Prefix BilliardsPOS-Rel` into a fresh root with network access to PyPI blocked (pip `--no-index` only), restore `POS_TEST_DUMP`, and check that `Health-Native.ps1` exits 0. Uninstall in teardown.
- [ ] **Step 2: Run** it, elevated. Expected: FAIL.
- [ ] **Step 3: Implement** the release script and the README.
- [ ] **Step 4: Run** it. Expected: PASS. Also run the whole suite once: `python -m pytest deploy/windows/tests backend/tests/test_email_date_label.py -v` (elevated, with `-m "slow or not slow"`). Record the summary line in the README "Verified" section with the date.
- [ ] **Step 5: Commit** `feat(native): offline release bundle and cutover runbook`

---

**Out of this plan (needs separate approval):**
- any action on the bar PC;
- uninstalling Rancher;
- the Telegram bot;
- de-duplicating the 08:00 email (kept: `-DailyReportTask` is a switch, so both the scheduler email and the task can be preserved);
- the duplicate print-agent start;
- `/inventory/stock-check` 500;
- the default passwords in compose.
