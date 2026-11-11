import asyncio, sys, os
from playwright.async_api import async_playwright

from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args
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
window.claude = { use: async (n) => {
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
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
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
        await pg.goto('file://' + PAGE)
        await pg.wait_for_timeout(1200)
        await pg.select_option('#mSel','claude-opus-5-5')
        ta = pg.locator('.pane[data-tid="main"] textarea')
        await ta.fill('Explain self-attention'); await ta.press('Enter')
        await pg.wait_for_timeout(2500)
        SEL = """([pi, word]) => { const panes=document.querySelectorAll('.pane'); const body=panes[pi].querySelector('.msg.assistant .body');
          const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf(word); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+word.length);
            const s=getSelection(); s.removeAllRanges(); s.addRange(r); break;}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }"""
        await pg.evaluate(SEL, [0,'soft dictionary lookup']); await pg.wait_for_timeout(150)
        await pg.locator('#popIn').fill('Why lookup?'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(2500)
        await pg.evaluate(SEL, [0,'query']); await pg.wait_for_timeout(150)
        await pg.locator('#popChips .chip').nth(1).click(); await pg.wait_for_timeout(2500)
        print('opts', await pg.evaluate('JSON.stringify({m:window.__opts.model,t:window.__opts.modelTier})'))
        print('panes', await pg.evaluate("[...document.querySelectorAll('.pane')].map(p=>p.querySelector('.ph-title').textContent)"))
        print('markers', await pg.evaluate("[...document.querySelectorAll('.pane[data-tid=main] sup.fn')].map(s=>s.textContent)"), 'chips', await pg.locator('.pane[data-tid=main] .bchip').count())
        print('model label', await pg.locator('.pane[data-tid=main] .model').first.text_content())
        # collapse middle pane
        await pg.locator('.pane').nth(1).locator('[data-act=collapse]').click(); await pg.wait_for_timeout(300)
        print('rails', await pg.locator('.pane.rail').count())
        await pg.screenshot(path=OUT + '/v1.png')
        # takeaway from last branch
        last = pg.locator('.pane').nth(2)
        await last.locator('[data-act=take]').first.click(); await last.locator('.tk input').fill('the key idea'); await last.locator('.tk .go').click()
        await pg.wait_for_timeout(2500)
        print('notes in main', await pg.locator('.pane[data-tid=main] .msg.note').count())
        ctx = await pg.evaluate("JSON.stringify(window.__calls[window.__calls.length-1].slice(-1))")
        print('takeaway prompt tail', ctx[-260:])
        # back from last branch
        await last.locator('[data-act=back]').click(); await pg.wait_for_timeout(600)
        print('flashing anchors', await pg.locator('.anchor.flash').count())
        await pg.screenshot(path=OUT + '/v2.png')
        # canvas
        await pg.locator('[data-v=canvas]').click(); await pg.wait_for_timeout(600)
        print('canvas nodes', await pg.locator('.cnode').count(), 'edges', await pg.locator('#edges path').count())
        await pg.screenshot(path=OUT + '/v3.png')
        await pg.locator('.cnode').nth(2).locator('[data-cact=panes]').click(); await pg.wait_for_timeout(500)
        print('after canvas click view', await pg.evaluate("document.getElementById('stage').className"))
        # delete branch via chip
        d = pg.locator('.pane[data-tid=main] [data-delb]').first
        await pg.locator('.pane[data-tid=main] .bchip').first.hover()
        await d.click(); await pg.wait_for_timeout(200); await pg.locator('#mOk').click(); await pg.wait_for_timeout(400)
        print('after delete markers', await pg.evaluate("[...document.querySelectorAll('.pane[data-tid=main] sup.fn')].map(s=>s.textContent)"), 'panes', await pg.locator('.pane').count())
        print('\n'.join(errs[:20]) or 'no errors')
        await b.close()

asyncio.run(main())
