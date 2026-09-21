"""SQL migration runner — applies backend/migrations/sql/*.sql in manifest order.

WHY THIS EXISTS
---------------
init-db (STEP 1..26) is hand-written idempotent DDL embedded in Python. That
worked while every change was a column add. Migrations 027+ are different: they
create triggers, reference tables, and data corrections that carry ~60 hard
assertions. Re-expressing them as init-db STEPs would mean maintaining two
copies of the same SQL, and the copies would drift.

So the .sql files stay the single source of truth and this runner applies them.
The same files are applied by run_all.sh on the Mac and Invoke-Migrations.ps1 on
the Windows POS, all reading the same manifest.txt, so all three paths converge
on an identical schema.

DESIGN NOTES
------------
* Raw DBAPI cursor, not SQLAlchemy text(). text() parses ':name' as a bind
  parameter, and these files are full of plpgsql. Going straight to psycopg2
  bypasses that entirely.

* autocommit=True so each file's own BEGIN/COMMIT is honoured. Each file is
  therefore one atomic unit: it fully applies or fully rolls back. There is no
  such thing as a half-applied migration here.

* A failure NEVER crashes the container. At a bar, a POS that refuses to boot is
  worse than a POS on last week's schema. Because each file is atomic, a failure
  leaves the database consistent at the last good migration, and every later
  file then fails its own _applied() guard -- a clean, self-limiting cascade.
  Use --strict on a dev machine when you want a non-zero exit instead.

* lock_timeout is set so a migration waiting on a lock held by a live ticket
  gives up instead of blocking the POS indefinitely. It bounds lock WAITING
  only, never execution time, so a slow backfill is never cut short.

FRESH INSTALLS -- READ THIS
---------------------------
Migrations 029b, 031*, 032*, 034* and 035b are data-shaping: they assert against
the real Bola 8 menu ("exactly 11 Servicio options", "Azulito has 3
ingredients"). On a database seeded only with seed.py's demo data those items do
not exist and the assertions correctly refuse to pass.

That is intended. A new machine is provisioned by RESTORING A PRODUCTION DUMP,
not by seeding demo data. A restored dump already carries its schema_migrations
rows, so this runner sees them as applied and does nothing. The demo-seed path
gets the structural migrations and logs the rest as failed -- which is the
honest outcome, not a bug to paper over.
"""
from __future__ import annotations

import os
import re
import time

import click

from .extensions import db

_OK_NOTICE = re.compile(r'\b(\d+[a-z]?)\s+OK\b\s*[-—]*\s*(.*)', re.IGNORECASE)


def _sql_dir() -> str:
    """backend/migrations/sql, resolved relative to this file.

    This module lives at <root>/app/migrations_runner.py, so the SQL sits one
    directory up. Holds both on the Mac (backend/) and in the image (/app).
    """
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), 'migrations', 'sql')


def read_manifest(sql_dir: str | None = None) -> list[str]:
    """Ordered filename stems from manifest.txt. Comments and blanks dropped."""
    sql_dir = sql_dir or _sql_dir()
    path = os.path.join(sql_dir, 'manifest.txt')
    if not os.path.exists(path):
        raise FileNotFoundError(f'migration manifest not found: {path}')

    stems: list[str] = []
    with open(path, 'r', encoding='utf-8') as fh:
        for raw in fh:
            line = raw.split('#', 1)[0].strip()
            if line:
                stems.append(line)
    return stems


def version_of(stem: str) -> str:
    """'031b_modifier_coverage' -> '031b'. Matches what the file registers."""
    return stem.split('_', 1)[0]


def _dbapi_connection(raw):
    """Unwrap SQLAlchemy's pool proxy to the real psycopg2 connection."""
    for attr in ('driver_connection', 'dbapi_connection', 'connection'):
        conn = getattr(raw, attr, None)
        if conn is not None and hasattr(conn, 'cursor'):
            return conn
    return raw


def _applied_versions(conn) -> set[str]:
    """Versions already recorded. Empty set if schema_migrations doesn't exist yet."""
    cur = conn.cursor()
    try:
        cur.execute("SELECT to_regclass('public.schema_migrations') IS NOT NULL")
        if not cur.fetchone()[0]:
            return set()
        cur.execute('SELECT version FROM schema_migrations')
        return {row[0] for row in cur.fetchall()}
    finally:
        cur.close()


def _summarise(notices: list[str]) -> str:
    """Pull the '031b OK -- ...' line a migration prints on success."""
    for note in reversed(notices):
        match = _OK_NOTICE.search(note)
        if match:
            return match.group(0).strip()
    return 'applied'


def apply_migrations(strict: bool = False, dry_run: bool = False,
                     only: str | None = None) -> tuple[int, int, list[str]]:
    """Apply every pending migration. Returns (applied, skipped, failures)."""
    sql_dir = _sql_dir()
    stems = read_manifest(sql_dir)
    if only:
        stems = [s for s in stems if version_of(s) == only]
        if not stems:
            raise click.ClickException(f'no migration with version {only!r} in manifest')

    raw = db.engine.raw_connection()
    conn = _dbapi_connection(raw)
    previous_autocommit = getattr(conn, 'autocommit', False)

    applied = skipped = 0
    failures: list[str] = []

    try:
        conn.autocommit = True

        # Bound lock WAITING only -- never truncates a slow backfill. Without
        # this a migration can sit behind an open ticket's row lock forever and
        # take the container's startup with it.
        cur = conn.cursor()
        cur.execute("SET lock_timeout = '30s'")
        cur.close()

        done = _applied_versions(conn)

        for stem in stems:
            version = version_of(stem)
            path = os.path.join(sql_dir, f'{stem}.sql')

            if version in done:
                skipped += 1
                continue

            if not os.path.exists(path):
                failures.append(version)
                click.echo(f'  {stem:<38} MISSING FILE ({path})')
                continue

            if dry_run:
                click.echo(f'  {stem:<38} would apply')
                applied += 1
                continue

            with open(path, 'r', encoding='utf-8') as fh:
                sql = fh.read()

            if hasattr(conn, 'notices'):
                del conn.notices[:]

            started = time.monotonic()
            cur = conn.cursor()
            try:
                cur.execute(sql)
            except Exception as exc:                      # noqa: BLE001
                failures.append(version)
                first_line = str(exc).strip().splitlines()[0]
                click.echo(f'  {stem:<38} FAILED  {first_line}')

                # The file opened an explicit BEGIN, so the error left the
                # SERVER inside an aborted transaction even though psycopg2 is
                # in autocommit mode and believes there is none. conn.rollback()
                # is a no-op in that state, so the ROLLBACK has to be sent as a
                # statement. Skip this and every later migration dies with
                # "current transaction is aborted" instead of its real reason --
                # which hides which migration actually broke.
                try:
                    cleanup = conn.cursor()
                    cleanup.execute('ROLLBACK')
                    cleanup.close()
                except Exception:                         # noqa: BLE001
                    pass
                continue
            finally:
                cur.close()

            elapsed = (time.monotonic() - started) * 1000
            notices = list(getattr(conn, 'notices', []))
            click.echo(f'  {stem:<38} {_summarise(notices)}  ({elapsed:.0f} ms)')
            applied += 1
            done.add(version)

    finally:
        try:
            conn.autocommit = previous_autocommit
        except Exception:                                  # noqa: BLE001
            pass
        raw.close()

    if failures and strict:
        raise SystemExit(1)

    return applied, skipped, failures


def register_migration_commands(app):
    """Wire `flask apply-migrations` and `flask migration-status` onto the app."""

    @app.cli.command('apply-migrations')
    @click.option('--strict', is_flag=True,
                  help='Exit non-zero if any migration fails. Use on dev, not on the POS.')
    @click.option('--dry-run', is_flag=True,
                  help='List what would be applied without touching the database.')
    @click.option('--only', default=None, metavar='VERSION',
                  help="Apply a single version, e.g. --only 034c. Its own guard still enforces order.")
    def apply_migrations_cmd(strict, dry_run, only):
        """Apply pending SQL migrations from migrations/sql in manifest order."""
        click.echo('Applying SQL migrations...')

        # This command runs from entrypoint.sh under `set -e`. Anything that
        # escapes here -- a missing manifest because the folder was copied
        # incompletely, an unreachable database, a permissions problem -- would
        # exit non-zero and stop the container from booting at all. A POS that
        # will not start is worse than a POS on an older schema, so nothing
        # escapes unless --strict was asked for.
        try:
            applied, skipped, failures = apply_migrations(
                strict=strict, dry_run=dry_run, only=only
            )
        except SystemExit:
            raise                                  # --strict asked for this
        except Exception as exc:                   # noqa: BLE001
            click.echo('')
            click.echo(f'  !! MIGRATION RUNNER FAILED TO START: {exc}')
            click.echo('  !! No migration was attempted, so nothing changed.')
            click.echo('  !! The app will start on the schema already in place.')
            click.echo('')
            if strict:
                raise SystemExit(1) from exc
            return

        click.echo(
            f'Migrations: {applied} applied, {skipped} already present, '
            f'{len(failures)} failed'
        )
        if failures:
            click.echo('')
            click.echo('  !! MIGRATIONS FAILED: ' + ', '.join(failures))
            click.echo('  !! Each file is atomic, so the database is consistent at the')
            click.echo('  !! last successful migration -- nothing is half-applied.')
            click.echo('  !! Run `flask migration-status` for the full picture.')
            click.echo('')

    @app.cli.command('migration-status')
    def migration_status_cmd():
        """Show which migrations are applied and which are pending."""
        raw = db.engine.raw_connection()
        conn = _dbapi_connection(raw)
        try:
            done = _applied_versions(conn)
        finally:
            raw.close()

        stems = read_manifest()
        pending = [s for s in stems if version_of(s) not in done]

        for stem in stems:
            mark = 'applied' if version_of(stem) in done else 'PENDING'
            click.echo(f'  {stem:<38} {mark}')

        click.echo('')
        click.echo(f'{len(stems) - len(pending)}/{len(stems)} applied, {len(pending)} pending')

        # Versions in the database that the manifest doesn't know about. Means
        # the code is older than the database -- a downgrade or a bad copy.
        unknown = sorted(done - {version_of(s) for s in stems})
        if unknown:
            click.echo('')
            click.echo('  !! Database reports migrations this build does not ship: '
                       + ', '.join(unknown))
            click.echo('  !! The code is OLDER than the database. Do not run init-db.')
