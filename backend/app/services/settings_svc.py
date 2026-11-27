"""Typed access to the `settings` key/value table.

The table stores everything as text, so every consumer was re-implementing its
own truthiness check. Centralising it keeps 'true' / '1' / 'on' equivalent and
guarantees a missing row or an unreachable database degrades to the caller's
default instead of raising inside a request or a background greenlet.
"""
from ..models.setting import Setting

_TRUTHY = {'1', 'true', 't', 'yes', 'y', 'on'}

# Physical bar printing has been off since the bar switched to screen-only
# service, so the flag defaults to False and the setting turns it back ON.
# Defaulting to True would start printing chits on every existing install the
# moment this ships.
PRINT_BAR_TICKETS = 'print_bar_tickets'


def get_bool(key: str, default: bool = False) -> bool:
    try:
        row = Setting.query.get(key)
    except Exception:
        return default
    if row is None or row.value is None or str(row.value).strip() == '':
        return default
    return is_truthy(row.value)


def is_truthy(value) -> bool:
    """'1' / 'true' / 'on' / 'yes' ... (case and spaces ignored)."""
    return str(value).strip().lower() in _TRUTHY


def get_int(key: str, default: int = 0) -> int:
    """Whole-number setting; a missing, blank or non-numeric row gives `default`."""
    try:
        row = Setting.query.get(key)
    except Exception:
        return default
    if row is None or row.value is None:
        return default
    try:
        return int(str(row.value).strip())
    except ValueError:
        return default


def should_print(routing_dest: str) -> bool:
    """Is the thermal printer allowed to receive chits for this destination?

    KITCHEN always prints. BAR is gated on print_bar_tickets so a manager can
    turn the bar printer on or off without a deploy.
    """
    if (routing_dest or '').upper() != 'BAR':
        return True
    return get_bool(PRINT_BAR_TICKETS, False)
