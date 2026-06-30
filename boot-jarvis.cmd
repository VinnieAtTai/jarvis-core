@echo off
cd /d "%~dp0"
del /q "%LOCALAPPDATA%\jarvis\STOP" >nul 2>&1
"C:\Program Files\nodejs\node.exe" spawn-hub-detached.mjs
