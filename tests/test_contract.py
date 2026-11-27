"""One list of checks for the /api/* contract (agents/server.md), run against the three things that implement it:
the real server (with the fake Claude Code CLI), the demo's in-browser stand-in (demo/demo.js) and the UI tests'
in-page fake (tests/fakes/page-server.js). tests/contract_cases.js has the checks; where an implementation is meant
to differ from the server, the check says so there, with the reason. A fake that drifts from the server fails here.
Exits non-zero if any check fails in any implementation."""
import asyncio, os, shutil, sys, tempfile
from playwright.async_api import async_playwright
from common import launch_args, BOOT_WATCH, booted, goto_app, build_site, goto_site, ROOT, CORS
from test_server import start, FAKES

CASES = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'contract_cases.js'), encoding='utf-8').read()
FAKE_LLM = "window.fakeLLM = { use: async (name) => name === 'sample' ? async (messages, opts) => { opts.onText({ text: 'Hello ' }); return { text: 'Hello from the fake model.', truncated: false }; } : null };"
fails = []


async def run_cases(pg, impl):
    results = await pg.evaluate(CASES + f"\n;digressContract({{impl: '{impl}'}})")
    print(f'--- {impl}: {len(results)} checks')
    for r in results:
        print(('ok   ' if r['ok'] else 'FAIL ') + f"[{impl}] {r['name']}", '' if r['ok'] else '\n       ' + r['detail'])
        if not r['ok']: fails.append(f"[{impl}] {r['name']}")
    return results


async def main():
    tmp = tempfile.mkdtemp(prefix='digress-contract-')
    proc = None
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            errs = []

            # the real server, with the fake Claude Code CLI: the page is served by it, so requests are same-origin
            proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': os.path.join(tmp, 'data')})
            pg = await (await b.new_context()).new_page()
            pg.on('pageerror', lambda e: errs.append(str(e)))
            async def lib(r):
                u = r.request.url
                if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
                await r.continue_()
            await pg.route('**/*', lib)
            await pg.add_init_script(BOOT_WATCH); await pg.goto(base + '/'); await booted(pg)
            await run_cases(pg, 'server')
            await pg.close()

            # the demo, built from web/
            site = os.path.join(tmp, 'site'); build_site(site)
            pg = await (await b.new_context()).new_page()
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await goto_site(pg, site); await booted(pg)
            await run_cases(pg, 'demo')
            await pg.close()

            # the UI tests' fake
            pg = await (await b.new_context()).new_page()
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.add_init_script(FAKE_LLM)
            await goto_app(pg); await booted(pg)
            await run_cases(pg, 'fake')
            await pg.close()
            await b.close()
        if errs: print('page errors:', errs[:3])
    finally:
        if proc: proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    print('\nFAILED:' if fails else '\nall contract checks passed', *fails, sep='\n  ')
    sys.exit(1 if fails else 0)

asyncio.run(main())
