import json
import subprocess
from pathlib import Path

import pytest

WIN = Path(__file__).resolve().parents[1]
REPO = WIN.parents[1]
FIX = Path(__file__).parent / "fixtures" / "test.env"
PG_PORT = 55432


def parse(p):
    out = {}
    for line in Path(p).read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k] = v
    return out


def compose_env(service):
    r = subprocess.run(["docker", "compose", "--env-file", str(FIX), "config", "--format", "json"],
                       cwd=REPO, capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)["services"][service]["environment"]


def export(run_ps, out, *extra):
    r = run_ps(str(WIN / "Export-ComposeEnv.ps1"), "-ComposeDir", str(REPO), "-OutDir", str(out),
               "-PgPort", str(PG_PORT), "-EnvFile", str(FIX), *extra)
    assert r.returncode == 0, r.stdout + r.stderr
    return out


@pytest.fixture(scope="module")
def out(run_ps, tmp_path_factory):
    # -SkipAcl: the ACL (SYSTEM+Administrators only) would lock a non-elevated test out of reading the files
    return export(run_ps, tmp_path_factory.mktemp("cfg"), "-SkipAcl")


def test_tz_stripped_for_backend_and_scheduler(out):
    assert compose_env("backend")["TZ"] == "America/Mexico_City"   # the leak this guards
    assert "TZ" not in parse(out / "backend.env")
    assert "TZ" not in parse(out / "scheduler.env")
    assert parse(out / "backup.env")["TZ"] == "America/Mexico_City"


def test_compose_defaults_materialised(out):
    assert parse(out / "backend.env")["CURRENCY"] == "MXN"


def test_scheduler_env_is_scheduler_only(out):
    want = (set(compose_env("scheduler")) - {"TZ"}) | {"PYTHONUTF8", "PYTHONUNBUFFERED"}
    got = parse(out / "scheduler.env")
    assert set(got) == want
    assert "CURRENCY" not in got


def test_overrides_applied(out):
    b, s, k = (parse(out / f"{n}.env") for n in ("backend", "scheduler", "backup"))
    for e in (b, s):
        assert e["DATABASE_URL"].endswith(f"@127.0.0.1:{PG_PORT}/testdb")
        assert e["PYTHONUTF8"] == "1" and e["PYTHONUNBUFFERED"] == "1"
    assert b["PRINT_AGENT_URL"] == "http://127.0.0.1:9191"
    assert b["SECRET_KEY"] == "sek=ret#key"
    assert k["PG_HOST"] == "127.0.0.1" and k["PG_PORT"] == str(PG_PORT)
    assert "PYTHONUTF8" not in k


def test_env_dir_acl(run_ps, tmp_path):
    d = tmp_path / "acl"
    export(run_ps, d)
    try:
        r = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                            f"(Get-Acl '{d}').Access | ForEach-Object {{ $_.IdentityReference.Value + '|' + $_.FileSystemRights }}; "
                            f"'PROT=' + (Get-Acl '{d}').AreAccessRulesProtected"],
                           capture_output=True, text=True)
        lines = r.stdout.splitlines()
        assert "PROT=True" in lines
        ids = {l.split("|")[0] for l in lines if "|" in l}
        assert ids == {"NT AUTHORITY\SYSTEM", "BUILTIN\Administrators"}, r.stdout + r.stderr
    finally:  # give the owner access back so pytest can clean up
        subprocess.run(["icacls", str(d), "/reset", "/t", "/q"], capture_output=True)


def test_import_posenv_value_with_equals(run_ps, tmp_path):
    f = tmp_path / "x.env"
    f.write_bytes(b"# comment\n\nA=b=c#d\"e'f$g\nEMPTY=\n")
    s = tmp_path / "t.ps1"
    s.write_text(f"Import-Module '{WIN / 'PosCommon.psm1'}' -Force\nImport-PosEnv -Path '{f}'\n"
                 "Write-Output \"A=$env:A\"\nWrite-Output \"EMPTY=[$env:EMPTY]\"\n")
    r = run_ps(str(s))
    assert r.returncode == 0, r.stderr
    assert "A=b=c#d\"e'f$g" in r.stdout.splitlines()
    assert "EMPTY=[]" in r.stdout.splitlines()
