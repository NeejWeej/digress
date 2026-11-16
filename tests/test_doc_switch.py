"""A PDF re-fits its pane 250 ms after the pane is resized. Switching to another document inside that window
used to rebuild the old PDF from the new one's state and throw ("reading 'getPage'"). Resize, then switch
straight away, several times: no page errors, and each document shows correctly. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, launch_args, goto_app, booted, PDF_DRAWN_JS
from common import CORS

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

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
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
        pdf_id = await pg.evaluate('__digress.conv.id')
        await pg.locator('#newDoc').click()
        await pg.locator('#docPaste').fill('# Notes on Raft\n\nRaft elects a leader that replicates the log.')
        await pg.locator('#docGo').click(); await pg.wait_for_function("__digress.conv.doc&&__digress.conv.doc.kind==='text'&&(document.querySelector('.docbody')||{}).textContent?.includes('Raft')")
        text_id = await pg.evaluate('__digress.conv.id')
        for i in range(4):
            await pg.locator(f'#side [data-conv="{pdf_id}"]').first.click(); await pg.wait_for_function(PDF_DRAWN_JS)
            await pg.set_viewport_size({'width': 1100 if i % 2 == 0 else 1500, 'height': 900})   # the PDF pane narrows or widens…
            await pg.wait_for_timeout(60)                                                         # (deliberate: inside the 250 ms re-fit window)
            await pg.locator(f'#side [data-conv="{text_id}"]').first.click()                       # …and we switch away before it re-fits
            await pg.wait_for_function("(document.querySelector('.docbody')||{}).textContent?.includes('Raft')")
            await pg.wait_for_timeout(400)                                                        # (deliberate: past the window, where the old code threw)
        check('switching documents during a re-fit throws nothing', not errs, errs[:3])
        check('the text document is shown', 'Raft' in await pg.locator('.docbody').inner_text())
        await pg.locator(f'#side [data-conv="{pdf_id}"]').first.click(); await pg.wait_for_function(PDF_DRAWN_JS)
        check('and the PDF still opens and draws', await pg.locator('.dpage canvas').count() > 0)
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
