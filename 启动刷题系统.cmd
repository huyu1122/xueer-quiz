@echo off
rem ============================================================
rem  XueEr Quiz - one-click launcher (Windows)
rem
rem  NOTE 1: This file is intentionally ASCII-only.
rem    cmd.exe parses .cmd files using the system OEM code page
rem    (e.g. 936/GBK on Chinese Windows), so non-ASCII text here
rem    would be mis-decoded and can break block parsing.
rem    All Chinese user-facing output is printed by Node instead.
rem
rem  NOTE 2: No "for %%p in ( ... )" block is used for the Node
rem    path list, because "%ProgramFiles(x86)%" contains a ")"
rem    that would close the block early. A "call :take" helper is
rem    used instead so each candidate is a plain statement.
rem
rem  NOTE 3: Must be saved with CRLF line endings.
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Switch the console to UTF-8 so Node's Chinese output renders correctly.
rem The default OEM code page (936/GBK on Chinese Windows) would garble it.
rem Safe here because this script is pure ASCII: parsing already happened.
chcp 65001 >nul 2>&1

title XueEr Quiz

echo.
echo   Starting XueEr Quiz, please wait...
echo.

rem ---------- 1. Locate a usable Node.js ----------
set "NODE_EXE="

rem 1a. Prefer node from PATH
for /f "delims=" %%i in ('where node 2^>nul') do call :take "%%i"

rem 1b. Standard install locations
if not defined NODE_EXE call :take "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE call :take "%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE call :take "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE call :take "%APPDATA%\nvm\node.exe"
if not defined NODE_EXE call :take "%ProgramData%\nvm\node.exe"

rem 1c. Bundled runtimes (DeepSeek Harness ships its own Node)
for /d %%d in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do call :take "%%~fd\dependencies\node\bin\node.exe"
if not defined NODE_EXE call :take "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\bin\node.exe"

rem 1d. Nothing found: offer local mode instead of a dead end
if not defined NODE_EXE goto :no_node

echo   Node.js: !NODE_EXE!
echo.

rem ---------- 2. Start the server (opens the browser) ----------
"!NODE_EXE!" "server\server.js" %*
set "EXITCODE=%errorlevel%"

rem ---------- 3. Keep the window open on failure ----------
if not "%EXITCODE%"=="0" goto :failed

endlocal
exit /b 0

rem ============================================================
rem  Helpers
rem ============================================================

rem Accept a candidate path if it exists and NODE_EXE is unset.
:take
if defined NODE_EXE exit /b 0
if exist %1 set "NODE_EXE=%~1"
exit /b 0

:no_node
echo   [WARN] Node.js was not found on this computer.
echo.
echo   The full version needs Node.js to run its server,
echo   which provides login and cross-device sync.
echo.
echo   You can install it (recommended) from:
echo       https://nodejs.org/
echo.
echo   ------------------------------------------------------
echo   Press any key to open index.html in LOCAL MODE now.
echo   Local mode works fully offline; progress is saved in
echo   your browser, but login and sync are unavailable.
echo   ------------------------------------------------------
echo.
pause >nul

rem Open index.html with the default browser
start "" "index.html"

echo.
echo   Opened index.html in local mode. You may close this window.
echo.
pause
endlocal
exit /b 0

:failed
echo.
echo   [ERROR] The server exited with code %EXITCODE%.
echo   See the messages above for details.
echo.
pause
endlocal
exit /b %EXITCODE%
