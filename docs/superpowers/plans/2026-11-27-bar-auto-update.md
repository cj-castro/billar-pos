# Bar PC auto-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Bola 8 PC installs a CJ-approved version by itself at 03:00 — backup, rehearsal on a copy, switch, health check, automatic rollback, Slack message — with no files moved by hand.

**Architecture:** GitHub Actions builds one image per service on every push to main and pushes them to GHCR tagged by commit SHA, plus a tiny `release` image carrying `docker-compose.bar.yml` and `release.json`. A manual "promote" workflow (CJ only) retags a SHA as `bar-stable`. On the bar PC a Python `updater` container (Docker socket mounted) wakes at 03:00, compares `bar-stable` with what runs, and drives `docker` / `docker compose` through a small command layer that tests replace with a fake.

**Tech Stack:** Python 3.11 (stdlib only + `docker` CLI and compose plugin inside the image), Docker Compose v2, GitHub Actions, GHCR, Slack incoming webhooks.

**Spec:** `docs/superpowers/specs/2026-11-27-bar-auto-update-design.md` (approved 2026-11-27). Read it first.

## Global Constraints

- Compose project name is **`billiards`** (top-level `name: billiards`): volume `billiards_pg_data`, network `billiards_billiardbar_net`. Never change it.
- Images: `ghcr.io/cj-castro/billar-pos-{backend,frontend,telegram-bot,backup,updater,release}`, tag = full 40-char commit SHA; approval tag = `bar-stable`. Postgres stays `postgres:15-alpine`.
- Frontend build args stay `VITE_API_URL=/api/v1`, `VITE_SOCKET_URL=/`.
- Schedule: 03:00 `America/Mexico_City`; when blocked, retry every hour until 12:00.
- Backups: `<BAR_HOST_DIR>/backups/pre-update-<old7>-to-<new7>-<YYYYmmdd-HHMM>.dump`, `pg_dump -Fc`, keep the newest 10 `pre-update-*`.
- Health check budget: 5 minutes after `up -d`.
- Rehearsal database name: `billar_scratch_update` (dropped after every run).
- `.env` keys read by the updater: `GHCR_USER`, `GHCR_TOKEN`, `BAR_HOST_DIR`, `SLACK_WEBHOOK_URL` (#bola8-pos-updates), optional `TELEGRAM_TOKEN` + `ADMIN_CHAT_ID`, `TZ`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. GitHub secret for approvals: `SLACK_RELEASES_WEBHOOK_URL` (#bola8-pos-releases).
- Never print a token or a webhook URL (logs, test output, messages). A message that fails to send is logged and never blocks or fails an update.
- Only `cj-castro` may promote.
- Messages in Spanish; only for installs, blocks and failures.
- No PowerShell pipelines for SQL or dumps; bytes move through `docker exec` / files written by Python.
- Never touch `mobile/`. Never touch the Mac's dev project (`billar-pos` / database `billiardbar`) in tests: e2e uses project `billiards-e2e`.
- Tests are plain scripts printing PASS/FAIL and exiting non-zero on failure (no pytest).
- High-risk area (deploy scripts, `docker-compose*.yml`, `.github/`): call it out in the PR; never weaken an existing test.
- No commits: implementers stage (`git add`); CJ approves the commit at PR time.

## Review Focus

1. **No internet / registry unreachable at 03:00** → nothing changes; retried hourly; one Slack message only if the whole window passes without being able to check. → Task 3 test `registry down all window`.
2. **Backup fails or is empty** (disk full, pg_dump error) → abort before any change, message "falló respaldo". → Task 3 test `backup fails aborts`.
3. **PC rebooted mid-update** (state file says `in_progress`) → on start the updater checks health; healthy → record new version; unhealthy → rollback with the recorded backup. → Task 3 test `resume after reboot`.
4. **CJ promotes an older SHA whose migrations are a subset of what the live DB has** → the old code would run on a newer schema: block with "la versión aprobada es más vieja que la base de datos; requiere restauración manual", change nothing. → Task 3 test `approved older than db blocks`.
5. **Promote of a SHA whose images were never built** (build failed) → the promote workflow fails before retagging anything. → Task 5 step "verify all six images exist".

---

### Task 1: Updater core logic (pure)

**Files:**
- Create: `updater/updater/__init__.py`, `updater/updater/core.py`
- Test: `updater/tests/test_core.py`
- Create: `.github/workflows/updater.yml` (runs `python -m tests.test_core` etc. from `updater/` on every PR; not a required check)

**Interfaces — Produces (`updater.core`):**
- `@dataclass Release: sha: str; built_at: str; migrations: list[str]` and `parse_release(text: str) -> Release` (from `release.json`: `{"sha","built_at","migrations"}`; raises `ValueError` on missing keys or a sha that is not 40 hex chars).
- `@dataclass State: current_sha: str|None; previous_sha: str|None; in_progress: dict|None; last_result: str|None` with `load_state(path) -> State` (missing file → all None) and `save_state(path, state)` (write to `<path>.tmp`, then `os.replace`).
- `decide(release: Release, state: State, live_db_versions: set[str]) -> str` → one of `'noop'` (same sha), `'install'`, `'older_than_db'` (live DB has a migration version not in `release.migrations` and not matching `^0(2[7-9]|3[0-9])[a-z]?$`, the squashed range).
- `in_window(now: datetime, start_h=3, end_h=12) -> bool`.
- `backup_name(old_sha: str|None, new_sha: str, now: datetime) -> str` → `pre-update-<old7|none>-to-<new7>-<YYYYmmdd-HHMM>.dump`.
- `prune_backups(names: list[str], keep=10) -> list[str]` → names to delete (only `pre-update-*`, oldest first by the timestamp in the name).
- `message(kind: str, **kw) -> str` for kinds `installed`, `blocked_open`, `registry_down`, `backup_failed`, `rehearsal_failed`, `rolled_back`, `rollback_failed`, `older_than_db` — Spanish, each includes the short SHAs; never includes env values.

- [ ] **Step 1:** Write `updater/tests/test_core.py` covering: `parse_release` valid/invalid; `decide` → noop / install / older_than_db (live has `058`, release lacks it) and that `031b` in live but not in release is ignored (squashed); `in_window` at 02:59 False, 03:00 True, 11:59 True, 12:00 False; `backup_name(None, 'a'*40, 2026-11-28 03:00)` == `pre-update-none-to-aaaaaaa-20261128-0300.dump`; `prune_backups` with 12 names keeps the newest 10 and ignores `other.dump`; every `message()` kind returns non-empty Spanish text containing the short SHA passed in.
- [ ] **Step 2:** `cd updater && python -m tests.test_core` → FAIL (module missing).
- [ ] **Step 3:** Implement `updater/updater/core.py` (stdlib only). Add `updater.yml` workflow (Python 3.11, runs every `tests/test_*.py` module).
- [ ] **Step 4:** Test passes.
- [ ] **Step 5:** Stage.

### Task 2: Command layer, DB checks and notifier

**Files:**
- Create: `updater/updater/ops.py`, `updater/updater/notify.py`
- Test: `updater/tests/test_ops.py`, `updater/tests/test_notify.py`

**Interfaces — Produces:**
- `class Runner` with `run(args: list[str], *, stdout_path: str|None=None, input_path: str|None=None, timeout: int=600) -> tuple[int, str]` (subprocess, never `shell=True`; returns exit code and combined text output, output redacted of `GHCR_TOKEN` and webhook values). `FakeRunner(responses: dict[str, tuple[int,str]])` in `updater/updater/testing.py` records calls; key = first 3 args joined by space; default `(0, '')`.
- `class Ops(runner, project='billiards', compose_file: str, env_file: str, pg_user, pg_db, registry: str = os.environ.get('UPDATER_REGISTRY', 'ghcr.io/cj-castro'))` — every image name is built from `registry` (Task 6 points it at a local registry):
  - `login(user, token) -> bool` (`docker login ghcr.io -u <user> --password-stdin`, token via stdin, never argv)
  - `pull_release(tag) -> str` (pulls `ghcr.io/cj-castro/billar-pos-release:<tag>`, copies `release.json` + `docker-compose.bar.yml` out with `docker create` / `docker cp` into a temp dir, returns that dir)
  - `open_counts() -> tuple[int, int]` (`docker exec <postgres> psql -tA -c` counting `cash_sessions WHERE status='OPEN'` and `tickets WHERE status='OPEN'`)
  - `live_migration_versions() -> set[str]` (`SELECT version FROM schema_migrations`)
  - `backup(dest_path) -> bool` (`docker exec <postgres> pg_dump -Fc -U .. db`, stdout to file; False if exit≠0 or file < 1 KB)
  - `rehearse(backend_image, dump_path) -> tuple[bool, str]` (create `billar_scratch_update`, `pg_restore` the dump into it, `docker run --rm --network billiards_billiardbar_net -e DATABASE_URL=..scratch.. --entrypoint sh <image> -c "flask init-db && python seed.py && flask factory-finalize && flask apply-migrations --strict && flask migration-status"`, then drop the scratch DB in a `finally`)
  - `pull_images(compose_file) -> bool`, `up(services: list[str]) -> bool`, `stop(services) -> bool`
  - `healthy(timeout_s=300) -> tuple[bool, str]` (backend container health = healthy; `docker compose exec -T backend flask migration-status` shows `0 pending` and no "!!"; frontend `http://frontend/` 200 from inside the network; scheduler and telegram-bot running)
  - `restore(dump_path) -> bool` (`DROP DATABASE .. WITH (FORCE)`, `createdb`, `pg_restore`; app services must be stopped first)
- `notify(text: str, env: dict) -> None` in `notify.py`: POST `{"text": text}` to `SLACK_WEBHOOK_URL`; if `TELEGRAM_TOKEN` and `ADMIN_CHAT_ID`, also Telegram `sendMessage`; any exception or non-2xx is logged (without the URL) and swallowed. `urllib` only.

- [ ] **Step 1:** Tests with `FakeRunner`: `login` passes the token on stdin and not in args; `backup` returns False on exit 1 and on a 10-byte file; `open_counts` parses `"1\n"`/`"0\n"`; `rehearse` always issues the `DROP DATABASE billar_scratch_update` even when the restore fails; `restore` issues FORCE drop → create → restore in that order; `Runner` output redaction hides a token set in env. `test_notify`: a local `http.server` stub receives the JSON text; a 500 from the stub and an unreachable URL both return without raising; the URL never appears in captured log output.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Stage.

### Task 3: The update run, scheduler and CLI

**Files:**
- Create: `updater/updater/run.py`, `updater/updater/__main__.py`
- Test: `updater/tests/test_run.py`

**Interfaces:**
- Consumes: Task 1 `core.*`, Task 2 `Ops`, `notify`, `FakeRunner`.
- Produces: `run_update(ops, env: dict, state_path: str, now: datetime, notify_fn) -> str` returning the outcome kind (`noop`, `installed`, `blocked_open`, `registry_down`, `backup_failed`, `rehearsal_failed`, `rolled_back`, `rollback_failed`, `older_than_db`, `resumed_ok`, `resumed_rolled_back`). CLI: `python -m updater status | check | run-now | daemon`. `daemon` sleeps until 03:00 local, calls `run_update`, re-calls hourly while the outcome is `blocked_open` or `registry_down` and `in_window`, posts the block/registry message once when the window closes.
- Sequence inside `run_update` (spec 5.4): resume check → login → pull release → `decide` → open check → backup → prune → rehearse (new backend image from the release compose) → mark `in_progress` → write compose (old kept as `docker-compose.bar.yml.previous`) → pull images → `up` app services (not `updater`) → `healthy` → success: state current/previous updated, `in_progress` cleared, notify `installed`, then `up(['updater'])` last. Failure after `up`: stop app services → `restore(backup)` → restore previous compose → `up` → `healthy` → notify `rolled_back`; if that fails notify `rollback_failed` with the backup path.

- [ ] **Step 1:** Tests (FakeRunner + fake notify capturing texts), one per outcome above, plus the Review Focus cases: `registry down all window` (daemon helper with injected clock: 03:00..12:00 all fail → exactly one message at 12:00); `backup fails aborts` (no `up`, no compose write); `resume after reboot` (state `in_progress` + healthy → `resumed_ok`; unhealthy → restore called with the recorded dump → `resumed_rolled_back`); `approved older than db blocks` (no backup taken, message `older_than_db`); rehearsal failure → no `up`, no restore of live, compose file unchanged; `installed` → `up(['updater'])` is the LAST call.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Stage.

### Task 4: Images, bar compose and the build workflow

**Files:**
- Create: `updater/Dockerfile` (python:3.11-slim + docker CLI + compose plugin from Docker's static downloads, pinned versions; `CMD ["python","-m","updater","daemon"]`)
- Create: `release/Dockerfile` (`FROM scratch`-like busybox; copies `docker-compose.bar.yml` and `release.json`), `release/make_release.py` (writes `release.json` = sha, UTC build time, migration versions from `backend/migrations/sql/manifest.txt`; renders `docker-compose.bar.yml` from the template with `<sha>`)
- Create: `release/docker-compose.bar.template.yml` — `name: billiards`; same services, environment, healthchecks, ports, `restart` as `docker-compose.yml`, but `image: ghcr.io/cj-castro/billar-pos-<svc>:{{SHA}}` instead of `build:`; scheduler uses the backend image; new `updater` service: image `...-updater:{{SHA}}`, `restart: unless-stopped`, volumes `/var/run/docker.sock:/var/run/docker.sock` and `${BAR_HOST_DIR}:/bar`, env from `.env` keys in Global Constraints, `TZ`.
- Create: `.github/workflows/release-images.yml` — on push to main (and `workflow_dispatch`): login to GHCR with `GITHUB_TOKEN` (`packages: write`), build and push the six images tagged `${{ github.sha }}` (buildx, `linux/amd64`), then a cleanup step keeping the newest 10 SHA tags per package plus anything tagged `bar-stable` / `bar-previous`.
- Test: `release/test_make_release.py`

- [ ] **Step 1:** `test_make_release`: rendered compose has no `build:` key, top-level `name: billiards`, every app image ends with `:<sha>`, the `updater` service mounts the socket and `${BAR_HOST_DIR}:/bar`; every environment key of every service in `docker-compose.yml` exists in the rendered compose (so the bar keeps all settings); `release.json` lists `058` and the sha.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `docker compose -f <rendered> config -q` passes with a dummy `.env`. **Step 4:** PASS; `docker build updater/` succeeds locally. **Step 5:** Stage.

### Task 5: Promote (CJ only) and the Mac promote script

**Files:**
- Create: `.github/workflows/promote-to-bar.yml` — `workflow_dispatch` input `sha` (default empty = latest main). Steps: refuse unless `github.actor == 'cj-castro'`; resolve SHA; **verify all six images exist** for that SHA (`docker manifest inspect`), else fail before any retag; record the current `bar-stable` digest of `release` as `bar-previous`; retag the six with `docker buildx imagetools create -t ...:bar-stable ...:<sha>`; post to `SLACK_RELEASES_WEBHOOK_URL`: "Aprobado para el bar: `<sha7>` · <commit subject> · migraciones nuevas: <list or 'ninguna'>" (diff of `release.json` migrations vs the previous).
- Create: `scripts/promote-to-bar.sh` — triggers the workflow through the REST API (`POST /repos/cj-castro/billar-pos/actions/workflows/promote-to-bar.yml/dispatches`, token from `git credential fill`, never printed), arg = SHA (default `origin/main`), then prints the run URL.

- [ ] **Step 1:** `actionlint` (or `python -c "import yaml"` parse) on both workflows; `bash -n scripts/promote-to-bar.sh`; a dry-run flag `--dry-run` that prints the request body without sending.
- [ ] **Step 2:** Run checks → PASS. **Step 3:** Stage.

### Task 6: End-to-end on the Mac

**Files:**
- Create: `scripts/updater/e2e_mac.sh`, `scripts/updater/README.md`

Runs a local registry (`registry:2` on `localhost:5001`) standing in for GHCR (via `UPDATER_REGISTRY=localhost:5001`, Task 2), builds image sets for two SHAs from two git worktrees (`HEAD~N` = old, `HEAD` = new, where new has at least one migration old lacks — use a throwaway migration `999_e2e_probe.sql` committed only in a temp worktree), brings up project **`billiards-e2e`** with its own volume restored from a fresh `pg_dump` of the dev DB (read-only on `billiardbar`), and runs `python -m updater run-now` inside the e2e updater for each scenario, asserting the outcome and DB state:
1. happy path old→new, migration applied, `#bola8-pos-updates` message or printed text contains `actualizado`;
2. open drawer → `blocked_open`, compose and images unchanged;
3. failing migration (`999_e2e_fail.sql` raising) → `rehearsal_failed`, live DB untouched;
4. backend never healthy (image whose entrypoint exits) → `rolled_back`, DB restored (row count of a marker table equals pre-update), old images running;
5. same SHA → `noop`.
Messages: printed unless `E2E_POST_SLACK=1`, then prefixed `[PRUEBA Mac]`. Tears everything down (`docker compose -p billiards-e2e down -v`, registry container, worktrees) in a trap.

- [ ] **Step 1:** Write the script with `set -euo pipefail`, a guard refusing to run if `-p` would be `billiards` or `billar-pos`.
- [ ] **Step 2:** Run it; all 5 scenarios PASS. Record output in the report.
- [ ] **Step 3:** Stage.

### Task 7: One-time bar setup runbook

**Files:**
- Create: `docs/DEPLOY-BAR-AUTO-UPDATE-SETUP.md`

Spec section 7 as copy-pasteable steps with expected output: before going (GHCR classic token `read:packages`; two Slack incoming webhooks; GitHub secret `SLACK_RELEASES_WEBHOOK_URL`; promote `0384c10…` once the build workflow has built it); at the bar (backup + zip; confirm `flask migration-status` 0 pending with 058 applied; add `.env` keys; place `docker-compose.bar.yml` from the release image with `docker create`/`docker cp`; `docker compose -f docker-compose.bar.yml up -d`; `docker compose exec updater python -m updater run-now` → expect `noop` or same-version reinstall and a Slack message; Docker Desktop "start when you sign in"; Windows power plan never sleep); rollback of the setup itself (start the old build-based compose from the zipped folder). Plain sentences; no PowerShell pipelines.

- [ ] **Step 1:** Write. **Step 2:** Every command checked against Tasks 2–5 names. **Step 3:** Stage.
