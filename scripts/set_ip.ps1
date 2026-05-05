<#
.SYNOPSIS
    Set static IP on Windows and optionally enable external access (dry-run supported).
.DESCRIPTION
    This script configures a static IPv4 address with a dry-run mode that shows proposed changes.
    After applying, it offers ngrok or port forwarding instructions for external access.
.NOTES
    Run as Administrator. Requires internet for ngrok download.
#>

#Requires -RunAsAdministrator

# ========== Helper Functions ==========
function Get-NetworkInfo {
    $adapters = Get-NetAdapter -Physical | Where-Object {$_.Status -eq 'Up'}
    if ($adapters.Count -eq 0) { Write-Host "No active network adapters found." -ForegroundColor Red; exit 1 }
    
    Write-Host "`nActive network adapters:" -ForegroundColor Cyan
    $i = 1
    $adapters | ForEach-Object { Write-Host "$i. $($_.Name)" }
    
    do {
        $choice = Read-Host "`nSelect adapter number (or type the exact name)"
        if ($choice -match '^\d+$') {
            $selected = $adapters[$choice - 1]
            if ($selected) { $adapterName = $selected.Name }
        } else {
            $adapterName = $choice
        }
    } while (-not $adapterName -or -not (Get-NetAdapter -Name $adapterName -ErrorAction SilentlyContinue))
    
    # Get current IPv4 config if any
    $ipConfig = Get-NetIPAddress -InterfaceAlias $adapterName -AddressFamily IPv4 -ErrorAction SilentlyContinue
    $route = Get-NetRoute -InterfaceAlias $adapterName -DestinationPrefix "0.0.0.0/0" -AddressFamily IPv4 -ErrorAction SilentlyContinue
    $dns = Get-DnsClientServerAddress -InterfaceAlias $adapterName -AddressFamily IPv4 | Select-Object -ExpandProperty ServerAddresses
    
    $currentGateway = if ($route) { $route.NextHop } else { $null }
    $currentDNS = if ($dns) { $dns -join ", " } else { "8.8.8.8, 1.1.1.1 (default suggestion)" }
    $subnetMask = if ($ipConfig) { $ipConfig.PrefixLength } else { 24 }
    
    return @{
        AdapterName    = $adapterName
        CurrentIP      = if ($ipConfig) { $ipConfig.IPAddress } else { $null }
        CurrentGateway = $currentGateway
        CurrentDNS     = $currentDNS
        PrefixLength   = $subnetMask
        DHCPEnabled    = (Get-NetIPInterface -InterfaceAlias $adapterName -AddressFamily IPv4).Dhcp
    }
}

function Test-IPInSubnet {
    param($IP, $Gateway, $PrefixLen)
    $ipBytes = ([System.Net.IPAddress]$IP).GetAddressBytes()
    $gwBytes = ([System.Net.IPAddress]$Gateway).GetAddressBytes()
    # Build mask bytes directly — avoids UInt32 byte-order bug on little-endian Windows
    $mask = [byte[]]::new(4)
    for ($i = 0; $i -lt 4; $i++) {
        $bits = $PrefixLen - ($i * 8)
        if ($bits -ge 8)     { $mask[$i] = 255 }
        elseif ($bits -le 0) { $mask[$i] = 0   }
        else                 { $mask[$i] = [byte](256 - [Math]::Pow(2, 8 - $bits)) }
    }
    for ($i = 0; $i -lt 4; $i++) {
        if (($ipBytes[$i] -band $mask[$i]) -ne ($gwBytes[$i] -band $mask[$i])) {
            return $false
        }
    }
    return $true
}

function Show-DryRun {
    param($current, $proposed)
    
    Write-Host "`n=== DRY RUN: Proposed Static IP Configuration ===" -ForegroundColor Cyan
    Write-Host "Adapter      : $($current.AdapterName)"
    Write-Host "Current IP   : $($current.CurrentIP -replace '^$','(DHCP)')"
    Write-Host "Proposed IP  : $($proposed.IP)/$($proposed.PrefixLength)" -ForegroundColor Yellow
    Write-Host "Current GW   : $($current.CurrentGateway -replace '^$','(not set)')"
    Write-Host "Proposed GW  : $($proposed.Gateway)" -ForegroundColor Yellow
    Write-Host "Current DNS  : $($current.CurrentDNS)"
    Write-Host "Proposed DNS : $($proposed.DNS -join ', ')" -ForegroundColor Yellow
    Write-Host "DHCP on adapter currently: $($current.DHCPEnabled)" -ForegroundColor Gray
    
    if (-not (Test-IPInSubnet -IP $proposed.IP -Gateway $proposed.Gateway -PrefixLen $proposed.PrefixLength)) {
        Write-Host "--  WARNING: Proposed IP and gateway are NOT in the same subnet!" -ForegroundColor Red
    }
    
    $confirm = Read-Host "`nApply these changes? (y/n)"
    return ($confirm -eq 'y')
}

# ========== Auto-select best static IP ==========
function Get-BestStaticIP {
    param($Gateway, $PrefixLen, $CurrentIP)

    if (-not $Gateway) { return $null }

    $gwParts = $Gateway -split '\.'
    $subnet  = "$($gwParts[0]).$($gwParts[1]).$($gwParts[2])"

    # Get all IPs already assigned to ANY local adapter (don't suggest these)
    $localIPs = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress

    # Candidates: low-end addresses unlikely to be in typical DHCP pools (routers usually hand out .100-.200)
    $candidates = @(10, 5, 20, 15, 25, 30, 8, 9, 11, 12)

    foreach ($last in $candidates) {
        $ip = "$subnet.$last"
        if ($ip -eq $Gateway)    { continue }
        if ($ip -eq $CurrentIP)  { continue }
        if ($localIPs -contains $ip) { continue }  # already used by another local adapter
        # Quick ping check - skip if address already in use on the network
        $ping = Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue
        if (-not $ping) { return $ip }
    }
    # Fallback: just use .10
    return "$subnet.10"
}

# ========== Main Script ==========
Write-Host "=== Static IP Configuration for Bola 8 POS ===" -ForegroundColor Green

# 1. Gather current network info
$net = Get-NetworkInfo
$adapter        = $net.AdapterName
$defaultGateway = $net.CurrentGateway
$defaultPrefix  = $net.PrefixLength

Write-Host "`nCurrent network settings for '$adapter':" -ForegroundColor Yellow
if ($net.CurrentIP) { Write-Host "  IP (current): $($net.CurrentIP)" }
else                 { Write-Host "  IP (current): DHCP" }
if ($defaultGateway) { Write-Host "  Gateway     : $defaultGateway" }
Write-Host "  Prefix      : /$defaultPrefix"
Write-Host "  DNS         : $($net.CurrentDNS)"

# 2. Auto-detect gateway if missing (derive from current DHCP IP)
if (-not $defaultGateway -and $net.CurrentIP) {
    $parts = $net.CurrentIP -split '\.'
    $defaultGateway = "$($parts[0]).$($parts[1]).$($parts[2]).1"
    Write-Host "  Gateway not found via route table - assuming $defaultGateway" -ForegroundColor Yellow
}

# 3. Pick best static IP automatically
Write-Host "`nScanning subnet for a free address..." -ForegroundColor Cyan
$bestIP = Get-BestStaticIP -Gateway $defaultGateway -PrefixLen $defaultPrefix -CurrentIP $net.CurrentIP

if ($bestIP) {
    Write-Host "  Recommended IP: $bestIP (free, low address, outside typical DHCP range)" -ForegroundColor Green
} else {
    $gwParts = $defaultGateway -split '\.'
    $bestIP  = "$($gwParts[0]).$($gwParts[1]).$($gwParts[2]).10"
    Write-Host "  Could not scan subnet - defaulting to $bestIP" -ForegroundColor Yellow
}

# 4. Confirm or override
Write-Host ""
$override = Read-Host "Use $bestIP as the static IP? (press Enter to accept, or type a different IP)"
if (-not [string]::IsNullOrWhiteSpace($override)) {
    if ([System.Net.IPAddress]::TryParse($override, [ref]$null)) {
        $bestIP = $override
        Write-Host "  Using $bestIP" -ForegroundColor Cyan
    } else {
        Write-Host "  Invalid IP - using recommended $bestIP" -ForegroundColor Yellow
    }
}
$staticIP = $bestIP
$prefix   = $defaultPrefix

# 5. DNS - use gateway + Google as fallback
$dnsServers = @($defaultGateway, "8.8.8.8")
Write-Host "  DNS: $($dnsServers -join ', ') (gateway + Google)" -ForegroundColor Gray

$proposed = @{
    IP           = $staticIP
    PrefixLength = $prefix
    Gateway      = $defaultGateway
    DNS          = $dnsServers
}

# Ask for dry run preference
Write-Host ""
$dryRun = (Read-Host "Show proposed config before applying? (y/n)") -eq 'y'

# 3. Dry run handling
if ($dryRun) {
    $apply = Show-DryRun -current $net -proposed $proposed
    if (-not $apply) {
        Write-Host "Dry run - no changes made. Exiting." -ForegroundColor Gray
        exit 0
    }
    Write-Host "Proceeding with applying configuration..." -ForegroundColor Green
}

# 4. Apply static IP
Write-Host "`nApplying static IP configuration..." -ForegroundColor Yellow
try {
    # Remove existing IPv4 config
    Remove-NetIPAddress -InterfaceAlias $adapter -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetRoute -InterfaceAlias $adapter -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
    
    # Add new static IP and gateway
    New-NetIPAddress -InterfaceAlias $adapter -IPAddress $staticIP -PrefixLength $prefix -DefaultGateway $defaultGateway -ErrorAction Stop
    Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses $dnsServers -ErrorAction Stop
    
    Write-Host "- Static IP set to $staticIP/$prefix, gateway $defaultGateway" -ForegroundColor Green
    Write-Host "- DNS set to $($dnsServers -join ', ')" -ForegroundColor Green
} catch {
    Write-Host "Failed to apply static IP: $_" -ForegroundColor Red
    exit 1
}

# 5. Verify connectivity
Write-Host "`n--- Verification ---" -ForegroundColor Cyan
Start-Sleep -Seconds 2
if (Test-Connection -ComputerName $defaultGateway -Count 1 -Quiet) {
    Write-Host "- Gateway ping successful" -ForegroundColor Green
} else {
    Write-Host "- Gateway unreachable. Check IP/subnet." -ForegroundColor Red
}
if (Test-Connection -ComputerName 8.8.8.8 -Count 1 -Quiet) {
    Write-Host "- Internet connectivity confirmed" -ForegroundColor Green
} else {
    Write-Host "- No internet access. Check DNS or router." -ForegroundColor Red
}

# ========== External Access Options ==========
Write-Host "`n=== External Access (from outside your network) ===" -ForegroundColor Magenta
Write-Host "Choose a method to reach this PC from the internet:" 
Write-Host "1) ngrok (easiest, no router config, uses a tunnel)" 
Write-Host "2) Port forwarding (manual router configuration)" 
$method = Read-Host "Enter 1 or 2"

if ($method -eq '1') {
    $servicePort = Read-Host "Enter the local port you want to expose (e.g., 3389 for RDP, 80 for web)"
    Write-Host "Checking for ngrok..." -ForegroundColor Yellow
    $ngrokPath = Get-Command ngrok -ErrorAction SilentlyContinue
    if (-not $ngrokPath) {
        Write-Host "ngrok not found. Download now?" -ForegroundColor Cyan
        $download = Read-Host "Download ngrok? (y/n)"
        if ($download -eq 'y') {
            $url = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip"
            $zip = "$env:TEMP\ngrok.zip"
            Invoke-WebRequest -Uri $url -OutFile $zip
            Expand-Archive -Path $zip -DestinationPath "$env:ProgramFiles\ngrok" -Force
            $ngrokPath = "$env:ProgramFiles\ngrok\ngrok.exe"
            $env:PATH += ";$env:ProgramFiles\ngrok"
            Write-Host "ngrok installed to $env:ProgramFiles\ngrok" -ForegroundColor Green
        } else {
            Write-Host "Cannot proceed without ngrok. Exiting." -ForegroundColor Red
            exit
        }
    }
    
    Write-Host "`n--  For persistent tunnels, sign up at https://ngrok.com and add your authtoken." -ForegroundColor Yellow
    $setToken = Read-Host "Do you have an authtoken? Enter now (or press Enter to skip)"
    if ($setToken) {
        & ngrok config add-authtoken $setToken
    }
    
    Write-Host "`nStarting ngrok tunnel to localhost:$servicePort ..." -ForegroundColor Green
    Write-Host "A new window will open showing the public URL (e.g., https://xxxx.ngrok.io)." -ForegroundColor Cyan
    Start-Process -FilePath "ngrok" -ArgumentList "tcp $servicePort" -WindowStyle Normal
    Write-Host "`n- Tunnel running. Access your PC from anywhere using that URL (TCP tunnel)." -ForegroundColor Green
    Write-Host "To stop, close the ngrok window or press Ctrl+C there." 
}
elseif ($method -eq '2') {
    $localPort = Read-Host "Enter the local port your service listens on (e.g., 3389 for RDP)"
    Write-Host "`n--- Manual Port Forwarding Instructions ---" -ForegroundColor Cyan
    Write-Host "1. Open your router admin panel (usually http://$defaultGateway)."
    Write-Host "2. Log in (admin credentials often on router sticker)."
    Write-Host "3. Find 'Port Forwarding' (or Virtual Server / NAT)."
    Write-Host "4. Create a rule with:" -ForegroundColor Yellow
    Write-Host "   - External port: [choose any, e.g., $localPort or a different one]" 
    Write-Host "   - Internal IP: $staticIP"
    Write-Host "   - Internal port: $localPort"
    Write-Host "   - Protocol: TCP (or both UDP/TCP if needed)"
    Write-Host "5. Save and reboot router if required."
    Write-Host "6. Find your public IP: curl ifconfig.me or visit 'whatismyip.com'."
    Write-Host "`n- Then connect from outside using: <public IP>:<external port>" -ForegroundColor Green
    Write-Host "--  Your public IP may change. Use Dynamic DNS (e.g., DuckDNS, No-IP)." -ForegroundColor Yellow
}
else {
    Write-Host "Invalid choice. Skipping external access setup." -ForegroundColor Red
}

Write-Host "`n=== Script completed ===" -ForegroundColor Green