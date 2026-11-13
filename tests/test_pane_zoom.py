"""Zoom inside panes (Columns / Rows views): chat panes scale their text and remember it; the PDF pane
re-renders sharply at the new size, and the fit button returns to fitting the width.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, launch_args, goto_app

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
FAKE = r"""
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{const out='Attention is a soft dictionary lookup over the keys. '.repeat(6);opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await pg.wait_for_timeout(1200)
        await pg.locator('#newDoc').click(); await pg.wait_for_timeout(200)
        await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_timeout(3000)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await ta.press('Enter'); await pg.wait_for_timeout(900)

        main = pg.locator('.pane[data-tid=main]')
        z = main.locator('.pzoom')
        await pg.mouse.move(5, 880); await pg.wait_for_timeout(300)
        check('zoom controls are hidden until you hover the pane', await z.evaluate('e=>getComputedStyle(e).opacity') == '0')
        await main.hover(); await pg.wait_for_timeout(250)
        check('hovering a pane shows them', await z.evaluate('e=>getComputedStyle(e).opacity') == '1' and await main.locator('.pzl').text_content() == '100%')
        msg = main.locator('.msg.assistant .body').first
        h0 = await msg.evaluate('e=>e.getBoundingClientRect().height'); w0 = await msg.evaluate('e=>e.getBoundingClientRect().width')
        for _ in range(3): await main.locator('[data-act=zin]').click()
        await pg.wait_for_timeout(200)
        h1 = await msg.evaluate('e=>e.getBoundingClientRect().height'); w1 = await msg.evaluate('e=>e.getBoundingClientRect().width')
        check('zoom in makes the chat text bigger and it reflows to the pane', await main.locator('.pzl').text_content() == '150%' and h1 > h0 * 1.15 and abs(w1 - w0) < 3, f'{h0:.0f}->{h1:.0f} w {w0:.0f}->{w1:.0f}')
        await pg.screenshot(path=OUT + '/pane_zoom_chat.png')

        # branching still anchors the right words while zoomed
        await pg.evaluate('''() => { const body=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT); const n=w.nextNode(); const r=document.createRange(); r.setStart(n,15); r.setEnd(n,19);
          const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }''')
        await pg.wait_for_timeout(150)
        await pg.locator('#popIn').fill('Why soft?'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(1200)
        anc = await main.locator('.anchor').first.text_content()
        check('selecting text to branch works while zoomed', anc == 'soft', repr(anc))

        # the PDF: re-rendered at the new size (sharp), "fit page" fits a whole page into the pane
        doc = pg.locator('.pane[data-tid=doc]')
        await doc.hover(); await pg.wait_for_timeout(200)
        pw0 = await doc.locator('.dpage').first.evaluate('e=>e.offsetWidth')
        await doc.locator('[data-act=zin]').click(); await pg.wait_for_timeout(1200)
        pw1, cw = await doc.locator('.dpage').first.evaluate("e=>[e.offsetWidth, e.querySelector('canvas') && e.querySelector('canvas').width]")
        check('PDF zoom in re-renders the pages larger, at full sharpness', abs(pw1 / pw0 - 1.1) < 0.02 and cw and cw >= pw1 - 2, f'{pw0}->{pw1} canvas {cw}')
        check('the PDF is not CSS-scaled (no blur)', await doc.evaluate("e=>getComputedStyle(e.querySelector('.docwrap')).zoom") == '1')
        check('the fit button only shows on the PDF', await doc.locator('.pzf').is_visible() and await main.locator('.pzf').count() == 0)
        await doc.locator('[data-act=zin]').click(); await pg.wait_for_timeout(300)
        for _ in range(3): await doc.locator('[data-act=zin]').click(); await pg.wait_for_timeout(300)
        await pg.wait_for_timeout(1200)
        sx = await doc.evaluate("e=>{const pb=e.querySelector('.pb');return [pb.scrollWidth>pb.clientWidth, e.querySelector('.dpage').getBoundingClientRect().left>=pb.getBoundingClientRect().left-1]}")
        check('a page wider than the pane scrolls sideways and its left edge stays reachable', sx[0] and sx[1], str(sx))
        await doc.locator('[data-act=zfit]').click(); await pg.wait_for_timeout(1200)
        check('the fit button goes back to fitting the width', await doc.locator('.pzl').text_content() == '100%' and abs(await doc.locator('.dpage').first.evaluate('e=>e.offsetWidth') - pw0) <= 2)
        check('and is greyed out while already fitting', await doc.locator('.pzf').is_disabled())
        await pg.screenshot(path=OUT + '/pane_zoom_pdf_fit.png')
        await doc.locator('[data-act=zout]').click(); await pg.wait_for_timeout(600)
        await doc.locator('.pzl').click(); await doc.locator('.zin').fill('100'); await doc.locator('.zin').press('Enter'); await pg.wait_for_timeout(1200)
        check('typing 100 into the percentage goes back to fitting the width', await doc.locator('.pzl').text_content() == '100%' and abs(await doc.locator('.dpage').first.evaluate('e=>e.offsetWidth') - pw0) <= 2)
        await doc.locator('[data-act=zout]').click(); await pg.wait_for_timeout(1200)

        # type a zoom level instead of stepping
        await main.hover(); await main.locator('.pzl').click()
        zin = main.locator('.zin')
        check('clicking the percentage opens a box with the current level, selected', await zin.is_visible() and await zin.input_value() == '150' and await zin.evaluate('e=>e.selectionStart==0&&e.selectionEnd==e.value.length'))
        await zin.fill('250'); await zin.press('Enter'); await pg.wait_for_timeout(300)
        check('typing a level and Enter jumps straight there', await main.locator('.pzl').text_content() == '250%' and await main.locator('.zin').count() == 0)
        await main.locator('.pzl').click(); await main.locator('.zin').fill('80'); await main.locator('.zin').press('Escape'); await pg.wait_for_timeout(200)
        check('Esc cancels', await main.locator('.pzl').text_content() == '250%' and await main.locator('.zin').count() == 0)
        await main.locator('.pzl').click(); await main.locator('.zin').fill('1000%'); await main.locator('.zin').press('Enter'); await pg.wait_for_timeout(200)
        check('a level out of range is kept within 50–300%', await main.locator('.pzl').text_content() == '300%')
        await main.locator('.pzl').click(); await main.locator('.zin').fill('150'); await pg.mouse.click(5, 880); await pg.wait_for_timeout(200)
        check('clicking away applies what was typed', await main.locator('.pzl').text_content() == '150%')
        await doc.hover(); await doc.locator('.pzl').click(); await doc.locator('.zin').fill('140'); await doc.locator('.zin').press('Enter'); await pg.wait_for_timeout(1200)
        check('typing a level on the PDF re-renders it at that size', await doc.locator('.pzl').text_content() == '140%' and abs(await doc.locator('.dpage').first.evaluate('e=>e.offsetWidth') / pw0 - 1.4) < 0.03)

        # remembered per pane, across reloads
        await pg.reload(); await pg.wait_for_timeout(3500)
        labels = await pg.evaluate("[...document.querySelectorAll('.pane')].map(p=>[p.dataset.tid,(p.querySelector('.pzl')||{}).textContent])")
        check('each pane keeps its zoom after a reload', ['main', '150%'] in labels and ['doc', '140%'] in labels, str(labels))
        await pg.screenshot(path=OUT + '/pane_zoom_reload.png')
        check('no page errors', not errs, '; '.join(errs[:5]))
        await b.close()
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    asyncio.run(main())
