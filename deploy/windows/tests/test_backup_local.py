"""Task 9: Backup-Native.ps1 / Restore-Native.ps1 against a restored copy of the prod dump (never app_test)."""
import os
import time
from types import SimpleNamespace

import pytest
from conftest import WIN, _run, fingerprint, psql

BACKUP = str(WIN / "backup" / "Backup-Native.ps1")
RESTORE = str(WIN / "backup" / "Restore-Native.ps1")


def ps(script, *args):
    return _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, *args])


@pytest.fixture
def lb(native_pg, restored_db, tmp_path):
    db = "bk_local"
    restored_db(db)
    envf = tmp_path / "backup.env"
    envf.write_text("".join(f"{k}={v}\n" for k, v in {
        "POSTGRES_DB": db, "POSTGRES_USER": native_pg.user, "POSTGRES_PASSWORD": native_pg.password,
        "PG_HOST": "127.0.0.1", "PG_PORT": str(native_pg.port)}.items()), encoding="utf-8", newline="\n")
    out = tmp_path / "backups"
    base = ["-EnvFile", str(envf), "-PgBin", str(native_pg.bin)]
    return SimpleNamespace(
        db=db, out=out, pg=native_pg,
        backup=lambda *a, bin=None: ps(BACKUP, *base[:2], "-PgBin", str(bin or native_pg.bin), "-OutDir", str(out), *a),
        restore=lambda dump, bin=None, outdir=None: ps(RESTORE, *base[:2], "-PgBin", str(bin or native_pg.bin),
                                         "-OutDir", str(outdir or out),
                                         "-DumpFile", str(dump), "-Force"),
        fp=lambda: fingerprint(native_pg, db))


def test_backup_restore_roundtrip_fingerprint(lb):
    before = lb.fp()
    r = lb.backup("-Label", "rt")
    assert r.returncode == 0, r.stdout + r.stderr
    dump = r.stdout.strip().splitlines()[-1]
    assert os.path.basename(dump).startswith("db_rt_") and dump.endswith(".dump") and os.path.getsize(dump) >= 10000
    assert psql(lb.pg, lb.db, "-c", "create table zz_junk(x int)").returncode == 0
    r = lb.restore(dump)
    assert r.returncode == 0, r.stdout + r.stderr
    for t in ("tickets  ", "inventory items", "migrations applied"):
        assert t in r.stdout
    assert lb.fp() == before


def test_restore_takes_safety_dump_first(lb):
    dump = lb.backup("-Label", "src").stdout.strip().splitlines()[-1]
    assert psql(lb.pg, lb.db, "-c", "create table zz_junk(x int)").returncode == 0
    r = lb.restore(dump)
    assert r.returncode == 0, r.stdout + r.stderr
    safety = list(lb.out.glob("db_pre-restore_*.dump"))
    assert len(safety) == 1 and safety[0].stat().st_size >= 10000
    toc = _run([lb.pg.bin / "pg_restore.exe", "--list", safety[0]])
    assert toc.returncode == 0 and "zz_junk" in toc.stdout    # the safety dump holds the pre-restore state


def test_restore_aborts_if_safety_dump_fails(lb, tmp_path):
    dump = lb.backup("-Label", "src").stdout.strip().splitlines()[-1]
    psql(lb.pg, lb.db, "-c", "create table zz_junk(x int)")
    before = lb.fp()
    r = lb.restore(dump, bin=tmp_path / "no-such-bin")
    assert r.returncode != 0
    assert not list(lb.out.glob("db_pre-restore_*.dump"))
    assert lb.fp() == before
    assert psql(lb.pg, lb.db, "-Atc", "select to_regclass('zz_junk')").stdout.strip() == "zz_junk"


def test_prune_keeps_recent(lb):
    lb.out.mkdir()
    old, new, other = (lb.out / n for n in ("db_old_20260101_000000.dump", "db_new_20261107_000000.dump", "keep.txt"))
    for f, days in ((old, 31), (new, 1), (other, 31)):
        f.write_bytes(b"x")
        t = time.time() - days * 86400
        os.utime(f, (t, t))
    r = lb.backup("-Label", "p", "-KeepDays", "30")
    assert r.returncode == 0, r.stdout + r.stderr
    assert not old.exists() and new.exists() and other.exists()
    assert len(list(lb.out.glob("db_p_*.dump"))) == 1


def test_restore_aborts_if_only_safety_dump_fails(lb, tmp_path):
    """PgBin is good: only the safety dump can fail (OutDir is an existing FILE), so the guard itself is what stops us."""
    dump = lb.backup("-Label", "src").stdout.strip().splitlines()[-1]
    psql(lb.pg, lb.db, "-c", "create table zz_junk(x int)")
    before = lb.fp()
    notdir = tmp_path / "iamafile"
    notdir.write_text("x")
    r = lb.restore(dump, outdir=notdir)
    assert r.returncode != 0 and "safety dump failed" in r.stdout
    assert "safety dump:" not in r.stdout, "no safety-dump path may be printed when the safety dump itself failed (M7)"
    assert lb.fp() == before
    assert psql(lb.pg, lb.db, "-Atc", "select to_regclass('zz_junk')").stdout.strip() == "zz_junk"


def test_scheduled_run_prunes_old_logs_only(lb, tmp_path):
    """M2: with -LogDir, *.log* files older than 30 days go; recent logs and other files stay."""
    logs = tmp_path / "logs"
    logs.mkdir()
    old, old_rot, new, other = (logs / n for n in ("Old.log", "Svc-20260101.log.1", "New.log", "notes.txt"))
    for f, days in ((old, 31), (old_rot, 45), (new, 2), (other, 90)):
        f.write_bytes(b"x")
        t = time.time() - days * 86400
        os.utime(f, (t, t))
    r = lb.backup("-Label", "p", "-LogDir", str(logs))
    assert r.returncode == 0, r.stdout + r.stderr
    assert not old.exists() and not old_rot.exists() and new.exists() and other.exists()
    assert "pruned 2 log file(s)" in r.stdout
    # without -LogDir nothing outside the dump folder is touched
    old.write_bytes(b"x")
    os.utime(old, (time.time() - 40 * 86400,) * 2)
    assert lb.backup("-Label", "q").returncode == 0
    assert old.exists()


def test_prune_failure_keeps_new_dump(lb):
    """An old dump held open exclusively cannot be deleted: backup still exits 0, keeps the new dump, logs a WARN."""
    import ctypes
    from ctypes import wintypes
    lb.out.mkdir()
    old = lb.out / "db_old_20260101_000000.dump"
    old.write_bytes(b"x")
    t = time.time() - 31 * 86400
    os.utime(old, (t, t))
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    h = k32.CreateFileW(str(old), 0x80000000, 0, None, 3, 0x80, None)    # GENERIC_READ, share none, OPEN_EXISTING
    assert h not in (None, wintypes.HANDLE(-1).value), ctypes.get_last_error()
    try:
        r = lb.backup("-Label", "p", "-KeepDays", "30")
    finally:
        k32.CloseHandle(h)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "WARN: prune failed" in r.stdout
    new = list(lb.out.glob("db_p_*.dump"))
    assert len(new) == 1 and new[0].stat().st_size >= 10000
    assert _run([lb.pg.bin / "pg_restore.exe", "--list", new[0]]).returncode == 0
    assert old.exists()
