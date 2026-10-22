#!/bin/sh
# backup.sh -- one pg_dump -Fc of the POS database, uploaded to S3.
# Run by crond (02:00), by entrypoint.sh (catch-up) and by hand:
#   docker compose exec backup backup.sh
# Success touches $MARKER; failure leaves it alone and exits non-zero.
set -eu

MARKER=/var/lib/backup/last_success
LOCK=/var/lib/backup/lock
MIN_BYTES=10240
TMP=""

log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') backup: $*"; }
fail() { log "BACKUP FAILED: $*"; exit 1; }
cleanup() { [ -z "$TMP" ] || rm -f "$TMP"; }
trap cleanup EXIT

# One run at a time (cron vs. manual vs. catch-up).
exec 9>"$LOCK"
flock -n 9 || fail "another backup is already running"

KEY="${S3_PREFIX:-billiardbar}/billiardbar_$(date +%Y-%m-%d_%H%M).dump"
TMP="$(mktemp /tmp/billiardbar.XXXXXX)"
export PGPASSWORD="$POSTGRES_PASSWORD"

log "dumping $POSTGRES_DB"
pg_dump -Fc -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$TMP" \
    || fail "pg_dump exited non-zero"

SIZE="$(wc -c < "$TMP")"
[ "$SIZE" -gt "$MIN_BYTES" ] || fail "dump is only $SIZE bytes (need > $MIN_BYTES)"
pg_restore --list "$TMP" > /dev/null || fail "pg_restore --list rejected the dump"

# Write-only IAM key: upload, never list or read back. No ACL flags.
aws s3 cp --only-show-errors "$TMP" "s3://$S3_BUCKET/$KEY" \
    || fail "upload to s3://$S3_BUCKET/$KEY failed"

touch "$MARKER"
log "OK: $SIZE bytes -> s3://$S3_BUCKET/$KEY"
