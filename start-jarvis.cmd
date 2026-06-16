@echo off
rem Runtime state lives in %LOCALAPPDATA%\jarvis (outside the repo) by default; set JARVIS_DATA to override.
set JARVIS_REAL_USAGE=1
set JARVIS_LINK_EMAIL=chris.vinciguerra@tai-software.com
cd /d "%~dp0"
start "jarvis-core" /min node jarvis-core.mjs
