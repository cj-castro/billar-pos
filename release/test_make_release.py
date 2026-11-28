"""Tests for release/make_release.py and the bar compose template.

Plain script, stdlib only. Run from the repo root:
    docker run --rm -v "$PWD:/r" -w /r python:3.11-slim python release/test_make_release.py
Prints PASS/FAIL per check and exits non-zero on any failure.

The compose files are read with a small indentation parser that knows the
shape both files use (2-space services, 4-space keys, 6-space entries). The
full YAML check is `docker compose config` (see the release-images workflow).
"""
import json
import os
import re
import shutil
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "updater"))

import make_release  # noqa: E402
from updater import ops  # noqa: E402  (stdlib only)

SHA = "0384c10d" + "a" * 32
APP_SERVICES = {"backend": "backend", "frontend": "frontend", "scheduler": "backend",
                "telegram-bot": "telegram-bot", "backup": "backup", "updater": "updater"}
ALL_SERVICES = {"postgres"} | set(APP_SERVICES)
OPTIONAL_KEYS = ("TELEGRAM_TOKEN", "ADMIN_CHAT_ID", "SLACK_WEBHOOK_URL", "GHCR_USER", "GHCR_TOKEN",
                 "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET",
                 "SMTP_USER", "SMTP_PASSWORD")
BAR_HOST_DIR_REQ = "${BAR_HOST_DIR:?set BAR_HOST_DIR in .env (Windows path of the billiards folder)}"
UPDATER_ENV = ("GHCR_USER", "GHCR_TOKEN", "BAR_HOST_DIR", "SLACK_WEBHOOK_URL", "TELEGRAM_TOKEN",
               "ADMIN_CHAT_ID", "TZ", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB",
               "COMPOSE_PROJECT_NAME", "UPDATER_REGISTRY", "UPDATER_MESSAGE_PREFIX")

failures = []


def check(name, fn):
    try:
        fn()
        print("PASS " + name)
    except Exception:
        failures.append(name)
        print("FAIL " + name)
        traceback.print_exc()


# --------------------------------------------------------------- parsing

def _strip(line):
    """Line without a trailing comment; '' for comment-only lines."""
    if line.lstrip().startswith("#"):
        return ""
    return re.sub(r"\s+#\s.*$", "", line.rstrip("\n")).rstrip()


def _indent(line):
    return len(line) - len(line.lstrip(" "))


def parse_compose(text):
    """{'top': {key: value}, 'services': {svc: {key: [raw lines under key] or value}}}."""
    lines = [l for l in (_strip(x) for x in text.splitlines()) if l.strip()]
    top, services = {}, {}
    i = 0
    section = None
    svc = None
    key = None
    while i < len(lines):
        line = lines[i]
        ind = _indent(line)
        s = line.strip()
        if ind == 0:
            k, _, v = s.partition(":")
            top[k] = v.strip()
            section = k
            svc = key = None
        elif section == "services" and ind == 2:
            svc = s.rstrip(":")
            services[svc] = {}
            key = None
        elif section == "services" and ind == 4 and svc:
            k, _, v = s.partition(":")
            key = k
            services[svc][k] = v.strip() if v.strip() else []
        elif section == "services" and ind > 4 and svc and key:
            block = services[svc][key]
            if isinstance(block, list):
                block.append(line)
        i += 1
    return {"top": top, "services": services}


def env_map(service):
    """environment block (6-space `KEY: value` lines) as an ordered dict."""
    out = {}
    for line in service.get("environment") or []:
        if _indent(line) != 6:
            continue
        k, _, v = line.strip().partition(":")
        out[k] = v.strip()
    return out


def list_items(service, key):
    return [l.strip()[2:].strip().strip('"') for l in (service.get(key) or [])
            if l.strip().startswith("- ")]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# --------------------------------------------------------------- fixtures

TMP = tempfile.mkdtemp(prefix="test-make-release-")
ORIG = parse_compose(read(os.path.join(ROOT, "docker-compose.yml")))
try:
    paths = make_release.make_release(SHA, out_dir=TMP, built_at="2026-11-27T09:00:00Z")
except Exception:
    traceback.print_exc()
    print("FAIL make_release raised")
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1)
RENDERED_TEXT = read(os.path.join(TMP, "docker-compose.bar.yml"))
BAR = parse_compose(RENDERED_TEXT)
RELEASE = json.loads(read(os.path.join(TMP, "release.json")))
SVCS = BAR["services"]


# ------------------------------------------------------------------ tests

def t_outputs_written():
    assert sorted(os.path.basename(p) for p in paths) == sorted(make_release.OUTPUT_FILES), paths
    for name in make_release.OUTPUT_FILES:
        assert os.path.isfile(os.path.join(TMP, name)), name


def t_files_match_what_ops_copies():
    # ops.pull_release copies these names from this directory of the image.
    assert tuple(make_release.OUTPUT_FILES) == tuple(ops.RELEASE_FILES), ops.RELEASE_FILES
    assert ops.RELEASE_DIR_IN_IMAGE == "/"
    df = read(os.path.join(HERE, "Dockerfile"))
    assert re.search(r"^COPY\s+release\.json\s+docker-compose\.bar\.yml\s+/\s*$", df, re.M), df


def t_no_build_key():
    assert not re.search(r"^\s*build\s*:", RENDERED_TEXT, re.M)
    for svc, body in SVCS.items():
        assert "build" not in body, svc


def t_top_level_name():
    assert BAR["top"].get("name") == "billiards", BAR["top"]
    first = next(l for l in RENDERED_TEXT.splitlines() if l.strip() and not l.lstrip().startswith("#"))
    assert first == "name: billiards", first


def t_exact_services():
    assert set(SVCS) == ALL_SERVICES, sorted(SVCS)
    assert set(ops.PULL_SERVICES) <= set(SVCS), ops.PULL_SERVICES
    assert "postgres" not in ops.PULL_SERVICES


def t_images_pinned_to_sha():
    assert SVCS["postgres"]["image"] == "postgres:15-alpine", SVCS["postgres"]["image"]
    for svc, img in APP_SERVICES.items():
        want = "ghcr.io/cj-castro/billar-pos-%s:%s" % (img, SHA)
        assert SVCS[svc].get("image") == want, (svc, SVCS[svc].get("image"))
    for m in re.finditer(r"^\s*image:\s*(\S+)", RENDERED_TEXT, re.M):
        ref = m.group(1)
        assert ref == "postgres:15-alpine" or ref.endswith(":" + SHA), ref


def t_no_placeholders_left():
    assert "{{" not in RENDERED_TEXT and "}}" not in RENDERED_TEXT


def t_updater_mounts():
    vols = list_items(SVCS["updater"], "volumes")
    assert "/var/run/docker.sock:/var/run/docker.sock" in vols, vols
    # Required: compose refuses to run without it and says what to do.
    assert BAR_HOST_DIR_REQ + ":/bar" in vols, vols
    assert env_map(SVCS["updater"])["BAR_HOST_DIR"] == BAR_HOST_DIR_REQ


def t_updater_env_and_restart():
    env = env_map(SVCS["updater"])
    missing = [k for k in UPDATER_ENV if k not in env]
    assert not missing, missing
    assert env["COMPOSE_PROJECT_NAME"] == "${COMPOSE_PROJECT_NAME:-billiards}", env["COMPOSE_PROJECT_NAME"]
    assert env["UPDATER_REGISTRY"] == "${UPDATER_REGISTRY:-ghcr.io/cj-castro}", env["UPDATER_REGISTRY"]
    assert env["TZ"] == "${TZ:-America/Mexico_City}", env["TZ"]
    # Same defaults as the postgres service, so the updater reaches the same DB.
    pg = env_map(ORIG["services"]["postgres"])
    for k in ("POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"):
        assert env[k] == pg[k], (k, env[k], pg[k])
    assert SVCS["updater"].get("restart") == "unless-stopped"
    assert "ports" not in SVCS["updater"]


def t_every_env_key_kept_with_same_value():
    # The parser really read docker-compose.yml (else this check is empty).
    assert set(ORIG["services"]) == ALL_SERVICES - {"updater"}, sorted(ORIG["services"])
    assert len(env_map(ORIG["services"]["backend"])) >= 30
    assert "REPORT_TO" in env_map(ORIG["services"]["scheduler"])
    for svc, body in ORIG["services"].items():
        orig_env = env_map(body)
        bar_env = env_map(SVCS[svc])
        for k, v in orig_env.items():
            assert k in bar_env, "%s.%s missing" % (svc, k)
            assert bar_env[k] == v, "%s.%s: %r != %r" % (svc, k, bar_env[k], v)


def t_optional_vars_default_empty():
    for m in re.finditer(r"\$\{([A-Z0-9_]+)([^}]*)\}", RENDERED_TEXT):
        var, rest = m.group(1), m.group(2)
        if var in OPTIONAL_KEYS:
            assert rest == ":-", "%s must be ${%s:-}, got %r" % (var, var, m.group(0))
        if var == "BAR_HOST_DIR":
            assert m.group(0) == BAR_HOST_DIR_REQ, m.group(0)
        else:
            # Every variable has a default, so compose never warns "not set".
            assert rest.startswith(":-"), m.group(0)


def t_same_restart_healthcheck_ports_depends():
    for svc, body in ORIG["services"].items():
        bar = SVCS[svc]
        for key in ("restart", "healthcheck", "ports", "depends_on", "entrypoint",
                    "networks", "tmpfs", "logging", "volumes"):
            if key in body:
                assert bar.get(key) == body[key], "%s.%s: %r != %r" % (svc, key, bar.get(key), body[key])
        assert bar.get("restart") == "unless-stopped", svc
    for svc in SVCS:
        assert SVCS[svc].get("restart") == "unless-stopped", svc
    dep = SVCS["frontend"]["depends_on"]
    assert [l.strip() for l in dep] == ["backend:", "condition: service_healthy"], dep
    assert list_items(SVCS["frontend"], "ports") == ["${FRONTEND_PORT:-8080}:80"]


def t_scheduler_runs_scheduler_py():
    assert SVCS["scheduler"].get("entrypoint") == '["python", "scheduler.py"]'


def t_top_level_volumes_and_networks_kept():
    text_orig = read(os.path.join(ROOT, "docker-compose.yml"))
    for block in ("volumes:\n  pg_data:\n    driver: local", "networks:\n  billiardbar_net:\n    driver: bridge"):
        assert block in text_orig and block in RENDERED_TEXT, block


def t_release_json():
    assert set(RELEASE) == {"sha", "built_at", "migrations"}, RELEASE.keys()
    assert RELEASE["sha"] == SHA
    assert RELEASE["built_at"] == "2026-11-27T09:00:00Z"
    stems = []
    with open(os.path.join(ROOT, "backend", "migrations", "sql", "manifest.txt"), encoding="utf-8") as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if line:
                stems.append(line)
    want = [s.split("_", 1)[0] for s in stems]
    assert RELEASE["migrations"] == want, RELEASE["migrations"]
    assert "001" in RELEASE["migrations"] and "058" in RELEASE["migrations"]
    assert len(set(want)) == len(want)


def t_release_json_parses_in_core():
    from updater import core
    rel = core.parse_release(read(os.path.join(TMP, "release.json")))
    assert rel.sha == SHA and "058" in rel.migrations


def t_default_built_at_is_utc_now():
    d = tempfile.mkdtemp(prefix="test-make-release-")
    try:
        make_release.make_release(SHA, out_dir=d)
        built = json.loads(read(os.path.join(d, "release.json")))["built_at"]
        assert re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", built), built
    finally:
        shutil.rmtree(d, ignore_errors=True)


def t_bad_sha_rejected():
    for bad in ("0384c10", SHA.upper(), SHA + "0", "g" * 40, "", None):
        d = tempfile.mkdtemp(prefix="test-make-release-")
        try:
            try:
                make_release.make_release(bad, out_dir=d)
            except ValueError:
                pass
            else:
                raise AssertionError("accepted sha %r" % (bad,))
            assert os.listdir(d) == [], os.listdir(d)
        finally:
            shutil.rmtree(d, ignore_errors=True)


def t_registry_override():
    d = tempfile.mkdtemp(prefix="test-make-release-")
    try:
        make_release.make_release(SHA, out_dir=d, registry="localhost:5001")
        text = read(os.path.join(d, "docker-compose.bar.yml"))
        svcs = parse_compose(text)["services"]
        assert svcs["backend"]["image"] == "localhost:5001/billar-pos-backend:" + SHA
        assert svcs["scheduler"]["image"] == "localhost:5001/billar-pos-backend:" + SHA
        assert env_map(svcs["updater"])["UPDATER_REGISTRY"] == "${UPDATER_REGISTRY:-localhost:5001}"
        assert "ghcr.io" not in text
    finally:
        shutil.rmtree(d, ignore_errors=True)
    for bad in ("ghcr.io/cj-castro/", "GHCR.io/x", "a b", "ghcr.io/x;rm"):
        try:
            make_release.render_compose("x", SHA, bad)
        except ValueError:
            continue
        raise AssertionError("accepted registry %r" % bad)


def t_cli():
    d = tempfile.mkdtemp(prefix="test-make-release-")
    try:
        code = make_release.main(["--sha", SHA, "--out", d])
        assert code == 0
        assert sorted(os.listdir(d)) == sorted(make_release.OUTPUT_FILES)
        assert make_release.main(["--sha", "nope", "--out", d]) == 2
    finally:
        shutil.rmtree(d, ignore_errors=True)


TESTS = [
    ("outputs written", t_outputs_written),
    ("file names and image path match ops.pull_release", t_files_match_what_ops_copies),
    ("rendered compose has no build: key", t_no_build_key),
    ("top-level name: billiards", t_top_level_name),
    ("exactly the seven services", t_exact_services),
    ("app images pinned to the sha, postgres unchanged", t_images_pinned_to_sha),
    ("no {{placeholders}} left", t_no_placeholders_left),
    ("updater mounts the socket and ${BAR_HOST_DIR:?...}:/bar", t_updater_mounts),
    ("updater environment and restart", t_updater_env_and_restart),
    ("every env key of docker-compose.yml kept with the same value", t_every_env_key_kept_with_same_value),
    ("optional variables default to empty", t_optional_vars_default_empty),
    ("restart/healthcheck/ports/depends_on unchanged", t_same_restart_healthcheck_ports_depends),
    ("scheduler still runs scheduler.py", t_scheduler_runs_scheduler_py),
    ("top-level volumes and networks kept", t_top_level_volumes_and_networks_kept),
    ("release.json lists every migration and the sha", t_release_json),
    ("release.json parses in updater core", t_release_json_parses_in_core),
    ("default built_at is UTC", t_default_built_at_is_utc_now),
    ("bad sha rejected, nothing written", t_bad_sha_rejected),
    ("registry override (e2e) and bad registry rejected", t_registry_override),
    ("command line", t_cli),
]

if __name__ == "__main__":
    try:
        for name, fn in TESTS:
            check(name, fn)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    if failures:
        print("\n%d FAILED: %s" % (len(failures), ", ".join(failures)))
        sys.exit(1)
    print("\nall %d passed" % len(TESTS))
