import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered
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
        pg = await b.new_page(viewport={'width': 1500, 'height': 560})
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
          while((n=w.nextNode())){const i=n.nodeValue.indexOf('training'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+8); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#pop.show').wait_for()
        pi = pg.locator('#popIn'); h0 = await pi.evaluate('e=>e.offsetHeight')
        await pi.click(); await pi.type('this is a long question that keeps going and going so that it wraps over several lines in the box ' * 2)
        h1 = await pi.evaluate('e=>e.offsetHeight')
        await pi.press('Shift+Enter'); await pi.type('and a second line')
        r = await pg.evaluate("(()=>{const r=document.getElementById('pop').getBoundingClientRect();return [Math.round(r.top),Math.round(r.bottom),innerHeight]})()")
        print('popup box grows:', h0, '->', h1, '| has newline:', '\n' in await pi.input_value(), '| popup top/bottom/viewport:', r)
        await pg.screenshot(path=OUT + '/pop.png')
        await answered(pg, pi.press('Enter'))
        print('Enter created branch:', await pg.locator('.pane').count()==2, '| question kept both lines:', await pg.evaluate("document.querySelectorAll('.pane')[1].querySelector('.msg.user .body').textContent.includes('second line')"))
        print('\n'.join(errs[:15]) or 'no errors')
        await b.close()
asyncio.run(main())
