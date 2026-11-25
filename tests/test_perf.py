"""Performance and memory-bounding checks:
  - Server serves gzip when Accept-Encoding: gzip is sent, and 304 Not Modified on matching ETag.
  - GET /api/store/convs?meta=1 returns metadata without message bodies and stays fresh across writes/deletes.
  - MathJax is lazy-loaded: not fetched on an empty page, loaded on demand when math appears.
  - PDF viewer evicts off-screen page canvases so DOM/GPU memory stays bounded on long PDFs.
  - Search index updates incrementally when a conversation changes.
Asserts and exits non-zero."""
import asyncio, gzip, json, os, sys, tempfile, urllib.request, urllib.error
from playwright.async_api import async_playwright
from common import BOOT_WATCH, OUT, launch_args, goto_app, booted, answered, calm, frames, pdf_drawn
from test_server import start, req

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def make_long_pdf(n_pages=26):
    """Minimal valid multi-page PDF with distinct text on each page (no external deps)."""
    objs = []
    def add(body):
        objs.append(body)
        return len(objs)
    cat = add('')
    pages_id = add('')
    font_id = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    kids = []
    for i in range(1, n_pages + 1):
        stream = f'BT /F1 18 Tf 72 720 Td (Page {i} unique_token_{i}) Tj ET'
        c_id = add(f'<< /Length {len(stream)} >>\nstream\n{stream}\nendstream')
        p_id = add(f'<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {c_id} 0 R >>')
        kids.append(f'{p_id} 0 R')
    objs[pages_id - 1] = f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count {n_pages} >>'
    objs[cat - 1] = f'<< /Type /Catalog /Pages {pages_id} 0 R >>'
    out = b'%PDF-1.4\n'
    offs = [0]
    for idx, body in enumerate(objs, 1):
        offs.append(len(out))
        out += f'{idx} 0 obj\n{body}\nendobj\n'.encode('latin1')
    xref = len(out)
    out += f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode('latin1')
    for o in offs[1:]:
        out += f'{o:010d} 00000 n \n'.encode('latin1')
    out += f'trailer\n<< /Size {len(objs) + 1} /Root {cat} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode('latin1')
    return out

def server_checks(base):
    # 1. Gzip + ETag / 304 on / and /styles.css
    for path in ('/', '/styles.css'):
        r = urllib.request.Request(base + path, headers={'Accept-Encoding': 'gzip'})
        with urllib.request.urlopen(r) as resp:
            enc = resp.headers.get('content-encoding')
            etag = resp.headers.get('etag')
            raw = resp.read()
        dec = gzip.decompress(raw) if enc == 'gzip' else raw
        check(f'{path}: gzip-compressed and smaller on the wire', enc == 'gzip' and len(raw) < len(dec) * 0.5, (enc, len(raw), len(dec)))
        check(f'{path}: returns ETag', bool(etag), etag)
        r304 = urllib.request.Request(base + path, headers={'If-None-Match': etag})
        st304 = None
        try:
            urllib.request.urlopen(r304)
        except urllib.error.HTTPError as e:
            st304 = e.code
        check(f'{path}: returns 304 on matching If-None-Match', st304 == 304, st304)

    # 2. ?meta=1 omits message bodies and stays fresh on update/delete
    big_msg = 'x' * 50000
    conv = {
        'id': 'c_perf', 'title': 'Perf test', 'updated': 1000, 'created': 900,
        'pinned': True, 'folder': 'Bench',
        'threads': {'main': {'id': 'main', 'title': 'Main'}, 'b1': {'id': 'b1', 'title': 'Sub', 'pinned': True, 'colorIdx': 2}},
        'order': {'main': ['m1']}, 'msgs': {'m1': {'id': 'm1', 'thread': 'main', 'role': 'assistant', 'content': big_msg}},
    }
    st, _ = req(base, 'PUT', '/api/store/convs/c_perf', conv)
    check('PUT conv succeeds', st == 200, st)
    st_m, body_m = req(base, 'GET', '/api/store/convs?meta=1')
    st_f, body_f = req(base, 'GET', '/api/store/convs')
    meta_rows = json.loads(body_m)
    check('?meta=1 returns metadata without msgs and is much smaller', st_m == 200 and st_f == 200 and len(body_m) < 2000 and len(body_f) > 50000, (len(body_m), len(body_f)))
    row = meta_rows[0]['data']
    check('?meta=1 preserves title, pinned, folder, pins', row.get('_meta') is True and row.get('title') == 'Perf test' and row.get('pinned') is True and row.get('folder') == 'Bench' and len(row.get('pins', [])) == 1 and 'msgs' not in row, row)

    # Update title and verify cache invalidation
    conv['title'] = 'Perf test renamed'
    req(base, 'PUT', '/api/store/convs/c_perf', conv)
    _, body_m2 = req(base, 'GET', '/api/store/convs?meta=1')
    check('?meta=1 reflects updated title immediately', json.loads(body_m2)[0]['data']['title'] == 'Perf test renamed', body_m2)

    # Delete and verify removal
    req(base, 'DELETE', '/api/store/convs/c_perf')
    _, body_m3 = req(base, 'GET', '/api/store/convs?meta=1')
    check('?meta=1 reflects deletion immediately', json.loads(body_m3) == [], body_m3)

FAKE = r"""
let n = 0;
window.fakeLLM = { use: async (name) => name === 'sample' ? async (input, opts) => {
  n++;
  const txt = n === 1
    ? 'Plain answer without math, token alpha_one.'
    : 'Second answer with math $x^2 + y^2 = z^2$ and token beta_two.';
  opts.onText && opts.onText({ text: txt });
  return { text: txt, truncated: false };
} : null };
"""

async def browser_checks():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        await pg.add_init_script(FAKE)
        await goto_app(pg)
        await booted(pg)

        # 1. Lazy MathJax: not loaded on empty page or plain reply, loads on math reply
        ta = pg.locator('.pane[data-tid=main] textarea')
        await ta.fill('first'); await answered(pg, ta.press('Enter'))
        check('MathJax not loaded when no math is rendered', not await pg.evaluate('!!(window.MathJax && window.MathJax.tex2svg)'))

        # 2. Incremental search index: open search, find alpha_one, then add beta_two and search again
        await pg.keyboard.press('Control+k')
        await pg.locator('#palIn').fill('alpha_one')
        await pg.wait_for_function("document.querySelectorAll('#palRes .pr').length > 0", timeout=15000)
        await pg.keyboard.press('Escape')

        await ta.fill('second'); await answered(pg, ta.press('Enter'))
        await pg.wait_for_function("!!(window.MathJax && window.MathJax.tex2svg && document.getElementById('MJX-SVG-styles'))", timeout=20000)
        check('MathJax lazy-loads once math appears and renders SVG', await pg.locator('span.math svg').count() >= 1)

        await pg.keyboard.press('Control+k')
        await pg.locator('#palIn').fill('beta_two')
        await pg.wait_for_function("document.querySelectorAll('#palRes .pr').length > 0", timeout=15000)
        check('incremental search index finds newly added reply', await pg.locator('#palRes .pr').count() >= 1)
        await pg.keyboard.press('Escape')

        # 3. PDF page eviction on a 26-page PDF
        pdf_path = os.path.join(OUT, f'perf_26p.{os.getpid()}.pdf')
        open(pdf_path, 'wb').write(make_long_pdf(26))
        try:
            await pg.locator('#newDoc').click()
            await pg.set_input_files('#docFile', pdf_path)
            await pg.locator('#docGo').click()
            await pdf_drawn(pg)
            # Scroll down through the PDF in steps so many pages enter and leave the viewport
            pb = pg.locator('.pane[data-tid=doc] .pb')
            for frac in (0.25, 0.5, 0.75, 1.0):
                await pb.evaluate('(e, f) => { e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) * f); }', frac)
                await frames(pg, 4)
            await pdf_drawn(pg)
            n_canvases = await pg.locator('.pane[data-tid=doc] .dpage canvas').count()
            check('PDF off-screen pages are evicted (canvases bounded <= 18 for 26p PDF)', 1 <= n_canvases <= 18, n_canvases)
        finally:
            try: os.remove(pdf_path)
            except OSError: pass

        check('no page errors', not errs, errs[:5])
        await b.close()

async def main():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': '/nonexistent/claude'})
        try:
            server_checks(base)
        finally:
            proc.terminate()
    await browser_checks()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    asyncio.run(main())
