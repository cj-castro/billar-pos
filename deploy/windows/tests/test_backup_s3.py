"""Task 8: backup-s3.ps1 against a local moto S3 (never real AWS)."""
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import boto3
import pytest
from conftest import NATIVE_TEST, WIN, _run, fingerprint, port_open, psql, restore

SCRIPT = str(WIN / "backup" / "backup-s3.ps1")
MOTO_PORT = 59000
ENDPOINT = f"http://127.0.0.1:{MOTO_PORT}"
BUCKET = "pos-backup-test"
AWS_EXE = NATIVE_TEST / "bin" / "aws" / "Amazon" / "AWSCLIV2" / "aws.exe"
KEY_RE = re.compile(r"^billiardbar/billiardbar_\d{4}-\d{2}-\d{2}_\d{4}\.dump$")


@pytest.fixture(scope="session")
def moto(tmp_path_factory):
    exe = Path(sys.executable).parent / "moto_server.exe"
    if not exe.exists() or not AWS_EXE.exists():
        pytest.skip("run deploy/windows/tests/Setup-TestEnv.ps1 first (moto, aws cli)")
    assert not port_open(MOTO_PORT), f"port {MOTO_PORT} already in use"
    tmp = tmp_path_factory.mktemp("moto")
    out = open(tmp / "moto.log", "wb")
    p = subprocess.Popen([str(exe), "-H", "127.0.0.1", "-p", str(MOTO_PORT)], stdin=subprocess.DEVNULL,
                         stdout=out, stderr=subprocess.STDOUT)
    end = time.time() + 30
    while time.time() < end and not port_open(MOTO_PORT):
        time.sleep(0.2)
    assert port_open(MOTO_PORT), (tmp / "moto.log").read_text(errors="replace")
    s3 = boto3.client("s3", endpoint_url=ENDPOINT, region_name="us-east-1",
                      aws_access_key_id="testing", aws_secret_access_key="testing")
    s3.create_bucket(Bucket=BUCKET)
    yield s3
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
    out.close()


@pytest.fixture
def bk(native_pg, moto, tmp_path):
    """Per-test sandbox: empty bucket, StateDir, private TEMP, env file; run(db=..., ...) -> CompletedProcess."""
    for o in moto.list_objects_v2(Bucket=BUCKET).get("Contents", []):
        moto.delete_object(Bucket=BUCKET, Key=o["Key"])
    state, temp = tmp_path / "state", tmp_path / "temp"
    state.mkdir()
    temp.mkdir()
    (tmp_path / "empty").write_text("")
    # no ambient AWS profile/creds/IMDS may leak in: only moto is ever reachable
    base = {"TEMP": str(temp), "TMP": str(temp), "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_SHARED_CREDENTIALS_FILE": str(tmp_path / "empty"), "AWS_CONFIG_FILE": str(tmp_path / "empty")}

    def run(db=None, drop=(), extra=None, catchup=False, endpoint=ENDPOINT):
        vals = {"POSTGRES_DB": db or native_pg.db, "POSTGRES_USER": native_pg.user,
                "POSTGRES_PASSWORD": native_pg.password, "PG_HOST": "127.0.0.1", "PG_PORT": str(native_pg.port),
                "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing", "AWS_REGION": "us-east-1",
                "S3_BUCKET": BUCKET, "S3_PREFIX": "", "AWS_ENDPOINT_URL": endpoint, **(extra or {})}
        for k in drop:
            vals.pop(k, None)
        envf = tmp_path / "backup.env"
        envf.write_text("".join(f"{k}={v}\n" for k, v in vals.items()), encoding="utf-8", newline="\n")
        args = ["-EnvFile", str(envf), "-PgBin", str(native_pg.bin), "-AwsExe", str(AWS_EXE), "-StateDir", str(state)]
        if catchup:
            args.append("-CatchUp")
        return _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                     "-File", SCRIPT, *args], env=base)

    def keys():
        return [o["Key"] for o in moto.list_objects_v2(Bucket=BUCKET).get("Contents", [])]

    return SimpleNamespace(run=run, keys=keys, state=state, marker=state / "last_success", temp=temp, s3=moto)


def out(r):
    return r.stdout + r.stderr


def test_success_uploads_valid_dump(bk, restored_db, native_pg, tmp_path):
    restored_db("bk_ok")
    r = bk.run(db="bk_ok")
    assert r.returncode == 0, out(r)
    ks = bk.keys()
    assert len(ks) == 1 and KEY_RE.match(ks[0]), ks
    assert bk.marker.exists()
    assert f"OK: " in r.stdout and f"-> s3://{BUCKET}/{ks[0]}" in r.stdout
    dl = tmp_path / "dl.dump"
    bk.s3.download_file(BUCKET, ks[0], str(dl))
    lst = _run([native_pg.bin / "pg_restore.exe", "--list", dl])
    assert lst.returncode == 0, lst.stderr
    assert not list(bk.temp.iterdir()), "temp dump left behind"


def test_uploaded_dump_restores_identically(bk, restored_db, native_pg, tmp_path):
    restored_db("bk_src")
    assert bk.run(db="bk_src").returncode == 0
    dl = tmp_path / "dl.dump"
    bk.s3.download_file(BUCKET, bk.keys()[0], str(dl))
    assert psql(native_pg, "postgres", "-c", "drop database if exists bk_back").returncode == 0
    assert psql(native_pg, "postgres", "-c",
                "create database bk_back encoding 'UTF8' lc_collate 'C' lc_ctype 'en-US' template template0").returncode == 0
    restore(native_pg, "bk_back", dl)
    assert fingerprint(native_pg, "bk_back") == fingerprint(native_pg, "bk_src")


def test_upload_failure_leaves_marker_untouched(bk, restored_db):
    restored_db("bk_fail")
    bk.marker.write_text("")
    old = time.time() - 3 * 3600
    os.utime(bk.marker, (old, old))
    r = bk.run(db="bk_fail", endpoint="http://127.0.0.1:1")   # nothing listens there
    assert r.returncode == 1, out(r)
    assert "BACKUP FAILED: upload" in r.stdout, out(r)
    assert abs(bk.marker.stat().st_mtime - old) < 2
    assert not list(bk.temp.iterdir()), "temp dump left behind"
    assert bk.keys() == []


def test_tiny_dump_rejected(bk, native_pg):
    assert psql(native_pg, "postgres", "-c", "drop database if exists bk_empty").returncode == 0
    assert psql(native_pg, "postgres", "-c", "create database bk_empty").returncode == 0
    r = bk.run(db="bk_empty")
    assert r.returncode == 1, out(r)
    assert "BACKUP FAILED: dump is only" in r.stdout, out(r)
    assert not bk.marker.exists() and bk.keys() == []
    assert not list(bk.temp.iterdir())


def test_missing_env_fatal(bk):
    r = bk.run(drop=("S3_BUCKET",))
    assert r.returncode == 1, out(r)
    assert "BACKUP FAILED: missing required environment: S3_BUCKET" in r.stdout, out(r)


def _direct(env_file, state_dir, *extra):
    return _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
                 "-EnvFile", str(env_file), "-PgBin", "C:\\nowhere", "-AwsExe", str(AWS_EXE), "-StateDir", str(state_dir), *extra])


def test_missing_env_file_logs_backup_failed(tmp_path):
    """I2: even a missing env file must end in `BACKUP FAILED: ...` + exit 1 (the task log is the only place anyone looks)."""
    r = _direct(tmp_path / "nope.env", tmp_path / "state")
    assert r.returncode == 1, out(r)
    assert "BACKUP FAILED:" in r.stdout, out(r)


def test_unusable_state_dir_logs_backup_failed(tmp_path):
    blocker = tmp_path / "iamafile"
    blocker.write_text("x")
    envf = tmp_path / "backup.env"
    envf.write_text("".join(f"{k}=v\n" for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET",
                                                  "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB")), encoding="utf-8")
    for extra in ((), ("-CatchUp",)):
        r = _direct(envf, blocker / "state", *extra)
        assert r.returncode == 1, out(r)
        assert "BACKUP FAILED:" in r.stdout, out(r)


def test_concurrent_run_refused(bk, restored_db):
    restored_db("bk_lock")
    with open(bk.state / "lock", "w"):          # an open handle blocks the script's FileShare.None open
        r = bk.run(db="bk_lock")
    assert r.returncode == 1, out(r)
    assert "BACKUP FAILED: another backup is already running" in r.stdout, out(r)
    assert bk.keys() == []


def test_catchup_runs_when_marker_stale(bk, restored_db):
    restored_db("bk_stale")
    bk.marker.write_text("")
    old = time.time() - 25 * 3600
    os.utime(bk.marker, (old, old))
    r = bk.run(db="bk_stale", catchup=True)
    assert r.returncode == 0, out(r)
    assert len(bk.keys()) == 1
    assert bk.marker.stat().st_mtime > time.time() - 120


def test_catchup_skips_when_fresh(bk):
    bk.marker.write_text("")
    recent = time.time() - 3600
    os.utime(bk.marker, (recent, recent))
    r = bk.run(catchup=True)
    assert r.returncode == 0, out(r)
    assert "recent backup present, skipping" in r.stdout
    assert bk.keys() == []
