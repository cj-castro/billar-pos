"""Plain-script tests for updater.run (the nightly update, resume, scheduler)
and updater.__main__ (CLI). Run: python -m tests.test_run

No Docker: the real Ops is driven through FakeRunner. The fake "bar" keeps a
running version that changes when `compose up -d <app services>` is called,
reading the live compose file at that moment, so health and the backend image
follow what was really switched.
"""
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

from updater import core
from updater import run as runmod
from updater.ops import Ops
from updater.run import run_update
from updater.testing import FakeRunner

FAILED = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + ": " + name)
    if not cond:
        FAILED.append(name)


OLD = "a" * 40
NEW = "b" * 40
OLD7, NEW7 = OLD[:7], NEW[:7]
TZ = timezone(timedelta(hours=-6))
NOW = datetime(2026, 11, 28, 3, 0, tzinfo=TZ)
BACKUP_NAME = "pre-update-%s-to-%s-20261128-0300.dump" % (OLD7, NEW7)
TOKEN = "ghp_SECRET_TOKEN_123"
HOOK = "https://hooks.slack.com/services/T000/B000/SECRETHOOK"
ENV = {"GHCR_USER": "cj-castro", "GHCR_TOKEN": TOKEN, "SLACK_WEBHOOK_URL": HOOK,
       "BAR_HOST_DIR": "C:\\Users\\bar\\billiards", "TZ": "America/Mexico_City"}

PG_ID = "a1b2c3d4e5f6"
BE_ID, SCH_ID, TG_ID = "be00000000b1", "5c00000000c2", "7e00000000d3"
UPD_ID = "0d00000000e4"
REL_CID = "c0ffee000001"
APP = "backend frontend scheduler telegram-bot backup"
SELF_UP = "up -d --no-deps updater"
NEW2 = "c" * 40


def compose_for(sha):
    return ("name: billiards\nservices:\n  backend:\n    image: ghcr.io/cj-castro/billar-pos-backend:%s\n"
            "  updater:\n    image: ghcr.io/cj-castro/billar-pos-updater:%s\n" % (sha, sha)).encode()


def release_json(sha=NEW, migrations=("001", "058")):
    return json.dumps({"sha": sha, "built_at": "2026-11-28T00:00:00Z", "migrations": list(migrations)})


class Bar:
    """A fake bar PC: compose file, state file, backups folder, FakeRunner."""

    def __init__(self, state=None, live="001\n058\n", cash=0, tickets=0, healthy=(OLD, NEW, NEW2),
                 release=None, compose=None, running=OLD, previous=None, overrides=None,
                 env=None, new_sha=NEW):
        self.dir = tempfile.mkdtemp(prefix="bar-test-")
        self.compose = os.path.join(self.dir, "docker-compose.bar.yml")
        self.previous = self.compose + ".previous"
        self.backups = os.path.join(self.dir, "backups")
        self.state_path = os.path.join(self.dir, "updater", "state.json")
        os.makedirs(os.path.dirname(self.state_path))
        with open(self.compose, "wb") as f:
            f.write(compose or compose_for(OLD))
        if previous is not None:
            with open(self.previous, "wb") as f:
                f.write(previous)
        if state is not None:
            if isinstance(state, str):
                with open(self.state_path, "w") as f:
                    f.write(state)
            else:
                core.save_state(self.state_path, state)
        self.env = dict(env if env is not None else ENV)
        self.new_sha = new_sha
        self.release = release if release is not None else release_json(new_sha)
        self.running = running
        self.healthy = set(healthy)
        self.release_dirs = []
        self.snapshots = []
        self.t = [0.0]
        self.sent = []
        r = {
            "docker login": (0, "Login Succeeded"),
            "docker pull ghcr.io/cj-castro/billar-pos-release:bar-stable": (0, ""),
            "docker create ghcr.io/cj-castro/billar-pos-release:bar-stable": (0, REL_CID + "\n"),
            REL_CID + ":/release.json": self._cp(lambda: self.release.encode()),
            REL_CID + ":/docker-compose.bar.yml": self._cp(lambda: compose_for(self.new_sha)),
            "ps -q postgres": (0, PG_ID + "\n"),
            "SELECT version FROM schema_migrations": (0, live),
            "cash_sessions WHERE status='OPEN'": cash if isinstance(cash, list) else (0, "%d\n" % cash),
            "tickets WHERE status='OPEN'": tickets if isinstance(tickets, list) else (0, "%d\n" % tickets),
            "pull --quiet": (0, ""),
            "pg_dump -Fc": self._write_dump,
            "SELECT count(*) FROM schema_migrations": (0, "2\n"),
            "flask init-db && python seed.py": (0, "2/2 applied, 0 pending\n"),
            ".env up -d": self._up,
            ".env stop": (0, ""),
            "ps -q backend": (0, BE_ID + "\n"),
            "ps -q scheduler": (0, SCH_ID + "\n"),
            "ps -q telegram-bot": (0, TG_ID + "\n"),
            "ps -q updater": (0, UPD_ID + "\n"),
            "{{end}} " + BE_ID: lambda a, **k: (0, "running|healthy" if self.running in self.healthy
                                                else "running|unhealthy"),
            "{{end}} " + SCH_ID: (0, "running|"),
            "{{end}} " + TG_ID: (0, "running|"),
            "exec -T backend flask migration-status": (0, "2/2 applied, 0 pending\n"),
            "http://frontend/": (0, "200"),
            "{{.Config.Image}} " + BE_ID: lambda a, **k: (0, "ghcr.io/cj-castro/billar-pos-backend:%s\n"
                                                         % self.running),
            "pg_restore --list": (0, ""),
        }
        r.update(overrides or {})
        self.fake = FakeRunner(r)
        self.ops = Ops(self.fake, project="billiards", compose_file=self.compose,
                       env_file=os.path.join(self.dir, ".env"), pg_user="billiard",
                       pg_db="billiardbar", pg_password="pw", registry="ghcr.io/cj-castro",
                       clock=lambda: self.t[0], sleep=self._sleep, poll_s=5)

    def _sleep(self, s):
        self.t[0] += s

    def _cp(self, content):
        def fn(args, **kw):
            dest = args[-1]
            self.release_dirs.append(os.path.dirname(dest))
            with open(dest, "wb") as f:
                f.write(content())
            return 0, ""
        return fn

    def _write_dump(self, args, **kw):
        with open(kw["stdout_path"], "wb") as f:
            f.write(b"PGDMP" + b"x" * 4096)
        return 0, ""

    def _up(self, args, **kw):
        if args[-1] != "updater":
            text = self.read(self.compose)
            self.running = next((x for x in (NEW, NEW2) if x.encode() in text), OLD)
            state = None
            try:
                with open(self.state_path) as f:
                    state = json.load(f)
            except Exception:
                pass
            self.snapshots.append({"compose": text, "state": state})
        return 0, ""

    def read(self, path):
        with open(path, "rb") as f:
            return f.read()

    def state(self):
        return core.load_state(self.state_path)

    def cmds(self):
        return self.fake.commands()

    def run(self, now=NOW, **kw):
        self.report = {}
        return run_update(self.ops, self.env, self.state_path, now, self.sent.append,
                          report=self.report, **kw)

    def done(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def idx(cmds, needle):
    for i, c in enumerate(cmds):
        if needle in c:
            return i
    return -1


def has(cmds, needle):
    return idx(cmds, needle) >= 0


def no_switch(bar, label):
    """Nothing about the live stack changed."""
    c = bar.cmds()
    check(label + ": no compose up", not has(c, ".env up -d"))
    check(label + ": no compose stop", not has(c, ".env stop"))
    check(label + ": live compose unchanged", bar.read(bar.compose) == compose_for(OLD))
    check(label + ": no live restore", not has(c, "pg_restore --list") and not has(c, "ALTER DATABASE"))
    check(label + ": no in_progress left", bar.state().in_progress is None)


def release_dirs_gone(bar, label):
    check(label + ": release temp dir removed",
          bar.release_dirs and all(not os.path.exists(d) for d in bar.release_dirs))


# --------------------------------------------------------------- outcomes

def test_noop():
    bar = Bar(state=core.State(current_sha=NEW, previous_sha=OLD))
    out = bar.run()
    check("noop: outcome", out == "noop")
    check("noop: no message", bar.sent == [])
    check("noop: no backup", not has(bar.cmds(), "pg_dump"))
    check("noop: no image pull", not has(bar.cmds(), "pull --quiet"))
    no_switch(bar, "noop")
    release_dirs_gone(bar, "noop")
    check("noop: state kept", bar.state().current_sha == NEW and bar.state().previous_sha == OLD)
    bar.done()


def test_installed():
    old_names = ["pre-update-x-to-y-202611%02d-0300.dump" % d for d in range(1, 12)]   # 11 older
    bar = Bar(state=core.State(current_sha=OLD))
    os.makedirs(bar.backups)
    for n in old_names + ["other.dump"]:
        with open(os.path.join(bar.backups, n), "wb") as f:
            f.write(b"x")
    out = bar.run()
    c = bar.cmds()
    check("installed: outcome", out == "installed")
    check("installed: login token on stdin only",
          [k["input_text"] for k in bar.fake.calls if k["args"][:2] == ["docker", "login"]] == [TOKEN])
    check("installed: token never in argv", not any(TOKEN in x for x in c))
    backup = os.path.join(bar.backups, BACKUP_NAME)
    check("installed: backup written with the expected name", os.path.isfile(backup))
    names = sorted(os.listdir(bar.backups))
    check("installed: pruned to newest 10 pre-update backups",
          len([n for n in names if n.startswith("pre-update-")]) == 10 and BACKUP_NAME in names
          and "other.dump" in names and old_names[0] not in names and old_names[1] not in names)
    pull = [k for k in bar.fake.calls if "pull --quiet" in " ".join(k["args"])]
    check("installed: images pulled from the release compose (not the live one)",
          len(pull) == 1 and bar.compose not in pull[0]["args"]
          and pull[0]["args"][pull[0]["args"].index("-f") + 1].endswith("docker-compose.bar.yml"))
    check("installed: order open check < pull < backup < rehearsal < up",
          0 <= idx(c, "tickets WHERE") < idx(c, "pull --quiet") < idx(c, "pg_dump")
          < idx(c, "flask init-db") < idx(c, ".env up -d"))
    reh = [k for k in bar.fake.calls if "flask init-db && python seed.py" in " ".join(k["args"])]
    check("installed: rehearsal uses the new backend image (Ruling I)",
          len(reh) == 1 and "ghcr.io/cj-castro/billar-pos-backend:" + NEW in reh[0]["args"])
    check("installed: open check repeated after the rehearsal",
          idx(c, "flask init-db") < max(i for i, x in enumerate(c) if "tickets WHERE" in x) < idx(c, ".env up -d"))
    ups = [x for x in c if ".env up -d" in x]
    check("installed: app services up, then updater", len(ups) == 2
          and ups[0].endswith("up -d --no-deps " + APP) and ups[1].endswith(SELF_UP))
    check("installed: postgres never in up/stop/pull",
          not any(("up -d" in x or " stop " in x or "pull --quiet" in x) and "postgres" in x for x in c))
    check("installed: up(['updater']) is the LAST call", c[-1].endswith(SELF_UP))
    last = bar.fake.calls[-1]["args"]
    check("installed: self-update runs from a detached helper sharing the updater's mounts",
          last[:4] == ["docker", "run", "-d", "--rm"] and "--volumes-from" in last
          and last[last.index("--volumes-from") + 1] == UPD_ID
          and "ghcr.io/cj-castro/billar-pos-updater:" + NEW in last
          and last[last.index("--entrypoint") + 1] == "docker"
          and last[last.index("ghcr.io/cj-castro/billar-pos-updater:" + NEW) + 1:][:3] == ["compose", "-p", "billiards"])
    check("installed: self-update helper passes --no-deps", last[-2:] == ["--no-deps", "updater"])
    src = open(runmod.__file__).read()
    check("run.py uses only public Ops helpers", "ops._" not in src)
    check("installed: self-update after the message was sent",
          len(bar.sent) == 1 and bar.state().current_sha == NEW)
    snap = bar.snapshots[0] if bar.snapshots else {}
    ip = (snap.get("state") or {}).get("in_progress") or {}
    check("installed: in_progress recorded before compose up",
          ip.get("new_sha") == NEW and ip.get("old_sha") == OLD and ip.get("backup_path") == backup
          and ip.get("started_at") == NOW.isoformat() and ip.get("phase") == "started")
    check("installed: new compose written before up", snap.get("compose") == compose_for(NEW))
    check("installed: .previous holds the old compose", bar.read(bar.previous) == compose_for(OLD))
    check("installed: live compose is the new one", bar.read(bar.compose) == compose_for(NEW))
    st = bar.state()
    check("installed: state current/previous", st.current_sha == NEW and st.previous_sha == OLD)
    check("installed: in_progress cleared", st.in_progress is None)
    check("installed: last_result", st.last_result == "installed")
    check("installed: exactly one message", len(bar.sent) == 1)
    msg = bar.sent[0] if bar.sent else ""
    check("installed: message says actualizado with both SHAs",
          "actualizado" in msg and OLD7 in msg and NEW7 in msg)
    check("installed: message names the backup file", BACKUP_NAME in msg)
    check("installed: no stop, no restore", not has(c, ".env stop") and not has(c, "pg_restore --list"))
    release_dirs_gone(bar, "installed")
    bar.done()


def test_self_update_fallback():
    bar = Bar(state=core.State(current_sha=OLD), overrides={"ps -q updater": (0, "")})
    out = bar.run()
    c = bar.cmds()
    check("self-update: no updater container -> plain compose up -d updater, last",
          out == "installed" and c[-1].startswith("docker compose") and c[-1].endswith(SELF_UP))
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD),
              overrides={"--volumes-from": (125, "Unable to find image")})
    out = bar.run()
    check("self-update: helper failure does not change the outcome or state",
          out == "installed" and bar.state().current_sha == NEW and len(bar.sent) == 1)
    bar.done()


def test_first_run_reinstall_and_empty_token():
    env = dict(ENV, GHCR_TOKEN="")
    bar = Bar(state=None, env=env)
    out = bar.run()
    check("first run (no state): same-version reinstall proceeds", out == "installed")
    check("empty GHCR_TOKEN: docker login skipped", not has(bar.cmds(), "docker login"))
    check("first run: backup named from 'none'",
          os.path.isfile(os.path.join(bar.backups, "pre-update-none-to-%s-20261128-0300.dump" % NEW7)))
    bar.done()


def test_blocked_open():
    bar = Bar(state=core.State(current_sha=OLD), tickets=1)
    out = bar.run()
    check("blocked_open: outcome", out == "blocked_open")
    check("blocked_open: no message from run_update (daemon posts at window end)", bar.sent == [])
    check("blocked_open: report carries the Spanish message",
          "abiertas" in (bar.report.get("message") or ""))
    check("blocked_open: no backup, no pull", not has(bar.cmds(), "pg_dump") and not has(bar.cmds(), "pull --quiet"))
    no_switch(bar, "blocked_open")
    release_dirs_gone(bar, "blocked_open")
    check("blocked_open: last_result", bar.state().last_result == "blocked_open")
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), cash=1)
    check("blocked_open: an open cash session blocks", bar.run() == "blocked_open")
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), overrides={"tickets WHERE status='OPEN'": (1, "psql: error")})
    check("db_unreachable: unreadable open count (never 'nothing open', never 'open tables')",
          bar.run() == "db_unreachable")
    check("db_unreachable: no message from run_update (window posts it)", bar.sent == [])
    check("db_unreachable: report message says the DB could not be read",
          "no se pudo leer la base de datos" in (bar.report.get("message") or "").lower())
    check("db_unreachable (counts): no backup", not has(bar.cmds(), "pg_dump"))
    no_switch(bar, "db_unreachable (counts)")
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), overrides={"SELECT version FROM schema_migrations": (2, "boom")})
    check("db_unreachable: unreadable live migrations", bar.run() == "db_unreachable")
    check("db_unreachable (versions): no backup", not has(bar.cmds(), "pg_dump"))
    bar.done()

    # Somebody opens a ticket while the copy is being rehearsed.
    bar = Bar(state=core.State(current_sha=OLD), tickets=[(0, "0\n"), (0, "1\n")])
    out = bar.run()
    check("blocked_open: ticket opened during rehearsal blocks before the switch", out == "blocked_open")
    check("blocked_open (re-check): rehearsal ran", has(bar.cmds(), "flask init-db"))
    no_switch(bar, "blocked_open (re-check)")
    check("blocked_open (re-check): .previous not written", not os.path.exists(bar.previous))
    bar.done()


def test_registry_down():
    bar = Bar(state=core.State(current_sha=OLD),
              overrides={"docker pull ghcr.io/cj-castro/billar-pos-release:bar-stable": (1, "net down")})
    out = bar.run()
    check("registry_down: outcome", out == "registry_down")
    check("registry_down: no message from run_update", bar.sent == [])
    msg = bar.report.get("message") or ""
    check("registry_down: report message, no 'none' placeholder", "registro" in msg and "none" not in msg)
    check("registry_down: no backup", not has(bar.cmds(), "pg_dump"))
    no_switch(bar, "registry_down")
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), overrides={"pull --quiet": (1, "toomanyrequests")})
    check("registry_down: image download failure", bar.run() == "registry_down")
    check("registry_down (images): no backup taken", not has(bar.cmds(), "pg_dump"))
    no_switch(bar, "registry_down (images)")
    release_dirs_gone(bar, "registry_down (images)")
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), release="{not json")
    check("registry_down: unreadable release.json", bar.run() == "registry_down")
    no_switch(bar, "registry_down (release.json)")
    release_dirs_gone(bar, "registry_down (release.json)")
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD),
              overrides={"docker login": (1, "denied"),
                         "docker pull ghcr.io/cj-castro/billar-pos-release:bar-stable": (1, "unauthorized")})
    check("registry_down: failed login then failed pull", bar.run() == "registry_down")
    check("registry_down: error mentions login", "login" in (bar.report.get("error") or ""))
    bar.done()


def test_backup_failed():
    bar = Bar(state=core.State(current_sha=OLD), overrides={"pg_dump -Fc": (1, "No space left on device")})
    out = bar.run()
    check("backup_failed: outcome", out == "backup_failed")
    check("backup_failed: one message", len(bar.sent) == 1 and "respaldo" in bar.sent[0])
    check("backup_failed: no rehearsal", not has(bar.cmds(), "flask init-db"))
    no_switch(bar, "backup_failed")
    check("backup_failed: no compose write (.previous absent)", not os.path.exists(bar.previous))
    check("backup_failed: no partial dump left", not os.listdir(bar.backups))
    bar.done()


def test_rehearsal_failed():
    bar = Bar(state=core.State(current_sha=OLD),
              overrides={"flask init-db && python seed.py": (1, "AssertionError: 058 check failed " + TOKEN)})
    out = bar.run()
    check("rehearsal_failed: outcome", out == "rehearsal_failed")
    check("rehearsal_failed: one message", len(bar.sent) == 1 and "ensayo" in bar.sent[0])
    check("rehearsal_failed: message carries the error", "058 check failed" in bar.sent[0])
    check("rehearsal_failed: token redacted from the message", TOKEN not in bar.sent[0] and "***" in bar.sent[0])
    no_switch(bar, "rehearsal_failed")
    check("rehearsal_failed: compose file unchanged, no .previous", not os.path.exists(bar.previous))
    check("rehearsal_failed: scratch DB dropped", has(bar.cmds(), "DROP DATABASE IF EXISTS billar_scratch_update"))
    check("rehearsal_failed: backup kept", os.path.isfile(os.path.join(bar.backups, BACKUP_NAME)))
    bar.done()


def test_older_than_db():
    bar = Bar(state=core.State(current_sha=OLD), live="001\n058\n059\n")
    out = bar.run()
    check("older_than_db: outcome", out == "older_than_db")
    check("older_than_db: message", len(bar.sent) == 1 and "más nuevas" in bar.sent[0])
    check("older_than_db: no backup taken", not has(bar.cmds(), "pg_dump"))
    check("older_than_db: no open check, no pull", not has(bar.cmds(), "tickets WHERE")
          and not has(bar.cmds(), "pull --quiet"))
    no_switch(bar, "older_than_db")
    bar.done()


def test_rolled_back():
    bar = Bar(state=core.State(current_sha=OLD), healthy=(OLD,))
    out = bar.run()
    c = bar.cmds()
    backup = os.path.join(bar.backups, BACKUP_NAME)
    check("rolled_back: outcome", out == "rolled_back")
    check("rolled_back: order up < stop < restore < up again",
          0 <= idx(c, ".env up -d") < idx(c, ".env stop " + APP) < idx(c, "pg_restore --list")
          < max(i for i, x in enumerate(c) if ".env up -d" in x))
    lst = [k for k in bar.fake.calls if "pg_restore --list" in " ".join(k["args"])]
    check("rolled_back: restore reads the recorded backup", lst and lst[0]["input_path"] == backup)
    check("rolled_back: old compose restored", bar.read(bar.compose) == compose_for(OLD))
    check("rolled_back: old version running again", bar.running == OLD)
    check("rolled_back: updater not restarted", not any(x.endswith(SELF_UP) for x in c))
    st = bar.state()
    check("rolled_back: state still old, in_progress cleared",
          st.current_sha == OLD and st.in_progress is None and st.last_result == "rolled_back")
    check("rolled_back: one message", len(bar.sent) == 1)
    msg = bar.sent[0] if bar.sent else ""
    check("rolled_back: message says regresó with step and error",
          "regresó" in msg and OLD7 in msg and "salud" in msg and "unhealthy" in msg)
    bar.done()

    # compose up of the new version fails: the new backend may have started -> restore.
    calls = {"n": 0}

    def up_fails_once(args, **kw):
        if args[-1] != "updater":
            calls["n"] += 1
            if calls["n"] == 1:
                return 1, "dependency failed to start: container billiards-backend-1 is unhealthy"
        return bar2._up(args, **kw)
    bar2 = Bar(state=core.State(current_sha=OLD), overrides={".env up -d": up_fails_once})
    out = bar2.run()
    check("rolled_back (up failed): outcome", out == "rolled_back")
    check("rolled_back (up failed): database restored", has(bar2.cmds(), "pg_restore --list"))
    check("rolled_back (up failed): message names the start step", "arranque" in (bar2.sent or [""])[0])
    bar2.done()

    # An exception inside the switch still rolls back.
    seen = {"n": 0}

    def status_raises_once(args, **kw):
        seen["n"] += 1
        if seen["n"] == 1:
            raise RuntimeError("socket closed")
        return 0, "2/2 applied, 0 pending\n"
    bar3 = Bar(state=core.State(current_sha=OLD),
               overrides={"exec -T backend flask migration-status": status_raises_once})
    out = bar3.run()
    check("rolled_back (exception in switch): outcome", out == "rolled_back")
    check("rolled_back (exception in switch): restored and compose back",
          has(bar3.cmds(), "pg_restore --list") and bar3.read(bar3.compose) == compose_for(OLD))
    check("rolled_back (exception in switch): in_progress cleared", bar3.state().in_progress is None)
    bar3.done()


def test_rollback_failed():
    bar = Bar(state=core.State(current_sha=OLD), healthy=(OLD,),
              overrides={"pg_restore --list": (1, "pg_restore: error: input file is too short")})
    out = bar.run()
    c = bar.cmds()
    host = "C:\\Users\\bar\\billiards\\backups\\" + BACKUP_NAME
    check("rollback_failed (restore): outcome", out == "rollback_failed")
    check("rollback_failed (restore): stop before restore", idx(c, ".env stop") < idx(c, "pg_restore --list"))
    check("rollback_failed (restore): app not restarted on an unknown DB",
          len([x for x in c if ".env up -d" in x]) == 1)
    check("rollback_failed (restore): compose put back to the old one", bar.read(bar.compose) == compose_for(OLD))
    msg = bar.sent[0] if bar.sent else ""
    check("rollback_failed (restore): one 'POS caído' message", len(bar.sent) == 1 and "POS caído" in msg)
    check("rollback_failed (restore): message has the host backup path", host in msg)
    check("rollback_failed (restore): message has the restore detail", "not a readable dump" in msg)
    st = bar.state()
    check("rollback_failed: in_progress cleared (never re-run a restore later by itself)",
          st.in_progress is None and st.last_result == "rollback_failed" and st.current_sha == OLD)
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), healthy=())
    out = bar.run()
    check("rollback_failed (old version unhealthy too): outcome", out == "rollback_failed")
    check("rollback_failed (old unhealthy): restore did run", has(bar.cmds(), "pg_restore --list"))
    check("rollback_failed (old unhealthy): message has backup path",
          bar.sent and "C:\\Users\\bar\\billiards\\backups\\" + BACKUP_NAME in bar.sent[0])
    bar.done()


def in_progress_state(dump, phase="started"):
    ip = {"new_sha": NEW, "old_sha": OLD, "backup_path": dump,
          "started_at": "2026-11-28T03:05:00-06:00"}
    if phase:
        ip["phase"] = phase
    return core.State(current_sha=OLD, in_progress=ip)


def make_dump(bar):
    os.makedirs(bar.backups, exist_ok=True)
    p = os.path.join(bar.backups, BACKUP_NAME)
    with open(p, "wb") as f:
        f.write(b"PGDMP" + b"x" * 4096)
    return p


def resumed_bar(phase="started", healthy=(OLD, NEW), running=NEW, compose=None):
    bar = Bar(compose=compose or compose_for(NEW), previous=compose_for(OLD), running=running,
              healthy=healthy)
    dump = make_dump(bar)
    core.save_state(bar.state_path, in_progress_state(dump, phase))
    return bar, dump


def test_resume():
    bar, dump = resumed_bar()
    out = bar.run()
    c = bar.cmds()
    check("resumed_ok: outcome", out == "resumed_ok")
    check("resumed_ok: no new pull/backup", not has(c, "billar-pos-release") and not has(c, "pg_dump"))
    st = bar.state()
    check("resumed_ok: state records the new version",
          st.current_sha == NEW and st.previous_sha == OLD and st.in_progress is None
          and st.last_result == "resumed_ok")
    check("resumed_ok: 'installed' message (Ruling J)", len(bar.sent) == 1 and "actualizado" in bar.sent[0])
    check("resumed_ok: updater restarted last (helper, new image)", c and c[-1].endswith(SELF_UP)
          and "--volumes-from" in c[-1] and "billar-pos-updater:" + NEW in c[-1])
    check("resumed_ok: no restore", not has(c, "pg_restore"))
    bar.done()

    bar, dump = resumed_bar(healthy=(OLD,))
    out = bar.run()
    c = bar.cmds()
    check("resumed_rolled_back: outcome", out == "resumed_rolled_back")
    lst = [k for k in bar.fake.calls if "pg_restore --list" in " ".join(k["args"])]
    check("resumed_rolled_back: restore called with the recorded dump", lst and lst[0]["input_path"] == dump)
    check("resumed_rolled_back: stop before restore", 0 <= idx(c, ".env stop") < idx(c, "pg_restore --list"))
    check("resumed_rolled_back: old compose restored and running",
          bar.read(bar.compose) == compose_for(OLD) and bar.running == OLD)
    check("resumed_rolled_back: 'rolled_back' message (Ruling J)", len(bar.sent) == 1 and "regresó" in bar.sent[0])
    st = bar.state()
    check("resumed_rolled_back: state old, in_progress cleared", st.current_sha == OLD and st.in_progress is None)
    check("resumed_rolled_back: updater not restarted", not any(x.endswith(SELF_UP) for x in c))
    bar.done()

    # Healthy, but the old backend is what runs: the new one never started
    # (the resume's own compose up fails, so the old containers keep running).
    bar, dump = resumed_bar(running=OLD)
    first_up = {"n": 0}

    def resume_up_fails(args, **kw):
        if args[-1] != "updater":
            first_up["n"] += 1
            if first_up["n"] == 1:
                return 1, "compose up failed"
        return bar._up(args, **kw)
    bar.fake.responses[".env up -d"] = resume_up_fails
    out = bar.run()
    check("resume (healthy, old image): rolled back", out == "resumed_rolled_back")
    check("resume (healthy, old image): no DB restore (new backend never ran)", not has(bar.cmds(), "pg_restore"))
    check("resume (healthy, old image): compose back to old", bar.read(bar.compose) == compose_for(OLD))
    check("resume (healthy, old image): state not marked new", bar.state().current_sha == OLD)
    bar.done()

    # Healthy, but the running image cannot be read: assume the worst, restore.
    bar = Bar(compose=compose_for(NEW), previous=compose_for(OLD), running=NEW,
              overrides={"{{.Config.Image}} " + BE_ID: (1, "Error: No such object")})
    dump = make_dump(bar)
    core.save_state(bar.state_path, in_progress_state(dump))
    out = bar.run()
    check("resume (image unknown): rolled back with restore",
          out == "resumed_rolled_back" and has(bar.cmds(), "pg_restore --list"))
    check("resume (image unknown): state not marked new", bar.state().current_sha == OLD)
    bar.done()

    # Interrupted before compose up was called.
    bar, dump = resumed_bar(phase="switching", running=OLD)
    out = bar.run()
    check("resume (before up): rolled back", out == "resumed_rolled_back")
    check("resume (before up): no DB restore", not has(bar.cmds(), "pg_restore"))
    check("resume (before up): compose back to old", bar.read(bar.compose) == compose_for(OLD))
    bar.done()

    # Old state files without 'phase' are treated as 'started' (conservative).
    bar, dump = resumed_bar(phase=None, healthy=(OLD,))
    check("resume (no phase, unhealthy): restores", bar.run() == "resumed_rolled_back"
          and has(bar.cmds(), "pg_restore --list"))
    bar.done()

    # in_progress without a SHA: cleared, nothing touched.
    bar = Bar(state=core.State(current_sha=OLD, in_progress={"junk": 1}))
    out = bar.run()
    check("resume (invalid in_progress): noop, nothing touched", out == "noop" and bar.cmds() == [])
    check("resume (invalid in_progress): cleared", bar.state().in_progress is None)
    bar.done()


def test_corrupt_state():
    bar = Bar(state="{not json")
    out = bar.run()
    check("corrupt state.json: treated as empty, run continues", out == "installed")
    check("corrupt state.json: rewritten valid", bar.state().current_sha == NEW)
    bar.done()


def test_secrets():
    bar = Bar(state=core.State(current_sha=OLD), healthy=(OLD,))
    bar.run()
    joined = " ".join(bar.cmds()) + " ".join(bar.sent)
    check("secrets: token and webhook never in argv or messages", TOKEN not in joined and HOOK not in joined)
    bar.done()


# ------------------------------------------- resume guard (final review item 1)

def resume_held_checks(bar, dump, label, why):
    out = bar.run()
    c = bar.cmds()
    st = bar.state()
    host = "C:\\Users\\bar\\billiards\\backups\\" + BACKUP_NAME
    check(label + ": outcome resume_held", out == "resume_held")
    check(label + ": no stop", not has(c, ".env stop"))
    check(label + ": no restore", not has(c, "pg_restore") and not has(c, "ALTER DATABASE"))
    check(label + ": compose left as it is (new)", bar.read(bar.compose) == compose_for(NEW))
    check(label + ": in_progress cleared (never restored later by itself)", st.in_progress is None)
    check(label + ": every version held (like rollback_failed)",
          isinstance(st.failed, dict) and st.failed.get("outcome") == "resume_held"
          and st.failed.get("host_backup_path") == host and st.current_sha == OLD)
    msg = bar.sent[0] if bar.sent else ""
    check(label + ": one 'requiere atención' message", len(bar.sent) == 1 and "requiere atención" in msg)
    check(label + ": message has the host backup path", host in msg)
    check(label + ": message says what was found", why in msg)
    check(label + ": updater not restarted", not any(x.endswith(SELF_UP) for x in c))
    # next night: nothing at all, any version
    check(label + ": next night held, even for another version", night2(bar, NEW2) == "held")
    check(label + ": next night touches nothing", bar.cmds() == [] and bar.sent == [])
    # CJ has fixed things: the bar is closed and every version starts fine.
    bar.healthy = {OLD, NEW, NEW2}
    bar.fake.responses["cash_sessions WHERE status='OPEN'"] = (0, "0\n")
    bar.fake.responses["tickets WHERE status='OPEN'"] = (0, "0\n")
    check(label + ": run-now --force clears it and installs",
          night2(bar, NEW2, force=True) == "installed" and bar.state().failed is None)


def test_resume_guard():
    # open drawer (cash session) at 03:30: no stop, no restore
    bar, dump = resumed_bar(healthy=(OLD,))
    bar.fake.responses["cash_sessions WHERE status='OPEN'"] = (0, "1\n")
    resume_held_checks(bar, dump, "resume guard (open drawer)", "1 caja(s) y 0 cuenta(s) abiertas")
    bar.done()

    # outside the 03:00-12:00 window (PC came back at 15:20)
    bar, dump = resumed_bar(healthy=(OLD,))
    bar.report = {}
    out_now = NOW.replace(hour=15, minute=20)
    orig_run = bar.run
    bar.run = lambda now=out_now, **kw: orig_run(now=now, **kw)
    resume_held_checks(bar, dump, "resume guard (outside window)", "15:20")
    bar.done()

    # open read fails
    bar, dump = resumed_bar(healthy=(OLD,))
    bar.fake.responses["tickets WHERE status='OPEN'"] = (2, "connection refused")
    resume_held_checks(bar, dump, "resume guard (open read fails)", "no se pudo leer")
    bar.done()

    # running image unknown + open ticket: also guarded (restore path)
    bar = Bar(compose=compose_for(NEW), previous=compose_for(OLD), running=NEW,
              overrides={"{{.Config.Image}} " + BE_ID: (1, "Error: No such object"),
                         "tickets WHERE status='OPEN'": (0, "2\n")})
    dump = make_dump(bar)
    core.save_state(bar.state_path, in_progress_state(dump))
    check("resume guard (image unknown, tickets open): held, no restore",
          bar.run() == "resume_held" and not has(bar.cmds(), "pg_restore") and not has(bar.cmds(), ".env stop"))
    bar.done()

    # inside the window, nothing open: the restore still happens (unchanged)
    bar, dump = resumed_bar(healthy=(OLD,))
    check("resume guard (window, nothing open): rolls back with restore",
          bar.run() == "resumed_rolled_back" and has(bar.cmds(), "pg_restore --list"))
    bar.done()

    # interrupted before compose up (no restore needed): not guarded, rolls back at any hour
    bar, dump = resumed_bar(phase="switching", running=OLD)
    bar.fake.responses["tickets WHERE status='OPEN'"] = (0, "3\n")
    check("resume guard: no-restore rollback (before up) is not blocked by open tickets",
          bar.run(now=NOW.replace(hour=18)) == "resumed_rolled_back" and not has(bar.cmds(), "pg_restore"))
    bar.done()


def test_resume_up_before_health():
    # healthy resume: compose up of the app services comes before the health check
    bar, dump = resumed_bar()
    out = bar.run()
    c = bar.cmds()
    i_up = idx(c, ".env up -d --no-deps " + APP)
    check("resume: up(APP_SERVICES) issued", i_up >= 0)
    check("resume: up before the health check",
          0 <= i_up < idx(c, "exec -T backend flask migration-status") and i_up < idx(c, "{{end}} " + BE_ID))
    check("resume: healthy resume still resumed_ok", out == "resumed_ok")
    bar.done()

    # half-finished compose up: old containers still running; the resume's up completes it
    bar, dump = resumed_bar(running=OLD)
    out = bar.run()
    check("resume: half-finished up completed -> resumed_ok on the new image",
          out == "resumed_ok" and bar.running == NEW and not has(bar.cmds(), "pg_restore"))
    bar.done()

    # resume finds the live DB missing (restore cut mid-swap): renamed back first
    bar, dump = resumed_bar()
    bar.fake.responses["FROM pg_database WHERE datname IN"] = (0, "billiardbar_failed\n")
    bar.run()
    c = bar.cmds()
    check("resume: interrupted restore swap undone before anything else",
          0 <= idx(c, 'ALTER DATABASE "billiardbar_failed" RENAME TO "billiardbar"') < idx(c, ".env up -d"))
    bar.done()


# ------------------------------- Ruling V: the resume's compose up is guarded

class LogCapture:
    """Collects updater.run log lines (to check that a skipped step says why)."""

    def __init__(self):
        import logging
        self.lines = []
        cap = self

        class H(logging.Handler):
            def emit(self, record):
                cap.lines.append(record.getMessage())
        self.handler = H(level=logging.DEBUG)
        self.logger = logging.getLogger("updater.run")

    def __enter__(self):
        self.logger.addHandler(self.handler)
        return self

    def __exit__(self, *a):
        self.logger.removeHandler(self.handler)

    def text(self):
        return "\n".join(self.lines)


def new_compose_up(bar):
    """Was the NEW compose ever brought up (an up while the file named NEW)?"""
    return any(NEW.encode() in s["compose"] for s in bar.snapshots)


def test_resume_up_guard():
    APP_UP = ".env up -d --no-deps " + APP
    # 15:20, PC came back with the OLD backend still running: no up of the new
    # compose, no stop, no restore; the old-image path rolls back the compose.
    bar, dump = resumed_bar(running=OLD)
    with LogCapture() as logs:
        out = bar.run(now=NOW.replace(hour=15, minute=20))
    c = bar.cmds()
    check("resume up guard (15:20, old running): outcome resumed_rolled_back", out == "resumed_rolled_back")
    check("resume up guard (15:20): new compose never brought up", not new_compose_up(bar))
    check("resume up guard (15:20): no up before the health check",
          idx(c, APP_UP) < 0 or idx(c, APP_UP) > idx(c, "{{end}} " + BE_ID))
    check("resume up guard (15:20): no stop", not has(c, ".env stop"))
    check("resume up guard (15:20): no restore", not has(c, "pg_restore") and not has(c, "ALTER DATABASE"))
    check("resume up guard (15:20): compose back to old, old still running",
          bar.read(bar.compose) == compose_for(OLD) and bar.running == OLD)
    check("resume up guard (15:20): state not marked new", bar.state().current_sha == OLD
          and bar.state().in_progress is None)
    check("resume up guard (15:20): log says why the up was skipped",
          "skipping compose up" in logs.text() and "15:20" in logs.text())
    bar.done()

    # 04:00, nothing open: up(APP_SERVICES) still comes before the health check
    bar, dump = resumed_bar()
    out = bar.run(now=NOW.replace(hour=4))
    c = bar.cmds()
    i_up = idx(c, APP_UP)
    check("resume up guard (04:00, nothing open): up issued before the health check",
          0 <= i_up < idx(c, "{{end}} " + BE_ID) and i_up < idx(c, "exec -T backend flask migration-status"))
    check("resume up guard (04:00, nothing open): resumed_ok", out == "resumed_ok")
    bar.done()

    # 04:00, nothing open, half-finished up: the up completes the switch
    bar, dump = resumed_bar(running=OLD)
    out = bar.run(now=NOW.replace(hour=4))
    check("resume up guard (04:00, old running, nothing open): up completes -> resumed_ok",
          out == "resumed_ok" and bar.running == NEW and new_compose_up(bar))
    bar.done()

    # 04:00, drawer open, old backend running: no up of the new compose, no restore
    bar, dump = resumed_bar(running=OLD)
    bar.fake.responses["cash_sessions WHERE status='OPEN'"] = (0, "1\n")
    with LogCapture() as logs:
        out = bar.run(now=NOW.replace(hour=4))
    c = bar.cmds()
    check("resume up guard (04:00, drawer open): no up of the new compose", not new_compose_up(bar))
    check("resume up guard (04:00, drawer open): no up before the health check",
          idx(c, APP_UP) < 0 or idx(c, APP_UP) > idx(c, "{{end}} " + BE_ID))
    check("resume up guard (04:00, drawer open): old image -> resumed_rolled_back, no stop/restore",
          out == "resumed_rolled_back" and not has(c, ".env stop") and not has(c, "pg_restore"))
    check("resume up guard (04:00, drawer open): log says what is open",
          "skipping compose up" in logs.text() and "1 caja(s)" in logs.text())
    bar.done()

    # 04:00, drawer open, new backend already running healthy: no compose up at all
    bar, dump = resumed_bar()
    bar.fake.responses["cash_sessions WHERE status='OPEN'"] = (0, "1\n")
    out = bar.run(now=NOW.replace(hour=4))
    c = bar.cmds()
    check("resume up guard (04:00, drawer open, new healthy): no app up, resumed_ok",
          out == "resumed_ok" and not has(c, APP_UP) and not has(c, "pg_restore"))
    bar.done()

    # 04:00, open read fails: treated as unsafe, no up
    bar, dump = resumed_bar(running=OLD)
    bar.fake.responses["tickets WHERE status='OPEN'"] = (2, "connection refused")
    out = bar.run(now=NOW.replace(hour=4))
    check("resume up guard (04:00, open read fails): no up of the new compose, no restore",
          not new_compose_up(bar) and not has(bar.cmds(), "pg_restore") and out == "resumed_rolled_back")
    bar.done()

    # 15:20, new backend not healthy: resume_restore's own guard holds (no up, no restore)
    bar, dump = resumed_bar(running=OLD, healthy=())
    out = bar.run(now=NOW.replace(hour=15, minute=20))
    c = bar.cmds()
    check("resume up guard (15:20, unhealthy): resume_held, no up, no stop, no restore",
          out == "resume_held" and not has(c, ".env up -d") and not has(c, ".env stop")
          and not has(c, "pg_restore"))
    bar.done()


def test_resume_window_uses_current_time():
    # Re-review fix: the window is checked against the time NOW, not the time
    # the run started. The resume starts at 11:55 (inside the window, nothing
    # open: the up runs), the new backend never gets healthy, and the health
    # check (resume budget 600 s on the fake clock) ends at 12:05.
    bar, dump = resumed_bar(running=OLD, healthy=())
    out = bar.run(now=NOW.replace(hour=11, minute=55))
    c = bar.cmds()
    check("resume clock (11:55 -> 12:05 during health): outcome resume_held", out == "resume_held")
    check("resume clock: fake clock really passed 12:00", bar.t[0] >= 300)
    check("resume clock: no stop", not has(c, ".env stop"))
    check("resume clock: no restore", not has(c, "pg_restore") and not has(c, "ALTER DATABASE"))
    check("resume clock: message names the current time (and when it started)",
          bar.sent and "son las 12:05 (empezó a las 11:55), fuera del horario" in bar.sent[0])
    bar.done()

    # Same start, but the health check is short (ends 11:56): still inside the
    # window, nothing open -> the restore happens (unchanged behaviour).
    bar, dump = resumed_bar(running=OLD, healthy=(OLD,))
    out = bar.run(now=NOW.replace(hour=11, minute=55), resume_health_s=60)
    check("resume clock (ends 11:56): still restores inside the window",
          out == "resumed_rolled_back" and has(bar.cmds(), "pg_restore --list"))
    bar.done()

    # now_fn (the CLI passes the wall clock) wins: the daemon took `now` at
    # 11:30, then waited (lock, PC suspend); the wall clock says 12:30.
    bar, dump = resumed_bar(running=OLD, healthy=())
    wall = NOW.replace(hour=12, minute=30)
    bar.report = {}
    out = run_update(bar.ops, bar.env, bar.state_path, NOW.replace(hour=11, minute=30), bar.sent.append,
                     report=bar.report, now_fn=lambda: wall)
    c = bar.cmds()
    check("resume clock (now_fn 12:30): no up of the new compose", not new_compose_up(bar))
    check("resume clock (now_fn 12:30): resume_held, no stop, no restore",
          out == "resume_held" and not has(c, ".env stop") and not has(c, "pg_restore"))
    check("resume clock (now_fn 12:30): message names 12:30", bar.sent and "12:30" in bar.sent[0])
    bar.done()

    # The CLI gives run_update a wall-clock now_fn (run-now and the daemon).
    from updater import __main__ as cli
    import io
    import contextlib
    calls = []

    def fake_run_update(*a, **k):
        calls.append(k)
        return "noop"
    d = tempfile.mkdtemp(prefix="cli-now-")
    saved = (cli.run.run_update, cli.LOCK_PATH, cli.make_ops, cli.run.daemon, cli.make_notifier,
             cli.BAR_REQUIRED_FILES)
    try:
        cli.run.run_update = fake_run_update
        cli.LOCK_PATH = os.path.join(d, "lock")
        cli.make_ops = lambda: None
        cli.make_notifier = lambda env, echo=False: (lambda text: None)
        cli.BAR_REQUIRED_FILES = ()
        with contextlib.redirect_stdout(io.StringIO()):
            cli.cmd_run_now({"TZ": "America/Mexico_City"})
        once = []
        cli.run.daemon = lambda run_once, *a, **k: once.append(run_once)
        cli.cmd_daemon({"TZ": "America/Mexico_City"})
        if once:
            once[0](NOW)
    finally:
        (cli.run.run_update, cli.LOCK_PATH, cli.make_ops, cli.run.daemon, cli.make_notifier,
         cli.BAR_REQUIRED_FILES) = saved
        shutil.rmtree(d, ignore_errors=True)

    def wall_clock(k):
        fn = k.get("now_fn")
        try:
            t = fn()
            return t.tzinfo is not None and abs((t - datetime.now(timezone.utc)).total_seconds()) < 60
        except Exception:
            return False
    check("cli run-now: run_update gets a wall-clock now_fn", len(calls) >= 1 and wall_clock(calls[0]))
    check("cli daemon: run_update gets a wall-clock now_fn", len(calls) == 2 and wall_clock(calls[1]))


def test_resume_old_image_rollback_holds():
    # Phase "started", the rollback had already put the old compose back before
    # the cut: the resume ends in rollback(started=False). The version was seen
    # failing, so it is held like a normal rollback.
    bar, dump = resumed_bar(compose=compose_for(OLD), running=OLD)
    out = bar.run()
    f = bar.state().failed or {}
    check("resume hold (started, old image): outcome resumed_rolled_back", out == "resumed_rolled_back")
    check("resume hold (started, old image): no restore", not has(bar.cmds(), "pg_restore"))
    check("resume hold (started, old image): failure recorded for the new SHA",
          f.get("sha") == NEW and f.get("outcome") == "resumed_rolled_back"
          and f.get("backup_path") == dump)
    check("resume hold (started, old image): same SHA held next night", night2(bar, NEW) == "held")
    nothing_done(bar, "resume hold (started, old image)")
    bar.healthy.add(NEW2)
    check("resume hold (started, old image): another SHA proceeds", night2(bar, NEW2) == "installed")
    bar.done()

    # The 15:20 case (up skipped, old image) is held too.
    bar, dump = resumed_bar(running=OLD)
    bar.run(now=NOW.replace(hour=15, minute=20))
    check("resume hold (15:20, old image): failure recorded",
          (bar.state().failed or {}).get("sha") == NEW)
    bar.done()

    # Unchanged: interrupted before compose up (phase switching) is not held.
    bar, dump = resumed_bar(phase="switching", running=OLD)
    bar.run()
    check("resume hold: phase switching still not held", bar.state().failed is None)
    bar.done()


# -------------------------------------------- image cleanup (final review item 7)

IMG_LIST = "\n".join([
    "ghcr.io/cj-castro/billar-pos-backend|" + OLD,
    "ghcr.io/cj-castro/billar-pos-backend|" + NEW,
    "ghcr.io/cj-castro/billar-pos-backend|" + "e" * 40,
    "ghcr.io/cj-castro/billar-pos-release|bar-stable",
    "postgres|15-alpine",
]) + "\n"


def test_image_cleanup():
    bar = Bar(state=core.State(current_sha=OLD), overrides={"docker image ls": (0, IMG_LIST)})
    out = bar.run()
    c = bar.cmds()
    rmis = [x for x in c if x.startswith("docker rmi")]
    check("cleanup: installed removes only images of other versions",
          out == "installed" and rmis == ["docker rmi ghcr.io/cj-castro/billar-pos-backend:" + "e" * 40])
    check("cleanup: after the message, before the self-update (still last)",
          len(bar.sent) == 1 and idx(c, "docker rmi") < len(c) - 1 and c[-1].endswith(SELF_UP))
    bar.done()

    bar, dump = resumed_bar()
    bar.fake.responses["docker image ls"] = (0, IMG_LIST)
    out = bar.run()
    c = bar.cmds()
    check("cleanup: resumed_ok cleans up too",
          out == "resumed_ok" and [x for x in c if x.startswith("docker rmi")]
          == ["docker rmi ghcr.io/cj-castro/billar-pos-backend:" + "e" * 40] and c[-1].endswith(SELF_UP))
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), healthy=(OLD,), overrides={"docker image ls": (0, IMG_LIST)})
    bar.run()
    check("cleanup: not after a rollback", not has(bar.cmds(), "docker rmi") and not has(bar.cmds(), "image ls"))
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), overrides={"docker image ls": (1, "daemon error"),
                                                           })
    check("cleanup: failure is only logged", bar.run() == "installed" and bar.state().current_sha == NEW)
    bar.done()


def test_telegram_warning_in_message():
    """Without TELEGRAM_TOKEN a stopped telegram-bot does not block the install;
    the message says so (final review item 4)."""
    bar = Bar(state=core.State(current_sha=OLD), overrides={"{{end}} " + TG_ID: (0, "exited|")})
    bar.ops.telegram_required = False
    out = bar.run()
    msg = bar.sent[0] if bar.sent else ""
    check("telegram warning: installed anyway", out == "installed" and bar.state().current_sha == NEW)
    check("telegram warning: message carries the warning", "Aviso" in msg and "telegram-bot" in msg)
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD), overrides={"{{end}} " + TG_ID: (0, "exited|")})
    bar.ops.telegram_required = True
    out = bar.run()
    check("telegram warning: with TELEGRAM_TOKEN a stopped bot fails the health check (no install)",
          out in ("rolled_back", "rollback_failed") and bar.state().current_sha == OLD
          and has(bar.cmds(), "pg_restore --list"))
    bar.done()


# ---------------------------------- daemon start-up folder check (final review item 3)

def test_bar_folder_check():
    d = tempfile.mkdtemp()
    env_p, compose_p = os.path.join(d, ".env"), os.path.join(d, "docker-compose.bar.yml")
    sent = []
    missing = runmod.check_bar_folder((env_p, compose_p), sent.append)
    check("folder check: both missing -> listed", missing == [env_p, compose_p])
    check("folder check: exactly one message, in Spanish",
          len(sent) == 1 and "el updater no ve la carpeta del bar" in sent[0].lower())
    for p in (env_p, compose_p):
        open(p, "w").close()
    sent = []
    check("folder check: all present -> nothing sent",
          runmod.check_bar_folder((env_p, compose_p), sent.append) == [] and sent == [])

    def broken(text):
        raise RuntimeError("webhook down")
    os.remove(env_p)
    check("folder check: a failing message never raises", runmod.check_bar_folder((env_p,), broken) == [env_p])

    # cmd_daemon runs the check once at start, then the scheduler
    from updater import __main__ as cli
    saved = (cli.BAR_REQUIRED_FILES, cli.run.daemon, cli.make_notifier)
    sent, started = [], []
    try:
        cli.BAR_REQUIRED_FILES = (env_p, compose_p)
        cli.run.daemon = lambda *a, **k: started.append(True)
        cli.make_notifier = lambda env, echo=False: sent.append
        cli.cmd_daemon({"TZ": "America/Mexico_City"})
    finally:
        cli.BAR_REQUIRED_FILES, cli.run.daemon, cli.make_notifier = saved
    check("cmd_daemon: folder message sent once at start, scheduler still started",
          len(sent) == 1 and "no ve la carpeta" in sent[0] and started == [True])
    shutil.rmtree(d, ignore_errors=True)


def test_status_shows_resume_hold():
    from updater import __main__ as cli
    import io
    import contextlib
    d = tempfile.mkdtemp()
    core.save_state(os.path.join(d, "state.json"), core.State(
        current_sha=OLD, last_result="resume_held",
        failed={"sha": NEW, "outcome": "resume_held", "host_backup_path": "C:\\b\\x.dump", "at": "t"}))
    old_paths = (cli.STATE_PATH, cli.BACKUP_DIR)
    cli.STATE_PATH, cli.BACKUP_DIR = os.path.join(d, "state.json"), d
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            cli.main(["status"])
    finally:
        cli.STATE_PATH, cli.BACKUP_DIR = old_paths
    out = buf.getvalue()
    check("status: resume_held shows ALL versions held and the backup",
          "ALL versions" in out and "C:\\b\\x.dump" in out and "run-now --force" in out)
    check("cli: resume_held exit code is a failure (1)", cli.exit_code("resume_held") == 1)
    shutil.rmtree(d, ignore_errors=True)


# ----------------------------------------------- failure record and hold

def nothing_done(bar, label):
    c = bar.cmds()
    check(label + ": no backup", not has(c, "pg_dump"))
    check(label + ": no stop, no up", not has(c, ".env stop") and not has(c, ".env up -d"))
    check(label + ": no restore", not has(c, "pg_restore"))
    check(label + ": no message", bar.sent == [])


def night2(bar, new_sha, **kw):
    """Same bar, next night, bar-stable now points at new_sha."""
    bar.new_sha = new_sha
    bar.release = release_json(new_sha)
    bar.fake.calls.clear()
    bar.sent.clear()
    return bar.run(now=NOW + timedelta(days=1), **kw)


def test_failure_record_and_hold():
    host = "C:\\Users\\bar\\billiards\\backups\\" + BACKUP_NAME
    # rehearsal_failed -> same SHA held next night
    bar = Bar(state=core.State(current_sha=OLD), overrides={"flask init-db && python seed.py": (1, "boom")})
    check("hold: night 1 rehearsal_failed", bar.run() == "rehearsal_failed")
    f = bar.state().failed or {}
    check("hold: failure record after rehearsal_failed",
          f.get("sha") == NEW and f.get("outcome") == "rehearsal_failed"
          and f.get("backup_path") == os.path.join(bar.backups, BACKUP_NAME)
          and f.get("host_backup_path") == host and f.get("at") == NOW.isoformat())
    bar.fake.responses["flask init-db && python seed.py"] = (0, "2/2 applied, 0 pending\n")
    check("hold: night 2 same SHA after rehearsal_failed -> held", night2(bar, NEW) == "held")
    nothing_done(bar, "hold (rehearsal_failed, same SHA)")
    check("hold: failure record kept", (bar.state().failed or {}).get("sha") == NEW)
    check("hold: new SHA after rehearsal_failed proceeds", night2(bar, NEW2) == "installed")
    check("hold: success of another SHA clears the record", bar.state().failed is None)
    bar.done()

    # rolled_back -> same SHA held, new SHA proceeds
    bar = Bar(state=core.State(current_sha=OLD), healthy=(OLD, NEW2))
    check("hold: night 1 rolled_back", bar.run() == "rolled_back")
    check("hold: failure record after rolled_back",
          (bar.state().failed or {}).get("outcome") == "rolled_back" and bar.state().failed.get("sha") == NEW)
    check("hold: night 2 same SHA after rolled_back -> held", night2(bar, NEW) == "held")
    nothing_done(bar, "hold (rolled_back, same SHA)")
    check("hold: new SHA after rolled_back proceeds", night2(bar, NEW2) == "installed")
    check("hold: record cleared, new version current",
          bar.state().failed is None and bar.state().current_sha == NEW2)
    bar.done()

    # rollback_failed -> every SHA held until --force
    bar = Bar(state=core.State(current_sha=OLD), healthy=(),
              overrides={"pg_restore --list": (1, "bad archive")})
    check("hold: night 1 rollback_failed", bar.run() == "rollback_failed")
    f = bar.state().failed or {}
    check("hold: rollback_failed record keeps the host backup path",
          f.get("outcome") == "rollback_failed" and f.get("host_backup_path") == host)
    bar.healthy = {OLD, NEW, NEW2}
    bar.fake.responses["pg_restore --list"] = (0, "")
    check("hold: night 2 same SHA after rollback_failed -> held", night2(bar, NEW) == "held")
    nothing_done(bar, "hold (rollback_failed, same SHA)")
    check("hold: night 2 NEW SHA after rollback_failed -> held too", night2(bar, NEW2) == "held")
    nothing_done(bar, "hold (rollback_failed, new SHA)")
    check("hold: rollback_failed hold does not even contact the registry", bar.cmds() == [])
    out = night2(bar, NEW2, force=True)
    check("hold: force clears the record and runs", out == "installed" and bar.state().failed is None
          and bar.state().current_sha == NEW2)
    bar.done()

    # resume rollbacks: a version seen failing is held, an interrupted one is not
    bar, dump = resumed_bar(healthy=(OLD,))
    bar.run()
    check("hold: resumed_rolled_back after an unhealthy start records the failure",
          (bar.state().failed or {}).get("sha") == NEW)
    bar.done()
    bar, dump = resumed_bar(phase="switching", running=OLD)
    bar.run()
    check("hold: interrupted before start (power cut) is not held", bar.state().failed is None)
    bar.done()

    # backup_failed is not the version's fault: retried next night
    bar = Bar(state=core.State(current_sha=OLD), overrides={"pg_dump -Fc": (1, "disk full")})
    bar.run()
    check("hold: backup_failed leaves no failure record", bar.state().failed is None)
    bar.done()


def test_window_backup_reused_on_retry():
    bar = Bar(state=core.State(current_sha=OLD), tickets=[(0, "0\n"), (0, "1\n"), (0, "0\n")])
    check("window backup: 03:00 blocked at the second check", bar.run() == "blocked_open")
    first = os.path.join(bar.backups, BACKUP_NAME)
    wb = bar.state().window_backup or {}
    check("window backup: recorded in state", wb.get("path") == first and wb.get("new_sha") == NEW
          and wb.get("old_sha") == OLD)
    bar.fake.calls.clear()
    out = bar.run(now=NOW + timedelta(hours=1))
    check("window backup: 04:00 retry installs", out == "installed")
    check("window backup: retry dumps again (fresh data) into the same file",
          has(bar.cmds(), "pg_dump") and os.listdir(bar.backups) == [BACKUP_NAME])
    snap = bar.snapshots[0]["state"]["in_progress"] if bar.snapshots else {}
    check("window backup: the switch uses that file", snap.get("backup_path") == first)
    bar.done()

    bar = Bar(state=core.State(current_sha=OLD, window_backup={
        "old_sha": OLD, "new_sha": NEW, "path": "/elsewhere/old.dump", "date": "2026-11-27"}))
    bar.run()
    check("window backup: a record from another day is ignored",
          os.path.isfile(os.path.join(bar.backups, BACKUP_NAME)))
    bar.done()


def test_resume_malformed_record():
    for label, ip in (("new_sha not a string", {"new_sha": 123}),
                      ("new_sha not a SHA", {"new_sha": "abc"}),
                      ("old_sha not a string", {"new_sha": NEW, "old_sha": 5, "backup_path": "/x"}),
                      ("backup_path not a string", {"new_sha": NEW, "old_sha": OLD, "backup_path": ["x"]}),
                      ("unknown phase", {"new_sha": NEW, "old_sha": OLD, "backup_path": "/x", "phase": "zzz"}),
                      ("not a dict", ["x"])):
        bar = Bar(state=core.State(current_sha=OLD, in_progress=ip))
        try:
            out = bar.run()
        except Exception as e:
            out = "raised %s" % type(e).__name__
        check("resume malformed (%s): cleared with a log line, nothing touched" % label,
              out == "noop" and bar.cmds() == [] and bar.state().in_progress is None)
        bar.done()


def test_cli_force_and_status():
    from updater import __main__ as cli
    import io
    import contextlib
    bar = Bar(state=core.State(current_sha=OLD, failed={
        "sha": NEW, "outcome": "rollback_failed", "backup_path": "/bar/backups/" + BACKUP_NAME,
        "host_backup_path": "C:\\Users\\bar\\billiards\\backups\\" + BACKUP_NAME, "at": "t"}))
    saved = (cli.STATE_PATH, cli.BACKUP_DIR, cli.LOCK_PATH, cli.make_ops)
    cli.STATE_PATH, cli.BACKUP_DIR = bar.state_path, bar.backups
    cli.LOCK_PATH = os.path.join(bar.dir, "lock")
    cli.make_ops = lambda: bar.ops
    try:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = cli.main(["status"])
        out = buf.getvalue()
        check("cli status: shows the failure record and the host backup path",
              code == 0 and "rollback_failed" in out and "C:\\Users\\bar\\billiards\\backups\\" + BACKUP_NAME in out)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = cli.main(["run-now"])
        check("cli run-now while held: outcome held, exit 3", code == 3 and "outcome: held" in buf.getvalue())
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            code = cli.main(["run-now", "--bogus"])
        check("cli run-now with an unknown flag: usage, exit 2", code == 2)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = cli.main(["run-now", "--force"])
        check("cli run-now --force: clears the hold and installs",
              code == 0 and "outcome: installed" in buf.getvalue() and bar.state().failed is None
              and bar.state().current_sha == NEW)
    finally:
        cli.STATE_PATH, cli.BACKUP_DIR, cli.LOCK_PATH, cli.make_ops = saved
        bar.done()


# --------------------------------------------------------------- scheduler

class Clock:
    def __init__(self, start):
        self.t = start
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += timedelta(seconds=s)


def at(h, m=0, day=28):
    return datetime(2026, 11, day, h, m, tzinfo=TZ)


def fake_once(clock, outcomes, calls):
    """run_once that returns outcomes in order (last repeats) and takes 2 minutes."""
    def run_once(now):
        calls.append(now)
        o = outcomes[min(len(calls) - 1, len(outcomes) - 1)]
        clock.t += timedelta(minutes=2)
        if isinstance(o, Exception):
            raise o
        return o, ("msg " + o if o in ("blocked_open", "registry_down", "db_unreachable") else None)
    return run_once


def test_registry_down_all_window():
    clock = Clock(at(1, 30))
    calls, sent = [], []
    runmod.daemon(fake_once(clock, ["registry_down"], calls), clock.now, clock.sleep,
                  lambda text: sent.append((clock.now(), text)), cycles=1)
    check("window: first attempt at 03:00", calls and calls[0] == at(3))
    check("window: hourly attempts 03:00..11:00", calls == [at(h) for h in range(3, 12)])
    check("window: exactly one message", len(sent) == 1)
    check("window: message sent at 12:00", sent and sent[0][0] == at(12))
    check("window: message is the registry one, nothing appended", sent and sent[0][1] == "msg registry_down")
    check("window: sleeps are chunked (survive a PC suspend)", clock.sleeps and max(clock.sleeps) <= 300)


def test_db_unreachable_window_and_held_not_retried():
    clock = Clock(at(2, 0))
    calls, sent = [], []
    runmod.daemon(fake_once(clock, ["db_unreachable"], calls), clock.now, clock.sleep,
                  lambda text: sent.append((clock.now(), text)), cycles=1)
    check("window: db_unreachable retried hourly, one message at 12:00",
          calls == [at(h) for h in range(3, 12)] and len(sent) == 1 and sent[0] == (at(12), "msg db_unreachable"))
    clock = Clock(at(2, 0))
    calls, sent = [], []
    runmod.daemon(fake_once(clock, ["held"], calls), clock.now, clock.sleep, lambda t: sent.append(t), cycles=1)
    check("window: held is not retried and sends nothing", calls == [at(3)] and sent == [])


def test_blocked_then_installed():
    clock = Clock(at(2, 0))
    calls, sent = [], []
    runmod.daemon(fake_once(clock, ["blocked_open", "blocked_open", "installed"], calls), clock.now,
                  clock.sleep, lambda text: sent.append(text), cycles=1)
    check("window: blocked twice then installed at 05:00", calls == [at(3), at(4), at(5)])
    check("window: no block message once it installed", sent == [])


def test_blocked_last_kind_wins():
    clock = Clock(at(2, 0))
    calls, sent = [], []
    runmod.daemon(fake_once(clock, ["registry_down"] * 3 + ["blocked_open"], calls), clock.now,
                  clock.sleep, lambda text: sent.append(text), cycles=1)
    check("window: last blocking kind is the one posted", len(sent) == 1 and sent[0].startswith("msg blocked_open"))


def test_daemon_survives_exceptions():
    clock = Clock(at(2, 0))
    calls, sent = [], []
    runmod.daemon(fake_once(clock, [RuntimeError("boom " + TOKEN), "noop"], calls), clock.now,
                  clock.sleep, lambda text: sent.append(text), cycles=2)
    check("daemon: an exception does not stop the loop", calls == [at(3), at(3, day=29)])
    check("daemon: crash reported once, no retry that night", len(sent) == 1 and "inesperado" in sent[0])
    check("daemon: noop sends nothing", len(sent) == 1)


def test_daemon_startup():
    clock = Clock(at(7, 15))
    calls = []
    runmod.daemon(fake_once(clock, ["noop"], calls), clock.now, clock.sleep, lambda t: None, cycles=0)
    check("daemon: started inside the window -> runs at once", calls == [at(7, 15)])

    clock = Clock(at(15, 0))
    calls = []
    runmod.daemon(fake_once(clock, ["resumed_ok"], calls), clock.now, clock.sleep, lambda t: None,
                  resume_pending=lambda: True, cycles=0)
    check("daemon: in_progress at start -> resumes at once, any hour", calls == [at(15)])

    clock = Clock(at(15, 0))
    calls = []
    runmod.daemon(fake_once(clock, ["noop"], calls), clock.now, clock.sleep, lambda t: None, cycles=1)
    check("daemon: started after the window -> waits for 03:00 next day", calls == [at(3, day=29)])

    clock = Clock(at(10, 30))
    calls, sent = [], []
    runmod.daemon(fake_once(clock, ["blocked_open"], calls), clock.now, clock.sleep,
                  lambda t: sent.append((clock.now(), t)), cycles=0)
    check("daemon: started 10:30 blocked -> retries 11:00, message 12:00",
          calls == [at(10, 30), at(11)] and len(sent) == 1 and sent[0][0] == at(12))


def test_schedule_helpers():
    check("next_run_at before 03:00 -> today", runmod.next_run_at(at(2, 59)) == at(3))
    check("next_run_at at 03:00 -> tomorrow", runmod.next_run_at(at(3)) == at(3, day=29))
    tz = runmod.local_tz({"TZ": "America/Mexico_City"})
    check("local_tz: Mexico City is UTC-6 in November",
          datetime(2026, 11, 28, 3, tzinfo=tz).utcoffset() == timedelta(hours=-6))
    tz = runmod.local_tz({"TZ": "Not/AZone"})
    check("local_tz: bad TZ falls back to UTC-6",
          datetime(2026, 11, 28, 3, tzinfo=tz).utcoffset() == timedelta(hours=-6))
    check("local_tz: default", runmod.local_tz({}).utcoffset(datetime(2026, 11, 28)) == timedelta(hours=-6))


def test_lock():
    d = tempfile.mkdtemp()
    p = os.path.join(d, "run.lock")
    with runmod.run_lock(p, wait=False):
        try:
            with runmod.run_lock(p, wait=False):
                second = True
        except runmod.Busy:
            second = False
    check("lock: a second run while one is going is refused", second is False)
    with runmod.run_lock(p, wait=False):
        pass
    check("lock: released after the run", True)
    shutil.rmtree(d, ignore_errors=True)


def test_check_update():
    bar = Bar(state=core.State(current_sha=OLD), tickets=2)
    info = runmod.check_update(bar.ops, bar.env, bar.state_path)
    check("check: reports decision and open counts",
          info.get("decision") == "install" and info.get("open_tickets") == 2 and info.get("new_sha") == NEW)
    no_switch(bar, "check")
    check("check: no backup, no pull of images", not has(bar.cmds(), "pg_dump") and not has(bar.cmds(), "pull --quiet"))
    check("check: no state written", bar.state().last_result is None)
    release_dirs_gone(bar, "check")
    bar.done()


def test_cli():
    from updater import __main__ as cli
    d = tempfile.mkdtemp()
    core.save_state(os.path.join(d, "state.json"), core.State(current_sha=NEW, previous_sha=OLD,
                                                               last_result="installed"))
    old_paths = (cli.STATE_PATH, cli.BACKUP_DIR)
    cli.STATE_PATH, cli.BACKUP_DIR = os.path.join(d, "state.json"), d
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = cli.main(["status"])
    out = buf.getvalue()
    check("cli status: exit 0 and shows the version", code == 0 and NEW7 in out and "installed" in out)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        code = cli.main(["bogus"])
    check("cli: unknown command -> usage, exit 2", code == 2 and "usage" in buf.getvalue().lower())
    check("cli: exit codes", cli.exit_code("installed") == 0 and cli.exit_code("noop") == 0
          and cli.exit_code("blocked_open") == 3 and cli.exit_code("rolled_back") == 1
          and cli.exit_code("rollback_failed") == 1 and cli.exit_code("held") == 3
          and cli.exit_code("db_unreachable") == 3)
    cli.STATE_PATH, cli.BACKUP_DIR = old_paths
    shutil.rmtree(d, ignore_errors=True)


def main():
    import logging
    logging.basicConfig(level=logging.WARNING)
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        try:
            t()
        except Exception as e:
            import traceback
            traceback.print_exc()
            check("%s raised %s: %s" % (t.__name__, type(e).__name__, e), False)
    if FAILED:
        print("\n%d FAILED" % len(FAILED))
        sys.exit(1)
    print("\nALL PASS")


if __name__ == "__main__":
    main()
