import asyncio, sys, os
from playwright.async_api import async_playwright

from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered, saved, frames, calm, changed, new_conv
from common import CORS
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

FAKE = r"""
const REPLY = `## Self-attention

Each token produces a **query**, **key**, and **value** vector. Scores are $QK^T$ scaled by $1/\\sqrt{d}$:

$$\\text{Attention}(Q,K,V)=\\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d}}\\right)V$$

\`\`\`mermaid
flowchart LR
  A[Tokens] --> B[Q K V]
  B --> C[Scores]
  C --> D[Softmax]
\`\`\`

\`\`\`python
def attn(q, k, v):
    return softmax(q @ k.T / d**0.5) @ v
\`\`\`

That is why attention is described as soft dictionary lookup.`;
window.__calls = [];
window.fakeLLM = { use: async (n) => {
  if (n === 'sample') return async (input, opts) => {
    window.__calls.push(input); window.__opts=opts;
    let out = '';
    for (const ch of REPLY.match(/[\s\S]{1,40}/g)) { out += ch; opts.onText && opts.onText({text: out, delta: ch}); await new Promise(r => setTimeout(r, 5)); }
    return {text: out, truncated: false, modelApplied: opts.model||'claude-sonnet-5-5'};
  };
  return null;
}};
"""

async def archive_via_menu(pg, row):
    await row.locator('[data-folderconv]').click()
    await pg.locator('#folderMenu.open [data-fm=arch]').click()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 620})
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        pg.on('console', lambda m: m.type in ('error', 'warning') and errs.append(m.type + ' ' + m.text))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k):
                    return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u:
                return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg)
        await booted(pg)
        ta = pg.locator('.pane[data-tid="main"] textarea')
        await ta.fill('Explain self-attention'); await answered(pg, ta.press('Enter'))
        await ta.fill('And again?'); await answered(pg, ta.press('Enter'))
        SEL = """([pi, word]) => { const body=document.querySelectorAll(pi)[0];
          const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf(word); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+word.length);
            const s=getSelection(); s.removeAllRanges(); s.addRange(r); break;}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }"""
        await pg.evaluate(SEL, ['.pane[data-tid=main] .msg.assistant .body','soft dictionary lookup'])
        await pg.locator('#popIn').fill('Why lookup?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        # --- branch pin from pane header
        await changed(pg, "[...document.querySelectorAll('#plist .citem')].map(c=>c.textContent)", pg.locator('.pane').nth(1).locator('[data-act=pin]').click())
        print('pinned section items:', await pg.evaluate("[...document.querySelectorAll('#plist .citem')].map(c=>c.textContent.trim())"))
        # --- second conversation, then pin the first conversation from the sidebar and archive the second
        await new_conv(pg)
        ta2 = pg.locator('.pane[data-tid="main"] textarea'); await ta2.fill('Second topic'); await answered(pg, ta2.press('Enter')); await saved(pg)
        print('conversations:', await pg.evaluate("[...document.querySelectorAll('#clist .citem .t')].map(c=>c.textContent)"))
        first = pg.locator('#clist .citem', has_text='Explain self-attention'); await first.hover(); await changed(pg, "[...document.querySelectorAll('#plist .citem')].map(c=>c.textContent)", first.locator('[data-pinconv]').click())
        print('after conv pin, pinned:', await pg.evaluate("[...document.querySelectorAll('#plist .citem')].map(c=>c.textContent.trim().slice(0,40))"))
        cur = pg.locator('#clist .citem.cur'); await cur.hover(); await changed(pg, "[document.querySelector('#archLbl').textContent, ...[...document.querySelectorAll('#clist .citem .t')].map(c=>c.textContent)]", archive_via_menu(pg, cur))
        print('archive label:', await pg.locator('#archLbl').text_content(), '| list:', await pg.evaluate("[...document.querySelectorAll('#clist .citem .t')].map(c=>c.textContent)"))
        await pg.locator('#archToggle').click(); await frames(pg)
        print('archive items:', await pg.evaluate("[...document.querySelectorAll('#alist .citem .t')].map(c=>c.textContent)"))
        # --- jump to pinned branch in the other conversation
        await pg.locator('#plist [data-pinb]').click()
        await pg.wait_for_function("__digress.conv.title==='Explain self-attention'&&document.querySelectorAll('.pane .ph-title').length===2"); await calm(pg)
        print('opened pinned branch: title', await pg.locator('#cTitle').text_content(), '| panes', await pg.evaluate("[...document.querySelectorAll('.pane .ph-title')].map(t=>t.textContent)"))
        # --- pane origin quote jumps to the source
        await pg.locator('.pane[data-tid=main] .pb').evaluate('e=>e.scrollTop=e.scrollHeight')
        await pg.locator('.pane').nth(1).locator('.origin .oq').click(); await calm(pg)
        print('origin quote click -> flashing anchor:', await pg.locator('.pane[data-tid=main] .anchor.flash').count())
        # --- canvas: expanded card jump buttons + quote to source
        await pg.locator('[data-v=canvas]').click(); await pg.locator('.cnode.main').wait_for(); await calm(pg)
        await pg.locator('.cnode.main [data-cact=exp]').click(); await calm(pg)
        full = pg.locator('.cnode.main .cfull'); await full.evaluate('e=>e.scrollTop=0'); await calm(pg)
        print('card jump buttons visible:', await pg.locator('.cnode.main.away').count())
        await pg.locator('.cnode.main [data-cact=jend]').click(); await calm(pg)   # a smooth scroll
        print('card at bottom:', await full.evaluate('e=>e.scrollHeight-e.scrollTop-e.clientHeight<5'))
        await pg.locator('.cnode.main [data-cact=exp]').click(); await calm(pg)
        await pg.locator('#zFit').click(); await calm(pg)
        await pg.locator('.cnode:not(.main) .cq').first.click(); await calm(pg)
        print('quote click -> parent expanded:', await pg.locator('.cnode.main.exp').count(), '| anchor flashing in parent:', await pg.locator('.cnode.main .cfull .anchor.flash').count())
        await pg.screenshot(path=OUT + '/p1.png')
        await pg.locator('[data-v=cols]').click(); await calm(pg)
        # --- unarchive
        a = pg.locator('#alist .citem').first; await a.hover(); await changed(pg, "[document.querySelector('#archLbl').textContent, ...[...document.querySelectorAll('#clist .citem .t')].map(c=>c.textContent)]", a.locator('[data-archconv]').click())
        print('after unarchive, archive visible:', await pg.locator('#archWrap').is_visible(), '| list:', await pg.evaluate("[...document.querySelectorAll('#clist .citem .t')].map(c=>c.textContent)"))
        await pg.screenshot(path=OUT + '/p2.png')
        # --- resizing canvas cards
        await pg.locator('[data-v=canvas]').click(); await calm(pg); await pg.locator('#zFit').click(); await calm(pg)
        card = pg.locator('.cnode:not(.main)').first
        w0 = await card.evaluate('e=>e.offsetWidth')
        bb = await card.locator('[data-dir=e]').bounding_box()
        await pg.mouse.move(bb['x']+3, bb['y']+20); await pg.mouse.down(); await pg.mouse.move(bb['x']+120, bb['y']+20, steps=6); await pg.mouse.up(); await frames(pg)
        w1 = await card.evaluate('e=>e.offsetWidth')
        print('edge drag width:', w0, '->', w1)
        await card.locator('[data-cact=exp]').click(); await calm(pg)
        card = pg.locator('.cnode.exp').first
        print('expanded keeps its own width:', await card.evaluate('e=>e.offsetWidth'))
        f0 = await card.locator('.cfull').evaluate('e=>e.offsetHeight')
        bb = await card.locator('[data-dir=se]').bounding_box()
        await pg.mouse.move(bb['x']+8, bb['y']+8); await pg.mouse.down(); await pg.mouse.move(bb['x']-100, bb['y']-120, steps=6); await pg.mouse.up(); await frames(pg)
        w2 = await card.evaluate('e=>e.offsetWidth'); f1 = await card.locator('.cfull').evaluate('e=>e.offsetHeight')
        print('corner drag: width', w2, 'height', f0, '->', f1)
        await pg.locator('[data-v=cols]').click(); await calm(pg); await pg.locator('[data-v=canvas]').click(); await calm(pg)
        card = pg.locator('.cnode.exp').first
        print('persisted after view switch:', await card.evaluate('e=>e.offsetWidth')==w2, await card.locator('.cfull').evaluate('e=>e.offsetHeight')==f1)
        await card.locator('[data-dir=se]').dblclick(); await frames(pg)
        print('double-click reset width:', await pg.locator('.cnode.exp').first.evaluate('e=>e.offsetWidth'))
        await pg.screenshot(path=OUT + '/p3.png')
        # --- left edge, top-left corner, stacking
        card = pg.locator('.cnode.exp').first
        r0 = await card.evaluate('e=>[e.offsetLeft,e.offsetWidth,e.offsetTop,e.querySelector(".cfull").offsetHeight]')
        bb = await card.locator('[data-dir=w]').bounding_box()
        await pg.mouse.move(bb['x']+3, bb['y']+30); await pg.mouse.down(); await pg.mouse.move(bb['x']-80, bb['y']+30, steps=5); await pg.mouse.up(); await frames(pg)
        r1 = await card.evaluate('e=>[e.offsetLeft,e.offsetWidth,e.offsetTop,e.querySelector(".cfull").offsetHeight]')
        print('left edge: left', r0[0], '->', r1[0], '| width', r0[1], '->', r1[1], '| right edge kept:', r0[0]+r0[1]==r1[0]+r1[1])
        bb = await card.locator('[data-dir=nw]').bounding_box()
        await pg.mouse.move(bb['x']+5, bb['y']+5); await pg.mouse.down(); await pg.mouse.move(bb['x']+40, bb['y']-60, steps=5); await pg.mouse.up(); await frames(pg)
        r2 = await card.evaluate('e=>[e.offsetLeft,e.offsetWidth,e.offsetTop,e.querySelector(".cfull").offsetHeight]')
        print('top-left corner: top', r1[2], '->', r2[2], '| height', r1[3], '->', r2[3], '| bottom kept:', r1[2]+r1[3]==r2[2]+r2[3], '| right kept:', r1[0]+r1[1]==r2[0]+r2[1])
        ids = await pg.evaluate("[...document.querySelectorAll('.cnode')].map(n=>n.dataset.ctid)")
        a = pg.locator(f'.cnode[data-ctid="{ids[0]}"]'); b2 = pg.locator(f'.cnode[data-ctid="{ids[1]}"]')
        ah = await a.locator('.ch').bounding_box(); bbb = await b2.bounding_box()
        await pg.mouse.move(ah['x']+40, ah['y']+8); await pg.mouse.down(); await pg.mouse.move(bbb['x']+30, bbb['y']+30, steps=8); await pg.mouse.up(); await frames(pg)
        za = int(await a.evaluate('e=>e.style.zIndex')); zb = int(await b2.evaluate('e=>e.style.zIndex'))
        print('dragged card on top of the other:', za > zb, '| selected outline:', await a.evaluate("e=>e.classList.contains('picked')"))
        bb2 = await b2.bounding_box(); await pg.mouse.click(bb2['x']+bb2['width']-30, bb2['y']+bb2['height']-20); await frames(pg)
        print('clicking the other brings it forward:', int(await b2.evaluate('e=>e.style.zIndex')) > int(await a.evaluate('e=>e.style.zIndex')))
        await pg.locator('[data-v=cols]').click(); await calm(pg); await pg.locator('[data-v=canvas]').click(); await calm(pg)
        print('stacking remembered:', int(await pg.locator(f'.cnode[data-ctid="{ids[1]}"]').evaluate('e=>e.style.zIndex')) > int(await pg.locator(f'.cnode[data-ctid="{ids[0]}"]').evaluate('e=>e.style.zIndex')))
        await pg.screenshot(path=OUT + '/z1.png')

        # --- the pinned section's order: a pinned conversation's pinned branches come right after its row (indented, no
        # "· title"); pinned branches of conversations that aren't pinned stay at the end, with the conversation's name
        await pg.locator('[data-v=cols]').click(); await calm(pg)
        await new_conv(pg)
        tb = pg.locator('.pane[data-tid="main"] textarea'); await tb.fill('Third topic'); await answered(pg, tb.press('Enter')); await saved(pg)
        await pg.evaluate(SEL, ['.pane[data-tid=main] .msg.assistant .body', 'soft dictionary lookup'])
        await pg.locator('#popIn').fill('Why lookup again?'); await answered(pg, pg.locator('#popIn').press('Enter'))
        await changed(pg, "[...document.querySelectorAll('#plist .citem')].map(c=>c.textContent)", pg.locator('.pane').nth(1).locator('[data-act=pin]').click())
        ROWS = """[...document.querySelectorAll('#plist .citem')].map(c=>({cls:c.className.replace(/ ?cur/,''),t:c.querySelector('.t').firstChild.textContent.trim(),small:c.querySelector('small')?c.querySelector('small').textContent:null}))"""
        rows = await pg.evaluate(ROWS)
        print('pinned rows:', rows)
        want = [('citem', 'Explain self-attention', None), ('citem pb psub', 'Why lookup?', None), ('citem pb', 'Why lookup again?', '· Third topic')]
        check('a pinned conversation, then its pinned branches (no title), then branches of unpinned conversations (with title)',
              [(r['cls'], r['t'], r['small']) for r in rows] == want, rows)
        # pin the third conversation too: its branch moves up under it, ahead of nothing left at the end
        third = pg.locator('#clist .citem', has_text='Third topic'); await third.hover()
        await changed(pg, "[...document.querySelectorAll('#plist .citem')].map(c=>c.className)", third.locator('[data-pinconv]').click())
        rows = await pg.evaluate(ROWS)
        check('both conversations pinned: each is followed by its own branch, all indented, none with a title',
              [r['cls'] for r in rows] == ['citem', 'citem pb psub', 'citem', 'citem pb psub'],
              rows)
        check('…and no branch row names its conversation', all(r['small'] is None for r in rows), rows)
        names = [r['t'] for r in rows]
        check('…each branch directly after its own conversation', names.index('Why lookup?') == names.index('Explain self-attention') + 1 and names.index('Why lookup again?') == names.index('Third topic') + 1, names)
        # unpin the first conversation: its branch drops to the end with the title again
        first = pg.locator('#plist .citem:not(.pb)', has_text='Explain self-attention'); await first.hover()
        await changed(pg, "[...document.querySelectorAll('#plist .citem')].map(c=>c.className)", first.locator('[data-pinconv]').click())
        rows = await pg.evaluate(ROWS)
        check('unpinning a conversation sends its pinned branch to the end, titled again',
              [(r['cls'], r['t']) for r in rows] == [('citem', 'Third topic'), ('citem pb psub', 'Why lookup again?'), ('citem pb', 'Why lookup?')] and rows[-1]['small'] == '· Explain self-attention', rows)

        # --- touch screens: only the pin button shows on a pinned row (the "pinned" mark beside the title is hidden there)
        tctx = await b.new_context(viewport={'width': 412, 'height': 860}, has_touch=True, is_mobile=True)
        tp = await tctx.new_page(); terrs = []
        tp.on('pageerror', lambda e: terrs.append(str(e)))
        await tp.route('**/*', route); await tp.add_init_script(FAKE)
        await goto_app(tp); await booted(tp)
        if not await tp.evaluate("matchMedia('(hover:none)').matches"):
            print('note: this browser context does not report (hover:none); the touch pin-icon check is skipped')
        else:
            tt = tp.locator('.pane[data-tid="main"] textarea'); await tt.fill('Touch topic'); await answered(tp, tt.press('Enter')); await saved(tp)
            await tp.evaluate("document.querySelector('#clist [data-pinconv]').click()")
            await tp.wait_for_function("document.querySelectorAll('#plist .citem').length===1")
            vis = await tp.evaluate("""[...document.querySelectorAll('#plist .citem:not(.pb) :is(.pmark,[data-pinconv]) svg.i')].filter(s=>{const cs=getComputedStyle(s);for(let e=s;e&&e.id!=='plist';e=e.parentElement){if(getComputedStyle(e).display==='none'||getComputedStyle(e).visibility==='hidden')return false}return true}).map(s=>s.closest('.pmark')?'pmark':s.closest('button')?s.closest('button').getAttributeNames().join():'?')""")
            check('on a touch screen a pinned row shows exactly one pin icon (the button, not the mark)', len(vis) == 1 and 'pmark' not in vis and 'data-pinconv' in vis[0], vis)
        check('no page errors (touch)', not terrs, '; '.join(terrs[:3]))
        await tctx.close()
        print('\n'.join(errs[:20]) or 'no errors')
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
