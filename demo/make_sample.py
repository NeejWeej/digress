"""Makes the demo's sample: demo/sample.pdf (from demo/sample/bayes.html) and demo/seed.json (the conversation a
visitor finds on their first visit).

The conversation isn't written by hand: this builds the demo site and uses it the way a visitor would (opens the
PDF, asks a suggested question, branches from a passage of the document and from a reply, carries a takeaway back,
turns flashcards on), then saves what the page stored. So the seed is always in the format the current page writes.
Its replies are the prepared ones in demo/replies.js.

Rerun it when the sample reading or the prepared replies change:
    .venv/bin/python demo/make_sample.py
"""
import asyncio, json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tests'))
from playwright.async_api import async_playwright
from common import launch_args, build_site, goto_site, booted, answered, soon, frames, PDF_DRAWN_JS

PDF = os.path.join(HERE, 'sample.pdf')
SEED = os.path.join(HERE, 'seed.json')

# select `phrase` in the PDF's text layer (it may run across several spans) and let go, as a reader would
SELECT_PDF = """([page, phrase]) => { const tl = document.querySelector(`.dpage[data-page="${page}"] .textLayer`); if (!tl) return 'no text layer';
  const w = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT), nodes = []; let all = '', n;
  while ((n = w.nextNode())) { nodes.push([n, all.length]); all += n.nodeValue; }
  const i = all.indexOf(phrase); if (i < 0) return 'not found';
  const at = (k) => { let best = nodes[0]; for (const x of nodes) if (x[1] <= k) best = x; return [best[0], k - best[1]]; };
  const r = document.createRange(); r.setStart(...at(i)); r.setEnd(...at(i + phrase.length));
  const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); return 'ok'; }"""
PAGES = "()=>[...document.querySelectorAll('.dpage .textLayer')].map(t=>t.textContent.replace(/\\s+/g,' ').slice(0,90))"
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


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())

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
            await goto_site(pg, site); await booted(pg)
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

            must(await pg.evaluate(SELECT_REPLY, ['main', 'likelihood ratio']) == 'ok', '"likelihood ratio" not in the overview')
            await pg.locator('#pop.show').wait_for()
            await pg.locator('#popIn').fill('Why is the odds form easier?'); await answered(pg, pg.locator('#popIn').press('Enter'))

            await pg.locator('.pane[data-tid=main] [data-act=cards]').click(); await pg.locator('#cardsModal.show').wait_for()
            await pg.locator('[data-kact=on]').click(); await soon(pg, "()=>/new/.test(document.querySelector('[data-kact=make]').textContent)")
            await pg.locator('[data-kact=make]').click()
            await soon(pg, "()=>document.querySelector('[data-kact=make]').textContent.includes('Up to date')", timeout=20000)
            await pg.keyboard.press('Escape'); await frames(pg)
            # leave the document, the main thread and the first branch open; the second is a click away (its chip)
            await pg.locator('.pane:not([data-tid=main]):not([data-tid=doc])').last.locator('.ph [data-act=close]').click(); await frames(pg)
            await pg.locator('.pane[data-tid=main] .pb').evaluate('e=>e.scrollTop=0'); await frames(pg)
            await soon(pg, "()=>__digress.sync.sent&&!document.querySelector('#status').textContent.includes('Saving')")
            await pg.wait_for_timeout(800)   # (deliberate: let the last saves and the layout land)

            store = await pg.evaluate(DUMP)
            convs = {k: v for k, v in store.items() if k.startswith('convs/')}
            must(len(convs) == 1, f'expected one conversation, got {len(convs)}')
            conv = next(iter(convs.values()))
            must(conv.get('doc', {}).get('assetId'), 'the conversation has no document file')
            print('conversation:', conv['title'], '|', len(conv['threads']), 'threads,', len(conv['msgs']), 'messages |',
                  sum(k.startswith('cards/') for k in store), 'cards |', sum(k.startswith('index/') for k in store), 'index entries')
            must(not errs, f'page errors: {errs[:3]}')
            seed = {'v': conv['id'] + '.' + str(conv['rev']), 'store': store, 'files': {conv['doc']['assetId']: {'type': 'application/pdf', 'src': 'demo/sample.pdf'}}}
            with open(SEED, 'w') as f: json.dump(seed, f, ensure_ascii=False, separators=(',', ':'))
            print('wrote', SEED, os.path.getsize(SEED), 'bytes')
        await b.close()

asyncio.run(main())
