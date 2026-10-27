# Escriba

Quadro kanban local das pendências de trabalho, tiradas das conversas do Teams, com um cérebro
que liga cada pendência ao projeto certo e um agente que trabalha na pasta daquele projeto.
Roda só na sua máquina: servidor Python de biblioteca padrão e painel sem framework nem CDN.

## Requisitos

- Windows, com o Teams (novo) instalado e já aberto pelo menos uma vez.
- Python 3.11+ e um `.venv` na raiz com o `requirements.txt` (só a leitura do cache do Teams precisa):
  `python -m venv .venv` e `.venv\Scripts\python.exe -m pip install -r requirements.txt`.
- [Claude Code](https://claude.com/claude-code) instalado e com login feito: o assistente, a leitura do
  Teams e o agente usam o `claude -p`.

## Configurar

Copie `config.exemplo.json` para `config.local.json` e troque pelos seus valores: seu nome e o que você
faz (vão nos prompts), as áreas do quadro (até 8) e, se for usar, o Jira. O `config.local.json` fica fora
do Git. Sem ele, o Escriba sobe com áreas genéricas.

## Uso

Dois cliques em `iniciar-mesa.cmd` (ou o mesmo comando em qualquer terminal). O painel abre em
http://127.0.0.1:8765 e só aceita conexão desta máquina.

No painel: **Atualizar do Teams** (ícone ⟳ na barra) lê as conversas novas e atualiza o quadro;
**Ctrl+K** abre a busca e o assistente; cada pendência tem a aba **Agente**, que roda o Claude Code na
pasta do projeto, só lendo arquivos, e grava o que produzir em `entregas/`. O **Radar** (G R) é a tela de
acompanhamento, para deixar aberta num monitor: cabe numa tela, tem filtro cruzado e um Modo TV.

Pela linha de comando, com o Python do `.venv`:

```
.venv\Scripts\python.exe pendencias.py listar          # as pendências abertas
.venv\Scripts\python.exe servidor\teams.py --simular   # leitura do Teams sem gravar
.venv\Scripts\python.exe servidor\cerebro.py indexar   # atualiza o índice dos projetos
```

## Onde está cada coisa

| Arquivo | O que é |
|---|---|
| `CLAUDE.md` | Arquitetura, regras e a rotina de atualização. Comece por aqui. |
| `docs/API.md` | Contrato do servidor. É ele que vale quando os documentos divergirem. |
| `docs/FRONTEND.md` | Como o painel está organizado. |
| `config.exemplo.json` | Formato do `config.local.json`. |

`dados/`, `export/`, `entregas/` e `config.local.json` ficam fora do Git: são as pendências, as conversas
exportadas, o trabalho do agente e os seus dados.

## Caminho alternativo pelo Microsoft Graph

`exportar-teams.ps1` busca as conversas pelo Microsoft Graph (permissão delegada `Chat.Read`). Muitos
tenants recusam esse consentimento; por isso o caminho padrão é a leitura da cópia local do cache do
Teams (`extrair_cache.py`, chamado pelo botão do painel).
