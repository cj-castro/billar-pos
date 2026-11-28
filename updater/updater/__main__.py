"""CLI: python -m updater status | check | run-now | daemon

  status   what is installed, the last result, recent backups (reads files only)
  check    what an update would do now (pulls the release image; changes nothing)
  run-now  one update attempt now, ignoring the 03:00 schedule
           --force: first clear a hold (a version that failed, or any version
           after a failed rollback), then run
  daemon   the container's main process: resume, then every night at 03:00

Exit codes for run-now: 0 installed/resumed_ok/noop, 3 nothing done for now
(blocked_open, registry_down, db_unreachable, older_than_db, held), 1 failure,
4 another run is going, 2 usage.
"""
import json
import logging
import logging.handlers
import os
import sys
import time
from datetime import datetime

from . import core, run
from .notify import notify
from .ops import Ops, Runner
from .redact import redact

# Ruling K: fixed paths inside the updater container.
STATE_PATH = "/bar/updater/state.json"
LOG_PATH = "/bar/updater/updater.log"
BACKUP_DIR = "/bar/backups"
LOCK_PATH = "/tmp/bar-updater.lock"
# Must be visible through the /bar mount (BAR_HOST_DIR); checked at daemon start.
BAR_REQUIRED_FILES = ("/bar/.env", "/bar/docker-compose.bar.yml")

USAGE = "usage: python -m updater status | check | run-now [--force] | daemon"
OK_KINDS = ("installed", "resumed_ok", "noop")
WAIT_KINDS = ("blocked_open", "registry_down", "db_unreachable", "older_than_db", "held")

log = logging.getLogger("updater")


class _RedactFilter(logging.Filter):
    """Defence in depth: no token or webhook value reaches a log line."""

    def __init__(self, env):
        super().__init__()
        self.env = env

    def filter(self, record):
        try:
            record.msg = redact(record.getMessage(), self.env)
            record.args = None
        except Exception:
            pass
        return True


def setup_logging(env, to_file):
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    handlers = [logging.StreamHandler(sys.stderr)]
    if to_file:
        try:
            os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
            handlers.append(logging.handlers.RotatingFileHandler(
                LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8"))
        except OSError as e:
            print("log file %s not available: %s" % (LOG_PATH, e), file=sys.stderr)
    for h in handlers:
        h.setFormatter(fmt)
        h.addFilter(_RedactFilter(env))
        root.addHandler(h)


def exit_code(outcome):
    if outcome in OK_KINDS:
        return 0
    if outcome in WAIT_KINDS:
        return 3
    return 1


def make_notifier(env, echo=False):
    prefix = (env.get("UPDATER_MESSAGE_PREFIX") or "").strip()

    def send(text):
        text = ("%s %s" % (prefix, text)) if prefix else text
        log.info("message: %s", text)
        if echo:
            print("message: " + redact(text, env))
        notify(text, env)
    return send


def make_ops():
    return Ops(Runner())


def cmd_status(env):
    tz = run.local_tz(env)
    st = run._load_state(STATE_PATH)
    print("current version : %s" % (st.current_sha or "unknown"))
    print("previous version: %s" % (st.previous_sha or "unknown"))
    print("last result     : %s" % (st.last_result or "none"))
    print("in progress     : %s" % (json.dumps(st.in_progress) if st.in_progress else "no"))
    f = st.failed
    if f:
        if isinstance(f, dict):
            held = {"rollback_failed": "ALL versions (last rollback failed)",
                    "resume_held": "ALL versions (an interrupted update needs a check; nothing was restored)",
                    }.get(f.get("outcome"), "version %s" % (f.get("sha") or "?"))
            print("HELD            : %s; outcome %s at %s" % (held, f.get("outcome"), f.get("at")))
            print("  backup to restore (on the PC): %s" % (f.get("host_backup_path") or f.get("backup_path")))
        else:
            print("HELD            : %r" % (f,))
        print("  clear with: python -m updater run-now --force")
    try:
        names = sorted(n for n in os.listdir(BACKUP_DIR) if n.startswith("pre-update-"))
    except OSError:
        names = []
    print("pre-update backups: %d" % len(names))
    for n in names[-3:]:
        print("  " + n)
    print("next run        : %s" % run.next_run_at(datetime.now(tz)).isoformat())
    return 0


def cmd_check(env):
    info = run.check_update(make_ops(), env, STATE_PATH)
    for k, v in info.items():
        print("%-18s: %s" % (k, redact(str(v), env)))
    return 0


def cmd_run_now(env, force=False):
    tz = run.local_tz(env)
    report = {}
    try:
        with run.run_lock(LOCK_PATH, wait=False):
            outcome = run.run_update(make_ops(), env, STATE_PATH, datetime.now(tz),
                                     make_notifier(env, echo=True), report=report, force=force,
                                     now_fn=lambda: datetime.now(tz))
    except run.Busy:
        print("another update run is in progress; try again later")
        return 4
    except Exception as e:
        log.error("run-now failed before any change: %s", redact(repr(e), env))
        print("outcome: error")
        return 1
    if outcome in run.DEFERRED and report.get("message"):
        print("message (not sent, retried hourly by the daemon): " + report["message"])
    print("outcome: " + outcome)
    return exit_code(outcome)


def cmd_daemon(env):
    tz = run.local_tz(env)
    send = make_notifier(env)

    def now_fn():
        return datetime.now(tz)

    def run_once(now):
        with run.run_lock(LOCK_PATH, wait=True):
            report = {}
            outcome = run.run_update(make_ops(), env, STATE_PATH, now, send, report=report, now_fn=now_fn)
            return outcome, report.get("message")

    def resume_pending():
        return bool(run._load_state(STATE_PATH).in_progress)

    log.info("updater daemon started; time zone %s; next run %s",
             getattr(tz, "key", tz), run.next_run_at(now_fn()).isoformat())
    run.check_bar_folder(BAR_REQUIRED_FILES, send)
    run.daemon(run_once, now_fn, time.sleep, send, resume_pending=resume_pending)
    return 0


COMMANDS = {"status": cmd_status, "check": cmd_check, "run-now": cmd_run_now, "daemon": cmd_daemon}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    force = argv[1:] == ["--force"] and argv[:1] == ["run-now"]
    if not argv or argv[0] not in COMMANDS or (len(argv) != 1 and not force):
        print(USAGE, file=sys.stderr)
        return 2
    env = dict(os.environ)
    if not logging.getLogger().handlers:
        setup_logging(env, to_file=argv[0] in ("run-now", "daemon"))
    if force:
        return cmd_run_now(env, force=True)
    return COMMANDS[argv[0]](env)


if __name__ == "__main__":
    sys.exit(main())
