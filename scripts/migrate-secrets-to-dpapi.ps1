# =============================================================================
# migrate-secrets-to-dpapi.ps1
# Phase 3 - One-time (but safe-to-re-run) migration of secrets from the
# repo-root .env into DPAPI-encrypted storage under C:\POS\secrets\.
#
# HOW TO RUN (one time, as Administrator):
#   1. Open PowerShell as Administrator
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. cd <repo root>
#   4. .\scripts\migrate-secrets-to-dpapi.ps1
#
# This script:
# - Reads the git-ignored repo-root .env file
# - For every D-07-scoped secret present and non-empty, encrypts it with
#   Windows DPAPI (LocalMachine scope) via
#   System.Security.Cryptography.ProtectedData
# - Writes each encrypted value to its own file: C:\POS\secrets\<KEY>.dat
# - Restricts C:\POS\secrets\ to Administrators/SYSTEM only (same ACL
#   approach as Plan 03-01's C:\POS\logs\)
#
# SAFETY: this script NEVER prints, logs, or transcribes a plaintext secret
# value to the console or any file. Only key names, counts, and file paths
# are ever printed.
#
# Re-running this script is safe: it overwrites each key's .dat file with a
# freshly-encrypted copy of whatever is currently in .env for that key.
#
# Run scripts\reconfigure-secrets.ps1 next to actually wire these encrypted
# values into the running NSSM services.
# =============================================================================
#Requires -RunAsAdministrator

$BaseDir    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile    = Join-Path $BaseDir ".env"
$SecretsDir = "C:\POS\secrets"

Write-Host "`n=== Phase 3: Migrate Secrets to DPAPI-Encrypted Storage ===" -ForegroundColor Cyan
Write-Host "   Secrets will be encrypted (LocalMachine scope) and written to $SecretsDir`n"

# ---------------------------------------------------------------------------
# Read-DotEnv: parses the repo-root .env into a hashtable.
#   - Skips blank lines and lines starting with #
#   - Splits each remaining line on the FIRST = into key/value
#   - Strips a single layer of surrounding quotes from the value, if present
# Secrets stay in the git-ignored .env file and are never hardcoded here.
# (Copied verbatim from scripts/install-nssm-backend.ps1.)
# ---------------------------------------------------------------------------
function Read-DotEnv {
    param([string]$Path)
    $envVars = @{}
    if (-not (Test-Path $Path)) {
        Write-Host "   WARNING: .env not found at $Path -- forwarding no vars from it." -ForegroundColor Yellow
        return $envVars
    }
    Get-Content -Path $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
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

# ---------------------------------------------------------------------------
# Protect-Secret: DPAPI-encrypts a plaintext string using LocalMachine scope
# (NOT CurrentUser) so that ANY local administrator on this machine -- not
# just the exact account that ran this migration -- can later run
# reconfigure-secrets.ps1 successfully. See 03-RESEARCH.md Pitfall 2 for the
# CurrentUser cross-account decryption failure this deliberately avoids.
# Returns the base64-encoded ciphertext. Never logs the plaintext value.
# ---------------------------------------------------------------------------
function Protect-Secret {
    param([string]$PlaintextValue)
    [byte[]]$bytes = [System.Text.Encoding]::UTF8.GetBytes($PlaintextValue)
    [byte[]]$encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    return [Convert]::ToBase64String($encrypted)
}

# -- Step 1: Ensure C:\POS\secrets\ exists and is ACL-restricted -------------
Write-Host "[1/3] Preparing $SecretsDir ..."
if (-not (Test-Path $SecretsDir)) {
    New-Item -ItemType Directory -Path $SecretsDir -Force | Out-Null
    Write-Host "   Created $SecretsDir" -ForegroundColor Green
} else {
    Write-Host "   Directory already exists: $SecretsDir" -ForegroundColor Gray
}

# Restrict ACL to Administrators/SYSTEM only -- mirrors Plan 03-01's
# C:\POS\logs\ ACL restriction exactly.
icacls $SecretsDir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
Write-Host "   ACL restricted to Administrators/SYSTEM (icacls /inheritance:r)" -ForegroundColor Green

# -- Step 2: Read .env and encrypt every D-07-scoped secret present ---------
Write-Host "`n[2/3] Reading .env and encrypting D-07-scoped secrets..."
$DotEnv = Read-DotEnv -Path $EnvFile

# Exact D-07 scope (16 keys) -- every one of these present in .env is
# migrated. Order matches 03-CONTEXT.md D-07 / 03-03-PLAN.md interfaces.
$SecretKeys = @(
    'POSTGRES_PASSWORD',
    'SECRET_KEY',
    'JWT_REFRESH_SECRET',
    'ADMIN_PASSWORD',
    'ADMIN_PIN',
    'MANAGER_PASSWORD',
    'MANAGER_PIN',
    'WAITER1_PASSWORD',
    'WAITER2_PASSWORD',
    'KITCHEN_PASSWORD',
    'BARSTAFF_PASSWORD',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'TELEGRAM_TOKEN'
)

$migrated = @()
$skipped  = @()

foreach ($key in $SecretKeys) {
    $value = if ($DotEnv.ContainsKey($key)) { $DotEnv[$key] } else { $null }
    if ([string]::IsNullOrWhiteSpace($value)) {
        Write-Host "   SKIPPED: $key not set in .env" -ForegroundColor Yellow
        $skipped += $key
        continue
    }

    $encoded = Protect-Secret -PlaintextValue $value
    $datPath = Join-Path $SecretsDir "$key.dat"
    Set-Content -Path $datPath -Value $encoded -NoNewline
    Write-Host "   Encrypted: $key -> $datPath" -ForegroundColor Green
    $migrated += $key
}

# -- Step 3: Summary -----------------------------------------------------------
Write-Host "`n[3/3] Summary" -ForegroundColor Cyan
Write-Host "   Migrated ($($migrated.Count)/$($SecretKeys.Count)):" -ForegroundColor Green
foreach ($k in $migrated) { Write-Host "     - $k" -ForegroundColor Green }
if ($skipped.Count -gt 0) {
    Write-Host "   Skipped ($($skipped.Count)/$($SecretKeys.Count)) -- not set in .env:" -ForegroundColor Yellow
    foreach ($k in $skipped) { Write-Host "     - $k" -ForegroundColor Yellow }
}

Write-Host "`n=== Done! ==================================================" -ForegroundColor Cyan
Write-Host " Secrets are now DPAPI-encrypted (LocalMachine scope) under $SecretsDir"
Write-Host " Next step: run .\scripts\reconfigure-secrets.ps1 to wire these"
Write-Host " encrypted values into BilliardBarBackend/Scheduler/TelegramBot's"
Write-Host " AppEnvironmentExtra, replacing their reliance on .env for secrets."
Write-Host "============================================================"
