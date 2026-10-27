"""Agente do Escriba: roda o Claude Code na pasta do projeto de uma pendência, só lendo arquivos.

O claude -p roda com cwd na pasta do projeto, então carrega sozinho o CLAUDE.md e a memória
daquele projeto. Ferramentas: só Read, Grep e Glob (--tools), em modo dontAsk (o que não foi
liberado é negado sem perguntar), sem servidores MCP além dos de uma extensão local (abaixo).
A resposta vem no formato do RESULTADO
(--json-schema). Os arquivos de entrega são gravados por este módulo em entregas/<id>/:
o agente nunca escreve nas pastas dos projetos.
"""
import json
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import cerebro
import claude_cli
import config
import loja

# Extensão local opcional: um pacote em servidor/local/, fora do Git, pode dar ao agente ferramentas
# extras (servidores MCP), com as regras de uso delas no prompt. Sem ele, o agente só lê arquivos.
try:
    from local import extensao as _ext
except ImportError:
    _ext = None

RAIZ = Path(__file__).resolve().parent.parent
ENTREGAS = RAIZ / "entregas"
HISTORICO = RAIZ / "dados" / "agente"
MAX_SIMULTANEAS = 2
TEMPO_MAXIMO_S = 900         # uma extensão local pode pedir mais (ferramenta que leva minuto)
LIMITE_USD = 5
MAX_ARQUIVOS = 30
MAX_BYTES_ARQUIVO = 2_000_000
MAX_BYTES_ENTREGA = 600_000        # soma de todos os arquivos de uma execução
MAX_PASTAS = 8
EXTENSOES_OK = {".md", ".txt", ".sql", ".csv", ".py", ".ps1", ".dax", ".json", ".tmdl", ".yml", ".yaml", ".html",
                ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".css", ".scss", ".xml", ".svg", ".ini", ".toml",
                ".bat", ".cmd", ".sh", ".r", ".ipynb", ".gitignore"}
# Nome de dispositivo do Windows: CON.txt continua sendo CON e não dá para criar o arquivo.
RESERVADOS = {"con", "prn", "aux", "nul", "clock$"} | {f"com{n}" for n in range(1, 10)} | {f"lpt{n}" for n in range(1, 10)}
# Arquivos que começam com ponto e o projeto precisa com o nome exato (.env fica fora de propósito)
PONTO_OK = {".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc", ".prettierrc", ".eslintrc"}

RESULTADO = {
    "type": "object",
    "properties": {
        "resumo": {"type": "string", "description": "2 a 4 frases: o que é a pendência e em que pé está"},
        "contexto": {"type": "array", "items": {"type": "object", "properties": {
            "fonte": {"type": "string", "description": "caminho completo do arquivo ou nome da nota"},
            "trecho": {"type": "string", "description": "trecho curto que sustenta a conclusão"},
            "porque": {"type": "string"}}, "required": ["fonte", "porque"]}},
        "proximos_passos": {"type": "array", "items": {"type": "string"}},
        "mensagem": {"type": "object", "properties": {"para": {"type": "string"}, "texto": {"type": "string"}},
                     "required": ["para", "texto"], "description": "mensagem pronta para a pessoa, quando fizer sentido"},
        "arquivos": {"type": "array", "items": {"type": "object", "properties": {
            "nome": {"type": "string", "description": "nome de arquivo simples, ex.: consulta-base.sql"},
            "descricao": {"type": "string"},
            "conteudo": {"type": "string"}}, "required": ["nome", "conteudo"]}},
        "bloqueios": {"type": "array", "items": {"type": "string"}, "description": f"o que depende de {config.dono_curto()} ou de outra pessoa"},
        "pode_concluir": {"type": "boolean", "description": "true se a entrega resolve a pendência sem depender de mais ninguém"},
    },
    "required": ["resumo", "contexto", "proximos_passos", "bloqueios", "pode_concluir"],
}

MODOS = {
    "briefing": "Prepare um briefing: o que é a pendência, o contexto que você achou nos arquivos e nas memórias (com as fontes), e os próximos passos concretos. Não precisa de mensagem nem de arquivos.",
    "rascunho": "Prepare o briefing e, principalmente, a MENSAGEM pronta para a pessoa que pediu (campo mensagem), no tom das conversas dele: direta, cordial, em português, sem formalidade excessiva. Se precisar de um anexo simples (consulta SQL, roteiro, nota), coloque em arquivos.",
    "executar": "Execute a tarefa ate onde der e entregue SO O QUE FOI PEDIDO. Se pediram uma base, o arquivo da base e a entrega inteira: nao acrescente LEIA-ME, nota de como ler, resumo da analise nem a consulta num .sql a parte -- o que voce tem a dizer vai em resumo e mensagem, que o painel ja mostra ao lado do arquivo. Arquivo extra so quando a entrega nao funciona sem ele (um projeto de codigo precisa do package.json). Bloqueio e so o que depende de outra pessoa, de um acesso que voce nao tem ou de rodar um comando (voce nao roda comandos).",
}
NOTA_FIM = {"briefing": "briefing pronto", "rascunho": "rascunho pronto", "executar": "entrega pronta"}

_execucoes = {}
_processos = {}
_trava = threading.Lock()
_vagas = threading.Semaphore(MAX_SIMULTANEAS)


def agora():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _evento(ex, tipo, texto):
    with _trava:
        ex["eventos"].append({"n": len(ex["eventos"]) + 1, "em": agora(), "tipo": tipo, "texto": str(texto)[:400]})


def _salvar(ex):
    HISTORICO.mkdir(parents=True, exist_ok=True)
    tmp = HISTORICO / f"{ex['id']}.json.tmp"
    with _trava:
        texto = json.dumps(ex, ensure_ascii=False, indent=1)
    tmp.write_text(texto, encoding="utf-8")
    tmp.replace(HISTORICO / f"{ex['id']}.json")


# ---------------------------------------------------------------- onde roda e o que recebe

def _pasta_e_memoria(item):
    """Pasta onde o agente roda (a do projeto) e a pasta de memória do Claude Code a liberar."""
    projeto = cerebro.projeto_por_id(item.get("projeto_id") or "") if item.get("projeto_id") else None
    pasta = Path(projeto["pasta"]) if projeto and projeto.get("pasta") else None
    # o cwd é lido inteiro pelo agente: vale a mesma regra do --add-dir (um projeto registrado
    # aponta para a raiz da Mesa, e aceitá-lo aqui abriria dados/ e export/)
    if pasta is None or not pasta.is_dir() or not cerebro.pasta_liberavel(pasta):
        pasta = ENTREGAS / item["id"]
        pasta.mkdir(parents=True, exist_ok=True)
        return projeto, pasta, None
    memoria = Path(projeto["memoria"]) if projeto.get("memoria") else None
    if memoria is None or not memoria.is_dir():
        raiz = cerebro.raiz_git(str(pasta))
        memoria = cerebro.pasta_memoria(raiz or str(pasta))
    if memoria is not None and (memoria / "memory").is_dir():
        memoria = memoria / "memory"
    return projeto, pasta, memoria if memoria is not None and memoria.is_dir() else None


def _pastas_extras(item, ctx, pasta, memoria, projetos_pedidos=None):
    """Pastas que o agente pode abrir além do cwd, com o motivo de cada uma.

    Quem decide é cerebro.pastas_para_agente: a raiz do projeto dono de cada arquivo que o
    cérebro citou no prompt (ligado OU achado na busca — antes só o ligado entrava aqui, e o
    cérebro acha quase tudo pela busca; era por isso que o agente recebia a lista de arquivos
    no prompt e levava "acesso negado" em todos), mais os projetos sugeridos e a memória.
    A pasta de entregas da pendência entra sempre: é onde está o trabalho anterior dele.
    """
    extras = []

    def juntar(caminho, motivo):
        d = Path(caminho)
        if any(d == e["pasta"] or e["pasta"] in d.parents for e in extras):
            return
        if d == pasta or pasta in d.parents:
            return  # já coberto pelo diretório de trabalho
        extras.append({"pasta": d, "motivo": motivo})

    if memoria is not None:
        juntar(memoria, "memória do Claude Code deste projeto")
    juntar(ENTREGAS / item["id"], "entregas desta pendência")
    for pid in (projetos_pedidos or []):   # o que o usuário mandou abrir vem antes do palpite
        p = cerebro.projeto_por_id(pid)
        if p and p.get("pasta") and cerebro.pasta_liberavel(p["pasta"]):
            juntar(p["pasta"], f"projeto {p['nome']} (você pediu)")
    for p in cerebro.pastas_para_agente(item, ctx, limite=MAX_PASTAS):
        if len(extras) >= MAX_PASTAS:
            break
        juntar(p["caminho"], p["motivo"])
    return [e for e in extras if e["pasta"].is_dir()]


def _legivel(caminho, pasta, extras):
    """O agente só lê dentro do cwd e das pastas liberadas; o prompt não deve prometer o resto."""
    try:
        c = Path(caminho).resolve()
    except (OSError, ValueError):
        return False
    for raiz in [pasta] + [e["pasta"] for e in extras]:
        try:
            if c == raiz.resolve() or raiz.resolve() in c.parents:
                return True
        except (OSError, ValueError):
            continue
    return False


def _prompt(item, ctx, modo, instrucao, projeto, pasta, memoria, ext=None, extras=None):
    """`ext` é o que a extensão local devolveu em preparar(): regras extras e um adendo ao modo."""
    extras, ext = extras or [], ext or {}
    hist = [f"- {h.get('em', '')[:10]} {h.get('texto', '')}" for h in (item.get("historico") or [])[-6:]]
    arquivos = [f"- {a['caminho']}" + ("" if _legivel(a["caminho"], pasta, extras) else " (FORA do seu alcance: não tente abrir)") +
                (f" (por quê: {a['motivo']})" if a.get("motivo") else "") +
                (f"\n  trecho: {a['trecho']}" if a.get("trecho") else "") for a in ctx.get("arquivos", [])]
    notas = [f"- {n.get('nota')}: {n.get('caminho', '')}" for n in ctx.get("notas", [])]
    partes = [
        f"Você é o agente {config.do_produto()}, o quadro de pendências de trabalho {config.apresentacao()}. "
        "Trabalhe só lendo arquivos (Read, Grep, Glob). Você não escreve nada: "
        "os arquivos que você produzir vão no campo arquivos da resposta e o sistema grava para ele.",
        f"\nTAREFA ({modo}): {MODOS[modo]}" + (" " + ext["modo_executar"] if modo == "executar" and ext.get("modo_executar") else ""),
        f"\nPedido extra dele: {instrucao}" if instrucao else "",
        "\nPENDÊNCIA",
        f"Título: {item.get('titulo', '')}",
        f"Quem pediu: {item.get('pessoa', '') or 'não informado'} | Área: {item.get('area', '')} | Prioridade: {item.get('prioridade', '')} | Prazo: {item.get('prazo') or 'sem prazo'}",
        f"Origem: {item.get('origem', '')} | Pedida em: {item.get('pedido_em', '')}",
        f"Contexto: {item.get('contexto', '')}",
        "Histórico recente:\n" + ("\n".join(hist) if hist else "(vazio)"),
        "\nPROJETO",
        f"{projeto['nome']}: {projeto.get('descricao', '')}" if projeto else "Sem projeto ligado; procure só no que for citado abaixo.",
        f"Você está rodando na pasta: {pasta}",
        ("\nPASTAS ABERTAS PARA VOCÊ (pode ler tudo dentro delas; fora disso a leitura é negada):\n"
         + "\n".join(f"- {e['pasta']}" + (f" — {e['motivo']}" if e["motivo"] else "") for e in extras)
         + "\nNão varra node_modules, out, dist, build, .git nem .venv: comece pelos .md da raiz e por src/."
         if extras else ""),
        f"Memória do Claude Code deste projeto (leia o MEMORY.md e as notas que interessarem): {memoria}" if memoria else "",
        "\nARQUIVOS QUE O CÉREBRO LIGOU A ESTA PENDÊNCIA (comece por eles; confira antes de afirmar):",
        "\n".join(arquivos) if arquivos else "(nenhum)",
        "\nNOTAS DE MEMÓRIA RELACIONADAS:",
        "\n".join(notas) if notas else "(nenhuma)",
        "\nREGRAS",
        "- Responda em português do Brasil, frases curtas e diretas.",
        "- Toda afirmação importante tem fonte em contexto (caminho completo ou nome da nota). Não invente números, nomes nem status.",
        ext.get("prompt") or "",
        "- Nunca copie chaves, senhas ou tokens para a resposta.",
        "- pode_concluir só é true se a sua entrega resolve a pendência sem depender de mais ninguém.",
        ("- Você não escreve em pasta nenhuma: os arquivos que você devolver em `arquivos` são gravados pelo servidor "
         f"em entregas/{item['id']}/, e depois ele copia para o projeto com um clique. Use o campo `nome` com a "
         "estrutura de pastas que a entrega precisa ter (ex.: src/Video.jsx, package.json, LEIA-ME.md), caminho "
         f"relativo, sem '..'. Até {MAX_ARQUIVOS} arquivos e {MAX_BYTES_ENTREGA // 1000} KB somados por execução: "
         "se o trabalho for maior, entregue o esqueleto que roda e diga em proximos_passos o que falta."),
        ("- Se faltar acesso a alguma pasta, não invente o conteúdo: escreva em bloqueios exatamente "
         "\"preciso de acesso a <caminho completo>\" e siga com o que der."),
    ]
    return "\n".join(p for p in partes if p is not None and p != "")


def _caminho_da_ferramenta(entrada):
    entrada = entrada if isinstance(entrada, dict) else {}
    for chave in ("file_path", "path", "notebook_path"):
        if entrada.get(chave):
            return str(entrada[chave])
    return ""


def _registrar_negado(ex, caminho):
    """Guarda o caminho que o Claude Code recusou e, se der, a pasta de projeto que o liberaria."""
    caminho = str(caminho or "").strip()
    if not caminho:
        _evento(ex, "aviso", "Uma ação fora do permitido foi negada (o agente só lê arquivos)")
        return
    with _trava:
        negados = ex.setdefault("negados", [])
        if caminho in negados:
            return
        negados.append(caminho)
    _evento(ex, "aviso", f"Leitura negada: {caminho}")
    projetos = cerebro.carregar_projetos()
    dono = cerebro.projeto_por_id(cerebro._dono(caminho, projetos) or "", projetos)
    alvo = dono.get("pasta") if dono else str(Path(caminho).parent)
    if not alvo or not cerebro.pasta_liberavel(alvo):
        return
    with _trava:
        sugeridas = ex.setdefault("pastas_negadas", [])
        if all(s["caminho"] != alvo for s in sugeridas):
            sugeridas.append({"caminho": alvo, "projeto_id": dono["id"] if dono else "",
                              "nome": dono["nome"] if dono else Path(alvo).name})


def _descrever_ferramenta(nome, entrada):
    entrada = entrada if isinstance(entrada, dict) else {}
    if nome == "Read":
        return f"Lendo {Path(str(entrada.get('file_path', ''))).name or 'arquivo'}"
    if nome == "Grep":
        alvo = Path(str(entrada.get("path", ""))).name
        return f"Procurando “{str(entrada.get('pattern', ''))[:60]}”" + (f" em {alvo}" if alvo else "")
    if nome == "Glob":
        return f"Listando {str(entrada.get('pattern', ''))[:80]}"
    return f"Usando {nome}"


# ---------------------------------------------------------------- execução

def _rodar(ex, item):
    with _vagas:
        if ex["status"] == "cancelada":
            return
        ex["status"] = "rodando"
        ex["inicio"] = agora()
        t0 = time.time()
        try:  # o cartão mostra "trabalhando" em qualquer aba, não só na que disparou
            loja.registrar_execucao(ex["pendencia_id"], {"id": ex["id"], "modo": ex["modo"], "status": "rodando",
                                                         "inicio": ex["inicio"], "fim": "", "resumo": "",
                                                         "custo_usd": 0, "duracao_ms": 0, "entregas": []})
        except loja.ErroPendencia:
            pass
        try:
            _executar(ex, item)
        except Exception as e:  # noqa: BLE001 - qualquer falha vira erro visível na execução
            ex["status"] = "erro"
            ex["erro"] = f"Falha inesperada no agente: {e}"
            _evento(ex, "erro", ex["erro"])
        finally:
            with _trava:
                _processos.pop(ex["id"], None)
            ex["fim"] = agora()
            ex["duracao_ms"] = ex.get("duracao_ms") or int((time.time() - t0) * 1000)
            try:  # tempo esgotado ou erro no meio: o que ja esta no disco continua sendo entrega
                ex["entregas"] = _entregas_da_pasta(ex["pendencia_id"], ex["id"], list(ex.get("entregas") or []), ex)
            except Exception:  # noqa: BLE001
                pass
            _finalizar(ex)


def _executar(ex, item):
    cli = claude_cli.achar()
    if not cli:
        raise RuntimeError("Claude Code CLI não encontrado nesta máquina")
    ctx = cerebro.contexto_da_pendencia(item)
    projeto, pasta, memoria = _pasta_e_memoria(item)
    ex["pasta"] = str(pasta)
    (ENTREGAS / item["id"]).mkdir(parents=True, exist_ok=True)
    extras = _pastas_extras(item, ctx, pasta, memoria, ex.get("projetos"))
    ex["pastas"] = [{"caminho": str(e["pasta"]), "motivo": e["motivo"]} for e in extras]
    cmd = cli["comando"] + ["-p", "--output-format", "stream-json", "--verbose", "--model", ex["modelo"],
                            "--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob",
                            "--strict-mcp-config", "--no-session-persistence",
                            "--max-budget-usd", str(LIMITE_USD)]
    if not cli.get("cmd_exe"):  # pelo claude.cmd, o JSON do esquema perderia as aspas
        cmd += ["--json-schema", json.dumps(RESULTADO, ensure_ascii=False)]
    for e in extras:
        cmd += ["--add-dir", str(e["pasta"])]
    prep = {}
    if _ext and hasattr(_ext, "preparar"):
        prep = _ext.preparar(ex, item, ENTREGAS / item["id"] / ex["id"]) or {}
    if prep.get("mcp_config"):
        cmd += ["--mcp-config", prep["mcp_config"]]
        if prep.get("ferramentas"):
            cmd += ["--allowedTools", *prep["ferramentas"]]
    prompt = _prompt(item, ctx, ex["modo"], ex.get("instrucao", ""), projeto, pasta, memoria, prep, extras)
    if cli.get("cmd_exe"):
        prompt += "\n\nResponda SOMENTE com um objeto JSON neste esquema:\n" + json.dumps(RESULTADO, ensure_ascii=False)
    _evento(ex, "inicio", f"Agente iniciado em {pasta} (Claude Code {cli['versao']}, modelo {ex['modelo']})")
    if projeto and projeto.get("pasta") and str(pasta) != projeto["pasta"]:
        _evento(ex, "aviso", f"Não rodei em {projeto['pasta']}: essa pasta não pode ser aberta pelo agente "
                             f"(é a pasta do próprio quadro ou está fora do registro). Trabalhei em {pasta}.")
    for e in extras:
        _evento(ex, "texto", f"Pasta aberta: {e['pasta']}" + (f" — {e['motivo']}" if e["motivo"] else ""))

    proc = subprocess.Popen(cmd, cwd=str(pasta), env=claude_cli.ambiente(), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    with _trava:
        _processos[ex["id"]] = proc
    teto = prep.get("teto_s") or TEMPO_MAXIMO_S
    vigia = threading.Timer(teto, lambda: _matar(proc))
    vigia.daemon = True
    vigia.start()
    # stderr lido em paralelo: lendo so no fim, um CLI falante enche o cano e trava tudo ate o vigia
    erros_cli = []
    leitor = threading.Thread(target=lambda: erros_cli.append(proc.stderr.read()), daemon=True)
    leitor.start()
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        final = None
        pedidos = {}   # tool_use_id -> caminho pedido, para dizer qual leitura foi negada
        ultimo = ""
        for linha in proc.stdout:
            try:
                ev = json.loads(linha)
            except json.JSONDecodeError:
                continue
            tipo = ev.get("type")
            if tipo == "assistant":
                for bloco in (ev.get("message") or {}).get("content") or []:
                    if bloco.get("type") == "tool_use" and _ext and hasattr(_ext, "ao_usar") \
                            and _ext.ao_usar(ex, bloco, _evento, _trava):
                        pass   # a extensão registrou e narrou a chamada
                    elif bloco.get("type") == "tool_use" and bloco.get("name") != "StructuredOutput":
                        caminho = _caminho_da_ferramenta(bloco.get("input"))
                        if caminho:
                            pedidos[bloco.get("id")] = caminho
                            ultimo = caminho
                        _evento(ex, "ferramenta", _descrever_ferramenta(bloco.get("name"), bloco.get("input")))
                    elif bloco.get("type") == "text" and bloco.get("text", "").strip():
                        _evento(ex, "texto", bloco["text"].strip()[:300])
            elif tipo == "user":
                for bloco in (ev.get("message") or {}).get("content") or []:
                    if isinstance(bloco, dict) and bloco.get("type") == "tool_result" and _ext and hasattr(_ext, "ao_resultado"):
                        _ext.ao_resultado(ex, bloco, _evento, _trava)
            elif tipo == "system" and ev.get("subtype") == "permission_denied":
                _registrar_negado(ex, pedidos.get(ev.get("tool_use_id")) or _caminho_da_ferramenta(ev.get("tool_input")) or ultimo)
            elif tipo == "result":
                final = ev
        leitor.join(timeout=5)
        erro_txt = "".join(erros_cli)
        proc.wait(timeout=30)
    finally:
        vigia.cancel()

    if ex["status"] == "cancelada":
        # o que ele ja gravou (arquivos de ferramenta, na pasta) continua valendo para o dono
        ex["entregas"] = _entregas_da_pasta(item["id"], ex["id"], list(ex.get("entregas") or []), ex)
        _evento(ex, "fim", "Execução cancelada" + (f"; {len(ex['entregas'])} arquivo(s) já gravado(s) ficaram na entrega" if ex["entregas"] else ""))
        return
    if final is None:
        ex["status"] = "erro"
        ex["erro"] = "O Claude Code terminou sem resultado" + (f": {erro_txt.strip()[:300]}" if erro_txt.strip() else
                                                                 (" (tempo máximo atingido)" if proc.returncode else ""))
        # mesmo sem resposta, o que uma ferramenta já gravou na pasta é trabalho pronto e é do dono:
        # jogá-lo fora era perder minutos de trabalho por causa de um relógio
        ex["entregas"] = _entregas_da_pasta(item["id"], ex["id"], list(ex.get("entregas") or []), ex)
        if ex["entregas"]:
            ex["erro"] += f" — mas {len(ex['entregas'])} arquivo(s) já gravado(s) ficaram na entrega."
        _evento(ex, "erro", ex["erro"])
        return
    ex["custo_usd"] = round(float(final.get("total_cost_usd") or 0), 4)
    ex["duracao_ms"] = int(final.get("duration_ms") or 0)
    for negado in final.get("permission_denials") or []:   # o envelope do CLI é a fonte exata
        if isinstance(negado, dict):
            _registrar_negado(ex, _caminho_da_ferramenta(negado.get("tool_input")))
    if final.get("is_error") or final.get("subtype") != "success":
        ex["status"] = "erro"
        ex["erro"] = f"O Claude Code respondeu com erro ({final.get('subtype')}): {str(final.get('result') or '')[:300]}"
        _evento(ex, "erro", ex["erro"])
        return
    resultado = final.get("structured_output")
    if not isinstance(resultado, dict):
        resultado = _json_do_texto(str(final.get("result") or ""))
    if not isinstance(resultado, dict):
        ex["status"] = "erro"
        ex["erro"] = "O agente não devolveu a resposta no formato combinado. Tente de novo."
        # o trabalho dele não se perde: a resposta crua vira uma entrega para o usuário ler
        ex["entregas"] = _entregas_da_pasta(item["id"], ex["id"], _gravar_entregas(item["id"], ex["id"], [{
            "nome": "resposta-bruta.md", "conteudo": str(final.get("result") or ""),
            "descricao": "Resposta do agente fora do formato combinado, gravada como veio."}], ex), ex)
        _evento(ex, "erro", ex["erro"])
        return
    ex["entregas"] = _entregas_da_pasta(item["id"], ex["id"],
                                    _gravar_entregas(item["id"], ex["id"], resultado.get("arquivos") or [], ex), ex)
    resultado["arquivos"] = [{"nome": e["nome"], "descricao": e["descricao"]} for e in ex["entregas"]]
    ex["resultado"] = _sem_segredos(resultado)
    ex["status"] = "concluida"
    _evento(ex, "fim", f"Pronto em {ex['duracao_ms'] / 1000:.0f} s" + (f", {len(ex['entregas'])} arquivo(s) entregue(s)" if ex["entregas"] else ""))


def _json_do_texto(texto):
    t = texto.strip()
    cerca = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, re.S)
    if cerca:
        t = cerca.group(1)
    else:
        ini, fim = t.find("{"), t.rfind("}")
        if ini == -1 or fim == -1:
            return None
        t = t[ini:fim + 1]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        return None


def _sem_segredos(valor):
    if isinstance(valor, str):
        return cerebro.mascarar(valor)
    if isinstance(valor, list):
        return [_sem_segredos(v) for v in valor]
    if isinstance(valor, dict):
        return {k: _sem_segredos(v) for k, v in valor.items()}
    return valor


def _aviso(ex, texto):
    """Aviso que vale tanto na execução de verdade quanto quando _gravar_entregas roda solto."""
    if ex is not None:
        _evento(ex, "aviso", texto)


def _parte_segura(parte):
    """Um segmento de caminho sem truque: nada de '..', de unidade, de dispositivo do Windows.

    O ponto da frente é mantido só nos arquivos de configuração conhecidos (.gitignore e afins):
    o projeto que o agente entrega precisa deles com o nome certo para rodar.
    """
    bruto = str(parte)
    ponto = bruto.startswith(".") and bruto.lower() in PONTO_OK
    p = re.sub(r"[^\w.\- ]+", "-", bruto, flags=re.UNICODE).strip(" .-")[:80]
    if not p:
        return ""
    if p.lower() in RESERVADOS or Path(p).stem.lower() in RESERVADOS:
        return "_" + p   # nome de dispositivo do Windows: renomeia, não descarta o arquivo
    return ("." + p) if ponto else p


def _nome_seguro(nome):
    """Caminho relativo da entrega (aceita subpasta: src/Video.jsx), sempre dentro da pasta dela."""
    bruto = str(nome or "").replace("\\", "/")
    partes = [_parte_segura(p) for p in bruto.split("/") if p not in ("", ".", "..")]
    partes = [p for p in partes if p]
    if len(partes) > 6:   # junta o excesso num nome só, para não re-enraizar o arquivo noutro lugar
        partes = partes[:5] + ["-".join(partes[5:])[:80]]
    if not partes:
        partes = ["entrega"]
    ultimo = partes[-1]
    if ultimo.startswith(".") and (ultimo.lower() in PONTO_OK or Path(ultimo).stem.lower() in PONTO_OK):
        return "/".join(partes)   # .gitignore, .editorconfig: o nome é a extensão
    if Path(ultimo).suffix.lower() not in EXTENSOES_OK:
        partes[-1] += ".txt"
    return "/".join(partes)


def _gravar_entregas(pendencia_id, eid, arquivos, ex=None):
    """Grava os arquivos que o agente devolveu em entregas/<pendência>/<execução>/.

    Uma pasta por execução: a segunda rodada não embaralha a entrega da primeira. O nome pode
    trazer subpasta (src/Video.jsx) e o caminho final é conferido contra a pasta da execução.
    """
    destino = (ENTREGAS / pendencia_id / eid).resolve()
    gravadas, total, mascarados = [], 0, []
    if not isinstance(arquivos, list):   # o modelo às vezes manda um objeto só
        arquivos = [arquivos] if isinstance(arquivos, dict) else []
    for a in arquivos[:MAX_ARQUIVOS]:
        if not isinstance(a, dict) or not str(a.get("conteudo") or "").strip():
            continue
        nome = _nome_seguro(a.get("nome"))
        limpo = cerebro.mascarar(str(a["conteudo"]))[:MAX_BYTES_ARQUIVO]
        if limpo != str(a["conteudo"])[:MAX_BYTES_ARQUIVO]:
            mascarados.append(nome)
        bruto = limpo.encode("utf-8")
        if len(bruto) > MAX_BYTES_ENTREGA - total:
            # tudo ou nada: arquivo pela metade é pior que arquivo faltando, e agora tem botão
            # que copia a entrega para dentro do projeto
            _aviso(ex, f"{nome} ({len(bruto) // 1000} KB) não coube no limite de "
                       f"{MAX_BYTES_ENTREGA // 1000} KB da entrega e não foi gravado.")
            continue
        alvo = (destino / nome).resolve()
        try:
            alvo.relative_to(destino)
        except ValueError:
            continue  # nome tentou sair da pasta da entrega
        base, n = alvo, 2
        while alvo.exists():
            alvo = base.with_name(f"{base.stem}-{n}{base.suffix}")
            n += 1
        try:
            alvo.parent.mkdir(parents=True, exist_ok=True)
            alvo.write_text(limpo, encoding="utf-8")
        except OSError as e:   # nome impossível não pode derrubar a execução inteira
            _aviso(ex, f"Não consegui gravar {nome}: {e}")
            continue
        total += len(bruto)
        gravadas.append({"nome": f"{eid}/{alvo.relative_to(destino).as_posix()}",
                         "rotulo": alvo.relative_to(destino).as_posix(),
                         "descricao": str(a.get("descricao") or "")[:300]})
    if mascarados and ex is not None:
        # o filtro de segredos também pega falso positivo (um "token:" num comentário): diga onde
        _evento(ex, "aviso", "Trecho parecido com chave ou senha trocado por [segredo removido] em "
                             + ", ".join(mascarados[:4]) + ". Confira esses arquivos antes de usar.")
    return gravadas


def _entregas_da_pasta(pendencia_id, eid, gravadas, ex):
    """Junta à entrega os arquivos que apareceram na pasta durante a execução sem vir na resposta
    do modelo — o que uma ferramenta de extensão gravou direto ali. Eles valem mesmo se a execução
    estourar o tempo ou for cancelada: é trabalho pronto e é do dono."""
    pasta = ENTREGAS / pendencia_id / eid
    if not pasta.is_dir():
        return gravadas
    ja = {g.get("rotulo") for g in gravadas}
    for p in sorted(pasta.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(pasta).as_posix()
        if rel in ja:
            continue
        descricao = None
        if _ext and hasattr(_ext, "descrever_arquivo"):
            try:
                descricao = _ext.descrever_arquivo(ex, p)
            except Exception:  # noqa: BLE001 - descrição é enfeite, não pode derrubar a entrega
                descricao = None
        gravadas.append({"nome": f"{eid}/{rel}", "rotulo": rel,
                         "descricao": str(descricao or "Arquivo gravado durante a execução")[:300],
                         "da_ferramenta": bool(descricao)})
    return gravadas


def _finalizar(ex):
    _salvar(ex)
    resumo = {k: ex.get(k) for k in ("id", "modo", "status", "inicio", "fim", "custo_usd", "duracao_ms", "entregas")}
    resumo["resumo"] = ((ex.get("resultado") or {}).get("resumo") or ex.get("erro") or "")[:400]
    nota = f"Agente: {NOTA_FIM[ex['modo']]}" if ex["status"] == "concluida" else (
        "Agente: execução cancelada" if ex["status"] == "cancelada" else "Agente: a execução falhou")
    try:
        loja.registrar_execucao(ex["pendencia_id"], resumo, nota)
    except loja.ErroPendencia:
        pass  # a pendência pode ter sido apagada enquanto o agente rodava


def _matar(proc):
    if proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


# ---------------------------------------------------------------- interface para o servidor

def marcar_interrompidas():
    """Na subida do servidor: execução que ficou 'rodando' de antes do reinício vira erro."""
    for item in loja.ler()["pendencias"]:
        u = (item.get("agente") or {}).get("ultima") or {}
        if u.get("status") in ("fila", "rodando") and u.get("id") not in _execucoes:
            try:
                loja.registrar_execucao(item["id"], {**u, "status": "erro", "fim": agora(),
                                                     "resumo": "Interrompida: o servidor foi reiniciado durante a execução."},
                                        "Agente: execução interrompida pelo reinício do servidor")
            except loja.ErroPendencia:
                pass

def iniciar(pendencia_id, modo, instrucao="", modelo="sonnet", projetos=None):
    if modo not in MODOS:
        raise loja.ErroPendencia(f"modo inválido: {modo!r}")
    item = loja.obter(pendencia_id)
    registrados = {p["id"] for p in cerebro.carregar_projetos()}
    pedidos = [str(p) for p in (projetos or []) if str(p) in registrados][:MAX_PASTAS]
    ex = {"id": f"e-{datetime.now():%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}", "pendencia_id": pendencia_id,
          "modo": modo, "instrucao": str(instrucao or "").strip()[:1000], "modelo": modelo, "status": "fila",
          "criada": agora(), "inicio": "", "fim": "", "duracao_ms": 0, "custo_usd": 0, "pasta": "",
          "eventos": [], "resultado": None, "entregas": [], "erro": "",
          "projetos": pedidos, "pastas": [], "negados": [], "pastas_negadas": []}
    with _trava:
        _execucoes[ex["id"]] = ex
    _evento(ex, "inicio", "Na fila" if _vagas._value == 0 else "Preparando o agente")
    threading.Thread(target=_rodar, args=(ex, item), daemon=True, name=f"agente-{ex['id']}").start()
    return obter(ex["id"])


def _carregar(eid):
    if not re.fullmatch(r"e-[\w-]{6,40}", eid or ""):
        return None
    with _trava:
        if eid in _execucoes:
            return _execucoes[eid]
    arq = HISTORICO / f"{eid}.json"
    if arq.is_file():
        return json.loads(arq.read_text(encoding="utf-8"))
    return None


def obter(eid, desde=0):
    ex = _carregar(eid)
    if ex is None:
        raise loja.ErroPendencia("execução não encontrada")
    with _trava:
        copia = {k: v for k, v in ex.items() if k != "eventos"}
        copia["eventos"] = [e for e in ex["eventos"] if e["n"] > int(desde or 0)]
    return copia


def cancelar(eid):
    ex = _carregar(eid)
    if ex is None:
        raise loja.ErroPendencia("execução não encontrada")
    if ex["status"] in ("fila", "rodando"):
        ex["status"] = "cancelada"
        with _trava:
            proc = _processos.get(eid)
        if proc is not None:
            _matar(proc)
    return obter(eid)


def listar(pendencia_id):
    vistas = {}
    if HISTORICO.is_dir():
        for arq in HISTORICO.glob("e-*.json"):
            try:
                ex = json.loads(arq.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if ex.get("pendencia_id") == pendencia_id:
                vistas[ex["id"]] = ex
    with _trava:
        for ex in _execucoes.values():
            if ex["pendencia_id"] == pendencia_id:
                vistas[ex["id"]] = ex
        lista = [{k: v for k, v in ex.items() if k != "eventos"} for ex in vistas.values()]
    return sorted(lista, key=lambda e: e.get("criada") or e.get("inicio") or "", reverse=True)


def caminho_entrega(pendencia_id, nome):
    """Arquivo de entrega a servir, ou None se o nome tentar sair da pasta da pendência.

    O nome pode ser relativo com subpasta (e-2026.../src/Video.jsx). Caminho absoluto, unidade
    e '..' são recusados antes de juntar, e no fim o resultado ainda é conferido contra a pasta.
    """
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,80}", pendencia_id or ""):
        return None
    partes = [p for p in str(nome or "").replace("\\", "/").split("/") if p and p not in (".", "..")]
    if not partes or len(partes) > 8 or any(":" in p for p in partes):
        return None
    pasta = (ENTREGAS / pendencia_id).resolve()
    alvo = pasta.joinpath(*partes).resolve()
    try:
        alvo.relative_to(pasta)
    except ValueError:
        return None
    return alvo if alvo.is_file() else None


def copiar_entrega(pendencia_id, eid, projeto_id="", confirmar=False):
    """Copia a entrega de uma execução para dentro da pasta do projeto — quem escreve é o servidor.

    O agente continua sem escrever em projeto nenhum. Aqui, com o clique do usuário, o servidor
    cria uma pasta nova (mesa-<pendência>) dentro do projeto e grava os arquivos; nada existente
    é sobrescrito. Sem `confirmar`, só devolve a prévia do que seria escrito.
    """
    origem = pasta_entrega(pendencia_id, eid)
    pares = []   # (arquivo na entrega, caminho relativo no destino)
    if origem is not None:
        pares = [(p, p.relative_to(origem).as_posix()) for p in sorted(origem.rglob("*")) if p.is_file()]
    else:
        # execução antiga: as entregas ficavam soltas em entregas/<pendência>/, sem pasta por execução
        antiga = _carregar(eid) or {}
        for a in antiga.get("entregas") or []:
            arq = caminho_entrega(pendencia_id, a.get("nome") or "")
            if arq is not None:
                pares.append((arq, a.get("rotulo") or Path(a["nome"]).name))
    if not pares:
        raise loja.ErroPendencia("essa entrega não existe mais")
    item = loja.obter(pendencia_id)
    pid = str(projeto_id or item.get("projeto_id") or "")
    projeto = cerebro.projeto_por_id(pid) if pid else None
    if not projeto or not projeto.get("pasta"):
        raise loja.ErroPendencia("escolha o projeto para onde copiar (a pendência não tem projeto ligado)")
    raiz = Path(projeto["pasta"])
    if not cerebro.pasta_liberavel(str(raiz)):
        raise loja.ErroPendencia(f"não dá para gravar em {raiz}")
    base = f"mesa-{pendencia_id}"[:60]
    destino, n = raiz / base, 2
    while destino.exists():
        destino = raiz / f"{base}-{n}"
        n += 1
    previa = [{"nome": rel, "bytes": p.stat().st_size} for p, rel in pares]
    if not confirmar:
        return {"destino": str(destino), "projeto": projeto["nome"], "arquivos": previa, "gravado": False}
    for p, rel in pares:
        alvo = destino / rel
        alvo.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, alvo)
    return {"destino": str(destino), "projeto": projeto["nome"], "arquivos": previa, "gravado": True}


def pasta_entrega(pendencia_id, eid=""):
    """Pasta da pendência (ou de uma execução dela), para copiar a entrega para o projeto."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,80}", pendencia_id or ""):
        return None
    pasta = (ENTREGAS / pendencia_id).resolve()
    if eid:
        if not re.fullmatch(r"e-[\w-]{6,40}", eid):
            return None
        pasta = (pasta / eid).resolve()
        try:
            pasta.relative_to((ENTREGAS / pendencia_id).resolve())
        except ValueError:
            return None
    return pasta if pasta.is_dir() else None
