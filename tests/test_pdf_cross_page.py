"""A passage selected across a PDF page break (the end of one page and the start of the next) opens the branch
popup like any other. The branch keeps where it ends (`anchorEnd`), both pages show the highlight (the marker
only where it starts), the model is told it's from pp. 1–2 with the whole passage, and deleting the branch
clears the highlight from both pages. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import FIX, launch_args, goto_app, booted, frames, pdf_drawn, settle
from common import CORS
from test_pane_zoom import MAP

FAKE = r"""
window.__calls=[];
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{window.__calls.push(input);const out='It carries on from one page to the next.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

SELECT = r"""(()=>{
  const t1=document.querySelector('.dpage[data-page="1"] .textLayer'),t2=document.querySelector('.dpage[data-page="2"] .textLayer');
  const s1=[...t1.querySelectorAll('span')].filter(s=>s.textContent.trim()).at(-1),s2=[...t2.querySelectorAll('span')].find(s=>s.textContent.trim());
  const r=document.createRange();r.setStart(s1.firstChild,0);r.setEnd(s2.firstChild,s2.firstChild.length);
  const sel=getSelection();sel.removeAllRanges();sel.addRange(r);
  return [s1.textContent,s2.textContent];
})()"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1200, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click(); await pdf_drawn(pg)
        # bring the page break into view, so page 2 is drawn too
        await pg.evaluate("(()=>{const pb=document.querySelector('.pane[data-tid=doc] .pb'),p2=pb.querySelector('.dpage[data-page=\"2\"]');pb.scrollTop+=p2.getBoundingClientRect().top-pb.getBoundingClientRect().top-pb.clientHeight/2})()")
        await pg.wait_for_function("!!document.querySelector('.dpage[data-page=\"2\"] .textLayer span')")
        last1, first2 = await pg.evaluate(SELECT)
        await pg.locator('#pop.show').wait_for(timeout=5000)
        check('the branch popup opens for a selection across pages', True)
        q = await pg.locator('#popQ').text_content()
        check('only the text layers are quoted (not the page number or buttons between pages)', 'Ask about' not in q, repr(q[-60:]))
        check('the popup quotes both pages', last1.strip()[:10] in q and first2.strip()[:10] in q, repr(q[-120:]))
        await pg.locator('#popIn').fill('What does this say?'); await pg.locator('#popIn').press('Enter')
        await pg.wait_for_function("window.__calls.length>0")
        t = await pg.evaluate("Object.values(__digress.conv.threads).find(t=>t.anchorMsg==='DOC')")
        check('the branch starts on page 1 and ends on page 2', t['anchorPage'] == 0 and (t.get('anchorEnd') or {}).get('page') == 1, repr({k: t.get(k) for k in ('anchorPage', 'anchorRange', 'anchorEnd')}))
        await settle(pg, 300)
        hl = await pg.evaluate("[1,2].map(n=>[...document.querySelectorAll(`.dpage[data-page=\"${n}\"] .anchor`)].map(a=>a.textContent).join(''))")
        check('page 1 highlights the passage up to its end', last1.strip()[:10] in hl[0].replace(' ', '') or last1.replace(' ', '')[:10] in hl[0].replace(' ', ''), repr(hl[0][-80:]))
        check('page 2 highlights the rest of it', first2.replace(' ', '')[:10] in hl[1].replace(' ', ''), repr(hl[1][:80]))
        markers = await pg.evaluate("[1,2].map(n=>document.querySelectorAll(`.dpage[data-page=\"${n}\"] sup.fn`).length)")
        check('one marker, where the passage starts', markers == [1, 0], repr(markers))
        sent = str(await pg.evaluate("JSON.stringify(window.__calls[0])"))
        check('the model is told the pages and gets the whole passage', 'pp. 1–2' in sent and first2.strip()[:10] in sent, '')
        # delete the branch: both pages lose the highlight
        await pg.locator('.pane:not([data-tid=doc]):not([data-tid=main]) [data-delb]').first.click(); await pg.locator('#mOk').click()
        await pg.wait_for_function("!document.querySelector('.dpage .anchor')", timeout=5000)
        check('deleting the branch clears both pages', True)
        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
