"""A model that never stops calling the document tools still answers, and a reply never ends blank.
With a small budget (MAX_TOOL_CALLS=3, so 6 requests), the fake ChatGPT and Anthropic API models keep searching
until a request says no tool may run (tool_choice none), which the server sends once they reach the limit. It used
to stop there and report the reply as done with no text, which the page saved as a finished, empty reply.
  - ChatGPT and the Anthropic API: the answer arrives, after the limit's worth of tool results, and the last
    request had tool_choice none while the ones before let the tools run.
  - A reply that finishes with no text is shown as an error with Retry, never as a finished blank reply.
Asserts and exits non-zero."""
import asyncio, json, os, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright
from common import FIX, launch_args, BOOT_WATCH, booted, replies, settled, saved, CORS
from test_server import FAKES, CDN, free_port, start, wait_port

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, ('' if ok else str(detail)[:600]))
    if not ok: fails.append(name)

def lines(path): return [json.loads(l) for l in open(path).read().splitlines() if l.strip().startswith('{')]
LAST = "(()=>{const r=[...document.querySelectorAll('.pane[data-tid=main] .msg.assistant')].pop();return r?r.innerText:''})()"

async def main():
    tmp = tempfile.mkdtemp(); procs = []
    try:
        oport, aport = free_port(), free_port()
        oa_log, api_log = os.path.join(tmp, 'openai.log'), os.path.join(tmp, 'api.log')
        for f in (oa_log, api_log): open(f, 'w').close()
        procs.append(subprocess.Popen(['node', os.path.join(FAKES, 'fake-openai.mjs'), str(oport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_LOG': oa_log}))
        procs.append(subprocess.Popen(['node', os.path.join(FAKES, 'fake-anthropic.mjs'), str(aport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_API_LOG': api_log}))
        wait_port(oport); wait_port(aport)
        obase = f'http://127.0.0.1:{oport}'
        auth = os.path.join(tmp, 'chatgpt.json')
        with open(os.open(auth, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
            json.dump({'client_id': 'app_1', 'host_id': 'urn:uuid:t', 'access_token': 'tok-1', 'refresh_token': 'ref-1', 'scopes': ['chatgpt.tokens.use.direct'], 'expires_at': int(time.time() * 1000) + 3600_000}, f)
        s1, base1 = start({'CLAUDE_BIN': '/nonexistent/claude', 'DATA_DIR': os.path.join(tmp, 'd1'), 'MAX_TOOL_CALLS': '3',
                           'CHATGPT_AUTH_FILE': auth, 'CHATGPT_AUTH_BASE': obase, 'CHATGPT_API_BASE': obase + '/v1'})
        s2, base2 = start({'ANTHROPIC_API_KEY': 'test-key', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{aport}', 'DATA_DIR': os.path.join(tmp, 'd2'), 'MAX_TOOL_CALLS': '3'})
        procs += [s1, s2]
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            async def open_app(base, model=None):
                ctx = await b.new_context(viewport={'width': 1300, 'height': 850}); pg = await ctx.new_page()
                errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
                async def route(r):
                    u = r.request.url
                    for k, v in CDN.items():
                        if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
                    if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                    await r.continue_()
                await pg.route('**/*', route); await pg.add_init_script(BOOT_WATCH); await pg.goto(base + '/'); await booted(pg)
                if model: await pg.select_option('#mSel', model)
                await pg.locator('#newDoc').click(); await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click()
                await pg.wait_for_function(r"(()=>{const o=document.querySelector('.pane[data-tid=doc] .ph-origin');return o&&/Page \d+ of \d+/.test(o.textContent)})()", timeout=20000)
                return ctx, pg, errs
            async def ask(pg, text):
                ta = pg.locator('.pane[data-tid=main] textarea'); n = await replies(pg); await ta.fill(text); await ta.press('Enter')
                await settled(pg, n + 1, timeout=30000)
                await pg.wait_for_function("![...document.querySelectorAll('.sendb')].some(b=>b.title==='Stop')", timeout=30000); await saved(pg)
                return await pg.evaluate(LAST)

            for who, base, model, log, choice in (('ChatGPT', base1, 'gpt-test-1', oa_log, lambda l: l.get('tool_choice')),
                                                  ('Anthropic API', base2, None, api_log, lambda l: (l.get('tool_choice') or {}).get('type'))):
                ctx, pg, errs = await open_app(base, model)
                reply = await ask(pg, 'NEVERSTOP tell me everything in this paper')
                check(f'{who}: a model that keeps calling tools still answers', 'FINALANSWER after' in reply, reply[:300])
                got = [l for l in lines(log) if 'NEVERSTOP' in json.dumps(l)]
                cs = [choice(l) for l in got]
                check(f'{who}: once it reached the limit, one last request with no tool allowed (6 with tools, then 1 without)', len(cs) == 7 and cs[-1] == 'none' and all(c != 'none' for c in cs[:-1]), cs)
                check(f'{who}: the answer saw every tool result (the calls past the budget came back as "answer now")', 'FINALANSWER after 6 tool results' in reply, reply[:200])
                check(f'{who}: no error on the reply', await pg.locator('.pane[data-tid=main] .msg.assistant').last.locator('.err, .merr').count() == 0)
                check(f'{who}: no page errors', not errs, errs[:3])
                await ctx.close()

            # a reply that ends with no text: an error with Retry, not a finished blank reply (the page's own fake model)
            from common import goto_app
            pg = await b.new_page()
            await pg.add_init_script("window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>({text:'',truncated:false})};")
            await goto_app(pg); await booted(pg)
            ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Say nothing'); await ta.press('Enter')
            await pg.wait_for_function("(()=>{const c=__digress.conv,id=(c.order.main||[]).slice(-1)[0],m=id&&c.msgs[id];return m&&m.role==='assistant'&&!m.pending})()", timeout=15000)
            m = await pg.evaluate("(()=>{const c=__digress.conv,m=c.msgs[c.order.main.slice(-1)[0]];return {error:m.error||'',content:m.content||''}})()")
            check('a reply with no text is saved as an error, not as a finished blank reply', 'No answer came back' in m['error'] and not m['content'], m)
            txt = await pg.evaluate(LAST)
            check('…which says so on the page', 'No answer came back' in txt, txt[:200])
            await b.close()
    finally:
        for pr in procs: pr.terminate()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
