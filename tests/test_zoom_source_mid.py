import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
FAKE = r"""
window.__calls=[];
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{window.__calls.push(input);
    const REPLY=(input[input.length-1].content.includes('Second')?'A reply about distributed consensus and leader election.':'## Overview\n\nThe paper frames attention as a soft dictionary lookup [p. 1]. The key trick is scaling scores [p. 2], which helps training [p. 3].');
    let out='';for(const ch of REPLY.match(/[\s\S]{1,30}/g)){out+=ch;opts.onText&&opts.onText({text:out});await new Promise(r=>setTimeout(r,5))}
    return {text:out,truncated:false};};
  return null;}};
"""
def clean(x): return x
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        pg.on('console', lambda m: m.type == 'error' and errs.append('console ' + m.text))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await pg.wait_for_timeout(1500)
        ta = pg.locator('.pane[data-tid=main] textarea')
        # a long main thread, so the branch's source passage sits far down inside the parent card
        for q in ['Q1','Q2','Q3','Q4','Q5','Q6','Q7','Q8','Q9','Q10']:
            await ta.fill(q); await ta.press('Enter'); await pg.wait_for_timeout(1500)
        await pg.evaluate("""() => { const bs=document.querySelectorAll('.pane[data-tid=main] .msg.assistant .body'); const b=bs[3]; const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf('soft dictionary'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+15); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.wait_for_timeout(200); await pg.locator('#popIn').fill('Why?'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(1800)
        await pg.locator('[data-v=canvas]').click(); await pg.wait_for_timeout(700)
        VIS = """() => { const f=document.querySelector('.cnode.main .cfull'); const a=f&&f.querySelector('.anchor'); if(!f||!a) return 'missing';
            const fr=f.getBoundingClientRect(), ar=a.getBoundingClientRect(), cv=document.getElementById('cv').getBoundingClientRect();
            return {inCard: ar.top>=fr.top-1 && ar.bottom<=fr.bottom+1, onScreen: ar.top>=cv.top && ar.bottom<=cv.bottom && ar.left>=cv.left && ar.right<=cv.right, flashing: a.classList.contains('flash'), at: Math.round(100*(ar.top-fr.top)/fr.height)+'% down the card', scrolled: Math.round(f.scrollTop)} }"""
        async def check(label, zoom, canvas_zoom_clicks=0, stick=False):
            await pg.locator('#zTidy').click(); await pg.wait_for_timeout(300)
            await pg.evaluate("(z)=>{const n=document.querySelector('.cnode.main');n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));}", zoom)
            # set the parent's own zoom with Alt+scroll-equivalent controls, starting from 100%
            await pg.locator('.cnode.main .zl').evaluate('e=>e.click()'); await pg.locator('.cnode.main .zin').evaluate("e=>{e.value='100';e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))}"); await pg.wait_for_timeout(100)
            steps = {1.0:0, 1.5:3, 0.66:-3}[zoom]
            for _ in range(abs(steps)): await pg.locator('.cnode.main [data-cact=%s]' % ('zin' if steps>0 else 'zout')).evaluate('e=>e.click()')
            for _ in range(canvas_zoom_clicks): await pg.locator('#zOut').click()
            if stick: await pg.locator('.cnode.main [data-cact=stick]').evaluate('e=>e.click()'); await pg.wait_for_timeout(300)
            if not await pg.locator('.cnode.main.exp').count(): await pg.locator('.cnode.main [data-cact=exp]').evaluate('e=>e.click()'); await pg.wait_for_timeout(300)
            await pg.locator('.cnode.main .cfull').evaluate('e=>e.scrollTop=0'); await pg.wait_for_timeout(150)
            await pg.locator('.cnode:not(.main) .cq').evaluate('e=>e.click()'); await pg.wait_for_timeout(700)
            print(f'{label} (card zoom {await pg.locator(".cnode.main .zl").text_content()}):', await pg.evaluate(VIS))
            if stick: await pg.locator('.cnode.main [data-cact=restore]').evaluate('e=>e.click()'); await pg.wait_for_timeout(300)
        await check('parent at 100%', 1.0)
        await check('parent zoomed in', 1.5)
        await check('parent zoomed out', 0.66)
        await check('parent zoomed in, canvas zoomed out', 1.5, canvas_zoom_clicks=3)
        await check('parent stuck to screen, zoomed in', 1.5, stick=True)
        print('\n'.join(errs[:15]) or 'no errors')
        await b.close()
asyncio.run(main())
