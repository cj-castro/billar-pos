#!/usr/bin/env bash
# =============================================================================
# update.sh — pull the latest code, rebuild, and restart.
#
# Shell counterpart of deploy/update.ps1:
#   backup -> pull -> build -> restart -> health check
#
#   ./scripts/update.sh              # full update
#   ./scripts/update.sh --no-pull    # rebuild current checkout only
#   SKIP_BACKUP=1 ./scripts/update.sh
#
# Your data is not touched. The rebuild replaces container images only; the
# database lives in the pg_data volume, which is never removed here (no
# `down -v`). On boot the entrypoint re-runs init-db, seed.py and the migration
# baseline, all of which are idempotent: seed.py returns early once any user
# exists, and the squashed baseline is CREATE/ALTER ... IF NOT EXISTS with a
# guard that recognises an already-provisioned database.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

PULL=1
case "${1:-}" in
    --no-pull) PULL=0 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    "") ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

say()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

echo
echo "=== billar-pos UPDATE ==="
say "Project: $PROJECT_DIR"

[ -f .env ] || fail ".env not found. Copy .env.example to .env and fill it in."
docker info >/dev/null 2>&1 || fail "Docker daemon is not running."

# --- 1. backup -------------------------------------------------------------
say "Step 1/5: Backing up the database..."
if [ "${SKIP_BACKUP:-0}" = "1" ]; then
    echo "  SKIP_BACKUP=1 -- skipping."
elif ! docker compose ps -q postgres | grep -q .; then
    echo "  WARNING: postgres is not running; nothing to back up."
else
    if ! "$SCRIPT_DIR/backup.sh"; then
        echo "  WARNING: backup failed."
        read -r -p "  Continue without a backup? [y/N] " a
        [ "${a:-N}" = "y" ] || [ "${a:-N}" = "Y" ] || fail "Aborted by user."
    fi
fi

# --- 2. pull ---------------------------------------------------------------
say "Step 2/5: Pulling latest code..."
if [ "$PULL" = "0" ]; then
    echo "  --no-pull: using the current checkout."
elif [ -d .git ]; then
    if ! git pull --ff-only; then
        echo "  WARNING: git pull failed (local changes?). Using current code."
    fi
else
    echo "  Not a git checkout; skipping."
fi

# --- 3. build --------------------------------------------------------------
# Required, not optional: the backend image bakes in the source tree, so code
# changes do not reach a running container without a rebuild.
say "Step 3/5: Rebuilding images..."
docker compose build

# --- 4. restart ------------------------------------------------------------
say "Step 4/5: Restarting services..."
docker compose up -d --remove-orphans

# --- 5. health -------------------------------------------------------------
say "Step 5/5: Waiting for the backend to report healthy..."
HEALTHY=0
for _ in $(seq 1 40); do
    if curl -sf http://localhost:8080/api/v1/health >/dev/null 2>&1; then
        HEALTHY=1; break
    fi
    sleep 3
done

echo
if [ "$HEALTHY" = "1" ]; then
    say "Update complete — http://localhost:8080"
    echo "  Migration result:"
    docker compose logs backend 2>/dev/null | grep -iE 'Migrations: .*applied' | tail -1 \
        || echo "    (no migration summary in the current log window)"
else
    say "Backend did not report healthy in time."
    echo "  Inspect with: docker compose logs --tail=50 backend"
    echo "  Backups are in ./backups"
    exit 1
fi
