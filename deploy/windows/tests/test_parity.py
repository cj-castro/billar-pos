"""Task 11: native backend (55000, DB app_test) vs the Docker reference (billiards-backend:g0, 55001) -- read-only GETs.

DB note: docker_backend() always (re)creates its DB from the shared template (restored_db), so it cannot be pointed at
app_test itself without dropping the native backend's DB. It gets `app_parity`, a clone of the same dump (+ the same
test admin), which is equivalent for read-only GETs.
Ordering: app_test is shared with test_nginx/test_functional, which write to it. conftest therefore runs this module
FIRST and test_functional LAST. As a second line of defence the test fingerprints app_test against app_parity
(both migrated, before any request) and fails with a clear message if app_test drifted, so a bad order can never
masquerade as a parity regression.
"""
import re
from collections import Counter

import pytest
import requests

from conftest import ADMIN_PASSWORD, ADMIN_USER, fingerprint, psql

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
    assert len(PATHS) == len(set(PATHS)) == 95
    assert any("2026-11-06" in p for p in PATHS) and any("2026-11-01" in p for p in PATHS)


def _fp(native_pg, db):
    """fingerprint rows as {check: value}. public.users row hash is dropped (keep the count): the test admin is created
    separately in each DB (random password salt, own created_at)."""
    d = dict(r.split("|", 1) for r in fingerprint(native_pg, db))
    d["table:public.users"] = d["table:public.users"].split("|")[0]
    # schema_migrations rows carry applied_at/applied_by of each apply: compare version+name only
    for k in ("schema_migrations", "table:public.schema_migrations"):
        d.pop(k)
    r = psql(native_pg, db, "-Atc", "select string_agg(version || ':' || name, ',' order by version) from schema_migrations")
    assert r.returncode == 0, r.stderr
    d["migrations"] = r.stdout.strip()
    return d


def test_get_endpoints_identical(native_backend, docker_backend, native_pg):
    with docker_backend("app_parity", int(AGENT_UNREACHABLE), DOCKER_PORT) as d_url:
        fa, fb = _fp(native_pg, "app_test"), _fp(native_pg, "app_parity")
        drift = sorted(k for k in fa.keys() | fb.keys() if fa.get(k) != fb.get(k))
        assert not drift, ("app_test has drifted from a fresh migrated clone BEFORE parity ran (another test wrote to it "
                           "or test order is wrong), not a parity regression: " + ", ".join(drift[:10]))
        N, D = f"{native_backend}/api/v1", f"{d_url}/api/v1"
        creds = {"username": ADMIN_USER, "password": ADMIN_PASSWORD}
        tok_n = requests.post(f"{N}/auth/login", json=creds, timeout=20).json()["access_token"]
        # same SECRET_KEY/JWT secret on both stacks (write_env) -> the native token must be valid on Docker too
        hdr = {"Authorization": f"Bearer {tok_n}"}
        assert requests.get(f"{D}/auth/me", headers=hdr, timeout=20).status_code == 200, "native JWT rejected by Docker"
        diffs, codes, big, ingresos = [], Counter(), 0, {}
        for p in PATHS:
            a = requests.get(f"{N}/{p}", headers=hdr, timeout=60)
            b = requests.get(f"{D}/{p}", headers=hdr, timeout=60)
            codes[a.status_code] += 1
            if p.split("?")[0] in KNOWN_500:
                assert a.status_code == b.status_code == 500, f"{p}: known bug must stay 500/500, got {a.status_code}/{b.status_code}"
                continue
            assert a.status_code == b.status_code == 200, f"{p}: expected 200 on both, native={a.status_code} docker={b.status_code}"
            big += len(a.content) > 300 and len(b.content) > 300
            if p.startswith("reports/earnings?"):
                ingresos[p[-30:-19]] = (a.json()["ingresos_cents"], b.json()["ingresos_cents"])
            if a.headers.get("Content-Type") != b.headers.get("Content-Type") or _body(a) != _body(b):
                diffs.append((p, a.headers.get("Content-Type"), b.headers.get("Content-Type"), _body(a), _body(b)))
        print(f"\ncompared {len(PATHS)} GETs, native status dist {dict(codes)}, responses >300 bytes: {big}")
        assert big >= 50, f"only {big} substantial responses -- suite would prove nothing"
        assert len(ingresos) == 3 and all(x > 0 and y > 0 for x, y in ingresos.values()), f"empty earnings: {ingresos}"
        report = "\n".join(f"DIFF {p} content-type native={ca} docker={cb}\n  N: {str(ba)[:400]}\n  D: {str(bb)[:400]}"
                           for p, ca, cb, ba, bb in diffs)
        assert not diffs, f"{len(diffs)} differences:\n{report}"
