"""Task 10: Install-NativePOS / Uninstall-NativePOS / Health-Native.

Three groups:
  * -DryRun plan tests (R18): non-admin, no service/task is ever created. They assert the exact PLAN lines.
  * Health-Native tests: non-admin, against a tiny fake HTTP server (+ nonexistent services for the FAIL path).
  * Real service tests (marked admin, auto-skipped unless elevated): prefix BilliardsPOS-Test, root .native-test\\root,
    ports 55433 / 55001 / 59081 (distinct from the 55432/55000/59080 session fixtures).
Run the admin ones from an ELEVATED shell:  python -m pytest deploy/windows/tests/test_services.py -m admin -v
"""
import http.server
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest
from conftest import NATIVE_TEST, REPO, WIN, _run, port_open, wait_health

INSTALL = str(WIN / "Install-NativePOS.ps1")
UNINSTALL = str(WIN / "Uninstall-NativePOS.ps1")
HEALTH = str(WIN / "Health-Native.ps1")
SVC_SUFFIXES = ("Postgres", "Backend", "Scheduler", "Web")
TASK_SUFFIXES = ("S3Backup", "S3Backup-Catchup", "LocalBackup", "DailyReport")


# ---------------------------------------------------------------- helpers
def make_release(base: Path) -> Path:
    """Minimal fake ReleaseDir (empty placeholder files): enough for -DryRun's existence checks."""
    rel = base / "release"
    for f in ("bin/nssm.exe", "bin/pgsql/bin/pg_ctl.exe", "bin/nginx/nginx.exe", "bin/nginx/conf/mime.types",
              "bin/python/python.exe", "bin/AWSCLIV2.msi", "app/frontend-nginx.conf", "app/dist/index.html",
              "app/backend/wsgi.py", "deploy/backend/run-backend.ps1", "deploy/python/requirements-backend.lock.txt"):
        p = rel / f
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"")
    (rel / "wheelhouse").mkdir()
    return rel


def make_envdir(base: Path, pg_port=5433) -> Path:
    d = base / "envs"
    d.mkdir()
    common = f"DATABASE_URL=postgresql://billiard:pw@127.0.0.1:{pg_port}/billiardbar\n"
    (d / "backend.env").write_text(common, encoding="utf-8")
    (d / "scheduler.env").write_text(common, encoding="utf-8")
    (d / "backup.env").write_text("POSTGRES_USER=billiard\nPOSTGRES_PASSWORD=pw_not_secret\nPOSTGRES_DB=billiardbar\n"
                                  f"PG_HOST=127.0.0.1\nPG_PORT={pg_port}\n", encoding="utf-8")
    return d


def plan_lines(r):
    assert r.returncode == 0, r.stdout + r.stderr
    return [l[len("PLAN: "):] for l in r.stdout.splitlines() if l.startswith("PLAN: ")]


def install_plan(run_ps, tmp_path, *extra, prefix="BilliardsPOS-Test", root=None, startup="Automatic"):
    root = root or str(tmp_path / "root")
    r = run_ps(INSTALL, "-DryRun", "-ReleaseDir", str(make_release(tmp_path)), "-EnvDir", str(make_envdir(tmp_path)),
               "-Root", root, "-Prefix", prefix, "-WebPort", "8081", "-PgPort", "5434", "-BackendPort", "5001",
               "-StartupType", startup, *extra)
    return plan_lines(r), root


def has(lines, *tokens):
    """First plan line containing all tokens as whole space-separated words, in order."""
    for l in lines:
        words = l.split(" ")
        try:
            i = -1
            for t in tokens:
                i = words.index(t, i + 1)
            return l
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------- R18: install -DryRun
def test_dryrun_needs_no_elevation_and_creates_nothing(run_ps, tmp_path):
    lines, root = install_plan(run_ps, tmp_path)
    assert lines
    assert not Path(root).exists(), "-DryRun must not create the install root"


def test_dryrun_service_dependencies(run_ps, tmp_path):
    p = "BilliardsPOS-Test"
    lines, _ = install_plan(run_ps, tmp_path)
    assert has(lines, "nssm", "set", f"{p}-Backend", "DependOnService", f"{p}-Postgres")
    assert has(lines, "nssm", "set", f"{p}-Scheduler", "DependOnService", f"{p}-Postgres")
    assert has(lines, "nssm", "set", f"{p}-Web", "DependOnService", f"{p}-Backend")
    assert not has(lines, "nssm", "set", f"{p}-Postgres", "DependOnService")


@pytest.mark.parametrize("svc", ["Backend", "Scheduler", "Web"])
def test_dryrun_nssm_service_settings(run_ps, tmp_path, svc):
    p = "BilliardsPOS-Test"
    lines, root = install_plan(run_ps, tmp_path)
    n = f"{p}-{svc}"
    log = f"{root}\\logs\\{n}.log"
    assert has(lines, "nssm", "install", n)
    for key, val in (("AppExit", "Default Restart"), ("AppRestartDelay", "5000"), ("AppRotateFiles", "1"),
                     ("AppRotateBytes", "10485760"), ("AppKillProcessTree", "1"), ("ObjectName", "LocalSystem"),
                     ("Start", "SERVICE_AUTO_START")):
        assert has(lines, "nssm", "set", n, key, *val.split(" ")), f"{n}: {key} {val}"
    assert has(lines, "nssm", "set", n, "AppStdout", log)
    assert has(lines, "nssm", "set", n, "AppStderr", log)
    assert has(lines, "sc", "failure", n, "reset=", "86400", "actions=", "restart/5000/restart/5000/restart/30000")


def test_dryrun_nssm_commands(run_ps, tmp_path):
    p = "BilliardsPOS-Test"
    lines, root = install_plan(run_ps, tmp_path)
    be = has(lines, "nssm", "set", f"{p}-Backend", "AppParameters")
    assert "run-backend.ps1" in be and f"{root}\\config\\backend.env" in be and "-ExecutionPolicy Bypass" in be
    sc = has(lines, "nssm", "set", f"{p}-Scheduler", "AppParameters")
    assert "run-scheduler.ps1" in sc and "scheduler.env" in sc
    assert has(lines, "nssm", "set", f"{p}-Backend", "AppEnvironmentExtra", "POS_BIND_PORT=5001")
    web = has(lines, "nssm", "set", f"{p}-Web", "AppParameters")
    assert f"{root}\\web" in web and "conf\\nginx.conf" in web
    assert has(lines, "nssm", "set", f"{p}-Web", "AppDirectory", f"{root}\\web")


def test_dryrun_postgres_service(run_ps, tmp_path):
    p = "BilliardsPOS-Test"
    lines, root = install_plan(run_ps, tmp_path)
    reg = has(lines, "pg_ctl", "register", "-N", f"{p}-Postgres")
    assert reg and has([reg], "-S", "auto") and has([reg], "-D", f"{root}\\pgdata")
    assert '"-p 5434"' in reg                                    # -o "-p <PgPort>"
    assert has([reg], "-U", '"NT', "AUTHORITY\\NetworkService\"") or "NetworkService" in reg
    assert has(lines, "sc", "failure", f"{p}-Postgres", "reset=", "86400", "actions=",
               "restart/5000/restart/5000/restart/30000")
    ini = [l for l in lines if "Initialize-PosCluster.ps1" in l]
    assert ini and "-Port 5434" in ini[0] and "pw_not_secret" not in ini[0], "password must not be printed"
    assert lines.index(ini[0]) < lines.index(reg), "cluster is initialised before it is registered"
    assert any("icacls" in l and "pgdata" in l and "S-1-5-20" in l for l in lines)   # NetworkService can write pgdata


def test_dryrun_startup_type_manual(run_ps, tmp_path):
    p = "BilliardsPOS-Test"
    lines, _ = install_plan(run_ps, tmp_path, startup="Manual")
    assert has(lines, "pg_ctl", "register", "-S", "demand")
    for svc in ("Backend", "Scheduler", "Web"):
        assert has(lines, "nssm", "set", f"{p}-{svc}", "Start", "SERVICE_DEMAND_START")
        assert not has(lines, "nssm", "set", f"{p}-{svc}", "Start", "SERVICE_AUTO_START")


def test_dryrun_scheduled_tasks(run_ps, tmp_path):
    p = "BilliardsPOS-Test"
    lines, root = install_plan(run_ps, tmp_path)
    tasks = {re.search(r"-TaskName (\S+)", l).group(1): l for l in lines if l.startswith("Register-ScheduledTask")}
    assert set(tasks) == {f"{p}-S3Backup", f"{p}-S3Backup-Catchup", f"{p}-LocalBackup"}   # no DailyReport by default
    for name, l in tasks.items():
        assert "-User SYSTEM" in l and "-StartWhenAvailable" in l and "-RunLevel Highest" in l, name
    s3 = tasks[f"{p}-S3Backup"]
    assert "-Trigger Daily@02:00" in s3 and "backup-s3.ps1" in s3 and "-CatchUp" not in s3
    assert "-StateDir" in s3 and f"{root}\\state" in s3 and "AWSCLIV2\\aws.exe" in s3
    cu = tasks[f"{p}-S3Backup-Catchup"]
    assert "AtStartup" in cu and "backup-s3.ps1" in cu and "-CatchUp" in cu
    lb = tasks[f"{p}-LocalBackup"]
    assert "-Trigger Daily@03:00" in lb and "Backup-Native.ps1" in lb and "-KeepDays 30" in lb
    assert f"{root}\\backups" in lb


def test_dryrun_daily_report_only_when_asked(run_ps, tmp_path):
    p = "BilliardsPOS-Test"
    lines, _ = install_plan(run_ps, tmp_path, "-DailyReportTask")
    dr = [l for l in lines if l.startswith("Register-ScheduledTask") and f"{p}-DailyReport" in l]
    assert len(dr) == 1
    assert "-Trigger Daily@08:00" in dr[0] and "run-flask.ps1" in dr[0] and "-Command daily-report" in dr[0]


def test_dryrun_skiptasks(run_ps, tmp_path):
    lines, _ = install_plan(run_ps, tmp_path, "-SkipTasks", "-DailyReportTask")
    assert not any("ScheduledTask" in l for l in lines)


def test_dryrun_nginx_runtime_prefix(run_ps, tmp_path):
    """R14: <Root>\\web holds conf (nginx.conf + pos-site.conf + mime.types), temp, logs."""
    lines, root = install_plan(run_ps, tmp_path)
    blob = "\n".join(lines)
    for sub in ("web\\conf", "web\\temp", "web\\logs"):
        assert f"{root}\\{sub}" in blob, sub
    cv = [l for l in lines if "Convert-NginxSite.ps1" in l][0]
    assert f"-Out {root}\\web\\conf\\pos-site.conf" in cv and "-ListenPort 8081" in cv and "-BackendPort 5001" in cv
    assert f"-DistDir {root}\\app\\dist" in cv
    assert "mime.types" in blob


def test_dryrun_all_actions_target_only_prefix_names(run_ps, tmp_path):
    """Nothing but <Prefix>-<known suffix> is ever touched (a prefix that is itself a prefix of another install, e.g.
    BilliardsPOS vs BilliardsPOS-Test, must not leak)."""
    for prefix in ("BilliardsPOS-Test", "BilliardsPOS"):
        sub = tmp_path / prefix
        sub.mkdir()
        lines, _ = install_plan(run_ps, sub, "-DailyReportTask", prefix=prefix)
        allowed = {f"{prefix}-{s}" for s in SVC_SUFFIXES + TASK_SUFFIXES}
        seen = set()
        for l in lines:
            w = l.split(" ")
            if w[0] == "nssm" and len(w) > 2:
                seen.add(w[2])
            elif w[0] == "sc" and len(w) > 2:
                seen.add(w[2])
            elif w[0] == "pg_ctl" and w[1] == "register":
                seen.add(w[w.index("-N") + 1])
            elif w[0].endswith("ScheduledTask") and "-TaskName" in w:
                seen.add(w[w.index("-TaskName") + 1])
        assert seen and seen <= allowed, seen - allowed
        assert {f"{prefix}-{s}" for s in SVC_SUFFIXES} <= seen


def test_dryrun_missing_release_part_fails(run_ps, tmp_path):
    rel = make_release(tmp_path)
    (rel / "bin" / "nssm.exe").unlink()
    r = run_ps(INSTALL, "-DryRun", "-ReleaseDir", str(rel), "-EnvDir", str(make_envdir(tmp_path)),
               "-Root", str(tmp_path / "root"))
    assert r.returncode != 0 and "nssm.exe" in (r.stdout + r.stderr)


# ---------------------------------------------------------------- R18: uninstall -DryRun
def uninstall_plan(run_ps, *extra, prefix="BilliardsPOS-Test"):
    return plan_lines(run_ps(UNINSTALL, "-DryRun", "-Prefix", prefix, *extra))


def test_uninstall_dryrun_removes_prefix_items_only(run_ps):
    p = "BilliardsPOS-Test"
    lines = uninstall_plan(run_ps)
    for s in SVC_SUFFIXES:
        assert has(lines, "sc", "stop", f"{p}-{s}")
        assert has(lines, "sc", "delete", f"{p}-{s}")
    for t in TASK_SUFFIXES:
        assert any(l.startswith("Unregister-ScheduledTask") and f"-TaskName {p}-{t} " in l + " " for l in lines), t
    names = set()
    for l in lines:
        w = l.split(" ")
        names.add(w[w.index("-TaskName") + 1] if "-TaskName" in w else w[2])
    assert names == {f"{p}-{s}" for s in SVC_SUFFIXES + TASK_SUFFIXES}
    assert not any(re.search(r"pgdata|backups|Remove-Item|rd |rmdir|del ", l) for l in lines), "data must be kept"
    # stop order: Web before Backend before Postgres
    stops = [l.split(" ")[2] for l in lines if l.startswith("sc stop")]
    assert stops.index(f"{p}-Web") < stops.index(f"{p}-Backend") < stops.index(f"{p}-Postgres")


def test_uninstall_stoponly_dryrun_disables(run_ps):
    p = "BilliardsPOS-Test"
    lines = uninstall_plan(run_ps, "-StopOnly")
    for s in SVC_SUFFIXES:
        assert has(lines, "sc", "stop", f"{p}-{s}")
        assert has(lines, "sc", "config", f"{p}-{s}", "start=", "disabled")
    assert not any(l.startswith("sc delete") or "Unregister-ScheduledTask" in l for l in lines)
    assert any(l.startswith("Disable-ScheduledTask") and f"{p}-LocalBackup" in l for l in lines)


# ---------------------------------------------------------------- Health-Native (non-admin)
class _H(http.server.BaseHTTPRequestHandler):
    status = 200

    def do_GET(self):
        ok = self.path == "/api/v1/health"
        self.send_response(self.status if ok else 404)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


@pytest.fixture()
def fake_web():
    srv = http.server.HTTPServer(("127.0.0.1", 0), type("H", (_H,), {"status": 200}))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv
    srv.shutdown()


def health(run_ps, port, state, *extra, prefix="BilliardsPOS-NoSuch"):
    return run_ps(HEALTH, "-Prefix", prefix, "-WebPort", str(port), "-StateDir", str(state), *extra)


def fresh_state(tmp_path, age_hours=0):
    st = tmp_path / "state"
    st.mkdir()
    m = st / "last_success"
    m.write_text("")
    t = time.time() - age_hours * 3600
    import os
    os.utime(m, (t, t))
    return st


def test_health_missing_services_fail(run_ps, fake_web, tmp_path):
    r = health(run_ps, fake_web.server_port, fresh_state(tmp_path))
    assert r.returncode != 0
    for s in SVC_SUFFIXES:
        assert re.search(rf"FAIL.*BilliardsPOS-NoSuch-{s}", r.stdout), r.stdout
    assert re.search(r"OK.*health", r.stdout, re.I) and re.search(r"OK.*last_success", r.stdout, re.I), r.stdout


def test_health_all_non_service_checks_pass(run_ps, fake_web, tmp_path):
    r = health(run_ps, fake_web.server_port, fresh_state(tmp_path), "-SkipServices", "-MinFreeGB", "1")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "FAIL" not in r.stdout and len([l for l in r.stdout.splitlines() if l.strip()]) >= 3


def test_health_stale_or_missing_marker_fails(run_ps, fake_web, tmp_path):
    r = health(run_ps, fake_web.server_port, fresh_state(tmp_path, age_hours=27), "-SkipServices", "-MinFreeGB", "1")
    assert r.returncode != 0 and re.search(r"FAIL.*last_success", r.stdout), r.stdout
    empty = tmp_path / "empty"
    empty.mkdir()
    r = health(run_ps, fake_web.server_port, empty, "-SkipServices", "-MinFreeGB", "1")
    assert r.returncode != 0 and re.search(r"FAIL.*last_success", r.stdout), r.stdout


def test_health_web_down_or_500_fails(run_ps, fake_web, tmp_path):
    st = fresh_state(tmp_path)
    fake_web.RequestHandlerClass.status = 500
    r = health(run_ps, fake_web.server_port, st, "-SkipServices", "-MinFreeGB", "1")
    assert r.returncode != 0 and re.search(r"FAIL.*health", r.stdout, re.I), r.stdout
    fake_web.RequestHandlerClass.status = 200
    r = health(run_ps, 1, st, "-SkipServices", "-MinFreeGB", "1")        # nothing listens on port 1
    assert r.returncode != 0 and re.search(r"FAIL.*health", r.stdout, re.I), r.stdout


def test_health_low_disk_fails(run_ps, fake_web, tmp_path):
    r = health(run_ps, fake_web.server_port, fresh_state(tmp_path), "-SkipServices", "-MinFreeGB", "100000")
    assert r.returncode != 0 and re.search(r"FAIL.*disk", r.stdout, re.I), r.stdout


# ---------------------------------------------------------------- real services (elevated shell only)
PFX = "BilliardsPOS-Test"
PGP, BEP, WEP = 55433, 55001, 59081
ROOT = NATIVE_TEST / "root"


def ps(cmd):
    r = _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd])
    return r.stdout.strip()


def sc_qc(name):
    out = _run(["sc.exe", "qc", name]).stdout
    start = re.search(r"START_TYPE\s*:\s*\d+\s+(\S+)", out)
    acct = re.search(r"SERVICE_START_NAME\s*:\s*(.+)", out)
    return (start.group(1) if start else None), (acct.group(1).strip() if acct else None)


def svc_state(name):
    return ps(f"(Get-Service -Name '{name}' -ErrorAction SilentlyContinue).Status")


def all_services():
    out = ps("Get-CimInstance Win32_Service | ForEach-Object { \"$($_.Name)|$($_.State)|$($_.StartMode)\" }")
    return {l.split("|")[0]: l.split("|")[1:] for l in out.splitlines() if l.strip()}


def python_children():
    out = ps("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*serve_windows.py*' } | "
             "ForEach-Object { $_.ProcessId }")
    return [int(x) for x in out.split()]


@pytest.fixture(scope="module")
def stack(run_ps, web_dist, tmp_path_factory):
    tmp = tmp_path_factory.mktemp("svc")
    rel = tmp / "release"
    envs = tmp / "envs"
    envs.mkdir()
    # release layout (see Install-NativePOS.ps1 header): directories are junctions to the prepared test environment
    def junction(link, target):
        link.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, text=True)
        assert r.returncode == 0, r.stdout + r.stderr
    py = sorted((NATIVE_TEST / "python").glob("cpython-3.11*"))
    if not py or not (NATIVE_TEST / "bin" / "nssm.exe").exists():
        pytest.skip("run deploy/windows/tests/Setup-TestEnv.ps1 first")
    junction(rel / "app" / "backend", REPO / "backend")
    junction(rel / "app" / "dist", web_dist)
    junction(rel / "deploy", WIN)
    junction(rel / "bin" / "pgsql", NATIVE_TEST / "pgsql")
    junction(rel / "bin" / "nginx", NATIVE_TEST / "nginx")
    junction(rel / "bin" / "python", py[0])
    junction(rel / "bin" / "aws", NATIVE_TEST / "bin" / "aws")          # prebuilt: installer skips the msi
    shutil.copy(NATIVE_TEST / "bin" / "nssm.exe", rel / "bin" / "nssm.exe")
    shutil.copy(REPO / "frontend" / "nginx.conf", rel / "app" / "frontend-nginx.conf")
    dsn = f"postgresql://billiard:test_pw_not_secret@127.0.0.1:{PGP}/billiardbar"
    from conftest import write_env
    write_env(envs / "backend.env", dsn, BEP)
    write_env(envs / "scheduler.env", dsn, BEP)
    (envs / "backup.env").write_text(
        "POSTGRES_USER=billiard\nPOSTGRES_PASSWORD=test_pw_not_secret\nPOSTGRES_DB=billiardbar\n"
        f"PG_HOST=127.0.0.1\nPG_PORT={PGP}\n", encoding="utf-8")

    def install(startup="Automatic"):
        return run_ps(INSTALL, "-ReleaseDir", str(rel), "-EnvDir", str(envs), "-Root", str(ROOT), "-Prefix", PFX,
                      "-WebPort", str(WEP), "-PgPort", str(PGP), "-BackendPort", str(BEP), "-StartupType", startup)

    def uninstall(*extra):
        return run_ps(UNINSTALL, "-Prefix", PFX, *extra)

    before = all_services()
    uninstall()                                 # leftovers of an aborted run
    r = install()
    assert r.returncode == 0, r.stdout + r.stderr
    from types import SimpleNamespace
    yield SimpleNamespace(install=install, uninstall=uninstall, before=before, root=ROOT)
    uninstall()


@pytest.mark.admin
def test_install_starts_all_services_and_health_green(stack, run_ps):
    for s in SVC_SUFFIXES:
        assert svc_state(f"{PFX}-{s}") == "Running", s
    assert wait_health(WEP, 90), "web -> backend health never 200"
    # the S3 marker is normally written by the 02:00 task; create it so the 26 h check can pass
    (ROOT / "state").mkdir(exist_ok=True)
    (ROOT / "state" / "last_success").write_text("")
    r = run_ps(HEALTH, "-Prefix", PFX, "-WebPort", str(WEP), "-StateDir", str(ROOT / "state"))
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.admin
def test_backend_restarts_after_kill(stack):
    pids = python_children()
    assert pids, "no backend python process"
    for pid in pids:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
    time.sleep(2)
    assert wait_health(BEP, 30), "backend did not come back within 30 s"


@pytest.mark.admin
def test_backend_recovers_after_postgres_restart(stack):
    r = _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
              f"Restart-Service -Name '{PFX}-Postgres' -Force"])
    assert r.returncode == 0, r.stderr
    assert wait_health(BEP, 60), "backend not serving 60 s after postgres restart"


@pytest.mark.admin
def test_services_survive_without_logon_settings(stack):
    for s in SVC_SUFFIXES:
        start, acct = sc_qc(f"{PFX}-{s}")
        assert start == "AUTO_START", (s, start)
        assert acct and acct.lower() in ("localsystem", "nt authority\\networkservice"), (s, acct)
    for s in ("Backend", "Scheduler", "Web"):
        assert sc_qc(f"{PFX}-{s}")[1].lower() == "localsystem"


@pytest.mark.admin
def test_install_is_idempotent(stack):
    r = stack.install()
    assert r.returncode == 0, r.stdout + r.stderr
    assert wait_health(WEP, 90)
    mine = [n for n in all_services() if n.startswith(PFX + "-")]
    assert sorted(mine) == sorted(f"{PFX}-{s}" for s in SVC_SUFFIXES)
    tasks = ps(f"(Get-ScheduledTask | Where-Object TaskName -like '{PFX}-*').TaskName").split()
    assert sorted(tasks) == sorted(f"{PFX}-{t}" for t in ("S3Backup", "S3Backup-Catchup", "LocalBackup"))
    # manual startup type is honoured on re-install, then restore automatic
    r = stack.install("Manual")
    assert r.returncode == 0, r.stdout + r.stderr
    assert all(sc_qc(f"{PFX}-{s}")[0] == "DEMAND_START" for s in SVC_SUFFIXES)
    r = stack.install("Automatic")
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.admin
def test_does_not_touch_foreign_services(stack):
    now = all_services()
    foreign_before = {n: v for n, v in stack.before.items() if not n.startswith(PFX + "-")}
    for n, (state, mode) in foreign_before.items():
        assert n in now, f"foreign service {n} disappeared"
        assert now[n][1] == mode, f"{n} start mode changed"
        if state == "Running":
            assert now[n][0] == "Running", f"{n} stopped"
    assert set(now) - set(stack.before) <= {n for n in now if n.startswith(PFX + "-")}


@pytest.mark.admin
def test_uninstall_stoponly_keeps_data(stack):
    r = stack.uninstall("-StopOnly")
    assert r.returncode == 0, r.stdout + r.stderr
    for s in SVC_SUFFIXES:
        assert svc_state(f"{PFX}-{s}") == "Stopped", s
        assert sc_qc(f"{PFX}-{s}")[0] == "DISABLED", s
    assert (ROOT / "pgdata" / "PG_VERSION").exists()
    assert not port_open(BEP) and not port_open(WEP)
    r = stack.uninstall()                       # full removal keeps data too
    assert r.returncode == 0, r.stdout + r.stderr
    assert not [n for n in all_services() if n.startswith(PFX + "-")]
    assert (ROOT / "pgdata" / "PG_VERSION").exists()
