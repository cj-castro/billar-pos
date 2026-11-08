"""Shared pytest harness for the native-windows tests.

Fixtures (names are binding for later tasks): pg_bin, native_pg, restored_db(name), run_ps(script, *args, env=None).
Run Setup-TestEnv.ps1 first; everything lives under deploy/windows/.native-test/.
"""
import ctypes
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

WIN = Path(__file__).resolve().parents[1]           # deploy/windows
NATIVE_TEST = WIN / ".native-test"
PG_PORT = 55432
PG_USER = "billiard"
PG_PASSWORD = "test_pw_not_secret"
PG_DB = "billiardbar"


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def pytest_collection_modifyitems(config, items):
    if is_admin():
        return
    skip = pytest.mark.skip(reason="needs an elevated shell")
    for item in items:
        if "admin" in item.keywords:
            item.add_marker(skip)


def _run(cmd, env=None, **kw):
    e = {**os.environ, "PGCLIENTENCODING": "UTF8", **(env or {})}
    return subprocess.run([str(c) for c in cmd], env=e, capture_output=True, text=True,
                          encoding="utf-8", **kw)


@pytest.fixture(scope="session")
def pg_bin() -> Path:
    p = NATIVE_TEST / "pgsql" / "bin"
    if not (p / "postgres.exe").exists():
        pytest.skip("run deploy/windows/tests/Setup-TestEnv.ps1 first")
    return p


@pytest.fixture(scope="session")
def run_ps():
    """run_ps(script, *args, env=None) -> CompletedProcess (never raises on non-zero exit)."""
    def _ps(script, *args, env=None):
        return _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                     "-File", script, *args], env=env)
    return _ps


@pytest.fixture(scope="session")
def native_pg(pg_bin, run_ps, tmp_path_factory):
    """Fresh cluster on 55432 (initialised by Initialize-PosCluster.ps1), started detached, stopped at teardown."""
    data = tmp_path_factory.mktemp("pgdata") / "data"
    r = run_ps(str(WIN / "postgres" / "Initialize-PosCluster.ps1"),
               "-PgBin", str(pg_bin), "-DataDir", str(data), "-Port", str(PG_PORT),
               "-DbUser", PG_USER, "-DbPassword", PG_PASSWORD, "-DbName", PG_DB)
    assert r.returncode == 0, r.stdout + r.stderr
    log = data.parent / "pg.log"
    # no captured pipes: the detached postmaster would inherit them and hang the call
    r = subprocess.run([str(pg_bin / "pg_ctl.exe"), "start", "-D", str(data), "-w", "-t", "60", "-l", str(log)],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    assert r.returncode == 0, log.read_text(errors="replace") if log.exists() else "pg_ctl start failed"
    pg = SimpleNamespace(bin=pg_bin, data=data, port=PG_PORT, user=PG_USER, password=PG_PASSWORD,
                         db=PG_DB, env={"PGPASSWORD": PG_PASSWORD})
    pg.dsn = lambda db=PG_DB: f"postgresql://{PG_USER}:{PG_PASSWORD}@127.0.0.1:{PG_PORT}/{db}"
    yield pg
    _run([pg_bin / "pg_ctl.exe", "stop", "-D", data, "-m", "fast", "-w"])


def psql(pg, db, *args):
    return _run([pg.bin / "psql.exe", "-X", "-h", "127.0.0.1", "-p", pg.port, "-U", pg.user, "-d", db,
                 "-v", "ON_ERROR_STOP=1", *args], env=pg.env)


def restore(pg, db, dump):
    """pg_restore --no-owner --no-privileges; fails on any `pg_restore: error:` line (no allow-list: none seen with the
    prod dump, so a partial restore must never pass silently)."""
    r = _run([pg.bin / "pg_restore.exe", "--no-owner", "--no-privileges", "-h", "127.0.0.1", "-p", pg.port,
              "-U", pg.user, "-d", db, dump], env=pg.env)
    errs = [l for l in r.stderr.splitlines() if "pg_restore: error:" in l]
    assert r.returncode == 0 and not errs, f"pg_restore into {db} failed (rc={r.returncode}):" + chr(10) + r.stderr


@pytest.fixture(scope="session")
def restored_db(native_pg):
    """Factory: restored_db(name) -> DSN of a fresh DB `name` holding POS_TEST_DUMP.
    The dump is restored once into a template DB; each call clones it (CREATE DATABASE ... TEMPLATE)."""
    dump = os.environ.get("POS_TEST_DUMP")
    if not dump or not Path(dump).exists():
        pytest.skip("POS_TEST_DUMP not set (or file missing)")
    tmpl = "_pos_template"

    def _make(name):
        if not (r := psql(native_pg, "postgres", "-Atc",
                          f"select 1 from pg_database where datname='{tmpl}'")).stdout.strip():
            r = psql(native_pg, "postgres", "-c",
                     f"create database {tmpl} encoding 'UTF8' lc_collate 'C' lc_ctype 'en-US' template template0")
            assert r.returncode == 0, r.stderr
            restore(native_pg, tmpl, dump)
            n = psql(native_pg, tmpl, "-Atc", "select count(*) from pg_tables where schemaname='public'")
            assert int(n.stdout.strip() or 0) > 0, "restore produced no tables"
        psql(native_pg, "postgres", "-c", f"drop database if exists {name} with (force)")
        r = psql(native_pg, "postgres", "-c", f"create database {name} template {tmpl}")
        assert r.returncode == 0, r.stderr
        return native_pg.dsn(name)
    return _make

