"""Task 11: the spike's 25 functional checks, through nginx (59080) -> native backend. Writes data to app_test, so
conftest orders this module AFTER test_parity (which needs the pristine dump)."""
import re
import time
import uuid

import pytest
import requests
import socketio

from conftest import ADMIN_PASSWORD, ADMIN_USER


def test_functional_flow(native_web):
    BASE = native_web.url
    API = BASE + "/api/v1"
    results = []

    def check(name, ok, info=""):
        results.append((name, bool(ok), str(info)[:160]))

    r = requests.get(API + "/health", timeout=20)
    check("health", r.status_code == 200 and r.json()["status"] == "ok", r.text)
    r = requests.post(API + "/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD}, timeout=20)
    check("login", r.status_code == 200, r.status_code)
    tok = r.json().get("access_token") or r.json().get("token")
    H = {"Authorization": "Bearer " + tok}
    for p in ["/auth/me", "/resources", "/menu/categories", "/menu/items", "/tickets", "/cash/status", "/cash/sessions",
              "/reports/earnings?from=2026-11-01&to=2026-11-01T23:59:59", "/reports/sales?from=2026-11-01&to=2026-11-02",
              "/reports/payments?from=2026-11-01&to=2026-11-02", "/reports/peak-hours?from=2026-11-01&to=2026-11-02"]:
        r = requests.get(API + p, headers=H, timeout=30)
        check("GET " + p, r.status_code == 200, r.status_code)

    # cash session: open one if none is open (409 = already open)
    r = requests.get(API + "/cash/status", headers=H, timeout=20)
    cs = r.json()
    if not (cs.get("session") or cs.get("status") == "OPEN" or cs.get("is_open")):
        r = requests.post(API + "/cash/open", headers=H, json={"opening_fund_cents": 0}, timeout=20)
        check("cash/open", r.status_code in (201, 409), r.status_code)

    items = requests.get(API + "/menu/items", headers=H, timeout=20).json()
    items = items if isinstance(items, list) else items.get("items", [])
    cands = [i for i in items if not i.get("requires_flavor") and i.get("is_active", True)]
    assert cands, "no orderable menu item in the dump"
    r = requests.post(API + "/tickets", headers=H, json={"ticket_type": "EXPRESS", "customer_name": "t11"}, timeout=20)
    check("open ticket", r.status_code == 201, r.text[:100])
    tid = r.json()["id"]

    got = []
    sio = socketio.Client()
    sio.on("ticket:updated", lambda d: got.append(("ticket:updated", d)))
    joined = []
    sio.on("joined", lambda d: joined.append(d))
    sio.connect(BASE, transports=["websocket"], socketio_path="/socket.io", auth={"token": tok})
    try:
        check("socket connect via ws", sio.transport() == "websocket", sio.transport())
        sio.emit("join", {"room": f"ticket:{tid}"})
        end = time.time() + 10
        while time.time() < end and not joined:     # wait for the join ack before the first write
            time.sleep(0.05)
        check("joined ack", joined, joined)
        # condition-based: wait for the first ticket:updated instead of sleeping
        key = "t11-" + uuid.uuid4().hex[:12]
        added, r1 = None, None
        for it in cands:
            r1 = requests.post(f"{API}/tickets/{tid}/items", headers={**H, "Idempotency-Key": key},
                               json={"menu_item_id": it["id"], "quantity": 1}, timeout=20)
            if r1.status_code in (200, 201):
                added = it
                break
        assert added is not None, f"no menu item could be added: {r1.status_code} {r1.text[:200]}"
        check("add item #1 -> 201", r1.status_code == 201, f"{r1.status_code} {r1.text[:100]}")
        r2 = requests.post(f"{API}/tickets/{tid}/items", headers={**H, "Idempotency-Key": key},
                           json={"menu_item_id": added["id"], "quantity": 1}, timeout=20)
        check("add item #2 same key -> 200 replay", r2.status_code == 200 and r2.json().get("id") == r1.json().get("id"),
              r2.status_code)
        t = requests.get(f"{API}/tickets/{tid}", headers=H, timeout=20).json()
        lines = t.get("line_items") or t.get("items") or []
        check("exactly 1 line after 2 posts", len(lines) == 1, len(lines))
        end = time.time() + 10
        while time.time() < end and not got:
            time.sleep(0.1)
        check("socket event ticket:updated received", any(e[0] == "ticket:updated" for e in got), got)
        t0 = time.time()
        r = requests.post(f"{API}/tickets/{tid}/send-order", headers=H, timeout=60)
        check("send-order w/ print agent down (no crash)", r.status_code in (200, 400), f"{r.status_code} {r.text[:80]} {time.time()-t0:.1f}s")
        check("backend alive after", requests.get(API + "/health", timeout=20).status_code == 200)
        requests.post(f"{API}/tickets/{tid}/cancel", headers=H, json={"reason": "t11"}, timeout=20)
    finally:
        sio.disconnect()

    r = requests.get(BASE + "/", timeout=20)
    check("SPA / index.html", r.status_code == 200 and '<div id="root"' in r.text, r.headers.get("content-type"))
    assets = re.findall(r"/assets/[^\"]+", r.text)
    check("index references assets", assets, len(assets))
    for u in assets:
        rr = requests.get(BASE + u, timeout=20)
        check("asset " + u, rr.status_code == 200, f'{rr.headers.get("content-type")} cc={rr.headers.get("cache-control")}')
    r = requests.get(BASE + "/some/spa/route", timeout=20)
    check("SPA fallback route", r.status_code == 200 and '<div id="root"' in r.text)

    bad = [x for x in results if not x[1]]
    print(f"\nSUMMARY {len(results) - len(bad)} / {len(results)}")
    assert not bad, f"failed checks: {bad}"
