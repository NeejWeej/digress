"""The demo site (demo/build.mjs → GitHub Pages): the real page with demo/demo.js answering /api/* in the browser.
Built fresh from web/ here, so a change to the page that breaks the demo fails this test.
  - The build adds only the demo's scripts to the page, and leaves out the service worker.
  - A first visit opens the sample reading: the PDF and its branches, a note saying it's a demo, and "Demo" in the
    tab. A conversation without a document is there too. Flashcards are off, as by default; turning them on works.
  - The sample's suggested questions get the replies written for them, with page links. Its branches include a snip
    of the figure, and one that goes on after its takeaway (so it shows where the takeaway ends).
  - Other questions get the closest passages of the document, saying it's the demo; so do highlight branches.
  - Search, and Ask about Digress (from the documentation built into the site), work.
  - Everything stays in this browser across a reload; "Start over" brings back the sample as it was.
Asserts and exits non-zero."""
import asyncio, json, os, sys, tempfile
from playwright.async_api import async_playwright
from common import OUT, launch_args, build_site, goto_site, booted, answered, soon, frames, PDF_DRAWN_JS, settle

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

LAST = "(()=>{const b=[...document.querySelectorAll('.pane[data-tid=main] .msg.assistant .body')].at(-1);return b?b.innerText:''})()"
SELECT_PDF = """([page, phrase]) => { const tl = document.querySelector(`.dpage[data-page="${page}"] .textLayer`); if (!tl) return 'no text layer';
  const w = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT), nodes = []; let all = '', n;
  while ((n = w.nextNode())) { nodes.push([n, all.length]); all += n.nodeValue; }
  const i = all.indexOf(phrase); if (i < 0) return 'not found';
  const at = (k) => { let best = nodes[0]; for (const x of nodes) if (x[1] <= k) best = x; return [best[0], k - best[1]]; };
  const r = document.createRange(); r.setStart(...at(i)); r.setEnd(...at(i + phrase.length));
  const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); return 'ok'; }"""


async def main():
    with tempfile.TemporaryDirectory() as site:
        build_site(site)
        html = open(os.path.join(site, 'index.html'), encoding='utf-8').read()
        page = open(os.path.join(os.path.dirname(__file__), '..', 'web', 'index.html'), encoding='utf-8').read()
        check('the build is the real page plus the demo’s two scripts', html.replace('\n<script src="demo/replies.js"></script>\n<script src="demo/demo.js"></script>', '', 1) == page)
        sw = os.path.join(site, 'sw.js')
        check('…with its own service worker, not the app’s, the documentation and the sample', os.path.exists(sw)
              and open(sw, encoding='utf-8').read() == open(os.path.join(os.path.dirname(__file__), '..', 'demo', 'sw.js'), encoding='utf-8').read()
              and all(os.path.exists(os.path.join(site, 'demo', f)) for f in ('guide.json', 'seed.json', 'sample.pdf')))

        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            pg = await b.new_page(viewport={'width': 1500, 'height': 900})
            errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
            await goto_site(pg, site); await booted(pg); await pg.wait_for_function(PDF_DRAWN_JS)
            conv = await pg.evaluate("(()=>{const c=__digress.conv;return {title:c.title,threads:Object.keys(c.threads).length,msgs:Object.keys(c.msgs).length,doc:!!c.doc}})()")
            check('a first visit opens the sample conversation, with its document and branches', conv['title'].startswith('Bayes') and conv['doc'] and conv['threads'] == 4, conv)
            snip = await pg.evaluate("""(()=>{const c=__digress.conv,t=Object.values(c.threads).find(t=>t.anchorRegion);if(!t)return null;
              const a=(c.order[t.id]||[]).map(id=>c.msgs[id]).find(m=>m.role==='assistant');return {page:t.anchorPage,text:t.regionText||'',reply:a?(a.content||a.text||''):''}})()""")
            fp = await pg.evaluate("""(()=>{const c=__digress.conv,t=Object.values(c.threads).find(t=>/false-positive rate/.test(t.title||''));if(!t)return null;
              const last=c.order[t.id].map(id=>c.msgs[id]).filter(m=>m.role==='assistant').at(-1);return {id:t.id,last:(last.content||'').slice(0,60)}})()""")
            await pg.locator('#tree .mnode', has_text='false-positive rate').first.click(); await settle(pg, 800)
            cut = pg.locator(f'.pane[data-tid="{fp["id"]}"] .tkcut') if fp else None
            check('the false-positive branch goes on after its takeaway, and a line shows where the takeaway ends',
                  fp and fp['last'].startswith('Then a positive result means') and await cut.count() == 1, fp)
            check('…one of them a snip of Figure 1 (the tree), answered with a written reply', snip and snip['page'] == 0 and '990 healthy' in snip['text'] and snip['reply'].startswith('Read it from the top down'), snip and {k: str(v)[:80] for k, v in snip.items()})
            n0 = conv['msgs']
            check('…and the conversation without a document is in the sidebar too', await pg.locator('#side .citem[data-conv]').count() == 2)
            check('flashcards are off, as they are unless you turn them on', not await pg.locator('#reviewBtn').is_visible())
            check('the tab says it’s the demo', (await pg.title()).startswith('Demo · ') and (await pg.title()).endswith(' · Digress'), await pg.title())
            note = pg.locator('#demoNote')
            check('…and a note says it’s a demo, with Start over and a link to Digress', await note.is_visible() and 'demo of Digress' in await note.inner_text()
                  and await note.locator('[data-demo=reset]').first.is_visible() and await note.locator('a[href*="github.com"]').count() == 1)
            await pg.screenshot(path=OUT + '/demo.png')

            ta = pg.locator('.pane[data-tid=main] textarea')
            await ta.fill('Outline the sections with page references'); await answered(pg, ta.press('Enter'))
            last = await pg.evaluate(LAST)
            check('a suggested question gets the reply written for it', 'Counting instead of calculating' in last and 'demo' not in last.lower(), last[:200])
            check('…with page links', await pg.locator('.pane[data-tid=main] .msg.assistant').last.locator('a.pref').count() >= 5)

            await ta.fill('How do spam filters use this?'); await answered(pg, ta.press('Enter'))
            last = await pg.evaluate(LAST)
            check('another question gets the closest passages, quoted, and says it’s the demo', 'naive Bayes filter' in last and 'This is the demo' in last, last[:300])

            ok = await pg.evaluate(SELECT_PDF, [3, 'prosecutor’s fallacy'])
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill('What is this?'); await answered(pg, pg.locator('#popIn').press('Enter'))
            br = await pg.evaluate("(()=>{const b=[...document.querySelectorAll('.pane:not([data-tid=main]):not([data-tid=doc]) .msg.assistant .body')].at(-1);return b?b.innerText:''})()")
            check('a branch from a highlighted passage gets the passages around it', ok == 'ok' and 'innocent' in br and 'This is the demo' in br, [ok, br[:300]])

            await pg.keyboard.press('ControlOrMeta+k'); await pg.locator('#palIn').fill('prosecutor')
            await soon(pg, "()=>!!document.querySelector('#palRes .pr')")
            check('search works', await pg.locator('#palRes .pr').count() >= 1)
            await pg.keyboard.press('Escape'); await frames(pg)

            nb = await pg.locator('#demoNote').bounding_box()   # like a reader: drag the corner note out of the way of the ? beside How it works
            await pg.mouse.move(nb['x'] + 40, nb['y'] + 8); await pg.mouse.down()
            await pg.mouse.move(nb['x'] + 700, nb['y'] - 300, steps=8); await pg.mouse.up(); await frames(pg)
            await pg.locator('#guideB').click(); g = pg.locator('#guide.open')
            await g.locator('.gchips .chip').first.click()
            await soon(pg, "()=>{const a=[...document.querySelectorAll('#guide .gm.a')].at(-1);return a&&!a.classList.contains('wait')&&a.textContent.length>80}", timeout=15000)
            await soon(pg, "()=>document.querySelector('#guideSend').title==='Send'", timeout=15000)   # done: Stop turns back into Send
            ans = await g.locator('.gm.a').last.inner_text(); print('   (guide:', ans[:240].replace('\n', ' '), ')')
            check('Ask about Digress answers from the documentation built into the site', 'documentation' in ans and ('branch' in ans.lower()), ans[:300])
            await pg.keyboard.press('Escape')

            # turning flashcards on drafts the sample's cards into the inbox
            await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await pg.locator('#cardsModal.show').wait_for()
            await pg.locator('[data-kact=on]').click(); await soon(pg, "()=>/new/.test(document.querySelector('[data-kact=make]').textContent)")
            await pg.locator('[data-kact=make]').click()
            await soon(pg, "()=>document.querySelector('[data-kact=make]').textContent.includes('Up to date')", timeout=20000)
            await pg.keyboard.press('Escape')
            check('turning flashcards on drafts cards into the inbox', await soon(pg, "()=>/in inbox/.test(document.querySelector('#reviewBtn').textContent)"), await pg.locator('#reviewBtn').text_content())

            # the conversation without a document: its branches, a prepared reply, and quotes from itself otherwise
            await pg.locator('#side .citem[data-conv]', has_text='HTTPS').first.click()
            await soon(pg, "()=>__digress.conv.title.startsWith('How does HTTPS')")
            nested = await pg.evaluate("(()=>{const T=__digress.conv.threads;return Object.values(T).some(t=>t.parent&&t.parent!=='main'&&T[t.parent])})()")
            check('the conversation without a document has a branch of a branch', nested)
            check('…and the tab is named after it, marked as the demo', await soon(pg, "()=>/^Demo · How does HTTPS.* · Digress$/.test(document.title)"), await pg.title())
            await ta.fill('Why is symmetric encryption used for the data?'); await answered(pg, ta.press('Enter'))
            last = await pg.evaluate(LAST)
            check('another question there quotes what the conversation already says, and says it’s the demo', 'AES' in last and 'This is the demo' in last, last[:300])
            await pg.locator('#side .citem[data-conv]', has_text='Bayes').first.click()
            await soon(pg, "()=>__digress.conv.title.startsWith('Bayes')")

            # kept in this browser across a reload
            await soon(pg, "()=>__digress.sync.sent&&!document.querySelector('#status').textContent.includes('Saving')")
            await pg.wait_for_timeout(500)   # (deliberate: let the last save land)
            n1 = await pg.evaluate("Object.keys(__digress.conv.msgs).length")
            await pg.reload(); await booted(pg)
            await soon(pg, "()=>__digress.conv&&__digress.conv.title.startsWith('Bayes')")
            check('what you did is still there after a reload', await pg.evaluate("Object.keys(__digress.conv.msgs).length") == n1 and n1 > n0, [n0, n1])

            # a newer sample (a new seed published): it replaces the old one, with every card made from it
            cards = await pg.evaluate("fetch('api/store/cards').then(r=>r.json()).then(l=>l.length)")
            seed_path = os.path.join(site, 'demo', 'seed.json'); seed = json.load(open(seed_path))
            seed['v'] += '-newer'; json.dump(seed, open(seed_path, 'w'))
            await pg.reload(); await booted(pg); await soon(pg, "()=>__digress.conv&&__digress.conv.title.startsWith('Bayes')")
            left = await pg.evaluate("fetch('api/store/cards').then(r=>r.json()).then(l=>l.length)")
            check('a newer sample replaces the old, and the cards made from it go too (none left pointing at nothing)', cards > 0 and left == 0 and not await pg.locator('#reviewBtn').is_visible(), [cards, left])
            n0 = await pg.evaluate("Object.keys(__digress.conv.msgs).length")

            # Start over: back to the sample as it was
            pg.once('dialog', lambda d: asyncio.ensure_future(d.accept()))
            async with pg.expect_navigation():   # the reload, not the page before it (which also passes the check below)
                await note.locator('[data-demo=reset]').first.click()
            await pg.wait_for_function("!!window.__booted&&!!window.__digress&&!!__digress.conv&&__digress.conv.title.startsWith('Bayes')", timeout=30000)
            got = [await pg.evaluate("Object.keys(__digress.conv.msgs).length"), await pg.evaluate("document.querySelectorAll('#side .citem[data-conv]').length")]
            check('Start over brings back the sample as it was', got == [n0, 2] and not await pg.locator('#reviewBtn').is_visible(), [got, n0])

            # a shared .digress file opens in the demo, kept only in this browser: nothing but GETs leaves the page
            sent = []; pg.on('request', lambda r: sent.append((r.method, r.url)) if r.method != 'GET' else None)
            cid = await pg.evaluate("__digress.conv.id"); n_list = await pg.evaluate("__digress.convList.length")
            await pg.evaluate("id => document.querySelector(`[data-expconv='${id}']`).click()", cid); await pg.wait_for_selector('#modal.show')
            await pg.locator('#xDoc').check()
            async with pg.expect_download() as dl:
                await pg.locator('#mOk').click()
            shared = os.path.join(site, 'shared.digress'); await (await dl.value).save_as(shared)
            await pg.locator('#newDoc').click(); await pg.wait_for_selector('#docModal.show')
            await pg.locator('#docFile').set_input_files(shared)
            ok = await soon(pg, "([id, n]) => __digress.conv.id !== id && __digress.convList.length > n && __digress.conv.title.startsWith('Bayes')", [cid, n_list], timeout=20000)
            check('a .digress file opens in the demo as its own conversation', ok)
            check('…saying it’s kept only in this browser', await soon(pg, "()=>[...document.querySelectorAll('.toast')].some(t=>/only in this browser/.test(t.textContent))"))
            await pg.wait_for_function(PDF_DRAWN_JS)
            check('…with its document', await pg.evaluate("!!__digress.conv.doc.assetId && !__digress.conv.doc.left"))
            check('…and nothing was sent anywhere (no request but GETs)', not sent, sent[:5])

            # the note can be dragged out of the way (it can cover the keyboard shortcuts), and stays there
            box0 = await note.bounding_box()
            await pg.mouse.move(box0['x'] + 8, box0['y'] + box0['height'] - 6); await pg.mouse.down()
            await pg.mouse.move(box0['x'] + 500, box0['y'] - 300, steps=8); await pg.mouse.up()
            box1 = await note.bounding_box()
            check('the demo note can be dragged out of the way', box1['x'] > box0['x'] + 400 and box1['y'] < box0['y'] - 200, [box0, box1])
            await pg.reload(); await booted(pg)
            box2 = await pg.locator('#demoNote').bounding_box()
            check('…and stays there after a reload', abs(box2['x'] - box1['x']) < 3 and abs(box2['y'] - box1['y']) < 3, [box1, box2])

            # the note can be hidden completely, stays hidden across a reload, and comes back from the sidebar
            await note.locator('[data-demo=dismiss]').first.click(); await frames(pg)
            check('the demo note can be hidden completely', not await note.is_visible())
            await pg.reload(); await booted(pg)
            check('…and stays hidden after a reload', not await pg.locator('#demoNote').is_visible())
            await pg.locator('#demoSide [data-demo=toggle-note]').click(); await frames(pg)
            check('…and comes back from the sidebar', await pg.locator('#demoNote').is_visible())

            # Connections in the demo: Gemini BYOK with privacy/security/MIT notice and opt-in password encryption
            await pg.locator('#demoSide [data-demo=conn]').click()
            await pg.wait_for_selector('#connModal.show .cnrow[data-cid=gemini] .demo-byok-box')
            crow = pg.locator('#connModal .cnrow[data-cid=gemini]')
            ctext = await crow.inner_text()
            check('Connections offers browser-direct Gemini with privacy, security and MIT notices',
                  'directly from your browser' in ctext and 'MIT License' in ctext and await crow.locator('.demo-rem-cb').count() == 1)
            await crow.locator('.demo-rem-cb').check()
            check('…checking Remember reveals the encryption password input', await crow.locator('.demo-rem-pass').is_visible())
            await pg.locator('#connModal [data-cx=close]').click(); await frames(pg)

            # CSP header built into _headers drops 'unsafe-inline' from script-src and uses sha256 hashes
            headers_txt = open(os.path.join(site, '_headers')).read()
            csp_line = next((ln.split('Content-Security-Policy:', 1)[1].strip() for ln in headers_txt.splitlines() if 'Content-Security-Policy:' in ln), '')
            script_src = next((part.strip() for part in csp_line.split(';') if part.strip().startswith('script-src')), '')
            check('_headers CSP removes unsafe-inline from script-src and uses sha256 hashes',
                  "'unsafe-inline'" not in script_src and "'sha256-" in script_src, script_src)

            # Lock/Forget during an in-flight Gemini tool-call run aborts it and sends zero further Gemini requests;
            # Unlock vs Forget race keeps tab disconnected, deletes record, and falls back to demo replies.
            # Served on https://digress.test/digress/ (Secure Context for Web Crypto) with in-page fetch stub for Gemini.
            lock_ctx = await b.new_context(viewport={'width': 1280, 'height': 860}, ignore_https_errors=True, service_workers='block')
            lock_pg = await lock_ctx.new_page()
            lock_errs = []; lock_pg.on('pageerror', lambda e: lock_errs.append(str(e)))
            import mimetypes
            from common import BOOT_WATCH
            sec_url = 'https://digress.test/digress/'
            async def sec_route(r):
                u = r.request.url.split('#')[0].split('?')[0]
                if not u.startswith('http'): return await r.continue_()
                if u.startswith(sec_url):
                    f = os.path.join(site, u[len(sec_url):] or 'index.html')
                    if os.path.isdir(f): f = os.path.join(f, 'index.html')
                    if not os.path.isfile(f): return await r.fulfill(status=404, body='not found')
                    if f.endswith('index.html'):
                        h = open(f, encoding='utf-8').read().replace('<script src="demo/demo.js"></script>', '<script src="demo/demo.js"></script><script>' + BOOT_WATCH + '</script>', 1)
                        return await r.fulfill(body=h, content_type='text/html; charset=utf-8')
                    ct = 'text/javascript; charset=utf-8' if f.endswith('.js') else (mimetypes.guess_type(f)[0] or 'application/octet-stream')
                    return await r.fulfill(path=f, content_type=ct)
                return await r.abort()
            await lock_pg.add_init_script("""(() => {
                const origFetch = window.fetch.bind(window);
                window.__genCalls = 0;
                window.__holdUnlock = false;
                window.__unlockStarted = false;
                window.__releaseUnlock = null;
                window.fetch = async (input, init) => {
                    const u = typeof input === 'string' ? input : (input && input.url) || '';
                    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
                        if (u.includes('pageSize=1') && window.__holdUnlock) {
                            window.__unlockStarted = true;
                            await new Promise((r) => { window.__releaseUnlock = r; });
                        }
                        if (u.includes('/models?')) {
                            return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
                        }
                        if (u.includes(':streamGenerateContent')) {
                            window.__genCalls++;
                            const sse = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'tc1', name: 'search', args: { query: 'bayes' } } }] }, finishReason: 'STOP' }] }) + '\\n\\n';
                            return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
                        }
                    }
                    return origFetch(input, init);
                };
            })();""")
            await lock_pg.route('**/*', sec_route)
            await lock_pg.goto(sec_url); await booted(lock_pg)
            # Connect a fake Gemini key, start a chat with tools, hold the tool call, Lock/Disconnect, then release tool result
            res_lock = await lock_pg.evaluate("""async () => {
                const put = await fetch('api/connections/gemini', { method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({ key: 'fake-key-1234' }) });
                if (!put.ok) return { ok: false, step: 'put', status: put.status };
                const chatResp = await fetch('api/chat', {
                  method: 'POST', headers: {'content-type': 'application/json'},
                  body: JSON.stringify({ chat: 'chat-lock-1', model: 'gemini-2.5-flash', tools: ['search'], messages: [{ role: 'user', content: 'hi' }] })
                });
                const rd = chatResp.body.getReader(), dec = new TextDecoder();
                let buf = '', toolId = null;
                while (!toolId) {
                  const { value, done } = await rd.read();
                  if (done) break;
                  buf += dec.decode(value, { stream: true });
                  for (const ln of buf.split('\\n')) {
                    if (!ln.trim()) continue;
                    try { const o = JSON.parse(ln); if (o.tool && o.tool.id) toolId = o.tool.id; } catch {}
                  }
                }
                if (!toolId) return { ok: false, step: 'no-tool' };
                // Now disconnect/lock the key while the tool call is pending
                await fetch('api/connections/gemini', { method: 'DELETE' });
                // Attempt to deliver the tool result after locking
                const tr = await fetch('api/chat/tool', {
                  method: 'POST', headers: {'content-type': 'application/json'},
                  body: JSON.stringify({ chat: 'chat-lock-1', id: toolId, parts: [{ type: 'text', text: 'result' }] })
                });
                // Drain stream to completion
                while (!(await rd.read()).done) {}
                return { ok: true, toolStatus: tr.status, genCalls: window.__genCalls };
            }""")
            check('Lock/Forget aborts in-flight Gemini tool run and sends zero follow-up requests',
                  res_lock.get('ok') and res_lock.get('toolStatus') == 404 and res_lock.get('genCalls') == 1 and not lock_errs,
                  [res_lock, lock_errs[:2]])

            # Unlock vs Forget race: if Forget completes while Unlock is awaiting Google's key check,
            # the tab stays disconnected, the saved record stays absent, and chat falls back to demo replies.
            await lock_pg.evaluate("document.querySelector('#demoSide [data-demo=conn]').click()")
            if not await soon(lock_pg, "() => !!document.querySelector('#connModal.show .cnrow[data-cid=gemini] .cnkey')", timeout=10000):
                diag = await lock_pg.evaluate("({ secure: window.isSecureContext, subtle: !!(window.crypto && crypto.subtle), modal: (document.getElementById('connModal')||{}).className, html: (document.getElementById('connModal')||{}).innerText })")
                raise RuntimeError(f'Connections modal did not show key input: {diag}')
            await lock_pg.locator('#connModal .cnrow[data-cid=gemini] .cnkey').fill('race-key-9999')
            await lock_pg.locator('#connModal .cnrow[data-cid=gemini] .demo-rem-cb').check()
            await lock_pg.locator('#connModal .cnrow[data-cid=gemini] .demo-rem-pass').fill('pass1234')
            await lock_pg.locator('#connModal .cnrow[data-cid=gemini] [data-cx=add]').click()
            await soon(lock_pg, "() => !![...document.querySelectorAll('#connModal button')].find(b => b.textContent === 'Lock now') || !!document.querySelector('#connModal .cnerr')", timeout=25000)
            conn_err = await lock_pg.evaluate("(document.querySelector('#connModal .cnerr') || {}).textContent || ''")
            if conn_err:
                raise RuntimeError(f'Connect with Remember failed: {conn_err}')
            await lock_pg.locator('#connModal button', has_text='Lock now').click()
            await soon(lock_pg, "() => !!document.querySelector('#connModal .demo-unlock-pass')", timeout=10000)
            # Now hold the next validation response, start Unlock, run Forget while held, then release
            await lock_pg.evaluate("window.__holdUnlock = true; window.__unlockStarted = false; window.__releaseUnlock = null;")
            await lock_pg.locator('#connModal .demo-unlock-pass').fill('pass1234')
            await lock_pg.locator('#connModal [data-demo-unlock]').click()
            await soon(lock_pg, "() => !!window.__unlockStarted", timeout=15000)
            # Forget while Unlock is awaiting Google's validation
            await lock_pg.evaluate("fetch('api/connections/gemini', { method: 'DELETE' })")
            await lock_pg.evaluate("window.__releaseUnlock && window.__releaseUnlock()")
            await frames(lock_pg, 6)
            race_state = await lock_pg.evaluate("""async () => {
                const c = await (await fetch('api/connections')).json();
                const hasRec = await new Promise((ok) => {
                    const r = indexedDB.open('digress-demo', 1);
                    r.onsuccess = () => { const tx = r.result.transaction('kv', 'readonly'); const g = tx.objectStore('kv').get('byok/gemini'); g.onsuccess = () => ok(!!g.result); g.onerror = () => ok(false); };
                    r.onerror = () => ok(false);
                });
                const cr = await fetch('api/chat', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
                const txt = await cr.text();
                return { on: !!(c.providers[0] && c.providers[0].on), hasRec, usedDemo: txt.includes('"model":"demo"') };
            }""")
            check('Forget during in-flight Unlock keeps tab disconnected, deletes record, and uses demo replies',
                  race_state['on'] is False and race_state['hasRec'] is False and race_state['usedDemo'] is True, race_state)

            # Lock while response headers have arrived and the SSE body reader is paused releases the reader promptly
            await lock_ctx.close()
            pause_pg = await b.new_page(viewport={'width': 1280, 'height': 860})
            pause_errs = []; pause_pg.on('pageerror', lambda e: pause_errs.append(str(e)))
            await pause_pg.add_init_script("""(() => {
                const origFetch = window.fetch.bind(window);
                const enc = new TextEncoder();
                window.__bodyCancelled = false;
                window.fetch = async (input, init) => {
                    const u = typeof input === 'string' ? input : (input && input.url) || '';
                    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
                        if (u.includes('/models?')) {
                            return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
                        }
                        if (u.includes(':streamGenerateContent')) {
                            const stream = new ReadableStream({
                                start(c) {
                                    c.enqueue(enc.encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }) + '\\n\\n'));
                                    if (init && init.signal) {
                                        init.signal.addEventListener('abort', () => {
                                            window.__bodyCancelled = true;
                                            try { c.error(new DOMException('Aborted', 'AbortError')); } catch {}
                                        }, { once: true });
                                    }
                                },
                                cancel() { window.__bodyCancelled = true; },
                            });
                            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
                        }
                    }
                    return origFetch(input, init);
                };
            })();""")
            await goto_site(pause_pg, site); await booted(pause_pg)
            pause_res = await pause_pg.evaluate("""async () => {
                const put = await fetch('api/connections/gemini', { method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({ key: 'pause-key-1234' }) });
                if (!put.ok) return { ok: false, step: 'put', status: put.status };
                const resp = await fetch('api/chat', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ chat: 'chat-pause-1', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] }) });
                const rd = resp.body.getReader(), dec = new TextDecoder();
                let out = '', gotFirst = false;
                while (!gotFirst) {
                    const { value, done } = await rd.read();
                    if (done) break;
                    out += dec.decode(value, { stream: true });
                    if (out.includes('"hello"')) gotFirst = true;
                }
                // Headers have arrived and first chunk was read; body is now paused waiting for next chunk.
                // Lock/disconnect and ensure the stream terminates promptly.
                const t0 = Date.now();
                await fetch('api/connections/gemini', { method: 'DELETE' });
                for (;;) {
                    const { value, done } = await rd.read();
                    if (done) break;
                    out += dec.decode(value, { stream: true });
                }
                return { ok: true, gotFirst, cancelled: !!window.__bodyCancelled, stopped: out.includes('"stopped":"stop"'), elapsedMs: Date.now() - t0 };
            }""")
            check('Lock promptly aborts an already-open paused SSE response body',
                  pause_res.get('ok') and pause_res.get('gotFirst') and pause_res.get('cancelled') and pause_res.get('stopped') and pause_res.get('elapsedMs', 9999) < 3000 and not pause_errs,
                  [pause_res, pause_errs[:2]])
            await pause_pg.close()

            # a phone: the note can be made small
            ph = await b.new_page(viewport={'width': 390, 'height': 800})
            ph.on('pageerror', lambda e: errs.append(str(e)))
            await goto_site(ph, site); await booted(ph)
            await ph.locator('#demoNote .x').click()
            box = await ph.locator('#demoNote').bounding_box()
            check('on a phone the note can be made small', box and box['height'] < 40, box)
            await ph.screenshot(path=OUT + '/demo_phone.png')
            check('no page errors', not errs, errs[:3])
            await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
