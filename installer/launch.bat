@echo off
cd /d "%~dp0"
start "" "node\node.exe" "bin\ectowatch.mjs"
timeout /t 2 >nul
start "" "http://127.0.0.1:8787"
