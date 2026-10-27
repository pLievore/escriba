# Sobe o servidor local do Escriba e abre o painel no navegador.
# Uso: .\iniciar-mesa.ps1 [--porta 8765] [--modelo sonnet] [--sem-navegador]
$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $raiz ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }
& $python (Join-Path $raiz "servidor\app.py") @args
