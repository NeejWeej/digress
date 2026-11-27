"""Main and the document pane close like any other pane (✕), as long as another pane stays open.
  - ✕ on main closes it; the branches and the document stay. Opening a branch afterwards doesn't bring main back.
  - The last pane open can't be closed (a toast says so).
  - It stays closed after a reload (it's this window's layout).
  - Main thread, under Branches in the sidebar, brings main back, first (after the document); the document's row
    there brings the document back.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, answered, saved, frames, PDF_DRAWN_JS
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'pdfjs-dist@4.10.38/build/pdf.min.mjs': ROOT + 'pdfjs-dist/build/pdf.min.mjs',
    'pdfjs-dist@4.10.38/build/pdf.worker.min.mjs': ROOT + 'pdfjs-dist/build/pdf.worker.min.mjs',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='The paper argues that attention alone is enough. The weights come from a softmax over scores.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

opened = lambda pg: pg.evaluate("[...__digress.conv.ui.open]")
panes = lambda pg: pg.evaluate("[...document.querySelectorAll('#panes>.pane')].map(p=>p.dataset.tid)")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What does it argue?'); await answered(pg, ta.press('Enter'))
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf('softmax'); if(i>=0){
          const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+7); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why a softmax?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        check('(set up: the document, main and a branch)', await panes(pg) == ['doc', 'main', bt], await panes(pg))

        await pg.locator('.pane[data-tid=main] .ph [data-act=close]').click(); await frames(pg)
        check('✕ on main closes it; the document and the branch stay', await panes(pg) == ['doc', bt], await panes(pg))
        await pg.locator(f'.pane[data-tid="{bt}"] .ph [data-act=close]').click(); await frames(pg)
        await pg.locator(f'#side .mnode[data-map="{bt}"]').click(); await frames(pg)
        check('opening a branch again doesn’t bring main back', await panes(pg) == ['doc', bt], await panes(pg))
        await pg.screenshot(path=OUT + '/close_main.png')

        await pg.locator(f'.pane[data-tid="{bt}"] .ph [data-act=close]').click(); await frames(pg)
        await pg.locator('.pane[data-tid=doc] .ph [data-act=close]').click(); await frames(pg)
        check('the last pane open can’t be closed', await panes(pg) == ['doc'], await panes(pg))
        check('…a toast says so', 'At least one pane stays open' in await pg.locator('#toast').inner_text())

        await saved(pg, layout=True)
        await pg.reload(); await booted(pg); await pg.wait_for_function(PDF_DRAWN_JS)
        check('main stays closed after a reload', await opened(pg) == ['doc'], await opened(pg))

        await pg.locator('#side .mnode[data-map=main]').click(); await frames(pg)
        check('Main thread in the sidebar brings it back, after the document', await panes(pg) == ['doc', 'main'], await panes(pg))
        await pg.locator('.pane[data-tid=doc] .ph [data-act=close]').click(); await frames(pg)
        check('✕ on the document closes it', await panes(pg) == ['main'], await panes(pg))
        await pg.locator('#side [data-mapdoc]').click(); await frames(pg)
        check('the document’s row in the sidebar brings it back, first', await panes(pg) == ['doc', 'main'], await panes(pg))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
