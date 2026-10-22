#!/bin/bash
# End-to-end check of the backup sidecar against s3mock. Needs a running Docker.
#   bash backup/test/run-e2e.sh
# Tears down its containers, volumes and built image on exit.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
P=bkptest
dc() { docker compose -p "$P" -f docker-compose.e2e.yml "$@"; }
pass() { echo "PASS: $*"; }
die()  { echo "FAIL: $*"; exit 1; }
trap 'dc down -v --rmi local >/dev/null 2>&1' EXIT

dc up -d postgres s3 >/dev/null 2>&1 || die "up"
dc exec -T postgres sh -c 'until pg_isready -q -U billiard; do sleep 1; done'
dc exec -T postgres psql -q -U billiard -d billiardbar -c \
  "create table t as select g, md5(g::text) m from generate_series(1,50000) g" || die seed

# 1. container start -> catch-up uploads, then goes healthy
dc up -d --build backup >/dev/null 2>&1 || die "build/up backup"
sleep 15
dc logs backup | grep -E "catch-up|OK:" ; dc logs backup | grep -q "OK: " && pass "catch-up uploaded" || die "no catch-up upload"
sleep 6; echo "health: $(docker inspect -f '{{.State.Health.Status}}' ${P}-backup-1)"
[ "$(docker inspect -f '{{.State.Health.Status}}' ${P}-backup-1)" = healthy ] && pass healthy || die "not healthy"

# 2. manual run + downloaded object passes pg_restore --list
dc exec -T backup backup.sh || die "manual run"
KEY=$(dc exec -T backup sh -c 'aws s3 ls --recursive s3://testbucket' | awk 'END{print $4}' | tr -d '\r')
echo "latest key: $KEY"
dc exec -T backup sh -c "aws s3 cp --only-show-errors s3://testbucket/$KEY /tmp/dl.dump && pg_restore --list /tmp/dl.dump | grep -c 'TABLE DATA'" \
  | grep -q '^[1-9]' && pass "downloaded object passes pg_restore --list" || die "bad object"

# 3. cron job output reaches docker logs (crontab line is real; run it the way cron does)
dc exec -T backup sh -c 'cat /etc/crontabs/root; /usr/local/bin/backup.sh >/proc/1/fd/1 2>/proc/1/fd/2'
dc logs --tail 3 backup | grep -q "OK:" && pass "cron-style output visible in docker logs" || die "no log"

# 4. postgres down -> BACKUP FAILED, non-zero, marker unchanged
M1=$(dc exec -T backup stat -c %Y /var/lib/backup/last_success)
dc stop postgres >/dev/null
out=$(dc exec -T backup backup.sh 2>&1); rc=$?; echo "$out"
[ $rc -ne 0 ] && pass "non-zero exit ($rc) with postgres down" || die "exit 0"
echo "$out" | grep -q "BACKUP FAILED" && pass "BACKUP FAILED logged" || die "no failure line"
[ "$M1" = "$(dc exec -T backup stat -c %Y /var/lib/backup/last_success)" ] && pass "marker unchanged" || die "marker moved"
dc exec -T backup sh -c 'ls /tmp/billiardbar.* 2>&1' | grep -q "No such" && pass "temp file removed"

# 5. stale marker (27h old) -> unhealthy
dc exec -T backup touch -d "@$(( $(date +%s) - 97200 ))" /var/lib/backup/last_success
sleep 7; S=$(docker inspect -f '{{.State.Health.Status}}' ${P}-backup-1); echo "health: $S"
[ "$S" = unhealthy ] && pass "unhealthy when marker is 27h old" || die "expected unhealthy"

# 6. missing AWS env -> container exits with a clear message
docker run --rm --entrypoint "" -e POSTGRES_USER=u -e POSTGRES_PASSWORD=p -e POSTGRES_DB=d ${P}-backup /usr/local/bin/entrypoint.sh; rc=$?
[ $rc -ne 0 ] && pass "missing env exits $rc" || die "missing env did not exit"
