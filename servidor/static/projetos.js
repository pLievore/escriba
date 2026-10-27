/* Escriba: páginas Projetos (o cérebro), Arquivo (descartadas) e Configurações.
   Projetos: GET /api/projetos (projeto + abertas, total, docs; indice), detalhe com mapeamento, ligações e
   pendências, edição por PATCH /api/projetos/<id> {campos}. Reindexar: POST /api/cerebro/indexar. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, $$, limpar } = n;
  const PG = (Mesa.paginas = {});

  let projSel = null, abaProj = "mapeamento", rascunho = null, ordemProj = { k: "abertas", dir: -1 }, filtroProj = "", mostrarInativos = true;
  let erroProj = null, carregandoProj = false, timerIndice = 0, filtroArquivo = "";
  const raiz = () => $("#pagina");

  // ------------------------------------------------------------------ reindexação
  PG.reindexar = async (semConfirmar, ancora) => {
    if (!E.recursos.cerebro) { n.toast({ texto: "O cérebro ainda não está ligado neste servidor.", tipo: "info" }); return; }
    if (!n.podeEscrever()) return n.semConexao();
    if (!semConfirmar && ancora) {
      const ok = await n.confirmar({ depois: ancora.closest(".pag-cab") || ancora, mensagem: `Reindexar o cérebro (${E.projetos.length} projetos)? Leva alguns minutos; o quadro continua funcionando.`, rotuloAcao: "Reindexar", foco: ancora });
      if (!ok) return;
    }
    try {
      const r = await n.api("POST", "/api/cerebro/indexar", {});
      E.indice = r.indice || E.indice;
      n.toast({ texto: "Reindexação começou. O índice atualiza em segundo plano.", tipo: "ok" });
      vigiarIndice();
      redesenhar();
    } catch (e) { n.toast({ texto: `Não consegui reindexar: ${e.message}`, tipo: "erro" }); }
  };
  function vigiarIndice() {
    clearTimeout(timerIndice);
    timerIndice = setTimeout(async () => {
      try {
        const r = await n.api("GET", "/api/cerebro/status", null, { tempo: 5000, semMedir: true });
        const antes = E.indice && E.indice.rodando;
        E.indice = r.indice;
        if (E.indice && E.indice.rodando) vigiarIndice();
        else if (antes) { n.toast({ texto: `Índice atualizado: ${n.fmtNum(E.indice.total_docs || 0)} documentos.`, tipo: "ok" }); n.carregarProjetos(true); }
        if (E.pagina === "projetos") redesenhar();
      } catch (e) { vigiarIndice(); }
    }, 2000);
  }
  function linhaIndice() {
    const i = E.indice || {};
    const l = h("div", { c: "indice-linha", "aria-live": "polite" });
    if (i.rodando) l.append(n.spinner(true), `Indexando… ${n.fmtNum(i.arquivos || 0)} arquivos lidos${i.novos ? `, ${n.fmtNum(i.novos)} novos` : ""}`);
    else if (i.erro) l.append(ic("i-error", "cor-atrasada"), `O índice parou com erro: ${i.erro}`);
    else l.append(ic("i-success", "col-ic-feita"), `Índice com ${n.fmtNum(i.total_docs || 0)} documentos e ${n.fmtNum(i.memorias || 0)} memórias${i.fim ? ` · atualizado ${n.relativo(i.fim)}` : ""}`);
    return l;
  }

  // ------------------------------------------------------------------ Projetos
  function contagens(p) {
    const doP = E.itens.filter((i) => i.projeto_id === p.id);
    return { atrasadas: doP.filter(n.atrasada).length, abertas: p.abertas != null ? p.abertas : doP.filter((i) => !n.fechada(i)).length, total: p.total != null ? p.total : doP.length };
  }
  const COLS = [
    { k: "nome", r: "Projeto", ord: (p) => n.norm(p.nome) },
    { k: "area", r: "Área", w: 150, ord: (p) => p.area || "" },
    { k: "pasta", r: "Pasta principal", w: 260, ord: (p) => n.norm(p.pasta || "~") },
    { k: "abertas", r: "Abertas", w: 72, num: true, ord: (p) => contagens(p).abertas },
    { k: "atrasadas", r: "Atrasadas", w: 80, num: true, ord: (p) => contagens(p).atrasadas },
    { k: "total", r: "Pendências", w: 90, num: true, ord: (p) => contagens(p).total },
    { k: "docs", r: "Arquivos indexados", w: 130, num: true, ord: (p) => p.docs || 0 },
    { k: "memoria", r: "Memória", w: 76, ord: (p) => (p.memoria ? 1 : 0) },
    { k: "indice", r: "Índice", w: 150 },
  ];
  async function paginaProjetos(sub) {
    const r = raiz();
    if (sub !== undefined) { if (sub && sub !== projSel) { rascunho = null; abaProj = "mapeamento"; } projSel = sub || null; }
    if (!E.projetosCarregados && !carregandoProj) {
      carregandoProj = true;
      limpar(r).append(h("div", { c: "pagina-principal" }, h("div", { c: "pag-cab" }, h("h1", { t: "Projetos" })), h("div", { c: "pag-corpo" }, h("div", { style: "display:grid;gap:10px;max-width:720px" }, [1, 2, 3, 4].map(() => h("span", { c: "esq", style: "width:90%" }))))));
      erroProj = null;
      await n.carregarProjetos(true);
      carregandoProj = false;
      if (!E.projetosCarregados) erroProj = "Não consegui carregar os projetos.";
      if (E.pagina !== "projetos") return;
    }
    limpar(r);
    const principal = h("div", { c: "pagina-principal" });
    r.append(principal);
    const inputFiltro = h("input", { type: "search", placeholder: "Filtrar", "aria-label": "Filtrar projetos", value: filtroProj });
    inputFiltro.addEventListener("input", () => { filtroProj = inputFiltro.value; desenharTabela(); });
    const reindexar = h("button", { type: "button", c: "btn btn-28", disabled: !E.recursos.cerebro || (E.indice && E.indice.rodando) || null, on: { click: (ev) => PG.reindexar(false, ev.currentTarget) } }, ic("i-refresh"), "Reindexar tudo");
    const inativos = h("label", { c: "t-meta texto-2", style: "display:inline-flex;gap:6px;align-items:center" }, h("input", { type: "checkbox", checked: mostrarInativos || null, on: { change: (ev) => { mostrarInativos = ev.target.checked; desenharTabela(); } } }), "Mostrar inativos");
    const titulo = h("h1", {}, "Projetos", h("span", { c: "num", t: String(E.projetos.length) }));
    principal.append(h("div", { c: "pag-cab" }, titulo, h("div", { c: "dir" }, inativos, h("div", { c: "filtrar" }, ic("i-search"), inputFiltro), reindexar)));
    const corpo = h("div", { c: "pag-corpo" });
    principal.append(corpo);
    if (!E.recursos.projetos && !E.projetos.length) corpo.append(h("p", { c: "vazio-texto", t: "O mapeamento chega quando o servidor tiver o cérebro." }));
    if (erroProj) corpo.append(h("div", { c: "erro-texto" }, ic("i-error"), h("span", { t: erroProj }), h("button", { type: "button", c: "btn btn-28", t: "Tentar de novo", on: { click: () => { E.projetosCarregados = false; paginaProjetos(); } } })));
    corpo.append(linhaIndice());
    const cont = h("div");
    corpo.append(cont);
    function desenharTabela() {
      limpar(cont);
      const q = n.norm(filtroProj.trim());
      let lista = E.projetos.filter((p) => (mostrarInativos || p.ativo !== false) && (!q || n.norm([p.nome, p.area, p.pasta, (p.palavras_chave || []).join(" "), (p.pessoas || []).join(" ")].join(" ")).includes(q)));
      const c = COLS.find((x) => x.k === ordemProj.k) || COLS[3];
      lista.sort((a, b) => ((a.ativo === false) - (b.ativo === false)) || ((x, y) => (x < y ? -1 : x > y ? 1 : 0))(c.ord(a), c.ord(b)) * ordemProj.dir || n.norm(a.nome).localeCompare(n.norm(b.nome)));
      titulo.querySelector(".num").textContent = lista.length === E.projetos.length ? String(E.projetos.length) : `${lista.length} de ${E.projetos.length}`;
      if (!E.projetos.length) { cont.append(h("p", { c: "vazio-texto", t: "Nenhum projeto ainda. O cérebro cria projetos a partir das pastas que você usa." })); return; }
      if (!lista.length) { cont.append(h("p", { c: "vazio-texto", t: "Nenhum projeto com esse filtro." })); return; }
      const tab = h("table", { c: "tabela tabela-proj", role: "grid", "aria-label": "Projetos" });
      const thr = h("tr");
      for (const col of COLS) {
        const th = h("th", { c: col.num ? "num-col" : "", style: col.w ? `width:${col.w}px` : null, "aria-sort": ordemProj.k === col.k ? (ordemProj.dir > 0 ? "ascending" : "descending") : col.ord ? "none" : null });
        if (col.ord) th.append(h("button", { type: "button", on: { click: () => { ordemProj = { k: col.k, dir: ordemProj.k === col.k ? -ordemProj.dir : col.num ? -1 : 1 }; desenharTabela(); } } }, col.r, ordemProj.k === col.k ? ic(ordemProj.dir > 0 ? "i-chevron-up-12" : "i-chevron-down-12") : null));
        else th.textContent = col.r;
        thr.append(th);
      }
      tab.append(h("thead", {}, thr));
      const tb = h("tbody");
      let primeiro = true;
      for (const p of lista) {
        const k = contagens(p);
        const a = n.AREA[p.area] || n.AREA.Outros;
        const tr = h("tr", { c: "linha" + (p.ativo === false ? " inativo" : ""), tabindex: (projSel ? projSel === p.id : primeiro) ? "0" : "-1", "aria-selected": String(projSel === p.id), d: { pid: p.id } });
        primeiro = false;
        if (projSel === p.id) tr.setAttribute("aria-current", "true");
        const pastaSpan = h("span", { c: "mono", "data-tip": p.pasta || null, t: p.pasta || "" });
        tr.append(
          h("td", {}, h("div", { c: "p-nome" }, h("span", { c: "n" }, n.quadrado(a, 10), h("span", { t: p.nome, "data-tip-auto": p.nome })), (p.palavras_chave || []).length ? h("span", { c: "k", t: p.palavras_chave.slice(0, 4).join(", ") }) : null)),
          h("td", { c: "texto-2", t: p.area || "—" }),
          h("td", {}, p.pasta ? pastaSpan : h("span", { c: "texto-3", t: "Sem pasta" })),
          h("td", { c: "num-col num", t: String(k.abertas) }),
          h("td", { c: "num-col num", style: k.atrasadas ? "color:var(--overdue)" : null, t: String(k.atrasadas) }),
          h("td", { c: "num-col num", t: String(k.total) }),
          h("td", { c: "num-col num", t: p.docs ? n.fmtNum(p.docs) : "—" }),
          h("td", {}, p.memoria ? h("span", { c: "cel", "data-tip": p.memoria }, ic("i-check-12", "col-ic-feita"), h("span", { t: "Sim" })) : h("span", { c: "texto-3", t: "—" })),
          h("td", {}, celulaIndice(p)));
        requestAnimationFrame(() => { const w = pastaSpan.parentNode && pastaSpan.parentNode.clientWidth - 16; if (w > 0 && p.pasta) pastaSpan.textContent = n.truncarMeio(p.pasta, w); });
        tb.append(tr);
      }
      tab.append(tb);
      tab.addEventListener("click", (ev) => { const tr = ev.target.closest("tr.linha"); if (tr && !ev.target.closest("a,button")) abrirProjeto(tr.dataset.pid); });
      tab.addEventListener("keydown", (ev) => {
        const tr = ev.target.closest("tr.linha");
        if (!tr) return;
        if (ev.key === "Enter") { ev.preventDefault(); abrirProjeto(tr.dataset.pid); }
        else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          const outro = ev.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
          if (outro) { tr.tabIndex = -1; outro.tabIndex = 0; outro.focus(); }
        }
      });
      cont.append(tab);
    }
    desenharTabela();
    if (projSel) {
      const p = E.projetosPorId.get(projSel);
      if (p) r.append(detalheProjeto(p));
    }
  }
  function celulaIndice(p) {
    if (E.indice && E.indice.rodando) return h("span", { c: "cel texto-2" }, n.spinner(true), h("span", { t: "Indexando" }));
    if (!p.pasta) return h("span", { c: "texto-3" }, "Sem pasta · ", h("a", { href: "#/projetos/" + encodeURIComponent(p.id), t: "Mapear" }));
    if (!p.docs) return h("span", { c: "cel", style: "color:var(--today)" }, ic("i-warning-12"), h("span", { t: "Nada indexado" }));
    return h("span", { c: "texto-3", t: E.indice && E.indice.fim ? `Atualizado ${n.relativo(E.indice.fim)}` : "Indexado" });
  }
  async function abrirProjeto(pid) {
    if (projSel && rascunho && rascunho.sujo && pid !== projSel) {
      const rod = $(".form-rodape", raiz());
      const ok = await n.confirmar({ dentro: rod || raiz(), mensagem: "Sair sem salvar o mapeamento?", rotuloAcao: "Sair sem salvar", rotuloCancelar: "Continuar editando" });
      if (!ok) return;
    }
    rascunho = null;
    location.hash = "#/projetos/" + encodeURIComponent(pid);
  }
  function detalheProjeto(p) {
    const sobreposto = window.innerWidth < 1360;
    const g = h("aside", { c: "gaveta" + (sobreposto ? (window.innerWidth < 720 ? " tela" : " sobreposta") : ""), role: sobreposto ? "dialog" : "complementary", "aria-modal": sobreposto ? "true" : null, "aria-label": `Projeto ${p.nome}`, style: "--gaveta-w:480px" });
    const a = n.AREA[p.area] || n.AREA.Outros;
    const k = contagens(p);
    const fechar = async () => {
      if (rascunho && rascunho.sujo) {
        const rod = g.querySelector(".form-rodape");
        const ok = await n.confirmar({ dentro: rod || g, mensagem: "Sair sem salvar o mapeamento?", rotuloAcao: "Sair sem salvar", rotuloCancelar: "Continuar editando" });
        if (!ok) return;
      }
      rascunho = null; projSel = null; location.hash = "#/projetos";
    };
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !n.ehCampo(ev.target) && !n.temCamada("confirma") && !n.temCamada("menu")) { ev.preventDefault(); fechar(); }
      if (ev.key === "s" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); salvarProjeto(p, g); }
    });
    g.append(h("div", { c: "gaveta-topo" }, n.quadrado(a, 10), h("span", { c: "g-area", t: p.area || "Sem área" }), h("span", { c: "g-dir" }, h("button", { type: "button", c: "btn-icone", "aria-label": "Fechar o projeto", "data-tip": "Fechar   Esc", on: { click: fechar } }, ic("i-dismiss")))));
    const corpo = h("div", { c: "gaveta-corpo" });
    g.append(corpo);
    const cab = h("div", { c: "g-cab" }, h("h2", { c: "g-titulo", tabindex: "-1", t: p.nome, style: "cursor:default" }),
      h("p", { c: "g-origem", t: [p.area, (p.palavras_chave || []).slice(0, 5).join(", ")].filter(Boolean).join(" · ") }));
    if (p.descricao) cab.append(h("p", { c: "md", style: "margin-top:8px;color:var(--text-2)", t: p.descricao }));
    const faixa = h("div", { c: "faixa-numeros" });
    const num = (v, r) => h("span", { c: "n" }, h("span", { c: "num", t: String(v) }), h("span", { c: "r", t: r }));
    const sep = () => h("span", { c: "div", "aria-hidden": "true" });
    faixa.append(num(k.abertas, n.plural(k.abertas, "aberta", "abertas")), sep(), num(k.atrasadas, n.plural(k.atrasadas, "atrasada", "atrasadas")), sep(), num(k.total, n.plural(k.total, "pendência", "pendências")), sep(), num(n.fmtNum(p.docs || 0), "arquivos indexados"));
    cab.append(faixa);
    corpo.append(cab);
    const ABAS = [["mapeamento", "Mapeamento"], ["ligacoes", "Ligações"], ["pendencias", "Pendências"]];
    const abas = h("div", { c: "abas", role: "tablist", "aria-label": "Seções do projeto" });
    const painel = h("div", { c: "aba-painel", role: "tabpanel", id: "p-painel" });
    for (const [kk, r] of ABAS) abas.append(h("button", { type: "button", c: "aba", role: "tab", "aria-selected": String(kk === abaProj), tabindex: kk === abaProj ? "0" : "-1", "aria-controls": "p-painel", on: { click: () => { abaProj = kk; g.replaceWith(detalheProjeto(p)); } } }, h("span", { c: "aba-rot", "data-label": r, t: r })));
    abas.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const i = ABAS.findIndex(([kk]) => kk === abaProj);
      abaProj = ABAS[(i + (ev.key === "ArrowLeft" ? -1 : 1) + 3) % 3][0];
      const novo = detalheProjeto(p);
      g.replaceWith(novo);
      const b = novo.querySelector('.aba[aria-selected="true"]'); if (b) b.focus();
    });
    corpo.append(abas, painel);
    if (abaProj === "mapeamento") mapeamento(p, painel, g);
    else if (abaProj === "ligacoes") ligacoes(p, painel);
    else pendenciasDoProjeto(p, painel);
    if (sobreposto) requestAnimationFrame(() => { const t = g.querySelector(".g-titulo"); if (t && !g.contains(document.activeElement)) t.focus(); });
    return g;
  }
  function campoTokens(valores, rotulo, dica) {
    const estado = { valores: [...(valores || [])] };
    const caixa = h("div", { c: "tokens" });
    const input = h("input", { type: "text", "aria-label": rotulo, placeholder: "Adicionar…" });
    function desenhar() {
      limpar(caixa);
      for (const v of estado.valores) caixa.append(h("span", { c: "token" }, v, h("button", { type: "button", "aria-label": `Remover ${v}`, on: { click: () => { estado.valores = estado.valores.filter((x) => x !== v); desenhar(); estado.aoMudar && estado.aoMudar(); input.focus(); } } }, ic("i-dismiss-12"))));
      caixa.append(input);
    }
    input.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === ",") && input.value.trim()) {
        ev.preventDefault();
        const v = input.value.trim().replace(/,$/, "");
        if (v && !estado.valores.includes(v)) estado.valores.push(v);
        input.value = ""; desenhar(); input.focus(); estado.aoMudar && estado.aoMudar();
      } else if (ev.key === "Backspace" && !input.value && estado.valores.length) { estado.valores.pop(); desenhar(); input.focus(); estado.aoMudar && estado.aoMudar(); }
    });
    desenhar();
    estado.el = h("div", { c: "form-bloco" }, h("span", { c: "rot", t: rotulo }), caixa, dica ? h("p", { c: "campo-dica", t: dica }) : null);
    return estado;
  }
  function mapeamento(p, painel, g) {
    if (!rascunho || rascunho.id !== p.id) rascunho = { id: p.id, sujo: false, campos: { nome: p.nome || "", pasta: p.pasta || "", area: p.area || "Outros", descricao: p.descricao || "", ativo: p.ativo !== false, palavras_chave: [...(p.palavras_chave || [])], pessoas: [...(p.pessoas || [])] } };
    const c = rascunho.campos;
    const msg = h("span", { c: "msg" });
    const salvar = h("button", { type: "button", c: "btn btn-28 btn-primario", disabled: true, on: { click: () => salvarProjeto(p, g) } }, "Salvar", n.kbd("Ctrl", "S"));
    const descartar = h("button", { type: "button", c: "btn btn-28 btn-sutil", t: "Descartar", disabled: true, on: { click: () => { rascunho = null; g.replaceWith(detalheProjeto(p)); } } });
    const sujo = () => { rascunho.sujo = true; msg.textContent = "Alterações não salvas"; salvar.disabled = !n.podeEscrever(); descartar.disabled = false; };
    const inp = (k, opts) => { const e = h("input", Object.assign({ c: "campo" + (opts && opts.mono ? " mono" : ""), value: c[k] }, opts && opts.attrs)); e.addEventListener("input", () => { c[k] = e.value; sujo(); }); return e; };
    const nome = inp("nome", { attrs: { "aria-label": "Nome do projeto", maxlength: "120" } });
    const pasta = inp("pasta", { mono: true, attrs: { "aria-label": "Pasta principal", spellcheck: "false" } });
    const botaoArea = h("button", { type: "button", c: "chip-menu", "aria-haspopup": "menu" });
    const desenharArea = () => { limpar(botaoArea).append(n.quadrado(c.area), h("span", { t: c.area }), ic("i-chevron-down-12")); };
    desenharArea();
    botaoArea.addEventListener("click", () => n.menu(botaoArea, n.AREAS.map((a) => ({ tipo: "radio", rotulo: a.nome, sq: a, marcado: c.area === a.nome, acao: () => { c.area = a.nome; desenharArea(); sujo(); } })), { rotulo: "Área do projeto" }));
    const desc = h("textarea", { c: "campo-area", "aria-label": "Descrição do projeto", rows: "3" });
    desc.value = c.descricao;
    desc.addEventListener("input", () => { c.descricao = desc.value; sujo(); });
    const ativo = h("input", { type: "checkbox", checked: c.ativo || null, on: { change: (ev) => { c.ativo = ev.target.checked; sujo(); } } });
    const kw = campoTokens(c.palavras_chave, "Palavras-chave", "Nomes que você e as pessoas usam no Teams: 'cubo CC', 'bm', 'recontato'. Enter ou vírgula adiciona.");
    kw.aoMudar = () => { c.palavras_chave = kw.valores; sujo(); };
    const pessoas = campoTokens(c.pessoas, "Pessoas", "Quem costuma pedir coisas deste projeto.");
    pessoas.aoMudar = () => { c.pessoas = pessoas.valores; sujo(); };
    const teste = h("input", { type: "text", c: "campo", placeholder: "Ex.: refresh do cubo bm", "aria-label": "Testar mapeamento" });
    const resultadoTeste = h("div", { c: "teste-map", "aria-live": "polite" });
    let tt = 0;
    teste.addEventListener("input", () => { clearTimeout(tt); tt = setTimeout(() => testarMapeamento(teste.value, resultadoTeste), 300); });
    painel.append(
      h("div", { c: "form-bloco" }, h("label", { t: "Nome" }), nome),
      h("div", { c: "form-bloco" }, h("span", { c: "rot", t: "Área" }), h("div", {}, botaoArea)),
      h("div", { c: "form-bloco" }, h("label", { t: "Pasta principal" }), h("div", { c: "form-linha" }, pasta, h("button", { type: "button", c: "btn btn-28", t: "Abrir", disabled: !c.pasta || null, on: { click: () => n.abrirCaminho(p.pasta, "explorer") } })), h("p", { c: "campo-dica", t: "O servidor confere a pasta ao indexar. Abrir só funciona com a pasta já salva." })),
      h("div", { c: "form-bloco" }, h("label", { t: "Descrição" }), desc),
      h("div", { c: "form-bloco" }, h("label", { style: "display:inline-flex;gap:6px;align-items:center;font-weight:400;color:var(--text)" }, ativo, "Projeto ativo")),
      kw.el, pessoas.el,
      h("div", { c: "form-bloco" }, h("label", { t: "Testar mapeamento" }), teste, resultadoTeste));
    g.querySelector(".gaveta-corpo").after(h("div", { c: "form-rodape" }, msg, h("span", { c: "dir" }, descartar, salvar)));
    if (rascunho.sujo) sujo();
  }
  function testarMapeamento(texto, alvo) {
    limpar(alvo);
    const t = " " + n.norm(texto) + " ";
    if (!texto.trim()) return;
    const pontos = [];
    for (const p of E.projetos) {
      if (p.ativo === false) continue;
      let s = 0, porque = "";
      const c = rascunho && rascunho.id === p.id ? rascunho.campos : p;
      for (const k of c.palavras_chave || []) { const kk = n.norm(k).trim(); if (kk.length >= 2 && t.includes(" " + kk + " ") || (kk.length >= 6 && t.includes(kk))) { s += 3; porque = porque || `palavra-chave “${k}”`; } }
      for (const pe of c.pessoas || []) { const pr = n.norm(pe).split(/\s+/)[0]; if (pr.length >= 4 && t.includes(" " + pr + " ")) { s += 0.5; porque = porque || `pessoa “${pe}”`; } }
      const pastaNome = n.norm(n.nomeArquivo(c.pasta || ""));
      if (pastaNome && pastaNome.length >= 3 && t.includes(pastaNome)) { s += 1; porque = porque || `nome da pasta “${n.nomeArquivo(c.pasta)}”`; }
      if (s > 0) pontos.push({ p, s, porque });
    }
    pontos.sort((a, b) => b.s - a.s);
    if (!pontos.length) { alvo.textContent = "Nenhum projeto casa com esse texto (o cérebro também usaria a busca no índice)."; return; }
    pontos.slice(0, 2).forEach((x, k) => alvo.append(h("div", {}, k ? "2ª opção: " : "→ ", n.quadrado(x.p.area), " ", h("b", { t: x.p.nome }), ` · por quê: ${x.porque}`)));
  }
  async function salvarProjeto(p, g) {
    if (!rascunho || !rascunho.sujo) return;
    if (!n.podeEscrever()) return n.semConexao();
    const c = rascunho.campos;
    const campos = {};
    const antes = {};
    for (const k of ["nome", "pasta", "area", "descricao", "ativo", "palavras_chave", "pessoas"]) {
      const atual = k === "ativo" ? p.ativo !== false : p[k] == null ? (Array.isArray(c[k]) ? [] : "") : p[k];
      if (JSON.stringify(atual) !== JSON.stringify(c[k])) { campos[k] = c[k]; antes[k] = atual; }
    }
    if (!Object.keys(campos).length) { rascunho.sujo = false; g.replaceWith(detalheProjeto(p)); return; }
    try {
      const r = await n.api("PATCH", `/api/projetos/${encodeURIComponent(p.id)}`, { campos });
      atualizarProjetoLocal(r.projeto || Object.assign({}, p, campos));
      rascunho = null;
      const acao = {
        rotulo: `Projeto salvo: ${c.nome}.`, mudancas: [],
        desfazer: async () => { const r2 = await n.api("PATCH", `/api/projetos/${encodeURIComponent(p.id)}`, { campos: antes }); atualizarProjetoLocal(r2.projeto); redesenhar(); },
        refazer: async () => { const r2 = await n.api("PATCH", `/api/projetos/${encodeURIComponent(p.id)}`, { campos }); atualizarProjetoLocal(r2.projeto); redesenhar(); },
      };
      n.registrarAcao(acao);
      n.toast({ texto: `Projeto salvo: ${c.nome}.`, tipo: "ok", desfazer: acao });
      redesenhar();
    } catch (e) { n.toast({ texto: `Não consegui salvar o projeto: ${e.message}`, tipo: "erro" }); }
  }
  function atualizarProjetoLocal(novo) {
    if (!novo || !novo.id) return;
    const k = E.projetos.findIndex((x) => x.id === novo.id);
    const antigo = k >= 0 ? E.projetos[k] : {};
    const junto = Object.assign({}, antigo, novo, { abertas: antigo.abertas, total: antigo.total, docs: antigo.docs });
    if (k >= 0) E.projetos[k] = junto; else E.projetos.push(junto);
    E.projetosPorId.set(junto.id, junto);
    Mesa.emitir("projetos");
  }
  function ligacoes(p, painel) {
    if (p.pasta) painel.append(h("div", { c: "form-bloco" }, h("span", { c: "rot", t: "Pasta principal" }), Mesa.gaveta.linhaCaminho(p.pasta)));
    else painel.append(h("p", { c: "vazio-texto", t: "Este projeto não tem pasta. Defina na aba Mapeamento." }));
    if (p.memoria) painel.append(h("div", { c: "form-bloco" }, h("span", { c: "rot", t: "Memória do Claude Code" }), Mesa.gaveta.linhaCaminho(p.memoria, { icone: "i-note" })));
    painel.append(h("p", { c: "t-meta texto-3", style: "margin-top:8px", t: `${p.git ? "Repositório git" : "Sem git"} · ${n.fmtNum(p.docs || 0)} arquivos indexados` }));
    const arqs = p.arquivos || [];
    if (arqs.length) {
      const box = h("div", { c: "secao" }, h("div", { c: "secao-cab", style: "cursor:default" }, h("span", { t: "Arquivos-chave" }), h("span", { c: "num", t: String(arqs.length) })));
      for (const a of arqs) {
        const rel = p.pasta && a.caminho.toLowerCase().startsWith(p.pasta.toLowerCase() + "\\") ? a.caminho.slice(p.pasta.length + 1) : a.caminho;
        box.append(h("div", { c: "item-ctx" },
          h("div", { c: "item-l1" }, ic(n.iconeArquivo(a.caminho)), h("span", { c: "nome", t: n.nomeArquivo(a.caminho), "data-tip": a.caminho }),
            h("span", { c: "acoes", style: "visibility:visible" },
              h("button", { type: "button", c: "btn btn-sutil btn-24", t: "Abrir", "data-tip": "Abrir no VS Code", on: { click: () => n.abrirCaminho(a.caminho, "code") } }),
              h("button", { type: "button", c: "btn-icone b24", "aria-label": "Mostrar na pasta", "data-tip": "Mostrar na pasta", on: { click: () => n.abrirCaminho(a.caminho, "explorer") } }, ic("i-folder-open")),
              h("button", { type: "button", c: "btn-icone b24", "aria-label": "Copiar caminho", "data-tip": "Copiar caminho", on: { click: () => n.copiar(a.caminho, "Caminho copiado.") } }, ic("i-copy")))),
          h("div", { c: "item-l2" }, h("span", { c: "mono", t: rel })),
          a.porque ? h("div", { c: "item-porque" }, h("b", { t: "Por quê: " }), a.porque) : null));
      }
      painel.append(box);
    }
    const ps = p.pessoas || [];
    if (ps.length) painel.append(h("div", { c: "secao" }, h("div", { c: "secao-cab", style: "cursor:default" }, h("span", { t: "Pessoas" }), h("span", { c: "num", t: String(ps.length) })),
      h("div", { c: "chips-pessoas" }, ps.map((x) => h("button", { type: "button", c: "chip-pessoa", "data-tip": `Filtrar o quadro por ${x}`, on: { click: () => { location.hash = "#/quadro"; Mesa.quadro.filtrarPessoa(x); } } }, n.avatar(n.nomeCurto(x), true), x)))));
    if (p.observacoes) painel.append(h("div", { c: "form-bloco" }, h("span", { c: "rot", t: "Observações" }), h("p", { c: "md", t: p.observacoes })));
  }
  function pendenciasDoProjeto(p, painel) {
    const corte = n.somaDias(n.hoje(), -13);
    const lista = E.itens.filter((i) => i.projeto_id === p.id && i.status !== "descartada" && (i.status !== "feita" || (n.diaConcluida(i) || "") >= corte));
    if (!lista.length) { painel.append(h("p", { c: "vazio-texto", t: "Nenhuma pendência aberta ou concluída nos últimos 14 dias neste projeto." })); return; }
    lista.sort((a, b) => n.fechada(a) - n.fechada(b) || (a.prazo || "9999").localeCompare(b.prazo || "9999"));
    for (const i of lista) {
      const ch = n.chipCartao(i, "cartao");
      painel.append(h("button", { type: "button", c: "resumo-linha", on: { click: () => { location.hash = `#/quadro?p=${n.num(i.id)}`; } } },
        n.iconeStatus(i.status), h("span", { c: "card-num", t: n.ref(i.id) }), h("span", { c: "t", t: i.titulo }), ch ? n.chip(ch) : i.status === "feita" ? h("span", { c: "t-meta texto-3", t: n.relativoDia(n.diaConcluida(i)) }) : null));
    }
  }

  // ------------------------------------------------------------------ Arquivo (descartadas)
  function paginaArquivo() {
    const r = raiz();
    limpar(r);
    const principal = h("div", { c: "pagina-principal" });
    r.append(principal);
    const desc = E.itens.filter((i) => i.status === "descartada").sort((a, b) => String(b.atualizado_em || "").localeCompare(String(a.atualizado_em || "")));
    const input = h("input", { type: "search", placeholder: "Filtrar", "aria-label": "Filtrar o arquivo", value: filtroArquivo });
    principal.append(h("div", { c: "pag-cab" }, h("h1", {}, "Arquivo", h("span", { c: "num", t: String(desc.length) })), h("div", { c: "dir" }, h("div", { c: "filtrar" }, ic("i-search"), input))));
    const corpo = h("div", { c: "pag-corpo" });
    principal.append(corpo);
    const desenhar = () => {
      limpar(corpo);
      const q = filtroArquivo.trim();
      const lista = desc.filter((i) => !q || n.norm([i.titulo, i.pessoa, i.area, "#" + n.num(i.id)].join(" ")).includes(n.norm(q)));
      if (!E.carregado) { corpo.append(h("p", { c: "vazio-texto", t: "Carregando…" })); return; }
      if (!desc.length) { corpo.append(h("p", { c: "vazio-texto", t: "Nada no arquivo. Pendências descartadas ficam aqui; para trazer uma de volta, use Restaurar." })); return; }
      if (!lista.length) { corpo.append(h("p", { c: "vazio-texto", t: "Nada com esse filtro." })); return; }
      const tab = h("table", { c: "tabela", "aria-label": "Pendências descartadas" },
        h("thead", {}, h("tr", {}, ["#", "Título", "Área", "Pedido por", "Descartada em", ""].map((t, k) => h("th", { style: ["width:56px", "", "width:150px", "width:150px", "width:130px", "width:120px"][k] || null, t })))));
      const tb = h("tbody");
      for (const i of lista) {
        const ps = n.pessoasDe(i);
        tb.append(h("tr", { c: "linha" },
          h("td", {}, h("span", { c: "t-num", t: n.ref(i.id) })),
          h("td", {}, h("span", { c: "t-titulo", "data-tip-auto": i.titulo }, n.marcar(i.titulo, q))),
          h("td", {}, h("span", { c: "cel" }, n.quadrado(i.area), h("span", { t: n.areaDe(i).curto }))),
          h("td", { c: "texto-2", t: ps.join(", ") }),
          h("td", { c: "texto-3", t: n.relativo(n.statusDesde(i)) }),
          h("td", {}, h("button", { type: "button", c: "btn btn-24", disabled: !n.podeEscrever() || null, on: { click: () => restaurar(i) } }, ic("i-restore"), "Restaurar"))));
      }
      tab.append(tb);
      corpo.append(tab, h("p", { c: "t-meta texto-3", style: "margin-top:8px", t: "Restaurar devolve a pendência para A fazer. Excluir de vez não existe neste servidor: o arquivo guarda o histórico." }));
    };
    input.addEventListener("input", () => { filtroArquivo = input.value; desenhar(); });
    desenhar();
  }
  async function restaurar(i) {
    try { await n.moverVarias([{ id: i.id, status: "aberta", posicao: 0 }], { rotulo: `${n.ref(i.id)} restaurada em A fazer.`, rotuloDesfeito: `Desfeito: ${n.ref(i.id)} voltou para o Arquivo.` }); } catch (e) { /* toast já mostrado */ }
  }

  // ------------------------------------------------------------------ Configurações
  function paginaConfig() {
    const r = raiz();
    limpar(r);
    const principal = h("div", { c: "pagina-principal" });
    r.append(principal);
    principal.append(h("div", { c: "pag-cab" }, h("h1", { t: "Configurações" })));
    const cfg = h("div", { c: "config" });
    principal.append(cfg);
    const radios = (nome, opcoes, atual, aoMudar) => h("div", { c: "opcoes", role: "radiogroup", "aria-label": nome }, opcoes.map(([v, rot]) => h("label", {}, h("input", { type: "radio", name: nome, value: v, checked: String(atual) === String(v) || null, on: { change: () => aoMudar(v) } }), rot)));
    cfg.append(
      h("section", {}, h("h2", { t: "Tema" }), radios("tema", [["sistema", "Sistema"], ["claro", "Claro"], ["escuro", "Escuro"]], window.mesaTemaAtual ? window.mesaTemaAtual() : "sistema", (v) => window.mesaTema(v))),
      h("section", {}, h("h2", { t: "Densidade dos cartões" }), radios("densidade", [["confortavel", "Confortável"], ["compacta", "Compacta"]], E.densidade, (v) => Mesa.quadro.definirDensidade(v))),
      h("section", {}, h("h2", { t: "Concluído mostra os últimos" }), radios("janela", [[7, "7 dias"], [14, "14 dias"], [30, "30 dias"]], E.janelaFeitas, (v) => { E.janelaFeitas = Number(v); n.gravarPref("mesa.feitas.dias", Number(v)); Mesa.quadro.render(true); })),
      h("section", {}, h("h2", { t: "Limite de Em andamento" }), (() => {
        const inp = h("input", { type: "number", min: "0", max: "99", c: "campo", style: "width:96px", value: E.limiteAndamento || "", "aria-label": "Limite de Em andamento" });
        inp.addEventListener("change", () => { E.limiteAndamento = Math.max(0, Math.min(99, Number(inp.value) || 0)); n.gravarPref("mesa.limite.andamento", E.limiteAndamento); Mesa.quadro.render(true); });
        return h("div", { c: "form-linha" }, inp, h("span", { c: "t-meta texto-3", t: "Vazio ou 0 = sem limite. O limite nunca bloqueia nada." }));
      })()),
      h("section", {}, h("h2", { t: "Atalhos de uma tecla" }), h("label", {}, h("input", { type: "checkbox", checked: E.atalhosUmaTecla !== false || null, on: { change: (ev) => { E.atalhosUmaTecla = ev.target.checked; n.gravarPref("mesa.atalhos", ev.target.checked); } } }), "Ligados (N, V, R, J/K, P, D…). Ctrl+K continua sempre ligado.")),
      h("section", {}, h("h2", { t: "Modo da gaveta" }), radios("gaveta", [["auto", "Automático (dividida em telas largas)"], ["sobreposta", "Sempre sobreposta"]], E.gavetaModo, (v) => { E.gavetaModo = v; n.gravarPref("mesa.gaveta.modo", v); Mesa.gaveta.redesenhar(); Mesa.quadro.render(true); })));
    const s = E.status || {};
    const rec = Object.entries(E.recursos || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "nenhum";
    const info = h("dl", { c: "info" },
      h("dt", { t: "Endereço" }), h("dd", { c: "mono", t: location.host }),
      h("dt", { t: "Claude Code CLI" }), h("dd", { t: s.claude ? `Encontrado: ${s.claude}` : s.assistente === false ? "Não encontrado nesta máquina" : "—" }),
      h("dt", { t: "Modelo do assistente" }), h("dd", { t: s.modelo || "—" }),
      h("dt", { t: "Recursos do servidor" }), h("dd", { t: rec }),
      h("dt", { t: "Índice do cérebro" }), h("dd", { t: E.indice ? `${n.fmtNum(E.indice.total_docs || 0)} documentos, ${n.fmtNum(E.indice.memorias || 0)} memórias${E.indice.fim ? `, atualizado ${n.relativo(E.indice.fim)}` : ""}` : "—" }),
      h("dt", { t: "Versão dos dados" }), h("dd", { t: E.versao >= 0 ? String(E.versao) : "—" }),
      h("dt", { t: "Última leitura do Teams" }), h("dd", { t: E.meta && E.meta.ultima_leitura_teams ? n.relativo(E.meta.ultima_leitura_teams) + (E.meta.periodo_lido ? ` · ${E.meta.periodo_lido}` : "") : "—" }));
    const testar = h("button", { type: "button", c: "btn btn-28", t: "Testar conexão", on: { click: async () => { testar.disabled = true; await n.verificarStatus(); testar.disabled = false; n.toast({ texto: E.servidor === "fora" ? "O servidor não respondeu." : "Servidor respondeu.", tipo: E.servidor === "fora" ? "erro" : "ok", duracao: 3000 }); paginaConfig(); } } });
    cfg.append(h("section", {}, h("h2", { t: "Servidor" }), info, h("div", { c: "form-linha", style: "margin-top:12px" }, testar, h("button", { type: "button", c: "btn btn-28", disabled: !E.recursos.cerebro || null, on: { click: (ev) => PG.reindexar(false, ev.currentTarget) } }, ic("i-refresh"), "Reindexar o cérebro"))));
  }

  // ------------------------------------------------------------------ roteamento das páginas
  function redesenhar() {
    if (E.pagina === "projetos") paginaProjetos();
    else if (E.pagina === "arquivo") paginaArquivo();
    else if (E.pagina === "config") paginaConfig();
  }
  PG.mostrar = (pagina, sub) => {
    if (pagina !== "radar" && Mesa.radar) Mesa.radar.sair();
    if (pagina === "daily") Mesa.daily.mostrar();
    else if (pagina === "radar") Mesa.radar.mostrar();
    else if (pagina === "projetos") paginaProjetos(sub || "");
    else if (pagina === "arquivo") paginaArquivo();
    else if (pagina === "config") paginaConfig();
  };
  PG.temRascunho = () => !!(rascunho && rascunho.sujo);
  Mesa.ouvir("dados", () => { if (E.pagina === "arquivo") paginaArquivo(); else if (E.pagina === "projetos" && !(rascunho && rascunho.sujo) && !$("#pagina").contains(document.activeElement)) paginaProjetos(); });
  Mesa.ouvir("projetos", () => { if (E.pagina === "projetos" && !(rascunho && rascunho.sujo)) paginaProjetos(); });
  Mesa.ouvir("status", () => {
    if (E.indice && E.indice.rodando) vigiarIndice();
    if (E.pagina === "config" && !$("#pagina").contains(document.activeElement)) paginaConfig();
  });
  Mesa.ouvir("dia", redesenhar);
})();
