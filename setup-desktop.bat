@echo off
setlocal

echo.
echo ============================================
echo  BilliardBar POS - Desktop Setup
echo ============================================
echo.

:: Create database (ignore error if already exists)
echo [1/4] Creating PostgreSQL database...
psql -U postgres -c "CREATE DATABASE billiardbar;" 2>nul
if %errorlevel% neq 0 (
    echo       Database already exists or could not be created. Continuing...
)

:: Install Python dependencies
echo [2/4] Installing Python dependencies...
cd backend
pip install -r requirements.txt --quiet

:: Init DB schema
echo [3/4] Initializing database schema...
set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/billiardbar
set FLASK_APP=wsgi.py
flask init-db

:: Seed default data
echo [4/4] Seeding default data...
python seed.py

echo.
echo ============================================
echo  Setup complete!
echo.
echo  Default login: admin / admin123
echo.
echo  Next steps:
echo    1. cd frontend ^& npm install ^& npm run build
echo    2. cd electron ^& npm install
echo    3. cd electron ^& npm start
echo ============================================
echo.

cd ..
endlocal
