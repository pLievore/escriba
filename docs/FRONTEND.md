# Escriba: frontend

Painel servido por `servidor/app.py` a partir de `servidor/static/`. Sem build, biblioteca, CDN ou fonte da web.
Contrato: `docs/API.md` (vale ele quando este documento divergir).

O servidor injeta na página, na hora de servir, o config da instância (`window.ESCRIBA`: pasta, áreas,
nome de quem usa) no marcador `<!--escriba:config-->`, e os scripts de extensão local no marcador
`<!--escriba:extensoes-->`. Por isso nada disso está escrito nos arquivos de `static/`.

## Arquivos (ordem de carga)

| Arquivo | Papel |
|---|---|
| `index.html` | Estrutura, sprite de ícones SVG, regiões vivas. Carrega `tema.js` no `<head>` e os módulos no fim do `<body>`. |
| `tema.js` | Grava `data-theme` antes do CSS (Sistema · Claro · Escuro em `mesa.tema`). |
| `app.css` | Tokens claro/escuro (um bloco escuro), componentes, estágios da barra por `@container`, celular, movimento reduzido, alto contraste. |
| `nucleo.js` | `Mesa.estado`, eventos (`Mesa.ouvir`/`Mesa.emitir`), `h()` (DOM só por nós de texto), datas no fuso de São Paulo, `api()` com `X-Mesa` + JSON em toda escrita, pilha de desfazer, toasts, menus, popovers, seletor de prazo, confirmação embutida, tooltip, saúde do servidor e banner. |
| `quadro.js` | Barra de ferramentas, colunas e raias (área ou projeto), cartões renderizados por chave, arrastar e soltar (Pointer Events), teclado, seleção em lote, compositor, visão Lista, CSV. |
| `gaveta.js` | Gaveta dividida/sobreposta/tela cheia, cabeçalho editável, abas Contexto e Histórico, Resumo de hoje. |
| `agente.js` | Execuções do agente (início, polling a cada 1,5 s, cancelar), aba Agente com as pastas que ele lê, o que as extensões locais acrescentam (`Mesa.agente.registrarExtensao`), resultado, entregas em subpasta, "Abrir e refazer" quando a leitura foi negada e a cópia da entrega para o projeto; renderizador de markdown próprio (`Mesa.md`). |
| `teams.js` | Botão "Atualizar do Teams" (barra de ferramentas e rodapé): dispara a leitura, acompanha as cinco etapas, mostra cada mudança com Desfazer e o que ficou em dúvida. |
| `jira.js` | Linha "Jira" da gaveta: o botão que cria a tarefa no Jira (prévia → confirmação → criação, nunca em lote) e a etiqueta `ABC-123` com link, que o `quadro.js` também mostra no cartão. |
| `radar.js` | Página `#/radar`: a tela de acompanhamento, para ficar aberta num monitor. Seis KPIs, faixa de crítico, nove visuais em grade 4×3 e filtro cruzado. Calcula tudo de `Mesa.estado.itens`; não tem rota própria. |
| `daily.js` | Página `#/daily`: o resumo da daily em letra grande, com seletor de janela (última daily / hoje / 7 dias), Copiar e o texto falado. Os fatos vêm prontos de `GET /api/daily`. |
| `assistente.js` | Paleta Ctrl+K: busca local com prefixos `> # @ + ?`, comandos, pedido ao assistente com espera honesta e Desfazer por mudança. |
| `projetos.js` | Páginas Projetos (lista, detalhe, mapeamento por PATCH), Arquivo e Configurações. |
| `app.js` | Roteamento por hash, atalhos globais, barra de status, diálogo de atalhos, inicialização e polling. |

## Como o código se organiza

- Tudo pendura no objeto global `Mesa` (`Mesa.n` utilidades, `Mesa.quadro`, `Mesa.gaveta`, `Mesa.agente`, `Mesa.paleta`, `Mesa.paginas`, `Mesa.app`). Os módulos conversam por eventos: `dados`, `filtros`, `gaveta`, `agente`, `assistente`, `servidor`, `sync`, `status`, `dia`, `url`, `pagina`.
- Toda resposta de escrita traz `dados` completos: `Mesa.n.aplicarDados()` troca o estado e emite `dados`. O polling (`GET /api/pendencias` a cada 10 s com a aba visível, `GET /api/status` a cada 15/30 s) só redesenha quando `versao` muda e pisca o que mudou fora do painel.
- O quadro desenha uma vez por quadro (rAF, com temporizador de reserva) e reaproveita os elementos dos cartões; o desenho espera enquanto um cartão está levantado ou sendo arrastado. A gaveta não redesenha enquanto há campo em edição (mostra "Atualizada … agora" no topo).
- Número `#n`: calculado no navegador pela ordem de `criado_em` (o servidor não tem `numero`). Na paleta, `#n` digitado vai ao assistente com a referência ao id.
- Estado na URL: `#/quadro?visao=&area=&pessoa=&prio=&sinal=&q=&raias=&p=<n>`, `#/lista`, `#/radar`, `#/daily`, `#/projetos/<id>`, `#/arquivo`, `#/config`. Abrir uma pendência usa `pushState`; a gaveta seguindo o foco usa `replaceState`.
- Preferências em `localStorage`, sempre em `try/catch`: `mesa.tema`, `mesa.visao`, `mesa.modo`, `mesa.raias`, `mesa.densidade`, `mesa.painel.*`, `mesa.colunas.*`, `mesa.raias.*`, `mesa.secoes.recolhidas`, `mesa.rascunho`, `mesa.pedidos.recentes`, `mesa.visoes`, `mesa.entregas.vistas`, `mesa.execucoes.ativas`, `mesa.atalhos`, `mesa.gaveta.modo`, `mesa.feitas.dias`, `mesa.limite.andamento`, `mesa.radar.tv`.
- Teams: o esqueleto de `Mesa.teams` nasce em `nucleo.js` e `teams.js` o substitui quando o servidor
  oferece `recursos.teams`. O botão `#fer-teams` é desenhado pelo `quadro.js` (grupo da direita) e o
  `#st-teams` pelo `app.js` (rodapé); os dois chamam `Mesa.teams.painel(ancora)`, e o `teams.js` é quem
  muda o estado deles. Como o rodapé se redesenha a cada evento, o painel guarda o **id** da âncora e
  procura o elemento atual na hora de posicionar. O feed ao vivo (novidades sem clique) continua sem
  servidor: a barra de status e o Resumo de hoje só desenham algo se `Mesa.teams.novidades` encher.

## Alcance do agente (21/10/2026)

- A aba Agente diz, antes de rodar, em que pasta ele trabalha e quais pastas ele **lê além dela**
  ("Lê também N pastas"), tanto na linha de permissão quanto na confirmação de Executar. As pastas
  vêm de `ctx.pastas` (`GET /contexto`) antes da execução e de `ex.pastas` depois dela.
- Entrega com subpasta: a lista mostra `rotulo` (`src/scenes/M01.jsx`) e usa `nome` (que inclui o id
  da execução) para o link e para o caminho no disco. `urlEntrega` codifica pedaço por pedaço.
- "Leitura negada" só aparece quando o CLI recusou um caminho (`ex.pastas_negadas`): o botão
  "Abrir e refazer" repete a execução com o projeto daquela pasta aberto.
- "Copiar para a pasta do projeto" chama `POST /api/entregas/<id>/copiar` duas vezes: a primeira é
  a prévia (nada é gravado) que alimenta a confirmação, a segunda grava. Sem projeto ligado, um menu
  pergunta o destino a partir das sugestões do cérebro — nunca se adivinha onde escrever.
- A confirmação de Executar leva um campo de **observação para aquela execução** (`n.confirmar` ganhou
  a opção `extra`, que aceita um elemento entre a mensagem e os botões; Ctrl+Enter confirma). O texto
  vai como `instrucao` e fica guardado para a próxima. Enquanto a confirmação está aberta,
  `Mesa.agente.editandoAba()` devolve true e a aba não se redesenha — sem isso o polling apagaria a
  caixa e o que ele digitou.

## Testado em 21/10/2026

Leitura do Teams: `node --check`, servidor de teste na porta 8799 e um roteiro temporário
(`servidor/static/_roteiro.html`, já apagado) com 31 verificações em Edge sem janela, a 1536×800 e
1280×620: botão na barra e no rodapé, painel parado, as cinco etapas ao vivo com a rede trocada por
respostas de mentira, pílula do rodapé, resumo com as contagens, as mudanças com Desfazer, dúvidas e
avisos, fechar clicando fora, reabrir pelo rodapé, o painel não pular de lugar quando o rodapé se
redesenha, título de pendência entrando como texto e nenhum erro de console. Nenhuma escrita chegou
ao servidor. A esteira do servidor foi testada à parte (`teams.py --simular`, 141 mensagens em 16
chats) e a gravação com um `pendencias.json` de mentira, inclusive a recusa de reabrir o que foi
fechado no painel e o mascaramento de segredo no contexto.

`node --check` em todos os `.js`. Servidor de teste na porta 8799 com Edge sem janela: carga sem erro de console, capturas a 1536×730, 1280×620 e 400 px, temas claro e escuro, e um roteiro temporário (já apagado) com 52 verificações: paleta, gaveta e abas, popovers, filtros, compositor, menu de contexto, pegar e soltar pelo teclado, Shift+2 e arrastar (com a escrita recusada no próprio navegador, para conferir a reversão), lista, raias, Projetos, Arquivo, Configurações, link `?p=` e título com HTML exibido como texto. Nenhuma escrita chegou ao servidor.

## Cobrança, conflito e Radar (27/10/2026)

- **Cobrança.** `aguardando_de` e `cobrar_em` entram na gaveta como duas linhas de propriedade, que
  só aparecem quando a pendência está em Aguardando ou um dos campos já tem valor — o painel não
  cresce para quem não usa. `n.cobrancaInfo(item, modo)` devolve o chip nos mesmos moldes de
  `prazoInfo`, e `chipCartao` dá **precedência à cobrança vencida sobre o prazo**: é o que se perde
  se não aparecer. Ao soltar (ou mover pelo menu/teclado) um cartão em Aguardando,
  `Q.perguntarAguardando` abre o popover com nome e data sugerida; "Agora não" fecha sem gravar.
  Novo sinal "Cobrar" na barra, ao lado de Atrasadas.
- **Conflito.** `n.mudar(id, campos, { base })` manda `se_atualizado_em`. No 409 o painel aplica os
  dados que vieram na resposta, mostra o que mudou e oferece "Ver o que mudou" (abre o Histórico) e
  "Aplicar mesmo assim" (repete sem o retrato). `base` é o `atualizado_em` de **quando a edição
  começou**, não o do estado atual: o polling atualiza o estado por baixo da gaveta enquanto ele
  digita, e usar o valor atual não pegaria conflito nenhum.
- **Radar.** Página só de leitura, feita para **caber numa tela** (1080p, sem rolagem) — foi o
  requisito que mudou o desenho todo. A página é uma grade de altura fixa (`grid-template-rows:
  auto auto auto minmax(0,1fr)`) e os visuais ficam numa grade 4×3 de `minmax(0,1fr)`: **quem manda
  no tamanho de cada visual é a célula, não o conteúdo**. É isso que mantém os cartões alinhados e
  sem vãos. Por isso as barras, as colunas de prazo e o mapa de calor são **HTML**, que estica para
  preencher a célula; sobra para o SVG só o que tem proporção própria (a rosca e a linha do fluxo).
  O cartão de alertas ocupa a coluna 1 inteira (`grid-row:1/4`) e rola por dentro.
- **Filtro cruzado.** Clicar numa marca liga um filtro em `F[dimensão]`; `passa(item, exceto)`
  aplica todos menos o da própria dimensão, e cada visual desenha o **total em cinza atrás do
  recorte colorido** — a categoria não clicada esmaece, não some. Os chips em cima dizem o que está
  filtrando, e "Ver no quadro" leva o recorte para o kanban. É por causa disso que a página calcula
  tudo no navegador: uma ida ao servidor por clique não serve, e duas implementações do mesmo
  cálculo divergiriam. O `GET /api/radar` e o `servidor/radar.py` existiram e foram removidos.
- **Volume sem mentira.** Barras e colunas têm gradiente, brilho no topo e sombra projetada, mas
  nenhuma perspectiva ou rotação: o valor é sempre a face frontal a partir de uma base comum. A
  rosca é um círculo de verdade com um anel deslocado embaixo fazendo a espessura — inclinar viraria
  elipse e o ângulo deixaria de ser proporcional. Toda marca é rotulada: com 8 áreas nenhuma paleta
  é segura para daltonismo em todos os pares, então o nome vem junto e a cor é enfeite. O trecho
  atrasado de cada barra tem textura além da cor vermelha.
- **Cuidados.** `contarAte` escreve o número final antes de animar: sem isso, aba em segundo plano
  ou `rAF` represado deixava o KPI em 0. A série do fluxo agrupa por semana acima de 14 dias (30 ou
  90 pontos diários viram serra) e o último trecho vai esmaecido, porque a semana corrente está em
  curso e a queda natural dela se lia como "o trabalho parou".

## Ficou para depois

- Recursos que o servidor ainda não tem, escondidos até existirem: feed do Teams ao vivo (novidades e sugestões sem clique; a leitura por clique já existe), cancelar pedido do assistente, propostas/opções/citadas, visões no servidor (ficam no `localStorage`), `origem_trecho`/link do Teams, etapas da execução, "Abrir no VS Code na linha", sugestões de projetos, verificar pasta, criar/remover projeto, excluir de vez.
- Animações FLIP dos vizinhos no arraste e o fantasma voando até o vão (o cartão aparece direto no lugar).
- Na Lista, navegação célula a célula (→ para entrar nas células) e F2 no lugar; hoje F2 e duplo clique editam o título pela gaveta.
- No Radar: recorte por período (hoje tudo é "agora" e 14 dias fixos) e um gráfico por projeto.
- Conferência visual a 125% e 150% numa tela real e com leitor de tela (NVDA) — os testes foram em Edge sem janela.
