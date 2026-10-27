# Escriba: contrato da API local

Servidor: `servidor/app.py`, em `http://127.0.0.1:8765`. Só aceita `Host` 127.0.0.1/localhost.
Toda requisição que muda algo (POST, PATCH, DELETE) precisa dos cabeçalhos
`Content-Type: application/json` e `X-Mesa: 1`, senão volta 403.
Erros: status 4xx/5xx com corpo `{"erro": "mensagem em português para mostrar ao usuário"}`.
409 = o assistente ainda está respondendo o pedido anterior. 502 = falha do Claude Code.

Arquivos estáticos: `GET /` serve `servidor/static/index.html`; `GET /static/<arquivo>` serve qualquer
arquivo de `servidor/static/` (css, js, svg). Nada é carregado da internet (CSP `default-src 'self'`,
estilos e scripts inline permitidos, `img-src 'self' data:`).

## Pendência

```json
{
  "id": "relatorio-vendas-ana",
  "titulo": "Mandar o relatório de vendas no padrão da Ana",
  "pessoa": "Ana Souza",
  "area": "Comercial",
  "projeto_id": "relatorios-comerciais",
  "prioridade": "urgente",
  "status": "aberta",
  "ordem": 10,
  "prazo": "2026-10-21",
  "aguardando_de": "Bruno Lima",
  "cobrar_em": "2026-10-30",
  "contexto": "texto livre: o que foi pedido, por quem, situação",
  "origem": "Chat com Ana Souza",
  "pedido_em": "2026-10-19",
  "historico": [{"em": "2026-10-20T19:45:00Z", "texto": "Marcada como feita", "origem": "painel"}],
  "criado_em": "...", "atualizado_em": "...", "atualizado_por": "painel | assistente | claude-code | mcp | agente",
  "ligacoes": {
    "arquivos": [{"caminho": "C:\\...\\LEIA-ME.md", "motivo": "por que ajuda"}],
    "notas": ["regras-do-relatorio-de-vendas"],
    "agente": "resolve_sozinho | prepara_rascunho | so_humano | ''",
    "como_ajuda": "1-2 frases sobre o que o agente consegue fazer"
  },
  "agente": {
    "total": 2,
    "ultima": {"id": "e-...", "modo": "briefing", "status": "concluida", "inicio": "...", "fim": "...",
               "resumo": "1-2 frases", "custo_usd": 0.21, "duracao_ms": 48000,
               "entregas": [{"nome": "resposta-ana.md", "descricao": "..."}]}
  }
}
```

- `status`: `aberta` (coluna **A fazer**), `andamento` (**Em andamento**), `aguardando` (**Aguardando outros**),
  `feita` (**Concluído**), `descartada` (arquivo, fora do quadro).
- `prioridade`: `urgente` | `semana` (rótulo "Esta semana") | `acompanhar`.
- `area`: uma das áreas de `config.local.json` (padrão: `Produto`, `Operações`, `Comercial`, `Financeiro`,
  `Marketing`, `Dados`, `Tecnologia`, `Outros`); a última é a de sobra, para o que não se encaixa.
- `ordem`: número; menor vem primeiro dentro da coluna. Empate: prazo, depois `pedido_em`.
- `projeto_id`: id de um projeto do cérebro (ver Projetos) ou `""`.
- `aguardando_de`: quem está com a bola (texto livre, até 120). `cobrar_em`: AAAA-MM-DD, a data de
  puxar de volta. São independentes do `prazo` — o prazo é a entrega a quem pediu; a cobrança é o
  lembrete dele. Valem em qualquer status aberto, mas o painel só mostra os dois campos na gaveta
  quando a pendência está em **Aguardando outros** ou um deles já tem valor.
- Campos opcionais podem faltar em pendências antigas: trate ausência como vazio.

## Pendências

| Método e rota | Corpo | Resposta |
|---|---|---|
| `GET /api/pendencias` | | `{"versao": 12, "meta": {"ultima_leitura_teams": "2026-10-20T16:44:00-03:00", ...}, "pendencias": [...]}` |
| `POST /api/pendencias` | `{"campos": {"titulo": "...", "pessoa", "area", "projeto_id", "prioridade", "prazo", "contexto", "status"}}` | `{"mudanca": {"tipo": "criou", "id", "titulo"}, "dados": <GET>}` |
| `PATCH /api/pendencias/<id>` | `{"campos": {...só o que muda...}, "nota": "texto opcional", "se_atualizado_em": "<retrato opcional>"}` | `{"mudanca": {"tipo": "alterou", "id", "titulo", "resumo", "antes": {...}} \| null, "dados": <GET>}` |
| `POST /api/pendencias/<id>/mover` | `{"status": "andamento", "posicao": 0}` (posição na coluna de destino, 0 = topo) | igual ao PATCH |
| `POST /api/pendencias/<id>/restaurar` | `{"antes": <mudanca.antes>}` (desfazer uma alteração) | `{"dados": <GET>}` |
| `DELETE /api/pendencias/<id>` | `{}` (só para desfazer uma criação) | `{"dados": <GET>}` |

**Conflito (409).** Com `se_atualizado_em`, o PATCH só grava se o `atualizado_em` da pendência
ainda for aquele; senão volta `409 {"erro": "“X” mudou pela leitura do Teams enquanto você
editava.", "conflito": {"pendencia": <Pendência de agora>}, "dados": <GET>}` e **nada é gravado**.
Quem escreve no mesmo arquivo não é só o painel: a leitura do Teams, o agente e o MCP também.
O campo é opcional — mande-o nas edições que ficam abertas um tempo (título, descrição, campos de
texto) e omita nos cliques instantâneos (mover coluna, trocar prioridade), onde não há janela para
conflito. Sem o campo, o servidor não confere nada e grava, como antes.

`dados.versao` sobe a cada gravação. O painel deve consultar `GET /api/pendencias` a cada ~10 s
(quando a aba está visível) e redesenhar só se a versão mudou: o Claude Code e o servidor MCP também
gravam no mesmo arquivo.

## Cérebro

| Método e rota | Resposta |
|---|---|
| `GET /api/pendencias/<id>/contexto` | `{"projeto": <Projeto> \| null, "sugestoes": [{"projeto_id", "nome", "pontos"}], "arquivos": [Arquivo], "notas": [Nota], "notas_relacionadas": [Nota], "relacionadas": [{"id", "titulo", "status", "motivo": "mesmo projeto" \| "mesma pessoa"}], "pastas": [{"caminho", "motivo"}], "agente": "...", "como_ajuda": "..."}` |
| `GET /api/projetos` | `{"projetos": [Projeto + {"abertas": n, "total": n, "docs": n}], "indice": Indice}` |
| `PATCH /api/projetos/<id>` | corpo `{"campos": {"nome", "pasta", "area", "descricao", "ativo", "palavras_chave": [], "pessoas": []}}` → `{"projeto": Projeto}` |
| `GET /api/cerebro/busca?q=texto&projeto=<id opcional>` | `{"resultados": [Arquivo]}` |
| `POST /api/cerebro/indexar` | `{"indice": Indice}` (roda em segundo plano; consulte o status) |
| `GET /api/cerebro/status` | `{"indice": Indice}` |

- Projeto: `{"id", "nome", "pasta", "area", "descricao", "ativo", "git", "memoria": "pasta da memória do Claude ou ''", "arquivos": [{"caminho", "porque"}], "palavras_chave": [], "pessoas": [], "observacoes"}`
- `pastas` no contexto é a prévia do que o agente abriria **se fosse executado agora** (mesma
  `cerebro.pastas_para_agente` da Execucao): serve para o painel dizer, antes de rodar, o que vai
  ser lido. A execução de verdade pode abrir mais (o que o usuário pedir em `projetos`).
- Arquivo: `{"caminho", "motivo"?, "titulo"?, "tipo"?: "doc|sql|tmdl|codigo|config|memoria", "trecho"?: "texto com «termos» marcados", "existe"?: bool, "origem": "ligado" | "busca", "projeto_id"?}`
- Nota (memória do Claude Code): `{"nota": "nome-da-nota", "caminho", "titulo", "projeto_id", "trecho"?, "origem"?}`
- Indice: `{"rodando": bool, "inicio", "fim", "arquivos", "novos", "erro", "total_docs", "memorias", "por_projeto": {"id": n}}`

## Agente por pendência

O agente é o Claude Code rodando na pasta do projeto da pendência, só com leitura (Read, Grep, Glob).
Ele carrega sozinho o CLAUDE.md e a memória daquele projeto. Os arquivos que ele produz são gravados
pelo servidor em `entregas/<id-da-pendência>/`; ele nunca escreve nas pastas dos projetos.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /api/pendencias/<id>/agente` | `{"modo": "briefing" \| "rascunho" \| "executar", "instrucao": "opcional", "projetos": ["id", ...]}` | `{"execucao": Execucao}` |
| `GET /api/execucoes/<eid>?desde=<n>` | | `{"execucao": Execucao}` (eventos com `n` > desde) |
| `POST /api/execucoes/<eid>/cancelar` | `{}` | `{"execucao": Execucao}` |
| `GET /api/pendencias/<id>/execucoes` | | `{"execucoes": [Execucao sem eventos]}` (mais recente primeiro) |
| `GET /api/entregas/<id>/<nome>` | | o conteúdo do arquivo, `text/plain; charset=utf-8`. `<nome>` é o caminho relativo da entrega, com subpasta (`e-2026…/src/Video.jsx`), cada pedaço codificado à parte |
| `POST /api/entregas/<id>/copiar` | `{"eid": "e-...", "projeto_id": "opcional", "confirmar": false}` | `{"destino": "C:\\...\\mesa-<id>", "projeto": "nome", "arquivos": [{"nome", "bytes"}], "gravado": bool}` |
| `POST /api/abrir` | `{"caminho": "C:\\...", "com": "explorer" \| "code"}` | `{"ok": true}` (só caminhos de projetos, memórias e entregas) |

- `projetos`: ids de projetos registrados cujas pastas devem ser abertas nessa execução (o servidor
  ignora id desconhecido e pasta não liberável). Serve ao botão "Abrir e refazer" de `pastas_negadas`.
- `POST .../copiar` é a última milha: **quem escreve é o servidor**, com o clique do usuário, numa
  pasta nova `mesa-<pendência>` dentro do projeto. Nada existente é sobrescrito; sem `confirmar`,
  a resposta é só a prévia do que seria gravado. O agente continua sem escrever em projeto nenhum.

- Modos: **briefing** (o que é, contexto achado com fontes, próximos passos), **rascunho** (além disso, a
  mensagem pronta para a pessoa), **executar** (produz os arquivos de entrega quando dá).
- Execucao: `{"id", "pendencia_id", "modo", "instrucao", "modelo", "criada", "status": "fila" | "rodando" | "concluida" | "erro" | "cancelada", "inicio", "fim", "duracao_ms", "custo_usd", "pasta": "onde rodou", "pastas": [{"caminho", "motivo"}], "negados": ["caminho que o CLI recusou"], "pastas_negadas": [{"caminho", "projeto_id", "nome"}], "projetos": ["ids pedidos"], "eventos": [{"n": 1, "em": "ISO", "tipo": "inicio" | "ferramenta" | "texto" | "aviso" | "erro" | "fim", "texto": "Lendo ESTADO.md"}], "resultado": Resultado | null, "entregas": [{"nome", "rotulo", "descricao"}], "erro": ""}`
- `pastas`: o que o agente pode ler além do diretório de trabalho (vira `--add-dir`). Sai de
  `cerebro.pastas_para_agente`: a raiz do projeto dono de cada arquivo que o cérebro citou (ligado
  **ou** achado na busca), os projetos sugeridos quando não há projeto ligado, a memória e
  `entregas/<id>`. Nunca a raiz do Escriba (abri-la abriria `dados/` e `export/` junto), nem `dados/`,
  `export/`, raiz de unidade, a pasta pessoal ou `node_modules`/`.git` — `docs/` e `servidor/` da
  próprio Escriba podem, quando um arquivo de lá é citado (`cerebro.pasta_liberavel`). No máximo 8,
  sem pasta contida em outra.
- `negados` / `pastas_negadas`: caminhos que o Claude Code recusou (vêm do `permission_denials` do
  envelope e dos `tool_use` do stream, não de texto solto) e a pasta de projeto que os liberaria.
- Entrega: `{"nome", "rotulo", "descricao", "da_ferramenta"?}`. `nome` é o caminho relativo a `entregas/<id>`
  (`<eid>/src/Video.jsx`) e serve para montar a URL e o caminho no disco; `rotulo` é o caminho dentro
  da execução, para mostrar na tela; `da_ferramenta` marca o arquivo que uma ferramenta de extensão
  gravou direto na pasta, sem passar pela resposta do modelo. Cada execução grava
  na sua pasta: a segunda rodada não embaralha a entrega da primeira. Nome com `..`, unidade ou nome
  de dispositivo do Windows é recusado.
- Dois tetos diferentes, que não se misturam: o que o **modelo escreve** na resposta (campo
  `arquivos`) vai até 30 arquivos e 600 KB somados — o que não couber fica de fora com aviso, nunca
  gravado pela metade; o que uma ferramenta de extensão grava direto na pasta não passa pelo modelo
  e não entra nesse teto.
- Resultado: `{"resumo", "contexto": [{"fonte", "trecho", "porque"}], "proximos_passos": [], "mensagem": {"para", "texto"} | null, "arquivos": [{"nome", "descricao"}], "bloqueios": [], "pode_concluir": bool}`
- Extensões locais: um pacote opcional em `servidor/local/` (fora do Git) pode dar ao agente ferramentas
  extras por MCP e acrescentar campos à Execucao e uma seção à aba Agente (ver `CLAUDE.md`). Sem ele, o
  agente só lê arquivos e a Execucao tem só os campos acima.
- Uma execução leva de 30 s a alguns minutos. O teto é 900 s; uma extensão pode pedir mais (`teto_s` em
  `preparar`), quando a ferramenta dela é lenta. Consulte `GET /api/execucoes/<eid>?desde=<último n>` a
  cada ~1,5 s enquanto `status` for `fila` ou `rodando`. No máximo 2 execuções rodam ao mesmo tempo; as
  outras ficam em `fila`.
- Estourar o tempo **não joga fora o que já foi gravado**: o que uma ferramenta tiver escrito na pasta da
  entrega entra em `entregas` mesmo com `status: "erro"`, e o texto do erro diz quantos sobraram.

## Jira

A única rota do Escriba que escreve fora desta máquina. Só cria com `confirmar`, e só a partir do
clique do usuário: sem `confirmar`, a resposta é a prévia do que seria criado.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `GET /api/jira` | | `{"configurado": bool, "base", "projeto", "epico_padrao", "tipo", "quadro", "conta": {"nome", "email", "accountId"}, "sprint": {"id", "nome", "fim"} \| null, "epicos": [{"chave", "titulo", "estado"}], "erro"?}` |
| `POST /api/pendencias/<id>/jira` | `{"epico": "ABC-100", "tipo": "História", "confirmar": false}` | prévia: `{"projeto", "tipo", "resumo", "epico", "responsavel", "prazo", "sprint", "ja_existe", "criado": false}`; com `confirmar`: `{..., "criado": true, "chave": "ABC-123", "url": "..."}` |

- Base, projeto, quadro e épico padrão vêm de `config.local.json` (chave `jira`); sem eles, `recursos.jira`
  é false e o botão não aparece.
- A issue nasce com `parent` = o épico, `assignee` = o usuário, `duedate` = o prazo da pendência e
  `customfield_10010` = a **sprint ativa do quadro**, consultada na hora de criar (as sprints giram
  toda semana; nunca fixe o id). Sem sprint ativa, a issue vai para o backlog e a prévia avisa.
- A pendência ganha `"jira": {"chave", "url", "epico", "sprint", "em"}`, validado em `loja._limpar_jira`
  (chave no formato `ABC-123`, link só https). Uma pendência que já tem chave é recusada.
- Credencial: Gerenciador de Credenciais do Windows, alvo `jira.credencial` do config, padrão `Escriba/Jira`
  (`jira.guardar/ler/apagar`,
  via `ctypes`). Nunca em arquivo, nunca numa pendência, nunca no git. `recursos.jira` em `/api/status`
  diz se há credencial gravada.

## Daily

`GET /api/daily[?desde=hoje|7d|<ISO>]` → o resumo para a daily dele (segunda, quarta e sexta).
Sem `desde`, a janela vai **da daily anterior até agora** — a de hoje não conta, mesmo que já
tenha passado da hora: quem abre quer o que andou desde a última vez que falou. Tudo sai do
histórico das pendências; não chama modelo nenhum e responde na hora.

```json
{"janela": {"inicio": "...", "fim": "...", "rotulo": "desde sexta, 23/10 às 09:00",
            "dias": [0, 2, 4], "hora": "09:00", "hoje_e_dia": true, "hoje": "segunda, 26/10/2026"},
 "contagens": {"feitas": 3, "andamento": 3, "aguardando": 2, "mexidas": 1, "atrasadas": 0,
               "vencem_hoje": 0, "novas": 0, "descartadas": 0},
 "feitas": [{"id", "titulo", "pessoa", "area", "projeto_id", "prazo", "status", "aguardando_de", "cobrar_em", "notas": ["..."]}],
 "andamento": [...], "aguardando": [...], "cobrar": [...], "mexidas": [...], "atrasadas": [...],
 "vencem_hoje": [...], "novas": [...], "descartadas": [...],
 "texto": "Daily de segunda, 26/10/2026 — desde sexta...

Fechei (3):
- ..."}
```

- `mexidas`: pendência aberta que ganhou **nota de verdade** na janela sem ser fechada. Notas que
  o próprio sistema gera ("agora feita", "prioridade urgente") não contam nem aparecem — não se
  fala isso numa daily.
- `feitas` sai da marca `status` das entradas do histórico (`loja._anotar`), não do texto delas:
  a nota costuma ser o motivo ("Respondeu em 21/10: segue a base"), não o campo que mudou. Para
  histórico antigo, sem a marca, vale o `atualizado_em`.
- `cobrar`: pendência aberta cuja `cobrar_em` já chegou — o que ele vai puxar hoje. Entra no
  roteiro falado como "Vou cobrar hoje", com o nome de quem está com a bola.
- `texto` é o roteiro falado, pronto para o botão Copiar.
- Os dias e a hora da daily ficam em `meta.daily` (`{"dias": [0,2,4], "hora": "09:00"}`, 0 = segunda).

## Radar

Não tem rota. A página `#/radar` calcula tudo no navegador a partir do `GET /api/pendencias`, que
o painel já consulta a cada 10 s. Houve um `GET /api/radar` que devolvia o retrato pronto, como a
daily faz; ele saiu quando a página ganhou **filtro cruzado**: clicar numa área tem de refazer os
nove visuais na hora, e uma ida ao servidor por clique não serve. Duas implementações do mesmo
cálculo (uma em Python, outra em JS) divergiriam, então ficou só a do navegador.

## Leitura do Teams (botão "Atualizar do Teams")

Só começa por clique do usuário; o servidor nunca lê o Teams sozinho. Uma leitura por vez.
Os cinco passos são os da rotina manual (`servidor/teams.py`): copia as pastas do Teams dentro do
IndexedDB do perfil corporativo para `export/IndexedDB` (nunca o perfil inteiro), roda
`extrair_cache.py --desde <última leitura>`, manda o markdown e as pendências atuais para o
`claude -p` sem ferramentas (instruções em `servidor/instrucoes_teams.md`), aplica o plano por
`loja.aplicar(..., "claude-code")` e liga as pendências novas a um projeto do cérebro.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /api/teams/atualizar` | `{}` | `{"sync": Sync}` (409 se já houver uma rodando) |
| `GET /api/teams?desde=<n>` | | `{"sync": Sync \| null}` (eventos com `n` > desde; `null` = nenhuma leitura nesta sessão do servidor) |
| `POST /api/teams/cancelar` | `{}` | `{"sync": Sync}` |

- Sync: `{"id": "t-...", "status": "rodando" | "concluida" | "erro" | "cancelada", "etapa": "copia" | "extracao" | "analise" | "aplicacao" | "cerebro" | "fim", "modelo", "inicio", "fim", "duracao_ms", "custo_usd", "desde": "<última leitura usada como corte>", "resposta": "o resumo do Claude", "erro": "", "resumo": {"arquivos_copiados", "arquivo": "teams_cache_....md", "chats", "mensagens", "criadas", "atualizadas", "ligadas"}, "mudancas": [Mudanca], "avisos": ["operação 2: ..."], "duvidas": ["o que ele não mudou por dúvida"], "eventos": [{"n", "em", "tipo": "inicio" | "etapa" | "ok" | "texto" | "aviso" | "erro" | "fim", "texto"}], "total_eventos": 7}`
- Mudanca tem o mesmo formato do assistente (Desfazer por `/restaurar` ou `DELETE`).
- Uma leitura leva de 1 a 4 minutos (a cópia são ~120 MB e a análise, 1 a 3 min). Consulte
  `GET /api/teams?desde=<último n>` a cada ~1,5 s enquanto `status` for `rodando`.
- No fim, `meta` ganha `ultima_leitura_teams` (hora do início da extração, com `-03:00`),
  `chats_lidos`, `mensagens_lidas` e `periodo_lido`. Sem mensagens novas, só a data é atualizada.
- O mesmo caminho existe na linha de comando: `python servidor\teams.py [--simular]`
  (`--simular` faz tudo menos gravar).

## Assistente geral

`POST /api/assistente` com `{"texto": "já fiz a da Ana", "turnos": [{"papel": "eu" | "assistente", "texto"}], "foco": "<id opcional da pendência aberta na gaveta>"}`
→ `{"resposta": "texto curto", "mudancas": [Mudanca], "avisos": ["..."], "dados": <GET>}`.
Leva ~15 a 25 s. Só um pedido por vez (409 se houver outro). Cada Mudanca tem `tipo` (`criou`|`alterou`),
`id`, `titulo`, `resumo` e, em `alterou`, `antes` (para Desfazer via `/restaurar`; em `criou`, Desfazer = `DELETE`).

## Status

`GET /api/status` → `{"assistente": bool, "claude": "2.1.306 (caminho)", "modelo": "sonnet", "versao": 12, "indice": Indice, "recursos": {"andamento": true, "cerebro": true, "projetos": true, "agente": bool, "abrir": true, "teams": bool}}`.

`recursos.teams` é `true` quando há CLI do Claude Code e o `extrair_cache.py` no lugar: é ele que
mostra ou esconde o botão "Atualizar do Teams" no painel.

`agente.ultima.status` vale `rodando` enquanto a execução corre (o servidor grava no início), e passa a `concluida`, `erro` ou `cancelada` no fim. Na subida do servidor, execuções que ficaram `rodando` de antes de um reinício viram `erro` ("Interrompida").
