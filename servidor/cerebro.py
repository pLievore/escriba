"""Cérebro do Escriba: registro de projetos, índice de contexto e ligação das pendências.

- Projetos ficam em dados/projetos.json (pasta, área, memória do Claude Code, arquivos-chave,
  palavras-chave e pessoas). O registro nasceu do mapeamento do disco e pode ser ajustado no painel.
- O índice é um SQLite com busca de texto completo (FTS5) em dados/cerebro.db, sobre os
  documentos de cada projeto (md, txt, sql, tmdl, py, ps1, yml) e as notas de memória do Claude
  Code, com os links [[nome]] entre notas. Só lê os arquivos: nunca escreve nas pastas dos projetos.
- Nada sai da máquina: sem modelos baixados, sem serviços externos.

Uso pela linha de comando:
  python servidor\\cerebro.py semear [dados\\cerebro_fase1.json]   cria o registro e liga as pendências
  python servidor\\cerebro.py indexar                               atualiza o índice
  python servidor\\cerebro.py buscar "texto" [projeto_id]
"""
import json
import os
import re
import sqlite3
import sys
import threading
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "dados"
PROJETOS_ARQ = DADOS / "projetos.json"
BANCO = DADOS / "cerebro.db"
CLAUDE_PROJETOS = Path.home() / ".claude" / "projects"

AREAS = config.AREAS
TIPOS = {".md": "doc", ".txt": "doc", ".sql": "sql", ".tmdl": "tmdl", ".dax": "tmdl", ".py": "codigo",
         ".ps1": "codigo", ".js": "codigo", ".mjs": "codigo", ".yml": "config", ".yaml": "config"}
PASTAS_FORA = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out", ".next",
               "bin", "obj", ".vs", ".vscode", ".idea", "_obsoleto", "export", "dados", "public", "assets"}
NOMES_FORA = re.compile(r"(?i)(\.env|secret|credential|token|password|senha|\.key$|\.pfx$)")
# Pastas que nunca viram diretório de trabalho do agente (--add-dir libera a árvore toda).
# É menor que PASTAS_FORA de propósito: aqui o risco é abrir lixo enorme ou histórico do git,
# não deixar de indexar um arquivo.
PASTAS_NAO_ABRIR = {".git", "node_modules", ".venv", "venv", "__pycache__", ".vs", ".idea", ".next"}
# Da própria Mesa, o agente só abre estas (nunca dados/ nem export/, nunca a raiz)
DENTRO_DA_MESA_OK = {"docs", "servidor", "entregas"}
MAX_BYTES = 400_000          # lê no máximo isto de cada arquivo
MAX_ARQUIVOS_PROJETO = 3_000   # o maior repo registrado batia no teto antigo (900) e ficava meio cego
STOP = set("""a o e é de da do das dos em no na nos nas um uma uns umas para pra por com sem que se
ao aos à às ou mas mais menos já não sim sobre entre até após como quando onde qual quais
ele ela eles elas você vocês seu sua seus suas meu minha isso isto esse essa este esta aquele
foi ser ter tem está estão era vai vou pode precisa fazer feito the and for with from this that
dia dias hoje amanhã semana vez base parte item itens coisa coisas caso casos""".split())

SEGREDOS = [
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bsk[_-][A-Za-z0-9]{24,}"),
    re.compile(r"(?i)\b(api[_-]?key|password|senha|secret|token|pwd)\s*[:=]\s*\S+"),
]

_trava_indice = threading.Lock()
ESTADO_INDICE = {"rodando": False, "inicio": None, "fim": None, "arquivos": 0, "novos": 0, "erro": ""}


# ---------------------------------------------------------------- utilidades

def agora():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalizar(texto):
    t = unicodedata.normalize("NFD", str(texto or "")).encode("ascii", "ignore").decode().lower()
    return t


def slug(texto):
    return re.sub(r"[^a-z0-9]+", "-", normalizar(texto)).strip("-")[:48] or "projeto"


def mascarar(texto):
    for r in SEGREDOS:
        texto = r.sub("[segredo removido]", texto)
    return texto


def pasta_memoria(caminho_projeto):
    """Pasta de memória do Claude Code para um projeto (o nome troca tudo que não é letra/dígito por '-')."""
    if not caminho_projeto:
        return None
    codigo = re.sub(r"[^A-Za-z0-9]", "-", str(caminho_projeto))
    if not CLAUDE_PROJETOS.exists():
        return None
    for d in CLAUDE_PROJETOS.iterdir():
        if d.is_dir() and d.name.lower() == codigo.lower() and (d / "memory").is_dir():
            return d / "memory"
    return None


# ---------------------------------------------------------------- registro de projetos

def carregar_projetos():
    if not PROJETOS_ARQ.exists():
        return []
    return json.loads(PROJETOS_ARQ.read_text(encoding="utf-8")).get("projetos", [])


def salvar_projetos(projetos):
    DADOS.mkdir(parents=True, exist_ok=True)
    tmp = PROJETOS_ARQ.with_name(PROJETOS_ARQ.name + ".tmp")
    tmp.write_text(json.dumps({"atualizado_em": agora(), "projetos": projetos}, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, PROJETOS_ARQ)


def projeto_por_id(pid, projetos=None):
    for p in projetos if projetos is not None else carregar_projetos():
        if p["id"] == pid:
            return p
    return None


CAMPOS_PROJETO = {"nome": 120, "pasta": 400, "area": 60, "descricao": 1200}


def alterar_projeto(pid, campos):
    projetos = carregar_projetos()
    p = projeto_por_id(pid, projetos)
    if not p:
        raise ValueError(f"projeto {pid!r} não existe")
    for k, v in campos.items():
        if k in CAMPOS_PROJETO:
            v = str(v or "").strip()[: CAMPOS_PROJETO[k]]
            if k == "area" and v not in AREAS:
                raise ValueError(f"área inválida: {v!r}")
            if k == "pasta" and v and not Path(v).is_dir():
                raise ValueError(f"a pasta não existe: {v}")
            p[k] = v
        elif k in ("palavras_chave", "pessoas"):
            p[k] = [str(x).strip()[:80] for x in (v or []) if str(x).strip()][:60]
        elif k == "ativo":
            p[k] = bool(v)
        else:
            raise ValueError(f"campo desconhecido: {k}")
    if "pasta" in campos:
        mem = pasta_memoria(p["pasta"]) or pasta_memoria(raiz_git(p["pasta"]))
        p["memoria"] = str(mem) if mem else ""
    salvar_projetos(projetos)
    return p


def raiz_git(caminho):
    atual = Path(caminho)
    for d in [atual, *atual.parents]:
        if (d / ".git").exists():
            return str(d)
    return str(atual)


def _area(area_mesa):
    a = str(area_mesa or "")
    if a.startswith("novo:"):
        n = normalizar(a)
        if "ferrament" in n or "ia" in n.split(":")[-1].split():
            return "Ferramentas e IA"
        if any(x in n for x in ("financ", "venda", "comercial")):
            return "Financeiro e Vendas"
        return config.AREA_PADRAO
    return a if a in AREAS else config.AREA_PADRAO


def semear(arquivo_fase1, loja):
    """Cria dados/projetos.json a partir do mapeamento e liga as pendências aos projetos."""
    fase = json.loads(Path(arquivo_fase1).read_text(encoding="utf-8"))
    fase = fase.get("result", fase)
    existentes = {p["id"]: p for p in carregar_projetos()}
    projetos, por_nome = [], {}
    for p in fase["projetos"]:
        pid = slug(p["nome"])
        while pid in {x["id"] for x in projetos}:
            pid = f"{pid}-2"
        pasta = p["caminho"] if Path(p["caminho"]).is_dir() else ""
        mem = pasta_memoria(pasta) or (pasta_memoria(raiz_git(pasta)) if pasta else None)
        novo = {
            "id": pid,
            "nome": p["nome"],
            "pasta": pasta,
            "area": _area(p.get("area_mesa")),
            "descricao": p.get("descricao", ""),
            "ativo": bool(p.get("ativo")),
            "git": bool(p.get("git")),
            "memoria": str(mem) if mem else "",
            "arquivos": [{"caminho": a["caminho"], "porque": a.get("porque", "")} for a in p.get("arquivos_contexto") or []],
            "palavras_chave": p.get("palavras_chave") or [],
            "pessoas": p.get("pessoas") or [],
            "observacoes": p.get("observacoes", ""),
        }
        if pid in existentes:  # o que o usuário ajustou no painel prevalece
            for k in ("nome", "pasta", "area", "ativo", "palavras_chave", "pessoas"):
                novo[k] = existentes[pid].get(k, novo[k])
        projetos.append(novo)
        por_nome[normalizar(p["nome"])] = pid
    salvar_projetos(projetos)

    atuais = {i["id"]: i for i in loja.ler()["pendencias"]}
    operacoes = []
    for lig in fase.get("ligacoes", []):
        arquivos = [a for a in lig.get("contexto") or [] if not proibido_para_agente(a.get("caminho", ""))]
        pid = por_nome.get(normalizar(lig.get("projeto")))
        if not pid:  # sem nome reconhecido: o projeto que contém a maioria dos arquivos ligados
            votos = {}
            for a in arquivos:
                dono = _dono(a.get("caminho", ""), projetos)
                if dono:
                    votos[dono] = votos.get(dono, 0) + 1
            pid = max(votos, key=votos.get) if votos else ""
        ligacoes = {
            "arquivos": [{"caminho": a["caminho"], "motivo": a.get("motivo", "")} for a in arquivos],
            "notas": lig.get("notas_memoria") or [],
            "agente": lig.get("agente", ""),
            "como_ajuda": lig.get("como_o_agente_ajuda", ""),
        }
        atual = atuais.get(lig["id"])
        if not atual:
            continue
        campos = {}
        if not atual.get("projeto_id") and pid:  # não troca um projeto que o usuário escolheu
            campos["projeto_id"] = pid
        if not (atual.get("ligacoes") or {}).get("arquivos"):
            campos["ligacoes"] = ligacoes
        if campos:
            operacoes.append({"op": "atualizar", "id": lig["id"], "campos": campos, "nota": "Ligada ao contexto pelo cérebro"})
    mudancas, avisos, _ = loja.aplicar(operacoes, "claude-code")
    return len(projetos), len(mudancas), avisos


def ligar_novas(ids, loja, minimo=4.0):
    """Liga pendências recém-criadas a um projeto, quando a sugestão do cérebro é forte.

    Só preenche `projeto_id` vazio (nunca troca o que o usuário escolheu) e só com pontuação
    acima de `minimo`. Devolve (quantas foram ligadas, avisos).
    """
    alvos = set(ids or [])
    if not alvos:
        return 0, []
    operacoes = []
    for item in loja.ler()["pendencias"]:
        if item.get("id") not in alvos or item.get("projeto_id"):
            continue
        sugestoes = sugerir_projetos(texto_da_pendencia(item), item.get("area"))
        if sugestoes and sugestoes[0]["pontos"] >= minimo and not _empate(sugestoes):
            operacoes.append({"op": "atualizar", "id": item["id"],
                              "campos": {"projeto_id": sugestoes[0]["projeto_id"]},
                              "nota": "Ligada ao contexto pelo cérebro"})
    if not operacoes:
        return 0, []
    mudancas, avisos, _ = loja.aplicar(operacoes, "claude-code")
    return len(mudancas), avisos


def proibido_para_agente(caminho):
    """Arquivos que o agente não deve receber: dados da própria Mesa e o export bruto do Teams."""
    try:
        c = str(Path(caminho).resolve()).lower()
    except (OSError, ValueError):
        c = str(caminho).lower()
    base = str(RAIZ).lower()
    for proibida in (base + "\\dados", base + "\\export"):
        if c == proibida or c.startswith(proibida + "\\"):
            return True
    return NOMES_FORA.search(Path(c).name) is not None


def pasta_liberavel(caminho, projetos=None):
    """Pasta que pode virar diretório de trabalho do agente (--add-dir libera a árvore inteira).

    Decide pela identidade da pasta, não pelo que tem dentro. Negadas sempre: raiz de unidade,
    a pasta pessoal inteira, qualquer caminho que passe por node_modules/.git/.venv e afins
    (PASTAS_NAO_ABRIR), e a raiz da Mesa com tudo acima dela — abrir a raiz abriria `dados/` e
    `export/` junto. Dentro da Mesa valem só `docs/`, `servidor/` e `entregas/`. Fora dela, o
    de sempre: pastas de projetos registrados e das memórias (`caminho_permitido`).
    """
    try:
        d = Path(caminho).resolve()
    except (OSError, ValueError):
        return False
    if not d.is_dir() or d == d.parent or d == Path.home():
        return False
    if any(parte.lower() in PASTAS_NAO_ABRIR for parte in d.parts):
        return False
    raiz = RAIZ.resolve()
    if d == raiz or d in raiz.parents:
        return False
    if raiz in d.parents:
        primeira = d.relative_to(raiz).parts[0].lower()
        return primeira in DENTRO_DA_MESA_OK
    return caminho_permitido(str(d), projetos)


def pastas_para_agente(item, ctx, limite=8):
    """Pastas que o agente pode abrir nesta pendência, da mais específica para a mais geral.

    Entram: o projeto ligado; a raiz do projeto dono de cada arquivo do contexto (ligado ou
    achado na busca — era só o ligado que entrava, e o cérebro acha quase tudo pela busca);
    os projetos sugeridos quando não há projeto ligado; e a memória do Claude Code.
    Pasta contida em outra já escolhida não ocupa vaga.
    """
    projetos = carregar_projetos()   # carregado uma vez: pasta_liberavel usa este mesmo
    candidatas, motivos = [], {}

    def juntar(caminho, motivo):
        if not caminho or len(candidatas) >= limite * 3:
            return
        try:
            d = Path(caminho).resolve()
        except (OSError, ValueError):
            return
        if not pasta_liberavel(d, projetos):
            return
        if all(d != c for c in candidatas):
            candidatas.append(d)
            motivos[str(d)] = motivo

    pid = item.get("projeto_id") or ""
    if pid:
        p = projeto_por_id(pid, projetos)
        if p and p.get("pasta"):
            juntar(p["pasta"], "projeto da pendência")
    for a in (ctx.get("arquivos") or []):
        caminho = a.get("caminho") or ""
        if not caminho or proibido_para_agente(caminho):
            continue
        dono = projeto_por_id(_dono(caminho, projetos) or "", projetos)
        if dono and dono.get("pasta") and pasta_liberavel(dono["pasta"], projetos):
            juntar(dono["pasta"], f"projeto {dono['nome']} (arquivo citado)")
        else:
            # sem projeto, ou projeto cuja raiz é ampla demais (a própria Mesa): só a pasta do arquivo
            juntar(str(Path(caminho).parent), "pasta do arquivo citado")
    if not pid:
        for s in (ctx.get("sugestoes") or [])[:3]:
            p = projeto_por_id(s.get("projeto_id") or "", projetos)
            if p and p.get("pasta"):
                juntar(p["pasta"], f"projeto sugerido pelo cérebro ({s.get('pontos')} pontos)")

    escolhidas = []
    for d in candidatas:  # pasta já coberta por outra não gasta vaga
        if any(c == d or c in d.parents for c in escolhidas):
            continue
        escolhidas = [c for c in escolhidas if d not in c.parents]
        escolhidas.append(d)
    return [{"caminho": str(d), "motivo": motivos.get(str(d), "")} for d in escolhidas[:limite]]


# ---------------------------------------------------------------- índice

def _conectar():
    DADOS.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(BANCO, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript("""
        CREATE TABLE IF NOT EXISTS docs (
            id INTEGER PRIMARY KEY, caminho TEXT UNIQUE, projeto_id TEXT, tipo TEXT, titulo TEXT,
            nota TEXT, mtime REAL, tamanho INTEGER);
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
            titulo, corpo, tokenize = "unicode61 remove_diacritics 2 tokenchars '_'");
        CREATE TABLE IF NOT EXISTS links (origem TEXT, destino TEXT, projeto_id TEXT);
        CREATE INDEX IF NOT EXISTS links_origem ON links(origem);
        CREATE INDEX IF NOT EXISTS links_destino ON links(destino);
    """)
    return con


def _frontmatter(texto):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", texto, re.S)
    if not m:
        return {}, texto
    campos = {}
    for linha in m.group(1).splitlines():
        if ":" in linha and not linha.startswith(" "):
            k, v = linha.split(":", 1)
            campos[k.strip()] = v.strip().strip('"')
    return campos, texto[m.end():]


def _ler(caminho):
    with open(caminho, "rb") as f:
        bruto = f.read(MAX_BYTES)
    for cod in ("utf-8", "utf-16", "latin-1"):
        try:
            texto = bruto.decode(cod)
            if "\x00" in texto[:2000] and cod != "utf-16":
                continue
            return texto
        except UnicodeDecodeError:
            continue
    return ""


def _arquivos_do_projeto(p):
    pasta = Path(p.get("pasta") or "")
    vistos = []
    for a in p.get("arquivos") or []:
        c = Path(a["caminho"])
        if c.is_file():
            vistos.append(c)
    if pasta.is_dir():
        for raiz, dirs, nomes in os.walk(pasta):
            dirs[:] = [d for d in dirs if d.lower() not in PASTAS_FORA and not d.startswith(".")
                       and not d.lower().startswith(("bm_backup", "backup"))]
            for n in nomes:
                if Path(n).suffix.lower() in TIPOS and not NOMES_FORA.search(n):
                    vistos.append(Path(raiz) / n)
                if len(vistos) >= MAX_ARQUIVOS_PROJETO:
                    ESTADO_INDICE["erro"] = (f"{p['nome']}: parei em {MAX_ARQUIVOS_PROJETO} arquivos; "
                                             "o resto do projeto ficou fora do índice")
                    return vistos
    return vistos


def _dono(caminho, projetos):
    """Projeto mais específico (pasta mais longa) que contém o caminho."""
    melhor, tam = None, -1
    c = str(caminho).lower()
    for p in projetos:
        pasta = (p.get("pasta") or "").lower().rstrip("\\/")
        if pasta and (c == pasta or c.startswith(pasta + "\\") or c.startswith(pasta + "/")) and len(pasta) > tam:
            melhor, tam = p["id"], len(pasta)
    return melhor


def indexar():
    """Atualiza o índice de forma incremental (só relê arquivos que mudaram)."""
    if not _trava_indice.acquire(blocking=False):
        return ESTADO_INDICE
    ESTADO_INDICE.update(rodando=True, inicio=agora(), fim=None, arquivos=0, novos=0, erro="")
    try:
        projetos = [p for p in carregar_projetos()]
        con = _conectar()
        alvos = {}  # caminho -> (projeto_id, tipo, nota)
        for p in projetos:
            for c in _arquivos_do_projeto(p):
                chave = str(c)
                if chave not in alvos:
                    alvos[chave] = (_dono(c, projetos) or p["id"], TIPOS.get(c.suffix.lower(), "doc"), "")
        memorias = {}
        for p in projetos:
            if p.get("memoria") and Path(p["memoria"]).is_dir():
                memorias[p["memoria"]] = memorias.get(p["memoria"]) or p["id"]
        for pasta, pid in memorias.items():
            # a memória pertence ao projeto mais geral que aponta para ela (o da pasta raiz)
            donos = [x for x in projetos if x.get("memoria") == pasta]
            pid = min(donos, key=lambda x: len(x.get("pasta") or "z" * 999))["id"] if donos else pid
            for nota in Path(pasta).glob("*.md"):
                # o MEMORY.md é o índice das notas: fica buscável, mas não aparece como nota
                alvos[str(nota)] = (pid, "indice" if nota.stem.upper() == "MEMORY" else "memoria", nota.stem)

        atuais = {row[0]: (row[1], row[2]) for row in con.execute("SELECT caminho, id, mtime FROM docs")}
        for caminho in set(atuais) - set(alvos):
            did = atuais[caminho][0]
            con.execute("DELETE FROM docs_fts WHERE rowid = ?", (did,))
            con.execute("DELETE FROM docs WHERE id = ?", (did,))
            con.execute("DELETE FROM links WHERE origem = ?", (Path(caminho).stem,))
        for caminho, (pid, tipo, nota) in alvos.items():
            try:
                st = os.stat(caminho)
            except OSError:
                continue
            ESTADO_INDICE["arquivos"] += 1
            anterior = atuais.get(caminho)
            if anterior and abs((anterior[1] or 0) - st.st_mtime) < 1:
                con.execute("UPDATE docs SET projeto_id = ? WHERE id = ?", (pid, anterior[0]))
                continue
            texto = mascarar(_ler(caminho))
            titulo = Path(caminho).name
            if tipo == "indice":
                titulo = f"Índice da memória ({Path(caminho).parent.parent.name})"
            elif tipo == "memoria":
                fm, corpo = _frontmatter(texto)
                titulo = fm.get("description") or fm.get("name") or nota
                texto = corpo
                con.execute("DELETE FROM links WHERE origem = ?", (nota,))
                for destino in set(re.findall(r"\[\[([^\]|#]+)", corpo)):
                    con.execute("INSERT INTO links (origem, destino, projeto_id) VALUES (?, ?, ?)", (nota, destino.strip(), pid))
            else:
                h = re.search(r"^#\s+(.+)$", texto, re.M)
                if h and tipo == "doc":
                    titulo = f"{titulo} · {h.group(1).strip()[:120]}"
            if anterior:
                did = anterior[0]
                con.execute("UPDATE docs SET projeto_id=?, tipo=?, titulo=?, nota=?, mtime=?, tamanho=? WHERE id=?",
                            (pid, tipo, titulo, nota, st.st_mtime, st.st_size, did))
                con.execute("DELETE FROM docs_fts WHERE rowid = ?", (did,))
            else:
                cur = con.execute("INSERT INTO docs (caminho, projeto_id, tipo, titulo, nota, mtime, tamanho) VALUES (?,?,?,?,?,?,?)",
                                  (caminho, pid, tipo, titulo, nota, st.st_mtime, st.st_size))
                did = cur.lastrowid
            con.execute("INSERT INTO docs_fts (rowid, titulo, corpo) VALUES (?, ?, ?)", (did, titulo, texto))
            ESTADO_INDICE["novos"] += 1
        con.commit()
        con.close()
    except Exception as e:  # noqa: BLE001 - o estado guarda o erro para o painel mostrar
        ESTADO_INDICE["erro"] = f"{type(e).__name__}: {e}"
    finally:
        ESTADO_INDICE.update(rodando=False, fim=agora())
        _trava_indice.release()
    return ESTADO_INDICE


def indexar_em_segundo_plano():
    threading.Thread(target=indexar, name="indice-cerebro", daemon=True).start()


def estado_indice():
    info = dict(ESTADO_INDICE)
    if BANCO.exists():
        con = _conectar()
        info["total_docs"] = con.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
        info["por_projeto"] = dict(con.execute("SELECT projeto_id, COUNT(*) FROM docs GROUP BY projeto_id").fetchall())
        info["memorias"] = con.execute("SELECT COUNT(*) FROM docs WHERE tipo='memoria'").fetchone()[0]
        con.close()
    return info


# ---------------------------------------------------------------- busca

def _termos(texto, limite=24):
    vistos = []
    for t in re.findall(r"[a-z0-9_]+", normalizar(texto)):
        if len(t) < 3 or t in STOP or t.isdigit() and len(t) < 4:
            continue
        if t not in vistos:
            vistos.append(t)
        if len(vistos) >= limite:
            break
    return vistos


def buscar(consulta, projetos=None, limite=10, tipos=None):
    """Busca no índice. `projetos` restringe a uma lista de ids de projeto."""
    termos = _termos(consulta)
    if not termos or not BANCO.exists():
        return []
    expr = " OR ".join(f'"{t}"' for t in termos)
    sql = ("SELECT d.caminho, d.titulo, d.tipo, d.projeto_id, d.nota, "
           "snippet(docs_fts, 1, '«', '»', ' … ', 16), bm25(docs_fts, 6.0, 1.0) AS r "
           "FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE docs_fts MATCH ?")
    args = [expr]
    if projetos:
        sql += f" AND d.projeto_id IN ({','.join('?' * len(projetos))})"
        args += list(projetos)
    if tipos:
        sql += f" AND d.tipo IN ({','.join('?' * len(tipos))})"
        args += list(tipos)
    sql += " ORDER BY r LIMIT ?"
    args.append(limite)
    con = _conectar()
    try:
        linhas = con.execute(sql, args).fetchall()
    except sqlite3.OperationalError:
        linhas = []
    con.close()
    return [{"caminho": c, "titulo": t, "tipo": ti, "projeto_id": pid, "nota": n,
             "trecho": re.sub(r"\s+", " ", s or "").strip()[:320], "relevancia": round(-r, 3)}
            for c, t, ti, pid, n, s, r in linhas]


def notas_relacionadas(nomes):
    """Notas ligadas por [[links]] (nos dois sentidos) às notas dadas."""
    if not nomes or not BANCO.exists():
        return []
    con = _conectar()
    marc = ",".join("?" * len(nomes))
    vizinhos = {r[0] for r in con.execute(f"SELECT destino FROM links WHERE origem IN ({marc})", nomes)}
    vizinhos |= {r[0] for r in con.execute(f"SELECT origem FROM links WHERE destino IN ({marc})", nomes)}
    vizinhos -= set(nomes)
    saida = []
    for nome in sorted(vizinhos):
        row = con.execute("SELECT caminho, titulo, projeto_id FROM docs WHERE tipo='memoria' AND nota = ?", (nome,)).fetchone()
        if row:
            saida.append({"nota": nome, "caminho": row[0], "titulo": row[1], "projeto_id": row[2]})
    con.close()
    return saida


def _nota_para_doc(nome):
    if not BANCO.exists():
        return None
    con = _conectar()
    row = con.execute("SELECT caminho, titulo, projeto_id FROM docs WHERE tipo='memoria' AND (nota = ? OR lower(nota) = lower(?))",
                      (nome, nome)).fetchone()
    con.close()
    return {"nota": nome, "caminho": row[0], "titulo": row[1], "projeto_id": row[2]} if row else {"nota": nome, "caminho": "", "titulo": nome, "projeto_id": ""}


def familia(pid, projetos):
    """O projeto, os que estão dentro da pasta dele e o projeto pai (mesma árvore de pastas)."""
    p = projeto_por_id(pid, projetos)
    if not p or not p.get("pasta"):
        return [pid] if pid else []
    base = p["pasta"].lower().rstrip("\\")
    ids = []
    for x in projetos:
        pasta = (x.get("pasta") or "").lower().rstrip("\\")
        if pasta and (pasta == base or pasta.startswith(base + "\\") or base.startswith(pasta + "\\")):
            ids.append(x["id"])
    return ids or [pid]


def texto_da_pendencia(item):
    contexto = item.get("contexto") if isinstance(item.get("contexto"), str) else ""
    return " ".join(str(item.get(k) or "") for k in ("titulo", "pessoa", "origem")) + " " + contexto


def projeto_da_mesa(projetos=None):
    """Id do projeto registrado que é a própria Mesa (a pasta deste repositório), se houver."""
    base = os.path.normcase(str(RAIZ))
    for p in (projetos if projetos is not None else carregar_projetos()):
        if p.get("pasta") and os.path.normcase(os.path.abspath(p["pasta"])).rstrip("\\/") == base:
            return p["id"]
    return ""


def sugerir_projetos(texto, area=None, limite=3):
    """Projetos mais prováveis para um texto: palavras-chave, pessoas e documentos parecidos.

    A própria Mesa fica de fora: os documentos dela falam de todos os assuntos do usuário (é a
    ferramenta que descreve o trabalho dele), então ela casava com quase qualquer pendência pela
    busca e chegava a ganhar de projetos de verdade — chegou a gravar projeto_id errado.
    """
    da_mesa = projeto_da_mesa()
    projetos = [p for p in carregar_projetos() if p.get("pasta") and p["id"] != da_mesa]
    alvo = " " + normalizar(texto) + " "
    pontos = {}
    for p in projetos:
        s = 0.0
        for kw in p.get("palavras_chave") or []:
            k = normalizar(kw).strip()
            if (len(k) >= 3 and re.search(rf"(?<![a-z0-9]){re.escape(k)}(?![a-z0-9])", alvo)) or (len(k) >= 8 and k in alvo):
                s += 3.0
        for pessoa in p.get("pessoas") or []:
            primeiro = normalizar(pessoa).split(" (")[0].split()[:1]
            if primeiro and len(primeiro[0]) >= 4 and f" {primeiro[0]} " in alvo:
                s += 0.5
        if area and p.get("area") == area:
            s += 1.0
        if p.get("ativo"):
            s += 0.3
        pontos[p["id"]] = s
    por_busca = {}
    for posicao, hit in enumerate(buscar(texto, limite=15)):  # os primeiros resultados valem mais
        pid = hit["projeto_id"]
        if pid in pontos:
            por_busca[pid] = por_busca.get(pid, 0) + max(0.3, 1.5 - posicao * 0.1)
    for pid, extra in por_busca.items():
        pontos[pid] += min(extra, 4.0)  # a busca ajuda, mas não domina as palavras-chave
    melhores = sorted((x for x in pontos.items() if x[1] > 2.0), key=lambda x: -x[1])[:limite]
    return [{"projeto_id": pid, "pontos": round(s, 1)} for pid, s in melhores]


def _empate(sugestoes, folga=0.5):
    """Primeira sugestão sem folga sobre a segunda: o desempate seria a ordem do arquivo."""
    return len(sugestoes) > 1 and (sugestoes[0]["pontos"] - sugestoes[1]["pontos"]) < folga


def contexto_da_pendencia(item, todas=None):
    """Monta o contexto de uma pendência: projeto, arquivos (ligados + achados), notas e relacionadas."""
    projetos = carregar_projetos()
    ctx = item.get("ligacoes") if isinstance(item.get("ligacoes"), dict) else {}
    texto = texto_da_pendencia(item)
    pid = item.get("projeto_id") or ""
    sugestoes = [] if pid else sugerir_projetos(texto, item.get("area"))
    projeto = projeto_por_id(pid, projetos) if pid else None
    if not pid and sugestoes:  # sem projeto ligado, a busca usa a sugestão mais forte, mas o painel só sugere
        pid = sugestoes[0]["projeto_id"]

    ligados = []
    vistos = set()
    for a in ctx.get("arquivos") or []:
        c = a.get("caminho", "")
        if proibido_para_agente(c):
            continue
        vistos.add(c.lower())
        ligados.append({"caminho": c, "motivo": a.get("motivo", ""), "existe": Path(c).exists(), "origem": "ligado"})
    achados = []
    for hit in buscar(texto, projetos=familia(pid, projetos) if pid else None, limite=12):
        if hit["caminho"].lower() in vistos or hit["tipo"] == "memoria":
            continue
        vistos.add(hit["caminho"].lower())
        achados.append({**hit, "origem": "busca"})
        if len(achados) >= 6:
            break
    notas = [_nota_para_doc(n) for n in ctx.get("notas") or [] if str(n).upper() != "MEMORY"]
    nomes = [n["nota"] for n in notas]
    for hit in buscar(texto, projetos=familia(pid, projetos) if pid else None, limite=8, tipos=["memoria"]):
        if hit["nota"] and hit["nota"] not in nomes:
            notas.append({"nota": hit["nota"], "caminho": hit["caminho"], "titulo": hit["titulo"], "projeto_id": hit["projeto_id"], "trecho": hit["trecho"], "origem": "busca"})
            nomes.append(hit["nota"])
        if len(notas) >= 10:
            break
    relacionadas = []
    if todas:
        pessoa = normalizar(item.get("pessoa") or "").split(",")[0].strip()
        for outra in todas:
            if outra.get("id") == item.get("id") or outra.get("status") in ("feita", "descartada"):
                continue
            mesmo_proj = pid and outra.get("projeto_id") in familia(pid, projetos)
            mesma_pessoa = pessoa and len(pessoa) > 3 and pessoa.split()[0] in normalizar(outra.get("pessoa") or "")
            if mesmo_proj or mesma_pessoa:
                relacionadas.append({"id": outra["id"], "titulo": outra.get("titulo"), "status": outra.get("status"),
                                     "motivo": "mesmo projeto" if mesmo_proj else "mesma pessoa"})
    return {
        "projeto": projeto,
        "sugestoes": [{**s, "nome": (projeto_por_id(s["projeto_id"], projetos) or {}).get("nome", s["projeto_id"])} for s in sugestoes],
        "arquivos": ligados + achados,
        "notas": notas,
        "notas_relacionadas": notas_relacionadas(nomes)[:8],
        "relacionadas": relacionadas[:12],
        "agente": ctx.get("agente", ""),
        "como_ajuda": ctx.get("como_ajuda", ""),
    }


_raizes = {}


def _raiz_resolvida(caminho):
    """Raiz de projeto normalizada (resolve nome curto 8.3 e link), guardada entre chamadas.

    Sem o cache, cada `caminho_permitido` faria um acesso a disco por projeto registrado — são
    dezenas, e o contexto de uma pendência chama isto dezenas de vezes.
    """
    valor = _raizes.get(caminho)
    if valor is None:
        try:
            valor = os.path.normcase(str(Path(caminho).resolve())).rstrip("\\/")
        except (OSError, ValueError):
            valor = os.path.normcase(os.path.abspath(caminho)).rstrip("\\/")
        _raizes[caminho] = valor
    return valor


def caminho_permitido(caminho, projetos=None):
    """Só arquivos de pastas de projetos registrados, das memórias ou das entregas podem ser abertos.

    `projetos` evita reler o registro a cada chamada (o contexto de uma pendência chama isto
    dezenas de vezes).
    """
    try:
        c = os.path.normcase(str(Path(caminho).resolve()))
    except (OSError, ValueError):
        return False
    if projetos is None:
        projetos = carregar_projetos()
    raizes = [p["pasta"] for p in projetos if p.get("pasta")]
    raizes += [p["memoria"] for p in projetos if p.get("memoria")]
    raizes.append(str(RAIZ / "entregas"))
    for r in raizes:
        base = _raiz_resolvida(r)
        if base and (c == base or c.startswith(base + os.sep)):
            return True
    return False


# ---------------------------------------------------------------- linha de comando

def _principal():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import loja  # noqa: PLC0415
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "semear":
        arq = sys.argv[2] if len(sys.argv) > 2 else str(DADOS / "cerebro_fase1.json")
        n, m, avisos = semear(arq, loja)
        print(f"{n} projetos no registro; {m} pendências ligadas; avisos: {avisos}")
    elif cmd == "indexar":
        t0 = time.time()
        r = indexar()
        print(f"índice: {r['arquivos']} arquivos vistos, {r['novos']} (re)lidos em {time.time() - t0:.1f}s {r['erro']}")
        e = estado_indice()
        print(f"total {e.get('total_docs')} docs, {e.get('memorias')} memórias")
    elif cmd == "buscar":
        for h in buscar(sys.argv[2], projetos=[sys.argv[3]] if len(sys.argv) > 3 else None):
            print(f"[{h['tipo']}] {h['projeto_id']} | {h['caminho']}\n    {h['trecho'][:200]}")
    else:
        print(__doc__)


if __name__ == "__main__":
    _principal()
