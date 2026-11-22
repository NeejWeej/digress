"""A document conversation on a phone-sized screen.
  - Zoom (− / + / Fit) is never hidden: a narrow pane header wraps its buttons onto another row instead,
    in Columns and in the document on the canvas.
  - On the canvas, the document card's Expand fills the canvas; Side keeps it to the left half; Expand again fills it.
  - The palette button is Appearance; its "Fit to this screen" undoes pane widths and zoom levels.
  - A layout taken from another device keeps the view and what's open, but not pane widths, zoom levels or
    cards stuck to the screen (sized for that device's screen).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, FIX, OUT, launch_args, goto_app, booted, frames, calm, saved, PDF_DRAWN_JS, CORS, settle

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const out='A reply.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

# the document pane's zoom buttons are drawn, and inside both the window and the box given (pane or card)
ZOOM_SHOWN = """(box)=>{const b=document.querySelector(box).getBoundingClientRect();
  return ['zout','zin','zfit'].every(a=>{const e=document.querySelector('.pane.docpane .ph [data-act='+a+']');if(!e||!e.getClientRects().length)return false;
    const r=e.getBoundingClientRect();return r.width>0&&r.left>=b.left-1&&r.right<=Math.min(b.right,innerWidth)+1&&r.top>=b.top-1})}"""
CARD = "(()=>{const c=document.querySelector('#dock .docpanecard').getBoundingClientRect(),v=document.getElementById('cv').getBoundingClientRect();return [Math.round(c.width),Math.round(v.width)]})()"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
        pg = await ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await pg.evaluate("document.querySelector('#newDoc').click()"); await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS); await frames(pg, 3)
        check('Columns on a phone: the document’s − / + / Fit are all showing', await pg.evaluate(ZOOM_SHOWN, '.pane.docpane'))

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await calm(pg)
        await pg.evaluate("document.querySelector('#cv .cnode[data-ctid=doc] [data-cact=docdock]').click()")
        await pg.wait_for_function("!!document.querySelector('#dock .docpanecard .pane.docpane .dpage canvas')", timeout=15000); await settle(pg, 500)
        w = await pg.evaluate(CARD)
        check('Expand fills the canvas', w[0] >= w[1] - 22, w)
        check('…and its zoom buttons are showing, inside the card', await pg.evaluate(ZOOM_SHOWN, '#dock .docpanecard'))
        await pg.screenshot(path=OUT + '/phone_fit_whole.png')
        await pg.locator('#dock .docpanecard [data-cact=docside]').click(); await frames(pg, 3)
        w2 = await pg.evaluate(CARD)
        check('Side keeps it to one side', w2[0] < w[0] - 40 and await pg.evaluate("__digress.conv.ui.cv.dock.doc.w") == 0.5, [w, w2])
        check('…and its zoom buttons still show', await pg.evaluate(ZOOM_SHOWN, '#dock .docpanecard'))
        await pg.locator('#dock .docpanecard [data-cact=docdock]').click(); await frames(pg, 3)
        check('Expand from there fills the canvas again', (await pg.evaluate(CARD))[0] >= w[1] - 22)

        # Appearance: Fit to this screen
        check('the palette button is Appearance', 'Appearance' in await pg.locator('#themeB').get_attribute('title'))
        await pg.locator('#dock .pane.docpane [data-act=zin]').click(); await pg.locator('#dock .pane.docpane [data-act=zin]').click()
        await pg.evaluate("__digress.conv.ui.sizes={main:900};__digress.conv.ui.cv.cz={main:1.6}")
        check('(set up: the document is zoomed in)', await pg.evaluate("(__digress.conv.ui.pz||{}).doc>1"))
        await pg.evaluate("document.querySelector('#themeB').click()")
        await pg.locator('.thmenu.open button[data-fitscreen]').click(); await frames(pg, 3)
        st = await pg.evaluate("[Object.keys(__digress.conv.ui.pz||{}).length,Object.keys(__digress.conv.ui.sizes).length,Object.keys(__digress.conv.ui.cv.cz||{}).length]")
        check('Fit to this screen: zoom back to 100%, no pane widths, no card zoom', st == [0, 0, 0], st)
        check('…and closes the menu', await pg.locator('.thmenu.open').count() == 0)

        # another device's layout: its widths, zoom and docked cards stay behind
        await pg.evaluate("__digress.conv.ui.sizes={doc:900}"); await pg.locator('#dock .pane.docpane [data-act=zin]').click()   # (zooming saves the layout)
        await saved(pg, layout=True)
        cid = await pg.evaluate("__digress.conv.id")
        moved = await pg.evaluate("""id=>{const k='fakesrv:layout/'+id,d=JSON.parse(localStorage.getItem(k));const mine=localStorage.getItem('digress:device');
          const ui=Object.values(d.devices)[0].ui;ui.sizes={doc:900};d.devices={dOTHERDEVICE:{ui,at:Date.now()}};localStorage.setItem(k,JSON.stringify(d));
          localStorage.setItem('digress:device','dTHISPHONE');return [!!ui.pz,!!ui.cv.dock]}""", cid)
        check('(set up: the other device’s layout has zoom and a docked document)', moved == [True, True], moved)
        await pg.reload(); await booted(pg); await frames(pg, 3)
        ui = await pg.evaluate("(()=>{const u=__digress.conv.ui;return [u.view,Object.keys(u.sizes||{}).length,Object.keys(u.pz||{}).length,!!(u.cv&&u.cv.dock&&u.cv.dock.doc),u.open.includes('doc')]})()")
        check('a layout from another device: same view and panes', ui[0] == 'canvas' and ui[4], ui)
        check('…without its pane widths, zoom or docked cards', ui[1:4] == [0, 0, False], ui)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
