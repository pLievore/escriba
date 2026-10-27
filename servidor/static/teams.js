/* Escriba: leitura do Teams num clique.
   Um botão na barra de ferramentas e o item "Teams lido" do rodapé abrem o mesmo painel:
   ele dispara POST /api/teams/atualizar, acompanha o progresso (GET /api/teams?desde=n a cada
   1,5 s), mostra cada mudança aplicada com Desfazer e o que ficou em dúvida.
   O servidor é quem copia o cache, extrai as conversas e chama o Claude Code; aqui só se mostra. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, $$, limpar } = n;
  const T = Mesa.teams;

  const PASSOS = [["copia", "Copiando o cache do Teams"], ["extracao", "Lendo as mensagens novas"],
                  ["analise", "Comparando com o quadro"], ["aplicacao", "Aplicando as mudanças"],
                  ["cerebro", "Ligando ao contexto"]];
  const CAMPOS = [["status", "Status"], ["prioridade", "Prioridade"], ["prazo", "Prazo"], ["titulo", "Título"],
                  ["pessoa", "Pedido por"], ["area", "Área"], ["projeto_id", "Projeto"], ["contexto", "Descrição"]];
  const rodando = (s) => !!s && s.status === "rodando";
  const maxN = (evs) => (evs || []).reduce((m, e) => Math.max(m, Number(e.n) || 0), 0);

  let sync = null;            // última atualização conhecida (com os eventos acumulados)
  let timer = 0, pop = null, caixa = null, pedindo = false, perguntou = false;
  const desfeitas = new Set();

  // ------------------------------------------------------------------ acompanhamento
  function juntar(novo) {
    if (!novo) { sync = null; return; }
    const antes = sync && sync.id === novo.id ? sync.eventos || [] : [];
    const eventos = antes.concat((novo.eventos || []).filter((e) => (Number(e.n) || 0) > maxN(antes)));
    sync = Object.assign({}, novo, { eventos });
  }
  function agendar(ms) {
    clearTimeout(timer);
    timer = setTimeout(consultar, ms || (document.hidden ? 5000 : 1500));
  }
  async function consultar() {
    clearTimeout(timer);
    const antes = sync && rodando(sync);
    try {
      const r = await n.api("GET", `/api/teams?desde=${sync ? maxN(sync.eventos) : 0}`, null, { tempo: 8000, semMedir: true });
      juntar(r.sync);
      Mesa.emitir("teams", { sync });
      desenhar();
      if (rodando(sync)) agendar();
      else if (antes) terminou();
    } catch (e) {
      if (rodando(sync)) agendar(5000);
    }
  }
  function terminou() {
    n.recarregar();
    const s = sync || {};
    const r = s.resumo || {};
    const muds = s.mudancas || [];
    if (s.status === "concluida" && muds.length) {
      const acao = n.criarAcao(`Leitura do Teams: ${muds.length} ${n.plural(muds.length, "mudança aplicada", "mudanças aplicadas")}.`,
        muds, null, `Desfeito: ${muds.length} ${n.plural(muds.length, "mudança da leitura do Teams", "mudanças da leitura do Teams")}.`);
      n.registrarAcao(acao);
      requestAnimationFrame(() => Mesa.quadro.piscar(muds.map((m) => m.id)));
    }
    const texto = s.status === "erro" ? `Não consegui ler o Teams: ${String(s.erro || "").replace(/\.$/, "")}.`
      : s.status === "cancelada" ? "Leitura do Teams parada."
      : muds.length ? `Teams lido: ${resumoCurto(r)}.`
      : (s.resposta || "Teams lido: nada novo para o quadro.");
    n.anunciar(texto);
    if (!aberto()) n.toast({ texto, tipo: s.status === "erro" ? "erro" : "ok", duracao: s.status === "erro" ? 0 : 8000,
      acoes: [{ rotulo: "Ver", fn: () => T.painel() }] });
    Mesa.emitir("teams", { sync, fim: true });
    desenhar();
  }
  function resumoCurto(r) {
    const p = [];
    if (r.criadas) p.push(`${r.criadas} ${n.plural(r.criadas, "nova", "novas")}`);
    if (r.atualizadas) p.push(`${r.atualizadas} ${n.plural(r.atualizadas, "atualizada", "atualizadas")}`);
    if (!p.length) p.push("nada mudou");
    return p.join(", ");
  }

  // ------------------------------------------------------------------ ações
  T.disponivel = () => !!(E.recursos && E.recursos.teams);
  T.emCurso = () => (rodando(sync) ? sync : null);
  T.ultima = () => sync;
  T.iniciar = () => { if (T.disponivel()) consultar(); };

  T.atualizar = async () => {
    if (!T.disponivel()) { n.toast({ texto: "A leitura do Teams não está ligada neste servidor.", tipo: "info" }); return; }
    if (!n.podeEscrever()) { n.semConexao(); return; }
    if (rodando(sync) || pedindo) return;
    pedindo = true;
    desfeitas.clear();
    desenhar();
    try {
      const r = await n.api("POST", "/api/teams/atualizar", {}, { tempo: 20000 });
      juntar(r.sync);
      n.anunciar("Leitura do Teams iniciada.");
      Mesa.emitir("teams", { sync });
      agendar(800);
    } catch (e) {
      const texto = e.status === 409 ? "A leitura do Teams já está rodando." : `Não consegui começar: ${e.message}`;
      n.toast({ texto, tipo: e.status === 409 ? "info" : "erro" });
      consultar();
    } finally {
      pedindo = false;
      desenhar();
    }
  };
  T.parar = async () => {
    try {
      const r = await n.api("POST", "/api/teams/cancelar", {}, { tempo: 10000 });
      juntar(r.sync);
      desenhar();
      consultar();
    } catch (e) { n.toast({ texto: `Não consegui parar: ${e.message}`, tipo: "erro" }); }
  };

  // ------------------------------------------------------------------ painel
  function aberto() { return !!(pop && pop.el && pop.el.isConnected); }
  /* A barra de status é redesenhada a cada evento, então o elemento âncora morre embaixo do
     popover: guardamos o id e procuramos o atual na hora de posicionar e de devolver o foco. */
  let ancoraId = "";
  const ancoraAtual = () => (ancoraId && $("#" + ancoraId)) || null;
  function reposicionar() { if (aberto()) n.posicionar(pop.el, ancoraAtual() || pop.ancora); }
  T.painel = (ancora) => {
    const alvo = ancora || $("#fer-teams") || $("#st-teams") || $("#topo-nova");
    if (!alvo) return;
    if (aberto()) { pop.fechar(); return; }
    ancoraId = alvo.id || "";
    caixa = h("div", { c: "pop-teams" });
    pop = n.popover(alvo, caixa, { rotulo: "Leitura do Teams", aoFechar: (porFora) => {
      pop = null; caixa = null;
      const a = ancoraAtual();
      if (!porFora && a && a.focus) a.focus({ preventScroll: true });
    } });
    desenhar();
  };
  /* O botão da barra de ferramentas é desenhado pelo quadro.js; aqui só muda o estado dele. */
  function atualizarBotao() {
    const b = $("#fer-teams");
    if (!b) return;
    const ativo = rodando(sync) || pedindo;
    if (b.dataset.lendo === String(ativo)) return;   // o quadro redesenha muito; só mexe quando muda
    b.dataset.lendo = String(ativo);
    b.classList.toggle("ocupado", ativo);
    b.setAttribute("aria-busy", ativo ? "true" : "false");
    b.setAttribute("data-tip", ativo ? "Lendo o Teams…" : "Atualizar do Teams");
    limpar(b);
    b.append(ativo ? n.spinner() : ic("i-refresh"));
  }
  function desenhar() {
    atualizarBotao();
    if (!aberto()) return;
    limpar(caixa);
    const s = sync || {};
    const meta = E.meta || {};
    caixa.append(h("div", { c: "pop-teams-cab" }, ic("i-chat"), h("h3", { t: "Leitura do Teams" })));
    caixa.append(h("p", { c: "pop-teams-sub", t: meta.ultima_leitura_teams
      ? `Lido até ${n.ddmm(n.isoDeTs(meta.ultima_leitura_teams))} ${n.horaDeTs(meta.ultima_leitura_teams)}`
        + (meta.chats_lidos ? ` · ${meta.chats_lidos} chats` : "")
      : "As conversas ainda não foram lidas." }));
    if (rodando(s)) desenharRodando(s);
    else if (s.status === "erro") desenharErro(s);
    else if (s.status === "concluida" || s.status === "cancelada") desenharFim(s);
    else desenharParado();
    reposicionar();
  }
  function botaoAtualizar(rotulo) {
    return h("button", { type: "button", c: "btn btn-28 btn-primario", disabled: pedindo || !n.podeEscrever() || null,
      on: { click: () => T.atualizar() } }, pedindo ? n.spinner(true) : ic("i-refresh"), rotulo);
  }
  function desenharParado() {
    caixa.append(h("p", { c: "pop-teams-exp", t: "Copio o cache do Teams desta máquina, leio só as mensagens que chegaram depois da última leitura e atualizo o quadro. Nada é enviado ao Teams." }));
    caixa.append(h("div", { c: "pop-acoes" }, botaoAtualizar("Atualizar agora")));
  }
  function desenharRodando(s) {
    const ul = h("ul", { c: "exec-passos" });
    const atual = PASSOS.findIndex(([k]) => k === s.etapa);
    PASSOS.forEach(([, rotulo], i) => {
      const feito = atual > i, agora = atual === i;
      ul.append(h("li", { c: "exec-passo " + (agora ? "ativo" : "") },
        agora ? n.spinner(true) : feito ? ic("i-check-12") : ic("i-clock-12"),
        h("span", { c: "t", t: rotulo }), h("span")));
    });
    caixa.append(ul);
    const ultimo = [...(s.eventos || [])].reverse().find((e) => e.tipo === "ok" || e.tipo === "texto" || e.tipo === "aviso");
    if (ultimo) caixa.append(h("p", { c: "pop-teams-exp", t: ultimo.texto }));
    caixa.append(h("div", { c: "pop-acoes" },
      h("span", { c: "pop-teams-tempo", "data-teams-cron": s.inicio, t: n.cronometro(Date.now() - new Date(s.inicio).getTime()) }),
      h("button", { type: "button", c: "btn btn-28", t: "Parar", on: { click: () => T.parar() } })));
  }
  function desenharErro(s) {
    caixa.append(h("div", { c: "pal-erro", role: "alert" },
      h("div", { c: "l" }, ic("i-error"), h("span", { t: s.erro || "A leitura falhou." }))));
    caixa.append(h("div", { c: "pop-acoes" }, botaoAtualizar("Tentar de novo")));
  }
  function desenharFim(s) {
    const r = s.resumo || {};
    const muds = s.mudancas || [];
    if (s.status === "cancelada") caixa.append(h("p", { c: "pop-teams-exp", t: "Parada por você. O que já tinha sido aplicado continua no quadro." }));
    else caixa.append(h("div", { c: "pal-res-cab" }, ic("i-success"), h("span", { t: resumoCurto(r) }),
      h("span", { c: "em", t: s.duracao_ms ? `em ${n.duracao(s.duracao_ms)}` : "" })));
    if (r.mensagens != null) caixa.append(h("p", { c: "pop-teams-sub", t: `${r.mensagens} ${n.plural(r.mensagens, "mensagem", "mensagens")} em ${r.chats || 0} ${n.plural(r.chats || 0, "chat", "chats")}` }));
    if (s.resposta) caixa.append(h("div", { c: "pal-resposta", t: s.resposta }));
    for (const m of muds) caixa.append(linhaMudanca(m));
    for (const d of s.duvidas || []) caixa.append(h("div", { c: "pal-aviso" }, ic("i-info"), h("span", { t: d })));
    for (const a of s.avisos || []) caixa.append(h("div", { c: "pal-aviso" }, ic("i-warning"), h("span", { t: String(a).replace(/^opera[cç][aã]o \d+:\s*/i, "Não aplicado: ") })));
    if (s.custo_usd) caixa.append(h("p", { c: "pop-teams-sub", t: `Claude Code · ${n.fmtUSD(s.custo_usd)}` }));
    caixa.append(h("div", { c: "pop-acoes" }, botaoAtualizar("Atualizar de novo")));
  }
  function valorCampo(k, v) {
    if (k === "status") return n.STATUS_NOME[v] || v || "—";
    if (k === "prioridade") return (n.PRIO[v] || {}).nome || v || "—";
    if (k === "prazo") return v ? n.dataComSemana(v) : "sem prazo";
    if (k === "projeto_id") return v ? n.nomeProjeto(v) : "sem projeto";
    if (k === "contexto") return v ? `“${String(v).slice(0, 60)}${String(v).length > 60 ? "…" : ""}”` : "vazia";
    return v ? String(v) : "—";
  }
  function linhaMudanca(m) {
    const atual = E.porId.get(m.id);
    const desfeita = desfeitas.has(m.id + m.tipo);
    const l2 = h("div", { c: "l2" });
    let icone = "i-edit";
    if (m.tipo === "criou") {
      icone = "i-plus";
      if (atual) l2.append(`Nova · ${(n.PRIO[atual.prioridade] || {}).nome || ""} · ${atual.area}`);
    } else {
      const antes = m.antes || {};
      let algum = false;
      for (const [k, rot] of CAMPOS) {
        if (!(k in antes) || !atual || String(antes[k] || "") === String(atual[k] || "")) continue;
        if (algum) l2.append(h("br"));
        l2.append(`${rot}: `, h("span", { c: "antes", t: valorCampo(k, antes[k]) }), " → ", h("span", { c: "depois", t: valorCampo(k, atual[k]) }));
        algum = true;
        if (k === "status") icone = atual.status === "descartada" ? "i-discard" : n.STATUS_ICONE[atual.status];
      }
      if (!algum) l2.append(m.resumo || "Alterada");
    }
    if (desfeita) { limpar(l2); l2.append("Desfeito"); }
    const botao = h("button", { type: "button", c: "btn btn-24", t: "Desfazer", disabled: desfeita || !E.porId.has(m.id) || null });
    const linha = h("div", { c: "pal-mud" + (desfeita ? " desfeita" : ""), tabindex: "0", role: "group", "aria-label": `${n.ref(m.id)} ${m.titulo}` },
      ic(icone), h("div", {}, h("div", { c: "l1" }, h("span", { c: "card-num", t: n.ref(m.id) || "#" }), h("span", { c: "t", t: m.titulo })), l2), botao);
    botao.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      botao.disabled = true;
      try {
        await n.desfazerMudanca(m);
        desfeitas.add(m.id + m.tipo);
        desenhar();
      } catch (e) {
        botao.remove();
        linha.querySelector("div").append(h("div", { c: "erro", t: e.status === 409 ? "Não dá pra desfazer: a pendência mudou depois." : `Não consegui: ${e.message}` }));
      }
    });
    linha.addEventListener("click", () => { if (!E.porId.has(m.id)) return; if (pop) pop.fechar(true); Mesa.gaveta.abrir(m.id, { via: "push" }); });
    linha.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target === linha) { ev.preventDefault(); linha.click(); } });
    return linha;
  }

  // ------------------------------------------------------------------ ligações
  Mesa.ouvir("dados", () => desenhar());
  Mesa.ouvir("status", () => {
    atualizarBotao();
    // a primeira resposta do /api/status diz se o servidor lê o Teams; aí procuramos uma leitura em curso
    if (!T.disponivel() || perguntou) return;
    perguntou = true;
    consultar();
  });
  // cronômetro da leitura em curso (texto, sem animação)
  setInterval(() => {
    for (const el of $$("[data-teams-cron]")) el.textContent = n.cronometro(Date.now() - new Date(el.dataset.teamsCron).getTime());
  }, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && rodando(sync)) agendar(200); });
})();
