"""Command layer: every docker / docker compose call the updater makes.

Runner runs one command (no shell) and hides secrets in its output.
Ops builds the commands: backup, rehearsal on a scratch database, live
restore, compose up/stop/pull and the health check. Stdlib only.

Nothing here decides whether to update; run.py (Task 3) does. Ops methods
report failure by return value (bool / (bool, detail)), except the reads that
feed a decision (pull_release, open_counts, live_migration_versions), which
raise OpsError so that a failed read can never look like "nothing open" or
"no migrations".
"""
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import quote

from .redact import redact

log = logging.getLogger("updater.ops")

# Ruling K: fixed paths inside the updater container.
COMPOSE_FILE = "/bar/docker-compose.bar.yml"
ENV_FILE = "/bar/.env"

SCRATCH_DB = "billar_scratch_update"
MIN_DUMP_BYTES = 1024
# Where the release image keeps its two files (Task 4 must match).
RELEASE_DIR_IN_IMAGE = "/"
RELEASE_FILES = ("release.json", "docker-compose.bar.yml")
# Images we build and pull. postgres is left out on purpose: re-pulling
# postgres:15-alpine could bring a new minor version and restart the database.
PULL_SERVICES = ("backend", "frontend", "scheduler", "telegram-bot", "backup", "updater")
REHEARSAL_SCRIPT = ("flask init-db && python seed.py && flask factory-finalize"
                    " && flask apply-migrations --strict && flask migration-status")

LONG_TIMEOUT = 1800   # dumps, restores, the rehearsal
SHORT_TIMEOUT = 120
# telegram-bot (only checked when TELEGRAM_TOKEN is set): a bot that is
# "restarting" is accepted while it has restarted fewer times than this.
TELEGRAM_MAX_RESTARTS = 3

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,49}$")   # room for _restoring/_failed (63 max)
_CID_RE = re.compile(r"^[0-9a-f]{12,64}$")
_IGNORED_RE = re.compile(r"errors ignored on restore: (\d+)")
_PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_SHA_TAG_RE = re.compile(r"^[0-9a-f]{40}$")
_ZERO_PENDING_RE = re.compile(r"^\s*\d+/\d+ applied, 0 pending\s*$", re.M)
_SUMMARY_RE = re.compile(r"^\s*\d+/\d+ applied, \d+ pending\s*$", re.M)
_UNKNOWN_VERSIONS = "this build does not ship"


class OpsError(Exception):
    """A command whose result feeds a decision failed or gave unreadable output."""


def _tail(text, lines=20, chars=1500):
    text = (text or "").strip()
    text = "\n".join(text.splitlines()[-lines:])
    return text[-chars:]


class Runner:
    """Runs one command without a shell. Returns (exit_code, output).

    Output is stdout+stderr combined, or only stderr when stdout goes to
    `stdout_path`. Values of GHCR_TOKEN, SLACK_WEBHOOK_URL and TELEGRAM_TOKEN
    are replaced with *** in the returned output. Never raises for a failed,
    missing or timed-out command: those come back as a non-zero exit code.
    `input_text` (e.g. a registry token) is written to stdin, never to argv.
    `env` adds variables to the child's environment.
    `stderr='separate'` is for output that will be parsed: on exit 0 only
    stdout is returned (stderr, e.g. compose WARN lines or psql NOTICEs, is
    logged at debug level, redacted). On a non-zero exit stdout+stderr are
    returned, since a failure is reported, not parsed.
    """

    def run(self, args, *, stdout_path=None, input_path=None, input_text=None,
            env=None, timeout=600, stderr=None):
        if stderr not in (None, "separate"):
            raise ValueError("stderr must be None or 'separate'")
        separate = stderr == "separate"
        args = [str(a) for a in args]
        child_env = None
        if env:
            child_env = dict(os.environ)
            child_env.update(env)
        stdin_f = out_f = None
        try:
            try:
                if input_path is not None:
                    stdin_f = open(input_path, "rb")
                if stdout_path is not None:
                    out_f = open(stdout_path, "wb")
            except OSError as e:
                return 1, "cannot open file: %s" % e
            kw = {"timeout": timeout, "env": child_env}
            if stdin_f is not None:
                kw["stdin"] = stdin_f
            elif input_text is not None:
                kw["input"] = input_text.encode("utf-8")
            else:
                kw["stdin"] = subprocess.DEVNULL
            if out_f is not None:
                kw["stdout"] = out_f
                kw["stderr"] = subprocess.PIPE
            elif separate:
                kw["stdout"] = subprocess.PIPE
                kw["stderr"] = subprocess.PIPE
            else:
                kw["stdout"] = subprocess.PIPE
                kw["stderr"] = subprocess.STDOUT
            try:
                p = subprocess.run(args, **kw)
            except subprocess.TimeoutExpired:
                return 124, "timed out after %ss: %s" % (timeout, args[0])
            except FileNotFoundError:
                return 127, "command not found: %s" % args[0]
            except OSError as e:
                return 126, redact("cannot run %s: %s" % (args[0], e))
            if out_f is not None:
                raw = p.stderr or b""
            elif separate:
                err = p.stderr or b""
                if err.strip():
                    log.debug("stderr of %s: %s", " ".join(args[:3]),
                              redact(_tail(err.decode("utf-8", "replace"), 5)))
                raw = (p.stdout or b"") if p.returncode == 0 else (p.stdout or b"") + err
            else:
                raw = p.stdout or b""
            return p.returncode, redact(raw.decode("utf-8", "replace"))
        finally:
            for f in (stdin_f, out_f):
                if f is not None:
                    f.close()


class Ops:
    def __init__(self, runner, project=None, compose_file=COMPOSE_FILE, env_file=ENV_FILE,
                 pg_user=None, pg_db=None, registry=None, *, pg_password=None,
                 clock=time.monotonic, sleep=time.sleep, poll_s=5, telegram_required=None):
        self.runner = runner
        # Ruling H: project from COMPOSE_PROJECT_NAME, default 'billiards'.
        self.project = project or os.environ.get("COMPOSE_PROJECT_NAME") or "billiards"
        self.network = "%s_billiardbar_net" % self.project
        self.compose_file = compose_file
        self.env_file = env_file
        self.pg_user = pg_user or os.environ.get("POSTGRES_USER") or "billiard"
        self.pg_db = pg_db or os.environ.get("POSTGRES_DB") or "billiardbar"
        self.pg_password = (pg_password if pg_password is not None
                            else os.environ.get("POSTGRES_PASSWORD") or "billiard_secret")
        # Ruling I / Task 6: every image name is built from the registry.
        self.registry = (registry or os.environ.get("UPDATER_REGISTRY")
                         or "ghcr.io/cj-castro").rstrip("/")
        self._clock = clock
        self._sleep = sleep
        self.poll_s = poll_s
        # Without TELEGRAM_TOKEN the bot cannot log in and keeps restarting:
        # then its state is only a warning, never a failed health check.
        if telegram_required is None:
            telegram_required = bool((os.environ.get("TELEGRAM_TOKEN") or "").strip())
        self.telegram_required = bool(telegram_required)
        if not _PROJECT_RE.match(self.project):
            raise ValueError("invalid compose project name")
        for name, value in (("pg_user", self.pg_user), ("pg_db", self.pg_db)):
            if not _IDENT_RE.match(value):
                raise ValueError("invalid %s (letters, digits and _ only)" % name)

    # ------------------------------------------------------------ helpers

    def _compose(self, *rest, compose_file=None):
        return ["docker", "compose", "-p", self.project, "-f", compose_file or self.compose_file,
                "--env-file", self.env_file] + list(rest)

    def compose_args(self, *rest, compose_file=None):
        """Public: `docker compose -p <project> -f <file> --env-file <env> <rest...>`."""
        return self._compose(*rest, compose_file=compose_file)

    def service_cid(self, service, timeout=SHORT_TIMEOUT):
        """Public: container id of a running compose service, or ''."""
        return self._service_cid(service, timeout=timeout)

    def _service_cid(self, service, timeout=SHORT_TIMEOUT):
        """Container id of a running service, or ''. Only a hex id line counts,
        so a compose warning can never be taken for an id."""
        code, out = self.runner.run(self._compose("ps", "-q", service), timeout=timeout,
                                    stderr="separate")
        if code != 0:
            return ""
        ids = [l.strip() for l in out.splitlines() if _CID_RE.match(l.strip())]
        return ids[0] if ids else ""

    def _pg(self):
        cid = self._service_cid("postgres")
        if not cid:
            raise OpsError("postgres container not found (docker compose ps -q postgres)")
        return cid

    def _psql(self, sql, db=None, pg=None, timeout=SHORT_TIMEOUT, stderr=None):
        pg = pg or self._pg()
        return self.runner.run(
            ["docker", "exec", pg, "psql", "-X", "-v", "ON_ERROR_STOP=1",
             "-U", self.pg_user, "-d", db or self.pg_db, "-tA", "-c", sql],
            timeout=timeout, stderr=stderr)

    def _psql_read(self, sql, db=None, pg=None):
        """psql for output that is parsed: stdout only (NOTICE/WARNING go to stderr)."""
        return self._psql(sql, db=db, pg=pg, stderr="separate")

    def _scalar_int(self, sql, db=None, pg=None):
        code, out = self._psql_read(sql, db=db, pg=pg)
        if code != 0:
            raise OpsError("query failed: %s" % _tail(out, 3))
        first = (out.strip().splitlines() or [""])[0].strip()
        try:
            return int(first)
        except ValueError:
            raise OpsError("unexpected query output: %r" % _tail(out, 3)) from None

    def _migration_count(self, db, pg):
        return self._scalar_int("SELECT count(*) FROM schema_migrations", db=db, pg=pg)

    @staticmethod
    def _dump_ok(path):
        try:
            return os.path.isfile(path) and os.path.getsize(path) >= MIN_DUMP_BYTES
        except OSError:
            return False

    @staticmethod
    def _status_summary(out):
        m = _SUMMARY_RE.findall(out or "")
        return m[-1].strip() if m else "no migration summary"

    def _inspect_state(self, cid, timeout=SHORT_TIMEOUT):
        code, out = self.runner.run(
            ["docker", "inspect", "-f",
             "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", cid],
            timeout=timeout, stderr="separate")
        if code != 0:
            return "", ""
        status, _, health = out.strip().partition("|")
        return status.strip(), health.strip()

    # ----------------------------------------------------------- registry

    def login(self, user, token):
        if not user or not token:
            log.warning("registry login skipped: user or token missing")
            return False
        host = self.registry.split("/")[0]
        code, out = self.runner.run(["docker", "login", host, "-u", user, "--password-stdin"],
                                    input_text=token, timeout=SHORT_TIMEOUT)
        if code != 0:
            log.warning("docker login %s failed: %s", host, _tail(out, 3))
        return code == 0

    def pull_release(self, tag):
        """Pull the release image, copy its two files into a new temp dir, return the dir."""
        image = "%s/billar-pos-release:%s" % (self.registry, tag)
        code, out = self.runner.run(["docker", "pull", image], timeout=600)
        if code != 0:
            raise OpsError("docker pull %s failed: %s" % (image, _tail(out, 5)))
        # The command is never run; it lets `create` work on an image without CMD.
        code, out = self.runner.run(["docker", "create", image, "noop"], timeout=SHORT_TIMEOUT)
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        if code != 0 or not lines:
            raise OpsError("docker create %s failed: %s" % (image, _tail(out, 5)))
        cid = lines[-1]
        tmp = tempfile.mkdtemp(prefix="bar-release-")
        try:
            for name in RELEASE_FILES:
                dest = os.path.join(tmp, name)
                code, out = self.runner.run(
                    ["docker", "cp", "%s:%s%s" % (cid, RELEASE_DIR_IN_IMAGE, name), dest],
                    timeout=SHORT_TIMEOUT)
                if code != 0 or not os.path.isfile(dest):
                    raise OpsError("docker cp %s from %s failed: %s" % (name, image, _tail(out, 5)))
            return tmp
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        finally:
            self.runner.run(["docker", "rm", "-f", cid], timeout=SHORT_TIMEOUT)

    # ------------------------------------------------------------ DB reads

    def open_counts(self):
        """(open cash sessions, open tickets). Raises OpsError if unreadable."""
        pg = self._pg()
        cash = self._scalar_int("SELECT count(*) FROM cash_sessions WHERE status='OPEN'", pg=pg)
        tickets = self._scalar_int("SELECT count(*) FROM tickets WHERE status='OPEN'", pg=pg)
        return cash, tickets

    def live_migration_versions(self):
        code, out = self._psql_read("SELECT version FROM schema_migrations")
        if code != 0:
            raise OpsError("reading schema_migrations failed: %s" % _tail(out, 3))
        return {l.strip() for l in out.splitlines() if l.strip()}

    # ------------------------------------------------------------- backup

    def backup(self, dest_path):
        """pg_dump -Fc of the live DB to dest_path. False on any failure (no file left)."""
        part = dest_path + ".part"
        try:
            pg = self._pg()
        except OpsError as e:
            log.warning("backup failed: %s", e)
            return False
        code, out = self.runner.run(
            ["docker", "exec", pg, "pg_dump", "-Fc", "-U", self.pg_user, self.pg_db],
            stdout_path=part, timeout=LONG_TIMEOUT)
        size = os.path.getsize(part) if os.path.exists(part) else 0
        if code != 0 or size < MIN_DUMP_BYTES:
            log.warning("backup failed (exit %s, %s bytes): %s", code, size, _tail(out, 5))
            try:
                os.remove(part)
            except OSError:
                pass
            return False
        os.replace(part, dest_path)
        return True

    # ---------------------------------------------------------- rehearsal

    def rehearse(self, backend_image, dump_path):
        """Restore dump into SCRATCH_DB, run the new backend's startup sequence
        against it, require 0 pending migrations. Always drops SCRATCH_DB and
        removes the rehearsal container."""
        if not self._dump_ok(dump_path):
            return False, "backup file missing or too small: %s" % dump_path
        try:
            pg = self._pg()
        except OpsError as e:
            return False, str(e)
        drop = "DROP DATABASE IF EXISTS %s WITH (FORCE)" % SCRATCH_DB
        name = "%s-rehearsal" % self.project
        try:
            code, out = self._psql(drop, db="postgres", pg=pg)   # leftovers of a crashed run
            if code != 0:
                return False, "could not clear %s: %s" % (SCRATCH_DB, _tail(out, 5))
            code, out = self.runner.run(["docker", "exec", pg, "createdb", "-U", self.pg_user, SCRATCH_DB],
                                        timeout=SHORT_TIMEOUT)
            if code != 0:
                return False, "createdb %s failed: %s" % (SCRATCH_DB, _tail(out, 5))
            code, out = self.runner.run(
                ["docker", "exec", "-i", pg, "pg_restore", "--no-owner", "--no-privileges",
                 "-U", self.pg_user, "-d", SCRATCH_DB],
                input_path=dump_path, timeout=LONG_TIMEOUT)
            # pg_restore exits 1 when it only had warnings; the row check decides.
            if code not in (0, 1):
                return False, "restore into %s failed (exit %s): %s" % (SCRATCH_DB, code, _tail(out, 5))
            restore_note = _tail(out, 5)
            if self._migration_count(SCRATCH_DB, pg) <= 0:
                return False, "restore into %s left schema_migrations empty: %s" % (SCRATCH_DB, restore_note)
            url = "postgresql://%s:%s@postgres:5432/%s" % (
                quote(self.pg_user, safe=""), quote(self.pg_password, safe=""), SCRATCH_DB)
            # A container left by a crashed or timed-out run would block --name.
            self.runner.run(["docker", "rm", "-f", name], timeout=SHORT_TIMEOUT)
            # --env-file gives the copy the same settings as the live backend
            # (CURRENCY, DAY_CUTOFF, VENUE_NAME...). The -e flags win over it:
            # DATABASE_URL and TZ are passed by name, so the password never
            # appears in argv, `ps` output or logs.
            code, out = self.runner.run(
                ["docker", "run", "--rm", "--name", name, "--network", self.network,
                 "--env-file", self.env_file,
                 "-e", "DATABASE_URL", "-e", "TZ", "-e", "FLASK_APP=wsgi.py",
                 "--entrypoint", "sh", backend_image, "-c", REHEARSAL_SCRIPT],
                env={"DATABASE_URL": url, "TZ": os.environ.get("TZ") or "America/Mexico_City"},
                timeout=LONG_TIMEOUT)
            if code != 0:
                return False, "new backend startup failed on the copy (exit %s): %s" % (code, _tail(out))
            if _UNKNOWN_VERSIONS in out:
                return False, "copy has migrations the new build does not ship: %s" % _tail(out, 5)
            if not _ZERO_PENDING_RE.search(out):
                return False, "migrations still pending on the copy: %s" % self._status_summary(out)
            return True, self._status_summary(out)
        except OpsError as e:
            return False, str(e)
        finally:
            # A timeout kills the docker CLI, not the container: remove it first
            # so it releases its connection, then drop the copy.
            self.runner.run(["docker", "rm", "-f", name], timeout=SHORT_TIMEOUT)
            code, out = self._psql(drop, db="postgres", pg=pg)
            if code != 0:
                log.warning("could not drop %s: %s", SCRATCH_DB, _tail(out, 3))

    # ------------------------------------------------------- live restore

    def restore(self, dump_path):
        """Replace the live DB with dump_path, never leaving the bar without a
        database (Ruling M). Returns (ok, detail); detail names the backup.

        1. Checks: dump size and `pg_restore --list`. Nothing touched on failure.
        2. Restore into <db>_restoring and verify schema_migrations there.
           On failure <db>_restoring is dropped; the live DB is untouched.
        3. Swap: drop an old <db>_failed, terminate sessions on <db>,
           rename <db> -> <db>_failed, rename <db>_restoring -> <db>.
           If the second rename fails, <db>_failed is renamed back to <db>.
        App services should be stopped first; the old data stays in <db>_failed
        until the next restore.
        """
        db = self.pg_db
        restoring = db + "_restoring"
        failed = db + "_failed"
        where = "backup %s" % dump_path
        if not self._dump_ok(dump_path):
            return False, "restore refused: file missing or too small (%s)" % where
        try:
            pg = self._pg()
        except OpsError as e:
            return False, "restore failed: %s (%s)" % (e, where)
        # 0. A restore cut between its two renames (power cut) left no <db>:
        #    put the right copy back under <db> first. If that cannot be done or
        #    checked, stop here: step 3 drops <db>_failed, which may then hold
        #    the only copy of the live data.
        ok, detail = self.recover_interrupted_swap(pg=pg)
        if not ok:
            msg = "restore refused: %s; nothing changed (%s)" % (detail, where)
            log.error(msg)
            return False, msg
        code, out = self.runner.run(["docker", "exec", "-i", pg, "pg_restore", "--list"],
                                    input_path=dump_path, timeout=LONG_TIMEOUT)
        if code != 0:
            return False, "restore refused: not a readable dump: %s (%s)" % (_tail(out, 3), where)

        def admin(sql):
            return self._psql(sql, db="postgres", pg=pg)

        def drop_restoring():
            c, o = admin('DROP DATABASE IF EXISTS "%s" WITH (FORCE)' % restoring)
            if c != 0:
                log.warning("could not drop %s: %s", restoring, _tail(o, 3))

        def fail(msg):
            msg = "restore failed: %s; live database %s untouched (%s)" % (msg, db, where)
            log.error(msg)
            return False, msg

        # 2. Restore into <db>_restoring.
        code, out = admin('DROP DATABASE IF EXISTS "%s" WITH (FORCE)' % restoring)
        if code != 0:
            return fail("could not clear %s: %s" % (restoring, _tail(out, 3)))
        code, out = self.runner.run(["docker", "exec", pg, "createdb", "-U", self.pg_user, restoring],
                                    timeout=SHORT_TIMEOUT)
        if code != 0:
            drop_restoring()
            return fail("createdb %s: %s" % (restoring, _tail(out, 3)))
        # Same server: keep owners and GRANTs. Exit 1 = warnings (e.g. a missing
        # role); the schema_migrations check decides.
        code, out = self.runner.run(
            ["docker", "exec", "-i", pg, "pg_restore", "-U", self.pg_user, "-d", restoring],
            input_path=dump_path, timeout=LONG_TIMEOUT)
        if code not in (0, 1):
            drop_restoring()
            return fail("pg_restore exit %s: %s" % (code, _tail(out, 5)))
        m = _IGNORED_RE.search(out or "")
        warnings = ("; pg_restore: errors ignored on restore: %s" % m.group(1)) if m else ""
        if code == 1:
            log.warning("pg_restore reported warnings: %s", _tail(out, 5))
        try:
            n = self._migration_count(restoring, pg)
        except OpsError as e:
            drop_restoring()
            return fail("check of %s: %s" % (restoring, e))
        if n <= 0:
            drop_restoring()
            return fail("schema_migrations is empty in %s%s" % (restoring, warnings))

        # 3. Swap.
        code, out = admin('DROP DATABASE IF EXISTS "%s" WITH (FORCE)' % failed)
        if code != 0:
            drop_restoring()
            return fail("could not drop old %s: %s" % (failed, _tail(out, 3)))
        terminate = ("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                     "WHERE datname = '%s' AND pid <> pg_backend_pid()" % db)
        renamed = False
        for _ in range(3):   # a client may reconnect between terminate and rename
            admin(terminate)
            code, out = admin('ALTER DATABASE "%s" RENAME TO "%s"' % (db, failed))
            if code == 0:
                renamed = True
                break
        if not renamed:
            drop_restoring()
            return fail("could not rename %s to %s: %s" % (db, failed, _tail(out, 3)))
        code, out = admin('ALTER DATABASE "%s" RENAME TO "%s"' % (restoring, db))
        if code != 0:
            err = _tail(out, 3)
            c2, o2 = admin('ALTER DATABASE "%s" RENAME TO "%s"' % (failed, db))
            if c2 != 0:
                msg = ("restore failed: could not rename %s to %s (%s) and could not rename %s "
                       "back (%s). Live data is in %s, the restored copy in %s (%s)"
                       % (restoring, db, err, failed, _tail(o2, 3), failed, restoring, where))
                log.error(msg)
                return False, msg
            msg = ("restore failed: could not rename %s to %s: %s; %s renamed back, "
                   "live database unchanged (%s)" % (restoring, db, err, failed, where))
            log.error(msg)
            return False, msg
        return True, "restored %s from %s (%d migrations; previous data kept as %s%s)" % (
            db, dump_path, n, failed, warnings)

    def recover_interrupted_swap(self, pg=None):
        """Undo a restore swap that was cut between its two renames.

        Only acts when <db> does not exist: renames <db>_failed back to <db>
        (the data that was live before that restore), or, when there is no
        <db>_failed, a <db>_restoring whose schema_migrations is not empty.
        Returns (ok, detail); ok=False when the databases cannot be listed or
        the rename failed. Never drops anything."""
        db = self.pg_db
        failed, restoring = db + "_failed", db + "_restoring"
        try:
            pg = pg or self._pg()
            code, out = self._psql_read(
                "SELECT datname FROM pg_database WHERE datname IN ('%s', '%s', '%s')"
                % (db, failed, restoring), db="postgres", pg=pg)
            if code != 0:
                return False, "cannot list databases: %s" % _tail(out, 3)
            names = {l.strip() for l in out.splitlines() if l.strip()}
            if db in names:
                return True, "live database present"
            if failed in names:
                source = failed
            elif restoring in names and self._migration_count(restoring, pg) > 0:
                source = restoring
            else:
                log.error("live database %s is missing and there is nothing to rename back", db)
                return True, "live database missing; nothing to recover"
            code, out = self._psql('ALTER DATABASE "%s" RENAME TO "%s"' % (source, db), db="postgres", pg=pg)
            if code != 0:
                return False, ("live database %s is missing and %s could not be renamed back: %s"
                               % (db, source, _tail(out, 3)))
            log.warning("interrupted restore found: %s was missing; renamed %s back to %s", db, source, db)
            return True, "renamed %s back to %s" % (source, db)
        except OpsError as e:
            return False, "cannot check databases: %s" % e

    # ------------------------------------------------------------ compose

    def pull_images(self, compose_file, services=PULL_SERVICES):
        code, out = self.runner.run(
            self._compose("pull", "--quiet", *services, compose_file=compose_file), timeout=1800)
        if code != 0:
            log.warning("compose pull failed: %s", _tail(out, 10))
        return code == 0

    def up(self, services):
        if not services:
            log.warning("up() refused: empty service list would start every service")
            return False
        # --no-deps: never touch services not named here (postgres above all,
        # even when its definition changed in the new compose file).
        code, out = self.runner.run(self._compose("up", "-d", "--no-deps", *services), timeout=900)
        if code != 0:
            log.warning("compose up %s failed: %s", " ".join(services), _tail(out, 10))
        return code == 0

    def stop(self, services):
        if not services:
            return False
        code, out = self.runner.run(self._compose("stop", *services), timeout=300)
        if code != 0:
            log.warning("compose stop %s failed: %s", " ".join(services), _tail(out, 10))
        return code == 0

    # ------------------------------------------------------------- health

    def _left(self, deadline):
        """Seconds left before deadline, as a command timeout; 0 = budget spent."""
        left = deadline - self._clock()
        return 0 if left <= 0 else max(1, min(SHORT_TIMEOUT, int(left)))

    def _health_once(self, deadline):
        """One round of checks. (ok, detail); detail None = budget ran out mid-round."""
        t = self._left(deadline)
        if not t:
            return False, None
        cid = self._service_cid("backend", timeout=t)
        if not cid:
            return False, "backend container not found"
        t = self._left(deadline)
        if not t:
            return False, None
        status, health = self._inspect_state(cid, timeout=t)
        if health != "healthy":
            return False, "backend not healthy (%s/%s)" % (status or "?", health or "no healthcheck")
        t = self._left(deadline)
        if not t:
            return False, None
        code, out = self.runner.run(self._compose("exec", "-T", "backend", "flask", "migration-status"),
                                    timeout=t)
        if code != 0:
            return False, "migration-status failed (exit %s): %s" % (code, _tail(out, 5))
        if "!!" in out:
            return False, "migration-status warns: %s" % _tail(
                "\n".join(l for l in out.splitlines() if "!!" in l), 3)
        if not _ZERO_PENDING_RE.search(out):
            return False, "migrations pending: %s" % self._status_summary(out)
        t = self._left(deadline)
        if not t:
            return False, None
        code, out = self.runner.run(
            self._compose("exec", "-T", "backend", "curl", "-s", "-o", "/dev/null",
                          "-w", "%{http_code}", "--max-time", str(min(5, t)), "http://frontend/"),
            timeout=t, stderr="separate")
        if out.strip() != "200":
            return False, "frontend did not answer 200 (got %r)" % _tail(out, 1, 80)
        statuses = {}
        for svc in ("scheduler", "telegram-bot"):
            t = self._left(deadline)
            if not t:
                return False, None
            cid = self._service_cid(svc, timeout=t)
            t = self._left(deadline)
            if not t:
                return False, None
            statuses[svc] = (cid, self._inspect_state(cid, timeout=t)[0] if cid else "")
        if statuses["scheduler"][1] != "running":
            return False, "scheduler not running (%s)" % (statuses["scheduler"][1] or "no container")
        cid, status = statuses["telegram-bot"]
        if status == "running":
            return True, "ok"
        what = "telegram-bot not running (%s)" % (status or "no container")
        if not self.telegram_required:
            return True, "ok; warning: %s; TELEGRAM_TOKEN is not set" % what
        if status == "restarting":
            t = self._left(deadline)
            if not t:
                return False, None
            restarts = self._restart_count(cid, timeout=t)
            if restarts is not None and restarts < TELEGRAM_MAX_RESTARTS:
                return True, "ok; warning: telegram-bot restarting (%d restarts)" % restarts
            what = "telegram-bot restarting (%s restarts)" % ("?" if restarts is None else restarts)
        return False, what

    def _restart_count(self, cid, timeout=SHORT_TIMEOUT):
        code, out = self.runner.run(["docker", "inspect", "-f", "{{.RestartCount}}", cid],
                                    timeout=timeout, stderr="separate")
        try:
            return int(out.strip()) if code == 0 else None
        except ValueError:
            return None

    def healthy(self, timeout_s=300):
        """Poll until every check passes or timeout_s runs out. (ok, last detail).
        Each command's timeout is capped at the time left, so the budget is not
        overrun by more than a second or two."""
        deadline = self._clock() + timeout_s
        last = "health check did not run"
        while True:
            ok, detail = self._health_once(deadline)
            if ok:
                if detail != "ok":
                    log.warning("health check passed with a %s", detail[4:])
                return True, detail
            if detail:
                last = detail
            left = deadline - self._clock()
            if left <= 0:
                log.warning("health check gave up after %ss: %s", timeout_s, last)
                return False, last
            self._sleep(min(self.poll_s, left))

    # ------------------------------------------------------------- images

    def prune_images(self, keep_shas):
        """Remove local <registry>/billar-pos-* images whose tag is a commit SHA
        not in keep_shas (current and previous version). Never touches bar-*
        tags, other tags, untagged images, postgres, other registries, or an
        image any container (running or stopped) was created from. Never uses
        -f. Failures are only logged; returns the list removed."""
        removed = []
        try:
            keep = {s for s in keep_shas if s}
            prefix = self.registry + "/billar-pos-"
            code, out = self.runner.run(["docker", "image", "ls", "--format", "{{.Repository}}|{{.Tag}}"],
                                        timeout=SHORT_TIMEOUT, stderr="separate")
            if code != 0:
                log.warning("image cleanup skipped: cannot list images: %s", _tail(out, 3))
                return removed
            code, used = self.runner.run(["docker", "ps", "-a", "--format", "{{.Image}}"],
                                         timeout=SHORT_TIMEOUT, stderr="separate")
            if code != 0:
                log.warning("image cleanup skipped: cannot list containers: %s", _tail(used, 3))
                return removed
            in_use = {l.strip() for l in used.splitlines() if l.strip()}
            for line in out.splitlines():
                repo, _, tag = line.strip().partition("|")
                ref = "%s:%s" % (repo, tag)
                if (not repo.startswith(prefix) or not _SHA_TAG_RE.match(tag) or tag in keep
                        or ref in in_use):
                    continue
                code, o = self.runner.run(["docker", "rmi", ref], timeout=SHORT_TIMEOUT)
                if code == 0:
                    removed.append(ref)
                    log.info("old image removed: %s", ref)
                else:
                    log.warning("could not remove old image %s: %s", ref, _tail(o, 2))
        except Exception as e:
            log.warning("image cleanup failed: %s: %s", type(e).__name__, e)
        return removed
