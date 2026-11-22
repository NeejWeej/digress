"""A PDF's pages are redrawn to the pane's width whenever that changes: collapsing the other panes (the PDF pane
grows), expanding them again (it shrinks), hiding the sidebar, and several of those in quick succession.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, FIX, PDF_DRAWN_JS, answered, OUT, settle

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FAKE = "window.fakeLLM = {use: async () => async (m, o) => { o.onText({text: 'An answer.'}); return {text: 'An answer.'} }};"
# the first page's drawn width against the width it should be (the pane, less its padding), once it has settled
FIT = """(() => { const pb = document.querySelector('.pane[data-tid=doc] .pb'), d = document.querySelector('.pane[data-tid=doc] .dpage');
  return d ? [Math.round(d.getBoundingClientRect().width), pb.clientWidth - 46] : null })()"""
FITS = "(() => { const f = " + FIT + "; return !!f && Math.abs(f[0] - f[1]) < 8 })()"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args()); errs = []
        pg = await b.new_page(viewport={'width': 1440, 'height': 860}); pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE); await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click()
        await pg.wait_for_function(PDF_DRAWN_JS)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Hello?'); await answered(pg, ta.press('Enter'))
        check('to start with, the pages fit the pane', await soon(pg, FITS), await pg.evaluate(FIT))
        w0 = await pg.evaluate(FIT)
        await pg.locator('.pane[data-tid=main] [data-act=collapse]').click()
        check('collapsing the other pane: the pages are redrawn wider, to fit', await soon(pg, FITS) and (await pg.evaluate(FIT))[0] > w0[0] + 100, [w0, await pg.evaluate(FIT)])
        await pg.locator('.pane[data-tid=main]').click()
        check('expanding it again: narrower, to fit', await soon(pg, FITS) and abs((await pg.evaluate(FIT))[0] - w0[0]) < 8, [w0, await pg.evaluate(FIT)])
        # several changes in quick succession (as a slow device sees them): it still ends up fitting
        for _ in range(3):
            await pg.locator('#tSide').click(); await pg.wait_for_timeout(120)   # deliberate: quick changes one after another
        check('after quick changes one after another, it ends up fitting', await soon(pg, FITS), await pg.evaluate(FIT))
        await pg.screenshot(path=OUT + '/pdf_refit.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
