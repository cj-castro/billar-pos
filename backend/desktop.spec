# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for BilliardBar POS backend
# Run: pyinstaller desktop.spec

block_cipher = None

a = Analysis(
    ['desktop.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('app', 'app'),                              # Flask app module
        ('../frontend/dist', 'frontend/dist'),        # Bundled React SPA
    ],
    hiddenimports=[
        # jaraco — required by setuptools/pkg_resources at runtime inside PyInstaller
        'jaraco.text',
        'jaraco.functools',
        'jaraco.classes',
        'jaraco.classes.properties',
        'jaraco.context',
        # Flask ecosystem
        'flask',
        'flask.templating',
        'flask_sqlalchemy',
        'flask_migrate',
        'flask_jwt_extended',
        'flask_socketio',
        'flask_cors',
        'flask_limiter',
        # SQLAlchemy / PostgreSQL
        'sqlalchemy',
        'sqlalchemy.dialects.postgresql',
        'sqlalchemy.dialects.postgresql.psycopg2',
        'sqlalchemy.orm',
        'sqlalchemy.ext.declarative',
        'psycopg2',
        # Eventlet async
        'eventlet',
        'eventlet.hubs',
        'eventlet.hubs.epolls',
        'eventlet.hubs.kqueue',
        'eventlet.hubs.selects',
        'eventlet.green',
        'eventlet.green.socket',
        'eventlet.green.ssl',
        'dns',
        'dns.asyncquery',
        'dns.asyncresolver',
        'dns.resolver',
        # Marshmallow / bcrypt
        'marshmallow',
        'bcrypt',
        # Alembic / migrations
        'alembic',
        'alembic.config',
        'alembic.runtime.migration',
        # Misc
        'python_dateutil',
        'dateutil',
        'dotenv',
        'greenlet',
        'limits',
        'limits.storage',
        'limits.strategies',
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
    console=False,      # No console window in production
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
