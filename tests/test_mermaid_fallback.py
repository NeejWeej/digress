"""Diagrams: a valid Mermaid block is drawn; one with a syntax error (here, the kind models write: a colon
inside a state-diagram label) says why it can't be drawn, shows the error and its source, and offers
"Ask for a fix", which fills in this thread's question box (without sending). Asserts and exits non-zero."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, soon

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
BAD = "\nstateDiagram-v2\n    [*] --> Follower\n    Follower --> Candidate: \"election timeout (no heartbeat)\"\n    Candidate --> Candidate: \"timeout, split vote: new election\"\n    Candidate --> Leader: \"wins majority of votes\"\n    Candidate --> Follower: \"discovers current leader or higher term\"\n    Leader --> Follower: \"discovers higher term\"\n\n"
GOOD = 'flowchart LR\n  A[Client] --> B[Leader]\n  B --> C[Follower]\n'
REPLY = 'Roles:\n\n```mermaid\n' + BAD + '```\n\nAnd the flow:\n\n```mermaid\n' + GOOD + '```\n'
FAKE = "window.__asked=0;window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{window.__asked++;const out=%s;opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};" % json.dumps(REPLY)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else detail)
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 850})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain Raft roles'); await ta.press('Enter')
        boxes = pg.locator('.pane[data-tid=main] .mermaid-box')
        await pg.wait_for_function("document.querySelectorAll('.pane[data-tid=main] .mermaid-box[data-done]').length===2&&!document.querySelector('.pane[data-tid=main] .mermaid-box[data-done]:not(:has(svg)):not(.mm-bad)')", timeout=20000)
        check('the valid diagram is drawn', await boxes.nth(1).locator('svg').count() == 1)
        bad = boxes.nth(0)
        txt = await bad.inner_text()
        check('the broken one says it has a syntax error', 'syntax error' in txt and await bad.locator(':scope > svg').count() == 0, txt[:200])
        check('…shows mermaid’s error', 'Parse error' in await bad.locator('.mm-msg').inner_text())
        check('…and its source', 'stateDiagram-v2' in await bad.locator('.mm-err').inner_text())
        await pg.screenshot(path=OUT + '/mermaid_fallback.png')
        asked = await pg.evaluate('window.__asked')
        await bad.locator('[data-mmfix]').click(); await soon(pg, "() => !!document.querySelector('.pane[data-tid=main] textarea').value")
        v = await ta.input_value()
        check('Ask for a fix fills in the question, with the error', 'syntax error' in v and 'Parse error' in v and 'stateDiagram-v2' in v, v)
        check('…without sending it', await pg.evaluate('window.__asked') == asked)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
