"""The venue: name, timezone, currency, locale, logo (batch D1).

Everything that used to be hard-coded to one bar -- "Bola 8", America/Mexico_City,
pesos -- comes from here, so the same build can run in any pool hall.

Source of truth: the `settings` table (keys venue.*), editable by the owner in
Ajustes. Defaults come from the install's environment, so an existing install
keeps behaving exactly as before until someone changes a setting:

    venue.name      <- VENUE_NAME   (default 'Mi Billar')
    venue.timezone  <- TZ           (default America/Mexico_City)
    venue.currency  <- CURRENCY     (default MXN)
    venue.locale    <- LOCALE       (default es-MX)
    venue.logo      (data URL uploaded in Ajustes; none = the build's default logo)

SQL has the same answer through fn_bar_tz() (migration 045). ensure_defaults()
copies the environment defaults into the table so both sides always agree.
"""
import os
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import g, has_request_context

from app.extensions import db
from app.models.setting import Setting

KEYS = ('venue.name', 'venue.timezone', 'venue.currency', 'venue.locale', 'venue.logo',
        'venue.day_cutoff')
_LOGO_MAX_BYTES = 300_000          # a data URL; the UI downsizes before upload


def _env_defaults() -> dict:
    return {
        'venue.name': os.environ.get('VENUE_NAME') or 'Mi Billar',
        'venue.timezone': os.environ.get('TZ') or 'America/Mexico_City',
        'venue.currency': (os.environ.get('CURRENCY') or 'MXN').upper(),
        'venue.locale': os.environ.get('LOCALE') or 'es-MX',
        'venue.logo': '',
        # Closing hour: sales before it belong to the previous business day.
        # 00:00 = calendar days (the behaviour before this setting existed).
        'venue.day_cutoff': os.environ.get('DAY_CUTOFF') or '00:00',
    }


def get_venue() -> dict:
    """Current venue settings (one query, cached for the request)."""
    if has_request_context() and getattr(g, '_venue', None) is not None:
        return g._venue
    vals = _env_defaults()
    try:
        for row in Setting.query.filter(Setting.key.in_(KEYS)).all():
            if row.value not in (None, ''):
                vals[row.key] = row.value
    except Exception:                                    # noqa: BLE001
        # No app context / DB unreachable: degrade to the environment defaults.
        try:
            db.session.rollback()
        except Exception:                                # noqa: BLE001
            pass
    venue = {
        'name': vals['venue.name'],
        'timezone': vals['venue.timezone'] if _valid_tz(vals['venue.timezone']) else 'America/Mexico_City',
        'currency': vals['venue.currency'],
        'locale': vals['venue.locale'],
        'logo': vals['venue.logo'] or None,
        'day_cutoff': vals['venue.day_cutoff'] if _CUTOFF_RE.fullmatch(vals['venue.day_cutoff'] or '') else '00:00',
    }
    if has_request_context():
        g._venue = venue
    return venue


def invalidate() -> None:
    """Forget the cached venue (call after saving a venue.* setting).

    The cache lives on flask.g, i.e. the APP context -- one per HTTP request in
    production, but shared across calls when code runs inside one long context
    (tests, CLI). Without this, a value saved there would not be seen again.
    """
    if has_request_context():
        g.pop('_venue', None)


def bar_tz() -> ZoneInfo:
    """The bar's timezone. Use this instead of Config.TZ / a literal."""
    return ZoneInfo(get_venue()['timezone'])


_CUTOFF_RE = re.compile(r'([01][0-9]|2[0-3]):[0-5][0-9]')


def cutoff() -> timedelta:
    """The closing hour as an offset from midnight (same as SQL fn_bar_cutoff())."""
    h, m = get_venue()['day_cutoff'].split(':')
    return timedelta(hours=int(h), minutes=int(m))


def business_today() -> date:
    """Today's BUSINESS day: at 01:30 with a 06:00 cutoff it is still yesterday."""
    return (datetime.now(bar_tz()) - cutoff()).date()


def business_day_start(d: date) -> datetime:
    """UTC instant when business day `d` begins (its date at the closing hour)."""
    local = datetime.combine(d, time(0), tzinfo=bar_tz()) + cutoff()
    return local.astimezone(timezone.utc)


def business_day_bounds(d: date) -> tuple[datetime, datetime]:
    """[start, end) of business day `d` in UTC -- use for any 'sales of day X'."""
    return business_day_start(d), business_day_start(d + timedelta(days=1))


def _valid_tz(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return False


def validate(key: str, value: str) -> str | None:
    """Error message for a bad venue value, or None if it is fine."""
    if key == 'venue.name' and not value.strip():
        return 'El nombre no puede estar vacío'
    if key == 'venue.name' and len(value) > 80:
        return 'El nombre es demasiado largo (máx. 80)'
    if key == 'venue.timezone' and not _valid_tz(value):
        return f'Zona horaria desconocida: {value}'
    if key == 'venue.currency' and not re.fullmatch(r'[A-Z]{3}', value):
        return 'La moneda debe ser un código de 3 letras (MXN, USD, COP…)'
    if key == 'venue.locale' and not re.fullmatch(r'[a-z]{2}(-[A-Z]{2})?', value):
        return 'Idioma/región inválido (p. ej. es-MX)'
    if key == 'venue.day_cutoff' and not _CUTOFF_RE.fullmatch(value):
        return 'La hora de cierre debe tener formato HH:MM (p. ej. 06:00)'
    if key == 'venue.logo' and value and not (
            value.startswith('data:image/') and len(value) <= _LOGO_MAX_BYTES):
        return 'El logo debe ser una imagen de menos de 300 KB'
    return None


def ensure_defaults() -> int:
    """Insert missing venue.* rows from the environment (never overwrites).

    Called after migrations so fn_bar_tz() in SQL sees the same timezone the
    Python side would fall back to. Returns how many rows were created.
    """
    created = 0
    existing = {r.key for r in Setting.query.filter(Setting.key.in_(KEYS)).all()}
    for key, value in _env_defaults().items():
        if key not in existing and key != 'venue.logo':
            db.session.add(Setting(key=key, value=value))
            created += 1
    db.session.commit()
    return created
