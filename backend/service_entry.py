"""
Native Windows service entrypoint for the BilliardBar backend.

NSSM (scripts/install-nssm-backend.ps1) launches this file directly with the
venv's pythonw.exe. It replicates backend/entrypoint.sh's idempotent Docker
startup sequence for a native Windows Service (D-05/D-06):

    1. flask init-db   (idempotent STEP-block schema setup)
    2. python seed.py  (idempotent demo/default data seeding)
    3. socketio.run()  (the long-lived process NSSM supervises, in-process --
                          NOT gunicorn, which cannot run natively on Windows)

Steps 1-2 use subprocess.run(..., check=True) so a failure raises and exits
this process non-zero; NSSM's AppExit Default Restart policy then retries the
whole sequence from the top, matching entrypoint.sh's fail-fast `set -e`
behavior.
"""
# Docker's `gunicorn --worker-class eventlet` used to call eventlet.monkey_patch()
# implicitly inside its own EventletWorker.init_process(). This native entrypoint
# runs socketio.run() directly with no gunicorn in between, so this process must
# do it explicitly (DATA-03) -- including psycopg2, which monkey_patch() alone
# does NOT cooperatively patch. Must run before any other import in this file.
import eventlet
eventlet.monkey_patch()
from eventlet.support import psycopg2_patcher
psycopg2_patcher.make_psycopg_green()

import os
import subprocess
import sys

# Resolve the backend directory regardless of NSSM's configured AppDirectory,
# so this script works no matter the working directory it's launched from.
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


def _run_step(args):
    subprocess.run(args, check=True, cwd=BACKEND_DIR, env=os.environ)


def main():
    # Step 1: flask init-db -- idempotent schema setup (relies on FLASK_APP
    # already being set in the service environment via NSSM's
    # AppEnvironmentExtra; no extra env wiring needed here).
    _run_step([sys.executable, '-m', 'flask', 'init-db'])

    # Step 2: seed.py -- idempotent demo/default data seeding.
    _run_step([sys.executable, 'seed.py'])

    # Step 3: start the backend in-process. This call blocks for the
    # lifetime of the service; NSSM supervises this process directly.
    from app import create_app
    from app.extensions import socketio

    app = create_app()
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)


if __name__ == '__main__':
    main()
