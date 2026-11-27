"""Direct Node unit tests for server/db.mjs and server/fetchdoc.mjs.
Runs tests/server_unit.mjs with Node; exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'server_unit.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
