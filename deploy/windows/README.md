# Billiard Bar POS: native Windows install (no Docker)

For the code owner and whoever does the bar cutover. This replaces the Docker stack (Rancher Desktop + compose) with
Windows services. App behaviour is unchanged; only how it is hosted changes. Nothing here has been run on the bar PC.

## 1. What runs where

Default prefix `BilliardsPOS`, install root `C:\BilliardsPOS` (called `<Root>` below).

| Piece | Name | Listens | Account | Logs |
|---|---|---|---|---|
| PostgreSQL 15 | service `BilliardsPOS-Postgres` | 127.0.0.1:**5433** | NT AUTHORITY\NetworkService | `<Root>\pgdata\log` (server log), `<Root>\pgdata\pos-init.log` (first init) |
| Backend (eventlet + Flask, `serve_windows.py`) | service `BilliardsPOS-Backend` | 127.0.0.1:**5000** | LocalSystem | `<Root>\logs\BilliardsPOS-Backend.log` |
| Scheduler | service `BilliardsPOS-Scheduler` | none | LocalSystem | `<Root>\logs\BilliardsPOS-Scheduler.log` |
| Web (nginx 1.27.5, serves `app\dist`, proxies `/api` and sockets) | service `BilliardsPOS-Web` | 0.0.0.0:**8080** | LocalSystem | `<Root>\logs\BilliardsPOS-Web.log`, nginx's own `<Root>\web\logs` |
| S3 backup, daily | scheduled task `BilliardsPOS-S3Backup` (02:00) | | SYSTEM | Task Scheduler history (`LastTaskResult`), marker `<Root>\state\last_success` |
| S3 backup, catch-up | scheduled task `BilliardsPOS-S3Backup-Catchup` (at startup +5 min, `-CatchUp`) | | SYSTEM | same, and `BACKUP FAILED` on failure |
| Local dump | scheduled task `BilliardsPOS-LocalBackup` (03:00, keeps 30 days) | | SYSTEM | dumps in `<Root>\backups` |
| Daily report | scheduled task `BilliardsPOS-DailyReport` (08:00), only if installed with `-DailyReportTask` | | SYSTEM | |

Dependencies: Backend and Scheduler need Postgres; Web needs Backend. All three NSSM services restart on exit after 5 s;
all four have `sc failure` recovery (restart 5 s, 5 s, 30 s). The backend keeps retrying until Postgres is up.
Layout under `<Root>`: `app` (backend, dist), `venv`, `bin` (pgsql, nginx, python, nssm.exe, aws), `config` (env files with
secrets, ACL SYSTEM + Administrators only), `pgdata`, `web`, `logs`, `state`, `backups`, `deploy` (these scripts).
The print agent is not part of this install: the backend talks to `http://127.0.0.1:9191` exactly as before.

Ports: the bar PC already has PostgreSQL 18 on 5432 (leave it alone) and Windows MultiPoint on 80, hence 5433 and 8080.

## 2. Build the release and install

Build on any Windows PC with git, internet, uv and (if `-DistDir` is not given) node. Commit first: the backend and the
scripts come from `git archive`.

```powershell
deploy\windows\New-NativeRelease.ps1 -OutDir D:\release\billiard-native -DistDir <dir with the frontend dist>
```

`-DistDir` at cutover: capture it BEFORE the cutover window, while the Docker stack is still running:
`docker cp <frontend container>:/usr/share/nginx/html <dir>` (find the container with `docker compose ps -q frontend`), so the
bar serves exactly the build it serves today. Without `-DistDir` the script runs `npm ci` and a vite build with
`VITE_API_URL=/api/v1 VITE_SOCKET_URL=/`. Binaries (PostgreSQL 15.19, nginx 1.27.5, CPython 3.11, NSSM 2.24, AWS CLI v2 msi)
are downloaded by the script or passed with `-PgDir -NginxDir -PythonDir -NssmExe -AwsMsi`. NSSM is never committed. The
wheelhouse is `pip download` of the lock (`python\requirements-backend.lock.txt`, the bar's exact `pip freeze` plus tzdata),
so the install needs no internet. A failed build deletes its partial `-OutDir`.

After copying the release folder to the bar PC (`<rel>`), verify it there with the release's own copy of the script:

```powershell
<rel>\deploy\New-NativeRelease.ps1 -VerifyDir <rel>      # exit 0 = every file matches SHA256SUMS.txt
```

Install (elevated PowerShell):

```powershell
<rel>\deploy\Install-NativePOS.ps1 -ReleaseDir <rel> -EnvDir C:\pos-env -Root C:\BilliardsPOS -DailyReportTask
<rel>\deploy\Install-NativePOS.ps1 -DryRun -ReleaseDir <rel> -EnvDir C:\pos-env      # prints every action, needs no elevation
```

`-DailyReportTask` keeps today's task-driven 08:00 report (`BilliardsPOS-DailyReport`); the scheduler's own 08:00 email is
unchanged either way. Add `-StartupType Manual` to install without auto-start.

The installer is idempotent (re-run it to upgrade: dist is replaced, services are re-registered). It never touches `pgdata`,
`backups`, `logs` or `state`, but it DOES overwrite `<Root>\config\backend.env`, `scheduler.env` and `backup.env` from
`-EnvDir` on every run. For an upgrade pass `-EnvDir C:\BilliardsPOS\config` (same folder: the copy is skipped and the live
secrets stay as they are). Once installed, delete `C:\pos-env`.

## 3. Cutover (bar PC, Docker to native)

Do this out of hours. `<Root>` = `C:\BilliardsPOS`, `<compose>` = the bar's compose folder
(`C:\Users\bola8lacalma\Desktop\POS\billiards`), `<rel>` = the release folder, `C:\cutover` = a scratch folder you create.
Commands are PowerShell; user `billiard` and database `billiardbar` are the compose defaults (check `<compose>\.env`).

> **Do NOT uninstall Rancher Desktop, run `docker system prune`, or run `docker compose down -v`.** The Docker volume
> is the rollback. While native runs, native nginx holds port 8080, so Docker and native cannot both be up
> (rollback stops native first).

Before the window: build the release with the dist captured from the running frontend (section 2), copy it to the bar, verify it.

1. **Env files, while Rancher/Docker is still running** (it asks `docker compose config`):
   `<rel>\deploy\Export-ComposeEnv.ps1 -ComposeDir <compose> -OutDir C:\pos-env -PgPort 5433`
   writes `backend.env`, `scheduler.env`, `backup.env` (the `TZ` line is stripped for backend and scheduler on purpose; the folder is ACL'd to SYSTEM + Administrators).
2. **Freeze writers.** In `<compose>`: `docker compose stop frontend backend scheduler telegram-bot backup` (Postgres keeps running).
3. **Final dump and check.**
   ```powershell
   New-Item -ItemType Directory -Force C:\cutover | Out-Null
   $c = docker compose ps -q postgres
   docker exec $c pg_dump -Fc -U billiard -d billiardbar -f /tmp/cutover.dump
   docker cp "${c}:/tmp/cutover.dump" C:\cutover\cutover.dump
   <rel>\bin\pgsql\bin\pg_restore.exe --list C:\cutover\cutover.dump | Select-Object -First 5     # must list TOC entries; check $LASTEXITCODE -eq 0
   ```
   Copy `C:\cutover\cutover.dump` OFF the machine (USB / another PC) before going on.
4. **Fingerprint the old DB** (the container publishes no port and host 5432 is the unrelated PG18, so go through the container):
   `Get-Content <rel>\deploy\sql\fingerprint.sql | docker exec -i $c psql -U billiard -d billiardbar -At | Out-File -Encoding utf8 C:\cutover\old.txt`
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
7. **Install** (section 2, with `-DailyReportTask`). The first run initialises the cluster from `backup.env`; services start with an empty database.
8. **Restore.**
   `<Root>\deploy\backup\Restore-Native.ps1 -EnvFile C:\pos-env\backup.env -PgBin <Root>\bin\pgsql\bin -DumpFile C:\cutover\cutover.dump -OutDir <Root>\backups -Force`
   (safety dump of the current DB first, stops the POS services, drops and recreates the DB, restores, leaves services stopped).
9. **Fingerprint the new DB and compare** (password = `POSTGRES_PASSWORD` in `C:\pos-env\backup.env`):
   ```powershell
   $env:PGPASSWORD = '<POSTGRES_PASSWORD>'
   <Root>\bin\pgsql\bin\psql.exe -h 127.0.0.1 -p 5433 -U billiard -d billiardbar -At -f <Root>\deploy\sql\fingerprint.sql | Out-File -Encoding utf8 C:\cutover\new.txt
   Compare-Object (Get-Content C:\cutover\old.txt) (Get-Content C:\cutover\new.txt)      # must print nothing
   Remove-Item Env:PGPASSWORD
   ```
   Any difference: stop and roll back.
10. **Start:** `Start-Service BilliardsPOS-Backend, BilliardsPOS-Scheduler, BilliardsPOS-Web` (Postgres is already running).
11. **S3 backup once by hand, before the health gate** (it writes the marker Health checks):
    `Start-ScheduledTask BilliardsPOS-S3Backup`; wait for it to finish (`Get-ScheduledTaskInfo BilliardsPOS-S3Backup`, `LastTaskResult` 0),
    confirm `<Root>\state\last_success` is fresh and the object is in the bucket.
12. **Checks, all must pass before the bar opens:**
    - `<Root>\deploy\Health-Native.ps1` exits 0 (all `[OK]`).
    - `<Root>\logs\BilliardsPOS-Backend.log` shows the migrations line `Migrations: 0 applied, 4 already present` (anything applied means the dump was not the final schema).
    - Staff logins work; open a table, add items, close a ticket, see it in reports.
    - Printing: a ticket receipt on `La Barra` and a comanda on `Cocina Comandas`.
    - Phones on the LAN (`http://192.168.1.24:8080`) and over Tailscale; the desktop app on `http://localhost:8080`.
13. **Reboot without anyone logging in.** After boot all four services are Running, `Health-Native.ps1` is green, a phone can open the app.

Keep `cutover.dump` (and the off-machine copy), `old.txt` and the Docker volume until the native install has run for a while.

## 4. Rollback (back to Docker)

Order matters: native Postgres must stay up until it has been dumped, and the Docker Postgres container must be up (app containers down) for the restore.

1. Stop the native app services (frees port 8080): `Stop-Service BilliardsPOS-Web, BilliardsPOS-Scheduler, BilliardsPOS-Backend`.
2. **Only if native took sales since cutover:** dump it while native Postgres is still running:
   `<Root>\deploy\backup\Backup-Native.ps1 -EnvFile <Root>\config\backup.env -PgBin <Root>\bin\pgsql\bin -OutDir <Root>\backups -Label rollback -KeepDays 0`
   (the last output line is the dump path).
3. `<Root>\deploy\Uninstall-NativePOS.ps1 -Prefix BilliardsPOS -StopOnly` (stops and disables services and tasks, keeps data).
4. Start Rancher Desktop, wait until `docker info` works, then in `<compose>`: `docker compose up -d postgres`.
5. **Only if step 2 was done:** `<repo>\scripts\deploy\Restore-Database.ps1 -DumpFile <dump from step 2> -ProjectDir <compose> -Force`
   (it stops the app containers and leaves them stopped). With no native sales, the Docker DB is already the frozen cutover state: skip.
6. `docker compose up -d`.
7. Re-enable the four tasks (`Enable-ScheduledTask -TaskName '<name>'`): `BilliardBarPOS-Start`, `BilliardBarPOS-Backup`,
   `PostgreSQL Docker Backup - BilliardBar`, `Billiards_Daily_Report`; and, as the bar's user, restore the Run key:
   `Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name RancherDesktop -Value (Get-Content C:\cutover\RancherDesktop.run.txt)`
   (or `reg import C:\cutover\run-key.reg`).
8. Check: `Invoke-WebRequest http://127.0.0.1:8080/api/v1/health` is 200, then the logins / ticket / printing subset of step 12.

`Uninstall-NativePOS.ps1` without `-StopOnly` deletes services and tasks but never `pgdata`, `backups`, `config` or `logs`.

## 5. Daily checks

`.\deploy\Health-Native.ps1 [-Prefix BilliardsPOS] [-WebPort 8080] [-StateDir C:\BilliardsPOS\state]` prints `[OK]/[FAIL]/[SKIP]`
per check and exits 0 only if nothing failed: the four services Running, `GET /api/v1/health` through nginx = 200,
`state\last_success` younger than 26 h, system drive has at least 5 GB free. Also glance at the newest dump in `<Root>\backups`.

## 6. Telegram bot: not installed

Not in use, so there is no service, venv, or env file for it and `telegram-bot\` is untouched. To add it later: build a venv
from `telegram-bot\requirements.txt`, write a `telegram.env` from `docker compose config`, and register one more NSSM service
`BilliardsPOS-Telegram` depending on `BilliardsPOS-Backend` (copy a `nssm set` block from `Install-NativePOS.ps1`).
This needs its own task and review.

## 7. Known limits

- The `pg_ctl` Postgres service may report a clean stop if the postmaster dies, so `sc failure` does not restart it;
  `Health-Native.ps1` (service Running check) is what detects it.
- A reinstall that fails half-way leaves the services stopped until the installer is re-run.
- `Restore-Native.ps1`: the interactive `RESTORE` confirmation prompt (when `-Force` is not given) is untested, and the
  safety dump excludes writes between the dump and the moment services stop (a few seconds).
- The admin-only tests (real services, offline release install) cannot run in a non-elevated session and must be run
  elevated before merge:

  ```powershell
  $env:POS_TEST_DUMP = '<path to a prod dump>'
  deploy\windows\.native-test\venv\Scripts\python -m pytest deploy/windows/tests -m "admin" -v
  ```

  (from an elevated shell in the repo root; they use prefixes `BilliardsPOS-Test` and `BilliardsPOS-Rel` and clean up after themselves).
- Not done here, needs separate approval: any action on the bar PC, uninstalling Rancher, the Telegram bot, de-duplicating the 08:00
  email, the duplicate print-agent start, `/inventory/stock-check` 500, default passwords in compose.

## 8. Verified

2026-11-08, dev PC, non-elevated shell, `POS_TEST_DUMP` set to a prod dump:

```
deploy\windows\.native-testvenv\Scripts\python -m pytest deploy/windows/tests -m "slow or not slow" -v
=============== 95 passed, 10 skipped in 1387.97s (0:23:07) ===============
```

The 10 skipped are the `admin` tests (needs elevation, see section 7). The backend test does not import under the test
venv (no Flask), so it was run with the backend venv: `pytest backend/tests/test_email_date_label.py` gave `2 passed`.
Not verified here: the real service install, restart/recovery behaviour, and the offline release install (all admin tests).
