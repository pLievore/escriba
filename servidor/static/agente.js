/* Escriba: agente por pendência.
   Acompanha as execuções (POST /agente, polling de GET /api/execucoes/<eid>?desde=n a cada 1,5 s enquanto
   fila|rodando), desenha a aba Agente (ações, progresso ao vivo, o que as extensões locais acrescentam,
   resultado, entregas, custo) e fornece o renderizador de markdown próprio (só nós de texto). */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, $$, limpar } = n;
  const A = (Mesa.agente = {});
  /* Extensões locais: scripts que o servidor injeta na página quando há uma extensão do agente em
     servidor/local/. Cada uma registra { permissao(execs) -> frase, secao(ex) -> nó } e acrescenta à aba
     o que é dela. Sem extensão, a aba mostra só o que é do agente. */
  const extensoes = [];
  A.registrarExtensao = (x) => { if (x && typeof x === "object") extensoes.push(x); };
  function daExtensao(fn, ...args) {
    const out = [];
    for (const x of extensoes) {
      try { const r = typeof x[fn] === "function" ? x[fn](...args) : null; if (r) out.push(r); }
      catch (e) { console.error("[escriba] extensão falhou em", fn, e); }
    }
    return out;
  }

  const ativas = new Map();      // eid → execução (com eventos acumulados)
  const listas = new Map();      // pid → {execucoes, carregando, erro}
  const detalhes = new Map();    // eid → execução completa (com eventos)
  const expandidas = new Set(), recolhidas = new Set(), logAberto = new Set(), passosTodos = new Set();
  const textosRascunho = new Map(), instrucoes = new Map();
  const pedindo = new Set();
  let aba = null; // {pid, painel}
  let ultimoAnuncio = 0;
  let confirmando = false;   // confirmação aberta: redesenhar a aba apagaria a caixa e o que ele digitou

  const MODO = {
    briefing: { rotulo: "Briefing", botao: "Preparar briefing", icone: "i-briefing", kbd: ["B"] },
    rascunho: { rotulo: "Rascunho de resposta", botao: "Rascunhar resposta", icone: "i-draft", kbd: ["M"] },
    executar: { rotulo: "Executar tarefa", botao: "Executar tarefa", icone: "i-run", kbd: ["Shift", "E"] },
  };
  const rodando = (ex) => ex && (ex.status === "fila" || ex.status === "rodando");
  const maxN = (evs) => (evs || []).reduce((m, e) => Math.max(m, Number(e.n) || 0), 0);

  // ------------------------------------------------------------------ markdown próprio (só nós de texto)
  function inline(s) {
    const frag = document.createDocumentFragment();
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)<>]+)|([A-Za-z]:\\(?:[^\\\n"'<>|*?`]+\\)*[^\\\s"'<>|*?`]+)/g;
    let pos = 0, m;
    const texto = String(s || "");
    while ((m = re.exec(texto))) {
      if (m.index > pos) anexarTexto(frag, texto.slice(pos, m.index));
      if (m[1]) frag.append(h("code", { t: m[1].slice(1, -1) }));
      else if (m[2]) frag.append(h("strong", { t: m[2].slice(2, -2) }));
      else if (m[3]) frag.append(h("em", { t: m[3].slice(1, -1) }));
      else if (m[4]) frag.append(h("a", { href: m[5], target: "_blank", rel: "noopener noreferrer", t: m[4].slice(1, m[4].indexOf("](")) }));
      else if (m[6]) frag.append(h("a", { href: m[6], target: "_blank", rel: "noopener noreferrer", t: m[6] }));
      else if (m[7]) {
        const c = m[7].replace(/[.,;:)]+$/, "");
        const resto = m[7].slice(c.length);
        frag.append(h("span", { c: "md-caminho" }, h("span", { t: c }), h("button", { type: "button", c: "btn btn-sutil btn-24", t: "Abrir", "data-tip": "Abrir no VS Code", on: { click: () => n.abrirCaminho(c, "code") } })));
        if (resto) frag.append(resto);
      }
      pos = re.lastIndex;
    }
    if (pos < texto.length) anexarTexto(frag, texto.slice(pos));
    return frag;
  }
  function anexarTexto(frag, t) {
    const partes = t.split("\n");
    partes.forEach((p, k) => { if (k) frag.append(h("br")); if (p) frag.append(p); });
  }
  const ehItem = (l) => /^\s*([-*•]|\d+[.)])\s+/.test(l);
  function md(texto) {
    const raiz = h("div", { c: "md" });
    const linhas = String(texto || "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < linhas.length) {
      const l = linhas[i];
      if (/^```/.test(l)) {
        const buf = [];
        i++;
        while (i < linhas.length && !/^```/.test(linhas[i])) buf.push(linhas[i++]);
        i++;
        const codigo = buf.join("\n");
        raiz.append(h("pre", {}, h("button", { type: "button", c: "btn-icone b24", style: "position:absolute;top:4px;right:4px", "aria-label": "Copiar código", on: { click: () => n.copiar(codigo, "Código copiado.") } }, ic("i-copy")), h("code", { t: codigo })));
        continue;
      }
      if (!l.trim()) { i++; continue; }
      let m = l.match(/^(#{1,3})\s+(.*)$/);
      if (m) { raiz.append(h("h" + m[1].length, {}, inline(m[2]))); i++; continue; }
      if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < linhas.length && /^\s*>/.test(linhas[i])) buf.push(linhas[i++].replace(/^\s*>\s?/, ""));
        raiz.append(h("blockquote", {}, inline(buf.join("\n"))));
        continue;
      }
      if (ehItem(l)) {
        const lista = h(/^\s*\d/.test(l) ? "ol" : "ul");
        while (i < linhas.length && ehItem(linhas[i])) lista.append(h("li", {}, inline(linhas[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""))));
        raiz.append(lista);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < linhas.length && /^\s*\|?\s*:?-{3,}/.test(linhas[i + 1])) {
        const celulas = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const tabela = h("table");
        tabela.append(h("thead", {}, h("tr", {}, celulas(l).map((c) => h("th", {}, inline(c))))));
        i += 2;
        const corpo = h("tbody");
        while (i < linhas.length && /^\s*\|.*\|\s*$/.test(linhas[i])) {
          corpo.append(h("tr", {}, celulas(linhas[i++]).map((c) => h("td", { c: /^[\d.,%+−-]+$/.test(c) ? "n" : null }, inline(c)))));
        }
        tabela.append(corpo);
        raiz.append(tabela);
        continue;
      }
      const buf = [];
      while (i < linhas.length && linhas[i].trim() && !/^(```|#{1,3}\s)/.test(linhas[i]) && !/^\s*>/.test(linhas[i]) && !ehItem(linhas[i])) buf.push(linhas[i++]);
      raiz.append(h("p", {}, inline(buf.join("\n"))));
    }
    return raiz;
  }
  Mesa.md = md;

  // ------------------------------------------------------------------ acompanhamento
  function persistir() { n.gravarPref("mesa.execucoes.ativas", [...ativas.values()].filter(rodando).map((x) => ({ id: x.id, pid: x.pendencia_id }))); }
  A.rodando = rodando;
  A.ativaDe = (pid) => { for (const ex of ativas.values()) if (ex.pendencia_id === pid && rodando(ex)) return ex; return null; };
  A.ativas = () => [...ativas.values()].filter(rodando);
  function agendar(eid, ms) {
    const ex = ativas.get(eid);
    if (!ex) return;
    clearTimeout(ex._timer);
    ex._timer = setTimeout(() => consultar(eid), ms || (document.hidden ? 5000 : 1500));
  }
  async function consultar(eid) {
    const ex = ativas.get(eid);
    if (!ex) return;
    try {
      const r = await n.api("GET", `/api/execucoes/${encodeURIComponent(eid)}?desde=${ex._n || 0}`, null, { tempo: 8000, semMedir: true });
      const novo = r.execucao || {};
      const eventos = (ex.eventos || []).concat((novo.eventos || []).filter((e) => (Number(e.n) || 0) > (ex._n || 0)));
      const junto = Object.assign({}, novo, { eventos, _n: Math.max(ex._n || 0, maxN(eventos)) });
      ativas.set(eid, junto);
      detalhes.set(eid, junto);
      atualizarNaLista(junto);
      anunciarPassos(junto, novo.eventos || []);
      Mesa.emitir("agente", { eid, ex: junto });
      if (rodando(junto)) agendar(eid);
      else terminou(junto);
    } catch (e) {
      if (e.status === 400 || e.status === 404) { ativas.delete(eid); persistir(); Mesa.emitir("agente", { eid }); return; }
      agendar(eid, 5000);
    }
  }
  function anunciarPassos(ex, novos) {
    const ult = novos.filter((e) => e.tipo === "ferramenta" || e.tipo === "texto").pop();
    if (ult && Date.now() - ultimoAnuncio > 5000) { ultimoAnuncio = Date.now(); n.anunciar(ult.texto); }
  }
  function atualizarNaLista(ex) {
    const L = listas.get(ex.pendencia_id);
    if (!L || !L.execucoes) return;
    const k = L.execucoes.findIndex((x) => x.id === ex.id);
    const semEventos = Object.assign({}, ex);
    if (k >= 0) L.execucoes[k] = semEventos; else L.execucoes.unshift(semEventos);
  }
  function terminou(ex) {
    ativas.delete(ex.id);
    persistir();
    n.recarregar();
    const pid = ex.pendencia_id;
    const item = E.porId.get(pid);
    const vendo = Mesa.gaveta.atual() === pid && aba && aba.pid === pid && aba.painel.isConnected;
    const ref = item ? n.ref(pid) : "";
    let texto;
    if (ex.status === "concluida") texto = (ex.entregas || []).length ? `Entrega pronta em ${ref}.` : ex.modo === "rascunho" ? `Rascunho pronto em ${ref}.` : `Briefing pronto em ${ref}.`;
    else if (ex.status === "erro") texto = `O agente parou com erro em ${ref}.`;
    else texto = `Execução parada em ${ref}.`;
    n.anunciar(texto);
    if (!vendo && ex.status !== "cancelada") n.toast({ texto, tipo: ex.status === "erro" ? "erro" : "ok", acoes: item ? [{ rotulo: "Abrir", fn: () => Mesa.gaveta.abrir(pid, { via: "push", aba: "agente" }) }] : [] });
    Mesa.emitir("agente", { eid: ex.id, ex, fim: true });
  }
  function acompanhar(ex) {
    ex._n = maxN(ex.eventos);
    ativas.set(ex.id, ex);
    detalhes.set(ex.id, ex);
    persistir();
    agendar(ex.id, 800);
  }
  A.retomar = () => {
    for (const x of n.lerPref("mesa.execucoes.ativas", [])) {
      if (!x || !x.id || ativas.has(x.id)) continue;
      ativas.set(x.id, { id: x.id, pendencia_id: x.pid, status: "rodando", eventos: [], _n: 0 });
      consultar(x.id);
    }
  };
  /* Pastas que o agente vai abrir (ou abriu): o contexto do cérebro responde antes de rodar,
     a execução responde depois. */
  function pastasDe(item, ex) {
    if (ex && (ex.pastas || []).length) return ex.pastas;
    const ctx = Mesa.gaveta.contextoDe(item.id);
    return (ctx && ctx.pastas) || [];
  }
  /* O contexto pode não ter sido carregado ainda (a aba Agente abre direto pelo cartão): sem ele
     a confirmação não saberia dizer quais pastas serão abertas. */
  async function garantirPastas(item) {
    if (Mesa.gaveta.contextoDe(item.id)) return pastasDe(item, null);
    try { await Mesa.gaveta.recarregarContexto(item.id); } catch (e) { /* segue sem a lista */ }
    return pastasDe(item, null);
  }
  function listaPastas(pastas) {
    const ul = h("ul", { c: "ag-pastas" });
    for (const p of pastas) {
      ul.append(h("li", {}, ic("i-folder"), h("span", { c: "mono", t: p.caminho, "data-tip": p.motivo || "" }),
        h("button", { type: "button", c: "btn-icone b24", "aria-label": `Mostrar ${p.caminho} na pasta`, "data-tip": "Mostrar na pasta", on: { click: () => n.abrirCaminho(p.caminho, "explorer") } }, ic("i-open"))));
    }
    return ul;
  }

  A.iniciar = async (pid, modo, instrucao, projetos) => {
    if (!E.recursos.agente) { n.toast({ texto: "O agente ainda não está ligado neste servidor.", tipo: "info" }); return null; }
    if (!n.podeEscrever()) { n.semConexao(); return null; }
    if (A.ativaDe(pid) || pedindo.has(pid)) { n.toast({ texto: "Já tem uma execução rodando nesta pendência.", tipo: "info" }); return null; }
    pedindo.add(pid);
    Mesa.emitir("agente", { pid });
    try {
      const corpo = { modo };
      if (instrucao && instrucao.trim()) corpo.instrucao = instrucao.trim().slice(0, 1000);
      if ((projetos || []).length) corpo.projetos = projetos.slice(0, 8);
      const r = await n.api("POST", n.rotaItem(pid, "/agente"), corpo, { tempo: 20000 });
      const ex = r.execucao;
      acompanhar(ex);
      atualizarNaLista(ex);
      expandidas.add(ex.id);
      n.anunciar(`Agente começou: ${MODO[modo].rotulo.toLowerCase()} de ${n.ref(pid)}.`);
      return ex;
    } catch (e) {
      n.toast({ texto: `Não consegui iniciar o agente: ${e.message}`, tipo: "erro" });
      return null;
    } finally {
      pedindo.delete(pid);
      Mesa.emitir("agente", { pid });
    }
  };
  A.cancelar = async (eid) => {
    try {
      const r = await n.api("POST", `/api/execucoes/${encodeURIComponent(eid)}/cancelar`, {});
      const ex = r.execucao;
      if (ex) { const atual = ativas.get(eid); if (atual) { ativas.set(eid, Object.assign({}, atual, ex, { eventos: atual.eventos })); } atualizarNaLista(ex); }
      consultar(eid);
    } catch (e) { n.toast({ texto: `Não consegui parar a execução: ${e.message}`, tipo: "erro" }); }
  };
  async function carregarLista(pid) {
    const L = listas.get(pid) || {};
    if (L.carregando) return;
    L.carregando = true;
    listas.set(pid, L);
    try {
      const r = await n.api("GET", n.rotaItem(pid, "/execucoes"), null, { tempo: 10000 });
      L.execucoes = r.execucoes || [];
      L.erro = null;
      for (const ex of L.execucoes) if (rodando(ex) && !ativas.has(ex.id)) acompanhar(Object.assign({}, ex, { eventos: [] }));
    } catch (e) { L.erro = e; }
    L.carregando = false;
    if (aba && aba.pid === pid && aba.painel.isConnected && !A.editandoAba()) A.renderAba(aba.painel, E.porId.get(pid));
  }
  async function carregarDetalhe(eid) {
    if (detalhes.has(eid) && detalhes.get(eid).eventos) return detalhes.get(eid);
    try {
      const r = await n.api("GET", `/api/execucoes/${encodeURIComponent(eid)}?desde=0`, null, { tempo: 10000 });
      detalhes.set(eid, r.execucao);
      return r.execucao;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ aba Agente
  A.editandoAba = () => confirmando || !!(aba && aba.painel.isConnected && aba.painel.contains(document.activeElement) && n.ehCampo(document.activeElement));
  function pastaDoProjeto(item) {
    const p = item.projeto_id && E.projetosPorId.get(item.projeto_id);
    return p && p.pasta ? p.pasta : "";
  }
  A.renderAba = (painel, item, opts) => {
    if (!item) return;
    const o = opts || {};
    aba = { pid: item.id, painel };
    limpar(painel);
    const ligado = !!E.recursos.agente;
    const L = listas.get(item.id);
    if (ligado && !L) carregarLista(item.id);
    const execsServidor = (L && L.execucoes) || [];
    const ativa = A.ativaDe(item.id);
    const execs = [...execsServidor];
    if (ativa && !execs.some((x) => x.id === ativa.id)) execs.unshift(ativa);
    const jaTemBriefing = execs.some((x) => x.status === "concluida") || !!(item.agente && item.agente.ultima && item.agente.ultima.status === "concluida");
    const ocupado = !!ativa || pedindo.has(item.id);
    const leitura = !n.podeEscrever();
    const desab = !ligado || ocupado || leitura;
    const dica = !ligado ? "O agente ainda não está ligado neste servidor." : ocupado ? "Já tem uma execução rodando nesta pendência." : leitura ? "Sem conexão com o servidor local." : null;
    // classificação do cérebro
    const classe = { resolve_sozinho: "Resolve sozinho", prepara_rascunho: "Prepara rascunho", so_humano: "Só humano" }[item.ligacoes.agente];
    if (ligado && (classe || item.ligacoes.como_ajuda)) painel.append(h("p", { c: "ag-classe" }, classe ? h("b", { t: classe + ". " }) : null, item.ligacoes.como_ajuda || ""));
    const botoes = {};
    const acoes = h("div", { c: "ag-acoes" });
    for (const modo of ["briefing", "rascunho", "executar"]) {
      const primario = modo === (jaTemBriefing ? "executar" : "briefing");
      const b = h("button", { type: "button", c: "btn" + (primario ? " btn-primario" : ""), disabled: desab || null, "data-tip": dica, d: { modo } }, ic(MODO[modo].icone), MODO[modo].botao, n.kbd(...MODO[modo].kbd));
      b.addEventListener("click", () => {
        if (modo === "executar") return confirmarExecutar(item, b);
        A.iniciar(item.id, modo, instrucoes.get(item.id) || "");
      });
      botoes[modo] = b;
      acoes.append(b);
    }
    painel.append(acoes);
    if (!ligado) return;
    const pasta = pastaDoProjeto(item);
    const extra = daExtensao("permissao", execs).join(" ");
    const pastas = pastasDe(item, execs[0]);
    painel.append(h("p", { c: "ag-perm", t: `${pasta ? `Trabalha em ${pasta}.` : `Trabalha em entregas\\${item.id} (a pendência não tem projeto ligado).`} Só lê arquivos; o que produzir fica em entregas\\${item.id}.${extra ? " " + extra : ""}` }));
    if (pastas.length) painel.append(h("details", { c: "ag-pastas-caixa" },
      h("summary", {}, `Lê também ${pastas.length} ${n.plural(pastas.length, "pasta", "pastas")}`), listaPastas(pastas)));
    else if (!execs.length && !Mesa.gaveta.contextoDe(item.id)) {
      // sem contexto carregado ainda: busca e redesenha quando chegar, para a frase não mentir
      garantirPastas(item).then((ps) => { if (ps.length && aba && aba.pid === item.id && aba.painel.isConnected && !A.editandoAba()) A.renderAba(aba.painel, item); });
    }
    const caixaInstr = h("div", { c: "ag-instrucoes", hidden: !instrucoes.get(item.id) });
    const ta = h("textarea", { c: "campo-area", rows: "2", placeholder: "Algo a mais para o agente saber?", "aria-label": "Instruções para o agente", maxlength: "1000", style: "min-height:56px" });
    ta.value = instrucoes.get(item.id) || "";
    ta.addEventListener("input", () => instrucoes.set(item.id, ta.value));
    caixaInstr.append(ta);
    painel.append(h("button", { type: "button", c: "btn btn-sutil btn-28", style: "margin:6px 0 0 -10px", "aria-expanded": String(!caixaInstr.hidden), on: { click: (ev) => { caixaInstr.hidden = !caixaInstr.hidden; ev.currentTarget.setAttribute("aria-expanded", String(!caixaInstr.hidden)); if (!caixaInstr.hidden) ta.focus(); } } }, ic("i-plus"), "Instruções"), caixaInstr);
    if (!n.ligacoesN(item)) painel.append(h("p", { c: "ag-dica", t: "Sem contexto ligado. O agente vai procurar sozinho." }));
    const zonaConfirma = h("div", { c: "ag-confirma" });
    painel.append(zonaConfirma);
    aba.zonaConfirma = zonaConfirma;
    aba.botoes = botoes;
    const lista = h("div", { c: "ag-execs" });
    painel.append(lista);
    aba.lista = lista;
    desenharExecucoes(item, execs);
    if (o.acao === "foco-briefing" || o.acao === "briefing" || o.acao === "foco-rascunho" || o.acao === "rascunho") {
      const b = botoes[/rascunho/.test(o.acao) ? "rascunho" : "briefing"];
      requestAnimationFrame(() => { if (!b.disabled) { b.focus(); b.after(h("span", { c: "ag-dica", style: "align-self:center", t: "Enter começa" })); } });
    } else if (o.acao === "executar") requestAnimationFrame(() => { if (!botoes.executar.disabled) confirmarExecutar(item, botoes.executar); });
  };
  async function confirmarExecutar(item, botao, projetos) {
    if (!aba || !aba.zonaConfirma) return;
    const pasta = pastaDoProjeto(item);
    const pastas = (await garantirPastas(item)).map((p) => p.caminho).filter((c) => c !== pasta);
    const onde = [pasta || `entregas\\${item.id}`].concat(pastas.slice(0, 3));
    const resto = pastas.length > 3 ? ` e mais ${pastas.length - 3}` : "";
    // observação de última hora: é aqui que ele diz "no grão de ticket", "só outubro", "manda o CSV"
    const ta = h("textarea", { c: "campo-area", rows: "2", maxlength: "1000", style: "min-height:52px",
      placeholder: "Observação para esta execução (opcional): o grão, o período, o formato…",
      "aria-label": "Observação para esta execução" });
    ta.value = instrucoes.get(item.id) || "";
    const extra = h("div", { c: "confirma-extra" }, ta, h("span", { c: "ag-dica", t: "Ctrl+Enter executa." }));
    if (!aba || !aba.zonaConfirma) return;   // a aba pode ter sido redesenhada enquanto o contexto carregava
    let ok = false;
    confirmando = true;   // segura o redesenho: senão o polling apaga a caixa e o que ele digitou
    try {
      ok = await n.confirmar({ dentro: aba.zonaConfirma, substituir: true, foco: botao, extra,
        // a confirmação diz o que ele vai LER e onde vai GRAVAR; não promete nada sobre ferramentas
        // de extensão, que podem nem estar em jogo nesta execução
        mensagem: `O agente vai ler ${onde.join(", ")}${resto} e gravar o que produzir em entregas\\${item.id}; ele não escreve em pasta de projeto nenhuma. Executar agora?`,
        rotuloAcao: "Executar agora" });
    } finally {
      confirmando = false;
    }
    if (ok) {
      const obs = ta.value.trim();
      instrucoes.set(item.id, obs);
      A.iniciar(item.id, "executar", obs, projetos);
    }
  }
  function desenharExecucoes(item, execs) {
    const lista = aba.lista;
    limpar(lista);
    const L = listas.get(item.id);
    if (L && L.carregando && !execs.length) { lista.append(h("div", { style: "display:grid;gap:8px;padding:12px 0" }, h("span", { c: "esq", style: "width:50%" }), h("span", { c: "esq", style: "width:80%" }))); return; }
    if (L && L.erro && !execs.length) { lista.append(h("div", { c: "erro-texto" }, ic("i-error"), h("span", { t: "Não consegui carregar as execuções." }), h("button", { type: "button", c: "btn btn-28", t: "Tentar de novo", on: { click: () => { listas.delete(item.id); carregarLista(item.id); } } }))); return; }
    if (!execs.length) { lista.append(h("p", { c: "ag-vazio", t: "Nenhuma execução ainda. Comece com um briefing: o agente lê o contexto e resume o que falta." })); return; }
    execs.forEach((ex, k) => {
      const viva = ativas.get(ex.id) || detalhes.get(ex.id) || ex;
      const aberta = rodando(viva) || expandidas.has(ex.id) || (k === 0 && !recolhidas.has(ex.id));
      lista.append(desenharExecucao(item, viva, aberta, k === 0));
    });
  }
  A.atualizarAba = (pid, p) => {
    if (!aba || aba.pid !== pid || !aba.painel.isConnected) return;
    if (confirmando) return;   // há uma confirmação aberta; redesenhar levaria a caixa junto
    const item = E.porId.get(pid);
    if (!item) return;
    if (p && p.eid && !p.fim && aba.lista) {
      const atual = aba.lista.querySelector(`[data-eid="${CSS.escape(p.eid)}"]`);
      const ex = ativas.get(p.eid) || detalhes.get(p.eid);
      if (atual && ex && rodando(ex)) { atual.replaceWith(desenharExecucao(item, ex, true, atual === aba.lista.firstElementChild)); return; }
    }
    if (A.editandoAba()) return;
    A.renderAba(aba.painel, item);
  };

  function quandoTexto(ex) {
    const ini = ex.inicio || ex.criada;
    const partes = [];
    if (ini) partes.push(n.relativo(ini));
    if (rodando(ex)) partes.push(n.cronometro(Date.now() - new Date(ini || Date.now()).getTime()));
    else if (ex.duracao_ms) partes.push(n.duracao(ex.duracao_ms));
    return partes.join(" · ");
  }
  function tagEstado(ex) {
    const m = { fila: ["Na fila", "tag-fila"], rodando: ["Rodando", "tag-rodando"], concluida: ["Pronto", "tag-pronto"], erro: ["Falhou", "tag-falhou"], cancelada: ["Parado", "tag-parado"] }[ex.status] || ["", ""];
    return h("span", { c: "tag " + m[1], t: m[0] });
  }
  function desenharExecucao(item, ex, aberta, maisRecente) {
    const sec = h("section", { c: "exec", d: { eid: ex.id }, "aria-label": `${(MODO[ex.modo] || MODO.briefing).rotulo}, ${tagEstado(ex).textContent}` });
    const vivo = rodando(ex);
    const modo = MODO[ex.modo] || MODO.briefing;
    const quando = h("span", { c: "quando num", d: { cron: vivo ? (ex.inicio || ex.criada || "") : "" }, t: quandoTexto(ex) });
    const cab = h("div", { c: "exec-cab" });
    const abrir = h("button", { type: "button", c: "abrir", "aria-expanded": String(aberta), disabled: vivo || null, on: { click: () => { if (aberta) { expandidas.delete(ex.id); recolhidas.add(ex.id); } else { expandidas.add(ex.id); recolhidas.delete(ex.id); } sec.replaceWith(desenharExecucao(item, detalhes.get(ex.id) || ex, !aberta, maisRecente)); } } },
      ic(modo.icone), h("span", { c: "rot", t: modo.rotulo }), tagEstado(ex));
    cab.append(abrir, quando);
    if (vivo) {
      const parar = h("button", { type: "button", c: "btn btn-28 btn-parar", on: { click: async () => {
        let ok = false;
        confirmando = true;   // o polling redesenha a execução a cada 1,5 s e levaria a caixa junto
        try {
          ok = await n.confirmar({ depois: cab, mensagem: "Parar a execução? O que já foi feito fica salvo.", rotuloAcao: "Parar", rotuloCancelar: "Continuar", destrutiva: true, foco: parar });
        } finally {
          confirmando = false;
        }
        if (ok) A.cancelar(ex.id);
      } } }, ic("i-stop"), "Parar");
      cab.append(parar);
    } else cab.append(ic(aberta ? "i-chevron-up" : "i-chevron-down", "texto-3"));
    sec.append(cab);
    if (!aberta) return sec;
    if (vivo) {
      sec.append(h("div", { c: "barra-indet", "aria-hidden": "true" }));
      sec.append(desenharPassos(ex, true));
      sec.append(desenharLog(ex));
      for (const x of daExtensao("secao", ex)) sec.append(x);
      return sec;
    }
    const det = detalhes.get(ex.id);
    if (ex.status === "erro") {
      sec.append(h("div", { c: "exec-falha", role: "alert" },
        h("div", { c: "erro-texto", style: "padding:0" }, ic("i-error"), h("span", { t: `O agente parou: ${ex.erro || "sem detalhe"}` })),
        h("div", { c: "acoes" }, h("button", { type: "button", c: "btn btn-28", disabled: !!A.ativaDe(item.id) || null, t: "Tentar de novo", on: { click: () => A.iniciar(item.id, ex.modo, ex.instrucao || "") } }),
          h("button", { type: "button", c: "btn btn-28 btn-sutil", t: "Ver log", on: { click: async () => { logAberto.add(ex.id); await carregarDetalhe(ex.id); sec.replaceWith(desenharExecucao(item, detalhes.get(ex.id) || ex, true, maisRecente)); } } }))));
    }
    if (ex.status === "cancelada") sec.append(h("p", { c: "vazio-texto", t: "Execução parada antes de terminar." }));
    // passos recolhidos
    const qtdPassos = det && det.eventos ? det.eventos.filter((e) => e.tipo !== "inicio").length : null;
    const linhaPassos = h("button", { type: "button", c: "btn btn-sutil btn-24", style: "margin-left:-8px", "aria-expanded": String(logAberto.has(ex.id)), on: { click: async () => {
      if (logAberto.has(ex.id)) logAberto.delete(ex.id); else { logAberto.add(ex.id); await carregarDetalhe(ex.id); }
      sec.replaceWith(desenharExecucao(item, detalhes.get(ex.id) || ex, true, maisRecente));
    } } }, (qtdPassos != null ? `${qtdPassos} ${n.plural(qtdPassos, "passo", "passos")}` : "Passos") + (ex.duracao_ms ? ` · ${n.duracao(ex.duracao_ms)}` : ""), ic(logAberto.has(ex.id) ? "i-chevron-down-12" : "i-chevron-right-12"));
    sec.append(linhaPassos);
    if (logAberto.has(ex.id) && det && det.eventos) { sec.append(desenharPassos(det, false)); sec.append(desenharLog(det, true)); }
    if (ex.status === "concluida" && ex.resultado) sec.append(desenharResultado(item, ex, maisRecente));
    for (const x of daExtensao("secao", ex)) sec.append(x);
    const rod = [];
    if (ex.fim) rod.push(`${ex.status === "concluida" ? "Concluída" : ex.status === "erro" ? "Falhou" : "Parada"} ${n.relativo(ex.fim)}`);
    if (ex.duracao_ms) rod.push(n.duracao(ex.duracao_ms));
    if (ex.custo_usd) rod.push(n.fmtUSD(ex.custo_usd));
    if (ex.modelo) rod.push(`modelo ${ex.modelo}`);
    if (rod.length) sec.append(h("p", { c: "exec-rodape", t: rod.join(" · ") }));
    return sec;
  }
  function desenharPassos(ex, vivo) {
    const evs = (ex.eventos || []).filter((e) => e.tipo !== "inicio" || (ex.eventos || []).length === 1);
    const ini = new Date(ex.inicio || ex.criada || (evs[0] && evs[0].em) || Date.now()).getTime();
    const ul = h("ul", { c: "exec-passos" });
    const todos = passosTodos.has(ex.id);
    const mostrar = todos ? evs : evs.slice(-6);
    if (evs.length > mostrar.length) ul.append(h("li", {}, h("button", { type: "button", c: "btn btn-sutil btn-24", t: `Mostrar ${evs.length - mostrar.length} passos anteriores`, on: { click: (ev) => { passosTodos.add(ex.id); ev.currentTarget.closest(".exec-passos").replaceWith(desenharPassos(ex, vivo)); } } })));
    mostrar.forEach((e, k) => {
      const ultimo = vivo && k === mostrar.length - 1 && e.tipo !== "fim";
      const cls = e.tipo === "erro" ? "erro" : e.tipo === "aviso" ? "aviso" : ultimo ? "ativo" : "";
      const icone = e.tipo === "erro" ? ic("i-error-12") : e.tipo === "aviso" ? ic("i-warning-12") : ultimo ? n.spinner(true) : ic("i-check-12");
      const t = e.em ? new Date(e.em).getTime() - ini : 0;
      ul.append(h("li", { c: "exec-passo " + cls }, icone, h("span", { c: "t", t: e.texto }), h("span", { c: "d", t: t > 0 ? n.cronometro(t) : "" })));
    });
    if (vivo && !mostrar.length) ul.append(h("li", { c: "exec-passo ativo" }, n.spinner(true), h("span", { c: "t", t: ex.status === "fila" ? "Na fila: no máximo 2 execuções rodam ao mesmo tempo." : "Preparando o agente" }), h("span")));
    return ul;
  }
  function desenharLog(ex, sempre) {
    const caixa = h("div");
    const aberto = sempre || logAberto.has("log:" + ex.id);
    if (!sempre) caixa.append(h("button", { type: "button", c: "btn btn-sutil btn-24", style: "margin-left:-8px", "aria-expanded": String(aberto), on: { click: (ev) => { if (logAberto.has("log:" + ex.id)) logAberto.delete("log:" + ex.id); else logAberto.add("log:" + ex.id); ev.currentTarget.parentNode.replaceWith(desenharLog(ex)); } } }, aberto ? "Ocultar log completo" : "Ver log completo", ic(aberto ? "i-chevron-up-12" : "i-chevron-down-12")));
    if (!aberto) return caixa;
    const log = h("div", { c: "exec-log", tabindex: "0", "aria-label": "Log da execução" });
    log.textContent = (ex.eventos || []).map((e) => `${e.em ? n.horaDeTs(e.em) : ""}  ${e.tipo.padEnd(10)} ${e.texto}`).join("\n") || "Sem eventos ainda.";
    const faixa = h("div", { c: "t-meta texto-3", hidden: true }, "Rolagem automática pausada · ", h("button", { type: "button", c: "link", t: "Ir para o fim", on: { click: () => { log.scrollTop = log.scrollHeight; faixa.hidden = true; log._preso = true; } } }));
    log._preso = ex._logPreso !== false;
    log.addEventListener("scroll", () => { const fim = log.scrollTop + log.clientHeight >= log.scrollHeight - 4; ex._logPreso = fim; faixa.hidden = fim; });
    caixa.append(log, faixa);
    requestAnimationFrame(() => { if (ex._logPreso !== false) log.scrollTop = log.scrollHeight; else faixa.hidden = false; });
    return caixa;
  }
  function textoPlano(ex) {
    const r = ex.resultado || {};
    const partes = [];
    if (r.resumo) partes.push(r.resumo);
    if ((r.proximos_passos || []).length) partes.push("Próximos passos:\n" + r.proximos_passos.map((p) => "• " + p).join("\n"));
    if ((r.bloqueios || []).length) partes.push("Bloqueios:\n" + r.bloqueios.map((p) => "• " + p).join("\n"));
    if ((r.contexto || []).length) partes.push("Fontes:\n" + r.contexto.map((c) => `• ${c.fonte}${c.porque ? " — " + c.porque : ""}`).join("\n"));
    return partes.join("\n\n");
  }
  function htmlTeams(ex) {
    const r = ex.resultado || {};
    const div = h("div");
    if (r.resumo) div.append(h("p", { t: r.resumo }));
    if ((r.proximos_passos || []).length) div.append(h("p", {}, h("b", { t: "Próximos passos" })), h("ul", {}, r.proximos_passos.map((p) => h("li", { t: p }))));
    if ((r.bloqueios || []).length) div.append(h("p", {}, h("b", { t: "Bloqueios" })), h("ul", {}, r.bloqueios.map((p) => h("li", { t: p }))));
    return div.innerHTML; // conteúdo montado só com textContent: seguro
  }
  /* A última milha: o SERVIDOR copia a entrega para dentro do projeto, numa pasta nova.
     O agente continua sem escrever em projeto nenhum. */
  /* Sem projeto ligado, não se adivinha o destino: pergunta, com as sugestões do cérebro. */
  function escolherProjeto(item, ex, ancora) {
    const ctx = Mesa.gaveta.contextoDe(item.id) || {};
    const vistos = new Set();
    const opcoes = [];
    for (const s of ctx.sugestoes || []) if (!vistos.has(s.projeto_id)) { vistos.add(s.projeto_id); opcoes.push({ id: s.projeto_id, nome: s.nome || n.nomeProjeto(s.projeto_id) }); }
    for (const p of (ex.pastas || [])) {
      const proj = E.projetos.find((x) => x.pasta === p.caminho);
      if (proj && !vistos.has(proj.id)) { vistos.add(proj.id); opcoes.push({ id: proj.id, nome: proj.nome }); }
    }
    return new Promise((resolver) => {
      if (!opcoes.length) { resolver(""); return; }
      n.menu(ancora, opcoes.map((o) => ({ rotulo: o.nome, icone: "i-folder", acao: () => resolver(o.id) }))
        .concat([{ separador: true }, { rotulo: "Escolher na gaveta…", acao: () => { resolver(""); Mesa.gaveta.abrir(item.id, { aba: "contexto" }); } }]),
        { rotulo: "Copiar para qual projeto?" });
    });
  }
  async function copiarParaProjeto(item, ex, zona, botao) {
    if (!n.podeEscrever()) return n.semConexao();
    let projeto = item.projeto_id || "";
    if (!projeto) {
      projeto = await escolherProjeto(item, ex, botao);
      if (!projeto) { n.toast({ texto: "Ligue a pendência a um projeto para copiar a entrega.", tipo: "info" }); return; }
    }
    let previa;
    try {
      previa = await n.api("POST", `/api/entregas/${encodeURIComponent(item.id)}/copiar`, { eid: ex.id, projeto_id: projeto }, { tempo: 20000 });
    } catch (e) {
      n.toast({ texto: /projeto/.test(e.message || "") ? "Ligue a pendência a um projeto para copiar a entrega." : `Não consegui preparar a cópia: ${e.message}`, tipo: "erro" });
      return;
    }
    const qtd = (previa.arquivos || []).length;
    const ok = await n.confirmar({ dentro: zona, substituir: true, foco: botao,
      mensagem: `Copiar ${qtd} ${n.plural(qtd, "arquivo", "arquivos")} para ${previa.destino}? A pasta é nova: nada do projeto ${previa.projeto} é sobrescrito.`,
      rotuloAcao: "Copiar agora" });
    if (!ok) return;
    try {
      const r = await n.api("POST", `/api/entregas/${encodeURIComponent(item.id)}/copiar`, { eid: ex.id, projeto_id: projeto, confirmar: true }, { tempo: 30000 });
      n.toast({ texto: `${(r.arquivos || []).length} ${n.plural((r.arquivos || []).length, "arquivo copiado", "arquivos copiados")} para ${r.destino}.`, tipo: "ok",
        acoes: [{ rotulo: "Abrir a pasta", fn: () => n.abrirCaminho(r.destino, "explorer") }] });
    } catch (e) {
      n.toast({ texto: `Não consegui copiar: ${e.message}`, tipo: "erro" });
    }
  }

  function desenharResultado(item, ex, maisRecente) {
    const r = ex.resultado || {};
    const caixa = h("div", { c: "exec-res" });
    if (r.resumo) caixa.append(md(r.resumo));
    if (r.mensagem && r.mensagem.texto) {
      const chave = ex.id;
      const ta = h("textarea", { "aria-label": `Rascunho para ${r.mensagem.para || "a pessoa"}` });
      ta.value = textosRascunho.has(chave) ? textosRascunho.get(chave) : r.mensagem.texto;
      const cont = h("span", { c: "cont", t: `${ta.value.length} caracteres` });
      ta.addEventListener("input", () => { textosRascunho.set(chave, ta.value); cont.textContent = `${ta.value.length} caracteres`; });
      const ajustar = h("input", { type: "text", c: "campo", placeholder: "Ajustar: mais curta, mais formal…", "aria-label": "Ajustar o rascunho", style: "flex:1;min-width:160px;height:28px" });
      ajustar.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" || !ajustar.value.trim()) return;
        ev.preventDefault();
        A.iniciar(item.id, "rascunho", `Ajuste o rascunho anterior: ${ajustar.value.trim()}\n\nRascunho anterior:\n${ta.value.slice(0, 700)}`);
      });
      caixa.append(h("div", { c: "exec-bloco" }, h("div", { c: "rascunho" },
        h("div", { c: "rascunho-cab" }, ic("i-chat"), `Rascunho para ${r.mensagem.para || "a pessoa"} · Teams`, cont), ta,
        h("div", { c: "rascunho-acoes" },
          h("button", { type: "button", c: "btn btn-28 btn-primario", on: { click: () => n.copiarRico(ta.value.split("\n").map((l) => { const p = document.createElement("p"); p.textContent = l; return p.outerHTML; }).join(""), ta.value, "Pronto para colar no Teams.") } }, ic("i-copy"), "Copiar para o Teams"),
          h("button", { type: "button", c: "btn btn-28", disabled: !!A.ativaDe(item.id) || null, on: { click: () => A.iniciar(item.id, "rascunho", instrucoes.get(item.id) || "") } }, ic("i-refresh"), "Refazer"),
          ajustar)),
        h("p", { c: "ag-dica", t: "A Mesa nunca envia nada ao Teams: copie e cole você mesmo." })));
    }
    if ((r.proximos_passos || []).length) caixa.append(h("div", { c: "exec-bloco" }, h("h4", { t: "Próximos passos" }), h("div", { c: "md" }, h("ol", {}, r.proximos_passos.map((p) => h("li", {}, inline(p)))))));
    if ((r.bloqueios || []).length) caixa.append(h("div", { c: "exec-bloco" }, h("h4", { t: "Bloqueios" }), h("ul", { c: "exec-bloqueios" }, r.bloqueios.map((b) => h("li", {}, ic("i-warning"), h("span", {}, inline(b)))))));
    // acesso negado: o caminho vem do próprio CLI, então dá para oferecer a pasta de volta
    if ((ex.pastas_negadas || []).length) {
      const ul = h("ul", { c: "exec-bloqueios" });
      for (const p of ex.pastas_negadas) {
        ul.append(h("li", {}, ic("i-folder"), h("span", {}, h("span", { c: "mono", t: p.caminho }), p.nome ? ` — ${p.nome}` : ""),
          h("button", { type: "button", c: "btn btn-24", disabled: !!A.ativaDe(item.id) || !n.podeEscrever() || !p.projeto_id || null,
            "data-tip": p.projeto_id ? "Roda de novo com esta pasta aberta" : "Essa pasta não é de um projeto registrado",
            on: { click: (evt) => {
              const instrucao = ex.instrucao || instrucoes.get(item.id) || "";
              // executar passa pela mesma confirmação dos outros caminhos
              if (ex.modo === "executar") confirmarExecutar(item, evt.currentTarget, [p.projeto_id]);
              else A.iniciar(item.id, ex.modo, instrucao, [p.projeto_id]);
            } } }, ic("i-refresh"), "Abrir e refazer")));
      }
      caixa.append(h("div", { c: "exec-bloco" }, h("h4", { t: "Leitura negada" }),
        h("p", { c: "ag-dica", t: "O agente tentou ler fora das pastas abertas. Dá para rodar de novo com a pasta liberada." }), ul));
    }
    const entregas = ex.entregas || [];
    if (entregas.length) {
      const vistas = n.vistas();
      const ul = h("ul", { c: "exec-arquivos" });
      for (const a of entregas) {
        const caminho = n.caminhoEntrega(item.id, a.nome);
        ul.append(h("li", { c: "exec-arquivo" }, ic(n.iconeArquivo(a.nome)), h("span", { c: "nome", t: a.rotulo || a.nome, "data-tip": a.nome }), !vistas.has(ex.id) ? h("span", { c: "tag tag-novo", t: "Novo" }) : null, h("span", { c: "desc", t: a.descricao || "", "data-tip-auto": a.descricao || "" }),
          h("span", { c: "acoes" },
            h("a", { c: "btn btn-sutil btn-24", href: n.urlEntrega(item.id, a.nome), target: "_blank", rel: "noopener", t: "Abrir" }),
            h("button", { type: "button", c: "btn btn-sutil btn-24", t: "Pasta", "data-tip": "Mostrar na pasta", on: { click: () => n.abrirCaminho(caminho, "explorer") } }),
            h("button", { type: "button", c: "btn-icone b24", "aria-label": "Copiar caminho", "data-tip": "Copiar caminho", on: { click: () => n.copiar(caminho, "Caminho copiado.") } }, ic("i-copy")))));
      }
      const zonaCopia = h("div", { c: "ag-confirma" });
      caixa.append(h("div", { c: "exec-bloco" }, h("h4", {}, "Arquivos entregues", h("span", { c: "num", t: String(entregas.length) })), ul,
        h("div", { c: "exec-acoes-res" },
          h("button", { type: "button", c: "btn btn-28", disabled: !n.podeEscrever() || null,
            "data-tip": "O servidor copia para uma pasta nova dentro do projeto; nada é sobrescrito",
            on: { click: (ev) => copiarParaProjeto(item, ex, zonaCopia, ev.currentTarget) } }, ic("i-folder-open"), "Copiar para a pasta do projeto")),
        zonaCopia));
      if (maisRecente && !vistas.has(ex.id)) setTimeout(() => { if (caixa.isConnected && !document.hidden) n.marcarVista(ex.id); }, 2000);
    }
    if ((r.contexto || []).length) {
      const ul = h("ul", { c: "exec-fontes" });
      for (const c of r.contexto) {
        const ehCaminho = /^[A-Za-z]:\\/.test(c.fonte || "");
        // a fonte pode vir com sufixo ("… (linhas 770 a 813)", "…: L 12–18", "… — seção 1.7"): abre só o caminho
        const caminho = ehCaminho ? String(c.fonte).split(/\s+[—–]\s+/)[0].replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*[:#,]\s*(L|linhas?|seç[aã]o)\b.*$/i, "").trim() : "";
        ul.append(h("li", { c: "exec-fonte" },
          h("div", { c: "f" }, ic(ehCaminho ? n.iconeArquivo(caminho) : "i-note"), h("span", { c: "mono", t: c.fonte, "data-tip": c.fonte }), ehCaminho ? h("button", { type: "button", c: "btn btn-sutil btn-24", t: "Abrir", "data-tip": caminho, on: { click: () => n.abrirCaminho(caminho, "code") } }) : null),
          c.trecho ? h("div", { c: "tr" }, "“", c.trecho, "”") : null,
          c.porque ? h("div", { c: "pq" }, h("b", { t: "Por quê: " }), c.porque) : null));
      }
      caixa.append(h("div", { c: "exec-bloco" }, h("h4", {}, "Contexto que ele usou", h("span", { c: "num", t: String(r.contexto.length) })), ul));
    }
    const acoes = h("div", { c: "exec-acoes-res" },
      h("button", { type: "button", c: "btn btn-28", on: { click: () => n.copiar(textoPlano(ex), "Resultado copiado.") } }, ic("i-copy"), "Copiar"),
      h("button", { type: "button", c: "btn btn-28", on: { click: () => n.copiarRico(htmlTeams(ex), textoPlano(ex), "Pronto para colar no Teams.") } }, "Copiar para o Teams"),
      h("button", { type: "button", c: "btn btn-28", disabled: !!A.ativaDe(item.id) || !n.podeEscrever() || null, on: { click: () => { if (ex.modo === "executar") { const b = aba && aba.botoes && aba.botoes.executar; confirmarExecutar(item, b || null); } else A.iniciar(item.id, ex.modo, ex.instrucao || instrucoes.get(item.id) || ""); } } }, ic("i-refresh"), "Refazer"));
    if ((r.pode_concluir || ex.modo === "executar") && item.status !== "feita") acoes.append(h("button", { type: "button", c: "btn btn-28", disabled: !n.podeEscrever() || null, on: { click: () => Mesa.quadro.concluir(item.id) } }, ic("i-status-done", "col-ic-feita"), "Concluir pendência"));
    caixa.append(acoes);
    return caixa;
  }

  // cronômetros ao vivo (texto, sem animação)
  setInterval(() => {
    for (const el of $$("[data-cron]")) {
      const ini = el.dataset.cron;
      if (!ini) continue;
      el.textContent = `${n.relativo(ini)} · ${n.cronometro(Date.now() - new Date(ini).getTime())}`;
    }
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) for (const ex of A.ativas()) agendar(ex.id, 200); });
  Mesa.ouvir("dados", () => {
    // a lista do servidor pode ter mudado (agente terminou em outra aba): recarrega a da pendência aberta se o total mudou
    if (!aba || !aba.painel.isConnected) return;
    const item = E.porId.get(aba.pid);
    const L = listas.get(aba.pid);
    if (item && L && L.execucoes && item.agente && Number(item.agente.total || 0) > L.execucoes.length && !L.carregando) carregarLista(aba.pid);
  });
})();
