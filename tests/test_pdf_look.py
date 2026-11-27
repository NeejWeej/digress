"""How PDF pages look, set in the theme menu apart from the theme, and the newer themes.
  - "PDF pages": Original, Match the theme, Dark, Dim, Sepia. Only the drawn page is filtered (CSS), never the text
    layer, and never the pixels: what the model gets from a page is drawn unfiltered.
  - Match the theme: the page takes the theme's paper: under a dark theme inverted and blended (lighten) over the
    pane's color, under a light one multiplied over it (white becomes the theme's paper); the text layer isn't blended.
  - Hovering previews it, clicking keeps it (also after a reload); it doesn't change the theme, nor the theme it.
  - Every theme in the menu sets every color variable the default does.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, frames, PDF_DRAWN_JS
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
UNFOLD = "document.querySelectorAll('.thmenu.open .thgrp[aria-expanded=false]').forEach(b=>b.click())"   # open every section of the theme menu
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FILTER = "getComputedStyle(document.querySelector('.pane[data-tid=doc] .dpage canvas')).filter"
PIXEL = "(()=>{const c=document.querySelector('.pane[data-tid=doc] .dpage canvas');const d=c.getContext('2d').getImageData(2,2,1,1).data;return [...d].slice(0,3)})()"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await goto_app(pg); await booted(pg)

        # every theme sets every variable the default sets
        missing = await pg.evaluate("""() => {
          const css=[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules]}catch(e){return []}});
          const vars=r=>new Set([...r.style].filter(p=>p.startsWith('--')));
          const base=css.find(r=>r.selectorText===':root, .thsw[data-theme="light"]');
          const need=[...vars(base)].filter(v=>!['--sans','--serif','--you','--uiserif','--mono','--shadow'].includes(v));
          const out={};for(const [id] of THEMES){if(id==='system'||id==='light')continue;
            const r=css.find(r=>r.selectorText&&r.selectorText.startsWith(`:root[data-theme="${id}"]`));
            out[id]=r?need.filter(v=>!vars(r).has(v)):['(no rule)']}
          return Object.fromEntries(Object.entries(out).filter(([,v])=>v.length)) }""")
        check('every theme sets every color variable', missing == {}, missing)
        ids = await pg.evaluate("THEMES.map(t=>t[0])")
        check('the newer themes are in the menu', all(x in ids for x in ['kanagawa', 'everforest', 'latte', 'mocha', 'rainforest-day', 'rainforest-night']))

        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        check('Original to start with: no filter', await pg.evaluate(FILTER) == 'none', await pg.evaluate(FILTER))
        px0 = await pg.evaluate(PIXEL)

        await pg.locator('#themeB').click(); await pg.evaluate(UNFOLD)
        menu = pg.locator('.thmenu.open')
        check('the theme menu has a “PDF pages” section', 'PDF pages' in await menu.inner_text())
        await menu.locator('button[data-pdf=dark]').hover(); await frames(pg)
        check('hovering Dark previews it', 'invert' in await pg.evaluate(FILTER))
        await menu.locator('button[data-theme=nord]').hover(); await frames(pg)
        check('…moving on to a theme puts the PDF back as chosen', await pg.evaluate(FILTER) == 'none')
        await menu.locator('button[data-pdf=dark]').click(); await frames(pg)
        check('clicking Dark keeps it', 'invert' in await pg.evaluate(FILTER) and await pg.evaluate("document.documentElement.dataset.pdf") == 'dark')
        check('…only the drawn page: the text layer isn’t filtered', await pg.evaluate("getComputedStyle(document.querySelector('.pane[data-tid=doc] .textLayer')).filter") == 'none')
        check('…and the page’s pixels (what the model gets) are unchanged', await pg.evaluate(PIXEL) == px0)
        check('…and the theme didn’t change', await pg.evaluate("JSON.parse(localStorage.getItem('sq:settings')).theme") in ('system', None))
        await pg.keyboard.press('Escape')
        await pg.screenshot(path=OUT + '/pdf_dark.png')

        for look, want in [('dim', 'brightness'), ('sepia', 'sepia'), ('original', 'none')]:
            await pg.locator('#themeB').click(); await pg.evaluate(UNFOLD); await pg.locator(f'.thmenu.open button[data-pdf={look}]').click(); await frames(pg)
            check(f'{look}: {want}', want in await pg.evaluate(FILTER), await pg.evaluate(FILTER))
            await pg.keyboard.press('Escape')

        # Match the theme
        await pg.locator('#themeB').click(); await pg.evaluate(UNFOLD); await pg.locator('.thmenu.open button[data-pdf=match]').click()
        await pg.locator('.thmenu.open button[data-theme=light]').click(); await frames(pg)
        BLEND = "getComputedStyle(document.querySelector('.pane[data-tid=doc] .dpage canvas')).mixBlendMode"
        PAGE_BG = "[getComputedStyle(document.querySelector('.pane[data-tid=doc] .dpage')).backgroundColor, getComputedStyle(document.querySelector('.pane[data-tid=doc]')).getPropertyValue('--panel').trim()]"
        check('Match the theme, light theme: not inverted', 'invert' not in await pg.evaluate(FILTER), await pg.evaluate(FILTER))
        check('…multiplied over the theme’s paper', await pg.evaluate(BLEND) == 'multiply', await pg.evaluate(BLEND))
        await pg.locator('.thmenu.open button[data-theme=kanagawa]').click(); await frames(pg)
        check('…dark theme: dark pages', 'invert' in await pg.evaluate(FILTER), await pg.evaluate(FILTER))
        check('…blended (lighten) into the theme’s color', await pg.evaluate(BLEND) == 'lighten', await pg.evaluate(BLEND))
        check('…the text layer isn’t blended', await pg.evaluate("getComputedStyle(document.querySelector('.pane[data-tid=doc] .textLayer')).mixBlendMode") == 'normal')
        await pg.screenshot(path=OUT + '/pdf_match_kanagawa.png')
        await pg.keyboard.press('Escape')

        await pg.reload(); await booted(pg); await pg.wait_for_function(PDF_DRAWN_JS)
        check('kept after a reload, set before the page paints', await pg.evaluate("document.documentElement.dataset.pdf") == 'match' and 'invert' in await pg.evaluate(FILTER))
        await pg.locator('#themeB').click()
        check('…and ticked in the menu', await pg.locator('.thmenu.open button[data-pdf=match]').get_attribute('aria-checked') == 'true' and await pg.locator('.thmenu.open button[data-theme=kanagawa]').get_attribute('aria-checked') == 'true')
        await pg.locator('.thmenu.open').screenshot(path=OUT + '/theme_menu.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
