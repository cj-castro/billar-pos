"""Shared pytest harness for the native-windows tests.

Fixtures (names are binding for later tasks): pg_bin, native_pg, restored_db(name), run_ps(script, *args, env=None),
pos_venv, pos_root, native_backend (base URL str; .healthy_after = seconds to first /health 200).
Run Setup-TestEnv.ps1 first; everything lives under deploy/windows/.native-test/.
"""
import contextlib
import ctypes
import os
import socket
import subprocess
import time
import urllib.request
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



# ---------------------------------------------------------------- Task 5: backend launcher harness
REPO = WIN.parents[1]
BACKEND_PORT = 55000
ADMIN_USER, ADMIN_PASSWORD = "goldy", "SpikeAdmin#1"     # throwaway admin created in the TEST DB only


@pytest.fixture(scope="session")
def pos_venv(run_ps):
    """Pinned backend venv (Task 4 lock), built once and cached under .native-test/posvenv."""
    d = NATIVE_TEST / "posvenv"
    py = d / "Scripts" / "python.exe"
    if not py.exists():
        base = sorted((NATIVE_TEST / "python").glob("cpython-3.11*/python.exe"))
        if not base:
            pytest.skip("run deploy/windows/tests/Setup-TestEnv.ps1 first (uv python 3.11)")
        r = run_ps(str(WIN / "python" / "New-PosVenv.ps1"), "-Python", str(base[0]), "-VenvDir", str(d),
                   "-Lock", str(WIN / "python" / "requirements-backend.lock.txt"))
        assert r.returncode == 0, r.stdout + r.stderr
    return d


def _junction(link: Path, target: Path):
    link.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.fixture(scope="session")
def pos_root(pos_venv, tmp_path_factory):
    """R1 install layout under a temp dir: app\backend and venv are junctions to the worktree / session venv."""
    root = tmp_path_factory.mktemp("posroot")
    _junction(root / "app" / "backend", REPO / "backend")
    _junction(root / "venv", pos_venv)
    (root / "config").mkdir()
    (root / "logs").mkdir()
    return root


def write_env(path: Path, dsn: str, port=BACKEND_PORT, agent="http://127.0.0.1:59191", **extra) -> Path:
    vals = {"SECRET_KEY": "test-secret-not-real", "JWT_REFRESH_SECRET": "test-refresh-not-real",
            "DATABASE_URL": dsn, "PRINT_AGENT_URL": agent, "POS_BIND_PORT": str(port),
            "SMTP_HOST": "127.0.0.1", "SMTP_PORT": "1", "SMTP_USER": "u@example.test", "SMTP_PASSWORD": "x",
            "REPORT_FROM": "u@example.test", "REPORT_TO": "v@example.test",
            "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1", "FLASK_APP": "wsgi.py", **extra}
    path.write_text("".join(f"{k}={v}\n" for k, v in vals.items()), encoding="utf-8", newline="\n")
    return path


def launch_ps(script, *args, log: Path, env=None):
    """Start a powershell wrapper with stdout/stderr to a FILE (never pipes: long-running children would hang a capture)."""
    f = open(log, "wb")
    p = subprocess.Popen(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                          "-File", str(script), *map(str, args)],
                         stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, env={**os.environ, **(env or {})})
    p._logfile = f
    return p


def kill_tree(p):
    if p.poll() is None:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        with contextlib.suppress(Exception):
            p.wait(timeout=15)
    p._logfile.close()


def port_open(port, host="127.0.0.1") -> bool:
    with contextlib.closing(socket.socket()) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def wait_health(port, timeout=60, proc=None) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if proc is not None and proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def ensure_admin(pos_venv, dsn):
    code = (
        "from app import create_app\nfrom app.extensions import db\nfrom app.models.user import User\n"
        "a = create_app()\nwith a.app_context():\n"
        f" u = User.query.filter_by(username='{ADMIN_USER}').first() or User(username='{ADMIN_USER}', name='Test Admin', role='ADMIN')\n"
        f" u.set_password('{ADMIN_PASSWORD}'); u.is_active = True; db.session.add(u); db.session.commit()\n")
    r = _run([pos_venv / "Scripts" / "python.exe", "-c", code], cwd=REPO / "backend",
             env={"DATABASE_URL": dsn, "PYTHONUTF8": "1", "SECRET_KEY": "x"})
    assert r.returncode == 0, r.stderr


@contextlib.contextmanager
def running_backend(pos_root, tmp, dsn, port=BACKEND_PORT, agent="http://127.0.0.1:59191", name="backend"):
    env = write_env(tmp / f"{name}.env", dsn, port, agent)
    log = tmp / f"{name}.log"
    t0 = time.time()
    p = launch_ps(WIN / "backend" / "run-backend.ps1", "-Root", pos_root, "-EnvFile", env, log=log)
    try:
        # wait longer than the 60 s contract so a slow start is diagnosable; the test asserts healthy_after < 60
        assert wait_health(port, 90, p), "backend did not become healthy:\n" + log.read_text(errors="replace")[-3000:]
        yield SimpleNamespace(url=f"http://127.0.0.1:{port}", log=log, proc=p, healthy_after=time.time() - t0)
    finally:
        kill_tree(p)
    assert not port_open(port), f"listener still on {port} after teardown"


class _Url(str):
    healthy_after = None


@pytest.fixture(scope="session")
def native_backend(native_pg, restored_db, pos_venv, pos_root, tmp_path_factory):
    """R2: run-backend.ps1 against restored DB `app_test` on 127.0.0.1:55000 -> base URL. Admin login: ADMIN_USER / ADMIN_PASSWORD.
    PRINT_AGENT_URL comes from env POS_TEST_PRINT_AGENT_URL (default http://127.0.0.1:59191). Process tree killed at teardown."""
    dsn = restored_db("app_test")
    ensure_admin(pos_venv, dsn)
    tmp = tmp_path_factory.mktemp("native_backend")
    agent = os.environ.get("POS_TEST_PRINT_AGENT_URL", "http://127.0.0.1:59191")
    with running_backend(pos_root, tmp, dsn, BACKEND_PORT, agent, "native_backend") as b:
        url = _Url(b.url)
        url.healthy_after = b.healthy_after
        yield url


# ---------------------------------------------------------------- Task 6: nginx front door
WEB_PORT = 59080
SPIKE_DIST = Path(r"E:\cache\temp\claude\9efc318728cdca4e\f7027570-54c7-44ae-8d8a-32fbc1191f79\scratchpad\native-spike\dist")


def _dist_ok(d: Path) -> bool:
    """A usable prod-style build: index.html present and the JS bundle points at /api/v1."""
    js = list((d / "assets").glob("*.js")) if (d / "assets").is_dir() else []
    return (d / "index.html").exists() and any('"/api/v1"' in f.read_text(encoding="utf-8", errors="ignore") for f in js)


@pytest.fixture(scope="session")
def web_dist(tmp_path_factory) -> Path:
    """Frontend build in .native-test/dist. Fast path: copy a verified prior build of this commit; else build from a
    temp COPY of frontend/ (never inside the repo) with the prod build args."""
    import shutil
    dist = NATIVE_TEST / "dist"
    if _dist_ok(dist):
        return dist
    if _dist_ok(SPIKE_DIST):
        shutil.copytree(SPIKE_DIST, dist, dirs_exist_ok=True)
        return dist
    work = tmp_path_factory.mktemp("fe") / "frontend"
    shutil.copytree(REPO / "frontend", work, ignore=shutil.ignore_patterns("node_modules", "dist"))
    env = {"VITE_API_URL": "/api/v1", "VITE_SOCKET_URL": "/"}
    r = _run(["cmd", "/c", "npm", "ci"], cwd=work, env=env)
    assert r.returncode == 0, r.stderr[-2000:]
    r = _run(["cmd", "/c", "npx", "vite", "build", "--outDir", str(dist), "--emptyOutDir"], cwd=work, env=env)
    assert r.returncode == 0, r.stderr[-2000:]
    assert _dist_ok(dist)
    return dist


@pytest.fixture(scope="session")
def native_web(native_backend, web_dist, run_ps, tmp_path_factory):
    """nginx 1.27.5 on 59080 -> backend 55000, config rendered by Convert-NginxSite.ps1. Yields SimpleNamespace(url, prefix, nginx, args)."""
    import shutil
    exe = next((NATIVE_TEST / "nginx").rglob("nginx.exe"), None)
    if exe is None:
        pytest.skip("run deploy/windows/tests/Setup-TestEnv.ps1 first (nginx)")
    prefix = tmp_path_factory.mktemp("nginx")
    (prefix / "conf").mkdir()
    (prefix / "logs").mkdir()
    (prefix / "temp").mkdir()   # nginx on Windows will not create its temp dir; the installer must
    shutil.copy(exe.parent / "conf" / "mime.types", prefix / "conf" / "mime.types")
    r = run_ps(str(WIN / "nginx" / "Convert-NginxSite.ps1"), "-Source", str(REPO / "frontend" / "nginx.conf"),
               "-Out", str(prefix / "conf" / "pos-site.conf"), "-ListenPort", str(WEB_PORT),
               "-BackendPort", str(BACKEND_PORT), "-DistDir", str(web_dist))
    assert r.returncode == 0, r.stdout + r.stderr
    args = [str(exe), "-p", str(prefix), "-c", str(prefix / "conf" / "nginx.conf")]
    t = _run(args + ["-t"])
    assert t.returncode == 0, t.stderr
    out = open(prefix / "logs" / "stdout.txt", "wb")
    p = subprocess.Popen(args, cwd=prefix, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
    end = time.time() + 15
    while time.time() < end and not port_open(WEB_PORT):
        time.sleep(0.2)
    assert port_open(WEB_PORT), (prefix / "logs" / "error.log").read_text(errors="replace")
    yield SimpleNamespace(url=f"http://127.0.0.1:{WEB_PORT}", prefix=prefix, nginx=exe, args=args)
    subprocess.run(args + ["-s", "quit"], capture_output=True)
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
    out.close()
