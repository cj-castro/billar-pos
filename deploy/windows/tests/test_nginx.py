"""Task 6: nginx site generated mechanically from frontend/nginx.conf. Live tests need POS_TEST_DUMP (backend)."""
import re
import subprocess
import time
import uuid

import pytest
import requests
import socketio

from conftest import ADMIN_PASSWORD, ADMIN_USER, REPO, WIN

SOURCE = REPO / "frontend" / "nginx.conf"
CONVERT = WIN / "nginx" / "Convert-NginxSite.ps1"
CHANGED = [r"^\s*listen 80;", r"proxy_pass http://backend:5000;", r"^\s*root /usr/share/nginx/html;"]


def test_only_three_substitutions(run_ps, tmp_path):
    out = tmp_path / "conf" / "pos-site.conf"
    (tmp_path / "conf").mkdir()
    r = run_ps(str(CONVERT), "-Source", str(SOURCE), "-Out", str(out), "-ListenPort", "8080",
               "-BackendPort", "5000", "-DistDir", r"C:\POS\app\dist")
    assert r.returncode == 0, r.stdout + r.stderr
    a = SOURCE.read_text(encoding="utf-8").splitlines()
    b = out.read_text(encoding="utf-8").splitlines()
    assert len(a) == len(b)
    diff = [(x, y) for x, y in zip(a, b) if x != y]
    # listen (1) + proxy_pass in /api/ and /socket.io/ (2) + root (1)
    assert len(diff) == 4, diff
    for x, _ in diff:
        assert any(re.search(p, x) for p in CHANGED), x
    assert "listen 8080;" in b[1] and "root C:/POS/app/dist;" in b[2]
    assert b.count("        proxy_pass http://127.0.0.1:5000;") == 2
    assert (tmp_path / "conf" / "nginx.conf").exists()


def test_nginx_config_valid(native_web):
    r = subprocess.run(native_web.args + ["-t"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_spa_and_assets(native_web):
    r = requests.get(native_web.url + "/", timeout=10)
    assert r.status_code == 200 and '<div id="root"' in r.text
    asset = re.findall(r'/assets/[^"]+\.js', r.text)[0]
    a = requests.get(native_web.url + asset, timeout=10)
    assert a.status_code == 200 and "immutable" in a.headers["Cache-Control"]
    deep = requests.get(native_web.url + "/tables/1", timeout=10)
    assert deep.status_code == 200 and deep.text == r.text
    assert "no-store" in requests.get(native_web.url + "/index.html", timeout=10).headers["Cache-Control"]


def test_api_proxied(native_web):
    r = requests.get(native_web.url + "/api/v1/health", timeout=10)
    assert r.status_code == 200


def _login(base):
    r = requests.post(base + "/api/v1/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _ticket(base, H):
    """Open cash session (409 = already open) and a fresh EXPRESS ticket; returns (ticket_id, first plain menu item)."""
    B = base + "/api/v1"
    requests.post(B + "/cash/open", headers=H, json={"opening_fund_cents": 0}, timeout=30)
    items = requests.get(B + "/menu/items", headers=H, timeout=30).json()
    items = items if isinstance(items, list) else items.get("items", [])
    item = next(i for i in items if i.get("is_active", True) and not i.get("requires_flavor"))
    r = requests.post(B + "/tickets", headers=H, json={"ticket_type": "EXPRESS"}, timeout=30)
    assert r.status_code == 201, r.text
    return r.json()["id"], item


def _add_item(base, H, tid, item):
    r = requests.post(f"{base}/api/v1/tickets/{tid}/items", headers={**H, "Idempotency-Key": uuid.uuid4().hex},
                      json={"menu_item_id": item["id"], "quantity": 1}, timeout=30)
    assert r.status_code in (200, 201), r.text


def _wait(cond, timeout=10):
    end = time.time() + timeout
    while time.time() < end and not cond():
        time.sleep(0.1)
    return cond()


def _ws(native_web, tok, tid):
    got = []
    sio = socketio.Client(reconnection=False)
    sio.on("ticket:updated", lambda d: got.append(d))
    sio.on("joined", lambda d: got.append(("joined", d)))
    sio.connect(native_web.url, transports=["websocket"], socketio_path="/socket.io", auth={"token": tok})
    assert sio.transport() == "websocket"
    sio.emit("join", {"room": f"ticket:{tid}"})
    assert _wait(lambda: ("joined", {"room": f"ticket:{tid}"}) in got)
    return sio, got


def test_websocket_through_proxy(native_web):
    tok = _login(native_web.url); H = {"Authorization": "Bearer " + tok}
    tid, item = _ticket(native_web.url, H)
    sio, got = _ws(native_web, tok, tid)
    try:
        _add_item(native_web.url, H, tid, item)
        assert _wait(lambda: any(isinstance(g, dict) and g.get("ticket_id") == tid for g in got)), got
    finally:
        sio.disconnect()


@pytest.mark.slow
def test_websocket_idle_10min(native_web):
    tok = _login(native_web.url); H = {"Authorization": "Bearer " + tok}
    tid, item = _ticket(native_web.url, H)
    sio, got = _ws(native_web, tok, tid)
    sid = sio.sid
    try:
        time.sleep(600)
        assert sio.connected and sio.sid == sid, "websocket dropped or silently reconnected during idle"
        _add_item(native_web.url, H, tid, item)
        assert _wait(lambda: any(isinstance(g, dict) and g.get("ticket_id") == tid for g in got)), got
    finally:
        sio.disconnect()
