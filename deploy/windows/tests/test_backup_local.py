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
        restore=lambda dump, bin=None: ps(RESTORE, *base[:2], "-PgBin", str(bin or native_pg.bin), "-OutDir", str(out),
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
    r = lb.restore(dump)
    assert r.returncode == 0, r.stdout + r.stderr
    safety = list(lb.out.glob("db_pre-restore_*.dump"))
    assert len(safety) == 1 and safety[0].stat().st_size >= 10000
    assert _run([lb.pg.bin / "pg_restore.exe", "--list", safety[0]]).returncode == 0


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
