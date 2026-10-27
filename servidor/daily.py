"""Resumo para a daily: o que foi fechado, o que está em curso e o que está travado.

A daily padrão é segunda, quarta e sexta. A janela do resumo não é "ontem": é **desde a daily
anterior** — na sexta cobre quarta→sexta, na segunda cobre sexta→segunda (com o fim de semana
dentro). Quem define os dias e a hora é `meta.daily` em dados/pendencias.json; o padrão é
segunda, quarta e sexta às 09:00.

Tudo sai do histórico das pendências, sem chamar modelo nenhum: abrir o resumo é instantâneo e
não gasta nada. A marca que torna isso exato é o campo `status` das entradas do histórico, que
`loja._anotar` passou a gravar — o texto da entrada costuma ser a nota de quem mudou, não o
campo que mudou.
"""
import re
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
import loja  # noqa: E402

DIAS_PADRAO = [0, 2, 4]          # segunda, quarta, sexta (0 = segunda, como no weekday())
HORA_PADRAO = "09:00"
DIA_NOME = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]
MAX_POR_BLOCO = 12


def _config(meta):
    cfg = meta.get("daily") if isinstance(meta.get("daily"), dict) else {}
    dias = [d for d in (cfg.get("dias") or DIAS_PADRAO) if isinstance(d, int) and 0 <= d <= 6]
    hora = str(cfg.get("hora") or HORA_PADRAO)
    try:
        h, m = (int(x) for x in hora.split(":")[:2])
        marca = time(max(0, min(23, h)), max(0, min(59, m)))
    except ValueError:
        marca = time(9, 0)
    return sorted(set(dias)) or DIAS_PADRAO, marca


def janela(meta, agora=None):
    """De quando até quando este resumo fala.

    Começa na daily anterior — a de hoje não conta, mesmo que já tenha passado da hora: quem
    abre o resumo quer o que aconteceu desde a última vez que falou, não desde hoje de manhã.
    """
    dias, marca = _config(meta)
    agora = agora or datetime.now(loja.BRT)
    dia = agora.date() - timedelta(days=1)
    for _ in range(14):
        if dia.weekday() in dias:
            inicio = datetime.combine(dia, marca, tzinfo=loja.BRT)
            return {"inicio": inicio, "fim": agora, "dias": dias, "hora": marca.strftime("%H:%M"),
                    "rotulo": f"desde {DIA_NOME[dia.weekday()]}, {dia:%d/%m} às {marca:%H:%M}",
                    "hoje_e_dia": agora.weekday() in dias}
        dia -= timedelta(days=1)
    inicio = agora - timedelta(days=2)
    return {"inicio": inicio, "fim": agora, "dias": dias, "hora": marca.strftime("%H:%M"),
            "rotulo": "dos últimos 2 dias", "hoje_e_dia": agora.weekday() in dias}


def _dentro(iso, inicio, fim):
    """A entrada do histórico (UTC, "...Z") caiu na janela?"""
    try:
        quando = datetime.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return False
    return inicio <= quando.astimezone(loja.BRT) <= fim


def _virou(item, status, inicio, fim):
    """A pendência entrou nesse status dentro da janela (pela marca do histórico)."""
    marcadas = [h for h in (item.get("historico") or []) if h.get("status")]
    if marcadas:
        return any(h["status"] == status and _dentro(h.get("em"), inicio, fim) for h in marcadas)
    # histórico antigo, sem a marca: sobra o carimbo de atualização
    return item.get("status") == status and _dentro(item.get("atualizado_em"), inicio, fim)


# o que loja.descrever() gera sozinho ("agora feita", "prioridade urgente"): não se fala isso numa daily
_AUTO = re.compile(r"^(criada|agora [\w ]+|prioridade [\w ]+|prazo [\d/]*|sem prazo|título editado|"
                   r"pessoa: .*|área: .*|projeto (ligado|desligado)|contexto atualizado|"
                   r"aguardando .*|sem quem aguardar|cobrar em [\d/]*|sem cobrança marcada|"
                   r"ligações do cérebro atualizadas|posição alterada)$", re.IGNORECASE)


def _tem_conteudo(texto):
    partes = [p.strip() for p in str(texto).split(",") if p.strip()]
    return bool(partes) and not all(_AUTO.match(p) for p in partes)


def _notas(item, inicio, fim):
    """Notas escritas na janela, só as que dizem alguma coisa."""
    return [str(h.get("texto") or "")[:200] for h in (item.get("historico") or [])
            if _dentro(h.get("em"), inicio, fim) and _tem_conteudo(h.get("texto") or "")]


def _resumir(item, inicio, fim):
    return {k: item.get(k, "") for k in ("id", "titulo", "pessoa", "area", "projeto_id", "prazo", "status",
                                         "aguardando_de", "cobrar_em")} | {
        "notas": _notas(item, inicio, fim)[-2:]}


def janela_forcada(desde, agora):
    """Janela escolhida na tela: `hoje`, `7d`, ou um instante ISO."""
    desde = str(desde or "").strip()
    if desde == "hoje":
        inicio = datetime.combine(agora.date(), time(0, 0), tzinfo=loja.BRT)
        return {"inicio": inicio, "rotulo": "de hoje"}
    if desde == "7d":
        return {"inicio": agora - timedelta(days=7), "rotulo": "dos últimos 7 dias"}
    try:
        inicio = datetime.fromisoformat(desde)
    except ValueError:
        return None
    if inicio.tzinfo is None:
        inicio = inicio.replace(tzinfo=loja.BRT)
    return {"inicio": inicio.astimezone(loja.BRT), "rotulo": f"desde {inicio.astimezone(loja.BRT):%d/%m %H:%M}"}


def montar(dados=None, agora=None, desde=""):
    """Os fatos da daily, já ordenados, mais o texto pronto para falar."""
    dados = dados or loja.ler()
    agora = agora or datetime.now(loja.BRT)
    j = janela(dados["meta"], agora)
    forcada = janela_forcada(desde, agora) if desde else None
    if forcada:
        j = {**j, "inicio": forcada["inicio"], "rotulo": forcada["rotulo"]}
    inicio, fim = j["inicio"], j["fim"]
    hoje = (agora or datetime.now(loja.BRT)).date().isoformat()
    itens = dados["pendencias"]

    feitas = [i for i in itens if i.get("status") == "feita" and _virou(i, "feita", inicio, fim)]
    descartadas = [i for i in itens if i.get("status") == "descartada" and _virou(i, "descartada", inicio, fim)]
    andamento = [i for i in itens if i.get("status") == "andamento"]
    aguardando = [i for i in itens if i.get("status") == "aguardando"]
    abertas = [i for i in itens if i.get("status") in ("aberta", "andamento", "aguardando")]
    novas = [i for i in itens if _dentro(i.get("criado_em"), inicio, fim) and i.get("status") != "descartada"]
    atrasadas = [i for i in abertas if i.get("prazo") and i["prazo"] < hoje]
    # cobranças cuja data já chegou: é o que ele precisa puxar hoje, e normalmente na própria daily
    cobrar = [i for i in abertas if i.get("cobrar_em") and i["cobrar_em"] <= hoje]
    vencem_hoje = [i for i in abertas if i.get("prazo") == hoje]
    # mexidas sem fechar: o "andei nisso" que não virou done
    mexidas = [i for i in abertas if _notas(i, inicio, fim) and i not in novas]

    def ordenar(lista):
        return sorted(lista, key=lambda i: (i.get("prazo") or "9999-12-31", i.get("titulo") or ""))

    blocos = {
        "feitas": [_resumir(i, inicio, fim) for i in ordenar(feitas)][:MAX_POR_BLOCO],
        "andamento": [_resumir(i, inicio, fim) for i in ordenar(andamento)][:MAX_POR_BLOCO],
        "aguardando": [_resumir(i, inicio, fim) for i in ordenar(aguardando)][:MAX_POR_BLOCO],
        "cobrar": [_resumir(i, inicio, fim) for i in sorted(cobrar, key=lambda i: i["cobrar_em"])][:MAX_POR_BLOCO],
        "mexidas": [_resumir(i, inicio, fim) for i in ordenar(mexidas) if i not in andamento][:MAX_POR_BLOCO],
        "atrasadas": [_resumir(i, inicio, fim) for i in ordenar(atrasadas)][:MAX_POR_BLOCO],
        "vencem_hoje": [_resumir(i, inicio, fim) for i in ordenar(vencem_hoje)][:MAX_POR_BLOCO],
        "novas": [_resumir(i, inicio, fim) for i in ordenar(novas)][:MAX_POR_BLOCO],
        "descartadas": [_resumir(i, inicio, fim) for i in ordenar(descartadas)][:MAX_POR_BLOCO],
    }
    contagens = {k: len(v) for k, v in blocos.items()}
    saida = {
        "janela": {"inicio": inicio.isoformat(), "fim": fim.isoformat(), "rotulo": j["rotulo"],
                   "dias": j["dias"], "hora": j["hora"], "hoje_e_dia": j["hoje_e_dia"],
                   "hoje": f"{DIA_NOME[(agora or datetime.now(loja.BRT)).weekday()]}, "
                           f"{(agora or datetime.now(loja.BRT)):%d/%m/%Y}"},
        "contagens": contagens,
        **blocos,
    }
    saida["texto"] = texto(saida)
    return saida


def _pessoa_curta(nome):
    n = str(nome or "").split(",")[0].strip()
    return n.split()[0] if n else ""


def texto(d):
    """O roteiro falado. Frases curtas, nome das pessoas, sem enfeite."""
    linhas = [f"Daily de {d['janela']['hoje']} — {d['janela']['rotulo']}", ""]

    def lista(titulo, itens, com_pessoa=False, com_prazo=False):
        if not itens:
            return
        linhas.append(f"{titulo} ({len(itens)}):")
        for i in itens:
            extra = []
            if com_pessoa and _pessoa_curta(i.get("pessoa")):
                extra.append(_pessoa_curta(i["pessoa"]))
            if com_prazo and i.get("prazo"):
                extra.append(f"prazo {loja.fmt_dia(i['prazo'])}")
            linhas.append(f"- {i['titulo']}" + (f" ({', '.join(extra)})" if extra else ""))
        linhas.append("")

    if d["feitas"]:
        lista("Fechei", d["feitas"])
    else:
        linhas.append("Fechei: nada desde a última daily.")
        linhas.append("")
    lista("Sigo em", d["andamento"], com_pessoa=True, com_prazo=True)
    lista("Mexi, sem fechar", d["mexidas"], com_pessoa=True)
    lista("Esperando resposta", d["aguardando"], com_pessoa=True)
    if d.get("cobrar"):
        linhas.append(f"Vou cobrar hoje ({len(d['cobrar'])}):")
        for i in d["cobrar"]:
            de = _pessoa_curta(i.get("aguardando_de")) or _pessoa_curta(i.get("pessoa"))
            linhas.append(f"- {i['titulo']}" + (f" (com {de})" if de else ""))
        linhas.append("")
    lista("Atrasadas", d["atrasadas"], com_prazo=True)
    lista("Vencem hoje", d["vencem_hoje"], com_pessoa=True)
    if d["novas"]:
        linhas.append(f"Entrou no período: {len(d['novas'])} "
                      f"{'pendência nova' if len(d['novas']) == 1 else 'pendências novas'}.")
    return "\n".join(linhas).strip()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(montar()["texto"])
