"""Pure Node unit tests for web/js/context.js (buildContext, prompt prefix stability,
over-budget documents, CLIP branch isolation, takeaways/images, system/skills precedence).
Runs tests/context_unit.mjs with Node; exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'context_unit.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
