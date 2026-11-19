"""Zen: only the panes, for reading.
  - The Zen button (or ⌘/Ctrl+., even while typing) hides the top bar and sidebar (the lines between panes stay); the panes take the room.
  - Selecting text and branching works as usual in Zen; the branch opens beside it.
  - The sidebar still comes out, over the panes: ⌘/Ctrl+B or the tab at the left edge; a click outside or Esc puts it away.
  - The tab at the top of the screen, or ⌘/Ctrl+. again, brings everything back.
  - It's per window and survives a reload; on a phone the Zen button is in the ⋯ menu.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames, soon
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='Raft elects a leader with randomized election timeouts. The leader then replicates its log to followers.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

shown = lambda pg, sel: pg.evaluate(f"(()=>{{const e=document.querySelector('{sel}');return !!e&&e.getClientRects().length>0}})()")

async def open_page(b, w, h):
    pg = await b.new_page(viewport={'width': w, 'height': h})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    async def route(r):
        u = r.request.url
        for k, v in MAP.items():
            if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        await r.continue_()
    await pg.route('**/*', route); await pg.add_init_script(FAKE)
    await goto_app(pg); await booted(pg)
    return pg, errs

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg, errs = await open_page(b, 1400, 850)
        ta = pg.locator('.pane[data-tid=main] textarea')
        await ta.fill('Explain Raft'); await answered(pg, ta.press('Enter'))
        w0 = await pg.evaluate("document.querySelector('#stage').getBoundingClientRect().width")

        await pg.locator('#zenB').click(); await frames(pg)
        check('the Zen button hides the top bar and sidebar', not await shown(pg, '.top') and not await shown(pg, '#side'))
        check('…and shows the tab to leave it', await shown(pg, '#zenX'))
        r = await pg.evaluate("(()=>{const s=document.querySelector('#stage').getBoundingClientRect();return [s.top,s.width]})()")
        check('the panes take the room (from the top, full width)', r[0] < 1 and r[1] > w0 + 100 and r[1] >= 1399, [r, w0])
        await pg.screenshot(path=OUT + '/zen.png')

        # select a passage and branch from it, in Zen
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf('election timeouts'); if(i>=0){
          const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+17); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why randomized?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await frames(pg)
        check('branching from a selection works in Zen: the branch opens beside it', await pg.locator('#panes > .pane').count() == 2 and await pg.evaluate("document.querySelector('#app').classList.contains('zen')"))
        await pg.screenshot(path=OUT + '/zen_branch.png')

        # the sidebar still comes out in Zen: ⌘/Ctrl+B or the tab at the left edge, over the panes
        check('in Zen, a tab at the left edge offers the sidebar', await shown(pg, '#zenS'))
        await pg.keyboard.press('ControlOrMeta+b'); await frames(pg)
        check('⌘/Ctrl+B opens the sidebar in Zen', await shown(pg, '#side') and not await shown(pg, '.top'))
        sr = await pg.evaluate("(()=>{const s=document.querySelector('#side').getBoundingClientRect();return [s.left,s.top,s.width]})()")
        check('…over the panes, from the top', sr[0] == 0 and sr[1] < 1 and sr[2] > 150, sr)
        await pg.screenshot(path=OUT + '/zen_side.png')
        await pg.mouse.click(1200, 400); await frames(pg)
        check('…and a click outside it puts it away (still in Zen)', not await shown(pg, '#side') and await shown(pg, '#zenX'))
        await pg.locator('#zenS').click(); await frames(pg)
        check('the left tab opens it too', await shown(pg, '#side'))
        await pg.locator('#side .mnode[data-map=main]').click(); await frames(pg)
        check('…and its tree works (it stays out while you use it)', await shown(pg, '#side'))
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Esc puts it away', not await shown(pg, '#side'))

        # ⌘/Ctrl+. while typing leaves and enters
        bta = pg.locator('#panes > .pane').nth(1).locator('textarea'); await bta.focus()
        await pg.keyboard.press('ControlOrMeta+Period'); await frames(pg)
        check('⌘/Ctrl+. (while typing) leaves Zen', await shown(pg, '.top') and not await shown(pg, '#zenX'))
        await pg.keyboard.press('ControlOrMeta+Period'); await frames(pg)
        check('…and enters it again', not await shown(pg, '.top'))

        # survives a reload (per window)
        await pg.reload(); await booted(pg)
        check('Zen survives a reload of this window', not await shown(pg, '.top') and await shown(pg, '#zenX'))
        await pg.locator('#zenX').click(); await frames(pg)
        check('the tab at the top leaves Zen', await shown(pg, '.top') and await shown(pg, '#side') and not await shown(pg, '#zenX'))
        await pg.reload(); await booted(pg)
        check('…and it stays off after a reload', await shown(pg, '.top'))

        # a phone: Zen is in the ⋯ menu
        ph, errs2 = await open_page(b, 390, 800)
        await ph.locator('#moreB').click()
        zb = ph.locator('.tmore #zenB')
        check('on a phone the Zen button is in the ⋯ menu', await zb.count() == 1 and await zb.is_visible())
        await zb.click(); await frames(ph)
        check('…and works from there (the menu closes)', not await shown(ph, '.top') and await shown(ph, '#zenX') and not await shown(ph, '.tmore.open'))
        box = await ph.locator('#zenX').bounding_box()
        check('…with a tab big enough to tap', box and box['height'] >= 15 and box['width'] >= 40, box)
        await ph.screenshot(path=OUT + '/zen_phone.png')
        await ph.locator('#zenX').click(); await frames(ph)
        check('…and the tab brings the top bar back', await shown(ph, '.top'))

        check('no page errors', not errs and not errs2, (errs + errs2)[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
