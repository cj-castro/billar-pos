"""Windows replacement for `gunicorn --worker-class eventlet -w 1 --worker-connections 1000 wsgi:app`.
Env: BACKEND_DIR (required), POS_BIND_HOST (default 127.0.0.1), POS_BIND_PORT (default 5000).
eventlet.monkey_patch() MUST run before anything else is imported."""
import eventlet
eventlet.monkey_patch()

import os  # noqa: E402
import sys  # noqa: E402

import eventlet.wsgi  # noqa: E402

backend = os.environ.get('BACKEND_DIR')
if not backend:
    sys.exit('serve_windows: BACKEND_DIR is required')
backend = os.path.abspath(backend)
sys.path.insert(0, backend)
os.chdir(backend)
from wsgi import app  # noqa: E402  (create_app())

host = os.environ.get('POS_BIND_HOST') or '127.0.0.1'
port = int(os.environ.get('POS_BIND_PORT') or 5000)
print(f"serve_windows: listening {host}:{port}", flush=True)
sock = eventlet.listen((host, port), backlog=1024)
# max_size == gunicorn --worker-connections
eventlet.wsgi.server(sock, app, max_size=1000, log_output=True, keepalive=True)
