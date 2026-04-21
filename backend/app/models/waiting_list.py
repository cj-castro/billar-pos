import uuid
from datetime import datetime, timezone
from app.extensions import db


class WaitingListEntry(db.Model):
    __tablename__ = 'waiting_list'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    party_name = db.Column(db.String(200), nullable=False)
    party_size = db.Column(db.Integer, default=1)
    notes = db.Column(db.Text)
    # WAITING → ASSIGNED | CANCELLED | NO_SHOW
    status = db.Column(db.String(20), nullable=False, default='WAITING')
    position = db.Column(db.Integer)          # 1-based queue order

    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    assigned_at = db.Column(db.DateTime(timezone=True))

    assigned_resource_id = db.Column(db.String(36), db.ForeignKey('resources.id'))
    assigned_ticket_id = db.Column(db.String(36), db.ForeignKey('tickets.id'))
    created_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)

    assigned_resource = db.relationship('Resource', foreign_keys=[assigned_resource_id])
    assigned_ticket = db.relationship('Ticket', foreign_keys=[assigned_ticket_id])
    creator = db.relationship('User', foreign_keys=[created_by])

    def to_dict(self):
        wait_seconds = None
        if self.status == 'WAITING':
            wait_seconds = int((datetime.now(timezone.utc) - self.created_at).total_seconds())
        return {
            'id': self.id,
            'party_name': self.party_name,
            'party_size': self.party_size,
            'notes': self.notes,
            'status': self.status,
            'position': self.position,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'assigned_at': self.assigned_at.isoformat() if self.assigned_at else None,
            'assigned_resource_id': self.assigned_resource_id,
            'assigned_resource_code': self.assigned_resource.code if self.assigned_resource else None,
            'assigned_ticket_id': self.assigned_ticket_id,
            'created_by_name': self.creator.name if self.creator else None,
            'wait_seconds': wait_seconds,
        }
