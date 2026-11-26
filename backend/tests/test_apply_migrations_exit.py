"""`flask apply-migrations` must exit non-zero when a migration fails.

    cd backend && python -m pytest tests/test_apply_migrations_exit.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flask import Flask  # noqa: E402

from app import migrations_runner  # noqa: E402


def _invoke(monkeypatch, failures):
    monkeypatch.setattr(migrations_runner, 'apply_migrations',
                        lambda **kw: (0, 1, failures))
    app = Flask(__name__)
    migrations_runner.register_migration_commands(app)
    return app.test_cli_runner().invoke(args=['apply-migrations'])


def test_failed_migration_exits_nonzero(monkeypatch):
    result = _invoke(monkeypatch, ['002'])
    assert result.exit_code == 1
    assert 'MIGRATIONS FAILED: 002' in result.output


def test_clean_run_exits_zero(monkeypatch):
    assert _invoke(monkeypatch, []).exit_code == 0
