"""Layout polish, each checked where it used to go wrong:
  1. narrow branch panes: the header buttons wrap under the title instead of squeezing it to a letter
  2. sidebar branch rows: the hover buttons overlay the row, so titles don't wrap a word per line
  3. canvas: the hint never runs under the zoom tools
  4. canvas card previews: no Markdown list markers; a heading reads as a sentence
  5. closing a branch doesn't leave a "back to where you were" button in its parent
  6. a connecting line that crosses another pane is faint over it (masked), full strength elsewhere
  7. takeaway headers stay on one line; "Saved" is never cut to "Sa…"; math is typeset while a reply streams
Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, soon, frames, calm

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
MAIN = '## Three roles\n\nEach token plays three parts.\n\n- a query, asking\n- a key, answering\n\nThe score is $q \\cdot k$ for each pair, scaled by $\\sqrt{d_k}$.'
SLOW = 'Here is the variance: $\\mathrm{Var}(q \\cdot k) = d_k$. ' + 'More words follow here to keep it streaming. ' * 40
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{const q=input[input.length-1].content;
  if(q.includes('Write a short takeaway'))return {text:'- A takeaway point.',truncated:false};
  const out=q.includes('Stream')?%s:q.includes('Explain')?%s:'A reply about '+q+'.';
  let s='';for(const ch of out.match(/[\s\S]{1,12}/g)){s+=ch;opts.onText&&opts.onText({text:s});if(q.includes('Stream'))await new Promise(r=>setTimeout(r,40))}
  return {text:s,truncated:false}}};""" % (json.dumps(SLOW), json.dumps(MAIN))
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1400, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        idle = lambda: pg.wait_for_function("!Object.values(__digress.conv.msgs).some(m=>m.pending)", timeout=20000)
        async def ask(tid, q):
            ta = pg.locator(f'.pane[data-tid="{tid}"] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await frames(pg)
        await ask('main', 'Explain attention')
        tids = []
        for q in ('Why does the gradient vanish there when softmax saturates?', 'Why several heads instead of one big one?'):
            await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click(); await pg.wait_for_function('n => Object.keys(__digress.conv.threads).length > n', arg=len(tids) + 1)
            tid = await pg.evaluate(f"Object.keys(__digress.conv.threads).find(t=>t!=='main'&&!{json.dumps(tids)}.includes(t))")
            tids.append(tid); await ask(tid, q)
        b1, b2 = tids
        await calm(pg)

        # 1
        w = await pg.evaluate(f"""[...document.querySelectorAll('#panes>.pane')].map(p=>[p.dataset.tid,Math.round(p.getBoundingClientRect().width),Math.round(p.querySelector('.ph-title').getBoundingClientRect().width)])""")
        check('1. every pane title gets real room, even in narrow panes (≥ 120px)', all(t >= 120 for _, _, t in w), w)
        check('1. …and its buttons are all still there', await pg.locator(f'.pane[data-tid="{b1}"] [data-act=close]').is_visible() and await pg.locator(f'.pane[data-tid="{b1}"] [data-act=zin]').is_visible())
        await pg.screenshot(path=OUT + '/polish_panes.png')

        # 2
        row = pg.locator(f'#tree .mnode[data-map="{b1}"]')
        lines = await row.locator('.mt').evaluate("e=>Math.round(e.getBoundingClientRect().height/parseFloat(getComputedStyle(e).lineHeight))")
        check('2. a long branch title in the sidebar takes ≤ 3 lines (it used to go a word per line)', lines <= 3, lines)
        check('2. its buttons are hidden until hover', not await row.locator('.macts').evaluate("e=>getComputedStyle(e).opacity==='1'"))
        await row.hover(); await soon(pg, "sel => getComputedStyle(document.querySelector(sel)).opacity === '1'", f'#tree .mnode[data-map="{b1}"] .macts')   # fades in
        check('2. …and show on hover', await row.locator('.macts').evaluate("e=>getComputedStyle(e).opacity==='1'") and await row.locator('[data-delb]').is_visible())

        # 6: main | b1 | b2 — b2's line crosses b1
        cross = await pg.evaluate(f"""[document.querySelector('#wires path[data-wire="{b2}"]')?.getAttribute('mask'),document.querySelector('#wires path[data-wire="{b1}"]')?.getAttribute('mask')]""")
        check('6. a line crossing another pane is masked over it', cross[0] and cross[0].startswith('url(#wm'), cross)
        check('6. …a line between neighbours is not', cross[1] is None, cross)

        # 7a: takeaway header stays on one line in a narrow pane
        await pg.locator(f'.pane[data-tid="{b1}"] .ph [data-act=take]').click(); await answered(pg, pg.locator(f'.pane[data-tid="{b1}"] .tk .go').click()); await calm(pg)
        nh = pg.locator('.pane[data-tid="main"] .msg.note .nh').first
        h = await nh.evaluate("e=>{const r=document.createRange();r.selectNodeContents(e);const tops=new Set([...r.getClientRects()].filter(x=>x.width>2&&x.height<20).map(x=>Math.round(x.top/4)));return tops.size}")
        check('7. a takeaway header’s text stays on one line', h == 1, h)

        # 5: closing a branch leaves no back button in the parent
        await pg.locator(f'.pane[data-tid="{b2}"] [data-act=close]').click(); await calm(pg)
        check('5. closing a branch doesn’t leave a “back to where you were” button in the parent', await pg.locator('.pane[data-tid="main"].hasprev').count() == 0)

        # 7b: Saved is whole or hidden
        await pg.set_viewport_size({'width': 1120, 'height': 860}); await calm(pg)
        await pg.locator(f'.pane[data-tid="{b1}"] .sdot').click(); await frames(pg)   # shows "Marked resolved" in the status
        st = await pg.evaluate("(e=>[getComputedStyle(e).visibility,e.scrollWidth,e.clientWidth])(document.getElementById('status'))")
        check('7. “Saved” is shown whole or not at all', st[0] == 'hidden' or st[1] <= st[2] + 1, st)
        await pg.set_viewport_size({'width': 1400, 'height': 860}); await calm(pg)

        # 7c: math while streaming
        ta = pg.locator('.pane[data-tid="main"] textarea'); await ta.fill('Stream a reply'); await ta.press('Enter')
        await pg.wait_for_function("(()=>{const c=__digress.conv,m=c.msgs[c.order.main.at(-1)];return m.pending&&(m.content||'').length>200})()", timeout=15000)
        mid = await pg.evaluate("(()=>{const b=[...document.querySelectorAll('.pane[data-tid=main] .msg.assistant .body')].at(-1);return [!!b.querySelector('span.math svg'),b.textContent.includes('\\\\mathrm')]})()")
        check('7. math is typeset while the reply is still streaming (no raw LaTeX)', mid[0] and not mid[1], mid)
        await idle()

        # 3, 4: canvas
        await pg.evaluate("document.querySelector('#viewSeg button[data-v=canvas]').click()"); await pg.locator('#cv .cnode[data-ctid="main"]').wait_for(); await calm(pg)
        ov = await pg.evaluate("(()=>{const h=document.querySelector('.cvhint').getBoundingClientRect(),t=document.querySelector('.cvtools').getBoundingClientRect();return getComputedStyle(document.querySelector('.cvhint')).display==='none'||h.right<=t.left})()")
        check('3. the canvas hint ends before the zoom tools', ov)
        prev = await pg.evaluate("""(()=>{const n=document.querySelector('#cv .cnode[data-ctid="main"]');return [...n.querySelectorAll('.cprev,.cr,.cq,.ca,div,span')].map(e=>e.textContent).find(t=>t.includes('Three roles'))||n.textContent})()""")
        check('4. a card preview has no “- ” list markers, and the heading ends like a sentence', 'Three roles. Each token' in prev and ' - ' not in prev and '- a query' not in prev, prev[:200])
        await pg.screenshot(path=OUT + '/polish_canvas.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
