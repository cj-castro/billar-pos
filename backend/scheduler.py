"""Report scheduler — runs as a separate Docker service.

  * daily sales report     every day at 08:00
  * purchase forecast      every Sunday at 10:00 (batch E3) — what to buy for
                           the coming week, by email (the Telegram bot sends
                           its own copy at the same time)

Times are in the venue's timezone (Ajustes → Negocio, batch D1), read at start.
Set SCHEDULED_REPORTS=off to schedule nothing (e.g. a test or copy install that
must not email the owner). Shares the backend's DB settings but runs outside
gunicorn so there is no interference with the eventlet worker.
"""
import logging
import os
import sys

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


def send_purchase_forecast():
    with flask_app.app_context():
        try:
            from app.services.purchase_svc import send_weekly_email
            send_weekly_email()
        except Exception:
            log.exception("Weekly purchase forecast failed")


if os.environ.get('SCHEDULED_REPORTS', 'on').strip().lower() in ('off', 'false', '0', 'no'):
    log.info("SCHEDULED_REPORTS=off — no reports will be sent from this install")
    import time
    while True:                      # stay up (restart: unless-stopped) but do nothing
        time.sleep(3600)

with flask_app.app_context():
    from app.services.venue_svc import bar_tz
    tz = bar_tz()

purchase_hour = int(os.environ.get('PURCHASE_FORECAST_HOUR', '10'))

scheduler = BlockingScheduler(timezone=tz)
scheduler.add_job(send_report, CronTrigger(hour=8, minute=0, timezone=tz),
                  id='daily_report', replace_existing=True)
scheduler.add_job(send_purchase_forecast,
                  CronTrigger(day_of_week='sun', hour=purchase_hour, minute=0, timezone=tz),
                  id='weekly_purchase_forecast', replace_existing=True)

log.info("Scheduler ready (%s) — daily report 08:00; purchase forecast Sundays %02d:00", tz, purchase_hour)

try:
    scheduler.start()
except (KeyboardInterrupt, SystemExit):
    log.info("Scheduler stopped")
