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
