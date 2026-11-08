import os
from pathlib import Path

import pytest
from conftest import WIN, psql, restore, _run, fingerprint as _fingerprint

FIXTURES = Path(__file__).parent / "fixtures"
INIT = str(WIN / "postgres" / "Initialize-PosCluster.ps1")
FINGERPRINT = WIN / "sql" / "fingerprint.sql"

needs_dump = pytest.mark.skipif(not os.environ.get("POS_TEST_DUMP"), reason="POS_TEST_DUMP not set")


def scalar(pg, sql, db=None):
    r = psql(pg, db or pg.db, "-Atc", sql)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_cluster_settings(native_pg):
    assert scalar(native_pg, "show timezone") == "UTC"
    assert scalar(native_pg, "show datestyle") == "ISO, MDY"
    assert scalar(native_pg, "select datcollate from pg_database where datname=current_database()") == "C"
    assert scalar(native_pg, "select datctype from pg_database where datname=current_database()") == "en-US"
    assert scalar(native_pg, "show server_encoding") == "UTF8"
    assert scalar(native_pg, "show logging_collector") == "on"      # R24: service stderr is otherwise lost
    assert scalar(native_pg, "show log_directory") == "log"


def test_locale_matches_alpine_reference(native_pg):
    """Accented Spanish names must search/sort exactly as on the Docker (musl) Postgres."""
    r = psql(native_pg, native_pg.db, "-At", "-f", str(FIXTURES / "locale_test.sql"))
    assert r.returncode == 0, r.stderr
    got = r.stdout.splitlines()
    want = (FIXTURES / "locale_reference.txt").read_text(encoding="utf-8").splitlines()
    assert got == want


@needs_dump
def test_restore_fingerprint_equals_source(native_pg, restored_db, tmp_path):
    restored_db("fp_a")
    dump2 = tmp_path / "fp_a.dump"
    r = _run([native_pg.bin / "pg_dump.exe", "-Fc", "-h", "127.0.0.1", "-p", native_pg.port,
              "-U", native_pg.user, "-d", "fp_a", "-f", dump2], env=native_pg.env)
    assert r.returncode == 0, r.stderr
    assert psql(native_pg, "postgres", "-c",
                "create database fp_b encoding 'UTF8' lc_collate 'C' lc_ctype 'en-US' template template0").returncode == 0
    restore(native_pg, "fp_b", dump2)
    a, b = _fingerprint(native_pg, "fp_a"), _fingerprint(native_pg, "fp_b")
    assert a == b
    names = {row.split("|")[0].split(":")[0] for row in a}
    assert {"table", "sequence", "schema_migrations", "functions", "triggers", "views"} <= names


def test_initialize_is_idempotent(native_pg, run_ps):
    scalar(native_pg, "create table if not exists idem_probe(x int); insert into idem_probe values (42)")
    before = scalar(native_pg, "select count(*) || ':' || max(x) from idem_probe")
    r = run_ps(INIT, "-PgBin", str(native_pg.bin), "-DataDir", str(native_pg.data), "-Port", str(native_pg.port),
               "-DbUser", native_pg.user, "-DbPassword", native_pg.password, "-DbName", native_pg.db)
    assert r.returncode == 0, r.stdout + r.stderr
    assert scalar(native_pg, "select count(*) || ':' || max(x) from idem_probe") == before
    assert scalar(native_pg, "show timezone") == "UTC"
