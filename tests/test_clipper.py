"""Browser clipper handoff (#clip / window.postMessage), CLIP branches, and extension URL rule matching.
  - extension/rules.js matches hostnames, wildcard subdomains, URL prefixes, and fallbacks.
  - Clipping as a branch into a named conversation creates it on first clip, reuses it on subsequent clips,
    attaches clipped images, renders a safe origin card (rejecting javascript: URLs), and isolates each clip's
    model context from main and sibling clips.
  - Clipping a full HTML page in mode='doc' runs Readability and opens a new document conversation.
Asserts and exits non-zero."""
import asyncio, json, os, subprocess, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, soon, frames, settle

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

# 1x1 red PNG
TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

FAKE_LLM = """window.__calls = [];
window.fakeLLM = {
  use: async (name) => name === 'sample' ? async (messages, opts) => {
    window.__calls.push(messages);
    const reply = 'Got it.';
    if (opts && opts.onToken) opts.onToken(reply);
    return { text: reply };
  } : null
};"""

def test_rules_node():
    js = r"""
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ctx = { URL }; vm.createContext(ctx);
vm.runInContext(readFileSync('./extension/rules.js', 'utf8'), ctx);
const R = ctx.DigressRules;
const cfg = {
  digressUrl: 'https://box.tailnet.ts.net/',
  rules: [
    { pattern: 'x.com/i/lists/42', mode: 'branch', convTitle: 'ML list', focus: false },
    { pattern: 'x.com', mode: 'branch', convTitle: 'Twitter clippings', focus: false },
    { pattern: '*.substack.com', mode: 'doc', convTitle: '', focus: true },
  ],
  fallback: { mode: 'doc', convTitle: '', focus: true },
};
const out = {
  norm1: R.normalizeDigressUrl('box.tailnet.ts.net/'),
  norm2: R.normalizeDigressUrl('http://127.0.0.1:8788///'),
  list: R.matchRule('https://x.com/i/lists/42/members', cfg),
  tweet: R.matchRule('https://www.x.com/alice/status/123', cfg),
  sub: R.matchRule('https://example.substack.com/p/hello', cfg),
  other: R.matchRule('https://arxiv.org/abs/1706.03762', cfg),
  mergedDef: R.mergeSettings({}),
  mergedCust: R.mergeSettings({ xThreadMode: 'thread', showToast: false }),
};
console.log(JSON.stringify(out));
"""
    r = subprocess.run(['node', '--input-type=module', '-e', js], cwd=REPO, capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    check('normalizeDigressUrl adds https and strips trailing slashes',
          d['norm1'] == 'https://box.tailnet.ts.net' and d['norm2'] == 'http://127.0.0.1:8788', d)
    check('URL prefix rule beats broader hostname rule', d['list']['convTitle'] == 'ML list' and d['list']['focus'] is False, d['list'])
    check('hostname rule matches www.x.com', d['tweet']['mode'] == 'branch' and d['tweet']['convTitle'] == 'Twitter clippings', d['tweet'])
    check('wildcard subdomain rule matches *.substack.com', d['sub']['mode'] == 'doc' and d['sub']['pattern'] == '*.substack.com', d['sub'])
    check('unmatched URL uses fallback rule', d['other']['mode'] == 'doc' and d['other']['pattern'] == '*', d['other'])
    check('mergeSettings provides xThreadMode and showToast defaults and overrides',
          d['mergedDef']['xThreadMode'] == 'single' and d['mergedDef']['showToast'] is True
          and d['mergedCust']['xThreadMode'] == 'thread' and d['mergedCust']['showToast'] is False, d['mergedCust'])

async def post_clip(pg, payload):
    return await pg.evaluate("""(payload) => new Promise((resolve) => {
      const id = 't-' + Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source === window && e.data && e.data.digressClipAck === 1 && e.data.id === id) {
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        }
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ digressClip: 1, id, payload }, location.origin);
    })""", payload)

async def post_query(pg, conv_id=''):
    return await pg.evaluate("""(convId) => new Promise((resolve) => {
      const id = 'q-' + Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source === window && e.data && e.data.digressClipQueryAck === 1 && e.data.id === id) {
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        }
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ digressClipQuery: 1, id, convId }, location.origin);
    })""", conv_id)

async def post_focus(pg, conv_id, thread_id=''):
    return await pg.evaluate("""({ convId, threadId }) => new Promise((resolve) => {
      const id = 'f-' + Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source === window && e.data && e.data.digressClipFocusAck === 1 && e.data.id === id) {
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        }
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ digressClipFocus: 1, id, convId, threadId }, location.origin);
    })""", {'convId': conv_id, 'threadId': thread_id})

async def main():
    test_rules_node()
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 850})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE_LLM)
        await goto_app(pg); await booted(pg)

        # 1. Clip first tweet as a branch into "Twitter clippings" (auto-creates conversation)
        ack1 = await post_clip(pg, {
            'mode': 'branch', 'convTitle': 'Twitter clippings',
            'title': '@alice on X', 'url': 'https://x.com/alice/status/1',
            'text': 'First spicy take about attention sinks.',
            'images': [{'data': TINY_PNG, 'type': 'image/png'}],
        })
        check('first clip acks ok and creates a CLIP branch', ack1.get('ok') and ack1.get('threadId', '').startswith('t'), ack1)
        cid = ack1['convId']; tid1 = ack1['threadId']
        t1 = await pg.evaluate("id => __digress.conv.threads[id]", tid1)
        check('CLIP branch has expected anchor fields and stored image',
              t1 and t1['anchorMsg'] == 'CLIP' and t1['parent'] == 'main' and len(t1.get('anchorImages') or []) == 1, t1)
        check('conversation passes ThreadOps.check', await pg.evaluate("ThreadOps.check(__digress.conv)").__await__() if False else len(await pg.evaluate("ThreadOps.check(__digress.conv)")) == 0)

        # Origin card shows clickable source link, quote, and image thumbnail
        origin_info = await pg.evaluate("""(tid) => {
          const p = document.querySelector(`.pane[data-tid="${tid}"] .origin`);
          if (!p) return null;
          const a = p.querySelector('a.clink');
          return { text: p.textContent, href: a ? a.getAttribute('href') : null, imgs: p.querySelectorAll('.oimg img').length };
        }""", tid1)
        check('origin card shows source link, quote text, and clipped image',
              origin_info and origin_info['href'] == 'https://x.com/alice/status/1' and 'attention sinks' in origin_info['text'] and origin_info['imgs'] == 1, origin_info)

        # Ask in branch 1 -> model receives clipped text + image
        await pg.locator(f'.pane[data-tid="{tid1}"] textarea').fill('Is this true?')
        await pg.locator(f'.pane[data-tid="{tid1}"] textarea').press('Enter')
        await soon(pg, "() => window.__calls.length === 1")
        call1 = await pg.evaluate("window.__calls[0]")
        c1_str = json.dumps(call1)
        check('model receives clipped text and image in branch 1',
              'attention sinks' in c1_str and ('"type": "image"' in c1_str or '[image]' in c1_str), c1_str[-300:])

        # 2. Clip second tweet into "Twitter clippings" -> reuses same conversation, isolated context, rejects javascript: URL
        ack2 = await post_clip(pg, {
            'mode': 'branch', 'convTitle': 'Twitter clippings',
            'title': '@bob on X', 'url': 'javascript:alert(1)',
            'text': 'Second unrelated post about KV cache quantization.',
        })
        check('second clip reuses the same conversation', ack2.get('ok') and ack2.get('convId') == cid and ack2.get('threadId') != tid1, ack2)
        tid2 = ack2['threadId']
        bad_href = await pg.evaluate("(tid) => !!document.querySelector(`.pane[data-tid=\"${tid}\"] .origin a.clink`)", tid2)
        check('javascript: URL is rejected and not rendered as a link', not bad_href)

        await pg.locator(f'.pane[data-tid="{tid2}"] textarea').fill('Explain KV quant.')
        await pg.locator(f'.pane[data-tid="{tid2}"] textarea').press('Enter')
        await soon(pg, "() => window.__calls.length === 2")
        c2_str = json.dumps(await pg.evaluate("window.__calls[1]"))
        check('branch 2 sees only its own tweet (not branch 1)',
              'KV cache quantization' in c2_str and 'attention sinks' not in c2_str, c2_str[:250])

        # 3. Clip a full HTML page as a new document conversation
        body_p = ' '.join(['Branching conversations let learners follow tangents without losing the main thread.'] * 12)
        ack3 = await post_clip(pg, {
            'mode': 'doc', 'title': 'Paywalled Article', 'url': 'https://example.com/post',
            'html': f'<!doctype html><html><head><title>Paywalled Article</title></head><body><article><h1>Paywalled Article</h1><p>{body_p}</p><p>Second paragraph discussing paywalled articles and local-first learning tools in detail.</p></article></body></html>',
        })
        check('doc clip creates a new document conversation', ack3.get('ok') and ack3.get('convId') != cid, ack3)
        await soon(pg, "() => !!document.querySelector('.docpane .docbody')")
        doc_info = await pg.evaluate("() => ({ source: (__digress.conv.doc||{}).source, text: document.querySelector('.docpane .docbody').textContent })")
        check('doc clip runs Readability and preserves source URL',
              doc_info['source'] == 'https://example.com/post' and 'paywalled article' in doc_info['text'].lower(), doc_info)

        # 4. Query conversations and branches from another conversation without switching away
        q1 = await post_query(pg, cid)
        check('digressClipQuery returns conversations and branches for requested convId',
              q1.get('ok') and len(q1.get('conversations') or []) >= 2
              and any(b['id'] == tid1 for b in (q1.get('branches') or [])), q1)

        # 5. Clip with custom branchTitle + convId + HTML-only body in branch mode
        ack4 = await post_clip(pg, {
            'mode': 'branch', 'convId': cid, 'branchTitle': 'Custom Reading Note',
            'title': 'Ignored Auto Title', 'url': 'https://example.com/branch-html',
            'html': f'<!doctype html><html><body><article><h1>HTML Branch</h1><p>{body_p}</p></article></body></html>',
        })
        tid4 = ack4.get('threadId')
        t4 = await pg.evaluate("id => __digress.conv.threads[id]", tid4)
        check('branch clip honors custom branchTitle, convId, and HTML fallback',
              ack4.get('ok') and ack4.get('convId') == cid and t4
              and t4.get('title') == 'Custom Reading Note' and t4.get('titleKept') is True
              and 'branching conversations' in (t4.get('anchorText') or '').lower(), t4)

        # 6. Clip into an existing branch (targetThreadId) -> populates composer with quote + question
        ack5 = await post_clip(pg, {
            'mode': 'branch', 'convId': cid, 'targetThreadId': tid1,
            'title': '@carol on X', 'url': 'https://x.com/carol/status/9',
            'text': 'Follow-up counterargument.', 'question': 'How does this compare?',
        })
        ta_val = await pg.evaluate("(tid) => (document.querySelector(`.pane[data-tid=\"${tid}\"] textarea`) || {}).value || ''", tid1)
        check('targetThreadId pre-fills existing branch composer with clip and question',
              ack5.get('ok') and ack5.get('threadId') == tid1
              and 'Follow-up counterargument.' in ta_val and 'How does this compare?' in ta_val, ta_val)

        # 7. digressClipFocus switches conversation and reveals target branch
        f1 = await post_focus(pg, ack3['convId'], 'main')
        cur_cid = await pg.evaluate("__digress.conv.id")
        check('digressClipFocus switches to requested conversation', f1.get('ok') and cur_cid == ack3['convId'], cur_cid)
        check('conversation still passes ThreadOps.check', len(await pg.evaluate("ThreadOps.check(__digress.conv)")) == 0)

        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
