@echo off
title Frame Commander (local test)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on PATH.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node serve.js
pause
