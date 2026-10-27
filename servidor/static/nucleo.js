/* Escriba: núcleo.
   Estado, API, datas no fuso de São Paulo, utilidades de DOM (todo texto vindo do servidor entra por
   textContent ou nós de texto), menus, popovers, toasts, confirmação embutida, pilha de desfazer e
   saúde do servidor. Os outros arquivos (quadro, gaveta, agente, assistente, projetos, app) usam o
   objeto global Mesa definido aqui. */
(function () {
  "use strict";
  const Mesa = (window.Mesa = window.Mesa || {});

  // ------------------------------------------------------------------ constantes
  const FUSO = "America/Sao_Paulo";
  // O que o servidor injeta na página: pasta da instalação, áreas e scripts de extensão (ver app.py)
  const CFG = window.ESCRIBA || {};
  const RAIZ_MESA = String(CFG.raiz || "");
  const COLUNAS = [
    { status: "aberta", nome: "A fazer", icone: "i-status-todo", cls: "col-ic-afazer", vazio: "Nada a fazer. Pressione N para criar." },
    { status: "andamento", nome: "Em andamento", icone: "i-status-doing", cls: "col-ic-andamento", vazio: "Nada em andamento." },
    { status: "aguardando", nome: "Aguardando outros", icone: "i-status-waiting", cls: "col-ic-aguardando", vazio: "Ninguém te devendo resposta." },
    { status: "feita", nome: "Concluído", icone: "i-status-done", cls: "col-ic-feita", vazio: "Nada concluído nos últimos 14 dias." },
  ];
  const STATUS_NOME = { aberta: "A fazer", andamento: "Em andamento", aguardando: "Aguardando outros", feita: "Concluída", descartada: "Descartada" };
  const STATUS_ICONE = { aberta: "i-status-todo", andamento: "i-status-doing", aguardando: "i-status-waiting", feita: "i-status-done", descartada: "i-status-discarded" };
  const STATUS_COR = { aberta: "col-ic-afazer", andamento: "col-ic-andamento", aguardando: "col-ic-aguardando", feita: "col-ic-feita", descartada: "texto-3" };
  const PRIORIDADES = [
    { v: "urgente", nome: "Urgente", icone: "i-prio-urgent" },
    { v: "semana", nome: "Esta semana", icone: "i-prio-week" },
    { v: "acompanhar", nome: "Acompanhar", icone: "i-prio-watch" },
  ];
  const PRIO = Object.fromEntries(PRIORIDADES.map((p) => [p.v, p]));
  const PRIO_PESO = { urgente: 0, semana: 1, acompanhar: 2 };
  // Áreas (campo `area` do servidor). Vêm do config da instância, que o servidor injeta na página
  // (window.ESCRIBA); a cor sai da posição, e a área de sobra (a última) fica cinza e vazada.
  const CORES_AREA = ["var(--p-azul)", "var(--p-framboesa)", "var(--p-verde)", "var(--p-ocre)", "var(--p-laranja)", "var(--p-violeta)", "var(--p-oliva)"];
  const AREAS = (Array.isArray(CFG.areas) && CFG.areas.length ? CFG.areas : [{ nome: "Outros", curto: "Outros", apelidos: ["outros"] }])
    .map((a, k, todas) => {
      const sobra = a.nome === (CFG.area_padrao || todas[todas.length - 1].nome);
      return { nome: a.nome, curto: a.curto || a.nome, cor: sobra ? "var(--p-cinza)" : CORES_AREA[k % CORES_AREA.length],
               outros: sobra || undefined, apelidos: Array.isArray(a.apelidos) ? a.apelidos : [] };
    });
  const AREA_PADRAO = (AREAS.find((a) => a.outros) || AREAS[AREAS.length - 1]).nome;
  const AREA = Object.fromEntries(AREAS.map((a) => [a.nome, a]));
  // `AREA.Outros` é usado no painel inteiro como "a área de sobra": vira apelido invisível dela
  if (!AREA.Outros) Object.defineProperty(AREA, "Outros", { value: AREA[AREA_PADRAO], enumerable: false });
  const ORIGEM_ATOR = { painel: "Você", assistente: "Assistente", "claude-code": "Leitura do Teams", mcp: "Sessão do Claude Code", agente: "Agente", cerebro: "Cérebro" };

  // ------------------------------------------------------------------ preferências (sempre em try/catch)
  function lerPref(chave, padrao) {
    try {
      const v = localStorage.getItem(chave);
      return v == null ? padrao : JSON.parse(v);
    } catch (e) {
      return padrao;
    }
  }
  function gravarPref(chave, valor) {
    try {
      if (valor === undefined) localStorage.removeItem(chave);
      else localStorage.setItem(chave, JSON.stringify(valor));
    } catch (e) { /* sem armazenamento: a página funciona sem ele */ }
  }

  // ------------------------------------------------------------------ estado
  const E = (Mesa.estado = {
    dados: null, versao: -1, meta: {}, itens: [], porId: new Map(), numero: new Map(), porNumero: new Map(),
    nomesCurtos: new Map(), carregado: false, erroCarga: null,
    status: null, recursos: {}, assistenteOk: false,
    servidor: "verificando", ultimaResposta: 0, ultimaSync: 0, sync: "",
    projetos: [], projetosPorId: new Map(), indice: null, projetosCarregados: false,
    pagina: "quadro", modo: lerPref("mesa.modo", "quadro"),
    visao: lerPref("mesa.visao", "tudo"),
    filtros: { areas: new Set(), pessoas: new Set(), prioridades: new Set(), sinais: new Set(), texto: "" },
    raias: lerPref("mesa.raias", ""),
    densidade: lerPref("mesa.densidade", "confortavel"),
    janelaFeitas: lerPref("mesa.feitas.dias", 14),
    limiteAndamento: lerPref("mesa.limite.andamento", 5),
    atalhosUmaTecla: lerPref("mesa.atalhos", true),
    gavetaModo: lerPref("mesa.gaveta.modo", "auto"),
    abertaId: null, foco: null, selecao: new Set(),
    hoje: "",
  });

  // ------------------------------------------------------------------ eventos
  const ouvintes = {};
  Mesa.ouvir = (ev, fn) => { (ouvintes[ev] || (ouvintes[ev] = [])).push(fn); };
  Mesa.emitir = (ev, p) => {
    for (const fn of ouvintes[ev] || []) {
      try { fn(p); } catch (e) { console.error("[mesa] erro em", ev, e); }
    }
  };

  // ------------------------------------------------------------------ DOM
  const $ = (s, raiz) => (raiz || document).querySelector(s);
  const $$ = (s, raiz) => Array.from((raiz || document).querySelectorAll(s));
  function anexar(e, filhos) {
    for (const f of filhos.flat(Infinity)) {
      if (f == null || f === false || f === "") continue;
      e.append(typeof f === "string" || typeof f === "number" ? document.createTextNode(String(f)) : f);
    }
    return e;
  }
  /* h(tag, opções, ...filhos): opções = "classe" ou {c, t, on:{}, d:{}, style, props, ...atributos}.
     `t` e filhos string viram nós de texto: nunca innerHTML. */
  function h(tag, opts, ...filhos) {
    const e = document.createElement(tag);
    if (typeof opts === "string") e.className = opts;
    else if (opts) {
      for (const k of Object.keys(opts)) {
        const v = opts[k];
        if (v == null || v === false) continue;
        if (k === "c") e.className = v;
        else if (k === "t") e.textContent = String(v);
        else if (k === "on") for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]);
        else if (k === "d") for (const dk of Object.keys(v)) { if (v[dk] != null) e.dataset[dk] = String(v[dk]); }
        else if (k === "style") e.style.cssText = v;
        else if (k === "props") Object.assign(e, v);
        else e.setAttribute(k, v === true ? "" : String(v));
      }
    }
    return anexar(e, filhos);
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function ic(id, cls) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "i" + (/-12$/.test(id) ? " i-12" : "") + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    const u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", "#" + id);
    s.append(u);
    return s;
  }
  const movReduzido = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function spinner(doze) {
    if (movReduzido()) return ic(doze ? "i-run-12" : "i-run", "cor-acento");
    return ic(doze ? "i-spinner-12" : "i-spinner", "gira");
  }
  function limpar(e) { while (e && e.firstChild) e.removeChild(e.firstChild); return e; }
  function ehCampo(e) {
    if (!e || e === document.body) return false;
    const t = e.tagName;
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || e.isContentEditable;
  }

  // ------------------------------------------------------------------ texto
  const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  /* Destaca os termos (sem acento e sem caixa) com <mark>, montando nós de texto. */
  function marcar(texto, termo) {
    texto = String(texto == null ? "" : texto);
    const frag = document.createDocumentFragment();
    const termos = norm(termo).trim().split(/\s+/).filter((t) => t.length > 0);
    if (!termos.length) { frag.append(texto); return frag; }
    let n = "";
    const mapa = [];
    for (let i = 0; i < texto.length; i++) {
      const c = norm(texto[i]);
      for (let k = 0; k < c.length; k++) { n += c[k]; mapa.push(i); }
    }
    let faixas = [];
    for (const t of termos) {
      let p = 0;
      while ((p = n.indexOf(t, p)) !== -1) { faixas.push([mapa[p], mapa[p + t.length - 1] + 1]); p += t.length; }
    }
    if (!faixas.length) { frag.append(texto); return frag; }
    faixas.sort((a, b) => a[0] - b[0]);
    const juntas = [];
    for (const f of faixas) {
      const u = juntas[juntas.length - 1];
      if (u && f[0] <= u[1]) u[1] = Math.max(u[1], f[1]); else juntas.push([f[0], f[1]]);
    }
    let pos = 0;
    for (const [a, b] of juntas) {
      if (a > pos) frag.append(texto.slice(pos, a));
      frag.append(h("mark", { t: texto.slice(a, b) }));
      pos = b;
    }
    if (pos < texto.length) frag.append(texto.slice(pos));
    return frag;
  }
  /* Trechos do índice vêm com «termos» marcados: viram <mark> por nós de texto. */
  function trechoMarcado(s) {
    const frag = document.createDocumentFragment();
    const partes = String(s || "").split(/«([^»]*)»/);
    partes.forEach((p, i) => { if (i % 2) frag.append(h("mark", { t: p })); else if (p) frag.append(p); });
    return frag;
  }
  function slug(s) { return norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function plural(n, um, varios) { return n === 1 ? um : varios; }
  const fmtNum = (n) => new Intl.NumberFormat("pt-BR").format(n);
  const fmtUSD = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

  // ------------------------------------------------------------------ datas (fuso de São Paulo)
  const fmtISO = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });
  const fmtHora = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
  const fmtHoraSeg = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const hojeISO = () => fmtISO.format(new Date());
  const ehData = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  function isoDeTs(ts) { const d = new Date(ts); return ts && !isNaN(d) ? fmtISO.format(d) : ""; }
  function meioDia(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); }
  function somaDias(iso, n) { const d = meioDia(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function diasEntre(a, b) { return Math.round((meioDia(b) - meioDia(a)) / 864e5); }
  const DSEM = ["dom.", "seg.", "ter.", "qua.", "qui.", "sex.", "sáb."];
  const DSEM_LONGO = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const diaSemana = (iso) => meioDia(iso).getUTCDay();
  const ddmm = (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7);
  function dataCurta(iso) { return iso.slice(0, 4) === hoje().slice(0, 4) ? ddmm(iso) : ddmm(iso) + "/" + iso.slice(2, 4); }
  function dataLonga(iso) { return ddmm(iso) + "/" + iso.slice(0, 4); }
  function dataComSemana(iso) { return DSEM[diaSemana(iso)] + " " + dataCurta(iso); }
  function horaDeTs(ts) { const d = new Date(ts); return isNaN(d) ? "" : fmtHora.format(d); }
  function hoje() { return E.hoje || hojeISO(); }
  function relativo(ts) {
    const d = new Date(ts);
    if (!ts || isNaN(d)) return "";
    const seg = (Date.now() - d) / 1000;
    if (Math.abs(seg) < 60) return "agora";
    if (seg > 0 && seg < 3600) return `há ${Math.floor(seg / 60)} min`;
    const dia = isoDeTs(ts), h0 = hoje();
    if (dia === h0) return "hoje " + horaDeTs(ts);
    if (dia === somaDias(h0, -1)) return "ontem " + horaDeTs(ts);
    const dd = diasEntre(dia, h0);
    if (dd > 0 && dd < 7) return dataComSemana(dia);
    return dataCurta(dia);
  }
  function relativoDia(iso) {
    if (!ehData(iso)) return "";
    const h0 = hoje();
    if (iso === h0) return "hoje";
    if (iso === somaDias(h0, -1)) return "ontem";
    const dd = diasEntre(iso, h0);
    if (dd > 0 && dd < 7) return dataComSemana(iso);
    return dataCurta(iso);
  }
  function diaTitulo(iso) {
    const h0 = hoje();
    if (iso === h0) return "Hoje";
    if (iso === somaDias(h0, -1)) return "Ontem";
    return dataComSemana(iso);
  }
  function duracao(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  }
  function cronometro(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000)), m = Math.floor(s / 60);
    if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  function fimDaSemana(iso) { const d = diaSemana(iso); return somaDias(iso, d === 0 ? 0 : 7 - d); }
  function inicioDaSemana(iso) { const d = diaSemana(iso); return somaDias(iso, d === 0 ? -6 : 1 - d); }
  function proximoDiaUtil(iso) { let d = somaDias(iso, 1); while ([0, 6].includes(diaSemana(d))) d = somaDias(d, 1); return d; }
  /* Entende "hoje", "amanhã", "sex", "24/10", "24/10/26", "+3", "próximo dia útil", "2026-10-24". */
  function interpretarData(texto, base) {
    const t = norm(texto).trim().replace(/\.$/, "");
    const h0 = base || hoje();
    if (!t) return null;
    if (t === "hoje") return h0;
    if (t === "amanha") return somaDias(h0, 1);
    if (t === "depois de amanha") return somaDias(h0, 2);
    if (/^proximo dia util$|^dia util$/.test(t)) return proximoDiaUtil(h0);
    if (/^proxima semana$|^semana que vem$/.test(t)) return somaDias(inicioDaSemana(h0), 7);
    let m = t.match(/^\+(\d{1,3})\s*d?$/);
    if (m) return somaDias(h0, Number(m[1]));
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return valida(Number(m[1]), Number(m[2]), Number(m[3]));
    m = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) {
      let ano = m[3] ? Number(m[3]) : Number(h0.slice(0, 4));
      if (ano < 100) ano += 2000;
      let r = valida(ano, Number(m[2]), Number(m[1]));
      if (r && !m[3] && r < somaDias(h0, -60)) r = valida(ano + 1, Number(m[2]), Number(m[1]));
      return r;
    }
    const dias = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
    const w = t.replace(/^(ate|proxim[ao]|na|no)\s+/, "").slice(0, 3);
    const idx = dias.indexOf(w);
    if (idx >= 0) {
      const atual = diaSemana(h0);
      let delta = (idx - atual + 7) % 7;
      if (/^proxim/.test(t) && delta === 0) delta = 7;
      return somaDias(h0, delta);
    }
    return null;
    function valida(a, me, di) {
      if (me < 1 || me > 12 || di < 1 || di > 31) return null;
      const iso = `${a}-${String(me).padStart(2, "0")}-${String(di).padStart(2, "0")}`;
      const d = meioDia(iso);
      return d.getUTCMonth() + 1 === me ? iso : null;
    }
  }

  // ------------------------------------------------------------------ pendências: campos derivados
  const PADRAO_STATUS = {
    aberta: /agora a fazer|reaberta|voltou para mim|restaurada/i,
    andamento: /agora em andamento/i,
    aguardando: /agora aguardando|aguardando outros/i,
    feita: /agora feita|marcada como feita|conclu[ií]da/i,
    descartada: /agora descartada|descartada/i,
  };
  function normalizarItem(x) {
    const i = Object.assign({}, x);
    i.id = String(x.id);
    i.titulo = String(x.titulo || "(sem título)");
    i.status = STATUS_NOME[x.status] ? x.status : "aberta";
    i.prioridade = PRIO[x.prioridade] ? x.prioridade : "semana";
    i.area = AREA[x.area] ? x.area : (AREA[x.projeto] ? x.projeto : AREA_PADRAO);
    i.projeto_id = String(x.projeto_id || "");
    i.pessoa = String(x.pessoa || "");
    i.contexto = typeof x.contexto === "string" ? x.contexto : "";
    i.origem = String(x.origem || "");
    i.prazo = ehData(x.prazo) ? x.prazo : "";
    i.aguardando_de = String(x.aguardando_de || "");
    i.cobrar_em = ehData(x.cobrar_em) ? x.cobrar_em : "";
    i.ordem = typeof x.ordem === "number" ? x.ordem : Number(x.ordem) || 0;
    i.historico = Array.isArray(x.historico) ? x.historico.filter((e) => e && typeof e === "object") : [];
    const lg = x.ligacoes && typeof x.ligacoes === "object" ? x.ligacoes : {};
    i.ligacoes = { arquivos: Array.isArray(lg.arquivos) ? lg.arquivos : [], notas: Array.isArray(lg.notas) ? lg.notas : [], agente: String(lg.agente || ""), como_ajuda: String(lg.como_ajuda || "") };
    i.agente = x.agente && typeof x.agente === "object" ? x.agente : null;
    return i;
  }
  function statusDesde(i) {
    const re = PADRAO_STATUS[i.status];
    for (let k = i.historico.length - 1; k >= 0; k--) {
      const ev = i.historico[k];
      if (re && re.test(String(ev.texto || ""))) return ev.em;
    }
    return i.atualizado_em || i.criado_em || "";
  }
  const concluidaEm = (i) => (i.status === "feita" ? statusDesde(i) : "");
  const diaConcluida = (i) => isoDeTs(concluidaEm(i));
  function diasParada(i) { const d = isoDeTs(statusDesde(i)); return d ? diasEntre(d, hoje()) : 0; }
  const fechada = (i) => i.status === "feita" || i.status === "descartada";
  const atrasada = (i) => !fechada(i) && i.prazo && i.prazo < hoje();
  const venceHoje = (i) => !fechada(i) && i.prazo === hoje();
  function pessoasDe(i) { return String(i.pessoa || "").split(",").map((s) => s.trim()).filter(Boolean); }
  function nomeCurtoBase(nome) { const m = nome.match(/\(([^)]+)\)/); return m ? m[1].trim() : nome.split(/\s+/)[0]; }
  function calcularNomes() {
    const grupos = new Map();
    for (const i of E.itens) for (const p of pessoasDe(i)) {
      const base = nomeCurtoBase(p), chave = norm(base);
      if (!grupos.has(chave)) grupos.set(chave, new Set());
      grupos.get(chave).add(p);
    }
    E.nomesCurtos = new Map();
    for (const nomes of grupos.values()) {
      const lista = [...nomes];
      const semApelido = new Set(lista.map((n) => n.replace(/\s*\([^)]*\)/, "").trim()));
      for (const n of lista) {
        let curto = nomeCurtoBase(n);
        if (semApelido.size > 1 && !/\(/.test(n)) {
          const partes = n.trim().split(/\s+/);
          if (partes.length > 1) curto += " " + partes[partes.length - 1][0].toUpperCase() + ".";
        }
        E.nomesCurtos.set(n, curto);
      }
    }
  }
  const nomeCurto = (nome) => E.nomesCurtos.get(nome) || nomeCurtoBase(nome || "");
  function numerar() {
    const ord = [...E.itens].sort((a, b) => String(a.criado_em || "").localeCompare(String(b.criado_em || "")) || a.id.localeCompare(b.id));
    E.numero = new Map(); E.porNumero = new Map();
    ord.forEach((i, k) => { E.numero.set(i.id, k + 1); E.porNumero.set(k + 1, i.id); });
  }
  const num = (id) => E.numero.get(id) || 0;
  const ref = (id) => "#" + num(id);
  const areaDe = (i) => AREA[i.area] || AREA.Outros;
  function ligacoesN(i) { return (i.ligacoes.arquivos || []).length + (i.ligacoes.notas || []).length; }
  function vistas() { return new Set(lerPref("mesa.entregas.vistas", [])); }
  function marcarVista(eid) {
    const v = lerPref("mesa.entregas.vistas", []);
    if (!v.includes(eid)) { v.push(eid); gravarPref("mesa.entregas.vistas", v.slice(-300)); Mesa.emitir("vistas", eid); }
  }
  function estadoAgente(i) {
    const ativa = Mesa.agente && Mesa.agente.ativaDe ? Mesa.agente.ativaDe(i.id) : null;
    if (ativa) return { estado: "trabalhando", ex: ativa };
    const u = i.agente && i.agente.ultima;
    if (!u) return null;
    if (u.status === "rodando" || u.status === "fila") return { estado: "trabalhando", ex: u }; // disparada em outra aba ou pelo MCP
    if (u.status === "erro") return { estado: "falhou", u };
    if (u.status !== "concluida") return null;
    if ((u.entregas || []).length) return { estado: "entrega", u, naoVista: !vistas().has(u.id) };
    if (u.modo === "rascunho") return { estado: "rascunho", u };
    return { estado: "briefing", u };
  }
  function entregasNaoVistas() {
    const v = vistas();
    return E.itens.filter((i) => !fechada(i) && i.agente && i.agente.ultima && i.agente.ultima.status === "concluida" && (i.agente.ultima.entregas || []).length && !v.has(i.agente.ultima.id));
  }
  /* Rótulo do prazo por contexto (tabela 4.3 do DESIGN). modo: cartao | compacta | gaveta. */
  function prazoInfo(i, modo) {
    if (!i.prazo) return modo === "gaveta" ? { texto: "Sem prazo", cls: "chip-sem", vazio: true } : null;
    const h0 = hoje(), d = diasEntre(h0, i.prazo);
    if (d < 0) {
      const n = -d;
      const texto = modo === "cartao" ? `Atrasada ${n > 99 ? "99+" : n} d` : modo === "compacta" ? "Atrasada" : `Atrasada · venceu ${dataComSemana(i.prazo)} (há ${n} ${plural(n, "dia", "dias")})`;
      return { texto, cls: "chip-atrasada", icone: "i-clock-filled-12", tipo: "atrasada" };
    }
    if (d === 0) return { texto: modo === "compacta" ? "Hoje" : "Vence hoje", cls: "chip-hoje", icone: "i-clock-12", tipo: "hoje" };
    if (d === 1) return { texto: modo === "cartao" ? "Vence amanhã" : modo === "compacta" ? "Amanhã" : `Vence amanhã, ${dataComSemana(i.prazo)}`, cls: "", icone: "i-calendar-12", tipo: "amanha" };
    if (i.prazo.slice(0, 4) !== h0.slice(0, 4)) {
      const curta = ddmm(i.prazo) + "/" + i.prazo.slice(2, 4);
      return { texto: modo === "compacta" ? curta : modo === "cartao" ? `Até ${curta}` : `Até ${dataLonga(i.prazo)}`, cls: "", icone: "i-calendar-12", tipo: "futuro" };
    }
    if (d <= 6) return { texto: modo === "compacta" ? dataComSemana(i.prazo) : `Até ${dataComSemana(i.prazo)}`, cls: "", icone: "i-calendar-12", tipo: "futuro" };
    return { texto: modo === "compacta" ? ddmm(i.prazo) : modo === "cartao" ? `Até ${ddmm(i.prazo)}` : `Até ${dataComSemana(i.prazo)}`, cls: "", icone: "i-calendar-12", tipo: "futuro" };
  }
  /* Estado da cobrança: quando chegou a data de puxar de volta com quem está a bola.
     Independe do prazo — o prazo é a entrega ao solicitante; a cobrança é o lembrete de quem usa o quadro. */
  function cobrancaInfo(i, modo) {
    if (fechada(i) || !i.cobrar_em) return null;
    const d = diasEntre(hoje(), i.cobrar_em);
    const de = i.aguardando_de ? nomeCurto(i.aguardando_de) : "";
    if (d < 0) {
      const nd = -d;
      return { texto: modo === "compacta" ? "Cobrar" : modo === "cartao" ? `Cobrar (${nd > 99 ? "99+" : nd} d)` : `Cobrar${de ? " " + de : ""} · marcada para ${dataComSemana(i.cobrar_em)}, há ${nd} ${plural(nd, "dia", "dias")}`,
               cls: "chip-cobrar vencida", icone: "i-bell-12", tipo: "cobrar-vencida", vencida: true, de, dias: nd };
    }
    if (d === 0) return { texto: modo === "gaveta" ? `Cobrar${de ? " " + de : ""} hoje` : "Cobrar hoje", cls: "chip-cobrar", icone: "i-bell-12", tipo: "cobrar-hoje", de, dias: 0 };
    if (d === 1) return { texto: modo === "gaveta" ? `Cobrar${de ? " " + de : ""} amanhã` : "Cobrar amanhã", cls: "chip-cobrar futura", icone: "i-bell-12", tipo: "cobrar-futura", de, dias: 1 };
    return { texto: modo === "gaveta" ? `Cobrar${de ? " " + de : ""} ${dataComSemana(i.cobrar_em)}` : `Cobrar ${ddmm(i.cobrar_em)}`, cls: "chip-cobrar futura", icone: "i-bell-12", tipo: "cobrar-futura", de, dias: d };
  }
  const cobrancaVencida = (i) => { const c = cobrancaInfo(i); return !!c && (c.tipo === "cobrar-vencida" || c.tipo === "cobrar-hoje"); };
  /* Chip do lugar do prazo no cartão. Precedência: cobrança vencida > prazo > cobrança futura >
     Parada há n d (só em Aguardando). A cobrança vencida vem antes do prazo porque é o lembrete
     que só existe aqui: o prazo ainda reaparece na coluna, no filtro e na daily. */
  function chipCartao(i, modo) {
    if (i.status === "feita" || i.status === "descartada") return null;
    const c = cobrancaInfo(i, modo);
    if (c && c.vencida) return c;          // cobrança atrasada manda em tudo: é o que ele perde se não vir
    const p = prazoInfo(i, modo);
    if (p) return p;
    if (c) return c;
    if (i.status === "aguardando") {
      const n = diasParada(i);
      if (n > 3) return { texto: `Parada há ${n} d`, cls: "chip-parada", icone: "i-hourglass-12", tipo: "parada" };
    }
    return null;
  }
  function descricaoAcessivel(i) {
    const partes = [areaDe(i).nome + "."];
    const ps = pessoasDe(i);
    if (ps.length) partes.push(`Pedida por ${ps.join(" e ")}.`);
    partes.push(PRIO[i.prioridade].nome + ".");
    if (i.status === "feita") partes.push(`Concluída ${relativoDia(diaConcluida(i))}.`);
    else {
      const c = chipCartao(i, "gaveta");
      partes.push(c ? c.texto + "." : "Sem prazo.");
    }
    if (i.aguardando_de) partes.push(`Aguardando ${i.aguardando_de}.`);
    const cb = cobrancaInfo(i, "gaveta");
    // o chip acima já pode ser o da cobrança; só acrescenta quando o prazo tomou o lugar dele
    if (cb && !/^Cobrar/.test(chipCartao(i, "gaveta") ? chipCartao(i, "gaveta").texto : "")) partes.push(cb.texto + ".");
    const na = (i.ligacoes.arquivos || []).length, nn = (i.ligacoes.notas || []).length;
    if (na || nn) partes.push(`${na} ${plural(na, "arquivo", "arquivos")} e ${nn} ${plural(nn, "nota", "notas")} ligados.`);
    const ag = estadoAgente(i);
    if (ag) partes.push({ trabalhando: "Agente trabalhando.", falhou: "O agente parou com erro.", entrega: "Entrega pronta.", rascunho: "Rascunho de resposta pronto.", briefing: "Briefing pronto." }[ag.estado]);
    return partes.join(" ");
  }

  // ------------------------------------------------------------------ peças visuais compartilhadas
  function quadrado(area, tam) {
    const a = typeof area === "string" ? (AREA[area] || AREA.Outros) : area;
    return h("span", { c: "sq" + (tam === 10 ? " sq-10" : "") + (a.outros ? " sq-outros" : ""), style: "--cor:" + a.cor, "aria-hidden": "true" });
  }
  function iconeStatus(status, doze) {
    let id = STATUS_ICONE[status] || "i-status-todo";
    if (doze) id = status === "feita" ? "i-status-done-12" : id;
    return ic(id, STATUS_COR[status]);
  }
  function iconePrio(p) { const x = PRIO[p] || PRIO.semana; return ic(x.icone, "prio-" + x.v); }
  function avatar(nome, grande) { return h("span", { c: "avatar" + (grande ? " avatar-20" : ""), "aria-hidden": "true", t: (nome || "?").trim().charAt(0).toUpperCase() }); }
  function chip(info, opts) {
    if (!info) return null;
    const e = h("span", { c: "chip " + (info.cls || "") });
    if (info.icone) e.append(ic(info.icone));
    e.append(document.createTextNode(info.texto));
    if (opts && opts.semFundo) e.classList.add("sem-fundo");
    return e;
  }
  function kbd(...teclas) { return h("span", { c: "kbds", "aria-hidden": "true" }, teclas.map((t) => h("kbd", { t }))); }

  // ------------------------------------------------------------------ regiões vivas
  function anunciar(texto, urgente) {
    const e = document.getElementById(urgente ? "vivo-urgente" : "vivo-educado");
    if (!e) return;
    e.textContent = "";
    setTimeout(() => { e.textContent = texto; }, 40);
  }

  // ------------------------------------------------------------------ API
  const duracoes = [];
  function medir(ms) {
    duracoes.push(ms);
    if (duracoes.length > 2) duracoes.shift();
    const lento = duracoes.length === 2 && duracoes.every((d) => d > 2000);
    if (E.servidor === "ok" && lento) definirServidor("lento");
    else if (E.servidor === "lento" && ms < 2000) definirServidor("ok");
  }
  function agoraCurto() { return `${ddmm(hojeISO())} ${fmtHoraSeg.format(new Date())}`; }
  async function api(metodo, caminho, corpo, opcoes) {
    const o = opcoes || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.tempo || 10000);
    const init = { method: metodo, cache: "no-store", signal: ctrl.signal, headers: {} };
    if (metodo !== "GET") {
      init.headers = { "Content-Type": "application/json", "X-Mesa": "1" };
      init.body = JSON.stringify(corpo || {});
    }
    const t0 = performance.now();
    let r;
    try {
      r = await fetch(caminho, init);
    } catch (e) {
      clearTimeout(timer);
      const abortou = e && e.name === "AbortError";
      const err = new Error(abortou ? "O servidor não respondeu a tempo." : "Sem conexão com o servidor local.");
      err.rede = true; err.tempoEsgotado = abortou; err.detalhe = `${metodo} ${caminho} · sem resposta · ${agoraCurto()}`;
      if (metodo !== "GET" && !abortou) Mesa.n.servidorFalhou();
      throw err;
    }
    try {
      if (!o.semMedir) medir(performance.now() - t0);
      E.ultimaResposta = Date.now();
      if (o.texto && r.ok) return await r.text();
      let dados = null;
      try { dados = await r.json(); } catch (e) { /* sem corpo JSON */ }
      if (!r.ok) {
        const err = new Error((dados && dados.erro) || `O servidor respondeu ${r.status}.`);
        err.status = r.status; err.dados = dados; err.detalhe = `${metodo} ${caminho} · ${r.status} · ${agoraCurto()}`;
        throw err;
      }
      return dados;
    } finally {
      clearTimeout(timer);
    }
  }
  const rotaItem = (id, sufixo) => `/api/pendencias/${encodeURIComponent(id)}${sufixo || ""}`;

  // ------------------------------------------------------------------ dados
  function aplicarDados(d, opts) {
    if (!d || !Array.isArray(d.pendencias)) return;
    const externo = !!(opts && opts.externo);
    const anteriores = E.porId;
    E.dados = d;
    E.versao = d.versao;
    E.meta = d.meta || {};
    E.itens = d.pendencias.map(normalizarItem);
    E.porId = new Map(E.itens.map((i) => [i.id, i]));
    numerar();
    calcularNomes();
    const mudados = [];
    if (externo && anteriores.size) {
      for (const i of E.itens) {
        const a = anteriores.get(i.id);
        if (!a || a.atualizado_em !== i.atualizado_em) mudados.push(i.id);
      }
    }
    for (const id of [...E.selecao]) if (!E.porId.has(id)) E.selecao.delete(id);
    E.carregado = true;
    E.erroCarga = null;
    E.ultimaSync = Date.now();
    Mesa.emitir("dados", { externo, mudados });
  }
  let recarregando = null, falhasCarga = 0;
  async function recarregar(opts) {
    if (recarregando) return recarregando;
    const mostrarBarra = E.carregado && opts && opts.barra;
    if (mostrarBarra) Mesa.emitir("recarga", true);
    recarregando = (async () => {
      try {
        const d = await api("GET", "/api/pendencias", null, { tempo: E.carregado ? 5000 : 10000 });
        falhasCarga = 0;
        if (E.servidor === "fora") voltou();
        else if (E.servidor === "verificando") definirServidor("ok");
        E.ultimaSync = Date.now();
        if (d.versao !== E.versao || !E.carregado) aplicarDados(d, { externo: E.carregado });
        else Mesa.emitir("sync");
      } catch (e) {
        falhasCarga++;
        if (!E.carregado) { E.erroCarga = { mensagem: e.message, detalhe: e.detalhe || "" }; Mesa.emitir("erroCarga", E.erroCarga); }
        if (e.rede && falhasCarga >= 2) caiu();
      } finally {
        recarregando = null;
        if (mostrarBarra) Mesa.emitir("recarga", false);
      }
    })();
    return recarregando;
  }
  async function carregarProjetos(forcar) {
    if (E.projetosCarregados && !forcar) return E.projetos;
    try {
      const r = await api("GET", "/api/projetos", null, { tempo: 15000 });
      E.projetos = Array.isArray(r.projetos) ? r.projetos : [];
      E.projetosPorId = new Map(E.projetos.map((p) => [p.id, p]));
      E.indice = r.indice || null;
      E.projetosCarregados = true;
      Mesa.emitir("projetos");
    } catch (e) { /* a página Projetos mostra o erro; o resto segue sem nomes */ }
    return E.projetos;
  }
  function nomeProjeto(pid) {
    if (!pid) return "";
    const p = E.projetosPorId.get(pid);
    return p ? p.nome : pid;
  }

  // ------------------------------------------------------------------ sincronização (barra de status)
  let timerSalvo = null;
  function definirSync(v, erro) {
    clearTimeout(timerSalvo);
    E.sync = v;
    E.syncErro = erro || null;
    if (v === "salvo") timerSalvo = setTimeout(() => { E.sync = ""; Mesa.emitir("sync"); }, 1500);
    Mesa.emitir("sync");
  }
  const salvandoTimers = new Map();
  function marcarSalvando(id, on) {
    clearTimeout(salvandoTimers.get(id));
    if (on) salvandoTimers.set(id, setTimeout(() => Mesa.emitir("salvando", { id, on: true }), 800));
    else { salvandoTimers.delete(id); Mesa.emitir("salvando", { id, on: false }); }
  }
  function podeEscrever() { return E.servidor !== "fora"; }
  function semConexao() {
    toast({ texto: "Sem conexão com o servidor local.", tipo: "erro", duracao: 5000 });
  }
  function mensagemErro(e) {
    if (!e) return "Não consegui salvar.";
    if (e.status === 400) return `Não consegui salvar: ${String(e.message || "").replace(/\.$/, "")}.`;
    return e.message || "Não consegui salvar.";
  }

  // ------------------------------------------------------------------ desfazer
  const pilha = [], refeitas = [];
  function registrarAcao(acao) {
    pilha.push(acao);
    if (pilha.length > 20) pilha.shift();
    refeitas.length = 0;
  }
  async function desfazerMudanca(m) {
    if (!m) return;
    const r = m.tipo === "criou"
      ? await api("DELETE", rotaItem(m.id), {})
      : await api("POST", rotaItem(m.id, "/restaurar"), { antes: m.antes });
    aplicarDados(r.dados);
  }
  /* Ação reversível a partir das mudanças do servidor. `refazerFn` devolve as mudanças novas. */
  function criarAcao(rotulo, mudancas, refazerFn, rotuloDesfeito) {
    const acao = { rotulo, rotuloDesfeito, mudancas: (mudancas || []).filter(Boolean) };
    acao.desfazer = async () => {
      for (const m of [...acao.mudancas].reverse()) await desfazerMudanca(m);
    };
    acao.refazer = refazerFn ? async () => { acao.mudancas = ((await refazerFn()) || []).filter(Boolean); } : null;
    return acao;
  }
  async function executarDesfazer(acao, toastEl) {
    if (!podeEscrever()) return semConexao();
    definirSync("salvando");
    try {
      await acao.desfazer();
      definirSync("salvo");
      const idx = pilha.indexOf(acao);
      if (idx >= 0) pilha.splice(idx, 1);
      if (acao.refazer) refeitas.push(acao);
      const texto = acao.rotuloDesfeito || `Desfeito: ${acao.rotulo.replace(/\.$/, "")}.`;
      const acoes = acao.refazer ? [{ rotulo: "Refazer", fn: () => executarRefazer(acao) }] : [];
      if (toastEl && toastEl.isConnected) atualizarToast(toastEl, { texto, acoes, tipo: "info" });
      else toast({ texto, tipo: "info", acoes });
      anunciar(texto);
    } catch (e) {
      definirSync("erro", e);
      const t = e.status === 409 ? "Não dá pra desfazer: a pendência mudou depois." : `Não consegui desfazer: ${e.message}`;
      toast({ texto: t, tipo: "erro" });
    }
  }
  async function executarRefazer(acao) {
    if (!podeEscrever()) return semConexao();
    definirSync("salvando");
    try {
      await acao.refazer();
      definirSync("salvo");
      const idx = refeitas.indexOf(acao);
      if (idx >= 0) refeitas.splice(idx, 1);
      pilha.push(acao);
      toast({ texto: `Refeito: ${acao.rotulo}`, tipo: "ok", desfazer: acao });
    } catch (e) {
      definirSync("erro", e);
      toast({ texto: `Não consegui refazer: ${e.message}`, tipo: "erro" });
    }
  }
  function desfazerUltimo() {
    const acao = pilha[pilha.length - 1];
    if (!acao) { toast({ texto: "Nada para desfazer nesta sessão.", tipo: "info" }); return; }
    executarDesfazer(acao);
  }
  function refazerUltimo() {
    const acao = refeitas[refeitas.length - 1];
    if (!acao) { toast({ texto: "Nada para refazer.", tipo: "info" }); return; }
    executarRefazer(acao);
  }

  // ------------------------------------------------------------------ escritas comuns
  /* PATCH com toast + Desfazer. Devolve a mudança (ou null se nada mudou). */
  async function mudar(id, campos, opts) {
    const o = opts || {};
    if (!podeEscrever()) { semConexao(); throw new Error("sem conexão"); }
    marcarSalvando(id, true);
    definirSync("salvando");
    try {
      const corpo = { campos: campos || {} };
      if (o.nota) corpo.nota = o.nota;
      /* `base` é o atualizado_em de quando a edição começou. Sem ele o servidor não confere nada:
         é o caso dos cliques instantâneos (menu de status), em que não há janela para conflito. */
      if (o.base) corpo.se_atualizado_em = o.base;
      const r = await api("PATCH", rotaItem(id), corpo);
      aplicarDados(r.dados);
      definirSync("salvo");
      if (r.mudanca && o.toast !== false) {
        const refazer = async () => {
          const r2 = await api("PATCH", rotaItem(id), corpo);
          aplicarDados(r2.dados);
          return [r2.mudanca];
        };
        const acao = criarAcao(o.rotulo || o.toast || "Pendência alterada.", [r.mudanca], refazer, o.rotuloDesfeito);
        registrarAcao(acao);
        if (o.toast) toast({ texto: o.toast, tipo: "ok", desfazer: acao });
      }
      return r.mudanca;
    } catch (e) {
      if (e.status === 409 && e.dados && e.dados.conflito) {
        // outra via (leitura do Teams, agente, MCP) gravou primeiro: mostra o estado novo e deixa
        // ele decidir, em vez de passar por cima do que acabou de chegar
        if (e.dados.dados) aplicarDados(e.dados.dados, { externo: true });
        definirSync("");
        const forcar = async () => {
          try { await mudar(id, campos, { ...o, base: "", toast: o.toast || "Alteração aplicada por cima." }); }
          catch (e2) { /* toast já mostrado */ }
        };
        toast({ texto: e.message, tipo: "aviso", duracao: 14000,
                acoes: [{ rotulo: "Ver o que mudou", fn: () => Mesa.gaveta && Mesa.gaveta.abrir(id, { via: "push", aba: "historico" }) },
                        { rotulo: "Aplicar mesmo assim", fn: forcar }] });
        throw e;
      }
      definirSync("erro", e);
      if (!o.silencioso) toast({ texto: o.erro || mensagemErro(e), tipo: "erro", acoes: o.tentar ? [{ rotulo: "Tentar de novo", fn: o.tentar }] : [] });
      throw e;
    } finally {
      marcarSalvando(id, false);
    }
  }
  /* Move uma ou várias pendências (POST /mover; extra = campos a mudar depois, como a área da raia). */
  async function moverVarias(movs, opts) {
    const o = opts || {};
    if (!podeEscrever()) { semConexao(); throw new Error("sem conexão"); }
    const mudancas = [];
    definirSync("salvando");
    movs.forEach((m) => marcarSalvando(m.id, true));
    try {
      for (const m of movs) {
        const item = E.porId.get(m.id);
        if (!item) continue;
        if (m.status != null) {
          const r = await api("POST", rotaItem(m.id, "/mover"), { status: m.status, posicao: Math.max(0, m.posicao | 0) });
          if (r.mudanca) mudancas.push(r.mudanca);
          aplicarDados(r.dados);
        }
        if (m.campos && Object.keys(m.campos).length) {
          const r = await api("PATCH", rotaItem(m.id), { campos: m.campos });
          if (r.mudanca) mudancas.push(r.mudanca);
          aplicarDados(r.dados);
        }
      }
      definirSync("salvo");
      if (mudancas.length && o.toast !== false) {
        const refazer = async () => {
          const novas = [];
          for (const m of movs) {
            if (m.status != null) { const r = await api("POST", rotaItem(m.id, "/mover"), { status: m.status, posicao: Math.max(0, m.posicao | 0) }); novas.push(r.mudanca); aplicarDados(r.dados); }
            if (m.campos && Object.keys(m.campos).length) { const r = await api("PATCH", rotaItem(m.id), { campos: m.campos }); novas.push(r.mudanca); aplicarDados(r.dados); }
          }
          return novas;
        };
        const acao = criarAcao(o.rotulo || "Pendência movida.", mudancas, refazer, o.rotuloDesfeito);
        registrarAcao(acao);
        toast({ texto: o.rotulo || "Pendência movida.", tipo: "ok", desfazer: acao });
        anunciar(o.anuncio || o.rotulo || "");
      }
      return mudancas;
    } catch (e) {
      definirSync("erro", e);
      // desfaz o que já tinha ido antes da falha, para nada ficar pela metade
      for (const m of mudancas.reverse()) { try { await desfazerMudanca(m); } catch (e2) { /* segue */ } }
      if (!o.silencioso) toast({ texto: e.rede || e.status >= 500 ? "Não consegui salvar. A pendência voltou para onde estava." : mensagemErro(e), tipo: "erro", acoes: o.tentar ? [{ rotulo: "Tentar de novo", fn: o.tentar }] : [] });
      Mesa.emitir("dados", { externo: false, mudados: [] });
      throw e;
    } finally {
      movs.forEach((m) => marcarSalvando(m.id, false));
    }
  }
  async function criar(campos, opts) {
    const o = opts || {};
    if (!podeEscrever()) { semConexao(); throw new Error("sem conexão"); }
    definirSync("salvando");
    try {
      const r = await api("POST", "/api/pendencias", { campos });
      aplicarDados(r.dados);
      definirSync("salvo");
      const m = r.mudanca;
      const refazer = async () => { const r2 = await api("POST", "/api/pendencias", { campos }); aplicarDados(r2.dados); return [r2.mudanca]; };
      const acao = criarAcao(`Pendência criada: ${ref(m.id)}.`, [m], refazer, `Desfeito: ${ref(m.id)} não foi criada.`);
      registrarAcao(acao);
      if (o.toast !== false) toast({ texto: `Pendência criada: ${ref(m.id)}.`, tipo: "ok", acoes: [{ rotulo: "Abrir", fn: () => Mesa.gaveta && Mesa.gaveta.abrir(m.id, { via: "push" }) }], desfazer: acao });
      return m;
    } catch (e) {
      definirSync("erro", e);
      toast({ texto: mensagemErro(e), tipo: "erro" });
      throw e;
    }
  }
  async function copiar(texto, msg) {
    let ok = false;
    try { await navigator.clipboard.writeText(texto); ok = true; } catch (e) {
      const t = h("textarea", { style: "position:fixed;left:-9999px;top:0", "aria-hidden": "true" });
      t.value = texto; document.body.append(t); t.select();
      try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
      t.remove();
    }
    toast({ texto: ok ? (msg || "Copiado.") : "Não consegui copiar para a área de transferência.", tipo: ok ? "ok" : "erro", duracao: ok ? 3000 : 5000 });
    return ok;
  }
  async function copiarRico(html, texto, msg) {
    try {
      if (!window.ClipboardItem) throw new Error("sem ClipboardItem");
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([texto], { type: "text/plain" }) })]);
      toast({ texto: msg || "Pronto para colar no Teams.", tipo: "ok", duracao: 3000 });
      return true;
    } catch (e) {
      return copiar(texto, msg || "Pronto para colar no Teams.");
    }
  }
  async function abrirCaminho(caminho, com) {
    if (!E.recursos.abrir) { toast({ texto: "Abrir arquivos ainda não está ligado neste servidor.", tipo: "info" }); return false; }
    if (!podeEscrever()) { semConexao(); return false; }
    try {
      await api("POST", "/api/abrir", { caminho, com: com === "code" ? "code" : "explorer" });
      return true;
    } catch (e) {
      const m = String(e.message || "");
      let texto = m;
      if (/não existe/i.test(m)) texto = "Arquivo não encontrado. Ele pode ter sido movido ou apagado.";
      else if (/só dá para abrir|fora/i.test(m)) texto = "Esse caminho está fora das pastas mapeadas.";
      toast({ texto, tipo: "erro" });
      return false;
    }
  }
  /* O nome da entrega pode vir com subpasta ("e-2026…/src/Video.jsx"): no disco isso é barra
     invertida e, na URL, cada pedaço é codificado à parte (quem valida o caminho é o servidor). */
  const caminhoEntrega = (pid, nome) => `${RAIZ_MESA}\\entregas\\${pid}\\${String(nome).replace(/\//g, "\\")}`;
  const urlEntrega = (pid, nome) => `/api/entregas/${encodeURIComponent(pid)}/${String(nome).split("/").map(encodeURIComponent).join("/")}`;

  // ------------------------------------------------------------------ toasts
  let toastsTimers = new WeakMap();
  function toast(o) {
    const cont = document.getElementById("toasts");
    if (!cont) return null;
    const tipo = o.tipo || "info";
    const el = h("div", { c: "toast" });
    el._o = o;
    preencherToast(el, o);
    cont.append(el);
    while (cont.children.length > 3) removerToast(cont.firstElementChild, true);
    anunciar(o.texto, tipo === "erro");
    const dur = o.duracao != null ? o.duracao : tipo === "erro" ? 0 : o.desfazer ? 8000 : 5000;
    if (dur > 0) iniciarTempo(el, dur);
    el.addEventListener("pointerenter", () => pausar(el));
    el.addEventListener("pointerleave", () => retomar(el));
    el.addEventListener("focusin", () => pausar(el));
    el.addEventListener("focusout", () => retomar(el));
    Mesa.emitir("toasts");
    return el;
  }
  function preencherToast(el, o) {
    limpar(el);
    const tipo = o.tipo || "info";
    el.append(ic(tipo === "erro" ? "i-error" : tipo === "ok" ? "i-success" : "i-info", tipo === "erro" ? "err" : tipo === "ok" ? "ok" : "info"));
    el.append(h("div", { c: "toast-texto", t: o.texto }));
    const acoes = h("div", { c: "toast-acoes" });
    if (o.desfazer) acoes.append(h("button", { type: "button", c: "toast-acao", t: "Desfazer", on: { click: () => executarDesfazer(o.desfazer, el) } }));
    for (const a of o.acoes || []) acoes.append(h("button", { type: "button", c: "toast-acao", t: a.rotulo, on: { click: () => { try { a.fn(); } finally { if (!a.manter) removerToast(el); } } } }));
    acoes.append(h("button", { type: "button", c: "toast-fechar", "aria-label": "Fechar notificação", on: { click: () => removerToast(el) } }, ic("i-dismiss")));
    el.append(acoes);
  }
  function atualizarToast(el, o) {
    el._o = Object.assign({}, el._o, o, { desfazer: o.desfazer || null });
    preencherToast(el, el._o);
    iniciarTempo(el, 8000);
  }
  function iniciarTempo(el, ms) {
    const t = toastsTimers.get(el);
    if (t) clearTimeout(t.id);
    const info = { resta: ms, inicio: Date.now(), id: 0 };
    info.id = setTimeout(() => removerToast(el), ms);
    toastsTimers.set(el, info);
  }
  function pausar(el) {
    const t = toastsTimers.get(el);
    if (!t || t.pausado) return;
    clearTimeout(t.id); t.resta -= Date.now() - t.inicio; t.pausado = true;
  }
  function retomar(el) {
    const t = toastsTimers.get(el);
    if (!t || !t.pausado || el.matches(":hover") || el.contains(document.activeElement)) return;
    t.pausado = false; t.inicio = Date.now(); t.id = setTimeout(() => removerToast(el), Math.max(1500, t.resta));
  }
  document.addEventListener("visibilitychange", () => {
    for (const el of $$("#toasts .toast")) { if (document.hidden) pausar(el); else retomar(el); }
  });
  function removerToast(el, ja) {
    if (!el || !el.isConnected) return;
    const t = toastsTimers.get(el);
    if (t) clearTimeout(t.id);
    if (ja || movReduzido()) { el.remove(); Mesa.emitir("toasts"); return; }
    el.classList.add("saindo");
    setTimeout(() => { el.remove(); Mesa.emitir("toasts"); }, 110);
  }

  // ------------------------------------------------------------------ camadas (Esc fecha a mais alta)
  const camadas = [];
  function empilharCamada(c) { camadas.push(c); return c; }
  function tirarCamada(c) { const i = camadas.indexOf(c); if (i >= 0) camadas.splice(i, 1); }
  function fecharTopo() {
    const c = camadas[camadas.length - 1];
    if (!c) return false;
    c.fechar();
    return true;
  }
  const temCamada = (tipo) => camadas.some((c) => !tipo || c.tipo === tipo);

  // ------------------------------------------------------------------ posicionamento de flutuantes
  function posicionar(el, ancora, lado) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw < 720 && el.classList.contains("menu") && !el.classList.contains("sub")) { el.classList.add("folha"); return; }
    const r = ancora && ancora.getBoundingClientRect ? ancora.getBoundingClientRect() : ancora;
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x, y;
    if (lado === "direita") { x = r.right + 2; y = r.top - 4; if (x + w > vw - 8) x = r.left - w - 2; }
    else {
      x = r.left; y = r.bottom + 4;
      if (x + w > vw - 8) x = Math.max(8, r.right - w);
      if (y + hh > vh - 8) y = Math.max(8, r.top - hh - 4);
    }
    x = Math.max(8, Math.min(x, vw - w - 8));
    y = Math.max(8, Math.min(y, vh - hh - 8));
    el.style.left = x + "px";
    el.style.top = y + "px";
  }

  // ------------------------------------------------------------------ menus
  /* itens: {rotulo, icone?, iconeEl?, sq?, sec?, num?, kbd?, marcado?, tipo?: "check"|"radio", desabilitado?, dica?,
     perigo?, acao(), sub?: itens | () => itens, somente?(), titulo?: "Seção", separador?: true, manter?: true} */
  let menuAberto = null;
  function menu(ancora, itens, opts) {
    const o = opts || {};
    if (!o.sub) fecharMenus();
    const camada = document.getElementById("camada-menus");
    const el = h("div", { c: "menu" + (o.sub ? " sub" : "") + (o.classe ? " " + o.classe : ""), role: "menu", "aria-label": o.rotulo || null, tabindex: "-1" });
    let filtroInput = null;
    const corpo = h("div");
    if (o.filtro) {
      filtroInput = h("input", { type: "text", placeholder: o.placeholder || "Filtrar…", "aria-label": "Filtrar opções", autocomplete: "off" });
      el.append(h("div", { c: "menu-filtro" }, filtroInput));
    }
    el.append(corpo);
    const estado = { el, ancora, fechar, sub: null, pai: o.pai || null };
    let botoes = [];
    function render() {
      limpar(corpo);
      const lista = typeof itens === "function" ? itens() : itens;
      const termo = filtroInput ? norm(filtroInput.value.trim()) : "";
      botoes = [];
      let n = 0;
      for (const it of lista) {
        if (it.separador) { if (!termo) corpo.append(h("div", { c: "menu-sep", role: "separator" })); continue; }
        if (it.titulo) { if (!termo) corpo.append(h("div", { c: "menu-titulo", t: it.titulo, role: "presentation" })); continue; }
        if (it.campo) { corpo.append(it.campo); continue; }
        if (termo && !norm(it.rotulo).includes(termo)) continue;
        n++;
        const papel = it.tipo === "check" ? "menuitemcheckbox" : it.tipo === "radio" ? "menuitemradio" : "menuitem";
        const b = h("button", { type: "button", c: "menu-item" + (it.perigo ? " perigo" : ""), role: papel, tabindex: "-1",
          "aria-checked": it.tipo ? String(!!it.marcado) : null, "aria-disabled": it.desabilitado ? "true" : null,
          "aria-haspopup": it.sub ? "menu" : null, "data-tip": it.dica || null });
        if (it.tipo) b.append(h("span", { c: "marca" }, it.marcado ? ic(it.tipo === "radio" ? "i-check" : "i-check") : null));
        if (it.sq) b.append(quadrado(it.sq));
        if (it.iconeEl) b.append(it.iconeEl);
        else if (it.icone) b.append(ic(it.icone, it.iconeCls));
        b.append(h("span", { c: "rot", t: it.rotulo }));
        if (it.somente) b.append(h("span", { c: "somente", t: "Somente", d: { somente: "1" } }));
        if (it.num != null) b.append(h("span", { c: "num", t: String(it.num) }));
        if (it.sec) b.append(h("span", { c: "sec", t: it.sec }));
        if (it.kbd) b.append(kbd(...[].concat(it.kbd)));
        if (it.sub) b.append(ic("i-chevron-right-12"));
        b._it = it;
        b.addEventListener("click", (ev) => ativar(b, ev));
        b.addEventListener("pointerenter", () => { if (it.sub) abrirSub(b); else if (estado.sub) { estado.sub.fechar(true); estado.sub = null; } });
        corpo.append(b);
        botoes.push(b);
      }
      if (!n) corpo.append(h("div", { c: "menu-vazio", t: termo ? "Nada com esse filtro." : (o.vazio || "Nada para mostrar.") }));
    }
    function ativar(b, ev) {
      const it = b._it;
      if (it.desabilitado) return;
      if (it.sub) { abrirSub(b, true); return; }
      if (ev && ev.target && ev.target.closest && ev.target.closest("[data-somente]") && it.somente) { fecharTudo(); it.somente(); return; }
      if (it.tipo === "check" && (o.multi || it.manter)) {
        it.marcado = !it.marcado;
        b.setAttribute("aria-checked", String(it.marcado));
        const m = b.querySelector(".marca"); limpar(m); if (it.marcado) m.append(ic("i-check"));
        if (it.acao) it.acao(it.marcado);
        return;
      }
      fecharTudo(true);
      if (it.acao) it.acao();
    }
    function abrirSub(b, focar) {
      if (estado.sub && estado.sub.ancora === b) { if (focar) estado.sub.focarPrimeiro(); return; }
      if (estado.sub) estado.sub.fechar(true);
      const it = b._it;
      estado.sub = menu(b, typeof it.sub === "function" ? it.sub() : it.sub, { sub: true, pai: estado, rotulo: it.rotulo, lado: "direita" });
      if (focar) estado.sub.focarPrimeiro();
    }
    function focarIdx(i) {
      const ativos = botoes.filter((b) => !b._it.desabilitado);
      if (!ativos.length) return;
      const k = (i + ativos.length) % ativos.length;
      ativos[k].focus();
    }
    estado.focarPrimeiro = () => { if (filtroInput) filtroInput.focus(); else focarIdx(0); };
    el.addEventListener("keydown", (ev) => {
      const ativos = botoes.filter((b) => !b._it.desabilitado);
      const atual = ativos.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); focarIdx(atual + 1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); if (atual <= 0 && filtroInput) filtroInput.focus(); else focarIdx(atual - 1); }
      else if (ev.key === "Home" && document.activeElement !== filtroInput) { ev.preventDefault(); focarIdx(0); }
      else if (ev.key === "End" && document.activeElement !== filtroInput) { ev.preventDefault(); focarIdx(ativos.length - 1); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); fechar(); }
      else if (ev.key === "ArrowRight" && document.activeElement && document.activeElement._it && document.activeElement._it.sub) { ev.preventDefault(); abrirSub(document.activeElement, true); }
      else if (ev.key === "ArrowLeft" && o.sub) { ev.preventDefault(); fechar(); }
      else if (ev.key === "Tab") { ev.preventDefault(); fecharTudo(); }
      else if (ev.key === "Enter" && document.activeElement === filtroInput) { ev.preventDefault(); if (ativos[0]) ativar(ativos[0]); }
      else if (/^[1-9]$/.test(ev.key) && !filtroInput && ativos.length <= 9 && !ev.ctrlKey && !ev.altKey) {
        const b = ativos[Number(ev.key) - 1];
        if (b) { ev.preventDefault(); ativar(b); }
      } else if (ev.key === " " && document.activeElement && document.activeElement.classList.contains("menu-item")) { ev.preventDefault(); ativar(document.activeElement); }
    });
    if (filtroInput) filtroInput.addEventListener("input", render);
    function fechar(semFoco) {
      if (!el.isConnected) return;
      if (estado.sub) { estado.sub.fechar(true); estado.sub = null; }
      el.remove();
      tirarCamada(estado.camada);
      if (ancora && ancora.setAttribute && ancora.hasAttribute("aria-expanded")) ancora.setAttribute("aria-expanded", "false");
      if (!o.sub && menuAberto === estado) menuAberto = null;
      if (o.pai && o.pai.sub === estado) o.pai.sub = null;
      if (o.aoFechar) o.aoFechar();
      if (!semFoco) {
        if (o.pai) { if (ancora && ancora.focus) ancora.focus(); }
        else if (o.devolverFoco !== false && ancora && ancora.focus && document.contains(ancora)) ancora.focus({ preventScroll: true });
      }
    }
    function fecharTudo(semFoco) {
      let raiz = estado;
      while (raiz.pai) raiz = raiz.pai;
      raiz.fechar(semFoco);
      if (semFoco && raiz.ancora && raiz.ancora.focus && document.contains(raiz.ancora) && o.devolverFoco !== false) raiz.ancora.focus({ preventScroll: true });
    }
    estado.render = render;
    render();
    camada.append(el);
    posicionar(el, o.ponto || ancora, o.lado);
    if (ancora && ancora.setAttribute && ancora.tagName === "BUTTON") ancora.setAttribute("aria-expanded", "true");
    estado.camada = empilharCamada({ tipo: "menu", fechar: () => fechar() });
    if (!o.sub) menuAberto = estado;
    if (o.focar !== false) requestAnimationFrame(() => estado.focarPrimeiro());
    return estado;
  }
  function fecharMenus() {
    if (menuAberto) menuAberto.fechar(true);
    for (const p of [...popovers]) p.fechar(true);
  }
  document.addEventListener("pointerdown", (ev) => {
    const camada = document.getElementById("camada-menus");
    if (!camada || camada.contains(ev.target)) return;
    if (menuAberto && !(menuAberto.ancora && menuAberto.ancora.contains && menuAberto.ancora.contains(ev.target))) menuAberto.fechar(true);
    for (const p of [...popovers]) if (!(p.ancora && p.ancora.contains && p.ancora.contains(ev.target))) p.fechar(true, true);
  }, true);

  // ------------------------------------------------------------------ popovers
  const popovers = [];
  function popover(ancora, conteudo, opts) {
    const o = opts || {};
    for (const p of [...popovers]) p.fechar(true);
    if (menuAberto) menuAberto.fechar(true);
    const el = h("div", { c: "popover" + (o.classe ? " " + o.classe : ""), role: "dialog", "aria-label": o.rotulo || null, tabindex: "-1" }, conteudo);
    document.getElementById("camada-menus").append(el);
    posicionar(el, o.ponto || ancora);
    const estado = { el, ancora, fechar };
    estado.camada = empilharCamada({ tipo: "popover", fechar: () => fechar() });
    popovers.push(estado);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); fechar(); } });
    function fechar(semFoco, porFora) {
      if (!el.isConnected) return;
      el.remove();
      tirarCamada(estado.camada);
      const i = popovers.indexOf(estado);
      if (i >= 0) popovers.splice(i, 1);
      if (o.aoFechar) o.aoFechar(!!porFora);
      if (!semFoco && ancora && ancora.focus && document.contains(ancora)) ancora.focus({ preventScroll: true });
    }
    estado.reposicionar = () => posicionar(el, o.ponto || ancora);
    requestAnimationFrame(() => {
      const alvo = o.foco ? el.querySelector(o.foco) : el.querySelector("input,textarea,button");
      (alvo || el).focus();
    });
    return estado;
  }

  /* Seletor de prazo (popover de 260 px): campo que entende texto, atalhos e mini calendário. */
  function seletorPrazo(ancora, atual, aoEscolher, opts) {
    const o = opts || {};
    const h0 = hoje();
    let mesBase = (atual || h0).slice(0, 7);
    let focoCal = atual || h0;
    const campo = h("input", { type: "text", placeholder: "hoje, amanhã, sex, 24/10, +3", "aria-label": o.rotulo || "Prazo", autocomplete: "off" });
    const previa = h("div", { c: "previa", "aria-live": "polite" });
    const sex = somaDias(h0, (5 - diaSemana(h0) + 7) % 7 || 7);
    const seg = somaDias(h0, (1 - diaSemana(h0) + 7) % 7 || 7);
    const atalhos = h("div", { c: "atalhos-prazo" },
      [["Hoje", h0], ["Amanhã", somaDias(h0, 1)], [`${DSEM[5].replace(/^./, (c) => c.toUpperCase())} ${ddmm(sex)}`, sex], [`${DSEM[1].replace(/^./, (c) => c.toUpperCase())} ${ddmm(seg)}`, seg], ["Sem prazo", ""]]
        .map(([r, v]) => h("button", { type: "button", t: r, on: { click: () => escolher(v) } })));
    const cabCal = h("div", { c: "cal-cab" });
    const cal = h("div", { c: "cal", role: "grid", "aria-label": "Calendário" });
    const conteudo = h("div", { c: "pop-prazo" }, campo, previa, atalhos, cabCal, cal);
    function desenharCal() {
      limpar(cabCal); limpar(cal);
      const [a, m] = mesBase.split("-").map(Number);
      cabCal.append(
        h("button", { type: "button", c: "btn-icone b24", "aria-label": "Mês anterior", on: { click: () => mudarMes(-1) } }, ic("i-chevron-left")),
        h("span", { t: `${MESES[m - 1].replace(/^./, (c) => c.toUpperCase())} de ${a}` }),
        h("button", { type: "button", c: "btn-icone b24", "aria-label": "Próximo mês", on: { click: () => mudarMes(1) } }, ic("i-chevron-right")));
      for (const d of ["D", "S", "T", "Q", "Q", "S", "S"]) cal.append(h("span", { c: "dsem", t: d, "aria-hidden": "true" }));
      const primeiro = `${mesBase}-01`;
      const ini = somaDias(primeiro, -diaSemana(primeiro));
      for (let k = 0; k < 42; k++) {
        const dia = somaDias(ini, k);
        const cls = [dia.slice(0, 7) !== mesBase ? "fora" : "", [0, 6].includes(diaSemana(dia)) ? "fds" : "", dia === h0 ? "hoje" : "", dia === atual ? "sel" : "", dia === focoCal ? "foco-cal" : ""].filter(Boolean).join(" ");
        cal.append(h("button", { type: "button", c: cls, t: String(Number(dia.slice(8))), "aria-label": `${DSEM_LONGO[diaSemana(dia)]}, ${dataLonga(dia)}`, "aria-pressed": dia === atual ? "true" : "false", tabindex: dia === focoCal ? "0" : "-1", d: { dia }, on: { click: () => escolher(dia) } }));
      }
    }
    function mudarMes(delta) {
      const [a, m] = mesBase.split("-").map(Number);
      const d = new Date(Date.UTC(a, m - 1 + delta, 1));
      mesBase = d.toISOString().slice(0, 7);
      focoCal = mesBase + focoCal.slice(7, 10);
      if (!ehData(focoCal) || meioDia(focoCal).toISOString().slice(0, 7) !== mesBase) focoCal = mesBase + "-01";
      desenharCal();
    }
    cal.addEventListener("keydown", (ev) => {
      const passos = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (passos[ev.key]) { ev.preventDefault(); focoCal = somaDias(focoCal, passos[ev.key]); }
      else if (ev.key === "PageUp" || ev.key === "PageDown") { ev.preventDefault(); mudarMes(ev.key === "PageUp" ? -1 : 1); focarCal(); return; }
      else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); escolher(focoCal); return; }
      else return;
      mesBase = focoCal.slice(0, 7);
      desenharCal();
      focarCal();
    });
    function focarCal() { const b = cal.querySelector(`[data-dia="${focoCal}"]`); if (b) b.focus(); }
    campo.addEventListener("input", () => {
      const v = interpretarData(campo.value);
      previa.classList.toggle("erro", !!campo.value.trim() && !v);
      previa.textContent = !campo.value.trim() ? "" : v ? `${DSEM_LONGO[diaSemana(v)]}, ${dataLonga(v)}` : "Não entendi essa data.";
    });
    campo.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const t = campo.value.trim();
        if (!t) return;
        if (/^sem( prazo)?$/i.test(t)) return escolher("");
        const v = interpretarData(t);
        if (v) escolher(v);
      } else if (ev.key === "ArrowDown") { ev.preventDefault(); focarCal(); }
    });
    const pop = popover(ancora, conteudo, { rotulo: o.rotulo || "Escolher prazo", classe: "", aoFechar: o.aoFechar, foco: "input" });
    desenharCal();
    pop.reposicionar();
    function escolher(v) { pop.fechar(); aoEscolher(v); }
    return pop;
  }

  // ------------------------------------------------------------------ confirmação embutida
  /* Aparece logo depois de `depois` (ou dentro de `dentro`). Foco em Cancelar. Devolve Promise<boolean>. */
  function confirmar(o) {
    return new Promise((resolver) => {
      const anterior = document.activeElement;
      const cancelar = h("button", { type: "button", c: "btn btn-28", t: o.rotuloCancelar || "Cancelar" });
      const acao = h("button", { type: "button", c: "btn btn-28 " + (o.destrutiva ? "btn-perigo" : "btn-primario"), t: o.rotuloAcao || "Confirmar" });
      const caixa = h("div", { c: "confirma" + (o.destrutiva ? " destrutiva" : ""), role: "group", "aria-label": "Confirmação" },
        h("div", { c: "confirma-msg" }, ic("i-warning"), h("span", { t: o.mensagem })),
        o.extra || null,   // campo próprio de quem chamou (ex.: observação antes de executar)
        h("div", { c: "confirma-acoes" }, o.acaoPrimeiro === false ? [cancelar, acao] : [acao, cancelar]));
      if (o.dentro) { if (o.substituir) limpar(o.dentro); o.dentro.append(caixa); }
      else if (o.depois && o.depois.parentNode) o.depois.after(caixa);
      else document.body.append(caixa);
      anunciar(o.mensagem, true);
      const camada = empilharCamada({ tipo: "confirma", fechar: () => fim(false) });
      /* Se quem desenhou a caixa redesenhar a tela por baixo dela, a caixa sai do DOM. Sem este
         vigia a promessa nunca se resolvia, a camada do Esc ficava órfã e quem esperava travava. */
      const vigia = new MutationObserver(() => { if (!caixa.isConnected) fim(false); });
      let resolvido = false;
      function fim(v) {
        if (resolvido) return;
        resolvido = true;
        vigia.disconnect();
        if (caixa.isConnected) caixa.remove();
        tirarCamada(camada);
        if (!v) { const alvo = o.foco || anterior; if (alvo && alvo.focus && document.contains(alvo)) alvo.focus({ preventScroll: true }); }
        resolver(v);
      }
      if (caixa.parentNode) vigia.observe(caixa.parentNode, { childList: true });
      cancelar.addEventListener("click", () => fim(false));
      acao.addEventListener("click", () => fim(true));
      caixa.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); fim(false); }
        else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && o.extra) { ev.preventDefault(); fim(true); }
      });
      requestAnimationFrame(() => {
        const campo = o.extra && o.extra.querySelector && o.extra.querySelector("textarea,input");
        (campo || cancelar).focus();
      });
    });
  }

  // ------------------------------------------------------------------ tooltip
  let tipTimer = 0, tipAlvo = null;
  function mostrarTip(alvo) {
    const tip = document.getElementById("tooltip");
    let texto = alvo.getAttribute("data-tip");
    if (!texto && alvo.hasAttribute("data-tip-auto")) {
      if (alvo.scrollWidth <= alvo.clientWidth + 1 && alvo.scrollHeight <= alvo.clientHeight + 1) return;
      texto = alvo.getAttribute("data-tip-auto") || alvo.textContent;
    }
    if (!texto || document.body.classList.contains("arrastando")) return;
    tip.textContent = texto;
    tip.hidden = false;
    const r = alvo.getBoundingClientRect(), w = tip.offsetWidth, hh = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.bottom + 6;
    if (alvo.closest(".nav")) { x = r.right + 8; y = r.top + r.height / 2 - hh / 2; }
    if (y + hh > innerHeight - 4) y = r.top - hh - 6;
    tip.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + "px";
    tip.style.top = Math.max(4, y) + "px";
  }
  function esconderTip() { clearTimeout(tipTimer); tipAlvo = null; const t = document.getElementById("tooltip"); if (t) t.hidden = true; }
  document.addEventListener("pointerover", (ev) => {
    const alvo = ev.target.closest && ev.target.closest("[data-tip],[data-tip-auto]");
    if (alvo === tipAlvo) return;
    esconderTip();
    if (!alvo || ev.pointerType === "touch") return;
    tipAlvo = alvo;
    tipTimer = setTimeout(() => mostrarTip(alvo), alvo.hasAttribute("data-tip-auto") ? 600 : 500);
  });
  document.addEventListener("pointerdown", esconderTip, true);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") esconderTip(); }, true);
  document.addEventListener("focusin", (ev) => {
    const alvo = ev.target.closest && ev.target.closest("[data-tip]");
    esconderTip();
    if (alvo && alvo.matches(":focus-visible")) { tipAlvo = alvo; tipTimer = setTimeout(() => mostrarTip(alvo), 500); }
  });
  document.addEventListener("focusout", esconderTip);

  // ------------------------------------------------------------------ saúde do servidor
  const ESPERAS = [2, 5, 10, 30];
  let tentativa = 0, timerStatus = 0, timerContagem = 0, proximaEm = 0, falhasStatus = 0, dadosDe = 0;
  function definirServidor(v) {
    if (E.servidor === v) return;
    const antes = E.servidor;
    E.servidor = v;
    document.body.classList.toggle("leitura", v === "fora");
    Mesa.emitir("servidor", { antes, agora: v });
    if (v === "lento") anunciar("Servidor lento.");
  }
  function caiu() {
    if (E.servidor === "fora") return;
    dadosDe = E.ultimaSync;
    tentativa = 0;
    definirServidor("fora");
    anunciar("Servidor local fora do ar. Edição bloqueada até ele voltar.", true);
    agendarStatus();
    renderBanner();
  }
  function voltou() {
    if (E.servidor !== "fora") return;
    definirServidor("ok");
    falhasStatus = 0; falhasCarga = 0;
    anunciar("Conectado de novo.");
    renderBanner(true);
    recarregar();
    agendarStatus();
  }
  async function verificarStatus() {
    clearTimeout(timerStatus);
    try {
      const s = await api("GET", "/api/status", null, { tempo: 3000, semMedir: true });
      falhasStatus = 0;
      E.status = s;
      E.recursos = s.recursos || {};
      E.assistenteOk = !!s.assistente;
      if (s.indice) E.indice = s.indice;
      if (E.servidor === "fora") voltou();
      else if (E.servidor === "verificando") definirServidor("ok");
      if (s.versao != null && s.versao !== E.versao && E.carregado) recarregar();
      Mesa.emitir("status", s);
    } catch (e) {
      falhasStatus++;
      if (falhasStatus >= 2 || E.servidor === "fora") caiu();
    }
    agendarStatus();
  }
  function agendarStatus() {
    clearTimeout(timerStatus);
    clearInterval(timerContagem);
    let seg;
    if (E.servidor === "fora") {
      seg = ESPERAS[Math.min(tentativa, ESPERAS.length - 1)];
      tentativa++;
      proximaEm = Date.now() + seg * 1000;
      timerContagem = setInterval(atualizarContagem, 1000);
      atualizarContagem();
    } else seg = document.hidden ? 30 : 15;
    timerStatus = setTimeout(verificarStatus, seg * 1000);
  }
  function atualizarContagem() {
    const e = document.getElementById("banner-tentativa");
    if (!e) return;
    const s = Math.max(0, Math.ceil((proximaEm - Date.now()) / 1000));
    e.textContent = s > 0 ? `Nova tentativa em ${s} s` : "Tentando…";
  }
  function servidorFalhou() { verificarStatus(); }
  function renderBanner(voltouAgora) {
    const b = document.getElementById("banner");
    if (!b) return;
    limpar(b);
    if (voltouAgora) {
      b.hidden = false;
      b.append(h("div", { c: "banner-caixa ok" }, ic("i-plug"), h("span", { c: "banner-texto", t: "Conectado de novo." })));
      setTimeout(() => { if (E.servidor !== "fora") { b.hidden = true; limpar(b); Mesa.emitir("layout"); } }, 3000);
      Mesa.emitir("layout");
      return;
    }
    if (E.servidor !== "fora") { b.hidden = true; Mesa.emitir("layout"); return; }
    b.hidden = false;
    const desde = dadosDe ? fmtHora.format(new Date(dadosDe)) : "";
    const extra = h("div", { c: "banner-extra", hidden: true },
      h("span", { t: `Rode iniciar-mesa.cmd em ${RAIZ_MESA}` }),
      h("button", { type: "button", c: "btn btn-24", t: "Copiar caminho", on: { click: () => copiar(RAIZ_MESA, "Caminho copiado.") } }));
    b.append(h("div", { c: "banner-caixa" }, ic("i-plug-off"),
      h("span", { c: "banner-texto" }, h("b", { t: "Servidor local fora do ar." }), desde ? ` Mostrando os dados de ${desde}; edição bloqueada até ele voltar.` : " Edição bloqueada até ele voltar."),
      h("span", { c: "banner-tentativa", id: "banner-tentativa" }),
      h("button", { type: "button", c: "btn btn-24", t: "Tentar agora", on: { click: () => verificarStatus() } }),
      h("button", { type: "button", c: "btn btn-24 btn-sutil", t: "Como iniciar", "aria-expanded": "false", on: { click: (ev) => { extra.hidden = !extra.hidden; ev.currentTarget.setAttribute("aria-expanded", String(!extra.hidden)); } } })), extra);
    atualizarContagem();
    Mesa.emitir("layout");
  }

  // ------------------------------------------------------------------ dia (recalcula rótulos à meia-noite)
  function vigiarDia() {
    const novo = hojeISO();
    if (novo !== E.hoje) { E.hoje = novo; Mesa.emitir("dia"); }
  }
  function agendarMeiaNoite() {
    const agora = new Date();
    const segBRT = ((agora.getUTCHours() + 21) % 24) * 3600 + agora.getUTCMinutes() * 60 + agora.getUTCSeconds();
    setTimeout(() => { vigiarDia(); agendarMeiaNoite(); }, (86400 - segBRT) * 1000 + 5000);
  }
  E.hoje = hojeISO();

  // ------------------------------------------------------------------ TEAMS
  /* O esqueleto nasce aqui para quem carrega sem o teams.js (o painel v1, por exemplo);
     teams.js troca `iniciar`, `atualizar`, `parar` e `painel` por valer quando o servidor
     oferece o recurso "teams" em /api/status. O feed ao vivo (novidades e sugestões vindas
     do Teams sem clique) continua sem servidor: a barra de status (app.js) e o Resumo de hoje
     (gaveta.js) só desenham algo quando "teams" chega com novidades. */
  Mesa.teams = {
    disponivel: () => !!(E.recursos && E.recursos.teams),
    iniciar() { /* teams.js */ },
    atualizar() { /* teams.js */ },
    parar() { /* teams.js */ },
    painel() { /* teams.js */ },
    emCurso: () => null,
    novidades: [],
    sugestoes: [],
  };

  // ------------------------------------------------------------------ exporta
  Mesa.n = {
    FUSO, RAIZ_MESA, COLUNAS, STATUS_NOME, STATUS_ICONE, STATUS_COR, PRIORIDADES, PRIO, PRIO_PESO, AREAS, AREA, AREA_PADRAO, ORIGEM_ATOR,
    lerPref, gravarPref, $, $$, h, ic, spinner, limpar, anexar, ehCampo, movReduzido,
    norm, marcar, trechoMarcado, slug, plural, fmtNum, fmtUSD,
    hojeISO, hoje, ehData, isoDeTs, meioDia, somaDias, diasEntre, diaSemana, ddmm, dataCurta, dataLonga, dataComSemana,
    horaDeTs, relativo, relativoDia, diaTitulo, duracao, cronometro, fimDaSemana, inicioDaSemana, interpretarData, DSEM, DSEM_LONGO, MESES,
    statusDesde, concluidaEm, diaConcluida, diasParada, fechada, atrasada, venceHoje, cobrancaInfo, cobrancaVencida, pessoasDe, nomeCurto, num, ref, areaDe,
    ligacoesN, estadoAgente, entregasNaoVistas, marcarVista, vistas, prazoInfo, chipCartao, descricaoAcessivel,
    quadrado, iconeStatus, iconePrio, avatar, chip, kbd, anunciar,
    api, rotaItem, aplicarDados, recarregar, carregarProjetos, nomeProjeto,
    definirSync, podeEscrever, semConexao, mensagemErro, marcarSalvando,
    registrarAcao, criarAcao, desfazerMudanca, executarDesfazer, desfazerUltimo, refazerUltimo,
    mudar, moverVarias, criar, copiar, copiarRico, abrirCaminho, caminhoEntrega, urlEntrega,
    toast, removerToast, menu, fecharMenus, popover, seletorPrazo, confirmar, posicionar,
    empilharCamada, tirarCamada, fecharTopo, temCamada,
    verificarStatus, agendarStatus, servidorFalhou, definirServidor, renderBanner, vigiarDia, agendarMeiaNoite,
  };
})();
