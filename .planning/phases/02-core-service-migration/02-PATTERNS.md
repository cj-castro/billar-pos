# Phase 2: Core Service Migration - Pattern Map

**Mapped:** 2026-08-08
**Files analyzed:** 9 files (5 new scripts, 4 existing services)
**Analogs found:** 8 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/install-nssm-backend.ps1` | deployment script | file-I/O | `scripts/install-nssm-print-agent.ps1` | exact |
| `scripts/install-nssm-scheduler.ps1` | deployment script | file-I/O | `scripts/install-nssm-print-agent.ps1` | exact |
| `scripts/install-nssm-telegram-bot.ps1` | deployment script | file-I/O | `scripts/install-nssm-print-agent.ps1` | exact |
| `scripts/install-nssm-nginx.ps1` | deployment script | file-I/O | `scripts/install-nssm-print-agent.ps1` | role-match (binary service, not Python) |
| `scripts/postgres-backup-restore.ps1` | utility script | file-I/O | docker-compose.yml env refs | partial (no exact analog in codebase) |
| `backend/wsgi.py` | service entrypoint | request-response | self (existing) | exact |
| `backend/scheduler.py` | service entrypoint | event-driven/batch | self (existing) | exact |
| `telegram-bot/bot.py` | service entrypoint | event-driven | self (existing) | exact |
| `frontend/nginx.conf` | config | request-response (proxy) | self (existing) | exact |

---

## Pattern Assignments

### `scripts/install-nssm-backend.ps1` (deployment script, file-I/O)

**Analog:** `scripts/install-nssm-print-agent.ps1` (lines 1-185)

**Template structure** (adapt print agent pattern):
```powershell
# Reference: scripts/install-nssm-print-agent.ps1 lines 1-32 (header and setup)
#Requires -RunAsAdministrator

$BaseDir   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendDir = Join-Path $BaseDir "backend"
$VenvPy    = Join-Path $BackendDir "venv\Scripts\pythonw.exe"  # pythonw = no console window
$Script    = Join-Path $BackendDir "wsgi.py"
$ServiceName = "BilliardBarBackend"
$NssmExe   = $null

Write-Host "`n=== BilliardBar Backend - Windows Service Installer ===" -ForegroundColor Cyan
```

**NSSM LOCATE pattern** (lines 36-79):
```powershell
# Find or install NSSM (identical to print-agent pattern)
Write-Host "[1/6] Locating NSSM..."
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                  "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                  "$BaseDir\scripts\nssm.exe")) {
    try {
        $v = & $p version 2>&1
        if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
    } catch {}
}

if (-not $NssmExe) {
    Write-Host "   Trying to install via Chocolatey..." -ForegroundColor Yellow
    try {
        & choco install nssm -y --no-progress 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $NssmExe = "nssm" }
    } catch {}
    
    if (-not $NssmExe) {
        Write-Host "   Downloading NSSM directly..." -ForegroundColor Yellow
        $nssmZip  = "$env:TEMP\nssm.zip"
        $nssmDir  = "$env:TEMP\nssm_extract"
        $nssmDest = "$BaseDir\scripts\nssm.exe"
        try {
            Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" `
                -OutFile $nssmZip -UseBasicParsing -TimeoutSec 30
            Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force
            $exe = Get-ChildItem -Path $nssmDir -Recurse -Filter "nssm.exe" |
                   Where-Object { $_.FullName -match 'win64' } |
                   Select-Object -First 1
            Copy-Item $exe.FullName -Destination $nssmDest -Force
            $NssmExe = $nssmDest
        } catch {
            Write-Host "   Failed to download NSSM: $_" -ForegroundColor Red
            exit 1
        }
    }
}
Write-Host "   NSSM found: $NssmExe" -ForegroundColor Green
```

**Python virtualenv setup** (lines 82-101):
```powershell
# IDENTICAL PATTERN for backend
Write-Host "`n[2/6] Checking Python environment..."
$python = $null
foreach ($p in @("python", "python3", "py")) {
    try {
        $v = & $p --version 2>&1
        if ($LASTEXITCODE -eq 0) { $python = $p; break }
    } catch {}
}
if (-not $python) {
    Write-Host "   Python not found. Run: winget install Python.Python.3.11" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $VenvPy)) {
    Write-Host "   Creating virtualenv..." -ForegroundColor Yellow
    & $python -m venv "$BackendDir\venv"
}
Write-Host "   Installing packages..." -ForegroundColor Yellow
& "$BackendDir\venv\Scripts\pip.exe" install -r "$BackendDir\requirements.txt" --quiet --upgrade
```

**Service registration** (lines 114-141):
```powershell
# Register the NSSM service (adapted from print-agent pattern)
Write-Host "`n[3/6] Registering Windows Service..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Stopping existing service..." -ForegroundColor Yellow
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

# Install service
& $NssmExe install $ServiceName $VenvPy $Script
& $NssmExe set $ServiceName AppDirectory $BackendDir
& $NssmExe set $ServiceName AppStdout    (Join-Path $BackendDir "backend.log")
& $NssmExe set $ServiceName AppStderr    (Join-Path $BackendDir "backend_err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760  # 10 MB
& $NssmExe set $ServiceName Start SERVICE_AUTO_START
& $NssmExe set $ServiceName ObjectName LocalSystem
```

**Environment variables from docker-compose.yml** (backend section, lines 28-56):
```powershell
# Extract from docker-compose.yml backend.environment block
# Set via NSSM AppEnvironmentExtra (from docker-compose.yml lines 28-56)
$envExtra = @(
    "DATABASE_URL=postgresql://billiard:billiard_secret@localhost:5432/billiardbar",
    "PRINT_AGENT_URL=http://localhost:9191",  # CRITICAL: Changed from host.docker.internal:9191
    "SECRET_KEY=dev-secret-key-change-in-production",
    "JWT_REFRESH_SECRET=dev-refresh-secret-change-in-production",
    "BILLING_MODE=PER_MINUTE",
    "POOL_RATE_CENTS=150",
    "HAPPY_HOUR_START=17:00",
    "HAPPY_HOUR_END=20:00",
    "HAPPY_HOUR_DISCOUNT_PCT=20",
    "CURRENCY=MXN",
    "TZ=America/Mexico_City",
    "LOG_LEVEL=INFO",
    "FLASK_ENV=production",
    "FLASK_APP=wsgi.py",
    "ADMIN_PASSWORD=admin123",
    "ADMIN_PIN=1234",
    "MANAGER_PASSWORD=manager123",
    "MANAGER_PIN=5678",
    "WAITER1_PASSWORD=waiter123",
    "WAITER2_PASSWORD=waiter123",
    "KITCHEN_PASSWORD=kitchen123",
    "BARSTAFF_PASSWORD=bar123",
    "SMTP_HOST=smtp.gmail.com",
    "SMTP_PORT=587",
    "SMTP_USER=",
    "SMTP_PASSWORD=",
    "REPORT_FROM=bola.8gdl@gmail.com",
    "REPORT_TO=bola.8gdl@gmail.com,isc.castro@gmail.com"
)
& $NssmExe set $ServiceName AppEnvironmentExtra $envExtra
```

**Restart policy** (lines 138-139):
```powershell
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000  # 5s delay before restart
```

**Health check and startup verification** (lines 155-176):
```powershell
# Start and verify (similar to print-agent but use Flask health endpoint)
Write-Host "`n[4/6] Starting service..."
& $NssmExe start $ServiceName
Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "   Service is RUNNING [OK]" -ForegroundColor Green
} else {
    Write-Host "   Service status: $($svc.Status)" -ForegroundColor Yellow
    Write-Host "   Check log: $BackendDir\backend_err.log" -ForegroundColor Yellow
}

# Health check: Flask endpoint (wait up to 10s for backend to be ready)
Write-Host "`n[5/6] Testing connectivity..."
$maxRetries = 10
$retry = 0
while ($retry -lt $maxRetries) {
    try {
        $r = Invoke-RestMethod -Uri "http://localhost:5000/api/v1/auth/me" -TimeoutSec 3
        Write-Host "   API is responding [OK]" -ForegroundColor Green
        break
    } catch {
        $retry++
        if ($retry -lt $maxRetries) {
            Write-Host "   Waiting for API to be ready... ($retry/$maxRetries)" -ForegroundColor Yellow
            Start-Sleep -Seconds 1
        }
    }
}
if ($retry -eq $maxRetries) {
    Write-Host "   Warning: API did not respond in time. Check backend_err.log" -ForegroundColor Yellow
}
```

**Summary** (lines 178-185):
```powershell
Write-Host "`n=== Backend Service Installed ===" -ForegroundColor Cyan
Write-Host "Service management commands:"
Write-Host "   Start:   nssm start $ServiceName"
Write-Host "   Stop:    nssm stop $ServiceName"
Write-Host "   Restart: nssm restart $ServiceName"
Write-Host "   Logs:    $BackendDir\backend.log / backend_err.log"
Write-Host "   Status:  Get-Service $ServiceName"
```

---

### `scripts/install-nssm-scheduler.ps1` (deployment script, file-I/O)

**Analog:** `scripts/install-nssm-print-agent.ps1`

**Key differences from backend:**
- Script path: `backend/scheduler.py` (instead of `backend/wsgi.py`)
- Entrypoint: `python.exe` in the NSSM `install` command (not `pythonw.exe` for console output for logging)
- Environment variables: Smaller set from docker-compose.yml scheduler section (lines 91-101) — omit billing/pricing vars, keep SMTP/TZ/DB

```powershell
# Key config differences:
$Script = Join-Path $BackendDir "scheduler.py"  # Different script
$ServiceName = "BilliardBarScheduler"

# Use python.exe (not pythonw.exe) so scheduler output goes to log file
$VenvPy = Join-Path $BackendDir "venv\Scripts\python.exe"

# Smaller env var set (from docker-compose.yml scheduler section)
$envExtra = @(
    "DATABASE_URL=postgresql://billiard:billiard_secret@localhost:5432/billiardbar",
    "SECRET_KEY=dev-secret-key-change-in-production",
    "TZ=America/Mexico_City",
    "FLASK_APP=wsgi.py",
    "SMTP_HOST=smtp.gmail.com",
    "SMTP_PORT=587",
    "SMTP_USER=",
    "SMTP_PASSWORD=",
    "REPORT_FROM=bola.8gdl@gmail.com",
    "REPORT_TO=bola.8gdl@gmail.com,isc.castro@gmail.com"
)
```

**Health check:** Scheduler runs indefinitely on BlockingScheduler (no port to test); skip HTTP health check. Just verify service status.

---

### `scripts/install-nssm-telegram-bot.ps1` (deployment script, file-I/O)

**Analog:** `scripts/install-nssm-print-agent.ps1`

**Key differences from backend:**
- Script path: `telegram-bot/bot.py`
- Virtualenv location: `telegram-bot/venv` (separate from backend)
- Requirements file: `telegram-bot/requirements.txt` (separate)
- Environment variables: From docker-compose.yml telegram-bot section (lines 113-118)

```powershell
# Key config differences:
$BotDir = Join-Path $BaseDir "telegram-bot"
$VenvPy = Join-Path $BotDir "venv\Scripts\python.exe"  # Console output for logging
$Script = Join-Path $BotDir "bot.py"
$ServiceName = "BilliardBarTelegramBot"

# Smaller env var set for telegram-bot
$envExtra = @(
    "TELEGRAM_TOKEN=",  # Will be set from actual secret in production
    "ADMIN_CHAT_ID=",   # Will be set from actual ID
    "DATABASE_URL=postgresql://billiard:billiard_secret@localhost:5432/billiardbar"
)

# Install from telegram-bot requirements.txt
& "$BotDir\venv\Scripts\pip.exe" install -r "$BotDir\requirements.txt" --quiet --upgrade
```

**Health check:** Like scheduler, runs indefinitely on event loop. Just verify service status and check logs.

---

### `scripts/install-nssm-nginx.ps1` (deployment script, file-I/O)

**Analog:** `scripts/install-nssm-print-agent.ps1` (service registration pattern; no Python venv needed)

**Key differences:**
- No Python virtualenv (nginx is a standalone binary)
- NSSM install command: `nssm install ServiceName C:\nginx\nginx.exe`
- Download and extract nginx binary from nginx.org instead of using pip
- Copy `frontend/nginx.conf` to `C:\nginx\conf\nginx.conf`
- Copy built frontend files (`frontend/dist/*`) to `C:\nginx\html/`

```powershell
$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NginxDir = "C:\nginx"  # Or use environment-configurable path
$ServiceName = "BilliardBarNginx"

# Step 1: Download nginx Windows binary
Write-Host "[1/5] Downloading nginx..."
$nginxZip = "$env:TEMP\nginx.zip"
try {
    Invoke-WebRequest -Uri "https://nginx.org/download/nginx-1.24.0.zip" `
        -OutFile $nginxZip -UseBasicParsing -TimeoutSec 30
    Expand-Archive -Path $nginxZip -DestinationPath $NginxDir -Force
    Write-Host "   nginx extracted to $NginxDir" -ForegroundColor Green
} catch {
    Write-Host "   Failed to download nginx: $_" -ForegroundColor Red
    exit 1
}

# Step 2: Copy frontend/nginx.conf → C:\nginx\conf\nginx.conf
#         (Edit proxy_pass lines: http://backend:5000 → http://localhost:5000)
Write-Host "[2/5] Configuring nginx..."
$nginxConfDest = Join-Path $NginxDir "conf\nginx.conf"
Copy-Item "$BaseDir\frontend\nginx.conf" -Destination $nginxConfDest -Force

# Step 3: Copy built frontend files → C:\nginx\html/
Write-Host "[3/5] Copying frontend files..."
$htmlDest = Join-Path $NginxDir "html"
if (Test-Path "$BaseDir\frontend\dist") {
    Copy-Item "$BaseDir\frontend\dist\*" -Destination $htmlDest -Recurse -Force
} else {
    Write-Host "   Warning: frontend/dist not found. Build frontend first: cd frontend && npm run build" -ForegroundColor Yellow
}

# Step 4: Register NSSM service
Write-Host "[4/5] Registering Windows Service..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

& $NssmExe install $ServiceName "$NginxDir\nginx.exe"
& $NssmExe set $ServiceName AppDirectory $NginxDir
& $NssmExe set $ServiceName AppStdout (Join-Path $NginxDir "nginx.log")
& $NssmExe set $ServiceName AppStderr (Join-Path $NginxDir "nginx_err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760
& $NssmExe set $ServiceName Start SERVICE_AUTO_START

# Step 5: Start and verify
Write-Host "[5/5] Starting service..."
& $NssmExe start $ServiceName
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "   Service is RUNNING [OK]" -ForegroundColor Green
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8080/" -TimeoutSec 3
        Write-Host "   Frontend is responding [OK]" -ForegroundColor Green
    } catch {
        Write-Host "   Frontend not responding yet. Wait 10s and check: http://localhost:8080/" -ForegroundColor Yellow
    }
}
```

---

### `scripts/postgres-backup-restore.ps1` (utility script, file-I/O)

**Analog:** None existing in codebase; based on docker-compose.yml and RESEARCH.md patterns

**Pattern 1: Backup from Docker Postgres** (based on RESEARCH.md lines 414-419):
```powershell
# Backup Postgres from Docker container
function Backup-DockerPostgres {
    param(
        [string]$DockerContainerName = "billar-pos-postgres",
        [string]$OutputFile = "C:\backups\billiardbar_backup.dump",
        [string]$PostgresUser = "billiard",
        [string]$PostgresDb = "billiardbar"
    )
    
    Write-Host "Backing up Postgres from Docker container '$DockerContainerName'..."
    
    # Ensure output directory exists
    $OutputDir = Split-Path -Parent $OutputFile
    if (-not (Test-Path $OutputDir)) {
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    }
    
    try {
        & docker exec $DockerContainerName pg_dump -U $PostgresUser -d $PostgresDb -Fc | Out-File -Encoding Byte $OutputFile
        
        # Verify backup file size
        $fileInfo = Get-Item $OutputFile -ErrorAction SilentlyContinue
        if ($fileInfo -and $fileInfo.Length -gt 0) {
            Write-Host "   Backup saved: $OutputFile (size: $($fileInfo.Length / 1MB)MB)" -ForegroundColor Green
            return $true
        } else {
            Write-Host "   Backup file is empty or missing" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "   Backup failed: $_" -ForegroundColor Red
        return $false
    }
}
```

**Pattern 2: Restore to native Windows Postgres** (based on RESEARCH.md lines 424-433):
```powershell
# Restore Postgres dump to native Windows Postgres 15
function Restore-WindowsPostgres {
    param(
        [string]$DumpFile = "C:\backups\billiardbar_backup.dump",
        [string]$PostgresUser = "postgres",
        [string]$TargetUser = "billiard",
        [string]$TargetDb = "billiardbar",
        [string]$PostgresPassword = "",
        [string]$PostgresPath = "C:\Program Files\PostgreSQL\15\bin"
    )
    
    Write-Host "Restoring Postgres from dump..."
    
    if (-not (Test-Path $DumpFile)) {
        Write-Host "   Error: Dump file not found: $DumpFile" -ForegroundColor Red
        return $false
    }
    
    # Set password env var for restore
    $env:PGPASSWORD = $PostgresPassword
    
    try {
        # Restore (custom format with --no-acl --no-owner to avoid permission issues)
        & "$PostgresPath\pg_restore.exe" `
            -U $PostgresUser `
            -d $TargetDb `
            -h localhost `
            --no-acl --no-owner `
            -v `
            $DumpFile
        
        Write-Host "   Restore completed" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "   Restore failed: $_" -ForegroundColor Red
        return $false
    } finally {
        $env:PGPASSWORD = ""  # Clear password from env
    }
}
```

**Pattern 3: Verify data integrity** (based on RESEARCH.md lines 438-445):
```powershell
# Verify restored database has expected tables and data
function Verify-DatabaseRestore {
    param(
        [string]$TargetUser = "billiard",
        [string]$TargetDb = "billiardbar",
        [string]$Password = "",
        [string]$PostgresPath = "C:\Program Files\PostgreSQL\15\bin"
    )
    
    Write-Host "Verifying data integrity..."
    
    $env:PGPASSWORD = $Password
    
    try {
        # Query table counts
        $result = & "$PostgresPath\psql.exe" `
            -U $TargetUser `
            -d $TargetDb `
            -h localhost `
            -c "SELECT COUNT(*) FROM tickets; SELECT COUNT(*) FROM kitchen_queue; SELECT COUNT(*) FROM menu_items;"
        
        Write-Host "   Database verification output:" -ForegroundColor Green
        Write-Host "   $result" -ForegroundColor Gray
        return $true
    } catch {
        Write-Host "   Verification failed: $_" -ForegroundColor Red
        return $false
    } finally {
        $env:PGPASSWORD = ""
    }
}
```

---

### `backend/wsgi.py` (service entrypoint, request-response)

**Analog:** Self (existing file, lines 1-7)

**Current code (already correct for Windows native):**
```python
from app import create_app
app = create_app()

if __name__ == '__main__':
    from app.extensions import socketio
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
```

**Key pattern:**
- Uses `socketio.run()` with eventlet (built-in to Flask-SocketIO when eventlet is in requirements.txt)
- Binds to `0.0.0.0:5000` (accessible via localhost from nginx)
- No gunicorn (would not work on Windows)
- No `debug=True` for production

**Verification before NSSM install (from RESEARCH.md lines 769-801):**
```powershell
# Manual test from PowerShell (before NSSM install):
cd C:\billar-pos
python -m venv backend\venv
backend\venv\Scripts\pip.exe install -r backend\requirements.txt --quiet
backend\venv\Scripts\python.exe backend\wsgi.py
# Expected output: "(12345) wsgi running on http://0.0.0.0:5000"
```

---

### `backend/scheduler.py` (service entrypoint, event-driven/batch)

**Analog:** Self (existing file, lines 1-51)

**Current code (already correct for Windows native):**
```python
import logging
import sys
from zoneinfo import ZoneInfo
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format='%(asctime)s [scheduler] %(levelname)s %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger(__name__)

from app import create_app  # Import after logging setup

flask_app = create_app()

def send_report():
    with flask_app.app_context():
        try:
            from app.services.email_report_svc import generate_and_send_report
            generate_and_send_report()
        except Exception:
            log.exception("Daily report failed")

scheduler = BlockingScheduler(timezone=ZoneInfo('America/Mexico_City'))
scheduler.add_job(
    send_report,
    CronTrigger(hour=8, minute=0, timezone=ZoneInfo('America/Mexico_City')),
    id='daily_report',
    replace_existing=True,
)

log.info("Scheduler ready — daily report fires at 08:00 America/Mexico_City")

try:
    scheduler.start()
except (KeyboardInterrupt, SystemExit):
    log.info("Scheduler stopped")
```

**Key pattern:**
- `BlockingScheduler` (appropriate for standalone service; no Flask app running concurrently)
- APScheduler CronTrigger with `America/Mexico_City` timezone (matches business timezone)
- Logs to stdout (NSSM captures to AppStdout log file)
- Handles graceful shutdown via KeyboardInterrupt
- Uses Flask app context for DB access (same pattern as Docker scheduler)

**No changes needed** — this file runs on Windows as-is.

---

### `telegram-bot/bot.py` (service entrypoint, event-driven)

**Analog:** Self (existing file, lines 1-795)

**Current code structure (already correct for Windows native):**
```python
import os
import logging
from sqlalchemy import create_engine, text
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# Environment variables from NSSM AppEnvironmentExtra
TOKEN = os.environ.get("TELEGRAM_TOKEN")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID")
DATABASE_URL = os.environ.get("DATABASE_URL")

if not TOKEN or not ADMIN_CHAT_ID or not DATABASE_URL:
    raise ValueError("Missing required env vars")

# SQLAlchemy engine (direct DB access, no Flask app context)
engine = create_engine(DATABASE_URL)

# ... (command handlers: /daily, /staff, /stock, etc.)

def main():
    app = Application.builder().token(TOKEN).build()
    
    # Register handlers
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("daily", daily_sales))
    # ... more handlers
    
    # Scheduled jobs (AsyncIOScheduler)
    scheduler = AsyncIOScheduler()
    scheduler.add_job(send_auto_report, "cron", hour=9, minute=0, args=[app])
    scheduler.add_job(send_weekly_report, "cron", day_of_week="mon", hour=8, minute=0, args=[app])
    scheduler.start()
    
    logging.info("🤖 Telegram Bot is running...")
    app.run_polling()

if __name__ == "__main__":
    main()
```

**Key pattern:**
- Direct SQLAlchemy engine (no Flask app context needed)
- Reads `TELEGRAM_TOKEN`, `ADMIN_CHAT_ID` from env vars (set via NSSM AppEnvironmentExtra)
- AsyncIOScheduler for embedded job scheduling (separate from APScheduler BlockingScheduler used in scheduler.py)
- `app.run_polling()` blocks forever (NSSM will restart if it exits)
- Logs to stdout (NSSM captures to log file)

**No changes needed** — this file runs on Windows as-is.

---

### `frontend/nginx.conf` (config, request-response/proxy)

**Analog:** Self (existing file, lines 1-45)

**Current Docker config:**
```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    
    # ... cache headers, static routes ...
    
    location /api/ {
        proxy_pass http://backend:5000;  # ← CHANGE TO: http://localhost:5000
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60;
    }
    
    location /socket.io/ {
        proxy_pass http://backend:5000;  # ← CHANGE TO: http://localhost:5000
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

**Windows native modifications:**
```nginx
server {
    listen 8080;  # Or change to 80 if port 8080 is not desired on staging
    root C:\nginx\html;  # Windows path to built frontend files
    index index.html;
    
    # ... all cache headers and static routes remain UNCHANGED ...
    
    location /api/ {
        proxy_pass http://localhost:5000;  # Changed from http://backend:5000
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60;
    }
    
    location /socket.io/ {
        proxy_pass http://localhost:5000;  # Changed from http://backend:5000
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

**Key changes:**
- Line 2: `root /usr/share/nginx/html;` → `root C:\nginx\html;` (Windows path)
- Line 26: `proxy_pass http://backend:5000;` → `proxy_pass http://localhost:5000;`
- Line 34: `proxy_pass http://backend:5000;` → `proxy_pass http://localhost:5000;`
- All other directives remain unchanged (WebSocket upgrade headers, timeouts, caching, etc.)

---

## Shared Patterns

### NSSM Service Registration Template
**Apply to:** All Windows Service install scripts (`install-nssm-backend.ps1`, `install-nssm-scheduler.ps1`, `install-nssm-telegram-bot.ps1`)

**Base pattern** (from `scripts/install-nssm-print-agent.ps1` lines 114-139):
```powershell
# Step 1: Locate NSSM (try multiple paths, install if needed)
# Step 2: Set up Python virtualenv (if service is Python-based)
# Step 3: Remove old service (if reinstalling)
# Step 4: Register service with NSSM
$NssmExe install <ServiceName> <PythonExe> <ScriptPath>
$NssmExe set <ServiceName> AppDirectory <WorkDir>
$NssmExe set <ServiceName> AppStdout <LogPath>
$NssmExe set <ServiceName> AppStderr <ErrLogPath>
$NssmExe set <ServiceName> AppRotateFiles 1
$NssmExe set <ServiceName> AppRotateBytes 10485760  # 10 MB
$NssmExe set <ServiceName> Start SERVICE_AUTO_START
$NssmExe set <ServiceName> ObjectName LocalSystem
$NssmExe set <ServiceName> AppEnvironmentExtra @(...env vars...)
$NssmExe set <ServiceName> AppExit Default Restart
$NssmExe set <ServiceName> AppRestartDelay 5000
# Step 5: Start and verify
```

### Environment Variables from docker-compose.yml
**Apply to:** All service install scripts (backend, scheduler, telegram-bot)

**Mapping source:**
```
docker-compose.yml backend.environment (lines 28-56)
  → install-nssm-backend.ps1 AppEnvironmentExtra
  
docker-compose.yml scheduler.environment (lines 91-101)
  → install-nssm-scheduler.ps1 AppEnvironmentExtra
  
docker-compose.yml telegram-bot.environment (lines 113-118)
  → install-nssm-telegram-bot.ps1 AppEnvironmentExtra
```

**Critical overrides for Windows native:**
```
PRINT_AGENT_URL: http://host.docker.internal:9191 (Docker)
                 → http://localhost:9191 (Windows native)
                 
DATABASE_URL:    postgresql://user:pass@postgres:5432/billiardbar (Docker)
                 → postgresql://user:pass@localhost:5432/billiardbar (Windows native)
```

### Print Agent Unreachability Mitigation (NET-01)
**Apply to:** `backend/wsgi.py` startup verification + `install-nssm-backend.ps1`

**Health check pattern** (verify print agent reachable after backend startup):
```powershell
# From install-nssm-backend.ps1 (add after service starts)
Write-Host "Verifying print agent connectivity..."
try {
    $r = Invoke-RestMethod -Uri "http://localhost:9191/health" -TimeoutSec 3
    Write-Host "   Print agent is reachable [OK]" -ForegroundColor Green
} catch {
    Write-Host "   Print agent unreachable at http://localhost:9191" -ForegroundColor Yellow
    Write-Host "   Verify print agent service is running and listening" -ForegroundColor Yellow
}
```

---

## No Analog Found

Files with no close existing match (planner should use RESEARCH.md and D-08 decision references):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `scripts/postgres-backup-restore.ps1` | utility script | file-I/O | No backup/restore script exists in codebase; patterns derived from RESEARCH.md §"PostgreSQL Data Migration" (lines 406-459) and docker-compose.yml health check pattern |

---

## Metadata

**Analog search scope:** `scripts/`, `backend/`, `telegram-bot/`, `frontend/` directories + `docker-compose.yml`

**Files scanned:** 12 total (6 analog sources + 9 files to create/modify)

**Pattern extraction date:** 2026-08-08

**Key decision references:**
- D-04: NSSM tool choice (reuse print-agent pattern)
- D-05: Backend uses `socketio.run()` not gunicorn
- D-06: Idempotent startup (flask init-db + seed.py on every start)
- D-07: Per-service separate virtualenvs
- D-11: nginx reverse proxy (reuse docker config)
- NET-01: Print agent URL change from host.docker.internal:9191 → localhost:9191

