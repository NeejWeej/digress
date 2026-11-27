"""Regression tests for code review fixes:
  1. Origin guard rejects cross-port and scheme-mismatched Origins on the same hostname,
     while allowing matching Origin and reverse-proxied https://*.ts.net.
  2. Explicit unavailable model (e.g. gpt-5 when only Claude is connected) is rejected with 400
     instead of routing the conversation to the wrong provider.
  3. Detached continuation (`saveOrphan` with `m.runFrom > 0`) preserves the original answer prefix
     and clears `runFrom`.
  4. Save conflict preserves edits made while the save request was in flight.
Asserts and exits non-zero."""
import asyncio, http.client, json, os, sys, tempfile, time
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from common import BOOT_WATCH, launch_args, booted, soon, settle
from test_server import start, req, FAKES

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)


def raw_req(base, method, path, body=None, headers=None):
    u = urlparse(base)
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=15)
    h = {'host': f'{u.hostname}:{u.port}', **(headers or {})}
    if body is not None and isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        h.setdefault('content-type', 'application/json')
    c.request(method, path, body, h)
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, data


def test_server_fixes():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': FAKES + '/fake-claude.mjs', 'LLM_PROVIDER': 'claude-code'})
        try:
            u = urlparse(base)
            # 1. Origin guard checks scheme and port, not just hostname
            st_same, _ = raw_req(base, 'GET', '/api/health', headers={'origin': f'http://{u.hostname}:{u.port}'})
            st_port, _ = raw_req(base, 'GET', '/api/health', headers={'origin': f'http://{u.hostname}:{u.port + 1}'})
            st_scheme, _ = raw_req(base, 'GET', '/api/health', headers={'origin': f'https://{u.hostname}:{u.port}'})
            st_ts, _ = raw_req(base, 'GET', '/api/health', headers={'host': 'box.ts.net', 'origin': 'https://box.ts.net'})
            check('origin guard allows matching origin and https .ts.net, blocks wrong port/scheme',
                  st_same == 200 and st_port == 403 and st_scheme == 403 and st_ts == 200,
                  (st_same, st_port, st_scheme, st_ts))

            # 2. Explicit unavailable model (gpt-5 when only claude-code is enabled) returns 400
            st_bad, body_bad = req(base, 'POST', '/api/chat', {
                'model': 'gpt-5',
                'messages': [{'role': 'user', 'content': 'hello'}],
            })
            check('unavailable explicit model rejected with 400 before dispatch',
                  st_bad == 400 and b'not available' in body_bad,
                  (st_bad, body_bad[:200]))

            # 3. Detached continuation preserves prefix via m.runFrom and clears m.runFrom
            run_id = 'a' * 32
            conv = {
                'id': 'c_cont', 'title': 'Cont test', 'updated': 1, 'created': 1,
                'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                'order': {'main': ['u1', 'a1']},
                'msgs': {
                    'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Go on', 'ts': 1},
                    'a1': {'id': 'a1', 'thread': 'main', 'role': 'assistant', 'content': 'Original answer. ', 'run': run_id, 'runFrom': 17, 'ts': 2},
                },
            }
            st_put, _ = req(base, 'PUT', '/api/store/convs/c_cont', conv)
            assert st_put == 200
            # Start chat run and immediately close the connection so it finishes orphaned
            c = http.client.HTTPConnection(u.hostname, u.port, timeout=15)
            payload = json.dumps({
                'chat': run_id,
                'save': {'conv': 'c_cont', 'msg': 'a1'},
                'messages': [
                    {'role': 'user', 'content': 'Go on'},
                    {'role': 'assistant', 'content': 'Original answer. '},
                    {'role': 'user', 'content': 'Continue'},
                ],
            }).encode()
            c.request('POST', '/api/chat', payload, {'content-type': 'application/json'})
            r = c.getresponse()
            r.read(1)  # ensure the server accepted the run before detaching
            c.close()  # detach mid-stream

            # Wait for saveOrphan to finish writing into c_cont
            saved = None
            for _ in range(50):
                _, raw = req(base, 'GET', '/api/store/convs/c_cont')
                d = json.loads(raw)
                if 'run' not in d['msgs']['a1']:
                    saved = d['msgs']['a1']
                    break
                time.sleep(0.1)
            check('detached continuation preserves original prefix and clears runFrom',
                  saved is not None and saved['content'].startswith('Original answer. ') and len(saved['content']) > len('Original answer. ') and 'runFrom' not in saved,
                  saved)
        finally:
            proc.terminate()


async def test_inflight_conflict_browser():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': FAKES + '/fake-claude.mjs', 'LLM_PROVIDER': 'claude-code'})
        try:
            async with async_playwright() as p:
                b = await p.chromium.launch(**launch_args())
                pg = await b.new_page(viewport={'width': 1200, 'height': 800})
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                await pg.add_init_script(BOOT_WATCH)

                # Seed a conversation on the server (rev 1)
                conv = {
                    'id': 'c_conf', 'title': 'Initial Title', 'titleKept': True, 'updated': 100, 'created': 100,
                    'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                    'order': {'main': ['u1']},
                    'msgs': {'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'hi', 'ts': 1}},
                }
                st_put, _ = req(base, 'PUT', '/api/store/convs/c_conf', conv)
                assert st_put == 200

                in_flight = asyncio.Event()
                release = asyncio.Event()
                intercepted = {'done': False}

                async def hold_put(route):
                    r = route.request
                    if r.method == 'PUT' and '/api/store/convs/c_conf' in r.url and not intercepted['done']:
                        intercepted['done'] = True
                        # Simulate another device updating folder on the server before this PUT lands
                        _, cur_raw = req(base, 'GET', '/api/store/convs/c_conf')
                        cur = json.loads(cur_raw)
                        cur['folder'] = 'RemoteFolder'
                        cur['updated'] = int(time.time() * 1000)
                        raw_req(base, 'PUT', '/api/store/convs/c_conf', cur, {'x-base-rev': str(cur['rev'])})
                        in_flight.set()
                        await release.wait()
                    await route.continue_()

                await pg.route('**/api/store/convs/*', hold_put)
                await pg.goto(base + '/#c=c_conf')
                await booted(pg)
                await soon(pg, "()=>__digress.conv && __digress.conv.id === 'c_conf' && __digress.conv.rev >= 1")

                # Edit 1: change title to 'Title 1' (triggers PUT which hold_put pauses)
                await pg.evaluate("""() => {
                  const t = document.getElementById('cTitle');
                  t.contentEditable = 'true';
                  t.textContent = 'Title 1';
                  t.dispatchEvent(new Event('blur'));
                }""")
                await asyncio.wait_for(in_flight.wait(), timeout=10)

                # Edit 2 while PUT is in flight: change title to 'Title 2'
                await pg.evaluate("""() => {
                  const t = document.getElementById('cTitle');
                  t.contentEditable = 'true';
                  t.textContent = 'Title 2';
                  t.dispatchEvent(new Event('blur'));
                }""")
                release.set()

                # Wait for 409 merge + retry save to complete with BOTH Title 2 and RemoteFolder
                await soon(pg, "()=>__digress.conv.title === 'Title 2' && __digress.conv.folder === 'RemoteFolder'", timeout=10000)
                srv = None
                for _ in range(40):
                    _, raw = req(base, 'GET', '/api/store/convs/c_conf')
                    srv = json.loads(raw)
                    if srv.get('title') == 'Title 2' and srv.get('folder') == 'RemoteFolder':
                        break
                    await asyncio.sleep(0.1)
                live = await pg.evaluate("()=>({title:__digress.conv.title, folder:__digress.conv.folder})")
                check('409 save conflict preserves edit made while save was in flight alongside remote folder change',
                      live['title'] == 'Title 2' and live['folder'] == 'RemoteFolder'
                      and srv.get('title') == 'Title 2' and srv.get('folder') == 'RemoteFolder',
                      {'live': live, 'srv': {'title': srv.get('title'), 'folder': srv.get('folder')}})
                check('no page errors in conflict test', not errs, errs)
                await b.close()
        finally:
            proc.terminate()


async def main():
    test_server_fixes()
    await test_inflight_conflict_browser()
    if fails:
        print('FAILED:', fails)
        sys.exit(1)
    print('ALL PASSED')


if __name__ == '__main__':
    asyncio.run(main())
