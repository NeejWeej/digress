"""Turning Web on or off never changes what came before, so the prompt cache keeps working.
  - Every request starts with the previous request's messages unchanged (the system prompt included).
  - A question asked with Web on carries PROMPTS.webOn, in that request and every later one; the others never do.
  - The request says whether it may search (web), per question.
  - A side branch is marked only where it forks: its first question has the [Side question …] marker; its later
    questions carry no marker (no "(Asked in a side branch.)"), and main's questions never do.
(The tools offered stay the same either way; that's the server's part, in test_server.py.)
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, frames
from common import CORS

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
}
FAKE = r"""window.__calls=[];window.fakeLLM={use:async(n)=>n!=='sample'?null:async(msgs,opts)=>{
  window.__calls.push({msgs:JSON.parse(JSON.stringify(msgs)),web:opts.web});
  const out='Reply '+window.__calls.length+'.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
NOTE = '(Web search is on for this question.)'
q = lambda m: m['content'].split('\n\n---\n\n')[-1]   # the question (the fake puts the system prompt before the first)
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 800}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea')
        async def ask(q):
            await ta.fill(q); await answered(pg, ta.press('Enter')); await frames(pg)
        web = pg.locator('#webT')
        await ask('First, with Web off.')
        await web.click(); await ask('Second, with Web on.')
        await web.click(); await ask('Third, Web off again.')
        calls = await pg.evaluate('window.__calls')
        check('three requests', len(calls) == 3, len(calls))
        if len(calls) == 3:
            c1, c2, c3 = [c['msgs'] for c in calls]
            check('each request starts with the one before, unchanged (system prompt included)', c2[:len(c1)] == c1 and c3[:len(c2)] == c2, [c1, c2, c3])
            check('the question asked with Web on is marked, in its own request', c2[-1]['content'].rstrip().endswith(NOTE), c2[-1])
            check('…and still in the next one', NOTE in c3[2]['content'], c3[2])
            check('questions asked with Web off never are', NOTE not in q(c1[0]) and NOTE not in q(c3[-1]) and NOTE not in q(c3[0]), [c1[0], c3[-1]])
            check('the requests say whether they may search', [c['web'] for c in calls] == [False, True, False], [c['web'] for c in calls])
        # --- a side branch: marked only where it forks ---
        BR = '(Asked in a side branch.)'
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').last.click()
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1'); await frames(pg, 3)
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        bta = pg.locator(f'.pane[data-tid="{bt}"] textarea')
        for t in ('Branch, first.', 'Branch, second.', 'Branch, third.'):
            await bta.fill(t); await answered(pg, bta.press('Enter')); await frames(pg)
        calls = await pg.evaluate('window.__calls')
        b1, b2, b3 = [c['msgs'] for c in calls[-3:]]
        check('the branch’s first question has its [Side question] marker', '[Side question' in b1[-1]['content'], b1[-1])
        check('its later questions carry no marker at all', all('[Side question' not in m['content'] and BR not in m['content'] and 'side branch' not in q(m).lower() for m in (b2[-1], b3[-1])) and q(b2[-1]) == 'Branch, second.' and q(b3[-1]) == 'Branch, third.', [b2[-1], b3[-1]])
        check('…and each request still starts with the one before, unchanged', b2[:len(b1)] == b1 and b3[:len(b2)] == b2)
        check('main’s questions are never marked', not any(BR in q(m) for m in b1[:-1] if m['role'] == 'user'), b1[:-1])
        await ask('Fourth, in main.')
        c4 = (await pg.evaluate('window.__calls'))[-1]['msgs']
        check('a question in main after that isn’t marked', BR not in c4[-1]['content'] and '[Side question' not in c4[-1]['content'] and c4[:len(c3)] == c3, c4[-1])

        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
