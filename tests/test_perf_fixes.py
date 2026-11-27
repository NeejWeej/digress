"""Regression tests for performance & memory fixes:
  1. PDF eviction race + pixel budget: rapid fling-scrolling through a 24-page PDF cancels/discards
     evicted renders, never leaves untracked canvases in the DOM, and stays within the pixel budget.
  2. PDF text + outline cache: reopening a PDF with the same assetId loads extracted text from the
     browser-local IndexedDB cache (`docState.fromCache === true`) with identical page text.
  3. Streaming timer decoupling: the 1s elapsed-time tick updates `.live .lt` in place without
     re-running `renderRich` or replacing DOM nodes when `m.content` has not changed.
  4. Demo IndexedDB metadata projections: `meta/convs/*` and `meta/file/*` stay in sync across
     seed, PUT, PATCH, DELETE, file cleanup, and legacy migration without reading full convs or file bytes.
Asserts and exits non-zero."""
import asyncio, os, sys, tempfile
from playwright.async_api import async_playwright
from common import (
    launch_args, goto_app, booted, soon, settle, quiet,
    build_site, goto_site, PDF_DRAWN_JS,
)

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)


def make_multipage_pdf(path, num_pages=24):
    """Minimal valid N-page PDF written in pure Python."""
    objs = []
    # 1: Catalog, 2: Pages, 3: Font
    objs.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    kids = ' '.join(f'{4 + i * 2} 0 R' for i in range(num_pages))
    objs.append(f'<< /Type /Pages /Kids [{kids}] /Count {num_pages} >>'.encode())
    objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for i in range(num_pages):
        content = f'BT /F1 18 Tf 72 700 Td (Synthetic page {i + 1} marker_{i + 1:02d}) Tj ET'.encode()
        p_id = 4 + i * 2
        c_id = p_id + 1
        objs.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {c_id} 0 R >>'.encode())
        objs.append(f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'\nendstream')
    out = bytearray(b'%PDF-1.4\n')
    offs = [0]
    for idx, body in enumerate(objs, 1):
        offs.append(len(out))
        out.extend(f'{idx} 0 obj\n'.encode() + body + b'\nendobj\n')
    xref = len(out)
    out.extend(f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode())
    for o in offs[1:]:
        out.extend(f'{o:010d} 00000 n \n'.encode())
    out.extend(f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    open(path, 'wb').write(out)


FAKE_STREAM = r"""
window.__releaseStream = null;
window.fakeLLM = {
  use: async (n) => {
    if (n === 'sample') return async (input, opts) => {
      opts.onText && opts.onText({ text: 'First paragraph stays mounted.\n\nSecond paragraph.' });
      await new Promise((r) => { window.__releaseStream = r; });
      const final = 'First paragraph stays mounted.\n\nSecond paragraph.\n\nFinal line.';
      opts.onText && opts.onText({ text: final });
      return { text: final, truncated: false };
    };
    return null;
  }
};
"""


async def test_app_perf(p):
    with tempfile.TemporaryDirectory() as td:
        pdf_path = os.path.join(td, 'many.pdf')
        make_multipage_pdf(pdf_path, 24)
        b = await p.chromium.launch(**launch_args())
        ctx = await b.new_context(viewport={'width': 1280, 'height': 900}, device_scale_factor=2)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE_STREAM)
        await goto_app(pg)
        await booted(pg)

        # 1 & 2: Attach 24-page PDF, verify extraction & caching, then fling-scroll and check eviction
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', pdf_path)
        await pg.locator('#docGo').click()
        await soon(pg, "()=>__digress.docState && __digress.docState.loaded && __digress.docState.n === 24", timeout=15000)
        await pg.wait_for_function(PDF_DRAWN_JS)
        first_pages = await pg.evaluate("()=>__digress.docState.pages")
        check('PDF extracted all 24 pages on first open',
              len(first_pages) == 24 and 'marker_01' in first_pages[0] and 'marker_24' in first_pages[23],
              [len(first_pages), first_pages[0] if first_pages else ''])
        from_cache_first = await pg.evaluate("()=>!!__digress.docState.fromCache")
        check('first open extracted fresh (not from cache)', not from_cache_first)

        # Fling-scroll rapidly down through the 24-page PDF at 200% zoom to trigger both race and pixel budget
        await pg.locator('.pane[data-tid=doc] [data-act=zin]').click()
        await pg.locator('.pane[data-tid=doc] [data-act=zin]').click()
        await settle(pg, 300)
        await pg.evaluate("""async () => {
          const pb = document.querySelector('.pane[data-tid=doc] .pb');
          const max = pb.scrollHeight - pb.clientHeight;
          for (let step = 1; step <= 12; step++) {
            pb.scrollTop = Math.round(max * step / 12);
            await new Promise(r => setTimeout(r, 25));
          }
          pb.scrollTop = max;
        }""")
        await settle(pg, 500)
        # Wait for any in-flight renders to settle
        await soon(pg, "()=>document.querySelectorAll('.dpage[data-page=\"24\"] canvas').length === 1", timeout=10000)
        await settle(pg, 400)

        stats = await pg.evaluate("""() => {
          const canvases = [...document.querySelectorAll('.dpage canvas')];
          const domPages = canvases.map(c => +c.closest('.dpage').dataset.page);
          const tracked = [...__digress.docView.rendered.keys()];
          const untracked = domPages.filter(p => !__digress.docView.rendered.has(p));
          const totalPx = canvases.reduce((s, c) => s + c.width * c.height, 0);
          return { count: canvases.length, domPages, tracked, untracked, totalPx };
        }""")
        check('fling-scroll leaves no untracked canvas leak and bounds total pixels',
              not stats['untracked'] and stats['count'] <= 16 and stats['totalPx'] <= 36_000_000 and 24 in stats['domPages'],
              stats)

        # Scroll back to page 1 and verify it re-renders cleanly
        await pg.evaluate("()=>{document.querySelector('.pane[data-tid=doc] .pb').scrollTop = 0}")
        await soon(pg, "()=>document.querySelectorAll('.dpage[data-page=\"1\"] canvas').length === 1", timeout=10000)
        check('scrolling back to page 1 re-renders it after eviction',
              await pg.locator('.dpage[data-page="1"] canvas').count() == 1)

        # 2: Reload and verify PDF text + outline loaded from IndexedDB cache
        await quiet(pg)
        await pg.reload()
        await booted(pg)
        await soon(pg, "()=>__digress.docState && __digress.docState.loaded && __digress.docState.n === 24", timeout=15000)
        cached_info = await pg.evaluate("()=>({fromCache:!!__digress.docState.fromCache, pages:__digress.docState.pages})")
        check('reopening PDF loads extracted text from browser cache',
              cached_info['fromCache'] and cached_info['pages'] == first_pages,
              {'fromCache': cached_info['fromCache'], 'same': cached_info['pages'] == first_pages})

        # 3: Streaming timer does not re-render unchanged markdown body
        ta = pg.locator('.pane[data-tid=main] textarea')
        await ta.fill('Test streaming stability')
        await ta.press('Enter')
        await soon(pg, "()=>document.querySelector('.pane[data-tid=main] .msg.assistant .body p')?.textContent.includes('First paragraph')", timeout=10000)
        await pg.evaluate("()=>{window.__pRef = document.querySelector('.pane[data-tid=main] .msg.assistant .body p')}")
        # Deliberate wait across >2 1-second timer ticks while m.content is unchanged
        await pg.wait_for_timeout(2300)  # deliberate
        same_node = await pg.evaluate("()=>window.__pRef === document.querySelector('.pane[data-tid=main] .msg.assistant .body p')")
        check('1s streaming timer does not replace DOM when content is unchanged', same_node)

        await pg.evaluate("()=>window.__releaseStream && window.__releaseStream()")
        await soon(pg, "()=>!document.querySelector('.pane[data-tid=main] .msg.assistant.pending') && document.querySelector('.pane[data-tid=main] .msg.assistant .body')?.textContent.includes('Final line.')", timeout=10000)
        check('stream finishes cleanly with final content', True)
        check('no page errors in app perf tests', not errs, errs)
        await b.close()


async def test_demo_idb_meta(p):
    with tempfile.TemporaryDirectory() as site:
        build_site(site)
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await goto_site(pg, site)
        await booted(pg)
        await pg.wait_for_function(PDF_DRAWN_JS)

        # Verify meta/convs/*, meta/file/*, and metaV exist in digress-demo IDB
        keys = await pg.evaluate("""async () => {
          const d = await new Promise((ok, no) => { const r = indexedDB.open('digress-demo', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          const all = await new Promise((ok, no) => { const t = d.transaction('kv', 'readonly'); const r = t.objectStore('kv').getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          const mv = await new Promise((ok, no) => { const t = d.transaction('kv', 'readonly'); const r = t.objectStore('kv').get('metaV'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          return { all, mv };
        }""")
        meta_convs = [k for k in keys['all'] if k.startswith('meta/convs/')]
        meta_files = [k for k in keys['all'] if k.startswith('meta/file/')]
        check('demo IDB writes meta/convs/*, meta/file/*, and metaV',
              keys['mv'] == 1 and len(meta_convs) >= 2 and len(meta_files) >= 1,
              {'mv': keys['mv'], 'mc': meta_convs, 'mf': meta_files})

        # Verify ?meta response strips internal _refs and reflects PATCH immediately
        first_id = meta_convs[0].split('/', 2)[2]
        res = await pg.evaluate("""async (id) => {
          await fetch('api/store/convs/' + id, { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
          const list = await (await fetch('api/store/convs?meta=1')).json();
          const hit = list.find(x => x.id === id);
          return { pinned: hit && hit.data.pinned, hasRefs: hit && ('_refs' in hit.data) };
        }""", first_id)
        check('PATCH keeps meta/convs in sync and ?meta strips internal _refs',
              res['pinned'] is True and res['hasRefs'] is False, res)

        # Verify file cleanup sweeps an unreferenced expired file using meta/file/* and keeps referenced files
        sweep_res = await pg.evaluate("""async () => {
          const d = await new Promise((ok, no) => { const r = indexedDB.open('digress-demo', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          const oldId = 'deadbeefdeadbeefdeadbeefdeadbeef';
          await new Promise((ok, no) => {
            const t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv');
            s.put({ type: 'application/octet-stream', buf: new ArrayBuffer(16), at: 1 }, 'file/' + oldId);
            s.put({ type: 'application/octet-stream', at: 1 }, 'meta/file/' + oldId);
            t.oncomplete = ok; t.onerror = () => no(t.error);
          });
          // Create and delete a dummy conv to trigger sweepFiles()
          await fetch('api/store/convs/tmp_sweep', { method: 'PUT', body: JSON.stringify({ id: 'tmp_sweep', title: 'tmp', threads: {}, msgs: {}, order: {} }) });
          await fetch('api/store/convs/tmp_sweep', { method: 'DELETE' });
          const gone = await new Promise((ok, no) => {
            const t = d.transaction('kv', 'readonly'), s = t.objectStore('kv');
            let f, mf;
            s.get('file/' + oldId).onsuccess = (e) => { f = e.target.result; };
            s.get('meta/file/' + oldId).onsuccess = (e) => { mf = e.target.result; };
            t.oncomplete = () => ok({ f: !!f, mf: !!mf }); t.onerror = () => no(t.error);
          });
          const remainingFiles = await new Promise((ok, no) => {
            const t = d.transaction('kv', 'readonly');
            const r = t.objectStore('kv').getAllKeys(IDBKeyRange.bound('meta/file/', 'meta/file/\ufffd'));
            r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
          });
          return { gone, remainingFiles };
        }""")
        check('sweepFiles deletes expired unused file + meta/file and keeps referenced files',
              not sweep_res['gone']['f'] and not sweep_res['gone']['mf'] and len(sweep_res['remainingFiles']) >= 1,
              sweep_res)

        # Verify legacy upgrade backfill: wipe meta/* and metaV, reload, confirm rebuilt
        await pg.evaluate("""async () => {
          const d = await new Promise((ok, no) => { const r = indexedDB.open('digress-demo', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          await new Promise((ok, no) => {
            const t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv');
            s.delete('metaV');
            s.delete(IDBKeyRange.bound('meta/', 'meta/\ufffd'));
            t.oncomplete = ok; t.onerror = () => no(t.error);
          });
        }""")
        await quiet(pg)
        await pg.reload()
        await booted(pg)
        rebuilt = await pg.evaluate("""async () => {
          const d = await new Promise((ok, no) => { const r = indexedDB.open('digress-demo', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          const mc = await new Promise((ok, no) => { const r = d.transaction('kv', 'readonly').objectStore('kv').getAllKeys(IDBKeyRange.bound('meta/convs/', 'meta/convs/\ufffd')); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          const mf = await new Promise((ok, no) => { const r = d.transaction('kv', 'readonly').objectStore('kv').getAllKeys(IDBKeyRange.bound('meta/file/', 'meta/file/\ufffd')); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          return { mc: mc.length, mf: mf.length };
        }""")
        check('legacy IDB without metaV backfills meta/convs and meta/file on reload',
              rebuilt['mc'] >= 2 and rebuilt['mf'] >= 1, rebuilt)
        check('no page errors in demo IDB tests', not errs, errs)
        await b.close()


async def main():
    async with async_playwright() as p:
        await test_app_perf(p)
        await test_demo_idb_meta(p)
    if fails:
        print('FAILED:', fails)
        sys.exit(1)
    print('ALL PASSED')


if __name__ == '__main__':
    asyncio.run(main())
