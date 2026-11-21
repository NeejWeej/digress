"""The keyboard shortcuts panel.
  - ? opens it (not while typing) and closes it; Esc and ✕ close it too. How it works links to it.
  - It sits in a corner without a backdrop: the page around it still takes clicks, and the keys still work with it
    open, lighting up their row.
  - A filter narrows it; ⇆ moves it to the other corner, remembered. On a phone it's a sheet at the bottom.
  - README.md's table lists every key in it (one list in the code, KEYS; the README keeps up).
Asserts and exits non-zero."""
import asyncio, os, re, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, OUT, REPO

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FAKE = "window.fakeLLM = {use: async () => async (m, o) => ({text: 'ok'})};"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        shown = lambda: pg.evaluate("document.getElementById('keysPanel').classList.contains('show')")

        await pg.locator('.pane[data-tid=main] textarea').focus(); await pg.keyboard.type('?')
        check('? while typing is just a question mark', not await shown() and await pg.locator('.pane[data-tid=main] textarea').input_value() == '?')
        await pg.locator('.pane[data-tid=main] textarea').fill(''); await pg.evaluate("document.activeElement.blur()")
        await pg.keyboard.press('Shift+Slash'); await frames(pg)
        check('? opens the shortcuts panel', await shown())
        check('…without taking focus', await pg.evaluate("!document.getElementById('keysPanel').contains(document.activeElement)"))
        box = await pg.locator('#keysPanel').bounding_box()
        check('…in the bottom-right corner', box['x'] + box['width'] > 1240 and box['y'] + box['height'] > 760, box)
        check('…with nothing covering the rest of the page', await pg.evaluate("(()=>{const e=document.elementFromPoint(600,300);return !!e&&!e.closest('#keysPanel')&&!e.closest('.modal,.pal')})()"))
        text = await pg.locator('#keysPanel').inner_text()
        check('…listing the keys with this platform’s names', all(x in text for x in ['Ctrl+K', 'Ctrl+B', "Ctrl+Shift+'", 'Space', 'Esc']), text[:300])
        await pg.screenshot(path=OUT + '/keys_panel.png')

        side = lambda: pg.evaluate("document.getElementById('app').classList.contains('noside')")
        s0 = await side()
        await pg.keyboard.press('ControlOrMeta+b'); await frames(pg)
        check('a key still works with it open', await side() != s0)
        check('…and its row lights up', await pg.evaluate("[...document.querySelectorAll('#keysPanel .kprow.hit')].some(r=>/sidebar/.test(r.textContent))"))
        await pg.keyboard.press('ControlOrMeta+b'); await frames(pg)

        await pg.locator('#keysPanel .kpq').fill('canvas'); await frames(pg)
        secs = await pg.evaluate("[...document.querySelectorAll('#keysPanel .kpsec')].map(e=>e.textContent)")
        check('the filter narrows it', secs == ['On the canvas'] or (len(secs) <= 2 and 'On the canvas' in secs), secs)
        await pg.locator('#keysPanel .kpq').fill('zzzz'); await frames(pg)
        check('…and says when nothing matches', 'No shortcut matches' in await pg.locator('#keysPanel').inner_text())
        await pg.locator('#keysPanel .kpq').press('Escape')
        check('Esc in the filter clears it first', await pg.locator('#keysPanel .kpq').input_value() == '' and await shown())

        await pg.locator('#keysPanel [data-kp=side]').click(); await frames(pg)
        box = await pg.locator('#keysPanel').bounding_box()
        check('⇆ moves it to the other corner', box['x'] < 40, box)
        await pg.reload(); await booted(pg); await pg.evaluate("document.activeElement && document.activeElement.blur()"); await pg.keyboard.press('Shift+Slash'); await frames(pg)
        check('…remembered', (await pg.locator('#keysPanel').bounding_box())['x'] < 40)
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Esc closes it', not await shown())
        await pg.keyboard.press('Shift+Slash'); await frames(pg); await pg.keyboard.press('Shift+Slash'); await frames(pg)
        check('? again closes it', not await shown())

        await pg.locator('#help summary').click(); await frames(pg)
        check('How it works no longer has its own copy of the list', await pg.locator('#help .keys').count() == 0)
        await pg.locator('#help [data-keys]').click(); await frames(pg)
        check('…and links to the panel', await shown())
        await pg.locator('#keysPanel [data-kp=close]').click(); await frames(pg)
        check('✕ closes it', not await shown())

        # README.md lists every key in the panel
        keys = await pg.evaluate("__digress.keys")
        readme = open(os.path.join(REPO, 'README.md'), encoding='utf-8').read()
        table = readme.split('## Keyboard shortcuts', 1)[1].split('\n## ', 1)[0]
        flat = re.sub(r'\s+', '', re.sub(r'<[^>]+>', '', table)).replace('\\\\', '\\')
        mac = lambda k: k.replace('Mod+', '⌘').replace('Shift+', '⇧').replace('Alt+', '⌥')
        missing = [(sec, k) for sec, rows in keys for ks, what, m in rows for k in ks if re.sub(r'\s+', '', mac(k)) not in flat]
        check('README.md’s table lists every key in the panel', not missing, missing)

        ph = await b.new_page(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True)
        ph.on('pageerror', lambda e: errs.append(str(e)))
        await ph.add_init_script(FAKE); await goto_app(ph); await booted(ph)
        await ph.evaluate("document.activeElement && document.activeElement.blur()"); await ph.keyboard.press('Shift+Slash'); await ph.wait_for_timeout(400)
        box = await ph.locator('#keysPanel').bounding_box()
        check('on a phone it’s a sheet along the bottom', box and box['x'] <= 1 and box['width'] >= 388 and abs(box['y'] + box['height'] - 800) < 2, box)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
