"""The thread operations (web/threads.js: split, join, swap) on thousands of random conversations: every
message keeps exactly the context it had, the shape stays valid, and a refused operation changes nothing.
Runs tests/threads_prop.mjs with Node; exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'threads_prop.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
