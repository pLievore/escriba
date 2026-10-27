@echo off
rem Sobe o servidor local do Escriba e abre o painel no navegador.
rem Funciona com dois cliques no Explorer ou em qualquer terminal (cmd, PowerShell, Git Bash).
rem Opcoes: --porta 8765 --modelo sonnet --sem-navegador
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
"%PY%" servidor\app.py %*
if errorlevel 1 pause
