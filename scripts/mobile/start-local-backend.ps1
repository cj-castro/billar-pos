# Starts postgres+backend+frontend (no scheduler/telegram) as isolated compose project "billarmobile". Idempotent.
# LOCAL DEV ONLY: secrets below are dev placeholders, never use in production.
param([int]$Port = 8090)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\..\.."
$env:FRONTEND_PORT = "$Port"
$env:SECRET_KEY = 'mobile-dev-secret-key'
$env:JWT_REFRESH_SECRET = 'mobile-dev-refresh-secret'
$env:POSTGRES_PASSWORD = 'mobile_dev_pg'
Push-Location $root
try {
  docker compose -p billarmobile up -d --build postgres backend frontend
  if ($LASTEXITCODE) { throw "docker compose up failed" }
} finally { Pop-Location }
Write-Host "Backend: http://localhost:$Port/api/v1  (emulator: http://10.0.2.2:$Port/api/v1)"
