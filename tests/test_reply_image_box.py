"""A reply's image, once the reader loads it, sits in a frame like a diagram's (`.rimgbox > .mm-view > img` and the
zoom strip `.mm-bar`): a tall picture is cut down to at most 420 px high and the column's width, a click on it
opens it full screen (Escape or a click closes that), the zoom button then "+" make it wider (data-k on the
box) and Fit brings it back, and none of it changes the reply's text, so a branch's anchors in it stay where they were.
Asserts and exits non-zero."""
import asyncio, json, struct, sys, zlib
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def png(w, h):
    raw = b''.join(b'\0' + b''.join(bytes([x % 256, y % 256, 120]) for x in range(0, w)) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 1)) + chunk(b'IEND', b'')

TALL = png(800, 2000)
URL = 'https://pics.test/tall.png'
A1 = f"Before the picture, some words. ![A tall chart]({URL}) After the picture, more words to land on."
SEED = r"""
const now = Date.now(), M = (id, role, content, ts) => ({id, role, thread: 'main', content, ts: now - 60000 + ts, ver: 0, ...(role === 'assistant' ? {model: 'sonnet'} : {})});
const msgs = {q1: M('q1', 'user', 'Show me the chart', 1), a1: M('a1', 'assistant', %s, 2)};
localStorage.setItem('fakesrv:convs/ci', JSON.stringify({id: 'ci', title: 'Pic', created: now, updated: now, rev: 1,
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}}, msgs, order: {main: ['q1', 'a1']}, nextColor: 0}));
localStorage.setItem('fakesrv:layout/ci', JSON.stringify({devices: {other: {at: now, ui: {open: ['main'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
""" % json.dumps(A1)
FAKE = "window.fakeLLM = {use: async () => async (m, o) => { const t = 'ok'; o.onText && o.onText({text: t}); return {text: t}; }};"
MSG = '.pane[data-tid=main] .msg[data-mid="a1"]'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        hits = []
        async def pics(r):
            hits.append(r.request.url); await r.fulfill(body=TALL, content_type='image/png')
        await pg.route('https://pics.test/**', pics)
        await pg.add_init_script(SEED); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await soon(pg, f"!!document.querySelector('{MSG} .rimg [data-rload]')")
        # what the text looks like with the picture waiting: anchors count this, whitespace aside
        text = f"document.querySelector('{MSG} .body').textContent.replace(/\\s+/g,'')"
        t0 = await pg.evaluate(text)
        check('nothing was fetched before the button', hits == [], hits)
        await pg.locator(f'{MSG} .rimg [data-rload]').click()
        await soon(pg, f"(()=>{{const i=document.querySelector('{MSG} .rimgbox .mm-view>img');return !!i&&i.complete&&i.naturalWidth>0}})()")
        check('the loaded image is a framed box with the zoom strip', await pg.locator(f'{MSG} .rimgbox > .mm-view > img').count() == 1 and await pg.locator(f'{MSG} .rimgbox > .mm-bar [data-mmz=tog]').count() == 1 and await pg.locator(f'{MSG} .rimg').count() == 0)
        check('…and only that image was fetched', set(hits) == {URL}, hits)
        img = pg.locator(f'{MSG} .rimgbox .mm-view>img')
        box = await pg.evaluate(f"""(()=>{{const i=document.querySelector('{MSG} .rimgbox .mm-view>img'),v=i.parentElement;return {{h:i.getBoundingClientRect().height,w:i.getBoundingClientRect().width,col:v.getBoundingClientRect().width,nat:[i.naturalWidth,i.naturalHeight]}}}})()""")
        check('a tall picture is shown at most 420 px high, no wider than its column', box['nat'] == [800, 2000] and 0 < box['h'] <= 420.5 and 0 < box['w'] <= box['col'] + 0.5, box)
        await pg.screenshot(path=OUT + '/reply_image_box.png')
        check('the reply’s text is the same after loading (anchors don’t move)', await pg.evaluate(text) == t0, [t0, await pg.evaluate(text)])
        # click opens the full-screen view; Escape, then a click, close it
        await img.click()
        await pg.locator('.lightbox').wait_for(timeout=5000)
        check('a click on the image shows it full screen', await pg.locator('.lightbox img').count() == 1)
        await pg.keyboard.press('Escape'); await pg.wait_for_function("!document.querySelector('.lightbox')", timeout=5000)
        check('Escape closes it', True)
        await img.click(); await pg.locator('.lightbox').wait_for(timeout=5000)
        await pg.locator('.lightbox').click(position={'x': 5, 'y': 5}); await pg.wait_for_function("!document.querySelector('.lightbox')", timeout=5000)
        check('a click closes it too', True)
        # zoom
        await pg.locator(f'{MSG} .rimgbox').hover()
        w0 = await img.evaluate('e=>e.getBoundingClientRect().width')
        await pg.locator(f'{MSG} .rimgbox [data-mmz=tog]').click()
        check('the zoom button turns the strip on', await pg.locator(f'{MSG} .rimgbox.mmz-on').count() == 1)
        await pg.locator(f'{MSG} .rimgbox [data-mmz=in]').click()
        await soon(pg, f"!!document.querySelector('{MSG} .rimgbox').dataset.k")
        w1 = await img.evaluate('e=>e.getBoundingClientRect().width'); k = await pg.locator(f'{MSG} .rimgbox').get_attribute('data-k')
        check('zooming in makes the image wider and sets data-k on the box', w1 > w0 * 1.3 and float(k) > 1, [w0, w1, k])
        check('…and a click on it no longer opens the full-screen view', (await img.click(), await pg.locator('.lightbox').count())[1] == 0)
        check('the reply’s text is still the same while zoomed', await pg.evaluate(text) == t0)
        await pg.locator(f'{MSG} .rimgbox [data-mmz=fit]').click()
        await soon(pg, f"!document.querySelector('{MSG} .rimgbox').dataset.k")
        w2 = await img.evaluate('e=>e.getBoundingClientRect().width'); h2 = await img.evaluate('e=>e.getBoundingClientRect().height')
        check('Fit puts it back (no data-k, the first size, still at most 420 px)', abs(w2 - w0) < 1 and h2 <= 420.5, [w0, w2, h2])
        # a branch on the words after the picture still lands on them, picture loaded
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg[data-mid="a1"] .body');
          const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf('land on'); if(i>=0){
          const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+7); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why?'); await pg.locator('#popIn').press('Enter')
        await soon(pg, "Object.values(__digress.conv.threads).some(t=>t.anchorMsg==='a1')")
        await pg.evaluate("__digress.refresh()"); await frames(pg, 3)
        check('a branch anchored after the loaded picture is marked on its words', await pg.evaluate(f"[...document.querySelectorAll('{MSG} .anchor')].map(x=>x.textContent).join('')") == 'land on')
        check('…and the picture is still loaded after the reply is drawn again', await pg.locator(f'{MSG} .rimgbox .mm-view>img').count() == 1)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
