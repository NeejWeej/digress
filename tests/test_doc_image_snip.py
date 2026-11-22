"""Images in a text document can be branched from, like a PDF's pages: the whole image, or a box dragged on it with Snip.
  - A Markdown document's images (a data: URL and a remote one) each get a .dimg wrapper with an ask button and no text,
    so the text that anchors count is unchanged, and the pane's Snip button shows for the document.
  - Snip + drag over part of an image: the popover shows that part; asking opens a branch (t.anchorImg) whose first
    message carries exactly that part as an image (the left of a red|blue image: only red), with the image's alt text.
  - The ask button on a remote image: the server fetches it (fetch-doc, image:true; never the page itself) and keeps a
    copy with the conversation (doc.images); the model gets the whole image.
  - The branch's pane shows the image in its origin line; Show in source flashes the box; markers survive a reload.
  - A highlight branch in the same document keeps its anchor.
Asserts and exits non-zero."""
import asyncio, base64, json, struct, sys, zlib
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, frames, quiet, soon, OUT

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def png(w, h, px):
    """A PNG of w×h whose pixel (x, y) is px(x, y) = (r, g, b)."""
    raw = b''.join(b'\0' + b''.join(bytes(px(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

RB = base64.b64encode(png(200, 100, lambda x, y: (230, 20, 20) if x < 100 else (20, 20, 230))).decode()   # left red, right blue
GREEN = png(120, 120, lambda x, y: (20, 200, 40))
REMOTE = 'https://img.test/chart.png'
TEXT = f"""# Notes

Intro paragraph alpha.

![Red and blue](data:image/png;base64,{RB})

Middle text bravo charlie.

![Chart of growth]({REMOTE})

Closing words delta echo.
"""
SEED = r"""
const now = Date.now(), text = %s;
localStorage.setItem('fakesrv:convs/ci', JSON.stringify({id: 'ci', title: 'Notes', created: now, updated: now, rev: 1, doc: {kind: 'text', name: 'notes.md', text},
  threads: {main: {id: 'main', parent: null, title: 'Main thread', colorIdx: -1},
            hb: {id: 'hb', parent: 'main', anchorMsg: 'DOC', anchorText: 'bravo charlie', anchorPage: 0, title: 'A highlight', colorIdx: 0, created: now}},
  msgs: {}, order: {main: [], hb: []}, nextColor: 1}));
localStorage.setItem('fakesrv:layout/ci', JSON.stringify({devices: {other: {at: now, ui: {open: ['doc', 'main'], collapsed: [], layout: 'cols', view: 'panes', sizes: {}}}}}));
""" % json.dumps(TEXT)
FAKE = "window.fakeLLM = {use: async () => async (m, o) => ({text: 'It is what it is.'})}; window.fakeImages = {%s: %s};" % (json.dumps(REMOTE), json.dumps(base64.b64encode(GREEN).decode()))

# the image parts of chat request i, each as [width, height, [r,g,b] at 10%, 50% and 90% across the middle]
IMAGES = """async (i) => { const out = [];
  for (const m of window.__chatBodies[i].messages) for (const p of (Array.isArray(m.content) ? m.content : [])) {
    if (p.type !== 'image') continue;
    const bm = await createImageBitmap(await (await fetch('data:' + p.mediaType + ';base64,' + p.data)).blob());
    const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height; const ctx = cv.getContext('2d'); ctx.drawImage(bm, 0, 0);
    const at = (f) => [...ctx.getImageData(Math.floor(bm.width * f), Math.floor(bm.height / 2), 1, 1).data.slice(0, 3)];
    out.push([bm.width, bm.height, at(.1), at(.5), at(.9)]) }
  return out }"""
TEXT_OF = "(i) => window.__chatBodies[i].messages.map(m => typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('')).join('\\n')"
# text inside the image wrappers that anchors would count (the app's textWalker: everything but svg, math, mermaid, markers)
DIMG_TEXT = """[...document.querySelectorAll('.pane[data-tid=doc] .dimg')].map(w => { const t = document.createTreeWalker(w, NodeFilter.SHOW_TEXT,
  {acceptNode: n => n.parentElement.closest('svg,.math,.mermaid-box,mjx-container,sup.fn') ? 2 : 1}); let s = '', n; while ((n = t.nextNode())) s += n.nodeValue; return s.trim() }).join('')"""
SAVED = "JSON.parse(localStorage.getItem('fakesrv:convs/ci'))"
red = lambda c: c[0] > 180 and c[2] < 80
blue = lambda c: c[2] > 180 and c[0] < 80
green = lambda c: c[1] > 150 and c[0] < 80

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.route('https://img.test/**', lambda r: r.fulfill(body=GREEN, content_type='image/png'))   # the browser showing the remote image
        await pg.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');" + SEED + "}" + FAKE)
        await goto_app(pg); await booted(pg)
        doc = '.pane[data-tid=doc]'
        await pg.wait_for_function(f"document.querySelectorAll('{doc} .docbody .dimg').length === 2 && [...document.querySelectorAll('{doc} .dimg img')].every(i => i.naturalWidth)")
        check('both images are wrapped (a data: URL and a remote one)', True)
        check('…with no text added around them', await pg.evaluate(DIMG_TEXT) == '', await pg.evaluate(DIMG_TEXT))
        check('the highlight branch keeps its anchor', await pg.evaluate(f"(document.querySelector('{doc} .anchor[data-tid=hb]')||{{}}).textContent") == 'bravo charlie')
        check('the document pane offers Snip', await pg.locator(f'{doc} [data-act=snip]').is_visible())

        # snip the left part of the red|blue image
        await pg.locator(f'{doc} [data-act=snip]').click()
        box = await pg.locator(f'{doc} .dimg').first.bounding_box()
        await pg.mouse.move(box['x'] + 4, box['y'] + 4); await pg.mouse.down()
        await pg.mouse.move(box['x'] + box['width'] * 0.3, box['y'] + box['height'] * 0.6, steps=6)
        await pg.mouse.move(box['x'] + box['width'] * 0.45, box['y'] + box['height'] - 4, steps=6); await pg.mouse.up()
        await pg.wait_for_function("(() => { const i = document.querySelector('#pop.show .pimg'); return i && i.naturalWidth })()")
        check('the popover shows the snip, not the lightbox', await pg.locator('.lightbox').count() == 0)
        await pg.locator('#popIn').fill('What color is this?'); await pg.keyboard.press('Enter')
        await soon(pg, "window.__chatBodies && window.__chatBodies.length >= 1")
        imgs = await pg.evaluate(IMAGES, 0)
        check('the branch’s question carries one image', len(imgs) == 1, imgs)
        if imgs:
            w, h, a, m, z = imgs[0]
            check('…the part snipped: red only (the left 45% of a red|blue image)', red(a) and red(m) and red(z), imgs[0])
            check('…at its shape (about 0.45 wide by 1 tall, of a 2:1 image)', abs(w / h - 0.9) < 0.12, [w, h])
        txt = await pg.evaluate(TEXT_OF, 0)
        check('…and says it is part of an image in the document, with its alt text', 'this part of an image in the document' in txt and 'Red and blue' in txt, txt[-300:])
        await quiet(pg)
        saved = await pg.evaluate(SAVED)
        snip = next((t for t in saved['threads'].values() if t.get('anchorImg') and t['anchorImg']['w'] < 1), None)
        check('the branch keeps which image and the box (anchorImg)', bool(snip) and snip['anchorImg']['n'] == 0 and snip['anchorImg']['key'].startswith('data:') and 0.4 < snip['anchorImg']['w'] < 0.5, snip and snip['anchorImg'])
        check('…and a copy of the image is kept with the conversation', bool(snip) and snip['anchorImg']['key'] in (saved['doc'].get('images') or {}), list((saved['doc'].get('images') or {}).keys()))
        check('the box and a marker are drawn on the image', bool(snip) and await pg.locator(f'{doc} .dimg .dregion[data-tid={snip["id"]}]').count() == 1 and await pg.locator(f'{doc} .dimg sup.fn[data-tid={snip["id"]}]').count() == 1)
        if snip:
            pane = f'.pane[data-tid={snip["id"]}]'
            await pg.wait_for_function(f"(() => {{ const i = document.querySelector('{pane} .oimg img'); return i && i.naturalWidth }})()")
            check('the branch’s pane shows the snip where it came from', True)
            await pg.locator(f'{pane} [data-back]').first.click()
            await soon(pg, f"!!document.querySelector('{doc} .dregion.flash[data-tid={snip['id']}]')")
            check('Show in source flashes the box on the image', True)

        # the whole remote image, from its ask button
        second = pg.locator(f'{doc} .dimg').nth(1)
        await second.scroll_into_view_if_needed(); await second.hover()
        await second.locator('[data-iask]').click()
        await pg.wait_for_function("(() => { const i = document.querySelector('#pop.show .pimg'); return i && i.naturalWidth })()")
        check('the remote image was fetched by the server (fetch-doc), for the copy kept', REMOTE in (await pg.evaluate("window.__fetchedImages || []")))
        await pg.locator('#popIn').fill('What does the chart show?'); await pg.keyboard.press('Enter')
        await soon(pg, "window.__chatBodies && window.__chatBodies.length >= 2")
        n = await pg.evaluate("window.__chatBodies.length") - 1
        imgs = await pg.evaluate(IMAGES, n)
        check('the whole image goes to the model', len(imgs) == 1 and imgs[0][0] == 120 and imgs[0][1] == 120 and green(imgs[0][3]), imgs)
        check('…described as an image in the document', 'an image in the document ("Chart of growth")' in await pg.evaluate(TEXT_OF, n))
        await quiet(pg)
        saved = await pg.evaluate(SAVED)
        check('…and kept with the conversation under its URL', REMOTE in (saved['doc'].get('images') or {}))
        await pg.screenshot(path=OUT + '/doc_image_snip.png')

        await pg.reload(); await booted(pg)
        await pg.wait_for_function(f"document.querySelectorAll('{doc} .dimg sup.fn').length === 2", timeout=15000)
        check('after a reload: both markers are on their images', True)
        await pg.locator(f'{doc} .dimg').first.scroll_into_view_if_needed(); await pg.locator(f'{doc} .dimg').first.hover(); await frames(pg, 4)
        await pg.locator(doc).screenshot(path=OUT + '/doc_image_snip_doc.png')
        check('…and the highlight’s anchor is still right', await pg.evaluate(f"(document.querySelector('{doc} .anchor[data-tid=hb]')||{{}}).textContent") == 'bravo charlie')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
