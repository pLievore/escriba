"""Lista bancos e object stores do IndexedDB do Teams copiado, com contagem de registros."""
import sys
from pathlib import Path

from ccl_chromium_reader import ccl_chromium_indexeddb

base = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "export" / "IndexedDB")
ldb = base / "https_teams.microsoft.com_0.indexeddb.leveldb"
blob = base / "https_teams.microsoft.com_0.indexeddb.blob"

wrapper = ccl_chromium_indexeddb.WrappedIndexDB(ldb, blob)
for dbid in wrapper.database_ids:
    try:
        db = wrapper[dbid.dbid_no]
    except Exception as e:
        print(f"[{dbid.dbid_no}] {dbid.name}: erro {e}")
        continue
    print(f"[{dbid.dbid_no}] {dbid.name}")
    for nome in db.object_store_names:
        try:
            n = sum(1 for _ in db[nome].iterate_records())
        except Exception as e:
            n = f"erro {e}"
        print(f"    {nome}: {n}")
