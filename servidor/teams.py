"""Atualização do Teams num clique: copia o cache, extrai, lê com o Claude Code e aplica.

São os mesmos passos da rotina manual do CLAUDE.md, feitos pelo servidor quando o usuário
clica em "Atualizar do Teams" no painel (nunca sozinho, nunca em segundo plano):

 1. **cópia**: copia só as pastas `https_teams.microsoft.com_0.indexeddb.*` de dentro do
    IndexedDB do perfil corporativo para `export/IndexedDB`. Nunca o perfil inteiro
    (`EBWebView`, que tem cookies e tokens) e nem o IndexedDB de outros sites.
 2. **extração**: roda `extrair_cache.py --desde <última leitura>`, que gera o markdown em
    `export/` (fora do git) e mascara chaves e senhas que apareçam nas conversas.
 3. **análise**: manda esse markdown e as pendências atuais para o `claude -p`, sem nenhuma
    ferramenta, com as regras de `servidor/instrucoes_teams.md`. Ele devolve um plano JSON.
 4. **aplicação**: `loja.aplicar(..., "claude-code")` (não reabre o que o usuário fechou no
    painel) e `loja.definir_meta` com a hora da leitura, que vira o "Teams lido" do rodapé.
 5. **cérebro**: liga as pendências novas a um projeto, quando a sugestão é forte.

Uma atualização por vez. Nada é enviado ao Teams e nada sai desta máquina além da chamada
do Claude Code. Só biblioteca padrão. Contrato em docs/API.md.

Uso pela linha de comando (o `--simular` faz tudo menos gravar):
  python servidor\\teams.py [--simular] [--desde 2026-10-20T16:44:00-03:00] [--modelo sonnet]
"""
import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import cerebro  # noqa: E402
import claude_cli  # noqa: E402
import config  # noqa: E402
import loja  # noqa: E402

RAIZ = AQUI.parent
EXPORT = RAIZ / "export"
DESTINO = EXPORT / "IndexedDB"
EXTRATOR = RAIZ / "extrair_cache.py"
INSTRUCOES = AQUI / "instrucoes_teams.md"
# Dentro do IndexedDB do perfil corporativo, só o que é do Teams (o resto é SharePoint e afins)
PERFIL = Path("Packages/MSTeams_8wekyb3d8bbwe/LocalCache/Microsoft/MSTeams/EBWebView/WV2Profile_tfw/IndexedDB")
PREFIXO = "https_teams.microsoft.com_0.indexeddb."
DIAS_PADRAO = 14
MAX_TEXTO = 600_000          # o que cabe do export no pedido ao Claude (os chats mais recentes vêm primeiro)
MAX_PENDENCIAS = 120
TEMPO_COPIA_S = 600
TEMPO_EXTRACAO_S = 600
TEMPO_CLAUDE_S = 900
PONTOS_PROJETO = 4.0         # confiança mínima para ligar uma pendência nova a um projeto
SEMANA = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"]
MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
         "setembro", "outubro", "novembro", "dezembro"]

ETAPAS = [("copia", "Copiando o cache do Teams"), ("extracao", "Lendo as mensagens novas"),
          ("analise", "Comparando com o quadro"), ("aplicacao", "Aplicando as mudanças"),
          ("cerebro", "Ligando ao contexto")]

PLANO = {
    "type": "object",
    "properties": {
        "resumo": {"type": "string", "description": "1 a 3 frases em português: o que mudou no quadro"},
        "operacoes": {"type": "array", "items": {"type": "object", "properties": {
            "op": {"type": "string", "enum": ["criar", "atualizar"]},
            "id": {"type": "string", "description": "id exato de uma pendência existente (só em atualizar)"},
            "campos": {"type": "object"},
            "nota": {"type": "string", "description": "o que na conversa justificou a mudança"},
            "dados": {"type": "object"}}, "required": ["op"]}},
        "duvidas": {"type": "array", "items": {"type": "string"},
                    "description": "o que ficou em dúvida e você não mudou"},
    },
    "required": ["resumo", "operacoes"],
}

_trava = threading.Lock()
_sync = None        # a atualização que está rodando, ou a última desta sessão
_proc = None        # processo externo em curso (para cancelar)


class EmCurso(Exception):
    """Já existe uma atualização rodando."""


class Cancelada(Exception):
    """O usuário parou a atualização."""


# ---------------------------------------------------------------- estado

def agora():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _evento(s, tipo, texto):
    with _trava:
        s["eventos"].append({"n": len(s["eventos"]) + 1, "em": agora(), "tipo": tipo, "texto": str(texto)[:400]})


def _etapa(s, nome):
    s["etapa"] = nome
    rotulo = dict(ETAPAS).get(nome, nome)
    _evento(s, "etapa", rotulo)


def _conferir_cancelada(s):
    if s["status"] == "cancelada":
        raise Cancelada()


def perfil_teams():
    """Pasta IndexedDB do perfil corporativo do Teams, ou None se não existir nesta máquina."""
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return None
    pasta = Path(base) / PERFIL
    return pasta if pasta.is_dir() else None


def disponivel():
    return EXTRATOR.is_file()


def estado(desde=0):
    """A atualização atual (ou a última desta sessão), com os eventos depois de `desde`."""
    with _trava:
        if _sync is None:
            return None
        copia = {k: v for k, v in _sync.items() if k != "eventos"}
        copia["eventos"] = [e for e in _sync["eventos"] if e["n"] > int(desde or 0)]
        copia["total_eventos"] = len(_sync["eventos"])
    return copia


def _python():
    venv = RAIZ / ".venv" / "Scripts" / "python.exe"
    return str(venv) if venv.is_file() else sys.executable


def _sem_janela():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _registrar_proc(proc):
    global _proc
    with _trava:
        _proc = proc


def _matar(proc):
    if proc is None or proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True,
                       creationflags=_sem_janela())
    else:
        proc.kill()


# ---------------------------------------------------------------- 1. cópia do cache

def _apagar_pasta(p, tentativas=6):
    """rmtree teimoso. Devolve True se a pasta sumiu.

    O antivírus desta máquina abre os `.ldb` recém-copiados para varrer e os segura por alguns
    instantes; um `rmtree` só falha calado e deixa a pasta pela metade. Então: tira o somente-leitura
    do que resistir, repete algumas vezes com espera crescente, e diz honestamente se conseguiu.
    """
    for k in range(tentativas):
        if not p.exists():
            return True
        for raiz, dirs, nomes in os.walk(p):
            for nome in dirs + nomes:
                try:
                    os.chmod(Path(raiz) / nome, stat.S_IWRITE)
                except OSError:
                    pass
        shutil.rmtree(p, ignore_errors=True)
        if not p.exists():
            time.sleep(0.05)   # o Windows às vezes só solta o nome no tique seguinte
            if not p.exists():
                return True
        time.sleep(0.3 * (k + 1))
    return not p.exists()


def _trocar_destino(temp):
    """Põe `temp` no lugar de `export/IndexedDB`, sem deixar o destino pela metade.

    No Windows `os.replace` NÃO substitui uma pasta que já existe e tem arquivo dentro: dá
    "Acesso negado". Então o destino tem de sumir antes — e, se não sumir, é melhor parar com uma
    mensagem que diga o que fazer do que tentar o replace e estourar um WinError 5 sem explicação.
    """
    antigo = EXPORT / "IndexedDB.antigo"
    _apagar_pasta(antigo)
    if DESTINO.exists():
        try:
            DESTINO.replace(antigo)      # renomear é mais barato que apagar 100 arquivos
        except OSError:
            pass
    if DESTINO.exists() and not _apagar_pasta(DESTINO):
        raise RuntimeError(
            "Não consegui substituir export\\IndexedDB: algum programa está com os arquivos "
            "abertos (costuma ser o antivírus varrendo a cópia, ou uma janela do Explorador "
            "aberta nessa pasta). A cópia nova ficou em export\\IndexedDB.novo. "
            "Feche o Explorador nessa pasta e clique em Atualizar do Teams de novo.")
    erro = None
    for k in range(6):
        try:
            temp.replace(DESTINO)
            _apagar_pasta(antigo)
            return
        except OSError as e:
            erro = e
            time.sleep(0.3 * (k + 1))
    _apagar_pasta(antigo)
    raise RuntimeError(f"Não consegui renomear export\\IndexedDB.novo para IndexedDB ({erro}). "
                       "A cópia está lá; tente de novo em alguns segundos.")


def _copiar_cache(s):
    _etapa(s, "copia")
    origem = perfil_teams()
    if origem is None:
        raise RuntimeError("Não achei o cache do Teams nesta máquina "
                           f"(%LOCALAPPDATA%\\{PERFIL}). O Teams precisa estar instalado e já aberto uma vez.")
    pastas = sorted(p for p in origem.iterdir() if p.is_dir() and p.name.startswith(PREFIXO))
    if not pastas:
        raise RuntimeError("O cache do Teams mudou de formato: não achei nenhuma pasta "
                           f"'{PREFIXO}*' no perfil. Rode mapear_cache.py para ver a estrutura nova.")
    EXPORT.mkdir(parents=True, exist_ok=True)
    temp = EXPORT / "IndexedDB.novo"
    _apagar_pasta(temp)
    arquivos = falhas = tamanho = 0
    for pasta in pastas:
        for raiz, _, nomes in os.walk(pasta):
            alvo = temp / pasta.name / Path(raiz).relative_to(pasta)
            alvo.mkdir(parents=True, exist_ok=True)
            for nome in nomes:
                _conferir_cancelada(s)
                try:
                    shutil.copy2(Path(raiz) / nome, alvo / nome)
                    arquivos += 1
                    tamanho += (alvo / nome).stat().st_size
                except OSError:
                    falhas += 1  # LOCK e arquivos que o Teams está escrevendo ficam de fora
    if not arquivos:
        _apagar_pasta(temp)
        raise RuntimeError("Não consegui copiar nenhum arquivo do cache do Teams.")
    _trocar_destino(temp)
    s["resumo"]["arquivos_copiados"] = arquivos
    _evento(s, "ok", f"{arquivos} arquivos ({tamanho / 1e6:.0f} MB) copiados"
                     + (f"; {falhas} em uso pelo Teams ficaram de fora" if falhas else ""))


# ---------------------------------------------------------------- 2. extração das conversas

def _extrair(s, desde):
    _etapa(s, "extracao")
    cmd = [_python(), "-X", "utf8", str(EXTRATOR)]
    cmd += ["--desde", desde] if desde else [str(DIAS_PADRAO)]
    proc = subprocess.Popen(cmd, cwd=str(RAIZ), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", creationflags=_sem_janela())
    _registrar_proc(proc)
    try:
        saida, erro = proc.communicate(timeout=TEMPO_EXTRACAO_S)
    except subprocess.TimeoutExpired:
        _matar(proc)
        raise RuntimeError("A extração do cache passou de 10 minutos e foi cancelada.")
    finally:
        _registrar_proc(None)
    _conferir_cancelada(s)
    if proc.returncode != 0:
        detalhe = (erro or saida or "").strip().splitlines()
        ultimo = detalhe[-1] if detalhe else "sem detalhes"
        if "ccl_chromium_reader" in (erro or ""):
            ultimo = ("falta a biblioteca ccl_chromium_reader no Python da Mesa "
                      "(.venv\\Scripts\\python.exe -m pip install ccl_chromium_reader)")
        raise RuntimeError(f"A extração do cache falhou: {ultimo[:300]}")
    m = re.search(r"OK: (.+?) \| (\d+) chats \| (\d+) mensagens", saida or "")
    if not m:
        raise RuntimeError(f"Não entendi a saída da extração: {(saida or '').strip()[:200] or 'vazia'}")
    arquivo = Path(m.group(1).strip())
    chats, mensagens = int(m.group(2)), int(m.group(3))
    s["resumo"].update({"arquivo": arquivo.name, "chats": chats, "mensagens": mensagens})
    _evento(s, "ok", f"{mensagens} mensagens em {chats} chats ({arquivo.name})")
    return arquivo, chats, mensagens


# ---------------------------------------------------------------- 3. análise pelo Claude Code

def data_longa():
    d = datetime.now(loja.BRT).date()
    return f"{SEMANA[d.weekday()]}, {d.day} de {MESES[d.month - 1]} de {d.year} ({d.isoformat()})"


def _pendencias_para_prompt(dados):
    corte = (datetime.now(loja.BRT).date() - timedelta(days=21)).isoformat()
    projetos = {p["id"]: p["nome"] for p in cerebro.carregar_projetos()}
    lista = []
    for i in dados["pendencias"]:
        if i.get("status") == "descartada":
            continue
        if i.get("status") == "feita" and str(i.get("atualizado_em", ""))[:10] < corte:
            continue
        lista.append({k: i.get(k, "") for k in ("id", "titulo", "pessoa", "area", "prioridade", "status", "prazo")}
                     | {"projeto": projetos.get(i.get("projeto_id") or "", ""),
                        "contexto": str(i.get("contexto", ""))[:220]})
    return lista[:MAX_PENDENCIAS]


def _prompt(texto_conversas, dados, desde, cortado):
    janela = (f"desde a última leitura ({desde})" if desde else f"dos últimos {DIAS_PADRAO} dias")
    return (f"{config.preencher(INSTRUCOES.read_text(encoding='utf-8'))}\n\n"
            f"Hoje é {data_longa()}.\n\n"
            f"PENDÊNCIAS ATUAIS DO QUADRO (JSON):\n{json.dumps(_pendencias_para_prompt(dados), ensure_ascii=False)}\n\n"
            f"CONVERSAS DO TEAMS {janela}"
            + (" (cortadas no limite de tamanho; os chats mais recentes vêm primeiro)" if cortado else "")
            + f":\n{texto_conversas}")


def _analisar(s, arquivo, dados, desde, modelo):
    _etapa(s, "analise")
    texto = arquivo.read_text(encoding="utf-8", errors="replace")
    cortado = len(texto) > MAX_TEXTO
    prompt = _prompt(texto[:MAX_TEXTO], dados, desde, cortado)
    if cortado:
        # sem isto a data avancaria por cima de chats que ninguem leu, e eles sumiriam para sempre
        s["cortado"] = True
        _evento(s, "aviso", f"O export tem {len(texto) // 1000} KB e o limite e {MAX_TEXTO // 1000} KB: "
                            "li os chats mais recentes ate o limite e NAO vou avancar a data da ultima "
                            "leitura, para o resto nao se perder. Rode de novo depois de tratar estes.")
    _evento(s, "texto", f"Lendo as mensagens com o Claude Code (modelo {modelo}); costuma levar de 1 a 3 min.")
    plano, envelope = claude_cli.rodar_json(prompt, PLANO, modelo=modelo, tempo=TEMPO_CLAUDE_S,
                                            registrar=_registrar_proc)
    _registrar_proc(None)
    _conferir_cancelada(s)
    s["custo_usd"] = round(float(envelope.get("total_cost_usd") or 0), 4)
    operacoes = plano.get("operacoes")
    if not isinstance(operacoes, list):
        raise RuntimeError("O Claude Code não devolveu a lista de operações. Tente de novo.")
    s["duvidas"] = [str(d)[:300] for d in (plano.get("duvidas") or [])][:10]
    _evento(s, "ok", f"{len(operacoes)} mudança(s) propostas")
    return str(plano.get("resumo") or "").strip(), operacoes


# ---------------------------------------------------------------- 4. aplicação

def _mascarar(valor):
    if isinstance(valor, str):
        return cerebro.mascarar(valor)
    if isinstance(valor, list):
        return [_mascarar(v) for v in valor]
    if isinstance(valor, dict):
        return {k: _mascarar(v) for k, v in valor.items()}
    return valor


def _periodo(desde, ate):
    fim = f"{ate:%d/%m/%Y}"
    if not desde:
        return f"últimos {DIAS_PADRAO} dias até {fim}"
    try:
        ini = datetime.fromisoformat(desde)
    except ValueError:
        return f"até {fim}"
    return f"{ini:%d/%m} a {fim}"


def _aplicar(s, operacoes, desde, instante, chats, mensagens):
    _etapa(s, "aplicacao")
    mudancas, avisos, _ = loja.aplicar(_mascarar(operacoes), "claude-code")
    meta = {"chats_lidos": chats, "mensagens_lidas": mensagens, "periodo_lido": _periodo(desde, instante)}
    if s.get("cortado"):
        avisos.append("a data da ultima leitura nao avancou: parte das conversas nao coube nesta rodada")
    else:
        meta["ultima_leitura_teams"] = instante.replace(microsecond=0).isoformat()
    loja.definir_meta(meta)
    criadas = [m for m in mudancas if m["tipo"] == "criou"]
    s["mudancas"] = mudancas
    s["avisos"] = avisos
    s["resumo"].update({"criadas": len(criadas), "atualizadas": len(mudancas) - len(criadas)})
    _evento(s, "ok", f"{len(criadas)} criada(s), {len(mudancas) - len(criadas)} atualizada(s)")
    for a in avisos:
        _evento(s, "aviso", a)
    return [m["id"] for m in criadas]


def _ligar(s, novas):
    if not novas:
        return
    _etapa(s, "cerebro")
    try:
        ligadas, avisos = cerebro.ligar_novas(novas, loja, PONTOS_PROJETO)
    except Exception as e:  # noqa: BLE001 - o cérebro não pode derrubar a atualização
        _evento(s, "aviso", f"Não consegui ligar as pendências novas ao contexto: {e}")
        return
    s["resumo"]["ligadas"] = ligadas
    _evento(s, "ok", f"{ligadas} pendência(s) nova(s) ligada(s) a um projeto" if ligadas
            else "Nenhuma pendência nova tinha projeto evidente")
    for a in avisos:
        _evento(s, "aviso", a)


# ---------------------------------------------------------------- orquestração

def _rodar(s):
    t0 = time.time()
    try:
        dados = loja.ler()
        desde = str(dados["meta"].get("ultima_leitura_teams") or "").strip()
        s["desde"] = desde
        _copiar_cache(s)
        _conferir_cancelada(s)
        instante = datetime.now(loja.BRT)
        arquivo, chats, mensagens = _extrair(s, desde)
        if not mensagens:
            loja.definir_meta({"ultima_leitura_teams": instante.replace(microsecond=0).isoformat()})
            s["resposta"] = "Nenhuma mensagem nova desde a última leitura."
            s["status"] = "concluida"
            _evento(s, "fim", s["resposta"])
            return
        s["resposta"], operacoes = _analisar(s, arquivo, loja.ler(), desde, s["modelo"])
        novas = _aplicar(s, operacoes, desde, instante, chats, mensagens)
        _ligar(s, novas)
        s["status"] = "concluida"
        r = s["resumo"]
        _evento(s, "fim", f"Pronto: {r.get('criadas', 0)} criada(s), {r.get('atualizadas', 0)} atualizada(s)"
                          f" de {mensagens} mensagens.")
    except Cancelada:
        s["status"] = "cancelada"
        _evento(s, "fim", "Atualização parada. O que já foi aplicado continua no quadro.")
    except Exception as e:  # noqa: BLE001 - qualquer falha vira erro visível no painel
        s["status"] = "erro"
        s["erro"] = str(e)[:500]
        _evento(s, "erro", s["erro"])
    finally:
        _registrar_proc(None)
        s["fim"] = agora()
        s["duracao_ms"] = int((time.time() - t0) * 1000)
        s["etapa"] = "fim"


def iniciar(modelo="sonnet"):
    global _sync
    if not disponivel():
        raise loja.ErroPendencia("A leitura do Teams não está disponível: falta o extrair_cache.py.")
    with _trava:
        if _sync is not None and _sync["status"] == "rodando":
            raise EmCurso()
        _sync = {"id": f"t-{datetime.now():%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}",
                 "status": "rodando", "etapa": "copia", "modelo": modelo,
                 "inicio": agora(), "fim": "", "duracao_ms": 0, "custo_usd": 0,
                 "desde": "", "resposta": "", "erro": "",
                 "resumo": {}, "mudancas": [], "avisos": [], "duvidas": [], "eventos": []}
        s = _sync
    _evento(s, "inicio", "Atualização do Teams iniciada")
    threading.Thread(target=_rodar, args=(s,), daemon=True, name="teams-sync").start()
    return estado()


def cancelar():
    with _trava:
        s, proc = _sync, _proc
    if s is None:
        raise loja.ErroPendencia("não há atualização em curso")
    if s["status"] == "rodando":
        s["status"] = "cancelada"
        _matar(proc)
    return estado()


# ---------------------------------------------------------------- linha de comando

def _principal():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Atualiza as pendências a partir do cache do Teams")
    ap.add_argument("--simular", action="store_true", help="faz tudo menos gravar: mostra o plano e sai")
    ap.add_argument("--desde", help="instante ISO da última leitura (padrão: o do dados/pendencias.json)")
    ap.add_argument("--modelo", default="sonnet")
    args = ap.parse_args()
    s = {"id": "cli", "status": "rodando", "etapa": "", "modelo": args.modelo, "inicio": agora(),
         "fim": "", "duracao_ms": 0, "custo_usd": 0, "desde": "", "resposta": "", "erro": "",
         "resumo": {}, "mudancas": [], "avisos": [], "duvidas": [], "eventos": []}
    vistos = [0]

    def mostrar():
        for e in s["eventos"][vistos[0]:]:
            print(f"  [{e['tipo']}] {e['texto']}", flush=True)
        vistos[0] = len(s["eventos"])

    dados = loja.ler()
    desde = args.desde or str(dados["meta"].get("ultima_leitura_teams") or "").strip()
    print(f"Última leitura: {desde or '(nunca)'}", flush=True)
    _copiar_cache(s)
    mostrar()
    instante = datetime.now(loja.BRT)
    arquivo, chats, mensagens = _extrair(s, desde)
    mostrar()
    if not mensagens:
        print("Nada novo.")
        return
    resposta, operacoes = _analisar(s, arquivo, dados, desde, args.modelo)
    mostrar()
    print(f"\nResumo do Claude: {resposta}")
    print(json.dumps(_mascarar(operacoes), ensure_ascii=False, indent=1)[:4000])
    for d in s["duvidas"]:
        print(f"  ? {d}")
    print(f"\nCusto: US$ {s['custo_usd']}")
    if args.simular:
        print("\n--simular: nada foi gravado.")
        return
    novas = _aplicar(s, operacoes, desde, instante, chats, mensagens)
    _ligar(s, novas)
    mostrar()


if __name__ == "__main__":
    _principal()
