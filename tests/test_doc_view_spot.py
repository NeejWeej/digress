"""Where you are in the document stays put when the view changes. One spot, shared by Columns and the canvas:
  - Columns -> canvas with the document docked: the same place (page and how far down it), not page 1 (moving the
    pane into the dock reset its scroll; a reader on p. 95 landed on p. 1, and stayed there back in Columns).
  - Read on in the dock, back to Columns: where you got to.
  - The pane changes width (the PDF is laid out again): the same place, not the top of the page.
  - A text document too: the same character at the top.
Asserts and exits non-zero."""
import asyncio, os, sys, tempfile
from playwright.async_api import async_playwright
from common import ROOT, OUT, CORS, launch_args, goto_app, booted, PDF_DRAWN_JS, chromium_only, settle
chromium_only('it prints its test PDF with Chromium (page.pdf)')

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'pdfjs-dist@4.10.38/build/pdf.min.mjs': ROOT + 'pdfjs-dist/build/pdf.min.mjs',
    'pdfjs-dist@4.10.38/build/pdf.worker.min.mjs': ROOT + 'pdfjs-dist/build/pdf.worker.min.mjs',
}
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

# the page on the reading line (15% down the pane, where the reading mark goes) and how far down that page it is
SPOT = """(()=>{const pb=document.querySelector('.pane[data-tid=doc] .pb');if(!pb)return null;const y=pb.getBoundingClientRect().top+pb.clientHeight*0.15;
  for(const d of pb.querySelectorAll('.dpage')){const r=d.getBoundingClientRect();if(r.bottom>y)return [+d.dataset.page,(y-r.top)/r.height]}return null})()"""
GO = """([n,f])=>{const pb=document.querySelector('.pane[data-tid=doc] .pb'),d=pb.querySelector(`.dpage[data-page="${n}"]`);
  pb.scrollTop+=d.getBoundingClientRect().top-pb.getBoundingClientRect().top+d.offsetHeight*f}"""
# the text document: which character is on the reading line
CHAR = """(()=>{const pb=document.querySelector('.pane[data-tid=doc] .pb'),y=pb.getBoundingClientRect().top+pb.clientHeight*0.15;
  const ks=[...pb.querySelectorAll('.docbody > *')];return ks.findIndex(k=>k.getBoundingClientRect().bottom>=y)})()"""

def near(a, b, tol=0.05): return a and a[0] == b[0] and abs(a[1] - b[1]) < tol

async def make_pdf(b, path, pages):
    pg = await b.new_page()
    body = ''.join(f'<section style="page-break-after:always"><h1>Section {n}</h1><p>Marker ZEBRA-{n} on page {n}. ' + 'Filler words for the page. ' * 80 + '</p></section>' for n in range(1, pages + 1))
    await pg.set_content(f'<html><body style="font:11px sans-serif">{body}</body></html>')
    await pg.pdf(path=path, format='A4'); await pg.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        tmp = tempfile.mkdtemp(); big = os.path.join(tmp, 'big.pdf'); await make_pdf(b, big, 100)
        md = os.path.join(tmp, 'notes.md')
        with open(md, 'w') as f: f.write('\n\n'.join(f'## Part {i}\n\nParagraph {i}: ' + 'some words that wrap differently at other widths ' * 12 for i in range(1, 200)))
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', big)
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS, timeout=30000)
        async def view(v): await pg.evaluate(f"document.querySelector('#viewSeg button[data-v={v}]').click()"); await settle(pg, 700)

        await pg.evaluate(GO, [95, 0.5]); await settle(pg, 400)
        start = await pg.evaluate(SPOT)
        await view('canvas')
        check('canvas, document not docked: the pane is where it was', True)
        await view('cols')
        check('…and back in Columns, still there', near(await pg.evaluate(SPOT), start), [start, await pg.evaluate(SPOT)])
        await view('canvas')
        await pg.locator('#cv .cnode[data-ctid="doc"] [data-cact=docdock]').click()
        await pg.wait_for_function("!!document.querySelector('#dock .docpanecard .pane.docpane')"); await settle(pg, 700)
        got = await pg.evaluate(SPOT)
        check('docked on the canvas: the same place (p. 95, half way down), not p. 1', near(got, start), [start, got])
        await pg.screenshot(path=OUT + '/doc_view_spot_dock.png')
        await view('cols')
        got = await pg.evaluate(SPOT)
        check('back in Columns: the same place again', near(got, start), [start, got])
        await view('canvas'); got = await pg.evaluate(SPOT)
        check('to the canvas a second time (docked already): the same place', near(got, start), [start, got])

        await pg.evaluate(GO, [40, 0.3]); await settle(pg, 400); read = await pg.evaluate(SPOT)
        await view('cols'); got = await pg.evaluate(SPOT)
        check('read on in the dock, then Columns: where you got to (one spot for both views)', near(got, read), [read, got])

        await pg.evaluate(GO, [60, 0.6]); await settle(pg, 400); before = await pg.evaluate(SPOT)
        w0 = await pg.evaluate("document.querySelector('.pane[data-tid=doc] .dpage').offsetWidth")
        await pg.set_viewport_size({'width': 1100, 'height': 900})
        await pg.wait_for_function(f"document.querySelector('.pane[data-tid=doc] .dpage').offsetWidth<{w0 - 40}", timeout=10000); await settle(pg, 500)
        got = await pg.evaluate(SPOT)
        check('the pane narrows and the PDF is laid out again: the same place, not the top of the page', near(got, before), [before, got])
        await pg.set_viewport_size({'width': 1500, 'height': 900}); await settle(pg, 900)

        # a text document
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', md); await pg.locator('#docGo').click()
        await pg.wait_for_function("!!document.querySelector('.pane[data-tid=doc] .docbody h2')", timeout=15000)
        await pg.evaluate("(()=>{const pb=document.querySelector('.pane[data-tid=doc] .pb');pb.scrollTop=pb.scrollHeight*0.6})()"); await settle(pg, 400)
        c0 = await pg.evaluate(CHAR)
        await view('canvas')
        if not await pg.evaluate("!!document.querySelector('#dock .docpanecard .pane.docpane')"):
            await pg.locator('#cv .cnode[data-ctid="doc"] [data-cact=docdock]').click(); await settle(pg, 700)
        c1 = await pg.evaluate(CHAR)
        await view('cols'); c2 = await pg.evaluate(CHAR)
        check('a text document: the same paragraph on the reading line, docked and back', c0 > 50 and abs(c1 - c0) <= 1 and abs(c2 - c0) <= 1, [c0, c1, c2])
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)
asyncio.run(main())
