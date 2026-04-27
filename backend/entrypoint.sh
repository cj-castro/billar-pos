#!/bin/sh
set -e
export PYTHONUNBUFFERED=1

echo "Creating database tables..."
flask init-db

echo "Seeding initial data..."
python seed.py

echo "Starting Gunicorn..."
exec gunicorn --worker-class eventlet -w 1 \
     --bind 0.0.0.0:5000 \
     --log-file=- --access-logfile=- \
     wsgi:app
# #!/bin/sh
# set -euo pipefail
# trap 'echo "Entrypoint failed on line $LINENO"' ERR

# export PYTHONUNBUFFERED=1

# echo "Initializing database..."
# flask init-db || echo "Database already initialized"

# if [ "${SEED_DATA:-true}" = "true" ]; then
#   echo "Seeding initial data..."
#   python seed.py || echo "Seed step skipped"
# fi

# echo "Starting Gunicorn..."
# exec gunicorn \
#   --worker-class eventlet \
#   -w 1 \
#   --bind 0.0.0.0:5000 \
#   --log-file=- \
#   --access-logfile=- \
#   --graceful-timeout 30 \
#   --timeout 60 \
#   wsgi:app
