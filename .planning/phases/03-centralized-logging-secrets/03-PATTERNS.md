# Phase 3: Centralized Logging & Secrets - Pattern Map

**Mapped:** 2026-08-09
**Files analyzed:** 8 (5 new, 3 modified)
**Analogs found:** 5 / 8 (3 new patterns have partial/no direct analogs)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/reconfigure-log-paths.ps1` | utility (admin) | configuration-management | `scripts/install-nssm-backend.ps1` | exact |
| `scripts/migrate-secrets-to-dpapi.ps1` | utility (one-time) | configuration-management | `scripts/install-nssm-backend.ps1` | exact |
| `scripts/tail-logs.ps1` | utility (monitoring) | streaming/log-aggregation | None (new pattern) | — |
| `scripts/rotate-nginx-logs.ps1` | utility (maintenance) | file-I/O | None (new pattern) | — |
| `.env.example` | config/documentation | configuration | `docker-compose.yml` | good |
| `frontend/nginx.conf` (modified) | configuration | configuration | `frontend/nginx.conf` (itself) | exact |
| `backend/app/config.py` (modified) | config/service | configuration-management | `backend/app/config.py` (itself) | exact |
| `backend/app/__init__.py` (modified) | service/app-factory | request-response | `backend/app/__init__.py` (itself) | exact |

## Pattern Assignments

### `scripts/reconfigure-log-paths.ps1` (utility, configuration-management)

**Analog:** `scripts/install-nssm-backend.ps1`

**Header/Structure pattern** (lines 1-40):
```powershell
# =============================================================================
# scripts/reconfigure-log-paths.ps1
# Phase 3 - Reconfigure NSSM service log paths to C:\POS\logs\
# 
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd C:\path\to\repo
#   4. .\scripts\reconfigure-log-paths.ps1
#
# This script:
# - Stops each Phase 2 NSSM service
# - Changes AppStdout/AppStderr paths to C:\POS\logs\
# - Preserves existing AppRotateFiles/AppRotateBytes settings
# - Restarts each service
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogsDir = "C:\POS\logs"
$NssmExe = $null

Write-Host "`n=== Phase 3: Reconfigure NSSM Log Paths ===" -ForegroundColor Cyan
```

**NSSM locating pattern** (lines 72-117 of install-nssm-backend.ps1):
```powershell
# -- Step 1: Find or install NSSM
Write-Host "[1/5] Locating NSSM..."
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                  "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                  "$BaseDir\scripts\nssm.exe")) {
    try {
        $v = & $p version 2>&1
        if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
    } catch {}
}

if (-not $NssmExe) {
    Write-Host "NSSM not found. Install via Phase 2 first." -ForegroundColor Red
    exit 1
}
Write-Host "NSSM found: $NssmExe" -ForegroundColor Green
```

**Service array definition pattern** (lines 549-555 of 03-RESEARCH.md example):
```powershell
$services = @(
    @{ Name = "BilliardBarBackend"; Stdout = "backend.log"; Stderr = "backend_err.log" },
    @{ Name = "BilliardBarScheduler"; Stdout = "scheduler.log"; Stderr = "scheduler_err.log" },
    @{ Name = "BilliardBarTelegramBot"; Stdout = "telegram_bot.log"; Stderr = "telegram_bot_err.log" },
    @{ Name = "BilliardBarPrintAgent"; Stdout = "print_agent.log"; Stderr = "print_agent_err.log" },
    @{ Name = "BilliardBarNginx"; Stdout = "nginx_service.log"; Stderr = "nginx_service_err.log" }
)
```

**Service reconfiguration pattern** (stop → set → verify → restart):
```powershell
# Stop service first (NSSM config changes only take effect on restart)
& $NssmExe stop $serviceName confirm 2>&1 | Out-Null
Start-Sleep -Seconds 2

# Set new log paths
$stdoutPath = Join-Path $LogsDir $svc.Stdout
& $NssmExe set $serviceName AppStdout $stdoutPath
& $NssmExe set $serviceName AppStderr (Join-Path $LogsDir $svc.Stderr)

# Verify settings were applied
$verify = & $NssmExe get $serviceName AppStdout
if ($verify -ne $stdoutPath) {
    Write-Host "ERROR: AppStdout verification failed!" -ForegroundColor Red
    exit 1
}

# Restart service
& $NssmExe start $serviceName 2>&1 | Out-Null
Start-Sleep -Seconds 3

# Check service status
$svcStatus = (Get-Service -Name $serviceName -ErrorAction SilentlyContinue).Status
if ($svcStatus -eq "Running") {
    Write-Host "✓ $serviceName is running" -ForegroundColor Green
} else {
    Write-Host "⚠ $serviceName status: $svcStatus" -ForegroundColor Yellow
}
```

---

### `scripts/migrate-secrets-to-dpapi.ps1` (utility, configuration-management)

**Analog:** `scripts/install-nssm-backend.ps1` (Read-DotEnv pattern) + Windows DPAPI documentation

**Header pattern**:
```powershell
# =============================================================================
# scripts/migrate-secrets-to-dpapi.ps1
# Phase 3 - One-time migration of secrets from .env to Windows Credential Manager
#
# HOW TO RUN (one time, as Administrator):
#   .\scripts\migrate-secrets-to-dpapi.ps1
#
# This script:
# - Reads all secrets from .env (POSTGRES_PASSWORD, JWT keys, role PINs, SMTP creds)
# - Encrypts each value using DPAPI (tied to LocalSystem identity)
# - Stores encrypted blobs in a secure location or Windows Registry
# - Outputs instructions for retrieving values in NSSM AppEnvironmentExtra
# =============================================================================
#Requires -RunAsAdministrator
```

**Read-DotEnv function** (lines 47-70 of install-nssm-backend.ps1):
```powershell
function Read-DotEnv {
    param([string]$Path)
    $envVars = @{}
    if (-not (Test-Path $Path)) {
        Write-Host "   WARNING: .env not found at $Path" -ForegroundColor Yellow
        return $envVars
    }
    Get-Content -Path $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        # Strip surrounding quotes (single or double)
        if ($value.Length -ge 2 -and (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            )) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $envVars[$key] = $value
    }
    return $envVars
}
```

**DPAPI encryption pattern** (from 03-RESEARCH.md Pattern 3):
```powershell
# Define list of secrets to migrate (from docker-compose.yml D-07)
$secrets = @(
    'POSTGRES_PASSWORD', 'SECRET_KEY', 'JWT_REFRESH_SECRET',
    'ADMIN_PASSWORD', 'ADMIN_PIN', 'MANAGER_PASSWORD', 'MANAGER_PIN',
    'WAITER1_PASSWORD', 'WAITER2_PASSWORD', 'KITCHEN_PASSWORD', 'BARSTAFF_PASSWORD',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD'
)

# Encrypt each secret with DPAPI (LocalSystem scope)
foreach ($secret in $secrets) {
    if (-not $DotEnv.ContainsKey($secret)) { continue }
    
    $value = $DotEnv[$secret]
    if ([string]::IsNullOrWhiteSpace($value)) { continue }
    
    [byte[]]$plaintext = [System.Text.Encoding]::UTF8.GetBytes($value)
    [byte[]]$encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
        $plaintext,
        $null,  # optionalEntropy
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser  # LocalSystem scope
    )
    
    $base64 = [Convert]::ToBase64String($encrypted)
    # Store encrypted blob (e.g., in registry or file)
    Write-Host "  ✓ Encrypted $secret"
}
```

---

### `scripts/tail-logs.ps1` (utility, streaming/log-aggregation)

**No close analog in codebase** — new pattern. Reference implementation pattern from 03-RESEARCH.md Pattern 2:

```powershell
# =============================================================================
# scripts/tail-logs.ps1
# Phase 3 - Watch all service logs in C:\POS\logs\ live with service prefixes
#
# Usage:
#   .\scripts\tail-logs.ps1              # Watch ALL services
#   .\scripts\tail-logs.ps1 -Service backend  # Watch only backend
# =============================================================================

param(
    [string]$Service = $null,
    [string]$LogDir = "C:\POS\logs"
)

Write-Host "Tailing logs from $LogDir" -ForegroundColor Cyan
if ($Service) {
    Write-Host "Filter: $Service only" -ForegroundColor Cyan
}

# Determine which log files to tail
$files = if ($Service) {
    @(Get-ChildItem "$LogDir\${Service}*.log" -ErrorAction SilentlyContinue)
} else {
    @(Get-ChildItem "$LogDir\*.log" -ErrorAction SilentlyContinue)
}

if ($files.Count -eq 0) {
    Write-Host "No log files found in $LogDir" -ForegroundColor Yellow
    exit 1
}

Write-Host "Watching $($files.Count) file(s):`n" -ForegroundColor Green
foreach ($file in $files) {
    Write-Host "  • $($file.Name)" -ForegroundColor Green
}
Write-Host ""

# For each file, tail with service prefix
foreach ($file in $files) {
    $serviceName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    
    & { 
        Get-Content -Path $file.FullName -Wait -ErrorAction SilentlyContinue | ForEach-Object {
            "[$(Get-Date -Format 'HH:mm:ss')] [$serviceName] $_"
        }
    } | Out-Host
}
```

---

### `scripts/rotate-nginx-logs.ps1` (utility, file-I/O)

**No close analog in codebase** — new pattern. Reference implementation from 03-RESEARCH.md Pattern 4:

```powershell
# =============================================================================
# scripts/rotate-nginx-logs.ps1
# Phase 3 - Rotate nginx native access.log / error.log in C:\POS\logs\
#
# Called by: Windows Task Scheduler (daily at 02:00 AM)
#
# This script:
# - Renames active nginx logs to archive names (access.log.YYYY-MM-DD)
# - Signals nginx to reopen log files (or restarts service)
# - Prunes archived logs older than 30 days
# =============================================================================

$LogDir = "C:\POS\logs"
$MaxDays = 30

Write-Host "Rotating nginx logs in $LogDir..." -ForegroundColor Cyan

# Rotate active logs (nginx keeps them open, so rename + signal)
$date = Get-Date -Format "yyyy-MM-dd"

if (Test-Path "$LogDir\access.log") {
    Move-Item "$LogDir\access.log" "$LogDir\access.log.$date" -Force
    Write-Host "  Rotated access.log" -ForegroundColor Green
}

if (Test-Path "$LogDir\error.log") {
    Move-Item "$LogDir\error.log" "$LogDir\error.log.$date" -Force
    Write-Host "  Rotated error.log" -ForegroundColor Green
}

# Signal nginx to reopen logs (via NSSM)
try {
    # NSSM can signal services; fallback to restart if signal fails
    nssm signalservice BilliardBarNginx USR1 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Signaling failed, restarting nginx..." -ForegroundColor Yellow
        nssm restart BilliardBarNginx
    } else {
        Write-Host "  Signaled nginx to reopen logs" -ForegroundColor Green
    }
} catch {
    Write-Host "  ERROR: Could not signal nginx: $_" -ForegroundColor Red
}

# Prune old archived logs (older than 30 days)
$old = Get-ChildItem "$LogDir\access.log.*", "$LogDir\error.log.*" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$MaxDays) }

if ($old.Count -gt 0) {
    $old | Remove-Item -Force
    Write-Host "  Pruned $($old.Count) log file(s) older than $MaxDays days" -ForegroundColor Green
} else {
    Write-Host "  No old logs to prune" -ForegroundColor Gray
}

Write-Host "Done." -ForegroundColor Green
```

---

### `.env.example` (config/documentation)

**Analog:** `docker-compose.yml` (lines 1-56, lists all environment variables)

**Structure and content pattern** — document every non-secret env var with placeholders, plus comments on which values come from Credential Manager:

```
# =============================================================================
# .env.example
# Phase 3 - Non-secret environment configuration template
#
# This file documents all NON-SECRET configuration variables.
# SECRET values (passwords, JWT keys, Telegram token, SMTP creds, etc.)
# are sourced from Windows Credential Manager (DPAPI) in Phase 3,
# NOT from this .env file.
#
# For development (Docker): Create a real .env file from this template
# and fill in the values marked CHANGE_ME or PLACEHOLDER.
#
# For production (Windows Services): Only this file is needed; secrets
# are stored in Windows Credential Manager via migrate-secrets-to-dpapi.ps1.
# =============================================================================

# Postgres configuration (from docker-compose.yml / Phase 2)
POSTGRES_DB=billiardbar
POSTGRES_USER=billiard
# POSTGRES_PASSWORD is now sourced from Credential Manager (not here)

# Backend Flask configuration
BILLING_MODE=PER_MINUTE
POOL_RATE_CENTS=150
HAPPY_HOUR_START=17:00
HAPPY_HOUR_END=20:00
HAPPY_HOUR_DISCOUNT_PCT=20

# Application and system defaults
CURRENCY=MXN
TZ=America/Mexico_City
LOG_LEVEL=INFO
FLASK_ENV=production

# JWT token expiration (hours)
JWT_ACCESS_HOURS=8

# Print agent (Phase 2 native service)
PRINT_AGENT_URL=http://localhost:9191

# Frontend and networking
FRONTEND_PORT=8080

# Secrets moved to Credential Manager (Phase 3):
# ├── POSTGRES_PASSWORD    (database auth) — Credential Manager
# ├── SECRET_KEY          (Flask session)  — Credential Manager
# ├── JWT_REFRESH_SECRET  (JWT refresh)    — Credential Manager
# ├── ADMIN_PASSWORD      (role)           — Credential Manager
# ├── ADMIN_PIN           (role)           — Credential Manager
# ├── MANAGER_PASSWORD    (role)           — Credential Manager
# ├── MANAGER_PIN         (role)           — Credential Manager
# ├── WAITER1_PASSWORD    (role)           — Credential Manager
# ├── WAITER2_PASSWORD    (role)           — Credential Manager
# ├── KITCHEN_PASSWORD    (role)           — Credential Manager
# ├── BARSTAFF_PASSWORD   (role)           — Credential Manager
# ├── SMTP_HOST           (email)          — Credential Manager
# ├── SMTP_PORT           (email)          — Credential Manager
# ├── SMTP_USER           (email)          — Credential Manager
# ├── SMTP_PASSWORD       (email)          — Credential Manager
# └── TELEGRAM_BOT_TOKEN  (notifications)  — Credential Manager
#
# On production (Windows Services), each NSSM service's AppEnvironmentExtra
# decrypts these values from Credential Manager at startup and injects them
# as plaintext environment variables (D-06 accepted limitation).
```

---

### `frontend/nginx.conf` (modified, configuration)

**Analog:** `frontend/nginx.conf` (existing file, lines 1-45)

**Add access_log/error_log directives pattern** (from 03-RESEARCH.md D-02):

Insert at top of the `server {}` block (after `listen 80;`, before `root`):

```nginx
server {
    listen 80;
    
    # Phase 3: Explicit log paths for native nginx logs (D-02)
    # NSSM's AppStdout/AppStderr handle wrapper/startup logs
    # These directives handle nginx's own HTTP access/error logging
    access_log /var/log/nginx/access.log combined;
    error_log /var/log/nginx/error.log warn;
    
    root /usr/share/nginx/html;
    index index.html;
    
    # ... rest of config unchanged
```

**On Windows (Phase 3 native deployment)**, update paths to point to shared log directory:

```nginx
# Windows native service deployment (Phase 3):
access_log C:\POS\logs\nginx_access.log combined;
error_log C:\POS\logs\nginx_error.log warn;
```

---

### `backend/app/config.py` (modified, configuration-management)

**Analog:** `backend/app/config.py` (existing, lines 1-38)

**No changes to this file itself** — it already reads secrets with `os.environ.get()` and insecure defaults. The D-12 default-value warning check is implemented in `backend/app/__init__.py`, not here.

Reference: existing secret reading pattern (lines 5, 12-13):

```python
class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
    JWT_SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
    JWT_REFRESH_SECRET_KEY = os.environ.get('JWT_REFRESH_SECRET', 'dev-refresh-secret')
    
    # Role passwords/PINs read from env (not config class)
    # ADMIN_PASSWORD, ADMIN_PIN, etc. are read via os.environ.get() at app factory time
```

---

### `backend/app/__init__.py` (modified, app-factory/middleware)

**Analog:** `backend/app/__init__.py` (existing, lines 1-28)

**Add D-12 default-value warning check pattern** — insert after logging setup, before blueprints:

```python
def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    logging.basicConfig(
        level=getattr(logging, app.config['LOG_LEVEL'], logging.INFO),
        format='%(asctime)s %(levelname)s %(name)s %(message)s'
    )

    # ========== D-12: WARN IF SECRETS AT INSECURE DEFAULTS ==========
    _check_default_secrets(app.config)
    # ===================================================================

    db.init_app(app)
    # ... rest of create_app unchanged
```

**Function to add** (after `create_app()` definition or at end of file):

```python
def _check_default_secrets(config):
    """
    Warn (not fail) if any secret is at its known insecure default value.
    Runs once per create_app() call.
    
    D-11 behavior: services warn loudly but continue to run.
    This prevents hard failures from blocking POS operation.
    """
    import os
    
    KNOWN_DEFAULTS = {
        'SECRET_KEY': ['dev-secret-change-me', 'dev-secret-key-change-in-production'],
        'JWT_REFRESH_SECRET_KEY': ['dev-refresh-secret', 'dev-refresh-secret-change-in-production'],
        # Database
        'POSTGRES_PASSWORD': ['billiard_secret'],
        # Role credentials (from docker-compose.yml defaults)
        'ADMIN_PASSWORD': ['admin123'],
        'ADMIN_PIN': ['1234'],
        'MANAGER_PASSWORD': ['manager123'],
        'MANAGER_PIN': ['5678'],
        'WAITER1_PASSWORD': ['waiter123'],
        'WAITER2_PASSWORD': ['waiter123'],
        'KITCHEN_PASSWORD': ['kitchen123'],
        'BARSTAFF_PASSWORD': ['bar123'],
        # SMTP (only warn if explicitly set to a known-bad value, not if empty)
        'SMTP_USER': ['default', 'CHANGE_ME'],
        'SMTP_PASSWORD': ['default', 'CHANGE_ME'],
    }
    
    warnings = []
    
    # Check config object secrets (Flask app.config)
    for key, defaults in KNOWN_DEFAULTS.items():
        if key.startswith('ADMIN_') or key.startswith('MANAGER_') or key.startswith('WAITER') or key.startswith('KITCHEN_') or key.startswith('BARSTAFF_') or key.startswith('SMTP_'):
            continue  # Check these from environment only
        
        value = config.get(key, '')
        if value and value in defaults:
            warnings.append(f"{key} is at insecure default: '{value}'")
    
    # Check role credentials and SMTP from environment (not in config object)
    env_role_secrets = {
        'ADMIN_PASSWORD': os.environ.get('ADMIN_PASSWORD', ''),
        'ADMIN_PIN': os.environ.get('ADMIN_PIN', ''),
        'MANAGER_PASSWORD': os.environ.get('MANAGER_PASSWORD', ''),
        'MANAGER_PIN': os.environ.get('MANAGER_PIN', ''),
        'WAITER1_PASSWORD': os.environ.get('WAITER1_PASSWORD', ''),
        'WAITER2_PASSWORD': os.environ.get('WAITER2_PASSWORD', ''),
        'KITCHEN_PASSWORD': os.environ.get('KITCHEN_PASSWORD', ''),
        'BARSTAFF_PASSWORD': os.environ.get('BARSTAFF_PASSWORD', ''),
        'SMTP_USER': os.environ.get('SMTP_USER', ''),
        'SMTP_PASSWORD': os.environ.get('SMTP_PASSWORD', ''),
    }
    
    for key, defaults in KNOWN_DEFAULTS.items():
        if key not in env_role_secrets:
            continue
        value = env_role_secrets[key]
        if value and value in defaults:
            warnings.append(f"{key} (env) is at insecure default: '{value}'")
    
    # Log warnings (both to console and to app logger)
    if warnings:
        logger = logging.getLogger(__name__)
        warning_msg = "⚠️  INSECURE DEFAULTS DETECTED:\n  " + "\n  ".join(warnings)
        logger.warning(warning_msg)
        print("\n" + "="*70)
        print(warning_msg)
        print("="*70 + "\n")
        # Do NOT exit(1) — warn only, per D-11
```

---

## Shared Patterns

### PowerShell Admin Script Structure (All Phase 3 PS Scripts)

**Apply to:** `scripts/reconfigure-log-paths.ps1`, `scripts/migrate-secrets-to-dpapi.ps1`, `scripts/tail-logs.ps1`, `scripts/rotate-nginx-logs.ps1`

**Header and safety pattern:**
```powershell
# =============================================================================
# scripts/[script-name].ps1
# [Description and purpose]
#
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd C:\path\to\repo
#   4. .\scripts\[script-name].ps1
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
```

**Error handling and status output:**
```powershell
# Use Write-Host with ForegroundColor for user feedback
Write-Host "Message" -ForegroundColor Cyan   # Headers
Write-Host "Message" -ForegroundColor Green  # Success
Write-Host "Message" -ForegroundColor Yellow # Warnings
Write-Host "Message" -ForegroundColor Red    # Errors

# Always exit with non-zero status on fatal errors
if ($error_condition) {
    Write-Host "Fatal error" -ForegroundColor Red
    exit 1
}
```

---

### NSSM Service Configuration Pattern

**Apply to:** `scripts/reconfigure-log-paths.ps1`

**Core pattern:** Locate NSSM → Stop service → Update config → Verify → Restart

```powershell
# Locate NSSM
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe", ...)) {
    try { $v = & $p version 2>&1; if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break } }
    catch {}
}

if (-not $NssmExe) {
    Write-Host "NSSM not found" -ForegroundColor Red
    exit 1
}

# Stop, configure, restart cycle
& $NssmExe stop $serviceName confirm 2>&1 | Out-Null
& $NssmExe set $serviceName AppStdout $newPath
$verify = & $NssmExe get $serviceName AppStdout
if ($verify -ne $newPath) { Write-Host "Verification failed" -ForegroundColor Red; exit 1 }
& $NssmExe start $serviceName 2>&1 | Out-Null
```

---

### Secrets Migration Pattern

**Apply to:** `scripts/migrate-secrets-to-dpapi.ps1`

**Core pattern:** Read .env → Identify secrets → Encrypt with DPAPI → Store → Output instructions

```powershell
# Read .env using Read-DotEnv helper (reuse from Phase 2)
$envVars = Read-DotEnv -Path $EnvFile

# For each secret in scope (D-07 list):
foreach ($secret in $secrets) {
    if (-not $envVars.ContainsKey($secret)) { continue }
    
    # Encrypt with DPAPI
    [byte[]]$plaintext = [System.Text.Encoding]::UTF8.GetBytes($envVars[$secret])
    [byte[]]$encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
        $plaintext, $null, 
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    
    # Store encrypted blob (registry or file)
    $base64 = [Convert]::ToBase64String($encrypted)
}
```

---

### Backend Secret Validation Pattern

**Apply to:** `backend/app/__init__.py` (_check_default_secrets function)

**Core pattern:** Define KNOWN_DEFAULTS → Check config + env vars → Warn if matched (do not exit)

```python
KNOWN_DEFAULTS = {
    'SECRET_KEY': ['dev-secret-change-me', '...'],
    # ... other secrets
}

warnings = []
for key, defaults in KNOWN_DEFAULTS.items():
    value = config.get(key, '')  # or os.environ.get(key)
    if value in defaults:
        warnings.append(f"{key} is at insecure default")

if warnings:
    logger.warning("\n".join(warnings))
    print("\n" + "="*70 + "\n".join(warnings) + "\n" + "="*70)
    # Do NOT exit(1) — warn only
```

---

## No Analog Found

Files with no close match in the codebase — planner should use RESEARCH.md patterns instead:

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `scripts/tail-logs.ps1` | utility | streaming/log-aggregation | No live multi-file log tailing script exists in codebase; relies on PowerShell 5.1 `Get-Content -Wait` (new pattern in 03-RESEARCH.md) |
| `scripts/rotate-nginx-logs.ps1` | utility | file-I/O | No Windows-based log rotation script exists; relies on NSSM signals + scheduled task (new pattern in 03-RESEARCH.md) |

---

## Metadata

**Analog search scope:** 
- `scripts/` — Phase 2 NSSM installers (install-nssm-*.ps1)
- `backend/app/` — Flask app factory and configuration
- `frontend/` — nginx configuration
- Root — docker-compose.yml for environment variable reference

**Files scanned:** 
- `scripts/install-nssm-backend.ps1` (Read-DotEnv, NSSM patterns)
- `scripts/install-nssm-print-agent.ps1` (service registration patterns)
- `backend/app/__init__.py` (app factory)
- `backend/app/config.py` (secret reading)
- `frontend/nginx.conf` (current configuration)
- `docker-compose.yml` (environment variable list)

**Pattern extraction date:** 2026-08-09

---

*Phase: 3-Centralized Logging & Secrets*
*Pattern mapping completed: 2026-08-09 — Ready for planning phase*
