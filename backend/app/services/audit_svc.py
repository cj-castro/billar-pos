from app.extensions import db
from app.models.audit import AuditLog


def log(user_id, action, entity_type=None, entity_id=None,
        before=None, after=None, reason=None, ip_address=None):
    entry = AuditLog(
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id else None,
        before_state=before,
        after_state=after,
        reason=reason,
        ip_address=ip_address
    )
    db.session.add(entry)
    # committed with parent transaction
