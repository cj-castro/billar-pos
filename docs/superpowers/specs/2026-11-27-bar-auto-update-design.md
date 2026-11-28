# Design: the bar PC updates itself (no more moving files)

**Status:** for CJ's approval, 2026-11-27 (questions answered). No code yet.
**Branch:** `feat/bar-auto-update`.
**High-risk area:** deploy scripts and `docker-compose.yml` (CODEOWNERS).

---

## 1. Why

Deploying to the Bola 8 PC today means: build a zip on the Mac, carry it to the
bar, check its MD5, zip the old folder, expand the new one over it (keeping
`.env` and the folder name `billiards`), then run four PowerShell steps (stop,
back up, migrate, rebuild). The bar PC builds every image itself, which is slow
and needs internet for `npm ci`. Each release gets its own runbook (17 so far).

CJ: **the most painful part is moving the files around.**

**Goal:** a version reaches the bar by download, only when CJ approves it, and
installs itself at night with a backup, a dry run, a health check, an
automatic rollback and a Telegram message with the result.

This is "lock 1" of `docs/PLAN-SAAS-AND-LICENSING.md` (ship built images, not
source) plus an updater. It is also the first piece of the product sold to
other bars.

## 2. What CJ decided

- **Built images, downloaded** — no source, no build, no zip on the bar PC.
- **The bar PC checks by itself** (option C), not a button at the bar and not
  remote control.
- **Only versions CJ marks "listo para el bar" are installed.** A merge to
  main alone never reaches the bar.
- **Check at 03:00** (bar closes at 01:00; the PC is always on).
- **The updater is a container** in the same Docker setup (option B), tested
  on the Mac before the bar.
- **Test on the Mac first, then the bar PC.**
- **Three private Slack channels** (created 2026-11-27, workspace bola8pos-team):
  - `#bola8-pos` (C0CMQ6AL2JY): Claude's progress updates;
  - `#bola8-pos-updates` (C0CME8F6YRH): the bar PC's nightly result;
  - `#bola8-pos-releases` (C0CM53ZF19V): every version marked "listo para el bar".
  Telegram to CJ stays as an optional second copy of the nightly result.

## 3. Goals, non-goals, anti-goals

**Goals**
- Merge to main → GitHub builds and stores the images.
- One action marks a version approved (and the same action on an older
  version is a manual rollback).
- At 03:00 the bar PC installs the approved version if it differs from what
  runs, safely, and messages CJ.
- The whole update, including a forced failure and its rollback, runs on the
  Mac exactly as it would at the bar.

**Non-goals**
- The phone app (Girish's; it has its own release pipeline).
- Remote shell or remote desktop to the bar PC.
- Managing many bars at once, licensing, a customer portal (SaaS plan, later).
- Zero downtime: updates run while the bar is closed.

**Anti-goals (failure even if it works)**
- An update that starts while a drawer or a ticket is open.
- A failed update that leaves the POS down and nobody knows before the
  manager arrives.
- Any loss of sales data.
- A merge that reaches the bar without CJ approving it.
- Secrets leaving the bar PC (`.env` stays there; the registry key is
  read-only).

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | PowerShell script + Windows Task Scheduler | Reuses `Backup-Database.ps1`, readable log file; Windows only, cannot be tested on the Mac or in CI, PowerShell has already corrupted encodings twice, a Linux bar would need a second version. |
| **B (chosen)** | **An `updater` container** (Python) that drives Docker from inside | Same behaviour on the bar PC, the Mac and CI; testable end to end; no PowerShell; reusable for the next bars. Needs access to the Docker socket (powerful, only this container); must update itself last. |
| — | Watchtower (ready-made image auto-updater) | Dropped: no drawer check, no backup, no migration dry run, no rollback. |

Trigger options considered: button at the bar (A), remote (B), **automatic at
night (C, chosen)**. Approval options: every merge to main, or **only versions
marked ready (chosen)**.

## 5. How it works

### 5.1 Build (GitHub Actions, on every push to main)

New workflow `release-images.yml` builds and pushes, to the GitHub Container
Registry (private), one image per service, tagged with the commit SHA:

- `ghcr.io/cj-castro/billar-pos-backend:<sha>` (also runs the scheduler)
- `ghcr.io/cj-castro/billar-pos-frontend:<sha>` (built with
  `VITE_API_URL=/api/v1`, `VITE_SOCKET_URL=/`, as today)
- `ghcr.io/cj-castro/billar-pos-telegram-bot:<sha>`
- `ghcr.io/cj-castro/billar-pos-backup:<sha>`
- `ghcr.io/cj-castro/billar-pos-updater:<sha>`
- `ghcr.io/cj-castro/billar-pos-release:<sha>` — a tiny image holding only
  `docker-compose.bar.yml` (images pinned to `<sha>`) and `release.json`
  (version, SHA, date, list of migrations in the build).

Postgres stays `postgres:15-alpine` from Docker Hub, as today.

*My call: the GitHub Container Registry, because the code already lives on
GitHub and it needs no AWS account. The SaaS plan can move to AWS ECR later.*

### 5.2 Approve ("listo para el bar")

New workflow `promote-to-bar.yml`, run by hand (GitHub → Actions → "Promote to
bar" → SHA, default = latest main). It points the tag `bar-stable` of every
image above at that SHA (registry retag, no rebuild). Promoting an older SHA is
the manual rollback. A one-line script on the Mac does the same through the API.

The workflow posts to #bola8-pos-releases: "Aprobado para el bar: <sha> · <title of
the last merged PR> · migraciones pendientes respecto a la versión anterior".
The bar only ever reads `billar-pos-release:bar-stable`. *My call: approval
lives in the registry, so the bar PC needs exactly one credential (read
packages) and no GitHub API access.*

### 5.3 On the bar PC

`docker-compose.bar.yml` (replaces the build-based compose on the bar):
- top-level `name: billiards`, so containers and the data volume
  `billiards_pg_data` stay exactly as today (the folder-name trap);
- every service uses `image:` (no `build:`), same environment as today, read
  from the bar's `.env`;
- a new `updater` service with the Docker socket mounted and one host folder
  mounted (the `billiards` folder, for the compose file, `.env`, backups and the
  log). The host path comes from `.env` (`BAR_HOST_DIR`), because a compose run
  from inside a container resolves relative bind paths inside the container,
  not on Windows.

The updater reads from `.env`: `GHCR_USER`, `GHCR_TOKEN` (read-only),
`SLACK_WEBHOOK_URL` (incoming webhook for #bola8-pos-updates), optionally
`TELEGRAM_TOKEN` + `ADMIN_CHAT_ID`, `TZ`, plus the database URL. A message
that cannot be sent is logged and never blocks or fails an update.

### 5.4 The nightly update (03:00, America/Mexico_City)

1. Read `billar-pos-release:bar-stable`. Same SHA as what runs → nothing to do
   (no message, one log line).
2. **Refuse while open:** any cash session or ticket open → no change; retry
   every hour until 12:00; then post "bloqueado: caja abierta" and wait
   for the next night.
3. **Back up:** `pg_dump -Fc` inside the postgres container, streamed by the
   updater to `backups/pre-update-<old>-to-<new>.dump`. Keep the last 10.
4. **Download** the new images.
5. **Rehearse on a copy** with the NEW backend image: restore step 3's backup
   into a scratch database (`billar_scratch_update`), start the new backend's
   startup sequence against it (init-db, seed no-op, apply-migrations), and
   check `migration-status` = 0 pending. Any failure stops here, before the
   live database is touched, and is reported. The scratch database is dropped
   afterwards. (Today every deploy is rehearsed on a production dump because
   about 60 migration assertions depend on real Bola 8 data; this keeps that.)
6. **Switch:** write the new `docker-compose.bar.yml` (old one kept as
   `.previous`), `docker compose up -d` for every service except the updater.
   The backend applies the migrations on start (existing `entrypoint.sh`).
7. **Check** (up to 5 minutes): backend healthy, `flask migration-status` = 0
   pending and no "unknown" versions, frontend answers on its port, scheduler
   and Telegram bot running.
8. **Success:** record the new SHA, post to #bola8-pos-updates ("POS actualizado a <sha> ·
   migraciones: 058 · respaldo: <file>"), then update the updater itself last
   (`up -d updater`).
9. **Failure at 6 or 7 → automatic rollback:** stop the app services;
   restore the database from step 3's backup **whenever the new backend
   started at all** (its `init-db` changes schema outside the migration
   files, so "0 pending migrations" does not mean "schema unchanged"); start
   the previous compose; check again; message CJ ("falló <paso>: <error> · se
   regresó a <old sha>") to #bola8-pos-updates. If the rollback also fails: message "POS caído,
   requiere atención" with the backup path.

Manual commands (for the first run and tests):
`docker compose exec updater python -m updater status | check | run-now`.

### 5.5 Safety

- The updater container is the only one with the Docker socket. Its image is
  small and built from this repo.
- Registry key: classic GitHub token with `read:packages` only (fine-grained
  tokens do not support the container registry). Revocable from GitHub.
- No secrets in images: `.env` stays on the bar PC. The Slack webhook URL is
  a secret (anyone with it can post): `.env` and a GitHub secret only, never
  printed in logs.
- The bar keeps the nightly S3 backup service as today.

### 5.6 Safety rules added during review

- **Restore by swap.** A rollback restores the backup into `<db>_restoring`.
  Only when that works are the names swapped: the live database becomes
  `<db>_failed`, then `<db>_restoring` becomes `<db>`. If the restore fails,
  the live database is not touched.
- **Interrupted swap.** A reboot can cut the swap between the two renames.
  Then there is no `<db>`. Before a restore and at the start of a resume, the
  updater renames `<db>_failed` back to `<db>` (or uses a complete
  `<db>_restoring`). It only renames; it never drops. If it cannot check or
  rename, it refuses to restore.
- **Failed versions are held.** After `rehearsal_failed`, `rolled_back` or
  `rollback_failed`, that version is not tried again by itself. A resume that
  rolls back after the switch reached `compose up` holds the version too.
  After `rollback_failed` or `resume_held`, every version is held. Only
  `run-now --force` clears a hold. Installing another version also clears a
  per-version hold.
- **Resume after a reboot is careful.** The resume checks the current time
  and reads open cash sessions and tickets before each risky step (it reads
  the clock again each time, so a long health check that ends after 12:00
  counts as outside the window). Outside 03:00-12:00, with anything open, or
  when that read fails, it does not start the new version, does not stop
  services and does not restore the database. It lets the health check and
  the running image decide. If the old version runs healthy, it puts the old
  compose file back and starts it (compose up of the old version); it does
  not restore the database. If a restore would be needed, it holds every
  version (`resume_held`) and sends CJ a message with the backup path.
- **telegram-bot in the health check.** The health check requires
  telegram-bot only when `TELEGRAM_TOKEN` is set in `.env`. Without a token, a
  stopped bot is a warning in the message, not a failure.
- **Old images are removed.** After an install (or a resumed install), local
  `billar-pos-*` images with SHA tags are removed, except the current and the
  previous SHA and any image a container uses. `bar-*` tags are never removed.
- **Promote.** Only `cj-castro` can promote. `bar-previous` is set to the SHA
  in the `release.json` of the old `bar-stable` release image.

## 6. Testing (Mac first)

- **Unit tests** (plain scripts, no pytest): the decision logic — version
  compare, open-drawer check, backup rotation, rollback decision — with Docker
  calls stubbed. Added to CI.
- **End-to-end on the Mac** (`scripts/updater/e2e_mac.sh`): a separate compose
  project `billiards-e2e` with its own volume restored from the dev database
  (never `billiar-pos` / `billiardbar`), and two real image sets:
  1. happy path: old SHA → new SHA with a pending migration;
  2. drawer open → blocked, nothing changed;
  3. a deliberately failing migration → database restored, old version
     running, message text produced;
  4. backend never healthy → rollback;
  5. same SHA → nothing happens.
  Messages are printed (dry mode) or posted to #bola8-pos-updates marked "[PRUEBA Mac]".
- **Bar PC:** the one-time setup (section 7), then a first update run by hand
  while CJ watches, to the same version already running.

## 7. One-time setup at the bar (CJ, ~1 hour, bar closed)

1. Back up the database and zip the `billiards` folder (as today).
2. Before going: create the read-only registry token on GitHub, and two Slack
   incoming webhooks: one for #bola8-pos-updates (goes in the bar PC's `.env`)
   and one for #bola8-pos-releases (GitHub secret `SLACK_RELEASES_WEBHOOK_URL`).
3. Copy the last small setup package: `docker-compose.bar.yml`, the updater
   files, and a setup script. Add to `.env`: `GHCR_USER`, `GHCR_TOKEN`,
   `BAR_HOST_DIR`. `.env` otherwise untouched; folder name stays `billiards`.
4. Start with the new compose; run `updater run-now` by hand while watching
   (same version → backup, download, no migrations, restart, health, Telegram).
5. Make sure Docker Desktop starts with Windows and the PC never sleeps.
6. Later, optional: remove the source code from the bar PC.

## 8. Calls made by Claude (CJ to check)

- **Messages only for installs, blocks and failures** — nothing on nights with
  no new version.
- **First approved version = the commit of the manual deploy of 2026-11-28**
  (`0384c10`, the `pos-bundle-2026-11-28.zip`). The bar runs images it built
  from that zip, which carry no commit id; the one-time setup checks
  `flask migration-status` (0 pending, 058 applied) before switching, so the
  first automatic run is a same-version reinstall.
- **Only CJ can approve.** `zedfauji` and `jpicos2101` have write access and
  the account is on GitHub Free (protected Environments with reviewers are not
  available for private repos on Free). So `promote-to-bar.yml` refuses unless
  `github.actor == 'cj-castro'`, and the Mac promote script uses CJ's own login.
- **Registry cost:** GitHub's container registry is currently free for storage
  and transfer, with a month's notice before any change
  ([docs](https://docs.github.com/en/billing/concepts/product-billing/github-packages)).
  Still, a cleanup job keeps only the last 10 SHAs plus whatever `bar-stable`
  and the previous bar version point to.
- **Rehearse every update on a scratch copy** of the fresh backup before
  touching the live database (5.4 step 5).
- **Restore the database on every rollback** in which the new backend started
  (5.4 step 9).

## 9. Open questions for CJ

None. Answered 2026-11-27: nobody uses the POS after 01:00, so the 03:00–12:00
window holds no other work, and a rollback to the backup taken at the start of
the update loses nothing.

## 10. Left to the builder

Updater internals (Docker CLI vs SDK, scheduling library), exact log format,
retention numbers within reason, the Mac script's shape, the promote script.
