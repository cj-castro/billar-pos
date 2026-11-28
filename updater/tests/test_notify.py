"""Plain-script tests for updater.notify. Run: python -m tests.test_notify

Uses a local http.server stub; never contacts Slack or Telegram.
"""
import io
import json
import logging
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from updater.notify import notify

FAILED = []
RECEIVED = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + ": " + name)
    if not cond:
        FAILED.append(name)


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        RECEIVED.append((self.path, self.headers.get("Content-Type"), body))
        code = 500 if "fail" in self.path else 200
        self.send_response(code)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):  # keep test output clean
        pass


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def capture_logs():
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    h.setLevel(logging.DEBUG)
    root = logging.getLogger()
    root.addHandler(h)
    root.setLevel(logging.DEBUG)
    return buf, h


def main():
    srv = HTTPServer(("127.0.0.1", 0), Stub)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    buf, h = capture_logs()
    try:
        # 1. Slack stub receives the JSON text
        hook = base + "/services/T000/B000/okSECRETHOOK"
        RECEIVED.clear()
        notify("POS actualizado: aaaaaaa -> bbbbbbb. Todo funciona.", {"SLACK_WEBHOOK_URL": hook})
        check("slack: one POST received", len(RECEIVED) == 1)
        path, ctype, body = RECEIVED[0] if RECEIVED else ("", "", b"{}")
        check("slack: posted to the webhook path", path == "/services/T000/B000/okSECRETHOOK")
        check("slack: JSON content type", (ctype or "").startswith("application/json"))
        check("slack: body is {'text': ...}",
              json.loads(body.decode("utf-8")) == {"text": "POS actualizado: aaaaaaa -> bbbbbbb. Todo funciona."})

        # 2. Spanish characters survive as UTF-8
        RECEIVED.clear()
        notify("Actualización pospuesta: mesas abiertas", {"SLACK_WEBHOOK_URL": hook})
        check("slack: UTF-8 text intact",
              RECEIVED and json.loads(RECEIVED[0][2].decode("utf-8"))["text"] == "Actualización pospuesta: mesas abiertas")

        # 3. Secrets inside the text are redacted before sending (defence in depth)
        RECEIVED.clear()
        env = {"SLACK_WEBHOOK_URL": hook, "GHCR_TOKEN": "ghp_LEAKME123"}
        notify("Falló login: token ghp_LEAKME123 rechazado; hook " + hook, env)
        sent = RECEIVED[0][2].decode("utf-8") if RECEIVED else ""
        check("redact: token not sent", "ghp_LEAKME123" not in sent and "***" in sent)
        check("redact: webhook not sent in text", "okSECRETHOOK" not in sent)

        # 4. HTTP 500 is swallowed and logged without the URL
        fail_hook = base + "/services/T000/B000/failSECRETHOOK"
        try:
            notify("x", {"SLACK_WEBHOOK_URL": fail_hook})
            check("slack 500: returns without raising", True)
        except Exception:
            check("slack 500: returns without raising", False)
        logs = buf.getvalue()
        check("slack 500: failure logged", "500" in logs)
        check("slack 500: URL not in logs", "failSECRETHOOK" not in logs and fail_hook not in logs)

        # 5. Unreachable URL is swallowed and logged without the URL
        dead = "http://127.0.0.1:%d/services/T/B/deadSECRETHOOK" % free_port()
        try:
            notify("x", {"SLACK_WEBHOOK_URL": dead})
            check("unreachable: returns without raising", True)
        except Exception:
            check("unreachable: returns without raising", False)
        logs = buf.getvalue()
        check("unreachable: URL not in logs", "deadSECRETHOOK" not in logs)

        # 6. Garbage URL is swallowed too
        try:
            notify("x", {"SLACK_WEBHOOK_URL": "not a url SECRETGARBAGE"})
            check("bad url: returns without raising", True)
        except Exception:
            check("bad url: returns without raising", False)
        check("bad url: value not in logs", "SECRETGARBAGE" not in buf.getvalue())

        # 7. No webhook configured: no POST, no exception
        RECEIVED.clear()
        notify("x", {})
        check("no webhook: nothing sent", RECEIVED == [])

        # 8. Telegram also gets the message when token + chat id are set
        RECEIVED.clear()
        env = {"SLACK_WEBHOOK_URL": hook, "TELEGRAM_TOKEN": "123:TGSECRET", "ADMIN_CHAT_ID": "999"}
        notify("hola", env, telegram_api=base)
        paths = [p for p, _, _ in RECEIVED]
        check("telegram: slack + telegram both posted", len(RECEIVED) == 2)
        tg = [r for r in RECEIVED if r[0] == "/bot123:TGSECRET/sendMessage"]
        check("telegram: sendMessage path", len(tg) == 1)
        if tg:
            data = json.loads(tg[0][2].decode("utf-8"))
            check("telegram: chat_id + text", data.get("chat_id") == "999" and data.get("text") == "hola")

        # 9. Telegram only with both values
        RECEIVED.clear()
        notify("hola", {"SLACK_WEBHOOK_URL": hook, "TELEGRAM_TOKEN": "123:TGSECRET"}, telegram_api=base)
        check("telegram: skipped without ADMIN_CHAT_ID", len(RECEIVED) == 1)

        # 10. Telegram failure: swallowed, token not logged; Slack still sent
        RECEIVED.clear()
        dead_api = "http://127.0.0.1:%d" % free_port()
        notify("hola", env, telegram_api=dead_api)
        check("telegram down: slack still sent", len(RECEIVED) == 1)
        check("telegram down: token not in logs", "TGSECRET" not in buf.getvalue())
    finally:
        logging.getLogger().removeHandler(h)
        srv.shutdown()

    print("\n%d failed" % len(FAILED))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
