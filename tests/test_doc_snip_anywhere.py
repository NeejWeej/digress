"""Snip anywhere in a text document, not only on an image (as in a PDF).
  - Snip shows for a text document; a box started on text, over a paragraph and part of an image, becomes a picture
    of that part: the model gets it (the paragraph's text drawn dark, the image's red where it was) with the text
    found in the box, the picture is kept as a file (anchorShot), and the box's text is marked in the document.
  - A box over a table: its words go along too.
  - A box inside one image is still a sharp crop of that image (anchorImg).
  - After a reload: the snip's text is still marked, its pane shows the picture, Show in source finds it.
  - With the pane zoomed (CSS zoom) and far down the document, the box is drawn under the pointer (it was off by the
    zoom, more the further down: off screen on a phone) and the picture is of what's inside it.
Asserts and exits non-zero."""
import asyncio, base64, json, struct, sys, zlib
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, quiet, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def png(w, h, px):
    raw = b''.join(b'\0' + b''.join(bytes(px(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

RB = base64.b64encode(png(200, 100, lambda x, y: (230, 20, 20) if x < 100 else (20, 20, 230))).decode()
TEXT = f"""# Snips

Alpha bravo charlie delta echo.

![Red and blue](data:image/png;base64,{RB})

Foxtrot golf hotel india.

| Col A | Col B |
|---|---|
| one | two |

Kilo lima mike.

Filler paragraph 0 with words to make the document long.\n\nFiller paragraph 1 with words to make the document long.\n\nFiller paragraph 2 with words to make the document long.\n\nFiller paragraph 3 with words to make the document long.\n\nFiller paragraph 4 with words to make the document long.\n\nFiller paragraph 5 with words to make the document long.\n\nFiller paragraph 6 with words to make the document long.\n\nFiller paragraph 7 with words to make the document long.\n\nFiller paragraph 8 with words to make the document long.\n\nFiller paragraph 9 with words to make the document long.\n\nFiller paragraph 10 with words to make the document long.\n\nFiller paragraph 11 with words to make the document long.\n\nFiller paragraph 12 with words to make the document long.\n\nFiller paragraph 13 with words to make the document long.\n\nFiller paragraph 14 with words to make the document long.\n\nFiller paragraph 15 with words to make the document long.\n\nFiller paragraph 16 with words to make the document long.\n\nFiller paragraph 17 with words to make the document long.\n\nFiller paragraph 18 with words to make the document long.\n\nFiller paragraph 19 with words to make the document long.\n\nFiller paragraph 20 with words to make the document long.\n\nFiller paragraph 21 with words to make the document long.\n\nFiller paragraph 22 with words to make the document long.\n\nFiller paragraph 23 with words to make the document long.\n\nFiller paragraph 24 with words to make the document long.\n\nFiller paragraph 25 with words to make the document long.\n\nFiller paragraph 26 with words to make the document long.\n\nFiller paragraph 27 with words to make the document long.\n\nFiller paragraph 28 with words to make the document long.\n\nFiller paragraph 29 with words to make the document long.\n\nFiller paragraph 30 with words to make the document long.\n\nFiller paragraph 31 with words to make the document long.\n\nFiller paragraph 32 with words to make the document long.\n\nFiller paragraph 33 with words to make the document long.\n\nFiller paragraph 34 with words to make the document long.\n\nFiller paragraph 35 with words to make the document long.\n\nFiller paragraph 36 with words to make the document long.\n\nFiller paragraph 37 with words to make the document long.\n\nFiller paragraph 38 with words to make the document long.\n\nFiller paragraph 39 with words to make the document long.\n\nFiller paragraph 40 with words to make the document long.\n\nFiller paragraph 41 with words to make the document long.\n\nFiller paragraph 42 with words to make the document long.\n\nFiller paragraph 43 with words to make the document long.\n\nFiller paragraph 44 with words to make the document long.\n\nFiller paragraph 45 with words to make the document long.\n\nFiller paragraph 46 with words to make the document long.\n\nFiller paragraph 47 with words to make the document long.\n\nFiller paragraph 48 with words to make the document long.\n\nFiller paragraph 49 with words to make the document long.\n\nFiller paragraph 50 with words to make the document long.\n\nFiller paragraph 51 with words to make the document long.\n\nFiller paragraph 52 with words to make the document long.\n\nFiller paragraph 53 with words to make the document long.\n\nFiller paragraph 54 with words to make the document long.\n\nFiller paragraph 55 with words to make the document long.\n\nFiller paragraph 56 with words to make the document long.\n\nFiller paragraph 57 with words to make the document long.\n\nFiller paragraph 58 with words to make the document long.\n\nFiller paragraph 59 with words to make the document long.

Target xray yankee zulu.

![Red and blue again](data:image/png;base64,{RB})
"""
SEED = r"""
const now = Date.now(), text = %s;
localStorage.setItem('fakesrv:convs/cs', JSON.stringify({id: 'cs', title: 'Snips', created: now, updated: now, rev: 1, doc: {kind: 'text', name: 'snips.md', text},
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1}}, msgs: {}, order: {main: []}, nextColor: 0}));
localStorage.setItem('fakesrv:layout/cs', JSON.stringify({devices: {other: {at: now, ui: {open: ['doc', 'main'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
""" % json.dumps(TEXT)
FAKE = "window.fakeLLM = {use: async () => async (m, o) => ({text: 'Noted.'})};"

# the last request's image: [width, height, pixel at (fx, fy) for each point given, darkest luminance in the band fy0..fy1]
ASKED = "window.__chatBodies.filter(b => !/^You name notes/.test(b.system || ''))"   # the questions, not the title calls
IMAGE = """async ([pts, band]) => { const body = """ + ASKED + """.at(-1); let p = null;
  for (const m of body.messages) for (const x of (Array.isArray(m.content) ? m.content : [])) if (x.type === 'image') p = x;
  if (!p) return null;
  const bm = await createImageBitmap(await (await fetch('data:' + p.mediaType + ';base64,' + p.data)).blob());
  const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height; const ctx = cv.getContext('2d'); ctx.drawImage(bm, 0, 0);
  const at = ([fx, fy]) => [...ctx.getImageData(Math.min(bm.width - 1, Math.floor(bm.width * fx)), Math.min(bm.height - 1, Math.floor(bm.height * fy)), 1, 1).data.slice(0, 3)];
  let dark = 255; if (band) { const y0 = Math.floor(bm.height * band[0]), y1 = Math.max(y0 + 1, Math.floor(bm.height * band[1]));
    const d = ctx.getImageData(0, y0, bm.width, y1 - y0).data; for (let i = 0; i < d.length; i += 4) dark = Math.min(dark, (d[i] + d[i + 1] + d[i + 2]) / 3) }
  return [bm.width, bm.height, pts.map(at), dark] }"""
LAST_TEXT = ASKED + ".at(-1).messages.map(m => typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('')).join('\\n')"
SAVED = "JSON.parse(localStorage.getItem('fakesrv:convs/cs'))"
DOC = '.pane[data-tid=doc]'
rect = lambda pg, sel: pg.locator(sel).first.bounding_box()

async def drag(pg, x0, y0, x1, y1):
    """Snip from (x0, y0) to (x1, y1); returns where the box was drawn just before letting go."""
    await pg.locator(f'{DOC} [data-act=snip]').click()
    await pg.mouse.move(x0, y0); await pg.mouse.down()
    await pg.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, steps=5); await pg.mouse.move(x1, y1, steps=5); await frames(pg, 2)
    drawn = await pg.evaluate("(() => { const r = document.querySelector('.snipbox').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom] })()")
    await pg.mouse.up()
    await pg.wait_for_function("(() => { const i = document.querySelector('#pop.show .pimg'); return i && i.naturalWidth })()", timeout=15000)
    return drawn

async def ask(pg, q):
    n = await pg.evaluate("window.__chatBodies ? " + ASKED + ".length : 0")
    await pg.locator('#popIn').fill(q); await pg.keyboard.press('Enter')
    await soon(pg, f"!!window.__chatBodies && {ASKED}.length > {n}", timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg)
        await pg.wait_for_function(f"(() => {{ const i = document.querySelector('{DOC} .dimg img'); return i && i.naturalWidth }})()")
        check('a text document offers Snip', await pg.locator(f'{DOC} [data-act=snip]').is_visible())

        # 1. a box started on text: the first paragraph and the top half of the image
        body = await rect(pg, f'{DOC} .docbody'); para = await rect(pg, f'{DOC} .docbody p'); img = await rect(pg, f'{DOC} .dimg')
        x0, y0 = body['x'] + 12, para['y'] - 6
        x1, y1 = img['x'] + img['width'] + 30, img['y'] + img['height'] * 0.5
        await drag(pg, x0, y0, x1, y1)
        await pg.screenshot(path=OUT + '/doc_snip_anywhere_pop.png')
        await ask(pg, 'What is in this part?')
        W, H = x1 - x0, y1 - y0
        red_at = ((img['x'] + img['width'] * 0.25 - x0) / W, (img['y'] + img['height'] * 0.25 - y0) / H)
        blue_at = ((img['x'] + img['width'] * 0.75 - x0) / W, red_at[1])
        band = ((para['y'] - y0) / H, (para['y'] + para['height'] - y0) / H)
        got = await pg.evaluate(IMAGE, [[red_at, blue_at], band])
        check('the model gets a picture of the box', bool(got), got)
        if got:
            w, h, (red, blue), dark = got
            check('…at the box’s shape', abs(w / h - W / H) < 0.08, [w, h, W, H])
            check('…with the image drawn where it was (red, then blue)', red[0] > 180 and red[2] < 90 and blue[2] > 180 and blue[0] < 90, [red, blue])
            check('…and the paragraph’s text drawn (dark ink on its line)', dark < 110, dark)
        sent = await pg.evaluate(ASKED + ".at(-1).messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'image').data")
        open(OUT + '/doc_snip_anywhere_sent.png', 'wb').write(base64.b64decode(sent))   # what the model got, to look at
        txt = await pg.evaluate(LAST_TEXT)
        check('…with the text found in the box', 'this part of the document' in txt and 'Alpha bravo charlie delta echo' in txt and 'Foxtrot' not in txt.split('this part of the document')[-1], txt[-300:])
        await quiet(pg)
        saved = await pg.evaluate(SAVED)
        shot = next((t for t in saved['threads'].values() if t.get('anchorShot')), None)
        check('the picture is kept as a file with the branch (anchorShot)', bool(shot) and bool(shot['anchorShot'].get('asset')) and shot['anchorShot']['w'] > 0, shot and shot.get('anchorShot'))
        check('…with its text and where it is (anchorRange)', bool(shot) and 'Alpha' in shot.get('regionText', '') and bool(shot.get('anchorRange')), shot)
        if shot:
            check('the box’s text is marked in the document', 'Alpha bravo' in (await pg.evaluate(f"[...document.querySelectorAll('{DOC} .anchor[data-tid={shot['id']}]')].map(a => a.textContent).join(' ')")))

        # 2. a box over the table
        await pg.locator(f'{DOC} table').scroll_into_view_if_needed()
        tb = await rect(pg, f'{DOC} table')
        await drag(pg, tb['x'] - 8, tb['y'] - 8, tb['x'] + tb['width'] + 8, tb['y'] + tb['height'] + 8)
        await ask(pg, 'Explain the table')
        txt = await pg.evaluate(LAST_TEXT)
        check('a box over a table: its words go with the picture', all(w in txt for w in ['Col A', 'Col B', 'one', 'two']), txt[-200:])
        got = await pg.evaluate(IMAGE, [[], None])
        check('…and the picture', bool(got) and got[0] > 50, got)

        # 3. a box inside the image is still a crop of the image
        await pg.locator(f'{DOC} .dimg').first.scroll_into_view_if_needed(); img = await rect(pg, f'{DOC} .dimg')
        await drag(pg, img['x'] + 5, img['y'] + 5, img['x'] + img['width'] * 0.4, img['y'] + img['height'] - 5)
        await ask(pg, 'And this?')
        await quiet(pg)
        saved = await pg.evaluate(SAVED)
        check('a box inside one image is a crop of it (anchorImg), as before', any(t.get('anchorImg') for t in saved['threads'].values()))
        got = await pg.evaluate(IMAGE, [[(0.5, 0.5)], None])
        check('…red only', bool(got) and got[2][0][0] > 180 and got[2][0][2] < 90, got)
        await pg.screenshot(path=OUT + '/doc_snip_anywhere.png')

        # 4. after a reload
        await pg.reload(); await booted(pg)
        if shot:
            await pg.wait_for_function(f"!!document.querySelector('{DOC} .anchor[data-tid={shot['id']}]')", timeout=15000)
            check('after a reload: the snip’s text is still marked', True)
            await pg.locator(f'.crumb, [data-map]').first.wait_for()
            await pg.evaluate(f"document.querySelector('{DOC} .anchor[data-tid={shot['id']}]').click()")
            pane = f'.pane[data-tid={shot["id"]}]'
            await pg.wait_for_function(f"(() => {{ const i = document.querySelector('{pane} .oimg img'); return i && i.naturalWidth }})()", timeout=15000)
            check('…its pane shows the picture', True)
            await pg.locator(f'{pane} .ol [data-back]').click()
            await soon(pg, f"!!document.querySelector('{DOC} .anchor.flash[data-tid={shot['id']}]')")
            check('…and Show in source finds its text', True)
        # 5. zoomed in, far down the document
        for _ in range(2): await pg.locator(f'{DOC} [data-act=zin]').click(); await frames(pg, 2)
        check('the document pane is zoomed', await pg.evaluate(f"getComputedStyle(document.querySelector('{DOC} .docwrap')).zoom") == '1.25')
        target = pg.locator(f'{DOC} p', has_text='Target xray yankee zulu'); await target.scroll_into_view_if_needed(); await frames(pg, 4)
        check('…and scrolled far down', await pg.evaluate(f"document.querySelector('{DOC} .pb').scrollTop") > 1500)
        tp = await target.bounding_box(); im2 = await pg.locator(f'{DOC} .dimg').nth(1).bounding_box()
        x0, y0, x1, y1 = tp['x'] - 6, tp['y'] - 6, im2['x'] + im2['width'] + 20, im2['y'] + im2['height'] * 0.5
        drawn = await drag(pg, x0, y0, x1, y1)
        check('…the box is drawn under the pointer', all(abs(a - b) < 3 for a, b in zip(drawn, [x0, y0, x1, y1])), [drawn, [x0, y0, x1, y1]])
        await ask(pg, 'And down here?')
        W, H = x1 - x0, y1 - y0
        red_at = ((im2['x'] + im2['width'] * 0.25 - x0) / W, (im2['y'] + im2['height'] * 0.25 - y0) / H)
        blue_at = ((im2['x'] + im2['width'] * 0.75 - x0) / W, red_at[1])
        band = ((tp['y'] - y0) / H, (tp['y'] + tp['height'] - y0) / H)
        got = await pg.evaluate(IMAGE, [[red_at, blue_at], band])
        if got:
            w, h, (red, blue), dark = got
            check('…and the picture is of what was inside it: its shape', abs(w / h - W / H) < 0.08, [w, h, W, H])
            check('…the image where it was', red[0] > 180 and red[2] < 90 and blue[2] > 180 and blue[0] < 90, [red, blue])
            check('…the paragraph’s text', dark < 110, dark)
        else: check('…and the picture is of what was inside it', False, got)
        check('…with its words', 'Target xray yankee zulu' in await pg.evaluate(LAST_TEXT))
        sent = await pg.evaluate(ASKED + ".at(-1).messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'image').data")
        open(OUT + '/doc_snip_anywhere_zoomed.png', 'wb').write(base64.b64decode(sent))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

if __name__ == "__main__": asyncio.run(main())
