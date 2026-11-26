import logging
from flask import request
from flask_socketio import join_room, leave_room, emit
from flask_jwt_extended import decode_token
from app.extensions import socketio

# Rooms that any authenticated client may join
_PUBLIC_ROOMS = frozenset(('floor', 'kitchen', 'bar', 'waiting'))
# Rooms restricted to MANAGER / ADMIN only
_MANAGER_ROOMS = frozenset(('manager',))

log = logging.getLogger(__name__)
# sid -> {'user_id', 'role'} for sockets that authenticated at handshake.
# ponytail: per-process dict; fine for the single-worker eventlet deploy.
_SESSIONS: dict = {}


@socketio.on('connect')
def on_connect(auth):
    # SEC-05: token in the handshake (auth.token or ?token=). Reject only when
    # a token is present AND invalid; anonymous connects stay allowed.
    token = (auth.get('token') if isinstance(auth, dict) else None) or request.args.get('token')
    if not token:
        return
    try:
        payload = decode_token(token)
    except Exception:
        return False
    _SESSIONS[request.sid] = {'user_id': payload.get('sub'), 'role': payload.get('role', '')}


@socketio.on('join')
def on_join(data):
    room = data.get('room', '')
    # Validate token for manager room access
    if room in _MANAGER_ROOMS:
        token = data.get('token', '')
        try:
            if token:
                log.warning('socket join: payload token is deprecated; send auth.token on connect')
                payload = decode_token(token)
                role = payload.get('sub') and payload.get('role', '')
            else:
                role = _SESSIONS.get(request.sid, {}).get('role', '')
                if not role:
                    raise ValueError('no session')
            if role not in ('MANAGER', 'ADMIN'):
                emit('error', {'msg': 'Forbidden'})
                return
        except Exception:
            emit('error', {'msg': 'Unauthorized'})
            return
        join_room(room)
        emit('joined', {'room': room})
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
    _SESSIONS.pop(request.sid, None)
