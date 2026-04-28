import os
from datetime import timedelta

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL', 'postgresql://billiard:billiard@localhost:5432/billiardbar')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-me')
    JWT_REFRESH_SECRET_KEY = os.environ.get('JWT_REFRESH_SECRET', 'dev-refresh-secret')
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(hours=int(os.environ.get('JWT_ACCESS_HOURS', 8)))

    # Flask-Limiter: use in-memory storage explicitly (avoids warning)
    RATELIMIT_STORAGE_URI = os.environ.get('RATELIMIT_STORAGE_URI', 'memory://')

    BILLING_MODE = os.environ.get('BILLING_MODE', 'PER_MINUTE')
    POOL_RATE_CENTS = int(os.environ.get('POOL_RATE_CENTS', 150))
    HAPPY_HOUR_START = os.environ.get('HAPPY_HOUR_START', '17:00')
    HAPPY_HOUR_END = os.environ.get('HAPPY_HOUR_END', '20:00')
    HAPPY_HOUR_DISCOUNT_PCT = int(os.environ.get('HAPPY_HOUR_DISCOUNT_PCT', 20))
    CURRENCY = os.environ.get('CURRENCY', 'USD')
    TZ = os.environ.get('TZ', 'America/Mexico_City')
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
