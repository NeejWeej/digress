"""Collapsing and closing the pane you're in from the keyboard.
  - The pane you last clicked, typed in or scrolled is outlined (.cur) when there's more than one.
  - ⌘\\ / Ctrl+\\ collapses it to a strip, and again expands it; ⌘⇧\\ / Ctrl+Shift+\\ closes it (also while typing),
    the next pane becomes the one you're in, and the toast's Undo puts it back where it was.
  - The last pane open stays open. On the canvas, ⌘\\ expands or shrinks the selected card.
  - The buttons' tooltips and How it works name the keys.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, calm
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='Attention is a soft dictionary lookup over the keys, scaled by the square root of the dimension.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

COLLAPSE, CLOSE = 'ControlOrMeta+Backslash', 'ControlOrMeta+Shift+Backslash'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1600, 'height': 900})
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
        for word, q in [('soft dictionary', 'Why soft?'), ('square root', 'Why the root?')]:
            await pg.evaluate('''(word) => { const body = document.querySelector('.pane[data-tid=main] .msg.assistant .body');
              const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(word);
              if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
              document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }''', word)
            await pg.locator('#popIn').fill(q); await answered(pg, pg.locator('#popIn').press('Enter'))
        order = await pg.evaluate("[...__digress.conv.ui.open]")
        b1, b2 = order[1], order[2]
        cur = lambda: pg.evaluate("[...document.querySelectorAll('#panes>.pane.cur')].map(p=>p.dataset.tid)")
        rails = lambda: pg.evaluate("[...document.querySelectorAll('#panes>.pane.rail')].map(p=>p.dataset.tid)")
        opened = lambda: pg.evaluate("[...__digress.conv.ui.open]")

        await pg.locator(f'.pane[data-tid="{b1}"] textarea').focus(); await frames(pg)
        check('the pane you’re typing in is outlined, and only it', await cur() == [b1], await cur())
        await pg.keyboard.press(COLLAPSE); await frames(pg)
        check('⌘\\ collapses it to a strip (while typing)', await rails() == [b1] and await cur() == [b1], [await rails(), await cur()])
        await pg.keyboard.press(COLLAPSE); await frames(pg)
        check('…and again expands it', await rails() == [], await rails())

        await pg.locator(f'.pane[data-tid="{b1}"] textarea').focus()
        await pg.keyboard.press(CLOSE); await frames(pg)
        check('⌘⇧\\ closes it', await opened() == ['main', b2], await opened())
        check('…the next pane becomes the one you’re in', await cur() == [b2], await cur())
        check('…and a toast says so, with Undo', 'Closed “Why soft?”' in await pg.locator('#toast').inner_text() and await pg.locator('#toast .tact').inner_text() == 'Undo', await pg.locator('#toast').inner_text())
        await pg.screenshot(path=OUT + '/pane_keys.png')
        await pg.locator('#toast .tact').click(); await frames(pg)
        check('Undo puts it back where it was', await opened() == order and await cur() == [b1], [await opened(), await cur()])

        await pg.locator(f'.pane[data-tid="{b2}"] .pb').click(); await frames(pg)
        check('clicking a pane makes it the one you’re in', await cur() == [b2], await cur())
        for _ in range(2): await pg.keyboard.press(CLOSE); await frames(pg)
        left = await opened()
        check('closing again and again leaves one pane', len(left) == 1, left)
        check('…with no outline when it’s the only one', await cur() == [], await cur())
        await pg.keyboard.press(CLOSE); await frames(pg)
        check('the last pane stays open', await opened() == left and 'At least one pane stays open' in await pg.locator('#toast').inner_text(), await opened())

        # the canvas: the selected card
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await pg.locator(f'#cv .cnode[data-ctid="{b2}"]').wait_for(); await calm(pg)
        await pg.locator(f'#cv .cnode[data-ctid="{b2}"] .ch').click(); await frames(pg)
        full = lambda: pg.locator(f'#cv .cnode[data-ctid="{b2}"] .cfull').count()
        before = await full()
        await pg.keyboard.press(COLLAPSE); await calm(pg)
        after = await full()
        check('on the canvas, ⌘\\ expands the selected card', before == 0 and after == 1, [before, after])
        await pg.keyboard.press(COLLAPSE); await calm(pg)
        check('…and shrinks it again', await full() == 0)

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=cols]').click()"); await calm(pg)
        tips = await pg.evaluate("[...document.querySelectorAll('#panes .ph [data-act=collapse], #panes .ph [data-act=close]')].map(b=>b.title||b.dataset.tip)")
        check('the collapse and close buttons’ tooltips name the keys', tips and all('Ctrl+\\' in t or 'Ctrl+Shift+\\' in t for t in tips), tips)
        await pg.locator('#help summary').click(); await frames(pg)
        keys = await pg.locator('#help .keys').inner_text()
        check('How it works lists them', 'Ctrl+\\' in keys and 'Ctrl+Shift+\\' in keys, keys)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
