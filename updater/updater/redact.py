"""Hide secret values in text before it is logged, returned or sent. Stdlib only."""
import os

SECRET_KEYS = ("GHCR_TOKEN", "SLACK_WEBHOOK_URL", "TELEGRAM_TOKEN", "POSTGRES_PASSWORD")
MASK = "***"


def redact(text, *envs):
    """Replace every non-empty value of SECRET_KEYS found in `envs` with ***.

    With no `envs`, the process environment is used. Empty or blank values are
    ignored (replacing "" would insert *** between every character).
    """
    if not text:
        return text
    if not envs:
        envs = (os.environ,)
    values = set()
    for env in envs:
        for key in SECRET_KEYS:
            v = (env or {}).get(key)
            if isinstance(v, str) and v.strip():
                values.add(v)
                values.add(v.strip())
    for v in sorted(values, key=len, reverse=True):
        text = text.replace(v, MASK)
    return text
