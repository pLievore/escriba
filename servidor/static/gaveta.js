/* Escriba: gaveta de detalhe.
   Modos: dividida (≥ 1360 px, segue a seleção), sobreposta modal (720–1359 px) e tela cheia (< 720 px).
   Cabeçalho editável (PATCH com campos e nota), abas Contexto (cérebro), Agente (agente.js) e Histórico,
   e o Resumo de hoje quando o painel está aberto sem pendência. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, $$, limpar } = n;
  const G = (Mesa.gaveta = {});

  let id = null, resumoAberto = false, voltarPara = null, avisoExterno = "", editando = 0, pendente = false;
  const abaDe = new Map();
  const ctxCache = new Map();
  let painelAberto = n.lerPref("mesa.painel.aberto", true);
  let largura = Number(n.lerPref("mesa.painel.largura", 480)) || 480;
  let elGaveta, corpoEl, camadaModal = null, origemFoco = null;

  // ------------------------------------------------------------------ utilidades compartilhadas
  let ctx2d = null;
  function larguraTexto(t, fonte) {
    ctx2d = ctx2d || document.createElement("canvas").getContext("2d");
    ctx2d.font = fonte;
    return ctx2d.measureText(t).width;
  }
  /* Truncamento no meio: unidade, primeira pasta e os 2 últimos segmentos (medido com canvas). */
  n.truncarMeio = function (caminho, px, fonte) {
    const f = fonte || '12px "Cascadia Mono", "Cascadia Code", Consolas, monospace';
    if (!caminho || !px || larguraTexto(caminho, f) <= px) return caminho;
    const partes = String(caminho).split("\\");
    if (partes.length <= 3) return caminho;
    for (let k = 2; k >= 1; k--) {
      const cand = [partes[0], partes[1], "…", ...partes.slice(-k)].join("\\");
      if (larguraTexto(cand, f) <= px) return cand;
    }
    return "…\\" + partes[partes.length - 1];
  };
  n.iconeArquivo = function (caminho) {
    const m = String(caminho || "").match(/\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toLowerCase() : "";
    if (["sql", "py", "js", "mjs", "dax", "ps1", "json", "yml", "yaml", "html"].includes(ext)) return "i-file-code";
    if (["xlsx", "xls", "csv"].includes(ext)) return "i-file-sheet";
    if (["docx", "md", "txt"].includes(ext)) return "i-file-doc";
    if (["tmdl", "pbix", "pbip", "bim"].includes(ext)) return "i-file-model";
    if (["mp4", "mov"].includes(ext)) return "i-file-video";
    return "i-file";
  };
  n.nomeArquivo = (c) => String(c || "").split(/[\\/]/).pop();
  n.pastaDe = (c) => { const p = String(c || "").split("\\"); p.pop(); return p.join("\\"); };
  function linhaCaminho(caminho, opts) {
    const o = opts || {};
    const span = h("span", { c: "caminho", "data-tip": caminho, t: caminho });
    requestAnimationFrame(() => { const w = span.clientWidth; if (w) span.textContent = n.truncarMeio(caminho, w); });
    return h("div", { c: "linha-pasta" }, ic(o.icone || "i-folder"), span,
      h("button", { type: "button", c: "btn-icone b24", "aria-label": "Abrir pasta", "data-tip": "Abrir pasta", on: { click: () => n.abrirCaminho(caminho, "explorer") } }, ic("i-open")),
      h("button", { type: "button", c: "btn-icone b24", "aria-label": "Copiar caminho", "data-tip": "Copiar caminho", on: { click: () => n.copiar(caminho, "Caminho copiado.") } }, ic("i-copy")));
  }
  G.linhaCaminho = linhaCaminho;

  // ------------------------------------------------------------------ modos
  function modo() {
    const w = window.innerWidth;
    if (w < 720) return "tela";
    if (w >= 1360 && E.gavetaModo !== "sobreposta") return "split";
    return "sobreposta";
  }
  G.modo = modo;
  const paginaQuadro = () => E.pagina === "quadro" || E.pagina === "lista";
  G.painelVisivel = () => paginaQuadro() && (modo() === "split" ? painelAberto : !!(id || resumoAberto));
  G.segueFoco = () => modo() === "split" && painelAberto && paginaQuadro();
  G.atual = () => id;
  function larguraMax() { return Math.max(400, Math.min(760, window.innerWidth - 48 - 880)); }
  G.larguraSplit = () => (G.painelVisivel() && modo() === "split" ? Math.min(largura, larguraMax()) : 0);

  // ------------------------------------------------------------------ abrir e fechar
  G.abrir = (pid, opts) => {
    const o = opts || {};
    const item = E.porId.get(pid);
    if (!item) { if (E.carregado) n.toast({ texto: "Essa pendência não existe mais.", tipo: "erro", duracao: 5000 }); return; }
    if (!paginaQuadro()) { E.pagina = E.modo; Mesa.emitir("pagina"); }
    const anterior = id;
    if (o.voltar) voltarPara = o.voltar; else if (pid !== anterior && !o.manterVoltar) voltarPara = null;
    if (pid !== anterior) { avisoExterno = ""; pendente = false; editando = 0; }
    id = pid;
    resumoAberto = false;
    E.abertaId = pid;
    E.foco = pid;
    if (modo() === "split") { painelAberto = true; n.gravarPref("mesa.painel.aberto", true); }
    let aba = o.aba || abaDe.get(pid);
    if (!aba) { const ag = n.estadoAgente(item); aba = ag && ag.estado === "entrega" && ag.naoVista ? "agente" : "contexto"; }
    abaDe.set(pid, aba);
    if (o.via) Mesa.emitir("url", { push: o.via === "push" });
    desenhar(pid !== anterior);
    Mesa.emitir("gaveta");
    Mesa.quadro.render();
    if (o.acao) requestAnimationFrame(() => executarAcao(o.acao));
    else if (o.focarTitulo) requestAnimationFrame(() => { const t = elGaveta.querySelector(".g-titulo"); if (t) t.focus(); });
    else if (!o.semFoco && modo() !== "split") requestAnimationFrame(() => { const t = elGaveta.querySelector(".g-titulo"); if (t) t.focus(); });
  };
  G.fechar = (opts) => {
    const o = opts || {};
    const eraId = id;
    const m = modo();
    id = null;
    resumoAberto = false;
    E.abertaId = null;
    voltarPara = null;
    if (m === "split" && !o.manterPainel) { painelAberto = false; n.gravarPref("mesa.painel.aberto", false); }
    Mesa.emitir("url", { push: false });
    desenhar(true);
    Mesa.emitir("gaveta");
    Mesa.quadro.render();
    if (!o.semFoco && eraId) requestAnimationFrame(() => Mesa.quadro.focar(eraId));
  };
  G.alternarPainel = () => {
    if (modo() === "split") {
      painelAberto = !painelAberto;
      n.gravarPref("mesa.painel.aberto", painelAberto);
      if (!painelAberto) { id = null; E.abertaId = null; Mesa.emitir("url", { push: false }); }
      desenhar(true); Mesa.emitir("gaveta"); Mesa.quadro.render();
    } else if (id || resumoAberto) G.fechar();
    else G.resumo();
  };
  G.resumo = () => {
    if (!paginaQuadro()) { location.hash = "#/quadro"; }
    id = null; E.abertaId = null; resumoAberto = true;
    if (modo() === "split") { painelAberto = true; n.gravarPref("mesa.painel.aberto", true); }
    Mesa.emitir("url", { push: false });
    desenhar(true); Mesa.emitir("gaveta"); Mesa.quadro.render();
    requestAnimationFrame(() => { const t = elGaveta.querySelector(".resumo h2"); if (t) t.focus(); });
  };
  G.devolverFoco = () => { if (id) Mesa.quadro.focar(id); };
  G.temModal = () => modo() !== "split" && !elGaveta.hidden;
  G.contem = (el) => elGaveta && elGaveta.contains(el);
  G.proxima = (delta) => {
    if (!id) return;
    const p = Mesa.quadro.proximo(id, delta);
    if (p && p !== id) G.abrir(p, { via: "replace", aba: abaDe.get(id), manterVoltar: false, semFoco: true });
  };

  // ------------------------------------------------------------------ desenho
  function aplicarModo() {
    const m = modo();
    const visivel = G.painelVisivel();
    elGaveta.hidden = !visivel;
    elGaveta.classList.toggle("sobreposta", m === "sobreposta");
    elGaveta.classList.toggle("tela", m === "tela");
    const w = m === "split" ? Math.min(largura, larguraMax()) : m === "sobreposta" ? (window.innerWidth >= 1024 ? 480 : Math.min(560, window.innerWidth - 48)) : window.innerWidth;
    elGaveta.style.setProperty("--gaveta-w", w + "px");
    elGaveta.classList.toggle("estreita", w < 480);
    const scrim = $("#scrim");
    const modal = visivel && m !== "split";
    scrim.hidden = !(modal && m === "sobreposta");
    if (modal) {
      elGaveta.setAttribute("role", "dialog");
      elGaveta.setAttribute("aria-modal", "true");
      if (!camadaModal) camadaModal = n.empilharCamada({ tipo: "gaveta", fechar: () => G.fechar() });
    } else {
      elGaveta.setAttribute("role", "complementary");
      elGaveta.removeAttribute("aria-modal");
      if (camadaModal) { n.tirarCamada(camadaModal); camadaModal = null; }
    }
    elGaveta.setAttribute("aria-label", id ? `Detalhe da pendência ${n.ref(id)}` : "Resumo de hoje");
  }
  function desenhar(trocou) {
    if (!elGaveta) return;
    const rolagem = corpoEl ? corpoEl.scrollTop : 0;
    aplicarModo();
    if (elGaveta.hidden) { limpar(elGaveta); corpoEl = null; return; }
    limpar(elGaveta);
    if (modo() === "split") elGaveta.append(puxador());
    if (!id) { elGaveta.append(desenharResumo()); corpoEl = null; return; }
    const item = E.porId.get(id);
    if (!item) { id = null; E.abertaId = null; desenhar(true); return; }
    corpoEl = h("div", { c: "gaveta-corpo" + (trocou ? " gaveta-conteudo-entra" : "") });
    elGaveta.append(desenharTopo(item), corpoEl);
    corpoEl.append(desenharCabecalho(item), desenharAbas(item));
    if (!trocou) corpoEl.scrollTop = rolagem;
  }
  G.redesenhar = () => desenhar(false);

  function puxador() {
    const max = larguraMax();
    const p = h("div", { c: "puxador", role: "separator", tabindex: "0", "aria-orientation": "vertical", "aria-label": "Largura do painel", "aria-valuemin": "400", "aria-valuemax": String(max), "aria-valuenow": String(Math.min(largura, max)) });
    const aplicar = (w) => {
      largura = Math.max(400, Math.min(larguraMax(), Math.round(w)));
      n.gravarPref("mesa.painel.largura", largura);
      elGaveta.style.setProperty("--gaveta-w", largura + "px");
      elGaveta.classList.toggle("estreita", largura < 480);
      p.setAttribute("aria-valuenow", String(largura));
      Mesa.emitir("toasts");
    };
    p.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      p.setPointerCapture(ev.pointerId);
      p.classList.add("ativo");
      const mover = (e2) => aplicar(window.innerWidth - e2.clientX);
      const soltar = () => { p.classList.remove("ativo"); p.removeEventListener("pointermove", mover); p.removeEventListener("pointerup", soltar); Mesa.quadro.render(true); };
      p.addEventListener("pointermove", mover);
      p.addEventListener("pointerup", soltar);
    });
    p.addEventListener("dblclick", () => { aplicar(480); Mesa.quadro.render(true); });
    p.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft") { ev.preventDefault(); aplicar(largura + 16); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); aplicar(largura - 16); }
    });
    return p;
  }

  const ATOR_EXTERNO = { assistente: "pelo assistente", "claude-code": "pela leitura do Teams", mcp: "pela sessão do Claude Code", agente: "pelo agente", painel: "em outra aba" };
  function desenharTopo(item) {
    const a = n.areaDe(item);
    const esq = h("div", { style: "display:flex;align-items:center;gap:6px;min-width:0;flex:1" },
      h("span", { c: "g-num", t: n.ref(item.id) }), h("span", { c: "texto-3", "aria-hidden": "true", t: "·" }),
      h("button", { type: "button", c: "link g-area", "data-tip": `Filtrar o quadro por ${a.nome}`, on: { click: () => Mesa.quadro.filtrarArea(a.nome) } }, n.quadrado(a), a.curto));
    if (avisoExterno) esq.append(h("span", { c: "g-aviso", t: avisoExterno }));
    if (voltarPara && E.porId.has(voltarPara)) esq.append(h("button", { type: "button", c: "link t-meta", t: `← Voltar para ${n.ref(voltarPara)}`, on: { click: () => { const v = voltarPara; voltarPara = null; G.abrir(v, { via: "push" }); } } }));
    const ehModal = modo() !== "split";
    return h("div", { c: "gaveta-topo" }, ehModal && modo() === "tela" ? h("button", { type: "button", c: "btn-icone", "aria-label": "Voltar", on: { click: () => history.length > 1 ? history.back() : G.fechar() } }, ic("i-arrow-left")) : null, esq,
      h("div", { c: "g-dir" },
        h("button", { type: "button", c: "btn-icone", "aria-label": "Pendência anterior", "data-tip": "Anterior   K", on: { click: () => G.proxima(-1) } }, ic("i-chevron-up")),
        h("button", { type: "button", c: "btn-icone", "aria-label": "Próxima pendência", "data-tip": "Próxima   J", on: { click: () => G.proxima(1) } }, ic("i-chevron-down")),
        h("button", { type: "button", c: "btn-icone", "aria-label": "Mais ações", "aria-haspopup": "menu", "data-tip": "Mais ações", on: { click: (ev) => menuTopo(item, ev.currentTarget) } }, ic("i-more")),
        h("button", { type: "button", c: "btn-icone", "aria-label": ehModal ? "Fechar (Esc)" : "Fechar painel", "data-tip": ehModal ? "Fechar   Esc" : "Fechar painel   ]", on: { click: () => G.fechar() } }, ic("i-dismiss"))));
  }
  function menuTopo(item, ancora) {
    const leitura = !n.podeEscrever();
    n.menu(ancora, [
      { rotulo: "Copiar link", icone: "i-link", acao: () => Mesa.quadro.copiarLink(item.id) },
      { rotulo: "Copiar referência", icone: "i-copy", acao: () => Mesa.quadro.copiarReferencia(item.id) },
      { rotulo: "Duplicar", icone: "i-plus", desabilitado: leitura, acao: () => duplicar(item) },
      { separador: true },
      { rotulo: "Descartar", icone: "i-discard", perigo: true, desabilitado: leitura, acao: () => Mesa.quadro.descartar([item.id]) },
    ], { rotulo: "Mais ações da pendência" });
  }
  async function duplicar(item) {
    const campos = { titulo: (item.titulo + " (cópia)").slice(0, 160), pessoa: item.pessoa, area: item.area, prioridade: item.prioridade, prazo: item.prazo, contexto: item.contexto, status: item.status === "feita" ? "aberta" : item.status };
    if (item.projeto_id) campos.projeto_id = item.projeto_id;
    try { const m = await n.criar(campos); G.abrir(m.id, { via: "push" }); } catch (e) { /* toast já mostrado */ }
  }

  // ------------------------------------------------------------------ cabeçalho e propriedades
  function desenharCabecalho(item) {
    const cab = h("div", { c: "g-cab" });
    const titulo = h("h2", { c: "g-titulo", tabindex: "-1", t: item.titulo, "data-tip": n.podeEscrever() ? "Clique ou F2 para editar" : null });
    titulo.addEventListener("click", () => editarTitulo(item));
    titulo.addEventListener("keydown", (ev) => { if (ev.key === "F2" || ev.key === "Enter") { ev.preventDefault(); editarTitulo(item); } });
    const partes = [];
    partes.push(item.origem || n.ORIGEM_ATOR[item.atualizado_por] || "");
    if (n.ehData(item.pedido_em)) {
      const d = n.diasEntre(item.pedido_em, n.hoje());
      partes.push(`pedido em ${n.dataComSemana(item.pedido_em)}`);
      if (d > 0) partes.push(d === 1 ? "há 1 dia" : `há ${d} dias`);
    }
    cab.append(titulo, h("p", { c: "g-origem", t: partes.filter(Boolean).join(" · ") }), desenharProps(item), desenharDescricao(item));
    return cab;
  }
  function campoFantasma(conteudo, opts) {
    const o = opts || {};
    const b = h("button", { type: "button", c: "fant" + (o.vazio ? " vazio" : "") + (o.cls ? " " + o.cls : "") + (o.soLeitura ? " so-leitura" : ""), "aria-label": o.rotulo, "aria-haspopup": o.popup || null, disabled: o.desabilitado || null, "data-tip": o.dica || null, d: { campo: o.campo || null } }, conteudo);
    if (o.acao && !o.soLeitura) b.addEventListener("click", (ev) => { if (!n.podeEscrever()) return n.semConexao(); o.acao(ev.currentTarget); });
    return b;
  }
  function desenharProps(item) {
    const g = h("div", { c: "props" });
    const leitura = !n.podeEscrever();
    const dicaLeitura = leitura ? "Sem conexão com o servidor local." : null;
    const linha = (rot, val) => g.append(h("div", { c: "prop-rot", t: rot }), h("div", { c: "prop-val" }, val));
    linha("Status", campoFantasma([n.iconeStatus(item.status), h("span", { t: n.STATUS_NOME[item.status] })], { rotulo: `Status: ${n.STATUS_NOME[item.status]}`, popup: "menu", campo: "status", dica: dicaLeitura, acao: (b) => Mesa.quadro.menuStatus(item.id, b) }));
    linha("Prioridade", campoFantasma([n.iconePrio(item.prioridade), h("span", { t: n.PRIO[item.prioridade].nome })], { rotulo: `Prioridade: ${n.PRIO[item.prioridade].nome}`, popup: "menu", campo: "prioridade", dica: dicaLeitura, acao: (b) => Mesa.quadro.menuPrioridade(item.id, b) }));
    let prazo;
    if (item.status === "feita") {
      const c = n.concluidaEm(item);
      prazo = campoFantasma([ic("i-status-done-12", "col-ic-feita"), h("span", { t: c ? `Concluída ${n.dataComSemana(n.isoDeTs(c))} às ${n.horaDeTs(c)}` : "Concluída" })], { rotulo: "Prazo", campo: "prazo", cls: "", acao: (b) => editarPrazo(item, b) });
    } else {
      const p = n.prazoInfo(item, "gaveta");
      prazo = campoFantasma([ic(p.vazio ? "i-calendar" : p.tipo === "atrasada" ? "i-clock-filled" : p.tipo === "hoje" ? "i-clock" : "i-calendar"), h("span", { t: p.vazio ? "Definir" : p.texto })], { rotulo: `Prazo: ${p.texto}`, vazio: p.vazio, cls: p.tipo === "atrasada" ? "atrasada" : p.tipo === "hoje" ? "hoje" : "", popup: "dialog", campo: "prazo", dica: dicaLeitura || (p.vazio ? null : p.texto), acao: (b) => editarPrazo(item, b) });
    }
    linha("Prazo", prazo);
    const ps = n.pessoasDe(item);
    linha("Pedido por", campoFantasma(ps.length ? [n.avatar(n.nomeCurto(ps[0])), h("span", { t: ps.length > 1 ? `${ps[0]} +${ps.length - 1}` : ps[0] })] : [ic("i-person"), h("span", { t: "Definir" })], { rotulo: `Pedido por: ${ps.join(", ") || "ninguém"}`, vazio: !ps.length, popup: "dialog", campo: "pessoa", dica: dicaLeitura || (ps.length > 1 ? ps.join(", ") : null), acao: (b) => editarPessoas(item, b) }));
    // Aguardando/Cobrar só ocupam espaço quando significam algo: na coluna Aguardando ou já preenchidos
    if (item.status === "aguardando" || item.aguardando_de || item.cobrar_em) {
      const de = item.aguardando_de;
      linha("Aguardando", campoFantasma(de ? [n.avatar(n.nomeCurto(de)), h("span", { t: de })] : [ic("i-person"), h("span", { t: "Definir" })],
        { rotulo: `Aguardando: ${de || "ninguém"}`, vazio: !de, popup: "dialog", campo: "aguardando_de", dica: dicaLeitura, acao: (b) => editarAguardandoDe(item, b) }));
      const cb = n.cobrancaInfo(item, "gaveta");
      linha("Cobrar", campoFantasma([ic(cb ? "i-bell-12" : "i-bell"), h("span", { t: cb ? cb.texto : "Definir" })],
        { rotulo: cb ? cb.texto : "Cobrar: sem data", vazio: !cb, cls: cb && cb.vencida ? "atrasada" : cb && cb.tipo === "cobrar-hoje" ? "hoje" : "",
          popup: "dialog", campo: "cobrar_em", dica: dicaLeitura, acao: (b) => editarCobranca(item, b) }));
    }
    const a = n.areaDe(item);
    linha("Área", campoFantasma([n.quadrado(a), h("span", { t: a.nome })], { rotulo: `Área: ${a.nome}`, popup: "menu", campo: "area", dica: dicaLeitura, acao: (b) => Mesa.quadro.menuArea(item.id, b) }));
    const pn = n.nomeProjeto(item.projeto_id);
    linha("Projeto", campoFantasma([ic("i-projects"), h("span", { t: pn || "Definir" })], { rotulo: `Projeto: ${pn || "nenhum"}`, vazio: !pn, popup: "menu", campo: "projeto", dica: dicaLeitura || pn || null, acao: (b) => escolherProjeto(item, b) }));
    const criada = n.isoDeTs(item.criado_em) || item.pedido_em;
    linha("Criada", campoFantasma(h("span", { t: n.ehData(criada) ? n.dataComSemana(criada) : "—" }), { rotulo: "Criada", soLeitura: true, dica: item.criado_em ? n.relativo(item.criado_em) : null }));
    if (Mesa.jira && Mesa.jira.disponivel()) linha("Jira", Mesa.jira.campo(item));
    return g;
  }
  function desenharDescricao(item) {
    const caixa = h("div", { c: "g-desc" }, h("div", { c: "g-desc-rot", t: "Descrição" }));
    if (item.contexto) {
      const t = h("div", { c: "g-desc-texto", tabindex: "0", role: "button", "aria-label": "Descrição. Enter para editar", t: item.contexto });
      t.addEventListener("click", (ev) => { if (!window.getSelection || !String(window.getSelection())) editarDescricao(item, caixa); });
      t.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === "F2") { ev.preventDefault(); editarDescricao(item, caixa); } });
      caixa.append(t);
    } else caixa.append(h("button", { type: "button", c: "btn btn-sutil btn-28", style: "margin-left:-10px", on: { click: () => editarDescricao(item, caixa) } }, ic("i-plus"), "Adicionar descrição"));
    return caixa;
  }
  function comecarEdicao() { editando++; }
  function terminarEdicao() { editando = Math.max(0, editando - 1); if (!editando && pendente) { pendente = false; desenhar(false); } }
  function editarTitulo(item) {
    if (!n.podeEscrever()) return n.semConexao();
    const t = elGaveta.querySelector(".g-titulo");
    if (!t) return;
    comecarEdicao();
    const base = item.atualizado_em;   // retrato de quando a edição começou: o servidor confere
    const ta = h("textarea", { c: "g-titulo-edit", maxlength: "160", rows: "1", "aria-label": "Título" });
    ta.value = item.titulo;
    t.replaceWith(ta);
    const ajustar = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    ajustar();
    ta.focus();
    ta.select();
    let feito = false;
    const fim = async (salvar) => {
      if (feito) return;
      feito = true;
      const v = ta.value.replace(/\s+/g, " ").trim();
      terminarEdicao();
      if (salvar && v && v !== item.titulo) {
        try { await n.mudar(item.id, { titulo: v }, { base, toast: `${n.ref(item.id)}: título editado.` }); } catch (e) { /* toast já mostrado */ }
      }
      desenhar(false);
      requestAnimationFrame(() => { const nt = elGaveta.querySelector(".g-titulo"); if (nt) nt.focus(); });
    };
    ta.addEventListener("input", ajustar);
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); fim(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); fim(false); }
    });
    ta.addEventListener("blur", () => fim(true));
  }
  function editarDescricao(item, caixa) {
    if (!n.podeEscrever()) return n.semConexao();
    comecarEdicao();
    const base = item.atualizado_em;
    limpar(caixa);
    const ta = h("textarea", { maxlength: "1500", "aria-label": "Descrição", placeholder: "O que foi pedido, por quem, situação." });
    ta.value = item.contexto;
    const dica = h("div", { c: "campo-dica", t: "Ctrl+Enter salva · Esc cancela" });
    caixa.append(h("div", { c: "g-desc-rot", t: "Descrição" }), ta, dica);
    ta.focus();
    let feito = false;
    const fim = async (salvar) => {
      if (feito) return;
      feito = true;
      terminarEdicao();
      const v = ta.value.trim();
      if (salvar && v !== item.contexto) { try { await n.mudar(item.id, { contexto: v }, { base, toast: `${n.ref(item.id)}: descrição atualizada.` }); } catch (e) { /* segue */ } }
      desenhar(false);
    };
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); fim(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); fim(false); }
    });
    ta.addEventListener("blur", () => fim(true));
  }
  function editarPrazo(item, ancora) {
    comecarEdicao();
    n.seletorPrazo(ancora, item.prazo, (v) => {
      if (v === item.prazo) return;
      n.mudar(item.id, { prazo: v }, { toast: v ? `${n.ref(item.id)}: prazo ${n.dataComSemana(v)}.` : `${n.ref(item.id)} ficou sem prazo.` }).catch(() => {});
    }, { aoFechar: () => terminarEdicao() });
  }
  function editarCobranca(item, ancora) {
    comecarEdicao();
    n.seletorPrazo(ancora, item.cobrar_em, (v) => {
      if (v === item.cobrar_em) return;
      n.mudar(item.id, { cobrar_em: v }, { toast: v ? `${n.ref(item.id)}: cobrar ${n.dataComSemana(v)}.` : `${n.ref(item.id)}: cobrança desmarcada.` }).catch(() => {});
    }, { aoFechar: () => terminarEdicao(), rotulo: "Cobrar em" });
  }
  function editarAguardandoDe(item, ancora) {
    comecarEdicao();
    const base = item.atualizado_em;
    const input = h("input", { type: "text", "aria-label": "Aguardando quem", placeholder: "Nome de quem está com a bola", autocomplete: "off", maxlength: "120" });
    input.value = item.aguardando_de || "";
    const sugestoes = h("div", { c: "pop-lista", role: "listbox" });
    const salvar = async (v) => {
      pop.fechar();
      if (v === (item.aguardando_de || "")) return;
      try { await n.mudar(item.id, { aguardando_de: v }, { base, toast: v ? `${n.ref(item.id)}: aguardando ${v}.` : `${n.ref(item.id)}: sem quem aguardar.` }); } catch (e) { /* toast já mostrado */ }
    };
    function desenharSugestoes() {
      limpar(sugestoes);
      const q = n.norm(input.value.trim());
      const base2 = Mesa.quadro.pessoasDaBase().filter((p) => !q || n.norm(p).includes(q)).slice(0, 6);
      for (const p of base2) sugestoes.append(h("button", { type: "button", c: "menu-item", role: "option", on: { click: () => salvar(p) } }, n.avatar(n.nomeCurto(p), true), h("span", { c: "rot", t: p })));
      if (!base2.length) sugestoes.append(h("div", { c: "menu-vazio", t: input.value ? "Ninguém com esse nome; Enter usa o que você digitou." : "Digite um nome." }));
    }
    input.addEventListener("input", desenharSugestoes);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); salvar(input.value.trim()); } });
    desenharSugestoes();
    const pop = n.popover(ancora, h("div", { c: "pop-aguardando" },
      h("label", { c: "t-meta texto-2", t: "Quem está com a bola" }), input, sugestoes,
      h("div", { c: "pop-acoes" },
        item.aguardando_de ? h("button", { type: "button", c: "btn btn-28", t: "Limpar", on: { click: () => salvar("") } }) : null,
        h("button", { type: "button", c: "btn btn-28 btn-primario", t: "Salvar", on: { click: () => salvar(input.value.trim()) } }))),
      { rotulo: "Aguardando quem", aoFechar: () => terminarEdicao() });
  }
  function editarPessoas(item, ancora) {
    comecarEdicao();
    let tokens = n.pessoasDe(item);
    const base = Mesa.quadro.pessoasDaBase();
    const caixa = h("div", { c: "tokens" });
    const input = h("input", { type: "text", "aria-label": "Adicionar pessoa", placeholder: "Nome", autocomplete: "off", role: "combobox", "aria-expanded": "true", "aria-controls": "pessoas-sug" });
    const lista = h("div", { c: "pop-lista", id: "pessoas-sug", role: "listbox" });
    let ativo = 0;
    function desenharTokens() {
      limpar(caixa);
      for (const t of tokens) caixa.append(h("span", { c: "token" }, t, h("button", { type: "button", "aria-label": `Remover ${t}`, on: { click: () => { tokens = tokens.filter((x) => x !== t); desenharTokens(); input.focus(); } } }, ic("i-dismiss-12"))));
      caixa.append(input);
    }
    function opcoes() {
      const q = n.norm(input.value.trim());
      const ops = base.filter((p) => !tokens.includes(p) && (!q || n.norm(p).includes(q))).slice(0, 8).map((p) => ({ v: p, r: p }));
      if (input.value.trim() && !base.some((p) => n.norm(p) === q)) ops.push({ v: input.value.trim(), r: `Usar “${input.value.trim()}”` });
      return ops;
    }
    function desenharLista() {
      limpar(lista);
      const ops = opcoes();
      ativo = Math.min(ativo, Math.max(0, ops.length - 1));
      ops.forEach((o, k) => lista.append(h("button", { type: "button", c: "menu-item" + (k === ativo ? " ativo" : ""), role: "option", "aria-selected": String(k === ativo), on: { click: () => { tokens.push(o.v); input.value = ""; desenharTokens(); desenharLista(); input.focus(); } } }, o.v === o.r ? n.avatar(n.nomeCurto(o.v), true) : ic("i-plus"), h("span", { c: "rot", t: o.r }))));
      if (!ops.length) lista.append(h("div", { c: "menu-vazio", t: input.value ? "Ninguém com esse nome." : "Digite um nome." }));
    }
    input.addEventListener("input", () => { ativo = 0; desenharLista(); });
    input.addEventListener("keydown", (ev) => {
      const ops = opcoes();
      if (ev.key === "ArrowDown") { ev.preventDefault(); ativo = Math.min(ops.length - 1, ativo + 1); desenharLista(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); ativo = Math.max(0, ativo - 1); desenharLista(); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        if (input.value.trim() && ops[ativo]) { tokens.push(ops[ativo].v); input.value = ""; desenharTokens(); desenharLista(); input.focus(); }
        else salvar();
      } else if (ev.key === "Backspace" && !input.value && tokens.length) { tokens.pop(); desenharTokens(); input.focus(); }
    });
    const salvar = () => {
      const v = tokens.join(", ").slice(0, 120);
      pop.fechar();
      if (v !== item.pessoa) n.mudar(item.id, { pessoa: v }, { toast: v ? `${n.ref(item.id)}: pedido por ${v}.` : `${n.ref(item.id)}: sem pessoa.` }).catch(() => {});
    };
    desenharTokens();
    desenharLista();
    const pop = n.popover(ancora, h("div", { c: "pop-tokens" }, h("div", { c: "t-meta texto-2", style: "margin-bottom:6px", t: "Pedido por (várias pessoas, separadas por vírgula)" }), caixa, lista,
      h("div", { c: "pop-acoes" }, h("button", { type: "button", c: "btn btn-28", t: "Cancelar", on: { click: () => pop.fechar() } }), h("button", { type: "button", c: "btn btn-28 btn-primario", t: "Salvar", on: { click: salvar } }))),
    { rotulo: "Pedido por", foco: "input", aoFechar: () => terminarEdicao() });
  }
  async function escolherProjeto(item, ancora) {
    await n.carregarProjetos();
    const c = ctxCache.get(item.id);
    const sugestoes = c && c.dados && Array.isArray(c.dados.sugestoes) ? c.dados.sugestoes : [];
    const projetos = [...E.projetos].sort((a, b) => (b.ativo === true) - (a.ativo === true) || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
    const aplicar = (pid) => {
      if (pid === item.projeto_id) return;
      n.mudar(item.id, { projeto_id: pid }, { toast: pid ? `${n.ref(item.id)}: projeto ${n.nomeProjeto(pid)}.` : `${n.ref(item.id)}: sem projeto.` }).then(() => { ctxCache.delete(item.id); desenhar(false); }).catch(() => {});
    };
    const itens = [];
    if (sugestoes.length) {
      itens.push({ titulo: "Sugestões do cérebro" });
      for (const s of sugestoes) itens.push({ rotulo: s.nome || n.nomeProjeto(s.projeto_id), sq: n.AREA[(E.projetosPorId.get(s.projeto_id) || {}).area] || n.AREA.Outros, sec: `${s.pontos} pts`, acao: () => aplicar(s.projeto_id) });
      itens.push({ separador: true });
    }
    for (const p of projetos) itens.push({ tipo: "radio", rotulo: p.nome, sq: n.AREA[p.area] || n.AREA.Outros, marcado: p.id === item.projeto_id, sec: p.ativo ? "" : "inativo", acao: () => aplicar(p.id) });
    itens.push({ separador: true }, { tipo: "radio", rotulo: "Sem projeto", marcado: !item.projeto_id, acao: () => aplicar("") });
    comecarEdicao();
    n.menu(ancora, itens, { filtro: true, rotulo: "Projeto", vazio: "Nenhum projeto carregado.", aoFechar: () => terminarEdicao() });
  }

  // ------------------------------------------------------------------ abas
  const ABAS = [["contexto", "Contexto"], ["agente", "Agente"], ["historico", "Histórico"]];
  function desenharAbas(item) {
    const atual = abaDe.get(item.id) || "contexto";
    const lista = h("div", { c: "abas", role: "tablist", "aria-label": "Seções da pendência" });
    const painel = h("div", { c: "aba-painel", role: "tabpanel", id: "g-painel", tabindex: "-1", "aria-labelledby": "g-aba-" + atual });
    for (const [k, r] of ABAS) {
      const b = h("button", { type: "button", c: "aba", role: "tab", id: "g-aba-" + k, "aria-selected": String(k === atual), "aria-controls": "g-painel", tabindex: k === atual ? "0" : "-1", d: { aba: k } },
        h("span", { c: "aba-rot", "data-label": r, t: r }));
      if (k === "contexto" && E.recursos.cerebro) {
        const c = ctxCache.get(item.id);
        const qtd = c && c.dados ? (c.dados.arquivos || []).length + (c.dados.notas || []).length : n.ligacoesN(item);
        if (qtd) b.append(h("span", { c: "num", t: String(qtd) }));
      }
      if (k === "agente") {
        const ag = n.estadoAgente(item);
        if (ag && ag.estado === "trabalhando") b.append(n.spinner(true));
        else if (ag && ag.estado === "entrega" && ag.naoVista) b.append(h("span", { c: "ponto-aba", "aria-label": "entrega nova" }));
      }
      b.addEventListener("click", () => trocarAba(k));
      lista.append(b);
    }
    lista.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const idx = ABAS.findIndex(([k]) => k === (abaDe.get(id) || "contexto"));
      const prox = ABAS[(idx + (ev.key === "ArrowLeft" ? -1 : 1) + ABAS.length) % ABAS.length][0];
      trocarAba(prox, true);
    });
    const frag = document.createDocumentFragment();
    frag.append(lista, painel);
    preencherAba(painel, item, atual);
    return frag;
  }
  function trocarAba(k, focarAba) {
    if (!id) return;
    abaDe.set(id, k);
    const corpo = corpoEl;
    if (!corpo) return;
    const antigaLista = corpo.querySelector(".abas"), antigoPainel = corpo.querySelector(".aba-painel");
    const item = E.porId.get(id);
    const novo = desenharAbas(item);
    const tmp = h("div");
    tmp.append(novo);
    const [nl, np] = tmp.children;
    antigaLista.replaceWith(nl);
    antigoPainel.replaceWith(np);
    if (focarAba) { const b = corpo.querySelector(`.aba[data-aba="${k}"]`); if (b) b.focus(); }
  }
  G.trocarAba = trocarAba;
  function preencherAba(painel, item, aba) {
    if (aba === "contexto") desenharContexto(painel, item);
    else if (aba === "agente") Mesa.agente.renderAba(painel, item, { acao: G._acaoAgente });
    else desenharHistorico(painel, item);
    G._acaoAgente = null;
  }
  function executarAcao(acao) {
    if (!id) return;
    const item = E.porId.get(id);
    if (acao === "titulo") editarTitulo(item);
    else if (acao === "pessoa") { const b = elGaveta.querySelector('[data-campo="pessoa"]'); if (b) editarPessoas(item, b); }
    else if (acao === "projeto") { const b = elGaveta.querySelector('[data-campo="projeto"]'); if (b) escolherProjeto(item, b); }
    else if (["briefing", "rascunho", "executar", "foco-briefing", "foco-rascunho"].includes(acao)) {
      G._acaoAgente = acao;
      abaDe.set(id, "agente");
      trocarAba("agente");
    }
  }

  /* O contexto já carregado: a aba Agente usa as pastas que ele traz para dizer, antes de rodar,
     o que o agente vai abrir. */
  G.contextoDe = (pid) => (ctxCache.get(pid) || {}).dados || null;

  // ------------------------------------------------------------------ aba Contexto (cérebro)
  async function carregarContexto(pid, forcar) {
    const c = ctxCache.get(pid);
    if (c && !forcar && (c.dados || c.carregando)) return c;
    const novo = { carregando: true, dados: c && c.dados, erro: null, em: c && c.em, assinatura: c && c.assinatura };
    ctxCache.set(pid, novo);
    try {
      const r = await n.api("GET", n.rotaItem(pid, "/contexto"), null, { tempo: 20000 });
      novo.dados = r; novo.em = Date.now(); novo.erro = null;
      const item = E.porId.get(pid);
      novo.assinatura = item ? JSON.stringify(item.ligacoes) + item.projeto_id : "";
    } catch (e) { novo.erro = e; }
    novo.carregando = false;
    if (id === pid && (abaDe.get(pid) || "contexto") === "contexto") {
      const painel = elGaveta.querySelector(".aba-painel");
      if (painel) { limpar(painel); desenharContexto(painel, E.porId.get(pid)); }
      const aba = elGaveta.querySelector('.aba[data-aba="contexto"] .num');
      if (novo.dados) {
        const qtd = (novo.dados.arquivos || []).length + (novo.dados.notas || []).length;
        if (aba) aba.textContent = String(qtd);
        else if (qtd) { const b = elGaveta.querySelector('.aba[data-aba="contexto"]'); if (b) b.append(h("span", { c: "num", t: String(qtd) })); }
      }
    }
    return novo;
  }
  G.recarregarContexto = (pid) => carregarContexto(pid || id, true);
  const recolhidasSecoes = () => new Set(n.lerPref("mesa.secoes.recolhidas", []));
  function secao(chave, titulo, qtd, corpo, icone) {
    const rec = recolhidasSecoes().has(chave);
    const s = h("section", { c: "secao" });
    const b = h("button", { type: "button", c: "secao-cab", "aria-expanded": String(!rec) }, ic(rec ? "i-chevron-right" : "i-chevron-down"), icone ? ic(icone) : null, h("span", { t: titulo }), qtd != null ? h("span", { c: "num", t: String(qtd) }) : null);
    const c = h("div", { c: "secao-corpo", hidden: rec }, corpo);
    b.addEventListener("click", () => {
      const set = recolhidasSecoes();
      if (set.has(chave)) set.delete(chave); else set.add(chave);
      n.gravarPref("mesa.secoes.recolhidas", [...set]);
      c.hidden = !c.hidden;
      b.setAttribute("aria-expanded", String(!c.hidden));
      b.firstChild.replaceWith(ic(c.hidden ? "i-chevron-right" : "i-chevron-down"));
    });
    s.append(b, c);
    return s;
  }
  function esqueletoSecoes() {
    const f = h("div");
    for (let k = 0; k < 2; k++) f.append(h("div", { style: "display:grid;gap:8px;padding:10px 0" }, h("span", { c: "esq e10", style: "width:40%" }), h("span", { c: "esq", style: "width:90%" }), h("span", { c: "esq", style: "width:70%" })));
    return f;
  }
  function desenharContexto(painel, item) {
    if (!E.recursos.cerebro) { painel.append(h("p", { c: "vazio-texto", t: "O cérebro ainda não está ligado neste servidor." })); return; }
    const c = ctxCache.get(item.id);
    const assinaturaAtual = JSON.stringify(item.ligacoes) + item.projeto_id;
    if (!c || (!c.carregando && c.assinatura !== assinaturaAtual && !c.erro)) carregarContexto(item.id, true);
    const estado = h("div", { c: "linha-estado" });
    painel.append(estado);
    const cc = ctxCache.get(item.id);
    if (cc && cc.carregando) estado.append(n.spinner(true), "Procurando no cérebro…");
    else if (cc && cc.dados) {
      const qtd = (cc.dados.arquivos || []).length + (cc.dados.notas || []).length;
      const em = new Date(cc.em).toISOString();
      estado.append(`Contexto de ${n.ddmm(n.isoDeTs(em))} ${n.horaDeTs(em)} · ${qtd} ${n.plural(qtd, "ligação", "ligações")}`);
    }
    estado.append(h("button", { type: "button", c: "btn btn-sutil btn-24", "aria-label": "Atualizar o contexto", "data-tip": "Atualizar", on: { click: () => carregarContexto(item.id, true) } }, ic("i-refresh"), "Atualizar"));
    if (!cc || (!cc.dados && cc.carregando)) { painel.append(esqueletoSecoes()); return; }
    if (cc.erro && !cc.dados) {
      painel.append(h("div", { c: "erro-texto" }, ic("i-error"), h("span", { t: "Não consegui consultar o cérebro." }), h("button", { type: "button", c: "btn btn-28", t: "Tentar de novo", on: { click: () => carregarContexto(item.id, true) } })));
      return;
    }
    const d = cc.dados;
    const pasta = d.projeto && d.projeto.pasta ? d.projeto.pasta : "";
    // 1. projeto e pasta
    if (d.projeto) {
      painel.append(h("div", { c: "linha-pasta" }, ic("i-projects"), h("a", { href: "#/projetos/" + encodeURIComponent(d.projeto.id), c: "nome", t: d.projeto.nome, style: "font-weight:600" }), d.projeto.ativo === false ? h("span", { c: "tag tag-parado tag-peq", t: "Inativo" }) : null));
      if (pasta) painel.append(linhaCaminho(pasta));
      else painel.append(h("p", { c: "vazio-texto" }, "Este projeto não tem pasta. ", h("a", { href: "#/projetos/" + encodeURIComponent(d.projeto.id), t: "Mapear pasta" })));
    } else {
      const corpo = h("div", { c: "sugestoes-proj" }, h("p", { c: "t-meta texto-2", t: "Sem projeto ligado. O cérebro sugere:" }));
      for (const s of d.sugestoes || []) corpo.append(h("div", { c: "sugestao-proj" }, ic("i-projects"), h("span", { c: "nome", t: s.nome || s.projeto_id, style: "flex:1;min-width:0" }), h("span", { c: "t-meta texto-3", t: `${s.pontos} pts` }),
        h("button", { type: "button", c: "btn btn-24", t: "Ligar", on: { click: () => n.mudar(item.id, { projeto_id: s.projeto_id }, { toast: `${n.ref(item.id)}: projeto ${s.nome}.` }).then(() => { ctxCache.delete(item.id); desenhar(false); }).catch(() => {}) } })));
      if (!(d.sugestoes || []).length) corpo.firstChild.textContent = "Sem projeto ligado.";
      corpo.append(h("button", { type: "button", c: "btn btn-28", style: "justify-self:start", on: { click: (ev) => escolherProjeto(item, ev.currentTarget) } }, "Escolher projeto…"));
      painel.append(corpo);
    }
    const ligNotas = new Set(item.ligacoes.notas || []);
    const ligArqs = new Set((item.ligacoes.arquivos || []).map((a) => String(a.caminho).toLowerCase()));
    // 2. notas
    const notas = d.notas || [];
    if (notas.length) {
      const corpo = h("div");
      for (const nota of notas) corpo.append(itemNota(item, nota, ligNotas.has(nota.nota)));
      painel.append(secao("notas", "Notas de memória", notas.length, corpo, null));
    }
    // 3. arquivos
    const arqs = d.arquivos || [];
    if (arqs.length) {
      const corpo = h("div");
      const mostrar = (lim) => {
        limpar(corpo);
        arqs.slice(0, lim).forEach((a) => corpo.append(itemArquivo(item, a, pasta, ligArqs.has(String(a.caminho).toLowerCase()))));
        if (arqs.length > lim) corpo.append(h("button", { type: "button", c: "btn btn-sutil btn-28", t: `Mostrar mais ${arqs.length - lim}`, on: { click: () => mostrar(arqs.length) } }));
      };
      mostrar(5);
      painel.append(secao("arquivos", "Arquivos", arqs.length, corpo, null));
    }
    // 4. notas relacionadas por [[links]]
    const rel = d.notas_relacionadas || [];
    if (rel.length) {
      const corpo = h("div");
      for (const nota of rel) corpo.append(itemNota(item, Object.assign({ origem: "link" }, nota), false));
      painel.append(secao("notas-rel", "Notas relacionadas", rel.length, corpo, null));
    }
    // 5. pendências relacionadas
    const pend = (d.relacionadas || []).filter((r) => E.porId.has(r.id));
    if (pend.length) {
      const corpo = h("div");
      for (const r of pend) {
        const outra = E.porId.get(r.id);
        corpo.append(h("button", { type: "button", c: "linha-rel", on: { click: () => G.abrir(r.id, { via: "push", voltar: item.id, aba: abaDe.get(r.id) || "contexto" }) } },
          n.iconeStatus(outra.status), h("span", { c: "card-num", t: n.ref(r.id) }), h("span", { c: "t", t: outra.titulo }), n.quadrado(outra.area), h("span", { c: "m", t: r.motivo || "" })));
      }
      painel.append(secao("relacionadas", "Pendências relacionadas", pend.length, corpo, null));
    }
    // 6. pessoas
    const ps = n.pessoasDe(item);
    if (ps.length) {
      const corpo = h("div", { c: "chips-pessoas" });
      for (const p of ps) corpo.append(h("button", { type: "button", c: "chip-pessoa", "data-tip": `Filtrar o quadro por ${p}`, on: { click: () => Mesa.quadro.filtrarPessoa(p) } }, n.avatar(n.nomeCurto(p), true), p, h("span", { c: "papel", t: "pediu" })));
      painel.append(secao("pessoas", "Pessoas", ps.length, corpo, null));
    }
    if (!notas.length && !arqs.length && !pend.length) painel.append(h("p", { c: "vazio-texto", t: "O cérebro não achou nada ligado a esta pendência." }));
    if (d.como_ajuda) painel.append(h("p", { c: "item-porque", style: "margin:12px 0 0" }, h("b", { t: "Como o agente ajuda: " }), d.como_ajuda));
    painel.append(h("div", { style: "margin-top:12px" }, h("button", { type: "button", c: "btn btn-sutil btn-28", style: "margin-left:-10px", disabled: !n.podeEscrever() || null, on: { click: (ev) => ligarManual(item, ev.currentTarget, d.projeto) } }, ic("i-plus"), "Ligar arquivo ou nota")));
  }
  function acoesCaminho(item, caminho, ligado, tipoLig, chave) {
    const mais = h("button", { type: "button", c: "btn-icone b24", "aria-label": "Mais ações", "aria-haspopup": "menu", on: { click: (ev) => n.menu(ev.currentTarget, [
      { rotulo: "Mostrar na pasta", icone: "i-folder-open", acao: () => n.abrirCaminho(caminho, "explorer") },
      { rotulo: "Copiar caminho", icone: "i-copy", acao: () => n.copiar(caminho, "Caminho copiado.") },
      { separador: true },
      ligado ? { rotulo: "Não é relevante", icone: "i-unlink", desabilitado: !n.podeEscrever(), acao: () => desligar(item, tipoLig, chave) }
        : { rotulo: "Ligar à pendência", icone: "i-link", desabilitado: !n.podeEscrever(), acao: () => ligar(item, tipoLig, chave) },
    ], { rotulo: "Ações do arquivo" }) } }, ic("i-more"));
    return h("span", { c: "acoes" },
      h("button", { type: "button", c: "btn btn-sutil btn-24", "data-tip": "Abrir no VS Code", on: { click: () => n.abrirCaminho(caminho, "code") } }, "Abrir"),
      h("button", { type: "button", c: "btn-icone b24", "aria-label": "Copiar caminho", "data-tip": "Copiar caminho", on: { click: () => n.copiar(caminho, "Caminho copiado.") } }, ic("i-copy")), mais);
  }
  function itemNota(item, nota, ligada) {
    const el = h("div", { c: "item-ctx" });
    const arquivo = n.nomeArquivo(nota.caminho);
    el.append(h("div", { c: "item-l1" }, ic("i-note"), h("span", { c: "nome", t: nota.titulo || nota.nota, "data-tip-auto": nota.titulo || nota.nota }), nota.caminho ? acoesCaminho(item, nota.caminho, ligada, "nota", nota.nota) : null));
    el.append(h("div", { c: "item-l2" }, "memória do Claude · ", h("span", { c: "mono", t: arquivo || nota.nota })));
    if (nota.trecho) el.append(h("div", { c: "item-trecho" }, "“", n.trechoMarcado(nota.trecho), "”"));
    const porque = ligada ? "ligada a esta pendência" : nota.origem === "link" ? "citada por [[link]] numa nota ligada" : nota.origem === "busca" ? "achada na busca do cérebro" : "ligada a esta pendência";
    el.append(h("div", { c: "item-porque" }, h("b", { t: "Por quê: " }), porque));
    el.addEventListener("click", (ev) => { if (!ev.target.closest("button,a")) el.classList.toggle("expandido"); });
    return el;
  }
  function itemArquivo(item, a, pasta, ligado) {
    const el = h("div", { c: "item-ctx" });
    const nome = n.nomeArquivo(a.caminho);
    const rel = pasta && a.caminho.toLowerCase().startsWith(pasta.toLowerCase() + "\\") ? a.caminho.slice(pasta.length + 1) : a.caminho;
    el.append(h("div", { c: "item-l1" }, ic(n.iconeArquivo(a.caminho)), h("span", { c: "nome", t: a.titulo && a.tipo !== "memoria" && a.tipo !== "doc" ? nome : nome, "data-tip": a.caminho }), a.existe === false ? h("span", { c: "tag tag-sumiu tag-peq", t: "Sumiu" }) : null, acoesCaminho(item, a.caminho, ligado, "arquivo", a.caminho)));
    el.append(h("div", { c: "item-l2" }, h("span", { c: "mono", t: rel })));
    if (a.trecho) {
      const codigo = ["sql", "codigo", "tmdl", "config"].includes(a.tipo);
      el.append(h("div", { c: "item-trecho" + (codigo ? " codigo" : "") }, codigo ? null : "“", n.trechoMarcado(a.trecho), codigo ? null : "”"));
    }
    const porque = a.motivo || (ligado ? "ligado a esta pendência" : a.origem === "busca" ? "achado na busca do cérebro" : "ligado a esta pendência");
    el.append(h("div", { c: "item-porque" }, h("b", { t: "Por quê: " }), porque));
    el.addEventListener("dblclick", (ev) => { if (!ev.target.closest("button")) n.abrirCaminho(a.caminho, "code"); });
    el.addEventListener("click", (ev) => { if (!ev.target.closest("button,a")) el.classList.toggle("expandido"); });
    return el;
  }
  async function salvarLigacoes(item, novas, rotulo) {
    try {
      await n.mudar(item.id, { ligacoes: novas }, { toast: rotulo });
      ctxCache.delete(item.id);
      desenhar(false);
    } catch (e) { /* toast já mostrado */ }
  }
  function desligar(item, tipo, chave) {
    const lg = JSON.parse(JSON.stringify(item.ligacoes));
    if (tipo === "nota") lg.notas = lg.notas.filter((x) => x !== chave);
    else lg.arquivos = lg.arquivos.filter((x) => String(x.caminho).toLowerCase() !== String(chave).toLowerCase());
    salvarLigacoes(item, lg, "Ligação removida.");
  }
  function ligar(item, tipo, chave, motivo) {
    const lg = JSON.parse(JSON.stringify(item.ligacoes));
    if (tipo === "nota") { if (!lg.notas.includes(chave)) lg.notas.push(chave); }
    else if (!lg.arquivos.some((x) => String(x.caminho).toLowerCase() === String(chave).toLowerCase())) lg.arquivos.push({ caminho: chave, motivo: motivo || "ligado à mão" });
    salvarLigacoes(item, lg, tipo === "nota" ? "Nota ligada." : "Arquivo ligado.");
  }
  function ligarManual(item, ancora, projeto) {
    const input = h("input", { type: "search", c: "campo", placeholder: "Buscar no índice pelo nome ou assunto", "aria-label": "Buscar arquivo ou nota", autocomplete: "off" });
    const lista = h("div", { c: "pop-lista", role: "listbox" });
    let timer = 0, seq = 0;
    const buscar = async () => {
      const q = input.value.trim();
      const meu = ++seq;
      limpar(lista);
      if (q.length < 3) { lista.append(h("div", { c: "menu-vazio", t: "Digite pelo menos 3 letras." })); return; }
      lista.append(h("div", { c: "menu-vazio" }, n.spinner(true), " Procurando…"));
      try {
        const r = await n.api("GET", `/api/cerebro/busca?q=${encodeURIComponent(q)}${projeto ? "&projeto=" + encodeURIComponent(projeto.id) : ""}`, null, { tempo: 15000 });
        if (meu !== seq) return;
        limpar(lista);
        const res = r.resultados || [];
        if (!res.length) lista.append(h("div", { c: "menu-vazio", t: "Nada com esse termo no índice." }));
        for (const x of res) {
          const ehNota = x.tipo === "memoria" && x.nota;
          lista.append(h("button", { type: "button", c: "menu-item", role: "option", style: "height:auto;min-height:36px;padding:4px 8px", on: { click: () => { pop.fechar(); ligar(item, ehNota ? "nota" : "arquivo", ehNota ? x.nota : x.caminho); } } },
            ic(ehNota ? "i-note" : n.iconeArquivo(x.caminho)), h("span", { c: "rot", style: "display:grid" }, h("span", { t: x.titulo || n.nomeArquivo(x.caminho) }), h("span", { c: "t-caption texto-3", t: x.caminho }))));
        }
      } catch (e) { if (meu === seq) { limpar(lista); lista.append(h("div", { c: "menu-vazio", t: "Não consegui consultar o cérebro." })); } }
    };
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(buscar, 300); });
    input.addEventListener("keydown", (ev) => { if (ev.key === "ArrowDown") { ev.preventDefault(); const b = lista.querySelector("button"); if (b) b.focus(); } });
    lista.addEventListener("keydown", (ev) => {
      const bs = $$("button", lista), k = bs.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" && k < bs.length - 1) { ev.preventDefault(); bs[k + 1].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); if (k <= 0) input.focus(); else bs[k - 1].focus(); }
    });
    const pop = n.popover(ancora, h("div", { style: "width:360px;display:grid;gap:6px" }, h("div", { c: "t-meta texto-2", t: "Ligar arquivo ou nota" }), input, lista), { rotulo: "Ligar arquivo ou nota", foco: "input" });
  }

  // ------------------------------------------------------------------ aba Histórico
  function desenharHistorico(painel, item) {
    const origem = h("div", { c: "hist-origem" }, h("div", { c: "rot", t: "Origem" }));
    const o = item.origem || "";
    const ehChat = /chat|teams|conversa|reuni/i.test(o);
    origem.append(h("div", { c: "linha" }, ic(ehChat ? "i-chat" : /e-?mail/i.test(o) ? "i-mail" : "i-info"), h("span", { t: o || "Sem origem registrada" }), n.ehData(item.pedido_em) ? h("span", { c: "texto-2", t: `· pedido em ${n.dataComSemana(item.pedido_em)}` }) : null));
    painel.append(origem);
    const ta = h("textarea", { placeholder: "Escrever nota…", "aria-label": "Escrever nota", rows: "1", maxlength: "300" });
    const salvar = h("button", { type: "button", c: "btn btn-24", t: "Salvar nota", disabled: true });
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight) + "px"; salvar.disabled = !ta.value.trim(); });
    ta.addEventListener("focus", comecarEdicao);
    ta.addEventListener("blur", terminarEdicao);
    const enviar = async () => {
      const v = ta.value.trim();
      if (!v) return;
      if (!n.podeEscrever()) return n.semConexao();
      salvar.disabled = true;
      try { await n.mudar(item.id, {}, { nota: v, toast: "Nota salva no histórico." }); ta.value = ""; } catch (e) { salvar.disabled = false; }
    };
    ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(); } else if (ev.key === "Escape" && ta.value) { ev.stopPropagation(); ta.value = ""; ta.blur(); } });
    salvar.addEventListener("click", enviar);
    painel.append(h("div", { c: "hist-nota" }, ta, h("div", { c: "dica" }, "Ctrl+Enter salva", salvar)));
    const eventos = [...item.historico].reverse();
    if (eventos.length <= 1 && (!eventos[0] || /^criada/i.test(String(eventos[0].texto)))) painel.append(h("p", { c: "vazio-texto", t: "Sem atividade além da criação." }));
    let diaAtual = "", ul = null;
    for (const ev of eventos) {
      const dia = n.isoDeTs(ev.em);
      if (dia !== diaAtual) {
        diaAtual = dia;
        painel.append(h("div", { c: "hist-dia", t: dia ? n.diaTitulo(dia) : "Sem data" }));
        ul = h("ul", { c: "hist-lista" });
        painel.append(ul);
      }
      const ator = n.ORIGEM_ATOR[ev.origem] || ev.origem || "Alguém";
      const t = String(ev.texto || "");
      const icone = /criada/i.test(t) ? "i-plus" : /agora feita|marcada como feita/i.test(t) ? "i-status-done" : /agente/i.test(t) ? "i-run" : /descartada/i.test(t) ? "i-discard" : ev.origem === "assistente" ? "i-prompt" : ev.origem === "claude-code" ? "i-chat" : "i-edit";
      ul.append(h("li", { c: "hist-item" }, h("span", { c: "ic" }, ic(icone)), h("span", { c: "tx" }, h("b", { t: ator }), " · ", t), h("span", { c: "hr", t: n.horaDeTs(ev.em) })));
    }
    painel.append(h("p", { c: "hist-rodape", t: "O servidor guarda os 30 eventos mais recentes." }));
  }

  // ------------------------------------------------------------------ Resumo de hoje
  function desenharResumo() {
    const r = h("div", { c: "gaveta-corpo resumo" });
    const h0 = n.hoje();
    const abertas = E.itens.filter((i) => !n.fechada(i));
    r.append(h("div", { c: "resumo-cab" }, h("div", { style: "flex:1" }, h("h2", { tabindex: "-1", t: "Resumo de hoje" }), h("div", { c: "resumo-data", t: `${n.DSEM_LONGO[n.diaSemana(h0)]}, ${n.dataLonga(h0)}` })),
      h("button", { type: "button", c: "btn-icone", "aria-label": "Fechar o resumo", on: { click: () => G.fechar() } }, ic("i-dismiss"))));
    const linhaR = (i, direita) => h("button", { type: "button", c: "resumo-linha", on: { click: () => G.abrir(i.id, { via: "push" }) } }, n.iconeStatus(i.status), h("span", { c: "card-num", t: n.ref(i.id) }), h("span", { c: "t", t: i.titulo }), direita);
    const bloco = (titulo, itens, direita, extra) => {
      if (!itens.length) return null;
      const b = h("div", { c: "resumo-bloco" }, h("h3", {}, titulo, h("span", { c: "num", t: extra || String(itens.length) })));
      for (const i of itens.slice(0, 12)) b.append(linhaR(i, direita(i)));
      return b;
    };
    const atrasadas = abertas.filter(n.atrasada).sort((a, b) => a.prazo.localeCompare(b.prazo));
    const hoje = abertas.filter(n.venceHoje);
    const entregas = n.entregasNaoVistas().concat(abertas.filter((i) => { const a = n.estadoAgente(i); return a && a.estado === "entrega" && !a.naoVista; })).filter((v, k, arr) => arr.indexOf(v) === k);
    const paradas = abertas.filter((i) => i.status === "aguardando" && n.diasParada(i) > 5).sort((a, b) => n.diasParada(b) - n.diasParada(a));
    const andamento = abertas.filter((i) => i.status === "andamento");
    const lim = E.limiteAndamento;
    const blocos = [
      bloco("Atrasadas", atrasadas, (i) => n.chip(n.prazoInfo(i, "cartao"))),
      bloco("Vencem hoje", hoje, (i) => n.chip(n.prazoInfo(i, "cartao"))),
      bloco("Entregas para revisar", entregas, (i) => h("span", { c: "t-meta", style: "color:var(--done)" }, ic("i-delivery"), ` ${(i.agente.ultima.entregas || []).length} ${n.plural((i.agente.ultima.entregas || []).length, "arquivo", "arquivos")}`)),
      bloco("Paradas há mais de 5 dias", paradas, (i) => h("span", { c: "chip chip-parada" }, ic("i-hourglass-12"), `Parada há ${n.diasParada(i)} d`)),
      bloco("Em andamento", andamento, (i) => { const ps = n.pessoasDe(i); return ps.length ? h("span", { c: "t-meta texto-2", t: n.nomeCurto(ps[0]) + (ps.length > 1 ? ` +${ps.length - 1}` : "") }) : null; }, lim ? `${andamento.length}/${lim}` : null),
    ].filter(Boolean);
    if (Mesa.teams.disponivel() && Mesa.teams.novidades.length) blocos.unshift(h("div", { c: "resumo-bloco" }, h("h3", { t: "Novidades do Teams" })));
    if (!blocos.length) r.append(h("p", { c: "vazio-texto", style: "margin-top:16px", t: "Nada vencendo hoje." }));
    r.append(...blocos);
    return r;
  }

  // ------------------------------------------------------------------ reação a dados e eventos
  Mesa.ouvir("dados", ({ externo, mudados }) => {
    if (!elGaveta) return;
    if (!id) { if (resumoAberto || (G.painelVisivel() && modo() === "split")) desenhar(false); return; }
    if (!E.porId.has(id)) { const era = id; id = null; E.abertaId = null; if (modo() !== "split") { desenhar(true); Mesa.emitir("gaveta"); } else desenhar(true); n.anunciar(`${n.ref(era)} saiu do quadro.`); return; }
    const item = E.porId.get(id);
    if (externo && mudados && mudados.includes(id)) avisoExterno = `Atualizada ${ATOR_EXTERNO[item.atualizado_por] || "fora do painel"} agora`;
    if (editando) { pendente = true; const t = elGaveta.querySelector(".gaveta-topo"); if (t) t.replaceWith(desenharTopo(item)); return; }
    const aba = abaDe.get(id) || "contexto";
    if (aba === "agente" && Mesa.agente.editandoAba && Mesa.agente.editandoAba()) {
      const t = elGaveta.querySelector(".gaveta-topo"); if (t) t.replaceWith(desenharTopo(item));
      const cab = elGaveta.querySelector(".g-cab"); if (cab) cab.replaceWith(desenharCabecalho(item));
      return;
    }
    desenhar(false);
  });
  Mesa.ouvir("agente", (p) => {
    if (!id || !elGaveta || elGaveta.hidden) return;
    const aba = abaDe.get(id) || "contexto";
    if (aba === "agente") Mesa.agente.atualizarAba && Mesa.agente.atualizarAba(id, p);
    const b = elGaveta.querySelector('.aba[data-aba="agente"]');
    if (b) {
      for (const x of b.querySelectorAll(".i,.ponto-aba")) x.remove();
      const ag = n.estadoAgente(E.porId.get(id));
      if (ag && ag.estado === "trabalhando") b.append(n.spinner(true));
      else if (ag && ag.estado === "entrega" && ag.naoVista) b.append(h("span", { c: "ponto-aba", "aria-label": "entrega nova" }));
    }
  });
  Mesa.ouvir("dia", () => desenhar(false));
  Mesa.ouvir("servidor", () => { if (!editando) desenhar(false); });
  Mesa.ouvir("status", (s) => { if (G._recursosVistos !== JSON.stringify(E.recursos)) { G._recursosVistos = JSON.stringify(E.recursos); if (!editando) desenhar(false); } });
  Mesa.ouvir("projetos", () => { if (id && !editando) desenhar(false); });
  Mesa.ouvir("pagina", () => desenhar(false));
  Mesa.ouvir("layout", () => { aplicarModo(); });

  G.iniciar = () => {
    elGaveta = $("#gaveta");
    $("#scrim").addEventListener("click", () => G.fechar());
    elGaveta.addEventListener("keydown", (ev) => {
      if (ev.defaultPrevented) return;
      const emCampo = n.ehCampo(ev.target);
      if (ev.altKey && !ev.ctrlKey && /^[123]$/.test(ev.key) && id) { ev.preventDefault(); trocarAba(ABAS[Number(ev.key) - 1][0], true); return; }
      if (ev.key === "Escape" && !emCampo) {
        if (n.temCamada("menu") || n.temCamada("popover") || n.temCamada("confirma")) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (modo() === "split") { if (id) Mesa.quadro.focar(id); else Mesa.quadro.focar(E.foco); }
        else G.fechar();
        return;
      }
      if (!emCampo && !ev.ctrlKey && !ev.altKey && !ev.metaKey && E.atalhosUmaTecla !== false && id) {
        if (ev.key === "j" || ev.key === "J") { ev.preventDefault(); G.proxima(1); return; }
        if (ev.key === "k" || ev.key === "K") { ev.preventDefault(); G.proxima(-1); return; }
      }
      if (ev.key === "Tab" && modo() !== "split") {
        const focaveis = $$('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),[tabindex="0"],select', elGaveta).filter((x) => x.offsetParent);
        if (!focaveis.length) return;
        const pri = focaveis[0], ult = focaveis[focaveis.length - 1];
        if (ev.shiftKey && document.activeElement === pri) { ev.preventDefault(); ult.focus(); }
        else if (!ev.shiftKey && document.activeElement === ult) { ev.preventDefault(); pri.focus(); }
      }
    });
    window.addEventListener("resize", () => { const m = modo(); if (m !== G._ultimoModo) { G._ultimoModo = m; desenhar(false); Mesa.quadro.render(true); } else aplicarModo(); });
    G._ultimoModo = modo();
    desenhar(true);
  };
})();
