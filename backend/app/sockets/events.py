from flask_socketio import join_room, leave_room, emit
from flask_jwt_extended import decode_token
from app.extensions import socketio

# Rooms that any authenticated client may join
_PUBLIC_ROOMS = frozenset(('floor', 'kitchen', 'bar', 'waiting'))
# Rooms restricted to MANAGER / ADMIN only
_MANAGER_ROOMS = frozenset(('manager',))


@socketio.on('connect')
def on_connect(auth):
    pass  # Connection accepted; client joins rooms via 'join' event


@socketio.on('join')
def on_join(data):
    room = data.get('room', '')
    # Validate token for manager room access
    if room in _MANAGER_ROOMS:
        token = data.get('token', '')
        try:
            payload = decode_token(token)
            role = payload.get('sub') and payload.get('role', '')
            if role not in ('MANAGER', 'ADMIN'):
                emit('error', {'msg': 'Forbidden'})
                return
        except Exception:
            emit('error', {'msg': 'Unauthorized'})
            return
    # Allow public rooms and ticket-specific rooms
    if room in _PUBLIC_ROOMS or room.startswith('ticket:'):
        join_room(room)
        emit('joined', {'room': room})


@socketio.on('leave')
def on_leave(data):
    room = data.get('room')
    leave_room(room)


@socketio.on('disconnect')
def on_disconnect():
    pass
