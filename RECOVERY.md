# 🚨 Bola 8 POS — Crash Recovery & Operations Guide

**Project location:** `C:\Users\bola8lacalma\Desktop\POS\billiards`

---

## ⚡ Quick Reference — Most Common Commands

```powershell
# Start everything
docker compose up -d

# Stop everything
docker compose down

# Restart everything (fixes most issues)
docker compose down && docker compose up -d

# View live logs
docker compose logs -f

# Run health check
powershell -File scripts\health-check.ps1

# Backup database NOW
powershell -File scripts\backup-pos.ps1
```

---

## 🔄 System Restart (Normal)

Run from the project folder:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
docker compose down
docker compose up -d
```

Wait ~15 seconds, then verify:
```powershell
powershell -File scripts\health-check.ps1
```

---

## 💾 Database Backup

### Manual backup (run anytime):
```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards
powershell -File scripts\backup-pos.ps1
```

Backup files are saved to `backups\db_YYYYMMDD_HHMMSS.zip`.  
Last 7 days of backups are kept automatically.

### Restore from a backup:

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards

# 1. Unzip the backup
Expand-Archive backups\db_20260423_120000.zip -DestinationPath backups\restore_tmp

# 2. Copy the SQL file into the container
docker cp backups\restore_tmp\db_20260423_120000.sql billar-pos-postgres-1:/tmp/restore.sql

# 3. Restore (WARNING: this overwrites current data)
docker exec -i billar-pos-postgres-1 psql -U billiard -d billiardbar -f /tmp/restore.sql

pg_dump -U billiard -d billiardbar --encoding UTF8 -f backup.sql

# 4. Restart backend so it reconnects cleanly
docker compose restart backend

# 5. Clean up
Remove-Item backups\restore_tmp -Recurse -Force
```

# In Git Bash, WSL, or Cygwin terminal

iconv -f UTF-16LE -t UTF-8 billiardbar-2026-04-27_15-50-03.sql > new_file_utf8.sql     

docker exec -it billar-pos-postgres-1 psql -U billiard -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'billiardbar' AND pid <> pg_backend_pid();"  

docker exec -it billar-pos-postgres-1 psql -U billiard -d postgres -c "DROP DATABASE billiardbar;"  

docker exec -it billar-pos-postgres-1 psql -U billiard -d postgres -c "CREATE DATABASE billiardbar;"   

docker exec -i billar-pos-postgres-1 psql -U billiard -d billiardbar <  new_file_utf8.sql   



## 🚨 Crash Scenarios & Fixes

### Scenario 1 — App not loading (browser shows error)

```powershell
# Check if containers are running
docker ps

# If any are missing, restart all
docker compose up -d

# Check logs for errors
docker compose logs backend --tail 50
docker compose logs frontend --tail 20
```

### Scenario 2 — "Cannot connect to database" error

```powershell
# Check postgres is healthy
docker ps --filter name=postgres

# If postgres is restarting or stopped:
docker compose restart postgres
Start-Sleep -Seconds 10
docker compose restart backend

# Verify DB is accessible
docker exec -it billar-pos-postgres-1 psql -U billiard -d postgres -c "SELECT 'OK';"  
```

### Scenario 3 — Backend crashes / 500 errors everywhere

```powershell
# View recent backend errors
docker compose logs backend --tail 100

# Restart backend only (data is safe in postgres)
docker compose restart backend
Start-Sleep -Seconds 8

# Verify API responds
Invoke-WebRequest http://localhost:8080/api/v1/auth/login -Method POST `
  -Body '{"username":"manager","password":"manager123"}' `
  -ContentType "application/json"
```

### Scenario 4 — Computer restarted, system won't start

```powershell
cd C:\Users\bola8lacalma\Desktop\POS\billiards

# Check Docker Desktop is running (look in system tray)
# If not, start Docker Desktop and wait for it to fully load (~60 seconds)

# Then start containers
docker compose up -d

# Check status
docker ps
```

### Scenario 5 — Open cash session stuck / can't close bar

```powershell
# Run ghost cleanup via API (manager credentials required)
$r = Invoke-RestMethod "http://localhost:8080/api/v1/auth/login" -Method POST `
     -Body '{"username":"manager","password":"manager123"}' `
     -ContentType "application/json"
$h = @{ Authorization = "Bearer $($r.access_token)" }

# Clean ghost tickets
Invoke-RestMethod "http://localhost:8080/api/v1/tickets/clean-ghosts" `
  -Method POST -Headers $h `
  -Body '{"reason":"crash recovery cleanup"}' -ContentType "application/json"

# See remaining open tickets
Invoke-RestMethod "http://localhost:8080/api/v1/tickets/open-all" -Headers $h
```

### Scenario 6 — Disk full / Docker out of space

```powershell
# Remove unused Docker images and containers
docker system prune -f

# Remove old backups older than 3 days (if disk is critically low)
Get-ChildItem C:\Users\bola8lacalma\Desktop\POS\billiards\backups\db_*.zip |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } |
  Remove-Item -Force
```

---

## 🗄️ Database Integrity Checks

Run these manually if you suspect data corruption:

```powershell
# Quick check — connect and run integrity queries
docker exec -i billar-pos-postgres-1 psql -U billiard -d billiardbar << 'SQL'
-- Table count (expect 12+)
SELECT count(*) AS table_count FROM information_schema.tables WHERE table_schema='public';

-- Ghost tickets (open ticket on available resource)
SELECT t.id, t.status, r.code, r.status AS resource_status
FROM tickets t JOIN resources r ON r.id = t.resource_id
WHERE t.status='OPEN' AND r.status='AVAILABLE';

-- Orphaned timers (running timer on non-open ticket)
SELECT ts.id, ts.start_time, t.status AS ticket_status
FROM timer_sessions ts JOIN tickets t ON t.id = ts.ticket_id
WHERE ts.end_time IS NULL AND t.status != 'OPEN';

-- Duplicate open sessions on same resource
SELECT resource_id, count(*) AS cnt
FROM tickets WHERE status='OPEN'
GROUP BY resource_id HAVING count(*) > 1;

-- Cash session status
SELECT id, status, opened_at, closed_at FROM cash_sessions ORDER BY opened_at DESC LIMIT 5;
SQL
```

**PowerShell version (Windows):**
```powershell
docker exec -i billar-pos-postgres-1 psql -U billiard -d billiardbar -c "SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='public';" -c "SELECT count(*) AS ghost_tickets FROM tickets t JOIN resources r ON r.id=t.resource_id WHERE t.status='OPEN' AND r.status='AVAILABLE';" -c "SELECT count(*) AS orphan_timers FROM timer_sessions WHERE end_time IS NULL AND ticket_id NOT IN (SELECT id FROM tickets WHERE status='OPEN');"
```

---

## 📋 Automated Daily Backup (Task Scheduler)

To schedule automatic nightly backups at 3:00 AM:

```powershell
# Run once as Administrator
$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
              -Argument "-NonInteractive -File C:\Users\bola8lacalma\Desktop\POS\billiards\scripts\backup-pos.ps1 -Quiet"
$trigger  = New-ScheduledTaskTrigger -Daily -At "03:00"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName "Bola8POS_DailyBackup" `
  -Action $action -Trigger $trigger -Settings $settings `
  -RunLevel Highest -Force

Write-Host "Daily backup scheduled at 3:00 AM" -ForegroundColor Green
```

---

## 📞 Contacts & Info

| Item | Value |
|------|-------|
| App URL | http://localhost:8080 |
| API health | http://localhost:8080/api/v1/auth/login |
| DB name | billiardbar |
| DB user | billiard |
| Backups folder | `billiards\backups\` |
| Print agent port | 9191 (localhost only) |

---

## ✅ System Healthy Checklist

After any restart, confirm:
- [ ] `docker ps` shows 3 containers all **Up**
- [ ] http://localhost:8080 loads the login screen
- [ ] Login works with manager credentials
- [ ] Floor map shows tables
- [ ] `health-check.ps1` shows all green

---

## Root Cause & Structural Fix — Ghost Tickets (Phase 4 / DATA-02)

### Investigation

A ghost ticket is an `OPEN` ticket whose `resource_id` points at a resource
that is `AVAILABLE` (i.e. the floor map shows the table as free while the
ticket underneath it is still open) — see the "Ghost tickets" integrity
query above. Every currently-shipped code path in
`backend/app/api/tickets.py` and `backend/app/api/waiting_list.py` that
sets a resource's `status` to `'AVAILABLE'` was audited:

- `open_ticket` — creates the ticket, sets the resource to `IN_USE`, and
  creates the pool timer, all inside one `db.session.commit()`. Never frees
  a resource, not relevant to this invariant.
- `close_ticket` — frees the resource to `AVAILABLE` and sets
  `ticket.status = 'CLOSED'` in the same commit.
- `cancel_ticket` — same pattern; `ticket.status` becomes `CANCELLED` in the
  same commit the resource is freed.
- `void_timer` — frees the resource **and** always clears
  `ticket.resource_id` to `None` in the same commit, specifically to avoid
  leaving an OPEN ticket pointed at a freed resource.
- `reopen_ticket` — sets the resource back to `IN_USE` in the same commit as
  `ticket.status = 'OPEN'` (the inverse direction; doesn't free anything).
- `waiting_list.py`'s `_cancel_seated_ticket` and `transfer_to_pool` — both
  also change the linked ticket's status/resource_id in the same commit
  that frees a resource.
- `request_payment` — **the one intentional, legitimate exception.** Frees
  a pool table to `AVAILABLE` while the ticket stays `OPEN`, because the
  guest asked for the check while still seated. This is safe because
  `ticket.payment_requested` is set to `True` in the exact same commit, and
  `clean_ghost_tickets()`'s existing `WHERE` clause already excludes any
  ticket with `payment_requested IS TRUE` from being treated as a ghost.

**Conclusion:** ghost tickets are not caused by a non-atomic write in the
currently-shipped application code — every code path that frees a resource
does so atomically, in the same transaction as the corresponding
ticket-state change. The historical ghost tickets seen in production are
most plausibly explained by process crashes/restarts interrupting an
in-flight request between separate statements pre-dating this atomic
pattern, or by direct manual DB intervention during past incident recovery
— not a reproducible bug in the code as it stands today.

### Structural Fix (STEP 27, `backend/app/__init__.py`)

Because "audited and looks atomic today" is not the same guarantee as
"structurally impossible to violate in the future," `flask init-db`'s STEP
27 now installs `fn_check_ticket_resource_consistency()` plus two deferred
constraint triggers — `trg_ticket_resource_consistency` (on `tickets`,
`AFTER INSERT OR UPDATE`) and `trg_resource_ticket_consistency` (on
`resources`, `AFTER UPDATE`) — both declared `DEFERRABLE INITIALLY
DEFERRED`, meaning Postgres only evaluates them once at transaction
`COMMIT` time, never mid-transaction. If a future code change ever commits
a transaction leaving an `OPEN` ticket pointing at an `AVAILABLE` resource
without `payment_requested = TRUE`, the `COMMIT` itself raises a Postgres
exception containing the literal text `ghost-ticket invariant violated`
plus the violating row count — surfacing immediately in the backend log at
the point of the offending commit, rather than silently corrupting state
that's only discovered later via the integrity-check queries above. The
two-trigger design (one on each table) closes the theoretical gap where a
future transaction updates only the `resources` table without touching
`tickets` at all.

This is enforced at the database level, independent of the application
layer — it is a structural backstop against regression, not a
replacement for careful code review of new ticket/resource-mutating paths.

### Residual Risk (accepted, not fixable at this layer)

Per DATA-02's "fixed if feasible... otherwise explicitly flagged"
allowance: the only way to still corrupt this invariant is a **direct SQL
write to the database that bypasses the application entirely, combined
with `session_replication_role = replica`** (a Postgres superuser-only
session setting that disables all triggers, including these two). Postgres
on this deployment is only reachable from the local machine (native
Windows service, not exposed externally per Phase 2's SVC-02), and
triggering this bypass requires superuser access — this residual risk is
accepted, not fixed, and is out of scope for this phase's network
boundary.

### What did NOT change

`clean_ghost_tickets()` and its `was_reopened` guard (the F-1 fix) are
**unchanged** and remain the operator-run recovery path for any ghost
ticket that does occur, per D-06: **no automated cleanup was added or
scheduled against any database, staging or production**, by this plan.
STEP 27 adds prevention (a structural invariant enforced going forward); it
does not replace or automate the existing manual recovery tooling
described earlier in this document.
