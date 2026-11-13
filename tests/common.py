"""Shared paths and helpers for the browser tests.

The UI tests open web/index.html through goto_app(): the page is served at http://digress.test/
with tests/fakes/page-server.js standing in for the server, and its CDN libraries come from
node_modules (run `npm install` first), so they need no network.
Set CHROME_PATH to use a specific Chrome; otherwise Playwright's own Chromium is used.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ROOT = os.path.join(REPO, 'node_modules') + '/'
PAGE = os.path.join(REPO, 'web', 'index.html')
FIX = os.path.join(HERE, 'fixtures')
OUT = os.path.join(HERE, '.artifacts')
os.makedirs(OUT, exist_ok=True)
CHROME = os.environ.get('CHROME_PATH')


def launch_args():
    args = {'args': ['--no-sandbox']}
    if CHROME:
        args['executable_path'] = CHROME
    return args


def cached_math_page():
    """A copy of the app that loads MathJax synchronously, the way a warm browser cache behaves."""
    html = open(PAGE, encoding='utf-8').read()
    fast = html.replace('<script async src="https://cdn.jsdelivr.net/npm/mathjax', '<script src="https://cdn.jsdelivr.net/npm/mathjax')
    assert fast != html, 'MathJax script tag not found'
    path = os.path.join(OUT, 'cached_math.html')
    open(path, 'w', encoding='utf-8').write(fast)
    return path


APP_URL = 'http://digress.test/'
PAGE_SERVER = open(os.path.join(HERE, 'fakes', 'page-server.js'), encoding='utf-8').read()


async def goto_app(pg, page=PAGE):
    """Open the app the way the real server serves it, with the in-page fake server answering /api/*.
    Call it after the test's own pg.route(...) so this route wins for the page itself."""
    await pg.add_init_script(PAGE_SERVER)
    await pg.route(APP_URL, lambda r: r.fulfill(path=page, content_type='text/html; charset=utf-8'))
    await pg.goto(APP_URL)
