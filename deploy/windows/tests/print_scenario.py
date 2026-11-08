"""The fixed API scenario both stacks run (see test_print_parity.py). Everything goes through the public API.

run_scenario(base_url, token, settle=None, strict=True) -> list of {"step", "status", "secs"} (one per HTTP call that can print).
`settle(n)` (optional) is called after each step with the number of print requests expected so far, so the background
auto-chit greenlets reach the mock in a fixed order; without it nothing waits.
`strict=False` (agent-down runs) records statuses instead of asserting the happy-path ones.
Precondition handled here: print_bar_tickets is switched on (setting default is false, which skips BAR chits entirely).
"""
import time

import requests

H = lambda token, **kw: {"Authorization": f"Bearer {token}", **kw}


def _pick(items, routing):
    """first active item per routing destination, ordered by name; no flavor-required items (they need modifiers)."""
    return sorted((i for i in items if i["is_active"] and i["routing"] == routing and not i["requires_flavor"]),
                  key=lambda i: i["name"])


def run_scenario(base, token, settle=None, strict=True):
    s, steps = requests.Session(), []

    def call(step, method, path, ok, expect_print=0, **kw):
        t0 = time.time()
        r = s.request(method, base + path, headers=H(token), timeout=30, **kw)
        steps.append({"step": step, "status": r.status_code, "secs": round(time.time() - t0, 2)})
        if ok is not None and strict:
            assert r.status_code == ok, f"{step}: {r.status_code} {r.text[:300]}"
        if settle and expect_print:
            settle(expect_print)
        return r

    me = requests.get(base + "/api/v1/auth/me", headers=H(token), timeout=10)
    uid = me.json().get("id") if me.ok else None
    items = s.get(base + "/api/v1/menu/items", headers=H(token), timeout=30).json()
    kitchen, bar = _pick(items, "KITCHEN"), _pick(items, "BAR")
    assert kitchen and bar, "restored menu has no active KITCHEN/BAR item"

    if s.get(base + "/api/v1/settings/print_bar_tickets", headers=H(token), timeout=10).json()["value"] != "true":
        r = s.put(base + "/api/v1/settings/print_bar_tickets", json={"value": "true"}, headers=H(token), timeout=10)
        assert r.status_code == 200, r.text
    if not s.get(base + "/api/v1/cash/status", headers=H(token), timeout=10).json().get("open"):
        s.post(base + "/api/v1/cash/open", json={"opening_fund_cents": 0}, headers=H(token), timeout=10)

    # 1. open an EXPRESS ticket (no table: no pool timer, so payloads carry no running clock)
    t = call("open", "POST", "/api/v1/tickets", 201, json={"ticket_type": "EXPRESS"}).json()
    tid = t["id"]

    # 2. kitchen item and bar item, quantity 2, with a note: each fires an auto-chit
    def add(step, pool, n):
        for it in pool:                 # first that the restored stock allows; same data => same pick on both stacks
            r = call(step, "POST", f"/api/v1/tickets/{tid}/items", None,
                     json={"menu_item_id": it["id"], "quantity": 2, "notes": "sin hielo"})
            if r.status_code == 201:
                if settle:
                    settle(n)
                return r.json()
            steps.pop()
        raise AssertionError(f"{step}: no addable item")
    k_line = add("add_kitchen", kitchen, 1)
    b_line = add("add_bar", bar, 2)

    # 3. manual queue chit for the bar line (BAR printing is enabled above)
    call("queue_print", "POST", f"/api/v1/queue/{b_line['id']}/print", 200, expect_print=3, json={})
    # 4. receipt
    call("print", "POST", f"/api/v1/tickets/{tid}/print", 200, expect_print=4, json={})
    # 5. close
    call("close", "POST", f"/api/v1/tickets/{tid}/close", 200, json={"payment_type": "CARD"})
    # 6. reprint (manager-authorised)
    call("reprint", "POST", f"/api/v1/tickets/{tid}/reprint", 200, expect_print=5, json={"manager_id": uid})
    return steps
