/* Escriba: Radar.
   Página #/radar: a tela de acompanhamento, feita para caber inteira num monitor, sem rolar.

   Layout: a página é uma grade de altura fixa (topo, filtros, faixa, KPIs, visuais em 4x3). Quem
   manda no tamanho de cada visual é a célula da grade, não o conteúdo — é isso que faz tudo caber
   e tira os vãos. Por isso as barras e as colunas são HTML, não SVG: elas se esticam para preencher
   a célula. Sobra para o SVG só o que tem proporção própria (a rosca e a linha do fluxo).

   Tudo é calculado AQUI a partir de `Mesa.estado.itens` — o painel já tem todas as pendências na
   memória. É o que torna o filtro cruzado instantâneo. Por isso esta página foge do padrão "os
   fatos vêm prontos do servidor" que a daily segue.

   Filtro cruzado, como no Power BI: clicar numa marca liga um filtro, e os outros visuais mostram
   o recorte **sobre o total**, que continua desenhado em cinza — o tamanho relativo não se perde.
   O eixo de cada visual é sempre o universo inteiro: a categoria não clicada esmaece, não some.

   Volume: as barras têm gradiente, brilho no topo e sombra projetada. Nada de perspectiva ou
   rotação, que encolheriam a marca do fundo e mentiriam sobre o número. Toda marca é rotulada:
   a cor é enfeite, nunca o único canal de identidade. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, limpar } = n;
  const R = (Mesa.radar = {});
  const SVGNS = "http://www.w3.org/2000/svg";
  const DSEM = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const ABERTAS = ["aberta", "andamento", "aguardando"];
  const PERIODOS = [[7, "7 d"], [14, "14 d"], [30, "30 d"], [90, "90 d"]];
  const DIAS_CARGA = 12;

  const SLOT = ["azul", "rosa", "verde", "ambar", "laranja", "violeta", "lima", "ardosia"];
  const slotArea = (nome) => SLOT[Math.max(0, n.AREAS.findIndex((a) => a.nome === nome))] || "ardosia";
  const SLOT_STATUS = { aberta: "neutro", andamento: "ciano", aguardando: "violeta", feita: "ok", descartada: "ardosia" };
  const SLOT_PRIO = { urgente: "crit", semana: "ambar", acompanhar: "ciano" };

  function sv(tag, attrs, ...filhos) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) if (attrs[k] != null) e.setAttribute(k, String(attrs[k]));
    for (const f of filhos.flat(Infinity)) if (f != null && f !== false) e.append(f);
    return e;
  }
  const txt = (s) => document.createTextNode(String(s));
  const pc = (v, max) => (max > 0 ? Math.min(100, (v / max) * 100) : 0);

  // ------------------------------------------------------------------ estado
  const DIMS = ["areas", "pessoas", "prioridades", "status", "projetos"];
  const F = {};
  for (const d of DIMS) F[d] = new Set();
  let periodo = Number(n.lerPref("mesa.radar.periodo", 30)) || 30;
  let timer = 0, montado = false, seq = 0;

  const fmtPeriodo = () => (PERIODOS.find((p) => p[0] === periodo) || PERIODOS[2])[1];
  const porSemana = () => periodo > 14;

  function passa(i, exceto) {
    if (F.areas.size && exceto !== "areas" && !F.areas.has(i.area)) return false;
    if (F.prioridades.size && exceto !== "prioridades" && !F.prioridades.has(i.prioridade)) return false;
    if (F.status.size && exceto !== "status" && !F.status.has(i.status)) return false;
    if (F.projetos.size && exceto !== "projetos" && !F.projetos.has(i.projeto_id || "")) return false;
    if (F.pessoas.size && exceto !== "pessoas") {
      const ps = n.pessoasDe(i);
      if (!(ps.length ? ps.some((p) => F.pessoas.has(p)) : F.pessoas.has(""))) return false;
    }
    return true;
  }
  const sel = (exceto) => E.itens.filter((i) => passa(i, exceto));
  const temFiltro = () => DIMS.some((d) => F[d].size);

  function alternar(dim, valor) {
    const s = F[dim];
    if (s.has(valor)) s.delete(valor); else s.add(valor);
    desenhar();
  }
  function limparFiltros() {
    for (const d of DIMS) F[d].clear();
    desenhar();
  }

  // ------------------------------------------------------------------ cálculos
  const aberta = (i) => ABERTAS.indexOf(i.status) >= 0;
  const diaDe = (ts) => n.isoDeTs(ts) || "";
  function fechadaEm(i) {
    for (let k = i.historico.length - 1; k >= 0; k--) if (i.historico[k].status === "feita") return diaDe(i.historico[k].em);
    return i.historico.some((x) => x.status) ? "" : diaDe(i.atualizado_em);
  }
  const ultimoSinal = (i) => (i.historico.length ? diaDe(i.historico[i.historico.length - 1].em) : diaDe(i.criado_em));
  function noPeriodo(dia) {
    if (!dia) return false;
    const d = n.diasEntre(dia, n.hoje());
    return d >= 0 && d < periodo;
  }

  function contar(itens) {
    const h0 = n.hoje(), abertas = itens.filter(aberta);
    return {
      abertas: abertas.length,
      porStatus: Object.fromEntries(["aberta", "andamento", "aguardando", "feita", "descartada"]
        .map((s) => [s, itens.filter((i) => i.status === s).length])),
      atrasadas: abertas.filter(n.atrasada),
      hoje: abertas.filter(n.venceHoje),
      cobrar: abertas.filter(n.cobrancaVencida),
      urgentes: abertas.filter((i) => i.prioridade === "urgente"),
      semPrazo: abertas.filter((i) => !i.prazo),
      fechadas: itens.filter((i) => i.status === "feita" && noPeriodo(fechadaEm(i))),
      criadas: itens.filter((i) => noPeriodo(diaDe(i.criado_em))),
      paradas: abertas.filter((i) => i.status === "aguardando" && n.diasEntre(ultimoSinal(i) || h0, h0) >= 7 && !i.cobrar_em),
      esquecidas: abertas.filter((i) => i.status !== "aguardando" && n.diasEntre(ultimoSinal(i) || h0, h0) >= 14),
      erroAgente: abertas.filter((i) => ((i.agente && i.agente.ultima) || {}).status === "erro"),
    };
  }

  /* Série de criadas x concluídas. Acima de 14 dias agrupa por semana: 30 ou 90 pontos diários
     viram serra e não se lê tendência nenhuma. */
  function serie(itens) {
    const passos = [];
    if (porSemana()) {
      const sab = n.somaDias(n.hoje(), 6 - n.diaSemana(n.hoje()));
      for (let k = Math.ceil(periodo / 7) - 1; k >= 0; k--) {
        const fim = n.somaDias(sab, -k * 7);
        passos.push({ dia: n.somaDias(fim, -6), fim: fim, rot: n.ddmm(n.somaDias(fim, -6)), criadas: 0, fechadas: 0 });
      }
    } else {
      for (let k = periodo - 1; k >= 0; k--) {
        const d = n.somaDias(n.hoje(), -k);
        passos.push({ dia: d, fim: d, rot: n.ddmm(d), criadas: 0, fechadas: 0 });
      }
    }
    const achar = (dia) => {
      if (!dia) return -1;
      for (let k = 0; k < passos.length; k++) if (dia >= passos[k].dia && dia <= passos[k].fim) return k;
      return -1;
    };
    for (const i of itens) {
      const c = achar(diaDe(i.criado_em));
      if (c >= 0) passos[c].criadas++;
      if (i.status === "feita") { const f = achar(fechadaEm(i)); if (f >= 0) passos[f].fechadas++; }
    }
    return passos;
  }

  /* Realce cruzado de verdade: `total` conta o universo inteiro (a barra cinza, que não encolhe),
     `foco` conta só o que passa por TODOS os filtros (a barra colorida por cima). */
  function porDimensao(dim) {
    const mapa = new Map();
    const juntar = (chave, rotulo, i) => {
      if (!mapa.has(chave)) mapa.set(chave, { chave: chave, rotulo: rotulo, total: 0, foco: 0, atrasadas: 0 });
      const g = mapa.get(chave);
      g.total++;
      if (passa(i)) { g.foco++; if (n.atrasada(i)) g.atrasadas++; }
    };
    for (const i of E.itens) {
      if (!aberta(i)) continue;
      if (dim === "areas") juntar(i.area, i.area, i);
      else if (dim === "prioridades") juntar(i.prioridade, n.PRIO[i.prioridade].nome, i);
      else if (dim === "projetos") { if (i.projeto_id) juntar(i.projeto_id, n.nomeProjeto(i.projeto_id) || i.projeto_id, i); }
      else if (dim === "pessoas") { for (const p of n.pessoasDe(i)) juntar(p, p, i); }
    }
    return [...mapa.values()].sort((a, b) => b.foco - a.foco || b.total - a.total || a.rotulo.localeCompare(b.rotulo));
  }

  // ------------------------------------------------------------------ peças
  function cartao(opts) {
    const corpo = Array.prototype.slice.call(arguments, 1);
    return h("section", { c: "rv-card" + (opts.cls ? " " + opts.cls : "") },
      h("div", { c: "rv-cab" }, h("h2", { t: opts.titulo }),
        opts.sub ? h("span", { c: "rv-sub", t: opts.sub }) : null, opts.dir || null),
      corpo);
  }
  function legenda(itens) {
    return h("div", { c: "rv-legenda" }, itens.map((x) =>
      h("span", { c: "rv-leg" }, h("i", { c: "rv-pt c-" + x.slot, "aria-hidden": "true" }), h("span", { t: x.rotulo }))));
  }
  const vazio = (t) => h("p", { c: "rv-vazio", t: t });

  function abrir(id) {
    if (!E.porId.has(id)) return;
    location.hash = "#/quadro";
    Mesa.gaveta.abrir(id, { via: "push" });
  }
  function irParaQuadro(sinal) {
    E.filtros.sinais = sinal ? new Set([sinal]) : new Set();
    E.filtros.areas = new Set(F.areas);
    E.filtros.prioridades = new Set(F.prioridades);
    E.filtros.pessoas = new Set(F.pessoas);
    E.visao = "tudo";
    location.hash = "#/quadro";
    Mesa.emitir("filtros");
  }

  // ------------------------------------------------------------------ KPIs
  /* O número correto entra primeiro; a contagem é só enfeite por cima. Se o rAF não rodar
     (aba em segundo plano, movimento reduzido, captura automatizada), fica o número certo. */
  function contarAte(el, alvo) {
    el.textContent = String(alvo);
    if (n.movReduzido() || document.hidden) return;
    const t0 = performance.now();
    const passo = (t) => {
      const k = Math.min(1, (t - t0) / 460);
      el.textContent = String(Math.round(alvo * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }
  function faisca(valores, slot) {
    const pref = "k" + (seq++), W = 100, H = 20, max = Math.max(1, ...valores);
    const passo = valores.length > 1 ? W / (valores.length - 1) : W;
    const pts = valores.map((v, k) => [k * passo, H - 1 - (v / max) * (H - 4)]);
    const g = sv("svg", { class: "rv-faisca", viewBox: "0 0 " + W + " " + H, "aria-hidden": "true", preserveAspectRatio: "none" });
    g.append(sv("defs", {}, sv("linearGradient", { id: pref, x1: "0", y1: "0", x2: "0", y2: "1" },
      sv("stop", { offset: "0", "stop-color": "var(--rv-" + slot + ")", "stop-opacity": ".45" }),
      sv("stop", { offset: "1", "stop-color": "var(--rv-" + slot + ")", "stop-opacity": "0" }))));
    g.append(sv("path", { d: "M0," + H + " L" + pts.map((p) => p.join(",")).join(" L") + " L" + W + "," + H + " Z", fill: "url(#" + pref + ")" }));
    g.append(sv("polyline", { points: pts.map((p) => p.join(",")).join(" "), class: "rv-faisca-l", stroke: "var(--rv-" + slot + ")" }));
    return g;
  }
  function ladrilho(o) {
    const clicavel = !!(o.sinal || o.dim);
    const el = h(clicavel ? "button" : "div", {
      c: "rv-kpi t-" + (o.tom || "neutro") + (clicavel ? " clicavel" : "") + (o.ativo ? " ativo" : ""),
      type: clicavel ? "button" : null, "data-tip": o.dica || null,
      on: o.dim ? { click: () => alternar(o.dim, o.valor) } : o.sinal ? { click: () => irParaQuadro(o.sinal) } : null,
    });
    el.append(h("span", { c: "rv-kpi-top" }, ic(o.icone), h("span", { c: "rv-kpi-rot", t: o.rotulo })));
    const num = h("strong", { c: "rv-kpi-num num", t: "0" });
    el.append(h("span", { c: "rv-kpi-linha" }, num, o.sufixo ? h("span", { c: "rv-kpi-suf", t: o.sufixo }) : null));
    el.append(h("span", { c: "rv-kpi-pe", t: o.pe || "" }));
    if (o.serie) el.append(faisca(o.serie, o.slot || "ciano"));
    contarAte(num, o.n);
    return el;
  }

  // ------------------------------------------------------------------ barras (HTML: esticam na célula)
  function visualBarras(titulo, sub, dim, linhas, corSlot, aoVazio, teto) {
    if (!linhas.length) return cartao({ titulo: titulo, sub: sub }, vazio(aoVazio));
    const vis = linhas.slice(0, teto || 6);
    const max = Math.max(1, ...vis.map((l) => l.total));
    const temAtraso = vis.some((l) => l.atrasadas);
    const corpo = h("div", { c: "rv-barras" + (vis.length <= 3 ? " poucas" : "") });
    for (const l of vis) {
      const apagada = F[dim].size && !F[dim].has(l.chave);
      const slot = corSlot(l);
      const emDia = Math.max(0, l.foco - l.atrasadas);
      const fila = h("button", {
        type: "button", c: "rv-l" + (apagada ? " apagada" : "") + (F[dim].has(l.chave) ? " escolhida" : ""),
        "data-tip": l.rotulo + ": " + l.foco + (l.foco !== l.total ? " de " + l.total : "") + " em pé"
          + (l.atrasadas ? " · " + l.atrasadas + " atrasadas" : "") + " · clique para filtrar",
        on: { click: () => alternar(dim, l.chave) },
      },
        h("span", { c: "rv-l-rot", t: l.rotulo }),
        h("span", { c: "rv-l-trilho" },
          h("span", { c: "rv-l-ghost", style: "width:" + pc(l.total, max) + "%" }),
          h("span", { c: "rv-l-barra c-" + slot, style: "width:" + pc(emDia, max) + "%" }),
          l.atrasadas ? h("span", { c: "rv-l-barra c-crit atr", style: "width:" + pc(l.atrasadas, max) + "%;left:" + pc(emDia, max) + "%" }) : null),
        h("span", { c: "rv-l-num num", t: String(l.foco) }));
      corpo.append(fila);
    }
    return cartao({ titulo: titulo, sub: sub,
      dir: linhas.length > vis.length ? h("span", { c: "rv-mais", t: "+" + (linhas.length - vis.length) }) : null },
      temAtraso ? legenda([{ slot: "neutro", rotulo: "no prazo" }, { slot: "crit", rotulo: "atrasadas" }]) : null,
      corpo);
  }

  // ------------------------------------------------------------------ colunas de prazo (HTML)
  function visualCarga(itens) {
    const h0 = n.hoje(), abertas = itens.filter(aberta);
    const prazos = new Map();
    for (const i of abertas) if (i.prazo && i.prazo >= h0) prazos.set(i.prazo, (prazos.get(i.prazo) || 0) + 1);
    const cols = [{ rot: "atrás", v: abertas.filter(n.atrasada).length, slot: "crit", atrasado: true }];
    for (let k = 0; k < DIAS_CARGA; k++) {
      const d = n.somaDias(h0, k);
      cols.push({ rot: n.ddmm(d).slice(0, 5), dia: d, v: prazos.get(d) || 0, slot: k === 0 ? "ambar" : "azul",
        hoje: k === 0, fds: [0, 6].indexOf(n.diaSemana(d)) >= 0 });
    }
    const max = Math.max(1, ...cols.map((c) => c.v));
    const corpo = h("div", { c: "rv-cols" });
    for (const c of cols) {
      corpo.append(h("div", { c: "rv-col" + (c.hoje ? " hoje" : "") + (c.fds ? " fds" : "") + (c.atrasado ? " atras" : ""),
        "data-tip": c.atrasado ? c.v + " com prazo vencido"
          : c.v + " " + n.plural(c.v, "pendência", "pendências") + (c.hoje ? " vencem hoje" : " vencem em " + c.rot) },
        h("span", { c: "rv-col-n num", t: c.v ? String(c.v) : "" }),
        h("span", { c: "rv-col-trilho" }, c.v ? h("span", { c: "rv-col-barra c-" + c.slot, style: "height:" + Math.max(6, pc(c.v, max)) + "%" }) : null),
        h("span", { c: "rv-col-rot", t: c.hoje ? "hoje" : c.rot })));
    }
    return cartao({ titulo: "Prazos que vêm", sub: "próximos " + DIAS_CARGA + " dias" }, corpo);
  }

  // ------------------------------------------------------------------ rosca (SVG)
  function arcoAnel(cx, cy, re, ri, a0, a1) {
    const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const grande = a1 - a0 > Math.PI ? 1 : 0;
    const e1 = pt(re, a0), e2 = pt(re, a1), i2 = pt(ri, a1), i1 = pt(ri, a0);
    return "M" + e1 + " A" + re + "," + re + " 0 " + grande + " 1 " + e2 + " L" + i2 + " A" + ri + "," + ri + " 0 " + grande + " 0 " + i1 + " Z";
  }
  function visualRosca() {
    const pref = "d" + (seq++);
    const base = contar(sel("status"));        // o anel mostra todas as colunas, mesmo filtrando por uma
    const foco = contar(sel());
    const partes = ["aberta", "andamento", "aguardando", "feita"]
      .map((s) => ({ s: s, nome: n.STATUS_NOME[s], v: base.porStatus[s] || 0, slot: SLOT_STATUS[s] })).filter((p) => p.v);
    const tot = partes.reduce((a, b) => a + b.v, 0);
    if (!tot) return cartao({ titulo: "Composição", sub: "por coluna" }, vazio("Sem pendências no recorte."));
    const W = 230, H = 162, cx = W / 2, cy = H / 2, re = 66, ri = 43;
    const g = sv("svg", { class: "rv-svg rv-rosca", viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Composição por coluna: " + partes.map((p) => p.nome + " " + p.v).join(", ") });
    const d = sv("defs");
    for (const p of partes) {
      d.append(sv("linearGradient", { id: pref + "-" + p.slot, x1: "0", y1: "0", x2: "0", y2: "1" },
        sv("stop", { offset: "0", "stop-color": "var(--rv-" + p.slot + "-claro)" }),
        sv("stop", { offset: "1", "stop-color": "var(--rv-" + p.slot + ")" })));
    }
    d.append(sv("filter", { id: pref + "-s", x: "-30%", y: "-30%", width: "170%", height: "180%" },
      sv("feDropShadow", { dx: "0", dy: "3", stdDeviation: "3", "flood-color": "var(--rv-sombra)", "flood-opacity": "1" })));
    g.append(d);
    const vao = partes.length > 1 ? 0.045 : 0;
    let a = -Math.PI / 2;
    for (const p of partes) {            // anel de baixo: dá volume sem inclinar o círculo
      const a1 = a + (p.v / tot) * Math.PI * 2;
      g.append(sv("path", { d: arcoAnel(cx, cy + 6, re, ri, a + vao / 2, a1 - vao / 2), class: "rv-rosca-base" }));
      a = a1;
    }
    a = -Math.PI / 2;
    for (const p of partes) {
      const a1 = a + (p.v / tot) * Math.PI * 2;
      const apagada = F.status.size && !F.status.has(p.s);
      const arco = sv("path", { d: arcoAnel(cx, cy, re, ri, a + vao / 2, a1 - vao / 2),
        fill: "url(#" + pref + "-" + p.slot + ")", class: "rv-fatia" + (apagada ? " apagada" : ""),
        filter: "url(#" + pref + "-s)", tabindex: "0", role: "button",
        "data-tip": p.nome + ": " + p.v + " (" + Math.round((p.v / tot) * 100) + "%) · clique para filtrar" });
      arco.addEventListener("click", () => alternar("status", p.s));
      arco.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); alternar("status", p.s); } });
      g.append(arco);
      if (p.v / tot > 0.12) {
        const am = (a + a1) / 2, rr = (re + ri) / 2;
        g.append(sv("text", { x: cx + rr * Math.cos(am), y: cy + rr * Math.sin(am) + 4, class: "rv-fatia-rot", "text-anchor": "middle" }, txt(p.v)));
      }
      a = a1;
    }
    g.append(sv("text", { x: cx, y: cy + 2, class: "rv-rosca-num", "text-anchor": "middle" }, txt(foco.abertas)));
    g.append(sv("text", { x: cx, y: cy + 17, class: "rv-rosca-rot", "text-anchor": "middle" }, txt("em pé")));
    return cartao({ titulo: "Composição", sub: "clique numa fatia" },
      h("div", { c: "rv-svg-caixa" }, g),
      legenda(partes.map((p) => ({ slot: p.slot, rotulo: p.nome + " " + p.v }))));
  }

  // ------------------------------------------------------------------ fluxo (SVG)
  function visualFluxo(itens) {
    const pref = "f" + (seq++);
    const dias = serie(itens);
    const W = 460, H = 150, L = 26, T = 10, Rt = 22, B = 20;
    const iw = W - L - Rt, ih = H - T - B;
    let maxv = Math.max(2, ...dias.map((d) => Math.max(d.criadas, d.fechadas)));
    if (maxv % 2) maxv += 1;
    const px = dias.length > 1 ? iw / (dias.length - 1) : 0;
    const X = (k) => L + k * px, Y = (v) => T + ih - (v / maxv) * ih;
    const g = sv("svg", { class: "rv-svg", viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", role: "img",
      "aria-label": "Criadas e concluídas por " + (porSemana() ? "semana" : "dia") + " nos últimos " + periodo + " dias" });
    const d = sv("defs");
    for (const s of ["ciano", "ok"]) {
      d.append(sv("linearGradient", { id: pref + "-" + s, x1: "0", y1: "0", x2: "0", y2: "1" },
        sv("stop", { offset: "0", "stop-color": "var(--rv-" + s + ")", "stop-opacity": ".30" }),
        sv("stop", { offset: "1", "stop-color": "var(--rv-" + s + ")", "stop-opacity": "0" })));
    }
    g.append(d);
    for (let k = 0; k <= 2; k++) {
      const v = (maxv / 2) * k, y = Y(v);
      g.append(sv("line", { x1: L, x2: W - Rt, y1: y, y2: y, class: "rv-gl" }));
      g.append(sv("text", { x: L - 6, y: y + 3, class: "rv-eixo", "text-anchor": "end" }, txt(v)));
    }
    [["criadas", "ciano", null], ["fechadas", "ok", "5 4"]].forEach((s) => {
      const pts = dias.map((dd, k) => [X(k), Y(dd[s[0]])]);
      g.append(sv("path", { d: "M" + L + "," + (T + ih) + " L" + pts.map((p) => p.join(",")).join(" L") + " L" + X(dias.length - 1) + "," + (T + ih) + " Z",
        fill: "url(#" + pref + "-" + s[1] + ")" }));
      // a última semana ainda está em curso: o trecho final vai esmaecido, senão a queda natural
      // de um período incompleto se lê como "o trabalho parou"
      const cheio = porSemana() ? pts.slice(0, -1) : pts;
      g.append(sv("polyline", { points: cheio.map((p) => p.join(",")).join(" "), class: "rv-linha",
        stroke: "var(--rv-" + s[1] + ")", "stroke-dasharray": s[2] }));
      if (porSemana() && pts.length > 1) {
        g.append(sv("polyline", { points: pts.slice(-2).map((p) => p.join(",")).join(" "), class: "rv-linha parcial",
          stroke: "var(--rv-" + s[1] + ")", "stroke-dasharray": "3 3" }));
      }
      if (dias.length <= 20) pts.forEach((p, k) => {
        const parcial = porSemana() && k === pts.length - 1;
        g.append(sv("circle", { cx: p[0], cy: p[1], r: 3, class: "rv-ponto" + (parcial ? " parcial" : ""),
          fill: parcial ? "var(--rv-card)" : "var(--rv-" + s[1] + ")", stroke: parcial ? "var(--rv-" + s[1] + ")" : null }));
      });
    });
    dias.forEach((dd, k) => {
      g.append(sv("rect", { x: X(k) - px / 2, y: T, width: Math.max(5, px), height: ih, class: "rv-alvo",
        "data-tip": (porSemana() ? "semana de " + dd.rot : dd.rot) + (porSemana() && k === dias.length - 1 ? " (em curso)" : "")
          + ": " + dd.criadas + " " + n.plural(dd.criadas, "criada", "criadas") + ", " + dd.fechadas + " " + n.plural(dd.fechadas, "concluída", "concluídas") }));
    });
    const salto = Math.ceil(dias.length / 6);
    dias.forEach((dd, k) => {
      if (k % salto && k !== dias.length - 1) return;
      const ult = porSemana() && k === dias.length - 1;
      g.append(sv("text", { x: X(k), y: H - 7, class: "rv-eixo", "text-anchor": "middle" }, txt(ult ? "agora" : dd.rot)));
    });
    const tot = dias.reduce((a, dd) => ({ c: a.c + dd.criadas, f: a.f + dd.fechadas }), { c: 0, f: 0 });
    const saldo = tot.f - tot.c;
    return cartao({ titulo: "Entrou e saiu", cls: "rv-w2", sub: fmtPeriodo() + (porSemana() ? " · por semana" : " · por dia"),
      dir: h("span", { c: "rv-saldo " + (saldo >= 0 ? "bom" : "ruim"), "data-tip": "Concluídas menos criadas no período" },
        h("span", { t: (saldo > 0 ? "+" : "") + saldo })) },
      legenda([{ slot: "ciano", rotulo: "criadas " + tot.c }, { slot: "ok", rotulo: "concluídas " + tot.f }]),
      h("div", { c: "rv-svg-caixa estica" }, g));
  }

  // ------------------------------------------------------------------ mapa de calor (HTML)
  function visualCalor(itens, largo) {
    const semanas = largo ? 18 : 11;
    const fim = n.somaDias(n.hoje(), 6 - n.diaSemana(n.hoje()));
    const cel = new Map();
    for (const i of itens) for (const ev of i.historico) {
      const d = diaDe(ev.em);
      if (d) cel.set(d, (cel.get(d) || 0) + 1);
    }
    const max = Math.max(1, ...cel.values());
    const grade = h("div", { c: "rv-calor", style: "--sem:" + semanas });
    for (let d = 0; d < 7; d++) {
      grade.append(h("span", { c: "rv-calor-dia", t: d % 2 === 1 ? DSEM[d] : "" }));
      for (let s = 0; s < semanas; s++) {
        const dia = n.somaDias(fim, -((semanas - 1 - s) * 7) - (6 - d));
        if (dia > n.hoje()) { grade.append(h("i", { c: "rv-cel futuro" })); continue; }
        const v = cel.get(dia) || 0;
        grade.append(h("i", { c: "rv-cel", style: "--i:" + (v ? 0.2 + 0.8 * Math.sqrt(v / max) : 0),
          "data-tip": n.dataComSemana(dia) + ": " + v + " " + n.plural(v, "movimento", "movimentos") }));
      }
    }
    return cartao({ titulo: "Movimento", sub: "mexidas por dia", cls: largo ? "rv-w2" : "" },
      grade,
      h("div", { c: "rv-calor-leg" }, h("span", { t: "menos" }),
        [0.2, 0.45, 0.7, 1].map((i) => h("i", { c: "rv-cel", style: "--i:" + i })), h("span", { t: "mais" })));
  }

  // ------------------------------------------------------------------ alertas
  const GRUPOS = [
    { k: "atrasadas", t: "Atrasadas", tom: "crit", icone: "i-clock-filled", sinal: "atrasadas" },
    { k: "cobrar", t: "Hora de cobrar", tom: "crit", icone: "i-bell", sinal: "cobrar" },
    { k: "hoje", t: "Vencem hoje", tom: "warn", icone: "i-clock", sinal: "hoje" },
    { k: "paradas", t: "Paradas em Aguardando", tom: "warn", icone: "i-hourglass" },
    { k: "urgentes", t: "Urgentes sem prazo", tom: "warn", icone: "i-prio-urgent", so: (i) => !i.prazo },
    { k: "esquecidas", t: "Sem sinal de vida", tom: "aviso", icone: "i-history" },
    { k: "erroAgente", t: "Agente parou com erro", tom: "aviso", icone: "i-error" },
  ];
  function linhaAlerta(i) {
    const extra = [];
    if (n.atrasada(i)) extra.push(-n.diasEntre(n.hoje(), i.prazo) + " d");
    else if (i.prazo) extra.push(n.ddmm(i.prazo));
    if (i.aguardando_de) extra.push(n.nomeCurto(i.aguardando_de));
    else if (n.pessoasDe(i).length) extra.push(n.nomeCurto(n.pessoasDe(i)[0]));
    return h("li", {}, h("button", { type: "button", c: "rv-item", on: { click: () => abrir(i.id) } },
      h("i", { c: "rv-pt c-" + slotArea(i.area), "aria-hidden": "true", "data-tip": i.area }),
      h("span", { c: "rv-item-tit", "data-tip-auto": i.titulo, t: i.titulo }),
      extra.length ? h("span", { c: "rv-item-extra", t: extra.join(" · ") }) : null));
  }
  function visualAlertas(c) {
    const corpo = h("div", { c: "rv-alertas" });
    let algum = false;
    for (const gp of GRUPOS) {
      const itens = (c[gp.k] || []).filter(gp.so || (() => true));
      if (!itens.length) continue;
      algum = true;
      const ord = itens.slice().sort((x, y) => (x.prazo || "9999").localeCompare(y.prazo || "9999"));
      corpo.append(h("section", { c: "rv-alerta " + gp.tom },
        h("h3", {}, ic(gp.icone), h("span", { t: gp.t }), h("span", { c: "rv-alerta-n num", t: String(itens.length) }),
          gp.sinal ? h("button", { type: "button", c: "rv-ir", "aria-label": "Abrir no quadro com este filtro",
            "data-tip": "Abrir no quadro com este filtro", on: { click: () => irParaQuadro(gp.sinal) } }, ic("i-open")) : null),
        h("ul", {}, ord.slice(0, 5).map(linhaAlerta)),
        itens.length > 5 ? h("p", { c: "rv-resto", t: "e mais " + (itens.length - 5) }) : null));
    }
    if (!algum) {
      corpo.append(h("div", { c: "rv-tudo-certo" }, ic("i-success"), h("strong", { t: "Nada pegando fogo." }),
        h("span", { t: "Sem atraso, sem cobrança vencida e sem pendência esquecida neste recorte." })));
    }
    return cartao({ titulo: "Precisa de atenção", sub: "clique para abrir", cls: "rv-alto" }, corpo);
  }

  // ------------------------------------------------------------------ filtros
  const ROT_DIM = { areas: "Área", pessoas: "Pessoa", prioridades: "Prioridade", status: "Coluna", projetos: "Projeto" };
  function barraFiltros() {
    const b = h("div", { c: "rv-filtros" });
    const grupo = h("div", { c: "rv-periodo", role: "group", "aria-label": "Período dos gráficos de tempo" });
    grupo.append(h("span", { c: "rv-periodo-rot", t: "Período" }));
    for (const p of PERIODOS) {
      grupo.append(h("button", { type: "button", c: "rv-pivo", "aria-pressed": String(periodo === p[0]), t: p[1],
        on: { click: () => { periodo = p[0]; n.gravarPref("mesa.radar.periodo", p[0]); desenhar(); } } }));
    }
    b.append(grupo);
    const chips = h("div", { c: "rv-chips" });
    for (const dim of DIMS) {
      for (const v of F[dim]) {
        const rotulo = dim === "prioridades" ? n.PRIO[v].nome : dim === "status" ? n.STATUS_NOME[v]
          : dim === "projetos" ? (n.nomeProjeto(v) || v) : v;
        chips.append(h("button", { type: "button", c: "rv-chip" + (dim === "areas" ? " c-" + slotArea(v) : ""),
          "data-tip": "Tirar o filtro " + ROT_DIM[dim] + ": " + rotulo, on: { click: () => alternar(dim, v) } },
          h("span", { c: "rv-chip-dim", t: ROT_DIM[dim] }), h("span", { t: rotulo }), ic("i-dismiss-12")));
      }
    }
    if (temFiltro()) {
      chips.append(h("button", { type: "button", c: "rv-limpar", on: { click: limparFiltros } }, ic("i-filter-clear"), "Limpar"));
      chips.append(h("button", { type: "button", c: "rv-limpar", "data-tip": "Abrir o quadro com este recorte",
        on: { click: () => irParaQuadro("") } }, ic("i-board"), "Ver no quadro"));
    }
    b.append(chips);
    return b;
  }

  // ------------------------------------------------------------------ desenho
  function desenhar() {
    const raiz = $("#pagina");
    if (!raiz || E.pagina !== "radar") return;
    seq = 0;
    const tv = !!n.lerPref("mesa.radar.tv", false);
    document.body.classList.toggle("radar-tv", tv);
    limpar(raiz);
    const principal = h("div", { c: "pagina-principal rv" });
    raiz.append(principal);
    if (!E.carregado) { principal.append(h("p", { c: "rv-vazio", style: "padding:48px" }, n.spinner(), " Carregando…")); return; }

    const itens = sel();
    const c = contar(itens);
    const cTot = contar(E.itens);
    const dias = serie(itens);

    principal.append(h("header", { c: "rv-topo" },
      h("div", { c: "rv-tit" }, h("h1", { t: "Radar" }),
        h("span", { c: "rv-dia", t: n.dataComSemana(n.hoje()) }),
        temFiltro() ? h("span", { c: "rv-recorte", t: itens.length + " de " + E.itens.length + " no recorte" }) : null),
      barraFiltros(),
      h("div", { c: "rv-acoes" },
        h("span", { c: "rv-vivo", "data-tip": "Acompanha o quadro em tempo real" }, h("i", { c: "rv-pulso" }), h("span", { t: "ao vivo" })),
        h("button", { type: "button", c: "rv-pivo", "aria-pressed": String(tv), t: "Modo TV",
          "data-tip": "Esconde a navegação e aumenta a letra",
          on: { click: () => { n.gravarPref("mesa.radar.tv", !tv); desenhar(); } } }),
        h("button", { type: "button", c: "btn-icone", "aria-label": "Atualizar agora", "data-tip": "Atualizar agora",
          on: { click: () => n.recarregar({ barra: true }) } }, ic("i-refresh")))));

    const criticos = c.atrasadas.length + c.cobrar.length;
    if (criticos) {
      const partes = [];
      if (c.atrasadas.length) partes.push(c.atrasadas.length + " " + n.plural(c.atrasadas.length, "atrasada", "atrasadas"));
      if (c.cobrar.length) partes.push(c.cobrar.length + " para cobrar");
      principal.append(h("button", { type: "button", c: "rv-faixa",
        on: { click: () => irParaQuadro(c.atrasadas.length ? "atrasadas" : "cobrar") } },
        h("span", { c: "rv-faixa-ic" }, ic("i-error")), h("strong", { t: partes.join(" e ") }),
        h("span", { t: "precisa de você hoje" }), ic("i-chevron-right")));
    }

    principal.append(h("div", { c: "rv-kpis" },
      ladrilho({ rotulo: "Em pé", n: c.abertas, icone: "i-board", tom: "info", slot: "ciano",
        pe: c.porStatus.aberta + " a fazer · " + c.porStatus.andamento + " fazendo · " + c.porStatus.aguardando + " aguardando" }),
      ladrilho({ rotulo: "Atrasadas", n: c.atrasadas.length, icone: "i-clock-filled",
        tom: c.atrasadas.length ? "crit" : "neutro", sinal: "atrasadas", dica: "Abrir o quadro filtrado por atrasadas",
        pe: temFiltro() ? cTot.atrasadas.length + " no quadro inteiro" : "o prazo já passou" }),
      ladrilho({ rotulo: "Para cobrar", n: c.cobrar.length, icone: "i-bell",
        tom: c.cobrar.length ? "warn" : "neutro", sinal: "cobrar", pe: "a data de cobrança chegou" }),
      ladrilho({ rotulo: "Urgentes", n: c.urgentes.length, icone: "i-prio-urgent",
        tom: c.urgentes.length ? "warn" : "neutro", dim: "prioridades", valor: "urgente",
        ativo: F.prioridades.has("urgente"), dica: "Clique para filtrar o painel por urgentes",
        pe: c.semPrazo.length + " em pé sem prazo" }),
      ladrilho({ rotulo: "Concluídas", n: c.fechadas.length, icone: "i-status-done", tom: "ok", slot: "ok",
        serie: dias.map((d) => d.fechadas), sufixo: "em " + fmtPeriodo(), pe: c.criadas.length + " entraram no período" }),
      ladrilho({ rotulo: "Vencem hoje", n: c.hoje.length, icone: "i-clock",
        tom: c.hoje.length ? "warn" : "neutro", sinal: "hoje", pe: "entregar ainda hoje" })));

    const grade = h("div", { c: "rv-grade" });
    principal.append(grade);
    const proj = porDimensao("projetos");
    grade.append(visualAlertas(c));
    grade.append(visualRosca());
    grade.append(visualBarras("Em pé por área", "clique para filtrar", "areas", porDimensao("areas"),
      (l) => slotArea(l.chave), "Nada em pé neste recorte."));
    grade.append(visualCarga(itens));
    grade.append(visualFluxo(itens));
    grade.append(visualBarras("Por prioridade", "clique para filtrar", "prioridades", porDimensao("prioridades"),
      (l) => SLOT_PRIO[l.chave] || "ciano", "Sem prioridades neste recorte.", 3));
    grade.append(visualBarras("Quem está esperando", "quem pediu", "pessoas", porDimensao("pessoas"),
      () => "rosa", "Ninguém esperando neste recorte."));
    if (proj.length) grade.append(visualBarras("Por projeto", "ligado pelo cérebro", "projetos", proj, () => "violeta", "", 5));
    grade.append(visualCalor(E.itens, !proj.length));
  }

  // ------------------------------------------------------------------ ciclo de vida
  function parar() { if (timer) { clearInterval(timer); timer = 0; } }
  R.mostrar = () => {
    montado = true;
    desenhar();
    parar();
    timer = setInterval(() => { if (E.pagina === "radar" && !document.hidden) n.recarregar(); }, 30000);
    requestAnimationFrame(() => { const t = $("#pagina h1"); if (t) { t.setAttribute("tabindex", "-1"); t.focus(); } });
  };
  R.sair = () => { montado = false; parar(); document.body.classList.remove("radar-tv"); };

  Mesa.ouvir("dados", () => { if (E.pagina === "radar" && montado) desenhar(); });
  Mesa.ouvir("projetos", () => { if (E.pagina === "radar" && montado) desenhar(); });
  Mesa.ouvir("dia", () => { if (E.pagina === "radar" && montado) desenhar(); });
})();
