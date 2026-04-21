import uuid
from app.extensions import db

class Resource(db.Model):
    __tablename__ = 'resources'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code = db.Column(db.String(20), unique=True, nullable=False)
    name = db.Column(db.String(100), nullable=False)
    type = db.Column(db.String(20), nullable=False)  # POOL_TABLE, REGULAR_TABLE, BAR_SEAT
    status = db.Column(db.String(20), default='AVAILABLE')  # AVAILABLE, IN_USE, INACTIVE
    is_active = db.Column(db.Boolean, default=True)
    sort_order = db.Column(db.Integer, default=0)

    pool_config = db.relationship('PoolTableConfig', backref='resource', uselist=False)
    tickets = db.relationship('Ticket', backref='resource', lazy='dynamic')

    def to_dict(self, include_timer=False):
        d = {
            'id': self.id,
            'code': self.code,
            'name': self.name,
            'type': self.type,
            'status': self.status,
            'is_active': self.is_active,
            'sort_order': self.sort_order,
        }
        if self.type == 'POOL_TABLE' and self.pool_config:
            d['pool_config'] = self.pool_config.to_dict()
        return d


class PoolTableConfig(db.Model):
    __tablename__ = 'pool_table_configs'

    resource_id = db.Column(db.String(36), db.ForeignKey('resources.id'), primary_key=True)
    billing_mode = db.Column(db.String(20), default='PER_MINUTE')
    rate_cents = db.Column(db.Integer, nullable=False, default=8600)  # pesos per hour
    promo_free_minutes = db.Column(db.Integer, default=0)

    def to_dict(self):
        return {
            'billing_mode': self.billing_mode,
            'rate_cents': self.rate_cents,
            'promo_free_minutes': self.promo_free_minutes
        }
