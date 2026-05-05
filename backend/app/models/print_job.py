import uuid
from app.extensions import db


class PrintJob(db.Model):
    """Tracks every print attempt so failures can be retried safely and
    manager notifications can reference a stable job ID."""
    __tablename__ = 'print_jobs'

    id            = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    ticket_id     = db.Column(db.String(36), db.ForeignKey('tickets.id', ondelete='SET NULL'), nullable=True)
    queue_item_id = db.Column(db.String(36), db.ForeignKey('ticket_line_items.id', ondelete='SET NULL'), nullable=True)
    # RECEIPT — first print of a ticket
    # REPRINT  — manager-authorised second+ print
    # CHIT     — kitchen/bar command slip
    type          = db.Column(db.String(20), nullable=False)
    # PENDING → SENT → PRINTED | FAILED
    status        = db.Column(db.String(20), nullable=False, default='PENDING')
    requested_by  = db.Column(db.String(36), nullable=True)   # user.id
    error_msg     = db.Column(db.Text, nullable=True)
    retry_count   = db.Column(db.Integer, default=0)
    created_at    = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    printed_at    = db.Column(db.DateTime(timezone=True), nullable=True)

    def to_dict(self):
        return {
            'id':            self.id,
            'ticket_id':     self.ticket_id,
            'queue_item_id': self.queue_item_id,
            'type':          self.type,
            'status':        self.status,
            'retry_count':   self.retry_count,
            'error_msg':     self.error_msg,
            'created_at':    self.created_at.isoformat() if self.created_at else None,
            'printed_at':    self.printed_at.isoformat() if self.printed_at else None,
        }
