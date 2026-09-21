#!/bin/sh
set -e
export PYTHONUNBUFFERED=1

# Order matters and is not interchangeable:
#
#   1. init-db      legacy STEP 1..26. Must run first: STEP 16 lifts the legacy
#                   recipe table into insumos_base, and migration 029b (below)
#                   is what retires that legacy table afterwards.
#   2. seed.py      no-op unless the database has zero users.
#   3. migrations   versioned .sql files, 027 onward, in manifest order.
#
# apply-migrations deliberately exits 0 even when a migration fails. Each file
# is a single transaction, so a failure leaves the schema consistent at the last
# good migration and the POS keeps selling on it. Read the summary line it
# prints, or run `flask migration-status`, to see where it stopped.

echo "Creating database tables..."
flask init-db

echo "Seeding initial data..."
python seed.py

echo "Applying SQL migrations..."
flask apply-migrations

echo "Starting Gunicorn..."
exec gunicorn --worker-class eventlet -w 1 \
     --bind 0.0.0.0:5000 \
     --timeout 120 \
     --graceful-timeout 30 \
     --worker-connections 1000 \
     --log-file=- --access-logfile=- \
     wsgi:app
