import asyncio, sys, os
from playwright.async_api import async_playwright

from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args, goto_app
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
setTimeout(()=>{window.fakeLLM = { use: async (n) => { await new Promise(r=>setTimeout(r,1500));
  if (n === 'sample') return async (input, opts) => {
    window.__calls.push(input);
    let out = '';
    for (const ch of REPLY.match(/[\s\S]{1,40}/g)) { out += ch; opts.onText && opts.onText({text: out, delta: ch}); await new Promise(r => setTimeout(r, 5)); }
    return {text: out, truncated: false};
  };
  return null;
}};},2000);
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
        await goto_app(pg)
        await pg.wait_for_timeout(300)
        await pg.locator('[data-ask]').first.click()
        await pg.wait_for_timeout(6000)
        print('errors shown:', await pg.locator('.err').count(), '| assistant msgs:', await pg.locator('.msg.assistant').count())
        await pg.locator('#tSide').click()
        await pg.wait_for_timeout(400)
        print('stage width after collapse:', await pg.evaluate("document.getElementById('stage').getBoundingClientRect().width"))
        await pg.screenshot(path=OUT + '/s5.png')
        print('\n'.join(errs[:20]) or 'no errors')
        await b.close()

asyncio.run(main())
