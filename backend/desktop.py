import os
import sys
from pathlib import Path


def _load_appdata_env():
    """Safety net: load .env from AppData if DATABASE_URL not already in environment.

    In normal operation Electron passes env vars directly; this covers the case
    where the binary is launched manually outside of Electron.
    """
    if 'DATABASE_URL' in os.environ:
        return
    try:
        appdata = os.environ.get('APPDATA') or str(Path.home() / 'AppData' / 'Roaming')
        env_file = Path(appdata) / 'BilliardBarPOS' / '.env'
        if not env_file.exists():
            return
        for line in env_file.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())
    except Exception:
        pass


_load_appdata_env()

from app import create_app          # noqa: E402  (env must be set first)
from app.extensions import socketio, db  # noqa: E402


app = create_app()


def _auto_init_db():
    """Create tables and run idempotent schema migrations on every desktop startup.

    Uses IF NOT EXISTS so it is safe to run repeatedly — no data is lost.
    """
    with app.app_context():
        from sqlalchemy import text

        # Register all models with SQLAlchemy's metadata before create_all
        from app.models import (          # noqa: F401
            User, Resource, PoolTableConfig,
            Ticket, TicketLineItem, LineItemModifier, LineItemPromotion, PoolTimerSession,
            MenuCategory, MenuItem, ModifierGroup, MenuItemModifierGroup, Modifier,
            InventoryItem, ModifierInventoryRule, StockMovement,
            Promotion, AuditLog, CashSession, Expense, TipDistributionConfig,
        )
        from app.models.waiting_list import WaitingListEntry   # noqa: F401
        from app.models.inventory import MenuItemIngredient    # noqa: F401

        try:
            db.create_all()
        except Exception as exc:
            print(f'[desktop] db.create_all failed: {exc}', flush=True)
            return

        migrations = [
            'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_name VARCHAR(200)',
            'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tip_cents INTEGER DEFAULT 0',
            'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS was_reopened BOOLEAN DEFAULT FALSE',
            'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMP WITH TIME ZONE',
            'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopened_by VARCHAR(36)',
            'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS manual_discount_pct INTEGER DEFAULT 0',
            "ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'other'",
            'ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS shots_per_bottle INTEGER',
            'ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS yields_item_id VARCHAR(36)',
            'ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS allow_multiple BOOLEAN DEFAULT FALSE',
        ]
        for stmt in migrations:
            try:
                db.session.execute(text(stmt))
            except Exception:
                db.session.rollback()
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()

        # Seed mandatory singleton rows
        try:
            from app.models.cash_session import TipDistributionConfig as TDC
            if not TDC.query.get(1):
                db.session.add(TDC(id=1))
                db.session.commit()
        except Exception:
            db.session.rollback()

        print('[desktop] Database initialized.', flush=True)


if __name__ == '__main__':
    _auto_init_db()
    socketio.run(
        app,
        host='127.0.0.1',
        port=5000,
        debug=False,
        use_reloader=False,
        log_output=True,
    )
