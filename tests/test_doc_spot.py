"""Where you were in a document, kept per device, and one line for the page shown, the mark and quote jumps.
  - Scrolling a PDF and stopping saves the reading spot in this device's layout (ui.dspot, api/layout); reloading
    opens the document at that spot (the header says that page, the same place on it).
  - A quoted citation clicked after the document opened goes to its quote, whatever spot was kept.
  - A quoted citation jump lands its text on the same line the reading mark uses, so the page the header shows is
    the page "Mark where you got up to" marks.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, soon, frames, settle, saved, quiet, PDF_DRAWN_JS, CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'pdfjs-dist@4.10.38/build/pdf.min.mjs': ROOT + 'pdfjs-dist/build/pdf.min.mjs',
    'pdfjs-dist@4.10.38/build/pdf.worker.min.mjs': ROOT + 'pdfjs-dist/build/pdf.worker.min.mjs',
}
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FAKE_LLM = """window.fakeLLM = {
  use: async (name) => name === 'sample' ? async (messages, opts) => {
    const reply = 'The top of page 3 [p. 3 "Models with scaled attention train faster"], and page 1 [p. 1 "Queries are compared against keys"].';
    if (opts && opts.onToken) opts.onToken(reply);
    return { text: reply };
  } : null
};"""

MARK = "(__digress.conv.doc||{}).mark||null"
DSPOT = "(__digress.conv.ui||{}).dspot||null"
PAGE_SHOWN = "(()=>{const t=document.querySelector('.docpane .ph-origin').textContent.match(/Page (\\d+) of/);return t?+t[1]:null})()"
# which page the header says, how far down the pane the page's top is (as a fraction of the pane's height) and the scroll position
WHERE = """(()=>{const pb=document.querySelector('.docpane .pb'),r=pb.getBoundingClientRect(),y=r.top+pb.clientHeight*0.15;
  const pg=[...document.querySelectorAll('.dpage')].find(p=>p.getBoundingClientRect().bottom>=y);
  return {top: pb.scrollTop, page: +pg.dataset.page, f: (y-pg.getBoundingClientRect().top)/pg.getBoundingClientRect().height}})()"""

async def scroll_to(pg, n, frac):   # put page n, frac of the way down it, at the top 15% line
    await pg.evaluate(f"""(()=>{{const pb=document.querySelector('.docpane .pb'),d=document.querySelector('.dpage[data-page="{n}"]');
      pb.scrollTop+=d.getBoundingClientRect().top+d.getBoundingClientRect().height*{frac}-(pb.getBoundingClientRect().top+pb.clientHeight*0.15)}})()""")
    await frames(pg, 3)

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
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE_LLM)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        await saved(pg, layout=True)

        # 1. the spot is kept, and the document opens there again
        check('(no spot kept before anything is scrolled)', await pg.evaluate(DSPOT) is None)
        await scroll_to(pg, 3, 0.1)
        await soon(pg, f"() => {PAGE_SHOWN} === 3")
        check('(page 3 is showing)', await pg.evaluate(PAGE_SHOWN) == 3)
        check('the spot is noted in this device’s layout (page 3)', await soon(pg, "() => { const d = __digress.conv.ui.dspot; return Array.isArray(d) && d[0] === 'p' && d[1] === 3 }"), await pg.evaluate(DSPOT))
        where0 = await pg.evaluate(WHERE)
        # it's saved a couple of seconds after scrolling stops: wait for the layout on its way to the server (not a fixed time)
        check('…and saved with the layout (api/layout), not with the conversation',
              await soon(pg, "() => JSON.stringify(__digress.conv.ui) === __digress.sync.ui && !__digress.sync.uiSaving && __digress.sync.ui.includes('dspot')", timeout=15000), await pg.evaluate("__digress.sync.ui"))
        stored = await pg.evaluate("() => { const d = JSON.parse(localStorage.getItem('fakesrv:layout/' + __digress.conv.id) || '{\"devices\":{}}'); return Object.values(d.devices).map(x => x.ui.dspot) }")
        check('…it reached the (fake) server’s layout for this conversation', stored and stored[0] and stored[0][1] == 3, stored)
        await saved(pg, layout=True); await quiet(pg)
        await pg.reload(); await booted(pg); await pg.wait_for_function(PDF_DRAWN_JS)
        await settle(pg)
        check('after a reload the header says page 3', await soon(pg, f"() => {PAGE_SHOWN} === 3"), await pg.evaluate(PAGE_SHOWN))
        where1 = await pg.evaluate(WHERE)
        check('…at about the same place on it', where1['page'] == 3 and abs(where1['f'] - where0['f']) < 0.03 and abs(where1['top'] - where0['top']) < 30, [where0, where1])
        await pg.screenshot(path=OUT + '/doc_spot.png')

        # 2. a citation clicked after the document is open goes to its own quote
        await pg.locator('.pane[data-tid="main"] textarea').fill('cite please')
        await pg.locator('.pane[data-tid="main"] textarea').press('Enter')
        await soon(pg, "() => document.querySelectorAll('.pane[data-tid=\"main\"] .msg.assistant a.pref').length === 2")
        await pg.locator('.pane[data-tid="main"] .msg.assistant a.pref').nth(1).click()
        await soon(pg, f"() => {PAGE_SHOWN} === 1")
        await settle(pg)
        check('a quoted citation after a reload goes to its page, not to the kept spot', await pg.evaluate(PAGE_SHOWN) == 1, await pg.evaluate(PAGE_SHOWN))
        check('…and highlights its quote', await pg.evaluate("() => { const h = CSS.highlights.get('digress-hit'); return h ? [...h].map(r => r.toString()).join('').includes('Queries are compared') : false }"))
        await saved(pg, layout=True); await quiet(pg)
        # with the quote jump the kept spot follows (page 1 now): a reload comes back to it
        await soon(pg, "() => { const d = __digress.conv.ui.dspot; return Array.isArray(d) && d[1] === 1 }", timeout=15000)

        # 3. the page the header shows is the page the mark goes on, after a quote jump to text near a page's top
        await pg.locator('.pane[data-tid="main"] .msg.assistant a.pref').nth(0).click()
        await soon(pg, f"() => {PAGE_SHOWN} === 3")
        await settle(pg)
        shown = await pg.evaluate(PAGE_SHOWN)
        check('a quote near the top of page 3: the header says page 3', shown == 3, shown)
        at = await pg.evaluate("""(()=>{const h=CSS.highlights.get('digress-hit');if(!h)return null;const r=[...h][0].getBoundingClientRect(),pb=document.querySelector('.docpane .pb').getBoundingClientRect();return (r.top-pb.top)/pb.height})()""")
        check('…the quote lands on the reading line (15% down the pane)', at is not None and abs(at - 0.15) < 0.04, at)
        await pg.locator('.docpane .jump [data-act=jmark]').click(); await frames(pg)
        m = await pg.evaluate(MARK)
        check('“Mark where you got up to” marks that same page', m and m[0] == 'p' and m[1] == shown, [m, shown])
        await pg.screenshot(path=OUT + '/doc_spot_quote.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
