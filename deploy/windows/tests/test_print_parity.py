"""Task 7: printing parity, native Windows backend vs the Docker backend (billiards-backend:g0).

Printing = the backend POSTing JSON to the print agent, so identical requests mean identical prints. Both stacks run the
same scenario against their own DB (print_a = docker, print_b = native, both clones of POS_TEST_DUMP) and their own mock
agent; the recorded requests are normalised (uuids, timestamps only) and compared. Needs POS_TEST_DUMP, docker, the image.
"""
import json
import re
import subprocess
import time
from datetime import datetime
from contextlib import ExitStack, contextmanager

import pytest

from conftest import (WIN, ADMIN_PASSWORD, ADMIN_USER, ensure_admin, kill_tree, port_open, psql,
                      running_backend)
from mock_print_agent import read_records
from print_scenario import run_scenario
from test_env_export import export, parse

pytestmark = pytest.mark.slow
NATIVE_AGENT, DOCKER_AGENT = 59191, 59192
NATIVE_PORT, DOCKER_PORT = 55002, 55001
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
ISO_TS = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?")
DMY_TS = re.compile(r"\d{2}/\d{2}/\d{4}[ ,]+\d{2}:\d{2}")


def _parse_iso(t):
    t = t.replace("Z", "+00:00")
    m = re.search(r"[+-]\d{4}$", t)
    if m:
        t = t[:m.start() + 3] + ":" + t[m.start() + 3:]
    return datetime.fromisoformat(t)


def _iso_token(m):
    off = re.search(r"(Z|[+-]\d{2}:?\d{2})$", m.group(0))
    return f"<ts{off.group(1) if off else '-naive'}>"        # offset kept: a timezone shift changes the token


def _walk(v, f):
    if isinstance(v, dict):
        return {k: _walk(v[k], f) for k in sorted(v)}
    if isinstance(v, list):
        return [_walk(x, f) for x in v]
    return f(v) if isinstance(v, str) else v


def normalize(record):
    """uuid -> <uuid>; ISO timestamps -> <ts+HH:MM> / <tsZ> / <ts-naive> (offset and naive-vs-aware survive);
    dd/mm/yyyy HH:MM -> <dmy-naive>. The clock values themselves are compared separately by timestamps(). No ticket or
    folio number appears in any payload (tickets are keyed by uuid), so nothing sequence-derived is dropped."""
    return _walk(record, lambda x: DMY_TS.sub("<dmy-naive>", ISO_TS.sub(_iso_token, UUID.sub("<uuid>", x))))


def timestamps(record):
    """Every timestamp in the record, in fixed (sorted-key) order, as datetime objects."""
    out = []

    def grab(x):
        x = UUID.sub("", x)
        for m in ISO_TS.finditer(x):
            out.append(_parse_iso(m.group(0)))
        for m in DMY_TS.finditer(x):
            out.append(datetime.strptime(re.sub(r"[ ,]+", " ", m.group(0)), "%d/%m/%Y %H:%M"))
        return x
    _walk(record, grab)
    return out


@contextmanager
def mock_agent(pos_venv, tmp, port, host):
    out = tmp / f"agent_{port}.jsonl"
    out.write_text("")
    log = open(tmp / f"agent_{port}.log", "wb")
    p = subprocess.Popen([str(pos_venv / "Scripts" / "python.exe"), str(WIN / "tests" / "mock_print_agent.py"),
                          "--port", str(port), "--host", host, "--out", str(out)],
                         stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    p._logfile = log
    end = time.time() + 20
    while time.time() < end and not port_open(port):
        time.sleep(0.2)
    assert port_open(port), (tmp / f"agent_{port}.log").read_text(errors="replace")
    try:
        yield out
    finally:
        kill_tree(p)


def login(base):
    import requests
    r = requests.post(base + "/api/v1/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def wait_count(path, n, timeout=15):
    end = time.time() + timeout
    while time.time() < end and len(read_records(path)) < n:
        time.sleep(0.1)


@contextmanager
def both_stacks(pos_venv, pos_root, native_pg, restored_db, docker_backend, tmp, with_agents):
    """Yield (docker_url, native_url, [docker_jsonl, native_jsonl]); the jsonl list is empty when with_agents is False."""
    with ExitStack() as st:
        outs = []
        if with_agents:
            outs = [st.enter_context(mock_agent(pos_venv, tmp, DOCKER_AGENT, "127.0.0.1")),
                    st.enter_context(mock_agent(pos_venv, tmp, NATIVE_AGENT, "127.0.0.1"))]
        dsn_b = restored_db("print_b")
        ensure_admin(pos_venv, dsn_b)
        d_url = st.enter_context(docker_backend("print_a", DOCKER_AGENT, DOCKER_PORT))
        n = st.enter_context(running_backend(pos_root, tmp, dsn_b, NATIVE_PORT, f"http://127.0.0.1:{NATIVE_AGENT}",
                                             name="print_b"))
        yield d_url, n.url, outs


def test_print_payloads_identical(pos_venv, pos_root, native_pg, restored_db, docker_backend, tmp_path):
    with both_stacks(pos_venv, pos_root, native_pg, restored_db, docker_backend, tmp_path, True) as (d_url, n_url, outs):
        spans = []
        for url, out in zip((d_url, n_url), outs):
            t0 = time.time()
            run_scenario(url, login(url), settle=lambda n, out=out: wait_count(out, n))
            spans.append((t0, time.time()))
        d, n = (read_records(o) for o in outs)
    nd, nn = [normalize(r) for r in d], [normalize(r) for r in n]
    # clock values: docker/native pairs are the same moment of the scenario, so they may differ only by the gap between
    # the two runs (+ the longest run, + 60 s as dd/mm/yyyy HH:MM strings are minute-resolution). A TZ shift is hours.
    bound = abs(spans[1][0] - spans[0][0]) + max(e - b for b, e in spans) + 60
    assert any(timestamps(r) for r in d), "no timestamps found: the clock comparison would be vacuous"
    for rd, rn in zip(d, n):
        td, tn = timestamps(rd), timestamps(rn)
        assert len(td) == len(tn), (rd, rn)
        for a, b in zip(td, tn):
            assert (a.tzinfo is None) == (b.tzinfo is None), (a, b)
            assert abs((a - b).total_seconds()) <= bound, f"{rd['path']}: {a} vs {b} (bound {bound:.0f}s)"
    # BAR chits are gated on setting print_bar_tickets (default false); the scenario switches it on, so:
    # kitchen auto-chit, bar auto-chit, queue chit, receipt (/print), reprint (/print) = 5 requests
    assert [r["path"] for r in nd] == ["/chit", "/chit", "/chit", "/print", "/print"], nd
    assert nd == nn, "docker:\n" + json.dumps(nd, indent=1, sort_keys=True) + "\nnative:\n" + json.dumps(nn, indent=1, sort_keys=True)


def jobs(pg, db, since):
    """This scenario's print_jobs only, as PrintJob `type:status` (not the dump's historical rows)."""
    r = psql(pg, db, "-Atc", f"select type||':'||status from print_jobs where created_at >= to_timestamp({since}) order by 1")
    assert r.returncode == 0, r.stderr
    return r.stdout.split()


def test_agent_down_behaviour_matches_docker(pos_venv, pos_root, native_pg, restored_db, docker_backend, tmp_path):
    with both_stacks(pos_venv, pos_root, native_pg, restored_db, docker_backend, tmp_path, False) as (d_url, n_url, _):
        assert not port_open(NATIVE_AGENT) and not port_open(DOCKER_AGENT)
        since = time.time() - 10
        res = {k: run_scenario(u, login(u), strict=False) for k, u in (("docker", d_url), ("native", n_url))}
        # background auto-chits finish failing on their own greenlet: wait until no job is still SENT
        end = time.time() + 20
        while time.time() < end and any(s.endswith(":SENT") for db in ("print_a", "print_b") for s in jobs(native_pg, db, since)):
            time.sleep(0.2)
    assert [(s["step"], s["status"]) for s in res["docker"]] == [(s["step"], s["status"]) for s in res["native"]]
    assert all(s["secs"] < 9 for r in res.values() for s in r), res
    ja, jb = jobs(native_pg, "print_a", since), jobs(native_pg, "print_b", since)
    # PrintJob.type CHIT x3 (kitchen auto, bar auto, queue), RECEIPT, REPRINT; status FAILED (agent unreachable)
    want = ["CHIT:FAILED"] * 3 + ["RECEIPT:FAILED", "REPRINT:FAILED"]
    assert ja == want and jb == want, (ja, jb)


def test_native_uses_loopback_agent(run_ps, tmp_path):
    out = export(run_ps, tmp_path, "-SkipAcl")
    assert parse(out / "backend.env")["PRINT_AGENT_URL"] == "http://127.0.0.1:9191"
