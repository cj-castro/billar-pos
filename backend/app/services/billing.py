import math
from datetime import datetime, timezone


def calculate_charge(start_time: datetime, end_time: datetime,
                     billing_mode: str, rate_cents: int,
                     promo_free_seconds: int = 0) -> dict:
    """
    rate_cents = pesos per HOUR (e.g. 8600 = $86/hr).
    All modes derive per-minute cost as rate_cents / 60.
    """
    raw_seconds = int((end_time - start_time).total_seconds())
    raw_seconds = max(0, raw_seconds - promo_free_seconds)

    rate_per_minute = rate_cents / 60.0   # fractional cents per minute

    if billing_mode == 'PER_MINUTE':
        minutes = raw_seconds / 60.0
        charge = int(round(minutes * rate_per_minute))
    elif billing_mode == 'ROUND_15':
        minutes = math.ceil(raw_seconds / 60)
        rounded = math.ceil(minutes / 15) * 15 if minutes > 0 else 0
        charge = int(round(rounded * rate_per_minute))
    elif billing_mode == 'PER_HOUR':
        hours = math.ceil(raw_seconds / 3600) if raw_seconds > 0 else 0
        charge = hours * rate_cents
    else:
        charge = 0

    total_seconds = int((end_time - start_time).total_seconds())

    return {
        'duration_seconds': total_seconds,
        'charge_cents': charge
    }
