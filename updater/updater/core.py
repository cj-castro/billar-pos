"""Pure updater logic: no Docker, no network. Stdlib only."""
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_SQUASHED_RE = re.compile(r"^0(2[7-9]|3[0-9])[a-z]?$")
_BACKUP_RE = re.compile(r"^pre-update-.+-(\d{8}-\d{4})\.dump$")


@dataclass
class Release:
    sha: str
    built_at: str
    migrations: list


def parse_release(text: str) -> Release:
    try:
        data = json.loads(text)
    except (TypeError, ValueError) as e:
        raise ValueError("release.json is not valid JSON") from e
    if not isinstance(data, dict):
        raise ValueError("release.json must be an object")
    for key in ("sha", "built_at", "migrations"):
        if key not in data:
            raise ValueError("release.json is missing key: " + key)
    sha = data["sha"]
    if not isinstance(sha, str) or not _SHA_RE.match(sha):
        raise ValueError("release.json sha must be 40 hex characters")
    if not isinstance(data["migrations"], list):
        raise ValueError("release.json migrations must be a list")
    return Release(sha=sha, built_at=str(data["built_at"]),
                   migrations=[str(m) for m in data["migrations"]])


@dataclass
class State:
    current_sha: str = None
    previous_sha: str = None
    in_progress: dict = None
    last_result: str = None
    # {sha, outcome, backup_path, host_backup_path, at}: a version whose update
    # failed is not retried by itself (after rollback_failed: no version is).
    failed: dict = None
    # {old_sha, new_sha, path, date}: the dump made in today's window for this
    # old->new pair; an hourly retry dumps into the same file, not a new one.
    window_backup: dict = None


def load_state(path) -> State:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return State()
    return State(
        current_sha=data.get("current_sha"),
        previous_sha=data.get("previous_sha"),
        in_progress=data.get("in_progress"),
        last_result=data.get("last_result"),
        failed=data.get("failed"),
        window_backup=data.get("window_backup"),
    )


def save_state(path, state: State) -> None:
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "current_sha": state.current_sha,
            "previous_sha": state.previous_sha,
            "in_progress": state.in_progress,
            "last_result": state.last_result,
            "failed": state.failed,
            "window_backup": state.window_backup,
        }, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def decide(release: Release, state: State, live_db_versions: set) -> str:
    if state.current_sha == release.sha:
        return "noop"
    known = set(release.migrations)
    for v in live_db_versions:
        if v not in known and not _SQUASHED_RE.match(v):
            return "older_than_db"
    return "install"


def in_window(now: datetime, start_h=3, end_h=12) -> bool:
    return start_h <= now.hour < end_h


def _short(sha) -> str:
    return sha[:7] if sha else "none"


def backup_name(old_sha, new_sha: str, now: datetime) -> str:
    return "pre-update-%s-to-%s-%s.dump" % (
        _short(old_sha), _short(new_sha), now.strftime("%Y%m%d-%H%M"))


def prune_backups(names: list, keep=10) -> list:
    found = []
    for n in names:
        m = _BACKUP_RE.match(n)
        if m:
            found.append((m.group(1), n))
    found.sort()
    excess = len(found) - keep
    return [n for _, n in found[:excess]] if excess > 0 else []


def message(kind: str, **kw) -> str:
    old = _short(kw.get("old_sha"))
    new = _short(kw.get("new_sha"))
    step = kw.get("step") or "?"
    error = kw.get("error")
    detail = (": %s" % error) if error else ""
    texts = {
        "installed": "POS actualizado: %s -> %s. Todo funciona." % (old, new),
        # blocked_open, registry_down, db_unreachable: retried every hour during
        # 03:00-12:00; the message is posted once, when the window has closed.
        "blocked_open": "Actualización a %s pospuesta: hubo mesas o cuentas abiertas toda la mañana (versión actual %s). No se cambió nada; se reintenta mañana a las 03:00." % (new, old),
        "registry_down": "No se pudo consultar el registro de imágenes para %s en toda la mañana (versión actual %s)%s. No se cambió nada; se reintenta mañana a las 03:00." % (new, old, detail),
        "db_unreachable": "No se pudo leer la base de datos antes de actualizar a %s (versión actual %s)%s. No se cambió nada; se reintenta mañana a las 03:00." % (new, old, detail),
        "backup_failed": "Falló el respaldo antes de actualizar a %s; no se cambió nada (versión actual %s)%s." % (new, old, detail),
        "rehearsal_failed": "El ensayo de la actualización a %s falló; no se cambió nada (versión actual %s)%s." % (new, old, detail),
        "rolled_back": "Falló %s al actualizar a %s%s. Se regresó a %s y el POS funciona." % (step, new, detail, old),
        "rollback_failed": "POS caído: falló %s al actualizar a %s y no se pudo regresar a %s%s. Se necesita ayuda ya." % (step, new, old, detail),
        "older_than_db": "No se instaló %s: la base de datos tiene migraciones más nuevas que esa versión (versión actual %s)." % (new, old),
        # A resume after a reboot that would need a database restore, but the
        # bar may be selling (something open, unreadable, or outside 03:00-12:00).
        "resume_held": "POS requiere atención: la actualización de %s a %s se interrumpió (reinicio o corte de luz) y no quedó confirmada%s. No se restauró la base de datos ni se detuvo nada, para no borrar ventas. El actualizador queda en pausa para todas las versiones hasta revisar y correr run-now --force." % (old, new, detail),
    }
    if kind not in texts:
        raise ValueError("unknown message kind: " + str(kind))
    return texts[kind]
