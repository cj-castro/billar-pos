@echo off
REM =============================================================================
REM Run-Install-All-Native-Services.bat
REM Double-click launcher for install-all-native-services.ps1 (Phase 2 staging
REM installer). Handles the "Run as Administrator" prompt for you so staff
REM never need to open PowerShell manually or type any commands.
REM
REM What happens when you double-click this file:
REM   1. Windows asks "Do you want to allow this app to make changes to your
REM      device?" -- click YES. (This is normal and required -- installing
REM      services always needs Administrator permission.)
REM   2. A window opens and runs the installer. This can take several minutes
REM      the first time. Just wait for it to finish.
REM   3. When it's done, press any key in that window to close it.
REM
REM If you're not sure what to do, stop and contact Girish before continuing.
REM =============================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0install-all-native-services.ps1\"' -Verb RunAs -Wait"

echo.
echo ============================================================
echo  The installer window has closed. If it finished successfully
echo  you're done. If something went wrong, check the logs folder
echo  next to this file, or contact Girish.
echo ============================================================
pause
