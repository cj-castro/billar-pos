"""Task 11: native backend (55000, DB app_test) vs the Docker reference (billiards-backend:g0, 55001) -- read-only GETs.

DB note: docker_backend() always (re)creates its DB from the shared template (restored_db), so it cannot be pointed at
app_test itself without dropping the native backend's DB. It gets `app_parity`, a byte-for-byte clone of the same dump
(+ the same test admin), which is equivalent for read-only GETs. test_functional.py writes to app_test, so conftest
runs it AFTER this module (pytest_collection_modifyitems) -- parity always sees the pristine dump on both sides.
"""
import re
from collections import Counter

import pytest
import requests

from conftest import ADMIN_PASSWORD, ADMIN_USER

DOCKER_PORT = 55001
AGENT_UNREACHABLE = "59199"      # nothing listens: GETs never print, so it is never contacted

STATIC = """analytics/anomalies analytics/cash-flow analytics/cost-coverage analytics/fixed-costs analytics/health
analytics/inventory analytics/menu-engineering analytics/overview analytics/pool-tables analytics/profitability
analytics/staff auth/me cash/status cash/tip-distribution cash/sessions inventory inventory/units inventory/stock-check
menu/categories menu/items menu/modifiers promotions queue/bar queue/kitchen queue/counts resources safe safe/summary
suppliers tickets/active-express tickets/open-all tickets/pending-payment tickets/reopened tickets users waiting-list
waiting-list/history health""".split()
DATED = """reports/earnings reports/earnings/by-category reports/earnings/by-staff reports/sales reports/payments
reports/peak-hours reports/staff reports/voids reports/pool-time reports/promotions reports/modifiers reports/cigarettes
reports/charts-data reports/export reports/menu-deletions reports/inventory-deletions analytics/overview analytics/staff
analytics/profitability""".split()
DATES = [("2026-11-01", "2026-11-01T23:59:59"), ("2026-11-03", "2026-11-03T23:59:59"),
         ("2026-11-06", "2026-11-06T23:59:59")]
PATHS = STATIC + [f"{p}?from={a}&to={b}" for p in DATED for a, b in DATES]

# Scrubbed keys: ONLY values that are a function of the wall clock / request, never business data. Matched by exact
# key name (case-insensitive) at any depth. Anything else that differs is a real finding.
VOLATILE = {
    "now": "server wall-clock at request time",
    "server_time": "server wall-clock at request time",
    "generated_at": "report generation timestamp (wall clock)",
    "uptime": "process uptime",
    "uptime_seconds": "process uptime",
    "request_id": "per-request id",
}
KNOWN_500 = {"inventory/stock-check"}     # known app bug: must stay a 500 on BOTH


def scrub(x):
    if isinstance(x, dict):
        return {k: scrub(v) for k, v in x.items() if k.lower() not in VOLATILE}
    if isinstance(x, list):
        return [scrub(i) for i in x]
    return x


def _body(r):
    try:
        return scrub(r.json())
    except ValueError:
        return r.text


def test_endpoint_list_is_the_spike_list():
    assert len(PATHS) == len(set(PATHS)) >= 94
    assert any("2026-11-06" in p for p in PATHS) and any("2026-11-01" in p for p in PATHS)


def test_get_endpoints_identical(native_backend, docker_backend):
    with docker_backend("app_parity", int(AGENT_UNREACHABLE), DOCKER_PORT) as d_url:
        N, D = f"{native_backend}/api/v1", f"{d_url}/api/v1"
        creds = {"username": ADMIN_USER, "password": ADMIN_PASSWORD}
        tok_n = requests.post(f"{N}/auth/login", json=creds, timeout=20).json()["access_token"]
        # same SECRET_KEY/JWT secret on both stacks (write_env) -> the native token must be valid on Docker too
        hdr = {"Authorization": f"Bearer {tok_n}"}
        assert requests.get(f"{D}/auth/me", headers=hdr, timeout=20).status_code == 200, "native JWT rejected by Docker"
        diffs, codes = [], Counter()
        for p in PATHS:
            a = requests.get(f"{N}/{p}", headers=hdr, timeout=60)
            b = requests.get(f"{D}/{p}", headers=hdr, timeout=60)
            codes[a.status_code] += 1
            if p.split("?")[0] in KNOWN_500:
                assert a.status_code == b.status_code == 500, f"{p}: known bug must stay 500/500, got {a.status_code}/{b.status_code}"
                continue
            if a.status_code != b.status_code or _body(a) != _body(b):
                diffs.append((p, a.status_code, b.status_code, _body(a), _body(b)))
        print(f"\ncompared {len(PATHS)} GETs, native status dist {dict(codes)}")
        assert codes[200] >= 60, f"too few 200s -- suite would prove nothing: {dict(codes)}"
        report = "\n".join(f"DIFF {p} native={sa} docker={sb}\n  N: {str(ba)[:400]}\n  D: {str(bb)[:400]}"
                           for p, sa, sb, ba, bb in diffs)
        assert not diffs, f"{len(diffs)} differences:\n{report}"
