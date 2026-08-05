"""Daily report scheduler — runs as a separate Docker service.

Sends the daily sales report at 08:00 America/Mexico_City every day.
Shares the same DB connection settings as the backend but runs outside
gunicorn so there is no interference with the eventlet worker.
"""
import logging
import sys
from zoneinfo import ZoneInfo

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format='%(asctime)s [scheduler] %(levelname)s %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger(__name__)

# Build Flask app for DB access (uses same DATABASE_URL env var as backend)
from app import create_app  # noqa: E402 — import after logging setup

flask_app = create_app()


def send_report():
    with flask_app.app_context():
        try:
            from app.services.email_report_svc import generate_and_send_report
            generate_and_send_report()
        except Exception:
            log.exception("Daily report failed")


scheduler = BlockingScheduler(timezone=ZoneInfo('America/Mexico_City'))
scheduler.add_job(
    send_report,
    CronTrigger(hour=8, minute=0, timezone=ZoneInfo('America/Mexico_City')),
    id='daily_report',
    replace_existing=True,
)

log.info("Scheduler ready — daily report fires at 08:00 America/Mexico_City")

try:
    scheduler.start()
except (KeyboardInterrupt, SystemExit):
    log.info("Scheduler stopped")
