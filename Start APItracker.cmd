@echo off
cd /d "%~dp0"
if not exist backend\node_modules (
  echo Installing backend packages...
  call npm install --prefix backend --no-audit --no-fund
)
start "" http://localhost:4300
node scripts\start-all.js
pause
