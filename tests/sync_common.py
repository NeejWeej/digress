"""What test_sync_devices.py and test_sync_replies.py share: the real server with fake Claude Code, and
browser "devices" (each its own profile) on it."""
import json, os, shutil, tempfile
from contextlib import asynccontextmanager
from playwright.async_api import async_playwright
from common import BOOT_WATCH, booted, come_back, settled, replies, saved, launch_args
from test_server import start, req, CDN, FAKES

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:500])
    if not ok: fails.append(what)


@asynccontextmanager
async def setup():
    """-> an object with base, convs(), device(w), ask(pg, q, tid, wait), idle(pg), back(pg, until), texts(pg, tid), errs."""
    tmp = tempfile.mkdtemp(); data = os.path.join(tmp, 'data'); log = os.path.join(tmp, 'claude.log')
    proc, base = start({'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': os.path.join(FAKES, 'fake-claude.mjs'), 'DATA_DIR': data, 'FAKE_LOG': log, 'RUN_DETACH_MS': '6000'})
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            s = Env(b, base)
            yield s
            await b.close()
    finally:
        proc.terminate(); shutil.rmtree(tmp, ignore_errors=True)


class Env:
    def __init__(self, browser, base):
        self.b, self.base, self.errs = browser, base, []

    def convs(self):
        return {d['id']: d['data'] for d in json.loads(req(self.base, 'GET', '/api/store/convs')[1])}

    def rev(self, cid):
        st, body = req(self.base, 'GET', f'/api/store/convs/{cid}?rev')
        return json.loads(body)['rev'] if st == 200 else None

    async def device(self, w=1400):
        ctx = await self.b.new_context(viewport={'width': w, 'height': 900}); pg = await ctx.new_page()
        pg.on('pageerror', lambda e: self.errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in CDN.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(BOOT_WATCH)
        await pg.goto(self.base + '/'); await booted(pg)
        return pg

    async def ask(self, pg, q, tid='main', wait=True):
        n = await replies(pg)
        ta = pg.locator(f'.pane[data-tid="{tid}"] textarea'); await ta.fill(q); await ta.press('Enter')
        if wait: await self.idle(pg, n + 1)

    async def idle(self, pg, n=0, t=25000):
        """No reply being written (at least n replies), and the conversation saved as it now is."""
        await settled(pg, n, timeout=t); await saved(pg)

    async def back(self, pg, until, arg=None):
        """The tab comes back (common.come_back); True once `until` (a JS function of arg) holds."""
        return await come_back(pg, until, arg, must=False)   # the check after it says what's wrong

    def texts(self, pg, tid='main'):
        return pg.locator(f'.pane[data-tid="{tid}"] .msg.user').all_text_contents()


LAST_MAIN = "(()=>{const c=__digress.conv,m=c.msgs[c.order.main.at(-1)];return m})()"


async def ticks(pg, n=1, timeout=15000):
    """Wait until the reply being written in main (still pending) has at least n ticks from the fake (it has started on the server)."""
    await pg.wait_for_function(f"n=>{{const m={LAST_MAIN};return m.role==='assistant'&&m.pending&&(m.content||'').split('tick').length-1>=n}}", arg=n, timeout=timeout)
