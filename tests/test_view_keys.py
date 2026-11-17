"""Switching views from the keyboard, and the shortcuts list in How it works.
  - ⌘'/Ctrl+' goes to the canvas and back to the panes, as they were (Columns or Rows); ⌘⇧'/Ctrl+Shift+' switches
    Columns and Rows (from the canvas too). Both work while typing.
  - How it works lists the keyboard shortcuts, with the keys for this platform; the view buttons' tooltips name them.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, frames, calm
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

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
        view = lambda: pg.evaluate("(u=>u.view==='canvas'?'canvas':u.layout)(__digress.conv.ui)")
        on = lambda: pg.evaluate("document.querySelector('#viewSeg button.on').dataset.v")

        check('(starts in Columns)', await view() == 'cols')
        await pg.locator('.pane[data-tid=main] textarea').focus()
        await pg.keyboard.press("ControlOrMeta+Quote"); await calm(pg)
        check("⌘' goes to the canvas, even while typing", await view() == 'canvas' and await on() == 'canvas', await view())
        await pg.keyboard.press("ControlOrMeta+Quote"); await calm(pg)
        check('…and again goes back to Columns', await view() == 'cols' and await on() == 'cols', await view())
        await pg.keyboard.press("ControlOrMeta+Shift+Quote"); await calm(pg)
        check("⌘⇧' switches to Rows", await view() == 'rows' and await on() == 'rows', await view())
        await pg.keyboard.press("ControlOrMeta+Quote"); await calm(pg)
        await pg.keyboard.press("ControlOrMeta+Quote"); await calm(pg)
        check('the canvas and back returns to Rows (what you had)', await view() == 'rows', await view())
        await pg.keyboard.press("ControlOrMeta+Quote"); await calm(pg)
        await pg.keyboard.press("ControlOrMeta+Shift+Quote"); await calm(pg)
        check("⌘⇧' on the canvas goes to the other of Columns and Rows", await view() == 'cols', await view())

        await pg.locator('#help summary').click(); await frames(pg)
        keys = await pg.locator('#help .keys').inner_text()
        check('How it works lists the shortcuts', all(x in keys for x in ['Ctrl+K', 'Ctrl+B', 'Ctrl+.', "Ctrl+'", "Ctrl+Shift+'", 'Space']), keys)
        tips = await pg.evaluate("[...document.querySelectorAll('#viewSeg button')].map(b=>b.title||b.dataset.tip)")
        check("the view buttons' tooltips name the shortcuts", all("Ctrl+" in t for t in tips), tips)
        await pg.locator('#help').screenshot(path=OUT + '/view_keys_help.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
