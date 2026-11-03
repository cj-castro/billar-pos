#!/usr/bin/env bash
# =============================================================================
# verify_clean_install.sh -- rehearse a single-run clean install.
#
# Provisions a THROWAWAY database, runs the exact entrypoint.sh chain against
# it, asserts the result, and drops it. The production database is only ever
# read (row counts, before and after) and never written.
#
#   ./scripts/verify_clean_install.sh
#   KEEP_DB=1 ./scripts/verify_clean_install.sh     # leave the scratch DB for inspection
#
# Exits non-zero if the chain order breaks, the runner fails to start, the
# integer-cents guard fails, or production row counts move.
#
# NOTE: with the full 28-file manifest and demo seed data, the data-shaping
# migrations (029b/031*/032*/034*/035b) are EXPECTED to fail -- they assert
# against the real menu, which seed.py does not create. That is documented
# behaviour, not a regression. This script fails only on structural problems.
# When the manifest is squashed to a single 001_baseline_squash, expect
# "1 applied, 0 failed".
# =============================================================================
set -euo pipefail

PROD_DB="${POSTGRES_DB:-billiardbar}"
DB_USER="${POSTGRES_USER:-billiard}"
DB_PASS="${POSTGRES_PASSWORD:-billiard_secret}"
TEST_DB="${TEST_DB:-billiardbar_cleantest}"

if [ "$TEST_DB" = "$PROD_DB" ]; then
  echo "REFUSING: scratch database name equals production ($PROD_DB)." >&2
  exit 2
fi

psql_prod() { docker compose exec -T postgres psql -U "$DB_USER" -d "$PROD_DB" -tAc "$1"; }
psql_admin() { docker compose exec -T postgres psql -U "$DB_USER" -d postgres -tAc "$1"; }
psql_test() { docker compose exec -T postgres psql -U "$DB_USER" -d "$TEST_DB" -tAc "$1"; }
in_backend() {
  docker compose exec -T \
    -e DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@postgres:5432/${TEST_DB}" \
    backend "$@"
}

fail=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

cleanup() {
  if [ "${KEEP_DB:-0}" = "1" ]; then
    echo "KEEP_DB=1 -- leaving $TEST_DB in place."
    return
  fi
  psql_admin "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "0. production baseline (read-only)"
PROD_TICKETS_BEFORE=$(psql_prod "SELECT count(*) FROM tickets;")
PROD_ITEMS_BEFORE=$(psql_prod "SELECT count(*) FROM menu_items;")
echo "  $PROD_DB: ${PROD_TICKETS_BEFORE} tickets, ${PROD_ITEMS_BEFORE} menu items"

step "1. provision a throwaway database"
psql_admin "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);" >/dev/null
psql_admin "CREATE DATABASE ${TEST_DB} TEMPLATE template0;" >/dev/null
[ "$(psql_admin "SELECT 1 FROM pg_database WHERE datname='${TEST_DB}';")" = "1" ] \
  && ok "created $TEST_DB" || bad "could not create $TEST_DB"

step "2. entrypoint chain, in order"
# The order below mirrors backend/entrypoint.sh exactly and is not interchangeable.
if in_backend flask init-db        >/tmp/ci_1.log 2>&1; then ok "1/4 flask init-db";        else bad "1/4 flask init-db";        tail -5 /tmp/ci_1.log; fi
if in_backend python seed.py       >/tmp/ci_2.log 2>&1; then ok "2/4 python seed.py";       else bad "2/4 python seed.py";       tail -5 /tmp/ci_2.log; fi
if in_backend flask factory-finalize >/tmp/ci_3.log 2>&1; then ok "3/4 flask factory-finalize"; else bad "3/4 flask factory-finalize"; tail -5 /tmp/ci_3.log; fi
if in_backend flask apply-migrations >/tmp/ci_4.log 2>&1; then ok "4/4 flask apply-migrations"; else bad "4/4 flask apply-migrations"; tail -5 /tmp/ci_4.log; fi

step "3. migration runner outcome"
MANIFEST_COUNT=$(in_backend python -c \
  "from app.migrations_runner import read_manifest; print(len(read_manifest()))" 2>/dev/null | tr -d '\r')
echo "  manifest entries: ${MANIFEST_COUNT:-?}"
if grep -q 'MIGRATION RUNNER FAILED TO START' /tmp/ci_4.log; then
  bad "runner failed to start"; grep -A3 'FAILED TO START' /tmp/ci_4.log
else
  ok "runner started"
fi
SUMMARY=$(grep -E '^Migrations: ' /tmp/ci_4.log || echo 'Migrations: (no summary)')
echo "  $SUMMARY"
APPLIED=$(sed -n 's/^Migrations: \([0-9]*\) applied.*/\1/p' /tmp/ci_4.log)
FAILED=$(sed -n 's/.*already present, \([0-9]*\) failed.*/\1/p' /tmp/ci_4.log)
[ -n "${APPLIED:-}" ] && ok "parsed summary (applied=${APPLIED} failed=${FAILED:-?})" \
                      || bad "no migration summary line"

# Pass criteria differ by manifest shape, so this script validates the squash
# goal honestly instead of rubber-stamping either outcome:
#
#   SQUASHED (1 entry)  -- a baseline must NOT assert against production menu
#                          data, so it has to apply cleanly on a demo seed.
#                          Required: applied=1, failed=0.
#   SEQUENTIAL (many)   -- the data-shaping files legitimately refuse to run
#                          against demo data (see migrations_runner docstring).
#                          Their failure here is expected and not a defect; a
#                          real install restores a production dump instead.
SQUASHED=0
[ "${MANIFEST_COUNT:-0}" = "1" ] && SQUASHED=1

if [ "$SQUASHED" = "1" ]; then
  [ "${APPLIED:-0}" = "1" ] && ok "squashed baseline applied" \
                            || bad "squashed baseline did not apply (applied=${APPLIED:-0})"
  [ "${FAILED:-1}" = "0" ] && ok "squashed baseline reported no failures" \
                           || bad "squashed baseline failed (failed=${FAILED:-?})"
else
  echo "  NOTE: sequential manifest on demo seed data -- data-shaping"
  echo "        migrations are EXPECTED to fail here (documented in"
  echo "        app/migrations_runner.py). Real installs restore a dump."
fi

step "4. schema_migrations bookkeeping"
if [ "$(psql_test "SELECT to_regclass('public.schema_migrations') IS NOT NULL;")" = "t" ]; then
  ok "schema_migrations exists"
  RECORDED=$(psql_test "SELECT count(*) FROM schema_migrations;")
  echo "  recorded versions: $RECORDED"
  DUPES=$(psql_test "SELECT count(*) FROM (SELECT version FROM schema_migrations GROUP BY 1 HAVING count(*)>1) d;")
  [ "$DUPES" = "0" ] && ok "no duplicate version rows" || bad "duplicate version rows: $DUPES"
  if [ "$SQUASHED" = "1" ] && [ "${RECORDED:-0}" != "1" ]; then
    bad "squashed baseline should record exactly 1 version, found ${RECORDED:-0}"
  fi
elif [ "$SQUASHED" = "1" ]; then
  bad "schema_migrations missing after a squashed baseline"
else
  # 027 aborts at its wrong-database guard before CREATE TABLE, so nothing is
  # recorded. Correct for demo data -- and precisely what a squash would fix.
  echo "  NOTE: absent because the first migration aborted on its"
  echo "        wrong-database guard before creating the table. Expected"
  echo "        on demo seed data; a squashed baseline would create it."
fi

step "5. re-run is a no-op (idempotence)"
in_backend flask apply-migrations >/tmp/ci_5.log 2>&1 || true
RE_APPLIED=$(sed -n 's/^Migrations: \([0-9]*\) applied.*/\1/p' /tmp/ci_5.log)
[ "${RE_APPLIED:-x}" = "0" ] && ok "second run applied 0 migrations" \
                             || bad "second run re-applied ${RE_APPLIED:-?} (not idempotent)"

step "6. integer-cents guard on the fresh schema"
if in_backend python -m tests.test_money_columns >/tmp/ci_6.log 2>&1; then
  ok "$(tail -1 /tmp/ci_6.log)"
else
  bad "integer-cents guard failed"; grep '^FAIL' /tmp/ci_6.log || tail -5 /tmp/ci_6.log
fi

step "7. production database untouched"
PROD_TICKETS_AFTER=$(psql_prod "SELECT count(*) FROM tickets;")
PROD_ITEMS_AFTER=$(psql_prod "SELECT count(*) FROM menu_items;")
[ "$PROD_TICKETS_BEFORE" = "$PROD_TICKETS_AFTER" ] \
  && ok "tickets unchanged ($PROD_TICKETS_AFTER)" \
  || bad "tickets moved: $PROD_TICKETS_BEFORE -> $PROD_TICKETS_AFTER"
[ "$PROD_ITEMS_BEFORE" = "$PROD_ITEMS_AFTER" ] \
  && ok "menu_items unchanged ($PROD_ITEMS_AFTER)" \
  || bad "menu_items moved: $PROD_ITEMS_BEFORE -> $PROD_ITEMS_AFTER"

printf '\n'
if [ "$fail" = "0" ]; then
  echo "CLEAN INSTALL BASELINE: OK"
else
  echo "CLEAN INSTALL BASELINE: FAILED"
fi
exit "$fail"
