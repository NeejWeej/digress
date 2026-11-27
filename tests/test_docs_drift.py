"""Docs-drift checks (text only, no browser): settings, defaults, test names and API routes mentioned in
the docs match the code. Runs tests/docs_drift.mjs with Node; exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'docs_drift.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
