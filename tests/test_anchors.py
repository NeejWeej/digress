import asyncio, sys, os
from playwright.async_api import async_playwright

from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app, booted, answered, drawn, frames, changed
from common import CORS
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

That is why attention is described as soft dictionary lookup.

- First, the **query** for token $i$ is compared
- Second, each **key** gets a score

The end.`;
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
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
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
        await ta.fill('Explain'); await answered(pg, ta.press('Enter')); await drawn(pg)
        # select from inside "query" in list item 1 to "each" in list item 2 (crosses bold, math, li boundary)
        await pg.evaluate("""() => { const body=document.querySelector('.pane .msg.assistant .body');
          const lis=body.querySelectorAll('li'); const q=lis[0].querySelector('strong').firstChild; const t2=[...lis[1].childNodes].find(n=>n.nodeType===3&&n.nodeValue.includes('each'));
          const r=document.createRange(); r.setStart(q,2); r.setEnd(t2, t2.nodeValue.indexOf('each')+4);
          const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('What is this?'); await answered(pg, pg.locator('#popIn').press('Enter')); await drawn(pg)
        info = await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
          const sup=b.querySelector('sup.fn'); return {anchored:[...b.querySelectorAll('.anchor')].map(a=>a.textContent).join('|'),
          supParent: sup && sup.closest('li') ? sup.closest('li').textContent.slice(0,40) : (sup? 'NOT IN LI: '+sup.parentElement.tagName : 'none'),
          lastIsSup: b.lastElementChild.lastElementChild && b.lastElementChild.lastElementChild.matches('sup.fn')} }""")
        print('anchor', info)
        # nested branch so delete has a child
        await pg.evaluate("""() => { const body=document.querySelectorAll('.pane')[1].querySelector('.msg.assistant .body');
          const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf('lookup'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+6); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break;}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await answered(pg, pg.locator('#popChips .chip').first.click()); await drawn(pg)
        print('panes before', await pg.locator('.pane').count())
        # tooltip on the pane delete button
        btn = pg.locator('.pane').nth(1).locator('.ph [data-delb]')
        await btn.hover(); await pg.locator('#tipbox.show').wait_for()   # after the 380 ms delay
        print('tooltip:', await pg.locator('#tipbox.show').text_content())
        await btn.click(); await pg.locator('#modal.show').wait_for()
        print('modal:', (await pg.locator('#modal .mbox').inner_text()).replace('\n',' / '))
        await pg.screenshot(path=OUT + '/w1.png')
        await pg.locator('#mOk').click(); await pg.wait_for_function("!document.querySelector('#modal.show')"); await frames(pg)
        print('panes after', await pg.locator('.pane').count(), 'threads', await pg.evaluate("document.querySelectorAll('#tree .mnode').length"))
        # sidebar delete: make a new branch then delete from tree
        await changed(pg, "document.querySelectorAll('#tree .mnode').length", pg.locator('.pane[data-tid=main] [data-act=wbranch]').click())
        node = pg.locator('#tree .mnode').nth(1); await node.hover(); await node.locator('[data-delb]').click(); await pg.wait_for_function("!!document.querySelector('#modal.show')&&document.activeElement.id==='mOk'")   # open, and focused (20 ms later)
        print('sidebar modal title:', await pg.locator('#mTitle').text_content())
        await pg.keyboard.press('Escape'); await pg.wait_for_function("!document.querySelector('#modal.show')")
        print('modal closed by esc:', await pg.locator('#modal.show').count()==0, 'tree nodes', await pg.locator('#tree .mnode').count())
        print('\n'.join(errs[:20]) or 'no errors')
        await b.close()

asyncio.run(main())
