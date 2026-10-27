# Escriba

A local kanban board for the work requests buried in your Microsoft Teams conversations. A local
"brain" links each task to the right project, and an agent works inside that project's folder.
Everything runs on your machine: a Python server built only on the standard library, and a web panel
with no framework, build step or CDN.

> The interface, the prompts and the docs under `docs/` are in Brazilian Portuguese.

## Requirements

- Windows, with the new Teams app installed and opened at least once.
- Python 3.11+ and a `.venv` at the repository root with `requirements.txt` installed (only the Teams
  cache reader needs it):
  `python -m venv .venv` then `.venv\Scripts\python.exe -m pip install -r requirements.txt`.
- [Claude Code](https://claude.com/claude-code) installed and logged in: the assistant, the Teams reader
  and the agent all run `claude -p`.

## Configuration

Copy `config.exemplo.json` to `config.local.json` and fill in your own values: your name and role (used in
the prompts), the board areas (up to 8) and, if you want it, your Jira settings. `config.local.json` is
ignored by Git. Without it, Escriba starts with generic areas.

## Usage

Double-click `iniciar-mesa.cmd` (or run it from any terminal). The panel opens at
http://127.0.0.1:8765 and only accepts connections from this machine.

In the panel:

- **Atualizar do Teams** (the ⟳ icon in the toolbar) reads new Teams messages and updates the board.
- **Ctrl+K** opens search and the assistant, which takes plain-language requests ("já fiz a #3").
- Each task has an **Agente** tab that runs Claude Code in the project folder, read-only, and saves what
  it produces under `entregas/`. It never writes into your projects without a click.
- **Radar** (G R) is a monitoring dashboard meant to stay open on a second screen: it fits one screen,
  has cross-filtering and a TV mode.
- **Daily** (G D) summarizes what moved since your last stand-up.

From the command line, with the `.venv` Python:

```
.venv\Scripts\python.exe pendencias.py listar          # open tasks
.venv\Scripts\python.exe servidor\teams.py --simular   # Teams read, dry run
.venv\Scripts\python.exe servidor\cerebro.py indexar   # rebuild the project index
```

## Where things are

| File | What it is |
|---|---|
| `CLAUDE.md` | Architecture, rules and the update routine. Start here. |
| `docs/API.md` | The server contract. It wins whenever the docs disagree. |
| `docs/FRONTEND.md` | How the panel is organized. |
| `config.exemplo.json` | The format of `config.local.json`. |

`dados/`, `export/`, `entregas/` and `config.local.json` are ignored by Git: they hold your tasks, the
exported conversations, the agent's output and your personal settings.

## Extending the agent

An optional package under `servidor/local/` (also ignored by Git) can give the agent extra tools through
MCP servers and add its own section to the agent tab. See "Extensões locais do agente" in `CLAUDE.md`.

## Alternative: Microsoft Graph

`exportar-teams.ps1` fetches conversations through Microsoft Graph (delegated `Chat.Read` permission).
Many tenants refuse that consent, so the default path reads a local copy of the Teams cache instead
(`extrair_cache.py`, called by the panel button).
