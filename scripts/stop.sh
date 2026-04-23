#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# stop.sh — Gracefully stop the Billiard Bar POS stack
# Usage:  ./scripts/stop.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stopping Billiard Bar POS..."
docker compose down
echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Stack stopped."
