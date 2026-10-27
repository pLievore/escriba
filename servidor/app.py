"""Servidor local do Escriba: kanban, cérebro e agente por pendência.

Serve o painel em http://127.0.0.1:8765 (só nesta máquina) e atende:
- as pendências (loja.py), com colunas, ordem e desfazer;
- o cérebro (cerebro.py): projetos, índice local e contexto de cada pendência;
- o agente (agente.py): Claude Code rodando na pasta do projeto, só lendo arquivos;
- o assistente geral: "claude -p" com o login do próprio usuário, que devolve um plano de
  operações em JSON, validado e aplicado aqui;
- a leitura do Teams (teams.py): copia o cache, extrai as conversas novas e aplica o plano.
Só biblioteca padrão do Python. Contrato em docs/API.md.

Uso: python servidor\\app.py [--porta 8765] [--modelo sonnet] [--claude CAMINHO] [--sem-navegador]
"""
import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import agente  # noqa: E402
import cerebro  # noqa: E402
import claude_cli  # noqa: E402
import config  # noqa: E402
import daily  # noqa: E402
import jira  # noqa: E402
import loja  # noqa: E402
import teams  # noqa: E402

ESTATICO = AQUI / "static"
INSTRUCOES = AQUI / "instrucoes_assistente.md"
HOSTS = {"127.0.0.1", "localhost"}
SEMANA = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"]
MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
         "setembro", "outubro", "novembro", "dezembro"]
ID = r"[A-Za-z0-9_.~:@+%-]{1,200}"
ROTA_ITEM = re.compile(rf"^/api/pendencias/({ID})(/restaurar|/mover|/contexto|/agente|/execucoes|/jira)?$")
ROTA_EXEC = re.compile(r"^/api/execucoes/(e-[\w-]{6,40})(/cancelar)?$")
ROTA_ENTREGA = re.compile(rf"^/api/entregas/({ID})/(.{{1,300}})$")
ROTA_COPIAR = re.compile(rf"^/api/entregas/({ID})/copiar$")
ROTA_PROJETO = re.compile(rf"^/api/projetos/({ID})$")
CONFIG = {"claude": None, "modelo": "sonnet"}
UM_PEDIDO = threading.Lock()
RECURSOS = {"andamento": True, "cerebro": True, "projetos": True, "agente": True, "abrir": True,
            "teams": True, "daily": True, "jira": True}

PLANO = {
    "type": "object",
    "properties": {
        "resposta": {"type": "string"},
        "operacoes": {"type": "array", "items": {"type": "object", "properties": {
            "op": {"type": "string", "enum": ["atualizar", "criar"]},
            "id": {"type": "string"},
            "campos": {"type": "object"},
            "nota": {"type": "string"},
            "dados": {"type": "object"}}, "required": ["op"]}},
    },
    "required": ["resposta", "operacoes"],
}


class Ocupado(Exception):
    pass


class Servidor(ThreadingHTTPServer):
    daemon_threads = True
    # No Windows, reutilizar o endereço deixa duas instâncias escutando a mesma porta.
    allow_reuse_address = os.name != "nt"


# ---------------------------------------------------------------- assistente geral

def data_longa():
    d = datetime.now(loja.BRT).date()
    return f"{SEMANA[d.weekday()]}, {d.day} de {MESES[d.month - 1]} de {d.year} ({d.isoformat()})"


def pagina_inicial():
    """index.html com o config da instância e os scripts da extensão local, se houver.

    Os dois entram aqui, na hora de servir, e não no arquivo: assim nem as áreas nem o nome de quem
    usa, nem o que uma extensão local faz, precisam estar escritos em algo que vá para o Git.
    """
    scripts = list(getattr(agente._ext, "SCRIPTS", []) or []) if agente._ext else []
    dados = json.dumps(config.para_o_painel(config.RAIZ, scripts), ensure_ascii=False).replace("</", "<\\/")
    html = (ESTATICO / "index.html").read_text(encoding="utf-8")
    html = html.replace("<!--escriba:config-->", f"<script>window.ESCRIBA = {dados};</script>")
    tags = "".join(f'<script src="/static/{s}"></script>' for s in scripts if "/" in s and ".." not in s)
    html = html.replace("<!--escriba:extensoes-->", tags)
    return html.encode("utf-8")


def montar_prompt(texto, turnos, dados, foco=""):
    corte = (datetime.now(loja.BRT).date() - timedelta(days=14)).isoformat()
    projetos = {p["id"]: p["nome"] for p in cerebro.carregar_projetos()}
    lista = [
        {k: i.get(k, "") for k in ("id", "titulo", "pessoa", "area", "prioridade", "status", "prazo")}
        | {"projeto": projetos.get(i.get("projeto_id") or "", ""), "contexto": str(i.get("contexto", ""))[:220]}
        for i in dados["pendencias"]
        if i.get("status") != "descartada"
        and not (i.get("status") == "feita" and str(i.get("atualizado_em", ""))[:10] < corte)
    ]
    conversa = "\n".join(
        f"{(config.DONO.get('nome') or 'Usuário') if t.get('papel') == 'eu' else 'Assistente'}: {str(t.get('texto', ''))[:600]}"
        for t in turnos[-6:]
    ) or "(início da conversa)"
    trechos = []
    for hit in cerebro.buscar(texto, limite=5):
        trechos.append(f"- {hit['caminho']}: {hit['trecho']}")
    em_foco = ""
    if foco:
        item = next((i for i in dados["pendencias"] if i.get("id") == foco), None)
        if item:
            em_foco = f"\n\nPendência aberta na tela agora (\"esta\", \"essa\" se referem a ela): {foco} — {item.get('titulo', '')}"
    return (f"{config.preencher(INSTRUCOES.read_text(encoding='utf-8'))}\n\nHoje é {data_longa()}.\n\n"
            f"Conversa recente:\n{conversa}\n\n"
            f"Pendências atuais (JSON):\n{json.dumps(lista, ensure_ascii=False)}"
            f"{em_foco}\n\n"
            f"Trechos do cérebro (arquivos e memórias dos projetos) que podem ajudar a responder:\n"
            f"{chr(10).join(trechos) if trechos else '(nenhum)'}\n\n"
            f"Pedido de {config.dono_curto()}: {texto}")


def rodar_claude(prompt):
    plano, _ = claude_cli.rodar_json(prompt, PLANO, modelo=CONFIG["modelo"], tempo=240,
                                     preferido=CONFIG["claude"])
    return plano


def atender(corpo):
    texto = str(corpo.get("texto") or "").strip()[:2000]
    if not texto:
        raise loja.ErroPendencia("o pedido está vazio")
    turnos = [t for t in corpo.get("turnos") or [] if isinstance(t, dict)]
    if not UM_PEDIDO.acquire(blocking=False):
        raise Ocupado()
    try:
        plano = rodar_claude(montar_prompt(texto, turnos, loja.ler(), str(corpo.get("foco") or "")))
        mudancas, avisos, dados = loja.aplicar(plano.get("operacoes") or [], "assistente")
        novas = [m["id"] for m in mudancas if m["tipo"] == "criou"]
        if novas:  # sem isto a pendencia nasce sem projeto e o agente roda as cegas
            try:
                ligadas, _ = cerebro.ligar_novas(novas, loja)
                if ligadas:
                    dados = loja.ler()
            except Exception as e:  # noqa: BLE001 - ligar ao contexto nunca derruba o pedido
                avisos.append(f"nao consegui ligar as pendencias novas ao contexto: {e}")
        resposta = str(plano.get("resposta") or "").strip() or ("Pronto." if mudancas else "Não mudei nada.")
        return {"resposta": resposta, "mudancas": mudancas, "avisos": avisos, "dados": dados}
    finally:
        UM_PEDIDO.release()


# ---------------------------------------------------------------- projetos e abrir

def projetos_com_contagem():
    dados = loja.ler()
    indice = cerebro.estado_indice()
    por_projeto = indice.get("por_projeto") or {}
    saida = []
    for p in cerebro.carregar_projetos():
        doP = [i for i in dados["pendencias"] if i.get("projeto_id") == p["id"]]
        saida.append({**p, "abertas": sum(1 for i in doP if i.get("status") not in loja.FECHADAS),
                      "total": len(doP), "docs": por_projeto.get(p["id"], 0)})
    return {"projetos": saida, "indice": indice}


def abrir(corpo):
    caminho = str(corpo.get("caminho") or "").strip()
    com = str(corpo.get("com") or "explorer")
    if not caminho or not (cerebro.caminho_permitido(caminho)):
        raise loja.ErroPendencia("Só dá para abrir arquivos das pastas dos projetos, das memórias e das entregas.")
    alvo = Path(caminho)
    if not alvo.exists():
        raise loja.ErroPendencia("Esse arquivo não existe mais.")
    sem_janela = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if com == "code":
        code = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Microsoft VS Code" / "bin" / "code.cmd"
        subprocess.Popen([str(code) if code.exists() else "code", str(alvo)], creationflags=sem_janela, shell=False)
    elif alvo.is_dir():
        subprocess.Popen(["explorer", str(alvo)])
    else:
        subprocess.Popen(["explorer", f"/select,{alvo}"])
    return {"ok": True}


# ---------------------------------------------------------------- HTTP

class Painel(BaseHTTPRequestHandler):
    server_version = "Escriba/2.0"
    sys_version = ""

    def log_message(self, formato, *args):
        if "/api/execucoes/" in self.path or self.path.startswith("/api/pendencias?"):
            return  # o polling do painel encheria o terminal
        sys.stderr.write(f"[{datetime.now():%H:%M:%S}] {formato % args}\n")

    def _host_ok(self):
        return (self.headers.get("Host") or "").rsplit(":", 1)[0] in HOSTS

    def _pode_mudar(self):
        # Cabeçalho próprio + JSON: um site qualquer aberto no navegador não consegue mandar
        # isso para cá sem uma pré-verificação de CORS, que este servidor não aceita.
        return (self.headers.get("X-Mesa") == "1"
                and (self.headers.get("Content-Type") or "").startswith("application/json"))

    def _responder(self, codigo, corpo, tipo="application/json; charset=utf-8"):
        dados = corpo if isinstance(corpo, bytes) else json.dumps(corpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(dados)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if tipo.startswith("text/html"):
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
                             "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(dados)

    def _erro(self, codigo, mensagem):
        self._responder(codigo, {"erro": mensagem})

    def _corpo(self):
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho > 1_000_000:
            raise loja.ErroPendencia("pedido grande demais")
        bruto = self.rfile.read(tamanho) if tamanho else b"{}"
        try:
            corpo = json.loads(bruto.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise loja.ErroPendencia("o corpo do pedido não é JSON válido")
        if not isinstance(corpo, dict):
            raise loja.ErroPendencia("o corpo do pedido precisa ser um objeto")
        return corpo

    def _estatico(self, caminho):
        nome = caminho[len("/static/"):]
        alvo = (ESTATICO / nome).resolve()
        try:
            alvo.relative_to(ESTATICO.resolve())
        except ValueError:
            return self._erro(404, "Endereço não encontrado.")
        if not alvo.is_file():
            return self._erro(404, "Endereço não encontrado.")
        tipo = mimetypes.guess_type(alvo.name)[0] or "application/octet-stream"
        if tipo.startswith("text/") or tipo in ("application/javascript", "image/svg+xml"):
            tipo += "; charset=utf-8"
        return self._responder(200, alvo.read_bytes(), tipo)

    def _get(self, caminho, consulta):
        if caminho in ("/", "/index.html"):
            return self._responder(200, pagina_inicial(), "text/html; charset=utf-8")
        if caminho.startswith("/static/"):
            return self._estatico(caminho)
        if caminho == "/api/pendencias":
            return self._responder(200, loja.ler())
        if caminho == "/api/status":
            cli = claude_cli.achar(CONFIG["claude"])
            return self._responder(200, {
                "assistente": bool(cli), "claude": f"{cli['versao']} ({cli['caminho']})" if cli else "",
                "modelo": CONFIG["modelo"], "versao": loja.ler()["versao"], "indice": cerebro.estado_indice(),
                "recursos": {**RECURSOS, "agente": bool(cli), "teams": bool(cli) and teams.disponivel(),
                             "jira": jira.disponivel()}})
        if caminho == "/api/projetos":
            return self._responder(200, projetos_com_contagem())
        if caminho == "/api/cerebro/status":
            return self._responder(200, {"indice": cerebro.estado_indice()})
        if caminho == "/api/jira":
            return self._responder(200, jira.estado())
        if caminho == "/api/daily":
            return self._responder(200, daily.montar(desde=(consulta.get("desde") or [""])[0][:40]))
        if caminho == "/api/teams":
            desde = (consulta.get("desde") or ["0"])[0]
            return self._responder(200, {"sync": teams.estado(int(desde) if desde.isdigit() else 0)})
        if caminho == "/api/cerebro/busca":
            q = (consulta.get("q") or [""])[0]
            pid = (consulta.get("projeto") or [""])[0]
            projetos = cerebro.familia(pid, cerebro.carregar_projetos()) if pid else None
            return self._responder(200, {"resultados": [{**h, "origem": "busca"} for h in cerebro.buscar(q, projetos=projetos, limite=20)]})
        rota = ROTA_ITEM.match(caminho)
        if rota and rota.group(2) == "/contexto":
            dados = loja.ler()
            item = loja._achar(dados, unquote(rota.group(1)))
            ctx = cerebro.contexto_da_pendencia(item, dados["pendencias"])
            # as pastas que o agente abriria agora: a confirmação do painel precisa dizer isso antes
            ctx["pastas"] = cerebro.pastas_para_agente(item, ctx)
            return self._responder(200, ctx)
        if rota and rota.group(2) == "/execucoes":
            return self._responder(200, {"execucoes": agente.listar(unquote(rota.group(1)))})
        rota = ROTA_EXEC.match(caminho)
        if rota and not rota.group(2):
            desde = (consulta.get("desde") or ["0"])[0]
            return self._responder(200, {"execucao": agente.obter(rota.group(1), int(desde) if desde.isdigit() else 0)})
        rota = ROTA_ENTREGA.match(caminho)
        if rota:
            arq = agente.caminho_entrega(unquote(rota.group(1)), unquote(rota.group(2)))
            if not arq:
                return self._erro(404, "Entrega não encontrada.")
            return self._responder(200, arq.read_bytes(), "text/plain; charset=utf-8")
        return self._erro(404, "Endereço não encontrado.")

    def _post(self, metodo, caminho, corpo):
        if metodo == "POST" and caminho == "/api/pendencias":
            mudanca, dados = loja.criar(corpo.get("campos") or {}, "painel")
            return self._responder(200, {"mudanca": mudanca, "dados": dados})
        if metodo == "POST" and caminho == "/api/assistente":
            return self._responder(200, atender(corpo))
        if metodo == "POST" and caminho == "/api/cerebro/indexar":
            cerebro.indexar_em_segundo_plano()
            return self._responder(200, {"indice": cerebro.estado_indice()})
        if metodo == "POST" and caminho == "/api/abrir":
            return self._responder(200, abrir(corpo))
        if metodo == "POST" and caminho == "/api/teams/atualizar":
            return self._responder(200, {"sync": teams.iniciar(CONFIG["modelo"])})
        if metodo == "POST" and caminho == "/api/teams/cancelar":
            return self._responder(200, {"sync": teams.cancelar()})
        rota = ROTA_COPIAR.match(caminho)
        if rota and metodo == "POST":
            return self._responder(200, agente.copiar_entrega(
                unquote(rota.group(1)), str(corpo.get("eid") or ""), str(corpo.get("projeto_id") or ""),
                bool(corpo.get("confirmar"))))
        rota = ROTA_PROJETO.match(caminho)
        if rota and metodo == "PATCH":
            try:
                projeto = cerebro.alterar_projeto(unquote(rota.group(1)), corpo.get("campos") or {})
            except ValueError as e:
                raise loja.ErroPendencia(str(e))
            return self._responder(200, {"projeto": projeto})
        rota = ROTA_EXEC.match(caminho)
        if rota and rota.group(2) and metodo == "POST":
            return self._responder(200, {"execucao": agente.cancelar(rota.group(1))})
        rota = ROTA_ITEM.match(caminho)
        if rota:
            id_, sufixo = unquote(rota.group(1)), rota.group(2)
            if metodo == "PATCH" and not sufixo:
                mudanca, dados = loja.alterar(id_, corpo.get("campos") or {}, corpo.get("nota") or "", "painel",
                                              str(corpo.get("se_atualizado_em") or ""))
                return self._responder(200, {"mudanca": mudanca, "dados": dados})
            if metodo == "POST" and sufixo == "/mover":
                mudanca, dados = loja.mover(id_, str(corpo.get("status") or ""), corpo.get("posicao", 0), "painel")
                return self._responder(200, {"mudanca": mudanca, "dados": dados})
            if metodo == "POST" and sufixo == "/restaurar":
                return self._responder(200, {"dados": loja.restaurar(id_, corpo.get("antes"))})
            if metodo == "POST" and sufixo == "/jira":
                # sem "confirmar" nada é criado: a resposta é só a prévia do que iria
                return self._responder(200, jira.criar(id_, str(corpo.get("epico") or ""),
                                                       str(corpo.get("tipo") or ""), bool(corpo.get("confirmar"))))
            if metodo == "POST" and sufixo == "/agente":
                ex = agente.iniciar(id_, str(corpo.get("modo") or ""), corpo.get("instrucao") or "", CONFIG["modelo"],
                                    corpo.get("projetos") or [])
                return self._responder(200, {"execucao": ex})
            if metodo == "DELETE" and not sufixo:
                return self._responder(200, {"dados": loja.remover(id_)})
        return self._erro(404, "Endereço não encontrado.")

    def _tratar(self, metodo):
        url = urlparse(self.path)
        if not self._host_ok():
            return self._erro(403, "Acesso permitido só por 127.0.0.1.")
        if metodo != "GET" and not self._pode_mudar():
            return self._erro(403, "Pedido sem os cabeçalhos do painel.")
        try:
            if metodo == "GET":
                return self._get(url.path, parse_qs(url.query))
            return self._post(metodo, url.path, self._corpo())
        except loja.Conflito as e:
            # 409 com o estado novo junto: o painel mostra o que mudou em vez de salvar por cima
            return self._responder(409, {"erro": str(e), "conflito": {"pendencia": e.item}, "dados": loja.ler()})
        except loja.ErroPendencia as e:
            return self._erro(400, str(e))
        except Ocupado:
            return self._erro(409, "O assistente ainda está respondendo o pedido anterior.")
        except teams.EmCurso:
            return self._erro(409, "A leitura do Teams já está rodando.")
        except RuntimeError as e:
            return self._erro(502, str(e))
        except Exception as e:  # noqa: BLE001 - o painel precisa de uma resposta, não de um traceback
            self.log_message("erro inesperado: %r", e)
            return self._erro(500, "Erro inesperado no servidor; veja o terminal.")

    def do_GET(self):
        self._tratar("GET")

    def do_POST(self):
        self._tratar("POST")

    def do_PATCH(self):
        self._tratar("PATCH")

    def do_DELETE(self):
        self._tratar("DELETE")


def main():
    ap = argparse.ArgumentParser(description=f"Servidor local {config.do_produto()}")
    ap.add_argument("--porta", type=int, default=8765)
    ap.add_argument("--modelo", default="sonnet", help="modelo do assistente e do agente: sonnet, opus, haiku ou um id completo")
    ap.add_argument("--claude", help="caminho do executável do Claude Code CLI")
    ap.add_argument("--sem-navegador", action="store_true", help="não abrir o navegador ao iniciar")
    args = ap.parse_args()
    CONFIG["modelo"] = args.modelo
    CONFIG["claude"] = args.claude
    url = f"http://127.0.0.1:{args.porta}/"
    try:
        servidor = Servidor(("127.0.0.1", args.porta), Painel)
    except OSError:
        print(f"{config.o_produto().capitalize()} já está rodando em {url} (ou a porta {args.porta} está ocupada).", flush=True)
        if not args.sem_navegador:
            webbrowser.open(url)
        return
    loja.migrar()
    agente.marcar_interrompidas()
    cerebro.indexar_em_segundo_plano()
    cli = claude_cli.achar(args.claude)
    print(f"{config.PRODUTO} em {url}", flush=True)
    print(f"Claude Code: {cli['versao'] + ' em ' + cli['caminho'] if cli else 'não encontrado'} (modelo {CONFIG['modelo']})", flush=True)
    print("Atualizando o índice do cérebro em segundo plano. Ctrl+C para parar.", flush=True)
    if not args.sem_navegador:
        threading.Timer(0.6, webbrowser.open, args=(url,)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
