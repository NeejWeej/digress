"""Reading a web article: paste a link to a blog post and it opens like a document, in reader view.

Through the real server and a fake website: the page is downloaded with the same checks as PDF links,
only the article is kept (no navigation, footer or scripts; nothing on the page runs), as Markdown with
its links resolved. Images aren't downloaded: each becomes a placeholder with its description, until the
reader loads it (the server downloads it, only real PNG/JPEG/WebP/GIF) and a copy is kept with the
conversation. The model sees the placeholders as text and can look at the pictures with view_page, but
only the article's own image links. Asserts and exits non-zero.
"""
import asyncio, http.server, json, os, re, shutil, sys, tempfile, threading, time
from playwright.async_api import async_playwright
from common import OUT, launch_args, BOOT_WATCH, booted, replies, settled, answered, saved, soon, drawn
from common import CORS
from test_server import FAKES, CDN, start

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, ('' if ok else str(detail)[:600]))
    if not ok: fails.append(name)

def png(w=16, h=16):
    """A real 16x16 PNG (red), built by hand: signature, IHDR, IDAT, IEND."""
    import struct, zlib
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\xcc\x22\x22' * w for _ in range(h))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
PNG = png()
TEXT = ' '.join(['Attention compares every query with every key, and the softmax turns those scores into weights.'] * 6)
# math as KaTeX writes it (the TeX kept in an annotation beside MathML and drawn HTML), and as Wikipedia does
KATEX = lambda tex, rendered: (f'<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>{rendered}</mi></mrow>'
                              f'<annotation encoding="application/x-tex">{tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">{rendered}</span></span>')
MATH = (f'<p>The loss {KATEX("\\ell", "ℓ")} is the average surprisal, and the table is wide:</p>'
        f'<span class="katex-display">{KATEX("\\begin{array}{l r r} \\text{Dataset} & \\text{gzip} & \\text{Qwen3-14B} \\\\ \\text{Infini-News} & 3.0250 & 112001 \\end{array}", "DatasetgzipQwen3-14BInfini-News3.0250112001")}</span>'
        '<p>On Wikipedia: <span class="mwe-math-element"><math alttext="{\\displaystyle x_{1}^{2}}"><mi>x</mi></math><img class="mwe-math-fallback-image-inline" src="/eq.svg" alt="x_1^2"></span> squared.</p>')
ARTICLE = f'''<!doctype html><html><head><meta charset="utf-8"><title>Why attention scales | Test Blog</title>
<meta property="og:site_name" content="Test Blog"><meta name="author" content="Ada Writer"></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a> Subscribe to our newsletter</nav>
<script>window.__ran = 1; fetch('/tracker');</script>
<article><h1>Why attention scales</h1>
<p>{TEXT} Here is a <a href="/related">related post</a> and the marker ZEBRA-ART.</p>
<figure><img src="/fig1.png" alt="Loss curve"><figcaption>Figure 1: the loss falls as training goes on.</figcaption></figure>
<p>{TEXT}</p>
<a href="/big"><img src="/fig2.png" alt="Wrapped image"></a>
<p><img src="/logo.svg" alt="An SVG logo"></p>
<h2>Scaling by the square root</h2><p>{TEXT}</p>
{MATH}
</article><footer>Copyright footer junk, cookie settings</footer></body></html>'''.encode()


def fake_site():
    hits = {}
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            hits[self.path] = hits.get(self.path, 0) + 1
            routes = {'/post': ('text/html; charset=utf-8', ARTICLE), '/fig1.png': ('image/png', PNG), '/fig2.png': ('image/png', PNG),
                      '/logo.svg': ('image/svg+xml', b'<svg xmlns="http://www.w3.org/2000/svg"/>')}
            ct, body = routes.get(self.path, ('text/plain', b'nope'))
            self.send_response(200 if self.path in routes else 404); self.send_header('content-type', ct); self.send_header('content-length', str(len(body))); self.end_headers()
            self.wfile.write(body)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'127.0.0.1:{srv.server_address[1]}', hits


async def main():
    tmp = tempfile.mkdtemp(); site_srv, site, hits = fake_site()
    cc_log = os.path.join(tmp, 'claude.log'); open(cc_log, 'w').close()
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': os.path.join(tmp, 'd'), 'FAKE_LOG': cc_log, 'DOC_FETCH_TEST_ALLOW': site})
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            pg = await b.new_page(viewport={'width': 1500, 'height': 950}); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            async def route(r):
                u = r.request.url
                for k, v in CDN.items():
                    if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
                if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                await r.continue_()
            await pg.route('**/*', route)
            await pg.add_init_script(BOOT_WATCH); await pg.goto(base + '/'); await booted(pg)

            # open the article from its link (a plain-http, bare-IP test site, so it asks first)
            await pg.locator('#newDoc').click()
            await pg.locator('#docPaste').fill(f'http://{site}/post')
            await pg.locator('#docGo').click(); await soon(pg, "document.querySelector('#docGo').textContent==='Open anyway'")
            check('the link needs an OK first, like a PDF link', await pg.locator('#docGo').text_content() == 'Open anyway')
            await pg.locator('#docGo').click()
            await pg.wait_for_function("__digress.conv.doc&&__digress.conv.doc.article&&!!document.querySelector('.docwrap .abar')&&(document.querySelector('.docbody')||{}).textContent?.includes('ZEBRA-ART')")
            await drawn(pg)
            body = pg.locator('.docbody')
            text = await body.inner_text()
            check('the article opens in reader view: its heading and text', 'Why attention scales' in text and 'ZEBRA-ART' in text and 'Scaling by the square root' in text, text[:300])
            check('math (KaTeX, Wikipedia) comes through as TeX the page typesets, not run-together characters and escaped source',
                  await body.locator('.math mjx-container').count() == 3 and await body.locator('.math.display mjx-container').count() == 1 and await body.locator('.math.raw').count() == 0
                  and 'DatasetgzipQwen3' not in text and '\\\\ell' not in text and 'x_1^2' not in text and 'eq.svg' not in await body.inner_html(), text[-400:])
            check('…with who wrote it and where', 'Ada Writer' in text and 'Test Blog' in text, text[:200])
            check('…and without the page around it (navigation, footer)', 'Subscribe to our newsletter' not in text and 'cookie settings' not in text)
            check('nothing on the page ran (its script never fetched anything)', hits.get('/tracker', 0) == 0 and await pg.evaluate('typeof window.__ran') == 'undefined')
            check('the conversation is named after the article, without the site\'s name tacked on', (await pg.locator('.citem').first.text_content()).strip() == 'Why attention scales', await pg.locator('.citem').first.text_content())
            check('…and the title shows once, as the heading', text.count('Why attention scales') == 1, text[:200])
            link = await body.locator('a', has_text='related post').evaluate('a=>[a.href,a.target]')
            check('its links point where they did on the site, opening in a new tab', link == [f'http://{site}/related', '_blank'], link)

            # images: placeholders, nothing downloaded until asked
            figs = body.locator('.aimg')
            caps = await figs.locator('.acap').all_text_contents()
            check('each image is a placeholder that says what it was', caps == ['Image: Loss curve', 'Image: Wrapped image', 'Image: An SVG logo'], caps)
            check('…with the figure\'s caption kept as text', 'Figure 1: the loss falls as training goes on.' in text)
            check('no image was downloaded on opening', not any(k.endswith(('.png', '.svg')) for k in hits), hits)
            check('the bar above says how many images are not loaded', '3 images in this article, not loaded' in await pg.locator('.abar').text_content())
            orig = await figs.first.locator('.abtns a').evaluate('a=>[a.href,a.target,a.rel]')
            check('each can be opened as the original, in a new tab', orig == [f'http://{site}/fig1.png', '_blank', 'noopener noreferrer'], orig)
            await pg.screenshot(path=OUT + '/article.png')

            # load one: the server downloads it (after the OK this test site needs), a copy is kept
            await figs.first.locator('[data-aload]').click(); await pg.wait_for_function("i => !document.querySelectorAll('.docbody .aimg')[i].classList.contains('busy')", arg=0)   # that try is over
            check('loading an image from an http/bare-IP site asks first', 'Click again to load it anyway' in (await pg.locator('#toast').text_content() or ''))
            await figs.first.locator('[data-aload]').click(); await pg.wait_for_function("i => !document.querySelectorAll('.docbody .aimg')[i].classList.contains('busy')", arg=0)
            await soon(pg, "() => { const i = document.querySelector('.docbody .aimg .aview img'); return i && i.complete && i.naturalWidth > 0 }")
            check('…then it shows, downloaded once by the server', await figs.first.locator('.aview img').evaluate('i=>i.complete&&i.naturalWidth===16') and hits.get('/fig1.png') == 1, hits)
            check('the text is unchanged, so highlights still line up', (await body.inner_text()).replace('\n', '') == text.replace('\n', ''))
            await figs.nth(2).locator('[data-aload]').click(); await pg.wait_for_function("i => !document.querySelectorAll('.docbody .aimg')[i].classList.contains('busy')", arg=2)
            await figs.nth(2).locator('[data-aload]').click(); await pg.wait_for_function("i => !document.querySelectorAll('.docbody .aimg')[i].classList.contains('busy')", arg=2)
            check('an SVG is refused (only PNG, JPEG, WebP, GIF)', 'PNG, JPEG, WebP or GIF' in (await pg.locator('#toast').text_content() or '') and await figs.nth(2).locator('.aview').count() == 0)

            # the model: placeholders in the text; view_page shows the pictures in a part
            ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('READART what does the loss curve show?'); await answered(pg, ta.press('Enter'))
            await pg.wait_for_function("![...document.querySelectorAll('.sendb')].some(b=>b.title==='Stop')")
            sent = [json.loads(l) for l in open(cc_log).read().splitlines() if l.startswith('{') and '"system"' in l][-1]
            check('the model gets the article, told it is one and how to see its pictures', 'web article' in sent['system'] and f'[Image: Loss curve](http://{site}/fig1.png "digress-image")' in sent['system'] and 'view_page' in sent['system'], sent['system'][-900:])
            reply = await pg.locator('.pane[data-tid=main] .msg.assistant').last.inner_text()
            check('view_page on an article returns its pictures: the loaded one as an image', re.search(r'Part 1 has 3 pictures: \| text:\[Image: Loss curve\] \| image:image/png:\d+:png=true', reply) is not None, reply)
            check('…one not loaded yet needs the reader\'s OK, so the model is told that instead of getting it', 'Wrapped image] | text:(couldn’t be loaded: it needs the reader’s OK' in reply and hits.get('/fig2.png', 0) == 0, reply)
            check('…and the SVG is refused, with the reason', 'An SVG logo] | text:(couldn’t be loaded: That isn’t an image Digress shows' in reply, reply)

            # highlight a passage in the article: a branch about it, like any document
            await pg.evaluate('''() => { const b = document.querySelector('.docbody'); const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n;
              while ((n = w.nextNode())) { const i = n.nodeValue.indexOf('ZEBRA-ART'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 9);
              const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } } document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); }''')
            await pg.locator('#popIn').fill('What is this marker?'); await answered(pg, pg.locator('#popIn').press('Enter'))
            check('highlighting a passage in the article opens a branch about it, marked in the text', await pg.locator('.docbody .anchor').count() >= 1 and await pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').count() == 1)
            br = [json.loads(l) for l in open(cc_log).read().splitlines() if l.startswith('{') and '"system"' in l][-1]
            check('…and the model is told which passage', 'ZEBRA-ART' in br['prompt'] and 'Side question about this passage from the document' in br['prompt'], br['prompt'][:300])

            # it all stays: reload
            await saved(pg, layout=True); await pg.reload(); await booted(pg)
            await soon(pg, "() => (document.querySelector('.docbody')||{}).textContent?.includes('ZEBRA-ART') && [...document.querySelectorAll('.docbody .aimg.loaded .aview img')].some(i => i.complete && i.naturalWidth > 0)")
            check('after a reload the article and the loaded image are still there', 'ZEBRA-ART' in await pg.locator('.docbody').inner_text() and await pg.locator('.docbody .aimg.loaded .aview img').count() == 1 and hits.get('/fig1.png') == 1, hits)
            check('no page errors', not errs, errs[:3])
            await b.close()
    finally:
        proc.kill(); site_srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
