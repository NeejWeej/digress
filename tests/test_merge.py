"""Two devices editing the same conversation (web/threads.js: merge) on thousands of random cases: the result
is valid, every message sees what it saw, nothing either side added or changed is lost, and falling back to
a copy stays rare. Runs tests/merge_prop.mjs with Node; exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'merge_prop.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
