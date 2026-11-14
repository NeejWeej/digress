import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered, frames, calm
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
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain attention'); await answered(pg, ta.press('Enter'))
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body'); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf('soft dictionary'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+15); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why a lookup?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await pg.locator('[data-v=canvas]').click(); await pg.locator('.cnode.main').wait_for(); await calm(pg); await pg.locator('#zFit').click(); await calm(pg)
        cvb = await pg.locator('#cv').bounding_box()
        rect = lambda sel: pg.evaluate("(s)=>{const r=document.querySelector(s).getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}", sel)
        # 1) drag the branch card to the right edge -> snaps to the right half, stuck
        card = pg.locator('.cnode:not(.main)').first; tid = await card.get_attribute('data-ctid')
        hb = await card.locator('.ch .ct').bounding_box()
        await pg.mouse.move(hb['x']+10, hb['y']+8); await pg.mouse.down()
        await pg.mouse.move(cvb['x']+cvb['width']-8, cvb['y']+cvb['height']/2, steps=12)
        print('snap preview shown:', await pg.locator('#snapPrev').evaluate("e=>getComputedStyle(e).display"))
        await pg.mouse.up(); await calm(pg)
        d = pg.locator(f'#dock .cnode[data-ctid="{tid}"]')
        r = await rect(f'#dock .cnode[data-ctid="{tid}"]')
        print('stuck to right half:', await d.count()==1, '| rect', r, '| canvas', [round(cvb['x']),round(cvb['y']),round(cvb['width']),round(cvb['height'])])
        print('stuck card shows full thread:', await d.locator('.cfull .msg').count(), '| line to it:', await pg.locator('#edges path').count())
        # 2) pan + zoom the canvas: stuck card stays put
        await pg.mouse.move(cvb['x']+200, cvb['y']+cvb['height']-60); await pg.mouse.down(); await pg.mouse.move(cvb['x']+260, cvb['y']+cvb['height']-120, steps=5); await pg.mouse.up()
        await pg.locator('#zOut').click(); await calm(pg)
        print('unmoved after pan/zoom:', await rect(f'#dock .cnode[data-ctid="{tid}"]')==r)
        # 3) per-card zoom on the main card with Alt+scroll, and via the header buttons
        main = pg.locator('#world .cnode.main'); mb = await main.bounding_box()
        w0 = await main.evaluate('e=>e.offsetWidth')
        await pg.mouse.move(mb['x']+40, mb['y']+60); await pg.keyboard.down('Alt'); await pg.mouse.wheel(0,-300); await pg.keyboard.up('Alt'); await calm(pg)
        print('alt+scroll card zoom:', await main.locator('.zl').text_content(), '| width', w0, '->', await main.evaluate('e=>e.offsetWidth'))
        await main.locator('.zl').evaluate('e=>e.click()'); await main.locator('.zin').evaluate("e=>{e.value='100';e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))}"); await calm(pg)
        print('reset:', await main.locator('.zl').text_content(), await main.evaluate('e=>e.offsetWidth')==w0)
        await main.locator('[data-cact=zin]').evaluate('e=>e.click()'); await calm(pg)
        print('header +:', await main.locator('.zl').text_content())
        # 4) Space reads the selected card full screen, Esc puts it back
        await main.locator('.ch .ct').dispatch_event('pointerdown'); await pg.keyboard.press('Space'); await calm(pg)
        print('space -> main stuck full screen:', await pg.locator('#dock .cnode.main').count(), await rect('#dock .cnode.main'))
        await pg.screenshot(path=OUT + '/k1.png')
        await pg.keyboard.press('Escape'); await calm(pg)
        print('esc -> back on canvas:', await pg.locator('#world .cnode.main').count(), '| still main zoom', await pg.locator('#world .cnode.main .zl').text_content())
        # 5) sticky toggle off: drop the right-half card onto the canvas where it is
        before = await rect(f'#dock .cnode[data-ctid="{tid}"]')
        await d.locator('[data-cact=stick]').click(); await calm(pg)
        after = await rect(f'#world .cnode[data-ctid="{tid}"]')
        print('unstick keeps it in place:', before, '->', after)
        # 6) sticky toggle on: lift it back onto the screen
        await pg.locator(f'#world .cnode[data-ctid="{tid}"] [data-cact=stick]').click(); await calm(pg)
        print('stick again ->', await pg.locator(f'#dock .cnode[data-ctid="{tid}"]').count(), await rect(f'#dock .cnode[data-ctid="{tid}"]'))
        # 7) drag the stuck card away from the edge -> back onto the canvas, follows the pointer
        hb = await pg.locator(f'#dock .cnode[data-ctid="{tid}"] .ch .ct').bounding_box()
        await pg.mouse.move(hb['x']+10, hb['y']+8); await pg.mouse.down(); await pg.mouse.move(cvb['x']+400, cvb['y']+300, steps=10); await pg.mouse.up(); await calm(pg)
        print('dragged off -> on canvas:', await pg.locator(f'#world .cnode[data-ctid="{tid}"]').count(), '| near pointer:', await rect(f'#world .cnode[data-ctid="{tid}"]'))
        # 8) keyboard snapping + persistence
        await pg.locator(f'#world .cnode[data-ctid="{tid}"] .ch .ct').click(); await pg.keyboard.press('Control+Alt+ArrowLeft'); await calm(pg)
        print('ctrl+alt+left -> left half:', await rect(f'#dock .cnode[data-ctid="{tid}"]'))
        await pg.locator('[data-v=cols]').click(); await calm(pg); await pg.locator('[data-v=canvas]').click(); await calm(pg)
        print('still stuck after switching views:', await pg.locator(f'#dock .cnode[data-ctid="{tid}"]').count())
        await pg.set_viewport_size({'width':1200,'height':800}); await calm(pg)
        print('follows window resize:', await rect(f'#dock .cnode[data-ctid="{tid}"]'))
        await pg.screenshot(path=OUT + '/k2.png')
        print('\n'.join(errs[:15]) or 'no errors')
        await b.close()
asyncio.run(main())
