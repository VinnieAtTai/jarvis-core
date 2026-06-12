@echo off
set JARVIS_REAL_USAGE=1
set JARVIS_LINK_EMAIL=chris.vinciguerra@tai-software.com
cd /d "%~dp0"
start "jarvis-core" /min node jarvis-core.mjs
