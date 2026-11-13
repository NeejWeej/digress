"""The model reads big documents itself, with tools, on every provider.

A 60-page PDF (too long to send whole) is opened in the app, through the real server, and each provider
(Claude Code, ChatGPT and the Anthropic API, as fakes in tests/fakes/) answers a question by running the
same scripted tool session (tests/fakes/doc-script.mjs): search + view a page, then read three pages and
ask for one that doesn't exist, then answer with exactly what came back. That checks the whole loop:
the server passes each call to the page, the page runs it on the open PDF, the result travels back in the
provider's own format, and the model gets as many rounds as it needs.

Also: what the model starts with (contents + first pages, the same every question; a branch about a
passage carries the pages around it), a small document still goes whole, the trail under the reply, and
the new endpoints refuse what they should. Asserts and exits non-zero.
"""
import asyncio, json, os, re, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright
from common import FIX, OUT, launch_args
from test_server import FAKES, CDN, free_port, start, req

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, ('' if ok else str(detail)[:600]))
    if not ok: fails.append(name)

FILLER = ('The quick analysis of attention layers continues with more careful measurements of every head, '
          'their scaling behaviour, and the variance of the scores across many training runs. ') * 22


async def make_pdf(b, path, pages):
    pg = await b.new_page()
    body = ''
    for n in range(1, pages + 1):
        fig = ('<svg width="300" height="160"><rect x="20" y="20" width="120" height="120" fill="#c00"/><text x="160" y="90" font-size="20">bars</text></svg>'
               '<p>Figure 1: a red square next to the word bars.</p>') if n == 2 else ''
        body += f'<section style="page-break-after:always"><h1>Section {n}</h1><p>Marker ZEBRA-{n} on page {n}.</p>{fig}<p>{FILLER}</p></section>'
    await pg.set_content(f'<html><body style="font:11px sans-serif">{body}</body></html>')
    await pg.pdf(path=path, format='A4', outline=True, tagged=True, margin={'top': '20px', 'bottom': '20px', 'left': '20px', 'right': '20px'})
    await pg.close()


def lines(path):
    return [json.loads(l) for l in open(path).read().splitlines() if l.strip().startswith('{')]


async def main():
    tmp = tempfile.mkdtemp(); procs = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            big = os.path.join(tmp, 'big.pdf'); await make_pdf(b, big, 60)

            # fakes: OpenAI (ChatGPT plan route) and the Anthropic API; Claude Code is a fake CLI
            oport, aport = free_port(), free_port()
            oa_log, api_log, cc_log = (os.path.join(tmp, n) for n in ('openai.log', 'api.log', 'claude.log'))
            for f in (oa_log, api_log, cc_log): open(f, 'w').close()
            procs.append(subprocess.Popen(['node', os.path.join(FAKES, 'fake-openai.mjs'), str(oport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_LOG': oa_log}))
            procs.append(subprocess.Popen(['node', os.path.join(FAKES, 'fake-anthropic.mjs'), str(aport)], stdout=subprocess.PIPE, env={**os.environ, 'FAKE_API_LOG': api_log}))
            time.sleep(0.6)
            obase = f'http://127.0.0.1:{oport}'
            auth = os.path.join(tmp, 'chatgpt.json')
            with open(os.open(auth, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
                json.dump({'client_id': 'app_1', 'host_id': 'urn:uuid:t', 'access_token': 'tok-1', 'refresh_token': 'ref-1', 'scopes': ['chatgpt.tokens.use.direct'], 'expires_at': int(time.time() * 1000) + 3600_000}, f)
            s1, base1 = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': os.path.join(tmp, 'd1'), 'FAKE_LOG': cc_log,
                               'CHATGPT_AUTH_FILE': auth, 'CHATGPT_AUTH_BASE': obase, 'CHATGPT_API_BASE': obase + '/v1'})
            s2, base2 = start({'ANTHROPIC_API_KEY': 'test-key', 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{aport}', 'DATA_DIR': os.path.join(tmp, 'd2')})
            procs += [s1, s2]
            check('the server says its providers can use the document tools', json.loads(req(base1, 'GET', '/api/health')[1]).get('tools') is True)

            # the new endpoints refuse what they should
            st, _ = req(base1, 'POST', '/api/chat/tool', {'chat': 'f' * 32, 'id': 'x', 'parts': [{'type': 'text', 'text': 'hi'}]})
            check('a tool result for no waiting call is refused', st == 404, st)
            st, _ = req(base1, 'POST', '/api/mcp/' + 'a' * 48, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
            check('the MCP endpoint refuses an unknown token', st == 404, st)
            st, _ = req(base1, 'POST', '/api/chat/tool', {'chat': 'f' * 32, 'id': 'x', 'parts': []}, headers={'origin': 'https://evil.example'})
            check('…and other sites can\'t post tool results', st == 403, st)

            # the model knows the budget up front, and is told as it runs low (server/doctools.mjs on its own)
            script = ("const { DOC_TOOLS, openSession, deliverResult, MAX_TOOL_CALLS } = await import(process.argv[1]);"
                      "const up = DOC_TOOLS.every((t) => t.description.includes(`up to ${MAX_TOOL_CALLS} document tool calls per answer`));"
                      "const s = openSession('a'.repeat(32)); s.out = (o) => setTimeout(() => deliverResult({ chat: s.chatId, id: o.tool.id, parts: [{ type: 'text', text: 'x' }] }));"
                      "const tails = []; for (let i = 0; i <= MAX_TOOL_CALLS; i++) { const r = await s.call('read_pages', { from: 1 }); tails.push((r.error ? 'E:' : '') + r.parts.at(-1).text); } s.close();"
                      "console.log(JSON.stringify({ up, tails }));")
            out = json.loads(subprocess.run(['node', '--input-type=module', '-e', script, os.path.join(os.path.dirname(FAKES), '..', 'server', 'doctools.mjs')], capture_output=True, text=True).stdout)
            t = out['tails']
            check('every tool\'s description tells the model its budget of calls', out['up'])
            check('results say how many calls are left once only a few are', t[10] == 'x' and t[11].startswith('(3 document tool calls left') and t[13].startswith('(1 document tool call left') and 'last document tool call' in t[14], t[10:15])
            check('past the budget, calls come back as an error telling it to answer', t[15].startswith('E:That is the limit'), t[15])

            async def open_app(base):
                ctx = await b.new_context(viewport={'width': 1500, 'height': 950})
                pg = await ctx.new_page(); errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                async def route(r):
                    u = r.request.url
                    for k, v in CDN.items():
                        if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
                    if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                    await r.continue_()
                await pg.route('**/*', route)
                await pg.goto(base + '/'); await pg.wait_for_timeout(1500)
                return ctx, pg, errs

            async def wait_idle(pg):
                for _ in range(200):
                    if await pg.evaluate("![...document.querySelectorAll('.sendb')].some(b=>b.title==='Stop')"): break
                    await pg.wait_for_timeout(100)
                await pg.wait_for_timeout(900)

            async def new_doc(pg, path):
                await pg.locator('#newDoc').click(); await pg.wait_for_timeout(200)
                before = await pg.evaluate("location.hash+'|'+document.querySelectorAll('.citem').length")
                await pg.set_input_files('#docFile', path); await pg.locator('#docGo').click()
                for _ in range(50):    # the new conversation exists
                    if await pg.evaluate("location.hash+'|'+document.querySelectorAll('.citem').length") != before: break
                    await pg.wait_for_timeout(100)
                for _ in range(200):   # the doc pane's header says "Page 1 of N" once the text is read
                    o = pg.locator('.pane[data-tid=doc] .ph-origin')
                    if await o.count() and re.search(r'Page \d+ of \d+', await o.first.text_content() or ''): break
                    await pg.wait_for_timeout(100)

            async def ask(pg, text, tid='main'):
                ta = pg.locator(f'.pane[data-tid="{tid}"] textarea').first
                await ta.fill(text); await ta.press('Enter'); await wait_idle(pg)

            last_reply = lambda pg: pg.evaluate("(()=>{const r=[...document.querySelectorAll('.pane[data-tid=main] .msg.assistant')].pop();return r?r.innerText:''})()")

            def check_script(who, reply):
                check(f'{who}: the model got as many rounds as it needed and answered', 'DOCREPLY after 4 tool results' in reply, reply[:300])
                check(f'{who}: search ran on the open PDF and found the page', re.search(r'search: text:1 match for "ZEBRA-42", on pages 42', reply) is not None, reply[:600])
                check(f'{who}: view_page sent back a real picture of the page', re.search(r'view_page: text:Page 2: \| image:image/(png|jpeg):\d{4,}', reply) is not None, reply)
                check(f'{who}: read_pages sent back those pages\' text', '[p. 41]' in reply and 'ZEBRA-41' in reply and 'read_pages: text:[p. 41]' in reply, reply)
                check(f'{who}: a page that doesn\'t exist comes back as an error the model can read', re.search(r'read_pages ERROR: text:(Error: )?There is no p\. 9999: the document has 60 pages', reply) is not None, reply)

            async def check_trail(pg, who):
                s = await pg.locator('.pane[data-tid=main] .msg.assistant').last.locator('.dreads summary').text_content()
                check(f'{who}: under the reply, what it read of the document', 'searched' in s and 'read 3 pages' in s and 'looked at 1 page' in s and 'started from the contents and pp. 1–3 of 60' in s, s)

            # ---- server 1: Claude Code, then ChatGPT, in the same conversation
            ctx, pg, errs = await open_app(base1)
            await new_doc(pg, big)

            await ask(pg, 'READDOC what is in section 42?')
            reply = await last_reply(pg)
            check_script('Claude Code', reply)
            await check_trail(pg, 'Claude Code')
            await pg.screenshot(path=OUT + '/doc_tools.png')
            cc = [l for l in lines(cc_log) if 'model' in l]
            first = cc[-1]
            check('Claude Code: offered exactly our three tools through our MCP server', [l for l in lines(cc_log) if 'mcpTools' in l][-1]['mcpTools'] == ['search', 'read_pages', 'view_page'])
            check('Claude Code: only those tools are allowed, nothing built in', first['tools'] == '' and first['allowed'] == 'mcp__digress__search,mcp__digress__read_pages,mcp__digress__view_page', first)
            check('Claude Code: still isolated from your own setup (no CLAUDE.md, hooks, settings, other MCP servers)', first['isolatedHow'] == 'pieces', first)
            sys1 = first['system']
            check('the test PDF was too long to send whole', 'It is too long to include whole' in sys1, sys1[:300])
            check('its built-in table of contents was read, with page numbers', 'Section 42 … p. 42' in sys1, sys1[-1500:])
            check('it starts with the contents and the first 3 pages, not the whole document', '<contents>' in sys1 and 'Section 42 … p. 42' in sys1 and 'ZEBRA-3 ' in sys1 and 'ZEBRA-4 ' not in sys1 and 'ZEBRA-42' not in sys1, sys1[-800:])
            check('it is told how to use the tools and not to guess', 'search finds where something is' in sys1 and 'never guess' in sys1)

            # same conversation, ChatGPT
            await pg.select_option('#mSel', 'gpt-test-1'); await pg.wait_for_timeout(200)
            await ask(pg, 'READDOC and again, through ChatGPT')
            reply = await last_reply(pg)
            check_script('ChatGPT', reply)
            await check_trail(pg, 'ChatGPT')
            oa = [l for l in lines(oa_log) if l.get('model', '').startswith('gpt-test')]
            check('ChatGPT: the tools went as function tools, and the loop took 3 requests', all(any(t.get('type') == 'function' and t.get('name') == 'read_pages' for t in l.get('tools', [])) for l in oa[-3:]) and len(oa) >= 3)
            check('ChatGPT: the same starting point (contents + first pages) as the developer message', oa[-1]['input'][0]['role'] == 'developer' and '<contents>' in oa[-1]['input'][0]['content'])

            # the starting point never changes between questions (one prompt cache for the conversation)
            await pg.select_option('#mSel', 'auto'); await pg.wait_for_timeout(200)
            await ask(pg, 'A follow-up about something else entirely: transformers in general?')
            sys2 = [l for l in lines(cc_log) if 'model' in l][-1]['system']
            check('a different question starts from exactly the same instructions', sys2 == sys1)

            # a branch about a passage on p. 30 carries pp. 29–31
            await pg.locator('.dpage[data-page="30"]').scroll_into_view_if_needed(); await pg.wait_for_timeout(1500)
            ok = await pg.evaluate('''() => { const tl = document.querySelector('.dpage[data-page="30"] .textLayer'); if (!tl) return false;
              const w = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf('ZEBRA-30');
              if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 8); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
              document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); return true; } } return false; }''')
            check('selected a passage on p. 30', ok)
            await pg.wait_for_timeout(300)
            await pg.locator('#popIn').fill('What is this marker?'); await pg.locator('#popIn').press('Enter'); await wait_idle(pg)
            br = [l for l in lines(cc_log) if 'model' in l][-1]
            check('a branch about a passage brings the text of its page and the pages either side', '[The text of pp. 29–31, around it:]' in br['prompt'] and 'ZEBRA-29' in br['prompt'] and 'ZEBRA-31' in br['prompt'] and 'ZEBRA-32' not in br['prompt'], br['prompt'][:400])
            check('…and still the same instructions', br['system'] == sys1)

            # a small document still goes whole, and only view_page is suggested
            await new_doc(pg, FIX + '/paper.pdf')
            await ask(pg, 'Summarize this.')
            sm = [l for l in lines(cc_log) if 'model' in l][-1]
            check('a short document is sent whole, with the tools still there for figures', 'full extracted text is below' in sm['system'] and '<contents>' not in sm['system'] and sm['mcp'], sm['system'][-300:])
            check('no page errors (server 1)', not errs, errs[:3])
            await ctx.close()

            # ---- server 2: the Anthropic API
            ctx, pg, errs = await open_app(base2)
            await new_doc(pg, big)
            await ask(pg, 'READDOC what is in section 42?')
            reply = await last_reply(pg)
            check_script('Anthropic API', reply)
            await check_trail(pg, 'Anthropic API')
            api = [l for l in lines(api_log) if l.get('api')]
            check('Anthropic API: tools sent on every round, 3 requests', len(api) >= 3 and all(set(['search', 'read_pages', 'view_page']) <= set(l['tools']) for l in api[-3:]))
            check('Anthropic API: the model\'s text before the tools and its answer are both kept, as separate paragraphs', reply.startswith('Let me look in the document.') and '\nDOCREPLY' in reply, reply[:120])
            check('no page errors (server 2)', not errs, errs[:3])
            await ctx.close()
            await b.close()
    finally:
        for pr in procs: pr.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
