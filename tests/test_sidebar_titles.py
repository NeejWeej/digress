"""Sidebar titles: a cut-off conversation title shows in full when hovering anywhere on its row (also
if the list re-renders mid-hover), the open conversation's title wraps instead of being cut, branch rows
name the branch and its passage, and the sidebar can be dragged wider (remembered; double-click resets).
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, launch_args, goto_app, booted, answered, saved, soon, frames, steady, new_conv

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
}
FAKE = r"""
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{const out='A short answer.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
LONG1 = 'How do attention heads in transformer models specialise during training runs'
LONG2 = 'Why does gradient descent with momentum converge faster on ill-conditioned problems'
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        ctx = await b.new_context(viewport={'width': 1400, 'height': 900})
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        for q in (LONG1, LONG2):
            await new_conv(pg)
            ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await saved(pg)

        other = pg.locator('#clist .citem:not(.cur) .t').filter(has_text='attention heads').first
        cur = pg.locator('#clist .citem.cur .t').first
        clipped = await other.evaluate('e=>e.scrollWidth>e.clientWidth')
        check('a long title in the list is cut off', clipped)
        await other.hover(); await soon(pg, "() => document.getElementById('tipbox').classList.contains('show')")   # after the 380 ms delay
        tip = await pg.locator('#tipbox').text_content()
        shown = await pg.locator('#tipbox').evaluate("e=>e.classList.contains('show')")
        check('hovering it shows the full title', shown and tip == LONG1, repr(tip))
        await pg.screenshot(path=OUT + '/sidebar_tip.png')

        ch = await cur.evaluate('e=>[e.scrollWidth<=e.clientWidth, e.offsetHeight]')
        check('the open conversation shows its whole title', ch[0] and ch[1] > 20, str(ch))

        # a title that fits gets no tooltip
        await new_conv(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Short one'); await answered(pg, ta.press('Enter')); await saved(pg)
        await pg.locator('#clist .citem:not(.cur) .t').filter(has_text='momentum').first.hover(); await frames(pg)
        short = pg.locator('#clist .citem.cur .t').first
        await pg.mouse.move(5, 5); await frames(pg)
        await short.hover(); await pg.wait_for_timeout(700)   # deliberate: well past the 380 ms tooltip delay, for a tooltip that shouldn't come
        check('a title that fits gets no tooltip', not await pg.locator('#tipbox').evaluate("e=>e.classList.contains('show')"))

        async def tip_after_hover(x, y, during=None):
            await pg.mouse.move(700, 500); await pg.wait_for_function("!document.getElementById('tipbox').classList.contains('show')")
            await pg.mouse.move(x, y, steps=3)
            if during: await pg.wait_for_timeout(150); await during()   # part-way into the hover (before the 380 ms tooltip delay)
            await soon(pg, "() => document.getElementById('tipbox').classList.contains('show')", timeout=3000)
            return await pg.evaluate("[document.getElementById('tipbox').classList.contains('show'),document.getElementById('tipbox').textContent]")
        row = pg.locator('#clist .citem:not(.cur)').filter(has_text='attention heads').first
        rb = await row.bounding_box(); ab = await row.locator('.acts').bounding_box()
        s_, t_ = await tip_after_hover(ab['x'] + 6, rb['y'] + rb['height'] / 2)
        check('hovering the faded end of the row (beside the buttons) shows the title', s_ and t_ == LONG1, repr(t_))
        s_, t_ = await tip_after_hover(rb['x'] + 4, rb['y'] + rb['height'] / 2)
        check('hovering the row padding shows the title', s_ and t_ == LONG1, repr(t_))
        async def rename_open_conv():   # keyboard only, so the pointer stays on the row while the list rebuilds
            await pg.evaluate("window.__row=document.querySelector('#clist .citem:not(.cur)');const t=document.getElementById('cTitle');t.focus();getSelection().selectAllChildren(t)")
            await pg.keyboard.type('Renamed'); await pg.keyboard.press('Enter')
            await soon(pg, "() => window.__row !== document.querySelector('#clist .citem:not(.cur)')")   # the list rebuilt (once the rename is saved)
        s_, t_ = await tip_after_hover(rb['x'] + 60, rb['y'] + rb['height'] / 2, during=rename_open_conv)
        rebuilt = await pg.evaluate("window.__row!==document.querySelector('#clist .citem:not(.cur)')")
        check('title still shows when the list re-renders mid-hover', rebuilt and s_ and t_ == LONG1, f'rebuilt={rebuilt} {t_!r}')
        await pg.evaluate("window.__row=document.querySelector('#clist .citem')")
        await pg.locator('[data-v=rows]').click(); await saved(pg, layout=True); await pg.locator('[data-v=cols]').click(); await saved(pg, layout=True)
        check('saving with nothing changed leaves the rows alone', await pg.evaluate("window.__row===document.querySelector('#clist .citem')"))

        # branch rows: the tooltip names the branch and the passage it came from
        await pg.evaluate('''() => { const body=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT); const n=w.nextNode(); const r=document.createRange(); r.setStart(n,2); r.setEnd(n,7);
          const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }''')
        await pg.locator('#popIn').fill('What is this about?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        bn = pg.locator('.mnode:not([data-mapdoc])').nth(1); bb = await bn.bounding_box()
        s_, t_ = await tip_after_hover(bb['x'] + 40, bb['y'] + 8)
        check('a branch row names the branch and its passage', s_ and t_.startswith('Open “') and 'from “short”' in t_, repr(t_))

        # double-click a title in the sidebar to rename it: the open conversation, then another one
        crow = pg.locator('#clist .citem.cur, #plist .citem.cur').first
        cid = await crow.get_attribute('data-conv')
        await crow.locator('.t').dblclick(); await soon(pg, "() => !!document.querySelector('#side .citem.cur .t[contenteditable]')")
        check('double-clicking a title edits it in place', await crow.locator('.t[contenteditable]').count() == 1)
        await pg.keyboard.type('Sidebar renamed'); await pg.keyboard.press('Enter')
        await soon(pg, "id => document.querySelector(`[data-conv='${id}'] .t`).innerText === 'Sidebar renamed' && document.getElementById('cTitle').innerText === 'Sidebar renamed'", cid)
        check('Enter keeps it: the list and the header show it',
              await pg.locator(f'[data-conv="{cid}"] .t').first.inner_text() == 'Sidebar renamed' and await pg.locator('#cTitle').inner_text() == 'Sidebar renamed')
        orow = pg.locator('#clist .citem:not(.cur)').filter(has_text='attention heads').first
        oid = await orow.get_attribute('data-conv')
        await orow.locator('.t').dblclick(); await soon(pg, "id => __digress.conv.id === id && !!document.querySelector(`[data-conv='${id}'] .t[contenteditable]`)", oid)   # opened, still editing
        ed = pg.locator(f'[data-conv="{oid}"] .t[contenteditable]')
        check('…another conversation too (the first click opens it; the editor survives that)', await ed.count() == 1)
        await pg.keyboard.type('Attention, renamed'); await pg.keyboard.press('Enter')
        await soon(pg, "id => document.querySelector(`[data-conv='${id}'] .t`).innerText === 'Attention, renamed'", oid)
        check('…and its new title is kept', await pg.locator(f'[data-conv="{oid}"] .t').first.inner_text() == 'Attention, renamed')
        await pg.locator(f'[data-conv="{oid}"] .t').first.dblclick(); await pg.wait_for_function("id => !!document.querySelector(`[data-conv='${id}'] .t[contenteditable]`)", arg=oid)
        await pg.keyboard.type('Never mind'); await pg.keyboard.press('Escape'); await pg.wait_for_function("id => !document.querySelector(`[data-conv='${id}'] .t[contenteditable]`)", arg=oid)
        check('Esc cancels', await pg.locator(f'[data-conv="{oid}"] .t').first.inner_text() == 'Attention, renamed')
        await saved(pg, layout=True)   # both renames stored (the open one is saved, the other one updated in place)
        await pg.wait_for_function("['Sidebar renamed','Attention, renamed'].every(t => Object.keys(localStorage).some(k => k.startsWith('fakesrv:convs/') && JSON.parse(localStorage.getItem(k)).title === t))")
        await pg.reload(); await booted(pg)
        titles = await pg.locator('#side .citem[data-conv] .t').all_inner_texts()
        check('renames are saved', 'Sidebar renamed' in titles and 'Attention, renamed' in titles, titles)

        # drag the edge wider
        w0 = await pg.locator('#side').evaluate('e=>e.offsetWidth')
        gb = await pg.locator('#sgrip').bounding_box()
        gx, gy = gb['x'] + gb['width'] / 2, gb['y'] + 300
        await pg.mouse.move(gx, gy); await pg.mouse.down(); await pg.mouse.move(gx + 120, gy, steps=8); await pg.mouse.up()
        w1 = await pg.locator('#side').evaluate('e=>e.offsetWidth')
        check('dragging the edge widens the sidebar', abs(w1 - w0 - 120) <= 3, f'{w0} -> {w1}')
        await pg.screenshot(path=OUT + '/sidebar_wide.png')
        await pg.reload(); await booted(pg)
        w2 = await pg.locator('#side').evaluate('e=>e.offsetWidth')
        check('width remembered after reload', abs(w2 - w1) <= 2, f'{w2}')
        gb = await pg.locator('#sgrip').bounding_box()
        await pg.mouse.dblclick(gb['x'] + gb['width'] / 2, gb['y'] + 300); await steady(pg, "document.getElementById('side').offsetWidth")
        w3 = await pg.locator('#side').evaluate('e=>e.offsetWidth')
        check('double-click resets the width', abs(w3 - w0) <= 2, f'{w3}')
        await pg.locator('#tSide').click(); await soon(pg, "() => !document.getElementById('sgrip').checkVisibility()")
        check('no resize handle while the sidebar is hidden', not await pg.locator('#sgrip').is_visible())

        check('no page errors', not errs, '; '.join(errs[:5]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
