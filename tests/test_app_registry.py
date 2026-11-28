"""The client's cross-module registry (`app`, filled in web/js/app.js) and redraw keys (web/js/redraw.js):
every `app.X` a module uses is registered, and every `invalidate('key')` has an `onRedraw('key', fn)`.
A typo in either is invisible to lint and would only fail when that line runs. Runs tests/app_registry.mjs
with Node (`node tests/app_registry.mjs --map` prints the dependency map); exits non-zero on any failure."""
import os, subprocess, sys
r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'app_registry.mjs')], capture_output=True, text=True)
print(r.stdout + r.stderr)
sys.exit(r.returncode)
