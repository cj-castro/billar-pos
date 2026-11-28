"""Plain-script tests for updater.ops (Runner, Ops) and updater.testing.FakeRunner.

Run: python -m tests.test_ops
No Docker needed: Ops is driven through FakeRunner; Runner runs the Python
interpreter itself as the child process.
"""
import os
import sys
import tempfile

from updater.ops import Ops, OpsError, Runner
from updater.testing import FakeRunner

FAILED = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + ": " + name)
    if not cond:
        FAILED.append(name)


def raises(fn, exc):
    try:
        fn()
    except exc:
        return True
    except Exception:
        return False
    return False


COMPOSE = ["docker", "compose", "-p", "billiards", "-f", "/bar/docker-compose.bar.yml",
           "--env-file", "/bar/.env"]
PG_ID = "a1b2c3d4e5f6"
BE_ID, SCH_ID, TG_ID = "be00000000b1", "5c00000000c2", "7e00000000d3"
PG = {"ps -q postgres": (0, PG_ID + "\n")}


def make_ops(responses=None, **kw):
    r = dict(PG)
    r.update(responses or {})
    fake = FakeRunner(r)
    kw.setdefault("project", "billiards")
    kw.setdefault("pg_user", "billiard")
    kw.setdefault("pg_db", "billiardbar")
    kw.setdefault("pg_password", "pw-not-in-argv")
    kw.setdefault("registry", "ghcr.io/cj-castro")
    kw.setdefault("sleep", lambda s: None)
    return fake, Ops(fake, **kw)


def joined(fake):
    return [" ".join(c["args"]) for c in fake.calls]


def first_index(cmds, needle):
    for i, c in enumerate(cmds):
        if needle in c:
            return i
    return -1


def write_bytes(n):
    """FakeRunner response that writes n bytes to stdout_path."""
    def fn(args, **kw):
        if kw.get("stdout_path"):
            with open(kw["stdout_path"], "wb") as f:
                f.write(b"x" * n)
        return 0, ""
    return fn


# ---------------------------------------------------------------- FakeRunner

def test_fake_runner():
    f = FakeRunner({"docker pull x": (1, "nope")})
    check("fake: exact first-3 key", f.run(["docker", "pull", "x", "--quiet"]) == (1, "nope"))
    check("fake: default (0, '')", f.run(["docker", "info"]) == (0, ""))
    check("fake: records calls", [c["args"] for c in f.calls] == [["docker", "pull", "x", "--quiet"], ["docker", "info"]])
    f = FakeRunner({"docker compose -p": (0, "short"), "ps -q backend": (0, "cid")})
    check("fake: specific key beats generic first-3 key", f.run(COMPOSE + ["ps", "-q", "backend"]) == (0, "cid"))
    f = FakeRunner({"tickets": [(1, "a"), (0, "b")]})
    check("fake: sequence 1", f.run(["psql", "tickets"]) == (1, "a"))
    check("fake: sequence 2", f.run(["psql", "tickets"]) == (0, "b"))
    check("fake: sequence last repeats", f.run(["psql", "tickets"]) == (0, "b"))
    f = FakeRunner({"echo": lambda args, **kw: (3, kw.get("input_text"))})
    check("fake: callable gets kwargs", f.run(["echo"], input_text="hi") == (3, "hi"))


# -------------------------------------------------------------------- Runner

def test_runner_redaction():
    saved = {k: os.environ.get(k) for k in ("GHCR_TOKEN", "SLACK_WEBHOOK_URL", "TELEGRAM_TOKEN", "POSTGRES_PASSWORD")}
    try:
        os.environ["GHCR_TOKEN"] = "ghp_SECRETTOKEN123"
        os.environ["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/services/T0/B0/SECRETHOOK"
        os.environ["TELEGRAM_TOKEN"] = ""  # empty must not redact everything
        os.environ["POSTGRES_PASSWORD"] = "pgPASSsecret9"
        code, out = Runner().run([sys.executable, "-c",
                                  "import sys; print('tok=ghp_SECRETTOKEN123'); "
                                  "print('hook=https://hooks.slack.com/services/T0/B0/SECRETHOOK', file=sys.stderr)"])
        check("runner: exit 0", code == 0)
        check("runner: token hidden", "ghp_SECRETTOKEN123" not in out and "tok=***" in out)
        check("runner: webhook hidden (stderr too)", "SECRETHOOK" not in out and "hook=***" in out)
        check("runner: empty secret does not mangle output", "*" * 6 not in out.replace("***", ""))
        code, out = Runner().run([sys.executable, "-c", "print('url=postgresql://u:pgPASSsecret9@h/db')"])
        check("runner: POSTGRES_PASSWORD hidden", "pgPASSsecret9" not in out and "u:***@h" in out)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_runner_io():
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in.bin")
        dst = os.path.join(d, "out.bin")
        with open(src, "wb") as f:
            f.write(b"\x00\x01payload")
        code, out = Runner().run([sys.executable, "-c",
                                  "import sys; d=sys.stdin.buffer.read(); sys.stdout.buffer.write(d[::-1]); "
                                  "print('note', file=sys.stderr)"],
                                 stdout_path=dst, input_path=src)
        with open(dst, "rb") as f:
            data = f.read()
        check("runner: stdin from file, stdout to file", code == 0 and data == b"daolyap\x01\x00")
        check("runner: stderr returned when stdout goes to file", "note" in out)
    code, out = Runner().run([sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"],
                             input_text="secret-on-stdin")
    check("runner: input_text on stdin", code == 0 and "SECRET-ON-STDIN" in out)
    code, out = Runner().run([sys.executable, "-c", "import os; print(os.environ.get('XTRA_VAR'))"],
                             env={"XTRA_VAR": "hello"})
    check("runner: extra env reaches child", "hello" in out)
    prog = "import sys; print('VALUE'); print('NOTICE: noise', file=sys.stderr); sys.exit(int(sys.argv[1]))"
    code, out = Runner().run([sys.executable, "-c", prog, "0"], stderr="separate")
    check("runner: stderr='separate' exit 0 -> stdout only", code == 0 and out.strip() == "VALUE")
    code, out = Runner().run([sys.executable, "-c", prog, "3"], stderr="separate")
    check("runner: stderr='separate' failure -> stderr included for the report",
          code == 3 and "VALUE" in out and "NOTICE: noise" in out)
    code, out = Runner().run([sys.executable, "-c", prog, "0"])
    check("runner: default still combines stderr", "VALUE" in out and "NOTICE: noise" in out)
    code, out = Runner().run([sys.executable, "-c", "import sys; sys.exit(4)"])
    check("runner: exit code returned", code == 4)
    code, out = Runner().run([sys.executable, "-c", "import time; time.sleep(5)"], timeout=1)
    check("runner: timeout -> non-zero, no exception", code != 0 and "timed out" in out)
    code, out = Runner().run(["definitely-not-a-binary-xyz"])
    check("runner: missing binary -> 127", code == 127)


# ----------------------------------------------------------------------- Ops

def test_project_and_defaults():
    saved = os.environ.get("COMPOSE_PROJECT_NAME")
    saved_reg = os.environ.get("UPDATER_REGISTRY")
    try:
        os.environ["COMPOSE_PROJECT_NAME"] = "billiards-e2e"
        os.environ["UPDATER_REGISTRY"] = "localhost:5001"
        o = Ops(FakeRunner())
        check("ops: project from COMPOSE_PROJECT_NAME", o.project == "billiards-e2e")
        check("ops: network from project", o.network == "billiards-e2e_billiardbar_net")
        check("ops: registry from UPDATER_REGISTRY", o.registry == "localhost:5001")
        os.environ.pop("COMPOSE_PROJECT_NAME")
        os.environ.pop("UPDATER_REGISTRY")
        o = Ops(FakeRunner())
        check("ops: default project billiards", o.project == "billiards" and o.network == "billiards_billiardbar_net")
        check("ops: default registry", o.registry == "ghcr.io/cj-castro")
        check("ops: default paths", o.compose_file == "/bar/docker-compose.bar.yml" and o.env_file == "/bar/.env")
    finally:
        for k, v in (("COMPOSE_PROJECT_NAME", saved), ("UPDATER_REGISTRY", saved_reg)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    check("ops: rejects unsafe db name", raises(lambda: Ops(FakeRunner(), pg_db='x"; DROP'), ValueError))


def test_login():
    fake, o = make_ops()
    ok = o.login("cj-castro", "ghp_TOKEN_abc")
    c = fake.calls[-1]
    check("login: ok", ok is True)
    check("login: argv", c["args"] == ["docker", "login", "ghcr.io", "-u", "cj-castro", "--password-stdin"])
    check("login: token on stdin", c["input_text"] == "ghp_TOKEN_abc")
    check("login: token never in argv", all("ghp_TOKEN_abc" not in a for a in c["args"]))
    fake, o = make_ops({"docker login ghcr.io": (1, "denied")})
    check("login: failure -> False", o.login("u", "t") is False)
    fake, o = make_ops(registry="localhost:5001")
    o.login("u", "t")
    check("login: host from registry", fake.calls[-1]["args"][2] == "localhost:5001")
    fake, o = make_ops()
    check("login: empty token -> False, no call", o.login("u", "") is False and fake.calls == [])


def test_pull_release():
    def cp(args, **kw):
        dest = args[-1]
        with open(dest, "w") as f:
            f.write("{}")
        return 0, ""
    fake, o = make_ops({"docker create": (0, "relcid\n"), "docker cp": cp}, registry="localhost:5001")
    d = o.pull_release("bar-stable")
    cmds = joined(fake)
    check("pull_release: pulls release image from registry", cmds[0] == "docker pull localhost:5001/billar-pos-release:bar-stable")
    check("pull_release: docker create", first_index(cmds, "docker create localhost:5001/billar-pos-release:bar-stable") > 0)
    check("pull_release: copies release.json", first_index(cmds, "docker cp relcid:/release.json") > 0)
    check("pull_release: copies compose", first_index(cmds, "docker cp relcid:/docker-compose.bar.yml") > 0)
    check("pull_release: removes container last", cmds[-1] == "docker rm -f relcid")
    check("pull_release: files in returned dir",
          os.path.isfile(os.path.join(d, "release.json")) and os.path.isfile(os.path.join(d, "docker-compose.bar.yml")))

    fake, o = make_ops({"docker pull": (1, "unauthorized")})
    check("pull_release: pull failure raises", raises(lambda: o.pull_release("bar-stable"), OpsError))
    check("pull_release: no create after failed pull", first_index(joined(fake), "docker create") == -1)

    fake, o = make_ops({"docker create": (0, "relcid\n"), "docker cp": (1, "no such file")})
    check("pull_release: cp failure raises", raises(lambda: o.pull_release("x"), OpsError))
    check("pull_release: container removed after cp failure", joined(fake)[-1] == "docker rm -f relcid")


def test_open_counts():
    fake, o = make_ops({"cash_sessions": (0, "1\n"), "tickets": (0, "0\n")})
    check("open_counts parses", o.open_counts() == (1, 0))
    cmds = joined(fake)
    i = first_index(cmds, "cash_sessions")
    check("open_counts: docker exec <postgres> psql -tA -c",
          cmds[i].startswith("docker exec " + PG_ID + " psql") and " -tA " in cmds[i] + " " and "status='OPEN'" in cmds[i])
    check("open_counts: resolves postgres via compose ps -q",
          first_index(cmds, " ".join(COMPOSE + ["ps", "-q", "postgres"])) == 0)
    fake, o = make_ops({"cash_sessions": (0, "0\n"), "tickets": (0, "3\n")})
    check("open_counts parses tickets", o.open_counts() == (0, 3))
    fake, o = make_ops({"cash_sessions": (2, "connection refused")})
    check("open_counts: psql failure raises (never reads as 0 open)", raises(o.open_counts, OpsError))
    fake, o = make_ops({"cash_sessions": (0, "garbage")})
    check("open_counts: unparsable raises", raises(o.open_counts, OpsError))
    fake, o = make_ops({"ps -q postgres": (0, "")})
    check("open_counts: no postgres container raises", raises(o.open_counts, OpsError))


def test_live_migration_versions():
    fake, o = make_ops({"schema_migrations": (0, "001\n040\n058\n\n")})
    check("live_migration_versions parses", o.live_migration_versions() == {"001", "040", "058"})
    fake, o = make_ops({"schema_migrations": (1, "relation does not exist")})
    check("live_migration_versions: failure raises", raises(o.live_migration_versions, OpsError))


def test_backup():
    with tempfile.TemporaryDirectory() as d:
        dest = os.path.join(d, "pre-update-a-to-b.dump")
        fake, o = make_ops({"pg_dump": (1, "pg_dump: error")})
        check("backup: exit 1 -> False", o.backup(dest) is False)
        check("backup: no file left after failure", not os.path.exists(dest) and os.listdir(d) == [])
        c = [c for c in fake.calls if "pg_dump" in c["args"]][0]
        check("backup: docker exec <postgres> pg_dump -Fc",
              c["args"][:4] == ["docker", "exec", PG_ID, "pg_dump"] and "-Fc" in c["args"]
              and "billiardbar" in c["args"] and c["stdout_path"])

        fake, o = make_ops({"pg_dump": write_bytes(10)})
        check("backup: 10-byte file -> False", o.backup(dest) is False)
        check("backup: tiny file removed", os.listdir(d) == [])

        fake, o = make_ops({"pg_dump": write_bytes(4096)})
        check("backup: good dump -> True", o.backup(dest) is True)
        check("backup: final file present, no partial", os.listdir(d) == ["pre-update-a-to-b.dump"]
              and os.path.getsize(dest) == 4096)


def _dump(d, n=4096):
    p = os.path.join(d, "x.dump")
    with open(p, "wb") as f:
        f.write(b"P" * n)
    return p


STATUS_OK = "  001_baseline_squash   applied\n\n58/58 applied, 0 pending\n"


def test_rehearse():
    img = "ghcr.io/cj-castro/billar-pos-backend:" + "a" * 40
    with tempfile.TemporaryDirectory() as d:
        dump = _dump(d)

        fake, o = make_ops({"pg_restore": (2, "pg_restore: fatal")})
        ok, detail = o.rehearse(img, dump)
        cmds = joined(fake)
        check("rehearse: restore failure -> False", ok is False and detail)
        check("rehearse: DROP issued even when restore fails",
              "DROP DATABASE IF EXISTS billar_scratch_update" in cmds[-1])
        check("rehearse: no docker run after failed restore", first_index(cmds, "docker run") == -1)

        fake, o = make_ops({"schema_migrations": (0, "58\n"), "docker run": (0, STATUS_OK)})
        ok, detail = o.rehearse(img, dump)
        cmds = joined(fake)
        check("rehearse: happy path -> True", ok is True)
        i_create = first_index(cmds, "createdb")
        i_restore = first_index(cmds, "pg_restore")
        i_run = first_index(cmds, "docker run")
        i_drop_last = len(cmds) - 1
        check("rehearse: order create -> restore -> run -> drop",
              0 < i_create < i_restore < i_run < i_drop_last and "DROP DATABASE" in cmds[-1])
        rc = [c for c in fake.calls if "pg_restore" in c["args"]][0]
        check("rehearse: pg_restore --no-owner --no-privileges into scratch, dump on stdin",
              "--no-owner" in rc["args"] and "--no-privileges" in rc["args"]
              and "billar_scratch_update" in rc["args"] and rc["input_path"] == dump
              and rc["args"][:3] == ["docker", "exec", "-i"])
        run = [c for c in fake.calls if c["args"][:2] == ["docker", "run"]][0]
        a = run["args"]
        check("rehearse: docker run --rm --network billiards_billiardbar_net",
              "--rm" in a and a[a.index("--network") + 1] == "billiards_billiardbar_net")
        check("rehearse: entrypoint sh, image, startup sequence",
              a[a.index("--entrypoint") + 1] == "sh" and img in a
              and a[-2] == "-c" and a[-1] == "flask init-db && python seed.py && flask factory-finalize"
              " && flask apply-migrations --strict && flask migration-status")
        check("rehearse: DATABASE_URL passed by name, password not in argv",
              "DATABASE_URL" in a and all("pw-not-in-argv" not in x for x in a))
        check("rehearse: --name <project>-rehearsal", a[a.index("--name") + 1] == "billiards-rehearsal")
        check("rehearse: --env-file /bar/.env before the -e overrides",
              a[a.index("--env-file") + 1] == "/bar/.env" and a.index("--env-file") < a.index("DATABASE_URL"))
        i_rm = [i for i, c in enumerate(cmds) if c == "docker rm -f billiards-rehearsal"]
        check("rehearse: leftover container removed before run and again in finally",
              len(i_rm) == 2 and i_rm[0] < i_run < i_rm[1] < len(cmds) - 1)
        check("rehearse: DATABASE_URL value points at scratch db",
              run["env"]["DATABASE_URL"] == "postgresql://billiard:pw-not-in-argv@postgres:5432/billar_scratch_update")

        fake, o = make_ops({"schema_migrations": (0, "58\n"), "docker run": (1, "MIGRATIONS FAILED: 059")})
        ok, detail = o.rehearse(img, dump)
        check("rehearse: migration failure -> False with detail", ok is False and "059" in detail)
        check("rehearse: DROP after failed run", "DROP DATABASE IF EXISTS billar_scratch_update" in joined(fake)[-1])

        fake, o = make_ops({"schema_migrations": (0, "58\n"),
                            "docker run": (0, "57/58 applied, 1 pending\n")})
        check("rehearse: pending after run -> False", o.rehearse(img, dump)[0] is False)

        fake, o = make_ops({"schema_migrations": (0, "58\n"),
                            "docker run": (0, STATUS_OK + "\n  !! Database reports migrations this build does not ship: 070\n")})
        check("rehearse: unknown versions -> False", o.rehearse(img, dump)[0] is False)

        fake, o = make_ops({"pg_restore": (1, "warning: errors ignored on restore: 1"),
                            "schema_migrations": (0, "58\n"), "docker run": (0, STATUS_OK)})
        check("rehearse: pg_restore exit 1 with data present -> continues", o.rehearse(img, dump)[0] is True)

        fake, o = make_ops({"createdb": (1, "boom")})
        o.rehearse(img, dump)
        check("rehearse: DROP after failed createdb", "DROP DATABASE IF EXISTS billar_scratch_update" in joined(fake)[-1])

        fake, o = make_ops({"schema_migrations": (0, "58\n"), "docker run": (124, "timed out after 1800s: docker")})
        o.rehearse(img, dump)
        cmds = joined(fake)
        check("rehearse: timed-out container removed, then DROP",
              cmds[-2] == "docker rm -f billiards-rehearsal" and "DROP DATABASE" in cmds[-1])

        fake, o = make_ops()
        ok, _ = o.rehearse(img, os.path.join(d, "missing.dump"))
        check("rehearse: missing dump -> False, nothing created", ok is False and first_index(joined(fake), "createdb") == -1)


RESTORING = "billiardbar_restoring"
R1 = 'ALTER DATABASE "billiardbar" RENAME TO "billiardbar_failed"'
R2 = 'ALTER DATABASE "billiardbar_restoring" RENAME TO "billiardbar"'
RBACK = 'ALTER DATABASE "billiardbar_failed" RENAME TO "billiardbar"'
LIVE_DROP = 'DROP DATABASE IF EXISTS "billiardbar" '


def _untouched(cmds):
    """Live DB never renamed or dropped."""
    return first_index(cmds, R1) == -1 and first_index(cmds, LIVE_DROP) == -1


def test_restore():
    with tempfile.TemporaryDirectory() as d:
        dump = _dump(d)

        # success order (Ruling M)
        fake, o = make_ops({"schema_migrations": (0, "58\n")})
        ok, detail = o.restore(dump)
        cmds = joined(fake)
        i_list = first_index(cmds, "pg_restore --list")
        i_create = first_index(cmds, "createdb -U billiard " + RESTORING)
        i_restore = first_index(cmds, "pg_restore -U billiard -d " + RESTORING)
        i_verify = first_index(cmds, "-d %s -tA -c SELECT count(*) FROM schema_migrations" % RESTORING)
        i_drop_failed = first_index(cmds, 'DROP DATABASE IF EXISTS "billiardbar_failed" WITH (FORCE)')
        i_term = first_index(cmds, "pg_terminate_backend(pid)")
        i_r1 = first_index(cmds, R1)
        i_r2 = first_index(cmds, R2)
        check("restore: ok -> (True, detail)", ok is True and dump in detail)
        check("restore: order list -> create _restoring -> restore -> verify -> terminate -> live->_failed -> _restoring->live",
              0 < i_list < i_create < i_restore < i_verify < i_term < i_r1 < i_r2)
        check("restore: old _failed dropped before the swap", i_verify < i_drop_failed < i_term)
        check("restore: live db never dropped", first_index(cmds, LIVE_DROP) == -1)
        check("restore: terminate targets live db only",
              "WHERE datname = 'billiardbar' AND pid <> pg_backend_pid()" in cmds[i_term])
        check("restore: admin statements run from the postgres maintenance db",
              all(" -d postgres " in cmds[i] for i in (i_drop_failed, i_term, i_r1, i_r2)))
        rc = fake.calls[i_restore]
        check("restore: pg_restore keeps privileges, dump on stdin",
              "--no-privileges" not in rc["args"] and "--no-owner" not in rc["args"]
              and rc["input_path"] == dump and rc["args"][-2:] == ["-d", RESTORING])
        check("restore: swap is the last step", i_r2 == len(cmds) - 1)

        # exit 1 with warnings: accepted, count reported
        fake, o = make_ops({"pg_restore -U": (1, "pg_restore: error: role \"kiuo_live_ro\" does not exist\n"
                                                 "pg_restore: warning: errors ignored on restore: 2\n"),
                            "schema_migrations": (0, "58\n")})
        ok, detail = o.restore(dump)
        check("restore: exit 1 + data -> True, ignored count in detail",
              ok is True and "errors ignored on restore: 2" in detail)

        # failure during restore into _restoring
        fake, o = make_ops({"pg_restore -U": (2, "fatal")})
        ok, detail = o.restore(dump)
        cmds = joined(fake)
        check("restore: restore into _restoring fails -> (False, detail with backup path)",
              ok is False and dump in detail)
        check("restore: restore failure never renames or drops live", _untouched(cmds)
              and first_index(cmds, "pg_terminate_backend") == -1)
        check("restore: restore failure drops _restoring",
              'DROP DATABASE IF EXISTS "%s" WITH (FORCE)' % RESTORING in cmds[-1])

        fake, o = make_ops({"pg_restore -U": (1, "fatal"), "schema_migrations": (0, "0\n")})
        ok, detail = o.restore(dump)
        cmds = joined(fake)
        check("restore: exit 1 + empty schema_migrations -> False, live untouched, _restoring dropped",
              ok is False and _untouched(cmds) and RESTORING in cmds[-1] and "DROP DATABASE" in cmds[-1])

        fake, o = make_ops({"schema_migrations": (2, "connection lost")})
        ok, _ = o.restore(dump)
        cmds = joined(fake)
        check("restore: verify query fails -> False, live untouched, _restoring dropped",
              ok is False and _untouched(cmds) and RESTORING in cmds[-1])

        fake, o = make_ops({"createdb": (1, "boom")})
        ok, _ = o.restore(dump)
        check("restore: createdb _restoring fails -> False, live untouched",
              ok is False and _untouched(joined(fake)) and first_index(joined(fake), "pg_restore -U") == -1)

        # second rename fails -> live renamed back
        fake, o = make_ops({"schema_migrations": (0, "58\n"), R2: (1, "rename failed")})
        ok, detail = o.restore(dump)
        cmds = joined(fake)
        check("restore: second rename fails -> False", ok is False and "renamed back" in detail)
        check("restore: second rename fails -> _failed renamed back to live",
              first_index(cmds, R1) < first_index(cmds, R2) < first_index(cmds, RBACK)
              and cmds[-1].endswith(RBACK))

        fake, o = make_ops({"schema_migrations": (0, "58\n"), R2: (1, "x"), RBACK: (1, "y")})
        ok, detail = o.restore(dump)
        check("restore: both renames fail -> False, detail says where the data is",
              ok is False and "billiardbar_failed" in detail and RESTORING in detail and dump in detail)

        # first rename keeps failing (client reconnects) -> live untouched
        fake, o = make_ops({"schema_migrations": (0, "58\n"), R1: (1, "database is being accessed")})
        ok, _ = o.restore(dump)
        cmds = joined(fake)
        check("restore: first rename fails -> retried 3 times then False",
              ok is False and sum(1 for c in cmds if R1 in c) == 3
              and sum(1 for c in cmds if "pg_terminate_backend" in c) == 3)
        check("restore: first rename fails -> no _restoring->live rename, _restoring dropped",
              first_index(cmds, R2) == -1 and RESTORING in cmds[-1] and "DROP DATABASE" in cmds[-1])

        # pre-checks: nothing touched
        for name, path, resp in (("missing dump", os.path.join(d, "nope.dump"), {}),
                                 ("tiny dump", _dump(d, 10), {}),
                                 ("unreadable archive", None, {"pg_restore --list": (1, "not a valid archive")})):
            if path is None:
                path = _dump(d)
            fake, o = make_ops(resp)
            ok, detail = o.restore(path)
            cmds = joined(fake)
            check("restore: %s -> False, nothing touched" % name,
                  ok is False and path in detail and first_index(cmds, "DROP DATABASE") == -1
                  and first_index(cmds, "createdb") == -1 and first_index(cmds, "ALTER DATABASE") == -1)


def test_compose_commands():
    fake, o = make_ops()
    check("up: ok", o.up(["backend", "frontend"]) is True)
    check("up: argv with --no-deps (never recreates postgres)",
          fake.calls[-1]["args"] == COMPOSE + ["up", "-d", "--no-deps", "backend", "frontend"])
    check("compose_args: public, same prefix", o.compose_args("ps") == COMPOSE + ["ps"])
    check("compose_args: other compose file",
          o.compose_args("pull", compose_file="/x.yml")[:6] == ["docker", "compose", "-p", "billiards", "-f", "/x.yml"])
    f2, o2 = make_ops({"ps -q backend": (0, "WARN noise\n" + BE_ID + "\n")})
    check("service_cid: public, hex id only", o2.service_cid("backend") == BE_ID)
    f2, o2 = make_ops({"ps -q backend": (0, "")})
    check("service_cid: none -> ''", o2.service_cid("backend") == "")
    check("up: empty list refused", o.up([]) is False and len(fake.calls) == 1)
    check("stop: ok", o.stop(["backend", "scheduler"]) is True)
    check("stop: argv", fake.calls[-1]["args"] == COMPOSE + ["stop", "backend", "scheduler"])
    check("pull_images: ok", o.pull_images("/tmp/rel/docker-compose.bar.yml") is True)
    a = fake.calls[-1]["args"]
    check("pull_images: uses given compose file",
          a[:9] == ["docker", "compose", "-p", "billiards", "-f", "/tmp/rel/docker-compose.bar.yml",
                    "--env-file", "/bar/.env", "pull"])
    check("pull_images: never pulls postgres", "postgres" not in a and "backend" in a and "updater" in a)
    fake, o = make_ops({"docker compose -p": (1, "err")})
    check("up: failure -> False", o.up(["backend"]) is False)
    check("stop: failure -> False", o.stop(["backend"]) is False)
    check("pull_images: failure -> False", o.pull_images("/x.yml") is False)


def _healthy_responses(**over):
    r = {
        "ps -q backend": (0, BE_ID + "\n"),
        "ps -q scheduler": (0, SCH_ID + "\n"),
        "ps -q telegram-bot": (0, TG_ID + "\n"),
        "docker inspect -f": (0, "running|healthy\n"),
        "exec -T backend flask migration-status": (0, STATUS_OK),
        "http://frontend/": (0, "200"),
    }
    r.update(over)
    return r


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def test_healthy():
    clk = Clock()
    fake, o = make_ops(_healthy_responses(), clock=clk.now, sleep=clk.sleep)
    ok, detail = o.healthy(timeout_s=300)
    check("healthy: all good -> True", ok is True)
    cmds = joined(fake)
    check("healthy: frontend probed from inside the network",
          first_index(cmds, " ".join(COMPOSE + ["exec", "-T", "backend", "curl"])) >= 0)

    def bad(name, over, **kw):
        c = Clock()
        f, op = make_ops(_healthy_responses(**over), clock=c.now, sleep=c.sleep, **kw)
        ok, detail = op.healthy(timeout_s=300)
        check("healthy: " + name + " -> False", ok is False and detail)
        check("healthy: " + name + " gives up at the budget", 300 <= c.t <= 305)

    bad("backend unhealthy", {"inspect -f {{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}} " + BE_ID: (0, "running|unhealthy\n")})
    bad("1 pending", {"exec -T backend flask migration-status": (0, "57/58 applied, 1 pending\n")})
    bad("10 pending is not 0 pending", {"exec -T backend flask migration-status": (0, "48/58 applied, 10 pending\n")})
    bad("unknown versions (!!)", {"exec -T backend flask migration-status":
                                  (0, STATUS_OK + "  !! Database reports migrations this build does not ship: 070\n")})
    bad("frontend 502", {"http://frontend/": (0, "502")})
    bad("scheduler exited", {"inspect -f {{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}} " + SCH_ID: (0, "exited|\n")})
    bad("telegram-bot missing (TELEGRAM_TOKEN set)", {"ps -q telegram-bot": (0, "")}, telegram_required=True)

    # becomes healthy after a few polls
    c = Clock()
    f, op = make_ops(_healthy_responses(**{
        "inspect -f {{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}} " + BE_ID:
            [(0, "running|starting\n"), (0, "running|starting\n"), (0, "running|healthy\n")]}),
        clock=c.now, sleep=c.sleep)
    ok, _ = op.healthy(timeout_s=300)
    check("healthy: starting -> healthy within budget -> True", ok is True and c.t < 300)


def test_stderr_kept_out_of_parsed_reads():
    warn = 'WARN[0000] The "BAR_HOST_DIR" variable is not set. Defaulting to a blank string.\n'

    def ps_with_warning(args, **kw):
        return 0, (PG_ID + "\n") if kw.get("stderr") == "separate" else warn + PG_ID + "\n"
    fake, o = make_ops({"ps -q postgres": ps_with_warning,
                        "cash_sessions": (0, "0\n"), "tickets": (0, "0\n")})
    check("ps -q: compose warning ignored", o.open_counts() == (0, 0))
    check("ps -q: asks for stderr separate", fake.calls[0]["stderr"] == "separate")
    check("ps -q: id used in docker exec", joined(fake)[1].startswith("docker exec " + PG_ID + " psql"))

    fake, o = make_ops({"ps -q postgres": (0, warn + PG_ID + "\n"),
                        "cash_sessions": (0, "0\n"), "tickets": (0, "0\n")})
    check("ps -q: warning in stdout still never taken as the id",
          o.open_counts() == (0, 0) and joined(fake)[1].startswith("docker exec " + PG_ID + " "))
    fake, o = make_ops({"ps -q postgres": (0, warn)})
    check("ps -q: only a warning -> no container -> raises", raises(o.open_counts, OpsError))

    def psql_notice(value):
        def fn(args, **kw):
            if kw.get("stderr") == "separate":
                return 0, value
            return 0, "WARNING:  there is no transaction in progress\nNOTICE:  hello\n" + value
        return fn
    fake, o = make_ops({"cash_sessions": psql_notice("1\n"), "tickets": psql_notice("0\n")})
    check("psql: NOTICE/WARNING not parsed in open_counts", o.open_counts() == (1, 0))
    check("psql: open_counts reads ask for stderr separate",
          all(c["stderr"] == "separate" for c in fake.calls if "psql" in c["args"]))
    fake, o = make_ops({"schema_migrations": psql_notice("001\n058\n")})
    check("psql: NOTICE not parsed in live_migration_versions", o.live_migration_versions() == {"001", "058"})

    def curl(args, **kw):
        return 0, "200" if kw.get("stderr") == "separate" else "curl: (6) warning\n200"
    clk = Clock()
    fake, o = make_ops(_healthy_responses(**{"http://frontend/": curl}), clock=clk.now, sleep=clk.sleep)
    check("healthy: curl probe reads stdout only", o.healthy(timeout_s=300)[0] is True)


class TimedFake(FakeRunner):
    """Every command takes `step` fake seconds; records (start time, timeout)."""

    def __init__(self, responses, clock, step):
        super().__init__(responses)
        self.clock = clock
        self.step = step
        self.timing = []

    def run(self, args, **kw):
        self.timing.append((self.clock.t, kw.get("timeout")))
        r = super().run(args, **kw)
        self.clock.t += self.step
        return r


def test_healthy_budget():
    c = Clock()
    r = dict(PG)
    r.update(_healthy_responses(**{"http://frontend/": (0, "502")}))
    fake = TimedFake(r, c, 40)
    o = Ops(fake, project="billiards", pg_user="billiard", pg_db="billiardbar", pg_password="x",
            clock=c.now, sleep=c.sleep)
    ok, detail = o.healthy(timeout_s=300)
    check("budget: gives up with the real failure", ok is False and "frontend" in detail)
    check("budget: no command starts after the deadline", all(t < 300 for t, _ in fake.timing))
    check("budget: each timeout capped at the time left",
          all(to is not None and to <= max(1, 300 - t) for t, to in fake.timing))
    check("budget: each timeout <= 120", all(to <= 120 for _, to in fake.timing))


TG_STATE = "inspect -f {{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}} " + TG_ID
TG_RESTARTS = "{{.RestartCount}} " + TG_ID


def test_healthy_telegram():
    """telegram-bot counts only when TELEGRAM_TOKEN is set (final review item 4)."""
    # Default: required exactly when TELEGRAM_TOKEN is set in the environment.
    saved = os.environ.pop("TELEGRAM_TOKEN", None)
    try:
        _, o = make_ops()
        check("telegram: not required without TELEGRAM_TOKEN", o.telegram_required is False)
        os.environ["TELEGRAM_TOKEN"] = "123:abc"
        _, o = make_ops()
        check("telegram: required when TELEGRAM_TOKEN is set", o.telegram_required is True)
        os.environ["TELEGRAM_TOKEN"] = "  "
        _, o = make_ops()
        check("telegram: blank TELEGRAM_TOKEN -> not required", o.telegram_required is False)
    finally:
        os.environ.pop("TELEGRAM_TOKEN", None)
        if saved is not None:
            os.environ["TELEGRAM_TOKEN"] = saved

    # Not required: a missing, exited or restarting bot never fails the health check.
    for name, over in (("missing", {"ps -q telegram-bot": (0, "")}),
                       ("exited", {TG_STATE: (0, "exited|\n")}),
                       ("restarting", {TG_STATE: (0, "restarting|\n"), TG_RESTARTS: (0, "9\n")})):
        c = Clock()
        f, o = make_ops(_healthy_responses(**over), clock=c.now, sleep=c.sleep, telegram_required=False)
        ok, detail = o.healthy(timeout_s=300)
        check("telegram (no token) %s: healthy" % name, ok is True)
        check("telegram (no token) %s: warning in the detail" % name,
              "telegram-bot" in (detail or "") and "warning" in (detail or ""))
        check("telegram (no token) %s: no waiting" % name, c.t == 0)
    c = Clock()
    f, o = make_ops(_healthy_responses(), clock=c.now, sleep=c.sleep, telegram_required=False)
    check("telegram (no token) running: plain ok", o.healthy(timeout_s=300) == (True, "ok"))

    # Required: running is fine; restarting is accepted only a few times (grace).
    c = Clock()
    f, o = make_ops(_healthy_responses(**{TG_STATE: (0, "restarting|\n"), TG_RESTARTS: (0, "1\n")}),
                    clock=c.now, sleep=c.sleep, telegram_required=True)
    ok, detail = o.healthy(timeout_s=300)
    check("telegram (token) restarting 1 time: accepted with a warning",
          ok is True and "telegram-bot" in detail and "warning" in detail)
    for name, over in (("restarting too often", {TG_STATE: (0, "restarting|\n"), TG_RESTARTS: (0, "%d\n" % 3)}),
                       ("restart count unreadable", {TG_STATE: (0, "restarting|\n"), TG_RESTARTS: (1, "err")}),
                       ("exited", {TG_STATE: (0, "exited|\n")})):
        c = Clock()
        f, o = make_ops(_healthy_responses(**over), clock=c.now, sleep=c.sleep, telegram_required=True)
        ok, detail = o.healthy(timeout_s=300)
        check("telegram (token) %s: not healthy" % name, ok is False and "telegram-bot" in detail)
    # scheduler is still always required
    c = Clock()
    f, o = make_ops(_healthy_responses(**{
        "inspect -f {{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}} " + SCH_ID:
            (0, "exited|\n")}), clock=c.now, sleep=c.sleep, telegram_required=False)
    check("telegram (no token): scheduler exited still fails", o.healthy(timeout_s=300)[0] is False)


DBLIST = "FROM pg_database WHERE datname IN"


def test_recover_interrupted_swap():
    """A restore cut between its two renames leaves no <db> (final review item 8)."""
    with tempfile.TemporaryDirectory() as d:
        dump = _dump(d)

        # <db> missing, <db>_failed present -> renamed back first, then the normal restore.
        fake, o = make_ops({DBLIST: (0, "billiardbar_failed\nbilliardbar_restoring\n"),
                            "schema_migrations": (0, "58\n")})
        ok, detail = o.restore(dump)
        cmds = joined(fake)
        i_back = first_index(cmds, RBACK)
        check("recover: _failed renamed back to live before anything else",
              0 <= first_index(cmds, DBLIST) < i_back < first_index(cmds, "pg_restore --list")
              and i_back < first_index(cmds, 'DROP DATABASE IF EXISTS "billiardbar_failed"'))
        check("recover: then the normal restore runs", ok is True and first_index(cmds, R2) > i_back)

        # <db> missing, only a valid <db>_restoring -> renamed to live.
        fake, o = make_ops({DBLIST: (0, "billiardbar_restoring\n"), "schema_migrations": (0, "58\n")})
        ok, _ = o.restore(dump)
        cmds = joined(fake)
        check("recover: valid _restoring renamed to live first",
              0 <= first_index(cmds, R2) < first_index(cmds, "pg_restore --list"))

        # <db> missing, _restoring empty -> not used.
        fake, o = make_ops({DBLIST: (0, "billiardbar_restoring\n"), "schema_migrations": (0, "0\n")})
        o.restore(dump)
        cmds = joined(fake)
        check("recover: empty _restoring is not renamed to live",
              first_index(cmds, R2) == -1 or first_index(cmds, R2) > first_index(cmds, "pg_restore --list"))

        # <db> present -> nothing renamed before the restore.
        fake, o = make_ops({DBLIST: (0, "billiardbar\nbilliardbar_failed\n"), "schema_migrations": (0, "58\n")})
        ok, _ = o.restore(dump)
        cmds = joined(fake)
        check("recover: live present -> no rename before the restore",
              ok is True and first_index(cmds, "ALTER DATABASE") > first_index(cmds, "pg_restore --list"))

        # rename back fails -> restore refused, _failed (the only copy) never dropped.
        fake, o = make_ops({DBLIST: (0, "billiardbar_failed\n"), RBACK: (1, "boom")})
        ok, detail = o.restore(dump)
        cmds = joined(fake)
        check("recover: rename back fails -> restore refused",
              ok is False and "billiardbar_failed" in detail and dump in detail)
        check("recover: rename back fails -> _failed never dropped, nothing restored",
              first_index(cmds, "DROP DATABASE") == -1 and first_index(cmds, "pg_restore") == -1)

        # database list unreadable -> restore refused (never drop _failed blind).
        fake, o = make_ops({DBLIST: (2, "connection refused")})
        ok, detail = o.restore(dump)
        cmds = joined(fake)
        check("recover: list unreadable -> restore refused, nothing dropped",
              ok is False and first_index(cmds, "DROP DATABASE") == -1)

        # public helper
        fake, o = make_ops({DBLIST: (0, "billiardbar_failed\n")})
        ok, detail = o.recover_interrupted_swap()
        check("recover_interrupted_swap: public, renames back", ok is True and joined(fake)[-1].endswith(RBACK))
        fake, o = make_ops({DBLIST: (0, "billiardbar\n")})
        ok, detail = o.recover_interrupted_swap()
        check("recover_interrupted_swap: nothing to do -> no rename",
              ok is True and first_index(joined(fake), "ALTER DATABASE") == -1)


SHA_A, SHA_B, SHA_C, SHA_D = "a" * 40, "b" * 40, "c" * 40, "d" * 40


def test_prune_images():
    """Old billar-pos images are removed after an install (final review item 7)."""
    reg = "ghcr.io/cj-castro"
    images = "\n".join([
        "%s/billar-pos-backend|%s" % (reg, SHA_A),        # previous: kept
        "%s/billar-pos-backend|%s" % (reg, SHA_B),        # current: kept
        "%s/billar-pos-backend|%s" % (reg, SHA_C),        # old: removed
        "%s/billar-pos-frontend|%s" % (reg, SHA_C),       # old: removed
        "%s/billar-pos-release|bar-stable" % reg,          # approval tag: kept
        "%s/billar-pos-release|bar-previous" % reg,        # kept
        "%s/billar-pos-updater|%s" % (reg, SHA_D),        # used by a container: kept
        "%s/billar-pos-backup|<none>" % reg,               # untagged: left alone
        "%s/billar-pos-backend|latest" % reg,              # not a SHA tag: left alone
        "postgres|15-alpine",                              # never
        "%s/other-app|%s" % (reg, SHA_C),                 # not ours
        "localhost:5001/billar-pos-backend|%s" % SHA_C,    # other registry
    ]) + "\n"
    fake, o = make_ops({"docker image ls": (0, images),
                        "docker ps -a": (0, "postgres:15-alpine\n%s/billar-pos-updater:%s\n" % (reg, SHA_D))})
    removed = o.prune_images({SHA_A, SHA_B})
    rmis = [c for c in joined(fake) if c.startswith("docker rmi")]
    check("prune: removes only old SHA tags of our images",
          sorted(removed) == sorted(["%s/billar-pos-backend:%s" % (reg, SHA_C),
                                     "%s/billar-pos-frontend:%s" % (reg, SHA_C)])
          and len(rmis) == 2)
    check("prune: never -f", all(" -f" not in c for c in rmis))
    check("prune: never current, previous, bar-*, postgres, in-use, other registries",
          not any(x in " ".join(rmis) for x in (SHA_A, SHA_B, SHA_D, "bar-", "postgres", "localhost:5001",
                                                 "other-app", "latest")))

    # rmi failure: logged, others still tried, never raises
    fake, o = make_ops({"docker image ls": (0, images),
                        "docker ps -a": (0, "%s/billar-pos-updater:%s\n" % (reg, SHA_D)),
                        "billar-pos-backend:" + SHA_C: (1, "conflict: image is being used")})
    removed = o.prune_images({SHA_A, SHA_B})
    check("prune: one failure does not stop the others",
          removed == ["%s/billar-pos-frontend:%s" % (reg, SHA_C)])

    # unreadable lists -> nothing removed
    fake, o = make_ops({"docker image ls": (1, "daemon down")})
    check("prune: image list fails -> nothing removed",
          o.prune_images({SHA_A}) == [] and not any(c.startswith("docker rmi") for c in joined(fake)))
    fake, o = make_ops({"docker image ls": (0, images), "docker ps -a": (1, "daemon down")})
    check("prune: container list fails -> nothing removed",
          o.prune_images({SHA_A}) == [] and not any(c.startswith("docker rmi") for c in joined(fake)))

    # never raises
    def boom(args, **kw):
        raise RuntimeError("socket")
    fake, o = make_ops({"docker image ls": boom})
    try:
        r = o.prune_images({SHA_A})
        check("prune: an exception is logged, not raised", r == [])
    except Exception:
        check("prune: an exception is logged, not raised", False)


def main():
    for t in (test_fake_runner, test_runner_redaction, test_runner_io, test_project_and_defaults,
              test_login, test_pull_release, test_open_counts, test_live_migration_versions,
              test_backup, test_rehearse, test_restore, test_compose_commands, test_healthy,
              test_stderr_kept_out_of_parsed_reads, test_healthy_budget, test_healthy_telegram,
              test_recover_interrupted_swap, test_prune_images):
        try:
            t()
        except Exception as e:  # a crash is a failure, not a pass
            check(t.__name__ + " raised " + type(e).__name__ + ": " + str(e), False)
    print("\n%d failed" % len(FAILED))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
