@echo off
REM ============================================================================
REM JARVIS hub supervisor (zero-dependency watchdog).
REM
REM Runs jarvis-core.mjs in the FOREGROUND and relaunches it whenever node exits
REM -- whether from a crash or an intentional `jarvis shutdown`. A 2s pause lets
REM TCP port 8124 fully release so the relaunch never hits EADDRINUSE.
REM
REM   Use this INSTEAD of start-jarvis.cmd when you want crash auto-recovery.
REM   To stop the hub for good: close this window, or press Ctrl+C and answer Y.
REM
REM Operational note: under this watchdog, `jarvis shutdown` becomes a RESTART
REM (node exits, the loop brings it back with whatever source is on disk) -- which
REM is also the simplest deploy: edit source, say "jarvis shutdown", done. The
REM console's WIND DOWN button is the exception: it writes a STOP sentinel so the
REM watchdog does a REAL stop (see :loop below) instead of relaunching.
REM
REM Boot-persistence (start automatically at Windows logon) is NOT handled here.
REM Pick one, in increasing robustness:
REM   * Logon shortcut: put a shortcut to this file in  shell:startup
REM   * Scheduled Task (no admin, per-user logon):
REM       schtasks /create /tn JarvisHub /sc onlogon /tr "\"%~f0\""
REM   * Windows service (survives logoff, needs admin + nssm.exe):
REM       nssm install JarvisHub node "%~dp0jarvis-core.mjs"
REM       nssm set JarvisHub AppDirectory "%~dp0"
REM       nssm set JarvisHub AppEnvironmentExtra JARVIS_REAL_USAGE=1
REM ============================================================================
set JARVIS_REAL_USAGE=1
set JARVIS_LINK_EMAIL=chris.vinciguerra@tai-software.com
cd /d "%~dp0"
:loop
echo [watchdog] starting jarvis-core at %date% %time%
echo ===== watchdog launch %date% %time% ===== >> "%LOCALAPPDATA%\jarvis\watchdog.log"
node jarvis-core.mjs >> "%LOCALAPPDATA%\jarvis\watchdog.log" 2>&1
REM A wind-down writes a STOP sentinel (in %LOCALAPPDATA%\jarvis, the default JARVIS_DATA) to
REM signal a REAL stop rather than a restart. If present, delete it and exit instead of relaunching.
if exist "%LOCALAPPDATA%\jarvis\STOP" ( echo [watchdog] WIND-DOWN stop sentinel found -- stopping for the night. & del /q "%LOCALAPPDATA%\jarvis\STOP" >nul 2>&1 & goto end )
echo [watchdog] jarvis-core exited (code %errorlevel%) -- relaunching in 2s. Ctrl+C to stop.
timeout /t 2 /nobreak >nul
goto loop
:end
