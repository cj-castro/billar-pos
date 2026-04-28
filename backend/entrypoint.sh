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
