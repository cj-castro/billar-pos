#!/usr/bin/env bash
# macOS counterpart of start-local-backend.ps1 (no Docker): Homebrew Postgres 17 + a Python venv + Flask on :8090.
# Mirrors the compose project "billarmobile": same DB/role names, same dev secrets, same boot order as
# backend/entrypoint.sh (init-db -> seed.py -> factory-finalize -> apply-migrations -> serve). Idempotent / re-runnable.
# LOCAL DEV ONLY: secrets below are dev placeholders, never use in production.
#
# Usage: scripts/mobile/start-local-backend.sh [port]      (default 8090)
# Stop:  kill "$(cat .local-backend/backend.pid)"
set -euo pipefail

PORT="${1:-8090}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/backend"
STATE="$ROOT/.local-backend"          # git-ignored: pid + log
VENV="$STATE/venv"                    # git-ignored (kept out of backend/)
PG_PREFIX="/opt/homebrew/opt/postgresql@17"
PSQL="$PG_PREFIX/bin/psql"

# Role/password match the .ps1 / docker-compose. The DB is NOT named "billiardbar" here: on a dev Mac that name
# is commonly a restored copy of production data (owned by the human user) which this script must never seed or
# migrate. Override with BILLAR_LOCAL_DB if you really want another name.
PG_DB="${BILLAR_LOCAL_DB:-billiardbar_mobile}"; PG_USER="billiard"; PG_PASS="mobile_dev_pg"
export DATABASE_URL="postgresql://$PG_USER:$PG_PASS@localhost:5432/$PG_DB"
export SECRET_KEY="mobile-dev-secret-key"
export JWT_REFRESH_SECRET="mobile-dev-refresh-secret"
export FLASK_APP="wsgi.py" FLASK_ENV="production" TZ="America/Mexico_City" CURRENCY="MXN"
export BILLING_MODE="PER_MINUTE" POOL_RATE_CENTS="150" PYTHONUNBUFFERED=1
# Seed credentials: compose defaults (the .ps1 does not override them).
export ADMIN_PASSWORD="admin123" ADMIN_PIN="1234" MANAGER_PASSWORD="manager123" MANAGER_PIN="5678"
export WAITER1_PASSWORD="waiter123" WAITER2_PASSWORD="waiter123" KITCHEN_PASSWORD="kitchen123" BARSTAFF_PASSWORD="bar123"
export PRINT_AGENT_URL="http://127.0.0.1:9191"

mkdir -p "$STATE"

# --- 1. Postgres (Homebrew) ---------------------------------------------------
if ! "$PG_PREFIX/bin/pg_isready" -q -h localhost; then
  brew services start postgresql@17
  for _ in $(seq 1 30); do "$PG_PREFIX/bin/pg_isready" -q -h localhost && break; sleep 1; done
fi
"$PG_PREFIX/bin/pg_isready" -h localhost

SUPER_DB="postgres"
if ! "$PSQL" -d "$SUPER_DB" -Atc "select 1" >/dev/null 2>&1; then SUPER_DB="$(whoami)"; fi
if [ "$("$PSQL" -d "$SUPER_DB" -Atc "select 1 from pg_roles where rolname='$PG_USER'")" != "1" ]; then
  "$PSQL" -d "$SUPER_DB" -v ON_ERROR_STOP=1 -c "CREATE ROLE $PG_USER LOGIN PASSWORD '$PG_PASS'"
else
  "$PSQL" -d "$SUPER_DB" -v ON_ERROR_STOP=1 -c "ALTER ROLE $PG_USER LOGIN PASSWORD '$PG_PASS'"
fi
if [ "$("$PSQL" -d "$SUPER_DB" -Atc "select 1 from pg_database where datname='$PG_DB'")" != "1" ]; then
  "$PSQL" -d "$SUPER_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $PG_DB OWNER $PG_USER"
fi

# --- 2. Python venv -----------------------------------------------------------
# requirements.txt pins (eventlet 0.36, greenlet 3.0, psycopg2-binary 2.9.9) may not build on the newest
# Python; fall back to Homebrew python@3.12 when the default interpreter can't install them.
make_venv() { rm -rf "$VENV"; "$1" -m venv "$VENV" && "$VENV/bin/pip" install -q --disable-pip-version-check -r "$BACKEND/requirements.txt"; }
if [ ! -x "$VENV/bin/python" ] || ! "$VENV/bin/python" -c "import flask, eventlet, psycopg2" 2>/dev/null; then
  PY312="/opt/homebrew/opt/python@3.12/bin/python3.12"
  if [ -x "$PY312" ]; then
    make_venv "$PY312"
  elif ! make_venv python3; then
    echo "requirements failed on $(python3 --version); installing python@3.12" >&2
    brew install python@3.12
    make_venv "$PY312"
  fi
fi

# --- 3. Schema + seed (same order as backend/entrypoint.sh) -------------------
cd "$BACKEND"
"$VENV/bin/flask" init-db
"$VENV/bin/python" seed.py            # no-op unless the users table is empty
"$VENV/bin/flask" factory-finalize
"$VENV/bin/flask" apply-migrations

# --- 4. Serve on 0.0.0.0:$PORT (replaces any previous instance) ---------------
if [ -f "$STATE/backend.pid" ] && kill -0 "$(cat "$STATE/backend.pid")" 2>/dev/null; then
  kill "$(cat "$STATE/backend.pid")" || true; sleep 1
fi
nohup "$VENV/bin/python" - "$PORT" >"$STATE/backend.log" 2>&1 <<'PY' &
import sys
import eventlet
eventlet.monkey_patch()
from eventlet.support import psycopg2_patcher
psycopg2_patcher.make_psycopg_green()
from app import create_app
from app.extensions import socketio
socketio.run(create_app(), host="0.0.0.0", port=int(sys.argv[1]), debug=False)
PY
echo $! >"$STATE/backend.pid"

for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT/api/v1/health" >/dev/null && break; sleep 1; done
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
echo "Backend: http://localhost:$PORT/api/v1  (simulator: http://localhost:$PORT, device: http://${LAN_IP:-<mac-lan-ip>}:$PORT)"
echo "Log: $STATE/backend.log  PID: $(cat "$STATE/backend.pid")"
