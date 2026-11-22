"""Where a takeaway's knowledge ends, in its branch, and the links between the two.
  - A takeaway records the last message of its branch it saw (upTo).
  - While nothing has come after it, the branch shows nothing extra. Once the branch goes on, a divider ("Takeaway
    carried back to the main thread") sits right after that message: what's below isn't in the takeaway.
  - Clicking the divider goes to the takeaway in the parent; the branch's name in the takeaway's header goes to the
    last reply it saw. Both in Columns and on the canvas.
  - A takeaway made before upTo existed gets the same divider, worked out from the messages' times.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, calm, CORS, settle

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;
  const out=/takeaway/i.test(q)?'- The weights come from a softmax.\n- Scaling keeps it from saturating.':('A reply with a few sentences in it. '.repeat(14)+'\n\n').repeat(3);
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

# is this message in view in its scroll box, and flashing?
SEEN = """([sel, mid]) => { const box=document.querySelector(sel), m=box&&box.querySelector(`.msg[data-mid="${mid}"]`); if(!m) return null;
  const r=m.getBoundingClientRect(), c=box.getBoundingClientRect(); return [r.top < c.bottom - 20 && r.bottom > c.top + 20, m.classList.contains('flash')]; }"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        async def ask(tid, q):
            ta = pg.locator(f'.pane[data-tid="{tid}"] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await frames(pg)

        await ask('main', 'Explain attention')
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid="main"] .msg.assistant .body'); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n=w.nextNode(); while(n&&n.nodeValue.trim().length<25)n=w.nextNode();
          const r=document.createRange(); r.setStart(n,2); r.setEnd(n,20); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#pop.show').wait_for(); await pg.locator('#popIn').fill('Why a softmax?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        await ask(bt, 'And the scaling?')
        last = await pg.evaluate(f"__digress.conv.order['{bt}'].at(-1)")
        br = pg.locator(f'.pane[data-tid="{bt}"]')
        await br.locator('.ph [data-act=take]').click(); await answered(pg, br.locator('.tk .go').click())
        note = await pg.evaluate("Object.values(__digress.conv.msgs).find(m=>m.role==='note')")
        check('a takeaway records the last message of its branch it saw', note['upTo'] == last, [note.get('upTo'), last])
        check('while nothing has come after it, the branch shows no divider', await br.locator('.tkcut').count() == 0)

        await ask(bt, 'One more thing, after the takeaway?')
        cut = br.locator('.tkcut')
        check('once the branch goes on, a divider shows where the takeaway ends', await cut.count() == 1)
        around = await cut.evaluate("d=>[d.previousElementSibling&&d.previousElementSibling.dataset.mid, d.nextElementSibling&&d.nextElementSibling.classList.contains('user')]")
        check('…right after the last reply it saw, before the next question', around == [last, True], around)
        check('…saying where it went', 'Takeaway carried back to the main thread' in await cut.inner_text(), await cut.inner_text())
        await pg.screenshot(path=OUT + '/takeaway_cut.png')

        # the divider goes to the takeaway in the parent
        main_pb = '.pane[data-tid="main"] .pb'
        await pg.evaluate(f"document.querySelector('{main_pb}').scrollTop=0"); await frames(pg)
        await cut.click(); await settle(pg, 700)
        seen = await pg.evaluate(SEEN, [main_pb, note['id']])
        check('clicking the divider brings the takeaway into view in the parent, and flashes it', seen and all(seen), seen)

        # the takeaway's header goes to the last reply it saw
        bpb = f'.pane[data-tid="{bt}"] .pb'
        await pg.evaluate(f"document.querySelector('{bpb}').scrollTop=document.querySelector('{bpb}').scrollHeight"); await frames(pg)
        await pg.locator(f'.pane[data-tid="main"] .msg.note .nl').click(); await settle(pg, 700)
        seen = await pg.evaluate(SEEN, [bpb, last])
        check('the branch’s name in the takeaway goes to the last reply it saw, and flashes it', seen and all(seen), seen)

        # a takeaway from before upTo existed: the same divider, from the times
        await pg.evaluate("(()=>{const n=Object.values(__digress.conv.msgs).find(m=>m.role==='note');delete n.upTo})()")
        await ask(bt, 'And another, to redraw the branch?')
        around = await br.locator('.tkcut').evaluate("d=>d.previousElementSibling&&d.previousElementSibling.dataset.mid")
        check('a takeaway without upTo gets its divider in the same place (worked out from the times)', await br.locator('.tkcut').count() == 1 and around == last, around)

        # the canvas: the divider in the branch's card, and both links
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await pg.locator('#cv .cnode[data-ctid="main"]').wait_for(); await calm(pg)
        for tid in ('main', bt):
            if not await pg.locator(f'#cv .cnode[data-ctid="{tid}"] .cfull').count():
                await pg.evaluate(f"document.querySelector('#cv .cnode[data-ctid=\"{tid}\"] [data-cact=exp]').click()"); await pg.locator(f'#cv .cnode[data-ctid="{tid}"] .cfull').wait_for()
        card = f'#cv .cnode[data-ctid="{bt}"] .cfull'
        check('on the canvas, the branch’s card shows the divider too', await pg.locator(card + ' .tkcut').count() == 1)
        await pg.evaluate(f"document.querySelector('{card}').scrollTop=document.querySelector('{card}').scrollHeight"); await frames(pg)
        await pg.evaluate("document.querySelector('#cv .cnode[data-ctid=\"main\"] .msg.note .nl').click()"); await settle(pg, 800)
        seen = await pg.evaluate(SEEN, [card, last])
        check('…the takeaway’s header goes to the last reply it saw, in the branch’s card', seen and all(seen), seen)
        mcard = '#cv .cnode[data-ctid="main"] .cfull'
        await pg.evaluate(f"document.querySelector('{mcard}').scrollTop=0"); await frames(pg)
        await pg.evaluate(f"document.querySelector('{card} .tkcut').click()"); await settle(pg, 800)
        seen = await pg.evaluate(SEEN, [mcard, note['id']])
        check('…and the divider goes to the takeaway, in the parent’s card', seen and all(seen), seen)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
