import uuid
from datetime import datetime, timezone
from app.extensions import db


class TipDistributionConfig(db.Model):
    """Single-row config for tip distribution percentages per role group."""
    __tablename__ = 'tip_distribution_config'

    id = db.Column(db.Integer, primary_key=True, default=1)
    floor_pct = db.Column(db.Integer, default=30)    # Waiters / Floor staff
    bar_pct = db.Column(db.Integer, default=40)      # Bar + Manager
    kitchen_pct = db.Column(db.Integer, default=30)  # Kitchen staff
    updated_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def to_dict(self):
        return {
            'floor_pct': self.floor_pct,
            'bar_pct': self.bar_pct,
            'kitchen_pct': self.kitchen_pct,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class CashSession(db.Model):
    __tablename__ = 'cash_sessions'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(10), default='OPEN')   # OPEN, CLOSED
    opening_fund_cents = db.Column(db.Integer, default=0)
    closing_cash_counted_cents = db.Column(db.Integer)
    opened_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    closed_by = db.Column(db.String(36), db.ForeignKey('users.id'))
    opened_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    closed_at = db.Column(db.DateTime(timezone=True))
    notes = db.Column(db.Text)

    opener = db.relationship('User', foreign_keys=[opened_by])
    closer = db.relationship('User', foreign_keys=[closed_by])
    expenses = db.relationship('Expense', backref='session', lazy='dynamic', cascade='all,delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'date': self.date.isoformat() if self.date else None,
            'status': self.status,
            'opening_fund_cents': self.opening_fund_cents,
            'closing_cash_counted_cents': self.closing_cash_counted_cents,
            'opened_by': self.opened_by,
            'closed_by': self.closed_by,
            'opened_at': self.opened_at.isoformat() if self.opened_at else None,
            'closed_at': self.closed_at.isoformat() if self.closed_at else None,
            'notes': self.notes,
        }


class Expense(db.Model):
    __tablename__ = 'expenses'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = db.Column(db.String(36), db.ForeignKey('cash_sessions.id'), nullable=False)
    amount_cents = db.Column(db.Integer, nullable=False)
    payment_method = db.Column(db.String(10), nullable=False)  # CASH, CARD
    payee = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=False)
    created_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    creator = db.relationship('User', foreign_keys=[created_by])

    def to_dict(self):
        return {
            'id': self.id,
            'session_id': self.session_id,
            'amount_cents': self.amount_cents,
            'payment_method': self.payment_method,
            'payee': self.payee,
            'description': self.description,
            'created_by': self.created_by,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }
