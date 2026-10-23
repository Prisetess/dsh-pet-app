@echo off
rem Same as "npm run start", but without npm / node / a terminal window staying open.
rem Opens this project folder with the local electron.exe (this exact path is verified working).
set "ELECTRON_RUN_AS_NODE="
if not exist "%USERPROFILE%\.dsh\electron\electron.exe" (
  echo [ERROR] not found: %USERPROFILE%\.dsh\electron\electron.exe
  echo Let DSH download Electron first, or set DSH_PET_ELECTRON_EXE to an electron.exe.
  pause
  exit /b 1
)
start "" "%USERPROFILE%\.dsh\electron\electron.exe" "%~dp0"
