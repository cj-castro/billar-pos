# Bar auto-update: one-time setup at Bola 8

Bola 8 · La Calma · `C:\Users\bola8lacalma\Desktop\POS\billiards`

You do this **once**. After it, the POS installs the versions you approve by
itself at 03:00. You no longer copy a zip or build on the PC.

This is a runbook. Every command is one **you** run. Work top to bottom.

**Time:** about 1 hour. **Bar closed. No open tickets. Internet available.**

---

## What changes

| Before | After |
|---|---|
| You copy a zip and run `docker compose build` on the PC. | The PC runs ready-made images from GitHub (GHCR). |
| `docker-compose.yml` builds the code. | `docker-compose.bar.yml` runs images. It comes from GitHub. |
| You deploy by hand. | A new container, the **updater**, checks every night at 03:00 (Mexico City time). It installs the version you approved. |

What does not change: the folder name `billiards`, the data volume
`billiards_pg_data`, the `.env`, the database, the port 8080.

The updater installs only the version that you approve with
`scripts/promote-to-bar.sh` (or Actions → "Promote to bar"). For each install it:
takes a backup, rehearses the migrations on a scratch copy, switches, checks
health for up to 5 minutes, and rolls back by itself if anything fails. It posts
one Spanish message in Slack for each install, block or failure.

---

## Five traps, read before you start

**1. Do not rename the folder.** Compose names the data volume after the project.
The new compose file sets `name: billiards`, so the volume stays
`billiards_pg_data`. Do not set `COMPOSE_PROJECT_NAME` in `.env` to anything
else. A different name creates an **empty** database volume.

**2. Never pipe SQL or dumps through PowerShell.** It corrupts accents (UTF-8).
This runbook uses `docker exec`, `docker cp` and the existing scripts only.

**3. Use `docker compose -f docker-compose.bar.yml ...` after the switch.** If
you type plain `docker compose up -d`, compose reads the OLD `docker-compose.yml`
and rebuilds the old code. Do not do that after step B7.

**4. No quotes in `.env` values.** The updater reads `.env` with
`docker run --env-file`, which keeps quotes as part of the value.
Write `GHCR_USER=cj-castro`, not `GHCR_USER="cj-castro"`.

**5. Never paste a token or a webhook URL into chat, a ticket or a file you
share.** Keep them only in `.env` on the PC and in GitHub secrets.

---

## Part A: Before you go (on the Mac and GitHub)

### A1. Make sure the cash-handoff deploy is already on the PC

The manual deploy of `pos-bundle-2026-11-28.zip` (main commit `0384c10`,
migration 058) must be **done** first. See
`docs/DEPLOY-2026-11-xx-cash-handoff.md`. At the bar you check this in step B2.
Do not start this setup before that deploy.

### A2. Merge the pull request

Merge the PR of the branch `feat/bar-auto-update` into `main`. Write down the
**merge commit**. Get it on the Mac:

```bash
cd /Users/cjcastro/devops/billar-pos
git fetch origin main
git rev-parse origin/main
```

The result is a 40-character SHA. Call it `<MERGE_SHA>`.

**Why not `0384c10`:** images are built only for commits that reach `main`
(workflow `release-images`). Commit `0384c10` has no images. The first approved
version is the merge commit of this feature. It has no new migrations, so the
database does not change.

### A3. Check that the six images were built

On GitHub: Actions → workflow **release-images** → the run for `<MERGE_SHA>`.
Wait for a green mark. The run builds six images:
`billar-pos-backend`, `-frontend`, `-telegram-bot`, `-backup`, `-updater`,
`-release`, each tagged with the full SHA.

If it is red, stop. Fix it first. The approval in A6 checks that all six exist
and refuses if one is missing.

### A4. Create the GitHub token (classic, `read:packages` only)

The PC uses it to download images. It must be **read-only**.

1. GitHub → your avatar → Settings → Developer settings → Personal access
   tokens → **Tokens (classic)** → Generate new token (classic).
2. Note: `bola8-pos-pull`. Expiration: your choice. Write the date in your
   calendar. An expired token stops updates (the updater then reports
   `registry_down`).
3. Tick **only** `read:packages`. Nothing else.
4. Generate. Copy the token once. Keep it for step B4.

Use a **classic** token. Fine-grained tokens do not work with GHCR.

### A5. Create two Slack incoming webhooks

Create them in the Slack app settings (Incoming Webhooks). Make two:

| Channel | Used by | Where it goes |
|---|---|---|
| `#bola8-pos-updates` | The updater on the PC (installs, blocks, failures) | `.env` on the PC, key `SLACK_WEBHOOK_URL` (step B4) |
| `#bola8-pos-releases` | The approval workflow on GitHub | GitHub secret `SLACK_RELEASES_WEBHOOK_URL` |

Add the second one as a GitHub secret: repository → Settings → Secrets and
variables → Actions → New repository secret. Name:
`SLACK_RELEASES_WEBHOOK_URL`. Value: the webhook URL.

### A6. Approve the merge commit

From the Mac:

```bash
cd /Users/cjcastro/devops/billar-pos
scripts/promote-to-bar.sh --dry-run <MERGE_SHA>     # shows the commit, sends nothing
scripts/promote-to-bar.sh <MERGE_SHA>
```

Or on GitHub: Actions → **promote-to-bar** → Run workflow → paste the SHA.
Only the account `cj-castro` can pass this workflow.

Expected: the script prints `Commit:` and `Subject:`, then a line saying the
workflow was started. The run turns green. A message appears in
`#bola8-pos-releases`: `Aprobado para el bar: <7 chars> · <subject> · migraciones nuevas: ninguna`.

This is the **first** promotion, so the run log says `No bar-stable yet (first
promotion).` That is normal. The run then creates the tag `bar-stable` on all six
images. If the log shows a registry error instead (the step that reads the
current `bar-stable` says "Cannot tell if bar-stable exists"), the workflow stops
and changes nothing. Open the run log, wait a few minutes, and run it again.

If the Slack message does not appear, the run log has a warning. Check the
secret name and the webhook. The images are promoted anyway.

---

## Part B: At the bar (bar closed)

Open PowerShell. Go to the folder:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
```

### B1. Back up the database

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Backup-Database.ps1 -Label pre-autoupdate -KeepDays 0
```

Expect: the script ends with the path of a `.dump` file in the `backups` folder.
**Write down the path.** It is your rollback for the data.

### B2. Check that the cash-handoff deploy is complete

```powershell
docker compose exec backend flask migration-status
```

Expect the last lines to be:

```
  058_cash_counts                        applied
N/N applied, 0 pending
```

(`N` is the total. The file name in the 058 line may differ a little.) The two
things that matter: **`0 pending`** and **058 applied**. If not, stop and finish
the cash-handoff deploy first.

Also check nothing is open. These are the same two checks the updater makes
before it changes anything:

```powershell
docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT count(*) FROM tickets WHERE status = 'OPEN';"
docker compose exec postgres psql -U billiard -d billiardbar -tA -c "SELECT count(*) FROM cash_sessions WHERE status = 'OPEN';"
```

Both must print `0`.

### B3. Zip the whole folder (this is your way back)

```powershell
cd C:\Users\bola8lacalma\Desktop\POS
Compress-Archive -Path .\billiards -DestinationPath .\billiards-before-autoupdate.zip
cd .\billiards
```

Expect a new file `billiards-before-autoupdate.zip` next to the folder. Keep it
until the new setup has run well for a few weeks.

### B4. Add four lines to `.env`

Open the file in Notepad:

```powershell
notepad .\.env
```

Add these lines at the end. **No quotes.** Replace the two `<...>` values.

```
GHCR_USER=cj-castro
GHCR_TOKEN=<the classic token from A4>
BAR_HOST_DIR=C:\Users\bola8lacalma\Desktop\POS\billiards
SLACK_WEBHOOK_URL=<the #bola8-pos-updates webhook from A5>
```

Save. Change nothing else in `.env`.

Check the project name in `.env`:

```powershell
Select-String -Path .\.env -Pattern '^COMPOSE_PROJECT_NAME'
```

- It prints nothing: good, go on.
- It prints `COMPOSE_PROJECT_NAME=billiards`: good, leave the line, go on.
- It prints any other value (also an empty one): **stop here and ask the
  developer before you go on. Do not delete the line.** The running stack may
  use that name, and then the real data is in a volume named after it (not
  `billiards_pg_data`). Deleting the line would start the new stack on an empty
  database.

Check that the four keys exist **without printing the secrets**:

```powershell
Select-String -Path .\.env -Pattern '^(GHCR_USER|GHCR_TOKEN|BAR_HOST_DIR|SLACK_WEBHOOK_URL)=' | ForEach-Object { ($_.Line -split '=')[0] }
```

Expect four names: `GHCR_USER`, `GHCR_TOKEN`, `BAR_HOST_DIR`, `SLACK_WEBHOOK_URL`.

### B5. Log in to GHCR

Run this, then paste the token at the `Password:` prompt (the text does not show
as you paste). Do not put the token on the command line:

```powershell
docker login ghcr.io -u cj-castro
```

Expect: `Login Succeeded`.

### B6. Get `docker-compose.bar.yml` from the release image

```powershell
docker create ghcr.io/cj-castro/billar-pos-release:bar-stable
```

It prints a container id (64 hex characters). Use it in the next two commands.
Replace `<ID>`:

```powershell
docker cp <ID>:/docker-compose.bar.yml .
docker rm <ID>
```

Expect: `docker cp` prints nothing or a short success line. The file
`docker-compose.bar.yml` now exists in the folder:

```powershell
Test-Path .\docker-compose.bar.yml        # True
Select-String -Path .\docker-compose.bar.yml -Pattern '^name:'    # name: billiards
```

If `docker create` says "not found" or "denied", the approval (A6) did not run
or the token is wrong. Go back to A4 and A6.

### B7. Check the folder path, then switch

The updater container runs compose itself. It must see this folder at `/bar`.
Docker Desktop on Windows may or may not accept `C:\...` there. Check **before**
you stop anything.

```powershell
docker compose -f docker-compose.bar.yml config -q
```

Expect: no output at all (no error). Always use `-q` here: without it, compose
prints the whole file with every value from `.env`, including the token and the
webhook. If compose prints an error about the volume or the path (for example
"invalid spec" or "too many colons"), use the fallback below. Step B8 checks
the mount itself, from inside the updater.

**Fallback.** Change the `BAR_HOST_DIR` line in `.env` to the Docker Desktop
path of the same folder:

```
BAR_HOST_DIR=/run/desktop/mnt/host/c/Users/bola8lacalma/Desktop/POS/billiards
```

Run `docker compose -f docker-compose.bar.yml config -q` again. It must print
nothing.

Now stop the **old** stack. **Do not use `-v`.** `-v` deletes the data volume.

```powershell
docker compose down
```

Expect: the containers and the network are removed. The volume stays.

Check that the data volume is still there:

```powershell
docker volume ls
```

Expect a line `local   billiards_pg_data`.

Start the new stack:

```powershell
docker compose -f docker-compose.bar.yml up -d
```

The first start downloads the images and can take a few minutes. Expect seven
containers: `postgres`, `backend`, `frontend`, `scheduler`, `telegram-bot`,
`backup`, `updater`.

```powershell
docker compose -f docker-compose.bar.yml ps
```

Expect all of them `running`. `postgres` and `backend` show `healthy`.

### B8. Check the data and the folder mount

The volume must be `billiards_pg_data` and the data must be there:

```powershell
docker volume ls
docker compose -f docker-compose.bar.yml exec postgres psql -U billiard -d billiardbar -tA -c "SELECT count(*) FROM tickets;"
docker compose -f docker-compose.bar.yml exec postgres psql -U billiard -d billiardbar -tA -c "SELECT max(opened_at) FROM cash_sessions;"
docker compose -f docker-compose.bar.yml exec backend flask migration-status
```

Expect: only `billiards_pg_data` for Postgres (no new volume named `billar-pos_...`
or similar that is empty); the ticket count is the real one (thousands, not 0);
the last cash session is the last real day; `0 pending`.

If the ticket count is 0, **stop**. Go to "Rollback of this setup" below.

Check that the updater sees the folder:

```powershell
docker compose -f docker-compose.bar.yml exec updater ls -a /bar
```

Expect to see your own files: `.env`, `docker-compose.bar.yml`, `backups`,
`backend`, `scripts` and so on. If the listing is empty or says "no such file",
the path in `BAR_HOST_DIR` does not work. Use the fallback in B7. Then run
`docker compose -f docker-compose.bar.yml up -d` again and check again.

Now check that `BAR_HOST_DIR` also works for compose and `docker run` started
**from inside the updater**. That is how the updater restarts itself after an
install; the check above does not prove it. Replace `<MERGE_SHA>` (from A2):

```powershell
docker compose -f docker-compose.bar.yml exec updater docker compose -p billiards -f /bar/docker-compose.bar.yml --env-file /bar/.env config -q
docker compose -f docker-compose.bar.yml exec updater sh -c 'docker run --rm --entrypoint ls -v $BAR_HOST_DIR:/x ghcr.io/cj-castro/billar-pos-updater:<MERGE_SHA> -a /x'
```

Expect: the first command prints nothing. The second one lists the same files
as above, and the list must include **`.env`** and **`docker-compose.bar.yml`**.
(There are no double quotes around `$BAR_HOST_DIR` on purpose: Windows
PowerShell can drop them on the way to the container. The path has no spaces,
so they are not needed.)

If the first command prints an error, or the list is empty or misses those two
files, stop. Change `BAR_HOST_DIR` in `.env` to the `/run/desktop/mnt/host/c/...`
form (the fallback in B7), run `docker compose -f docker-compose.bar.yml up -d`
and repeat **all** the checks of this step before you go on.

When the updater container starts, it checks the same thing. If it cannot see
`.env` and `docker-compose.bar.yml` in `/bar`, it posts one Slack message: "El
updater no ve la carpeta del bar ...". The fix is the same.

Open the POS in the browser (`http://localhost:8080`). Log in. Look at a table
and the ticket list.

### B9. First run, while you watch

Step B7's `up -d` already switched the POS to the `<MERGE_SHA>` images, but
without the updater's backup, rehearsal and automatic rollback. The B1 backup
protects that step. This first run now does the full sequence once on the same
version, while you watch: backup, rehearsal, switch, health check. There are no
new migrations. It also gives the updater its first record of what runs.

**If you do the setup between 03:00 and 12:00:** the updater checks for an
update as soon as its container starts (in B7). It may already have started this
same install by itself. Then the command below prints `another update run is in
progress; try again later` (exit code 4), or, if that run has finished,
`outcome: noop`. Both are fine. Wait a few minutes and check with `status`
(below): `current version` must be the merge commit and `last result` must be
`installed`.

```powershell
docker compose -f docker-compose.bar.yml exec updater python -m updater run-now
```

Expect, in order (the exact lines can differ): login to the registry, backup
written, rehearsal passed, switch, health OK. The last lines are a
`message: POS actualizado: none -> <7 chars>. Todo funciona.` and
`outcome: installed`. The old version shows as `none` because the updater had
no record yet. This is normal on the first run.

**The command may end with exit code 137 or cut off before `outcome:`.** On a
successful install the updater replaces its own container, so the command that
runs inside it is killed. That is normal. Then run:

```powershell
docker compose -f docker-compose.bar.yml exec updater python -m updater status
```

Expect:

```
current version : <40-character SHA of the merge commit>
last result     : installed
in progress     : no
pre-update backups: 1
```

Check these things:

1. A message `POS actualizado: ...` is in `#bola8-pos-updates`.
2. The updater container is running again:
   ```powershell
   docker compose -f docker-compose.bar.yml ps
   ```
   All services `running`.
3. The POS works in the browser.

If the outcome is anything else, read "When the status is not good" below.

You can also look at the run without changing anything:

```powershell
docker compose -f docker-compose.bar.yml exec updater python -m updater check
```

### B10. Make sure the PC restarts the POS alone

The updater runs at 03:00 only if Docker is running. After a power cut or a
Windows update restart, nobody types a password, so check all three:

1. **Docker Desktop starts with Windows.** Open Docker Desktop → Settings →
   General → tick **Start Docker Desktop when you sign in to your computer**.
   Apply.
2. **Windows never sleeps.** Settings → System → Power → Screen and sleep: set
   "When plugged in, put my device to sleep after" to **Never**. Check from
   PowerShell:
   ```powershell
   powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
   ```
   Expect `Current AC Power Setting Index: 0x00000000`.
3. **The PC signs in alone after a restart.** Docker Desktop starts only after a
   user signs in. If the PC waits at the password screen after a reboot, the POS
   stays down. Set automatic sign-in for the POS user (run `netplwiz`, untick
   "Users must enter a user name and password to use this computer"). If your
   Windows hides that box, or the PC uses a Microsoft account with a PIN, you
   must set auto sign-in another way. Test it: restart the PC once, do not touch
   it, and wait 5 minutes. Then:
   ```powershell
   docker compose -f C:\Users\bola8lacalma\Desktop\POS\billiards\docker-compose.bar.yml ps
   ```
   All services must be `running` (they restart by themselves,
   `restart: unless-stopped`).

---

## Daily life after the setup

To ship a new version:

1. Merge to `main`. Wait for the **release-images** run to turn green.
2. Run `scripts/promote-to-bar.sh` (default: latest `origin/main`) or Actions →
   promote-to-bar.
3. `#bola8-pos-releases` shows what you approved and the new migrations.
4. At 03:00 the PC installs it. `#bola8-pos-updates` shows the result.

The updater waits while a cash session or a ticket is open. It retries every hour
until 12:00. If it is still blocked at noon, it posts "pospuesta" and tries again
the next night.

After every good install, the updater deletes old POS images from the PC so
that they do not fill the disk. It keeps the images of the current and the
previous version. It never deletes `postgres`, the `bar-stable` and
`bar-previous` tags, or an image that a container uses. If a delete fails, it
only writes it in the log.

If `TELEGRAM_TOKEN` is empty in `.env`, the `telegram-bot` container cannot run.
The health check then only writes a warning (also in the Slack message) and does
not roll back. When `TELEGRAM_TOKEN` is set, `telegram-bot` must be running.

**Do not run plain `docker compose up -d` or `docker compose build` in this
folder any more.** The old `docker-compose.yml` stays in the folder: the
rollback and the backup and restore scripts need it. For any command use
`-f docker-compose.bar.yml`.

---

## How to read `status`

```powershell
docker compose -f docker-compose.bar.yml exec updater python -m updater status
```

| Line | Meaning |
|---|---|
| `current version` | The commit the PC runs now. |
| `previous version` | The one before it. |
| `last result` | The last outcome (see the table below). |
| `in progress` | `no` normally. If it shows a record, an install was cut off (reboot or power cut). When the updater starts again it finishes the install, or rolls back. It restores the database only between 03:00 and 12:00 and only when no cash session or ticket is open; otherwise the outcome is `resume_held` (see below). |
| `HELD` | A version is blocked. A second line gives the **backup path** and says `clear with: python -m updater run-now --force`. |
| `pre-update backups` | How many pre-update dumps exist (it keeps the newest 10) and the last three names. They are in the `backups` folder of the billiards folder. |
| `next run` | The next 03:00. |

The log file is `updater\updater.log` in the billiards folder.

**`current version : unknown` right after an update.** If Slack said the update
went fine but `status` now shows `unknown` (and `pre-update backups: 0`), the
new updater container does not see the billiards folder. The data and the POS
are fine; only the updater is blind. Check:

```powershell
docker compose -f docker-compose.bar.yml exec updater ls -a /bar
```

If `.env` and `docker-compose.bar.yml` are not listed, fix `BAR_HOST_DIR` in
`.env` (try the `/run/desktop/mnt/host/c/...` form from B7), then, from
PowerShell in the billiards folder:

```powershell
docker compose -f docker-compose.bar.yml up -d updater
```

Then run `status` again. It must show the version again.

## When the status is not good

`run-now` exit codes: `0` fine, `3` nothing done for now, `1` failure, `4` another
run is going.

| Outcome | What it means | What you do |
|---|---|---|
| `installed` | Done. | Nothing. |
| `noop` | The PC already runs the approved version. | Nothing. |
| `blocked_open` | A cash session or a ticket is open. Nothing was changed. | Close them. The updater retries every hour until 12:00. Or run `run-now` yourself after you close. |
| `registry_down` | The PC cannot reach GHCR. Often: no internet, or the token is wrong or expired. | Check the internet. Run `... exec updater python -m updater check`; it says if the login fails. If the token expired, make a new one (A4), change `GHCR_TOKEN` in `.env`, then `docker compose -f docker-compose.bar.yml up -d updater`. Then `run-now`. |
| `db_unreachable` | The updater cannot read the database. Nothing was changed. | Run `docker compose -f docker-compose.bar.yml ps`. If `postgres` is not healthy, look at `docker compose -f docker-compose.bar.yml logs postgres`. Fix, then `run-now`. |
| `rehearsal_failed` | The new version failed on a **scratch copy** (for example a migration error). The live database and containers were not touched. The version is held. | Send the text of the Slack message to the developer. Fix in code, merge, approve a new version. A new approved version clears the hold by itself. |
| `rolled_back` | The install failed after the switch. The updater restored the backup and the old version, and the POS works. The failed version is held. | Check that the POS works. Send the Slack message to the developer. Approve a fixed version. Sales made between the backup and the rollback (minutes at 03:00, so usually none) are lost. |
| `held` | A version failed before and is not retried. Nothing is sent. | Fix it first. Then `... exec updater python -m updater run-now --force`. |
| `older_than_db` | The database has newer migrations than the approved version. Nothing was installed. | Approve a newer version. Do not force. |
| `rollback_failed` | **The POS may be down.** The rollback did not work. The updater holds ALL versions. | See below. |
| `resume_held` | An install was cut off by a reboot or a power cut. After the restart the new version was not healthy, but the updater did **not** restore the database: a cash session or ticket was open, it could not check, or it was outside 03:00-12:00. Nothing was stopped. The Slack message ("POS requiere atención") says what it found and gives the backup path. The updater holds ALL versions. | See below. |

### When `rollback_failed` happens

1. Run `status`. Write down the `backup to restore (on the PC)` path. If you do
   not see it, look in the `backups` folder for the newest `pre-update-*.dump`.
2. Look at the state:
   ```powershell
   docker compose -f docker-compose.bar.yml ps
   docker compose -f docker-compose.bar.yml logs --tail 50 backend
   ```
3. If the database is damaged, restore the backup. The script stops the app
   containers, drops and recreates the database, and restores. It asks you to type
   `RESTORE`.
   ```powershell
   cd C:\Users\bola8lacalma\Desktop\POS\billiards
   powershell -ExecutionPolicy Bypass -File .\scripts\deploy\Restore-Database.ps1 -DumpFile "<the backup path>"
   ```
   The script's parameters are `-DumpFile` (required), `-ProjectDir` (default is
   the billiards folder above) and `-Force` (skip the question). It uses the
   `docker-compose.yml` in that folder to find the Postgres container and to stop
   the apps, and the project name is the same (`billiards`), so it works.
   Its last line says to start with `docker compose up -d`. **Do not use that.**
   Use:
   ```powershell
   docker compose -f docker-compose.bar.yml up -d
   ```
   The compose file at this point is the one from the last good version (the
   updater puts the previous one back; a copy is `docker-compose.bar.yml.previous`).
   Check it names the version you want to run.
4. Check that the POS works and the data is right.
5. Only after you fixed the cause, clear the hold:
   ```powershell
   docker compose -f docker-compose.bar.yml exec updater python -m updater run-now --force
   ```
   `--force` clears the hold. It does not hide a fault. If the cause is still
   there, the run fails again.

### When `resume_held` happens

The updater did not restore on purpose: sales may have happened since the
backup, and a restore would delete them.

1. Check the POS in the browser and `docker compose -f docker-compose.bar.yml ps`.
2. If the POS works and the data is right, nothing is lost. Clear the hold when
   the bar is closed: `... exec updater python -m updater run-now --force`. It
   installs the approved version again with the full sequence.
3. If the POS does not work, follow the `rollback_failed` steps above. Before you
   restore the backup, think about the sales made after it: they are lost by the
   restore. Write them down first if you can.

If the POS is down and you cannot fix it fast, use the rollback below. It is the
way back to how the bar ran before.

---

## Rollback of this setup (go back to the zip and build)

Use this if the setup fails and you want the old way back.

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
docker compose -f docker-compose.bar.yml down
```

**No `-v`.** The data volume stays. Then start the old stack. The old
`docker-compose.yml` is still in the folder:

```powershell
docker compose up -d
```

Expect: the old build-based stack starts on the same volume `billiards_pg_data`
with the same data. This works if the database was not changed by an update. If
the updater already installed a version with a **new migration**, the old code
may be older than the database: in that case restore the pre-update backup first
(`Restore-Database.ps1`, see above) before `docker compose up -d`.

If the folder itself is damaged, unzip the old copy over it. Close the old
stack first:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS
docker compose -f .\billiards\docker-compose.bar.yml down
Rename-Item .\billiards billiards-broken
Expand-Archive .\billiards-before-autoupdate.zip -DestinationPath .
cd .\billiards
docker compose up -d
```

Check that the folder is named `billiards` again. The zip holds the folder
`billiards`, so the name is right. After the stack is up, check the ticket count
as in step B8.

To stop the updater alone, without going back:
`docker compose -f docker-compose.bar.yml stop updater`. The POS keeps running.
It starts again with `up -d`.

---

## Security note for CJ

Two other GitHub accounts, `zedfauji` and `jpicos2101`, have **write** access to
the repository. On GitHub Free, a person with write access could push a branch
that edits the promote workflow and approve a version that you did not review.
The check "only `cj-castro`" is inside that same workflow file. Think about
lowering both accounts to **Read** or **Triage** (Settings → Collaborators). They
can then still open issues and pull requests from forks or review code.
The same GitHub Free limit applies to the image build: a person with write
access could also run an edited `release-images` workflow from a branch and
overwrite the `:<sha>` image tags with other content. The approval checks only
that the images exist, not who built them.
Also: keep the classic token read-only (`read:packages`). It can only download.

---

## Later (optional)

Remove the source code from the bar PC. The PC does not need `backend\` or
`frontend\` any more. Keep `.env`, `docker-compose.bar.yml`, `backups\`,
`updater\`, `scripts\deploy\` (the restore and backup scripts) and
**`docker-compose.yml`**. `Backup-Database.ps1` and `Restore-Database.ps1`
refuse to run when `docker-compose.yml` is not in the folder (they use it to
find the Postgres container and to stop the apps). Without `backend\` and
`frontend\` the old file can no longer build, so the way back in "Rollback of
this setup" is then the old zip. Do this only after some weeks of good nightly
updates, and keep the old zip.
