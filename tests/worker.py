"""Persistent test worker for tests/run_all.py.

Keeps one Playwright instance and one Browser process (Chromium or WebKit) alive across all tests
dispatched to this worker, giving every test fresh BrowserContext(s) (isolated cookies, localStorage,
IndexedDB, service workers, and cache) while eliminating repeated Python + Playwright + browser
cold-start overhead. Every test file remains 100% standalone when run directly.
"""
import asyncio, io, json, os, runpy, sys, time, traceback
from playwright.async_api import async_playwright as _real_async_playwright
import playwright.async_api as _pw_mod

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import common  # applies DIGRESS_BROWSER=webkit patch and loads shared helpers


class _SharedBrowser:
    """Proxy over the worker's shared Browser: isolates every test in fresh BrowserContexts."""
    def __init__(self, browser, tracked):
        self._browser = browser
        self._tracked = tracked

    async def new_context(self, **kw):
        ctx = await self._browser.new_context(**kw)
        self._tracked.append(ctx)
        return ctx

    async def new_page(self, **kw):
        ctx = await self._browser.new_context(**kw)
        self._tracked.append(ctx)
        return await ctx.new_page()

    async def close(self):
        while self._tracked:
            ctx = self._tracked.pop()
            try:
                await ctx.close()
            except Exception:
                pass

    def __getattr__(self, name):
        return getattr(self._browser, name)


class _SharedBrowserType:
    def __init__(self, real_bt, state, tracked):
        self._real = real_bt
        self._state = state
        self._tracked = tracked

    async def launch(self, **kw):
        b = self._state.get('browser')
        if b is None or not b.is_connected():
            b = await self._real.launch(**common.launch_args())
            self._state['browser'] = b
        return _SharedBrowser(b, self._tracked)

    def __getattr__(self, name):
        return getattr(self._real, name)


class _FakePlaywright:
    def __init__(self, pw, state, tracked):
        self._pw = pw
        self._state = state
        self._tracked = tracked
        real_bt = getattr(pw, common.BROWSER)
        self._shared_bt = _SharedBrowserType(real_bt, state, tracked)

    @property
    def chromium(self):
        return self._shared_bt

    def __getattr__(self, name):
        if name == common.BROWSER:
            return self._shared_bt
        return getattr(self._pw, name)


class _FakePlaywrightCM:
    def __init__(self, state):
        self._state = state
        self._tracked = []

    async def __aenter__(self):
        if self._state.get('pw') is None:
            self._state['pw'] = await _real_async_playwright().start()
        return _FakePlaywright(self._state['pw'], self._state, self._tracked)

    async def __aexit__(self, exc_type, exc, tb):
        while self._tracked:
            ctx = self._tracked.pop()
            try:
                await ctx.close()
            except Exception:
                pass
        return False


def main():
    real_in = sys.stdin
    real_out = sys.stdout
    real_err = sys.stderr

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    state = {'pw': None, 'browser': None}

    def patched_run(coro, **kw):
        return loop.run_until_complete(coro)

    def patched_async_playwright():
        return _FakePlaywrightCM(state)

    asyncio.run = patched_run
    _pw_mod.async_playwright = patched_async_playwright

    os.chdir(HERE)
    try:
        for line in real_in:
            name = line.strip()
            if not name:
                continue
            t0 = time.time()
            buf = io.StringIO()
            env0 = dict(os.environ)
            argv0 = list(sys.argv)
            code = 0
            test_path = os.path.join(HERE, name)
            sys.stdout = buf
            sys.stderr = buf
            sys.argv = [test_path]
            try:
                runpy.run_path(test_path, run_name='__main__')
            except SystemExit as e:
                if e.code is None or e.code == 0:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    buf.write(str(e.code) + '\n')
                    code = 1
            except Exception:
                traceback.print_exc(file=buf)
                code = 1
            finally:
                sys.stdout = real_out
                sys.stderr = real_err
                sys.argv = argv0
                # Restore environment variables so no test leaks env mutations
                for k in list(os.environ.keys()):
                    if k not in env0:
                        del os.environ[k]
                os.environ.update(env0)
                # Ensure no leftover contexts remain open on the shared browser
                b = state.get('browser')
                if b is not None:
                    if b.is_connected():
                        for ctx in list(b.contexts):
                            try:
                                loop.run_until_complete(ctx.close())
                            except Exception:
                                pass
                    else:
                        state['browser'] = None

            dt = time.time() - t0
            real_out.write(json.dumps({'name': name, 'code': code, 'dt': dt, 'out': buf.getvalue()}) + '\n')
            real_out.flush()
    finally:
        try:
            if state.get('browser') is not None:
                loop.run_until_complete(state['browser'].close())
            if state.get('pw') is not None:
                loop.run_until_complete(state['pw'].stop())
        except Exception:
            pass
        loop.close()


if __name__ == '__main__':
    main()
