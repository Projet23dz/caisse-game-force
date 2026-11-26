@echo off
chcp 65001 >nul
title CashPro - essai Windows 7
set ELECTRON_RUN_AS_NODE=1
"%~dp0app\CashPro.exe" "%~dp0demo.js" %*
set ELECTRON_RUN_AS_NODE=
