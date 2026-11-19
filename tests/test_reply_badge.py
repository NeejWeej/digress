"""A reply in a thread you can't see gets a badge: a pulsing ring while it's written, a dot once it's ready, until you
open it. In three places:
  - a minimized pane's strip (Columns/Rows), cleared by expanding it;
  - a folded (summary) card on the canvas, cleared by opening it;
  - the thread's row in the sidebar's Branches, also for a pane closed with ✕.
A reply you can see gets none. Nothing is saved: it's per window. Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, CORS, launch_args, goto_app, booted, answered, frames

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
}
# questions with "slow" wait for the test to say go (window.__go())
FAKE = r"""window.__gates=[];window.__go=()=>{const g=window.__gates.shift();g&&g()};
window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const q=JSON.stringify(input[input.length-1].content);
  if(q.includes('slow'))await new Promise(r=>window.__gates.push(r));
  const out='Here is the answer to that.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

def badge(where):   # 'writing' | 'ready' | '' for the branch (window.__bt) in a place
    sel = {'strip': '#panes .pane[data-tid="${t}"] .rail-label > .rbadge',
           'card': '#cv .cnode[data-ctid="${t}"] .ch > .rbadge',
           'row': '#tree .mnode[data-map="${t}"] > .rbadge'}[where]
    return "(()=>{const t=window.__bt,b=document.querySelector(`" + sel + "`);return b?(b.classList.contains('ready')?'ready':b.classList.contains('writing')?'writing':'?'):''})()"
BUSY = "__digress.conv.msgs[__digress.conv.order[window.__bt].slice(-1)[0]].pending"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('What is attention?'); await answered(pg, ta.press('Enter'))
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click()
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1'); await frames(pg, 3)
        await pg.evaluate("window.__bt=Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        bt = await pg.evaluate('window.__bt')
        pane = pg.locator(f'.pane[data-tid="{bt}"]')
        async def ask_slow(text):
            t = pane.locator('textarea'); await t.fill(text); await t.press('Enter')
            await pg.wait_for_function(BUSY)
        async def go():
            await pg.evaluate('window.__go()'); await pg.wait_for_function('!(' + BUSY + ')'); await frames(pg, 2)

        # 1. a pane you can see: no badge
        await ask_slow('A slow question you watch'); await frames(pg)
        check('a reply in an open pane: no badge while it writes', await pg.evaluate(badge('row')) == '' and await pg.evaluate("!document.querySelector('#panes .rbadge')"))
        await go()
        check('…nor once it’s done', await pg.evaluate("!document.querySelector('.rbadge')"))

        # 2. a strip
        await ask_slow('A slow question, then minimize')
        await pane.locator('[data-act=collapse]').click(); await frames(pg, 2)
        check('minimized while it writes: the strip pulses', await pg.evaluate(badge('strip')) == 'writing')
        check('…and so does its row in the sidebar', await pg.evaluate(badge('row')) == 'writing')
        await pg.screenshot(path=OUT + '/reply_badge_writing.png')
        await go()
        check('done: the strip has the ready dot and lights up', await pg.evaluate(badge('strip')) == 'ready' and await pane.evaluate("e=>e.classList.contains('rready')"))
        check('…and the sidebar row too', await pg.evaluate(badge('row')) == 'ready')
        await pg.screenshot(path=OUT + '/reply_badge_strip.png')
        await pane.click(); await frames(pg, 2)
        check('expanding the strip clears it everywhere', not await pane.evaluate("e=>e.classList.contains('rail')") and await pg.evaluate("!document.querySelector('.rbadge')") and await pg.evaluate(badge('row')) == '')

        # 3. a folded card on the canvas
        await ask_slow('A slow question, then to the canvas')
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await frames(pg, 3)
        card = pg.locator(f'#cv .cnode[data-ctid="{bt}"]')
        if await card.evaluate("e=>e.classList.contains('exp')"):
            await card.locator('[data-cact=exp]').click(); await frames(pg, 2)
        check('a folded card while it writes: it pulses', await pg.evaluate(badge('card')) == 'writing')
        await go()
        check('done: the folded card has the ready dot', await pg.evaluate(badge('card')) == 'ready' and await card.evaluate("e=>e.classList.contains('rready')"))
        await pg.screenshot(path=OUT + '/reply_badge_card.png')
        await card.locator('[data-cact=exp]').click(); await frames(pg, 2)
        check('opening the card clears it', await pg.evaluate(badge('card')) == '' and await pg.evaluate(badge('row')) == '')
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=cols]').click()"); await frames(pg, 3)

        # 4. a pane closed with ✕: the sidebar row
        if not await pane.count():
            await pg.locator(f'#tree .mnode[data-map="{bt}"]').click(); await frames(pg, 2)
        if await pane.evaluate("e=>e.classList.contains('rail')"): await pane.click(); await frames(pg, 2)
        await ask_slow('A slow question, then close the pane')
        await pane.locator('[data-act=close]').click(); await frames(pg, 2)
        check('closed while it writes: the sidebar row pulses', await pg.evaluate(badge('row')) == 'writing')
        await go()
        check('done: the sidebar row has the ready dot', await pg.evaluate(badge('row')) == 'ready')
        await pg.screenshot(path=OUT + '/reply_badge_row.png')
        await pg.locator(f'#tree .mnode[data-map="{bt}"]').click(); await frames(pg, 2)
        check('opening it from the sidebar clears it', await pg.evaluate(badge('row')) == '')
        check('nothing about it is saved with the conversation', 'rbadge' not in await pg.evaluate("JSON.stringify(__digress.conv)") and 'unread' not in await pg.evaluate("JSON.stringify(__digress.conv.ui)"))
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
