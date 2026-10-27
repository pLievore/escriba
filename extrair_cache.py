"""Extrai as conversas do cache local do Teams (copia do IndexedDB em export/IndexedDB)
para um markdown legivel, com as mensagens dos ultimos N dias agrupadas por chat.

Uso: .venv\\Scripts\\python.exe extrair_cache.py [dias] [--desde 2026-10-20T16:44:00-03:00]
"""
import argparse
import html
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ccl_chromium_reader import ccl_chromium_indexeddb

_ap = argparse.ArgumentParser(description="Extrai as conversas do cache local do Teams")
_ap.add_argument("dias", nargs="?", type=int, default=14, help="janela em dias (padrao 14)")
_ap.add_argument("--desde", help="so mensagens depois deste instante ISO 8601; sem fuso, vale Brasilia")
ARGS = _ap.parse_args()
RAIZ = Path(__file__).parent
BASE = RAIZ / "export" / "IndexedDB"
BRT = timezone(timedelta(hours=-3))
TIPOS_TEXTO = {"RichText/Html", "Text", "RichText", "RichText/Media_Card"}


def txt(v):
    """Valor do cache como str; sentinelas do V8 (Undefined/None) viram ''."""
    if v is None:
        return ""
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8")
        except UnicodeDecodeError:
            return v.decode("latin-1")
    s = str(v)
    return "" if s in ("<Undefined>", "None") else s


def ms_para_dt(v):
    try:
        return datetime.fromtimestamp(float(txt(v)) / 1000, tz=timezone.utc)
    except ValueError:
        return None


# Chaves e senhas coladas em chat nao podem ir para o export
SEGREDOS = [
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bsk[_-][A-Za-z0-9]{24,}"),
    re.compile(r"(?i)\b(api[_-]?key|password|senha|secret|token)\s*[:=]\s*\S+"),
    re.compile(r"(?m)^\s*(?=\S*[A-Za-z])(?=\S*\d)(?=\S*[^\sA-Za-z0-9])\S{16,}\s*$"),
]


def mascarar(t):
    for r in SEGREDOS:
        t = r.sub("[SEGREDO REMOVIDO]", t)
    return t


def limpar(conteudo):
    t = re.sub(r"(?is)<blockquote.*?</blockquote>", "[responde a uma mensagem anterior] ", conteudo)
    t = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t)
    return mascarar("\n".join(l.strip() for l in t.splitlines() if l.strip()))


wrapper = ccl_chromium_indexeddb.WrappedIndexDB(
    BASE / "https_teams.microsoft.com_0.indexeddb.leveldb",
    BASE / "https_teams.microsoft.com_0.indexeddb.blob",
)

# Pares conversation-manager / replychain-manager por conta (sufixo tenant:usuario)
contas = defaultdict(dict)
for d in wrapper.database_ids:
    m = re.match(r"Teams:(conversation-manager|replychain-manager):react-web-client:([0-9a-f-]+):([0-9a-f-]+):", d.name)
    if m:
        contas[(m.group(2), m.group(3))][m.group(1)] = d.dbid_no

def registros(db_no, prefixo):
    """Registros de TODAS as lojas do banco cujo nome começa com `prefixo`.

    O Teams divide as conversas em mais de uma loja: além de `replychains` passou a gravar em
    `replychains-2`. Lendo só a primeira, threads de grupo inteiras (o pedido e a resposta) ficavam
    de fora do export, e o quadro só via a cópia da menção no feed, sem autor e sem o pedido. Ler
    por prefixo pega também uma `replychains-3` que apareça depois. A mesma mensagem em duas lojas
    não duplica: `msgs` é indexado pelo id da mensagem.
    """
    banco = wrapper[db_no]
    try:
        lojas = [n for n in banco.object_store_names if n is not None and str(n).startswith(prefixo)]
    except AttributeError:   # versão do leitor sem a lista de lojas: cai no nome antigo
        lojas = [prefixo]
    for loja in sorted(lojas, key=str) or [prefixo]:
        yield from banco[loja].iterate_records()


if ARGS.desde:
    corte = datetime.fromisoformat(ARGS.desde)
    if corte.tzinfo is None:
        corte = corte.replace(tzinfo=BRT)
    corte = corte.astimezone(timezone.utc)
    janela = f"desde {corte.astimezone(BRT):%d/%m/%Y %H:%M}"
else:
    corte = datetime.now(timezone.utc) - timedelta(days=ARGS.dias)
    janela = f"ultimos {ARGS.dias} dias"
saida = [f"# Conversas do Teams (cache local) - {janela}",
         f"Gerado em {datetime.now(BRT):%d/%m/%Y %H:%M} (Brasilia). Fonte: copia do IndexedDB do Teams.", ""]

for (tenant, eu), dbs in contas.items():
    if "conversation-manager" not in dbs or "replychain-manager" not in dbs:
        continue
    eu_id = f"8:orgid:{eu}"

    convs = {}
    for r in registros(dbs["conversation-manager"], "conversations"):
        v = r.value
        if not isinstance(v, dict):
            continue
        tp = v.get("threadProperties") or {}
        titulo = txt(tp.get("topic")) or txt((v.get("chatTitle") or {}).get("longTitle")) or "(sem nome)"
        convs[txt(v.get("id"))] = {
            "titulo": titulo,
            "tipo": txt(tp.get("threadType")) or txt(v.get("type")),
            "lido": txt(tp.get("isRead")) == "True",
        }

    msgs = defaultdict(dict)
    for r in registros(dbs["replychain-manager"], "replychains"):
        if not isinstance(r.value, dict):
            continue
        for m in (r.value.get("messageMap") or {}).values():
            if txt(m.get("messageType")) not in TIPOS_TEXTO or txt(m.get("deletionInfo")):
                continue
            quando = ms_para_dt(m.get("originalArrivalTime"))
            if not quando or quando < corte:
                continue
            texto = limpar(txt(m.get("content")))
            if not texto:
                continue
            cid = txt(m.get("conversationId"))
            if "notifications" in cid:
                autor = "(feed: alguem te mencionou)"  # o feed grava tudo com voce como criador
            elif txt(m.get("creator")) == eu_id:
                autor = "EU"
            else:
                autor = txt(m.get("imDisplayName")) or "(desconhecido)"
            msgs[cid][txt(m.get("id"))] = (quando, autor, texto)

    if not msgs:
        continue
    saida.append(f"# Conta tenant {tenant}")
    ordem = sorted(msgs, key=lambda c: max(x[0] for x in msgs[c].values()), reverse=True)
    for cid in ordem:
        c = convs.get(cid, {"titulo": "(chat fora do cache de conversas)", "tipo": "?", "lido": True})
        lista = sorted(msgs[cid].values())
        flags = [] if c["lido"] else ["NAO LIDO"]
        if lista[-1][1] != "EU":
            flags.append("ultima msg NAO e minha")
        saida.append(f"## [{c['tipo']}] {c['titulo']}" + (f"  ({', '.join(flags)})" if flags else ""))
        for quando, autor, texto in lista:
            saida.append(f"- {quando.astimezone(BRT):%d/%m %H:%M} **{autor}**: " + texto.replace("\n", "\n    "))
        saida.append("")

arq = RAIZ / "export" / f"teams_cache_{datetime.now(BRT):%Y-%m-%d_%H%M}.md"
arq.write_text("\n".join(saida), encoding="utf-8")
total = sum(1 for l in saida if l.startswith("- "))
chats = sum(1 for l in saida if l.startswith("## "))
print(f"OK: {arq} | {chats} chats | {total} mensagens")
