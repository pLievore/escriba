"""Configuração da instância: quem usa o Escriba, as áreas do quadro e o Jira.

Os valores de verdade ficam em `config.local.json`, na raiz, fora do Git. Sem ele valem os padrões
abaixo, genéricos, e o Escriba sobe em qualquer máquina. O formato está em `config.exemplo.json`.

Os prompts (`instrucoes_*.md` e o do agente) usam marcadores que `preencher()` troca pelos valores
daqui, para que nenhum nome de pessoa ou de empresa precise morar no código.
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
ARQUIVO = RAIZ / "config.local.json"
PRODUTO = "Escriba"
ARTIGO = "o"

# Até 8 áreas: o painel tem 8 cores. A última é a de "sobra", para o que não se encaixa.
_PADRAO = {
    "dono": {"nome": "", "nome_completo": "", "descricao": ""},
    "areas": [
        {"nome": "Produto", "curto": "Produto", "apelidos": ["produto", "prod"]},
        {"nome": "Operações", "curto": "Operações", "apelidos": ["operacoes", "ops"]},
        {"nome": "Comercial", "curto": "Comercial", "apelidos": ["comercial", "vendas"]},
        {"nome": "Financeiro", "curto": "Financeiro", "apelidos": ["financeiro", "fin"]},
        {"nome": "Marketing", "curto": "Marketing", "apelidos": ["marketing", "mkt"]},
        {"nome": "Dados", "curto": "Dados", "apelidos": ["dados", "bi"]},
        {"nome": "Tecnologia", "curto": "Tecnologia", "apelidos": ["tecnologia", "ti", "tech"]},
        {"nome": "Outros", "curto": "Outros", "apelidos": ["outros", "outro"]},
    ],
    "jira": {"base": "", "projeto": "", "quadro": 0, "epico": "", "tipo": "História",
             "campo_sprint": "customfield_10010", "credencial": "Escriba/Jira"},
}


def _carregar():
    try:
        local = json.loads(ARQUIVO.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        local = {}
    if not isinstance(local, dict):
        local = {}
    cfg = {
        "dono": {**_PADRAO["dono"], **(local.get("dono") or {})},
        "areas": local.get("areas") if isinstance(local.get("areas"), list) and local.get("areas") else _PADRAO["areas"],
        "jira": {**_PADRAO["jira"], **{k: v for k, v in (local.get("jira") or {}).items() if v not in (None, "")}},
    }
    areas = []
    for a in cfg["areas"][:8]:
        if isinstance(a, str):
            a = {"nome": a}
        if isinstance(a, dict) and str(a.get("nome") or "").strip():
            nome = str(a["nome"]).strip()
            areas.append({"nome": nome, "curto": str(a.get("curto") or nome).strip(),
                          "apelidos": [str(x).lower() for x in (a.get("apelidos") or []) if str(x).strip()]})
    cfg["areas"] = areas or _PADRAO["areas"]
    return cfg


CFG = _carregar()
DONO = CFG["dono"]
AREAS = [a["nome"] for a in CFG["areas"]]
AREA_PADRAO = AREAS[-1]          # para onde vai o que não tem área reconhecida
JIRA = CFG["jira"]


def dono_curto():
    """Como o dono é chamado nas mensagens ("Ana"); sem config, "o usuário"."""
    return DONO.get("nome") or "o usuário"


def apresentacao():
    """O dono apresentado no topo dos prompts: nome completo e o que ele faz, quando houver."""
    nome = DONO.get("nome_completo") or DONO.get("nome")
    if not nome:
        return "do usuário"
    extra = []
    if DONO.get("nome") and DONO.get("nome") != nome:
        extra.append(f'o "{DONO["nome"]}"')
    if DONO.get("descricao"):
        extra.append(DONO["descricao"])
    return f"de {nome}" + (f" ({', '.join(extra)})" if extra else "")


def o_produto():
    """ "o Escriba" """
    return f"{ARTIGO} {PRODUTO}"


def do_produto():
    """ "do Escriba" """
    return f"{'da' if ARTIGO == 'a' else 'do'} {PRODUTO}"


def preencher(texto):
    """Troca os marcadores dos prompts pelos valores desta instância."""
    return (str(texto)
            .replace("{{O_PRODUTO}}", o_produto())
            .replace("{{DO_PRODUTO}}", do_produto())
            .replace("{{PRODUTO}}", PRODUTO)
            .replace("{{DONO}}", dono_curto())
            .replace("{{DONO_APRESENTACAO}}", apresentacao())
            .replace("{{AREAS}}", ", ".join(AREAS))
            .replace("{{AREA_PADRAO}}", AREA_PADRAO))


def para_o_painel(raiz=None, scripts=None):
    """O que o painel precisa saber, injetado na página pelo servidor (ver app.py)."""
    return {"produto": PRODUTO, "artigo": ARTIGO, "dono": dono_curto(), "raiz": str(raiz or RAIZ),
            "areas": CFG["areas"], "area_padrao": AREA_PADRAO, "scripts": list(scripts or [])}
