"""Pure client ES module unit tests (web/js/fsrs.js, web/js/text.js).
Runs tests/client_modules_unit.mjs with Node; exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'client_modules_unit.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
