"""Durable job-id dedup store — survives agent restarts (crash, NSSM bounce,
Windows update) where an in-memory dict would silently forget in-flight jobs."""
import sqlite3
import time
import os

_DB_PATH = os.path.join(os.path.dirname(__file__), 'dedup.sqlite3')
_TTL_SECONDS = 60.0


def _connect():
    conn = sqlite3.connect(_DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS printed_jobs (job_id TEXT PRIMARY KEY, printed_at REAL NOT NULL)"
    )
    return conn


def was_printed(job_id) -> bool:
    """Return True if job_id was recorded within the TTL window."""
    if not job_id:
        return False
    now = time.time()
    conn = _connect()
    try:
        conn.execute("DELETE FROM printed_jobs WHERE printed_at < ?", (now - _TTL_SECONDS,))
        conn.commit()
        row = conn.execute("SELECT 1 FROM printed_jobs WHERE job_id = ?", (job_id,)).fetchone()
        return row is not None
    finally:
        conn.close()


def record_printed(job_id) -> None:
    if not job_id:
        return
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO printed_jobs (job_id, printed_at) VALUES (?, ?)",
            (job_id, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
