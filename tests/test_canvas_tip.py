"""Canvas: the hover tip on a card's title bar ("Drag to move…") goes away as soon as a drag starts, doesn't
come back mid-drag, and works again afterwards. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, launch_args, goto_app, booted, answered, soon, frames, calm

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{const out='A short answer.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain gradients'); await answered(pg, ta.press('Enter'))
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await pg.locator('#cv .cnode[data-ctid="main"]').wait_for(); await calm(pg)
        shown = lambda: pg.evaluate("document.getElementById('tipbox').classList.contains('show')")
        bb = await pg.locator('#cv .cnode[data-ctid="main"] .ch').bounding_box()
        x, y = bb['x'] + 60, bb['y'] + bb['height'] / 2
        await pg.mouse.move(x, y); await soon(pg, "() => document.getElementById('tipbox').classList.contains('show')")   # after the 380 ms delay
        check('hovering the title bar shows the drag tip', await shown() and 'Drag' in await pg.locator('#tipbox').inner_text())
        await pg.mouse.down(); await frames(pg)
        check('pressing to drag hides it', not await shown())
        for i in range(1, 11): await pg.mouse.move(x + 20 * i, y + 8 * i); await pg.wait_for_timeout(60)
        await pg.wait_for_timeout(600)   # deliberate: past the 380 ms tip delay, so a tip that wrongly comes back would show
        check('it stays hidden while dragging', not await shown())
        await pg.mouse.up(); await pg.mouse.move(5, 400); await pg.wait_for_function("() => !document.getElementById('tipbox').classList.contains('show')")
        bb = await pg.locator('#cv .cnode[data-ctid="main"] .ch').bounding_box()
        await pg.mouse.move(bb['x'] + 60, bb['y'] + bb['height'] / 2); await soon(pg, "() => document.getElementById('tipbox').classList.contains('show')")
        check('after letting go, hovering shows it again', await shown())
        # a pending tip (pressed before it appeared) doesn't pop up mid-drag either
        await pg.mouse.move(5, 400); await pg.wait_for_function("() => !document.getElementById('tipbox').classList.contains('show')")
        bb = await pg.locator('#cv .cnode[data-ctid="main"] .ch').bounding_box(); x, y = bb['x'] + 60, bb['y'] + bb['height'] / 2
        await pg.mouse.move(x, y); await pg.wait_for_timeout(100); await pg.mouse.down()   # pressed 100 ms in: before the tip's 380 ms delay is up
        for i in range(1, 11): await pg.mouse.move(x - 10 * i, y + 5 * i); await pg.wait_for_timeout(60)
        check('a quick press-and-drag never shows it', not await shown())
        await pg.mouse.up()
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
