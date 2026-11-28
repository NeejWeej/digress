"""The sidebar's width handle (#sgrip). Desktop: dragged by its edge (--sidew, sq:sidew). A phone (under 760px, where the
sidebar is an overlay drawer, #app.sideopen): the same handle, a 24px strip on the drawer's edge, with a width of its own
(--sidew-m, sq:sidew-m, 220px to the screen less 24); a width set on one doesn't change the other. Double-click resets.
Also: a conversation's folder tag in the list is small (icon + up to 5.5em of name, the icon alone on a phone) so a long
folder name doesn't squeeze the open conversation's title. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, quiet, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FOLDER = 'A very long folder name for testing'
TITLE = 'A rather long title for the open conversation here'
SEED = r"""
if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');
const now = Date.now();
localStorage.setItem('fakesrv:convs/f1', JSON.stringify({id: 'f1', title: %s, folder: %s, created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}},
  msgs: {u1: {id: 'u1', role: 'user', thread: 'main', content: 'Hi', ts: now}, a1: {id: 'a1', role: 'assistant', thread: 'main', content: 'Hello.', ts: now}},
  order: {main: ['u1', 'a1']}, nextColor: 1}));}
""" % (repr(TITLE).replace("'", '"'), repr(FOLDER).replace("'", '"'))
FAKE = "window.fakeLLM = {use: async () => async () => ({text: 'ok'})};"
SIDEW = "Math.round(document.querySelector('#side').getBoundingClientRect().width)"
LS = "k => localStorage.getItem(k)"

async def page(b, phone, init=''):
    kw = dict(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True) if phone else dict(viewport={'width': 1440, 'height': 860})
    pg = await b.new_page(**kw)
    pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    await pg.add_init_script(init + SEED + FAKE)
    await goto_app(pg); await booted(pg)
    return pg

async def open_drawer(pg):
    if not await pg.evaluate("document.querySelector('#app').classList.contains('sideopen')"):
        await pg.locator('#tSide').click()
    await pg.wait_for_function("document.querySelector('#app').classList.contains('sideopen') && document.querySelector('#side').getBoundingClientRect().width > 100")

async def grip_drag(pg, dx):
    g = await pg.locator('#sgrip').bounding_box()
    if not g: return   # no handle to drag (the checks after it report that)
    x, y = g['x'] + g['width'] / 2, g['y'] + g['height'] / 2
    await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + dx, y, steps=8); await pg.mouse.up()
    await frames(pg, 3)

async def dbl(pg):
    try: await pg.locator('#sgrip').dblclick(timeout=3000)
    except Exception as e:
        if 'Timeout' not in str(e): raise

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())

        # ---- phone
        pg = await page(b, True)
        check('phone: handle hidden while the drawer is closed', await pg.evaluate("getComputedStyle(document.querySelector('#sgrip')).display") == 'none')
        await open_drawer(pg)
        w0 = await pg.evaluate(SIDEW)
        check('phone: default drawer is 300px', w0 == 300, w0)
        g = await pg.locator('#sgrip').bounding_box() or {'width': 0, 'x': 0, 'height': 0}
        check('phone: handle is a 24px strip on the drawer’s right edge', abs(g['width'] - 24) <= 1 and abs(g['x'] + g['width'] / 2 - w0) <= 2 and g['height'] > 100, g)
        check('phone: handle is visible', await pg.locator('#sgrip').is_visible())
        await grip_drag(pg, 60)
        w1 = await pg.evaluate(SIDEW)
        check('phone: dragging right 60px widens the drawer by about that', abs(w1 - w0 - 60) <= 4, [w0, w1])
        check('phone: stored in sq:sidew-m, not sq:sidew', await pg.evaluate(LS, 'sq:sidew-m') == str(w1) and await pg.evaluate(LS, 'sq:sidew') is None,
              [await pg.evaluate(LS, 'sq:sidew-m'), await pg.evaluate(LS, 'sq:sidew')])
        check('phone: the strip follows the new edge', abs(((await pg.locator('#sgrip').bounding_box()) or {'x': -99})['x'] + 12 - w1) <= 2)
        await pg.screenshot(path=OUT + '/side_width_phone.png')
        await quiet(pg); await pg.reload(); await booted(pg); await open_drawer(pg)
        check('phone: the width is kept after a reload', abs(await pg.evaluate(SIDEW) - w1) <= 1, [await pg.evaluate(SIDEW), w1])
        await grip_drag(pg, 300)
        check('phone: far right clamps at the screen less 24', abs(await pg.evaluate(SIDEW) - (390 - 24)) <= 1, await pg.evaluate(SIDEW))
        await grip_drag(pg, -600)
        check('phone: far left clamps at 220', abs(await pg.evaluate(SIDEW) - 220) <= 1, await pg.evaluate(SIDEW))
        check('phone: the clamped width is what is stored', await pg.evaluate(LS, 'sq:sidew-m') == '220', await pg.evaluate(LS, 'sq:sidew-m'))
        await dbl(pg)
        check('phone: double-click resets to 300px', await soon(pg, f"{SIDEW} === 300"), await pg.evaluate(SIDEW))
        check('phone: double-click removes sq:sidew-m', await pg.evaluate(LS, 'sq:sidew-m') is None)

        # folder tag on a phone: icon only
        t = await pg.evaluate("""(() => { const f = document.querySelector('#clist .citem[data-conv=f1] .ftag'); if (!f) return null;
          const s = f.querySelector('span'); return {title: f.title, spanShown: !!s && getComputedStyle(s).display !== 'none', icon: !!f.querySelector('svg'), w: f.getBoundingClientRect().width} })()""")
        check('phone: the folder tag is there', t is not None, t)
        if t:
            check('phone: the folder tag is the icon alone', t['icon'] and not t['spanShown'] and t['w'] < 40, t)
            check('phone: its title names the folder', t['title'] == 'In the folder “' + FOLDER + '”', t['title'])
        check('phone: no page errors', not pg.errs, pg.errs[:3])
        await pg.close()

        # ---- desktop
        pg = await page(b, False)
        d0 = await pg.evaluate(SIDEW)
        await grip_drag(pg, 70)
        d1 = await pg.evaluate(SIDEW)
        check('desktop: dragging the edge widens the sidebar', abs(d1 - d0 - 70) <= 4, [d0, d1])
        check('desktop: sq:sidew set, the phone key not', await pg.evaluate(LS, 'sq:sidew') == str(d1) and await pg.evaluate(LS, 'sq:sidew-m') is None,
              [await pg.evaluate(LS, 'sq:sidew'), await pg.evaluate(LS, 'sq:sidew-m')])
        await grip_drag(pg, 2000)
        check('desktop: far right clamps at 620', await pg.evaluate(SIDEW) == 620, await pg.evaluate(SIDEW))
        await grip_drag(pg, -2000)
        check('desktop: far left clamps at 200', await pg.evaluate(SIDEW) == 200, await pg.evaluate(SIDEW))
        await dbl(pg)
        check('desktop: double-click resets and removes sq:sidew', await soon(pg, f"{SIDEW} === {d0}") and await pg.evaluate(LS, 'sq:sidew') is None, await pg.evaluate(SIDEW))
        check('desktop: no page errors', not pg.errs, pg.errs[:3])
        await pg.close()

        # a phone-width setting doesn't change the desktop width
        pg = await page(b, False, "try{localStorage.setItem('sq:sidew-m','250')}catch(e){}")
        check('desktop: sq:sidew-m is ignored', await pg.evaluate(SIDEW) == d0 and await pg.evaluate("document.querySelector('#app').style.getPropertyValue('--sidew-m')") != '', [await pg.evaluate(SIDEW), d0])
        await pg.close()
        # and a desktop setting doesn't change the phone's
        pg = await page(b, True, "try{localStorage.setItem('sq:sidew','500')}catch(e){}")
        await open_drawer(pg)
        check('phone: sq:sidew is ignored', await pg.evaluate(SIDEW) == 300, await pg.evaluate(SIDEW))
        await pg.close()

        # ---- folder tag on the desktop
        pg = await page(b, False)
        await pg.wait_for_selector('#clist .citem[data-conv=f1] .ftag')
        r = await pg.evaluate("""(() => { const row = document.querySelector('#clist .citem[data-conv=f1]'), f = row.querySelector('.ftag'), t = row.querySelector('.t');
          const fs = parseFloat(getComputedStyle(f).fontSize), lh = parseFloat(getComputedStyle(t).lineHeight) || fs * 1.4;
          const s = f.querySelector('span');
          return {side: document.querySelector('#side').getBoundingClientRect().width, tag: f.getBoundingClientRect().width, em: f.getBoundingClientRect().width / fs, title: f.title,
            tw: t.getBoundingClientRect().width, lines: Math.round(t.getBoundingClientRect().height / lh), row: row.getBoundingClientRect().width,
            spanShown: !!s && getComputedStyle(s).display !== 'none', clipped: !!s && s.scrollWidth > s.clientWidth, icon: !!f.querySelector('svg')} })()""")
        print(r)
        check('folder tag: at most about 5.5em wide', r['em'] <= 5.5 + 0.7, r)
        check('folder tag: icon and a clipped name on the desktop', r['icon'] and r['spanShown'] and r['clipped'], r)
        check('folder tag: the title gets most of the row and wraps in few lines', r['tw'] > r['tag'] * 2 and r['tw'] > r['row'] * 0.5 and r['lines'] <= 3, r)
        check('folder tag: its title names the folder', r['title'] == 'In the folder “' + FOLDER + '”', r['title'])
        await pg.screenshot(path=OUT + '/side_width_ftag.png')
        check('folder tag: no page errors', not pg.errs, pg.errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
