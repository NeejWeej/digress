"""The demo's seed: a newer sample replaces the old one's conversations, but never deletes its files. A conversation
kept from the old sample (the copy a tab that had it open saves when the sample goes) still opens its PDF.
Asserts and exits non-zero."""
import asyncio, json, os, sys, tempfile
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(__file__))
from common import PDF_DRAWN_JS, booted, build_site, goto_site, launch_args, quiet, saved, soon

fails = []
def check(ok, what, detail=''):
    print(('ok   ' if ok else 'FAIL ') + what, '' if ok else str(detail)[:400])
    if not ok: fails.append(what)

FILE = "id => fetch('api/files/' + id).then(r => r.status)"


async def main():
    with tempfile.TemporaryDirectory() as site:
        build_site(site)
        seed_path = os.path.join(site, 'demo', 'seed.json'); seed = json.load(open(seed_path))
        old_id = next(iter(seed['files']))
        async with async_playwright() as p:
            b = await p.chromium.launch(**launch_args())
            pg = await b.new_page(viewport={'width': 1400, 'height': 900})
            errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
            await goto_site(pg, site); await booted(pg); await pg.wait_for_function(PDF_DRAWN_JS); await saved(pg)
            check(await pg.evaluate(FILE, old_id) == 200, 'the installed seed has its PDF')

            # a conversation of its own that uses the sample's PDF (like a recovery copy)
            rid = 'recovered1'
            await pg.evaluate("""async ([id, asset]) => {
              const c = JSON.parse(JSON.stringify(__digress.conv)); c.id = id; c.title = 'Kept from the old sample'; delete c.folder; delete c.rev; c.doc = {...c.doc, assetId: asset};
              const r = await fetch('api/store/convs/' + id, { method: 'PUT', body: JSON.stringify(c) }); if (!r.ok) throw new Error('put ' + r.status) }""", [rid, old_id])

            # a newer seed whose sample has another PDF id and title
            new_id = 'f' * 32
            seed['v'] += '-newer'
            seed = json.loads(json.dumps(seed).replace(old_id, new_id))   # the PDF's id is in the files, the conversations and their metadata
            for k, v in seed['store'].items():
                if k.startswith('convs/') and v.get('doc'): v['title'] = 'Newer sample'
            json.dump(seed, open(seed_path, 'w'))
            sid = next(k[6:] for k, v in seed['store'].items() if k.startswith('convs/') and v.get('doc'))
            await quiet(pg); await pg.reload(); await booted(pg)
            check(await soon(pg, "id => fetch('api/store/convs/' + id).then(r => r.json()).then(c => c.title === 'Newer sample')", sid, timeout=20000), 'the sample is the new one')
            st = await pg.evaluate(FILE, new_id); check(st == 200, '…with its own PDF', st)
            check(await pg.evaluate(FILE, old_id) == 200, 'the old sample’s PDF is still there, since a conversation uses it', await pg.evaluate(FILE, old_id))
            await pg.locator(f'#side [data-conv="{rid}"]').first.click()
            await soon(pg, "id=>__digress.conv&&__digress.conv.id===id", rid)
            drawn = await soon(pg, "()=>" + PDF_DRAWN_JS, timeout=20000)
            check(drawn and 'Not found' not in await pg.inner_text('body'), 'the conversation kept from the old sample still opens its PDF', await pg.evaluate("document.querySelector('#toast')?.textContent"))
            await quiet(pg); await pg.close(); await b.close()
            check(not errs, 'no page errors', errs[:3])
    print('\n' + (f'{len(fails)} failed: {fails}' if fails else 'all passed'))
    sys.exit(1 if fails else 0)


asyncio.run(main())
