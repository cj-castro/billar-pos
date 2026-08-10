"""Per-printer circuit breaker: after repeated failures, fail fast instead
of repeating a call that's likely to hang or fail again — e.g. the
Bluetooth-paired kitchen printer dropping its pairing mid-service."""
import time

_FAILURE_THRESHOLD = 3
_COOLDOWN_SECONDS = 30.0

_state: dict = {}  # printer_name -> {'failures': int, 'opened_at': float|None}


def _get(printer_name: str) -> dict:
    return _state.setdefault(printer_name, {'failures': 0, 'opened_at': None})


def is_open(printer_name: str) -> bool:
    """True if this printer should be skipped (too many recent failures)."""
    s = _get(printer_name)
    if s['opened_at'] is None:
        return False
    if time.time() - s['opened_at'] >= _COOLDOWN_SECONDS:
        s['opened_at'] = None
        s['failures'] = 0
        return False
    return True


def record_success(printer_name: str) -> None:
    _state[printer_name] = {'failures': 0, 'opened_at': None}


def record_failure(printer_name: str) -> None:
    s = _get(printer_name)
    s['failures'] += 1
    if s['failures'] >= _FAILURE_THRESHOLD and s['opened_at'] is None:
        s['opened_at'] = time.time()
