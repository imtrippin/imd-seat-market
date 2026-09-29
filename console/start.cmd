@echo off
cd /d "%~dp0"
if not exist node_modules\viem (echo installing dependencies... & call npm install --no-audit --no-fund)
if not exist config.json (echo copy config.example.json to config.json and fill in the factory address first & pause & exit /b 2)
start "" http://127.0.0.1:18820/
node server.mjs
