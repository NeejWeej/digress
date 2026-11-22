"""Search where you are: ⌘K searches everywhere; Tab (or the chips) narrows it to this conversation or to one
thread; the magnifier in a pane's floating buttons opens search already narrowed to that thread. Results
outside the scope don't show, and opening one lands in its thread. Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, settle
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;
  const out=q.includes('Branch q')?'The branch reply: a quokka lives on Rottnest Island.':q.includes('Other q')?'Elsewhere, a quokka story.':'The main reply: the quokka is a small marsupial.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Other q about animals'); await answered(pg, ta.press('Enter'))
        other = await pg.evaluate('__digress.conv.id')
        await pg.locator('#newConv').click(); await pg.wait_for_function("id=>__digress.conv.id!==id", arg=other)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Main q about marsupials'); await answered(pg, ta.press('Enter'))
        cid = await pg.evaluate('__digress.conv.id')
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click()
        await pg.wait_for_function("Object.keys(__digress.conv.threads).length>1")
        tid = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        bt = pg.locator(f'.pane[data-tid="{tid}"] textarea'); await bt.fill('Branch q on habitat'); await answered(pg, bt.press('Enter'))

        rows = lambda: pg.evaluate("[...document.querySelectorAll('#palRes .pr .ps')].map(e=>e.textContent)")   # result rows only (not group headers)
        async def results(q):
            await pg.locator('#palIn').fill(q)
            await pg.wait_for_function("q=>document.querySelector('#palIn').value===q&&(document.querySelector('#palRes .pr')||document.querySelector('#palRes .pempty'))", arg=q)
            await pg.wait_for_timeout(250)   # (deliberate: past the 90 ms debounce, so the rows are for q)
            return await rows()

        # the magnifier in the branch pane
        pane = pg.locator(f'.pane[data-tid="{tid}"]'); await pane.hover()
        mag = pane.locator('[data-act=jsearch]')
        check('a pane shows a magnifier on hover', await mag.is_visible())
        await mag.click(); await pg.locator('#pal.show').wait_for()
        on = await pg.locator('#palScope button.on').inner_text()
        check('it opens search narrowed to that thread', 'Branch q' in on, on)
        check('…and says so before you type', 'this thread' in (await pg.locator('#palRes').inner_text()))
        r = await results('quokka')
        check('only that thread’s matches show', any('Rottnest' in x for x in r) and not any('marsupial' in x or 'Elsewhere' in x for x in r), r)
        await pg.screenshot(path=OUT + '/search_scope.png')
        await pg.keyboard.press('Tab'); await settle(pg, 300)   # the chips go Everywhere · This conversation · This thread; Tab wraps
        r = await rows()
        check('Tab: everywhere', any('Elsewhere' in x for x in r), r)
        await pg.keyboard.press('Tab'); await settle(pg, 300)
        r = await rows()
        check('Tab again: this conversation (main and branch, not the other conversation)', any('Rottnest' in x for x in r) and any('marsupial' in x for x in r) and not any('Elsewhere' in x for x in r), r)
        await pg.keyboard.press('Tab'); await settle(pg, 300)   # back to this thread
        await pg.locator('#palRes .pr').first.click()
        await pg.wait_for_function("()=>!document.querySelector('#pal.show')&&!!CSS.highlights.get('digress-hit')", timeout=10000)
        check('opening a thread result lands in that thread', await pg.evaluate("!!CSS.highlights.get('digress-hit')&&[...CSS.highlights.get('digress-hit')][0].startContainer.parentElement.closest('.pane').dataset.tid") == tid)

        # ⌘K stays everywhere by default
        await pg.keyboard.press('Control+k'); await pg.locator('#pal.show').wait_for()
        check('⌘K opens searching everywhere', (await pg.locator('#palScope button.on').inner_text()) == 'Everywhere')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
