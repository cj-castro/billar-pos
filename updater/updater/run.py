"""The nightly update (spec 5.4), the resume after a reboot, and the 03:00
scheduler. Stdlib only.

run_update() is one attempt. It returns an outcome kind:
  noop, installed, blocked_open, registry_down, db_unreachable, backup_failed,
  rehearsal_failed, rolled_back, rollback_failed, older_than_db,
  resumed_ok, resumed_rolled_back, resume_held, held.
It sends the Slack/Telegram message itself (Ruling J), except for
blocked_open, registry_down and db_unreachable: those are retried every hour,
so the caller posts them once (daemon(): when the 03:00-12:00 window closes).
The text is always put in `report["message"]`. noop and held send nothing.

Hold (Rulings O and P): a version whose update ended in rehearsal_failed,
rolled_back or rollback_failed is recorded in state.failed and never retried
by itself (outcome held). After rollback_failed no version at all is
installed: the POS may be down and its database state is unknown. The same
goes for resume_held (a resume that needed a database restore while the bar
may be selling). Only `run-now --force` (force=True) clears the record.
Installing another version clears it too.

Safety rules kept here:
- Nothing on the live stack changes before backup + rehearsal pass and a
  second open check (right before the switch) still finds nothing open.
- in_progress is written to the state file before the compose file changes,
  and docker-compose.bar.yml.previous is written before in_progress, so every
  rollback (also after a reboot) can put the old compose back.
- The database is restored only when the new backend may have started
  (compose up was called); restore() keeps the live DB if it fails (Ruling M).
- A resume after a reboot restores the database only inside 03:00-12:00 and
  when a fresh open check finds nothing open; otherwise nothing is stopped or
  restored (resume_held) and CJ is asked to look. The same rule guards the
  resume's compose up of the new version (Ruling V): outside it, the health
  check and the running image decide without starting anything new.
- The updater container is restarted last, after the state file is written
  and the message sent, through a helper container (see self_update).
- run_update() raises only before the switch (nothing changed); any error
  during the switch or the resume leads to a rollback.
"""
import errno
import logging
import os
import re
import shutil
import traceback
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from . import core
from .ops import OpsError
from .redact import redact

log = logging.getLogger("updater.run")

RELEASE_TAG = "bar-stable"
# Never postgres (the data) and never updater (restarted last, on success only).
APP_SERVICES = ["backend", "frontend", "scheduler", "telegram-bot", "backup"]
SELF_SERVICE = "updater"
HEALTH_S = 300          # budget after compose up -d (global constraint)
RESUME_HEALTH_S = 600   # after a reboot Docker Desktop may still be starting things
KEEP_BACKUPS = 10
DEFERRED = ("blocked_open", "registry_down", "db_unreachable")
MAX_ERROR_CHARS = 500
WINDOW_START_H, WINDOW_END_H = 3, 12
DEFAULT_TZ = "America/Mexico_City"
SLEEP_CHUNK_S = 300     # re-read the clock often: a PC suspend makes long sleeps drift

# Ruling J: outcome -> message kind (None = no message).
MESSAGE_KIND = {
    "noop": None,
    "held": None,
    "db_unreachable": "db_unreachable",
    "installed": "installed",
    "resumed_ok": "installed",
    "rolled_back": "rolled_back",
    "resumed_rolled_back": "rolled_back",
    "blocked_open": "blocked_open",
    "registry_down": "registry_down",
    "backup_failed": "backup_failed",
    "rehearsal_failed": "rehearsal_failed",
    "rollback_failed": "rollback_failed",
    "older_than_db": "older_than_db",
    "resume_held": "resume_held",
}
# A failure record with one of these outcomes holds EVERY version (Ruling P).
HOLD_ALL = ("rollback_failed", "resume_held")

# Steps, as they read inside "Falló <step> al actualizar a <sha>".
STEP_WRITE = "la escritura de la nueva configuración"
STEP_UP = "el arranque de la nueva versión"
STEP_HEALTH = "la revisión de salud"
STEP_RESUME = "el cambio de versión (se interrumpió por un reinicio o un corte de luz)"

UNEXPECTED_TEXT = ("El actualizador del POS tuvo un error inesperado antes de cambiar nada; "
                   "el POS sigue en su versión actual: %s. Se reintenta mañana a las 03:00.")
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_PHASES = (None, "switching", "started")


def _short_error(text):
    text = (text or "").strip()
    if len(text) > MAX_ERROR_CHARS:
        text = "..." + text[-MAX_ERROR_CHARS:]
    return text


def _load_state(path):
    """A corrupt state file must never stop the updater: log it, start empty."""
    try:
        return core.load_state(path)
    except Exception as e:
        log.error("state file %s is unreadable (%s); treating it as empty", path, type(e).__name__)
        return core.State()


def _atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def host_backup_path(env, path):
    """Where CJ finds the backup on the bar PC (BAR_HOST_DIR is a Windows path)."""
    host = (env.get("BAR_HOST_DIR") or "").strip()
    if not host or not path:
        return path
    sep = "\\" if "\\" in host else "/"
    return host.rstrip("\\/") + sep + "backups" + sep + os.path.basename(path)


def _in_progress_problem(ip):
    """Why an in_progress record is unusable, or None when it is fine."""
    if not isinstance(ip, dict):
        return "not an object"
    if not isinstance(ip.get("new_sha"), str) or not _SHA_RE.match(ip["new_sha"]):
        return "new_sha is not a 40-character SHA"
    for key in ("old_sha", "backup_path", "started_at"):
        if ip.get(key) is not None and not isinstance(ip[key], str):
            return "%s is not a string" % key
    if ip.get("phase") not in _PHASES:
        return "unknown phase %r" % (ip.get("phase"),)
    return None


def _running_image(ops, service):
    """Image of the running container of `service`, or None when unknown."""
    cid = ops.service_cid(service)
    if not cid:
        return None
    code, out = ops.runner.run(["docker", "inspect", "-f", "{{.Config.Image}}", cid],
                               timeout=120, stderr="separate")
    lines = [l.strip() for l in (out or "").splitlines() if l.strip()]
    if code != 0 or not lines:
        return None
    return lines[0]


def self_update(ops, new_sha):
    """`compose up -d updater`, started from a short-lived helper container.

    Run from inside the updater itself, compose is killed together with the old
    container and leaves the new one "Created" but never started (checked on
    Docker Desktop with compose 2.33: exit 137, new container left with a
    temporary name). The helper is not part of the compose project, so it
    survives the swap; --volumes-from gives it the same socket and /bar mounts,
    and --rm removes it when done. The new updater image has the docker CLI.
    """
    cid = ops.service_cid(SELF_SERVICE)
    if not cid:
        log.warning("no running updater container found; running compose up -d updater directly")
        return ops.up([SELF_SERVICE])
    name = "%s-updater-selfupdate" % ops.project
    ops.runner.run(["docker", "rm", "-f", name], timeout=120)   # leftover of an earlier try
    image = "%s/billar-pos-updater:%s" % (ops.registry, new_sha)
    code, out = ops.runner.run(
        ["docker", "run", "-d", "--rm", "--name", name, "--volumes-from", cid,
         "--entrypoint", "docker", image] + ops.compose_args("up", "-d", "--no-deps", SELF_SERVICE)[1:],
        timeout=300)
    if code != 0:
        log.warning("could not start the self-update helper: %s", (out or "").strip()[-300:])
        return False
    log.info("self-update helper started; this updater will now be replaced")
    return True


def run_update(ops, env, state_path, now, notify_fn, *, report=None, backup_dir=None,
               health_s=HEALTH_S, resume_health_s=RESUME_HEALTH_S, force=False, now_fn=None):
    """One update attempt. `now` is local time (aware). Returns the outcome kind.
    force=True clears a hold (state.failed) first: `run-now --force`.
    now_fn() -> current local time (aware), read by the resume's window check
    on every call. Without it: `now` plus the time passed on ops' clock."""
    return _Run(ops, env or {}, state_path, now, notify_fn, report, backup_dir,
                health_s, resume_health_s, force, now_fn).run()


class _Run:
    def __init__(self, ops, env, state_path, now, notify_fn, report, backup_dir,
                 health_s, resume_health_s, force=False, now_fn=None):
        self.force = force
        self.now_fn = now_fn
        self._clock = getattr(ops, "_clock", None)
        try:
            self._t0 = self._clock()
        except Exception:
            self._clock = self._t0 = None
        self.backup_path = None
        self.ops = ops
        self.env = env
        self.state_path = state_path
        self.now = now
        self.notify_fn = notify_fn
        self.report = report if report is not None else {}
        self.compose = ops.compose_file
        self.previous = ops.compose_file + ".previous"
        self.backup_dir = backup_dir or os.path.join(os.path.dirname(ops.compose_file), "backups")
        self.health_s = health_s
        self.resume_health_s = resume_health_s
        self.state = None
        self.old = None
        self.new = None
        self.extra = ""
        self.health_note = ""

    # ---------------------------------------------------------- outcome

    def done(self, outcome, step=None, error=None, record_failure=False):
        """Record the outcome in the state file, log it, send its message.
        record_failure: hold this version (state.failed) from now on."""
        self.state.last_result = outcome
        if record_failure:
            self.state.failed = {
                "sha": self.new, "outcome": outcome, "backup_path": self.backup_path,
                "host_backup_path": host_backup_path(self.env, self.backup_path),
                "at": self.now.isoformat()}
            log.warning("version %s is held until `run-now --force` or another version: %s",
                        (self.new or "?")[:7], outcome)
        try:
            core.save_state(self.state_path, self.state)
        except Exception as e:
            log.error("could not save state file %s: %s", self.state_path, e)
        error = redact(_short_error(error), self.env) if error else None
        kind = MESSAGE_KIND.get(outcome)
        text = None
        if kind:
            text = core.message(kind, old_sha=self.old, new_sha=self.new, step=step, error=error)
            if self.new is None:   # the release could not be read: no SHA to name
                text = text.replace(" para none", " para la versión aprobada")
            if outcome in ("installed", "resumed_ok"):
                text += self.extra
            text = redact(text, self.env)
        self.report.update(outcome=outcome, message=text, error=error)
        log.info("outcome %s%s", outcome, (": " + error) if error else "")
        if text and outcome not in DEFERRED:
            try:
                self.notify_fn(text)
            except Exception as e:   # a message must never break an update
                log.warning("message not sent: %s", type(e).__name__)
        return outcome

    # -------------------------------------------------------------- run

    def run(self):
        self.state = _load_state(self.state_path)
        if self.force and self.state.failed:
            log.warning("--force: clearing the hold %s", self.state.failed)
            self.state.failed = None
        if self.state.in_progress:
            return self.resume()
        return self.install()

    def held(self, why):
        log.warning("held, nothing done: %s; failure record %s. Clear with `python -m updater "
                    "run-now --force`.", why, self.state.failed)
        return self.done("held")

    def install(self):
        ops, env = self.ops, self.env
        self.old = self.state.current_sha
        failed = self.state.failed if isinstance(self.state.failed, dict) else None
        if self.state.failed is not None and failed is None:
            failed = {"outcome": "rollback_failed"}   # unreadable record: assume the worst
        if failed and failed.get("outcome") in HOLD_ALL:
            return self.held("the last update needs a check (%s): POS may be down, database state unknown"
                             % failed.get("outcome"))
        login_note = ""
        token = env.get("GHCR_TOKEN") or ""
        if token.strip():
            if not ops.login(env.get("GHCR_USER") or "", token):
                login_note = "docker login falló; "
        else:
            log.info("GHCR_TOKEN is empty: registry login skipped")
        try:
            rdir = ops.pull_release(RELEASE_TAG)
        except OpsError as e:
            return self.done("registry_down", error=login_note + str(e))
        try:
            return self.install_from(rdir)
        finally:
            shutil.rmtree(rdir, ignore_errors=True)

    def install_from(self, rdir):
        ops = self.ops
        new_compose_path = os.path.join(rdir, "docker-compose.bar.yml")
        try:
            with open(os.path.join(rdir, "release.json"), "r", encoding="utf-8") as f:
                release = core.parse_release(f.read())
            new_compose = _read_bytes(new_compose_path)
        except (OSError, ValueError) as e:
            return self.done("registry_down", error="la imagen release no es válida: %s" % e)
        self.new = release.sha
        failed = self.state.failed
        if isinstance(failed, dict) and failed.get("sha") == release.sha:
            return self.held("the update to %s already failed (%s)" % (release.sha[:7], failed.get("outcome")))
        try:
            live = ops.live_migration_versions()
        except OpsError as e:
            log.warning("cannot read live migrations: %s", e)
            return self.done("db_unreachable", error=str(e))
        decision = core.decide(release, self.state, live)
        if decision == "noop":
            log.info("bar-stable %s is already installed: nothing to do", self.new[:7])
            return self.done("noop")
        if decision == "older_than_db":
            return self.done("older_than_db",
                             error="la base tiene: %s" % ", ".join(sorted(live - set(release.migrations))))
        blocked = self.open_check()
        if blocked:
            return blocked
        # Download first: a failed download changes nothing and takes no backup
        # (hourly retries would otherwise push older backups out of the 10 kept).
        if not ops.pull_images(new_compose_path):
            return self.done("registry_down",
                             error="no se pudieron descargar las imágenes de %s" % self.new[:7])
        try:
            os.makedirs(self.backup_dir, exist_ok=True)
        except OSError as e:
            return self.done("backup_failed", error="no se pudo crear %s: %s" % (self.backup_dir, e))
        backup = self.window_backup_path() or os.path.join(
            self.backup_dir, core.backup_name(self.old, self.new, self.now))
        name = os.path.basename(backup)
        # Always a fresh dump (a retry dumps into the same file): the bar was
        # open in between, and a rollback must not lose that hour's sales.
        if not ops.backup(backup):
            return self.done("backup_failed", error="pg_dump falló o el archivo quedó vacío (%s)"
                             % host_backup_path(self.env, backup))
        self.backup_path = backup
        self.state.window_backup = {"old_sha": self.old, "new_sha": self.new, "path": backup,
                                    "date": self.now.date().isoformat()}
        self.prune(keep_name=name)
        ok, detail = ops.rehearse("%s/billar-pos-backend:%s" % (ops.registry, self.new), backup)
        if not ok:
            return self.done("rehearsal_failed", error=detail, record_failure=True)
        log.info("rehearsal passed: %s", detail)
        # The rehearsal takes minutes; staff may have opened something meanwhile.
        blocked = self.open_check()
        if blocked:
            return blocked
        last = release.migrations[-1] if release.migrations else None
        self.extra = (" Migraciones hasta %s." % last if last else "") + " Respaldo: %s." % name
        # .previous first, then in_progress: whenever in_progress exists,
        # .previous is the compose that ran before this update.
        shutil.copyfile(self.compose, self.previous + ".tmp")
        os.replace(self.previous + ".tmp", self.previous)
        ip = {"new_sha": self.new, "old_sha": self.old, "backup_path": backup,
              "started_at": self.now.isoformat(), "phase": "switching"}
        self.state.in_progress = ip
        self.state.window_backup = None
        core.save_state(self.state_path, self.state)
        return self.switch(ip, new_compose)

    def window_backup_path(self):
        """The dump file made earlier in today's window for this old->new pair."""
        wb = self.state.window_backup
        if not isinstance(wb, dict):
            return None
        path = wb.get("path")
        if (wb.get("old_sha") == self.old and wb.get("new_sha") == self.new
                and wb.get("date") == self.now.date().isoformat() and isinstance(path, str)
                and os.path.dirname(path) == self.backup_dir):
            log.info("retry in the same window: dumping again into %s", os.path.basename(path))
            return path
        return None

    def open_check(self):
        try:
            cash, tickets = self.ops.open_counts()
        except OpsError as e:
            # Never "nothing open", and not "tables open" either.
            log.warning("cannot read open cash sessions/tickets: %s", e)
            return self.done("db_unreachable", error=str(e))
        if cash or tickets:
            return self.done("blocked_open", error="%d caja(s) y %d cuenta(s) abiertas" % (cash, tickets))
        return None

    def prune(self, keep_name):
        try:
            names = os.listdir(self.backup_dir)
        except OSError as e:
            log.warning("cannot list %s: %s", self.backup_dir, e)
            return
        for n in core.prune_backups(names, keep=KEEP_BACKUPS):
            if n == keep_name:
                continue
            try:
                os.remove(os.path.join(self.backup_dir, n))
                log.info("old backup removed: %s", n)
            except OSError as e:
                log.warning("cannot remove old backup %s: %s", n, e)

    # ----------------------------------------------------------- switch

    def switch(self, ip, new_compose):
        ops = self.ops
        started = False
        step = STEP_WRITE
        try:
            _atomic_write(self.compose, new_compose)
            ip["phase"] = "started"
            core.save_state(self.state_path, self.state)
            started = True   # from here on the new backend may have run init-db/migrations
            step = STEP_UP
            if not ops.up(APP_SERVICES):
                return self.rollback(ip, step, "docker compose up falló", started=True, resumed=False)
            step = STEP_HEALTH
            ok, detail = ops.healthy(timeout_s=self.health_s)
            if not ok:
                return self.rollback(ip, step, detail, started=True, resumed=False)
            self.note_health(detail)
        except Exception as e:
            log.error("error during the switch: %s", redact(traceback.format_exc(), self.env))
            return self.rollback(ip, step, "%s: %s" % (type(e).__name__, e), started=started, resumed=False)
        return self.success(ip, resumed=False)

    def note_health(self, detail):
        """A passed health check can carry a warning (telegram-bot): say it."""
        if detail and detail != "ok" and detail.startswith("ok; "):
            note = detail[4:]
            if note.startswith("warning: "):
                note = note[len("warning: "):]
            self.health_note = " Aviso: %s." % note

    def success(self, ip, resumed):
        self.state.previous_sha = ip.get("old_sha")
        self.state.current_sha = ip["new_sha"]
        self.state.in_progress = None
        self.state.failed = None
        if resumed and ip.get("backup_path"):
            self.extra = " Respaldo: %s." % os.path.basename(ip["backup_path"])
        self.extra += self.health_note
        outcome = self.done("resumed_ok" if resumed else "installed")
        # Images of versions that are neither current nor previous only fill the
        # disk. Failures are logged inside prune_images.
        try:
            self.ops.prune_images({ip["new_sha"], ip.get("old_sha")})
        except Exception as e:
            log.warning("image cleanup failed: %s", e)
        # Last: this replaces the container this code runs in.
        try:
            if not self_update(self.ops, ip["new_sha"]):
                log.warning("updater self-update failed; the old updater keeps running")
        except Exception as e:
            log.warning("updater self-update failed: %s", e)
        return outcome

    # --------------------------------------------------------- rollback

    def restore_compose(self):
        try:
            if not os.path.isfile(self.previous):
                log.error("%s is missing: cannot put the old compose back", self.previous)
                return False
            _atomic_write(self.compose, _read_bytes(self.previous))
            return True
        except OSError as e:
            log.error("cannot put the old compose back: %s", e)
            return False

    def rollback(self, ip, step, error, started, resumed, hold=None):
        """hold: record the failure (hold this version). None = the default:
        hold unless this is a resume where the new backend never started."""
        ops = self.ops
        backup = ip.get("backup_path")
        self.backup_path = backup
        log.warning("rolling back from %s (step: %s; error: %s; restore DB: %s)",
                    (ip.get("new_sha") or "?")[:7], step, error, started)
        try:
            if started:
                if not ops.stop(APP_SERVICES):
                    log.warning("compose stop failed; restoring the database anyway")
                if backup:
                    ok, detail = ops.restore(backup)
                else:
                    ok, detail = False, "no hay respaldo registrado"
                if not ok:
                    # Old code must not start on a database in an unknown state.
                    self.restore_compose()
                    return self.rollback_failed(ip, step, error,
                                                "no se pudo restaurar la base de datos: %s" % detail)
                log.info(detail)
            if not self.restore_compose():
                return self.rollback_failed(ip, step, error,
                                            "no se pudo volver a la configuración anterior (.previous)")
            if not ops.up(APP_SERVICES):
                return self.rollback_failed(ip, step, error, "no arrancó la versión anterior")
            ok, detail = ops.healthy(timeout_s=self.health_s)
            if not ok:
                return self.rollback_failed(ip, step, error, "la versión anterior no quedó sana: %s" % detail)
        except Exception as e:
            log.error("error during the rollback: %s", redact(traceback.format_exc(), self.env))
            return self.rollback_failed(ip, step, error, "error en la reversión: %s: %s" % (type(e).__name__, e))
        self.state.in_progress = None
        # Hold the version when it was seen failing; a resume where the new
        # backend never started (power cut mid-switch) proves nothing about it.
        if hold is None:
            hold = started or not resumed
        return self.done("resumed_rolled_back" if resumed else "rolled_back", step=step, error=error,
                         record_failure=hold)

    def rollback_failed(self, ip, step, error, why):
        # in_progress is cleared on purpose: a later automatic resume must never
        # restore an old backup over data entered after CJ fixed things by hand.
        self.state.in_progress = None
        backup = ip.get("backup_path")
        where = host_backup_path(self.env, backup) or "no registrado"
        return self.done("rollback_failed", step=step,
                         error="%s · %s · respaldo: %s" % (_short_error(error), why, where),
                         record_failure=True)

    # ----------------------------------------------------------- resume

    def resume(self):
        ip = self.state.in_progress
        try:
            problem = _in_progress_problem(ip)
        except Exception as e:
            problem = "%s: %s" % (type(e).__name__, e)
        if problem:
            log.error("in_progress in %s is unusable (%s): %r; clearing it, nothing touched",
                      self.state_path, problem, ip)
            self.state.in_progress = None
            return self.done("noop")
        self.old, self.new = ip.get("old_sha"), ip["new_sha"]
        phase = ip.get("phase") or "started"   # unknown -> assume the new backend may have run
        log.warning("update to %s was left in progress (phase %s): checking", self.new[:7], phase)
        try:
            if phase != "started":
                return self.rollback(ip, STEP_RESUME, "se interrumpió antes de arrancar la nueva versión",
                                     started=False, resumed=True)
            # A rollback's restore cut between its two renames leaves no live
            # database; put it back first (renames only, never drops).
            ok, detail = self.ops.recover_interrupted_swap()
            if not ok:
                log.warning("could not check for an interrupted restore: %s", detail)
            # Finish a compose up the reboot cut short (idempotent). It may start
            # the new backend, so only when a restore would be allowed too
            # (Ruling V): inside 03:00-12:00 and nothing open.
            unsafe = self.resume_unsafe()
            if unsafe:
                log.warning("resume: skipping compose up of the app services (%s); the health check "
                            "and the running image decide", "; ".join(unsafe))
            elif not self.ops.up(APP_SERVICES):
                log.warning("compose up during the resume failed; the health check decides")
            ok, detail = self.ops.healthy(timeout_s=self.resume_health_s)
            if not ok:
                return self.resume_restore(ip, detail)
            image = _running_image(self.ops, "backend")
            if image is None:
                return self.resume_restore(ip, "no se pudo confirmar qué versión corre")
            if not image.endswith(":" + self.new):
                # Healthy on the old image: the new backend never started, the DB is untouched.
                # Phase "started" means the switch got as far as compose up (or a
                # rollback had already put the old compose back): hold the version.
                return self.rollback(ip, STEP_RESUME, "sigue corriendo la versión anterior (%s)" % image,
                                     started=False, resumed=True, hold=True)
            self.note_health(detail)
        except Exception as e:
            log.error("error during the resume: %s", redact(traceback.format_exc(), self.env))
            error = "%s: %s" % (type(e).__name__, e)
            if phase == "started":
                return self.resume_restore(ip, error)
            return self.rollback(ip, STEP_RESUME, error, started=False, resumed=True)
        return self.success(ip, resumed=True)

    def current_now(self):
        """Local time right now. self.now is when the run was asked for (before
        the lock); a compose up and a health check can take 25 minutes."""
        if self.now_fn is not None:
            try:
                return self.now_fn()
            except Exception as e:
                log.warning("cannot read the current time (%s); using the run's start time + elapsed", e)
        if self._clock is not None:
            try:
                return self.now + timedelta(seconds=max(0.0, self._clock() - self._t0))
            except Exception as e:
                log.warning("cannot read the clock (%s); using the run's start time", e)
        return self.now

    def resume_unsafe(self):
        """Why touching the live stack during a resume is not safe now (empty
        list = safe): outside 03:00-12:00, something open, or the open check
        could not be read. Every call reads the open counts again and the
        current local time (current_now), not the time the run started."""
        found = []
        try:
            cash, tickets = self.ops.open_counts()
            if cash or tickets:
                found.append("hay %d caja(s) y %d cuenta(s) abiertas" % (cash, tickets))
        except Exception as e:
            found.append("no se pudo leer si hay cajas o cuentas abiertas (%s)" % _short_error(str(e))[:200])
        now = self.current_now()
        if not core.in_window(now, WINDOW_START_H, WINDOW_END_H):
            when = now.strftime("%H:%M")
            started = self.now.strftime("%H:%M")
            if started != when:
                when += " (empezó a las %s)" % started
            found.append("son las %s, fuera del horario 03:00-12:00" % when)
        return found

    def resume_restore(self, ip, error):
        """A resume that needs the database restored. After a reboot the bar
        may already be selling: restore only inside the 03:00-12:00 window and
        when a fresh check finds no open cash session or ticket. Otherwise
        stop nothing, restore nothing, hold every version, ask for help."""
        found = self.resume_unsafe()
        if not found:
            return self.rollback(ip, STEP_RESUME, error, started=True, resumed=True)
        log.error("resume needs a database restore but it is not safe now (%s); nothing stopped or "
                  "restored; every version held until `run-now --force`", "; ".join(found))
        self.state.in_progress = None   # never restore this backup later by itself
        self.backup_path = ip.get("backup_path")
        where = host_backup_path(self.env, self.backup_path) or "no registrado"
        return self.done("resume_held", step=STEP_RESUME,
                         error="%s · %s · respaldo: %s" % (_short_error(error), "; ".join(found), where),
                         record_failure=True)


# ------------------------------------------------------------------ check

def check_update(ops, env, state_path):
    """Read-only: what would run_update do now? Changes nothing, sends nothing."""
    info = {}
    state = _load_state(state_path)
    info.update(current_sha=state.current_sha, previous_sha=state.previous_sha,
                in_progress=state.in_progress, last_result=state.last_result, failed=state.failed)
    token = (env or {}).get("GHCR_TOKEN") or ""
    if token.strip():
        info["login"] = ops.login((env or {}).get("GHCR_USER") or "", token)
    try:
        rdir = ops.pull_release(RELEASE_TAG)
    except OpsError as e:
        info.update(decision="registry_down", error=str(e))
        return info
    try:
        with open(os.path.join(rdir, "release.json"), "r", encoding="utf-8") as f:
            release = core.parse_release(f.read())
        info.update(new_sha=release.sha, built_at=release.built_at)
        live = ops.live_migration_versions()
        info["decision"] = core.decide(release, state, live)
        cash, tickets = ops.open_counts()
        info.update(open_cash_sessions=cash, open_tickets=tickets)
    except (OSError, ValueError, OpsError) as e:
        info.setdefault("decision", "unknown")
        info["error"] = str(e)
    finally:
        shutil.rmtree(rdir, ignore_errors=True)
    return info


# -------------------------------------------------------------- scheduler

def local_tz(env):
    name = (env or {}).get("TZ") or DEFAULT_TZ
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        # Mexico City has had no daylight saving time since 2022.
        log.warning("time zone %r not available; using UTC-6", name)
        return timezone(timedelta(hours=-6), "UTC-6")


def next_run_at(now, hour=WINDOW_START_H):
    """The next `hour`:00 strictly after `now` (same time zone)."""
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def sleep_until(target, now_fn, sleep_fn):
    while True:
        left = (target - now_fn()).total_seconds()
        if left <= 0:
            return
        sleep_fn(min(left, SLEEP_CHUNK_S))


def _safe_notify(notify_fn, text):
    try:
        notify_fn(text)
    except Exception as e:
        log.warning("message not sent: %s", type(e).__name__)


BAR_FOLDER_TEXT = ("El updater no ve la carpeta del bar: dentro del contenedor falta %s. Revisa BAR_HOST_DIR "
                   "en .env y luego, en PowerShell dentro de la carpeta del bar, corre: docker compose -f "
                   "docker-compose.bar.yml up -d updater. Hasta corregirlo, las actualizaciones no pueden funcionar.")


def check_bar_folder(paths, notify_fn):
    """Daemon start: are the bar files visible through the /bar mount? A wrong
    BAR_HOST_DIR mounts an empty folder. Logs and sends ONE message when any
    file is missing; returns the missing paths."""
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        log.error("bar folder not visible: missing %s (check BAR_HOST_DIR in .env)", ", ".join(missing))
        _safe_notify(notify_fn, BAR_FOLDER_TEXT % ", ".join(missing))
    return missing


def run_window(run_once, now_fn, sleep_fn, notify_fn):
    """One night: attempt, and while the outcome is blocked_open/registry_down
    retry at the top of every hour inside the window. When the window closes
    still blocked, post the last blocking message once (at 12:00).
    run_once(now) -> (outcome, message). Returns the last outcome."""
    last_msg = None
    while True:
        started = now_fn()
        try:
            outcome, msg = run_once(started)
        except Exception as e:
            log.error("update run crashed: %s", redact(traceback.format_exc()))
            _safe_notify(notify_fn, UNEXPECTED_TEXT % redact(_short_error("%s: %s" % (type(e).__name__, e))))
            return "error"
        if outcome not in DEFERRED:
            return outcome
        last_msg = msg or last_msg
        nxt = started.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        if not core.in_window(nxt, WINDOW_START_H, WINDOW_END_H):
            sleep_until(started.replace(hour=WINDOW_END_H, minute=0, second=0, microsecond=0),
                        now_fn, sleep_fn)
            log.warning("window closed while %s; posting the message", outcome)
            if last_msg:
                _safe_notify(notify_fn, last_msg)
            return outcome
        sleep_until(nxt, now_fn, sleep_fn)


def daemon(run_once, now_fn, sleep_fn, notify_fn, *, resume_pending=lambda: False, cycles=None):
    """Run forever (cycles=None) or for `cycles` nights after the start-up check.
    At start: an update left in progress is resumed at once (any hour); inside
    the window an attempt runs at once. Then every night at 03:00."""
    try:
        pending = resume_pending()
    except Exception:
        pending = False
    try:
        if pending or core.in_window(now_fn(), WINDOW_START_H, WINDOW_END_H):
            run_window(run_once, now_fn, sleep_fn, notify_fn)
    except Exception:
        log.error("start-up run failed: %s", redact(traceback.format_exc()))
    n = 0
    while cycles is None or n < cycles:
        n += 1
        try:
            sleep_until(next_run_at(now_fn()), now_fn, sleep_fn)
            run_window(run_once, now_fn, sleep_fn, notify_fn)
        except Exception:
            # Never exit: log and wait for the next night.
            log.error("scheduler error: %s", redact(traceback.format_exc()))
            sleep_fn(60)


# ------------------------------------------------------------------- lock

class Busy(Exception):
    """Another update run holds the lock."""


@contextmanager
def run_lock(path, wait=True):
    """One update at a time (daemon vs `run-now`). The lock lives inside the
    container (/tmp), where both processes see it."""
    import fcntl
    f = open(path, "a+")
    try:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                raise Busy() from None
            log.warning("run lock unavailable (%s); continuing without it", e)
        yield
    finally:
        f.close()
