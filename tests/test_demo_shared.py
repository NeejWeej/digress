"""The demo runs the server's own Gemini code, not a copy (text only, no browser): runs tests/demo_shared.mjs."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'demo_shared.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
