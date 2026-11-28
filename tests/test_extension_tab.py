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
let sent = [], madeTabs = [], scripted = [], store = {}, deliverReply = { ok: true, convTitle: 'Conv', branchTitle: 'Branch A', convId: 'c1', threadId: 'tA' };
const noop = () => {};
const listeners = {};
const ev = (name) => ({ addListener: (f) => { (listeners[name] ||= []).push(f); }, removeListener: noop });
const chrome = {
  tabs: {
    query: async (q) => { menuCalls.push({ q }); if (queryFails) throw new Error('boom'); return tabs; },
    onUpdated: ev('tabs.onUpdated'), onActivated: ev('tabs.onActivated'),
    create: async (o) => { madeTabs.push(o); return { id: 99, url: o.url }; }, update: noop,
    get: (id, cb) => { const t = tabs.find((x) => x.id === id) || { id, url: 'https://x.com/home', status: 'complete' }; return cb ? cb(t) : Promise.resolve(t); },
    sendMessage: async (id, msg) => { sent.push({ id, msg }); if (msg.type === 'extractTweet') return { ok: true, payload: { title: 't', url: 'https://x.com/a/status/1', text: 'hi', tweetCount: 1 } }; return deliverReply; },
  },
  scripting: { executeScript: async (o) => { scripted.push(o); return [{ result: { title: 'p', url: 'https://example.com/', text: 'body' } }]; } },
  action: { onClicked: ev('action.onClicked'), setBadgeText: noop, setBadgeBackgroundColor: noop },
  runtime: { onMessage: ev('onMessage'), onInstalled: ev('onInstalled'), onStartup: ev('onStartup'), lastError: null },
  contextMenus: {
    onClicked: ev('menu.onClicked'),
    create: (o) => menuCalls.push({ create: o }),
    update: (id, o, cb) => { menuCalls.push({ update: id, props: o }); if (cb) cb(); },
    removeAll: (cb) => cb && cb(),
  },
  commands: { onCommand: ev('onCommand') },
  storage: { local: { get: async () => ({ ...store }) } },
  windows: { update: async () => {}, onFocusChanged: ev('win.onFocusChanged'), WINDOW_ID_NONE: -1 },
};
const ctx = { chrome, URL, console, setTimeout, clearTimeout, self: {} };
ctx.self = ctx; ctx.importScripts = () => {};
vm.createContext(ctx);
vm.runInContext(readFileSync('./extension/rules.js', 'utf8'), ctx);
ctx.importScripts = () => {};
vm.runInContext(readFileSync('./extension/background.js', 'utf8') +
  '\n;this.__find = findDigressTab; this.__X = X_PATTERNS; this.__on = onTweetMenuPage; this.__choice = menuChoice; this.__plain = PLAIN_IDS;', ctx);
const U = 'https://box.ts.net';
const run = async (list) => { tabs = list; const t = await ctx.__find(U); return t ? t.id : null; };
const flush = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
const fire = async (name, ...args) => { menuCalls = []; for (const f of listeners[name] || []) f(...args); await settle(); return menuCalls; };
const visUpdates = (calls) => calls.filter((c) => c.update === 'digress-auto').map((c) => c.props.visible);
const visById = (calls) => { const o = {}; for (const c of calls) if (c.update) (o[c.update] ||= []).push(c.props.visible); return o; };
const visFor = async (url, { fails = false } = {}) => {
  tabs = url === 'NOTAB' ? [] : [{ id: 1, url, active: true }]; queryFails = fails;
  const v = visUpdates(await fire('tabs.onActivated', { tabId: 1 })); queryFails = false; return v;
};
const visAllFor = async (url) => { tabs = [{ id: 1, url, active: true }]; return visById(await fire('tabs.onActivated', { tabId: 1 })); };
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
out.menu = rb.filter((c) => c.create).map((c) => c.create);
out.rebuildVisAll = visById(rb);
const lastIdx = (f) => rb.map((c, i) => (f(c) ? i : -1)).filter((i) => i >= 0).pop();
out.updateAfterCreates = lastIdx((c) => c.update === 'digress-auto') > lastIdx((c) => c.create);
out.queryUsed = rb.find((c) => c.q).q;
// visibility per URL
out.vis = {};
for (const u of ['https://x.com/home', 'https://twitter.com/a/status/1', 'https://www.x.com/home', 'https://example.com/', '', 'NOTAB'])
  out.vis[u] = await visFor(u);
tabs = [{ id: 1, active: true }]; out.vis.undef = visUpdates(await fire('tabs.onActivated', {}));
out.vis.rejects = await visFor('https://x.com/home', { fails: true });
out.plain = ctx.__plain;
out.visAll = {};
for (const u of ['https://x.com/home', 'https://twitter.com/a/status/1', 'https://www.x.com/home', 'https://example.com/', ''])
  out.visAll[u] = await visAllFor(u);
// menuChoice
out.choice = {};
for (const id of ['digress-x-single', 'digress-x-thread', 'digress-auto', 'digress-thread', 'digress-thread-x-single', 'digress-thread-x-thread',
  'digress-current', 'digress-current-x-single', 'digress-current-x-thread', 'digress-doc', 'digress-doc-x-single', 'digress-doc-x-thread',
  'digress-root', 'digress-sep', 'digress-thread-x', 'digress-bogus-x-thread', 'other-id', 'digress-thread-x-thread-extra'])
  out.choice[id] = ctx.__choice(id);
out.choiceNum = ctx.__choice(undefined);
// clicking
const click = async (id, tab = { id: 5, url: 'https://x.com/home' }) => {
  sent = []; madeTabs = []; scripted = [];
  for (const f of listeners['menu.onClicked'] || []) f({ menuItemId: id }, tab);
  for (let i = 0; i < 30; i++) await flush();
  const deliver = sent.filter((s) => s.msg.type === 'deliverClip');
  return { extract: sent.filter((s) => s.msg.type === 'extractTweet').map((s) => s.msg), deliver: deliver.map((s) => ({ id: s.id, payload: s.msg.payload })),
    created: madeTabs.length, toasts: scripted.filter((s) => s.func && s.func.name === 'showInPageToast').map((s) => s.args[0]) };
};
store = { digressUrl: U, showToast: true };
tabs = [{ id: 1, url: 'https://other.com/' }];
out.clickNoTab = await click('digress-thread-x-thread');
out.clickNoTabSingle = await click('digress-thread-x-single');
out.clickNoTabPlain = await click('digress-thread');
tabs = [{ id: 1, url: 'https://other.com/' }, { id: 2, url: 'https://box.ts.net/', lastAccessed: 1 }];
out.clickTab = await click('digress-thread-x-thread');
out.clickCurrent = await click('digress-current-x-single');
out.clickXSingle = await click('digress-x-single');
store = { digressUrl: U, showToast: true, xThreadMode: 'thread' };
out.clickAutoThreadMode = await click('digress-auto');
store = { digressUrl: U, showToast: true };
out.clickAutoDefault = await click('digress-auto');
out.clickUnknown = await click('digress-root');
tabs = [];
out.clickDocNoTab = await click('digress-doc-x-thread');
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
M = d['menu']; byId = {m.get('id'): m for m in M}
ids = [m.get('id') for m in M]
check('menu items in order (root, X items, auto, separator, then each destination with its two children)',
      ids == ['digress-root', 'digress-x-single', 'digress-x-thread', 'digress-auto', 'digress-sep',
              'digress-thread-x', 'digress-thread-x-single', 'digress-thread-x-thread', 'digress-thread',
              'digress-current-x', 'digress-current-x-single', 'digress-current-x-thread', 'digress-current',
              'digress-doc-x', 'digress-doc-x-single', 'digress-doc-x-thread', 'digress-doc'], ids)
check('titles', [byId[i].get('title') for i in ids if i != 'digress-sep'] == [
      'Send to Digress', 'Send just this tweet', 'Send thread up to here', 'Send selection or page',
      'Add to current thread', 'Just this tweet', 'Thread up to here', 'Add to current thread',
      'Branch in current conversation', 'Just this tweet', 'Thread up to here', 'Branch in current conversation',
      'New document conversation', 'Just this tweet', 'Thread up to here', 'New document conversation'], [byId[i].get('title') for i in ids])
check('separator is a separator under the root', byId['digress-sep'].get('type') == 'separator' and byId['digress-sep']['parentId'] == 'digress-root', byId['digress-sep'])
exp_parent = {'digress-x-single': 'digress-root', 'digress-x-thread': 'digress-root', 'digress-auto': 'digress-root',
  'digress-thread-x': 'digress-root', 'digress-thread': 'digress-root', 'digress-current-x': 'digress-root', 'digress-current': 'digress-root',
  'digress-doc-x': 'digress-root', 'digress-doc': 'digress-root'}
for k in ['thread', 'current', 'doc']:
    exp_parent[f'digress-{k}-x-single'] = f'digress-{k}-x'; exp_parent[f'digress-{k}-x-thread'] = f'digress-{k}-x'
check('parents: submenus under their destination, the rest under the root',
      all(byId[i].get('parentId') == p for i, p in exp_parent.items()) and 'parentId' not in byId['digress-root'], {i: byId[i].get('parentId') for i in ids})
x_only = {'digress-x-single', 'digress-x-thread'} | {f'digress-{k}-x{suf}' for k in ['thread', 'current', 'doc'] for suf in ['', '-single', '-thread']}
check('exactly the X items (and submenus) carry the X patterns; the plain ones carry none',
      all((byId[i].get('documentUrlPatterns') == pats) == (i in x_only) for i in ids if i != 'digress-sep')
      and all('documentUrlPatterns' not in byId[i] for i in ['digress-root', 'digress-auto', 'digress-thread', 'digress-current', 'digress-doc', 'digress-sep']), {i: byId[i].get('documentUrlPatterns') for i in ids})
check('PLAIN_IDS is auto plus the three plain destinations', d['plain'] == ['digress-auto', 'digress-thread', 'digress-current', 'digress-doc'], d['plain'])
VA = d['visAll']
check('syncSendItem toggles every plain item (hidden on x.com / twitter.com)',
      all(VA[u] == {i: [False] for i in d['plain']} for u in ['https://x.com/home', 'https://twitter.com/a/status/1']), VA)
check('syncSendItem shows every plain item on www.x.com, other sites and an empty url',
      all(VA[u] == {i: [True] for i in d['plain']} for u in ['https://www.x.com/home', 'https://example.com/', '']), VA)
check('rebuild syncs every plain item', d['rebuildVisAll'] == {i: [False] for i in d['plain']}, d['rebuildVisAll'])
C = d['choice']
R_THREAD = {'mode': 'branch', 'useCurrentConv': True, 'useCurrentThread': True, 'focus': False, 'needTab': True}
R_CUR = {'mode': 'branch', 'useCurrentConv': True, 'focus': False}
R_DOC = {'mode': 'doc', 'focus': True}
exp = {'digress-x-single': (False, None), 'digress-x-thread': (True, None), 'digress-auto': (None, None),
  'digress-thread': (None, R_THREAD), 'digress-thread-x-single': (False, R_THREAD), 'digress-thread-x-thread': (True, R_THREAD),
  'digress-current': (None, R_CUR), 'digress-current-x-single': (False, R_CUR), 'digress-current-x-thread': (True, R_CUR),
  'digress-doc': (None, R_DOC), 'digress-doc-x-single': (False, R_DOC), 'digress-doc-x-thread': (True, R_DOC)}
for i, (it, rule) in exp.items():
    check(f'menuChoice {i}', C[i] == {'includeThread': it, 'rule': rule}, C[i])
check('menuChoice: root, separator, a submenu parent, unknown destinations and other ids give null',
      all(C[i] is None for i in ['digress-root', 'digress-sep', 'digress-thread-x', 'digress-bogus-x-thread', 'other-id', 'digress-thread-x-thread-extra']) and d['choiceNum'] is None, C)
def toast(r): return r['toasts'][0] if r['toasts'] else None
k = d['clickNoTab']
check('thread item, no Digress tab: asks the tweet for the thread, opens no tab, delivers nothing',
      k['extract'] == [{'type': 'extractTweet', 'includeThread': True}] and k['created'] == 0 and k['deliver'] == [], k)
check('thread item, no Digress tab: an error toast says to open Digress first',
      toast(k) and toast(k)['ok'] is False and 'Open Digress first' in toast(k)['text'], k['toasts'])
check('the same for "Just this tweet" (includeThread false) and the plain "Add to current thread"',
      d['clickNoTabSingle']['extract'] == [{'type': 'extractTweet', 'includeThread': False}] and d['clickNoTabSingle']['created'] == 0
      and d['clickNoTabSingle']['deliver'] == [] and 'Open Digress first' in (toast(d['clickNoTabSingle']) or {}).get('text', '')
      and d['clickNoTabPlain']['created'] == 0 and d['clickNoTabPlain']['deliver'] == [], (d['clickNoTabSingle'], d['clickNoTabPlain']))
k = d['clickTab']
P = k['deliver'][0]['payload'] if k['deliver'] else {}
check('thread item with a Digress tab open: sends deliverClip to that tab without creating one',
      len(k['deliver']) == 1 and k['deliver'][0]['id'] == 2 and k['created'] == 0 and k['extract'] == [{'type': 'extractTweet', 'includeThread': True}], k)
check('payload: mode branch, useCurrentConv and useCurrentThread, text from the tweet',
      P.get('mode') == 'branch' and P.get('useCurrentConv') is True and P.get('useCurrentThread') is True and P.get('text') == 'hi', P)
check('success toast names the branch and says it is not sent yet',
      toast(k) and toast(k)['ok'] and 'Added to “Branch A”' in toast(k)['text'] and 'Conv' in toast(k)['text'] and 'Not sent yet' in toast(k)['text'], k['toasts'])
P = d['clickCurrent']['deliver'][0]['payload'] if d['clickCurrent']['deliver'] else {}
check('"Branch in current conversation" keeps its old behaviour: useCurrentConv, not useCurrentThread, "Clipped to" toast',
      P.get('useCurrentConv') is True and 'useCurrentThread' not in P and d['clickCurrent']['extract'] == [{'type': 'extractTweet', 'includeThread': False}]
      and (toast(d['clickCurrent']) or {}).get('text', '').startswith('Clipped to'), d['clickCurrent'])
check('digress-x-single / digress-x-thread use the site rule (no useCurrentThread) with their own scope',
      d['clickXSingle']['extract'] == [{'type': 'extractTweet', 'includeThread': False}]
      and 'useCurrentThread' not in d['clickXSingle']['deliver'][0]['payload'], d['clickXSingle'])
check('digress-auto follows the xThreadMode default (single, or thread when set)',
      d['clickAutoDefault']['extract'] == [{'type': 'extractTweet', 'includeThread': False}]
      and d['clickAutoThreadMode']['extract'] == [{'type': 'extractTweet', 'includeThread': True}], (d['clickAutoDefault'], d['clickAutoThreadMode']))
check('an unknown item (the root) does nothing', d['clickUnknown']['extract'] == [] and d['clickUnknown']['deliver'] == [] and d['clickUnknown']['created'] == 0, d['clickUnknown'])
check('"New document conversation" still opens a tab when none exists (only needTab rules don\'t)', d['clickDocNoTab']['created'] == 1, d['clickDocNoTab'])
print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
sys.exit(1 if fails else 0)
