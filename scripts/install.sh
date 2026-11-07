#!/usr/bin/env bash
# =============================================================================
# install.sh — first-time setup of billar-pos on a shell-based machine.
#
# Shell counterpart of deploy/install.ps1.
#
#   ./scripts/install.sh                      # demo data from seed.py
#   ./scripts/install.sh --dump prod.sql[.gz] # restore a real dump instead
#
# The dump is restored BEFORE the backend ever starts. That ordering is not
# cosmetic: the backend entrypoint runs init-db and the migration baseline on
# boot, and the data-shaping logic expects the real menu. Demo seed data is not
# a substitute for it.
#
# Safe to re-run. It never drops the database and never overwrites an existing
# .env; seed.py skips itself once any user exists.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

DUMP=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dump) DUMP="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

say()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

echo
echo "=== billar-pos INSTALL ==="
say "Project: $PROJECT_DIR"

# --- 1. prerequisites ------------------------------------------------------
say "Step 1/6: Checking prerequisites..."
command -v docker >/dev/null 2>&1 || fail "docker not found. Install Docker Engine."
docker compose version >/dev/null 2>&1 || fail "'docker compose' (v2) not available."
docker info >/dev/null 2>&1 || fail "Docker daemon is not running."
echo "  OK  $(docker --version)"

[ -n "$DUMP" ] && { [ -f "$DUMP" ] || fail "dump file not found: $DUMP"; }

# --- 2. environment --------------------------------------------------------
say "Step 2/6: Preparing .env..."
if [ -f .env ]; then
    echo "  .env already exists — leaving it untouched."
else
    [ -f .env.example ] || fail ".env.example is missing; cannot create .env."
    cp .env.example .env
    echo "  Created .env from .env.example."
    echo
    echo "  >> Edit .env before going live. At minimum set:"
    echo "       POSTGRES_PASSWORD, SECRET_KEY, JWT_REFRESH_SECRET,"
    echo "       ADMIN_PASSWORD, ADMIN_PIN, TZ, POOL_RATE_CENTS"
    echo
    read -r -p "  Press Enter once .env is filled in (Ctrl-C to abort)... " _
fi

# --- 3. build --------------------------------------------------------------
say "Step 3/6: Building images (this takes a few minutes)..."
docker compose build

# --- 4. database, before the backend boots ---------------------------------
say "Step 4/6: Starting PostgreSQL..."
docker compose up -d postgres

printf '  Waiting for PostgreSQL'
for _ in $(seq 1 60); do
    if docker compose exec -T postgres pg_isready -q 2>/dev/null; then break; fi
    printf '.'; sleep 2
done
echo
docker compose exec -T postgres pg_isready -q 2>/dev/null \
    || fail "PostgreSQL did not become ready."

if [ -n "$DUMP" ]; then
    say "  Restoring dump: $DUMP"
    DB="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"; DB="${DB:-billiardbar}"
    DBUSER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"; DBUSER="${DBUSER:-billiard}"
    if [ "${DUMP##*.}" = "gz" ]; then
        gunzip -c "$DUMP" | docker compose exec -T postgres psql -U "$DBUSER" -d "$DB" -q
    else
        docker compose exec -T postgres psql -U "$DBUSER" -d "$DB" -q < "$DUMP"
    fi
    echo "  Dump restored."
else
    echo "  No --dump given: seed.py will load demo data."
fi

# --- 5. start the rest -----------------------------------------------------
say "Step 5/6: Starting the stack..."
docker compose up -d --remove-orphans

# --- 6. health -------------------------------------------------------------
say "Step 6/6: Waiting for the backend to report healthy..."
HEALTHY=0
for _ in $(seq 1 40); do
    if curl -sf http://localhost:8080/api/v1/health >/dev/null 2>&1; then
        HEALTHY=1; break
    fi
    sleep 3
done

echo
if [ "$HEALTHY" = "1" ]; then
    say "Billar POS is running at http://localhost:8080"
    echo
    echo "  Next: create the pool-time promotion at /manager/promotions."
    echo "  Pick the cubetas from the dropdown -- menu UUIDs differ per install."
else
    say "Backend did not report healthy in time."
    echo "  Inspect with: docker compose logs --tail=50 backend"
    exit 1
fi
