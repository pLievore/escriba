"""Mostra a estrutura (chaves e amostra de valores) de alguns registros de um object store."""
import json
import sys
from pathlib import Path

from ccl_chromium_reader import ccl_chromium_indexeddb

base = Path(__file__).parent / "export" / "IndexedDB"
wrapper = ccl_chromium_indexeddb.WrappedIndexDB(
    base / "https_teams.microsoft.com_0.indexeddb.leveldb",
    base / "https_teams.microsoft.com_0.indexeddb.blob",
)

db_no, store, qtd = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1


def resumo(v, nivel=0):
    if isinstance(v, dict):
        if nivel >= 3:
            return f"{{dict {len(v)} chaves}}"
        return {k: resumo(x, nivel + 1) for k, x in list(v.items())[:40]}
    if isinstance(v, list):
        return [resumo(v[0], nivel + 1), f"... {len(v)} itens"] if v else []
    s = str(v)
    return s[:80] + ("..." if len(s) > 80 else "")


for i, rec in enumerate(wrapper[db_no][store].iterate_records()):
    if i >= qtd:
        break
    print(f"--- key: {str(rec.key.value)[:120]}")
    print(json.dumps(resumo(rec.value), ensure_ascii=False, indent=1, default=str))
