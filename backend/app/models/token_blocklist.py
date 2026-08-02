"""JWT token blocklist — stores revoked token JTIs so logout is effective."""
from datetime import datetime, timezone
from app.extensions import db


class TokenBlocklist(db.Model):
    __tablename__ = 'token_blocklist'

    id         = db.Column(db.Integer, primary_key=True, autoincrement=True)
    jti        = db.Column(db.String(36), nullable=False, unique=True, index=True)
    created_at = db.Column(db.DateTime(timezone=True),
                           default=lambda: datetime.now(timezone.utc), nullable=False)

    def __repr__(self):
        return f'<TokenBlocklist jti={self.jti}>'
