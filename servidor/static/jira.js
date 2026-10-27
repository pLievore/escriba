/* Escriba: criar a tarefa no Jira da empresa.
   É a única parte do painel que escreve fora desta máquina, então o caminho é sempre o mesmo:
   clique → prévia do que vai ser criado (o servidor responde sem criar nada) → confirmação →
   criação. Nunca em lote, nunca sozinho. Depois a pendência mostra a chave como link. */
(function () {
  "use strict";
  const Mesa = window.Mesa, n = Mesa.n, E = Mesa.estado;
  const { h, ic, limpar } = n;
  const J = (Mesa.jira = {});

  let estado = null, carregando = null;
  const criando = new Set();

  J.disponivel = () => !!(E.recursos && E.recursos.jira);
  J.estado = () => estado;

  /* O estado (conta, sprint ativa e épicos) é buscado uma vez e reaproveitado: a sprint muda
     toda semana, então vale no máximo 10 min. */
  J.carregar = (forcar) => {
    if (carregando) return carregando;
    if (estado && !forcar && Date.now() - estado._em < 600000) return Promise.resolve(estado);
    carregando = n.api("GET", "/api/jira", null, { tempo: 25000 })
      .then((r) => { estado = Object.assign(r, { _em: Date.now() }); return estado; })
      .catch((e) => { estado = { configurado: false, erro: e.message, _em: Date.now() }; return estado; })
      .finally(() => { carregando = null; });
    return carregando;
  };

  function etiqueta(item) {
    const j = item.jira || {};
    if (!j.chave) return null;
    return h("a", { c: "jira-chave", href: j.url || "#", target: "_blank", rel: "noopener noreferrer",
      "data-tip": `${j.chave}${j.epico ? ` · épico ${j.epico}` : ""}${j.sprint ? ` · ${j.sprint}` : ""}` },
      ic("i-jira"), h("span", { t: j.chave }));
  }
  J.etiqueta = etiqueta;

  /* A linha "Jira" da gaveta: ou o link da issue, ou o botão que começa o fluxo. */
  J.campo = (item) => {
    const caixa = h("div", { c: "jira-campo" });
    const j = item.jira || {};
    if (j.chave) {
      caixa.append(etiqueta(item), h("span", { c: "jira-meta", t: [j.epico, j.sprint].filter(Boolean).join(" · ") }));
      return caixa;
    }
    const b = h("button", { type: "button", c: "campo-fantasma", disabled: criando.has(item.id) || !n.podeEscrever() || null,
      "aria-label": "Criar esta pendência como tarefa no Jira" },
      criando.has(item.id) ? n.spinner(true) : ic("i-jira"),
      h("span", { t: criando.has(item.id) ? "Criando…" : "Criar no Jira" }));
    b.addEventListener("click", () => J.criar(item, b));
    caixa.append(b);
    return caixa;
  };

  function linhaPrevia(rotulo, valor) {
    return h("div", { c: "jira-previa-linha" }, h("span", { c: "r", t: rotulo }), h("span", { c: "v", t: valor || "—" }));
  }

  /* Prévia + confirmação. O servidor só cria quando vem "confirmar": o primeiro pedido é só a conta
     do que iria, e é isso que a caixa mostra. */
  J.criar = async (item, ancora) => {
    if (!n.podeEscrever()) return n.semConexao();
    if (criando.has(item.id)) return;
    criando.add(item.id);
    Mesa.emitir("jira", { id: item.id });
    let previa;
    try {
      previa = await n.api("POST", n.rotaItem(item.id, "/jira"), {}, { tempo: 30000 });
    } catch (e) {
      criando.delete(item.id);
      Mesa.emitir("jira", { id: item.id });
      n.toast({ texto: `Não consegui preparar: ${e.message}`, tipo: "erro" });
      return;
    }
    criando.delete(item.id);
    Mesa.emitir("jira", { id: item.id });
    if (previa.ja_existe) {
      n.toast({ texto: `Essa pendência já é ${previa.ja_existe} no Jira.`, tipo: "info" });
      return;
    }
    const caixa = h("div", { c: "jira-previa" },
      linhaPrevia("Projeto", `${previa.projeto} · ${previa.tipo}`),
      linhaPrevia("Resumo", previa.resumo),
      linhaPrevia("Épico", previa.epico),
      linhaPrevia("Sprint", previa.sprint ? previa.sprint.nome : "nenhuma sprint ativa no quadro"),
      linhaPrevia("Responsável", previa.responsavel),
      previa.prazo ? linhaPrevia("Data limite", n.ddmm(previa.prazo)) : null);
    const onde = ancora && ancora.closest(".gaveta-corpo, .g-campos");
    const ok = await n.confirmar({
      depois: onde || ancora, foco: ancora, extra: caixa, rotuloAcao: "Criar no Jira",
      mensagem: "Isto vai criar a tarefa no Jira da empresa, com você como responsável:",
    });
    if (!ok) return;
    criando.add(item.id);
    Mesa.emitir("jira", { id: item.id });
    try {
      const r = await n.api("POST", n.rotaItem(item.id, "/jira"), { confirmar: true }, { tempo: 45000 });
      await n.recarregar();
      n.anunciar(`Criada no Jira como ${r.chave}.`);
      n.toast({ texto: `${r.chave} criada no Jira${r.sprint ? `, na ${r.sprint.nome}` : ""}.`, tipo: "ok", duracao: 8000,
        acoes: [{ rotulo: "Abrir no Jira", fn: () => window.open(r.url, "_blank", "noopener") }] });
    } catch (e) {
      n.toast({ texto: `O Jira recusou: ${e.message}`, tipo: "erro", duracao: 0 });
    } finally {
      criando.delete(item.id);
      Mesa.emitir("jira", { id: item.id });
    }
  };

  Mesa.ouvir("status", () => { if (J.disponivel() && !estado && !carregando) J.carregar(); });
})();
