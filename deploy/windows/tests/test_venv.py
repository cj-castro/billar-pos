"""Task 4: pinned backend venv. The venv is built once per session (slow install)."""
import os
import subprocess
from pathlib import Path

import pytest

WIN = Path(__file__).resolve().parents[1]
REPO = WIN.parents[1]
LOCK = WIN / "python" / "requirements-backend.lock.txt"
SCRIPT = WIN / "python" / "New-PosVenv.ps1"


def _base_python() -> Path:
    found = sorted((WIN / ".native-test" / "python").glob("cpython-3.11*/python.exe"))
    if not found:
        pytest.skip("run deploy/windows/tests/Setup-TestEnv.ps1 first (uv python 3.11)")
    return found[0]


@pytest.fixture(scope="session")
def venv(run_ps, tmp_path_factory):
    d = tmp_path_factory.mktemp("posvenv") / "venv"
    r = run_ps(str(SCRIPT), "-Python", str(_base_python()), "-VenvDir", str(d), "-Lock", str(LOCK))
    assert r.returncode == 0, r.stdout + r.stderr
    return d / "Scripts" / "python.exe"


def _py(venv, *args, **kw):
    env = {**os.environ, "PYTHONUTF8": "1", **kw.pop("env", {})}
    return subprocess.run([str(venv), *args], capture_output=True, text=True, encoding="utf-8", env=env, **kw)


def _norm(lines):
    return sorted(l.strip().lower().replace("_", "-") for l in lines if l.strip())


def test_freeze_matches_lock(venv):
    r = _py(venv, "-m", "pip", "freeze")
    assert r.returncode == 0, r.stderr
    assert _norm(r.stdout.splitlines()) == _norm(LOCK.read_text().splitlines())


def test_pip_check_clean(venv):
    r = _py(venv, "-m", "pip", "check")
    assert r.returncode == 0, r.stdout + r.stderr


def test_zoneinfo_mexico(venv):
    r = _py(venv, "-c", "from zoneinfo import ZoneInfo; ZoneInfo('America/Mexico_City')")
    assert r.returncode == 0, r.stderr


def test_create_app_imports(venv):
    r = _py(venv, "-c", "from app import create_app", cwd=REPO / "backend",
            env={"DATABASE_URL": "postgresql://x:x@127.0.0.1:1/x"})
    assert r.returncode == 0, r.stderr
