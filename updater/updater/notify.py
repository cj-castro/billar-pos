"""Send one message to Slack (and Telegram when configured). Stdlib only.

A message that cannot be sent is logged and swallowed: notify() never raises,
so a broken webhook can never block or fail an update. Webhook URLs and the
Telegram token are secrets: they are never logged, and their values are
removed from the text itself before sending.
"""
import json
import logging
import urllib.request

from .redact import redact

log = logging.getLogger("updater.notify")

TELEGRAM_API = "https://api.telegram.org"
TIMEOUT_S = 10


def _post_json(url, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.status


def _send(channel, url, payload, env):
    try:
        status = _post_json(url, payload)
        if not 200 <= status < 300:
            log.warning("%s message not sent: HTTP %s", channel, status)
    except Exception as e:  # HTTPError (non-2xx), URLError, ValueError, timeouts...
        code = getattr(e, "code", None)
        reason = "HTTP %s" % code if isinstance(code, int) else type(e).__name__
        # str(e) can carry the URL for some errors: redact, then drop the URL anyway.
        detail = redact(str(e), env).replace(url, "***")
        log.warning("%s message not sent: %s (%s)", channel, reason, detail[:200])


def notify(text, env, *, telegram_api=TELEGRAM_API):
    try:
        env = env or {}
        text = redact(text, env)
        hook = (env.get("SLACK_WEBHOOK_URL") or "").strip()
        if hook:
            _send("Slack", hook, {"text": text}, env)
        else:
            log.warning("Slack message not sent: SLACK_WEBHOOK_URL is not set")
        token = (env.get("TELEGRAM_TOKEN") or "").strip()
        chat = (env.get("ADMIN_CHAT_ID") or "").strip()
        if token and chat:
            url = "%s/bot%s/sendMessage" % (telegram_api.rstrip("/"), token)
            _send("Telegram", url, {"chat_id": chat, "text": text}, env)
    except Exception as e:  # never let a message break an update
        log.warning("message not sent: %s", type(e).__name__)
