import asyncio, sys, os
from playwright.async_api import async_playwright

from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered, drawn, frames, calm
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}

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
                    return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u:
                return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route)
        await pg.add_init_script(FAKE)
        await goto_app(pg)
        await booted(pg)
        ta = pg.locator('.pane[data-tid="main"] textarea')
        await ta.fill('Explain self-attention'); await answered(pg, ta.press('Enter'))
        await ta.fill('And again?'); await answered(pg, ta.press('Enter')); await drawn(pg)
        SEL = """([pi, word]) => { const body=document.querySelectorAll(pi)[0];
          const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf(word); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+word.length);
            const s=getSelection(); s.removeAllRanges(); s.addRange(r); break;}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }"""
        await pg.evaluate(SEL, ['.pane[data-tid=main] .msg.assistant .body','soft dictionary lookup'])
        await pg.locator('#popIn').fill('Why lookup?'); await answered(pg, pg.locator('#popIn').press('Enter')); await drawn(pg); await calm(pg)
        # --- status toggle
        await pg.locator('.pane').nth(1).locator('.ph .sdot').click(); await frames(pg)
        print('resolved: header', await pg.locator('.pane.res .ph .sdot.res').count(), 'marker', await pg.locator('.pane[data-tid=main] sup.fn.res').count(), 'anchor', await pg.locator('.pane[data-tid=main] .anchor.res').count(), 'tree', await pg.locator('#tree .mnode.res').count())
        # --- jump buttons
        pb = pg.locator('.pane[data-tid=main] .pb')
        await pb.evaluate('e=>e.scrollTop=0'); await calm(pg)
        print('dbg', await pg.evaluate("(()=>{const p=document.querySelector('.pane[data-tid=main]');const pb=p.querySelector('.pb');return [pb.scrollHeight,pb.clientHeight,pb.scrollTop,p.className, getComputedStyle(p.querySelector('.jump')).opacity]})()"))
        print('jump visible when scrolled up:', await pg.locator('.pane[data-tid=main].away').count())
        await pg.locator('.pane[data-tid=main] [data-act=jend]').click(); await calm(pg)
        print('at bottom after jend:', await pb.evaluate('e=>e.scrollHeight-e.scrollTop-e.clientHeight<5'))
        await pg.locator('.pane[data-tid=main] .pb').hover(); await pg.mouse.wheel(0,-2000); await calm(pg)
        await pg.locator('.pane[data-tid=main] [data-act=jlast]').click(); await calm(pg)
        print('latest msg top offset:', await pg.evaluate("(()=>{const pb=document.querySelector('.pane[data-tid=main] .pb');const m=[...pb.querySelectorAll('.msgs>.msg')].slice(-2)[0];return Math.round(m.getBoundingClientRect().top-pb.getBoundingClientRect().top)})()"))
        await pb.evaluate('e=>e.scrollTop=e.scrollHeight'); await calm(pg)
        before = await pb.evaluate('e=>e.scrollTop')
        await pg.locator('.pane').nth(1).locator('.origin button[data-back]').click(); await calm(pg)
        print('return button shown:', await pg.locator('.pane[data-tid=main].hasprev').count())
        await pg.locator('.pane[data-tid=main] [data-act=jprev]').click(); await calm(pg)
        print('returned to spot:', abs(await pb.evaluate('e=>e.scrollTop')-before)<5)
        await pg.screenshot(path=OUT + '/x1.png')
        # --- canvas
        await pg.locator('[data-v=canvas]').click(); await pg.locator('.cnode.main').wait_for(); await calm(pg)
        print('cards', await pg.locator('.cnode').count(), 'edges', await pg.locator('#edges path').count())
        card = pg.locator('.cnode').nth(1); h = card.locator('.ch')
        bb = await h.bounding_box(); x0 = await card.evaluate('e=>e.offsetLeft')
        await pg.mouse.move(bb['x']+60, bb['y']+10); await pg.mouse.down(); await pg.mouse.move(bb['x']+260, bb['y']+160, steps=6); await pg.mouse.up()
        await frames(pg)
        print('dragged moved x by', await card.evaluate('e=>e.offsetLeft')-x0, 'saved pos', await pg.evaluate("Object.keys(window.__dbg||{}).length"))
        # expand main card, branch from inside it, ask from inside a card
        await pg.locator('.cnode.main [data-cact=exp]').click(); await calm(pg)
        print('expanded full msgs:', await pg.locator('.cnode.main .cfull .msg').count())
        await pg.evaluate(SEL, ['.cnode.main .cfull .msg.assistant .body','query']); await pg.locator('#pop.show').wait_for()
        print('popup in canvas:', await pg.locator('#pop.show').count())
        await answered(pg, pg.locator('#popChips .chip').first.click()); await drawn(pg); await calm(pg)
        print('cards after canvas branch', await pg.locator('.cnode').count(), 'expanded new card', await pg.locator('.cnode.exp').count())
        newc = pg.locator('.cnode.exp').last
        ta3 = newc.locator('.cask textarea')
        h0 = await ta3.evaluate('e=>e.offsetHeight')
        await ta3.fill('a long question that keeps going ' * 12); await ta3.dispatch_event('input'); await frames(pg)
        h1 = await ta3.evaluate('e=>e.offsetHeight')
        await ta3.press('Shift+Enter'); await ta3.type('second line'); await frames(pg)
        print('canvas box grows:', h0, '->', h1, '| shift+enter newline:', '\n' in await ta3.input_value())
        await ta3.fill('')
        await newc.locator('.cask textarea').fill('follow-up from canvas'); await answered(pg, newc.locator('.cask textarea').press('Enter')); await drawn(pg); await calm(pg)
        print('msgs in new card', await newc.locator('.cfull .msg').count())
        # fold main
        await pg.locator('#zFit').click(); await calm(pg)
        await pg.locator('.cnode.main [data-cact=fold]').click(); await calm(pg)
        print('cards when main folded', await pg.locator('.cnode').count())
        await pg.locator('.cnode.main [data-cact=fold]').click(); await calm(pg)
        await pg.locator('#zFit').click(); await calm(pg)
        await pg.screenshot(path=OUT + '/x2.png')
        await pg.locator('#zTidy').click(); await calm(pg)
        print('cards after tidy', await pg.locator('.cnode').count())
        # back to columns, make sure panes render
        await pg.locator('[data-v=cols]').click(); await calm(pg)
        print('panes after return', await pg.locator('.pane').count(), 'main msgs', await pg.locator('.pane[data-tid=main] .msg').count())
        print('\n'.join(errs[:20]) or 'no errors')
        await b.close()

asyncio.run(main())
