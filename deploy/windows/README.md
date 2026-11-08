# Billiard Bar POS: native Windows install (no Docker)

For the code owner and whoever does the bar cutover. This replaces the Docker stack (Rancher Desktop + compose) with
Windows services. App behaviour is unchanged; only how it is hosted changes. Nothing here has been run on the bar PC.

## 1. What runs where

Default prefix `BilliardsPOS`, install root `C:\BilliardsPOS` (called `<Root>` below).

| Piece | Name | Listens | Account | Logs |
|---|---|---|---|---|
| PostgreSQL 15 | service `BilliardsPOS-Postgres` | 127.0.0.1:**5433** | NT AUTHORITY\NetworkService | Windows Event Log (source PostgreSQL), `<Root>\pgdata\pos-init.log` (first init) |
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

Build (any Windows PC with git, internet, uv and, if `-DistDir` is not given, node; commit first, the backend and
scripts come from `git archive`):

```powershell
deploy\windows\New-NativeRelease.ps1 -OutDir D:\release\billiard-native -DistDir <dir with the frontend dist>
deploy\windows\New-NativeRelease.ps1 -VerifyDir D:\release\billiard-native     # re-check SHA256SUMS.txt after copying
```

`-DistDir` at cutover: `docker cp <frontend container>:/usr/share/nginx/html <dir>` so the bar serves exactly what it
serves now. Without it the script runs `npm ci` and a vite build with `VITE_API_URL=/api/v1 VITE_SOCKET_URL=/`.
Binaries (PostgreSQL 15.19, nginx 1.27.5, CPython 3.11, NSSM 2.24, AWS CLI v2 msi) are downloaded by the script or passed
with `-PgDir -NginxDir -PythonDir -NssmExe -AwsMsi`. NSSM is never committed. The wheelhouse is `pip download` of the lock
(`python\requirements-backend.lock.txt`, the bar's exact `pip freeze` plus tzdata), so the install needs no internet.

Install (elevated PowerShell, from the copied release folder):

```powershell
# env files for the three components come from the Docker config, see cutover step 6
.\deploy\Install-NativePOS.ps1 -ReleaseDir . -EnvDir C:\pos-env -Root C:\BilliardsPOS      # add -DailyReportTask to keep the 08:00 task
.\deploy\Install-NativePOS.ps1 -DryRun -ReleaseDir . -EnvDir C:\pos-env                    # prints every action, needs no elevation
```

The installer is idempotent (re-run it to upgrade: dist is replaced, services are re-registered). Add `-StartupType Manual`
to install without auto-start. It never touches `pgdata`, `backups`, `config` contents or `logs`.

## 3. Cutover (bar PC, Docker to native)

Do this out of hours. Everything before step 8 is reversible by starting the Docker stack again. `<Root>` = `C:\BilliardsPOS`,
`<compose>` = the bar's compose folder (`C:\Users\bola8lacalma\Desktop\POS\billiards`), `<rel>` = the release folder.

1. **Freeze writers.** In `<compose>`: `docker compose stop frontend backend scheduler telegram-bot backup`. Postgres keeps running.
2. **Final dump.** `docker exec <db container> pg_dump -U billiard -Fc billiardbar -f /tmp/final.dump`, `docker cp` it out, then
   `pg_restore --list <dump>` must succeed and list the tables.
3. **Fingerprint the old DB.** `psql -At -f <rel>\deploy\sql\fingerprint.sql` against the container (127.0.0.1:5432 of the container
   mapping, or `docker exec -i ... psql -At < fingerprint.sql`). Save the output to a file.
4. `docker compose stop` (everything). Quit Rancher Desktop (`rdctl shutdown`) and remove its autostart:
   `Remove-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name RancherDesktop`.
5. **Disable (do not delete)** the four Docker-era scheduled tasks, they are the rollback path:
   `BilliardBarPOS-Start`, `BilliardBarPOS-Backup`, `PostgreSQL Docker Backup - BilliardBar`, `Billiards_Daily_Report`
   (`Disable-ScheduledTask -TaskName '<name>'` for each).
6. **Env files.** `.\deploy\Export-ComposeEnv.ps1 -ComposeDir <compose> -OutDir C:\pos-env -PgPort 5433` writes `backend.env`,
   `scheduler.env`, `backup.env` from what compose resolves (a `TZ` line is stripped for backend and scheduler on purpose).
7. **Install** (section 2). The first run initialises the cluster from `backup.env`. Services start with an empty database.
8. **Restore.** `.\deploy\backup\Restore-Native.ps1 -EnvFile C:\pos-env\backup.env -PgBin C:\BilliardsPOS\bin\pgsql\bin -DumpFile <final.dump> -OutDir C:\BilliardsPOS\backups`
   (it takes a safety dump of the current DB first, stops the POS services, drops and recreates the DB, restores, and leaves
   the services stopped).
9. **Fingerprint the new DB** with the same `fingerprint.sql` on port 5433. It must equal the step 3 output. If not, stop and roll back.
10. **Start:** `Start-Service BilliardsPOS-Backend, BilliardsPOS-Scheduler, BilliardsPOS-Web` (Postgres is already running).
11. **Checks, all must pass before the bar opens:**
    - `.\deploy\Health-Native.ps1` exits 0 (the S3 freshness check fails until step 12, that is expected).
    - Staff logins work; open a table, add items, close a ticket, see it in reports.
    - Printing: a ticket receipt on `La Barra` and a comanda on `Cocina Comandas`.
    - Phones on the LAN (`http://192.168.1.24:8080`) and over Tailscale; the desktop app on `http://localhost:8080`.
12. **S3 backup once by hand:** `Start-ScheduledTask BilliardsPOS-S3Backup`, then confirm `<Root>\state\last_success` is fresh and the object is in the bucket.
13. **Reboot without anyone logging in.** After boot, all four services are Running, `Health-Native.ps1` is green, a phone can open the app.

## 4. Rollback (back to Docker)

1. `.\deploy\Uninstall-NativePOS.ps1 -Prefix BilliardsPOS -StopOnly` (stops and disables services and tasks, keeps data).
2. If the native side took real sales since cutover: `.\deploy\backup\Backup-Native.ps1 -EnvFile C:\pos-env\backup.env -PgBin C:\BilliardsPOS\bin\pgsql\bin -OutDir C:\BilliardsPOS\backups -KeepDays 0`,
   then restore that dump into the Docker container with the existing `scripts\deploy\Restore-Database.ps1`.
3. Start Rancher Desktop, `docker compose up -d` in `<compose>`.
4. Re-enable the four tasks (`BilliardBarPOS-Start`, `BilliardBarPOS-Backup`, `PostgreSQL Docker Backup - BilliardBar`,
   `Billiards_Daily_Report`) and re-add the HKCU Run entry `RancherDesktop` (or start it once from its own settings).

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
deploy\windows\.native-testenv\Scripts\python -m pytest deploy/windows/tests -m "slow or not slow" -v
=============== 95 passed, 10 skipped in 1387.97s (0:23:07) ===============
```

The 10 skipped are the `admin` tests (needs elevation, see section 7). The backend test does not import under the test
venv (no Flask), so it was run with the backend venv: `pytest backend/tests/test_email_date_label.py` gave `2 passed`.
Not verified here: the real service install, restart/recovery behaviour, and the offline release install (all admin tests).
