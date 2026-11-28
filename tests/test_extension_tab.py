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
let tabs = [], queryFails = false, menuCalls = [];
const noop = () => {};
const listeners = {};
const ev = (name) => ({ addListener: (f) => { (listeners[name] ||= []).push(f); }, removeListener: noop });
const chrome = {
  tabs: {
    query: async (q) => { menuCalls.push({ q }); if (queryFails) throw new Error('boom'); return tabs; },
    onUpdated: ev('tabs.onUpdated'), onActivated: ev('tabs.onActivated'),
    create: noop, update: noop, get: noop, sendMessage: noop,
  },
  runtime: { onMessage: ev('onMessage'), onInstalled: ev('onInstalled'), onStartup: ev('onStartup'), lastError: null },
  contextMenus: {
    onClicked: ev('menu.onClicked'),
    create: (o) => menuCalls.push({ create: o }),
    update: (id, o, cb) => { menuCalls.push({ update: id, props: o }); if (cb) cb(); },
    removeAll: (cb) => cb && cb(),
  },
  commands: { onCommand: ev('onCommand') },
  action: { onClicked: ev('action.onClicked') },
  storage: { local: { get: async () => ({}) } },
  windows: { update: async () => {}, onFocusChanged: ev('win.onFocusChanged'), WINDOW_ID_NONE: -1 },
};
const ctx = { chrome, URL, console, setTimeout, clearTimeout, self: {} };
ctx.self = ctx; ctx.importScripts = () => {};
vm.createContext(ctx);
vm.runInContext(readFileSync('./extension/rules.js', 'utf8'), ctx);
ctx.importScripts = () => {};
vm.runInContext(readFileSync('./extension/background.js', 'utf8') +
  '\n;this.__find = findDigressTab; this.__X = X_PATTERNS; this.__on = onTweetMenuPage;', ctx);
const U = 'https://box.ts.net';
const run = async (list) => { tabs = list; const t = await ctx.__find(U); return t ? t.id : null; };
const flush = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
const fire = async (name, ...args) => { menuCalls = []; for (const f of listeners[name] || []) f(...args); await settle(); return menuCalls; };
const visUpdates = (calls) => calls.filter((c) => c.update === 'digress-auto').map((c) => c.props.visible);
const visFor = async (url, { fails = false } = {}) => {
  tabs = url === 'NOTAB' ? [] : [{ id: 1, url, active: true }]; queryFails = fails;
  const v = visUpdates(await fire('tabs.onActivated', { tabId: 1 })); queryFails = false; return v;
};
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
// rebuild
tabs = [{ id: 1, url: 'https://x.com/home', active: true }];
const rb = await fire('onInstalled');
const created = Object.fromEntries(rb.filter((c) => c.create).map((c) => [c.create.id, c.create]));
out.auto = created['digress-auto'] || null;
out.xt = created['digress-x-thread'] || null;
out.xs = created['digress-x-single'] || null;
out.rebuildVis = visUpdates(rb);
const lastIdx = (f) => rb.map((c, i) => (f(c) ? i : -1)).filter((i) => i >= 0).pop();
out.updateAfterCreates = lastIdx((c) => c.update === 'digress-auto') > lastIdx((c) => c.create);
out.queryUsed = rb.find((c) => c.q).q;
// visibility per URL
out.vis = {};
for (const u of ['https://x.com/home', 'https://twitter.com/a/status/1', 'https://www.x.com/home', 'https://example.com/', '', 'NOTAB'])
  out.vis[u] = await visFor(u);
tabs = [{ id: 1, active: true }]; out.vis.undef = visUpdates(await fire('tabs.onActivated', {}));
out.vis.rejects = await visFor('https://x.com/home', { fails: true });
// events
tabs = [{ id: 1, url: 'https://x.com/home', active: true }];
out.onFocus = visUpdates(await fire('win.onFocusChanged', 5));
out.onFocusNone = visUpdates(await fire('win.onFocusChanged', -1));
out.onUpdUrl = visUpdates(await fire('tabs.onUpdated', 1, { url: 'https://x.com/home' }, { active: true }));
out.onUpdComplete = visUpdates(await fire('tabs.onUpdated', 1, { status: 'complete' }, { active: true }));
out.onUpdInactive = visUpdates(await fire('tabs.onUpdated', 1, { url: 'https://x.com/home' }, { active: false }));
out.onUpdOther = visUpdates(await fire('tabs.onUpdated', 1, { title: 'x' }, { active: true }));
// patterns vs onTweetMenuPage
const re = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const res = ctx.__X.map(re);
out.drift = ['https://x.com/', 'https://x.com/home', 'https://twitter.com/', 'https://twitter.com/a/status/1',
  'https://www.x.com/home', 'https://mobile.twitter.com/a', 'http://x.com/home', 'https://notx.com/', 'https://x.com.evil.com/',
  'https://example.com/x.com/', 'https://example.com/?u=https://x.com/', '']
  .filter((u) => !!ctx.__on(u) !== res.some((r) => r.test(u)));
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
check('rebuild creates "Send selection or page" under the root',
      d['auto'] and d['auto']['title'] == 'Send selection or page' and d['auto']['parentId'] == 'digress-root', d['auto'])
pats = ['https://x.com/*', 'https://twitter.com/*']
check('both tweet items are limited to x.com and twitter.com',
      d['xt'] and d['xs'] and d['xt']['documentUrlPatterns'] == pats and d['xs']['documentUrlPatterns'] == pats, (d['xt'], d['xs']))
check('rebuild then syncs the send item (after creating, active tab on x.com hides it)',
      d['rebuildVis'] == [False] and d['updateAfterCreates'] and d['queryUsed'] == {'active': True, 'lastFocusedWindow': True}, d)
V = d['vis']
check('send item hidden on x.com and twitter.com pages', V['https://x.com/home'] == [False] and V['https://twitter.com/a/status/1'] == [False], V)
check('send item shown on www.x.com, other sites, empty/missing url, no tab',
      all(V[k] == [True] for k in ['https://www.x.com/home', 'https://example.com/', '', 'undef', 'NOTAB']), V)
check('send item shown when the tab query rejects', V['rejects'] == [True], V)
check('focus change, active-tab url change and load complete re-sync the item',
      d['onFocus'] == [False] and d['onUpdUrl'] == [False] and d['onUpdComplete'] == [False], d)
check('WINDOW_ID_NONE, inactive-tab updates and unrelated changes do not',
      d['onFocusNone'] == [] and d['onUpdInactive'] == [] and d['onUpdOther'] == [], d)
check('onTweetMenuPage and the tweet items patterns agree on every URL', d['drift'] == [], d['drift'])
print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
sys.exit(1 if fails else 0)
