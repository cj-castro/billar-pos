from datetime import date, datetime
from decimal import Decimal

from app.extensions import db
from app.models.audit import AuditLog


def _jsonable(value):
    """Make before/after states storable in the JSON columns.

    Costs are NUMERIC since migration 044, so a state like
    {'unit_cost_cents': item.unit_cost_cents} carries a Decimal -- which the JSON
    encoder rejects, failing the WHOLE transaction (a restock crashed on it).
    Converting here protects every caller instead of each one remembering to.
    """
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def log(user_id, action, entity_type=None, entity_id=None,
        before=None, after=None, reason=None, ip_address=None):
    entry = AuditLog(
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id else None,
        before_state=_jsonable(before),
        after_state=_jsonable(after),
        reason=reason,
        ip_address=ip_address
    )
    db.session.add(entry)
    # committed with parent transaction
