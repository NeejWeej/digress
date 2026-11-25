"""A passage selected across a PDF page break (the end of one page and the start of the next) opens the branch
popup like any other. The branch keeps where it ends (`anchorEnd`), both pages show the highlight (the marker
only where it starts), the model is told it's from pp. 1–2 with the whole passage, and deleting the branch
clears the highlight from both pages.
A second, generated document has things in the text layer's order that aren't in the reading order: on page 1 a callout
printed near the top that comes after the body in the file, and a footer; on page 2 a running header before the body.
A selection from page 1's body to the middle of page 2's first line quotes only the body (lines joined with a space,
not glued), keeps where page 2's part starts (anchorEnd.s), and highlights neither the callout, the footer nor the header.
Asserts and exits non-zero."""
import asyncio, os, sys, tempfile
from playwright.async_api import async_playwright
from common import FIX, launch_args, goto_app, booted, frames, pdf_drawn, settle
from common import CORS
from test_pane_zoom import MAP

FAKE = r"""
window.__calls=[];
window.fakeLLM={use:async(n)=>{
  if(n==='sample')return async(input,opts)=>{window.__calls.push(input);const out='It carries on from one page to the next.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false};};
  return null;}};
"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, detail)
    if not ok: fails.append(name)

SELECT = r"""(()=>{
  const t1=document.querySelector('.dpage[data-page="1"] .textLayer'),t2=document.querySelector('.dpage[data-page="2"] .textLayer');
  const s1=[...t1.querySelectorAll('span')].filter(s=>s.textContent.trim()).at(-1),s2=[...t2.querySelectorAll('span')].find(s=>s.textContent.trim());
  const r=document.createRange();r.setStart(s1.firstChild,0);r.setEnd(s2.firstChild,s2.firstChild.length);
  const sel=getSelection();sel.removeAllRanges();sel.addRange(r);
  return [s1.textContent,s2.textContent];
})()"""

def make_pdf(path):
    """A 2-page PDF written by hand (Helvetica, text at set positions), so the content stream's order is ours."""
    def page(items):   # (x, y, size, text), in stream order; y counts up from the bottom
        return '\n'.join(f'BT /F1 {sz} Tf {x} {y} Td ({t}) Tj ET' for x, y, sz, t in items).encode()
    p1 = page([(72, 765, 10, 'Quarterly header'),
               (72, 330, 14, 'Alpha beta gamma delta'), (72, 312, 14, 'epsilon zeta eta theta'), (72, 294, 14, 'iota kappa lambda mu'), (72, 276, 14, 'nu xi omicron pi'),
               (72, 600, 14, 'CALLOUTBOX stands alone'),
               (72, 30, 10, 'Report 1')])
    p2 = page([(72, 765, 10, 'Report header'),
               (72, 700, 14, 'Page two begins here and goes on'), (72, 682, 14, 'second line there'), (72, 664, 14, 'third line again')])
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 2: b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
            3: b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
            4: b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
            5: b'<< /Length %d >>\nstream\n' % len(p1) + p1 + b'\nendstream', 6: b'<< /Length %d >>\nstream\n' % len(p2) + p2 + b'\nendstream',
            7: b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'}
    out = b'%PDF-1.4\n'; offs = {}
    for n in sorted(objs):
        offs[n] = len(out); out += b'%d 0 obj\n' % n + objs[n] + b'\nendobj\n'
    x = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % offs[n] for n in sorted(objs))
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, x)
    open(path, 'wb').write(out)

SELECT2 = r"""(()=>{
  const spans=n=>[...document.querySelectorAll(`.dpage[data-page="${n}"] .textLayer span`)].filter(s=>s.textContent.trim());
  const s1=spans(1).find(s=>s.textContent.startsWith('epsilon')),s2=spans(2).find(s=>s.textContent.startsWith('Page two'));
  if(!s1||!s2)return null;
  const r=document.createRange();r.setStart(s1.firstChild,0);r.setEnd(s2.firstChild,s2.textContent.indexOf('begins')+'begins'.length);
  const sel=getSelection();sel.removeAllRanges();sel.addRange(r);
  return [spans(1).map(s=>s.textContent),spans(2).map(s=>s.textContent)];
})()"""
norm = lambda x: ' '.join((x or '').split())

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1200, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click(); await pdf_drawn(pg)
        # bring the page break into view, so page 2 is drawn too
        await pg.evaluate("(()=>{const pb=document.querySelector('.pane[data-tid=doc] .pb'),p2=pb.querySelector('.dpage[data-page=\"2\"]');pb.scrollTop+=p2.getBoundingClientRect().top-pb.getBoundingClientRect().top-pb.clientHeight/2})()")
        await pg.wait_for_function("!!document.querySelector('.dpage[data-page=\"2\"] .textLayer span')")
        last1, first2 = await pg.evaluate(SELECT)
        await pg.locator('#pop.show').wait_for(timeout=5000)
        check('the branch popup opens for a selection across pages', True)
        q = await pg.locator('#popQ').text_content()
        check('only the text layers are quoted (not the page number or buttons between pages)', 'Ask about' not in q, repr(q[-60:]))
        check('the popup quotes both pages', last1.strip()[:10] in q and first2.strip()[:10] in q, repr(q[-120:]))
        await pg.locator('#popIn').fill('What does this say?'); await pg.locator('#popIn').press('Enter')
        await pg.wait_for_function("window.__calls.length>0")
        t = await pg.evaluate("Object.values(__digress.conv.threads).find(t=>t.anchorMsg==='DOC')")
        check('the branch starts on page 1 and ends on page 2', t['anchorPage'] == 0 and (t.get('anchorEnd') or {}).get('page') == 1, repr({k: t.get(k) for k in ('anchorPage', 'anchorRange', 'anchorEnd')}))
        await settle(pg, 300)
        hl = await pg.evaluate("[1,2].map(n=>[...document.querySelectorAll(`.dpage[data-page=\"${n}\"] .anchor`)].map(a=>a.textContent).join(''))")
        check('page 1 highlights the passage up to its end', last1.strip()[:10] in hl[0].replace(' ', '') or last1.replace(' ', '')[:10] in hl[0].replace(' ', ''), repr(hl[0][-80:]))
        check('page 2 highlights the rest of it', first2.replace(' ', '')[:10] in hl[1].replace(' ', ''), repr(hl[1][:80]))
        markers = await pg.evaluate("[1,2].map(n=>document.querySelectorAll(`.dpage[data-page=\"${n}\"] sup.fn`).length)")
        check('one marker, where the passage starts', markers == [1, 0], repr(markers))
        sent = str(await pg.evaluate("JSON.stringify(window.__calls[0])"))
        check('the model is told the pages and gets the whole passage', 'pp. 1–2' in sent and first2.strip()[:10] in sent, '')
        # delete the branch: both pages lose the highlight
        await pg.locator('.pane:not([data-tid=doc]):not([data-tid=main]) [data-delb]').first.click(); await pg.locator('#mOk').click()
        await pg.wait_for_function("!document.querySelector('.dpage .anchor')", timeout=5000)
        check('deleting the branch clears both pages', True)

        # ---- a document whose text layer isn't in reading order: callout, footer and running header stay out
        tmp = tempfile.mkdtemp(); pdf = os.path.join(tmp, 'order.pdf'); make_pdf(pdf)
        pg2 = await b.new_page(viewport={'width': 1200, 'height': 900})
        pg2.on('pageerror', lambda e: errs.append(str(e)))
        await pg2.route('**/*', route); await pg2.add_init_script(FAKE)
        await goto_app(pg2); await booted(pg2)
        await pg2.locator('#newDoc').click()
        await pg2.set_input_files('#docFile', pdf); await pg2.locator('#docGo').click(); await pdf_drawn(pg2)
        await pg2.evaluate("(()=>{const pb=document.querySelector('.pane[data-tid=doc] .pb'),p2=pb.querySelector('.dpage[data-page=\"2\"]');pb.scrollTop+=p2.getBoundingClientRect().top-pb.getBoundingClientRect().top-pb.clientHeight/2})()")
        await pg2.wait_for_function("!!document.querySelector('.dpage[data-page=\"2\"] .textLayer span')")
        texts = await pg2.evaluate(SELECT2)
        check('the generated PDF has the callout and footer after the body in its text layer, and a header on page 2',
              texts and texts[0].index('CALLOUTBOX stands alone') > texts[0].index('nu xi omicron pi') and 'Report 1' in texts[0] and texts[1][0] == 'Report header', texts)
        await pg2.locator('#pop.show').wait_for(timeout=5000)
        q = norm(await pg2.locator('#popQ').text_content())
        WANT = 'epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi Page two begins'
        check('the popup quotes the body lines of page 1 joined with spaces, then the start of page 2', q == WANT, repr(q))
        check('…without the callout, the footer or page 2’s header', not any(w in q for w in ('CALLOUT', 'Report', 'Quarterly')), repr(q))
        await pg2.locator('#popIn').fill('What does this say?'); await pg2.locator('#popIn').press('Enter')
        await pg2.wait_for_function("window.__calls.length>0")
        t = await pg2.evaluate("Object.values(__digress.conv.threads).find(t=>t.anchorMsg==='DOC')")
        check('the branch’s anchor text is the same', norm(t['anchorText']) == WANT and not any(w in t['anchorText'] for w in ('CALLOUT', 'Report')), repr(t['anchorText']))
        check('it ends on page 2 and says where it starts there (anchorEnd.s > 0, after the header)', (t.get('anchorEnd') or {}).get('page') == 1 and (t.get('anchorEnd') or {}).get('s', 0) > 0, repr({k: t.get(k) for k in ('anchorPage', 'anchorRange', 'anchorEnd')}))
        sent = str(await pg2.evaluate("JSON.stringify(window.__calls[0])"))
        check('the model is told it is pp. 1–2 and gets the passage as quoted', 'pp. 1–2' in sent and '> ' + WANT in sent, sent[-600:])
        await settle(pg2, 300)
        hl = await pg2.evaluate("[1,2].map(n=>[...document.querySelectorAll(`.dpage[data-page=\"${n}\"] .anchor`)].map(a=>a.textContent).join('').replace(/\\s+/g,''))")
        check('page 1 highlights the body lines only (not the callout or the footer)', hl[0] == 'epsilonzetaetathetaiotakappalambdamunuxiomicronpi', repr(hl[0]))
        check('page 2 highlights from its first body words, not its header', hl[1] == 'Pagetwobegins', repr(hl[1]))
        await pg2.close()
        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
