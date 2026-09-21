#!/usr/bin/env bash
# ============================================================================
# run_all.sh — apply every migration in manifest order, stopping on first error.
#
# The order lives in manifest.txt, shared with Invoke-Migrations.ps1 and
# `flask apply-migrations`, so the three runners cannot drift apart.
#
# Each file guards on its predecessor via schema_migrations, so out-of-order
# application fails loudly rather than half-working. Every file is idempotent:
# re-running is safe and is the normal way to verify state.
#
#   ./run_all.sh                                          # local docker db
#   PG="psql -U billiard -d billiardbar" ./run_all.sh      # direct
#   PG="docker exec -i rehearsal-pg psql -U billiard -d rehearsal" ./run_all.sh
#
# ⚠️ ALWAYS take a dump first:
#   docker exec billar-pos-postgres-1 pg_dump -U billiard -d billiardbar \
#     --clean --if-exists > backups/pre-migration-$(date +%Y%m%d-%H%M%S).sql
#   Use `psql -f`, never PowerShell redirection — it writes UTF-16 and psql then
#   fails with misleading "relation does not exist" errors.
#
# THIS SCRIPT IS FOR THE MAC. On the Windows POS use Invoke-Migrations.ps1 —
# it copies the files into the container instead of piping them through the
# PowerShell pipeline, which mangles accented characters. See
# docs/DEPLOY-WINDOWS.md.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PG="${PG:-docker exec -i billar-pos-postgres-1 psql -U billiard -d billiardbar}"

# Strip comments and blanks from the manifest.
# Deliberately NOT `mapfile`: macOS ships bash 3.2, where mapfile does not
# exist, and this script's whole purpose is the Phase 0 rehearsal on the Mac.
FILES=()
while IFS= read -r line; do
  FILES+=("$line")
done < <(sed 's/#.*//' manifest.txt | awk 'NF {print $1}')

# `${FILES[@]}` on an empty array trips `set -u` in bash 3.2, so check first.
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "manifest.txt yielded no migrations — refusing to continue."; exit 1
fi

echo "${#FILES[@]} migrations in manifest"
echo

for f in "${FILES[@]}"; do
  if [ ! -f "$f.sql" ]; then
    printf '%-36s MISSING FILE\n' "$f"; exit 1
  fi
  printf '%-36s' "$f"
  if out=$($PG -v ON_ERROR_STOP=1 < "$f.sql" 2>&1); then
    echo "$out" | grep -oE 'NOTICE:  [0-9]+[a-z]? OK.*' | head -1 || echo "OK"
  else
    echo "FAILED"; echo "$out" | grep -E 'ERROR|HINT' | head -4; exit 1
  fi
done

echo
echo "=== invariants (all must be 0) ==="
$PG -tA <<'SQL'
SELECT 'drift               : '||count(*) FROM v_ledger_reconciliation WHERE is_drifted;
SELECT 'chain breaks        : '||count(*) FROM fn_ledger_scan_chain();
SELECT 'unresolved warnings : '||count(*) FROM ledger_violations WHERE resolved_at IS NULL;
SELECT 'double deductions   : '||count(*) FROM v_recipe_modifier_overlap;
SELECT 'modifier gaps       : '||count(*) FROM v_modifier_coverage_gaps;
SELECT 'legacy recipe rows  : '||count(*) FROM menu_item_ingredients;
SQL

echo
echo "NEXT: restart the backend and re-run the invariants. init-db STEP 16 is the"
echo "      one step that can silently undo migration 032, so restart-survival is"
echo "      a required check, not an optional one."
