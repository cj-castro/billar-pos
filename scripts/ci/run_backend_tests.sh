#!/usr/bin/env bash
# Build a fresh scratch database and run the CI backend suite.
#
#   DATABASE_URL=postgresql://billiard:billiard@localhost:5432/billar_scratch \
#     scripts/ci/run_backend_tests.sh
#
# The database name must contain "scratch" (the DB tests refuse anything else)
# and must be empty: this runs init-db, seed.py and every migration.
set -euo pipefail
cd "$(dirname "$0")/../../backend"

: "${DATABASE_URL:?set DATABASE_URL to an empty *scratch* database}"
export FLASK_APP=wsgi.py

flask init-db
python seed.py
flask apply-migrations --strict

failed=()
while IFS= read -r mod; do
  echo "::group::$mod"
  if python -m "tests.$mod"; then echo "OK  $mod"; else failed+=("$mod"); fi
  echo "::endgroup::"
done < <(sed 's/#.*//' tests/ci_suite.txt | awk 'NF {print $1}')

if ((${#failed[@]})); then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "All backend CI tests passed."
