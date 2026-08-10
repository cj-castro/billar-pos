"""Background worker that automatically retries FAILED print jobs before a
human ever needs to tap the manual retry banner. Runs as an eventlet
greenlet via socketio.start_background_task — see the note in
tickets.py::_spawn_auto_print_chit about why threading.Thread is unsafe
here (single eventlet worker, cooperative scheduling)."""
from datetime import datetime, timedelta, timezone

_BACKOFF_SECONDS = [5, 30, 120]
_MAX_JOB_AGE_MINUTES = 10


def _rebuild_payload(job, ticket_model, ticket_line_item_model):
    """Reconstruct the print payload for a FAILED job from its source row.
    Returns (endpoint, payload) or (None, None) if the source row is gone."""
    if job.type in ('RECEIPT', 'REPRINT'):
        ticket = ticket_model.query.get(job.ticket_id)
        if not ticket:
            return None, None
        payload = ticket.to_dict()
        if job.type == 'REPRINT':
            payload['reprint'] = True
        payload['job_id'] = job.id
        return '/print', payload

    if job.type == 'CHIT':
        item = ticket_line_item_model.query.get(job.queue_item_id)
        if not item:
            return None, None
        mod_map: dict = {}
        mult = max(1, int(item.quantity or 1))
        for m in item.modifiers:
            name = m.modifier.name if hasattr(m, 'modifier') and m.modifier else getattr(m, 'name', '?')
            mod_map[name] = mod_map.get(name, 0) + mult
        payload = {
            'job_id': job.id,
            'type': item.routing_dest,
            'resource_code': (item.ticket.resource.code if item.ticket and item.ticket.resource else '?'),
            'items': [{
                'quantity': item.quantity,
                'name': (item.menu_item.name if item.menu_item else getattr(item, 'item_name', '?')),
                'modifiers': [{'name': k, 'count': v} for k, v in mod_map.items()],
                'notes': item.notes or '',
            }],
            'sent_at': item.sent_at.isoformat() if item.sent_at else '',
        }
        return '/chit', payload

    return None, None


def run_retry_cycle(app):
    """One pass over eligible FAILED jobs."""
    from app.extensions import db, socketio
    from app.models.print_job import PrintJob
    from app.models.ticket import Ticket, TicketLineItem
    from app.services.print_client import send_print_job

    with app.app_context():
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=_MAX_JOB_AGE_MINUTES)
        jobs = PrintJob.query.filter(
            PrintJob.status == 'FAILED',
            PrintJob.created_at >= cutoff,
            PrintJob.retry_count < len(_BACKOFF_SECONDS),
        ).all()

        for job in jobs:
            endpoint, payload = _rebuild_payload(job, Ticket, TicketLineItem)
            if not payload:
                continue

            ok, error_code, error_message = send_print_job(endpoint, payload)
            job.retry_count += 1
            if ok:
                job.status = 'PRINTED'
                job.printed_at = datetime.now(timezone.utc)
                job.error_msg = None
                job.error_code = None
            else:
                job.error_msg = error_message
                job.error_code = error_code
            db.session.commit()

            if not ok:
                continue

            if job.type == 'CHIT' and job.queue_item_id:
                item = TicketLineItem.query.get(job.queue_item_id)
                if item:
                    item.needs_reprint = False
                    db.session.commit()
                    room = item.routing_dest.lower()
                    socketio.emit(f'{room}:item_update',
                                  {'item_id': job.queue_item_id, 'needs_reprint': False},
                                  room=room)
            socketio.emit('print:retry_succeeded', {'job_id': job.id}, room='manager')


def start(app, socketio) -> None:
    """Schedule run_retry_cycle on a repeating background greenlet."""
    def _loop():
        import eventlet
        while True:
            eventlet.sleep(_BACKOFF_SECONDS[0])
            try:
                run_retry_cycle(app)
            except Exception as exc:  # noqa: BLE001
                app.logger.warning(f'print_retry_svc cycle failed: {exc}')

    socketio.start_background_task(_loop)
