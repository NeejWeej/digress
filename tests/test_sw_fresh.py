"""After a deploy, the next visit opens the new page, even from a host that lets browsers cache it.

GitHub Pages sends the demo with `cache-control: max-age=600`, and the demo had no service worker, so for ten minutes
after a deploy the browser opened its own copy of the old page (the old tab names) until a reload. The demo's
service worker (demo/sw.js) checks every request with the server. Here a real HTTP server sends the built demo with the same header; the page is
changed on disk and opened again by an ordinary navigation (not a reload). Asserts and exits non-zero."""
import asyncio, functools, http.server, os, sys, tempfile, threading
from playwright.async_api import async_playwright
from common import launch_args, build_site, soon
from test_server import free_port

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)


class PagesLike(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('cache-control', 'max-age=600')   # what GitHub Pages sends
        super().end_headers()
    def log_message(self, *a): pass


async def main():
    root = tempfile.mkdtemp(); site = os.path.join(root, 'digress'); build_site(site)
    port = free_port()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(PagesLike, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://localhost:{port}/digress/'
    index = os.path.join(site, 'index.html')
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            # no routing: Playwright turns the HTTP cache off while anything is routed, and the cache is the point here
            ctx = await b.new_context(viewport={'width': 1200, 'height': 800}, service_workers='allow')
            pg = await ctx.new_page()
            await pg.goto(url)
            check('the service worker controls the page', await soon(pg, '() => !!navigator.serviceWorker.controller', timeout=15000))

            # a deploy: the page changes on the server
            html = open(index, encoding='utf-8').read()
            open(index, 'w', encoding='utf-8').write(html.replace('<head>', '<head><meta name="deployed" content="v2">', 1))
            os.utime(index, (os.path.getmtime(index) + 5,) * 2)   # a later Last-Modified, so the server can't answer 304

            await pg.goto(url)   # an ordinary visit, not a reload
            got = await pg.evaluate("document.querySelector('meta[name=deployed]')?.content || null")
            check('an ordinary visit after the deploy opens the new page', got == 'v2', f'(got {got!r})')
            await b.close()
    finally:
        srv.shutdown()
    if fails: print('FAILED:', fails); sys.exit(1)
    print('all passed')

asyncio.run(main())
