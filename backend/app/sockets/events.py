from flask_socketio import join_room, leave_room, emit
from flask_jwt_extended import decode_token
from app.extensions import socketio


@socketio.on('connect')
def on_connect(auth):
    pass  # Connection accepted; client joins rooms after auth


@socketio.on('join')
def on_join(data):
    room = data.get('room')
    if room in ('floor', 'kitchen', 'bar', 'waiting') or room.startswith('ticket:'):
        join_room(room)
        emit('joined', {'room': room})


@socketio.on('leave')
def on_leave(data):
    room = data.get('room')
    leave_room(room)


@socketio.on('disconnect')
def on_disconnect():
    pass
