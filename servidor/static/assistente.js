/* Escriba: paleta de comandos (Ctrl+K) e assistente.
   Busca local instantânea (pendências, comandos, pessoas, áreas, projetos) com prefixos > # @ + ?, e o
   pedido ao assistente (POST /api/assistente, 15 a 35 s) com espera honesta: cronômetro real, sem fases
   inventadas, Esc continua em segundo plano. O resultado lista cada mudança com Desfazer. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, $$, limpar } = n;
  const P = (Mesa.paleta = {});

  const VERBOS = ["ja fiz", "fiz", "terminei", "fecha", "conclui", "mandei", "respondi", "enviei", "muda", "move", "passa", "adia", "cria", "anota", "marca", "tira", "poe", "coloca", "descarta"];
  const SUGESTOES = ["o que vence hoje?", "o que falta pra Ana?", "já fiz a #3", "move tudo do Bruno pra aguardando"];
  let fundo, caixa, campo, corpo, chipEl, linhaAssist, rodape, barra, roEl;
  let aberta = false, chipId = null, vista = "lista", itens = [], ativo = -1, expandir = new Set(), focoAnterior = null, camada = null, histIdx = -1;
  let pedido = null; // {texto, inicio, estado: esperando|pronto|erro, r, erro, duracao, desfeitas:Set}
  let turnos = [];
  let timerEspera = 0;
  const anteriores = [];

  // ------------------------------------------------------------------ pontuação da busca local
  function pontuar(texto, termo) {
    const t = n.norm(texto), q = n.norm(termo).trim();
    if (!q) return 0;
    if (t.split(/[^a-z0-9#]+/).some((w) => w.startsWith(q))) return 1;
    if (t.includes(q)) return 0.8;
    let k = 0, lacunas = 0, ult = -1;
    for (const c of q) {
      const p = t.indexOf(c, ult + 1);
      if (p < 0) return 0;
      if (ult >= 0 && p > ult + 1) lacunas++;
      ult = p; k++;
    }
    return lacunas <= 3 ? 0.6 : 0;
  }
  function negrito(texto, termo) {
    const frag = document.createDocumentFragment();
    const q = n.norm(termo).trim();
    const t = String(texto);
    if (!q) { frag.append(t); return frag; }
    const idx = n.norm(t).indexOf(q);
    if (idx < 0) { frag.append(t); return frag; }
    frag.append(t.slice(0, idx), h("b", { t: t.slice(idx, idx + q.length) }), t.slice(idx + q.length));
    return frag;
  }

  // ------------------------------------------------------------------ comandos
  function comandos() {
    const Q = Mesa.quadro, focoId = chipId;
    const lista = [
      { rotulo: "Nova pendência", icone: "i-plus", kbd: ["N"], acao: () => Q.abrirCompositor() },
      { rotulo: "Ir para Quadro", icone: "i-board", kbd: ["G", "Q"], acao: () => irPara("#/quadro") },
      { rotulo: "Ir para Lista", icone: "i-list", kbd: ["G", "L"], acao: () => { irPara("#/lista"); } },
      { rotulo: "Ir para Projetos", icone: "i-projects", kbd: ["G", "P"], acao: () => irPara("#/projetos") },
      { rotulo: "Ir para Arquivo", icone: "i-archive", kbd: ["G", "A"], acao: () => irPara("#/arquivo") },
      { rotulo: "Ir para Configurações", icone: "i-settings", kbd: ["G", "C"], acao: () => irPara("#/config") },
      { rotulo: "Visão Hoje", icone: "i-calendar-today", kbd: ["G", "H"], acao: () => Q.definirVisao("hoje") },
      { rotulo: "Visão Esta semana", icone: "i-calendar", kbd: ["G", "S"], acao: () => Q.definirVisao("semana") },
      { rotulo: "Visão Tudo", icone: "i-board", kbd: ["G", "T"], acao: () => Q.definirVisao("tudo") },
      { rotulo: "Resumo de hoje", icone: "i-calendar-today", kbd: ["]"], acao: () => Mesa.gaveta.resumo() },
      { rotulo: E.raias ? "Desligar raias" : "Ligar raias por área", icone: "i-lanes", kbd: ["R"], acao: () => Q.definirRaias(E.raias ? "" : "area") },
      { rotulo: "Ligar raias por projeto", icone: "i-lanes", acao: () => Q.definirRaias("projeto") },
      { rotulo: E.densidade === "compacta" ? "Densidade confortável" : "Densidade compacta", icone: "i-density", kbd: ["Shift", "D"], acao: () => Q.alternarDensidade() },
      { rotulo: "Tema: Sistema", icone: "i-theme", acao: () => window.mesaTema("sistema") },
      { rotulo: "Tema: Claro", icone: "i-theme", acao: () => window.mesaTema("claro") },
      { rotulo: "Tema: Escuro", icone: "i-theme", acao: () => window.mesaTema("escuro") },
      { rotulo: "Limpar filtros", icone: "i-filter-clear", kbd: ["Shift", "F"], acao: () => Q.limparFiltros() },
      { rotulo: "Só atrasadas", icone: "i-clock-filled", kbd: ["A"], acao: () => Q.soSinal("atrasadas") },
      { rotulo: "Só aguardando", icone: "i-status-waiting", acao: () => Q.soSinal("aguardando") },
      { rotulo: "Reindexar o cérebro", icone: "i-refresh", acao: () => Mesa.paginas.reindexar() },
      { rotulo: "Exportar CSV", icone: "i-copy", acao: () => Q.exportarCSV() },
      { rotulo: "Mostrar atalhos", icone: "i-keyboard", kbd: ["?"], acao: () => Mesa.app.atalhos() },
    ];
    const item = focoId && E.porId.get(focoId);
    if (item) {
      const r = n.ref(focoId);
      const agOk = E.recursos.agente;
      lista.unshift(
        { rotulo: `Abrir ${r}`, icone: "i-open", kbd: ["Enter"], acao: () => Mesa.gaveta.abrir(focoId, { via: "push", focarTitulo: true }) },
        { rotulo: `Concluir ${r}`, icone: "i-status-done", kbd: ["Shift", "4"], acao: () => Q.concluir(focoId) },
        ...n.COLUNAS.slice(0, 3).map((c, k) => ({ rotulo: `Mover ${r} para ${c.nome}`, icone: c.icone, kbd: ["Shift", String(k + 1)], acao: () => Q.moverPara([focoId], c.status) })),
        ...n.PRIORIDADES.map((p) => ({ rotulo: `Prioridade de ${r}: ${p.nome}`, icone: p.icone, acao: () => n.mudar(focoId, { prioridade: p.v }, { toast: `${r}: prioridade ${p.nome}.` }).catch(() => {}) })),
        { rotulo: `Prazo de ${r}…`, icone: "i-calendar", kbd: ["D"], acao: () => { Mesa.gaveta.abrir(focoId, { via: "push" }); requestAnimationFrame(() => { const b = $('#gaveta [data-campo="prazo"]'); if (b) b.click(); }); } },
        { rotulo: `Pedido por de ${r}…`, icone: "i-person", kbd: ["Q"], acao: () => Mesa.gaveta.abrir(focoId, { via: "push", acao: "pessoa" }) },
        { rotulo: `Projeto de ${r}…`, icone: "i-projects", acao: () => Mesa.gaveta.abrir(focoId, { via: "push", acao: "projeto" }) },
        { rotulo: `Preparar briefing de ${r}`, icone: "i-briefing", kbd: ["B"], desabilitado: !agOk, acao: () => Mesa.gaveta.abrir(focoId, { via: "push", aba: "agente", acao: "foco-briefing" }) },
        { rotulo: `Executar tarefa de ${r}`, icone: "i-run", kbd: ["Shift", "E"], desabilitado: !agOk, acao: () => Mesa.gaveta.abrir(focoId, { via: "push", aba: "agente", acao: "executar" }) },
        { rotulo: `Copiar link de ${r}`, icone: "i-link", acao: () => Q.copiarLink(focoId) },
        { rotulo: `Descartar ${r}`, icone: "i-discard", kbd: ["Delete"], acao: () => Q.descartar([focoId]) });
    }
    return lista;
  }
  function irPara(hash) { location.hash = hash; }

  // ------------------------------------------------------------------ resultados locais
  function buscar(texto) {
    const grupos = [];
    let t = texto.trim();
    let prefixo = "";
    if (/^[>#@+?]/.test(t)) { prefixo = t[0]; t = t.slice(1).trim(); }
    if (prefixo === "?") return { grupos, prefixo, termo: t };
    const sem = !prefixo;
    if (sem || prefixo === "#") {
      const pend = [];
      for (const i of E.itens) {
        if (i.status === "descartada") continue;
        const numero = "#" + n.num(i.id);
        let s = 0;
        if (prefixo === "#" && /^\d+$/.test(t)) s = String(n.num(i.id)) === t ? 1 : String(n.num(i.id)).startsWith(t) ? 0.7 : 0;
        else if (t === numero) s = 1;
        else s = Math.max(pontuar(i.titulo, t), pontuar(i.pessoa, t) * 0.95, pontuar(n.areaDe(i).nome, t) * 0.7);
        if (!t && prefixo === "#") s = 0.5;
        if (s >= 0.6 || (prefixo === "#" && s > 0)) pend.push({ tipo: "pendencia", s, i });
      }
      pend.sort((a, b) => b.s - a.s || (n.fechada(a.i) - n.fechada(b.i)) || n.num(a.i.id) - n.num(b.i.id));
      if (pend.length) grupos.push({ nome: "Pendências", itens: pend });
    }
    if (sem || prefixo === ">") {
      const cmds = comandos().map((c) => ({ tipo: "comando", s: t ? pontuar(c.rotulo, t) : 0.5, c })).filter((x) => x.s >= 0.6 || (prefixo === ">" && !t));
      cmds.sort((a, b) => b.s - a.s);
      if (cmds.length) grupos.push({ nome: "Comandos", itens: cmds });
    }
    if ((sem && t.length >= 2) || prefixo === "@") {
      const ps = Mesa.quadro.pessoasDaBase().map((p) => ({ tipo: "pessoa", s: t ? pontuar(p, t) : 0.5, p })).filter((x) => x.s >= 0.6 || (prefixo === "@" && !t));
      ps.sort((a, b) => b.s - a.s || a.p.localeCompare(b.p, "pt-BR"));
      if (ps.length) grupos.push({ nome: "Pessoas", itens: ps });
    }
    if ((sem && t.length >= 2) || prefixo === "+") {
      const ar = n.AREAS.map((a) => ({ tipo: "area", s: t ? Math.max(pontuar(a.nome, t), a.apelidos.includes(n.norm(t)) ? 1 : 0) : 0.5, a })).filter((x) => x.s >= 0.6 || (prefixo === "+" && !t));
      ar.sort((a, b) => b.s - a.s);
      if (ar.length) grupos.push({ nome: "Áreas", itens: ar });
      const pr = E.projetos.map((p) => ({ tipo: "projeto", s: t ? Math.max(pontuar(p.nome, t), (p.palavras_chave || []).some((k) => n.norm(k) === n.norm(t)) ? 0.9 : 0) : 0.4, p })).filter((x) => x.s >= 0.6 || (prefixo === "+" && !t));
      pr.sort((a, b) => b.s - a.s || String(a.p.nome).localeCompare(String(b.p.nome), "pt-BR"));
      if (pr.length) grupos.push({ nome: "Projetos", itens: pr });
    }
    return { grupos, prefixo, termo: t };
  }
  function assistentePadrao(texto) {
    const t = n.norm(texto).trim();
    if (!t) return false;
    if (t.split(/\s+/).length >= 3 || t.endsWith("?")) return true;
    return VERBOS.some((v) => t === v || t.startsWith(v + " "));
  }

  // ------------------------------------------------------------------ montar e abrir
  function montar() {
    fundo = $("#paleta-fundo");
    caixa = $("#paleta");
    limpar(caixa);
    barra = h("div", { c: "barra-indet", hidden: true, "aria-hidden": "true" });
    chipEl = h("span", { c: "pal-chip", hidden: true });
    campo = h("input", { type: "text", role: "combobox", "aria-expanded": "true", "aria-controls": "pal-lista", "aria-autocomplete": "list", "aria-label": "Digite um comando ou peça algo", placeholder: "Digite um comando ou peça algo", autocomplete: "off", spellcheck: "false" });
    roEl = h("span", { c: "pal-ro", hidden: true, t: "só leitura" });
    corpo = h("div", { c: "pal-corpo", id: "pal-lista", role: "listbox", "aria-label": "Resultados" });
    linhaAssist = h("button", { type: "button", c: "pal-assist", id: "pal-assist", role: "option", tabindex: "-1" });
    rodape = h("div", { c: "pal-rodape", hidden: true });
    caixa.append(barra, h("div", { c: "pal-campo" }, ic("i-prompt"), chipEl, campo, roEl, h("kbd", { t: "Esc" })), corpo, linhaAssist, rodape);
    campo.addEventListener("input", () => {
      histIdx = -1;
      if (vista === "pedido" && pedido && pedido.estado !== "esperando") vista = "lista";
      desenhar();
    });
    campo.addEventListener("keydown", teclado);
    linhaAssist.addEventListener("click", () => enviar(campo.value));
    fundo.addEventListener("pointerdown", (ev) => { if (ev.target === fundo) P.fechar(); });
    caixa.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault(); ev.stopPropagation();
        if (n.temCamada("confirma")) return;
        P.fechar();
      } else if (ev.key === "Tab") {
        const focaveis = $$("button:not([disabled]),input,[tabindex='0']", caixa).filter((x) => x.offsetParent);
        if (!focaveis.length) return;
        const pri = focaveis[0], ult = focaveis[focaveis.length - 1];
        if (ev.shiftKey && document.activeElement === pri) { ev.preventDefault(); ult.focus(); }
        else if (!ev.shiftKey && document.activeElement === ult) { ev.preventDefault(); pri.focus(); }
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && document.activeElement !== campo) { ev.preventDefault(); enviar(campo.value); }
    });
  }
  P.aberta = () => aberta;
  P.abrir = (opts) => {
    const o = opts || {};
    if (!caixa) montar();
    if (aberta) { campo.focus(); return; }
    focoAnterior = document.activeElement;
    n.fecharMenus();
    aberta = true;
    fundo.hidden = false;
    chipId = o.semChip ? null : (E.abertaId || (focoAnterior && focoAnterior.closest && focoAnterior.closest("[data-id]") ? focoAnterior.closest("[data-id]").dataset.id : null));
    if (o.vista) vista = o.vista;
    else vista = pedido && pedido.estado !== "esperando" && pedido.novo ? "pedido" : "lista";
    if (o.texto != null) campo.value = o.texto;
    else if (vista === "lista") campo.value = "";
    camada = n.empilharCamada({ tipo: "paleta", fechar: () => P.fechar() });
    desenhar();
    requestAnimationFrame(() => { campo.focus(); campo.select(); });
    Mesa.emitir("assistente");
  };
  P.fechar = () => {
    if (!aberta) return;
    aberta = false;
    fundo.hidden = true;
    n.tirarCamada(camada);
    camada = null;
    if (pedido && pedido.estado !== "esperando") pedido.novo = false;
    if (focoAnterior && document.contains(focoAnterior)) focoAnterior.focus({ preventScroll: true });
    Mesa.emitir("assistente");
  };
  P.alternar = () => (aberta ? P.fechar() : P.abrir());
  P.pedidoEmCurso = () => (pedido && pedido.estado === "esperando" ? pedido : null);
  P.verPedido = () => P.abrir({ vista: "pedido", texto: pedido ? pedido.texto : "" });

  // ------------------------------------------------------------------ desenho
  function desenhar() {
    const esperando = pedido && pedido.estado === "esperando";
    const mostraPedido = vista === "pedido" && pedido;
    barra.hidden = !(esperando && mostraPedido);
    campo.readOnly = !!(esperando && mostraPedido);
    roEl.hidden = !(esperando && mostraPedido);
    if (chipId && E.porId.has(chipId)) {
      chipEl.hidden = false;
      limpar(chipEl).append(n.ref(chipId), h("button", { type: "button", "aria-label": "Remover pendência do contexto", on: { click: () => { chipId = null; desenhar(); campo.focus(); } } }, ic("i-dismiss-12")));
    } else { chipEl.hidden = true; chipId = null; }
    limpar(corpo);
    rodape.hidden = true;
    if (mostraPedido) { linhaAssist.hidden = true; desenharPedido(); return; }
    desenharLista();
  }
  function desenharLista() {
    const texto = campo.value;
    itens = [];
    if (pedido && pedido.estado === "esperando") {
      corpo.append(h("div", { c: "pal-faixa" }, n.spinner(true), h("span", { c: "t", t: pedido.texto }), h("span", { c: "num", d: { seg: "1" }, t: segundos() + " s" }),
        h("button", { type: "button", c: "btn btn-24", t: "Ver", on: { click: () => { vista = "pedido"; campo.value = pedido.texto; desenhar(); } } })));
    }
    if (anteriores.length && turnos.length) corpo.append(desenharAnteriores());
    if (!texto.trim()) {
      const rec = n.lerPref("mesa.pedidos.recentes", []).slice(0, 5);
      if (rec.length) {
        corpo.append(h("div", { c: "pal-grupo-tit", role: "presentation", t: "Recentes" }));
        for (const r of rec) addItem({ tipo: "recente", r, rotulo: r.texto, sec: `${r.mudancas} ${n.plural(r.mudancas, "mudança", "mudanças")} · ${n.relativo(r.em)}`, icone: "i-history" });
      }
      corpo.append(h("div", { c: "pal-grupo-tit", role: "presentation", t: "Sugestões" }));
      corpo.append(h("div", { c: "pal-sugestoes" }, SUGESTOES.map((s) => h("button", { type: "button", t: s, on: { click: () => { campo.value = s; desenhar(); campo.focus(); } } }))));
    } else {
      const { grupos, prefixo } = buscar(texto);
      for (const g of grupos) {
        corpo.append(h("div", { c: "pal-grupo-tit", role: "presentation", t: g.nome }));
        const lim = expandir.has(g.nome) ? g.itens.length : 5;
        for (const x of g.itens.slice(0, lim)) addItem(x);
        if (g.itens.length > lim) addItem({ tipo: "vertodas", g: g.nome, rotulo: `Ver todas (${g.itens.length})`, icone: "i-chevron-down" });
      }
      if (!grupos.length && prefixo !== "?") corpo.append(h("p", { c: "pal-vazio", t: `Nada com "${texto.trim()}". Pergunte ao assistente com Ctrl+Enter.` }));
    }
    desenharLinhaAssistente(texto);
    const prefAssist = /^\?/.test(texto.trim()) || assistentePadrao(texto.replace(/^[>#@+?]/, ""));
    const primeiro = itens.findIndex((x) => x.s >= 0.6 || x.tipo === "recente");
    ativo = texto.trim() ? (prefAssist || primeiro < 0 ? itens.length : primeiro) : (itens.length ? 0 : itens.length);
    if (/^[>#@+]/.test(texto.trim()) && itens.length) ativo = 0;
    marcarAtivo();
  }
  function addItem(x) {
    const k = itens.length;
    const b = h("button", { type: "button", c: "pal-item", role: "option", id: "pal-it-" + k, tabindex: "-1", "aria-selected": "false" });
    const termo = buscar(campo.value).termo;
    if (x.tipo === "pendencia") {
      const i = x.i;
      const ps = n.pessoasDe(i);
      b.append(n.iconeStatus(i.status), h("span", { c: "card-num", t: n.ref(i.id) }), h("span", { c: "t" }, negrito(i.titulo, termo)), h("span", { c: "s", t: [ps[0] ? n.nomeCurto(ps[0]) : "", n.areaDe(i).curto].filter(Boolean).join(" · ") }));
    } else if (x.tipo === "comando") {
      b.append(ic(x.c.icone || "i-chevron-right"), h("span", { c: "t" }, negrito(x.c.rotulo, termo)), x.c.kbd ? n.kbd(...x.c.kbd) : null);
      if (x.c.desabilitado) { b.setAttribute("aria-disabled", "true"); b.setAttribute("data-tip", "O agente ainda não está ligado neste servidor."); }
    } else if (x.tipo === "pessoa") b.append(n.avatar(n.nomeCurto(x.p), true), h("span", { c: "t" }, negrito(x.p, termo)), h("span", { c: "s", t: "Filtrar o quadro" }));
    else if (x.tipo === "area") b.append(n.quadrado(x.a), h("span", { c: "t" }, negrito(x.a.nome, termo)), h("span", { c: "s", t: "Filtrar o quadro" }));
    else if (x.tipo === "projeto") b.append(ic("i-projects"), h("span", { c: "t" }, negrito(x.p.nome, termo)), h("span", { c: "s", t: n.AREA[x.p.area] ? n.AREA[x.p.area].curto : "" }));
    else b.append(ic(x.icone || "i-chevron-right"), h("span", { c: "t", t: x.rotulo }), x.sec ? h("span", { c: "s", t: x.sec }) : null);
    b.addEventListener("click", () => executar(x));
    b.addEventListener("pointermove", () => { if (ativo !== k) { ativo = k; marcarAtivo(); } });
    x.el = b;
    itens.push(x);
    corpo.append(b);
  }
  function desenharLinhaAssistente(texto) {
    linhaAssist.hidden = false;
    limpar(linhaAssist);
    const t = texto.replace(/^\?\s*/, "").trim();
    const indisponivel = !E.assistenteOk ? "Assistente indisponível: Claude Code CLI não encontrado nesta máquina." : !n.podeEscrever() ? "Assistente indisponível sem servidor." : "";
    const ocupado = pedido && pedido.estado === "esperando";
    linhaAssist.setAttribute("aria-disabled", indisponivel || ocupado ? "true" : "false");
    if (indisponivel) { linhaAssist.append(ic("i-prompt"), h("span", { c: "q", t: indisponivel })); return; }
    if (ocupado && t) { linhaAssist.append(ic("i-prompt"), h("span", { c: "r", t: "Perguntar ao assistente:" }), h("span", { c: "q", t: "Espere o pedido anterior terminar." })); return; }
    linhaAssist.append(ic("i-prompt"), h("span", { c: "r", t: "Perguntar ao assistente:" }), h("span", { c: "q", t: t ? `“${t}”` : "escreva o pedido" }), n.kbd("Ctrl", "Enter"));
  }
  function marcarAtivo() {
    itens.forEach((x, k) => x.el.setAttribute("aria-selected", String(k === ativo)));
    linhaAssist.setAttribute("aria-selected", String(ativo === itens.length));
    const el = ativo === itens.length ? linhaAssist : itens[ativo] && itens[ativo].el;
    campo.setAttribute("aria-activedescendant", el ? el.id : "");
    if (el && el !== linhaAssist) el.scrollIntoView({ block: "nearest" });
  }
  function desenharAnteriores() {
    const box = h("div", { c: "pal-anteriores" });
    for (const a of anteriores.slice(-3)) box.append(h("div", { c: "turno", t: `› ${a.texto} — ${a.resposta}` }));
    return box;
  }

  // ------------------------------------------------------------------ teclado
  function teclado(ev) {
    const esperando = pedido && pedido.estado === "esperando" && vista === "pedido";
    if (ev.key === "Escape") return; // tratado na caixa
    if (esperando) { if (ev.key === "Enter") ev.preventDefault(); return; }
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(campo.value); return; }
    if (vista === "pedido") {
      if (ev.key === "ArrowDown") { ev.preventDefault(); const m = corpo.querySelector(".pal-mud"); if (m) m.focus(); }
      return;
    }
    const total = itens.length + 1;
    if (ev.key === "ArrowDown") { ev.preventDefault(); ativo = (ativo + 1) % total; marcarAtivo(); }
    else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!campo.value.trim() || histIdx >= 0) {
        const rec = n.lerPref("mesa.pedidos.recentes", []);
        if (rec.length) { histIdx = Math.min(rec.length - 1, histIdx + 1); campo.value = rec[histIdx].texto; const k = histIdx; desenhar(); histIdx = k; ativo = itens.length; marcarAtivo(); return; }
      }
      ativo = (ativo - 1 + total) % total; marcarAtivo();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (ativo >= 0 && ativo < itens.length) executar(itens[ativo]);
      else enviar(campo.value);
    } else if (ev.key === "Backspace" && !campo.value && chipId) { ev.preventDefault(); chipId = null; desenhar(); }
  }
  function executar(x) {
    if (x.tipo === "vertodas") { expandir.add(x.g); desenhar(); return; }
    if (x.tipo === "recente") { enviar(x.r.texto); return; }
    if (x.tipo === "comando" && x.c.desabilitado) return;
    P.fechar();
    if (x.tipo === "pendencia") { if (E.pagina !== "quadro" && E.pagina !== "lista") location.hash = "#/quadro"; Mesa.gaveta.abrir(x.i.id, { via: "push", focarTitulo: true }); Mesa.quadro.focar(x.i.id); }
    else if (x.tipo === "comando") x.c.acao();
    else if (x.tipo === "pessoa") { location.hash = "#/" + E.modo; Mesa.quadro.filtrarPessoa(x.p); }
    else if (x.tipo === "area") { location.hash = "#/" + E.modo; Mesa.quadro.filtrarArea(x.a.nome); }
    else if (x.tipo === "projeto") location.hash = "#/projetos/" + encodeURIComponent(x.p.id);
  }

  // ------------------------------------------------------------------ pedido ao assistente
  function segundos() { return pedido ? Math.floor((Date.now() - pedido.inicio) / 1000) : 0; }
  /* "#3" vira referência explícita ao id, porque o servidor só conhece os ids. */
  function comReferencias(texto) {
    const refs = [];
    texto.replace(/#(\d{1,4})\b/g, (m, d) => { const id = E.porNumero.get(Number(d)); if (id && !refs.some((r) => r.id === id)) refs.push({ n: d, id }); return m; });
    if (!refs.length) return texto;
    return `${texto}\n\n(Referências do painel: ${refs.map((r) => `#${r.n} = id ${r.id}`).join("; ")})`;
  }
  async function enviar(bruto) {
    const texto = String(bruto || "").replace(/^\?\s*/, "").trim();
    if (!texto) { campo.focus(); return; }
    if (!E.assistenteOk) { n.toast({ texto: "Assistente indisponível: Claude Code CLI não encontrado nesta máquina.", tipo: "erro", duracao: 5000 }); return; }
    if (!n.podeEscrever()) { n.toast({ texto: "Assistente indisponível sem servidor.", tipo: "erro", duracao: 5000 }); return; }
    if (pedido && pedido.estado === "esperando") { desenharLinhaAssistente(campo.value); n.anunciar("Espere o pedido anterior terminar.", true); return; }
    if (pedido && pedido.estado === "pronto" && pedido.r) anteriores.push({ texto: pedido.texto, resposta: pedido.r.resposta });
    const foco = chipId || E.abertaId || "";
    pedido = { texto, inicio: Date.now(), estado: "esperando", foco, desfeitas: new Set(), novo: true };
    vista = "pedido";
    campo.value = texto;
    if (aberta) desenhar();
    n.anunciar("Assistente trabalhando.");
    Mesa.emitir("assistente");
    clearInterval(timerEspera);
    timerEspera = setInterval(tique, 1000);
    const corpoPedido = { texto: comReferencias(texto), turnos: turnos.slice(-6) };
    if (foco) corpoPedido.foco = foco;
    const meu = pedido;
    try {
      const r = await n.api("POST", "/api/assistente", corpoPedido, { tempo: 250000, semMedir: true });
      meu.r = r;
      meu.estado = "pronto";
      meu.duracao = Date.now() - meu.inicio;
      meu.depois = {};
      if (r.dados) n.aplicarDados(r.dados);
      for (const m of r.mudancas || []) { const i = E.porId.get(m.id); if (i) meu.depois[m.id] = JSON.parse(JSON.stringify(i)); }
      turnos.push({ papel: "eu", texto }, { papel: "assistente", texto: r.resposta || "" });
      turnos = turnos.slice(-12);
      const rec = n.lerPref("mesa.pedidos.recentes", []).filter((x) => x.texto !== texto);
      rec.unshift({ texto, em: new Date().toISOString(), mudancas: (r.mudancas || []).length });
      n.gravarPref("mesa.pedidos.recentes", rec.slice(0, 10));
      const mud = (r.mudancas || []).length;
      if (mud) {
        const acao = n.criarAcao(`Assistente: ${mud} ${n.plural(mud, "mudança aplicada", "mudanças aplicadas")}.`, r.mudancas, null, `Desfeito: ${mud} ${n.plural(mud, "mudança do assistente", "mudanças do assistente")}.`);
        n.registrarAcao(acao);
        meu.acao = acao;
        requestAnimationFrame(() => Mesa.quadro.piscar(r.mudancas.map((m) => m.id)));
      }
      n.anunciar(mud ? `${mud} ${n.plural(mud, "mudança aplicada", "mudanças aplicadas")}. ${r.resposta || ""}` : (r.resposta || "Não mudei nada."));
      if (!aberta || vista !== "pedido") n.toast({ texto: mud ? `Assistente: ${mud} ${n.plural(mud, "mudança aplicada", "mudanças aplicadas")}.` : `Assistente: ${r.resposta || "não mudei nada."}`, tipo: "ok", acoes: [{ rotulo: "Ver", fn: () => P.verPedido() }].concat(mud ? [{ rotulo: "Desfazer tudo", fn: () => desfazerTudo() }] : []), duracao: mud ? 8000 : 6000 });
    } catch (e) {
      meu.estado = "erro";
      meu.erro = e;
      meu.duracao = Date.now() - meu.inicio;
      n.anunciar(mensagemErro(e), true);
      if (!aberta || vista !== "pedido") n.toast({ texto: mensagemErro(e), tipo: "erro", acoes: [{ rotulo: "Ver", fn: () => P.verPedido() }] });
    } finally {
      clearInterval(timerEspera);
      if (aberta && pedido === meu) { campo.value = ""; desenhar(); campo.focus(); }
      Mesa.emitir("assistente");
    }
  }
  function mensagemErro(e) {
    if (e.status === 409) return "Espere o pedido anterior terminar.";
    if (e.tempoEsgotado) return "O servidor não respondeu. Veja a barra de status.";
    if (e.rede) return "Sem conexão com o servidor local. Nada foi alterado.";
    if (e.status === 502 && /4 minutos/.test(e.message)) return "O assistente não respondeu em 4 min. Nada foi alterado.";
    if (e.status === 502) return `O assistente respondeu com erro: ${String(e.message).replace(/\.$/, "")}. Nada foi alterado.`;
    if (e.status === 400) return `Não entendi o pedido: ${String(e.message).replace(/\.$/, "")}.`;
    return `${e.message} Nada foi alterado.`;
  }
  function tique() {
    if (!pedido || pedido.estado !== "esperando") return;
    const s = segundos();
    for (const el of $$("[data-seg]", caixa || document)) el.textContent = `${s} s`;
    const exp = caixa && caixa.querySelector(".pal-espera-exp");
    if (exp) exp.textContent = expectativa(s);
    Mesa.emitir("assistente-tique", s);
    if (s === 250) { /* o fetch aborta sozinho no limite de 250 s */ }
  }
  function expectativa(s) {
    if (s >= 90) return "Ainda sem resposta. O servidor espera até 4 min antes de desistir.";
    if (s >= 40) return "Está demorando mais que o normal.";
    return "Costuma levar de 15 a 35 s. Nada muda no quadro até a resposta chegar. Para desistir, espere a resposta e use Desfazer.";
  }
  function desenharPedido() {
    const p = pedido;
    if (p.estado === "esperando") {
      corpo.append(h("div", { c: "pal-espera" },
        h("div", { c: "pal-espera-l1" }, n.spinner(), h("span", { t: "Aguardando o assistente" }), h("span", { c: "seg", d: { seg: "1" }, t: `${segundos()} s` })),
        h("p", { c: "pal-espera-exp", t: expectativa(segundos()) }),
        h("div", { c: "pal-espera-acoes" }, h("button", { type: "button", c: "btn btn-28", on: { click: () => P.fechar() } }, "Continuar em segundo plano", n.kbd("Esc")))));
      return;
    }
    if (anteriores.length) corpo.append(desenharAnteriores());
    if (p.estado === "erro") {
      corpo.append(h("div", { c: "pal-erro", role: "alert" },
        h("div", { c: "l" }, ic("i-error"), h("span", { t: mensagemErro(p.erro) })),
        h("div", { style: "display:flex;gap:8px" }, h("button", { type: "button", c: "btn btn-28", t: "Tentar de novo", on: { click: () => { const t = p.texto; pedido = null; enviar(t); } } }),
          h("button", { type: "button", c: "btn btn-28 btn-sutil", t: "Copiar pedido", on: { click: () => n.copiar(p.texto, "Pedido copiado.") } }))));
      desenharRodape(p);
      return;
    }
    const r = p.r || {};
    const muds = r.mudancas || [];
    const box = h("div", { c: "pal-res" });
    if (muds.length) box.append(h("div", { c: "pal-res-cab" }, ic("i-success"), h("span", { t: `${muds.length} ${n.plural(muds.length, "mudança aplicada", "mudanças aplicadas")}` }), h("span", { c: "em", t: `em ${Math.round(p.duracao / 1000)} s` })));
    if (r.resposta) box.append(h("div", { c: "pal-resposta", t: r.resposta }));
    else if (!muds.length) box.append(h("div", { c: "pal-resposta", t: "Não mudei nada." }));
    for (const m of muds) box.append(linhaMudanca(p, m));
    for (const a of r.avisos || []) box.append(h("div", { c: "pal-aviso" }, ic("i-warning"), h("span", { t: String(a).replace(/^opera[cç][aã]o \d+:\s*/i, "Não aplicado: ") })));
    corpo.append(box);
    desenharRodape(p);
  }
  const CAMPOS = [["status", "Status"], ["prioridade", "Prioridade"], ["prazo", "Prazo"], ["titulo", "Título"], ["pessoa", "Pedido por"], ["area", "Área"], ["projeto_id", "Projeto"], ["contexto", "Descrição"]];
  function valorCampo(k, v) {
    if (k === "status") return n.STATUS_NOME[v] || v || "—";
    if (k === "prioridade") return (n.PRIO[v] || {}).nome || v || "—";
    if (k === "prazo") return v ? n.dataComSemana(v) : "sem prazo";
    if (k === "projeto_id") return v ? n.nomeProjeto(v) : "sem projeto";
    if (k === "contexto") return v ? `“${String(v).slice(0, 60)}${String(v).length > 60 ? "…" : ""}”` : "vazia";
    return v ? String(v) : "—";
  }
  function linhaMudanca(p, m) {
    const atual = p.depois[m.id] || E.porId.get(m.id);
    const desfeita = p.desfeitas.has(m.id + m.tipo);
    const l2 = h("div", { c: "l2" });
    let icone = "i-edit";
    if (m.tipo === "criou") {
      icone = "i-plus";
      if (atual) l2.append(`Nova · ${n.PRIO[atual.prioridade] ? n.PRIO[atual.prioridade].nome : ""} · ${atual.area}`);
    } else {
      const antes = m.antes || {};
      let algum = false;
      for (const [k, rot] of CAMPOS) {
        if (!(k in antes) || !atual) continue;
        if (k === "ordem") continue;
        if (String(antes[k] || "") === String(atual[k] || "")) continue;
        if (algum) l2.append(h("br"));
        l2.append(`${rot}: `, h("span", { c: "antes", t: valorCampo(k, antes[k]) }), " → ", h("span", { c: "depois", t: valorCampo(k, atual[k]) }));
        algum = true;
        if (k === "status") icone = atual.status === "descartada" ? "i-discard" : n.STATUS_ICONE[atual.status];
      }
      if (!algum) {
        const ult = atual && atual.historico && atual.historico[atual.historico.length - 1];
        l2.append(ult ? `Nota: “${ult.texto}”` : m.resumo || "Alterada");
      }
    }
    if (desfeita) { limpar(l2); l2.append("Desfeito"); }
    const botao = h("button", { type: "button", c: "btn btn-24", t: desfeita ? "Refazer" : "Desfazer" });
    const linha = h("div", { c: "pal-mud" + (desfeita ? " desfeita" : ""), tabindex: "0", role: "group", "aria-label": `${n.ref(m.id)} ${m.titulo}` },
      ic(icone), h("div", {}, h("div", { c: "l1" }, h("span", { c: "card-num", t: n.ref(m.id) || "#" }), h("span", { c: "t", t: m.titulo })), l2), botao);
    botao.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      botao.disabled = true;
      try {
        if (!desfeita) { await n.desfazerMudanca(m); p.desfeitas.add(m.id + m.tipo); }
        else { await refazer(p, m); p.desfeitas.delete(m.id + m.tipo); }
        desenhar();
      } catch (e) {
        botao.remove();
        linha.querySelector("div").append(h("div", { c: "erro", t: e.status === 409 ? "Não dá pra desfazer: a pendência mudou depois." : `Não consegui: ${e.message}` }));
      }
    });
    linha.addEventListener("click", () => { if (!E.porId.has(m.id)) return; P.fechar(); Mesa.gaveta.abrir(m.id, { via: "push" }); });
    linha.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target === linha) { ev.preventDefault(); linha.click(); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); const p2 = linha.nextElementSibling; if (p2 && p2.classList.contains("pal-mud")) p2.focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); const p2 = linha.previousElementSibling; if (p2 && p2.classList.contains("pal-mud")) p2.focus(); else campo.focus(); }
    });
    return linha;
  }
  async function refazer(p, m) {
    const depois = p.depois[m.id];
    if (!depois) throw new Error("não guardei o estado depois da mudança");
    if (m.tipo === "criou") {
      const campos = {};
      for (const k of ["titulo", "pessoa", "area", "projeto_id", "prioridade", "prazo", "contexto", "status"]) if (depois[k]) campos[k] = depois[k];
      const r = await n.api("POST", "/api/pendencias", { campos });
      n.aplicarDados(r.dados);
      m.id = r.mudanca.id;
      p.depois[m.id] = JSON.parse(JSON.stringify(E.porId.get(m.id)));
      return;
    }
    const campos = {};
    for (const [k] of CAMPOS) if (m.antes && k in m.antes) campos[k] = depois[k];
    const r = await n.api("PATCH", n.rotaItem(m.id), { campos });
    n.aplicarDados(r.dados);
    if (r.mudanca) m.antes = r.mudanca.antes;
  }
  async function desfazerTudo() {
    const p = pedido;
    if (!p || !p.r) return;
    const muds = [...(p.r.mudancas || [])].reverse();
    try {
      for (const m of muds) { if (p.desfeitas.has(m.id + m.tipo)) continue; await n.desfazerMudanca(m); p.desfeitas.add(m.id + m.tipo); }
      n.toast({ texto: `Desfeito: ${muds.length} ${n.plural(muds.length, "mudança do assistente", "mudanças do assistente")}.`, tipo: "info" });
    } catch (e) {
      n.toast({ texto: e.status === 409 ? "Não dá pra desfazer: a pendência mudou depois." : `Não consegui desfazer tudo: ${e.message}`, tipo: "erro" });
    }
    if (aberta) desenhar();
  }
  function desenharRodape(p) {
    rodape.hidden = false;
    limpar(rodape);
    const muds = (p.r && p.r.mudancas) || [];
    if (muds.length) rodape.append(h("button", { type: "button", c: "btn btn-sutil btn-28", t: "Desfazer tudo", on: { click: desfazerTudo } }));
    rodape.append(h("button", { type: "button", c: "btn btn-sutil btn-28", t: "Nova conversa", on: { click: () => { turnos = []; anteriores.length = 0; pedido = null; vista = "lista"; campo.value = ""; desenhar(); campo.focus(); } } }),
      h("span", { c: "dir" }, h("button", { type: "button", c: "btn btn-28", on: { click: () => P.fechar() } }, "Fechar", n.kbd("Esc"))));
  }

  P.iniciar = () => {
    montar();
    $("#caixa-paleta").addEventListener("click", () => (pedido && pedido.estado === "esperando" ? P.verPedido() : P.abrir()));
    $("#celular-perguntar").addEventListener("click", () => P.abrir());
  };
})();
