@echo off
"%~dp0pgsql\bin\pg_ctl.exe" stop -D "%~dp0data\pgdata" -m fast
taskkill /f /im CashPro.exe >nul 2>&1
