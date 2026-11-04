#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup.sh — Daily PostgreSQL dump for billiardbar
# Usage:  ./scripts/backup.sh
# Cron:   0 3 * * * /path/to/billiards/scripts/backup.sh >> /var/log/billiard_backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_DIR/backups"
KEEP_DAYS=7

# Load .env if present
[ -f "$PROJECT_DIR/.env" ] && export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)

DB="${POSTGRES_DB:-billiardbar}"
USER="${POSTGRES_USER:-billiard}"
# Resolve the container from compose rather than hardcoding a name: the project
# prefix follows the directory ("billar-pos-postgres-1"), so a literal name
# silently breaks the moment the folder is renamed or cloned elsewhere.
CONTAINER="$(cd "$PROJECT_DIR" && docker compose ps -q postgres)"
if [ -z "$CONTAINER" ]; then
    echo "ERROR: postgres container is not running; cannot back up." >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"

FILENAME="$BACKUP_DIR/${DB}_$(date +%Y%m%d_%H%M%S).sql.gz"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting backup → $FILENAME"

docker exec "$CONTAINER" pg_dump -U "$USER" "$DB" | gzip > "$FILENAME"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup complete. Size: $(du -sh "$FILENAME" | cut -f1)"

# Remove backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +$KEEP_DAYS -delete
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Old backups pruned (kept last $KEEP_DAYS days)."
