/* Escriba: quadro.
   Barra de ferramentas (visões, filtros, alternâncias, busca), colunas e raias, cartões renderizados por
   chave (Map id → elemento; só troca texto e atributos), arrastar e soltar com Pointer Events, teclado
   (roving tabindex, mover com Ctrl+setas, Shift+1..4, pegar com Espaço), seleção múltipla, compositor
   de nova pendência e a visão Lista. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, $$, limpar } = n;
  const Q = (Mesa.quadro = {});

  const elCartao = new Map();
  let agendado = 0, chaveEstrutura = "", larguraQuadro = 0, timerEsqueleto = 0, esqueletoVisivel = false, timerLento = 0;
  let navTeclado = false, timerSeguir = 0, levantado = null, arraste = null, compositor = null;

  const prefColunasRecolhidas = () => new Set(n.lerPref("mesa.colunas.recolhidas", []));
  const ordemColuna = (st) => (n.lerPref("mesa.colunas.ordem", {})[st] || "manual");
  function limiteColuna(st) {
    if (st === "andamento") return E.limiteAndamento || 0;
    const l = n.lerPref("mesa.colunas.limite", {})[st];
    return l ? Number(l) : 0;
  }
  const atalhosLigados = () => E.atalhosUmaTecla !== false;

  // ------------------------------------------------------------------ filtros e visões
  function filtrosAtivos() {
    const f = E.filtros;
    return f.areas.size + f.pessoas.size + f.prioridades.size + f.sinais.size + (f.texto.trim() ? 1 : 0);
  }
  function passaTexto(i, texto) {
    const termos = n.norm(texto).split(/\s+/).filter(Boolean);
    if (!termos.length) return true;
    const a = n.areaDe(i);
    const alvo = n.norm([i.titulo, i.contexto, i.pessoa, a.nome, a.curto, a.apelidos.join(" "), n.nomeProjeto(i.projeto_id), i.origem].join(" "));
    const numero = "#" + n.num(i.id);
    return termos.every((t) => (/^#\d+$/.test(t) ? t === numero : alvo.includes(t)));
  }
  function passaFiltros(i, semTexto) {
    const f = E.filtros;
    if (f.areas.size && !f.areas.has(i.area)) return false;
    if (f.pessoas.size) {
      const ps = n.pessoasDe(i);
      if (!(ps.length ? ps.some((p) => f.pessoas.has(p)) : f.pessoas.has(""))) return false;
    }
    if (f.prioridades.size && !f.prioridades.has(i.prioridade)) return false;
    if (f.sinais.size) {
      let ok = false;
      if (f.sinais.has("atrasadas") && n.atrasada(i)) ok = true;
      if (f.sinais.has("hoje") && n.venceHoje(i)) ok = true;
      if (f.sinais.has("aguardando") && i.status === "aguardando") ok = true;
      if (f.sinais.has("cobrar") && n.cobrancaVencida(i)) ok = true;
      if (f.sinais.has("entregas")) { const a = n.estadoAgente(i); if (a && a.estado === "entrega") ok = true; }
      if (!ok) return false;
    }
    if (!semTexto && f.texto.trim() && !passaTexto(i, f.texto)) return false;
    return true;
  }
  function janelaFeita(i) {
    const d = n.diaConcluida(i) || n.isoDeTs(i.atualizado_em);
    const h0 = n.hoje();
    if (E.visao === "hoje") return d === h0;
    if (E.visao === "semana") return d >= n.inicioDaSemana(h0);
    return d >= n.somaDias(h0, -(Number(E.janelaFeitas) || 14) + 1);
  }
  function passaVisao(i) {
    if (i.status === "descartada") return false;
    if (i.status === "feita") return Q.todasFeitas || janelaFeita(i);
    if (E.visao === "tudo") return true;
    const h0 = n.hoje();
    const ag = n.estadoAgente(i), entrega = ag && ag.estado === "entrega";
    if (E.visao === "hoje") return (i.prazo && i.prazo <= h0) || i.prioridade === "urgente" || i.status === "andamento" || !!entrega;
    return (i.prazo && i.prazo <= n.fimDaSemana(h0)) || i.prioridade !== "acompanhar" || i.status === "andamento" || !!entrega;
  }
  const visivel = (i) => passaVisao(i) && passaFiltros(i);
  Q.visivel = visivel;
  Q.passaVisao = passaVisao;
  Q.filtrosAtivos = filtrosAtivos;

  function ordenar(st, lista) {
    if (st === "feita") return lista.sort((a, b) => String(n.concluidaEm(b)).localeCompare(String(n.concluidaEm(a))));
    if (st === "aguardando" && E.filtros.sinais.has("aguardando")) return lista.sort((a, b) => n.diasParada(b) - n.diasParada(a) || manual(a, b));
    const modo = ordemColuna(st);
    if (modo === "prazo") return lista.sort((a, b) => (a.prazo || "9999").localeCompare(b.prazo || "9999") || n.PRIO_PESO[a.prioridade] - n.PRIO_PESO[b.prioridade] || manual(a, b));
    if (modo === "prioridade") return lista.sort((a, b) => n.PRIO_PESO[a.prioridade] - n.PRIO_PESO[b.prioridade] || (a.prazo || "9999").localeCompare(b.prazo || "9999") || manual(a, b));
    if (modo === "recentes") return lista.sort((a, b) => String(b.criado_em || "").localeCompare(String(a.criado_em || "")));
    return lista.sort(manual);
  }
  function manual(a, b) {
    return (a.ordem - b.ordem) || (a.prazo || "9999").localeCompare(b.prazo || "9999") || String(a.pedido_em || "").localeCompare(String(b.pedido_em || ""));
  }
  /* A coluna inteira na ordem do servidor (ordem, prazo, pedido_em): base do `posicao` do /mover. */
  function colunaServidor(st, sem) {
    return E.itens.filter((i) => i.status === st && !(sem && sem.has(i.id))).sort(manual);
  }

  // ------------------------------------------------------------------ raias
  function chaveRaia(i) { return E.raias === "projeto" ? i.projeto_id || "" : i.area; }
  function nomeRaia(k) { return E.raias === "projeto" ? (k ? n.nomeProjeto(k) : "Sem projeto") : k; }
  function areaRaia(k) {
    if (E.raias === "area") return n.AREA[k] || n.AREA.Outros;
    const p = E.projetosPorId.get(k);
    return p ? n.AREA[p.area] || n.AREA.Outros : n.AREA.Outros;
  }
  function raiasOrdenadas(visiveis) {
    const mapa = new Map();
    if (E.raias === "area") for (const a of n.AREAS) mapa.set(a.nome, []);
    for (const i of visiveis) { const k = chaveRaia(i); if (!mapa.has(k)) mapa.set(k, []); mapa.get(k).push(i); }
    const mostrarVazias = n.lerPref("mesa.raias.vazias", false);
    const lista = [...mapa.entries()].map(([k, itens]) => ({
      k, itens, abertas: itens.filter((i) => !n.fechada(i)).length, atrasadas: itens.filter(n.atrasada).length,
      ultima: E.raias === "area" ? k === n.AREA_PADRAO : k === "",
    })).filter((r) => mostrarVazias || r.abertas > 0);
    lista.sort((a, b) => (a.ultima - b.ultima) || (b.atrasadas - a.atrasadas) || (b.abertas - a.abertas) || nomeRaia(a.k).localeCompare(nomeRaia(b.k), "pt-BR"));
    return lista;
  }

  // ------------------------------------------------------------------ barra de ferramentas
  const ferr = {};
  function montarFerramentas() {
    const raiz = $("#ferramentas");
    limpar(raiz);
    const linha = h("div", { c: "fer-linha", role: "toolbar", "aria-label": "Visões e filtros" });
    ferr.linha = linha;
    // 1. visões
    ferr.pivos = h("div", { c: "pivos so-largo", role: "group", "aria-label": "Visão" },
      [["hoje", "Hoje"], ["semana", "Esta semana"], ["tudo", "Tudo"]].map(([v, r]) =>
        h("button", { type: "button", c: "pivo", "data-label": r, d: { visao: v }, t: r, "data-tip": `Visão ${r}   G ${v === "hoje" ? "H" : v === "semana" ? "S" : "T"}`, on: { click: () => Q.definirVisao(v) } })));
    ferr.salvas = h("button", { type: "button", c: "btn-icone so-largo", "aria-label": "Visões salvas", "aria-haspopup": "menu", "data-tip": "Visões salvas", on: { click: (ev) => menuVisoesSalvas(ev.currentTarget) } }, ic("i-chevron-down"));
    ferr.visaoEstreita = h("button", { type: "button", c: "chip-menu so-estreito", "aria-haspopup": "menu", on: { click: (ev) => menuVisaoEstreita(ev.currentTarget) } });
    // 3. filtros
    ferr.chipArea = chipFiltro("area", "Área");
    ferr.chipPessoa = chipFiltro("pessoa", "Pessoa");
    ferr.chipPrio = chipFiltro("prioridade", "Prioridade");
    ferr.chipFiltros = h("button", { type: "button", c: "chip-menu so-estreito", "aria-haspopup": "menu", on: { click: (ev) => menuFiltrosEstreito(ev.currentTarget) } });
    // 4. alternâncias
    const ALT = [["atrasadas", "Atrasadas", "i-clock-filled", "tem-atrasadas"], ["hoje", "Vencem hoje", "i-clock", "tem-hoje"], ["cobrar", "Cobrar", "i-bell", "tem-cobrar"], ["aguardando", "Aguardando", "i-status-waiting", "tem-aguardando"], ["entregas", "Entregas", "i-delivery", "tem-entregas"]];
    ferr.alts = {};
    const grupoAlt = h("div", { c: "alternancias", role: "group", "aria-label": "Sinais" },
      ALT.map(([k, r, icone, cls]) => {
        const b = h("button", { type: "button", c: "alt", "aria-pressed": "false", d: { sinal: k, cls }, "data-tip": r + (k === "atrasadas" ? "   A" : ""), on: { click: () => Q.alternarSinal(k) } },
          h("span", { c: "alt-icone" }, ic(icone)), h("span", { c: "alt-rotulo", t: r }), h("span", { c: "num", t: "0" }));
        ferr.alts[k] = b;
        return b;
      }));
    // 5. filtrar
    ferr.busca = h("input", { type: "search", placeholder: "Filtrar", "aria-label": "Filtrar pendências", autocomplete: "off", value: E.filtros.texto });
    ferr.filtrar = h("div", { c: "filtrar" }, ic("i-search"), ferr.busca, h("kbd", { t: "/" }));
    ferr.busca.addEventListener("input", () => { E.filtros.texto = ferr.busca.value; Q.render(); Mesa.emitir("filtros"); });
    ferr.busca.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (ferr.busca.value) { ferr.busca.value = ""; E.filtros.texto = ""; Q.render(); Mesa.emitir("filtros"); } else { ferr.busca.blur(); ferr.filtrar.classList.remove("expandido"); Q.focar(E.foco); } }
      else if (ev.key === "Enter" || ev.key === "ArrowDown") { ev.preventDefault(); ferr.filtrar.classList.remove("expandido"); Q.focar(primeiroVisivel()); }
    });
    ferr.busca.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== ferr.busca) ferr.filtrar.classList.remove("expandido"); }, 100));
    ferr.filtrarBtn = h("button", { type: "button", c: "btn-icone filtrar-btn", "aria-label": "Filtrar", "data-tip": "Filtrar   /", on: { click: () => Q.focarFiltro() } }, ic("i-search"));
    // 6. direita
    ferr.teams = h("button", { type: "button", c: "btn-icone", id: "fer-teams", "aria-label": "Atualizar do Teams", "aria-haspopup": "dialog", "data-tip": "Atualizar do Teams", hidden: true, on: { click: (ev) => Mesa.teams.painel(ev.currentTarget) } }, ic("i-refresh"));
    ferr.raias = h("button", { type: "button", c: "btn-icone", "aria-label": "Raias", "aria-pressed": "false", "aria-haspopup": "menu", "data-tip": "Raias   R", on: { click: (ev) => menuRaias(ev.currentTarget) } }, ic("i-lanes"));
    ferr.btnQuadro = h("button", { type: "button", c: "btn-icone", "aria-label": "Quadro", "aria-pressed": "true", "data-tip": "Quadro   V", on: { click: () => Q.definirModo("quadro") } }, ic("i-board"));
    ferr.btnLista = h("button", { type: "button", c: "btn-icone", "aria-label": "Lista", "aria-pressed": "false", "data-tip": "Lista   V", on: { click: () => Q.definirModo("lista") } }, ic("i-list"));
    ferr.painel = h("button", { type: "button", c: "btn-icone", "aria-label": "Mostrar ou ocultar o painel", "aria-pressed": "false", "data-tip": "Painel   ]", on: { click: () => Mesa.gaveta.alternarPainel() } }, ic("i-panel-right"));
    ferr.mais = h("button", { type: "button", c: "btn-icone", "aria-label": "Mais opções do quadro", "aria-haspopup": "menu", "data-tip": "Mais opções", on: { click: (ev) => menuMais(ev.currentTarget) } }, ic("i-more"));
    linha.append(ferr.pivos, ferr.salvas, ferr.visaoEstreita, h("span", { c: "fer-sep so-largo", "aria-hidden": "true" }),
      ferr.chipArea, ferr.chipPessoa, ferr.chipPrio, ferr.chipFiltros, h("span", { c: "fer-sep", "aria-hidden": "true" }), grupoAlt,
      h("span", { c: "fer-sep", "aria-hidden": "true" }), ferr.filtrar, ferr.filtrarBtn,
      h("div", { c: "fer-direita" }, ferr.teams, ferr.raias, h("div", { c: "grupo-modo", role: "group", "aria-label": "Modo" }, ferr.btnQuadro, ferr.btnLista), ferr.painel, ferr.mais));
    ferr.lote = h("div", { c: "lote", role: "toolbar", "aria-label": "Ações em lote", hidden: true });
    raiz.append(linha, ferr.lote);
  }
  function chipFiltro(tipo, rotulo) {
    const b = h("button", { type: "button", c: "chip-menu so-largo", "aria-haspopup": "menu", d: { filtro: tipo } });
    b.addEventListener("click", (ev) => {
      if (ev.target.closest(".chip-limpar")) { ev.stopPropagation(); conjuntoFiltro(tipo).clear(); Q.render(); Mesa.emitir("filtros"); return; }
      menuFiltro(tipo, b);
    });
    b._rotulo = rotulo;
    return b;
  }
  function conjuntoFiltro(tipo) { return tipo === "area" ? E.filtros.areas : tipo === "pessoa" ? E.filtros.pessoas : E.filtros.prioridades; }
  function rotuloChip(b, tipo) {
    const s = conjuntoFiltro(tipo);
    limpar(b);
    let r = b._rotulo;
    if (s.size === 1) {
      const v = [...s][0];
      r += ": " + (tipo === "area" ? n.AREA[v] ? n.AREA[v].curto : v : tipo === "pessoa" ? (v ? n.nomeCurto(v) : "Sem pessoa") : n.PRIO[v].nome);
    } else if (s.size > 1) r += ": " + s.size;
    b.append(h("span", { t: r }));
    if (s.size) b.append(h("span", { c: "chip-limpar", role: "button", "aria-label": `Limpar filtro de ${b._rotulo.toLowerCase()}` }, ic("i-dismiss-12")));
    else b.append(ic("i-chevron-down-12"));
    b.classList.toggle("ativo", s.size > 0);
  }
  function opcoesFiltro(tipo) {
    const base = E.itens.filter((i) => passaVisao(i) && !n.fechada(i));
    const s = conjuntoFiltro(tipo);
    const alternar = (v) => (marcado) => { if (marcado) s.add(v); else s.delete(v); Q.render(); Mesa.emitir("filtros"); };
    const somente = (v) => () => { s.clear(); s.add(v); Q.render(); Mesa.emitir("filtros"); };
    if (tipo === "area") {
      return n.AREAS.map((a) => ({ tipo: "check", manter: true, rotulo: a.nome, sq: a, marcado: s.has(a.nome), num: base.filter((i) => i.area === a.nome).length, acao: alternar(a.nome), somente: somente(a.nome) }));
    }
    if (tipo === "prioridade") {
      return n.PRIORIDADES.map((p) => ({ tipo: "check", manter: true, rotulo: p.nome, iconeEl: n.iconePrio(p.v), marcado: s.has(p.v), num: base.filter((i) => i.prioridade === p.v).length, acao: alternar(p.v), somente: somente(p.v) }));
    }
    const contagem = new Map();
    let sem = 0;
    for (const i of E.itens.filter((x) => x.status !== "descartada")) {
      const ps = n.pessoasDe(i);
      if (!ps.length) { if (!n.fechada(i)) sem++; continue; }
      for (const p of ps) contagem.set(p, (contagem.get(p) || 0) + (n.fechada(i) ? 0 : 1));
    }
    const pessoas = [...contagem.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"));
    const itens = pessoas.map(([p, c]) => ({ tipo: "check", manter: true, rotulo: p, marcado: s.has(p), num: c, acao: alternar(p), somente: somente(p) }));
    itens.push({ tipo: "check", manter: true, rotulo: "Sem pessoa", marcado: s.has(""), num: sem, acao: alternar(""), somente: somente("") });
    return itens;
  }
  function menuFiltro(tipo, ancora) {
    n.menu(ancora, () => opcoesFiltro(tipo), { filtro: true, multi: true, rotulo: `Filtrar por ${ancora._rotulo.toLowerCase()}` });
  }
  function menuFiltrosEstreito(ancora) {
    const itens = () => [{ titulo: "Área" }, ...opcoesFiltro("area"), { separador: true }, { titulo: "Prioridade" }, ...opcoesFiltro("prioridade"), { separador: true }, { titulo: "Pessoa" }, ...opcoesFiltro("pessoa")];
    n.menu(ancora, itens, { filtro: true, multi: true, rotulo: "Filtros" });
  }
  function menuVisaoEstreita(ancora) {
    n.menu(ancora, [["hoje", "Hoje"], ["semana", "Esta semana"], ["tudo", "Tudo"]].map(([v, r]) => ({ tipo: "radio", rotulo: r, marcado: E.visao === v, acao: () => Q.definirVisao(v) }))
      .concat([{ separador: true }, { rotulo: "Visões salvas…", acao: () => menuVisoesSalvas(ancora) }]), { rotulo: "Visão" });
  }
  function filtrosParaSalvar() {
    const f = E.filtros;
    return { visao: E.visao, areas: [...f.areas], pessoas: [...f.pessoas], prioridades: [...f.prioridades], sinais: [...f.sinais], texto: f.texto, raias: E.raias, modo: E.modo };
  }
  function aplicarVisaoSalva(v) {
    const f = E.filtros;
    f.areas = new Set(v.areas || []); f.pessoas = new Set(v.pessoas || []); f.prioridades = new Set(v.prioridades || []); f.sinais = new Set(v.sinais || []); f.texto = v.texto || "";
    if (ferr.busca) ferr.busca.value = f.texto;
    if (v.visao) E.visao = v.visao;
    if (v.raias != null) E.raias = v.raias;
    if (v.modo) E.modo = v.modo;
    Q.render(); Mesa.emitir("filtros");
  }
  function menuVisoesSalvas(ancora) {
    const lista = n.lerPref("mesa.visoes", []);
    const campo = h("input", { type: "text", placeholder: "Nome da visão", "aria-label": "Nome da visão", maxlength: "40" });
    const salvar = () => {
      const nome = campo.value.trim();
      if (!nome) return;
      const atual = n.lerPref("mesa.visoes", []).filter((v) => v.nome !== nome);
      atual.push({ nome, filtros: filtrosParaSalvar() });
      n.gravarPref("mesa.visoes", atual.slice(-8));
      n.fecharMenus();
      n.toast({ texto: `Visão salva: ${nome}.`, tipo: "ok" });
    };
    campo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); salvar(); } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Home" || ev.key === "End") ev.stopPropagation(); });
    const itens = lista.map((v) => ({ rotulo: v.nome, acao: () => aplicarVisaoSalva(v.filtros || {}), sec: "", dica: "Abrir esta visão" }));
    if (lista.length) {
      itens.push({ separador: true });
      itens.push({ rotulo: "Excluir uma visão", sub: lista.map((v) => ({ rotulo: v.nome, acao: () => excluirVisao(v.nome), perigo: true })) });
    } else itens.push({ titulo: "Nenhuma visão salva ainda" });
    itens.push({ separador: true }, { titulo: "Salvar filtros atuais como visão" }, { campo: h("div", { c: "menu-campo" }, campo, h("button", { type: "button", c: "btn btn-28", t: "Salvar", on: { click: salvar } })) });
    n.menu(ancora, itens, { rotulo: "Visões salvas" });
  }
  function excluirVisao(nome) {
    const antes = n.lerPref("mesa.visoes", []);
    n.gravarPref("mesa.visoes", antes.filter((v) => v.nome !== nome));
    const acao = { rotulo: `Visão excluída: ${nome}.`, desfazer: async () => n.gravarPref("mesa.visoes", antes), refazer: async () => n.gravarPref("mesa.visoes", antes.filter((v) => v.nome !== nome)), mudancas: [] };
    n.toast({ texto: `Visão excluída: ${nome}.`, tipo: "ok", desfazer: acao });
  }
  function menuRaias(ancora) {
    n.menu(ancora, [
      { tipo: "radio", rotulo: "Sem raias", marcado: !E.raias, acao: () => Q.definirRaias("") },
      { tipo: "radio", rotulo: "Raias por área", marcado: E.raias === "area", acao: () => Q.definirRaias("area") },
      { tipo: "radio", rotulo: "Raias por projeto", marcado: E.raias === "projeto", acao: () => Q.definirRaias("projeto") },
      { separador: true },
      { tipo: "check", rotulo: "Mostrar raias vazias", marcado: n.lerPref("mesa.raias.vazias", false), acao: () => { n.gravarPref("mesa.raias.vazias", !n.lerPref("mesa.raias.vazias", false)); Q.render(true); } },
    ], { rotulo: "Raias" });
  }
  function menuMais(ancora) {
    n.menu(ancora, [
      { rotulo: "Densidade", sub: [
        { tipo: "radio", rotulo: "Confortável", marcado: E.densidade !== "compacta", acao: () => Q.definirDensidade("confortavel") },
        { tipo: "radio", rotulo: "Compacta", marcado: E.densidade === "compacta", acao: () => Q.definirDensidade("compacta") }] },
      { rotulo: "Ordenar todas as colunas por", sub: [["manual", "Manual"], ["prazo", "Prazo"], ["prioridade", "Prioridade"], ["recentes", "Mais recentes"]].map(([v, r]) => ({ rotulo: r, acao: () => { const o = {}; for (const c of n.COLUNAS) o[c.status] = v; n.gravarPref("mesa.colunas.ordem", o); Q.render(true); } })) },
      { rotulo: "Resumo de hoje", icone: "i-calendar-today", acao: () => Mesa.gaveta.resumo() },
      { separador: true },
      { rotulo: "Exportar CSV", icone: "i-copy", acao: exportarCSV },
    ], { rotulo: "Mais opções do quadro" });
  }
  function atualizarFerramentas() {
    if (!ferr.linha) return;
    const sel = E.selecao.size;
    ferr.linha.hidden = sel > 0;
    ferr.lote.hidden = sel === 0;
    if (sel) desenharLote();
    for (const b of $$(".pivo", ferr.pivos)) b.setAttribute("aria-current", String(b.dataset.visao === E.visao));
    limpar(ferr.visaoEstreita).append(h("span", { t: { hoje: "Hoje", semana: "Esta semana", tudo: "Tudo" }[E.visao] }), ic("i-chevron-down-12"));
    rotuloChip(ferr.chipArea, "area");
    rotuloChip(ferr.chipPessoa, "pessoa");
    rotuloChip(ferr.chipPrio, "prioridade");
    const nf = E.filtros.areas.size + E.filtros.pessoas.size + E.filtros.prioridades.size;
    limpar(ferr.chipFiltros).append(h("span", { t: nf ? `Filtros ${nf}` : "Filtros" }), ic("i-chevron-down-12"));
    ferr.chipFiltros.classList.toggle("ativo", nf > 0);
    const abertas = E.itens.filter((i) => !n.fechada(i));
    const cont = {
      atrasadas: abertas.filter(n.atrasada).length,
      hoje: abertas.filter(n.venceHoje).length,
      cobrar: abertas.filter(n.cobrancaVencida).length,
      aguardando: abertas.filter((i) => i.status === "aguardando").length,
      entregas: abertas.filter((i) => { const a = n.estadoAgente(i); return a && a.estado === "entrega"; }).length,
    };
    const nomes = { atrasadas: "Atrasadas", hoje: "Vencem hoje", cobrar: "Para cobrar", aguardando: "Aguardando", entregas: "Entregas" };
    for (const [k, b] of Object.entries(ferr.alts)) {
      b.setAttribute("aria-pressed", String(E.filtros.sinais.has(k)));
      b.querySelector(".num").textContent = String(cont[k]);
      b.classList.toggle(b.dataset.cls, cont[k] > 0);
      b.setAttribute("aria-label", `${nomes[k]}: ${cont[k]}`);
    }
    if (ferr.busca.value !== E.filtros.texto && document.activeElement !== ferr.busca) ferr.busca.value = E.filtros.texto;
    ferr.teams.hidden = !Mesa.teams.disponivel();
    ferr.raias.setAttribute("aria-pressed", String(!!E.raias));
    ferr.btnQuadro.setAttribute("aria-pressed", String(E.modo === "quadro"));
    ferr.btnLista.setAttribute("aria-pressed", String(E.modo === "lista"));
    ferr.painel.setAttribute("aria-pressed", String(Mesa.gaveta ? Mesa.gaveta.painelVisivel() : false));
  }
  function desenharLote() {
    const l = ferr.lote;
    limpar(l);
    const ids = [...E.selecao];
    const qtd = ids.length;
    l.append(h("span", { c: "lote-conta", t: `${qtd} ${n.plural(qtd, "selecionada", "selecionadas")}` }), h("span", { c: "fer-sep", "aria-hidden": "true" }),
      h("button", { type: "button", c: "chip-menu", "aria-haspopup": "menu", on: { click: (ev) => n.menu(ev.currentTarget, n.COLUNAS.map((c) => ({ rotulo: c.nome, iconeEl: n.iconeStatus(c.status), acao: () => Q.moverPara(ids, c.status) }))) } }, h("span", { t: "Mover para" }), ic("i-chevron-down-12")),
      h("button", { type: "button", c: "chip-menu", "aria-haspopup": "menu", on: { click: (ev) => n.menu(ev.currentTarget, n.PRIORIDADES.map((p) => ({ rotulo: p.nome, iconeEl: n.iconePrio(p.v), acao: () => mudarVarias(ids, { prioridade: p.v }, `Prioridade de ${qtd} ${n.plural(qtd, "pendência", "pendências")}: ${p.nome}.`) }))) } }, h("span", { t: "Prioridade" }), ic("i-chevron-down-12")),
      h("button", { type: "button", c: "chip-menu", on: { click: (ev) => n.seletorPrazo(ev.currentTarget, "", (v) => mudarVarias(ids, { prazo: v }, v ? `Prazo de ${qtd} ${n.plural(qtd, "pendência", "pendências")}: ${n.dataComSemana(v)}.` : `${qtd} ${n.plural(qtd, "pendência ficou", "pendências ficaram")} sem prazo.`)) } }, h("span", { t: "Prazo" }), ic("i-chevron-down-12")),
      h("button", { type: "button", c: "chip-menu", "aria-haspopup": "menu", on: { click: (ev) => n.menu(ev.currentTarget, n.AREAS.map((a) => ({ rotulo: a.nome, sq: a, acao: () => mudarVarias(ids, { area: a.nome }, `Área de ${qtd} ${n.plural(qtd, "pendência", "pendências")}: ${a.nome}.`) }))) } }, h("span", { t: "Área" }), ic("i-chevron-down-12")),
      h("button", { type: "button", c: "btn btn-28", on: { click: () => Q.descartar(ids) } }, ic("i-discard"), "Descartar"),
      h("span", { c: "fer-direita" }, h("span", { c: "texto-3 t-meta", t: "Esc limpa" }), h("button", { type: "button", c: "btn-icone", "aria-label": "Limpar seleção", on: { click: () => Q.limparSelecao() } }, ic("i-dismiss"))));
  }
  async function mudarVarias(ids, campos, rotulo) {
    if (!n.podeEscrever()) return n.semConexao();
    const mudancas = [];
    n.definirSync("salvando");
    try {
      for (const id of ids) {
        const r = await n.api("PATCH", n.rotaItem(id), { campos });
        if (r.mudanca) mudancas.push(r.mudanca);
        n.aplicarDados(r.dados);
      }
      n.definirSync("salvo");
      if (mudancas.length) {
        const acao = n.criarAcao(rotulo, mudancas, async () => {
          const novas = [];
          for (const id of ids) { const r = await n.api("PATCH", n.rotaItem(id), { campos }); novas.push(r.mudanca); n.aplicarDados(r.dados); }
          return novas;
        });
        n.registrarAcao(acao);
        n.toast({ texto: rotulo, tipo: "ok", desfazer: acao });
      }
    } catch (e) {
      n.definirSync("erro", e);
      n.toast({ texto: n.mensagemErro(e), tipo: "erro" });
    }
  }
  Q.mudarVarias = mudarVarias;

  // ------------------------------------------------------------------ estrutura das colunas
  function colunasRecolhidas() {
    const s = prefColunasRecolhidas();
    if (E.filtros.sinais.has("aguardando") && E.filtros.sinais.size === 1) { s.add("aberta"); s.add("andamento"); s.add("feita"); s.delete("aguardando"); }
    if (larguraQuadro && larguraQuadro - 32 < 4 * 256 + 3 * 8 && window.innerWidth >= 720) s.add("feita");
    return s;
  }
  function montarColuna(c, recolhida) {
    if (recolhida) {
      const b = h("button", { type: "button", c: "col recolhida", "aria-expanded": "false", "aria-label": `${c.nome}, recolhida. Expandir`, d: { status: c.status, tipoAlvo: "trilho" } },
        h("span", { c: "col-trilho" }, ic(c.icone, c.cls), h("span", { c: "col-cont num", d: { cont: c.status } }), h("span", { c: "rotulo", t: c.nome })));
      b.addEventListener("click", () => {
        if (arraste) return;
        const s = prefColunasRecolhidas();
        if (s.has(c.status)) { s.delete(c.status); n.gravarPref("mesa.colunas.recolhidas", [...s]); }
        else if (c.status === "feita") { Q.forcarFeitaAberta = true; }
        if (E.filtros.sinais.has("aguardando") && c.status !== "aguardando") { E.filtros.sinais.delete("aguardando"); Mesa.emitir("filtros"); }
        Q.render(true);
      });
      return b;
    }
    const idH = "h-" + c.status;
    const lista = h("ul", { c: "col-lista", role: "listbox", "aria-labelledby": idH, "aria-multiselectable": "true", tabindex: "-1", d: { status: c.status, tipoAlvo: "lista" } });
    const cab = h("div", { c: "col-cab" },
      h("div", { c: "col-cab-linha" }, ic(c.icone, c.cls), h("h2", { id: idH, t: c.nome }), h("span", { c: "col-cont num", d: { cont: c.status } }),
        h("span", { c: "col-acoes" },
          c.status !== "feita" ? h("button", { type: "button", c: "btn-icone", "aria-label": `Nova pendência em ${c.nome}`, "data-tip": `Nova pendência em ${c.nome}`, on: { click: () => Q.abrirCompositor(c.status) } }, ic("i-plus")) : null,
          h("button", { type: "button", c: "btn-icone", "aria-label": `Opções da coluna ${c.nome}`, "aria-haspopup": "menu", "data-tip": "Opções da coluna", on: { click: (ev) => menuColuna(c, ev.currentTarget) } }, ic("i-more")))),
      c.status === "feita" ? h("div", { c: "col-janela", d: { janela: "1" } }) : h("div", { c: "col-dist", "aria-hidden": "true", d: { dist: c.status } }),
      h("div", { c: "col-ordem", hidden: true, d: { ordemAviso: c.status } }));
    const vazia = h("p", { c: "col-vazia", hidden: true, d: { vazia: c.status } });
    const rodape = h("div", { c: "col-rodape", d: { rodape: c.status } });
    const abaixo = h("button", { type: "button", c: "col-abaixo", hidden: true, d: { abaixo: c.status }, "aria-label": "Rolar para baixo" });
    const rolagem = h("div", { c: "col-rolagem" }, cab, lista, vazia, rodape, abaixo);
    const sec = h("section", { c: "col", "aria-labelledby": idH, d: { status: c.status } }, rolagem);
    rolagem.addEventListener("scroll", () => { sec.classList.toggle("rolou", rolagem.scrollTop > 0); atualizarAbaixo(sec); }, { passive: true });
    abaixo.addEventListener("click", () => rolagem.scrollBy({ top: rolagem.clientHeight - 60, behavior: n.movReduzido() ? "auto" : "smooth" }));
    return sec;
  }
  function atualizarAbaixo(sec) {
    const rol = sec.querySelector(".col-rolagem"), b = sec.querySelector(".col-abaixo"), lista = sec.querySelector(".col-lista");
    if (!rol || !b || !lista) return;
    const limite = rol.scrollTop + rol.clientHeight - 24;
    let qtd = 0;
    for (const li of lista.children) if (li.offsetTop + li.offsetHeight / 2 > limite) qtd++;
    b.hidden = qtd === 0;
    b.textContent = `↓ ${qtd} abaixo`;
  }
  function menuColuna(c, ancora) {
    const itens = [];
    if (c.status !== "feita") {
      const atual = ordemColuna(c.status);
      itens.push({ titulo: "Ordenar por" }, ...[["manual", "Manual"], ["prazo", "Prazo"], ["prioridade", "Prioridade"], ["recentes", "Mais recentes"]].map(([v, r]) => ({
        tipo: "radio", rotulo: r, marcado: atual === v, acao: () => { const o = n.lerPref("mesa.colunas.ordem", {}); o[c.status] = v; n.gravarPref("mesa.colunas.ordem", o); Q.render(true); } })));
      itens.push({ separador: true }, { rotulo: "Limite…", sec: limiteColuna(c.status) ? String(limiteColuna(c.status)) : "sem limite", acao: () => popLimite(c, ancora) });
    } else {
      itens.push({ titulo: "Mostrar" }, ...[7, 14, 30].map((d) => ({ tipo: "radio", rotulo: `Últimos ${d} dias`, marcado: Number(E.janelaFeitas) === d, acao: () => { E.janelaFeitas = d; n.gravarPref("mesa.feitas.dias", d); Q.render(true); } })));
    }
    itens.push({ separador: true }, { rotulo: "Recolher coluna", acao: () => { const s = prefColunasRecolhidas(); s.add(c.status); n.gravarPref("mesa.colunas.recolhidas", [...s]); Q.forcarFeitaAberta = false; Q.render(true); } });
    n.menu(ancora, itens, { rotulo: `Opções de ${c.nome}` });
  }
  function popLimite(c, ancora) {
    const campo = h("input", { type: "number", min: "0", max: "99", c: "campo", value: limiteColuna(c.status) || "", "aria-label": `Limite de ${c.nome}` });
    const salvar = () => {
      const v = Math.max(0, Math.min(99, Number(campo.value) || 0));
      if (c.status === "andamento") { E.limiteAndamento = v; n.gravarPref("mesa.limite.andamento", v); }
      else { const o = n.lerPref("mesa.colunas.limite", {}); o[c.status] = v; n.gravarPref("mesa.colunas.limite", o); }
      pop.fechar(); Q.render(true);
    };
    campo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); salvar(); } });
    const pop = n.popover(ancora, h("div", { style: "width:220px;display:grid;gap:8px" }, h("label", { c: "t-meta texto-2", t: `Limite de ${c.nome} (vazio = sem limite)` }), campo, h("div", { c: "pop-acoes" }, h("button", { type: "button", c: "btn btn-28 btn-primario", t: "Salvar", on: { click: salvar } }))), { rotulo: "Limite da coluna" });
  }

  // ------------------------------------------------------------------ cartão
  function assinatura(i) {
    const ag = n.estadoAgente(i);
    return [i.titulo, i.area, i.pessoa, i.prioridade, i.prazo, i.cobrar_em, i.aguardando_de, i.status, n.ligacoesN(i), ag ? ag.estado + (ag.naoVista ? "!" : "") + (ag.ex ? ag.ex.status : "") : "", n.hoje(), E.filtros.texto, E.densidade, n.num(i.id), i.historico.length, i.atualizado_em, E.recursos.cerebro ? 1 : 0].join("\u0001");
  }
  function iconeAgente(i) {
    const ag = n.estadoAgente(i);
    if (!ag) return null;
    const mapa = {
      trabalhando: ["rodando", null, "Agente trabalhando"], falhou: ["falhou", "i-error", "O agente parou com erro"],
      entrega: ["entrega", "i-delivery", `Entrega pronta · ${(ag.u && ag.u.entregas || []).length} ${n.plural((ag.u && ag.u.entregas || []).length, "arquivo", "arquivos")}`],
      rascunho: ["", "i-draft", "Rascunho de resposta pronto"], briefing: ["", "i-briefing", "Briefing pronto"],
    };
    const [cls, icone, tip] = mapa[ag.estado];
    const s = h("span", { c: "card-agente " + cls, "aria-hidden": "true", d: { alvo: "agente" }, "data-tip": tip });
    s.append(ag.estado === "trabalhando" ? n.spinner() : ic(icone));
    if (ag.estado === "entrega" && ag.naoVista) s.append(h("span", { c: "ponto-novo" }));
    return s;
  }
  function preencherCartao(li, i) {
    const sig = assinatura(i);
    if (li._sig === sig) return;
    li._sig = sig;
    limpar(li);
    const numero = n.num(i.id), a = n.areaDe(i);
    li.id = "c-" + numero;
    li.setAttribute("aria-labelledby", "t-" + numero);
    li.setAttribute("aria-describedby", "d-" + numero);
    const termo = E.filtros.texto;
    const titulo = h("div", { c: "card-titulo", id: "t-" + numero, "data-tip-auto": i.titulo }, n.marcar(i.titulo, termo));
    const desc = h("span", { c: "sr-only", id: "d-" + numero, t: n.descricaoAcessivel(i) });
    const nCtx = E.recursos.cerebro ? n.ligacoesN(i) : 0;
    const na = i.ligacoes.arquivos.length, nn = i.ligacoes.notas.length;
    const cerebro = nCtx ? h("span", { c: "card-cerebro", "aria-hidden": "true", d: { alvo: "contexto" }, "data-tip": `${na} ${n.plural(na, "arquivo", "arquivos")} e ${nn} ${n.plural(nn, "nota", "notas")} ligados` }, ic("i-links-12"), String(nCtx)) : null;
    const ps = n.pessoasDe(i);
    const pessoa = ps.length ? h("span", { c: "card-pessoa", "data-tip": ps.join(", ") }, E.densidade === "compacta" ? null : n.avatar(n.nomeCurto(ps[0])), h("span", { c: "nome", t: n.nomeCurto(ps[0]) }), ps.length > 1 ? h("span", { c: "mais", t: ` +${ps.length - 1}` }) : null) : null;
    const prio = h("span", { c: "prio", "data-tip": n.PRIO[i.prioridade].nome }, n.iconePrio(i.prioridade));
    const numEl = h("span", { c: "card-num", t: "#" + numero });
    const salv = h("span", { c: "salvando-num", "aria-hidden": "true" }, n.spinner(true));
    const mais = h("span", { c: "card-mais", "aria-hidden": "true", d: { alvo: "menu" }, "data-tip": "Mais ações" }, ic("i-more"));
    const agente = iconeAgente(i);
    if (E.densidade === "compacta") {
      const ch = n.chipCartao(i, "compacta");
      const prazo = ch ? h("span", { c: "chip " + (ch.tipo === "atrasada" ? "chip-atrasada" : ch.tipo === "hoje" ? "chip-hoje" : ch.tipo === "parada" ? "chip-parada" : "") }, ["atrasada", "hoje"].includes(ch.tipo) ? ic(ch.icone) : null, ch.texto) : null;
      li.append(
        h("div", { c: "card-l1" }, h("span", { c: "card-proj", "data-tip": a.nome }, h("span", { c: "check-sel", "aria-hidden": "true" }, ic("i-check-12")), n.quadrado(a)), titulo, agente),
        h("div", { c: "card-c" }, prio, prazo, pessoa ? h("span", { c: "sep", t: "·" }) : null, pessoa, cerebro, selo(i), h("span", { c: "num-compacto", t: "#" + numero }, salv)),
        mais, desc);
    } else {
      const ch = n.chipCartao(i, "cartao");
      li.append(
        h("div", { c: "card-a" },
          h("span", { c: "card-proj" }, h("span", { c: "check-sel", "aria-hidden": "true" }, ic("i-check-12")), n.quadrado(a), h("span", { t: a.curto })),
          h("span", { c: "card-dir" }, agente, numEl, salv)),
        titulo,
        h("div", { c: "card-c" }, prio, n.chip(ch), pessoa, cerebro, selo(i)),
        mais, desc);
    }
  }
  /* Selo da issue do Jira no cartao: so aparece quando a pendencia ja virou tarefa la.
     (a assinatura do cartao ja inclui atualizado_em, entao ele se redesenha sozinho ao criar) */
  function selo(i) {
    return Mesa.jira && Mesa.jira.disponivel() && (i.jira || {}).chave ? Mesa.jira.etiqueta(i) : null;
  }
  function preencherLinhaFeita(li, i) {
    const sig = ["f", i.titulo, n.num(i.id), n.diaConcluida(i), n.hoje(), E.filtros.texto].join("\u0001");
    if (li._sig === sig) return;
    li._sig = sig;
    limpar(li);
    const numero = n.num(i.id);
    li.id = "c-" + numero;
    li.setAttribute("aria-labelledby", "t-" + numero);
    li.setAttribute("aria-describedby", "d-" + numero);
    li.append(ic("i-status-done-12"), h("span", { c: "card-num", t: "#" + numero }),
      h("span", { c: "lf-titulo", id: "t-" + numero, "data-tip-auto": i.titulo }, n.marcar(i.titulo, E.filtros.texto)),
      h("span", { c: "lf-quando", t: n.relativoDia(n.diaConcluida(i)) }),
      h("span", { c: "sr-only", id: "d-" + numero, t: n.descricaoAcessivel(i) }));
  }
  function cartaoDe(i) {
    let li = elCartao.get(i.id);
    const feita = i.status === "feita";
    if (!li || li._feita !== feita) {
      li = h("li", { c: feita ? "linha-feita" : "card", role: "option", tabindex: "-1", "aria-selected": "false", d: { id: i.id } });
      li._feita = feita;
      elCartao.set(i.id, li);
    }
    if (feita) preencherLinhaFeita(li, i); else preencherCartao(li, i);
    li.setAttribute("aria-selected", String(E.selecao.has(i.id)));
    if (E.abertaId === i.id) li.setAttribute("aria-current", "true"); else li.removeAttribute("aria-current");
    return li;
  }
  Q.elDe = (id) => { const el = elCartao.get(id); return el && el.isConnected ? el : null; };

  function reconciliar(lista, els) {
    const comp = lista.querySelector(".compositor");
    let ref = comp ? comp.nextSibling : lista.firstChild;
    for (const el of els) {
      if (el !== ref) lista.insertBefore(el, ref);
      else ref = ref.nextSibling;
      ref = el.nextSibling;
    }
    while (ref) { const prox = ref.nextSibling; if (!ref.classList || !ref.classList.contains("compositor")) ref.remove(); ref = prox; }
  }

  // ------------------------------------------------------------------ desenho
  /* Um desenho por quadro (requestAnimationFrame), com um temporizador de reserva para abas em segundo
     plano, onde o rAF não dispara. Enquanto um cartão está levantado ou sendo arrastado, o desenho espera. */
  let reserva = 0, adiado = false;
  Q.render = (estrutura) => {
    if (estrutura) chaveEstrutura = "";
    if (agendado) return;
    const rodar = () => {
      cancelAnimationFrame(agendado); clearTimeout(reserva);
      agendado = 0; reserva = 0;
      if (levantado || (arraste && arraste.iniciado && !arraste.terminado)) { adiado = true; return; }
      adiado = false;
      desenhar();
    };
    agendado = requestAnimationFrame(rodar);
    reserva = setTimeout(rodar, 120);
  };
  Q.retomarDesenho = () => { if (adiado) Q.render(true); };
  function desenhar() {
    const pag = E.pagina;
    atualizarFerramentas();
    document.body.classList.toggle("denso", E.densidade === "compacta");
    if (pag !== "quadro" && pag !== "lista") { Mesa.emitir("render"); return; }
    const qd = $("#quadro"), lst = $("#lista");
    qd.hidden = E.modo !== "quadro";
    lst.hidden = E.modo !== "lista";
    if (!E.carregado) { desenharCarregando(); Mesa.emitir("render"); return; }
    pararEsqueleto();
    const visiveis = E.itens.filter(visivel);
    const nf = filtrosAtivos();
    const aviso = $("#aviso-filtros");
    const total = E.itens.filter((i) => i.status !== "descartada").length;
    if (total === 0) aviso.hidden = true;
    else if (nf && !visiveis.length) {
      aviso.hidden = false;
      limpar(aviso).append(h("span", { t: "Nenhuma pendência com esses filtros." }), h("button", { type: "button", c: "btn btn-28", t: "Limpar filtros", on: { click: () => Q.limparFiltros() } }));
    } else aviso.hidden = true;
    if (E.modo === "lista") desenharLista(visiveis);
    else desenharQuadro(visiveis);
    desenharAbasCelular(visiveis);
    Mesa.emitir("render");
  }
  function desenharCarregando() {
    const qd = $("#quadro");
    if (E.erroCarga) {
      pararEsqueleto();
      limpar(qd);
      chaveEstrutura = "";
      const e = E.erroCarga;
      qd.append(h("div", { c: "estado-erro", role: "alert" },
        h("h2", {}, ic("i-error"), "Não consegui carregar as pendências."),
        h("div", { c: "detalhe", t: e.detalhe || e.mensagem || "" }),
        h("div", { c: "acoes" }, h("button", { type: "button", c: "btn btn-primario", t: "Tentar de novo", on: { click: () => { E.erroCarga = null; Q.render(true); n.recarregar(); } } }),
          h("button", { type: "button", c: "btn btn-sutil", t: "Copiar detalhes", on: { click: () => n.copiar(`${e.mensagem}\n${e.detalhe}`, "Detalhes copiados.") } })),
        h("p", { c: "t-meta texto-3", t: "Se o servidor caiu, rode iniciar-mesa.cmd." })));
      return;
    }
    if (chaveEstrutura !== "carregando") {
      chaveEstrutura = "carregando";
      limpar(qd);
      for (const c of n.COLUNAS) {
        const sec = montarColuna(c, false);
        sec.querySelector(".col-cont").textContent = "–";
        qd.append(sec);
      }
      clearTimeout(timerEsqueleto);
      timerEsqueleto = setTimeout(mostrarEsqueleto, 300);
      clearTimeout(timerLento);
      timerLento = setTimeout(() => { if (!E.carregado && !E.erroCarga) n.toast({ texto: "Ainda carregando… o servidor está respondendo devagar.", tipo: "info" }); }, 10000);
    }
  }
  function mostrarEsqueleto() {
    if (E.carregado) return;
    esqueletoVisivel = true;
    for (const l of $$("#quadro .col-lista")) {
      for (const alt of [82, 100, 82]) l.append(h("li", { c: "esqueleto", "aria-hidden": "true", style: `height:${alt}px` }, h("span", { c: "esq e10", style: "width:40%" }), h("span", { c: "esq", style: "width:90%" }), h("span", { c: "esq", style: "width:60%" }), h("span", { c: "esq e20" })));
    }
  }
  function pararEsqueleto() { clearTimeout(timerEsqueleto); clearTimeout(timerLento); if (esqueletoVisivel) { esqueletoVisivel = false; chaveEstrutura = ""; } }

  function porColuna(visiveis) {
    const g = { aberta: [], andamento: [], aguardando: [], feita: [] };
    for (const i of visiveis) if (g[i.status]) g[i.status].push(i);
    for (const st of Object.keys(g)) ordenar(st, g[st]);
    return g;
  }
  function desenharQuadro(visiveis) {
    const qd = $("#quadro");
    const recolhidas = colunasRecolhidas();
    if (Q.forcarFeitaAberta && !prefColunasRecolhidas().has("feita")) recolhidas.delete("feita");
    const g = porColuna(visiveis);
    const raias = E.raias ? raiasOrdenadas(visiveis) : null;
    const recRaias = new Set(n.lerPref("mesa.raias.recolhidas", []));
    const chave = [E.raias, [...recolhidas].sort().join(","), raias ? raias.map((r) => r.k + (recRaias.has(r.k) ? "-" : "")).join("|") : "", E.densidade].join("§");
    if (chave !== chaveEstrutura) {
      chaveEstrutura = chave;
      limpar(qd);
      qd.classList.toggle("com-raias", !!raias);
      if (!raias) for (const c of n.COLUNAS) qd.append(montarColuna(c, recolhidas.has(c.status)));
      else qd.append(montarRaias(raias, recolhidas, recRaias));
      if (compositor && !compositor.li.isConnected) {
        const l = qd.querySelector(`.col-lista[data-status="${compositor.status}"]`);
        if (l) { l.prepend(compositor.li); compositor.ta.focus(); } else compositor = null;
      }
    }
    const todosVisiveis = new Set(visiveis.map((i) => i.id));
    const total = (st) => E.itens.filter((i) => i.status === st && passaVisao(i)).length;
    const nf = filtrosAtivos();
    for (const c of n.COLUNAS) {
      const itens = g[c.status];
      for (const cont of $$(`[data-cont="${c.status}"]`, qd)) {
        limpar(cont);
        const lim = limiteColuna(c.status);
        const qtd = itens.length;
        cont.classList.toggle("estourou", !!lim && qtd > lim && c.status !== "feita");
        if (lim && c.status !== "feita") {
          if (qtd > lim) cont.append(ic("i-warning-12"));
          cont.append(`${qtd}/${lim}`);
          cont.setAttribute("data-tip", qtd > lim ? `${qtd} ${c.status === "andamento" ? "em andamento" : "nesta coluna"}. Seu limite é ${lim}.` : `${qtd} de ${lim} no limite`);
        } else if (nf) {
          cont.append(String(qtd), h("span", { c: "total", t: ` de ${total(c.status)}` }));
          cont.removeAttribute("data-tip");
        } else { cont.append(String(qtd)); cont.removeAttribute("data-tip"); }
      }
      if (!raias) {
        const sec = qd.querySelector(`section.col[data-status="${c.status}"]`);
        if (!sec) continue;
        const lista = sec.querySelector(".col-lista");
        reconciliar(lista, itens.map(cartaoDe));
        lista.setAttribute("aria-label", itens.length ? null : `${c.nome}, vazia`);
        if (!itens.length) lista.removeAttribute("aria-labelledby"); else lista.setAttribute("aria-labelledby", "h-" + c.status);
        if (itens.length) lista.removeAttribute("aria-label");
        const vazia = sec.querySelector(".col-vazia");
        vazia.hidden = itens.length > 0 || !!lista.querySelector(".compositor");
        const semNada = E.itens.filter((i) => i.status !== "descartada").length === 0;
        vazia.textContent = semNada && c.status === "aberta" ? "Nenhuma pendência ainda. Pressione N para criar ou Ctrl+K e escreva o que te pediram: 'a Ana pediu o relatório até sexta'." : nf ? "Nada com esses filtros." : c.status === "feita" ? `Nada concluído nos últimos ${E.janelaFeitas} dias.` : c.vazio;
        desenharDistribuicao(sec, c, itens);
        desenharRodape(sec, c);
        const aviso = sec.querySelector("[data-ordem-aviso]");
        if (aviso) {
          const modo = ordemColuna(c.status);
          aviso.hidden = modo === "manual" && !(c.status === "aguardando" && E.filtros.sinais.has("aguardando"));
          limpar(aviso);
          if (!aviso.hidden) aviso.append(modo === "manual" ? "Ordem por tempo parado" : `Ordem por ${{ prazo: "prazo", prioridade: "prioridade", recentes: "mais recentes" }[modo]} · `, modo === "manual" ? null : h("button", { type: "button", c: "link", t: "Manual", on: { click: () => { const o = n.lerPref("mesa.colunas.ordem", {}); o[c.status] = "manual"; n.gravarPref("mesa.colunas.ordem", o); Q.render(true); } } }));
        }
        requestAnimationFrame(() => atualizarAbaixo(sec));
      } else {
        for (const r of raias) {
          const cel = qd.querySelector(`.raia-celula[data-status="${c.status}"][data-raia="${CSS.escape(r.k)}"]`);
          if (!cel || cel.classList.contains("recolhida")) {
            if (cel) cel.textContent = String(r.itens.filter((i) => i.status === c.status).length);
            continue;
          }
          reconciliar(cel, itens.filter((i) => chaveRaia(i) === r.k).map(cartaoDe));
        }
        for (const r of raias) atualizarCabRaia(qd, r);
      }
    }
    for (const [id, el] of elCartao) if (!todosVisiveis.has(id) && el.isConnected && !el.closest(".compositor")) el.remove();
    for (const id of [...elCartao.keys()]) if (!E.porId.has(id)) elCartao.delete(id);
    garantirRoving();
    larguraToasts();
  }
  function desenharDistribuicao(sec, c, itens) {
    if (c.status === "feita") {
      const j = sec.querySelector("[data-janela]");
      if (j) j.textContent = Q.todasFeitas ? "todas" : E.visao === "hoje" ? "hoje" : E.visao === "semana" ? "desde segunda" : `últimos ${E.janelaFeitas} dias`;
      return;
    }
    const d = sec.querySelector(`[data-dist="${c.status}"]`);
    if (!d) return;
    const atr = itens.filter(n.atrasada).length;
    const prox = itens.filter((i) => i.prazo && !n.atrasada(i) && n.diasEntre(n.hoje(), i.prazo) <= 1).length;
    const resto = itens.length - atr - prox;
    limpar(d);
    d.hidden = itens.length === 0;
    const tot = Math.max(1, itens.length);
    if (atr) d.append(h("span", { c: "d-atrasada", style: `width:${(atr / tot) * 100}%` }));
    if (prox) d.append(h("span", { c: "d-hoje", style: `width:${(prox / tot) * 100}%` }));
    if (resto) d.append(h("span", { c: "d-resto" }));
    d.parentNode.setAttribute("data-tip", `${atr} ${n.plural(atr, "atrasada", "atrasadas")} · ${prox} até amanhã · ${resto} no prazo ou sem prazo`);
  }
  function desenharRodape(sec, c) {
    const r = sec.querySelector("[data-rodape]");
    if (!r) return;
    limpar(r);
    if (c.status === "feita") {
      const antigas = E.itens.filter((i) => i.status === "feita" && !passaVisao(i)).length;
      if (antigas && !Q.todasFeitas) r.append(h("button", { type: "button", c: "link t-meta", t: `Ver concluídas mais antigas (${antigas})`, on: { click: () => { Q.todasFeitas = true; Q.definirModo("lista"); } } }));
    } else if (c.status === "andamento" || c.status === "aguardando") {
      r.append(h("button", { type: "button", c: "add-col", on: { click: () => Q.abrirCompositor(c.status) } }, ic("i-plus"), "Adicionar"));
    }
  }
  function montarRaias(raias, recolhidas, recRaias) {
    const cols = n.COLUNAS.map((c) => (recolhidas.has(c.status) ? "40px" : "minmax(256px,1fr)")).join(" ");
    const grade = h("div", { c: "raias-grade", style: `--raia-cols:${cols};max-width:${4 * 400 + 24}px` });
    for (const c of n.COLUNAS) {
      const rec = recolhidas.has(c.status);
      grade.append(h("div", { c: "raia-col-cab" }, h("div", { c: "col-cab-linha" }, ic(c.icone, c.cls), rec ? null : h("h2", { id: "h-" + c.status, t: c.nome }), h("span", { c: "col-cont num", d: { cont: c.status } }),
        rec ? null : h("span", { c: "col-acoes" }, c.status !== "feita" ? h("button", { type: "button", c: "btn-icone", "aria-label": `Nova pendência em ${c.nome}`, on: { click: () => Q.abrirCompositor(c.status) } }, ic("i-plus")) : null,
          h("button", { type: "button", c: "btn-icone", "aria-label": `Opções da coluna ${c.nome}`, "aria-haspopup": "menu", on: { click: (ev) => menuColuna(c, ev.currentTarget) } }, ic("i-more"))))));
    }
    for (const r of raias) {
      const a = areaRaia(r.k), rec = recRaias.has(r.k);
      const cab = h("div", { c: "raia-cab", style: "--cor:" + a.cor, d: { raiaCab: r.k } },
        h("button", { type: "button", c: "btn-icone raia-chevron", "aria-expanded": String(!rec), "aria-label": `${rec ? "Expandir" : "Recolher"} raia ${nomeRaia(r.k)}`, on: { click: () => { const s = new Set(n.lerPref("mesa.raias.recolhidas", [])); if (s.has(r.k)) s.delete(r.k); else s.add(r.k); n.gravarPref("mesa.raias.recolhidas", [...s]); Q.render(true); } } }, ic(rec ? "i-chevron-right" : "i-chevron-down")),
        n.quadrado(a, 10), h("span", { c: "raia-nome", t: nomeRaia(r.k) }), h("span", { c: "raia-cont num" }), h("span", { c: "raia-atrasada" }), h("span", { c: "raia-recolhida-resumo" }));
      grade.append(cab);
      if (rec) continue;
      for (const c of n.COLUNAS) {
        const recC = recolhidas.has(c.status);
        grade.append(h("ul", { c: "raia-celula col-lista" + (recC ? " recolhida" : ""), role: "listbox", "aria-label": `${c.nome}, ${nomeRaia(r.k)}`, "aria-multiselectable": "true", tabindex: "-1", d: { status: c.status, raia: r.k, tipoAlvo: "lista" } }));
      }
    }
    return grade;
  }
  function atualizarCabRaia(qd, r) {
    const cab = qd.querySelector(`[data-raia-cab="${CSS.escape(r.k)}"]`);
    if (!cab) return;
    cab.querySelector(".raia-cont").textContent = String(r.abertas);
    cab.querySelector(".raia-atrasada").textContent = r.atrasadas ? `· ${r.atrasadas} ${n.plural(r.atrasadas, "atrasada", "atrasadas")}` : "";
    const resumo = cab.querySelector(".raia-recolhida-resumo");
    const rec = new Set(n.lerPref("mesa.raias.recolhidas", [])).has(r.k);
    resumo.textContent = rec ? n.COLUNAS.map((c) => `${c.nome} ${r.itens.filter((i) => i.status === c.status).length}`).join(" · ") : "";
  }
  function desenharAbasCelular(visiveis) {
    const abas = $("#abas-colunas");
    if (!abas || window.innerWidth >= 720) return;
    const g = porColuna(visiveis);
    limpar(abas);
    for (const c of n.COLUNAS) {
      abas.append(h("button", { type: "button", c: "pivo", role: "tab", "data-label": `${c.nome} ${g[c.status].length}`, "aria-selected": String(Q.colunaCelular === c.status || (!Q.colunaCelular && c.status === "aberta")), t: `${c.nome} ${g[c.status].length}`,
        on: { click: () => { Q.colunaCelular = c.status; const sec = $(`#quadro section.col[data-status="${c.status}"], #quadro .col[data-status="${c.status}"]`); if (sec) sec.scrollIntoView({ inline: "start", block: "nearest", behavior: n.movReduzido() ? "auto" : "smooth" }); desenharAbasCelular(E.itens.filter(visivel)); } } }));
    }
  }

  // ------------------------------------------------------------------ visão Lista
  const COLS_LISTA = [
    { k: "sel", r: "", w: 32 }, { k: "num", r: "#", w: 56, ord: (i) => n.num(i.id) }, { k: "titulo", r: "Título", ord: (i) => n.norm(i.titulo) },
    { k: "area", r: "Área", w: 140, ord: (i) => i.area }, { k: "pessoa", r: "Pedido por", w: 120, ord: (i) => n.norm(i.pessoa), cls: "c-pessoa" },
    { k: "prio", r: "Prioridade", w: 124, ord: (i) => n.PRIO_PESO[i.prioridade] }, { k: "prazo", r: "Prazo", w: 184, ord: (i) => i.prazo || "9999" },
    { k: "status", r: "Status", w: 132, ord: (i) => ["aberta", "andamento", "aguardando", "feita"].indexOf(i.status) }, { k: "cerebro", r: "Cérebro", w: 64, num: true, ord: (i) => n.ligacoesN(i), cls: "c-largo" },
    { k: "agente", r: "Agente", w: 56, cls: "" }, { k: "atualizado", r: "Atualizado", w: 104, ord: (i) => i.atualizado_em || "", cls: "c-largo" },
  ];
  function desenharLista(visiveis) {
    const raiz = $("#lista");
    const largura = raiz.clientWidth || window.innerWidth;
    const ordem = Q.ordemLista || { k: "", dir: 1 };
    const grupos = n.lerPref("mesa.lista.grupos.recolhidos", []);
    const termo = E.filtros.texto;
    const foco = raiz.contains(document.activeElement) ? document.activeElement.closest("tr") : null;
    const focoId = foco && foco.dataset.id;
    limpar(raiz);
    if (Q.todasFeitas) raiz.append(h("div", { c: "aviso-filtros", style: "margin:0 0 8px" }, h("span", { t: "Mostrando todas as concluídas." }), h("button", { type: "button", c: "btn btn-28", t: "Voltar à janela de " + E.janelaFeitas + " dias", on: { click: () => { Q.todasFeitas = false; Q.render(); } } })));
    const cols = COLS_LISTA.filter((c) => !(c.cls === "c-largo" && largura < 1200) && !(c.cls === "c-pessoa" && largura < 960));
    const tabela = h("table", { c: "tabela", role: "grid", "aria-multiselectable": "true", "aria-label": "Pendências" });
    const thr = h("tr", { role: "row" });
    for (const c of cols) {
      const th = h("th", { role: "columnheader", c: c.num ? "num-col" : "", style: c.w ? `width:${c.w}px` : null, "aria-sort": ordem.k === c.k ? (ordem.dir > 0 ? "ascending" : "descending") : c.ord ? "none" : null });
      if (c.k === "sel") th.append(h("span", { c: "sr-only", t: "Seleção" }));
      else if (c.ord) th.append(h("button", { type: "button", on: { click: () => { Q.ordemLista = { k: c.k, dir: ordem.k === c.k ? -ordem.dir : 1 }; Q.render(); } } }, c.r, ordem.k === c.k ? ic(ordem.dir > 0 ? "i-chevron-up-12" : "i-chevron-down-12") : null));
      else th.textContent = c.r;
      thr.append(th);
    }
    tabela.append(h("thead", {}, thr));
    const tbody = h("tbody");
    const agrupar = Q.agruparLista || "status";
    let blocos;
    if (agrupar === "status") blocos = n.COLUNAS.map((c) => ({ k: c.status, nome: c.nome, icone: n.iconeStatus(c.status), itens: visiveis.filter((i) => i.status === c.status) }));
    else if (agrupar === "area") blocos = n.AREAS.map((a) => ({ k: a.nome, nome: a.nome, icone: n.quadrado(a), itens: visiveis.filter((i) => i.area === a.nome) }));
    else blocos = [{ k: "", nome: "", itens: visiveis }];
    let primeiro = true;
    for (const b of blocos) {
      if (!b.itens.length) continue;
      if (ordem.k) { const c = COLS_LISTA.find((x) => x.k === ordem.k); b.itens.sort((x, y) => { const a1 = c.ord(x), b1 = c.ord(y); return (a1 < b1 ? -1 : a1 > b1 ? 1 : 0) * ordem.dir; }); }
      else if (agrupar === "status") ordenar(b.k, b.itens);
      else b.itens.sort(manual);
      const rec = b.k && grupos.includes(b.k);
      if (b.nome) {
        tbody.append(h("tr", { c: "grupo", role: "row" }, h("td", { colspan: String(cols.length), role: "gridcell" },
          h("button", { type: "button", c: "secao-cab", "aria-expanded": String(!rec), on: { click: () => { const s = new Set(n.lerPref("mesa.lista.grupos.recolhidos", [])); if (s.has(b.k)) s.delete(b.k); else s.add(b.k); n.gravarPref("mesa.lista.grupos.recolhidos", [...s]); Q.render(); } } },
            ic(rec ? "i-chevron-right" : "i-chevron-down"), b.icone, h("span", { t: b.nome }), h("span", { c: "num", t: String(b.itens.length) })))));
      }
      if (rec) continue;
      for (const i of b.itens) {
        const tr = h("tr", { c: "linha", role: "row", tabindex: (focoId ? focoId === i.id : primeiro && !E.foco) || E.foco === i.id ? "0" : "-1", "aria-selected": String(E.selecao.has(i.id)), d: { id: i.id } });
        primeiro = false;
        if (E.abertaId === i.id) tr.setAttribute("aria-current", "true");
        for (const c of cols) tr.append(celulaLista(c, i, termo));
        tbody.append(tr);
      }
    }
    tabela.append(tbody);
    if (!visiveis.length) raiz.append(h("p", { c: "tabela-vazia", t: filtrosAtivos() ? "Nenhuma pendência com esses filtros." : "Nenhuma pendência nesta visão." }));
    else raiz.append(tabela);
    raiz.append(h("div", { c: "t-meta texto-3", style: "margin-top:8px;display:flex;gap:8px;align-items:center" }, "Agrupar por:",
      ...[["status", "Status"], ["area", "Área"], ["nenhum", "Nenhum"]].map(([v, r]) => h("button", { type: "button", c: "link", t: r, "aria-pressed": String(agrupar === v), on: { click: () => { Q.agruparLista = v; Q.render(); } } }))));
    if (!raiz.querySelector('tr.linha[tabindex="0"]')) { const p = raiz.querySelector("tr.linha"); if (p) p.tabIndex = 0; }
    if (focoId) { const tr = raiz.querySelector(`tr.linha[data-id="${CSS.escape(focoId)}"]`); if (tr) tr.focus({ preventScroll: true }); }
  }
  function celulaLista(c, i, termo) {
    const td = h("td", { role: "gridcell", c: c.num ? "num-col" : "" });
    if (c.k === "sel") {
      const cb = h("input", { type: "checkbox", "aria-label": `Selecionar ${n.ref(i.id)}`, tabindex: "-1" });
      cb.checked = E.selecao.has(i.id);
      cb.addEventListener("click", (ev) => { ev.stopPropagation(); Q.alternarSelecao(i.id); });
      td.append(cb);
    } else if (c.k === "num") td.append(h("span", { c: "t-num", t: n.ref(i.id) }));
    else if (c.k === "titulo") { td.append(h("span", { c: "t-titulo", "data-tip-auto": i.titulo }, n.marcar(i.titulo, termo))); td.style.minWidth = "280px"; }
    else if (c.k === "area") td.append(h("span", { c: "cel" }, n.quadrado(i.area), h("span", { t: n.areaDe(i).curto })));
    else if (c.k === "pessoa") { const ps = n.pessoasDe(i); if (ps.length) td.append(h("span", { c: "cel", "data-tip": ps.join(", ") }, n.avatar(n.nomeCurto(ps[0])), h("span", { t: n.nomeCurto(ps[0]) + (ps.length > 1 ? ` +${ps.length - 1}` : "") }))); }
    else if (c.k === "prio") td.append(h("span", { c: "cel" }, n.iconePrio(i.prioridade), h("span", { t: n.PRIO[i.prioridade].nome })));
    else if (c.k === "prazo") {
      if (i.status === "feita") td.append(h("span", { c: "texto-3", t: `Concluída ${n.relativoDia(n.diaConcluida(i))}` }));
      else { const p = n.prazoInfo(i, "gaveta"); td.append(h("span", { c: p.tipo === "atrasada" ? "chip chip-atrasada" : p.tipo === "hoje" ? "chip chip-hoje" : p.vazio ? "texto-3" : "", t: p.tipo === "atrasada" ? n.prazoInfo(i, "cartao").texto : p.texto })); }
    } else if (c.k === "status") td.append(h("span", { c: "cel" }, n.iconeStatus(i.status), h("span", { t: n.STATUS_NOME[i.status] })));
    else if (c.k === "cerebro") { const q = n.ligacoesN(i); if (q && E.recursos.cerebro) td.append(h("span", { c: "num", t: String(q) })); }
    else if (c.k === "agente") { const e = iconeAgente(i); if (e) td.append(e); }
    else if (c.k === "atualizado") td.append(h("span", { c: "texto-3", t: n.relativo(i.atualizado_em) }));
    return td;
  }

  // ------------------------------------------------------------------ foco e navegação
  function grade() {
    const qd = $("#quadro");
    if (E.modo === "lista") return [$$("#lista tr.linha").map((tr) => tr.dataset.id)];
    return n.COLUNAS.map((c) => $$(`.col-lista[data-status="${c.status}"]`, qd).flatMap((l) => $$(":scope > li[data-id]", l).map((li) => li.dataset.id)));
  }
  Q.ordemVisivel = () => grade().flat();
  function primeiroVisivel() { const g = grade(); for (const col of g) if (col.length) return col[0]; return null; }
  function garantirRoving() {
    const qd = $("#quadro");
    let alvo = E.foco && Q.elDe(E.foco);
    const todos = $$("li[data-id]", qd);
    for (const li of todos) if (li.tabIndex !== -1 && li !== alvo) li.tabIndex = -1;
    for (const l of $$(".col-lista", qd)) l.tabIndex = -1;
    if (!alvo) alvo = todos[0] || qd.querySelector(".col-lista") || null;
    if (alvo) alvo.tabIndex = 0;
  }
  Q.focar = (id, opts) => {
    if (!id) {
      const p = primeiroVisivel();
      if (p) return Q.focar(p, opts);
      const l = E.modo === "lista" ? $("#lista tr.linha") : $("#quadro .col-lista");
      if (l) { l.tabIndex = 0; l.focus(); }
      return;
    }
    let el = E.modo === "lista" ? $(`#lista tr.linha[data-id="${CSS.escape(id)}"]`) : Q.elDe(id);
    if (!el) return;
    if (E.modo === "lista") { for (const tr of $$("#lista tr.linha")) tr.tabIndex = -1; el.tabIndex = 0; }
    else { garantirRoving(); for (const li of $$("#quadro li[data-id]")) li.tabIndex = -1; el.tabIndex = 0; }
    navTeclado = !!(opts && opts.teclado);
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  function focarLista(lista) { garantirRoving(); for (const li of $$("#quadro li[data-id]")) li.tabIndex = -1; lista.tabIndex = 0; lista.focus(); }
  function vizinho(id, delta) {
    const g = grade();
    for (let c = 0; c < g.length; c++) {
      const k = g[c].indexOf(id);
      if (k >= 0) return g[c][Math.max(0, Math.min(g[c].length - 1, k + delta))];
    }
    return null;
  }
  function colunaVizinha(id, dir) {
    const g = grade();
    const ci = g.findIndex((col) => col.includes(id));
    if (ci < 0) return null;
    const el = Q.elDe(id);
    const y = el ? el.getBoundingClientRect().top : 0;
    for (let c = ci + dir; c >= 0 && c < g.length; c += dir) {
      const colEl = $$(`#quadro .col[data-status="${n.COLUNAS[c].status}"], #quadro .raia-celula[data-status="${n.COLUNAS[c].status}"]`)[0];
      if (!g[c].length) {
        const lista = $(`#quadro .col-lista[data-status="${n.COLUNAS[c].status}"]`);
        if (lista) return { lista };
        if (colEl && colEl.classList.contains("recolhida")) return { trilho: colEl };
        continue;
      }
      let melhor = g[c][0], dist = Infinity;
      for (const oid of g[c]) {
        const o = Q.elDe(oid);
        if (!o) continue;
        const d = Math.abs(o.getBoundingClientRect().top - y);
        if (d < dist) { dist = d; melhor = oid; }
      }
      return { id: melhor };
    }
    return null;
  }
  Q.proximo = (id, delta) => {
    const ord = Q.ordemVisivel();
    const k = ord.indexOf(id);
    if (k < 0) return ord[0] || null;
    return ord[Math.max(0, Math.min(ord.length - 1, k + delta))];
  };

  // ------------------------------------------------------------------ ações de pendência
  Q.moverPara = async (ids, status, opts) => {
    ids = [].concat(ids).filter((id) => E.porId.has(id));
    if (!ids.length) return;
    const nome = n.COLUNAS.find((c) => c.status === status);
    const antes = ids.map((id) => E.porId.get(id).status);
    const movs = ids.map((id, k) => ({ id, status, posicao: (opts && opts.posicao != null ? opts.posicao : 0) + k }));
    const rotulo = ids.length === 1 ? (status === "feita" ? `${n.ref(ids[0])} concluída.` : status === "descartada" ? `${n.ref(ids[0])} descartada. Está no Arquivo.` : `${n.ref(ids[0])} foi para ${nome ? nome.nome : status}.`)
      : status === "descartada" ? `${ids.length} pendências descartadas. Estão no Arquivo.` : `${ids.length} pendências movidas para ${nome ? nome.nome : status}.`;
    const desfeito = ids.length === 1 ? `Desfeito: ${n.ref(ids[0])} voltou para ${n.COLUNAS.find((c) => c.status === antes[0]) ? n.COLUNAS.find((c) => c.status === antes[0]).nome : n.STATUS_NOME[antes[0]]}.` : `Desfeito: ${ids.length} pendências voltaram.`;
    try { await n.moverVarias(movs, { rotulo, rotuloDesfeito: desfeito, tentar: () => Q.moverPara(ids, status, opts) }); } catch (e) { return; /* toast já mostrado */ }
    if (status === "aguardando" && ids.length === 1 && antes[0] !== "aguardando" && !(opts && opts.semPerguntar)) {
      const el = Q.elDe(ids[0]);
      requestAnimationFrame(() => perguntarAguardando(ids[0], el || document.activeElement));
    }
  };
  Q.concluir = (id) => Q.moverPara([id], "feita");
  Q.descartar = async (ids) => {
    ids = [].concat(ids);
    if (!ids.length) return;
    if (ids.length >= 5) {
      const ok = await n.confirmar({ depois: $("#barra-recarga"), mensagem: `Descartar ${ids.length} pendências? Elas vão para o Arquivo.`, rotuloAcao: `Descartar ${ids.length}`, destrutiva: true });
      if (!ok) return;
    }
    const focoAntes = E.foco;
    const prox = ids.includes(focoAntes) ? (vizinho(focoAntes, 1) !== focoAntes ? vizinho(focoAntes, 1) : vizinho(focoAntes, -1)) : null;
    if (E.abertaId && ids.includes(E.abertaId)) Mesa.gaveta.fechar({ semFoco: true });
    await Q.moverPara(ids, "descartada");
    E.selecao.clear();
    Q.render();
    requestAnimationFrame(() => { if (prox && !ids.includes(prox)) Q.focar(prox); else Q.focar(null); });
  };
  Q.copiarReferencia = (id) => { const i = E.porId.get(id); if (i) n.copiar(`${n.ref(id)} ${i.titulo}`, "Referência copiada."); };
  Q.linkDe = (id) => `${location.origin}/#/quadro?p=${n.num(id)}`;
  Q.copiarLink = (id) => n.copiar(Q.linkDe(id), "Link copiado.");
  Q.menuPrioridade = (id, ancora) => {
    const i = E.porId.get(id);
    if (!i) return;
    n.menu(ancora, n.PRIORIDADES.map((p) => ({ tipo: "radio", rotulo: p.nome, iconeEl: n.iconePrio(p.v), marcado: i.prioridade === p.v, acao: () => { if (p.v !== i.prioridade) n.mudar(id, { prioridade: p.v }, { toast: `${n.ref(id)}: prioridade ${p.nome}.` }).catch(() => {}); } })), { rotulo: "Prioridade", devolverFoco: true });
  };
  Q.menuArea = (id, ancora) => {
    const i = E.porId.get(id);
    if (!i) return;
    n.menu(ancora, n.AREAS.map((a) => ({ tipo: "radio", rotulo: a.nome, sq: a, marcado: i.area === a.nome, acao: () => { if (a.nome !== i.area) n.mudar(id, { area: a.nome }, { toast: `Área: ${i.area} → ${a.nome}.` }).catch(() => {}); } })), { rotulo: "Área", filtro: n.AREAS.length > 9 });
  };
  /* Ao mandar para Aguardando: de quem é a bola e quando puxar de volta.
     É o único lugar em que o quadro pergunta algo — sem isso a coluna Aguardando vira um limbo,
     e foi assim que pendência ficou parada semanas sem ninguém notar. Pular é um clique. */
  function perguntarAguardando(id, ancora) {
    const item = E.porId.get(id);
    if (!item || item.status !== "aguardando" || !n.podeEscrever()) return;
    const h0 = n.hoje();
    const sexta = n.somaDias(h0, (5 - n.diaSemana(h0) + 7) % 7 || 7);
    let quando = item.cobrar_em || n.somaDias(h0, 3);
    const input = h("input", { type: "text", "aria-label": "Quem está com a bola", placeholder: "Nome", autocomplete: "off", maxlength: "120" });
    input.value = item.aguardando_de || n.pessoasDe(item)[0] || "";
    const sug = h("div", { c: "pop-lista", role: "listbox" });
    const prazos = h("div", { c: "atalhos-prazo" });
    const previa = h("div", { c: "previa", "aria-live": "polite" });
    const OPCOES = [["Em 2 dias", n.somaDias(h0, 2)], ["Em 3 dias", n.somaDias(h0, 3)], [`Sex ${n.ddmm(sexta)}`, sexta], ["Em 1 semana", n.somaDias(h0, 7)], ["Sem cobrança", ""]];
    function desenharPrazos() {
      limpar(prazos);
      for (const [rot, v] of OPCOES) {
        prazos.append(h("button", { type: "button", c: v === quando ? "sel" : "", "aria-pressed": String(v === quando), t: rot,
          on: { click: () => { quando = v; desenharPrazos(); } } }));
      }
      previa.textContent = quando ? `Volta a aparecer como "cobrar" em ${n.dataComSemana(quando)}.` : "Sem lembrete: ela só aparece pelo prazo.";
    }
    function desenharSug() {
      limpar(sug);
      const q = n.norm(input.value.trim());
      const nomes = Q.pessoasDaBase().filter((p) => !q || n.norm(p).includes(q)).slice(0, 4);
      for (const p of nomes) sug.append(h("button", { type: "button", c: "menu-item", role: "option", on: { click: () => { input.value = p; desenharSug(); input.focus(); } } }, n.avatar(n.nomeCurto(p), true), h("span", { c: "rot", t: p })));
    }
    const salvar = () => {
      pop.fechar(true);
      const de = input.value.trim();
      if (de === (item.aguardando_de || "") && quando === (item.cobrar_em || "")) return;
      const partes = [];
      if (de) partes.push(`aguardando ${n.nomeCurto(de)}`);
      if (quando) partes.push(`cobrar ${n.ddmm(quando)}`);
      n.mudar(id, { aguardando_de: de, cobrar_em: quando },
        { toast: `${n.ref(id)}: ${partes.join(", ") || "sem cobrança marcada"}.` }).catch(() => {});
    };
    input.addEventListener("input", desenharSug);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); salvar(); } });
    desenharSug();
    desenharPrazos();
    const pop = n.popover(ancora, h("div", { c: "pop-aguardando" },
      h("p", { c: "pop-aguardando-tit", t: "Esperando quem?" }),
      input, sug,
      h("p", { c: "t-meta texto-2", t: "Lembrar de cobrar" }), prazos, previa,
      h("div", { c: "pop-acoes" },
        h("button", { type: "button", c: "btn btn-28", t: "Agora não", on: { click: () => pop.fechar() } }),
        h("button", { type: "button", c: "btn btn-28 btn-primario", t: "Salvar", on: { click: salvar } }))),
      { rotulo: "Aguardando quem", foco: "input" });
  }
  Q.perguntarAguardando = perguntarAguardando;
  Q.menuStatus = (id, ancora) => {
    const i = E.porId.get(id);
    if (!i) return;
    n.menu(ancora, n.COLUNAS.map((c, k) => ({ tipo: "radio", rotulo: n.STATUS_NOME[c.status], iconeEl: n.iconeStatus(c.status), marcado: i.status === c.status, kbd: String(k + 1), acao: () => { if (c.status !== i.status) Q.moverPara([id], c.status); } })), { rotulo: "Status" });
  };
  Q.prazo = (id, ancora) => {
    const i = E.porId.get(id);
    if (!i) return;
    n.seletorPrazo(ancora, i.prazo, (v) => {
      if (v === i.prazo) return;
      n.mudar(id, { prazo: v }, { toast: v ? `${n.ref(id)}: prazo ${n.dataComSemana(v)}.` : `${n.ref(id)} ficou sem prazo.` }).catch(() => {});
    });
  };
  Q.menuCartao = (id, ancora, ponto) => {
    const i = E.porId.get(id);
    if (!i) return;
    const ids = E.selecao.has(id) && E.selecao.size > 1 ? [...E.selecao] : [id];
    const agenteOk = !!E.recursos.agente;
    const leitura = !n.podeEscrever();
    const semAg = "O agente ainda não está ligado neste servidor.";
    n.menu(ancora, [
      { rotulo: "Abrir", kbd: "Enter", acao: () => Mesa.gaveta.abrir(id, { via: "push", focarTitulo: true }) },
      { rotulo: "Editar título", kbd: "F2", desabilitado: leitura, acao: () => Mesa.gaveta.abrir(id, { via: "push", acao: "titulo" }) },
      { separador: true },
      { rotulo: "Mover para", desabilitado: leitura, sub: () => [
        ...n.COLUNAS.map((c, k) => ({ rotulo: c.nome, iconeEl: n.iconeStatus(c.status), kbd: ["Shift", String(k + 1)], desabilitado: c.status === i.status && ids.length === 1, acao: () => Q.moverPara(ids, c.status) })),
        { separador: true },
        { rotulo: "Topo da coluna", desabilitado: i.status === "feita", acao: () => n.moverVarias([{ id, status: i.status, posicao: 0 }], { rotulo: `${n.ref(id)} foi para o topo de ${n.STATUS_NOME[i.status]}.` }).catch(() => {}) },
        { rotulo: "Fim da coluna", desabilitado: i.status === "feita", acao: () => n.moverVarias([{ id, status: i.status, posicao: 9999 }], { rotulo: `${n.ref(id)} foi para o fim de ${n.STATUS_NOME[i.status]}.` }).catch(() => {}) }] },
      { rotulo: "Prioridade", kbd: "P", desabilitado: leitura, sub: () => n.PRIORIDADES.map((p) => ({ tipo: "radio", rotulo: p.nome, iconeEl: n.iconePrio(p.v), marcado: i.prioridade === p.v, acao: () => (ids.length > 1 ? mudarVarias(ids, { prioridade: p.v }, `Prioridade de ${ids.length} pendências: ${p.nome}.`) : n.mudar(id, { prioridade: p.v }, { toast: `${n.ref(id)}: prioridade ${p.nome}.` }).catch(() => {})) })) },
      { rotulo: "Prazo…", kbd: "D", desabilitado: leitura, acao: () => Q.prazo(id, Q.elDe(id) || ancora) },
      { rotulo: "Pedido por…", kbd: "Q", desabilitado: leitura, acao: () => Mesa.gaveta.abrir(id, { via: "push", acao: "pessoa" }) },
      { rotulo: "Área", kbd: ["Shift", "P"], desabilitado: leitura, sub: () => n.AREAS.map((a) => ({ tipo: "radio", rotulo: a.nome, sq: a, marcado: i.area === a.nome, acao: () => (ids.length > 1 ? mudarVarias(ids, { area: a.nome }, `Área de ${ids.length} pendências: ${a.nome}.`) : n.mudar(id, { area: a.nome }, { toast: `Área: ${i.area} → ${a.nome}.` }).catch(() => {})) })) },
      { rotulo: "Projeto…", desabilitado: leitura, acao: () => Mesa.gaveta.abrir(id, { via: "push", acao: "projeto" }) },
      { separador: true },
      { rotulo: "Preparar briefing", icone: "i-briefing", kbd: "B", desabilitado: !agenteOk || leitura, dica: agenteOk ? null : semAg, acao: () => Mesa.gaveta.abrir(id, { via: "push", aba: "agente", acao: "briefing" }) },
      { rotulo: "Rascunhar resposta", icone: "i-draft", kbd: "M", desabilitado: !agenteOk || leitura, dica: agenteOk ? null : semAg, acao: () => Mesa.gaveta.abrir(id, { via: "push", aba: "agente", acao: "rascunho" }) },
      { rotulo: "Executar tarefa", icone: "i-run", kbd: ["Shift", "E"], desabilitado: !agenteOk || leitura, dica: agenteOk ? null : semAg, acao: () => Mesa.gaveta.abrir(id, { via: "push", aba: "agente", acao: "executar" }) },
      { separador: true },
      { rotulo: "Copiar referência", icone: "i-copy", kbd: ["Ctrl", "C"], acao: () => Q.copiarReferencia(id) },
      { rotulo: "Copiar link", icone: "i-link", acao: () => Q.copiarLink(id) },
      { separador: true },
      { rotulo: ids.length > 1 ? `Descartar ${ids.length}` : "Descartar", icone: "i-discard", kbd: "Delete", perigo: true, desabilitado: leitura, acao: () => Q.descartar(ids) },
    ], { rotulo: `Ações de ${n.ref(id)}`, ponto });
  };

  // ------------------------------------------------------------------ seleção
  Q.alternarSelecao = (id) => {
    if (E.selecao.has(id)) E.selecao.delete(id); else E.selecao.add(id);
    anunciarSelecao();
    Q.render();
  };
  Q.limparSelecao = () => { if (!E.selecao.size) return false; E.selecao.clear(); anunciarSelecao(); Q.render(); return true; };
  function anunciarSelecao() { const k = E.selecao.size; n.anunciar(k ? `${k} ${n.plural(k, "selecionada", "selecionadas")}` : "Seleção limpa"); }
  function selecionarIntervalo(id) {
    const g = grade();
    const col = g.find((c) => c.includes(id));
    if (!col) return;
    const ancora = [...E.selecao].reverse().find((s) => col.includes(s)) || E.foco;
    const a = col.indexOf(ancora), b = col.indexOf(id);
    if (a < 0) { E.selecao.add(id); }
    else for (let k = Math.min(a, b); k <= Math.max(a, b); k++) E.selecao.add(col[k]);
    anunciarSelecao();
    Q.render();
  }

  // ------------------------------------------------------------------ movimentos pelo teclado
  function moverRelativo(id, dir) {
    const i = E.porId.get(id);
    if (!i || !n.podeEscrever()) return;
    const idx = n.COLUNAS.findIndex((c) => c.status === i.status);
    const alvo = n.COLUNAS[idx + dir];
    if (!alvo) return;
    const viz = colunaVizinha(id, dir);
    let posicao = 0;
    if (viz && viz.id) {
      const outro = E.porId.get(viz.id);
      if (outro && outro.status === alvo.status) posicao = Math.max(0, colunaServidor(alvo.status).indexOf(outro));
    }
    otimista([{ id, status: alvo.status, posicao }]);
    Q.moverPara([id], alvo.status, { posicao }).then(() => requestAnimationFrame(() => Q.focar(id)));
    requestAnimationFrame(() => Q.focar(id));
  }
  function reordenar(id, delta) {
    const i = E.porId.get(id);
    if (!i || !n.podeEscrever() || i.status === "feita" || ordemColuna(i.status) !== "manual") return;
    const col = colunaServidor(i.status);
    const k = col.indexOf(i);
    const novo = Math.max(0, Math.min(col.length - 1, k + delta));
    if (novo === k) return;
    otimista([{ id, status: i.status, posicao: novo }]);
    n.moverVarias([{ id, status: i.status, posicao: novo }], { rotulo: `${n.ref(id)} mudou de posição.`, anuncio: `${n.STATUS_NOME[i.status]}, posição ${novo + 1} de ${col.length}.` }).catch(() => {}).then(() => requestAnimationFrame(() => Q.focar(id)));
    requestAnimationFrame(() => Q.focar(id));
  }
  function trocarRaia(id, dir) {
    if (!E.raias) return;
    const i = E.porId.get(id);
    const raias = raiasOrdenadas(E.itens.filter(visivel));
    const k = raias.findIndex((r) => r.k === chaveRaia(i));
    const alvo = raias[k + dir];
    if (!alvo) return;
    const campos = E.raias === "area" ? { area: alvo.k } : { projeto_id: alvo.k };
    n.mudar(id, campos, { toast: E.raias === "area" ? `Área: ${i.area} → ${alvo.k}.` : `Projeto: ${n.nomeProjeto(i.projeto_id) || "sem projeto"} → ${nomeRaia(alvo.k)}.` }).then(() => requestAnimationFrame(() => Q.focar(id))).catch(() => {});
  }
  /* Atualização otimista local (antes da resposta do servidor). */
  function otimista(movs) {
    for (const m of movs) {
      const i = E.porId.get(m.id);
      if (!i) continue;
      const col = colunaServidor(m.status, new Set(movs.map((x) => x.id)));
      const antes = col[m.posicao - 1], depois = col[m.posicao];
      i.status = m.status;
      i.ordem = antes && depois ? (antes.ordem + depois.ordem) / 2 : antes ? antes.ordem + 5 : depois ? depois.ordem - 5 : 10;
      if (m.campos) Object.assign(i, m.campos);
    }
    Q.render();
  }

  // ------------------------------------------------------------------ pegar e soltar pelo teclado
  function levantar(id) {
    const i = E.porId.get(id);
    if (!i || !n.podeEscrever()) return;
    const col = grade().find((c) => c.includes(id)) || [];
    levantado = { id, statusOrig: i.status, ordemOrig: i.ordem, status: i.status, idx: col.indexOf(id) };
    const el = Q.elDe(id);
    if (el) el.classList.add("levantado");
    n.anunciar(`Pegou ${n.ref(id)}. ${n.STATUS_NOME[i.status]}, posição ${levantado.idx + 1} de ${col.length}. Setas movem, Espaço solta, Esc cancela.`, true);
  }
  function moverLevantado(tecla) {
    const L = levantado;
    const el = Q.elDe(L.id);
    if (!el) return;
    let ci = n.COLUNAS.findIndex((c) => c.status === L.status);
    if (tecla === "ArrowLeft" || tecla === "ArrowRight") {
      const nci = ci + (tecla === "ArrowLeft" ? -1 : 1);
      if (nci < 0 || nci >= n.COLUNAS.length) return;
      ci = nci; L.status = n.COLUNAS[ci].status;
    }
    const lista = $(`#quadro .col-lista[data-status="${L.status}"]`);
    if (!lista) return;
    const irmaos = $$(":scope > li[data-id]", lista).filter((x) => x !== el);
    if (tecla === "ArrowUp") L.idx = Math.max(0, L.idx - 1);
    else if (tecla === "ArrowDown") L.idx = Math.min(irmaos.length, L.idx + 1);
    else L.idx = Math.min(L.idx, irmaos.length);
    lista.insertBefore(el, irmaos[L.idx] || null);
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
    n.anunciar(`${n.COLUNAS[ci].nome}, posição ${L.idx + 1} de ${irmaos.length + 1}.`);
  }
  function soltarLevantado() {
    const L = levantado;
    levantado = null;
    const el = Q.elDe(L.id);
    if (el) el.classList.remove("levantado");
    const lista = $(`#quadro .col-lista[data-status="${L.status}"]`);
    const irmaos = lista ? $$(":scope > li[data-id]", lista).filter((x) => x.dataset.id !== L.id) : [];
    const posicao = calcularPosicao(L.status, irmaos.map((x) => x.dataset.id), L.idx, new Set([L.id]));
    n.anunciar(`Soltou em ${n.COLUNAS.find((c) => c.status === L.status).nome}, posição ${L.idx + 1}.`, true);
    if (L.status === L.statusOrig && posicao === colunaServidor(L.status).findIndex((x) => x.id === L.id)) { Q.render(true); return; }
    otimista([{ id: L.id, status: L.status, posicao }]);
    const mover = L.status !== L.statusOrig ? Q.moverPara([L.id], L.status, { posicao }) : n.moverVarias([{ id: L.id, status: L.status, posicao }], { rotulo: `${n.ref(L.id)} mudou de posição.` }).catch(() => {});
    Promise.resolve(mover).then(() => requestAnimationFrame(() => Q.focar(L.id)));
    requestAnimationFrame(() => Q.focar(L.id));
  }
  function cancelarLevantado() {
    const L = levantado;
    levantado = null;
    const el = Q.elDe(L.id);
    if (el) el.classList.remove("levantado");
    chaveEstrutura = "";
    Q.render(true);
    requestAnimationFrame(() => Q.focar(L.id));
    n.anunciar("Movimento cancelado.", true);
  }
  /* posição no /mover a partir da posição visual entre cartões visíveis */
  function calcularPosicao(status, idsVisiveis, idx, mov) {
    if (status === "feita" || ordemColuna(status) !== "manual") return 0;
    const col = colunaServidor(status, mov);
    const ids = col.map((i) => i.id);
    if (idx < idsVisiveis.length) { const k = ids.indexOf(idsVisiveis[idx]); return k < 0 ? 0 : k; }
    if (idsVisiveis.length) { const k = ids.indexOf(idsVisiveis[idsVisiveis.length - 1]); return k < 0 ? col.length : k + 1; }
    return 0;
  }

  // ------------------------------------------------------------------ teclado no quadro e na lista
  function tecladoItem(ev, id, el) {
    const k = ev.key, ctrl = ev.ctrlKey || ev.metaKey, shift = ev.shiftKey, umaTecla = !ctrl && !ev.altKey;
    const lista = E.modo === "lista";
    if (levantado) {
      ev.preventDefault();
      if (k === "Escape") cancelarLevantado();
      else if (k === " " || k === "Enter") soltarLevantado();
      else if (/^Arrow/.test(k)) moverLevantado(k);
      return true;
    }
    if (k === "Enter" && !ctrl) { ev.preventDefault(); Mesa.gaveta.abrir(id, { via: "push", focarTitulo: true }); return true; }
    if (k === "F2") { ev.preventDefault(); Mesa.gaveta.abrir(id, { via: "push", acao: "titulo" }); return true; }
    if ((k === "ArrowDown" || (umaTecla && !shift && k === "j" && atalhosLigados())) && !ctrl) {
      ev.preventDefault();
      const p = vizinho(id, 1);
      if (shift && p) { E.selecao.add(id); E.selecao.add(p); anunciarSelecao(); Q.render(); }
      if (p) Q.focar(p, { teclado: true });
      return true;
    }
    if ((k === "ArrowUp" || (umaTecla && !shift && k === "k" && atalhosLigados())) && !ctrl) {
      ev.preventDefault();
      const p = vizinho(id, -1);
      if (shift && p) { E.selecao.add(id); E.selecao.add(p); anunciarSelecao(); Q.render(); }
      if (p) Q.focar(p, { teclado: true });
      return true;
    }
    if ((k === "ArrowLeft" || k === "ArrowRight") && !ctrl && !lista) {
      ev.preventDefault();
      const v = colunaVizinha(id, k === "ArrowLeft" ? -1 : 1);
      if (v && v.id) Q.focar(v.id, { teclado: true });
      else if (v && v.lista) focarLista(v.lista);
      else if (v && v.trilho) v.trilho.focus();
      return true;
    }
    if (k === "Home" || k === "End") {
      ev.preventDefault();
      const g = ctrl ? [Q.ordemVisivel()] : grade().filter((c) => c.includes(id));
      const col = g[0] || [];
      if (col.length) Q.focar(k === "Home" ? col[0] : col[col.length - 1], { teclado: true });
      return true;
    }
    if (k === "PageDown" || k === "PageUp") { ev.preventDefault(); const p = vizinho(id, k === "PageDown" ? 5 : -5); if (p) Q.focar(p, { teclado: true }); return true; }
    if (ctrl && !shift && (k === "ArrowLeft" || k === "ArrowRight") && !lista) { ev.preventDefault(); moverRelativo(id, k === "ArrowLeft" ? -1 : 1); return true; }
    if (ctrl && !shift && (k === "ArrowUp" || k === "ArrowDown") && !lista) { ev.preventDefault(); reordenar(id, k === "ArrowUp" ? -1 : 1); return true; }
    if (ctrl && shift && (k === "ArrowUp" || k === "ArrowDown") && !lista) { ev.preventDefault(); trocarRaia(id, k === "ArrowUp" ? -1 : 1); return true; }
    if (shift && !ctrl && !ev.altKey && /^Digit[1-4]$/.test(ev.code)) {
      ev.preventDefault();
      const c = n.COLUNAS[Number(ev.code.slice(5)) - 1];
      const ids = E.selecao.has(id) && E.selecao.size > 1 ? [...E.selecao] : [id];
      Q.moverPara(ids, c.status).then(() => requestAnimationFrame(() => Q.focar(id)));
      return true;
    }
    if (ctrl && !shift && (k === "c" || k === "C")) {
      const sel = window.getSelection && String(window.getSelection());
      if (!sel) { ev.preventDefault(); Q.copiarReferencia(id); return true; }
      return false;
    }
    if (ctrl && !shift && (k === "a" || k === "A") && !lista) {
      ev.preventDefault();
      const col = grade().find((c) => c.includes(id)) || [];
      for (const x of col) E.selecao.add(x);
      anunciarSelecao(); Q.render();
      return true;
    }
    if (k === "Delete") { ev.preventDefault(); Q.descartar(E.selecao.has(id) && E.selecao.size > 1 ? [...E.selecao] : [id]); return true; }
    if ((shift && k === "F10") || k === "ContextMenu") { ev.preventDefault(); Q.menuCartao(id, el); return true; }
    if (k === " " && !ctrl && !lista) { ev.preventDefault(); levantar(id); return true; }
    if (k === " " && lista) { ev.preventDefault(); Q.alternarSelecao(id); return true; }
    if (k === "Escape" && E.selecao.size) { ev.preventDefault(); Q.limparSelecao(); return true; }
    if (!umaTecla || !atalhosLigados()) return false;
    const letra = k.length === 1 ? k.toLowerCase() : "";
    if (letra === "x" && !shift) { ev.preventDefault(); Q.alternarSelecao(id); return true; }
    if (letra === "p" && !shift) { ev.preventDefault(); Q.menuPrioridade(id, el); return true; }
    if (letra === "p" && shift) { ev.preventDefault(); Q.menuArea(id, el); return true; }
    if (letra === "d" && !shift) { ev.preventDefault(); Q.prazo(id, el); return true; }
    if (letra === "q" && !shift) { ev.preventDefault(); Mesa.gaveta.abrir(id, { via: "push", acao: "pessoa" }); return true; }
    if (letra === "b" && !shift) { ev.preventDefault(); Mesa.gaveta.abrir(id, { via: "push", aba: "agente", acao: "foco-briefing" }); return true; }
    if (letra === "m" && !shift) { ev.preventDefault(); Mesa.gaveta.abrir(id, { via: "push", aba: "agente", acao: "foco-rascunho" }); return true; }
    if (letra === "e" && shift) { ev.preventDefault(); Mesa.gaveta.abrir(id, { via: "push", aba: "agente", acao: "executar" }); return true; }
    return false;
  }
  Q.tecladoItem = tecladoItem;

  // ------------------------------------------------------------------ arrastar e soltar (Pointer Events)
  function iniciarPossivelArraste(ev, li) {
    if (ev.button !== 0 || !(ev.pointerType === "mouse" || ev.pointerType === "pen") || !n.podeEscrever() || window.innerWidth < 720) return;
    if (ev.target.closest("[data-alvo]") || ev.ctrlKey || ev.shiftKey || ev.metaKey) return;
    arraste = { id: li.dataset.id, li, x0: ev.clientX, y0: ev.clientY, pid: ev.pointerId, iniciado: false };
    window.addEventListener("pointermove", aoMover);
    window.addEventListener("pointerup", aoSoltar);
    window.addEventListener("pointercancel", cancelarArraste);
  }
  function comecarArraste(ev) {
    const A = arraste;
    const r = A.li.getBoundingClientRect();
    A.iniciado = true;
    A.ids = E.selecao.has(A.id) && E.selecao.size > 1 ? Q.ordemVisivel().filter((id) => E.selecao.has(id)) : [A.id];
    A.dx = ev.clientX - r.left; A.dy = ev.clientY - r.top;
    const f = A.li.cloneNode(true);
    f.removeAttribute("id");
    for (const x of f.querySelectorAll("[id]")) x.removeAttribute("id");
    f.classList.add("fantasma");
    if (A.ids.length > 1) { f.classList.add("multi"); f.append(h("span", { c: "fantasma-selo num", t: String(A.ids.length) })); }
    A.destinoEl = h("span", { c: "fantasma-destino", hidden: true });
    f.append(A.destinoEl);
    f.style.width = r.width + "px";
    f.setAttribute("aria-hidden", "true");
    document.body.append(f);
    A.fantasma = f;
    for (const id of A.ids) { const el = Q.elDe(id); if (el) el.classList.add("origem-arraste"); }
    document.body.classList.add("arrastando");
    try { A.li.setPointerCapture(A.pid); } catch (e) { /* segue */ }
    A.linha = $("#arraste-linha");
    medirAlvos();
    $("#quadro").addEventListener("scroll", medirAlvos, true);
    A.loop = requestAnimationFrame(rolagemAuto);
    n.fecharMenus();
  }
  function medirAlvos() {
    const A = arraste;
    if (!A) return;
    A.alvos = [];
    for (const l of $$("#quadro .col-lista")) {
      const cont = l.closest(".col") || l;
      if (l.classList.contains("recolhida")) { A.alvos.push({ el: l, cx: l, r: l.getBoundingClientRect(), status: l.dataset.status, raia: l.dataset.raia, tipo: "trilho" }); continue; }
      A.alvos.push({ el: l, cx: cont, r: cont.getBoundingClientRect(), status: l.dataset.status, raia: l.dataset.raia, tipo: "lista" });
    }
    for (const t of $$("#quadro .col.recolhida")) A.alvos.push({ el: t, cx: t, r: t.getBoundingClientRect(), status: t.dataset.status, tipo: "trilho" });
    const arq = $("#nav-arquivo");
    if (arq && arq.offsetParent) A.alvos.push({ el: arq, cx: arq, r: arq.getBoundingClientRect(), tipo: "arquivo" });
  }
  function aoMover(ev) {
    const A = arraste;
    if (!A) return;
    if (!A.iniciado) {
      if (Math.hypot(ev.clientX - A.x0, ev.clientY - A.y0) < 4) return;
      comecarArraste(ev);
    }
    A.x = ev.clientX; A.y = ev.clientY;
    A.fantasma.style.transform = `translate3d(${ev.clientX - A.dx}px,${ev.clientY - A.dy}px,0)`;
    atualizarAlvo();
  }
  function atualizarAlvo() {
    const A = arraste;
    let alvo = null;
    for (const a of A.alvos) if (A.x >= a.r.left && A.x <= a.r.right && A.y >= a.r.top && A.y <= a.r.bottom) { alvo = a; if (a.tipo === "lista" && a.el.classList.contains("raia-celula")) { const rc = a.el.getBoundingClientRect(); if (A.y >= rc.top && A.y <= rc.bottom) break; } else break; }
    if (alvo && alvo.el.classList.contains("raia-celula")) {
      // nas raias o alvo é a célula exata
      alvo = A.alvos.find((a) => a.el.classList.contains("raia-celula") && (() => { const rc = a.el.getBoundingClientRect(); return A.x >= rc.left && A.x <= rc.right && A.y >= rc.top - 4 && A.y <= rc.bottom + 4; })()) || null;
    }
    if (A.alvo && A.alvo !== alvo) { A.alvo.cx.classList.remove("alvo"); A.alvo.el.classList.remove("alvo", "alvo-soltar"); }
    A.alvo = alvo;
    A.linha.hidden = true;
    A.destinoEl.hidden = true;
    if (!alvo) return;
    if (alvo.tipo === "arquivo") { alvo.el.classList.add("alvo-soltar"); A.destinoEl.hidden = false; A.destinoEl.textContent = "→ Arquivo"; return; }
    (alvo.el.classList.contains("raia-celula") ? alvo.el : alvo.cx).classList.add("alvo");
    if (alvo.raia != null && E.raias) {
      const atual = chaveRaia(E.porId.get(A.id));
      if (alvo.raia !== atual) { A.destinoEl.hidden = false; A.destinoEl.textContent = "→ " + nomeRaia(alvo.raia); }
    }
    if (alvo.tipo !== "lista") return;
    const cards = $$(":scope > li[data-id]", alvo.el).filter((x) => !A.ids.includes(x.dataset.id));
    let idx = cards.length;
    for (let k = 0; k < cards.length; k++) { const r = cards[k].getBoundingClientRect(); if (r.top + r.height / 2 > A.y) { idx = k; break; } }
    A.idx = idx;
    A.visiveis = cards.map((x) => x.dataset.id);
    const ref = cards[idx] || cards[idx - 1];
    const lr = alvo.el.getBoundingClientRect();
    let y;
    if (!cards.length) y = lr.top + 4;
    else if (cards[idx]) y = cards[idx].getBoundingClientRect().top - 4;
    else y = ref.getBoundingClientRect().bottom + 2;
    const manualOk = alvo.status !== "feita" && ordemColuna(alvo.status) === "manual";
    if (!manualOk) return;
    A.linha.hidden = false;
    A.linha.style.left = (lr.left + 6) + "px";
    A.linha.style.width = Math.max(40, lr.width - 12) + "px";
    A.linha.style.top = y + "px";
  }
  function rolagemAuto() {
    const A = arraste;
    if (!A || !A.iniciado) return;
    if (A.alvo && A.alvo.tipo === "lista") {
      const rol = A.alvo.el.closest(".col-rolagem") || $("#quadro");
      const r = rol.getBoundingClientRect();
      const zona = 48;
      if (A.y < r.top + zona) rol.scrollTop -= ((zona - (A.y - r.top)) / zona) * 12;
      else if (A.y > r.bottom - zona) rol.scrollTop += ((zona - (r.bottom - A.y)) / zona) * 12;
    }
    const q = $("#quadro"), rq = q.getBoundingClientRect();
    if (A.x < rq.left + 64) q.scrollLeft -= ((64 - (A.x - rq.left)) / 64) * 12;
    else if (A.x > rq.right - 64) q.scrollLeft += ((64 - (rq.right - A.x)) / 64) * 12;
    A.loop = requestAnimationFrame(rolagemAuto);
  }
  function limparArraste() {
    const A = arraste;
    window.removeEventListener("pointermove", aoMover);
    window.removeEventListener("pointerup", aoSoltar);
    window.removeEventListener("pointercancel", cancelarArraste);
    if (!A) return;
    cancelAnimationFrame(A.loop);
    $("#quadro").removeEventListener("scroll", medirAlvos, true);
    if (A.fantasma) A.fantasma.remove();
    if (A.linha) A.linha.hidden = true;
    if (A.alvo) { A.alvo.cx.classList.remove("alvo"); A.alvo.el.classList.remove("alvo", "alvo-soltar"); }
    for (const el of $$(".origem-arraste")) el.classList.remove("origem-arraste");
    document.body.classList.remove("arrastando");
    A.terminado = true;
    setTimeout(() => { arraste = null; Q.retomarDesenho(); }, 0);
  }
  function cancelarArraste() { if (arraste) { arraste.cancelado = true; limparArraste(); Q.render(); } }
  Q.cancelarArraste = () => { if (arraste && arraste.iniciado) { cancelarArraste(); return true; } return false; };
  function aoSoltar(ev) {
    const A = arraste;
    if (!A) return;
    if (!A.iniciado) { limparArraste(); arraste = null; return; }
    atualizarAlvo();
    const alvo = A.alvo, ids = A.ids;
    limparArraste();
    A.arrastou = true;
    Q.ultimoArraste = Date.now();
    if (!alvo) { Q.render(); return; }
    if (alvo.tipo === "arquivo") { Q.descartar(ids); return; }
    const status = alvo.status;
    const mov = new Set(ids);
    const posicao = alvo.tipo === "trilho" ? 0 : calcularPosicao(status, A.visiveis || [], A.idx || 0, mov);
    const item = E.porId.get(A.id);
    let campos = null;
    if (E.raias && alvo.raia != null && alvo.raia !== chaveRaia(item)) campos = E.raias === "area" ? { area: alvo.raia } : { projeto_id: alvo.raia };
    const mesmaPos = ids.length === 1 && status === item.status && !campos && posicao === colunaServidor(status).findIndex((x) => x.id === A.id);
    if (mesmaPos) { Q.render(); return; }
    const movs = ids.map((id, k) => ({ id, status, posicao: posicao + k, campos }));
    const snapshot = ids.map((id) => { const i = E.porId.get(id); return { id, status: i.status, ordem: i.ordem, area: i.area, projeto_id: i.projeto_id }; });
    otimista(movs);
    const nomeCol = n.COLUNAS.find((c) => c.status === status).nome;
    let rotulo;
    if (ids.length > 1) rotulo = `${ids.length} pendências movidas para ${nomeCol}.`;
    else if (status !== snapshot[0].status) rotulo = `${n.ref(A.id)} foi para ${nomeCol}.` + (campos ? ` ${E.raias === "area" ? "Área" : "Projeto"}: ${nomeRaia(alvo.raia)}.` : "");
    else if (campos) rotulo = E.raias === "area" ? `Área: ${snapshot[0].area} → ${alvo.raia}.` : `Projeto: ${nomeRaia(snapshot[0].projeto_id)} → ${nomeRaia(alvo.raia)}.`;
    else rotulo = `${n.ref(A.id)} mudou de posição.`;
    const desfeito = ids.length === 1 ? `Desfeito: ${n.ref(A.id)} voltou para ${n.COLUNAS.find((c) => c.status === snapshot[0].status).nome}.` : `Desfeito: ${ids.length} pendências voltaram.`;
    const movsServidor = movs.map((m) => ({ id: m.id, status: m.status, posicao: m.posicao, campos: m.campos }));
    n.moverVarias(movsServidor, { rotulo, rotuloDesfeito: desfeito, tentar: () => n.moverVarias(movsServidor, { rotulo, rotuloDesfeito: desfeito }).catch(() => {}) })
      .catch(() => { for (const s of snapshot) { const i = E.porId.get(s.id); if (i) Object.assign(i, s); } Q.render(); n.recarregar(); });
    if (status === "aguardando" && ids.length === 1 && snapshot[0].status !== "aguardando") {
      const el = Q.elDe(ids[0]);
      if (el) requestAnimationFrame(() => perguntarAguardando(ids[0], el));
    }
  }

  // ------------------------------------------------------------------ eventos do quadro
  function ligarEventos() {
    const qd = $("#quadro");
    qd.addEventListener("pointerdown", (ev) => {
      const li = ev.target.closest("li[data-id]");
      if (li && qd.contains(li)) iniciarPossivelArraste(ev, li);
    });
    qd.addEventListener("click", (ev) => {
      const li = ev.target.closest("li[data-id]");
      if (!li || (Q.ultimoArraste && Date.now() - Q.ultimoArraste < 300)) return;
      const id = li.dataset.id;
      const alvo = ev.target.closest("[data-alvo]");
      if (alvo && alvo.dataset.alvo === "menu") { ev.stopPropagation(); Q.menuCartao(id, alvo); return; }
      if (ev.ctrlKey || ev.metaKey) { Q.alternarSelecao(id); E.foco = id; Q.focar(id); return; }
      if (ev.shiftKey) { selecionarIntervalo(id); E.foco = id; Q.focar(id); return; }
      if (alvo && alvo.dataset.alvo === "contexto") { Mesa.gaveta.abrir(id, { via: "push", aba: "contexto" }); return; }
      if (alvo && alvo.dataset.alvo === "agente") { Mesa.gaveta.abrir(id, { via: "push", aba: "agente" }); return; }
      if (E.selecao.size && !E.selecao.has(id)) E.selecao.clear();
      E.foco = id;
      Mesa.gaveta.abrir(id, { via: "push" });
      Q.focar(id);
    });
    qd.addEventListener("dblclick", (ev) => {
      const t = ev.target.closest(".card-titulo,.lf-titulo");
      const li = ev.target.closest("li[data-id]");
      if (t && li) Mesa.gaveta.abrir(li.dataset.id, { via: "push", acao: "titulo" });
    });
    qd.addEventListener("contextmenu", (ev) => {
      const li = ev.target.closest("li[data-id]");
      if (!li || ev.shiftKey) return;
      ev.preventDefault();
      E.foco = li.dataset.id;
      Q.menuCartao(li.dataset.id, li, { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY });
    });
    let toque = 0;
    qd.addEventListener("touchstart", (ev) => {
      const li = ev.target.closest("li[data-id]");
      if (!li) return;
      clearTimeout(toque);
      toque = setTimeout(() => { E.foco = li.dataset.id; Q.menuCartao(li.dataset.id, li); }, 400);
    }, { passive: true });
    for (const tipo of ["touchend", "touchmove", "touchcancel"]) qd.addEventListener(tipo, () => clearTimeout(toque), { passive: true });
    qd.addEventListener("focusin", (ev) => {
      const li = ev.target.closest("li[data-id]");
      if (li) {
        E.foco = li.dataset.id;
        const lst = li.closest(".col-lista");
        if (lst) Q.colunaFoco = lst.dataset.status;
        if (navTeclado) seguirFoco(li.dataset.id);
        navTeclado = false;
      } else if (ev.target.classList && ev.target.classList.contains("col-lista")) Q.colunaFoco = ev.target.dataset.status;
    });
    qd.addEventListener("keydown", (ev) => {
      if (n.ehCampo(ev.target)) return;
      const li = ev.target.closest("li[data-id]");
      if (li) { if (tecladoItem(ev, li.dataset.id, li)) ev.stopPropagation(); return; }
      const lista = ev.target.classList && ev.target.classList.contains("col-lista") ? ev.target : null;
      if (lista && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
        ev.preventDefault();
        const idx = n.COLUNAS.findIndex((c) => c.status === lista.dataset.status) + (ev.key === "ArrowLeft" ? -1 : 1);
        const c = n.COLUNAS[idx];
        if (!c) return;
        const l2 = $(`#quadro .col-lista[data-status="${c.status}"]`);
        const primeiro = l2 && l2.querySelector("li[data-id]");
        if (primeiro) Q.focar(primeiro.dataset.id, { teclado: true }); else if (l2) focarLista(l2);
        else { const t = $(`#quadro .col.recolhida[data-status="${c.status}"]`); if (t) t.focus(); }
      } else if (lista && (ev.key === "ArrowDown" || ev.key === "Home")) {
        const p = lista.querySelector("li[data-id]");
        if (p) { ev.preventDefault(); Q.focar(p.dataset.id, { teclado: true }); }
      }
    });
    const lst = $("#lista");
    lst.addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr.linha");
      if (!tr || ev.target.closest("input")) return;
      const id = tr.dataset.id;
      if (ev.ctrlKey || ev.metaKey) { Q.alternarSelecao(id); return; }
      E.foco = id;
      Mesa.gaveta.abrir(id, { via: "push" });
    });
    lst.addEventListener("contextmenu", (ev) => {
      const tr = ev.target.closest("tr.linha");
      if (!tr || ev.shiftKey) return;
      ev.preventDefault();
      Q.menuCartao(tr.dataset.id, tr, { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY });
    });
    lst.addEventListener("focusin", (ev) => { const tr = ev.target.closest("tr.linha"); if (tr) { E.foco = tr.dataset.id; if (navTeclado) seguirFoco(tr.dataset.id); navTeclado = false; } });
    lst.addEventListener("keydown", (ev) => {
      if (n.ehCampo(ev.target)) return;
      const tr = ev.target.closest("tr.linha");
      if (tr && tecladoItem(ev, tr.dataset.id, tr)) ev.stopPropagation();
    });
    const ro = new ResizeObserver(() => {
      const w = $("#area").clientWidth;
      const mudou = (w - 32 < 1048) !== (larguraQuadro - 32 < 1048) || !larguraQuadro;
      const listaMudou = E.modo === "lista" && ((w < 1200) !== (larguraQuadro < 1200) || (w < 960) !== (larguraQuadro < 960));
      larguraQuadro = w;
      if (mudou || listaMudou) Q.render(true);
      larguraToasts();
    });
    ro.observe($("#area"));
    qd.addEventListener("scroll", () => {
      if (window.innerWidth >= 720) return;
      const secs = $$("#quadro .col");
      const x = qd.scrollLeft;
      let melhor = null, dist = Infinity;
      for (const s of secs) { const d = Math.abs(s.offsetLeft - 16 - x); if (d < dist) { dist = d; melhor = s.dataset.status; } }
      if (melhor && melhor !== Q.colunaCelular) { Q.colunaCelular = melhor; desenharAbasCelular(E.itens.filter(visivel)); }
    }, { passive: true });
  }
  function seguirFoco(id) {
    clearTimeout(timerSeguir);
    timerSeguir = setTimeout(() => { if (Mesa.gaveta.segueFoco()) Mesa.gaveta.abrir(id, { via: "replace", semFoco: true }); }, 150);
  }
  function larguraToasts() {
    const g = Mesa.gaveta && Mesa.gaveta.larguraSplit ? Mesa.gaveta.larguraSplit() : 0;
    document.documentElement.style.setProperty("--toasts-dir", g + "px");
    const temToast = !!$("#toasts .toast");
    const altura = temToast ? $("#toasts").offsetHeight + 12 : 0;
    document.documentElement.style.setProperty("--toast-folga-col", altura + "px");
  }
  Mesa.ouvir("toasts", larguraToasts);
  Mesa.ouvir("gaveta", larguraToasts);

  // ------------------------------------------------------------------ compositor (nova pendência)
  const PRIO_TOKENS = { urgente: "urgente", "1": "urgente", semana: "semana", "2": "semana", acompanhar: "acompanhar", "3": "acompanhar" };
  function pessoasDaBase() {
    const s = new Set();
    for (const i of E.itens) for (const p of n.pessoasDe(i)) s.add(p);
    return [...s].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }
  function resolverPessoa(tok) {
    const t = n.norm(tok.replace(/_/g, " "));
    const base = pessoasDaBase();
    return base.find((p) => n.norm(n.nomeCurto(p)) === t) || base.find((p) => n.norm(p) === t) || base.find((p) => n.norm(p).startsWith(t)) || base.find((p) => n.norm(n.nomeCurto(p)).startsWith(t)) || null;
  }
  function resolverArea(tok) {
    const t = n.norm(tok);
    return n.AREAS.find((a) => a.apelidos.includes(t) || n.slug(a.nome) === t || n.norm(a.curto) === t) || n.AREAS.find((a) => n.norm(a.nome).startsWith(t)) || null;
  }
  function analisar(texto) {
    const r = { tokens: [], pessoa: "", area: "", prioridade: "", prazo: "" };
    let t = " " + texto + " ";
    t = t.replace(/\s@([\p{L}\d._-]+)/gu, (m, tok) => { const p = resolverPessoa(tok); const nome = p || tok.replace(/_/g, " "); r.pessoa = r.pessoa ? r.pessoa + ", " + nome : nome; r.tokens.push({ tipo: "pessoa", rotulo: "@" + (p ? n.nomeCurto(p) : nome), trecho: m.trim() }); return " "; });
    t = t.replace(/\s!(urgente|semana|acompanhar|[123])(?=\s)/giu, (m, tok) => { r.prioridade = PRIO_TOKENS[tok.toLowerCase()]; r.tokens.push({ tipo: "prio", rotulo: n.PRIO[r.prioridade].nome, trecho: m.trim() }); return " "; });
    t = t.replace(/\s\+(\d{1,3})(?=\s)/gu, (m, d) => { r.prazo = n.somaDias(n.hoje(), Number(d)); r.tokens.push({ tipo: "prazo", rotulo: "Prazo " + n.dataComSemana(r.prazo), trecho: m.trim() }); return " "; });
    t = t.replace(/\s\+([\p{L}][\p{L}\d-]*)(?=\s)/gu, (m, tok) => { const a = resolverArea(tok); if (!a) return m; r.area = a.nome; r.tokens.push({ tipo: "area", rotulo: a.curto, trecho: m.trim() }); return " "; });
    t = t.replace(/\s(at[eé]\s+(?:(?:pr[oó]xim[ao]\s+)?[\p{L}]+\.?(?:\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?))(?=\s)/giu, (m, exp) => {
      const v = n.interpretarData(exp.replace(/^at[eé]\s+/i, ""));
      if (!v) return m;
      r.prazo = v; r.tokens.push({ tipo: "prazo", rotulo: "Prazo " + n.dataComSemana(v), trecho: m.trim() }); return " ";
    });
    t = t.replace(/\s(hoje|amanh[aã])\s*$/iu, (m, exp) => { if (r.prazo) return m; r.prazo = n.interpretarData(exp); r.tokens.push({ tipo: "prazo", rotulo: "Prazo " + n.dataComSemana(r.prazo), trecho: m.trim() }); return " "; });
    r.titulo = t.replace(/\s+/g, " ").trim();
    return r;
  }
  Q.analisarCompositor = analisar;
  Q.abrirCompositor = (status, area) => {
    if (!n.podeEscrever()) return n.semConexao();
    const trocar = E.pagina !== "quadro" || E.modo !== "quadro";
    if (trocar) { Q.definirModo("quadro"); location.hash = "#/quadro"; }
    status = status || (Q.colunaFoco && Q.colunaFoco !== "feita" ? Q.colunaFoco : "aberta");
    if (status === "feita") status = "aberta";
    if (trocar || agendado) setTimeout(() => montarCompositor(status, area, 0), 160);
    else montarCompositor(status, area, 0);
  };
  function areaPadrao(area) {
    if (area) return area;
    if (E.filtros.areas.size === 1) return [...E.filtros.areas][0];
    return n.AREA_PADRAO;
  }
  function montarCompositor(status, area, tentativa) {
    fecharCompositor(true);
    const lista = $(`#quadro .col-lista[data-status="${status}"]`) || $("#quadro .col-lista[data-status=\"aberta\"]");
    if (!lista) {
      if (tentativa > 2) return;
      const s = n.lerPref("mesa.colunas.recolhidas", []).filter((x) => x !== status);
      n.gravarPref("mesa.colunas.recolhidas", s);
      if (E.filtros.sinais.has("aguardando") && status !== "aguardando") { E.filtros.sinais.delete("aguardando"); Mesa.emitir("filtros"); }
      Q.render(true);
      setTimeout(() => montarCompositor(status, area, (tentativa || 0) + 1), 200);
      return;
    }
    const raia = lista.dataset.raia;
    const areaFinal = areaPadrao(area || (E.raias === "area" && raia ? raia : ""));
    const rasc = n.lerPref("mesa.rascunho", null);
    const ta = h("textarea", { rows: "2", placeholder: "Título · @pessoa +área !urgente até sex", "aria-label": `Nova pendência em ${n.STATUS_NOME[status]}`, maxlength: "400" });
    if (rasc && rasc.texto && Date.now() - rasc.em < 864e5) ta.value = rasc.texto;
    const tokens = h("div", { c: "comp-tokens" });
    const sug = h("div", { c: "comp-sugestao", hidden: true });
    const contador = h("span", { c: "contador" });
    const rodape = h("div", { c: "comp-rodape" }, h("span", { t: "Enter cria · Shift+Enter cria e abre · Esc fecha" }), contador);
    const li = h("li", { c: "compositor", d: { status } }, ta, tokens, sug, rodape);
    lista.prepend(li);
    const sec = lista.closest(".col");
    if (sec) { const v = sec.querySelector(".col-vazia"); if (v) v.hidden = true; }
    compositor = { li, ta, status, area: areaFinal, projeto: E.raias === "projeto" && raia ? raia : "" };
    let sugestao = null;
    function atualizar() {
      const a = analisar(ta.value);
      limpar(tokens);
      for (const t of a.tokens) tokens.append(h("span", { c: "comp-token" }, t.rotulo, h("button", { type: "button", "aria-label": `Remover ${t.rotulo}`, on: { click: () => { ta.value = (" " + ta.value + " ").replace(" " + t.trecho, " ").replace(/\s+/g, " ").trim(); atualizar(); ta.focus(); } } }, ic("i-dismiss-12"))));
      if (!a.area) tokens.append(h("span", { c: "comp-token", style: "padding-right:6px;background:transparent;border:1px dashed var(--border-strong)" }, n.quadrado(areaFinal), n.AREA[areaFinal].curto));
      const tam = a.titulo.length;
      contador.textContent = tam >= 140 ? `${tam}/160` : "";
      contador.style.color = tam > 160 ? "var(--overdue)" : "";
      const antes = ta.value.slice(0, ta.selectionStart);
      const m = antes.match(/(^|\s)([@+])([\p{L}\d._-]*)$/u);
      sugestao = null;
      if (m && m[3]) {
        if (m[2] === "@") { const p = resolverPessoa(m[3]); if (p) sugestao = { trecho: m[2] + m[3], novo: "@" + n.nomeCurto(p).replace(/\s+/g, "_"), rotulo: p }; }
        else if (!/^\d+$/.test(m[3])) { const ar = resolverArea(m[3]); if (ar) sugestao = { trecho: m[2] + m[3], novo: "+" + ar.apelidos[0], rotulo: ar.nome }; }
      }
      sug.hidden = !sugestao;
      sug.textContent = sugestao ? `Tab: ${sugestao.rotulo}` : "";
      n.gravarPref("mesa.rascunho", ta.value.trim() ? { texto: ta.value, em: Date.now() } : undefined);
    }
    ta.addEventListener("input", atualizar);
    ta.addEventListener("keyup", (ev) => { if (ev.key.startsWith("Arrow")) atualizar(); });
    ta.addEventListener("keydown", async (ev) => {
      if (ev.key === "Tab" && sugestao) {
        ev.preventDefault();
        const pos = ta.selectionStart;
        const antes = ta.value.slice(0, pos), depois = ta.value.slice(pos);
        const novoAntes = antes.slice(0, antes.length - sugestao.trecho.length) + sugestao.novo + " ";
        ta.value = novoAntes + depois.replace(/^\s+/, "");
        ta.selectionStart = ta.selectionEnd = novoAntes.length;
        atualizar();
      } else if (ev.key === "Escape") {
        ev.preventDefault(); ev.stopPropagation();
        fecharCompositor();
      } else if (ev.key === "Enter" && !ev.isComposing) {
        ev.preventDefault();
        const a = analisar(ta.value);
        if (!a.titulo) return;
        if (a.titulo.length > 160) { n.toast({ texto: "O título passa de 160 caracteres. Encurte antes de criar.", tipo: "erro", duracao: 5000 }); return; }
        const campos = { titulo: a.titulo, status: compositor.status, area: a.area || compositor.area, prioridade: a.prioridade || "semana" };
        if (a.pessoa) campos.pessoa = a.pessoa.slice(0, 120);
        if (a.prazo) campos.prazo = a.prazo;
        if (compositor.projeto) campos.projeto_id = compositor.projeto;
        const abrir = ev.shiftKey;
        ta.disabled = true;
        try {
          const m = await n.criar(campos);
          n.gravarPref("mesa.rascunho", undefined);
          if (abrir) { fecharCompositor(true); Mesa.gaveta.abrir(m.id, { via: "push", focarTitulo: true }); }
          else { ta.disabled = false; ta.value = ""; atualizar(); ta.focus(); }
        } catch (e) { ta.disabled = false; ta.focus(); }
      }
    });
    atualizar();
    ta.focus();
    li.scrollIntoView({ block: "nearest" });
  }
  function fecharCompositor(semFoco) {
    if (!compositor) return false;
    const c = compositor;
    compositor = null;
    c.li.remove();
    Q.render();
    if (!semFoco) requestAnimationFrame(() => Q.focar(E.foco));
    return true;
  }
  Q.fecharCompositor = fecharCompositor;

  // ------------------------------------------------------------------ comandos públicos
  Q.definirVisao = (v) => {
    if (!["hoje", "semana", "tudo"].includes(v)) return;
    E.visao = v; n.gravarPref("mesa.visao", v);
    Q.render(true); Mesa.emitir("filtros");
    n.anunciar(`Visão ${{ hoje: "Hoje", semana: "Esta semana", tudo: "Tudo" }[v]}.`);
  };
  Q.definirModo = (m) => {
    E.modo = m; n.gravarPref("mesa.modo", m);
    if (m === "quadro") Q.todasFeitas = false;
    if (E.pagina === "quadro" || E.pagina === "lista") E.pagina = m;
    Q.render(true); Mesa.emitir("filtros"); Mesa.emitir("pagina");
  };
  Q.alternarModo = () => Q.definirModo(E.modo === "quadro" ? "lista" : "quadro");
  Q.definirRaias = (v) => {
    E.raias = v; n.gravarPref("mesa.raias", v);
    if (v) n.gravarPref("mesa.raias.ultima", v);
    if (v === "projeto") n.carregarProjetos();
    Q.render(true); Mesa.emitir("filtros");
  };
  Q.alternarRaias = () => Q.definirRaias(E.raias ? "" : n.lerPref("mesa.raias.ultima", "area"));
  Q.definirDensidade = (d) => { E.densidade = d; n.gravarPref("mesa.densidade", d); Q.render(true); };
  Q.alternarDensidade = () => Q.definirDensidade(E.densidade === "compacta" ? "confortavel" : "compacta");
  Q.alternarSinal = (s) => { if (E.filtros.sinais.has(s)) E.filtros.sinais.delete(s); else E.filtros.sinais.add(s); Q.render(true); Mesa.emitir("filtros"); };
  Q.soSinal = (s) => { E.filtros.sinais = new Set([s]); Q.render(true); Mesa.emitir("filtros"); };
  Q.limparFiltros = () => {
    const f = E.filtros;
    f.areas.clear(); f.pessoas.clear(); f.prioridades.clear(); f.sinais.clear(); f.texto = "";
    if (ferr.busca) ferr.busca.value = "";
    Q.todasFeitas = false;
    Q.render(true); Mesa.emitir("filtros");
    n.anunciar("Filtros limpos.");
  };
  Q.filtrarPessoa = (p) => { E.filtros.pessoas = new Set([p]); Q.render(true); Mesa.emitir("filtros"); };
  Q.filtrarArea = (a) => { E.filtros.areas = new Set([a]); Q.render(true); Mesa.emitir("filtros"); };
  Q.focarFiltro = () => {
    if (!ferr.busca) return;
    ferr.filtrar.classList.add("expandido");
    requestAnimationFrame(() => { ferr.busca.focus(); ferr.busca.select(); });
  };
  Q.focarPrimeiroChip = () => { const b = [ferr.chipArea, ferr.chipFiltros].find((x) => x && x.offsetParent); if (b) b.focus(); };
  Q.pessoasDaBase = pessoasDaBase;
  Q.levantado = () => !!levantado;
  Q.cancelarLevantado = () => { if (levantado) { cancelarLevantado(); return true; } return false; };

  function exportarCSV() {
    const visiveis = E.itens.filter(visivel);
    const col = ["Número", "Título", "Área", "Projeto", "Pedido por", "Prioridade", "Status", "Prazo", "Pedido em", "Origem", "Descrição"];
    const esc = (v) => { const s = String(v == null ? "" : v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const linhas = [col.join(";")].concat(visiveis.map((i) => [n.ref(i.id), i.titulo, i.area, n.nomeProjeto(i.projeto_id), i.pessoa, n.PRIO[i.prioridade].nome, n.STATUS_NOME[i.status], i.prazo ? n.dataLonga(i.prazo) : "", n.ehData(i.pedido_em) ? n.dataLonga(i.pedido_em) : "", i.origem, i.contexto].map(esc).join(";")));
    const blob = new Blob(["﻿" + linhas.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `mesa-pendencias-${n.hoje()}.csv`, style: "display:none" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    n.toast({ texto: `CSV exportado com ${visiveis.length} ${n.plural(visiveis.length, "pendência", "pendências")}.`, tipo: "ok" });
  }
  Q.exportarCSV = exportarCSV;

  // ------------------------------------------------------------------ reação a eventos
  Mesa.ouvir("dados", ({ externo, mudados }) => {
    Q.render();
    if (externo && mudados && mudados.length) requestAnimationFrame(() => requestAnimationFrame(() => Q.piscar(mudados)));
  });
  Q.piscar = (ids) => {
    for (const id of ids) {
      const el = Q.elDe(id);
      if (!el) continue;
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1300);
    }
  };
  Mesa.ouvir("salvando", ({ id, on }) => { const el = Q.elDe(id); if (el) el.classList.toggle("salvando", on); });
  Mesa.ouvir("dia", () => Q.render());
  Mesa.ouvir("vistas", () => Q.render());
  Mesa.ouvir("agente", () => Q.render());
  Mesa.ouvir("status", () => Q.render());
  Mesa.ouvir("projetos", () => Q.render(true));
  Mesa.ouvir("servidor", () => Q.render());

  Q.iniciar = () => {
    montarFerramentas();
    ligarEventos();
    larguraQuadro = $("#area").clientWidth;
    Q.render(true);
  };
})();
