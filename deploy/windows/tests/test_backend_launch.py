"""Task 5: backend/scheduler launchers (entrypoint.sh + gunicorn replacement). Needs POS_TEST_DUMP."""
import re
import socket
import threading
import time

import pytest
import requests

from conftest import (ADMIN_PASSWORD, ADMIN_USER, WIN, ensure_admin, kill_tree, launch_ps, port_open, running_backend,
                      write_env)

BACKEND = WIN / "backend"
pytestmark = pytest.mark.slow


def _wait_log(p, log, needle, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if needle in log.read_text(encoding="utf-8", errors="replace"):
            return True
        if p.poll() is not None:
            break
        time.sleep(0.5)
    return needle in log.read_text(encoding="utf-8", errors="replace")


def test_backend_starts_and_health_200(native_backend):
    r = requests.get(native_backend + "/api/v1/health", timeout=5)
    assert r.status_code == 200
    assert native_backend.healthy_after < 60, f"took {native_backend.healthy_after:.1f}s to become healthy"


def test_migrations_reported_present(native_backend, pos_root, native_pg, tmp_path):
    # native_backend already applied the pending migrations to app_test; a second boot must find them all present
    with running_backend(pos_root, tmp_path, native_pg.dsn("app_test"), 55001, name="second") as b:
        assert "0 applied, 4 already present" in b.log.read_text(encoding="utf-8", errors="replace")


def test_startup_fails_fast_when_db_unreachable(pos_root, native_pg, tmp_path):
    env = write_env(tmp_path / "bad.env", "postgresql://u:p@127.0.0.1:1/x", port=55001)
    log = tmp_path / "bad.log"
    p = launch_ps(BACKEND / "run-backend.ps1", "-Root", pos_root, "-EnvFile", env, log=log)
    try:
        assert p.wait(timeout=90) != 0
    finally:
        kill_tree(p)
    assert "STARTUP FAILED at init-db" in log.read_text(encoding="utf-8", errors="replace")
    assert not port_open(55001)


def test_health_not_blocked_when_print_agent_blackholed(pos_venv, pos_root, restored_db, tmp_path):
    # accepts connections and never answers
    srv = socket.socket(); srv.bind(("127.0.0.1", 59192)); srv.listen(16)
    accepted, conns = [], []
    def accept():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            conns.append(c); accepted.append(1)
    threading.Thread(target=accept, daemon=True).start()
    dsn = restored_db("app_blackhole")
    ensure_admin(pos_venv, dsn)
    try:
        with running_backend(pos_root, tmp_path, dsn, 55001, "http://127.0.0.1:59192", "bh") as b:
            B = b.url + "/api/v1"
            tok = requests.post(B + "/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD}, timeout=30).json()["access_token"]
            H = {"Authorization": "Bearer " + tok}
            items = requests.get(B + "/menu/items", headers=H, timeout=30).json()
            items = items if isinstance(items, list) else items.get("items", [])
            requests.post(B + "/cash/open", headers=H, json={"opening_fund_cents": 0}, timeout=30)  # 409 if already open
            tid = requests.post(B + "/tickets", headers=H, json={"ticket_type": "EXPRESS"}, timeout=30).json()["id"]
            # only kitchen items fire a chit: add items until the agent socket has been hit
            for it in [i for i in items if i.get("is_active", True) and not i.get("requires_flavor")][:60]:
                requests.post(f"{B}/tickets/{tid}/items", headers=H, json={"menu_item_id": it["id"], "quantity": 1}, timeout=30)
                time.sleep(0.2)
                if accepted:
                    break
            assert accepted, "print agent was never contacted: test did not exercise the blackhole"
            lat = []
            for _ in range(6):
                t0 = time.time(); requests.get(B + "/health", timeout=30); lat.append(time.time() - t0); time.sleep(0.5)
            assert max(lat) < 1.0, lat
    finally:
        srv.close()
        for c in conns:
            c.close()


def test_unicode_output_to_file(pos_root, restored_db, tmp_path):
    dsn = restored_db("app_unicode")
    env = write_env(tmp_path / "u.env", dsn)
    log = tmp_path / "u.log"
    p = launch_ps(BACKEND / "run-flask.ps1", "-Root", pos_root, "-EnvFile", env, "-Command", "init-db", log=log)
    try:
        rc = p.wait(timeout=120)
    finally:
        kill_tree(p)
    assert rc == 0, log.read_text(encoding="utf-8", errors="replace")[-3000:]


def test_scheduler_starts(pos_root, restored_db, tmp_path):
    env = write_env(tmp_path / "s.env", restored_db("app_sched"))
    log = tmp_path / "s.log"
    p = launch_ps(BACKEND / "run-scheduler.ps1", "-Root", pos_root, "-EnvFile", env, log=log)
    try:
        ok = _wait_log(p, log, "Scheduler started", 30)
    finally:
        kill_tree(p)
    assert ok, log.read_text(encoding="utf-8", errors="replace")[-3000:]


def test_daily_report_reaches_smtp(pos_root, restored_db, tmp_path):
    env = write_env(tmp_path / "d.env", restored_db("app_report"))
    log = tmp_path / "d.log"
    p = launch_ps(BACKEND / "run-flask.ps1", "-Root", pos_root, "-EnvFile", env, "-Command", "daily-report", log=log)
    try:
        p.wait(timeout=120)
    finally:
        kill_tree(p)
    out = log.read_text(encoding="utf-8", errors="replace")
    assert "ValueError" not in out, out
    assert re.search(r"ERROR:.*(refused|10061|actively refused|Connection)", out, re.I), out


def test_tz_removed_from_child_environment(pos_root, tmp_path):
    probe = tmp_path / "tzprobe.py"
    probe.write_text("import os\nfrom flask import Flask\napp = Flask('p')\n"
                     "@app.cli.command('tz')\ndef tz():\n    print('TZ=' + os.environ.get('TZ', '<absent>'))\n")
    env = write_env(tmp_path / "t.env", "postgresql://x:x@127.0.0.1:1/x", FLASK_APP=str(probe), TZ="Europe/Madrid")
    log = tmp_path / "t.log"
    # TZ in the parent env AND in the env file: both must be gone before Python starts
    p = launch_ps(BACKEND / "run-flask.ps1", "-Root", pos_root, "-EnvFile", env, "-Command", "tz",
                  log=log, env={"TZ": "America/Mexico_City"})
    try:
        assert p.wait(timeout=60) == 0
    finally:
        kill_tree(p)
    assert "TZ=<absent>" in log.read_text(encoding="utf-8", errors="replace")


def test_missing_venv_python_fails_with_exit_1(tmp_path):
    root = tmp_path / "root"
    (root / "app" / "backend").mkdir(parents=True)
    env = write_env(tmp_path / "m.env", "postgresql://x:x@127.0.0.1:1/x")
    log = tmp_path / "m.log"
    for script in ("run-backend.ps1", "run-scheduler.ps1"):
        p = launch_ps(BACKEND / script, "-Root", root, "-EnvFile", env, log=log)
        try:
            assert p.wait(timeout=60) == 1, script
        finally:
            kill_tree(p)
        assert "STARTUP FAILED at setup: python not found" in log.read_text(encoding="utf-8", errors="replace")
