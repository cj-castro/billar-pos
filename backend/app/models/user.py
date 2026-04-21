import uuid
from datetime import datetime, timezone
from app.extensions import db
import bcrypt

class User(db.Model):
    __tablename__ = 'users'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username = db.Column(db.String(50), unique=True, nullable=False)
    name = db.Column(db.String(100), nullable=False)
    role = db.Column(db.String(20), nullable=False)  # WAITER, KITCHEN_STAFF, BAR_STAFF, MANAGER, ADMIN
    pin_hash = db.Column(db.String(255))
    password_hash = db.Column(db.String(255), nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def set_password(self, password: str):
        self.password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

    def check_password(self, password: str) -> bool:
        return bcrypt.checkpw(password.encode(), self.password_hash.encode())

    def set_pin(self, pin: str):
        self.pin_hash = bcrypt.hashpw(pin.encode(), bcrypt.gensalt()).decode()

    def check_pin(self, pin: str) -> bool:
        if not self.pin_hash:
            return False
        return bcrypt.checkpw(pin.encode(), self.pin_hash.encode())

    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'name': self.name,
            'role': self.role,
            'is_active': self.is_active,
            'has_pin': bool(self.pin_hash),
            'created_at': self.created_at.isoformat() if self.created_at else None
        }
