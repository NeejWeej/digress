"""Regression tests for third code review fixes:
  1. Navigating away during a slow save preserves the latest edit via per-conversation save queue.
  2. Flashcard drafting / doc tool callbacks stay bound to their owning conversation & provider.
  3. Sidebar unpin retries on 409 so a concurrently added branch on another device is never lost.
  4. Export "Include the original link" defaults checked for query-free URLs, unchecked for tokenized URLs.
  5. Clipper matches exact origin + path boundary (never startsWith(origin)).
  6. Demo IndexedDB enforces atomic single-transaction revision checks and increments rev on PATCH.
  7. Fuzzy search prefix-bounded vocab scan still finds typos and transpositions.
Asserts and exits non-zero."""
import asyncio, json, os, subprocess, sys, tempfile, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright
from common import BOOT_WATCH, launch_args, goto_site, booted, soon
from test_server import start, req, FAKES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)


def test_clipper_origin_matching():
    script = r"""
    const fs = require('node:fs');
    const vm = require('node:vm');
    const src = fs.readFileSync('extension/background.js', 'utf8');
    const m = src.match(/function matchesDigressUrl\([\s\S]*?\n\}/);
    if (!m) throw new Error('matchesDigressUrl not found');
    const fn = vm.runInNewContext(m[0] + '; matchesDigressUrl', { URL });
    const cases = [
      ['http://localhost:8788/', 'http://localhost:8788', true],
      ['http://localhost:8788/#c=abc', 'http://localhost:8788', true],
      ['http://localhost:87880/', 'http://localhost:8788', false],
      ['https://box.ts.net.evil.com/', 'https://box.ts.net', false],
      ['https://box.ts.net/app', 'https://box.ts.net', true],
      ['https://example.com/digress/', 'https://example.com/digress/', true],
      ['https://example.com/digress/index.html', 'https://example.com/digress/', true],
      ['https://example.com/digress-other/', 'https://example.com/digress/', false],
      ['http://127.0.0.1:8788/', 'http://localhost:8788', false],
    ];
    for (const [tabUrl, cfgUrl, want] of cases) {
      const got = fn(tabUrl, cfgUrl);
      if (got !== want) throw new Error(`${tabUrl} vs ${cfgUrl}: got ${got}, want ${want}`);
    }
    console.log('ok');
    """
    r = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
    check('clipper matches exact origin and path boundary', r.returncode == 0 and 'ok' in r.stdout, r.stderr or r.stdout)


def test_fuzzy_search_prefix_vocab():
    script = r"""
    import { openDb } from './server/db.mjs';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digress-fuzzy-'));
    try {
      const db = openDb(dir);
      db.saveConv('c1', {
        id: 'c1', title: 'Consensus notes', created: 1, updated: 1,
        threads: { main: { id: 'main', parent: null, title: 'Main' } },
        order: { main: ['m1'] },
        msgs: { m1: { id: 'm1', thread: 'main', role: 'assistant', content: 'Quorum replication guarantees linearizability.' } },
      }, 0);
      db.putDoc('index', 'c1', {
        v: 2,
        e: [{ k: 'm', tid: 'main', mid: 'm1', p: 0, n: 0, o: 0, x: 'Quorum replication guarantees linearizability.' }],
      });
      const rExact = db.searchPassages('linearizability');
      const rMidTypo = db.searchPassages('linearizabilty');
      const rSwap = db.searchPassages('repliaction');     // middle transposition
      const rSwapFirst = db.searchPassages('erplication'); // first-two transposition -> probes 'e' and 'r' -> finds 'replication'
      if (!rExact.length) throw new Error('exact failed');
      if (!rMidTypo.length) throw new Error('mid typo failed');
      if (!rSwap.length) throw new Error('mid swap failed');
      if (!rSwapFirst.length) throw new Error('first-two swap failed');
      console.log('ok', { exact: rExact.length, mid: rMidTypo.length, swap: rSwap.length, swapFirst: rSwapFirst.length });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    """
    r = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, capture_output=True, text=True)
    check('fuzzy search prefix-bounded vocab scan finds typos and first-two transpositions',
          r.returncode == 0 and 'ok' in r.stdout, r.stderr or r.stdout)


async def run_browser_tests():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': FAKES + '/fake-claude.mjs', 'LLM_PROVIDER': 'claude-code'})
        try:
            # Seed conversations for tests 1, 2, 3, 4
            conv_a = {
                'id': 'c_slow_a', 'title': 'Initial A', 'titleKept': True, 'created': 10, 'updated': 10,
                'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                'order': {'main': ['u1', 'a1']},
                'msgs': {
                    'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Hello A', 'ts': 10},
                    'a1': {'id': 'a1', 'thread': 'main', 'role': 'assistant', 'content': 'Answer A', 'ts': 11},
                },
            }
            conv_b = {
                'id': 'c_slow_b', 'title': 'Conv B', 'titleKept': True, 'created': 20, 'updated': 20,
                'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                'order': {'main': ['u1', 'a1']},
                'msgs': {
                    'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Hello B', 'ts': 20},
                    'a1': {'id': 'a1', 'thread': 'main', 'role': 'assistant', 'content': 'Answer B', 'ts': 21},
                },
            }
            conv_pin = {
                'id': 'c_pin', 'title': 'Pinned conv', 'titleKept': True, 'created': 30, 'updated': 30,
                'threads': {
                    'main': {'id': 'main', 'parent': None, 'title': 'Main'},
                    'b1': {'id': 'b1', 'parent': 'main', 'anchorMsg': 'a1', 'anchorText': 'Alpha', 'title': 'Branch 1', 'pinned': True, 'colorIdx': 0},
                },
                'order': {'main': ['u1', 'a1'], 'b1': ['bu1', 'ba1']},
                'msgs': {
                    'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Q', 'ts': 30},
                    'a1': {'id': 'a1', 'thread': 'main', 'role': 'assistant', 'content': 'Alpha beta', 'ts': 31},
                    'bu1': {'id': 'bu1', 'thread': 'b1', 'role': 'user', 'content': 'About alpha', 'ts': 32},
                    'ba1': {'id': 'ba1', 'thread': 'b1', 'role': 'assistant', 'content': 'Alpha detail', 'ts': 33},
                },
            }
            conv_doc_clean = {
                'id': 'c_doc_clean', 'title': 'Public paper', 'titleKept': True, 'created': 40, 'updated': 40,
                'doc': {'kind': 'text', 'name': 'paper.md', 'text': 'Paper body.', 'source': 'https://arxiv.org/pdf/2401.12345.pdf'},
                'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                'order': {'main': ['u1']},
                'msgs': {'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Notes', 'ts': 40}},
            }
            conv_doc_tok = {
                'id': 'c_doc_tok', 'title': 'Signed paper', 'titleKept': True, 'created': 50, 'updated': 50,
                'doc': {'kind': 'text', 'name': 'secret.md', 'text': 'Secret body.', 'source': 'https://private.example/file.pdf?token=secret123'},
                'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                'order': {'main': ['u1']},
                'msgs': {'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Notes', 'ts': 50}},
            }
            for c in (conv_a, conv_b, conv_pin, conv_doc_clean, conv_doc_tok):
                st, _ = req(base, 'PUT', f"/api/store/convs/{c['id']}", c)
                assert st == 200

            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True, **launch_args())
                ctx = await browser.new_context(viewport={'width': 1280, 'height': 800}, service_workers='block')
                pg = await ctx.new_page()

                # Single route handler registered before navigation (avoids WebKit mid-session route/unroute races).
                route_state = {
                    'delay_slow_a': False,
                    'delay_count': 0,
                    'fail_slow_a': False,
                    'race_pin': False,
                    'race_done': False,
                }
                first_put_seen = asyncio.Event()
                release_first_put = asyncio.Event()
                put_failed_once = asyncio.Event()

                async def handle_conv_routes(route):
                    r = route.request
                    if r.method == 'PUT' and '/api/store/convs/c_slow_a' in r.url:
                        if route_state['delay_slow_a'] and route_state['delay_count'] == 0:
                            route_state['delay_count'] += 1
                            first_put_seen.set()
                            await release_first_put.wait()
                        elif route_state['fail_slow_a']:
                            put_failed_once.set()
                            await route.fulfill(status=500, content_type='application/json', body='{"error":"write failed"}')
                            return
                    elif r.method == 'PUT' and '/api/store/convs/c_pin' in r.url and route_state['race_pin'] and not route_state['race_done']:
                        route_state['race_done'] = True
                        _, raw = req(base, 'GET', '/api/store/convs/c_pin')
                        cur = json.loads(raw)
                        cur['threads']['b2'] = {'id': 'b2', 'parent': 'main', 'anchorMsg': 'a1', 'anchorText': 'beta', 'title': 'Branch 2', 'colorIdx': 1}
                        cur['order']['b2'] = ['b2u1', 'b2a1']
                        cur['msgs']['b2u1'] = {'id': 'b2u1', 'thread': 'b2', 'role': 'user', 'content': 'About beta', 'ts': 40}
                        cur['msgs']['b2a1'] = {'id': 'b2a1', 'thread': 'b2', 'role': 'assistant', 'content': 'Beta detail', 'ts': 41}
                        st2, _ = req(base, 'PUT', '/api/store/convs/c_pin', cur, headers={'x-base-rev': str(cur['rev'])})
                        assert st2 == 200
                    await route.continue_()

                await pg.route('**/api/store/convs/*', handle_conv_routes)
                await pg.add_init_script(BOOT_WATCH)
                await pg.goto(base + '/')
                await booted(pg)

                # --- Test 1: Navigating away during a slow save preserves latest edit ---
                await pg.locator('.citem[data-conv="c_slow_a"]').click()
                await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_slow_a'")

                route_state['delay_slow_a'] = True

                # First edit ("first edit"), trigger save
                await pg.evaluate("""() => {
                    __digress.conv.title = 'first edit';
                    document.querySelector('#cTitle').textContent = 'first edit';
                    __digress.refresh();
                }""")
                await asyncio.wait_for(first_put_seen.wait(), timeout=15)

                # Second edit while first PUT is still in flight
                await pg.evaluate("""() => {
                    __digress.conv.title = 'latest edit';
                    document.querySelector('#cTitle').textContent = 'latest edit';
                    __digress.refresh();
                }""")

                # Click Conv B, then release first PUT while navigation is waiting
                nav_task = asyncio.create_task(pg.locator('.citem[data-conv="c_slow_b"]').click())
                await asyncio.sleep(0.3)
                release_first_put.set()
                await nav_task
                await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_slow_b'")
                route_state['delay_slow_a'] = False

                # Poll backend until latest edit lands
                stored_title = None
                for _ in range(60):
                    _, raw = req(base, 'GET', '/api/store/convs/c_slow_a')
                    stored_title = json.loads(raw).get('title')
                    if stored_title == 'latest edit':
                        break
                    await asyncio.sleep(0.1)
                check('navigating away during a slow save persists the latest edit', stored_title == 'latest edit', stored_title)

                # --- Test 1b: Reopening after a failed background write preserves unsaved edit and retries ---
                await pg.locator('.citem[data-conv="c_slow_a"]').click()
                await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_slow_a'")
                route_state['fail_slow_a'] = True
                await pg.evaluate("""() => {
                    __digress.conv.title = 'failed bg edit';
                    document.querySelector('#cTitle').textContent = 'failed bg edit';
                    __digress.refresh();
                }""")
                await asyncio.wait_for(put_failed_once.wait(), timeout=15)
                # Leave anyway when prompted (since write failed)
                nav_b = asyncio.create_task(pg.locator('.citem[data-conv="c_slow_b"]').click())
                await pg.locator('#mOk').wait_for(state='visible', timeout=10000)
                await pg.locator('#mOk').click()
                await nav_b
                await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_slow_b'")

                # Reopen c_slow_a while PUTs still fail (GET still works!)
                await pg.locator('.citem[data-conv="c_slow_a"]').click()
                await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_slow_a'")
                reopened_title = await pg.evaluate("() => __digress.conv.title")
                # Restore writes and trigger online event so retry flushes immediately
                route_state['fail_slow_a'] = False
                await pg.evaluate("() => window.dispatchEvent(new Event('online'))")
                recovered_title = None
                for _ in range(60):
                    _, raw = req(base, 'GET', '/api/store/convs/c_slow_a')
                    recovered_title = json.loads(raw).get('title')
                    if recovered_title == 'failed bg edit':
                        break
                    await asyncio.sleep(0.1)
                check('reopening after a failed background write keeps unsaved edit and recovers when writes return',
                      reopened_title == 'failed bg edit' and recovered_title == 'failed bg edit',
                      {'reopened_title': reopened_title, 'recovered_title': recovered_title})

                # --- Test 2: runDocTool and regionRef/imageBlob reject cross-conversation access after switching ---
                await pg.locator('.citem[data-conv="c_doc_clean"]').click()
                await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_doc_clean' && __digress.docState && __digress.docState.loaded")
                await pg.locator('.citem[data-conv="c_doc_tok"]').click()
                await pg.wait_for_function("__digress.conv && __digress.conv.id === 'c_doc_tok' && __digress.docState && __digress.docState.loaded")
                tool_res = await pg.evaluate("() => __digress.runDocTool('read_pages', {from: 1}, [], 'c_doc_clean')")
                check('runDocTool refuses to read another conversation’s document after switching',
                      isinstance(tool_res, dict) and 'error' in tool_res and 'Secret body' not in json.dumps(tool_res),
                      tool_res)
                snip_err = await pg.evaluate("""async () => {
                    const { regionRef, imageBlob } = await import('/js/media.js');
                    const ref = regionRef({ anchorPage: 0, anchorRegion: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }, 'c_doc_clean');
                    try { await imageBlob(ref); return ''; } catch (e) { return String(e && e.message || e); }
                }""")
                check('regionRef/imageBlob refuses to render another conversation’s PDF after switching',
                      'no longer open' in snip_err, snip_err)

                # --- Test 3: Sidebar unpin retries on 409 and preserves concurrently created branch ---
                await pg.wait_for_function("__digress.conv && __digress.conv.id !== 'c_pin'")
                route_state['race_pin'] = True
                unpin_btn = pg.locator('[data-unpinb="c_pin|b1"]')
                await unpin_btn.wait_for(state='attached')
                await unpin_btn.click(force=True)
                await soon(pg, "() => !document.querySelector('[data-unpinb=\"c_pin|b1\"]')")
                route_state['race_pin'] = False

                _, raw_pin = req(base, 'GET', '/api/store/convs/c_pin')
                after_pin = json.loads(raw_pin)
                b1_unpinned = not after_pin['threads']['b1'].get('pinned')
                b2_kept = 'b2' in after_pin['threads'] and 'b2a1' in after_pin['msgs']
                check('sidebar unpin retries on 409 and preserves concurrently created branch',
                      route_state['race_done'] and b1_unpinned and b2_kept,
                      {'injected': route_state['race_done'], 'b1_unpinned': b1_unpinned, 'threads': list(after_pin['threads'].keys())})

                # --- Test 4: Export "Include the original link" checkbox defaults & stripping ---
                await pg.locator('[data-expconv="c_doc_clean"]').click(force=True)
                await pg.locator('#xDocSrc').wait_for(state='visible')
                clean_checked = await pg.locator('#xDocSrc').is_checked()
                await pg.locator('#mCancel').click()
                check('export original-link checkbox is checked by default for query-free URLs', clean_checked)

                await pg.locator('[data-expconv="c_doc_tok"]').click(force=True)
                await pg.locator('#xDocSrc').wait_for(state='visible')
                tok_checked = await pg.locator('#xDocSrc').is_checked()
                # Switch to shareable link, check "Include the document", and verify "Include the original link" stays visible & unchecked and token is omitted
                await pg.locator('input[name="xfmt"][value="link"]').check()
                await pg.locator('#xLDoc').check()
                await pg.wait_for_function("() => { const b = document.querySelector('#mOk'); return b && !b.disabled; }")
                tok_link_row_visible = await pg.locator('#xLDocSrcRow').is_visible()
                tok_link_checked = await pg.locator('#xLDocSrc').is_checked()
                # Intercept clipboard copy to inspect share link payload
                await pg.evaluate("""() => {
                    window.__copiedShare = '';
                    navigator.clipboard.writeText = async (t) => { window.__copiedShare = t; };
                }""")
                await pg.locator('#mOk').click()
                await soon(pg, "() => !!window.__copiedShare")
                share_url = await pg.evaluate("() => window.__copiedShare")
                share_info = await pg.evaluate("""async (url) => {
                    const hash = new URL(url).hash;
                    const token = hash.slice('#share='.length).replace(/-/g, '+').replace(/_/g, '/');
                    const pad = token + '='.repeat((4 - token.length % 4) % 4);
                    const bytes = Uint8Array.from(atob(pad), c => c.charCodeAt(0));
                    const ds = new DecompressionStream('gzip');
                    const w = ds.writable.getWriter(); w.write(bytes); w.close();
                    const text = await new Response(ds.readable).text();
                    return { hasSecret: text.includes('secret123'), hasBody: text.includes('Secret body.') };
                }""", share_url)
                check('exporting with Include the document checked still omits unchecked tokenized source URL',
                      (not tok_checked) and tok_link_row_visible and (not tok_link_checked) and share_info['hasBody'] and (not share_info['hasSecret']),
                      {'tok_checked': tok_checked, 'tok_link_row_visible': tok_link_row_visible, 'tok_link_checked': tok_link_checked, **share_info})

                await browser.close()
        finally:
            proc.terminate()


async def test_demo_atomic_rev():
    with tempfile.TemporaryDirectory() as out:
        r = subprocess.run(['node', os.path.join(ROOT, 'demo', 'build.mjs'), out], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, **launch_args())
            ctx = await browser.new_context(viewport={'width': 1280, 'height': 800})
            pg = await ctx.new_page()
            await goto_site(pg, out)
            await booted(pg)

            res = await pg.evaluate("""async () => {
                const baseConv = {
                    id: 'c_race', title: 'Base', created: 1, updated: 1,
                    threads: { main: { id: 'main', parent: null, title: 'Main' } },
                    order: { main: [] }, msgs: {},
                };
                const r0 = await fetch('api/store/convs/c_race', {
                    method: 'PUT', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(baseConv),
                });
                const j0 = await r0.json();
                const [r1, r2] = await Promise.all([
                    fetch('api/store/convs/c_race', {
                        method: 'PUT', headers: { 'content-type': 'application/json', 'x-base-rev': String(j0.rev) },
                        body: JSON.stringify({ ...baseConv, title: 'Writer 1' }),
                    }),
                    fetch('api/store/convs/c_race', {
                        method: 'PUT', headers: { 'content-type': 'application/json', 'x-base-rev': String(j0.rev) },
                        body: JSON.stringify({ ...baseConv, title: 'Writer 2' }),
                    }),
                ]);
                const statuses = [r1.status, r2.status].sort();
                const afterPut = await (await fetch('api/store/convs/c_race')).json();
                const rp = await fetch('api/store/convs/c_race', {
                    method: 'PATCH', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ pinned: true }),
                });
                const afterPatch = await (await fetch('api/store/convs/c_race')).json();
                return { rev0: j0.rev, statuses, revAfterPut: afterPut.rev, patchStatus: rp.status, revAfterPatch: afterPatch.rev, pinned: afterPatch.pinned };
            }""")
            check('demo IndexedDB allows only one concurrent writer per revision and increments rev on PATCH',
                  res['rev0'] == 1 and res['statuses'] == [200, 409] and res['revAfterPut'] == 2 and res['patchStatus'] == 200 and res['revAfterPatch'] == 3 and res['pinned'] is True,
                  res)
            await browser.close()


async def main():
    test_clipper_origin_matching()
    test_fuzzy_search_prefix_vocab()
    await run_browser_tests()
    await test_demo_atomic_rev()
    if fails:
        print('FAILED:', fails)
        sys.exit(1)

if __name__ == '__main__':
    asyncio.run(main())
