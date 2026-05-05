# =============================================================================
# pos-network-setup.ps1
# Bola 8 POS — Network Setup & Mobile Access Helper
#
# Does three things in one script:
#   1. Shows current network status + access URLs
#   2. Opens Windows Firewall for the POS (ports 8080 + 9191)
#   3. (Optional) Locks in a static IP so the URL never changes
#
# HOW TO RUN (as Administrator):
#   1. PowerShell as Admin
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. .\scripts\pos-network-setup.ps1
# =============================================================================
#Requires -RunAsAdministrator

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$POS_PORT   = 8080
$AGENT_PORT = 9191

function Write-Section($title) {
    Write-Host "`n$('-' * 56)" -ForegroundColor DarkGray
    Write-Host " $title" -ForegroundColor Cyan
    Write-Host "$('-' * 56)" -ForegroundColor DarkGray
}
function ok($msg)   { Write-Host "  - $msg" -ForegroundColor Green }
function warn($msg) { Write-Host "  --  $msg" -ForegroundColor Yellow }
function info($msg) { Write-Host "     $msg" -ForegroundColor Gray }

Write-Host "`n--------------------------------------------------------" -ForegroundColor Cyan
Write-Host "-   Bola 8 POS - Network Setup & Mobile Access        -" -ForegroundColor Cyan
Write-Host "--------------------------------------------------------`n" -ForegroundColor Cyan

# ── 1. Detect current LAN IPs ────────────────────────────────────────────────
Write-Section "1/4 - Current Network Status"

$adapters = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254' } |
    Where-Object { $_.PrefixOrigin -ne 'WellKnown' }

# Exclude virtual/WSL/Hyper-V adapters — we want the real physical LAN/Wi-Fi IP
$physicalAdapters = $adapters | Where-Object {
    $adp = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
    $name = $adp.Name + ' ' + $adp.InterfaceDescription
    $name -notmatch 'vEthernet|Loopback|Virtual|WSL|Hyper-V|VirtualBox|VMware|Bluetooth|TAP|Tunnel'
}

$lanIP = $null
foreach ($a in $adapters) {
    $adapterInfo = Get-NetAdapter -InterfaceIndex $a.InterfaceIndex -ErrorAction SilentlyContinue
    $isDhcp = (Get-NetIPInterface -InterfaceIndex $a.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).Dhcp
    $kind   = if ($isDhcp -eq 'Enabled') { "DHCP" } else { "STATIC" }
    Write-Host "  $($adapterInfo.Name) - $($a.IPAddress)  [$kind]" -ForegroundColor White
}

# Prefer DHCP physical adapter (that's the real router connection), then static physical, then fallback
$preferred = $physicalAdapters | Where-Object {
    (Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).Dhcp -eq 'Enabled'
} | Select-Object -First 1

if (-not $preferred) { $preferred = $physicalAdapters | Select-Object -First 1 }
if ($preferred) { $lanIP = $preferred.IPAddress }

if ($lanIP) {
    Write-Host ""
    ok "POS App URL (for phones/tablets):"
    Write-Host "     http://$($lanIP):$POS_PORT" -ForegroundColor Yellow -BackgroundColor DarkBlue
    ok "Print Agent URL:"
    Write-Host "     http://$($lanIP):$AGENT_PORT/health" -ForegroundColor Yellow
} else {
    warn "No LAN IP detected. Connect to Wi-Fi or LAN first."
}

# ── 2. Firewall rules ────────────────────────────────────────────────────────
Write-Section "2/4 - Windows Firewall (ports 8080 + 9191)"

function Ensure-FirewallRule($name, $port, $desc) {
    $exists = netsh advfirewall firewall show rule name="$name" 2>$null
    if ($LASTEXITCODE -ne 0) {
        netsh advfirewall firewall add rule name="$name" dir=in action=allow `
            protocol=TCP localport=$port description="$desc" | Out-Null
        ok "Port $port opened ($name)"
    } else {
        info "Port $port already open ($name)"
    }
}

Ensure-FirewallRule "BilliardBarPOS-App"    $POS_PORT   "Bola 8 POS web app (nginx)"
Ensure-FirewallRule "BilliardBarPrintAgent" $AGENT_PORT "Bola 8 Print Agent (ESC/POS)"

# ── 3. Connectivity test ─────────────────────────────────────────────────────
Write-Section "3/4 - Service Reachability"

function Test-Port($ip, $port, $label) {
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $tcp.Connect($ip, $port)
        $tcp.Close()
        ok "$label reachable at ${ip}:${port}"
        return $true
    } catch {
        warn "$label NOT reachable at ${ip}:${port} - is the service running?"
        return $false
    }
}

if ($lanIP) {
    Test-Port $lanIP $POS_PORT   "POS App (nginx)"  | Out-Null
    Test-Port $lanIP $AGENT_PORT "Print Agent"      | Out-Null
} else {
    warn "Skipping reachability test - no LAN IP."
}

# Health check on print agent
try {
    $h = Invoke-RestMethod -Uri "http://localhost:$AGENT_PORT/health" -TimeoutSec 4
    ok "Print agent: status=$($h.status)  printer='$($h.printer)'"
} catch {
    warn "Print agent not responding on localhost:$AGENT_PORT"
    info "Start it: nssm start BilliardBarPrintAgent"
}

# ── 4. Static IP recommendation ──────────────────────────────────────────────
Write-Section "4/4 - Static IP (optional but recommended)"

Write-Host "  If the POS IP changes, staff phones need a new URL." -ForegroundColor White
Write-Host "  Two options:" -ForegroundColor White
Write-Host ""
Write-Host "  Option A - DHCP Reservation (RECOMMENDED)" -ForegroundColor Green
Write-Host "    Configure your router to always give this PC the same IP."
Write-Host "    You need:" -ForegroundColor Gray
if ($lanIP) {
    $mac = (Get-NetIPAddress -IPAddress $lanIP -ErrorAction SilentlyContinue |
            ForEach-Object { Get-NetAdapter -InterfaceIndex $_.InterfaceIndex } |
            Select-Object -First 1).MacAddress
    Write-Host "      MAC Address : $mac" -ForegroundColor Yellow
    Write-Host "      Desired IP  : $lanIP  (or e.g. 192.168.1.10)" -ForegroundColor Yellow
}
Write-Host "    Log in to your router - DHCP - Static Leases / Reservations" -ForegroundColor Gray
Write-Host "    - Add entry for the MAC above - assign fixed IP." -ForegroundColor Gray
Write-Host ""
Write-Host "  Option B - Static IP on this PC" -ForegroundColor Green
Write-Host "    Run set_ip.ps1 to set it directly on the network adapter."
Write-Host "    .\scripts\set_ip.ps1" -ForegroundColor DarkCyan
Write-Host ""

$setNow = Read-Host "  Configure static IP on this PC right now? (y/n)"
if ($setNow -eq 'y') {
    & "$ScriptsDir\set_ip.ps1"
}

# ── Final access card ────────────────────────────────────────────────────────
if ($lanIP) {
    $finalIP = $lanIP
    # Re-read in case set_ip.ps1 changed the IP — exclude virtual adapters
    $newIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254'
    } | Where-Object {
        $adp = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
        ($adp.Name + ' ' + $adp.InterfaceDescription) -notmatch 'vEthernet|Loopback|Virtual|WSL|Hyper-V|VirtualBox|VMware|Bluetooth|TAP|Tunnel'
    } | Select-Object -First 1).IPAddress
    if ($newIP) { $finalIP = $newIP }

    Write-Host ""
    Write-Host "--------------------------------------------------------" -ForegroundColor Green
    Write-Host "-           - MOBILE ACCESS CARD                     -" -ForegroundColor Green
    Write-Host "--------------------------------------------------------" -ForegroundColor Green
    Write-Host "-                                                      -"
    Write-Host "-  POS App:     http://$($finalIP):$POS_PORT            " -ForegroundColor Yellow
    Write-Host "-  Print Agent: http://$($finalIP):$AGENT_PORT/health   " -ForegroundColor Yellow
    Write-Host "-                                                      -"
    Write-Host "-  Connect phones/tablets to the same Wi-Fi, then     -"
    Write-Host "-  open the POS URL in Chrome or Safari.              -"
    Write-Host "--------------------------------------------------------" -ForegroundColor Green

    # Save access info to a file for reference
    $accessFile = Join-Path (Split-Path -Parent $ScriptsDir) "POS_ACCESS_INFO.txt"
    @"
Bola 8 POS - Network Access Info
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')
===========================================
POS App (phones/tablets): http://$finalIP`:$POS_PORT
Print Agent health check: http://$finalIP`:$AGENT_PORT/health
Print Agent printers list: http://$finalIP`:$AGENT_PORT/printers

Connect device to the same Wi-Fi network, then open the POS URL in Chrome or Safari.

MAC Address (for DHCP reservation): $mac
===========================================
"@ | Out-File -FilePath $accessFile -Encoding UTF8
    Write-Host ""
    info "Access info saved to: $accessFile"
}

Write-Host ""