from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_jwt_extended import JWTManager
from flask_socketio import SocketIO
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

db = SQLAlchemy()
migrate = Migrate()
jwt = JWTManager()
socketio = SocketIO(cors_allowed_origins="*", async_mode='eventlet')
cors = CORS()
limiter = Limiter(key_func=get_remote_address)


@jwt.token_in_blocklist_loader
def check_if_token_revoked(jwt_header, jwt_payload):
    """Return True if the token has been revoked (user logged out)."""
    from app.models.token_blocklist import TokenBlocklist
    jti = jwt_payload.get('jti')
    if not jti:
        return False
    return db.session.query(
        TokenBlocklist.query.filter_by(jti=jti).exists()
    ).scalar()
