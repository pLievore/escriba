"""Linha de comando do Escriba, para o Claude Code ler e mudar as pendências.

  python pendencias.py listar [--todas]     abertas e aguardando, em texto (--todas inclui fechadas)
  python pendencias.py json [--todas]       o mesmo, em JSON
  python pendencias.py aplicar PLANO.json   aplica {"operacoes": [...], "meta": {...}} como claude-code

As operações seguem servidor/loja.py: {"op": "atualizar", "id", "campos", "nota"} ou
{"op": "criar", "dados"}. Nunca reabre o que o usuário fechou, salvo com "forcar": true.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "servidor"))
import loja  # noqa: E402

ORDEM = {"urgente": 0, "semana": 1, "acompanhar": 2}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Pendências do Escriba")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for nome in ("listar", "json"):
        sub.add_parser(nome).add_argument("--todas", action="store_true")
    sub.add_parser("aplicar").add_argument("plano")
    args = ap.parse_args()

    if args.cmd in ("listar", "json"):
        dados = loja.ler()
        itens = [i for i in dados["pendencias"] if args.todas or i.get("status") in ("aberta", "aguardando")]
        if args.cmd == "json":
            print(json.dumps({"meta": dados["meta"], "pendencias": itens}, ensure_ascii=False))
            return
        print(f"Teams lido em: {dados['meta'].get('ultima_leitura_teams', '-')} | versão {dados['versao']}")
        for i in sorted(itens, key=lambda i: (ORDEM.get(i.get("prioridade"), 9), i.get("prazo") or "9999")):
            prazo = f" | prazo {i['prazo']}" if i.get("prazo") else ""
            print(f"[{i['status']}/{i['prioridade']}] {i['id']}: {i['titulo']} | {i.get('pessoa', '')}{prazo}")
        return

    plano = json.loads(Path(args.plano).read_text(encoding="utf-8"))
    mudancas, avisos, _ = loja.aplicar(plano.get("operacoes") or [], "claude-code")
    if isinstance(plano.get("meta"), dict) and plano["meta"]:
        loja.definir_meta(plano["meta"])
    for m in mudancas:
        if m["tipo"] == "criou":
            print(f"+ criou {m['id']}: {m['titulo']}")
        else:
            print(f"~ {m['id']}: {m['resumo']}")
    for a in avisos:
        print(f"! {a}")
    print(f"{len(mudancas)} mudança(s), {len(avisos)} aviso(s).")


if __name__ == "__main__":
    main()
