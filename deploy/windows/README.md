# Billiard Bar POS: native Windows install (no Docker)

For the code owner and whoever does the bar cutover. This replaces the Docker stack (Rancher Desktop + compose) with
Windows services. App behaviour is unchanged; only how it is hosted changes. Nothing here has been run on the bar PC.

## 1. What runs where

Default prefix `BilliardsPOS`, install root `C:\BilliardsPOS` (called `<Root>` below; it must not contain spaces).

| Piece | Name | Listens | Account | Logs |
|---|---|---|---|---|
| PostgreSQL 15 | service `BilliardsPOS-Postgres` | 127.0.0.1:**5433** | NT AUTHORITY\NetworkService | `<Root>\pgdata\log\postgresql-<Mon..Sun>.log` (7 files, overwritten weekly), `<Root>\pgdata\pos-init.log` (first init) |
| Backend (eventlet + Flask, `serve_windows.py`) | service `BilliardsPOS-Backend` | 127.0.0.1:**5000** | LocalSystem | `<Root>\logs\BilliardsPOS-Backend.log` |
| Scheduler | service `BilliardsPOS-Scheduler` | none | LocalSystem | `<Root>\logs\BilliardsPOS-Scheduler.log` |
| Web (nginx 1.27.5, serves `app\dist`, proxies `/api` and sockets) | service `BilliardsPOS-Web` | 0.0.0.0:**8080** | LocalSystem | `<Root>\logs\BilliardsPOS-Web.log`, nginx's own `<Root>\web\logs` |
| S3 backup, daily | scheduled task `BilliardsPOS-S3Backup` (02:00) | | SYSTEM | `<Root>\logs\BilliardsPOS-S3Backup.log` (`OK:` / `BACKUP FAILED:` lines), marker `<Root>\state\last_success` |
| S3 backup, catch-up | scheduled task `BilliardsPOS-S3Backup-Catchup` (at startup +5 min, `-CatchUp`) | | SYSTEM | `<Root>\logs\BilliardsPOS-S3Backup-Catchup.log` |
| Local dump | scheduled task `BilliardsPOS-LocalBackup` (03:00, keeps 30 days; also deletes `<Root>\logs\*.log*` older than 30 days) | | SYSTEM | `<Root>\logs\BilliardsPOS-LocalBackup.log`, dumps in `<Root>\backups` |
| Daily report | scheduled task `BilliardsPOS-DailyReport` (08:00), only if installed with `-DailyReportTask` | | SYSTEM | `<Root>\logs\BilliardsPOS-DailyReport.log` |

Every task appends all of its output to `<Root>\logs\<TaskName>.log` and still exits with the script's exit code, so Task
Scheduler's `LastTaskResult` and the log agree. **The S3 IAM key is write-only and cannot list the bucket**, so the way to confirm an
upload is the `OK: <bytes> -> s3://...` line in `<Root>\logs\BilliardsPOS-S3Backup*.log` plus a fresh `<Root>\state\last_success`
(`Health-Native.ps1` checks the marker). A failure leaves the marker alone and logs `BACKUP FAILED: <reason>`; the next boot's catch-up task retries.

Dependencies: Backend and Scheduler need Postgres; Web needs Backend. All three NSSM services restart on exit after 5 s;
all four have `sc failure` recovery (restart 5 s, 5 s, 30 s). The backend keeps retrying until Postgres is up.
Layout under `<Root>`: `app` (backend, dist), `venv`, `bin` (pgsql, nginx, python, nssm.exe, aws), `config` (env files with
secrets), `pgdata`, `web`, `logs`, `state`, `backups`, `deploy` (these scripts).
The print agent is not part of this install: the backend talks to `http://127.0.0.1:9191` exactly as before.

Ports: the bar PC already has PostgreSQL 18 on 5432 (leave it alone) and Windows MultiPoint on 80, hence 5433 and 8080.

**Time zone.** Docker ran the backend with `TZ=America/Mexico_City`. Natively `TZ` is deliberately absent (a Windows `TZ` makes
naive time UTC), so the backend follows the Windows zone, and the installer refuses to run unless
`(Get-TimeZone).Id` is `Central Standard Time (Mexico)`. `Export-ComposeEnv.ps1` likewise throws unless compose resolves
`TZ=America/Mexico_City` for backend and scheduler. Fix a wrong zone with `Set-TimeZone -Id 'Central Standard Time (Mexico)'`.
(`-SkipTimeZoneCheck` exists for tests only.)

**Permissions** (set by the installer, always by SID so Spanish Windows names do not matter). `C:\` gives Authenticated Users
Modify by default, and LocalSystem services and SYSTEM tasks execute code from `<Root>`, so `<Root>` is protected:

| Path | Access |
|---|---|
| `<Root>` (and `app`, `bin`, `deploy`, `venv`, `web` by inheritance) | SYSTEM + Administrators Full, `BUILTIN\Users` read+execute; nobody else can write |
| `config`, `logs`, `state`, `backups` (full dumps, secrets) | SYSTEM + Administrators only |
| `pgdata` | SYSTEM + Administrators + NetworkService Modify. During the first cluster init the installing user's own SID also gets Modify (initdb and pg_ctl drop the Administrators group from their token), and it is removed again right after |

So logs, dumps and state are only readable from an elevated shell (run `Health-Native.ps1` elevated too). nginx's own
`<Root>\web\logs` (access logs with client IPs) stays readable by Users. `-DryRun` prints the exact `icacls` plan.

## 2. Build the release and install

Build on any Windows PC with git, internet, uv and (if `-DistDir` is not given) node. Commit first: the backend and the
scripts come from `git archive`.

```powershell
deploy\windows\New-NativeRelease.ps1 -OutDir D:\release\billiard-native -DistDir <dir with the frontend dist>
```

`-DistDir` must be the **flat** dist: `index.html` at its top level (the release build and the installer both refuse anything else).
At cutover, capture it BEFORE the cutover window, while the Docker stack is still running:

```powershell
$fe = docker compose ps -q frontend
New-Item -ItemType Directory -Force D:\dist-capture | Out-Null
docker cp "${fe}:/usr/share/nginx/html/." D:\dist-capture      # note the trailing /. : copies the CONTENTS (without it, an existing folder gets a nested html\)
Test-Path D:\dist-capture\index.html                            # must be True
```

so the bar serves exactly the build it serves today. Without `-DistDir` the script runs `npm ci` and a vite build with
`VITE_API_URL=/api/v1 VITE_SOCKET_URL=/`. Binaries (PostgreSQL 15.19, nginx 1.27.5, CPython 3.11, NSSM 2.24, AWS CLI v2 msi)
are downloaded by the script or passed with `-PgDir -NginxDir -PythonDir -NssmExe -AwsMsi`. NSSM is never committed. The
wheelhouse is `pip download` of the lock (`python\requirements-backend.lock.txt`, the bar's exact `pip freeze` plus tzdata),
so the install needs no internet. A failed build deletes its partial `-OutDir`.

After copying the release folder to the bar PC (`<rel>`), unblock and verify it there with the release's own copy of the script
(an elevated PowerShell; files copied from another PC carry the "downloaded" mark and the execution policy can refuse them):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
Get-ChildItem -Recurse <rel> | Unblock-File
<rel>\deploy\New-NativeRelease.ps1 -VerifyDir <rel>      # exit 0 = every file matches SHA256SUMS.txt
```

Install (same elevated PowerShell):

```powershell
<rel>\deploy\Install-NativePOS.ps1 -ReleaseDir <rel> -EnvDir C:\pos-env -Root C:\BilliardsPOS -DailyReportTask
<rel>\deploy\Install-NativePOS.ps1 -DryRun -ReleaseDir <rel> -EnvDir C:\pos-env      # prints every action, needs no elevation
```

`-DailyReportTask` keeps today's task-driven 08:00 report (`BilliardsPOS-DailyReport`); the scheduler's own 08:00 email is
unchanged either way. Add `-StartupType Manual` to install without auto-start.

The installer is idempotent (re-run it to upgrade: dist is replaced, services are re-registered). It never deletes anything in
`pgdata`, `backups`, `logs` or `state`, but it does rewrite `pgdata\postgresql.conf` (the marked `# BEGIN POS` block) and
`pgdata\pg_hba.conf`, re-applies the ACLs above, and overwrites `<Root>\config\backend.env`, `scheduler.env` and `backup.env` from
`-EnvDir` on every run. For an upgrade pass `-EnvDir C:\BilliardsPOS\config` (same folder: the copy is skipped and the live
secrets stay as they are).

## 3. Stage 1: side-by-side rehearsal on the bar PC (before cutover)

Goal: prove the native stack on the real machine, against a copy of last night's data, while Docker keeps serving on :8080.
Nothing here touches Docker or the production database. Use a normal quiet day, not the cutover day.

1. Get a dump: last night's local dump, or take a fresh online one (Postgres keeps running, nothing is stopped):
   ```powershell
   New-Item -ItemType Directory -Force C:\cutover | Out-Null
   $c = docker compose ps -q postgres
   docker exec $c pg_dump -Fc -U billiard -d billiardbar -f /tmp/rehearsal.dump
   docker cp "${c}:/tmp/rehearsal.dump" C:\cutover\rehearsal.dump
   ```
2. Env files and install on **:8081**, manual start, no scheduled tasks:
   ```powershell
   <rel>\deploy\Export-ComposeEnv.ps1 -ComposeDir <compose> -OutDir C:\pos-env -PgPort 5433
   <rel>\deploy\Install-NativePOS.ps1 -ReleaseDir <rel> -EnvDir C:\pos-env -Root C:\BilliardsPOS -WebPort 8081 -StartupType Manual -SkipTasks
   Stop-Service BilliardsPOS-Scheduler      # keep it OFF: it would send the real 08:00 email and run its jobs on the copy
   ```
   Postgres (5433) and the backend (127.0.0.1:5000) do not clash with Docker (only the frontend publishes a port, 8080).
3. Restore the dump into native Postgres and start the app (the restore leaves services stopped):
   ```powershell
   C:\BilliardsPOS\deploy\backup\Restore-Native.ps1 -EnvFile C:\pos-env\backup.env -PgBin C:\BilliardsPOS\bin\pgsql\bin -DumpFile C:\cutover\rehearsal.dump -OutDir C:\BilliardsPOS\backups -Force
   Start-Service BilliardsPOS-Backend, BilliardsPOS-Web
   C:\BilliardsPOS\deploy\Health-Native.ps1 -WebPort 8081      # the last_success line FAILs on purpose: no backup task in a rehearsal
   ```
4. Checks on **:8081** (the rehearsal DB is a copy: anything done here is thrown away):
   - Desktop browser `http://localhost:8081`; logins; open a table, add items, close a ticket, see it in reports.
   - Phones on the LAN `http://192.168.1.24:8081` and the mobile app pointed at :8081. If they cannot connect, add a temporary
     inbound allow rule for TCP 8081 and delete it afterwards.
   - Printing: a ticket receipt on `La Barra` and a comanda on `Cocina Comandas` (the print agent is shared with Docker, so
     real paper comes out).
5. **Reboot drill.** Make the four services automatic, reboot WITHOUT logging in, time it, then put them back to manual:
   ```powershell
   'Postgres','Backend','Web' | ForEach-Object { Set-Service "BilliardsPOS-$_" -StartupType Automatic }
   Restart-Computer
   ```
   After the reboot, from another PC or phone (do not log on at the bar PC), time how long until `http://192.168.1.24:8081`
   loads; then log on, check `Get-Service BilliardsPOS-*` and `Health-Native.ps1 -WebPort 8081`, and
   `'Postgres','Backend','Web' | ForEach-Object { Set-Service "BilliardsPOS-$_" -StartupType Manual }`.
   (Do not leave the Scheduler automatic; do the drill outside 08:00.) Write the time down.
6. **Rollback drill.** `Stop-Service BilliardsPOS-Web, BilliardsPOS-Backend` (and Scheduler if running), then confirm Docker is
   unaffected: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/api/v1/health` is 200 and the Docker app works as before.
7. Clean up: `C:\BilliardsPOS\deploy\Uninstall-NativePOS.ps1 -Prefix BilliardsPOS` (keeps pgdata/backups/config/logs), then delete
   `C:\BilliardsPOS` (`pgdata` holds a copy of production data) and `C:\pos-env`. Cutover then starts clean: it re-runs the
   install with the default port 8080 and the scheduled tasks.

## 4. Stage 2: cutover (bar PC, Docker to native)

Do this out of hours. `<Root>` = `C:\BilliardsPOS`, `<compose>` = the bar's compose folder
(`C:\Users\bola8lacalma\Desktop\POS\billiards`), `<rel>` = the release folder, `C:\cutover` = a scratch folder you create.
Commands are PowerShell; user `billiard` and database `billiardbar` are the compose defaults (check `<compose>\.env`).

> **Do NOT uninstall Rancher Desktop, run `docker system prune`, or run `docker compose down -v`.** The Docker volume
> is the rollback. While native runs, native nginx holds port 8080, so Docker and native cannot both be up
> (rollback stops native first).

### Before the window (Docker still running)

1. Build the release with the dist captured from the running frontend (section 2), copy it to the bar, unblock and verify it.
   `(Get-TimeZone).Id` must be `Central Standard Time (Mexico)`.
2. **The bar's running backend code must equal the release.** Copy the code out of the running container and diff it against the
   release, ignoring `__pycache__` (line endings are normalised so a CRLF working tree does not show up as a total diff):
   ```powershell
   $bc = docker compose ps -q backend
   docker cp "${bc}:/app" C:\cutover\app-docker
   function Tree($r) {
       $r = (Resolve-Path $r).Path
       Get-ChildItem $r -Recurse -File | Where-Object { $_.FullName -notmatch '\\__pycache__\\' } | ForEach-Object {
           $t = [IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"
           '{0}  {1}' -f $_.FullName.Substring($r.Length + 1),
               [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t)))
       }
   }
   Compare-Object (Tree C:\cutover\app-docker) (Tree <rel>\app\backend)
   ```
   The only acceptable differences are the one intended change of this branch, `app\services\email_report_svc.py`, and its test
   `tests\test_email_date_label.py` (release side only). Any other line, in particular any `.py` or `.sql` file, means the bar is running different code than the
   release: **stop** and rebuild the release from what the bar actually runs.
3. **Capture report output from Docker** for three past days that had sales (so native can be compared after the restore).
   Reports need a manager token; the password is typed into a prompt, never onto the command line:
   ```powershell
   $tag = 'old'                       # use 'new' for the same block after step 11 of the cutover
   $base = 'http://127.0.0.1:8080/api/v1'
   $cred = Get-Credential             # a manager account
   $tok = (Invoke-RestMethod -Method Post "$base/auth/login" -ContentType 'application/json' `
           -Body (@{ username = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json)).access_token
   $h = @{ Authorization = "Bearer $tok" }
   foreach ($d in '2026-11-01', '2026-11-03', '2026-11-06') {      # pick three real days with sales
       foreach ($p in 'reports/earnings', 'reports/sales', 'reports/payments', 'reports/staff') {
           $r = Invoke-WebRequest -UseBasicParsing -Headers $h "$base/${p}?from=${d}&to=${d}T23:59:59"
           [IO.File]::WriteAllText("C:\cutover\rep-$tag-$d-$($p -replace '/', '_').json", $r.Content)
       }
   }
   ```
   Check at least `reports/earnings` shows a non-zero `ingresos_cents` for each day, otherwise the comparison proves nothing.

### The window

1. **Env files, while Rancher/Docker is still running** (it asks `docker compose config`):
   `<rel>\deploy\Export-ComposeEnv.ps1 -ComposeDir <compose> -OutDir C:\pos-env -PgPort 5433`
   writes `backend.env`, `scheduler.env`, `backup.env` (the `TZ` line is stripped for backend and scheduler on purpose, after checking it
   was `America/Mexico_City`; the folder is ACL'd to SYSTEM + Administrators).
2. **Freeze writers.** In `<compose>`: `docker compose stop frontend backend scheduler telegram-bot backup` (Postgres keeps running).
3. **Final dump and check.**
   ```powershell
   $c = docker compose ps -q postgres
   docker exec $c pg_dump -Fc -U billiard -d billiardbar -f /tmp/cutover.dump
   docker cp "${c}:/tmp/cutover.dump" C:\cutover\cutover.dump
   <rel>\bin\pgsql\bin\pg_restore.exe --list C:\cutover\cutover.dump > $null
   if ($LASTEXITCODE) { throw 'cutover.dump is unreadable' }      # do not pipe to Select-Object: that makes $LASTEXITCODE unreliable
   ```
   Copy `C:\cutover\cutover.dump` OFF the machine (USB / another PC) before going on.
4. **Fingerprint and schema of the old DB** (the container publishes no port and host 5432 is the unrelated PG18, so go through the container):
   ```powershell
   Get-Content <rel>\deploy\sql\fingerprint.sql | docker exec -i $c psql -U billiard -d billiardbar -At | Out-File -Encoding utf8 C:\cutover\old.txt
   docker exec $c sh -c "pg_dump --schema-only --no-owner --no-privileges -U billiard -d billiardbar > /tmp/schema.sql"
   docker cp "${c}:/tmp/schema.sql" C:\cutover\schema-old.sql
   ```
5. `docker compose stop` (everything). Save the Rancher autostart, then quit Rancher and remove it:
   ```powershell
   $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
   reg export 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' C:\cutover\run-key.reg /y
   (Get-ItemProperty $run).RancherDesktop | Set-Content C:\cutover\RancherDesktop.run.txt      # the value, for rollback
   rdctl shutdown
   Remove-ItemProperty $run -Name RancherDesktop
   ```
   (Run these as the bar's logged-on user: it is an HKCU value.)
6. **Disable (do not delete)** the four Docker-era scheduled tasks, they are the rollback path:
   `BilliardBarPOS-Start`, `BilliardBarPOS-Backup`, `PostgreSQL Docker Backup - BilliardBar`, `Billiards_Daily_Report`
   (`Disable-ScheduledTask -TaskName '<name>'` for each).
7. **Install** (section 2, with `-DailyReportTask`). The first run initialises the cluster from `backup.env`. The installer
   starts all four services at its end, so from now until the restore finishes the POS is reachable on :8080 with an empty, freshly
   seeded database: keep this strictly out of opening hours and do not let anyone log in.
8. **Restore.**
   `<Root>\deploy\backup\Restore-Native.ps1 -EnvFile C:\pos-env\backup.env -PgBin <Root>\bin\pgsql\bin -DumpFile C:\cutover\cutover.dump -OutDir <Root>\backups -Force`
   (safety dump of the current DB first, stops the POS services, drops and recreates the DB, restores, leaves services stopped).
9. **Fingerprint and schema of the new DB and compare.** The password is read from the env file, never typed:
   ```powershell
   Import-Module <Root>\deploy\PosCommon.psm1 -Force
   Import-PosEnv C:\pos-env\backup.env                        # sets POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB for this session
   $env:PGPASSWORD = $env:POSTGRES_PASSWORD
   $pg = '<Root>\bin\pgsql\bin'
   & $pg\psql.exe -h 127.0.0.1 -p 5433 -U $env:POSTGRES_USER -d $env:POSTGRES_DB -At -f <Root>\deploy\sql\fingerprint.sql | Out-File -Encoding utf8 C:\cutover\new.txt
   Compare-Object (Get-Content C:\cutover\old.txt) (Get-Content C:\cutover\new.txt)      # must print nothing
   & $pg\pg_dump.exe --schema-only --no-owner --no-privileges -h 127.0.0.1 -p 5433 -U $env:POSTGRES_USER -d $env:POSTGRES_DB -f C:\cutover\schema-new.sql
   $keep = { $_ -notmatch '^(--|SET |\\restrict|\\unrestrict)' -and $_.Trim() }
   Compare-Object (Get-Content C:\cutover\schema-old.sql | Where-Object $keep) (Get-Content C:\cutover\schema-new.sql | Where-Object $keep)      # must print nothing
   Remove-Item Env:PGPASSWORD
   ```
   The schema diff must be empty once comment lines (`--`, which carry owners and pg_dump versions), `SET` lines and the
   random `\restrict`/`\unrestrict` tokens of newer pg_dump minors are filtered out as above; ownership/comment noise is fine, any
   `CREATE`/`ALTER`/`COMMENT ON`/column or index line that differs is not. Any difference: stop and roll back.
10. **Delete the env folder** (it holds the DB and API secrets; the live copies are in `<Root>\config`): `Remove-Item C:\pos-env -Recurse -Force`.
    From now on use `-EnvDir <Root>\config` if the installer is ever re-run.
11. **Start:** `Start-Service BilliardsPOS-Backend, BilliardsPOS-Scheduler, BilliardsPOS-Web` (Postgres is already running).
12. **S3 backup once by hand, before the health gate** (it writes the marker Health checks):
    `Start-ScheduledTask BilliardsPOS-S3Backup`; wait for it to finish (`Get-ScheduledTaskInfo BilliardsPOS-S3Backup`, `LastTaskResult` 0),
    then confirm `<Root>\state\last_success` is fresh and `Get-Content <Root>\logs\BilliardsPOS-S3Backup.log -Tail 5` ends with the
    `OK: <bytes> -> s3://...` line (the IAM key cannot list the bucket, so that line is the proof).
13. **Checks, all must pass before the bar opens:**
    - `<Root>\deploy\Health-Native.ps1` exits 0 (all `[OK]`).
    - Migrations after the start of step 11, not step 7 (step 7 migrated the empty database): the LAST `Migrations:` line must say 0 applied.
      `Select-String 'Migrations:' <Root>\logs\BilliardsPOS-Backend.log | Select-Object -Last 1` shows `Migrations: 0 applied, 4 already present`
      (anything applied means the dump was not the final schema).
    - Reports equal Docker's: re-run the "capture report output" block of "Before the window" with `$tag = 'new'` (same URL, :8080 is native now), then
      ```powershell
      foreach ($f in Get-ChildItem C:\cutover\rep-old-*.json) {
          $n = $f.FullName -replace 'rep-old-', 'rep-new-'
          if ((Get-Content -Raw $f | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress) -ne (Get-Content -Raw $n | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress)) { "DIFF $($f.Name)" }
      }
      ```
      must print nothing.
    - Staff logins work; open a table, add items, close a ticket, see it in reports.
    - Printing: a ticket receipt on `La Barra` and a comanda on `Cocina Comandas`.
    - Phones on the LAN (`http://192.168.1.24:8080`) and over Tailscale; the desktop app on `http://localhost:8080`.
14. **Reboot without anyone logging in.** After boot all four services are Running, `Health-Native.ps1` is green, a phone can open the app.

Keep `cutover.dump` (and the off-machine copy), `old.txt`, `schema-old.sql`, the `rep-old-*` files and the Docker volume until the native install has run for a while.

## 5. Rollback (back to Docker)

Order matters: native Postgres must stay up until it has been dumped, and the Docker Postgres container must be up (app containers down) for the restore.

1. Stop the native app services (frees port 8080): `Stop-Service BilliardsPOS-Web, BilliardsPOS-Scheduler, BilliardsPOS-Backend`.
2. **Only if native took sales since cutover:** dump it while native Postgres is still running:
   `<Root>\deploy\backup\Backup-Native.ps1 -EnvFile <Root>\config\backup.env -PgBin <Root>\bin\pgsql\bin -OutDir <Root>\backups -Label rollback -KeepDays 0`
   (the last output line is the dump path).
3. `<Root>\deploy\Uninstall-NativePOS.ps1 -Prefix BilliardsPOS -StopOnly` (stops and disables services and tasks, keeps data).
4. Start Rancher Desktop, wait until `docker info` works, then in `<compose>`: `docker compose up -d postgres`.
5. **Only if step 2 was done:** `<compose>\scripts\deploy\Restore-Database.ps1 -DumpFile <dump from step 2> -ProjectDir <compose> -Force`
   (it stops the app containers and leaves them stopped). With no native sales, the Docker DB is already the frozen cutover state: skip.
6. `docker compose up -d`.
7. Re-enable the four tasks (`Enable-ScheduledTask -TaskName '<name>'`): `BilliardBarPOS-Start`, `BilliardBarPOS-Backup`,
   `PostgreSQL Docker Backup - BilliardBar`, `Billiards_Daily_Report`; and, as the bar's user, restore the Run key:
   `Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name RancherDesktop -Value (Get-Content C:\cutover\RancherDesktop.run.txt)`
   (or `reg import C:\cutover\run-key.reg`).
8. Check: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/api/v1/health` is 200, then the logins / ticket / printing subset of cutover step 13.

`Uninstall-NativePOS.ps1` without `-StopOnly` deletes services and tasks but never `pgdata`, `backups`, `config` or `logs`.

## 6. Daily checks

`.\deploy\Health-Native.ps1 [-Prefix BilliardsPOS] [-WebPort 8080] [-StateDir C:\BilliardsPOS\state]` (elevated: `state` is not readable by Users)
prints `[OK]/[FAIL]/[SKIP]`
per check and exits 0 only if nothing failed: the four services Running, `GET /api/v1/health` through nginx = 200,
`state\last_success` younger than 26 h, system drive has at least 5 GB free. Also glance at the newest dump in `<Root>\backups`
and at the tail of `<Root>\logs\BilliardsPOS-S3Backup.log` (`OK:` vs `BACKUP FAILED:`).

## 7. Telegram bot: not installed

Not in use, so there is no service, venv, or env file for it and `telegram-bot\` is untouched. To add it later: build a venv
from `telegram-bot\requirements.txt`, write a `telegram.env` from `docker compose config`, and register one more NSSM service
`BilliardsPOS-Telegram` depending on `BilliardsPOS-Backend` (copy a `nssm set` block from `Install-NativePOS.ps1`).
This needs its own task and review.

## 8. Known differences and limits

Decisions for the owner (behaviour differs from Docker, documented rather than changed):

- **No worker watchdog.** Docker's gunicorn ran with `--timeout 120` and restarted a stalled worker. The native launcher
  (`serve_windows.py`, eventlet) has none: a stalled eventlet hub stays down, with the service still "Running", until
  `Restart-Service BilliardsPOS-Backend`. Adding one means new concurrency code on eventlet (it needs an unpatched OS thread), which was judged riskier than the gap.
- **`Health-Native.ps1` is not scheduled.** Run it daily during the soak period (section 6). A scheduled task that writes its result to a log can be added later.

Limits:

- The `pg_ctl` Postgres service may report a clean stop if the postmaster dies, so `sc failure` does not restart it;
  `Health-Native.ps1` (service Running check) is what detects it.
- A reinstall that fails half-way leaves the services stopped until the installer is re-run.
- `Restore-Native.ps1`: the interactive `RESTORE` confirmation prompt (when `-Force` is not given) is untested, and the
  safety dump excludes writes between the dump and the moment services stop (a few seconds).
- **The admin-only tests must be run elevated before merge** (they create real services/tasks/ACLs, so the non-elevated
  session that wrote this could not run them: 10 services/release/env-ACL tests are skipped there). From an elevated PowerShell in the repo root:

  ```powershell
  $env:POS_TEST_DUMP = '<path to a prod dump>'
  deploy\windows\.native-test\venv\Scripts\python.exe -m pytest deploy/windows/tests -m "admin" -v
  ```

  They use prefixes `BilliardsPOS-Test` and `BilliardsPOS-Rel`, ports 55433/55001/59081, and clean up after themselves.
  The first elevated run is also the first time the `icacls` plan and the offline release install actually execute.
- Not done here, needs separate approval: any action on the bar PC, uninstalling Rancher, the Telegram bot, de-duplicating the 08:00
  email, the duplicate print-agent start, `/inventory/stock-check` 500, default passwords in compose.

## 9. Verified

2026-11-08, dev PC, non-elevated shell, `POS_TEST_DUMP` set to a prod dump. Full suite before the final-review fixes (`-m "slow or not slow"`):
`95 passed, 10 skipped in 1387.97s (0:23:07)`. After the fixes (task logging, ACL/time-zone/dist/space guards, backup-s3 hardening,
log rotation) the affected modules were re-run (the long parity, print-parity and nginx-idle modules cover nothing that changed and were not):

```
deploy\windows\.native-test\venv\Scripts\python -m pytest deploy/windows/tests/test_services.py deploy/windows/tests/test_release.py
=============== 52 passed, 9 skipped in 160.47s (0:02:40) ===============
deploy\windows\.native-test\venv\Scripts\python -m pytest deploy/windows/tests/test_backup_s3.py test_backup_local.py test_env_export.py test_postgres.py
=============== 27 passed, 1 skipped in 85.65s (0:01:25) ===============
```

The 10 skipped are the `admin` tests (needs elevation, see section 8). The backend test does not import under the test
venv (no Flask), so it was run with the backend venv: `pytest backend/tests/test_email_date_label.py` gave `2 passed`.
Not verified here: the real service install (including the `icacls` ACL plan and the scheduled-task command lines as Task
Scheduler runs them: only their syntax was exercised by hand), restart/recovery behaviour, and the offline release install (all admin tests).
