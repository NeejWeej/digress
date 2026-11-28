"""Makes the demo's sample: demo/sample.pdf (from demo/sample/bayes.html) and demo/seed.json (the conversation a
visitor finds on their first visit: the reading, and a conversation without a document).

The conversation isn't written by hand: this builds the demo site and uses it the way a visitor would (opens the
PDF, asks a suggested question, branches from a passage of the document and from a reply, carries a takeaway back;
and a plain conversation with a branch of a branch), then saves what the page stored. Flashcards stay off, as they
are by default. So the seed is always in the format the current page writes.
Its replies are the prepared ones in demo/replies.js.

Rerun it when the sample reading or the prepared replies change:
    .venv/bin/python demo/make_sample.py

The two takeaways in it are a real model's, not written by hand: --record [URL] builds the conversations once to
catch the page's own takeaway requests, sends them to the Digress server at URL (default http://127.0.0.1:8788,
with --model ID or else its default model; the document tools left out), keeps the answers in demo/sample/takeaways.json (with the
model and the date), and then builds the seed with them. Without --record it uses that file as it is. Rerun with
--record when the prepared replies of those branches change, since a takeaway sums up what they say.
"""
import asyncio, json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tests'))
from playwright.async_api import async_playwright
from common import launch_args, build_site, goto_site, booted, answered, soon, frames, PDF_DRAWN_JS

PDF = os.path.join(HERE, 'sample.pdf')
TAKEAWAYS = os.path.join(HERE, 'sample', 'takeaways.json')
# a phrase of each takeaway's branch question (replies.js finds the recorded takeaway by it)
TAKEAWAY_KEYS = ['agree on a secret while everyone is listening', 'small false-positive rate matter']
SEED = os.path.join(HERE, 'seed.json')

# select `phrase` in the PDF's text layer (it may run across several spans) and let go, as a reader would
SELECT_PDF = """([page, phrase]) => { const tl = document.querySelector(`.dpage[data-page="${page}"] .textLayer`); if (!tl) return 'no text layer';
  const w = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT), nodes = []; let all = '', n;
  while ((n = w.nextNode())) { nodes.push([n, all.length]); all += n.nodeValue; }
  const i = all.indexOf(phrase); if (i < 0) return 'not found';
  const at = (k) => { let best = nodes[0]; for (const x of nodes) if (x[1] <= k) best = x; return [best[0], k - best[1]]; };
  const r = document.createRange(); r.setStart(...at(i)); r.setEnd(...at(i + phrase.length));
  const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); return 'ok'; }"""
# Figure 1 on p. 1, on screen: from its top label ("1,000 people", alone in its span) to the end of its caption, padded
FIGURE = """() => { const spans=[...document.querySelectorAll('.pane[data-tid=doc] .dpage[data-page="1"] .textLayer span')];
  const a=spans.find(s=>s.textContent.trim()==='1,000 people'), z=spans.find(s=>s.textContent.includes('outlined in red'));
  if(!a||!z) return null; const p=document.querySelector('.pane[data-tid=doc] .dpage[data-page="1"]').getBoundingClientRect();
  const ra=a.getBoundingClientRect(), rz=z.getBoundingClientRect(), pad=p.width*0.03;
  return {left:p.left+p.width*0.12, right:p.right-p.width*0.12, top:ra.top-pad, bottom:rz.bottom+pad}; }"""
PAGES ="()=>[...document.querySelectorAll('.dpage .textLayer')].map(t=>t.textContent.replace(/\\s+/g,' ').slice(0,90))"
SELECT_REPLY = """([tid, phrase]) => { const body = document.querySelector(`.pane[data-tid="${tid}"] .msg.assistant .body`);
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.nodeValue.indexOf(phrase);
  if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + phrase.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); return 'ok'; } } return 'not found'; }"""
DUMP = """async () => { const db = await new Promise((ok, no) => { const r = indexedDB.open('digress-demo', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const t = db.transaction('kv'), s = t.objectStore('kv');
  const get = (q) => new Promise((ok) => { q.onsuccess = () => ok(q.result); });
  const [ks, vs] = await Promise.all([get(s.getAllKeys()), get(s.getAll())]);
  const out = {}; ks.forEach((k, i) => { if (!k.startsWith('file/') && !k.startsWith('seeded')) out[k] = vs[i]; }); return out; }"""


def must(ok, what):
    if not ok: sys.exit('make_sample: ' + what)


def record(url, bodies, model_id='auto'):
    """Send each takeaway request the page made to a real Digress server; its answers, with the model."""
    import urllib.request, datetime
    out = {}
    for k in TAKEAWAY_KEYS:
        must(k in bodies, f'no takeaway request caught for "{k}"')
        body = dict(bodies[k]); body.pop('tools', None); body['model'] = model_id; body['chat'] = 'seed-takeaway-' + os.urandom(4).hex()
        req = urllib.request.Request(url.rstrip('/') + '/api/chat', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
        text, model = '', ''
        with urllib.request.urlopen(req, timeout=300) as r:
            for line in r:
                if not line.strip(): continue
                o = json.loads(line)
                if 'error' in o: sys.exit('make_sample: the model answered with an error: ' + str(o['error']))
                text += o.get('d', '') or ''
                if o.get('done'): model = o.get('model', '')
        must(text.strip(), f'empty takeaway for "{k}"')
        out[k] = {'text': text.strip(), 'model': model, 'recorded': datetime.date.today().isoformat()}
        print(f'recorded ({model}):', k, '\n' + text.strip())
    return out


async def main():
    rec = '--record' in sys.argv
    url = next((a for a in sys.argv[sys.argv.index('--record') + 1:][:1] if not a.startswith('-')), 'http://127.0.0.1:8788') if rec else None
    model_id = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'auto'
    takeaways = {} if rec else json.load(open(TAKEAWAYS))
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        if rec:
            bodies = await build(b, {k: {} for k in TAKEAWAY_KEYS}, True)
            takeaways = record(url, bodies, model_id)
            with open(TAKEAWAYS, 'w') as f: json.dump(takeaways, f, ensure_ascii=False, indent=1); f.write('\n')
            print('wrote', TAKEAWAYS)
        await build(b, takeaways, False)
        await b.close()


async def build(b, takeaways, recording):
    if True:

        # 1. the reading, printed to PDF (its <title> becomes the PDF's title, which names the conversation)
        pg = await b.new_page()
        await pg.goto('file://' + os.path.join(HERE, 'sample', 'bayes.html'))
        await pg.pdf(path=PDF, format='Letter', prefer_css_page_size=True)
        await pg.close()
        print('wrote', PDF, os.path.getsize(PDF), 'bytes')

        # 2. the conversation, made in the demo site itself (from an empty seed)
        with open(SEED, 'w') as f: json.dump({'v': 0, 'store': {}, 'files': {}}, f)
        with tempfile.TemporaryDirectory() as site:
            build_site(site)
            pg = await b.new_page(viewport={'width': 1500, 'height': 900})
            errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.add_init_script(f'window.__seedTakeaways={json.dumps(takeaways)};window.__seedRecord={json.dumps(recording)};')
            await goto_site(pg, site); await booted(pg)

            # a conversation without a document: a question, a branch with a takeaway, and a branch of a branch
            ta = pg.locator('.pane[data-tid=main] textarea')
            await ta.fill('How does HTTPS keep my connection private?'); await answered(pg, ta.press('Enter'))
            must(await pg.evaluate(SELECT_REPLY, ['main', 'key exchange']) == 'ok', '"key exchange" not in the HTTPS reply')
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill('How can two strangers agree on a secret while everyone is listening?'); await answered(pg, pg.locator('#popIn').press('Enter'))
            dh = pg.locator('.pane:not([data-tid=main])').last
            await dh.locator('.ph [data-act=take]').click(); await answered(pg, dh.locator('.tk .go').click())
            await dh.locator('.ph [data-act=close]').click(); await frames(pg)
            must(await pg.evaluate(SELECT_REPLY, ['main', 'certificate']) == 'ok', '"certificate" not in the HTTPS reply')
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill('What stops someone in the middle from pretending to be the server?'); await answered(pg, pg.locator('#popIn').press('Enter'))
            cert = await pg.evaluate("Object.values(__digress.conv.msgs).find(m=>m.role==='user'&&/pretending to be the server/.test(m.text||m.content||'')).thread")
            must(await pg.evaluate(SELECT_REPLY, [cert, 'certificate authority']) == 'ok', '"certificate authority" not in the certificate reply')
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill('Who checks the certificate authorities?'); await answered(pg, pg.locator('#popIn').press('Enter'))
            for t in await pg.evaluate("[...document.querySelectorAll('#panes .pane')].map(p=>p.dataset.tid)"):
                await pg.locator(f'.pane[data-tid="{t}"] .pb').evaluate('e=>e.scrollTop=0')
            await soon(pg, "()=>__digress.sync.sent&&!document.querySelector('#status').textContent.includes('Saving')")

            # the reading (opened last, so it's the conversation a visitor sees first)
            await pg.locator('#newDoc').click()   # under the reading's name (the document pane shows the file's name)
            await pg.set_input_files('#docFile', files=[{'name': 'Bayes’ Rule and the Base-Rate Fallacy.pdf', 'mimeType': 'application/pdf', 'buffer': open(PDF, 'rb').read()}])
            await pg.locator('#docGo').click(); await pg.wait_for_function(PDF_DRAWN_JS)
            await soon(pg, "()=>__digress.conv.title.startsWith('Bayes')", timeout=10000)
            for i, t in enumerate(await pg.evaluate(PAGES), 1): print(f'  p. {i}: {t}…')   # check the [p. N] in replies.js against these

            await answered(pg, pg.locator('.pane[data-tid=main] .chip[data-ask^="Give me an overview"]').click())
            must(await pg.evaluate(SELECT_PDF, [1, 'wrongly flags 9% of healthy people']) == 'ok', 'passage on p. 1 not found')
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill('Why does such a small false-positive rate matter so much?'); await answered(pg, pg.locator('#popIn').press('Enter'))
            br = pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last
            await br.locator('.ph [data-act=take]').click(); await answered(pg, br.locator('.tk .go').click())
            # …and a question after the takeaway, so the branch shows where the takeaway's knowledge ends
            await br.locator('textarea').fill('What if the false-positive rate were 1% instead?'); await answered(pg, br.locator('textarea').press('Enter'))
            must(await br.locator('.tkcut').count() == 1, 'the branch shows no divider where its takeaway ends')

            # a snip: a box drawn around Figure 1 (from its top label to the end of its caption), asked about as a picture
            fig = await pg.evaluate(FIGURE)
            must(fig, 'Figure 1 not found on p. 1')
            await pg.evaluate(f"(()=>{{const pb=document.querySelector('.pane[data-tid=doc] .pb');pb.scrollTop+={fig['top']}-pb.getBoundingClientRect().top-80}})()"); await frames(pg, 3)
            fig = await pg.evaluate(FIGURE)
            await pg.locator('.pane[data-tid=doc] [data-act=snip]').click(); await frames(pg)
            await pg.mouse.move(fig['left'], fig['top']); await pg.mouse.down(); await pg.mouse.move(fig['right'], fig['bottom'], steps=10); await pg.mouse.up()
            await soon(pg, "()=>{const i=document.querySelector('#pop.show .pimg');return i&&i.complete&&i.naturalWidth>200}")
            await pg.locator('#popIn').fill('How do I read this tree?'); await answered(pg, pg.locator('#popIn').press('Enter'))
            snip = await pg.evaluate("Object.values(__digress.conv.threads).find(t=>t.anchorRegion).id")
            await pg.locator(f'.pane[data-tid="{snip}"] .ph [data-act=close]').click(); await frames(pg)

            must(await pg.evaluate(SELECT_REPLY, ['main', 'likelihood ratio']) == 'ok', '"likelihood ratio" not in the overview')
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill('Why is the odds form easier?'); await answered(pg, pg.locator('#popIn').press('Enter'))

            # flashcards stay off, as they are unless you turn them on (the prepared cards are there for anyone who does)
            # leave the document, the main thread and the first branch open; the second is a click away (its chip)
            await pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last.locator('.ph [data-act=close]').click(); await frames(pg)
            await pg.locator('.pane[data-tid=main] .pb').evaluate('e=>e.scrollTop=0'); await frames(pg)
            await soon(pg, "()=>__digress.sync.sent&&!document.querySelector('#status').textContent.includes('Saving')")
            await pg.wait_for_timeout(800)   # (deliberate: let the last saves and the layout land)

            if recording: return await pg.evaluate('window.__takeawayBodies||{}')
            store = await pg.evaluate(DUMP)
            notes = [m['content'] for v in store.values() if isinstance(v, dict) and v.get('msgs') for m in v['msgs'].values() if m.get('role') == 'note']
            for k, t in takeaways.items(): must(t['text'] in notes, f'the recorded takeaway for "{k}" is not in the seed')
            convs = {k: v for k, v in store.items() if k.startswith('convs/')}
            must(len(convs) == 2, f'expected two conversations, got {len(convs)}')
            for c in convs.values(): print('conversation:', c['title'], '|', len(c['threads']), 'threads,', len(c['msgs']), 'messages')
            print(sum(k.startswith('cards/') for k in store), 'cards |', sum(k.startswith('index/') for k in store), 'index entries')
            conv = next(c for c in convs.values() if c.get('doc'))
            must(conv['doc'].get('assetId'), 'the reading has no document file')
            must(not errs, f'page errors: {errs[:3]}')
            v = '.'.join(f"{c['id']}.{c['rev']}" for c in sorted(convs.values(), key=lambda c: c['id']))
            seed = {'v': v, 'store': store, 'files': {conv['doc']['assetId']: {'type': 'application/pdf', 'src': 'demo/sample.pdf'}}}
            with open(SEED, 'w') as f: json.dump(seed, f, ensure_ascii=False, separators=(',', ':'))
            print('wrote', SEED, os.path.getsize(SEED), 'bytes')

asyncio.run(main())
