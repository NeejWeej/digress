"""The reading mark: where you got up to in a document (no chat attached), kept with the conversation.
  - The ribbon button in the document pane's corner marks the place at the top of the view; a ribbon and a faint
    line show it in the page margin.
  - Opening the conversation again offers "Go back to it", which scrolls there.
  - With a mark, the button's menu goes back to it, moves it to where you are now, or removes it; the ribbon
    can also be dragged (to another page too), and its × removes it.
  - In a text document it's kept on its character, so it stays with the text when the pane gets narrower.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, frames, soon, PDF_DRAWN_JS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

MARK = "(__digress.conv.doc||{}).mark||null"
# how far down the pane (as a fraction of its height) the mark's line is now, or null when it isn't drawn
MARK_AT = """(()=>{const pb=document.querySelector('.docpane .pb'),d=document.querySelector('.docpane .dmark');if(!d)return null;
  const r=pb.getBoundingClientRect();return (d.getBoundingClientRect().top-r.top)/pb.clientHeight})()"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        jm = pg.locator('.docpane .jump [data-act=jmark]')
        page_top = lambda n: pg.evaluate(f"(()=>{{const pb=document.querySelector('.docpane .pb'),d=document.querySelector('.dpage[data-page=\"{n}\"]');return d.getBoundingClientRect().top-pb.getBoundingClientRect().top}})()")
        async def scroll_to(n, frac):   # put page n, frac of the way down it, at the top 15% line
            await pg.evaluate(f"""(()=>{{const pb=document.querySelector('.docpane .pb'),d=document.querySelector('.dpage[data-page="{n}"]');
              pb.scrollTop+=d.getBoundingClientRect().top+d.getBoundingClientRect().height*{frac}-(pb.getBoundingClientRect().top+pb.clientHeight*0.15)}})()""")
            await frames(pg, 3)

        check('no mark at first', await pg.evaluate(MARK) is None and not await pg.locator('.dmark').count())
        await scroll_to(2, 0.4)
        await jm.click(); await frames(pg)
        m = await pg.evaluate(MARK)
        check('the ribbon button marks where you are (page 2, 0.4 down it)', m and m[0] == 'p' and m[1] == 2 and abs(m[2] - 0.4) < 0.02, m)
        check('…drawn in page 2’s margin', await pg.locator('.dpage[data-page="2"] .dmark').count() == 1)
        check('…and it says so', 'Marked where you got up to' in await pg.locator('#toast').inner_text())
        await pg.screenshot(path=OUT + '/reading_mark.png')

        # coming back to the conversation: offered, and it goes there
        await pg.evaluate("document.querySelector('.docpane .pb').scrollTop=0"); await frames(pg)
        await soon(pg, "()=>__digress.sync.sent&&!document.querySelector('#status').textContent.includes('Saving')")
        await pg.wait_for_timeout(700)   # (deliberate: let the save land in the fake server's storage)
        await pg.reload(); await booted(pg); await pg.wait_for_function(PDF_DRAWN_JS)
        check('the mark is kept with the conversation', (await pg.evaluate(MARK) or [None, None])[1] == 2)
        t = pg.locator('#toast.show')
        await soon(pg, "()=>!!document.querySelector('#toast.show .tact')")
        check('opening it again offers to go back to the mark', 'You left a mark at p. 2' in await t.inner_text(), await pg.locator('#toast').inner_text())
        await t.locator('.tact').click(); await pg.wait_for_timeout(300)
        at = await pg.evaluate(MARK_AT)
        check('“Go back to it” scrolls the mark to the top of the view', at is not None and abs(at - 0.15) < 0.03, at)

        # read on, then move it here from the menu
        await scroll_to(2, 0.75)
        await jm.click()
        menu = pg.locator('#markMenu.open')
        check('with a mark, the button opens a menu: go back, move here, remove', await menu.count() == 1 and [x for x in await menu.locator('[data-mk]').evaluate_all('e=>e.map(b=>b.dataset.mk)')] == ['go', 'here', 'rm'])
        check('…“Move it here” names the page', 'Move it here (p. 2)' in await menu.inner_text())
        await menu.locator('[data-mk=here]').click(); await frames(pg)
        m = await pg.evaluate(MARK)
        check('“Move it here” moves it to where you are now', m[1] == 2 and abs(m[2] - 0.75) < 0.02, m)
        await scroll_to(1, 0.5); await jm.click(); await pg.locator('#markMenu.open [data-mk=go]').click(); await pg.wait_for_timeout(300)
        at = await pg.evaluate(MARK_AT)
        check('“Go back to it” from the menu', at is not None and abs(at - 0.15) < 0.03, at)

        # drag the ribbon down onto page 3
        rib = pg.locator('.dmark .rib'); r = await rib.bounding_box()
        p2 = await pg.evaluate("(()=>{const d=document.querySelector('.dpage[data-page=\"3\"]').getBoundingClientRect();return d.top+d.height*0.2})()")
        x, y = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
        await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x, (y + p2) / 2); await pg.mouse.move(x, p2); await pg.mouse.up(); await frames(pg)
        m = await pg.evaluate(MARK)
        check('dragging the ribbon moves the mark, to another page too', m[1] == 3 and abs(m[2] - 0.2) < 0.03, m)
        await pg.locator('.dmark .rib').hover(); await pg.locator('.dmark .mx').click(); await frames(pg)
        check('its × removes it', await pg.evaluate(MARK) is None and not await pg.locator('.dmark').count())
        check('…and the button marks again next time', await jm.get_attribute('title') == 'Mark where you got up to')

        # a text document: the mark stays on its character when the text reflows
        await pg.locator('#newDoc').click()
        text = '\n\n'.join(f'Paragraph {i}. ' + ('The quick brown fox jumps over the lazy dog. ' * 6) for i in range(1, 61))
        await pg.locator('#docPaste').fill(text); await pg.locator('#docGo').click()
        await pg.wait_for_function("!!document.querySelector('.docpane .docbody p')")
        await pg.evaluate("""(()=>{const pb=document.querySelector('.docpane .pb'),p=[...document.querySelectorAll('.docbody p')].find(e=>e.textContent.startsWith('Paragraph 30.'));
          pb.scrollTop+=p.getBoundingClientRect().top-(pb.getBoundingClientRect().top+pb.clientHeight*0.15)})()"""); await frames(pg, 3)
        await jm.click(); await frames(pg)
        m = await pg.evaluate(MARK)
        check('in a text document the mark is a character offset', m and m[0] == 'o' and m[1] > 100, m)
        where = "(()=>{const d=document.querySelector('.docpane .dmark'),p=[...document.querySelectorAll('.docbody p')].find(e=>e.textContent.startsWith('Paragraph 30.'));return d&&p?d.getBoundingClientRect().top-p.getBoundingClientRect().top:null})()"
        d0 = await pg.evaluate(where)
        check('…drawn at the start of that paragraph', d0 is not None and abs(d0) < 14, d0)
        await pg.set_viewport_size({'width': 900, 'height': 850}); await pg.wait_for_timeout(500)
        d1 = await pg.evaluate(where)
        check('…and still there after the text reflows', d1 is not None and abs(d1) < 14, [d0, d1])
        await pg.screenshot(path=OUT + '/reading_mark_text.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
