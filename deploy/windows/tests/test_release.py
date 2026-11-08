"""Task 12: New-NativeRelease.ps1 builds the offline bundle Install-NativePOS.ps1 consumes (ReleaseDir contract, Task 10).

Non-admin (R22): the release builds into tmp from the cached test binaries (no big downloads; the wheelhouse is
really `pip download`ed, so PyPI is needed once), contents match the contract, SHA256SUMS verifies, the wheelhouse
installs OFFLINE (pip --no-index) to a venv equal to the lock, and Install-NativePOS.ps1 -DryRun accepts the release.
Admin: the whole thing installed for real, DB restored from POS_TEST_DUMP, Health-Native green.
  python -m pytest deploy/windows/tests/test_release.py -m admin -v     (elevated)
"""
import hashlib
import os
import subprocess
from pathlib import Path

import pytest
from conftest import NATIVE_TEST, REPO, WIN, _run, wait_health, write_env

NEW_RELEASE = str(WIN / "New-NativeRelease.ps1")
INSTALL = str(WIN / "Install-NativePOS.ps1")
UNINSTALL = str(WIN / "Uninstall-NativePOS.ps1")
HEALTH = str(WIN / "Health-Native.ps1")
LOCK = WIN / "python" / "requirements-backend.lock.txt"
PFX = "BilliardsPOS-Rel"


@pytest.fixture(scope="module")
def release(run_ps, tmp_path_factory):
    py = sorted((NATIVE_TEST / "python").glob("cpython-3.11*"))
    need = [NATIVE_TEST / "pgsql", NATIVE_TEST / "nginx", NATIVE_TEST / "bin" / "nssm.exe",
            NATIVE_TEST / "dl" / "AWSCLIV2.msi", NATIVE_TEST / "dist" / "index.html"]
    if not py or any(not p.exists() for p in need):
        pytest.skip("run deploy/windows/tests/Setup-TestEnv.ps1 first")
    out = tmp_path_factory.mktemp("rel") / "release"
    r = run_ps(NEW_RELEASE, "-OutDir", str(out), "-DistDir", str(NATIVE_TEST / "dist"),
               "-PgDir", str(NATIVE_TEST / "pgsql"), "-NginxDir", str(NATIVE_TEST / "nginx"),
               "-PythonDir", str(py[0]), "-NssmExe", str(NATIVE_TEST / "bin" / "nssm.exe"),
               "-AwsMsi", str(NATIVE_TEST / "dl" / "AWSCLIV2.msi"))
    assert r.returncode == 0, r.stdout + r.stderr
    return out


# ------------------------------------------------------------ contract (R22 a, b)
CONTRACT = ["app/backend/wsgi.py", "app/dist/index.html", "app/frontend-nginx.conf",
            "bin/pgsql/bin/pg_ctl.exe", "bin/pgsql/bin/postgres.exe", "bin/nginx/nginx.exe", "bin/nginx/conf/mime.types",
            "bin/python/python.exe", "bin/nssm.exe", "bin/AWSCLIV2.msi",
            "deploy/Install-NativePOS.ps1", "deploy/PosCommon.psm1", "deploy/backend/run-backend.ps1",
            "deploy/python/requirements-backend.lock.txt", "deploy/python/New-PosVenv.ps1",
            "deploy/backup/Restore-Native.ps1", "deploy/Health-Native.ps1", "deploy/README.md", "SHA256SUMS.txt"]


@pytest.mark.parametrize("rel_path", CONTRACT)
def test_contract_file_present(release, rel_path):
    assert (release / rel_path).is_file(), rel_path


def test_wheelhouse_has_wheels_for_every_pin(release):
    names = {p.name.split("-")[0].lower().replace("_", "-") for p in (release / "wheelhouse").glob("*.whl")}
    pins = {l.split("==")[0].strip().lower().replace("_", "-") for l in LOCK.read_text().splitlines()
            if "==" in l and not l.startswith("#")}
    assert pins <= names, sorted(pins - names)


def test_deploy_has_no_tests_and_pgadmin_pruned(release):
    assert not (release / "deploy/tests").exists() and not (release / "deploy/.native-test").exists()
    assert not (release / "bin/pgsql/pgAdmin 4").exists(), "pgAdmin should be pruned from the bundle"


def test_nginx_conf_is_production_frontend_conf(release):
    got = (release / "app/frontend-nginx.conf").read_bytes().replace(b"\r\n", b"\n")
    want = (REPO / "frontend" / "nginx.conf").read_bytes().replace(b"\r\n", b"\n")
    assert got == want


# ------------------------------------------------------------ SHA256SUMS (R22 c)
def test_sha256sums_verify_every_file(release):
    listed = {}
    for l in (release / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        h, _, name = l.partition("  ")
        listed[name] = h
    files = {p.relative_to(release).as_posix() for p in release.rglob("*") if p.is_file()} - {"SHA256SUMS.txt"}
    assert set(listed) == files
    for name in sorted(files):
        h = hashlib.sha256()
        with open(release / name, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        assert h.hexdigest() == listed[name], name


def test_verifydir_detects_tamper(release, run_ps):
    assert run_ps(NEW_RELEASE, "-VerifyDir", str(release)).returncode == 0
    t = release / "deploy" / "README.md"
    orig = t.read_bytes()
    try:
        t.write_bytes(orig + b"x")
        assert run_ps(NEW_RELEASE, "-VerifyDir", str(release)).returncode != 0
    finally:
        t.write_bytes(orig)


# ------------------------------------------------------------ offline wheelhouse (R22 d)
def test_wheelhouse_installs_offline_and_freeze_equals_lock(release, run_ps, tmp_path):
    venv = tmp_path / "venv"
    # New-PosVenv -Wheelhouse = pip install --no-index --find-links; the dead index below proves nothing touches the net
    dead = {"PIP_INDEX_URL": "http://127.0.0.1:9/simple", "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9"}
    r = run_ps(str(release / "deploy/python/New-PosVenv.ps1"), "-Python", str(release / "bin/python/python.exe"),
               "-VenvDir", str(venv), "-Lock", str(release / "deploy/python/requirements-backend.lock.txt"),
               "-Wheelhouse", str(release / "wheelhouse"), env=dead)
    assert r.returncode == 0, r.stdout + r.stderr
    fr = subprocess.run([str(venv / "Scripts/python.exe"), "-m", "pip", "freeze"], capture_output=True, text=True)
    norm = lambda ls: sorted(l.strip().lower().replace("_", "-") for l in ls if l.strip())
    assert norm(fr.stdout.splitlines()) == norm(LOCK.read_text().splitlines())


# ------------------------------------------------------------ installer accepts the release (R22 e)
def _envs(base: Path, pgp: int, bep: int) -> Path:
    envs = base / "envs"
    envs.mkdir()
    dsn = f"postgresql://billiard:test_pw_not_secret@127.0.0.1:{pgp}/billiardbar"
    write_env(envs / "backend.env", dsn, bep)
    write_env(envs / "scheduler.env", dsn, bep)
    (envs / "backup.env").write_text("POSTGRES_USER=billiard\nPOSTGRES_PASSWORD=test_pw_not_secret\nPOSTGRES_DB=billiardbar\n"
                                     f"PG_HOST=127.0.0.1\nPG_PORT={pgp}\n", encoding="utf-8")
    return envs


def test_install_dryrun_against_built_release(release, run_ps, tmp_path):
    root = tmp_path / "root"
    r = run_ps(INSTALL, "-DryRun", "-ReleaseDir", str(release), "-EnvDir", str(_envs(tmp_path, 5433, 5000)),
               "-Root", str(root), "-Prefix", PFX)
    assert r.returncode == 0, r.stdout + r.stderr
    plan = [l for l in r.stdout.splitlines() if l.startswith("PLAN: ")]
    assert any("New-PosVenv" in l and "wheelhouse" in l.lower() for l in plan), "wheelhouse not used by the venv step"
    assert not root.exists()


# ------------------------------------------------------------ admin: full offline install
@pytest.mark.admin
def test_release_installs_offline(release, run_ps, tmp_path):
    """Install the built release (prefix BilliardsPOS-Rel, own root/ports), restore POS_TEST_DUMP, Health exit 0."""
    dump = os.environ.get("POS_TEST_DUMP")
    if not dump or not Path(dump).exists():
        pytest.skip("POS_TEST_DUMP not set (or file missing)")
    root = NATIVE_TEST / "root-rel"
    pgp, bep, wep = 55434, 55002, 59082
    envs = _envs(tmp_path, pgp, bep)
    dead = {"PIP_INDEX_URL": "http://127.0.0.1:9/simple", "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9"}
    run_ps(UNINSTALL, "-Prefix", PFX)
    try:
        r = run_ps(INSTALL, "-ReleaseDir", str(release), "-EnvDir", str(envs), "-Root", str(root), "-Prefix", PFX,
                   "-WebPort", str(wep), "-PgPort", str(pgp), "-BackendPort", str(bep), env=dead)
        assert r.returncode == 0, r.stdout + r.stderr
        pgbin = root / "bin" / "pgsql" / "bin"
        r = run_ps(str(WIN / "backup" / "Restore-Native.ps1"), "-EnvFile", str(envs / "backup.env"), "-PgBin", str(pgbin),
                   "-DumpFile", dump, "-OutDir", str(root / "backups"), "-Prefix", PFX, "-Force")
        assert r.returncode == 0, r.stdout + r.stderr
        r = _run(["powershell.exe", "-NoProfile", "-Command",
                  f"Start-Service '{PFX}-Backend','{PFX}-Scheduler','{PFX}-Web'"])
        assert r.returncode == 0, r.stderr
        assert wait_health(wep, 90), "web -> backend health never 200 after restore"
        (root / "state").mkdir(exist_ok=True)
        (root / "state" / "last_success").write_text("")
        r = run_ps(HEALTH, "-Prefix", PFX, "-WebPort", str(wep), "-StateDir", str(root / "state"))
        assert r.returncode == 0, r.stdout + r.stderr
    finally:
        run_ps(UNINSTALL, "-Prefix", PFX)
