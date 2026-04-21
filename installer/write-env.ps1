param(
    [string]$DBHost,
    [string]$DBPort,
    [string]$DBName,
    [string]$DBUser,
    [string]$DBPass
)

$dir = Join-Path $env:APPDATA "BilliardBarPOS"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$url = "postgresql://${DBUser}:${DBPass}@${DBHost}:${DBPort}/${DBName}"

$content = @"
DATABASE_URL=$url
SECRET_KEY=desktop-secret-key-change-me
JWT_REFRESH_SECRET=desktop-refresh-secret-change-me
LOG_LEVEL=INFO
"@

Set-Content -Path (Join-Path $dir ".env") -Value $content -Encoding UTF8
