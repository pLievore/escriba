"""Pendências do Escriba num arquivo JSON local.

Tudo fica em dados/pendencias.json. A gravação é atômica (arquivo temporário +
os.replace) e protegida por uma trava entre processos, para o servidor, o servidor
MCP e o Claude Code (via pendencias.py) poderem escrever no mesmo arquivo.
"""
import json
import os
import re
import time
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "dados"
ARQUIVO = DADOS / "pendencias.json"
BACKUP = DADOS / "pendencias.bak.json"
TRAVA = DADOS / ".trava"
BRT = timezone(timedelta(hours=-3))

AREAS = config.AREAS          # as áreas da instância vêm do config.local.json
PRIORIDADES = {"urgente": "urgente", "semana": "esta semana", "acompanhar": "acompanhar"}
STATUS = {"aberta": "a fazer", "andamento": "em andamento", "aguardando": "aguardando outros",
          "feita": "feita", "descartada": "descartada"}
FECHADAS = {"feita", "descartada"}
TEXTOS = {"titulo": 160, "pessoa": 120, "contexto": 1500, "origem": 120, "aguardando_de": 120}
MODOS_AGENTE = {"resolve_sozinho", "prepara_rascunho", "so_humano", ""}
ORIGENS = {"painel", "assistente", "claude-code", "mcp", "agente"}
ATOR = {"painel": "por você, em outra aba", "assistente": "pelo assistente", "claude-code": "pela leitura do Teams",
        "mcp": "pelo Claude Code", "agente": "pelo agente"}
ORIGEM_PADRAO = {"painel": "Adicionada no painel", "assistente": "Pedido ao assistente",
                 "claude-code": "Leitura do Teams", "mcp": "Sessão do Claude Code", "agente": "Agente"}
DATA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_PROJETO = re.compile(r"^[a-z0-9-]{0,80}$")

try:
    import msvcrt

    def _travar(f):
        while True:
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                time.sleep(0.05)

    def _destravar(f):
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
except ImportError:  # fora do Windows
    import fcntl

    def _travar(f):
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)

    def _destravar(f):
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


class Conflito(ValueError):
    """A pendência mudou por outra via depois do retrato que o painel tinha na mão.

    Quem escreve aqui não é só o usuário: a leitura do Teams, o agente e o MCP gravam no mesmo
    arquivo. Sem esta checagem, uma gaveta aberta há dois minutos salvava por cima do que a
    leitura do Teams acabara de anotar, e ninguém via o que se perdeu.
    """

    def __init__(self, item, mensagem):
        super().__init__(mensagem)
        self.item = item


class ErroPendencia(ValueError):
    """Pedido inválido; a mensagem volta para quem pediu."""


@contextmanager
def _exclusivo():
    DADOS.mkdir(parents=True, exist_ok=True)
    with open(TRAVA, "a+b") as f:
        f.seek(0)
        _travar(f)
        try:
            yield
        finally:
            f.seek(0)
            _destravar(f)


def _ler():
    if not ARQUIVO.exists():
        return {"versao": 0, "meta": {}, "pendencias": []}
    try:
        with open(ARQUIVO, encoding="utf-8") as f:
            dados = json.load(f)
        if not isinstance(dados, dict):
            raise ValueError("o arquivo não tem um objeto na raiz")
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
        # arquivo quebrado: não apagar nada e não deixar o servidor subir por cima do estrago
        copia = ARQUIVO.with_name(f"{ARQUIVO.name}.quebrado-{datetime.now():%Y%m%d%H%M%S}")
        try:
            os.replace(ARQUIVO, copia)
            if BACKUP.exists():
                import shutil
                shutil.copy2(BACKUP, ARQUIVO)
        except OSError:
            raise ErroPendencia(f"o {ARQUIVO.name} está ilegível ({e}); guardei em {copia.name}")
        raise ErroPendencia(f"o {ARQUIVO.name} estava ilegível ({e}); guardei em {copia.name} e "
                            f"voltei para a cópia {BACKUP.name}. Confira o quadro.")
    dados.setdefault("versao", 0)
    dados.setdefault("meta", {})
    dados.setdefault("pendencias", [])
    return dados


def _gravar(dados):
    dados["versao"] = int(dados.get("versao") or 0) + 1
    tmp = ARQUIVO.with_name(ARQUIVO.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    if ARQUIVO.exists():   # uma geração de cópia: é o único lugar onde as pendências existem
        try:
            os.replace(ARQUIVO, BACKUP)
        except OSError:
            pass
    for tentativa in range(5):   # no Windows um antivírus ou indexador segura o arquivo por instantes
        try:
            os.replace(tmp, ARQUIVO)
            return
        except PermissionError:
            if tentativa == 4:
                raise
            time.sleep(0.1)


def agora():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hoje():
    return datetime.now(BRT).date().isoformat()


def fmt_dia(iso):
    return f"{iso[8:10]}/{iso[5:7]}" if DATA.match(iso or "") else ""


def descrever(campos):
    partes = []
    if "status" in campos:
        partes.append(f"agora {STATUS[campos['status']]}")
    if "prioridade" in campos:
        partes.append(f"prioridade {PRIORIDADES[campos['prioridade']]}")
    if "prazo" in campos:
        partes.append(f"prazo {fmt_dia(campos['prazo'])}" if campos["prazo"] else "sem prazo")
    if "titulo" in campos:
        partes.append("título editado")
    if "pessoa" in campos:
        partes.append(f"pessoa: {campos['pessoa']}")
    if "area" in campos:
        partes.append(f"área: {campos['area']}")
    if "projeto_id" in campos:
        partes.append("projeto ligado" if campos["projeto_id"] else "projeto desligado")
    if "aguardando_de" in campos:
        partes.append(f"aguardando {campos['aguardando_de']}" if campos["aguardando_de"] else "sem quem aguardar")
    if "cobrar_em" in campos:
        partes.append(f"cobrar em {fmt_dia(campos['cobrar_em'])}" if campos["cobrar_em"] else "sem cobrança marcada")
    if "contexto" in campos:
        partes.append("contexto atualizado")
    if "ligacoes" in campos:
        partes.append("ligações do cérebro atualizadas")
    if "jira" in campos:
        partes.append(f"Jira: {campos['jira'].get('chave') or 'desvinculada'}")
    return ", ".join(partes)


def _slug(texto):
    t = unicodedata.normalize("NFD", str(texto)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:40] or "pendencia"


CHAVE_JIRA = re.compile(r"^[A-Z][A-Z0-9]{1,9}-\d{1,8}$")


def _limpar_jira(v):
    """O que a Mesa guarda da issue criada no Jira. Nunca guarda credencial."""
    if not isinstance(v, dict):
        raise ErroPendencia("os dados do Jira precisam vir num objeto")
    chave = str(v.get("chave") or "").strip().upper()
    if chave and not CHAVE_JIRA.match(chave):
        raise ErroPendencia(f"chave de issue inválida: {chave!r}")
    url = str(v.get("url") or "").strip()[:300]
    if url and not url.startswith("https://"):
        raise ErroPendencia("o link da issue precisa ser https")
    return {"chave": chave, "url": url,
            "epico": str(v.get("epico") or "").strip().upper()[:20],
            "sprint": str(v.get("sprint") or "").strip()[:80],
            "em": str(v.get("em") or "")[:30]}


def _limpar_ligacoes(v):
    if not isinstance(v, dict):
        raise ErroPendencia("as ligações precisam vir num objeto")
    arquivos = []
    for a in (v.get("arquivos") or [])[:20]:
        if isinstance(a, dict) and str(a.get("caminho") or "").strip():
            arquivos.append({"caminho": str(a["caminho"]).strip()[:400], "motivo": str(a.get("motivo") or "").strip()[:400]})
    notas = [str(n).strip()[:120] for n in (v.get("notas") or [])[:20] if str(n).strip()]
    agente = str(v.get("agente") or "").strip()
    if agente not in MODOS_AGENTE:
        agente = ""
    return {"arquivos": arquivos, "notas": notas, "agente": agente, "como_ajuda": str(v.get("como_ajuda") or "").strip()[:600]}


def _limpar(campos):
    """Valida e normaliza campos editáveis; levanta ErroPendencia com a regra quebrada."""
    if not isinstance(campos, dict):
        raise ErroPendencia("os campos precisam vir num objeto")
    campos = dict(campos)
    if "projeto" in campos and "area" not in campos:  # nome antigo da área
        campos["area"] = campos.pop("projeto")
    else:
        campos.pop("projeto", None)
    saida = {}
    for k, v in campos.items():
        if k in TEXTOS:
            saida[k] = str(v if v is not None else "").strip()[: TEXTOS[k]]
        elif k == "area":
            v = str(v or "").strip()
            if v not in AREAS:
                raise ErroPendencia(f"área inválida: {v!r}")
            saida[k] = v
        elif k == "projeto_id":
            v = str(v or "").strip()
            if not ID_PROJETO.match(v):
                raise ErroPendencia(f"id de projeto inválido: {v!r}")
            saida[k] = v
        elif k == "prioridade":
            v = str(v or "").strip()
            if v not in PRIORIDADES:
                raise ErroPendencia(f"prioridade inválida: {v!r}")
            saida[k] = v
        elif k == "status":
            v = str(v or "").strip()
            if v not in STATUS:
                raise ErroPendencia(f"status inválido: {v!r}")
            saida[k] = v
        elif k in ("prazo", "cobrar_em"):
            v = str(v or "").strip()
            if v and not DATA.match(v):
                raise ErroPendencia(("o prazo" if k == "prazo" else "a data de cobrança") + " precisa ser AAAA-MM-DD")
            saida[k] = v
        elif k == "ordem":
            try:
                saida[k] = float(v)
            except (TypeError, ValueError):
                raise ErroPendencia("a ordem precisa ser um número")
        elif k == "ligacoes":
            saida[k] = _limpar_ligacoes(v)
        elif k == "jira":
            saida[k] = _limpar_jira(v)
        else:
            raise ErroPendencia(f"campo desconhecido: {k}")
    if "titulo" in saida and not saida["titulo"]:
        raise ErroPendencia("o título não pode ficar vazio")
    return saida


def _achar(dados, id_):
    for item in dados["pendencias"]:
        if item.get("id") == id_:
            return item
    raise ErroPendencia(f"não existe pendência com id {id_!r}")


def _anotar(item, texto, origem, status=""):
    """Anota no histórico. `status` marca a transição, quando houve.

    Sem essa marca não dá para saber depois quando a pendência foi fechada: o texto da entrada
    costuma ser a nota de quem mudou ("Respondeu em 21/10: segue a base"), não o campo que mudou.
    """
    historico = list(item.get("historico") or [])
    entrada = {"em": agora(), "texto": str(texto)[:300], "origem": origem}
    if status:
        entrada["status"] = status
    historico.append(entrada)
    item["historico"] = historico[-30:]


def _alterar(dados, id_, campos, nota, origem):
    item = _achar(dados, id_)
    limpos = _limpar(campos)
    mudou = {k: v for k, v in limpos.items() if item.get(k, "" if k != "ligacoes" else {}) != v}
    nota = str(nota or "").strip()[:300]
    if not mudou and not nota:
        return None
    antes = {k: item.get(k, "") for k in mudou}
    antes["historico"] = [dict(h) for h in item.get("historico") or []]
    antes["atualizado_em"] = item.get("atualizado_em", "")
    antes["atualizado_por"] = item.get("atualizado_por", "")
    if "status" in mudou and "ordem" not in mudou:  # vai para o fim da coluna nova
        mudou["ordem"] = _proxima_ordem(dados, mudou["status"], item)
        antes.setdefault("ordem", item.get("ordem", 0))
    item.update(mudou)
    so_ordem = set(mudou) <= {"ordem"}
    if not so_ordem or nota:
        _anotar(item, nota or descrever(mudou), origem, mudou.get("status", ""))
    item["atualizado_em"] = agora()
    item["atualizado_por"] = origem
    return {"tipo": "alterou", "id": id_, "titulo": item["titulo"], "resumo": descrever(mudou) or (f"nota: {nota}" if nota else "posição alterada"), "antes": antes}


def _proxima_ordem(dados, status, ignorar=None):
    ordens = [float(i.get("ordem") or 0) for i in dados["pendencias"] if i.get("status") == status and i is not ignorar]
    return (max(ordens) if ordens else 0) + 10


def _criar(dados, campos, origem):
    if not isinstance(campos, dict):
        raise ErroPendencia("os dados da pendência precisam vir num objeto")
    campos = dict(campos)
    if "projeto" in campos and "area" not in campos:
        campos["area"] = campos.pop("projeto")
    base = {k: campos[k] for k in ("titulo", "pessoa", "area", "projeto_id", "prioridade", "prazo", "contexto", "origem", "status",
                                   "ligacoes", "jira", "aguardando_de", "cobrar_em")
            if campos.get(k) not in (None, "")}
    if base.get("area") not in AREAS:
        base["area"] = config.AREA_PADRAO
    if base.get("prioridade") not in PRIORIDADES:
        base["prioridade"] = "semana"
    if base.get("status") not in STATUS or base.get("status") == "descartada":
        base["status"] = "aberta"
    limpos = _limpar(base)
    if not limpos.get("titulo"):
        raise ErroPendencia("a pendência precisa de um título")
    existentes = {i.get("id") for i in dados["pendencias"]}
    id_ = _slug(limpos["titulo"])
    while id_ in existentes:
        id_ = f"{_slug(limpos['titulo'])}-{uuid.uuid4().hex[:4]}"
    t = agora()
    item = {
        "id": id_,
        "titulo": limpos["titulo"],
        "pessoa": limpos.get("pessoa", ""),
        "area": limpos["area"],
        "projeto_id": limpos.get("projeto_id", ""),
        "prioridade": limpos["prioridade"],
        "status": limpos["status"],
        "ordem": _proxima_ordem(dados, limpos["status"]),
        "prazo": limpos.get("prazo", ""),
        "aguardando_de": limpos.get("aguardando_de", ""),
        "cobrar_em": limpos.get("cobrar_em", ""),
        "contexto": limpos.get("contexto", ""),
        "origem": limpos.get("origem") or ORIGEM_PADRAO.get(origem, ""),
        "pedido_em": hoje(),
        "historico": [{"em": t, "texto": "Criada", "origem": origem, "status": limpos["status"]}],
        "criado_em": t,
        "atualizado_em": t,
        "atualizado_por": origem,
        "ligacoes": limpos.get("ligacoes", {"arquivos": [], "notas": [], "agente": "", "como_ajuda": ""}),
    }
    dados["pendencias"].append(item)
    return {"tipo": "criou", "id": id_, "titulo": item["titulo"]}


def _migrar_item(item):
    mudou = False
    if "area" not in item:
        area = item.pop("projeto", "")
        item["area"] = area if area in AREAS else config.AREA_PADRAO
        mudou = True
    elif item.get("projeto") in AREAS or "projeto" in item:
        item.pop("projeto", None)
        mudou = True
    for k, padrao in (("projeto_id", ""), ("prazo", ""), ("contexto", ""), ("pessoa", ""),
                      ("aguardando_de", ""), ("cobrar_em", "")):
        if k not in item:
            item[k] = padrao
            mudou = True
    if not isinstance(item.get("contexto"), str):  # versão intermediária guardava o cérebro aqui
        item.setdefault("ligacoes", item["contexto"] if isinstance(item["contexto"], dict) else {})
        item["contexto"] = ""
        mudou = True
    if not isinstance(item.get("ligacoes"), dict):
        item["ligacoes"] = {"arquivos": [], "notas": [], "agente": "", "como_ajuda": ""}
        mudou = True
    if item.get("status") not in STATUS:
        item["status"] = "aberta"
        mudou = True
    return mudou


def migrar():
    """Converte dados antigos para o formato atual (área, projeto_id, ordem, ligações)."""
    with _exclusivo():
        dados = _ler()
        mudou = False
        for item in dados["pendencias"]:
            mudou |= _migrar_item(item)
        por_status = {}
        for item in dados["pendencias"]:
            por_status.setdefault(item["status"], []).append(item)
        for itens in por_status.values():
            if all(isinstance(i.get("ordem"), (int, float)) for i in itens):
                continue
            itens.sort(key=lambda i: (i.get("prazo") or "9999-12-31", i.get("pedido_em") or "", i.get("titulo") or ""))
            for n, i in enumerate(itens, 1):
                i["ordem"] = n * 10
            mudou = True
        if mudou:
            _gravar(dados)
        return mudou


# ---------- operações públicas: cada uma lê, muda e grava sob a trava ----------

def ler():
    with _exclusivo():
        dados = _ler()
    for item in dados["pendencias"]:
        _migrar_item(item)  # só na memória: quem lê sempre vê o formato atual
    return dados


def obter(id_):
    dados = ler()
    return _achar(dados, id_)


def criar(campos, origem="painel"):
    with _exclusivo():
        dados = _ler()
        mudanca = _criar(dados, campos, origem)
        _gravar(dados)
        return mudanca, dados


def alterar(id_, campos, nota="", origem="painel", se_atualizado_em=""):
    """Altera a pendência. Com `se_atualizado_em`, recusa (Conflito) se ela mudou desde esse retrato."""
    with _exclusivo():
        dados = _ler()
        if se_atualizado_em:
            item = _achar(dados, id_)
            _migrar_item(item)
            atual = str(item.get("atualizado_em") or "")
            if atual and atual != str(se_atualizado_em):
                quem = ATOR.get(item.get("atualizado_por"), "por outra via")
                raise Conflito(item, f"“{item['titulo']}” mudou {quem} enquanto você editava.")
        mudanca = _alterar(dados, id_, campos, nota, origem)
        if mudanca:
            _gravar(dados)
        return mudanca, dados


def mover(id_, status, posicao, origem="painel"):
    """Põe a pendência na coluna `status`, na posição `posicao` (0 = topo), e renumera a coluna."""
    if status not in STATUS:
        raise ErroPendencia(f"status inválido: {status!r}")
    try:
        posicao = max(0, int(posicao))
    except (TypeError, ValueError):
        raise ErroPendencia("a posição precisa ser um número inteiro")
    with _exclusivo():
        dados = _ler()
        item = _achar(dados, id_)
        coluna = sorted((i for i in dados["pendencias"] if i.get("status") == status and i is not item),
                        key=lambda i: (float(i.get("ordem") or 0), i.get("prazo") or "9999", i.get("pedido_em") or ""))
        coluna.insert(min(posicao, len(coluna)), item)
        antes_ordem = item.get("ordem", 0)
        for n, i in enumerate(coluna, 1):
            if i is not item:
                i["ordem"] = n * 10
        mudanca = _alterar(dados, id_, {"status": status, "ordem": coluna.index(item) * 10 + 10}, "", origem)
        if mudanca:
            mudanca["antes"].setdefault("ordem", antes_ordem)
        _gravar(dados)
        return mudanca, dados


def restaurar(id_, antes):
    """Desfaz uma alteração: devolve os campos e o histórico guardados em `antes`."""
    if not isinstance(antes, dict):
        raise ErroPendencia("nada para desfazer")
    with _exclusivo():
        dados = _ler()
        item = _achar(dados, id_)
        editaveis = {k: v for k, v in antes.items() if k in TEXTOS or k in ("area", "projeto_id", "prioridade", "status", "prazo", "cobrar_em", "ordem", "ligacoes", "jira")}
        item.update(_limpar(editaveis))
        if isinstance(antes.get("historico"), list):
            # o retrato pode ser de horas atrás: o que o agente e a leitura do Teams anotaram
            # depois dele continua valendo, senão o desfazer apagaria essas notas sem avisar
            anterior = [h for h in antes["historico"] if isinstance(h, dict)]
            vistos = {(h.get("em"), h.get("texto"), h.get("origem")) for h in anterior}
            posteriores = [h for h in (item.get("historico") or [])
                           if isinstance(h, dict) and (h.get("em"), h.get("texto"), h.get("origem")) not in vistos]
            item["historico"] = (anterior + posteriores)[-30:]
        for k in ("atualizado_em", "atualizado_por"):
            if k in antes:
                item[k] = str(antes[k] or "")
        _gravar(dados)
        return dados


def remover(id_):
    """Apaga de vez — só serve para desfazer uma criação recente.

    A regra é não apagar pendência (usar status `descartada`), e a pilha de desfazer do
    painel guarda ações da sessão inteira: sem esta checagem, um Ctrl+Z tardio levava junto o
    histórico e as entregas de algo em que o agente já tinha trabalhado.
    """
    with _exclusivo():
        dados = _ler()
        item = _achar(dados, id_)
        if int((item.get("agente") or {}).get("total") or 0):
            raise ErroPendencia(f"“{item['titulo']}” já teve execução do agente; descarte em vez de apagar")
        # pelo histórico, e não pelo horário: o carimbo tem resolução de segundo e criar e editar
        # na mesma sessão caem no mesmo segundo
        if any(h.get("origem") == "painel" for h in (item.get("historico") or [])[1:]):
            raise ErroPendencia(f"“{item['titulo']}” foi editada por você; descarte em vez de apagar")
        dados["pendencias"].remove(item)
        _gravar(dados)
        return dados


def definir_meta(campos):
    with _exclusivo():
        dados = _ler()
        dados["meta"].update({k: v for k, v in campos.items() if isinstance(k, str)})
        _gravar(dados)
        return dados


def registrar_execucao(id_, resumo, nota=""):
    """Guarda na pendência o resumo da última execução do agente (sem passar pela validação de campos)."""
    with _exclusivo():
        dados = _ler()
        item = _achar(dados, id_)
        agente = dict(item.get("agente") or {})
        anterior = agente.get("ultima") or {}
        if anterior.get("id") != resumo.get("id"):
            agente["total"] = int(agente.get("total") or 0) + 1
        agente["ultima"] = resumo
        item["agente"] = agente
        if nota:
            _anotar(item, nota, "agente")
        _gravar(dados)
        return dados


def aplicar(operacoes, origem):
    """Aplica operações {"op": "atualizar" | "criar", ...} de uma vez.

    Devolve (mudancas, avisos, dados). Uma operação inválida vira aviso e não impede
    as outras. A leitura do Teams (origem "claude-code") nunca reabre o que o usuário
    fechou no painel ou pelo assistente, a não ser com "forcar": true na operação.
    """
    if not isinstance(operacoes, list):
        raise ErroPendencia("as operações precisam vir numa lista")
    mudancas, avisos = [], []
    with _exclusivo():
        dados = _ler()
        for item in dados["pendencias"]:
            _migrar_item(item)
        for n, op in enumerate(operacoes, 1):
            try:
                if not isinstance(op, dict):
                    raise ErroPendencia("operação fora do formato")
                tipo = op.get("op")
                if tipo == "atualizar":
                    id_ = str(op.get("id") or "")
                    campos = op.get("campos") or {}
                    if origem == "claude-code" and not op.get("forcar"):
                        item = _achar(dados, id_)
                        reabre = isinstance(campos, dict) and campos.get("status") in ("aberta", "andamento", "aguardando")
                        if reabre and item.get("status") in FECHADAS and item.get("atualizado_por") in ("painel", "assistente", "mcp"):
                            raise ErroPendencia(f"“{item['titulo']}” foi fechada por você; não reabri")
                    mudanca = _alterar(dados, id_, campos, op.get("nota"), origem)
                    if mudanca:
                        mudancas.append(mudanca)
                elif tipo == "criar":
                    mudancas.append(_criar(dados, op.get("dados") or {}, origem))
                else:
                    raise ErroPendencia(f"operação desconhecida: {tipo!r}")
            except ErroPendencia as e:
                avisos.append(f"operação {n}: {e}")
        if mudancas:
            _gravar(dados)
        return mudancas, avisos, dados
