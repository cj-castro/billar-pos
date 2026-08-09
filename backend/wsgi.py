# Docker's `gunicorn --worker-class eventlet` used to call eventlet.monkey_patch()
# implicitly inside its own EventletWorker.init_process(). This native entrypoint
# runs socketio.run() directly with no gunicorn in between, so this process must
# do it explicitly (DATA-03) -- including psycopg2, which monkey_patch() alone
# does NOT cooperatively patch.
import eventlet
eventlet.monkey_patch()
from eventlet.support import psycopg2_patcher
psycopg2_patcher.make_psycopg_green()

from app import create_app
app = create_app()

if __name__ == '__main__':
    from app.extensions import socketio
    socketio.run(app, host='0.0.0.0', port=5000, debug=False)
