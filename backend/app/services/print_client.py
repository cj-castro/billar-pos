"""Shared HTTP client for talking to the Windows print agent.
Used by both tickets.py and queue.py so the auth header, timeout, and error
classification logic live in exactly one place."""
import os
import json
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

PRINT_AGENT_URL = os.environ.get('PRINT_AGENT_URL', 'http://127.0.0.1:9191')
PRINT_AGENT_TOKEN = os.environ.get('PRINT_AGENT_TOKEN', '')

ERROR_AGENT_UNREACHABLE = 'AGENT_UNREACHABLE'
ERROR_PRINTER_OFFLINE   = 'PRINTER_OFFLINE'
ERROR_PRINTER_ERROR     = 'PRINTER_ERROR'
ERROR_UNKNOWN           = 'PRINT_UNKNOWN'


def send_print_job(endpoint: str, payload: dict, timeout: int = 8):
    """POST payload to {PRINT_AGENT_URL}{endpoint}.

    Returns (ok, error_code, error_message). Never raises — every failure
    mode is caught and classified.
    """
    body = json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if PRINT_AGENT_TOKEN:
        headers['X-Print-Token'] = PRINT_AGENT_TOKEN
    req = Request(f'{PRINT_AGENT_URL}{endpoint}', data=body, headers=headers, method='POST')

    try:
        with urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return True, None, None
            return False, ERROR_UNKNOWN, resp.read().decode()
    except HTTPError as http_err:
        try:
            detail = http_err.read().decode()
        except Exception:
            detail = str(http_err)
        if http_err.code == 401:
            return False, ERROR_UNKNOWN, f'Print agent rejected the request (401): {detail}'
        if 'offline' in detail.lower() or 'not found' in detail.lower():
            return False, ERROR_PRINTER_OFFLINE, f'Print agent error ({http_err.code}): {detail}'
        return False, ERROR_PRINTER_ERROR, f'Print agent error ({http_err.code}): {detail}'
    except URLError:
        return False, ERROR_AGENT_UNREACHABLE, 'Print agent not running. Start it on the Windows host.'
    except Exception as exc:
        return False, ERROR_UNKNOWN, str(exc)
