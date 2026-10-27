"""Criar tarefa no Jira da empresa a partir de uma pendência — só no clique do usuário.

É a única coisa no Escriba que escreve fora desta máquina. Por isso:
- a credencial fica no Gerenciador de Credenciais do Windows (alvo `jira.credencial` do config), nunca em
  arquivo, nunca no git, nunca numa pendência: `guardar()` grava, `ler()` lê na hora de usar;
- nada é criado sem `confirmar=True`; sem ele, `criar()` só devolve a prévia do que iria;
- a chave criada (ABC-1234) volta para a pendência, com link, e entra no histórico.

Alvo: o Jira Cloud, o projeto, o quadro e o épico padrão de `config.local.json` (chave "jira").
A issue nasce no épico escolhido, atribuída ao usuário e **na sprint ativa do quadro** — a sprint é
consultada na hora, porque elas giram toda semana. Só biblioteca padrão.
"""
import base64
import ctypes
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from ctypes import wintypes
from datetime import datetime
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import config  # noqa: E402
import loja  # noqa: E402

ALVO = config.JIRA["credencial"]
PADRAO = {k: config.JIRA[k] for k in ("base", "projeto", "quadro", "epico", "tipo", "campo_sprint")}
TEMPO_S = 30
MAX_EPICOS = 50


# ---------------------------------------------------------------- credencial (Gerenciador do Windows)

class _CREDENCIAL(ctypes.Structure):
    _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
                ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME),
                ("CredentialBlobSize", wintypes.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_char)),
                ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
                ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]


def guardar(email, token):
    """Grava e-mail e token no Gerenciador de Credenciais do Windows."""
    if not email or not token:
        raise loja.ErroPendencia("informe o e-mail da conta Atlassian e o token")
    blob = str(token).encode("utf-8")
    cred = _CREDENCIAL(Flags=0, Type=1, TargetName=ALVO, Comment=config.PRODUTO,
                       CredentialBlobSize=len(blob),
                       CredentialBlob=ctypes.cast(ctypes.create_string_buffer(blob), ctypes.POINTER(ctypes.c_char)),
                       Persist=2, AttributeCount=0, Attributes=None, TargetAlias=None, UserName=str(email))
    if not ctypes.windll.advapi32.CredWriteW(ctypes.byref(cred), 0):
        raise loja.ErroPendencia(f"não consegui gravar a credencial (erro {ctypes.GetLastError()})")
    return True


def ler():
    """(e-mail, token) do Gerenciador de Credenciais, ou None se não houver."""
    ponteiro = ctypes.POINTER(_CREDENCIAL)()
    if not ctypes.windll.advapi32.CredReadW(ALVO, 1, 0, ctypes.byref(ponteiro)):
        return None
    try:
        c = ponteiro.contents
        token = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize).decode("utf-8", "replace")
        return (c.UserName or "", token)
    finally:
        ctypes.windll.advapi32.CredFree(ponteiro)


def apagar():
    return bool(ctypes.windll.advapi32.CredDeleteW(ALVO, 1, 0))


# ---------------------------------------------------------------- configuração e chamadas

def config(meta=None):
    meta = meta if meta is not None else loja.ler()["meta"]
    cfg = meta.get("jira") if isinstance(meta.get("jira"), dict) else {}
    return {**PADRAO, **{k: v for k, v in cfg.items() if v not in (None, "")}}


def disponivel():
    if not PADRAO.get("base") or not PADRAO.get("projeto"):
        return False          # sem Jira no config.local.json, o botão nem aparece
    try:
        return ler() is not None
    except OSError:
        return False


def _pedir(caminho, metodo="GET", corpo=None, cfg=None):
    cfg = cfg or config()
    cred = ler()
    if not cred:
        raise loja.ErroPendencia("o Jira ainda não foi configurado nesta máquina (falta a credencial)")
    auth = base64.b64encode(f"{cred[0]}:{cred[1]}".encode()).decode()
    dados = json.dumps(corpo, ensure_ascii=False).encode("utf-8") if corpo is not None else None
    req = urllib.request.Request(cfg["base"] + caminho, data=dados, method=metodo, headers={
        "Authorization": f"Basic {auth}", "Accept": "application/json",
        **({"Content-Type": "application/json"} if dados else {})})
    try:
        with urllib.request.urlopen(req, timeout=TEMPO_S) as r:
            texto = r.read().decode("utf-8")
            return json.loads(texto) if texto.strip() else {}
    except urllib.error.HTTPError as e:
        detalhe = e.read().decode("utf-8", "replace")[:600]
        try:
            erros = json.loads(detalhe)
            msg = "; ".join(erros.get("errorMessages") or []) or "; ".join(
                f"{k}: {v}" for k, v in (erros.get("errors") or {}).items())
        except json.JSONDecodeError:
            msg = detalhe
        if e.code in (401, 403):
            raise loja.ErroPendencia(f"o Jira recusou a credencial ({e.code}). Refaça o token e grave de novo.")
        raise loja.ErroPendencia(f"o Jira respondeu {e.code}: {msg[:300] or 'sem detalhes'}")
    except urllib.error.URLError as e:
        raise loja.ErroPendencia(f"não consegui falar com o Jira: {e.reason}")


def sprint_atual(cfg=None):
    """A sprint ativa do quadro agora (elas giram toda semana; nunca fixar o id)."""
    cfg = cfg or config()
    r = _pedir(f"/rest/agile/1.0/board/{cfg['quadro']}/sprint?state=active&maxResults=1", cfg=cfg)
    for s in r.get("values") or []:
        return {"id": s.get("id"), "nome": s.get("name"), "fim": str(s.get("endDate") or "")[:10]}
    return None


def epicos(cfg=None):
    cfg = cfg or config()
    jql = (f"project = {cfg['projeto']} AND issuetype = Epic AND statusCategory != Done "
           "ORDER BY created DESC")
    r = _pedir("/rest/api/3/search/jql?jql=" + urllib.parse.quote(jql)
               + f"&maxResults={MAX_EPICOS}&fields=summary,status", cfg=cfg)
    return [{"chave": i.get("key"), "titulo": (i.get("fields") or {}).get("summary") or "",
             "estado": (((i.get("fields") or {}).get("status")) or {}).get("name") or ""}
            for i in (r.get("issues") or [])]


def estado():
    """O que o painel precisa saber para desenhar o botão, sem criar nada."""
    cfg = config()
    base = {"configurado": disponivel(), "base": cfg["base"], "projeto": cfg["projeto"],
            "epico_padrao": cfg["epico"], "tipo": cfg["tipo"], "quadro": cfg["quadro"]}
    if not base["configurado"]:
        return base
    try:
        eu = _pedir("/rest/api/3/myself", cfg=cfg)
        base["conta"] = {"nome": eu.get("displayName"), "email": eu.get("emailAddress"),
                         "accountId": eu.get("accountId")}
        base["sprint"] = sprint_atual(cfg)
        base["epicos"] = epicos(cfg)
    except loja.ErroPendencia as e:
        base["erro"] = str(e)
    return base


# ---------------------------------------------------------------- criar

def _descricao(item, cfg):
    """Descrição em ADF (o formato da API v3): texto da pendência + de onde veio."""
    paragrafos = []
    if str(item.get("contexto") or "").strip():
        paragrafos.append(str(item["contexto"]).strip()[:3000])
    de = []
    if item.get("pessoa"):
        de.append(f"Pedido por {item['pessoa']}")
    if item.get("origem"):
        de.append(str(item["origem"]))
    if item.get("area"):
        de.append(f"Área: {item['area']}")
    paragrafos.append(" · ".join(de) if de else "")
    paragrafos.append(f"Criado a partir da pendência {item.get('id')} {config.do_produto()}.")
    return {"type": "doc", "version": 1, "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": p}]} for p in paragrafos if p]}


def montar(item, epico="", tipo="", cfg=None, sprint=None):
    """Os campos exatos que seriam enviados. Serve de prévia e de corpo do POST."""
    cfg = cfg or config()
    cred = ler()
    if not cred:
        raise loja.ErroPendencia("o Jira ainda não foi configurado nesta máquina (falta a credencial)")
    campos = {
        "project": {"key": cfg["projeto"]},
        "issuetype": {"name": tipo or cfg["tipo"]},
        "summary": str(item.get("titulo") or "")[:250],
        "description": _descricao(item, cfg),
        "parent": {"key": epico or cfg["epico"]},
    }
    conta = _pedir("/rest/api/3/myself", cfg=cfg)
    campos["assignee"] = {"id": conta.get("accountId")}
    if item.get("prazo"):
        campos["duedate"] = item["prazo"]
    s = sprint if sprint is not None else sprint_atual(cfg)
    if s and s.get("id"):
        campos[cfg["campo_sprint"]] = s["id"]
    return campos, s, conta


def criar(pendencia_id, epico="", tipo="", confirmar=False):
    """Prévia (sem `confirmar`) ou cria a issue no Jira e guarda a chave na pendência."""
    item = loja.obter(pendencia_id)
    cfg = config()
    ja = (item.get("jira") or {}).get("chave") if isinstance(item.get("jira"), dict) else ""
    campos, sprint, conta = montar(item, epico, tipo, cfg)
    previa = {
        "projeto": cfg["projeto"], "tipo": campos["issuetype"]["name"],
        "resumo": campos["summary"], "epico": campos["parent"]["key"],
        "responsavel": conta.get("displayName"), "prazo": campos.get("duedate") or "",
        "sprint": sprint, "ja_existe": ja or "", "criado": False,
    }
    if not confirmar:
        return previa
    if ja:
        raise loja.ErroPendencia(f"essa pendência já virou {ja} no Jira")
    r = _pedir("/rest/api/3/issue", "POST", {"fields": campos}, cfg)
    chave = r.get("key") or ""
    if not chave:
        raise loja.ErroPendencia("o Jira respondeu sem a chave da issue")
    url = f"{cfg['base']}/browse/{chave}"
    nota = (f"Criada no Jira como {chave}, no épico {campos['parent']['key']}"
            + (f", sprint {sprint['nome']}" if sprint else "") + ".")
    loja.alterar(pendencia_id, {"jira": {
        "chave": chave, "url": url, "epico": campos["parent"]["key"],
        "sprint": (sprint or {}).get("nome", ""), "em": loja.agora()}}, nota, "painel")
    return {**previa, "criado": True, "chave": chave, "url": url}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) > 1 and sys.argv[1] == "guardar":
        print("Cole e-mail e token separados por dois-pontos (nada é gravado em arquivo):")
        linha = sys.stdin.readline().strip()
        email, _, token = linha.partition(":")
        guardar(email.strip(), token.strip())
        print("Guardado no Gerenciador de Credenciais do Windows.")
    else:
        print(json.dumps(estado(), ensure_ascii=False, indent=1)[:2000])
