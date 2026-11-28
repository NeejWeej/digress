"""findDigressTab (extension/background.js) picks the most recently used Digress tab.
background.js is a service-worker script, so it's loaded in a vm with a stub `chrome`."""
import json, subprocess, sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
fails = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  -- {detail}'))
    if not ok: fails.append(name)

JS = r"""
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
let tabs = [];
const noop = () => {};
const ev = { addListener: noop, removeListener: noop };
const chrome = {
  tabs: { query: async () => tabs, onUpdated: ev, create: noop, update: noop, get: noop, sendMessage: noop },
  runtime: { onMessage: ev, onInstalled: ev, onStartup: ev },
  contextMenus: { onClicked: ev, create: noop, removeAll: (cb) => cb && cb() },
  commands: { onCommand: ev },
  action: { onClicked: ev },
  storage: { local: { get: async () => ({}) } },
  windows: { update: async () => {} },
};
const ctx = { chrome, URL, console, setTimeout, clearTimeout, self: {} };
ctx.self = ctx; ctx.importScripts = () => {};
vm.createContext(ctx);
vm.runInContext(readFileSync('./extension/rules.js', 'utf8'), ctx);
ctx.importScripts = () => {};
vm.runInContext(readFileSync('./extension/background.js', 'utf8') + '\n;this.__find = findDigressTab;', ctx);
const U = 'https://box.ts.net';
const run = async (list) => { tabs = list; const t = await ctx.__find(U); return t ? t.id : null; };
const out = {
  recent: await run([
    { id: 1, url: 'https://box.ts.net/', lastAccessed: 100 },
    { id: 2, url: 'https://other.com/', lastAccessed: 900 },
    { id: 3, url: 'https://box.ts.net/#c=x', lastAccessed: 500 },
    { id: 4, url: 'https://box.ts.net/', lastAccessed: 300 },
  ]),
  missing: await run([
    { id: 1, url: 'https://box.ts.net/' },
    { id: 2, url: 'https://box.ts.net/', lastAccessed: 50 },
    { id: 3, url: 'https://box.ts.net/' },
  ]),
  noneMissing: await run([{ id: 7, url: 'https://box.ts.net/a' }, { id: 8, url: 'https://box.ts.net/b' }]),
  none: await run([{ id: 1, url: 'https://other.com/', lastAccessed: 5 }]),
};
console.log(JSON.stringify(out));
"""

r = subprocess.run(['node', '--input-type=module', '-e', JS], cwd=REPO, capture_output=True, text=True)
if r.returncode:
    print(r.stdout, r.stderr); sys.exit(1)
d = json.loads(r.stdout.strip().splitlines()[-1])
check('most recently accessed matching tab wins (non-Digress tabs ignored)', d['recent'] == 3, d)
check('a tab without lastAccessed ranks last but is still usable', d['missing'] == 2, d)
check('no lastAccessed anywhere keeps the listed order', d['noneMissing'] == 7, d)
check('no matching tab gives null', d['none'] is None, d)
print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
sys.exit(1 if fails else 0)
