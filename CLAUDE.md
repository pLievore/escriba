# Escriba

Quadro kanban das pendências de trabalho tiradas das conversas do Teams, com um cérebro local que liga
cada pendência ao projeto certo e um agente que trabalha na pasta do projeto.

- **Abrir**: `iniciar-mesa.cmd` (dois cliques ou qualquer terminal; o `.ps1` só roda dentro do PowerShell)
  sobe `servidor/app.py` em http://127.0.0.1:8765, só nesta máquina, só biblioteca padrão do Python.
  Contrato da API em `docs/API.md`; organização do painel em `docs/FRONTEND.md`.
- **Configuração** (`servidor/config.py`): quem usa, as áreas do quadro e o Jira vêm de `config.local.json`
  (fora do Git; formato em `config.exemplo.json`). Sem ele valem padrões genéricos. Os prompts usam
  marcadores (`{{DONO}}`, `{{AREAS}}`…) que `config.preencher()` troca na hora.
- **Dados**: `dados/pendencias.json` (fora do Git), escrito só por `servidor/loja.py`, com trava entre
  processos. Colunas: aberta (A fazer), andamento, aguardando, feita (Concluído), descartada (arquivo).
  Não editar o JSON à mão: usar `pendencias.py` ou a API.
- **Cérebro** (`servidor/cerebro.py`): registro de projetos em `dados/projetos.json` e índice SQLite FTS5 em
  `dados/cerebro.db` sobre os documentos de cada projeto e as memórias do Claude Code (links `[[nota]]`).
  Só lê as pastas dos projetos. `python servidor\cerebro.py indexar | buscar "texto" | semear`.
- **Agente** (`servidor/agente.py`): `claude -p` com cwd na pasta do projeto da pendência (carrega o CLAUDE.md
  e a memória daquele projeto), ferramentas só Read/Grep/Glob em modo dontAsk, `--json-schema`, no máximo 2
  ao mesmo tempo. No modo **executar** entrega só o que foi pedido. Nunca escreve nos projetos: o servidor
  grava as entregas em `entregas/<id>/<execução>/` e só copia para o projeto com o clique do usuário
  (`POST /api/entregas/<id>/copiar`, pasta nova, sem sobrescrever). `cerebro.pasta_liberavel` mantém fora
  a raiz do Escriba, `dados/`, `export/`, raiz de unidade, a pasta pessoal e `node_modules`.
- **Extensões locais do agente**: um pacote opcional em `servidor/local/` (fora do Git) pode dar ao agente
  ferramentas extras por MCP. O `agente.py` chama, se existirem, `preparar(ex, item, saida)`,
  `ao_usar(...)`, `ao_resultado(...)` e `descrever_arquivo(...)`; os scripts listados em `SCRIPTS` são
  injetados na página pelo servidor e registram o que desenham com `Mesa.agente.registrarExtensao()`.
  Sem extensão, o agente só lê arquivos.
- **Cobrança** (`aguardando_de` + `cobrar_em`): de quem é a bola e quando puxar de volta. Ao mandar um
  cartão para Aguardando, o quadro pergunta as duas coisas; o cartão ganha o chip "Cobrar".
- **Conflito de edição**: `PATCH /api/pendencias/<id>` aceita `se_atualizado_em`; se a pendência mudou
  depois daquele retrato, volta 409 com o estado novo e não grava.
- **Radar** (`servidor/static/radar.js`): tela de acompanhamento que cabe em 1080p, com filtro cruzado.
  Calcula tudo no navegador a partir das pendências que o painel já tem.
- **Daily** (`servidor/daily.py`): resumo desde a daily anterior, sem chamar modelo. Dias e hora em
  `meta.daily` (padrão seg/qua/sex às 09:00).
- **Jira** (`servidor/jira.py`): botão "Criar no Jira" na gaveta, a única coisa que escreve fora da máquina.
  Projeto, quadro e épico vêm do config; a credencial fica no Gerenciador de Credenciais do Windows, nunca
  em arquivo. Sem `confirmar`, a rota só devolve a prévia. Para gravar a credencial:
  `echo email:token | python servidor\jira.py guardar`.
- **Assistente geral**: `POST /api/assistente` chama `claude -p` sem ferramentas; instruções em
  `servidor/instrucoes_assistente.md`; a resposta é um plano JSON que `loja.aplicar` valida.
- **Leitura do Teams** (`servidor/teams.py`): o botão "Atualizar do Teams" copia o cache (só as pastas
  `https_teams.microsoft.com_0.indexeddb.*` do perfil, nunca o perfil inteiro), extrai o que é novo, lê com
  o `claude -p` (instruções em `servidor/instrucoes_teams.md`) e aplica. Só começa por clique.
  Pela linha de comando: `python servidor\teams.py [--simular]`.

## Rotina manual "atualiza as pendências"

O caminho normal é o botão **Atualizar do Teams**. A rotina manual vale quando o botão falha ou quando se
quer conferir o export antes de aplicar:

1. Copiar só a pasta `IndexedDB` do perfil do Teams para `export\IndexedDB` (nunca o perfil `EBWebView`
   inteiro, que tem cookies e tokens).
2. Ver a última leitura: `.venv\Scripts\python.exe pendencias.py listar` (primeira linha).
3. Extrair o que é novo: `.venv\Scripts\python.exe extrair_cache.py --desde <ultima_leitura_teams>` e ler o
   `.md` gerado em `export/`.
4. Montar um plano em `export/plano.json` e aplicar com `.venv\Scripts\python.exe pendencias.py aplicar export\plano.json`:
   ```json
   {"operacoes": [
     {"op": "criar", "dados": {"titulo": "...", "pessoa": "...", "area": "...", "prioridade": "urgente|semana|acompanhar", "prazo": "AAAA-MM-DD", "contexto": "...", "origem": "Chat com ..."}},
     {"op": "atualizar", "id": "...", "campos": {"status": "feita"}, "nota": "Respondeu em 21/10: ..."}
   ],
    "meta": {"ultima_leitura_teams": "<horário do 'Gerado em' do export>"}}
   ```
5. Depois de criar pendências novas: `.venv\Scripts\python.exe servidor\cerebro.py semear`.

As regras de decisão são as de `servidor/instrucoes_teams.md`.

## Regras

- Nunca escrever segredos (chaves, senhas, tokens) nas pendências, nem mascarados. `extrair_cache.py`
  mascara o que achar, e o cérebro não deixa o agente ler `dados/` nem `export/`.
- Não apagar pendências: usar status `descartada`.
- Nada de dado pessoal, de empresa ou de conversa em arquivo rastreado: isso vai para `config.local.json`
  ou para os arquivos ignorados pelo `.gitignore`.

## Scripts

- `extrair_cache.py`: gera `export/teams_cache_*.md` a partir de `export/IndexedDB`; mascara segredos;
  `dias` ou `--desde`. Lê todas as lojas cujo nome começa com `replychains` (o Teams divide as conversas).
- `pendencias.py`: `listar`, `json`, `aplicar PLANO.json`.
- `mapear_cache.py` / `inspecionar_cache.py`: diagnóstico da estrutura do cache, se o Teams mudar o formato.
- `exportar-teams.ps1`: caminho alternativo pelo Microsoft Graph, para tenants que liberam `Chat.Read`.
