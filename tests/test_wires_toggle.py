"""The lines between panes (from a branch's pane to where it came from).
  - On by default, and they stay on in Zen.
  - The palette menu's "Lines between panes" row turns them off (and on again); the menu stays open.
  - The choice is kept on this device: it survives a reload.
  - The canvas keeps its own lines either way.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, calm, saved, CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='Attention lets each token weigh every other token. The weights come from a softmax over scores.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

# the lines are drawn and showing
LINES = "(()=>{const s=document.querySelector('#wires');return !!s.querySelector('path')&&s.getClientRects().length>0})()"
ROW = '.thmenu.open button[data-wires]'
DRAWN = "!!document.querySelector('#wires path')"   # drawn, whether or not they show

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click()
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1'); await frames(pg, 3)
        async def reopen():   # make sure the branch's pane is open beside main (so there's a line to draw)
            await frames(pg, 2)
            if await pg.evaluate('__digress.conv.ui.open.length') < 2:
                await pg.locator('.pane[data-tid=main] .bchip').first.click()
            await frames(pg, 4)
        check('a branch beside its parent has a line to it (on by default)', await pg.evaluate(LINES))

        await pg.keyboard.press('Control+.'); await frames(pg, 3)
        check('(set up: Zen is on)', await pg.evaluate("document.querySelector('#app').classList.contains('zen')"))
        check('the lines stay in Zen', await pg.evaluate(LINES))
        await pg.keyboard.press('Control+.'); await frames(pg)

        await pg.locator('#themeB').click()
        row = pg.locator(ROW)
        check('the palette menu has the row, ticked', await row.count() == 1 and await row.get_attribute('aria-checked') == 'true')
        await row.click(); await frames(pg)
        check('clicking it hides the lines', not await pg.evaluate(LINES))
        check('…unticks it and keeps the menu open', await row.get_attribute('aria-checked') == 'false')
        await pg.screenshot(path=OUT + '/wires_off.png')
        await pg.keyboard.press('Escape')

        await saved(pg, layout=True); await pg.reload(); await booted(pg); await frames(pg, 3)
        await reopen()
        check('off survives a reload (drawn, not shown)', await pg.evaluate(DRAWN) and not await pg.evaluate(LINES) and await pg.evaluate("document.querySelector('#app').classList.contains('nowires')"))

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await calm(pg); await frames(pg)
        check('the canvas keeps its own lines', await pg.evaluate("!!document.querySelector('#cv path, #cv line')"))
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=cols]').click()"); await reopen()

        await pg.locator('#themeB').click(); await pg.locator(ROW).click(); await frames(pg, 3)
        check('clicking it again brings them back', await pg.evaluate(LINES) and await pg.locator(ROW).get_attribute('aria-checked') == 'true')
        await pg.keyboard.press('Escape')
        await saved(pg, layout=True); await pg.reload(); await booted(pg); await reopen()
        check('…and on survives a reload too', await pg.evaluate(LINES))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
