#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh — Start the Billiard Bar POS stack
# Usage:  ./scripts/start.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Billiard Bar POS..."

# Wait for Docker daemon to be available (useful on boot)
MAX_WAIT=60
WAITED=0
until docker info >/dev/null 2>&1; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: Docker daemon not available after ${MAX_WAIT}s. Aborting."
        exit 1
    fi
    echo "  Waiting for Docker... (${WAITED}s)"
    sleep 3
    WAITED=$((WAITED + 3))
done

docker compose up -d --remove-orphans

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stack started. Waiting for healthy state..."

# Wait for backend to respond
MAX_WAIT=60
WAITED=0
until curl -sf http://localhost:8080/api/v1/health >/dev/null 2>&1; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "WARNING: Backend did not become healthy after ${MAX_WAIT}s."
        break
    fi
    sleep 3
    WAITED=$((WAITED + 3))
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Billiard Bar POS is running at http://localhost:8080"


#  📁 scripts/ — new files

#   ┌─────────────────────────┬──────────────────────────────────────────────────────┐
#   │ File                    │ Purpose                                              │
#   ├─────────────────────────┼──────────────────────────────────────────────────────┤
#   │ start.sh                │ Waits for Docker, brings stack up, waits for healthy │
#   ├─────────────────────────┼──────────────────────────────────────────────────────┤
#   │ stop.sh                 │ Graceful docker compose down                         │
#   ├─────────────────────────┼──────────────────────────────────────────────────────┤
#   │ billiardbar.service     │ Systemd unit (WSL2 with systemd enabled)             │
#   ├─────────────────────────┼──────────────────────────────────────────────────────┤
#   │ install-autostart.ps1   │ Windows Task Scheduler (WSL2 without systemd)        │
#   └─────────────────────────┴──────────────────────────────────────────────────────┘

#   -----------------------------------------------------------------------------------------------------------------------------

#   🔁 How to set up autostart on the new machine

#   Option A — WSL2 with systemd (modern, recommended):

#    sudo cp scripts/billiardbar.service /etc/systemd/system/
#    # Edit the WorkingDirectory path first, then:
#    sudo systemctl enable billiardbar
#    sudo systemctl start billiardbar

#   Option B — Windows Task Scheduler (no systemd needed):

#    # In PowerShell as Administrator — edit the $wslPath inside first:
#    .\scripts\install-autostart.ps1

#   The containers also have restart: unless-stopped in docker-compose.yml, so if Docker is already running when Windows boots,
#   they'll come back up automatically even without these scripts.
