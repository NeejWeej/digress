"""A conversation started from a PDF is named after the PDF's own title (its metadata) when that's a real
title; junk titles fall back to the file name, and a title typed in the dialog always wins."""
import asyncio, os, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, SAVED_JS
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n==='sample'?async(input,opts)=>({text:'Sure.',truncated:false}):null};"""
fails = []
def check(ok, what):
    print(('ok  ' if ok else 'FAIL'), what)
    if not ok: fails.append(what)

def make_pdf(path, title):
    """A one-page PDF with a Title in its document info, written by hand (with a correct xref)."""
    esc = title.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
    text = b'BT /F1 18 Tf 72 720 Td (Attention is a soft lookup.) Tj ET'
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>',
            b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            b'<< /Length %d >>\nstream\n' % len(text) + text + b'\nendstream',
            b'<< /Title (' + esc.encode('latin-1') + b') /Producer (hand) >>']
    out, offs = bytearray(b'%PDF-1.4\n'), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out)); out += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    x = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offs)
    out += b'trailer\n<< /Size %d /Root 1 0 R /Info 6 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, x)
    open(path, 'wb').write(bytes(out))

async def main():
    good, junk = os.path.join(OUT, 'attention-v3.pdf'), os.path.join(OUT, 'notes_final.pdf')
    make_pdf(good, '  Attention   Is All\tYou Need ')
    make_pdf(junk, 'Microsoft Word - notes.docx')
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 900})
        pg.on('pageerror', lambda e: print('PAGEERR', e))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)

        title = lambda: pg.locator('#cTitle').text_content()
        # the saved copy of the newest conversation (the app's state is private to its script)
        saved = lambda: pg.evaluate("""Object.keys(localStorage).filter(k=>k.startsWith('fakesrv:convs/')).map(k=>JSON.parse(localStorage.getItem(k))).sort((a,b)=>b.created-a.created)[0]""")
        async def start(path, typed=''):
            before = await pg.evaluate('__digress.conv.id')
            await pg.locator('#newDoc').click()
            await pg.set_input_files('#docFile', path)
            await pg.locator('#docName').fill(typed)
            await pg.locator('#docGo').click()
            # the new conversation has its document, the PDF's metadata has been looked at (autoTitle dropped), and it's saved
            await pg.wait_for_function(f"id => {{ const c = __digress.conv; return c.id !== id && c.doc && !('autoTitle' in c) && {SAVED_JS} }}", arg=before)
            s = await saved()
            return [await title(), s['title'], s['doc']['name'], 'autoTitle' in s]
        async def ask(q):
            ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter'))

        t = await start(good); print('good PDF:', t)
        check(t[0] == t[1] == 'Attention Is All You Need', 'a real metadata title names the conversation, and is saved')
        check(t[2] == 'attention-v3' and not t[3], 'the document keeps its file name')
        await ask('What is this about?')
        check(await title() == 'Attention Is All You Need', 'the first question keeps the PDF title')

        t = await start(junk); print('junk PDF:', t)
        check(t[0] == t[1] == 'notes_final', 'a junk metadata title ("Microsoft Word - notes.docx") falls back to the file name')
        await ask('A question names it, as before')
        check(await title() == 'A question names it, as before', 'without a PDF title, the first question still names the conversation')

        t = await start(good, 'My reading'); print('typed:', t)
        check(t[0] == t[1] == 'My reading', 'a typed title wins over the metadata')
        await ask('First question')
        check(await title() == 'My reading', 'and over the first question')

        t = await start(junk)
        await pg.locator('#cTitle').click(); await pg.keyboard.press('Control+A'); await pg.keyboard.type('Renamed'); await pg.keyboard.press('Enter')
        await ask('Another question')
        check(await title() == 'Renamed', 'a rename is kept when the first question is asked')
        for name in ('untitled', 'Slide 1', 'paper.pdf', 'Title'):
            path = os.path.join(OUT, 'junk-title.pdf'); make_pdf(path, name)
            t = await start(path)
            check(t[0] == 'junk-title', f'metadata title {name!r} is ignored')
        await b.close()
    print('\n' + (f'{len(fails)} failed' if fails else 'all passed'))
    sys.exit(1 if fails else 0)
asyncio.run(main())
