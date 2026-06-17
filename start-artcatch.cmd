@echo off
setlocal
cd /d "%~dp0"

echo.
echo [ArtCatch] Docker Desktop must be running before this script continues.
echo [ArtCatch] Preparing PostgreSQL, migrations, and seed data...
echo.

cmd /c npm run db:up
if errorlevel 1 goto failed

cmd /c npm run db:migrate
if errorlevel 1 goto failed

cmd /c npm run db:seed
if errorlevel 1 goto failed

echo.
echo [ArtCatch] Starting backend and frontend in separate windows...
start "ArtCatch Backend" /D "%~dp0" cmd /k npm run dev:backend
start "ArtCatch Frontend" /D "%~dp0" cmd /k npm run dev:frontend

echo.
echo [ArtCatch] Open this URL after the frontend window says VITE ready:
echo http://127.0.0.1:5173/#scan
echo.
pause
exit /b 0

:failed
echo.
echo [ArtCatch] Setup failed. Check whether Docker Desktop is running.
echo.
pause
exit /b 1
