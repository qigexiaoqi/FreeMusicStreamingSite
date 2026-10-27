@echo off
rem ============================================================
rem  FreeMusicStreamingSite - local launcher
rem  Keep this file plain ASCII: cmd.exe parses .bat in the OEM
rem  code page, so non-ASCII text here would break the script.
rem ============================================================
setlocal
cd /d "%~dp0"
title FreeMusicStreamingSite

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)

if not defined PY (
    echo.
    echo   [ERROR] Python 3.8+ not found on this machine.
    echo           Download: https://www.python.org/downloads/
    echo           During setup, check "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

%PY% server.py %*

if errorlevel 1 (
    echo.
    echo   [ERROR] Server exited unexpectedly. See messages above.
    pause
)
endlocal
