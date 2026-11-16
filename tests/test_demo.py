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
from common import OUT, launch_args, build_site, goto_site, booted, answered, soon, frames, PDF_DRAWN_JS

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
        check('…without the service worker, with the documentation and the sample', not os.path.exists(os.path.join(site, 'sw.js'))
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
            await pg.locator('#tree .mnode', has_text='false-positive rate').first.click(); await pg.wait_for_timeout(800)
            cut = pg.locator(f'.pane[data-tid="{fp["id"]}"] .tkcut') if fp else None
            check('the false-positive branch goes on after its takeaway, and a line shows where the takeaway ends',
                  fp and fp['last'].startswith('Then a positive result means') and await cut.count() == 1, fp)
            check('…one of them a snip of Figure 1 (the tree), answered with a written reply', snip and snip['page'] == 0 and '990 healthy' in snip['text'] and snip['reply'].startswith('Read it from the top down'), snip and {k: str(v)[:80] for k, v in snip.items()})
            n0 = conv['msgs']
            check('…and the conversation without a document is in the sidebar too', await pg.locator('#side .citem[data-conv]').count() == 2)
            check('flashcards are off, as they are unless you turn them on', not await pg.locator('#reviewBtn').is_visible())
            check('the tab says it’s the demo', (await pg.title()).startswith('Demo · Digress'), await pg.title())
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
            check('…and the tab follows the page’s own naming', await soon(pg, "()=>/^Demo · Digress \\d/.test(document.title)"), await pg.title())
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
