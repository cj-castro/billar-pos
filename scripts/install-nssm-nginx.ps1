# =============================================================================
# install-nssm-nginx.ps1
# Bola 8 POS - installs native Windows nginx as a REAL Windows Service using NSSM
#
# Serves the built React SPA (frontend\dist) and reverse-proxies /api/ and
# /socket.io/ to the native backend at http://localhost:5000 — replaces the
# Docker `frontend` container's nginx (SVC-03). Config source: scripts\nginx-windows.conf
# (adapted from frontend/nginx.conf per D-11).
#
# [OK] Starts at BOOT (no login required - even headless servers)
# [OK] Auto-restarts on crash
# [OK] Manageable via services.msc or "nssm start/stop/restart BilliardBarNginx"
#
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd C:\Users\bola8lacalma\Desktop\POS\billiards
#   4. .\scripts\install-nssm-nginx.ps1
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NginxDir     = "C:\nginx"
$NginxExe     = Join-Path $NginxDir "nginx.exe"
# Pinned exact version (not "latest") — official nginx.org domain only, per this plan's threat_model (T-02-09)
$NginxVersion = "1.26.2"
$NginxZipUrl  = "https://nginx.org/download/nginx-1.26.2.zip"
$ConfSource   = Join-Path $BaseDir "scripts\nginx-windows.conf"
$ConfDest     = Join-Path $NginxDir "conf\nginx.conf"
$FrontendDir  = Join-Path $BaseDir "frontend"
$DistDir      = Join-Path $FrontendDir "dist"
$HtmlDir      = Join-Path $NginxDir "html"
$ServiceName  = "BilliardBarNginx"
$FrontendPort = 8080
$NssmExe      = $null

Write-Host "`n=== Bola 8 POS - Native nginx Windows Service Installer ===" -ForegroundColor Cyan
Write-Host "   Service will start at BOOT - no login required.`n"

# -- Step 1: Download and install nginx ---------------------------------------
Write-Host "[1/7] Downloading nginx $NginxVersion from nginx.org..."
if (Test-Path $NginxExe) {
    Write-Host "   nginx already installed at $NginxDir - skipping download." -ForegroundColor Gray
} else {
    $nginxZip = "$env:TEMP\nginx-$NginxVersion.zip"
    $nginxExtract = "$env:TEMP\nginx_extract"
    try {
        Invoke-WebRequest -Uri $NginxZipUrl -OutFile $nginxZip -UseBasicParsing -TimeoutSec 30
        if (Test-Path $nginxExtract) { Remove-Item $nginxExtract -Recurse -Force }
        Expand-Archive -Path $nginxZip -DestinationPath $nginxExtract -Force

        # The nginx.org zip nests everything one level deep as nginx-<version>\*
        # Flatten it up into C:\nginx directly.
        $nestedDir = Join-Path $nginxExtract "nginx-$NginxVersion"
        if (-not (Test-Path $NginxDir)) { New-Item -ItemType Directory -Path $NginxDir -Force | Out-Null }
        Copy-Item -Path (Join-Path $nestedDir "*") -Destination $NginxDir -Recurse -Force

        Write-Host "   nginx $NginxVersion installed to $NginxDir" -ForegroundColor Green
    } catch {
        Write-Host "   Failed to download/install nginx: $_" -ForegroundColor Red
        exit 1
    }
}

# -- Step 2: Deploy the native-Windows nginx config ---------------------------
Write-Host "`n[2/7] Deploying nginx-windows.conf..."
if (-not (Test-Path $ConfSource)) {
    Write-Host "   Config source not found: $ConfSource" -ForegroundColor Red
    exit 1
}
Copy-Item -Path $ConfSource -Destination $ConfDest -Force
Write-Host "   Copied $ConfSource -> $ConfDest" -ForegroundColor Green

# -- Step 3: Ensure frontend\dist exists (build if missing) -------------------
Write-Host "`n[3/7] Checking frontend build (frontend\dist)..."
if (Test-Path $DistDir) {
    Write-Host "   frontend\dist already exists - skipping build." -ForegroundColor Gray
} else {
    $npm = $null
    foreach ($p in @("npm", "npm.cmd")) {
        try {
            $v = & $p --version 2>&1
            if ($LASTEXITCODE -eq 0) { $npm = $p; break }
        } catch {}
    }
    if (-not $npm) {
        Write-Host "   npm not found. Install Node 20 first (winget install OpenJS.NodeJS.LTS)." -ForegroundColor Red
        exit 1
    }
    Write-Host "   Building frontend (npm install && npm run build)..." -ForegroundColor Yellow
    # NOTE: "npm --prefix X install" does NOT make npm look for package.json
    # in X -- confirmed against the real staging machine, 2026-08-08 (npm
    # 10.8.2): --prefix only changes where packages get installed TO, not
    # which directory's package.json npm reads for a local install. npm
    # still resolves package.json from the current working directory
    # regardless of --prefix, so this must actually cd into $FrontendDir.
    Push-Location $FrontendDir
    try {
        & $npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "   npm install failed." -ForegroundColor Red
            exit 1
        }
        & $npm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "   npm run build failed." -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $DistDir)) {
        Write-Host "   Build completed but frontend\dist still missing - aborting." -ForegroundColor Red
        exit 1
    }
    Write-Host "   Frontend built successfully." -ForegroundColor Green
}

# -- Step 4: Deploy built SPA into C:\nginx\html -------------------------------
Write-Host "`n[4/7] Deploying frontend\dist -> $HtmlDir..."
if (Test-Path $HtmlDir) {
    # Clear any pre-existing files so stale builds are never served.
    Get-ChildItem -Path $HtmlDir -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $HtmlDir -Force | Out-Null
}
Copy-Item -Path (Join-Path $DistDir "*") -Destination $HtmlDir -Recurse -Force
Write-Host "   Deployed built SPA to $HtmlDir" -ForegroundColor Green

# -- Step 5: Register the NSSM service -----------------------------------------
Write-Host "`n[5/7] Registering Windows Service..."
foreach ($p in @("nssm", "$env:ProgramFiles\nssm\win64\nssm.exe",
                  "$env:ProgramFiles\nssm\nssm.exe", "C:\nssm\nssm.exe",
                  "$BaseDir\scripts\nssm.exe")) {
    try {
        $v = & $p version 2>&1
        if ($LASTEXITCODE -eq 0) { $NssmExe = $p; break }
    } catch {}
}
if (-not $NssmExe) {
    Write-Host "   NSSM not found. Install it first (see scripts\install-nssm-print-agent.ps1 Step 1)." -ForegroundColor Red
    exit 1
}
Write-Host "   NSSM found: $NssmExe" -ForegroundColor Green

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Stopping existing service..." -ForegroundColor Yellow
    & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null
    & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
}

# nginx reads conf\nginx.conf relative to its own directory - no arguments needed.
& $NssmExe install $ServiceName $NginxExe
& $NssmExe set $ServiceName AppDirectory $NginxDir
& $NssmExe set $ServiceName AppStdout    (Join-Path $NginxDir "logs\nginx_service.log")
& $NssmExe set $ServiceName AppStderr    (Join-Path $NginxDir "logs\nginx_service_err.log")
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760
& $NssmExe set $ServiceName Start SERVICE_AUTO_START
& $NssmExe set $ServiceName ObjectName LocalSystem
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000

Write-Host "   Service '$ServiceName' registered." -ForegroundColor Green

# -- Step 6: Open Windows Firewall for the frontend port only -----------------
Write-Host "`n[6/7] Opening firewall port $FrontendPort (LAN access)..."
$ruleName = "BilliardBarNginx"
$ruleExists = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ($LASTEXITCODE -ne 0) {
    netsh advfirewall firewall add rule `
        name="$ruleName" dir=in action=allow protocol=TCP localport=8080 | Out-Null
    Write-Host "   Firewall rule added (port $FrontendPort open)." -ForegroundColor Green
} else {
    Write-Host "   Firewall rule already exists." -ForegroundColor Gray
}
Write-Host "   Note: port 5000 (backend) is NOT opened - only nginx itself needs LAN reachability." -ForegroundColor Gray

# -- Step 7: Start service and verify -------------------------------------------
Write-Host "`n[7/7] Starting service..."
& $NssmExe start $ServiceName
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "   Service is RUNNING [OK]" -ForegroundColor Green
} else {
    Write-Host "   Service status: $($svc.Status)" -ForegroundColor Yellow
    Write-Host "   Check log: $NginxDir\logs\nginx_service_err.log" -ForegroundColor Yellow
}

$verified = $false
for ($i = 1; $i -le 10; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$FrontendPort/" -TimeoutSec 5 -UseBasicParsing
        if ($r.Content -match '<div id="root">') {
            Write-Host "   Health check OK: SPA content served (found <div id=`"root`">)." -ForegroundColor Green
            $verified = $true
            break
        } else {
            Write-Host "   Attempt $i/10: response received but SPA mount point not found yet - retrying..." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "   Attempt $i/10: not reachable yet - retrying..." -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 2
}
if (-not $verified) {
    Write-Host "   Health check failed after 10 attempts - check $NginxDir\logs\nginx_service_err.log" -ForegroundColor Red
}

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Service management commands:"
Write-Host "   Start:   nssm start $ServiceName"
Write-Host "   Stop:    nssm stop  $ServiceName"
Write-Host "   Restart: nssm restart $ServiceName"
Write-Host "   Logs:    $NginxDir\logs\nginx_service.log"
Write-Host "   Status:  Get-Service $ServiceName"
Write-Host "============================================================"
