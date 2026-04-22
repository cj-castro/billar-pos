# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for BilliardBar POS backend
# Run: pyinstaller desktop.spec

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

# ---------------------------------------------------------------------------
# Collect submodules that use dynamic imports PyInstaller's static analyser
# misses.  Each collect_submodules() call returns a list of dotted names.
# ---------------------------------------------------------------------------
hidden = []

# setuptools._vendor contains jaraco.* vendored inside setuptools itself.
# Importing the top-level jaraco.* names is not enough because pyi_rth_pkgres
# resolves them through the vendor tree at runtime.
hidden += collect_submodules('setuptools')
hidden += collect_submodules('setuptools._vendor')
hidden += collect_submodules('pkg_resources')

# Socket.IO / Engine.IO — both use dynamic namespace discovery
hidden += collect_submodules('socketio')
hidden += collect_submodules('engineio')
hidden += collect_submodules('flask_socketio')

# eventlet hub selection is done at import time based on the platform
hidden += collect_submodules('eventlet')
hidden += collect_submodules('eventlet.hubs')
hidden += collect_submodules('eventlet.green')
hidden += collect_submodules('dns')          # dnspython — eventlet async DNS

# SQLAlchemy dialect plugins are loaded by string at runtime
hidden += collect_submodules('sqlalchemy')
hidden += collect_submodules('sqlalchemy.dialects')

# flask-limiter storage backends (memory, redis, …)
hidden += collect_submodules('limits')
hidden += collect_submodules('limits.storage')

# Alembic migration engine — env.py and script templates loaded at runtime
hidden += collect_submodules('alembic')

# marshmallow field registry uses dynamic class lookup
hidden += collect_submodules('marshmallow')

# ---------------------------------------------------------------------------
# Extra data files (non-Python assets that must travel with the bundle)
# ---------------------------------------------------------------------------
extra_datas = []
extra_datas += collect_data_files('alembic')       # SQL script templates
extra_datas += collect_data_files('sqlalchemy')    # type stubs / json files
extra_datas += collect_data_files('limits')        # storage config assets

a = Analysis(
    ['desktop.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('app', 'app'),                              # Flask app module
        ('../frontend/dist', 'frontend/dist'),        # Bundled React SPA
    ] + extra_datas,
    hiddenimports=hidden + [
        # Explicit safety net for imports that collect_submodules can still miss
        # because they live behind try/except or importlib.import_module() calls.

        # psycopg2 C extension (the _psycopg .pyd must be present)
        'psycopg2',
        'psycopg2._psycopg',
        'psycopg2.extensions',
        'psycopg2.extras',

        # bcrypt C extension
        'bcrypt',
        'bcrypt._bcrypt',

        # greenlet — C extension used by SQLAlchemy and eventlet
        'greenlet',

        # bidict — used internally by python-socketio
        'bidict',

        # dateutil / python-dateutil
        'dateutil',
        'dateutil.parser',
        'dateutil.tz',

        # python-dotenv
        'dotenv',

        # Flask internals sometimes missed on Windows
        'flask',
        'flask.templating',
        'flask_sqlalchemy',
        'flask_migrate',
        'flask_jwt_extended',
        'flask_cors',
        'flask_limiter',

        # Cryptography (used by JWT / bcrypt)
        'cryptography',
        'cryptography.hazmat.primitives',
        'cryptography.hazmat.backends',
        'cryptography.hazmat.backends.openssl',
        'cryptography.hazmat.backends.openssl.backend',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'unittest', 'test'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='billiardbar-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='billiardbar-backend',
)
