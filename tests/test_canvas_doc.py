"""The document on the canvas: its card's Expand (or snapping it to an edge) docks the real document pane
beside the canvas, at reading size: its pages are drawn sharp at that width, scrolling scrolls the PDF (not
the canvas), its own buttons work (page jump) and the pane-only ones (reorder, collapse, focus) are gone, a branch marker in it
brings that branch's card into view beside it (not behind it), it survives
the canvas redrawing, and switching back to Columns puts the pane back where it was. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, answered, PDF_DRAWN_JS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const out='A reply about the paper.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
        # a branch from the document, so it has a marker
        ok = await pg.evaluate("""() => { const tl=document.querySelector('.dpage[data-page="1"] .textLayer'); const w=document.createTreeWalker(tl,NodeFilter.SHOW_TEXT); let n=w.nextNode(); while(n&&n.nodeValue.trim().length<12)n=w.nextNode();
            const r=document.createRange(); r.setStart(n,0); r.setEnd(n,Math.min(10,n.nodeValue.length)); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); return true }""")
        await pg.locator('#pop.show').wait_for(); await pg.locator('#popIn').fill('What is this?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        cols_order = await pg.evaluate("[...document.querySelectorAll('#panes>.pane')].map(p=>p.dataset.tid)")

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()")
        await pg.locator('#cv .cnode[data-ctid="doc"]').wait_for()
        await pg.locator('#cv .cnode[data-ctid="doc"] [data-cact=docdock]').click()
        host = pg.locator('#dock .docpanecard')
        await host.wait_for(timeout=5000)
        await pg.wait_for_function("!!document.querySelector('#dock .docpanecard .cdocpane > .pane.docpane .dpage canvas')", timeout=15000)
        check('Expand docks the real document pane beside the canvas', await host.locator('.pane.docpane').count() == 1 and await pg.locator('#panes .pane.docpane').count() == 0)
        await pg.wait_for_timeout(600)   # (deliberate: the PDF re-fits 250 ms after the pane changes width)
        fit = await pg.evaluate("(()=>{const pb=document.querySelector('#dock .docpane .pb'),c=document.querySelector('#dock .docpane .dpage canvas');return [Math.round(c.getBoundingClientRect().width),pb.clientWidth]})()")
        check('its pages are drawn to its width (sharp: not scaled by the canvas)', fit[0] > fit[1] * 0.75 and fit[0] <= fit[1], fit)
        await pg.screenshot(path=OUT + '/canvas_doc_docked.png')

        cam0 = await pg.evaluate("document.getElementById('world').style.transform")
        pb = pg.locator('#dock .docpane .pb'); bb = await pb.bounding_box()
        await pg.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); await pg.mouse.wheel(0, 600); await pg.wait_for_timeout(300)
        check('scrolling over it scrolls the PDF, not the canvas', await pb.evaluate('e=>e.scrollTop') > 100 and await pg.evaluate("document.getElementById('world').style.transform") == cam0)

        await host.locator('[data-gopage]').click(); await host.locator('.pgin').fill('2'); await host.locator('.pgin').press('Enter')
        await pg.wait_for_function("document.querySelector('#dock .docpane .ph-origin').textContent.startsWith('Page 2')", timeout=10000)
        check('its own buttons work (jump to page 2), and it stays on the canvas', await pg.evaluate("__digress.conv.ui.view") == 'canvas')

        hidden = await host.evaluate("h=>['.pgrip','[data-act=collapse]','[data-act=focus]'].map(q=>{const e=h.querySelector('.ph '+q);return !e||e.getClientRects().length===0})")
        check('docked, it has no buttons for panes (reorder, collapse, focus)', all(hidden), hidden)

        # look elsewhere on the canvas, then follow a branch marker: its card comes into view beside the dock, not behind it
        await pg.mouse.move(1300, 500); await pg.mouse.down(); await pg.mouse.move(1450, 850, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(300)
        await pg.locator('#dock .docpane .pb').evaluate('e=>e.scrollTop=0'); await pg.wait_for_timeout(300)
        await host.locator(f'.dpage sup.fn[data-tid="{bt}"], .dpage .anchor[data-tid="{bt}"]').first.click(); await pg.wait_for_timeout(700)
        check('a branch marker in it goes to that branch’s card', await pg.locator(f'#cv .cnode[data-ctid="{bt}"].flash').count() == 1)
        seen = await pg.evaluate(f"""(()=>{{const n=document.querySelector('#cv .cnode[data-ctid="{bt}"]').getBoundingClientRect(),d=document.querySelector('#dock .docpanecard').getBoundingClientRect(),
          c=document.getElementById('cv').getBoundingClientRect();return [n.left>=d.right-1||n.right<=d.left+1, n.left>=c.left&&n.right<=c.right&&n.top>=c.top&&n.top<c.bottom-40]}})()""")
        check('…and that card is in view, not behind the docked document', all(seen), seen)

        # dragging the canvas (to pan) across the docked document, or across a card, selects nothing and asks nothing
        await pg.evaluate("getSelection().removeAllRanges()")
        d = await host.bounding_box(); cvb = await pg.locator('#cv').bounding_box(); y = d['y'] + d['height'] * 0.4
        x0 = (d['x'] + d['width'] + cvb['x'] + cvb['width']) / 2   # on the canvas beside the dock
        await pg.mouse.move(x0, cvb['y'] + 8); await pg.mouse.down()
        for i in range(1, 16): await pg.mouse.move(x0 + (d['x'] + 60 - x0) * i / 15, cvb['y'] + 8 + (y - cvb['y'] - 8) * i / 15); await pg.wait_for_timeout(15)
        off = await pg.evaluate("getComputedStyle(document.querySelector('#dock .docpane .textLayer span')).userSelect")
        # a browser can still extend a selection under a captured pointer (reported in Brave): make one mid-drag, as it would
        await pg.evaluate("""() => { const w=document.createTreeWalker(document.querySelector('#dock .docpane .textLayer'),NodeFilter.SHOW_TEXT); let t=w.nextNode(); while(t&&t.nodeValue.trim().length<12)t=w.nextNode();
          const r=document.createRange(); r.setStart(t,0); r.setEnd(t,10); getSelection().removeAllRanges(); getSelection().addRange(r); }""")
        await pg.mouse.up(); await pg.wait_for_timeout(300)
        check('while the canvas is dragged, no text can be selected (not even in the docked document)', off == 'none', off)
        check('…and letting go opens no branch popup, whatever got selected', not await pg.locator('#pop.show').count())
        await pg.evaluate("getSelection().removeAllRanges()")
        on = await pg.evaluate("getComputedStyle(document.querySelector('#dock .docpane .textLayer span')).userSelect")
        check('…and afterwards the document’s text can be highlighted again', on != 'none', on)

        await pg.evaluate("document.querySelector('#zTidy').click()"); await pg.wait_for_timeout(500)
        check('it survives the canvas redrawing', await host.locator('.pane.docpane .dpage canvas').count() > 0)

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=cols]').click()"); await pg.wait_for_timeout(600)
        back = await pg.evaluate("[...document.querySelectorAll('#panes>.pane')].map(p=>p.dataset.tid)")
        check('back in Columns, the pane is where it was', back == cols_order and await pg.locator('#panes .pane.docpane .dpage canvas').count() > 0, [cols_order, back])
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()")
        await pg.wait_for_function("!!document.querySelector('#dock .docpanecard .cdocpane > .pane.docpane')", timeout=5000)
        check('…and on the canvas again it’s still docked', True)
        await pg.locator('#dock .docpanecard [data-cact=restore]').click(); await pg.wait_for_timeout(400)
        check('putting it back makes it a card on the canvas again', await pg.locator('#dock .docpanecard').count() == 0 and await pg.locator('#world .cnode[data-ctid="doc"]').count() == 1)
        # snapping: drag the document's card to the right edge
        ch = pg.locator('#world .cnode[data-ctid="doc"] .ch .ct'); cb = await ch.bounding_box(); cvb = await pg.locator('#cv').bounding_box()
        await pg.mouse.move(cb['x'] + 10, cb['y'] + 5); await pg.mouse.down()
        for i in range(1, 13): await pg.mouse.move(cb['x'] + 10 + (cvb['x'] + cvb['width'] - 8 - cb['x'] - 10) * i / 12, cb['y'] + 5 + 60 * i / 12); await pg.wait_for_timeout(15)
        await pg.mouse.up()
        await pg.wait_for_function("!!document.querySelector('#dock .docpanecard .cdocpane > .pane.docpane')", timeout=5000)
        r = await pg.evaluate("(()=>{const c=document.getElementById('cv').getBoundingClientRect(),h=document.querySelector('#dock .docpanecard').getBoundingClientRect();return [Math.round(h.left-c.left),Math.round(c.width)]})()")
        check('dragging the document card to an edge snaps it there, as the document', r[0] > r[1] * 0.4, r)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
