@echo off
rem Claude Anywhere CLI shim for cmd.exe and PowerShell: runs bin\anywhere.js with Node.js.
setlocal
set "ANYWHERE_JS=%~dp0anywhere.js"
if defined ANYWHERE_NODE (
  set "NODE_EXE=%ANYWHERE_NODE%"
  goto run
)
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  set "NODE_EXE=node"
  goto run
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  goto run
)
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
  set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
  goto run
)
echo Claude Anywhere needs Node.js 18.17 or newer, and node.exe was not found. 1>&2
echo Install it: winget install OpenJS.NodeJS.LTS   (or the LTS installer from https://nodejs.org) 1>&2
exit /b 1
:run
"%NODE_EXE%" "%ANYWHERE_JS%" %*
exit /b %ERRORLEVEL%
