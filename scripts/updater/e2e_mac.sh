#!/usr/bin/env bash
# End-to-end test of the bar updater on the Mac, with real Docker.
#
#   scripts/updater/e2e_mac.sh            run every scenario, then clean up
#   scripts/updater/e2e_mac.sh --cleanup  only remove what an earlier run left
#
# What it does (details and expected output: scripts/updater/README.md):
#   - builds four image sets from the working tree, tagged with fake SHAs:
#       OLD    = the tree as it is
#       NEW    = OLD + throwaway migration 999_e2e_probe (creates table e2e_probe)
#       FAIL   = NEW + migration 999f_e2e_fail that raises
#       BROKEN = NEW with a backend entrypoint that writes one e2e_probe row and exits 1
#   - pushes them to a local registry (registry:2 on localhost:5001)
#   - starts compose project "billiards-e2e" from the OLD release's
#     docker-compose.bar.yml, with a copy (pg_dump) of the dev database
#   - runs `python -m updater run-now` inside the e2e updater for five
#     scenarios and checks the outcome, the database, the compose file and the
#     running images after each one
#   - removes everything it made (trap), and checks that the dev project
#     billar-pos was not touched
#
# Never touches the dev project billar-pos: the dev database is only read with
# pg_dump. Messages are only printed, unless E2E_POST_SLACK=1 (then they go to
# the webhook in E2E_SLACK_WEBHOOK_URL, prefixed "[PRUEBA Mac]").
#
# Environment (all optional):
#   E2E_ROOT        folder for the bar folder and build contexts
#                   (default: a new folder under /private/tmp)
#   E2E_LOG         copy of the output (default: /private/tmp/billiards-e2e-<time>.log)
#   E2E_KEEP=1      leave the stack running at the end (for debugging);
#                   remove it later with --cleanup
#   E2E_POST_SLACK=1 and E2E_SLACK_WEBHOOK_URL=<url>: post the messages
set -euo pipefail
set +x   # never trace: the .env may hold a webhook URL

# ------------------------------------------------------------------ settings

PROJECT="billiards-e2e"
REG="localhost:5001"
REG_PORT=5001
REGISTRY_CONTAINER="billiards-e2e-registry"
FRONTEND_PORT=18080
DEV_PG_CONTAINER="billar-pos-postgres-1"
DEV_DB="billiardbar"
DEV_PROJECT="billar-pos"
PGU="billiard"
PGDB="billiardbar"
PGPASS="e2e_only_secret"
TMP_IMAGE_PREFIX="billiards-e2e-tmp"
IMAGES="backend frontend telegram-bot backup updater release"
APP_SERVICES="backend frontend scheduler telegram-bot backup"

# Fake commit ids (40 hex characters each).
OLD="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
NEW="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
FAIL="cccccccccccccccccccccccccccccccccccccccc"
BROKEN="dddddddddddddddddddddddddddddddddddddddd"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# The guard: never run against the bar's project name or the dev project.
guard_project() {
  case "$PROJECT" in
    billiards|billar-pos|"")
      echo "REFUSED: compose project would be '$PROJECT'. This test only runs as billiards-e2e." >&2
      exit 2 ;;
  esac
  if ! printf '%s' "$PROJECT" | grep -Eq '^[a-z0-9][a-z0-9_-]*$'; then
    echo "REFUSED: invalid compose project name '$PROJECT'." >&2
    exit 2
  fi
}
guard_project

STARTED_ROOT=0
if [ -z "${E2E_ROOT:-}" ]; then
  E2E_ROOT=""
fi
BAR=""
WORK=""

# ------------------------------------------------------------------ helpers

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

dc() {
  docker compose -p "$PROJECT" -f "$BAR/docker-compose.bar.yml" --env-file "$BAR/.env" "$@"
}

cid_of() { dc ps -q "$1" 2>/dev/null | head -n1 || true; }

img_of() {
  local c
  c="$(cid_of "$1")"
  [ -n "$c" ] || { echo ""; return 0; }
  docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || echo ""
}

status_of() {
  local c
  c="$(cid_of "$1")"
  [ -n "$c" ] || { echo "none"; return 0; }
  docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "none"
}

health_of() {
  local c
  c="$(cid_of "$1")"
  [ -n "$c" ] || { echo "none"; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo "none"
}

sql() {   # sql "<statement>" [db]
  docker exec "$(cid_of postgres)" psql -X -v ON_ERROR_STOP=1 -U "$PGU" -d "${2:-$PGDB}" -tA -c "$1"
}

state_get() {   # state_get current_sha | failed.sha | ...
  python3 - "$BAR/updater/state.json" "$1" <<'PY'
import json, sys
try:
    v = json.load(open(sys.argv[1]))
except Exception:
    v = {}
for k in sys.argv[2].split("."):
    v = v.get(k) if isinstance(v, dict) else None
print("" if v is None else v)
PY
}

file_hash() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

frontend_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$FRONTEND_PORT/" || true; }

app_images() {
  local s
  for s in $APP_SERVICES; do printf '%s=%s ' "$s" "$(img_of "$s")"; done
}

app_cids() {
  local s
  for s in $APP_SERVICES; do printf '%s=%s ' "$s" "$(cid_of "$s")"; done
}

all_images_are() {   # all_images_are <sha>: every app service runs <sha>
  local s
  for s in $APP_SERVICES; do
    [ "$(img_of "$s")" = "$REG/billar-pos-$( [ "$s" = scheduler ] && echo backend || echo "$s"):$1" ] || return 1
  done
}


backups_count() { ls "$BAR/backups" 2>/dev/null | grep -c '^pre-update-' || true; }

contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }

# ----- scenario bookkeeping (bash 3.2: no associative arrays)
SUMMARY=""
ANY_FAIL=0
CUR=""
CUR_FAILS=0
CUR_CHECKS=0

begin() {
  CUR="$1"; CUR_FAILS=0; CUR_CHECKS=0
  echo
  echo "======================================================================"
  echo "$CUR"
  echo "======================================================================"
}

check() {   # check "<what>" <command...>
  local name="$1"; shift
  CUR_CHECKS=$((CUR_CHECKS + 1))
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $name"
  else
    echo "  FAIL: $name"
    CUR_FAILS=$((CUR_FAILS + 1))
  fi
}

finish() {
  local r="PASS"
  if [ "$CUR_FAILS" -gt 0 ]; then r="FAIL"; ANY_FAIL=1; fi
  echo "  => $r ($((CUR_CHECKS - CUR_FAILS))/$CUR_CHECKS checks)"
  SUMMARY="${SUMMARY}${r}  ${CUR} ($((CUR_CHECKS - CUR_FAILS))/$CUR_CHECKS checks)
"
}

# ----- updater commands
RUN_OUT=""
RUN_RC=0

run_now() {   # run_now [--force]: one updater run inside the e2e updater container
  local tries=0
  while :; do
    set +e
    RUN_OUT="$(dc exec -T updater python -m updater run-now "$@" 2>&1)"
    RUN_RC=$?
    set -e
    # 4 = another run holds the lock (the daemon's start-up check): wait, retry.
    if [ "$RUN_RC" -ne 4 ] || [ "$tries" -ge 12 ]; then break; fi
    tries=$((tries + 1))
    log "updater busy (exit 4); retrying in 10 s"
    sleep 10
  done
  echo "  --- updater run-now $* (exit $RUN_RC) ---"
  printf '%s\n' "$RUN_OUT" | sed 's/^/  | /'
  echo "  ---"
}

updater_status() { dc exec -T updater python -m updater status 2>&1 || true; }

promote() {   # point bar-stable of the release image at <sha> (what promote-to-bar does for the bar)
  docker pull -q "$REG/billar-pos-release:$1" >/dev/null
  docker tag "$REG/billar-pos-release:$1" "$REG/billar-pos-release:bar-stable"
  docker push -q "$REG/billar-pos-release:bar-stable" >/dev/null
  log "bar-stable -> ${1:0:7}"
}

wait_stack_healthy() {   # wait_stack_healthy <seconds>
  local deadline=$((SECONDS + $1))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(health_of backend)" = healthy ] && [ "$(frontend_code)" = 200 ] \
       && [ "$(status_of scheduler)" = running ] && [ "$(status_of telegram-bot)" = running ] \
       && [ "$(status_of updater)" = running ]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_updater_on() {   # wait_updater_on <sha> <seconds>: the updater container runs <sha> again
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(img_of updater)" = "$REG/billar-pos-updater:$1" ] && [ "$(status_of updater)" = running ] \
       && [ -z "$(docker ps -aq --filter "name=^${PROJECT}-updater-selfupdate$")" ]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# ----- dev project fingerprint (proves billar-pos was not touched)
dev_fingerprint() {
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$DEV_PROJECT" | sort)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker inspect -f '{{.Name}} {{.Id}} {{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' $ids | sort
  fi
  docker volume ls -q --filter "label=com.docker.compose.project=$DEV_PROJECT" | sort | sed 's/^/volume /'
}

# ------------------------------------------------------------------ cleanup

remove_e2e_images() {
  local imgs
  imgs="$(docker images --format '{{.Repository}}:{{.Tag}}' \
          | grep -E "^(${REG}/billar-pos-|${TMP_IMAGE_PREFIX}/)" | grep -v ':<none>$' || true)"
  if [ -n "$imgs" ]; then
    # shellcheck disable=SC2086
    docker rmi -f $imgs >/dev/null 2>&1 || true
  fi
}

cleanup_docker() {
  guard_project
  docker rm -f "${PROJECT}-rehearsal" "${PROJECT}-updater-selfupdate" >/dev/null 2>&1 || true
  if [ -n "$BAR" ] && [ -f "$BAR/docker-compose.bar.yml" ] && [ -f "$BAR/.env" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  # Anything of the project compose could not see (e.g. a half-made container).
  local left
  left="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
  # shellcheck disable=SC2086
  [ -z "$left" ] || docker rm -f -v $left >/dev/null 2>&1 || true
  left="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
  # shellcheck disable=SC2086
  [ -z "$left" ] || docker volume rm $left >/dev/null 2>&1 || true
  docker rm -f -v "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
  remove_e2e_images
}

DEV_BEFORE=""
cleanup() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  echo
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    log "E2E_KEEP=1: stack, registry and $E2E_ROOT left in place. Remove with: $0 --cleanup"
    exit "$rc"
  fi
  log "cleanup: docker compose -p $PROJECT down -v, registry, images, temp folders"
  cleanup_docker
  [ -n "$BAR" ] && rm -rf "$BAR"
  [ -n "$WORK" ] && rm -rf "$WORK"
  [ "$STARTED_ROOT" = 1 ] && [ -n "$E2E_ROOT" ] && rm -rf "$E2E_ROOT"
  echo "cleanup evidence:"
  echo "  containers of $PROJECT left: $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')"
  echo "  volumes of $PROJECT left   : $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')"
  echo "  registry container left    : $(docker ps -aq --filter "name=^${REGISTRY_CONTAINER}$" | wc -l | tr -d ' ')"
  echo "  e2e images left            : $(docker images --format '{{.Repository}}' | grep -cE "^(${REG}/billar-pos-|${TMP_IMAGE_PREFIX}/)" || true)"
  echo "  bar folder left            : $([ -n "$BAR" ] && [ -e "$BAR" ] && echo yes || echo no)"
  if [ -n "$DEV_BEFORE" ]; then
    local after
    after="$(dev_fingerprint)"
    if [ "$after" = "$DEV_BEFORE" ]; then
      echo "  dev project $DEV_PROJECT    : unchanged (same containers, start times, restart counts, volumes)"
    else
      echo "  dev project $DEV_PROJECT    : CHANGED -- before:"
      printf '%s\n' "$DEV_BEFORE" | sed 's/^/      /'
      echo "    after:"
      printf '%s\n' "$after" | sed 's/^/      /'
      [ "$rc" -eq 0 ] && rc=1
    fi
  fi
  exit "$rc"
}

if [ "${1:-}" = "--cleanup" ]; then
  log "removing what an earlier e2e run left (project $PROJECT, registry, images)"
  cleanup_docker
  log "done. Temp folders of earlier runs live under /private/tmp/billiards-e2e.* (remove by hand if present)."
  exit 0
fi
if [ $# -gt 0 ]; then
  sed -n '3,5p' "$0"
  exit 2
fi

# ------------------------------------------------------------------ preflight

if [ -z "$E2E_ROOT" ]; then
  E2E_ROOT="$(mktemp -d /private/tmp/billiards-e2e.XXXXXX)"
  STARTED_ROOT=1
fi
mkdir -p "$E2E_ROOT"
E2E_ROOT="$(cd "$E2E_ROOT" && pwd -P)"
BAR="$E2E_ROOT/e2e-bar"
WORK="$E2E_ROOT/e2e-work"
LOG_FILE="${E2E_LOG:-/private/tmp/billiards-e2e-$(date +%Y%m%d-%H%M%S).log}"
exec > >(tee -a "$LOG_FILE") 2>&1

log "bar updater end-to-end test (project $PROJECT, registry $REG)"
log "output copy: $LOG_FILE"

docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }
[ "$(docker inspect -f '{{.State.Running}}' "$DEV_PG_CONTAINER" 2>/dev/null)" = true ] \
  || { echo "The dev database container $DEV_PG_CONTAINER is not running (needed for the data copy)." >&2; exit 1; }
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ] \
   || [ -n "$(docker ps -aq --filter "name=^${REGISTRY_CONTAINER}$")" ]; then
  echo "Leftovers of an earlier run exist. Remove them first: $0 --cleanup" >&2
  exit 1
fi
for p in "$REG_PORT" "$FRONTEND_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p is in use; the test needs it free." >&2
    exit 1
  fi
done
if [ -e "$BAR" ] || [ -e "$WORK" ]; then
  echo "$BAR or $WORK already exists; the test needs fresh folders." >&2
  exit 1
fi
if [ "${E2E_POST_SLACK:-0}" = 1 ] && [ -z "${E2E_SLACK_WEBHOOK_URL:-}" ]; then
  echo "E2E_POST_SLACK=1 needs E2E_SLACK_WEBHOOK_URL." >&2
  exit 2
fi

# The daemon in the e2e updater runs an attempt at start-up when the local
# time is inside the 03:00-12:00 window; that would race the scenarios. Use
# America/Mexico_City unless it is (nearly) inside the window, then a fixed
# offset where it is mid-afternoon.
MX_HOUR=$((10#$(TZ=America/Mexico_City date +%H)))
if [ "$MX_HOUR" -ge 1 ] && [ "$MX_HOUR" -lt 12 ]; then
  UTC_HOUR=$((10#$(date -u +%H)))
  OFF=$(( ( (15 - UTC_HOUR + 12) % 24 + 24 ) % 24 - 12 ))
  if [ "$OFF" -gt 0 ]; then E2E_TZ="Etc/GMT-$OFF"; elif [ "$OFF" -lt 0 ]; then E2E_TZ="Etc/GMT+$((-OFF))"; else E2E_TZ="Etc/GMT"; fi
else
  E2E_TZ="America/Mexico_City"
fi

DEV_BEFORE="$(dev_fingerprint)"
trap cleanup EXIT
trap 'exit 130' INT TERM

log "bar folder (BAR_HOST_DIR): $BAR"
log "time zone for the e2e stack: $E2E_TZ"
mkdir -p "$BAR/backups" "$BAR/updater" "$WORK"

# ------------------------------------------------------------ build contexts

copy_backend() {   # copy_backend <dest>
  mkdir -p "$1"
  rsync -a --exclude '__pycache__' --exclude '.DS_Store' --exclude '*.pyc' "$REPO/backend/" "$1/"
}

copy_release_tools() {   # copy_release_tools <set dir>
  mkdir -p "$1/release"
  cp "$REPO/release/make_release.py" "$REPO/release/docker-compose.bar.template.yml" \
     "$REPO/release/Dockerfile" "$REPO/release/.dockerignore" "$1/release/"
}

add_migration() {   # add_migration <backend dir> <stem> <sql>
  printf '%s\n' "$3" > "$1/migrations/sql/$2.sql"
  printf '%s\n' "$2" >> "$1/migrations/sql/manifest.txt"
}

PROBE_SQL="-- 999_e2e_probe.sql: Mac end-to-end test only (scripts/updater/e2e_mac.sh).
-- Never in the repo. Creates the marker table e2e_probe with one row.
-- Depends on: 058
BEGIN;

DO \$\$ BEGIN
    IF NOT _applied('058') THEN RAISE EXCEPTION '058 must be applied before 999.'; END IF;
END \$\$;

CREATE TABLE IF NOT EXISTS e2e_probe (
    id         serial PRIMARY KEY,
    note       text NOT NULL,
    created_at timestamptz DEFAULT now()
);
INSERT INTO e2e_probe (note)
SELECT 'created by 999_e2e_probe' WHERE NOT EXISTS (SELECT 1 FROM e2e_probe);

INSERT INTO schema_migrations (version, name, notes)
VALUES ('999', 'e2e_probe', 'Mac end-to-end test marker table.')
ON CONFLICT (version) DO NOTHING;

DO \$done\$ BEGIN RAISE NOTICE '999 OK -- e2e_probe'; END \$done\$;

COMMIT;"

FAIL_SQL="-- 999f_e2e_fail.sql: Mac end-to-end test only. Fails on purpose.
-- Its version is 999f, not 999: the runner keys migrations by the stem before
-- the first '_', and 999 is already applied by the probe.
-- Depends on: 999
BEGIN;

DO \$\$ BEGIN
    IF NOT _applied('999') THEN RAISE EXCEPTION '999 must be applied before 999f.'; END IF;
END \$\$;

DO \$\$ BEGIN RAISE EXCEPTION 'e2e: 999f_e2e_fail fails on purpose'; END \$\$;

INSERT INTO schema_migrations (version, name, notes)
VALUES ('999f', 'e2e_fail', 'never reached')
ON CONFLICT (version) DO NOTHING;

COMMIT;"

BROKEN_ENTRYPOINT='#!/bin/sh
# Mac end-to-end test only: a backend that never becomes healthy. It writes
# one row into e2e_probe first, so the test can prove the rollback restored
# the database from the pre-update backup.
echo "e2e: BROKEN backend: writing one e2e_probe row, then exiting 1"
python -c "
import os, psycopg2
c = psycopg2.connect(os.environ[\"DATABASE_URL\"])
c.autocommit = True
c.cursor().execute(\"INSERT INTO e2e_probe (note) VALUES (%s)\", (\"written by the broken backend\",))
" || echo "e2e: could not write the marker row"
exit 1'

log "preparing build contexts in $WORK"
for set in old new fail broken; do
  copy_release_tools "$WORK/$set"
done
copy_backend "$WORK/old/backend"
copy_backend "$WORK/new/backend"
add_migration "$WORK/new/backend" "999_e2e_probe" "$PROBE_SQL"
copy_backend "$WORK/fail/backend"
add_migration "$WORK/fail/backend" "999_e2e_probe" "$PROBE_SQL"
add_migration "$WORK/fail/backend" "999f_e2e_fail" "$FAIL_SQL"
copy_backend "$WORK/broken/backend"
add_migration "$WORK/broken/backend" "999_e2e_probe" "$PROBE_SQL"
printf '%s\n' "$BROKEN_ENTRYPOINT" > "$WORK/broken/backend/entrypoint.sh"
chmod 755 "$WORK/broken/backend/entrypoint.sh"

sha_of_set() {
  case "$1" in old) echo "$OLD" ;; new) echo "$NEW" ;; fail) echo "$FAIL" ;; broken) echo "$BROKEN" ;; esac
}

# ------------------------------------------------------------------ registry

log "starting the local registry ($REGISTRY_CONTAINER on $REG)"
docker run -d --name "$REGISTRY_CONTAINER" -p "127.0.0.1:$REG_PORT:5000" registry:2 >/dev/null
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$REG_PORT/v2/" >/dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$REG_PORT/v2/" >/dev/null || { echo "local registry did not start" >&2; exit 1; }

# -------------------------------------------------------------------- images

build() {   # build <tag> <context> [extra docker build args...]
  local tag="$1" ctx="$2"; shift 2
  log "build $tag"
  docker build -q --provenance=false --sbom=false -t "$tag" "$@" "$ctx" >/dev/null
}

T0=$SECONDS
# Same for all four sets: built once, tagged four times.
build "$REG/billar-pos-frontend:$OLD" "$REPO/frontend" \
  --build-arg VITE_API_URL=/api/v1 --build-arg VITE_SOCKET_URL=/
build "$REG/billar-pos-backup:$OLD" "$REPO/backup"
build "$REG/billar-pos-updater:$OLD" "$REPO/updater"
# The real bot needs a Telegram token and would poll Telegram (a real token
# would steal the bar bot's updates). Build it to prove it builds, then run a
# stand-in on top of it that only stays up: the health check needs the
# telegram-bot container running.
build "$TMP_IMAGE_PREFIX/telegram-bot-real:e2e" "$REPO/telegram-bot"
log "build $REG/billar-pos-telegram-bot:$OLD (stand-in on top of the real image)"
printf 'FROM %s\nCMD ["sh", "-c", "echo e2e stand-in: the real bot is not started on the Mac test; exec sleep infinity"]\n' \
  "$TMP_IMAGE_PREFIX/telegram-bot-real:e2e" \
  | docker build -q --provenance=false --sbom=false -t "$REG/billar-pos-telegram-bot:$OLD" - >/dev/null

for set in old new fail broken; do
  sha="$(sha_of_set "$set")"
  build "$REG/billar-pos-backend:$sha" "$WORK/$set/backend"
  if [ "$set" != old ]; then
    for img in frontend backup updater telegram-bot; do
      docker tag "$REG/billar-pos-$img:$OLD" "$REG/billar-pos-$img:$sha"
    done
  fi
  python3 "$WORK/$set/release/make_release.py" --sha "$sha" --registry "$REG" --out "$WORK/$set/release" >/dev/null
  log "release $set: migrations $(python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["migrations"]; print(len(m), "up to", m[-1])' "$WORK/$set/release/release.json")"
  build "$REG/billar-pos-release:$sha" "$WORK/$set/release"
done
log "images built in $((SECONDS - T0)) s; pushing"
for set in old new fail broken; do
  sha="$(sha_of_set "$set")"
  for img in $IMAGES; do
    docker push -q "$REG/billar-pos-$img:$sha" >/dev/null
  done
done
# Drop the local tags: the stack and the updater must pull from the registry.
remove_e2e_images
log "pushed to $REG; local tags removed so every image comes from the registry"

# ------------------------------------------------------------ the bar folder

cp "$WORK/old/release/docker-compose.bar.yml" "$BAR/docker-compose.bar.yml"
SLACK_URL=""
PREFIX="[PRUEBA Mac]"
if [ "${E2E_POST_SLACK:-0}" = 1 ]; then
  SLACK_URL="$E2E_SLACK_WEBHOOK_URL"
  log "E2E_POST_SLACK=1: messages go to the webhook in E2E_SLACK_WEBHOOK_URL, prefixed $PREFIX"
else
  log "messages are printed only (no Slack, no Telegram)"
fi
# Values WITHOUT quotes: `docker run --env-file` (the rehearsal) keeps quotes literally.
umask 077
cat > "$BAR/.env" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT
BAR_HOST_DIR=$BAR
UPDATER_REGISTRY=$REG
GHCR_USER=
GHCR_TOKEN=
SLACK_WEBHOOK_URL=$SLACK_URL
TELEGRAM_TOKEN=
ADMIN_CHAT_ID=
UPDATER_MESSAGE_PREFIX=$PREFIX
TZ=$E2E_TZ
POSTGRES_USER=$PGU
POSTGRES_PASSWORD=$PGPASS
POSTGRES_DB=$PGDB
FRONTEND_PORT=$FRONTEND_PORT
SCHEDULED_REPORTS=off
SMTP_USER=
SMTP_PASSWORD=
PRINT_AGENT_URL=http://127.0.0.1:9
VENUE_NAME=Prueba e2e
EOF
umask 022
unset SLACK_URL
cat > "$BAR/updater/state.json" <<EOF
{"current_sha": "$OLD", "previous_sha": null, "in_progress": null, "last_result": null, "failed": null, "window_backup": null}
EOF

# ------------------------------------------------------- data copy + stack

DEV_MIGRATIONS="$(docker exec "$DEV_PG_CONTAINER" sh -c "psql -X -U \"\$POSTGRES_USER\" -d $DEV_DB -tA -c 'SELECT count(*) FROM schema_migrations'")"
log "pg_dump of the dev database $DEV_DB (read-only; $DEV_MIGRATIONS migrations recorded)"
docker exec "$DEV_PG_CONTAINER" sh -c "exec pg_dump -Fc -U \"\$POSTGRES_USER\" -d $DEV_DB" > "$WORK/dev.dump"
[ "$(wc -c < "$WORK/dev.dump")" -gt 1024 ] || { echo "dev dump is empty" >&2; exit 1; }

log "starting e2e postgres"
dc up -d postgres
for _ in $(seq 1 60); do
  [ "$(health_of postgres)" = healthy ] && break
  sleep 2
done
[ "$(health_of postgres)" = healthy ] || { echo "e2e postgres did not become healthy" >&2; exit 1; }
# Sanity: this is the e2e project's own container, not the dev one.
case "$(docker inspect -f '{{.Name}}' "$(cid_of postgres)")" in
  /"$PROJECT"-*) ;;
  *) echo "REFUSED: postgres container is not from project $PROJECT" >&2; exit 2 ;;
esac

log "restoring the copy into the e2e database (--no-owner --no-privileges)"
set +e
docker exec -i "$(cid_of postgres)" pg_restore --no-owner --no-privileges -U "$PGU" -d "$PGDB" < "$WORK/dev.dump" > "$WORK/restore.log" 2>&1
rc=$?
set -e
if [ "$rc" -gt 1 ]; then
  tail -5 "$WORK/restore.log"; echo "pg_restore failed (exit $rc)" >&2; exit 1
fi
[ "$(sql 'SELECT count(*) FROM schema_migrations')" = "$DEV_MIGRATIONS" ] \
  || { echo "the copy does not have the dev migrations" >&2; exit 1; }
# The copy must start with nothing open (the dev data may have an open drawer).
# Only the e2e copy is changed; triggers are skipped (replica role).
OPEN_BEFORE="$(sql "SELECT (SELECT count(*) FROM cash_sessions WHERE status='OPEN') || ' cash session(s), ' || (SELECT count(*) FROM tickets WHERE status='OPEN') || ' ticket(s)'")"
sql "SET session_replication_role = replica;
     UPDATE cash_sessions SET status='CLOSED', closed_at=COALESCE(closed_at, now()) WHERE status='OPEN';
     UPDATE tickets SET status='CANCELLED' WHERE status='OPEN';" >/dev/null
log "open in the dev copy: $OPEN_BEFORE -> closed in the e2e copy only"

log "starting the OLD stack (${OLD:0:7}) -- images pulled from $REG"
dc up -d --quiet-pull
log "waiting for the OLD stack to be healthy"
wait_stack_healthy 300 || { dc ps; echo "the OLD stack did not become healthy" >&2; exit 1; }
[ "$(dc exec -T updater printenv COMPOSE_PROJECT_NAME | tr -d '\r')" = "$PROJECT" ] \
  || { echo "REFUSED: the e2e updater does not see COMPOSE_PROJECT_NAME=$PROJECT" >&2; exit 2; }
all_images_are "$OLD" || { app_images; echo "the stack does not run OLD everywhere" >&2; exit 1; }
for _ in $(seq 1 30); do
  grep -q "updater daemon started" "$BAR/updater/updater.log" 2>/dev/null && break
  sleep 2
done
log "OLD stack healthy: $(dc ps --format '{{.Service}}={{.State}}' | tr '\n' ' ')"

# ================================================================= scenarios
# Order: 2 runs first (an update to NEW is waiting while the drawer is open),
# then 1 installs NEW, then 3, 4 and 5 start from NEW.

# ---------------------------------------------------------------- scenario 2
begin "Scenario 2: drawer open -> blocked_open, nothing changes"
promote "$NEW"
pre_compose="$(file_hash "$BAR/docker-compose.bar.yml")"
pre_images="$(app_images)"
pre_cids="$(app_cids)"
pre_backups="$(backups_count)"
USER_ID="$(sql "SELECT id FROM users ORDER BY id LIMIT 1")"
sql "INSERT INTO cash_sessions (id, date, status, opening_fund_cents, opened_by, opened_at, notes)
     VALUES ('e2e-open-drawer', current_date, 'OPEN', 0, '$USER_ID', now(), 'e2e scenario 2')" >/dev/null
run_now
check "run-now exits 3 (nothing done for now)" test "$RUN_RC" -eq 3
check "outcome is blocked_open" contains "$RUN_OUT" "outcome: blocked_open"
check "message text names the open drawer (pospuesta)" contains "$RUN_OUT" "pospuesta"
check "compose file unchanged" test "$(file_hash "$BAR/docker-compose.bar.yml")" = "$pre_compose"
check "running images unchanged (still OLD)" test "$(app_images)" = "$pre_images"
check "no container recreated" test "$(app_cids)" = "$pre_cids"
check "no backup taken" test "$(backups_count)" = "$pre_backups"
check "state still at OLD" test "$(state_get current_sha)" = "$OLD"
sql "DELETE FROM cash_sessions WHERE id='e2e-open-drawer'" >/dev/null
check "test drawer removed again" test "$(sql "SELECT count(*) FROM cash_sessions WHERE status='OPEN'")" = 0
finish

# ---------------------------------------------------------------- scenario 1
begin "Scenario 1: happy path OLD -> NEW, migration 999 applied"
check "before: 999 not applied" test "$(sql "SELECT count(*) FROM schema_migrations WHERE version='999'")" = 0
run_now
# The self-update can kill this exec (137) once the outcome is printed.
check "run-now exits 0 (or 137 from the self-update)" test "$RUN_RC" -eq 0 -o "$RUN_RC" -eq 137
check "updater container replaced and running on NEW (Ruling N)" wait_updater_on "$NEW" 240
STATUS_OUT="$(updater_status)"
printf '%s\n' "$STATUS_OUT" | sed 's/^/  status | /'
check "status: current version is NEW" contains "$STATUS_OUT" "current version : $NEW"
check "status: last result installed" contains "$STATUS_OUT" "last result     : installed"
check "state: previous version is OLD" test "$(state_get previous_sha)" = "$OLD"
MSG_SEEN="$RUN_OUT
$(grep 'message:' "$BAR/updater/updater.log" 2>/dev/null || true)"
check "message contains 'actualizado'" contains "$MSG_SEEN" "actualizado"
check "message has the [PRUEBA Mac] prefix" contains "$MSG_SEEN" "[PRUEBA Mac] POS actualizado"
check "migration 999 applied in the live database" test "$(sql "SELECT count(*) FROM schema_migrations WHERE version='999'")" = 1
check "marker table e2e_probe has its row" test "$(sql "SELECT count(*) FROM e2e_probe")" = 1
check "every app service runs NEW" all_images_are "$NEW"
check "backend healthy" test "$(health_of backend)" = healthy
check "frontend answers 200 on :$FRONTEND_PORT" test "$(frontend_code)" = 200
check "compose file names NEW" grep -q "billar-pos-backend:$NEW" "$BAR/docker-compose.bar.yml"
check "docker-compose.bar.yml.previous names OLD" grep -q "billar-pos-backend:$OLD" "$BAR/docker-compose.bar.yml.previous"
check "backup pre-update-${OLD:0:7}-to-${NEW:0:7}-*.dump written" \
  sh -c "ls '$BAR/backups' | grep -q '^pre-update-${OLD:0:7}-to-${NEW:0:7}-[0-9]\{8\}-[0-9]\{4\}\.dump$'"
check "scratch database billar_scratch_update dropped" test "$(sql "SELECT count(*) FROM pg_database WHERE datname='billar_scratch_update'" postgres)" = 0
finish

# ---------------------------------------------------------------- scenario 3
begin "Scenario 3: failing migration -> rehearsal_failed, live database untouched"
promote "$FAIL"
pre_compose="$(file_hash "$BAR/docker-compose.bar.yml")"
pre_cids="$(app_cids)"
pre_versions="$(sql "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
pre_tables="$(sql "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
pre_probe="$(sql "SELECT count(*) FROM e2e_probe")"
run_now
check "run-now exits 1 (failure)" test "$RUN_RC" -eq 1
check "outcome is rehearsal_failed" contains "$RUN_OUT" "outcome: rehearsal_failed"
check "message: El ensayo ... falló" contains "$RUN_OUT" "El ensayo de la actualización a ${FAIL:0:7} falló"
check "the error names the failing migration" contains "$RUN_OUT" "999f"
check "compose file unchanged" test "$(file_hash "$BAR/docker-compose.bar.yml")" = "$pre_compose"
check "no container recreated (still NEW)" test "$(app_cids)" = "$pre_cids"
check "every app service still runs NEW" all_images_are "$NEW"
check "live schema_migrations unchanged (no 999f)" test "$(sql "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")" = "$pre_versions"
check "live table count unchanged" test "$(sql "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "$pre_tables"
check "live e2e_probe unchanged" test "$(sql "SELECT count(*) FROM e2e_probe")" = "$pre_probe"
check "scratch database dropped" test "$(sql "SELECT count(*) FROM pg_database WHERE datname='billar_scratch_update'" postgres)" = 0
check "rehearsal container removed" test -z "$(docker ps -aq --filter "name=^${PROJECT}-rehearsal$")"
check "state: FAIL is held (failed.sha)" test "$(state_get failed.sha)" = "$FAIL"
check "state: current version still NEW" test "$(state_get current_sha)" = "$NEW"
run_now
check "second run without --force: outcome held (Ruling O)" contains "$RUN_OUT" "outcome: held"
finish

# ---------------------------------------------------------------- scenario 4
begin "Scenario 4: backend never healthy -> rolled_back, database restored"
promote "$BROKEN"
pre_compose="$(file_hash "$BAR/docker-compose.bar.yml")"
pre_probe="$(sql "SELECT count(*) FROM e2e_probe")"
pre_versions="$(sql "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
pre_updater="$(cid_of updater)"
log "this scenario can take up to the 5-minute health budget plus the rollback"
T4=$SECONDS
run_now
log "scenario 4 run took $((SECONDS - T4)) s"
check "run-now exits 1 (failure)" test "$RUN_RC" -eq 1
check "outcome is rolled_back" contains "$RUN_OUT" "outcome: rolled_back"
check "message: Se regresó a NEW" contains "$RUN_OUT" "Se regresó a ${NEW:0:7}"
check "marker row count equals pre-update ($pre_probe)" test "$(sql "SELECT count(*) FROM e2e_probe")" = "$pre_probe"
check "the broken backend did write (its rows are in the set-aside copy ${PGDB}_failed)" \
  test "$(sql "SELECT count(*) FROM e2e_probe" "${PGDB}_failed" 2>/dev/null || echo 0)" -gt "$pre_probe"
check "live schema_migrations equals pre-update" test "$(sql "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")" = "$pre_versions"
check "compose file back to the NEW one" test "$(file_hash "$BAR/docker-compose.bar.yml")" = "$pre_compose"
check "every app service runs NEW (the old version) again" all_images_are "$NEW"
check "backend healthy" test "$(health_of backend)" = healthy
check "frontend answers 200" test "$(frontend_code)" = 200
check "updater not replaced (no self-update on failure)" test "$(cid_of updater)" = "$pre_updater"
check "state: BROKEN is held as rolled_back" test "$(state_get failed.sha)/$(state_get failed.outcome)" = "$BROKEN/rolled_back"
check "state: current version still NEW, nothing in progress" test "$(state_get current_sha)/$(state_get in_progress)" = "$NEW/"
finish

# ---------------------------------------------------------------- scenario 5
begin "Scenario 5: same version -> noop"
promote "$NEW"
pre_compose="$(file_hash "$BAR/docker-compose.bar.yml")"
pre_cids="$(app_cids)"
pre_backups="$(backups_count)"
run_now
check "run-now exits 0" test "$RUN_RC" -eq 0
check "outcome is noop" contains "$RUN_OUT" "outcome: noop"
check "no message sent" sh -c "! printf '%s' \"\$1\" | grep -q '^message:'" _ "$RUN_OUT"
check "compose file unchanged" test "$(file_hash "$BAR/docker-compose.bar.yml")" = "$pre_compose"
check "no container recreated" test "$(app_cids)" = "$pre_cids"
check "no backup taken" test "$(backups_count)" = "$pre_backups"
finish

# ------------------------------------------------------------------- summary
echo
echo "======================================================================"
echo "SUMMARY"
echo "======================================================================"
printf '%s' "$SUMMARY"
if [ "$ANY_FAIL" = 0 ]; then
  echo "ALL SCENARIOS PASS"
else
  echo "SOME SCENARIOS FAILED"
fi
exit "$ANY_FAIL"
