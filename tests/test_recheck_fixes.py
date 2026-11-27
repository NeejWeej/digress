"""Regression tests for follow-up code review fixes:
  1. Completed run persists to DB before KEEP_MS expiry even if an attached client disconnects before saving.
  2. Gemini-only server resolves builtinDefault() to a Gemini model (not Claude), and unknown model IDs return 400.
  3. Unsent pasted screenshot in conversation A does not travel into conversation B on switch.
  4. Automatic branch titles stay on the branch reply's provider (never crossing from Claude to GPT).
  5. Failed recovery copy on unmergeable 409 conflict or 410 remote deletion preserves the open local conversation.
Asserts and exits non-zero."""
import asyncio, http.client, json, os, sys, tempfile, threading, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from common import BOOT_WATCH, launch_args, goto_app, booted, answered, soon, frames, settle
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


def test_run_persists_before_expiry():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({
            'DATA_DIR': data,
            'CLAUDE_BIN': FAKES + '/fake-claude.mjs',
            'LLM_PROVIDER': 'claude-code',
            'RUN_KEEP_MS': '200',
            'RUN_SAVE_GRACE_MS': '80',
        })
        try:
            u = urlparse(base)
            run_id = 'b' * 32
            conv = {
                'id': 'c_exp', 'title': 'Expiry test', 'updated': 1, 'created': 1,
                'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                'order': {'main': ['u1', 'a1']},
                'msgs': {
                    'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'Hi', 'ts': 1},
                    'a1': {'id': 'a1', 'thread': 'main', 'role': 'assistant', 'content': '', 'run': run_id, 'ts': 2},
                },
            }
            st_put, _ = req(base, 'PUT', '/api/store/convs/c_exp', conv)
            assert st_put == 200
            # Stay attached until the stream ends (seen === true), then disconnect without saving via PUT
            c = http.client.HTTPConnection(u.hostname, u.port, timeout=15)
            payload = json.dumps({
                'chat': run_id,
                'save': {'conv': 'c_exp', 'msg': 'a1'},
                'messages': [{'role': 'user', 'content': 'Hi'}],
            }).encode()
            c.request('POST', '/api/chat', payload, {'content-type': 'application/json'})
            r = c.getresponse()
            stream_data = r.read()
            c.close()
            assert r.status == 200 and b'"done"' in stream_data

            # Wait past RUN_KEEP_MS so the in-memory run expires
            saved = None
            expired = False
            for _ in range(40):
                st_run, _ = req(base, 'GET', f'/api/chat/run/{run_id}?from=0')
                if st_run == 404:
                    expired = True
                _, raw = req(base, 'GET', '/api/store/convs/c_exp')
                d = json.loads(raw)
                if 'run' not in d['msgs']['a1']:
                    saved = d['msgs']['a1']
                    if expired:
                        break
                time.sleep(0.05)
            check('completed run persists to DB before KEEP_MS expiry even when client disconnects before saving',
                  expired and saved is not None and bool(saved.get('content', '').strip()) and 'run' not in saved,
                  {'expired': expired, 'saved': saved})
        finally:
            proc.terminate()


def test_gemini_default_and_unknown_model():
    class FakeGemini(BaseHTTPRequestHandler):
        def do_GET(self):
            if '/models' in self.path and self.headers.get('x-goog-api-key') == 'test-gem-key':
                body = json.dumps({
                    'models': [
                        {'name': 'models/gemini-2.5-pro', 'displayName': 'Gemini 2.5 Pro', 'supportedGenerationMethods': ['generateContent'], 'inputTokenLimit': 1000000},
                        {'name': 'models/gemini-2.5-flash', 'displayName': 'Gemini 2.5 Flash', 'supportedGenerationMethods': ['generateContent'], 'inputTokenLimit': 1000000},
                    ]
                }).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(401)
            self.end_headers()
        def log_message(self, *a): pass

    srv = HTTPServer(('127.0.0.1', 0), FakeGemini)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        with tempfile.TemporaryDirectory() as data:
            proc, base = start({
                'DATA_DIR': data,
                'LLM_PROVIDER': 'gemini',
                'GEMINI_API_KEY': 'test-gem-key',
                'GEMINI_API_BASE': f'http://127.0.0.1:{port}/v1beta',
                'CLAUDE_BIN': '/nonexistent',
            })
            try:
                st_m, raw_m = req(base, 'GET', '/api/models')
                jm = json.loads(raw_m)
                check('Gemini-only server resolves default model to a Gemini model (not Claude)',
                      st_m == 200 and str(jm.get('default', '')).startswith('gemini-'),
                      jm)
                st_u, body_u = req(base, 'POST', '/api/chat', {
                    'model': 'unknown-family-model-99',
                    'messages': [{'role': 'user', 'content': 'hello'}],
                })
                check('unknown model family is rejected with 400 instead of falling back',
                      st_u == 400 and b'not available' in body_u,
                      (st_u, body_u[:200]))
            finally:
                proc.terminate()
    finally:
        srv.shutdown()


MODELS_SCRIPT = r"""
(()=>{let f=window.fetch;Object.defineProperty(window,'fetch',{configurable:true,get:()=>f,set:(v)=>{f=async(i,o)=>{const u=String(typeof i==='string'?i:i.url);
  if(/(^|\/)api\/models(\?|$)/.test(u))return new Response(JSON.stringify({models:window.__modelList,defaultLabel:'GPT-6.2-Sol'}),{headers:{'content-type':'application/json'}});
  return v(i,o)}}})})();
window.__modelList = [['gpt-6.2-sol','GPT-6.2-Sol'],['gpt-6.1-terra','GPT-6.1 Terra'],['claude-opus-5-5','Opus 5.5'],['claude-haiku-5-5','Haiku 5.5']];
window.__titleCalls = [];
window.fakeTitles = true;
window.fakeLLM = {use: async (n) => n !== 'sample' ? null : async (input, opts) => {
  const last = input[input.length - 1].content;
  let out;
  if (typeof last === 'string' && last.includes('Write a short, specific title')) {
    window.__titleCalls.push({model: opts.model, ask: last});
    out = 'Branch Title';
  } else {
    out = 'Attention is a soft dictionary lookup. The scores are scaled by the square root of the dimension.';
  }
  opts.onText && opts.onText({text: out});
  return {text: out, truncated: false, modelApplied: opts.model};
}};
"""


async def test_browser_isolation_and_titles():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 850})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(MODELS_SCRIPT)
        await goto_app(pg)
        await booted(pg)

        # 1. Paste a synthetic PNG into conversation A, click New conversation, send text-only in B
        await pg.evaluate("""async () => {
          const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
          cv.getContext('2d').fillRect(0, 0, 8, 8);
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
          const file = new File([blob], 'shot.png', { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ta = document.querySelector('.pane[data-tid="main"] textarea');
          const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          ta.dispatchEvent(ev);
        }""")
        await soon(pg, "() => document.querySelectorAll('.pane[data-tid=\"main\"] .cimgs .cimg').length === 1")
        await pg.locator('#newConv').click()
        await frames(pg)
        check('new conversation composer has zero pending images from previous conversation',
              await pg.locator('.pane[data-tid="main"] .cimgs .cimg').count() == 0)
        ta = pg.locator('.pane[data-tid="main"] textarea')
        await ta.fill('Text only in conversation B')
        await answered(pg, ta.press('Enter'))
        b_imgs = await pg.evaluate("""() => {
          const c = __digress.conv;
          const u = Object.values(c.msgs).find(m => m.role === 'user');
          return (u && u.images) ? u.images.length : 0;
        }""")
        check('text-only message in conversation B carries zero images from conversation A', b_imgs == 0, b_imgs)

        # 2. GPT main conversation + Claude branch -> automatic title MUST use Claude (never GPT)
        await pg.locator('#newConv').click()
        await frames(pg)
        await pg.evaluate("(()=>{const s=document.getElementById('mSel');s.value='gpt-6.2-sol';s.dispatchEvent(new Event('change'))})()")
        ta = pg.locator('.pane[data-tid="main"] textarea')
        await ta.fill('Explain scaled dot product attention')
        await answered(pg, ta.press('Enter'))
        # Switch picker to Claude and create a branch with a vague question
        await pg.evaluate("(()=>{const s=document.getElementById('mSel');s.value='claude-opus-5-5';s.dispatchEvent(new Event('change'))})()")
        await pg.evaluate("""()=>{const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body');const r=document.createRange(),t=b.querySelector('p').firstChild;
          const i=t.data.indexOf('scaled by the square root');r.setStart(t,i);r.setEnd(t,i+25);getSelection().removeAllRanges();getSelection().addRange(r);b.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))}""")
        await pg.locator('#pop textarea').first.wait_for()
        pt = pg.locator('#pop textarea').first
        await pt.fill('why?')
        await pt.press('Enter')
        await soon(pg, "() => window.__titleCalls.length === 1")
        call_model = await pg.evaluate("window.__titleCalls[0].model")
        check('Claude branch inside GPT conversation uses Claude fast model for auto-title (never GPT)',
              call_model == 'claude-haiku-5-5', call_model)
        check('no page errors in attachment and title tests', not errs, errs[:3])
        await b.close()


async def test_failed_recovery_copy_keeps_local_work():
    with tempfile.TemporaryDirectory() as data:
        proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': FAKES + '/fake-claude.mjs', 'LLM_PROVIDER': 'claude-code'})
        try:
            async with async_playwright() as p:
                b = await p.chromium.launch(**launch_args())
                ctx = await b.new_context(viewport={'width': 1200, 'height': 800}, service_workers='block')
                pg = await ctx.new_page()
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                await pg.add_init_script(BOOT_WATCH)

                # Seed conversation on server
                conv = {
                    'id': 'c_loss', 'title': 'Original Title', 'titleKept': True, 'updated': 100, 'created': 100,
                    'threads': {'main': {'id': 'main', 'parent': None, 'title': 'Main'}},
                    'order': {'main': ['u1']},
                    'msgs': {'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'hi', 'ts': 1}},
                }
                st_put, _ = req(base, 'PUT', '/api/store/convs/c_loss', conv)
                assert st_put == 200

                mode = {'kind': 'conflict'}
                copy_attempted = asyncio.Event()

                async def fail_recovery(route):
                    r = route.request
                    if r.method == 'PUT' and '/api/store/convs/' in r.url:
                        if r.url.endswith('/c_loss'):
                            if mode['kind'] == 'conflict':
                                # Return a 409 whose remote thread graph is unmergeable (cycle -> ThreadOps.merge throws conflict)
                                bad_remote = {
                                    'id': 'c_loss', 'rev': 99, 'title': 'Remote Overwrite', 'titleKept': True,
                                    'updated': 999, 'created': 100,
                                    'threads': {
                                        'main': {'id': 'main', 'parent': None, 'title': 'Main'},
                                        'b_cyc': {'id': 'b_cyc', 'parent': 'b_cyc', 'anchorMsg': 'u1', 'title': 'Cycle'},
                                    },
                                    'order': {'main': ['u1'], 'b_cyc': ['m_cyc']},
                                    'msgs': {
                                        'u1': {'id': 'u1', 'thread': 'main', 'role': 'user', 'content': 'hi', 'ts': 1},
                                        'm_cyc': {'id': 'm_cyc', 'thread': 'b_cyc', 'role': 'user', 'content': 'x', 'ts': 2},
                                    },
                                }
                                return await route.fulfill(status=409, content_type='application/json', body=json.dumps({'error': 'conflict', 'current': bad_remote}))
                            elif mode['kind'] == 'deleted':
                                return await route.fulfill(status=410, content_type='application/json', body=json.dumps({'error': 'deleted'}))
                        else:
                            # Recovery copy PUT fails with 500
                            copy_attempted.set()
                            return await route.fulfill(status=500, content_type='application/json', body=json.dumps({'error': 'disk full'}))
                    await route.continue_()

                await pg.route('**/api/store/convs/*', fail_recovery)
                await pg.goto(base + '/#c=c_loss')
                await booted(pg)
                await soon(pg, "() => __digress.conv && __digress.conv.id === 'c_loss' && __digress.conv.rev >= 1")

                # Trigger unmergeable conflict: remote deleted u1 while local added a branch anchored on u1
                await pg.evaluate("""() => {
                  __digress.conv.threads.b_local = {id: 'b_local', parent: 'main', anchorMsg: 'u1', anchorText: 'hi', title: 'Local Branch', created: Date.now(), colorIdx: 1};
                  __digress.conv.order.b_local = ['u_local'];
                  __digress.conv.msgs.u_local = {id: 'u_local', thread: 'b_local', role: 'user', content: 'LOCAL FOLLOWUP', ts: Date.now()};
                  const t = document.getElementById('cTitle');
                  t.textContent = 'My Local Work';
                  t.dispatchEvent(new Event('blur'));
                }""")
                await asyncio.wait_for(copy_attempted.wait(), timeout=10)
                await settle(pg, 300)
                st1 = await pg.evaluate("() => ({id: __digress.conv.id, title: __digress.conv.title, hasLocal: !!__digress.conv.msgs.u_local})")
                check('failed recovery copy on unmergeable 409 keeps local conversation intact',
                      st1['id'] == 'c_loss' and st1['title'] == 'My Local Work' and st1['hasLocal'],
                      st1)

                # Now test 410 deletedElsewhere when recovery copy fails
                mode['kind'] = 'deleted'
                copy_attempted.clear()
                await pg.evaluate("""() => {
                  __digress.conv.msgs.u2 = {id: 'u2', thread: 'main', role: 'user', content: 'Unsaved local msg', ts: Date.now()};
                  __digress.conv.order.main.push('u2');
                  const t = document.getElementById('cTitle');
                  t.textContent = 'My Local Work 2';
                  t.dispatchEvent(new Event('blur'));
                }""")
                await asyncio.wait_for(copy_attempted.wait(), timeout=10)
                await settle(pg, 300)
                st2 = await pg.evaluate("() => ({id: __digress.conv.id, title: __digress.conv.title, hasU2: !!__digress.conv.msgs.u2})")
                check('failed recovery copy on 410 remote deletion keeps local conversation open instead of blank',
                      st2['id'] == 'c_loss' and st2['title'] == 'My Local Work 2' and st2['hasU2'],
                      st2)
                check('no page errors in failed recovery copy test', not errs, errs[:3])
                await b.close()
        finally:
            proc.terminate()


async def main():
    test_run_persists_before_expiry()
    test_gemini_default_and_unknown_model()
    await test_browser_isolation_and_titles()
    await test_failed_recovery_copy_keeps_local_work()
    if fails:
        print('FAILED:', fails)
        sys.exit(1)
    print('ALL PASSED')


if __name__ == '__main__':
    asyncio.run(main())
