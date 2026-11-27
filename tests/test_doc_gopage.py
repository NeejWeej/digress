"""Go to a page in a PDF: click "Page N" in the document header, type a page, Enter jumps there; Esc leaves
it as it was; a number past the end goes to the last page. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, PDF_DRAWN_JS
from common import CORS

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
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        hdr = pg.locator('.docpane .ph-origin')
        n = int((await hdr.inner_text()).split(' of ')[1].split()[0])
        check('(the test PDF has several pages)', n >= 3, n)
        top = lambda: pg.evaluate("(()=>{const pb=document.querySelector('.docpane .pb').getBoundingClientRect(),y=pb.top+pb.height*0.3;return +[...document.querySelectorAll('.dpage')].find(p=>p.getBoundingClientRect().bottom>=y).dataset.page})()")

        await hdr.locator('[data-gopage]').click()
        inp = hdr.locator('.pgin')
        check('clicking “Page N” turns it into a number box', await inp.is_visible() and await inp.input_value() == '1')
        await pg.screenshot(path=OUT + '/doc_gopage.png')
        await inp.fill('3'); await inp.press('Enter')
        await pg.wait_for_function("document.querySelector('.docpane .ph-origin').textContent.startsWith('Page 3')", timeout=10000)
        await pg.wait_for_timeout(400)   # (deliberate: let the scroll settle before measuring)
        check('Enter jumps to that page', await top() == 3 and not await inp.count(), await top())

        await hdr.locator('[data-gopage]').click(); await hdr.locator('.pgin').fill('1'); await hdr.locator('.pgin').press('Escape')
        await pg.wait_for_timeout(400)   # (deliberate: nothing should move)
        check('Esc leaves it where it was', await top() == 3 and (await hdr.inner_text()).startswith('Page 3'))

        await hdr.locator('[data-gopage]').click(); await hdr.locator('.pgin').fill('999'); await hdr.locator('.pgin').press('Enter')
        await pg.wait_for_function(f"document.querySelector('.docpane .ph-origin').textContent.startsWith('Page {n}')", timeout=10000)
        check('a number past the end goes to the last page', True)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
