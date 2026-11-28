"""Plain-script tests for updater.core. Run: python -m tests.test_core"""
import json
import os
import sys
import tempfile
from datetime import datetime

from updater import core

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


A = "a" * 40
B = "b" * 40


def rel(sha=A, migrations=("001", "002")):
    return core.Release(sha=sha, built_at="2026-11-27T00:00:00Z", migrations=list(migrations))


def test_parse_release():
    r = core.parse_release(json.dumps({"sha": A, "built_at": "t", "migrations": ["001"]}))
    check("parse_release valid", r.sha == A and r.migrations == ["001"] and r.built_at == "t")
    check("parse_release missing key", raises(lambda: core.parse_release(json.dumps({"sha": A})), ValueError))
    check("parse_release short sha", raises(lambda: core.parse_release(json.dumps({"sha": "abc", "built_at": "t", "migrations": []})), ValueError))
    check("parse_release non-hex sha", raises(lambda: core.parse_release(json.dumps({"sha": "z" * 40, "built_at": "t", "migrations": []})), ValueError))
    check("parse_release bad json", raises(lambda: core.parse_release("nope"), ValueError))


def test_state():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "state.json")
        s = core.load_state(p)
        check("load_state missing -> None", (s.current_sha, s.previous_sha, s.in_progress, s.last_result) == (None, None, None, None))
        core.save_state(p, core.State(A, B, {"step": "backup"}, "ok"))
        s = core.load_state(p)
        check("state roundtrip", (s.current_sha, s.previous_sha, s.in_progress, s.last_result) == (A, B, {"step": "backup"}, "ok"))
        check("no tmp left", not os.path.exists(p + ".tmp"))
        check("state: failed/window_backup default None", (s.failed, s.window_backup) == (None, None))
        f = {"sha": A, "outcome": "rollback_failed", "backup_path": "/bar/backups/x.dump",
             "host_backup_path": "C:\\bar\\backups\\x.dump", "at": "t"}
        w = {"old_sha": B, "new_sha": A, "path": "/bar/backups/x.dump", "date": "2026-11-28"}
        core.save_state(p, core.State(A, B, None, "rollback_failed", failed=f, window_backup=w))
        s = core.load_state(p)
        check("state roundtrip failed + window_backup", s.failed == f and s.window_backup == w)
        with open(p, "w") as fh:
            json.dump({"current_sha": A}, fh)
        s = core.load_state(p)
        check("state: old file without the new keys loads", s.current_sha == A and s.failed is None)


def test_decide():
    empty = core.State(None, None, None, None)
    check("decide noop", core.decide(rel(), core.State(A, None, None, None), {"001"}) == "noop")
    check("decide install", core.decide(rel(sha=B), core.State(A, None, None, None), {"001", "002"}) == "install")
    check("decide install first time", core.decide(rel(), empty, set()) == "install")
    check("decide older_than_db", core.decide(rel(), empty, {"001", "058"}) == "older_than_db")
    check("decide squashed 031b ignored", core.decide(rel(), empty, {"001", "031b"}) == "install")
    check("decide squashed 027 and 039 ignored", core.decide(rel(), empty, {"027", "039"}) == "install")
    check("decide 040 not squashed", core.decide(rel(), empty, {"040"}) == "older_than_db")


def test_window():
    d = lambda h, m: datetime(2026, 11, 28, h, m)
    check("window 02:59", core.in_window(d(2, 59)) is False)
    check("window 03:00", core.in_window(d(3, 0)) is True)
    check("window 11:59", core.in_window(d(11, 59)) is True)
    check("window 12:00", core.in_window(d(12, 0)) is False)


def test_backups():
    n = core.backup_name(None, A, datetime(2026, 11, 28, 3, 0))
    check("backup_name none", n == "pre-update-none-to-aaaaaaa-20261128-0300.dump")
    n = core.backup_name(B, A, datetime(2026, 11, 28, 3, 5))
    check("backup_name old", n == "pre-update-bbbbbbb-to-aaaaaaa-20261128-0305.dump")
    names = ["pre-update-none-to-aaaaaaa-202611%02d-0300.dump" % day for day in range(1, 13)]
    names.append("other.dump")
    import random
    random.shuffle(names)
    out = core.prune_backups(names)
    check("prune deletes 2 oldest", out == sorted(n for n in names if n != "other.dump")[:2])
    check("prune ignores other", "other.dump" not in out)
    check("prune under limit", core.prune_backups(names[:5]) == [])
    # Lexical order of whole names disagrees with timestamp order here.
    mixed = [
        "pre-update-zzzzzzz-to-bbbbbbb-20261101-0300.dump",
        "pre-update-aaaaaaa-to-ccccccc-20261102-0300.dump",
        "pre-update-mmmmmmm-to-aaaaaaa-20261103-0300.dump",
    ] + ["pre-update-none-to-ddddddd-202611%02d-0300.dump" % d for d in range(4, 13)] + ["other.dump"]
    out = core.prune_backups(mixed)
    check("prune orders by timestamp not name", out == [
        "pre-update-zzzzzzz-to-bbbbbbb-20261101-0300.dump",
        "pre-update-aaaaaaa-to-ccccccc-20261102-0300.dump",
    ])


def test_messages():
    for kind in ["installed", "blocked_open", "registry_down", "backup_failed",
                 "rehearsal_failed", "rolled_back", "rollback_failed", "older_than_db",
                 "db_unreachable"]:
        t = core.message(kind, old_sha=B, new_sha=A, step="backup", error="boom")
        check("message %s non-empty with sha" % kind, bool(t) and A[:7] in t)
    for kind in ["registry_down", "backup_failed", "rehearsal_failed", "rolled_back", "rollback_failed",
                 "db_unreachable"]:
        check("message %s includes error" % kind, "boom-xyz" in core.message(kind, old_sha=B, new_sha=A, step="s", error="boom-xyz"))
    check("message installed has old sha", B[:7] in core.message("installed", old_sha=B, new_sha=A))
    check("message handles old none", A[:7] in core.message("installed", old_sha=None, new_sha=A))
    for kind in ["blocked_open", "registry_down", "db_unreachable"]:
        t = core.message(kind, old_sha=B, new_sha=A, error="e")
        check("message %s: one consistent retry (mañana 03:00, not 'cada hora')" % kind,
              "mañana a las 03:00" in t and "cada hora" not in t)
    check("message db_unreachable says the DB could not be read",
          "no se pudo leer la base de datos" in core.message("db_unreachable", new_sha=A).lower())
    check("message unknown kind", raises(lambda: core.message("zzz", new_sha=A), ValueError))
    t = core.message("resume_held", old_sha=B, new_sha=A, step="s", error="boom-xyz")
    check("message resume_held: 'requiere atención', both SHAs, the detail, nothing restored, --force",
          "requiere atención" in t and A[:7] in t and B[:7] in t and "boom-xyz" in t
          and "no se restauró" in t.lower() and "run-now --force" in t)


if __name__ == "__main__":
    test_parse_release()
    test_state()
    test_decide()
    test_window()
    test_backups()
    test_messages()
    if FAILED:
        print("%d FAILED" % len(FAILED))
        sys.exit(1)
    print("ALL PASS")
