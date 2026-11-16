"""On the canvas, jumping from a branch to where it came from can be undone, for any parent card (as in Columns).
  - Clicking a branch card's quote scrolls its parent card to the passage. If you were reading somewhere else in the
    parent, its jump buttons show Return, which scrolls back there and then goes away.
  - It works whether the parent is the main thread or another branch, and it survives the canvas redrawing.
  - A branch about a whole reply (no passage) has a line, "The whole reply", that jumps to that reply the same way.
  - Scrolling back near the spot yourself also makes Return go away.
  - (A docked document is the real document pane, which has its own Return: tests/test_canvas_doc.py.)
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, calm, CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
# long replies, so an open card scrolls a long way
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out=('A reply with a few sentences in it. '.repeat(25)+'\n\n').repeat(4);opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

card = lambda tid: f'#cv .cnode[data-ctid="{tid}"]'
TOP = "sel=>Math.round(document.querySelector(sel+' .cfull').scrollTop)"
RET = "sel=>{const b=document.querySelector(sel+' .cjump .cjp');return !!b&&b.getClientRects().length>0}"

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
        async def branch_from(tid, q):   # a branch about a passage near the start of tid's first reply (so its card has a quote)
            before = await pg.evaluate('Object.keys(__digress.conv.threads)')
            await pg.evaluate("""tid => { const b=document.querySelector(`.pane[data-tid="${tid}"] .msg.assistant .body`);
              const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); const n=w.nextNode(); const r=document.createRange(); r.setStart(n,2); r.setEnd(n,22);
              const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""", tid)
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill(q); await answered(pg, pg.locator('#popIn').press('Enter'))
            new = await pg.evaluate(f"Object.keys(__digress.conv.threads).find(t=>!{json.dumps(before)}.includes(t))")
            return new

        await ask('main', 'Explain attention')
        b1 = await branch_from('main', 'Why a softmax?')
        for i in range(3): await ask('main', f'And then, part {i + 1}?')   # the main thread goes on well past where b1 came from
        b2 = await branch_from(b1, 'Why not a sigmoid?')
        before = await pg.evaluate('Object.keys(__digress.conv.threads)')   # and one about a whole reply (no passage): main's second reply
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').nth(1).click()
        await pg.wait_for_function('n => Object.keys(__digress.conv.threads).length > n', arg=len(before))
        bw = await pg.evaluate(f"Object.keys(__digress.conv.threads).find(t=>!{json.dumps(before)}.includes(t))")
        await ask(bw, 'Say more about all of that?')
        for i in range(2): await ask(b1, f'More on that, part {i + 1}?')

        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await pg.locator(card('main')).wait_for(); await calm(pg)
        for tid in ('main', b1, b2, bw):   # open every card to read
            if not await pg.locator(card(tid) + ' .cfull').count():
                await pg.evaluate(f"document.querySelector('{card(tid)} [data-cact=exp]').click()"); await pg.locator(card(tid) + ' .cfull').wait_for()
        await calm(pg)

        async def jump_and_return(parent, child, what):
            await pg.evaluate(f"(()=>{{const f=document.querySelector('{card(parent)} .cfull');f.scrollTop=(f.scrollHeight-f.clientHeight)*0.66}})()"); await frames(pg, 3)   # reading two thirds down
            y0 = await pg.evaluate(TOP, card(parent))
            check(f'{what}: no Return before any jump', not await pg.evaluate(RET, card(parent)))
            await pg.evaluate(f"document.querySelector('{card(child)} .cq').click()"); await pg.wait_for_timeout(900)
            y1 = await pg.evaluate(TOP, card(parent))
            check(f'{what}: the branch’s quote scrolls the parent card to the passage', y1 < y0 - 200, [y0, y1])
            check(f'{what}: …and the parent card offers Return', await pg.evaluate(RET, card(parent)))
            if parent == 'main': await pg.screenshot(path=OUT + '/canvas_return.png')
            await pg.evaluate("document.querySelector('#zTidy').click()"); await calm(pg)
            check(f'{what}: Return is still there after the canvas redraws', await pg.evaluate(RET, card(parent)))
            await pg.evaluate(f"document.querySelector('{card(parent)} .cjump .cjp').click()"); await pg.wait_for_timeout(900)
            y2 = await pg.evaluate(TOP, card(parent))
            check(f'{what}: Return scrolls back to where you were reading', abs(y2 - y0) < 30, [y0, y2])
            check(f'{what}: …and then goes away', not await pg.evaluate(RET, card(parent)))
            return y0

        await jump_and_return('main', b1, 'parent is the main thread')
        y0 = await jump_and_return(b1, b2, 'parent is a branch')
        check('a branch about a whole reply has a line to jump to it', (await pg.locator(card(bw) + ' .cq').inner_text()).strip() == 'The whole reply')
        await jump_and_return('main', bw, 'a branch about a whole reply')
        mid = await pg.evaluate(f"__digress.conv.threads['{bw}'].anchorMsg")
        await pg.evaluate(f"document.querySelector('{card(bw)} .cq').click()"); await pg.wait_for_timeout(900)
        at = await pg.evaluate(f"""(()=>{{const f=document.querySelector('{card('main')} .cfull'),m=f.querySelector('.msg[data-mid="{mid}"]'),r=m.getBoundingClientRect(),c=f.getBoundingClientRect();
          return [r.top<c.bottom&&r.bottom>c.top, m.classList.contains('flash')]}})()""")
        check('…its line scrolls the parent to that reply and flashes it', all(at), at)
        await pg.evaluate(f"document.querySelector('{card('main')} .cjump .cjp').click()"); await pg.wait_for_timeout(600)

        # scrolling back near the spot by hand also clears it
        await pg.evaluate(f"document.querySelector('{card(b2)} .cq').click()"); await pg.wait_for_timeout(1200)   # past the jump's own scrolling
        check('(the jump offers Return again)', await pg.evaluate(RET, card(b1)))
        await pg.evaluate(f"(()=>{{const f=document.querySelector('{card(b1)} .cfull');f.scrollTop={y0}}})()"); await pg.wait_for_timeout(300)
        check('scrolling back to the spot yourself makes Return go away', not await pg.evaluate(RET, card(b1)))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
