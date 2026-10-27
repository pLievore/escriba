/* Escriba: resumo da daily.
   Página #/daily: o que foi fechado desde a daily anterior (segunda, quarta e sexta), o que está
   em curso e o que está travado — em letra grande, para ele ler falando, e com um botão de copiar.
   Os fatos vêm prontos do servidor (GET /api/daily): abrir é instantâneo e não chama modelo nenhum. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, $, limpar } = n;
  const D = (Mesa.daily = {});

  const JANELAS = [["", "Desde a última daily"], ["hoje", "Só hoje"], ["7d", "Últimos 7 dias"]];
  const BLOCOS = [
    { k: "feitas", t: "Fechei", icone: "i-status-done", cor: "ok" },
    { k: "andamento", t: "Sigo em", icone: "i-status-doing", pessoa: true, prazo: true },
    { k: "mexidas", t: "Mexi, sem fechar", icone: "i-edit", pessoa: true },
    { k: "aguardando", t: "Esperando resposta", icone: "i-status-waiting", pessoa: true },
    { k: "atrasadas", t: "Atrasadas", icone: "i-clock-filled", cor: "alerta", prazo: true },
    { k: "vencem_hoje", t: "Vencem hoje", icone: "i-clock", prazo: true },
    { k: "novas", t: "Entrou no período", icone: "i-plus", pessoa: true },
  ];
  let estado = { dados: null, carregando: false, erro: null, desde: "" };

  D.carregar = async (desde) => {
    estado.desde = desde != null ? desde : estado.desde;
    estado.carregando = true;
    estado.erro = null;
    desenhar();
    try {
      estado.dados = await n.api("GET", `/api/daily${estado.desde ? `?desde=${encodeURIComponent(estado.desde)}` : ""}`, null, { tempo: 15000 });
    } catch (e) {
      estado.erro = e;
    }
    estado.carregando = false;
    desenhar();
  };

  function linha(i, bloco) {
    const extra = [];
    if (bloco.pessoa && i.pessoa) {
      const ps = n.pessoasDe(i);
      if (ps.length) extra.push(n.nomeCurto(ps[0]) + (ps.length > 1 ? ` +${ps.length - 1}` : ""));
    }
    if (bloco.prazo && i.prazo) extra.push(`prazo ${n.ddmm(i.prazo)}`);
    const el = h("li", { c: "daily-item" },
      h("button", { type: "button", c: "daily-link", on: { click: () => { location.hash = "#/quadro"; Mesa.gaveta.abrir(i.id, { via: "push" }); } } },
        h("span", { c: "card-num", t: n.ref(i.id) || "#" }),
        h("span", { c: "t", t: i.titulo }),
        extra.length ? h("span", { c: "daily-extra", t: extra.join(" · ") }) : null));
    if ((i.notas || []).length) el.append(h("div", { c: "daily-nota", t: i.notas[i.notas.length - 1] }));
    return el;
  }

  function desenhar() {
    const raiz = $("#pagina");
    if (!raiz || E.pagina !== "daily") return;
    limpar(raiz);
    // .pagina e um flex row (a gaveta divide espaco com ela): o conteudo vai dentro de .pagina-principal
    const principal = h("div", { c: "pagina-principal" });
    raiz.append(principal);
    const d = estado.dados;
    const cab = h("div", { c: "pag-cab" },
      h("h1", {}, "Daily", d ? h("span", { c: "num", t: d.janela.hoje }) : null));
    const dir = h("span", { c: "dir" });
    for (const [v, rot] of JANELAS) {
      dir.append(h("button", { type: "button", c: "pivo", "aria-current": String(estado.desde === v), t: rot, on: { click: () => D.carregar(v) } }));
    }
    dir.append(h("button", { type: "button", c: "btn btn-28", disabled: !d || null, on: { click: () => n.copiar(d.texto, "Resumo copiado.") } }, ic("i-copy"), "Copiar"),
      h("button", { type: "button", c: "btn-icone", "aria-label": "Atualizar", "data-tip": "Atualizar", on: { click: () => D.carregar() } }, ic("i-refresh")));
    cab.append(dir);
    principal.append(cab);

    if (estado.erro) {
      principal.append(h("div", { c: "estado-erro" }, ic("i-error"), h("p", { t: `Não consegui montar o resumo: ${estado.erro.message}` }),
        h("button", { type: "button", c: "btn btn-28", t: "Tentar de novo", on: { click: () => D.carregar() } })));
      return;
    }
    if (!d) {
      principal.append(h("p", { c: "vazio-texto", style: "padding:24px 16px" }, estado.carregando ? n.spinner() : null, estado.carregando ? " Montando o resumo…" : "Sem resumo."));
      return;
    }
    const corpo = h("div", { c: "daily" + (estado.carregando ? " carregando" : "") });
    corpo.append(h("p", { c: "daily-janela" }, ic("i-history"), h("span", { t: d.janela.rotulo }),
      d.janela.hoje_e_dia ? h("span", { c: "tag tag-peq", t: "hoje tem daily" }) : null));
    let algum = false;
    for (const b of BLOCOS) {
      const itens = d[b.k] || [];
      if (!itens.length) continue;
      algum = true;
      corpo.append(h("section", { c: "daily-bloco" + (b.cor ? " " + b.cor : "") },
        h("h2", {}, ic(b.icone), b.t, h("span", { c: "num", t: String(d.contagens[b.k]) })),
        h("ul", {}, itens.map((i) => linha(i, b)))));
    }
    if (!algum) corpo.append(h("p", { c: "vazio-texto", t: "Nada se moveu nesse período." }));
    corpo.append(h("details", { c: "daily-texto" },
      h("summary", { t: "O texto para falar (é isto que o Copiar leva)" }),
      h("pre", { t: d.texto })));
    principal.append(corpo);
  }

  D.mostrar = () => {
    desenhar();
    const velho = estado.dados && Date.now() - (estado._em || 0) > 60000;
    if (!estado.dados || velho) { estado._em = Date.now(); D.carregar(); }
    requestAnimationFrame(() => { const t = $("#pagina h1"); if (t) { t.setAttribute("tabindex", "-1"); t.focus(); } });
  };
  // o quadro mudou (fechou uma pendência, leitura do Teams): o resumo da tela envelheceu
  Mesa.ouvir("dados", () => { if (E.pagina === "daily") { estado._em = Date.now(); D.carregar(); } });
})();
