"""Acha o Claude Code CLI mais novo desta máquina e monta o comando para chamá-lo.

A extensão do VS Code traz um claude.exe numa pasta que muda a cada atualização, e o CLI
global do npm pode estar velho. Aqui escolhemos sempre a versão mais nova que existe, e
preferimos executáveis nativos (.exe): eles recebem argumentos com JSON sem passar pelo
cmd.exe, que estragaria as aspas.

`rodar_json` é a chamada sem ferramentas que o assistente geral e a leitura do Teams usam:
"claude -p" com esquema JSON, sem MCP e sem sessão gravada.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

_cache = {"em": 0.0, "valor": None}
_trava = threading.Lock()
VALIDADE_S = 600
# Prompt de sistema curto e em ASCII: substitui o do Claude Code (mais rápido) e passa intacto
# por qualquer forma de chamar o CLI. As instruções de verdade vão pela entrada padrão.
SISTEMA = ("You are a JSON-only task assistant. Follow the instructions in the user message "
           "exactly and reply with only the requested JSON object.")


def _versao(texto):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", str(texto))
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def _candidatos(preferido=None):
    vistos = []
    if preferido:
        vistos.append(("preferido", Path(preferido)))
    if os.environ.get("MESA_CLAUDE"):
        vistos.append(("ambiente", Path(os.environ["MESA_CLAUDE"])))
    extensoes = Path.home() / ".vscode" / "extensions"
    if extensoes.is_dir():
        for exe in extensoes.glob("anthropic.claude-code-*/resources/native-binary/claude.exe"):
            vistos.append(("extensao", exe))
    nativo = Path.home() / ".local" / "bin" / "claude.exe"
    if nativo.is_file():
        vistos.append(("nativo", nativo))
    no_path = shutil.which("claude")
    if no_path:
        vistos.append(("path", Path(no_path)))
    return vistos


def _comando_de(caminho):
    """Lista de argumentos que executa o CLI, sem passar pelo cmd.exe quando possível."""
    if caminho.suffix.lower() == ".exe":
        return [str(caminho)]
    pasta_npm = caminho.parent / "node_modules" / "@anthropic-ai" / "claude-code"
    for exe in (pasta_npm / "bin" / "claude.exe", pasta_npm / "claude.exe"):
        if exe.is_file():
            return [str(exe)]
    cli = pasta_npm / "cli.js"
    node = shutil.which("node")
    if cli.is_file() and node:
        return [node, str(cli)]
    return [str(caminho)]  # último recurso: o .cmd (só com argumentos simples)


def _versao_instalada(comando, origem, caminho):
    if origem == "extensao":
        return _versao(caminho.parts[-4])  # anthropic.claude-code-2.1.306-win32-x64
    try:
        p = subprocess.run(comando + ["--version"], capture_output=True, text=True, timeout=20,
                           encoding="utf-8", errors="replace")
        return _versao(p.stdout)
    except (OSError, subprocess.TimeoutExpired):
        return (0, 0, 0)


def achar(preferido=None, forcar=False):
    """Devolve {"comando": [...], "versao": "2.1.306", "caminho": "..."} ou None."""
    with _trava:
        atual = _cache["valor"]
        if (not forcar and atual and time.time() - _cache["em"] < VALIDADE_S
                and all(Path(x).exists() for x in atual["comando"] if x.lower().endswith((".exe", ".js")))):
            return atual
        melhor = None
        for origem, caminho in _candidatos(preferido):
            if not caminho.exists():
                continue
            comando = _comando_de(caminho)
            versao = _versao_instalada(comando, origem, caminho)
            if origem == "preferido":
                versao = (999, 0, 0)  # escolha explícita do usuário
            if melhor is None or versao > melhor[0]:
                melhor = (versao, comando, caminho)
        _cache["em"] = time.time()
        _cache["valor"] = None if melhor is None else {
            "comando": melhor[1],
            "versao": ".".join(str(x) for x in melhor[0]) if melhor[0] < (999, 0, 0) else "escolhido",
            "caminho": str(melhor[2]),
            "cmd_exe": melhor[1][0].lower().endswith((".cmd", ".bat")),
        }
        return _cache["valor"]


def ambiente():
    """Variáveis para as chamadas não interativas: sem tráfego extra e sem atualização automática."""
    return dict(os.environ, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1")


def matar(proc):
    """Encerra o processo e os filhos dele (o CLI nativo abre subprocessos no Windows)."""
    if proc is None or proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        proc.kill()


def extrair_json(texto):
    """Primeiro objeto JSON de uma resposta em texto (com ou sem cerca ```json)."""
    t = str(texto or "").strip()
    cerca = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, re.S)
    if cerca:
        t = cerca.group(1)
    else:
        ini, fim = t.find("{"), t.rfind("}")
        if ini == -1 or fim == -1:
            raise RuntimeError("O Claude Code não devolveu o JSON combinado. Tente de novo.")
        t = t[ini:fim + 1]
    try:
        plano = json.loads(t)
    except json.JSONDecodeError:
        raise RuntimeError("O Claude Code devolveu um JSON quebrado. Tente de novo.")
    if not isinstance(plano, dict):
        raise RuntimeError("O Claude Code devolveu um formato inesperado. Tente de novo.")
    return plano


def rodar_json(prompt, esquema, modelo="sonnet", tempo=240, preferido=None, registrar=None):
    """Roda "claude -p" sem ferramentas e devolve (objeto JSON, envelope do CLI).

    `registrar` recebe o Popen enquanto ele roda, para quem precisar cancelar.
    Levanta RuntimeError com uma mensagem em português para mostrar ao usuário.
    """
    cli = achar(preferido)
    if not cli:
        raise RuntimeError("Não achei o Claude Code CLI nesta máquina. Instale a extensão do VS Code ou rode "
                           "'npm install -g @anthropic-ai/claude-code', ou suba o servidor com --claude <caminho>.")
    pasta = Path(tempfile.gettempdir()) / "escriba"
    pasta.mkdir(exist_ok=True)
    cmd = cli["comando"] + ["-p", "--output-format", "json", "--model", modelo, "--tools", "",
                            "--strict-mcp-config", "--no-session-persistence", "--system-prompt", SISTEMA]
    if cli.get("cmd_exe"):  # pelo claude.cmd, o JSON do esquema perderia as aspas no argumento
        prompt += "\n\nResponda SOMENTE com um objeto JSON neste esquema:\n" + json.dumps(esquema, ensure_ascii=False)
    else:
        cmd += ["--json-schema", json.dumps(esquema, ensure_ascii=False)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", cwd=str(pasta), env=ambiente(),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if registrar:
        registrar(proc)
    try:
        saida, erro = proc.communicate(prompt, timeout=tempo)
    except subprocess.TimeoutExpired:
        matar(proc)
        raise RuntimeError(f"O Claude Code passou de {round(tempo / 60)} minutos sem responder; "
                           "o pedido foi cancelado.")
    finally:
        if registrar:
            registrar(None)
    try:
        envelope = json.loads(saida)
    except json.JSONDecodeError:
        envelope = None
    if proc.returncode != 0 or not isinstance(envelope, dict) or envelope.get("is_error"):
        detalhe = envelope.get("result") if isinstance(envelope, dict) else (erro or saida)
        raise RuntimeError(f"O Claude Code respondeu com erro: {str(detalhe or '').strip()[:400] or 'sem detalhes'}")
    if isinstance(envelope.get("structured_output"), dict):
        return envelope["structured_output"], envelope
    return extrair_json(str(envelope.get("result") or "")), envelope
