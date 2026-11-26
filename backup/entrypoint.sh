#!/bin/sh
# Container entrypoint: check env, catch up if the last backup is stale,
# then run crond in the foreground.
set -eu

MARKER=/var/lib/backup/last_success

log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') backup: $*"; }

missing=""
for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION S3_BUCKET \
         POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
    eval "[ -n \"\${$v:-}\" ]" || missing="$missing $v"
done
if [ -n "$missing" ]; then
    log "FATAL: missing required environment:$missing -- add to .env and recreate the container"
    # Only this container fails; the delay keeps restart: unless-stopped from hot-looping.
    sleep 60
    exit 1
fi

# No auto-logon on the bar PC: after a power cut the stack starts late, so
# the 02:00 run may have been missed. No success in 24h -> run now.
if [ -z "$(find "$MARKER" -mmin -1440 2>/dev/null)" ]; then
    log "no successful backup in the last 24h, running catch-up"
    backup.sh || log "catch-up failed, will retry at 02:00"
fi

# Job output goes to PID 1's stdout/stderr so `docker logs` shows it.
echo '0 2 * * * /usr/local/bin/backup.sh >/proc/1/fd/1 2>/proc/1/fd/2' > /etc/crontabs/root
log "scheduled daily at 02:00 ${TZ:-UTC}"
exec crond -f -l 8
