"""Shared paths and helpers for the browser tests.

The UI tests open web/index.html through goto_app(): the page is served at http://digress.test/
with tests/fakes/page-server.js standing in for the server, and its CDN libraries come from
node_modules (run `npm install` first), so they need no network.
Set CHROME_PATH to use a specific Chrome; otherwise Playwright's own Chromium is used.
"""
import asyncio, os, time

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
    path = os.path.join(OUT, f'cached_math.{os.getpid()}.html')   # per process: tests run in parallel
    open(path, 'w', encoding='utf-8').write(fast)
    return path


APP_URL = 'http://digress.test/'
PAGE_SERVER = open(os.path.join(HERE, 'fakes', 'page-server.js'), encoding='utf-8').read()


async def goto_app(pg, page=PAGE):
    """Open the app the way the real server serves it, with the in-page fake server answering /api/*.
    Call it after the test's own pg.route(...) so this route wins for the page itself."""
    await pg.add_init_script(PAGE_SERVER)
    await pg.add_init_script(BOOT_WATCH)   # after the fake server, so it sees the page's own requests
    await pg.route(APP_URL, lambda r: r.fulfill(path=page, content_type='text/html; charset=utf-8'))
    def serve(f):   # one handler per file (Playwright passes a second argument to two-parameter handlers)
        return lambda r: r.fulfill(path=os.path.join(REPO, 'web', f), content_type='text/javascript; charset=utf-8')
    for f in ('prompts.js', 'threads.js'):
        await pg.route(APP_URL + f, serve(f))
    await pg.goto(APP_URL)


# ---------- waiting for the app instead of sleeping ----------
# Startup ends with loading the flashcards (after the model list, the conversation list and opening the latest
# conversation), so the page asking for them means it's ready. It also counts catchUp's version checks (come_back). Added by goto_app(); tests against the real server
# add it themselves (pg.add_init_script(BOOT_WATCH)) before pg.goto().
BOOT_WATCH = r"""(() => {
  const f = window.fetch;
  window.fetch = function (input, init) {
    try {
      const u = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (/\/api\/store\/cards$/.test(u.pathname) && !(init && init.method && init.method !== 'GET')) window.__booted = true;
      if (/\/api\/store\/convs\//.test(u.pathname) && u.searchParams.has('rev')) window.__revChecks = (window.__revChecks || 0) + 1;   // catchUp asking for the version
    } catch (e) { /* not a URL we care about */ }
    return f.apply(this, arguments);
  };
})();"""


async def booted(pg, timeout=30000):
    """The page has finished starting up (connected, listed conversations, opened the latest one)."""
    await pg.wait_for_function('window.__booted === true', timeout=timeout)


REPLIES_JS = "Object.values(__digress.conv.msgs).filter(m => m.role !== 'user').length"


async def replies(pg):
    """How many replies (assistant messages and takeaway notes) the open conversation has."""
    return await pg.evaluate(REPLIES_JS)


async def settled(pg, n=0, timeout=30000):
    """Wait until the open conversation has at least n replies and none is still being written."""
    await pg.wait_for_function("n => { const ms = Object.values(__digress.conv.msgs); "
                               "return ms.filter(m => m.role !== 'user').length >= n && !ms.some(m => m.pending) }", arg=n, timeout=timeout)


async def answered(pg, action, n=1, timeout=30000):
    """Run `action` (a coroutine, e.g. ta.press('Enter')) and wait for the n replies it starts to finish."""
    n0 = await replies(pg)
    await action
    await settled(pg, n0 + n, timeout)


# the open conversation's content is what was last saved (same as the page's contentOf/contentKey)
SAVED_JS = """(() => { const d = window.__digress, c = d && d.conv; if (!c || !d.sync.sent) return false;
  const msgs = {}; for (const [k, m] of Object.entries(c.msgs)) { const x = {...m}; for (const f of ['pending','ver','live','t0','toolNow']) delete x[f]; msgs[k] = x; }
  const {ui, rev, ...rest} = {...c, msgs};
  return JSON.stringify({...JSON.parse(JSON.stringify(rest)), updated: 0}) === d.sync.sent; })()"""


async def saved(pg, layout=False, timeout=30000):
    """Wait until the open conversation has been saved as it is now (and its layout too, with layout=True)."""
    js = SAVED_JS if not layout else f"{SAVED_JS} && JSON.stringify(__digress.conv.ui) === __digress.sync.ui && !__digress.sync.uiSaving"   # and arrived
    await pg.wait_for_function(js, timeout=timeout)


async def soon(pg, js, arg=None, timeout=10000):
    """Wait for a condition; True if it came true in time, False if not (for a check() to report)."""
    try:
        await pg.wait_for_function(js, arg=arg, timeout=timeout)
        return True
    except Exception as e:
        if 'Timeout' not in type(e).__name__ and 'Timeout' not in str(e): raise
        return False


async def frames(pg, n=2):
    """Let the page draw n frames (layout, observers and rAF callbacks run)."""
    await pg.evaluate("n => new Promise(r => { const f = () => --n > 0 ? requestAnimationFrame(f) : r(); requestAnimationFrame(f) })", n)


async def poll(fn, timeout=15, every=0.1):
    """Call fn until it returns something truthy (or the time is up); returns its last value."""
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() > end: return v
        await asyncio.sleep(every)


async def steady(pg, expr, n=5, timeout=10000):
    """Wait until the JS expression `expr` gives the same value for n frames in a row (an animation has ended)."""
    await pg.wait_for_function("""([expr, n]) => { const v = JSON.stringify((0, eval)(expr)), s = window.__steady || (window.__steady = {});
      const k = s[expr]; if (k && k.v === v) return ++k.n >= n; s[expr] = {v, n: 0}; return false }""", arg=[expr, n], timeout=timeout)
    await pg.evaluate("expr => { if (window.__steady) delete window.__steady[expr] }", expr)


CAM = "[document.getElementById('world').style.transform, ...[...document.querySelectorAll('#cv .cfull')].map(f => f.scrollTop)]"


async def come_back(pg, until='()=>true', arg=None, tries=10, must=True):
    """The tab comes back to the front, so it catches up (catchUp). True once it has asked the server for the
    conversation's version and `until` (a JS function of arg) holds. catchUp ignores a come-back within 1.5 s
    of the last one, so the tab comes back again each second until then (up to `tries` times). If it never
    does: raises (must=True) or returns False."""
    for _ in range(tries):
        c0 = await pg.evaluate('window.__revChecks || 0')
        await pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        if await soon(pg, f"([c0, a]) => (window.__revChecks || 0) > c0 && ({until})(a)", [c0, arg], timeout=1000): return True
    if must: raise AssertionError(f'the page never caught up ({until}, {arg!r})')
    return False


async def caught_up(pg, rev, tries=10, must=True):
    """come_back() until the open conversation is at version rev (what the server has)."""
    return await come_back(pg, 'r => __digress.sync.rev === r', rev, tries, must)

# what moves while the page animates: the canvas camera, scrolling inside cards and panes, the pane strip, cards and panes
MOTION = ("[(document.getElementById('world') || {style: {}}).style.transform, "
          "...[...document.querySelectorAll('#cv .cfull, .pane .pb, #panes')].map(e => [e.scrollTop, e.scrollLeft]), "
          "...[...document.querySelectorAll('.cnode, .pane')].map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })]")


async def calm(pg, timeout=10000):
    """Let the page draw, then wait until nothing is moving (camera glides, smooth scrolls)."""
    await frames(pg)
    await steady(pg, MOTION, timeout=timeout)


async def changed(pg, expr, action, timeout=10000):
    """Run `action` (a coroutine) and wait until the JS expression `expr` gives something else than before it."""
    before = await pg.evaluate(f"JSON.stringify({expr})")
    await action
    await pg.wait_for_function(f"b => JSON.stringify({expr}) !== b", arg=before, timeout=timeout)


# MathJax has started (window.__mathReady added its stylesheet and redrew the panes) and every diagram is drawn
DRAWN_JS = ("!!document.getElementById('MJX-SVG-styles') && "
            "[...document.querySelectorAll('.mermaid-box')].every(b => b.dataset.done && b.querySelector('svg, pre'))")


async def drawn(pg, timeout=30000):
    """Wait until math and diagrams are drawn (they load and render asynchronously, and change heights)."""
    await pg.wait_for_function(DRAWN_JS, timeout=timeout)


# after #newConv: an empty conversation is open and its box has the focus (the app focuses it 30 ms later)
NEW_CONV_JS = ("!__digress.conv.order.main.length && !__digress.conv.doc && "
               "document.activeElement === document.querySelector('.pane[data-tid=main] textarea')")


async def new_conv(pg):
    """Click New conversation and wait until it's open."""
    await pg.locator('#newConv').click()
    await pg.wait_for_function(NEW_CONV_JS)


# the open PDF is read (its header says "Page N of M") and the pages in or near view (the app draws those, within
# 900 px) are drawn at the current size, with their text layers
PDF_DRAWN_JS = r"""(() => { const o = document.querySelector('.pane[data-tid=doc] .ph-origin'), pb = document.querySelector('.pane[data-tid=doc] .pb');
  if (!o || !pb || !/Page \d+ of \d+/.test(o.textContent)) return false;
  const r = pb.getBoundingClientRect(), near = [...pb.querySelectorAll('.dpage')].filter(d => { const b = d.getBoundingClientRect(); return b.bottom > r.top - 900 && b.top < r.bottom + 900 });
  return near.length > 0 && near.every(d => { const c = d.querySelector('canvas'); return c && c.width >= d.offsetWidth - 2 && d.querySelector('.textLayer span') }) })()"""


async def pdf_drawn(pg, timeout=30000):
    await pg.wait_for_function(PDF_DRAWN_JS, timeout=timeout)


async def pdf_fitted(pg, timeout=30000):
    """After the panes change size: the PDF (at 100%) has been laid out again to fit its pane (the app does that
    250 ms after a resize) and drawn."""
    await pg.wait_for_function("(()=>{const pb=document.querySelector('.pane[data-tid=doc] .pb'),d=pb&&pb.querySelector('.dpage');"
                               "return !!d&&Math.abs(d.offsetWidth-Math.max(260,pb.clientWidth-46))<=1})()", timeout=timeout)
    await pdf_drawn(pg, timeout)


# ---------- the demo site (demo/build.mjs): a built folder served under a path, as GitHub Pages does ----------
SITE_URL = 'http://digress.test/digress/'
CDN = {   # every library the page loads from a CDN, from node_modules
    'highlight.js/11.9.0/highlight.min.js': '@highlightjs/cdn-assets/highlight.min.js',
    'pdf.js/3.11.174/pdf.min.js': 'pdfjs-dist/build/pdf.min.js', 'pdf.js/3.11.174/pdf.worker.min.js': 'pdfjs-dist/build/pdf.worker.min.js',
    'purify.min.js': 'dompurify/dist/purify.min.js', 'marked.min.js': 'marked/marked.min.js', 'tex-svg-full.js': 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': 'mermaid/dist/mermaid.min.js', 'minisearch@7.1.0/dist/umd/index.js': 'minisearch/dist/umd/index.js',
    'Readability.js': '@mozilla/readability/Readability.js', 'turndown@7.2.0/dist/turndown.js': 'turndown/dist/turndown.js',
    'turndown-plugin-gfm.js': 'turndown-plugin-gfm/dist/turndown-plugin-gfm.js',
}


def build_site(out):
    """Build the demo site into `out` with node demo/build.mjs."""
    import subprocess
    subprocess.run(['node', os.path.join(REPO, 'demo', 'build.mjs'), out], check=True, capture_output=True)


async def goto_site(pg, site, path=''):
    """Open the built demo site in `site` at SITE_URL + path, with CDN libraries from node_modules."""
    import mimetypes
    async def route(r):
        u = r.request.url.split('#')[0].split('?')[0]
        if u.startswith(SITE_URL):
            f = os.path.join(site, u[len(SITE_URL):] or 'index.html')
            if os.path.isdir(f): f = os.path.join(f, 'index.html')
            if not os.path.isfile(f): return await r.fulfill(status=404, body='not found')
            if f.endswith('index.html'):   # BOOT_WATCH after demo.js, so it sees the requests demo.js answers
                html = open(f, encoding='utf-8').read().replace('<script src="demo/demo.js"></script>', '<script src="demo/demo.js"></script><script>' + BOOT_WATCH + '</script>', 1)
                return await r.fulfill(body=html, content_type='text/html; charset=utf-8')
            return await r.fulfill(path=f, content_type=(mimetypes.guess_type(f)[0] or 'application/octet-stream'))
        for k, v in CDN.items():
            if u.endswith(k): return await r.fulfill(path=ROOT + v, content_type='application/javascript')
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        await r.abort()   # the demo makes no other requests
    await pg.route('**/*', route)
    await pg.goto(SITE_URL + path)
