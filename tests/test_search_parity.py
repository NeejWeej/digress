"""Pure Node test that the server's search (server/db.mjs, SQLite FTS5) and the page's (web/js/searchrank.js,
MiniSearch) return the same results in the same order for the same conversations, query by query, and that
their per-kind boosts agree. Guards agents/search.md's "Two search engines".
Runs tests/search_parity.mjs with Node; exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'search_parity.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
