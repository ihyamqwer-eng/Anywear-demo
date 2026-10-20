@echo off
setlocal
"%~dp0..\..\runtime\node.exe" "%~dp0anywear-cli.mjs" %*
exit /b %errorlevel%
