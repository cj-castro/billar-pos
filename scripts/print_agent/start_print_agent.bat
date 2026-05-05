@echo off
:: ============================================================
::  Bola 8 Print Agent - Startup Script
::  Configures dual-printer routing and starts the agent.
::
::  Printer names must match EXACTLY as shown in Windows
::  Settings > Printers & scanners.
:: ============================================================

:: --- Default printer (receipts, bar chits, reprints) ---
set PRINTER_NAME=La Barra

:: --- Kitchen printer (COCINA chits only) ---
set KITCHEN_PRINTER_NAME=Cocina Comandas

:: --- Port (change only if 9191 is in use) ---
set PRINT_PORT=9191

echo ============================================================
echo   Bola 8 Print Agent
echo   Receipt / Bar printer : %PRINTER_NAME%
echo   Kitchen printer       : %KITCHEN_PRINTER_NAME%
echo   Port                  : %PRINT_PORT%
echo ============================================================
echo.

:: Check Python is available
where python >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3.10+ and try again.
    pause
    exit /b 1
)

:: Install/verify dependencies
echo Installing dependencies...
python -m pip install flask pywin32 --quiet

echo.
echo Starting print agent... (press Ctrl+C to stop)
echo.

python "%~dp0print_agent.py"

pause
