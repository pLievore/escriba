/* Escriba: aplicação.
   Roteamento por hash (#/quadro?visao=…&area=…&q=…&p=3, #/lista, #/projetos[/id], #/arquivo, #/config),
   atalhos globais (Ctrl+K, /, ?, N, V, R, ], G+letra, Ctrl+Z), barra de status, diálogo de atalhos,
   menu do avatar e a inicialização (carga, polling de versão a cada 10 s, saúde do servidor). */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, $$, limpar } = n;
  const App = (Mesa.app = {});
  const PAGINAS = { quadro: "Quadro", lista: "Lista", radar: "Radar", daily: "Daily", projetos: "Projetos", arquivo: "Arquivo", config: "Configurações" };
  let pAbrir = null, gPendente = 0, dicaG = false, aplicandoUrl = false;

  // ------------------------------------------------------------------ URL
  function lerUrl() {
    const bruto = (location.hash || "#/quadro").replace(/^#\/?/, "");
    const [rota, qs] = bruto.split("?");
    const partes = rota.split("/").filter(Boolean);
    return { pagina: PAGINAS[partes[0]] ? partes[0] : "quadro", sub: partes[1] ? decodeURIComponent(partes[1]) : "", params: new URLSearchParams(qs || "") };
  }
  function montarHash() {
    if (["projetos", "arquivo", "config", "daily", "radar"].includes(E.pagina)) return location.hash;
    const p = new URLSearchParams();
    const f = E.filtros;
    if (E.visao !== "tudo") p.set("visao", E.visao);
    if (f.areas.size) p.set("area", [...f.areas].map(n.slug).join(","));
    if (f.pessoas.size) p.set("pessoa", [...f.pessoas].join(","));
    if (f.prioridades.size) p.set("prio", [...f.prioridades].join(","));
    if (f.sinais.size) p.set("sinal", [...f.sinais].join(","));
    if (f.texto.trim()) p.set("q", f.texto.trim());
    if (E.raias) p.set("raias", E.raias);
    if (E.abertaId && E.numero.get(E.abertaId)) p.set("p", String(E.numero.get(E.abertaId)));
    const qs = p.toString().replace(/%2C/g, ",");
    return `#/${E.modo === "lista" ? "lista" : "quadro"}${qs ? "?" + qs : ""}`;
  }
  function escreverUrl(push) {
    if (aplicandoUrl) return;
    const novo = montarHash();
    if (novo === location.hash) return;
    if (push) history.pushState(null, "", novo); else history.replaceState(null, "", novo);
  }
  function aplicarUrl() {
    aplicandoUrl = true;
    try {
      const u = lerUrl();
      const anterior = E.pagina;
      if (anterior === "projetos" && u.pagina !== "projetos" && Mesa.paginas.temRascunho()) { /* o detalhe já avisa ao trocar de projeto; ao sair da página, o rascunho se perde */ }
      E.pagina = u.pagina;
      if (u.pagina === "quadro" || u.pagina === "lista") {
        E.modo = u.pagina;
        n.gravarPref("mesa.modo", E.modo);
        const pr = u.params;
        const temFiltro = ["visao", "area", "pessoa", "prio", "sinal", "q", "raias"].some((k) => pr.has(k));
        if (temFiltro || pr.has("p")) {
          const f = E.filtros;
          if (pr.has("visao") && ["hoje", "semana", "tudo"].includes(pr.get("visao"))) E.visao = pr.get("visao");
          else if (temFiltro) E.visao = "tudo";
          const slugs = new Set((pr.get("area") || "").split(",").filter(Boolean));
          f.areas = new Set(n.AREAS.filter((a) => slugs.has(n.slug(a.nome))).map((a) => a.nome));
          f.pessoas = new Set((pr.get("pessoa") || "").split(",").filter((x, k, arr) => pr.has("pessoa")));
          if (!pr.has("pessoa")) f.pessoas = new Set();
          f.prioridades = new Set((pr.get("prio") || "").split(",").filter((x) => n.PRIO[x]));
          f.sinais = new Set((pr.get("sinal") || "").split(",").filter((x) => ["atrasadas", "hoje", "aguardando", "entregas"].includes(x)));
          f.texto = pr.get("q") || "";
          if (pr.has("raias")) E.raias = ["area", "projeto"].includes(pr.get("raias")) ? pr.get("raias") : "";
        }
        const p = Number(pr.get("p") || 0);
        if (p) {
          if (E.carregado) { const id = E.porNumero.get(p); if (id && id !== E.abertaId) Mesa.gaveta.abrir(id, { semFoco: true }); }
          else pAbrir = p;
        } else if (E.abertaId && Mesa.gaveta.modo() !== "split") Mesa.gaveta.fechar({ semFoco: true });
        else if (E.abertaId && anterior === E.pagina) Mesa.gaveta.fechar({ semFoco: true, manterPainel: true });
      }
      mostrarPagina(u);
    } finally { aplicandoUrl = false; }
    escreverUrl(false);
  }
  function mostrarPagina(u) {
    const app = $("#app");
    app.dataset.pagina = E.pagina;
    $("#topo-pagina").textContent = PAGINAS[E.pagina];
    document.title = tituloDoc();
    for (const a of $$(".nav-item[data-nav]")) {
      const alvo = a.dataset.nav;
      const atual = alvo === E.pagina || (alvo === "quadro" && E.pagina === "lista");
      if (atual) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    const quadro = E.pagina === "quadro" || E.pagina === "lista";
    $("#trabalho").setAttribute("aria-label", quadro ? "Quadro de pendências" : PAGINAS[E.pagina]);
    $("#pagina").hidden = quadro;
    if (!quadro) { $("#quadro").hidden = true; $("#lista").hidden = true; $("#aviso-filtros").hidden = true; Mesa.paginas.mostrar(E.pagina, u.sub); }
    else if (Mesa.radar) Mesa.radar.sair();   // sai do Modo TV ao voltar para o quadro
    $("#nav").classList.remove("aberta");
    Mesa.quadro.render(true);
    Mesa.gaveta.redesenhar();
    renderStatus();
  }
  Mesa.ouvir("url", ({ push }) => escreverUrl(push));
  Mesa.ouvir("filtros", () => { escreverUrl(false); renderStatus(); });
  Mesa.ouvir("pagina", () => { escreverUrl(false); mostrarPagina(lerUrl()); });

  // ------------------------------------------------------------------ título da aba
  function tituloDoc() {
    const novas = n.entregasNaoVistas().length;
    return `${novas ? `(${novas}) ` : ""}Escriba${E.pagina !== "quadro" ? " · " + PAGINAS[E.pagina] : ""}`;
  }

  // ------------------------------------------------------------------ barra de status
  function renderStatus() {
    const st = $("#status");
    if (!st) return;
    limpar(st);
    const s = E.status || {};
    const estados = { ok: ["ponto-ok", "Servidor local"], lento: ["ponto-lento", "Servidor lento"], fora: ["ponto-fora", "Servidor fora"], verificando: ["", "Verificando…"] };
    const [cls, rot] = estados[E.servidor] || estados.verificando;
    const resp = E.ultimaResposta ? Math.round((Date.now() - E.ultimaResposta) / 1000) : null;
    const tip = `${location.host}${resp != null ? ` · respondeu há ${resp} s` : ""}${s.modelo ? ` · assistente: modelo ${s.modelo}` : ""}${s.assistente === false ? " · Claude Code CLI não encontrado" : ""}`;
    st.append(h("button", { type: "button", c: "st-item", "data-tip": tip, "aria-label": `${rot}. Testar a conexão`, on: { click: () => n.verificarStatus() } }, h("span", { c: "ponto " + cls }), rot));
    st.append(h("span", { c: "st-sep", t: "·" }));
    if (E.sync === "salvando") st.append(h("span", { c: "st-item" }, n.spinner(true), "Salvando…"));
    else if (E.sync === "salvo") st.append(h("span", { c: "st-item", t: "Salvo" }));
    else if (E.sync === "erro") st.append(h("button", { type: "button", c: "st-item st-erro", t: "Não salvou · Tentar de novo", "data-tip": E.syncErro ? E.syncErro.message : null, on: { click: () => { n.definirSync(""); n.recarregar({ barra: true }); } } }));
    else st.append(h("span", { c: "st-item", t: E.ultimaSync ? `sincronizado ${n.horaDeTs(new Date(E.ultimaSync).toISOString())}` : "aguardando dados" }));
    const meta = E.meta || {};
    const leTeams = Mesa.teams.disponivel();
    if (meta.ultima_leitura_teams) {
      const velho = Date.now() - new Date(meta.ultima_leitura_teams).getTime() > 864e5;
      const tipT = `Última leitura do Teams${meta.chats_lidos ? `: ${meta.chats_lidos} chats` : ""}${meta.periodo_lido ? `, ${meta.periodo_lido}` : ""}${leTeams ? " · clique para atualizar" : ""}`;
      const texto = `Teams lido ${n.ddmm(n.isoDeTs(meta.ultima_leitura_teams))} ${n.horaDeTs(meta.ultima_leitura_teams)}`;
      st.append(h("span", { c: "st-sep", t: "·" }), leTeams
        ? h("button", { type: "button", id: "st-teams", c: "st-item" + (velho ? " st-velho" : ""), "data-tip": tipT, "aria-haspopup": "dialog", on: { click: (ev) => Mesa.teams.painel(ev.currentTarget) } }, velho ? ic("i-warning-12") : null, texto)
        : h("span", { c: "st-item" + (velho ? " st-velho" : ""), "data-tip": tipT }, velho ? ic("i-warning-12") : null, texto));
    } else if (leTeams) {
      st.append(h("span", { c: "st-sep", t: "·" }), h("button", { type: "button", id: "st-teams", c: "st-item st-velho", "data-tip": "Ler as conversas do Teams e atualizar o quadro", "aria-haspopup": "dialog", on: { click: (ev) => Mesa.teams.painel(ev.currentTarget) } }, ic("i-warning-12"), "Teams nunca lido"));
    }
    const meio = h("div", { c: "st-meio" });
    const emTeams = Mesa.teams.emCurso();
    if (emTeams) meio.append(h("button", { type: "button", c: "st-pilula", "aria-label": "Ver a leitura do Teams", on: { click: (ev) => Mesa.teams.painel(ev.currentTarget) } }, n.spinner(true), "Lendo o Teams", emTeams.inicio ? h("span", { c: "num" }, " · ", h("span", { "data-teams-cron": emTeams.inicio, t: n.cronometro(Date.now() - new Date(emTeams.inicio).getTime()) })) : null));
    const ped = Mesa.paleta.pedidoEmCurso();
    if (ped) meio.append(h("button", { type: "button", c: "st-pilula", "aria-label": "Ver o pedido ao assistente", on: { click: () => Mesa.paleta.verPedido() } }, n.spinner(true), h("span", { d: { segPilula: "1" }, t: `Assistente · ${Math.floor((Date.now() - ped.inicio) / 1000)} s` })));
    const ativas = Mesa.agente.ativas();
    if (ativas.length === 1) {
      const ex = ativas[0];
      const ini = ex.inicio || ex.criada;
      meio.append(h("button", { type: "button", c: "st-pilula", on: { click: () => Mesa.gaveta.abrir(ex.pendencia_id, { via: "push", aba: "agente" }) } }, n.spinner(true), `Agente em ${n.ref(ex.pendencia_id)}`, ini ? h("span", { c: "num", d: { cron: ini }, t: ` · ${n.cronometro(Date.now() - new Date(ini).getTime())}` }) : null));
    } else if (ativas.length > 1) {
      meio.append(h("button", { type: "button", c: "st-pilula", "aria-haspopup": "menu", on: { click: (ev) => n.menu(ev.currentTarget, ativas.map((ex) => ({ rotulo: `${n.ref(ex.pendencia_id)} · ${(E.porId.get(ex.pendencia_id) || {}).titulo || ""}`, acao: () => Mesa.gaveta.abrir(ex.pendencia_id, { via: "push", aba: "agente" }) }))) } }, n.spinner(true), `${ativas.length} execuções do agente`));
    }
    if (dicaG) meio.append(h("span", { c: "st-dica", t: "G…  Q Quadro · L Lista · D Daily · P Projetos · A Arquivo · C Config. · H Hoje · S Semana · T Tudo" }));
    st.append(meio);
    const dir = h("div", { c: "st-dir" });
    if (E.carregado && (E.pagina === "quadro" || E.pagina === "lista")) {
      const total = E.itens.filter((i) => i.status !== "descartada").length;
      if (Mesa.quadro.filtrosAtivos()) {
        const vis = E.itens.filter(Mesa.quadro.visivel).length;
        dir.append(h("span", { c: "st-item" }, h("span", { c: "num", t: String(vis) }), ` de `, h("span", { c: "num", t: String(total) }), " visíveis"), h("span", { c: "st-sep", t: "·" }), h("button", { type: "button", c: "st-item", t: "Limpar filtros", on: { click: () => Mesa.quadro.limparFiltros() } }));
      } else dir.append(h("span", { c: "st-item" }, h("span", { c: "num", t: String(total) }), ` ${n.plural(total, "pendência", "pendências")}`));
      dir.append(h("span", { c: "st-sep", t: "·" }));
    }
    dir.append(h("button", { type: "button", c: "st-item", on: { click: () => Mesa.paleta.abrir() } }, "Ctrl K comandos"), h("span", { c: "st-sep", t: "·" }), h("button", { type: "button", c: "st-item", on: { click: () => App.atalhos() } }, "? atalhos"));
    st.append(dir);
    document.title = tituloDoc();
    const ponto = $("#ponto-celular");
    if (ponto) { ponto.style.background = E.servidor === "ok" ? "var(--done)" : E.servidor === "lento" ? "var(--today)" : E.servidor === "fora" ? "var(--overdue)" : "var(--text-3)"; ponto.setAttribute("aria-label", `Servidor: ${rot}`); }
    const espera = $("#caixa-paleta-espera");
    if (espera) {
      limpar(espera);
      $("#caixa-paleta").classList.toggle("ocupada", !!ped);
      if (ped) espera.append(n.spinner(true), h("span", { d: { segPilula: "1" }, t: `${Math.floor((Date.now() - ped.inicio) / 1000)} s` }));
    }
  }
  for (const ev of ["servidor", "sync", "dados", "assistente", "agente", "teams", "status", "vistas", "gaveta"]) Mesa.ouvir(ev, () => renderStatus());
  Mesa.ouvir("assistente-tique", (s) => { for (const el of $$("[data-seg-pilula]")) el.textContent = el.closest(".caixa-paleta") ? `${s} s` : `Assistente · ${s} s`; });

  // ------------------------------------------------------------------ diálogo de atalhos
  const ATALHOS = [
    ["Global", [["Ctrl K", "Abre a paleta de comandos e o assistente"], ["/", "Foca Filtrar"], ["?", "Mostra os atalhos"], ["N", "Nova pendência"], ["V", "Alterna Quadro e Lista"], ["R", "Liga ou desliga as raias"], ["]", "Mostra ou oculta o painel (Resumo de hoje)"], ["Shift D", "Alterna Confortável e Compacta"], ["F", "Foca o primeiro filtro"], ["Shift F", "Limpa os filtros"], ["A", "Liga ou desliga Atrasadas"], ["G Q / L / R / D / P / A / C", "Quadro / Lista / Radar / Daily / Projetos / Arquivo / Configurações"], ["G H / S / T", "Visão Hoje / Esta semana / Tudo"], ["Ctrl Z", "Desfaz a última ação (fora de campos)"], ["Ctrl Y", "Refaz"], ["Esc", "Fecha a camada mais alta"]]],
    ["Cartão em foco", [["↑ ↓ ou K J", "Cartão anterior ou próximo"], ["← →", "Coluna vizinha"], ["Home End", "Primeiro ou último da coluna"], ["Enter", "Abre o detalhe"], ["F2", "Edita o título"], ["Shift 1 a 4", "Move para A fazer, Em andamento, Aguardando, Concluído"], ["Ctrl ← →", "Move para a coluna vizinha"], ["Ctrl ↑ ↓", "Reordena na coluna (ordem manual)"], ["Ctrl Shift ↑ ↓", "Troca de raia"], ["Espaço", "Pega ou solta (setas movem, Esc cancela)"], ["P", "Prioridade"], ["D", "Prazo"], ["Q", "Pedido por"], ["Shift P", "Área"], ["B", "Agente: preparar briefing (Enter começa)"], ["M", "Agente: rascunhar resposta (Enter começa)"], ["Shift E", "Agente: executar tarefa (com confirmação)"], ["X", "Seleciona ou desmarca"], ["Shift ↑ ↓", "Estende a seleção"], ["Ctrl A", "Seleciona a coluna"], ["Ctrl C", "Copia a referência"], ["Delete", "Descarta (vai para o Arquivo)"], ["Shift F10", "Menu de contexto"]]],
    ["Gaveta", [["J K", "Próxima ou anterior"], ["Alt 1 2 3", "Contexto, Agente, Histórico"], ["← →", "Troca de aba (na lista de abas)"], ["Ctrl Enter", "Salva a descrição ou a nota"], ["Esc", "Devolve o foco ao cartão ou fecha"]]],
    ["Paleta", [["↑ ↓", "Move entre itens"], ["↑ com o campo vazio", "Pedidos anteriores"], ["Enter", "Executa o item ativo"], ["Ctrl Enter", "Pergunta ao assistente"], ["> # @ + ?", "Só comandos, pendências, pessoas, áreas e projetos, assistente"], ["Backspace", "Remove o chip de contexto (campo vazio)"], ["Esc", "Fecha; com pedido em curso, continua em segundo plano"]]],
    ["Compositor", [["Enter", "Cria e continua"], ["Shift Enter", "Cria e abre o detalhe"], ["Tab", "Aceita a sugestão (@pessoa, +área)"], ["Esc", "Fecha (o rascunho fica guardado por 24 h)"]]],
  ];
  let camadaAtalhos = null, focoAntesAtalhos = null;
  App.atalhos = () => {
    const fundo = $("#atalhos-fundo"), dlg = $("#atalhos");
    if (!fundo.hidden) return fecharAtalhos();
    focoAntesAtalhos = document.activeElement;
    limpar(dlg);
    const filtro = h("input", { type: "search", c: "campo", placeholder: "Filtrar atalhos", "aria-label": "Filtrar atalhos", style: "width:220px;height:28px" });
    const corpo = h("div", { c: "dialogo-corpo" });
    const desenhar = () => {
      limpar(corpo);
      const q = n.norm(filtro.value.trim());
      for (const [grupo, lista] of ATALHOS) {
        const linhas = lista.filter(([k, d]) => !q || n.norm(k + " " + d).includes(q));
        if (!linhas.length) continue;
        corpo.append(h("div", { c: "at-grupo" }, h("h3", { t: grupo }), h("table", {}, h("tbody", {}, linhas.map(([k, d]) => h("tr", {}, h("td", {}, h("span", { c: "kbds" }, k.split(" ").map((t) => (t.length <= 12 && !/^(com|o|campo|vazio|ou|a|\/)$/.test(t) ? h("kbd", { t }) : " " + t + " ")))), h("td", { t: d })))))));
      }
      if (!corpo.children.length) corpo.append(h("p", { c: "vazio-texto", t: "Nenhum atalho com esse filtro." }));
    };
    filtro.addEventListener("input", desenhar);
    dlg.append(h("div", { c: "dialogo-cab" }, h("h2", { id: "atalhos-titulo", t: "Atalhos de teclado" }), filtro, h("button", { type: "button", c: "btn-icone", "aria-label": "Fechar", on: { click: fecharAtalhos } }, ic("i-dismiss"))), corpo,
      E.atalhosUmaTecla === false ? h("p", { c: "t-meta texto-3", style: "padding:0 16px 12px", t: "Os atalhos de uma tecla estão desligados em Configurações." }) : null);
    desenhar();
    fundo.hidden = false;
    camadaAtalhos = n.empilharCamada({ tipo: "dialogo", fechar: fecharAtalhos });
    fundo.onpointerdown = (ev) => { if (ev.target === fundo) fecharAtalhos(); };
    dlg.onkeydown = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); fecharAtalhos(); } };
    requestAnimationFrame(() => filtro.focus());
  };
  function fecharAtalhos() {
    const fundo = $("#atalhos-fundo");
    if (fundo.hidden) return;
    fundo.hidden = true;
    n.tirarCamada(camadaAtalhos);
    if (focoAntesAtalhos && document.contains(focoAntesAtalhos)) focoAntesAtalhos.focus();
  }

  // ------------------------------------------------------------------ menu do avatar
  function menuAvatar(ancora) {
    const tema = window.mesaTemaAtual ? window.mesaTemaAtual() : "sistema";
    n.menu(ancora, [
      { titulo: "Tema" },
      ...[["sistema", "Sistema"], ["claro", "Claro"], ["escuro", "Escuro"]].map(([v, r]) => ({ tipo: "radio", rotulo: r, marcado: tema === v, acao: () => window.mesaTema(v) })),
      { separador: true }, { titulo: "Densidade" },
      { tipo: "radio", rotulo: "Confortável", marcado: E.densidade !== "compacta", acao: () => Mesa.quadro.definirDensidade("confortavel") },
      { tipo: "radio", rotulo: "Compacta", marcado: E.densidade === "compacta", acao: () => Mesa.quadro.definirDensidade("compacta") },
      { separador: true },
      { rotulo: "Configurações", icone: "i-settings", acao: () => { location.hash = "#/config"; } },
      { rotulo: "Atalhos", icone: "i-keyboard", kbd: "?", acao: () => App.atalhos() },
    ], { rotulo: "Preferências" });
  }

  // ------------------------------------------------------------------ atalhos globais
  function noQuadro() { return E.pagina === "quadro" || E.pagina === "lista"; }
  function irG(letra) {
    const mapa = { q: "#/quadro", l: "#/lista", r: "#/radar", d: "#/daily", p: "#/projetos", a: "#/arquivo", c: "#/config" };
    if (mapa[letra]) { location.hash = mapa[letra]; return true; }
    const vis = { h: "hoje", s: "semana", t: "tudo" }[letra];
    if (vis) { if (!noQuadro()) location.hash = "#/quadro"; Mesa.quadro.definirVisao(vis); return true; }
    return false;
  }
  function tecladoGlobal(ev) {
    const k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && !ev.shiftKey && !ev.altKey && (k === "k" || k === "K")) { ev.preventDefault(); Mesa.paleta.alternar(); return; }
    if (Mesa.paleta.aberta() || !$("#atalhos-fundo").hidden) return;
    const emCampo = n.ehCampo(ev.target);
    if (k === "Escape") {
      if (Mesa.quadro.cancelarArraste()) { ev.preventDefault(); return; }
      if (emCampo) { ev.target.blur(); return; }
      if (n.fecharTopo()) { ev.preventDefault(); return; }
      if (Mesa.quadro.cancelarLevantado()) { ev.preventDefault(); return; }
      if (Mesa.quadro.fecharCompositor()) { ev.preventDefault(); return; }
      if (Mesa.quadro.limparSelecao()) { ev.preventDefault(); return; }
      if ($("#nav").classList.contains("aberta")) { $("#nav").classList.remove("aberta"); return; }
      return;
    }
    if (ctrl && !ev.altKey && !emCampo) {
      if ((k === "z" || k === "Z") && !ev.shiftKey) { ev.preventDefault(); n.desfazerUltimo(); return; }
      if (k === "y" || k === "Y" || ((k === "z" || k === "Z") && ev.shiftKey)) { ev.preventDefault(); n.refazerUltimo(); return; }
    }
    if (ctrl || ev.altKey || emCampo || n.temCamada("menu") || n.temCamada("popover") || Mesa.quadro.levantado()) return;
    if (gPendente) {
      clearTimeout(gPendente); gPendente = 0; dicaG = false; renderStatus();
      if (irG(k.toLowerCase())) { ev.preventDefault(); return; }
    }
    if (E.atalhosUmaTecla === false) return;
    if (k === "?") { ev.preventDefault(); App.atalhos(); return; }
    if (k === "/") { if (noQuadro()) { ev.preventDefault(); Mesa.quadro.focarFiltro(); } return; }
    if (k === "]") { ev.preventDefault(); if (!noQuadro()) location.hash = "#/quadro"; Mesa.gaveta.alternarPainel(); return; }
    if (k === "g" || k === "G") { if (ev.shiftKey) return; ev.preventDefault(); dicaG = true; renderStatus(); gPendente = setTimeout(() => { gPendente = 0; dicaG = false; renderStatus(); }, 1500); return; }
    if (!noQuadro()) return;
    if (k === "n" && !ev.shiftKey) { ev.preventDefault(); Mesa.quadro.abrirCompositor(); return; }
    if (k === "v" && !ev.shiftKey) { ev.preventDefault(); location.hash = E.modo === "quadro" ? "#/lista" : "#/quadro"; return; }
    if (k === "r" && !ev.shiftKey) { ev.preventDefault(); Mesa.quadro.alternarRaias(); return; }
    if ((k === "D" || k === "d") && ev.shiftKey) { ev.preventDefault(); Mesa.quadro.alternarDensidade(); return; }
    if (k === "f" && !ev.shiftKey) { ev.preventDefault(); Mesa.quadro.focarPrimeiroChip(); return; }
    if ((k === "F" || k === "f") && ev.shiftKey) { ev.preventDefault(); Mesa.quadro.limparFiltros(); return; }
    if (k === "a" && !ev.shiftKey) { ev.preventDefault(); Mesa.quadro.alternarSinal("atrasadas"); return; }
  }

  // ------------------------------------------------------------------ inicialização
  function ligarTopo() {
    $("#topo-marca").addEventListener("click", () => { location.hash = "#/quadro"; });
    $("#topo-nova").addEventListener("click", () => Mesa.quadro.abrirCompositor());
    $("#celular-nova").addEventListener("click", () => Mesa.quadro.abrirCompositor());
    $("#topo-atalhos").addEventListener("click", () => App.atalhos());
    $("#nav-atalhos").addEventListener("click", () => App.atalhos());
    $("#topo-avatar").addEventListener("click", (ev) => menuAvatar(ev.currentTarget));
    $("#topo-menu").addEventListener("click", (ev) => { const nav = $("#nav"); nav.classList.toggle("aberta"); ev.currentTarget.setAttribute("aria-expanded", String(nav.classList.contains("aberta"))); });
    $("#pular").addEventListener("click", (ev) => { ev.preventDefault(); Mesa.quadro.focar(E.foco); });
  }
  async function iniciar() {
    Mesa.quadro.iniciar();
    Mesa.gaveta.iniciar();
    Mesa.paleta.iniciar();
    ligarTopo();
    document.addEventListener("keydown", tecladoGlobal);
    window.addEventListener("hashchange", aplicarUrl);
    window.addEventListener("popstate", aplicarUrl);
    aplicarUrl();
    renderStatus();
    await n.recarregar();
    if (pAbrir && E.carregado) { const id = E.porNumero.get(pAbrir); pAbrir = null; if (id) Mesa.gaveta.abrir(id, { semFoco: true }); }
    n.verificarStatus();
    n.carregarProjetos();
    Mesa.agente.retomar();
    setInterval(() => { if (!document.hidden) n.recarregar(); }, 10000);
    setInterval(() => { n.vigiarDia(); if (!document.hidden) renderStatus(); }, 60000);
    n.agendarMeiaNoite();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { n.vigiarDia(); n.recarregar(); n.agendarStatus(); } });
    window.addEventListener("focus", () => n.vigiarDia());
    Mesa.teams.iniciar();
  }
  Mesa.ouvir("dados", () => {
    if (pAbrir && E.carregado) { const id = E.porNumero.get(pAbrir); pAbrir = null; if (id) Mesa.gaveta.abrir(id, { semFoco: true }); }
  });
  Mesa.ouvir("recarga", (on) => { const b = $("#barra-recarga"); if (b) b.hidden = !on; });
  iniciar();
})();
