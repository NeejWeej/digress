"""Flashcards when their conversation or branch is deleted.
  - Moving a conversation with cards to the trash asks once: "Also delete its N flashcards" (unticked), with the cards
    listed under a collapsed "See the N cards" in a box that scrolls. Without cards there's no question.
  - Ticked: the cards leave review at once; Restore brings them back as they were. Delete for good (and the server's
    cleanup after 7 days) deletes them, and its dialog says so; it doesn't ask again.
  - Unticked: they stay in review, with a note that the conversation is in the trash (and Restore); once it's deleted
    for good, a note that the source is gone.
  - Deleting a branch offers the same choice for its cards and its sub-branches'.
Asserts and exits non-zero."""
import asyncio, json, os, sys, tempfile, time
from playwright.async_api import async_playwright
from common import ROOT, OUT, launch_args, goto_app, booted, answered, saved, frames, new_conv, soon, settle
from common import CORS
from test_server import start, req

MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js',
    'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js',
}
FAKE = r"""window.fakeLLM={use:async(n)=>n!=='sample'?null:async(input,opts)=>{
  const out='A prior is what you believe before the evidence, and the likelihood says how well each guess explains it.';
  opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

C = "__digress.conv"
now = int(time.time() * 1000)
def card(i, conv, thread='main'):
    return {'id': f'k{conv}{i}', 'conv': conv, 'convTitle': 'x', 'thread': thread, 'at': {'thread': thread, 'msg': ''}, 'src': 'made',
            'where': 'Main' if thread == 'main' else 'a branch', 'front': f'Front {conv} {i}', 'back': 'Back', 'status': 'active',
            'created': now + i, 'due': now - 10000 - i, 'fsrs': None, 'reviews': []}

async def seed_cards(pg, cards):
    await pg.evaluate("(cs)=>{for(const c of cs)localStorage.setItem('fakesrv:cards/'+c.id,JSON.stringify(c))}", cards)
    await pg.reload(); await booted(pg); await settle(pg, 500)

due = lambda pg: pg.evaluate("[...document.querySelectorAll('#cardsModal .kfront')].length")
async def review_fronts(pg):
    """The fronts of every card due, in review over all conversations (skipping through them)."""
    await pg.locator('#reviewBtn').click(); await settle(pg, 300)
    seen = []
    for _ in range(20):
        f = pg.locator('#cardsModal .kfront')
        if not await f.count(): break
        t = await f.inner_text()
        if t in seen: break
        seen.append(t)
        if not await pg.locator('#cardsModal [data-kact=skip]').count(): break
        await pg.locator('#cardsModal [data-kact=skip]').click(); await frames(pg)
    return seen

async def close_cards(pg):
    await pg.keyboard.press('Escape'); await frames(pg)

async def page_part(p):
    b = await p.chromium.launch(**launch_args())
    pg = await b.new_page(viewport={'width': 1400, 'height': 860})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    async def route(r):
        u = r.request.url
        for k, v in MAP.items():
            if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript', headers=CORS)
        if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
        await r.continue_()
    await pg.route('**/*', route); await pg.add_init_script(FAKE)
    await goto_app(pg); await booted(pg)
    ids = []
    for q in ['What is a prior?', 'What is a posterior?', 'What is evidence?']:
        if ids: await new_conv(pg)
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill(q); await answered(pg, ta.press('Enter')); await saved(pg)
        ids.append(await pg.evaluate(f"{C}.id"))
    A, B, D = ids
    await seed_cards(pg, [card(i, A) for i in range(12)] + [card(0, B)])
    row = lambda cid, box='clist': pg.locator(f'#{box} .citem[data-conv="{cid}"]')

    # trashing A asks about its cards
    await row(A).hover(); await row(A).locator('[data-del]').click()
    await pg.locator('#modal.show').wait_for()
    body = pg.locator('#mBody')
    check('moving a conversation with cards to the trash asks about them', 'Also delete its 12 flashcards' in await body.inner_text() and await pg.locator('#mOk').inner_text() == 'Move to trash')
    check('…unticked to start with', not await pg.locator('#kdDrop').is_checked())
    check('…the cards are listed under a collapsed “See the 12 cards”', await pg.evaluate("!document.querySelector('#mBody .kdlist').open") and await pg.locator('#mBody .kdrow').count() == 12)
    await pg.locator('#mBody .kdlist summary').click(); await frames(pg)
    box = await pg.evaluate("(()=>{const b=document.querySelector('#mBody .kdbox');return [b.clientHeight,b.scrollHeight,document.querySelector('#modal .mbox').getBoundingClientRect().bottom,innerHeight]})()")
    check('…opened, they scroll in a box of their own; the dialog stays on screen', box[1] > box[0] and box[0] <= 260 and box[2] <= box[3], box)
    await pg.screenshot(path=OUT + '/trash_cards_dialog.png')
    await pg.locator('#kdDrop').check(); await pg.locator('#mOk').click()
    await soon(pg, f"() => [...document.querySelectorAll('#xlist .citem')].some(r=>r.dataset.conv==='{A}')")
    fronts = await review_fronts(pg); await close_cards(pg)
    check('ticked: its cards leave review at once (the other conversation’s stay)', fronts == [f'Front {B} 0'], fronts)

    await pg.locator('#trashToggle').click(); await frames(pg)
    await row(A, 'xlist').hover(); await row(A, 'xlist').locator('[data-restore]').click()
    await soon(pg, f"() => [...document.querySelectorAll('#clist .citem')].some(r=>r.dataset.conv==='{A}')")
    fronts = await review_fronts(pg); await close_cards(pg)
    check('Restore brings them back', len(fronts) == 13, fronts)

    # unticked: they stay, with a note and Restore
    await row(A).hover(); await row(A).locator('[data-del]').click(); await pg.locator('#modal.show').wait_for(); await pg.locator('#mOk').click()
    await soon(pg, f"() => [...document.querySelectorAll('#xlist .citem')].some(r=>r.dataset.conv==='{A}')")
    await pg.locator('#reviewBtn').click(); await settle(pg, 300)
    note = await pg.locator('#cardsModal .ksrcnote').inner_text() if await pg.locator('#cardsModal .ksrcnote').count() else ''
    check('unticked: they stay in review, saying the conversation is in the trash', 'in the trash' in note and 'Restore it' in note, note)
    await pg.screenshot(path=OUT + '/trash_cards_note.png')
    await pg.locator('#cardsModal .ksrcnote button').click(); await settle(pg, 300)
    check('…and Restore there brings the conversation back', await pg.locator('#cardsModal .ksrcnote').count() == 0 and A not in await pg.evaluate("[...document.querySelectorAll('#xlist .citem')].map(r=>r.dataset.conv)"))
    await close_cards(pg)

    # ticked, then Delete for good: the cards go, and the dialog says so without asking again
    await row(A).hover(); await row(A).locator('[data-del]').click(); await pg.locator('#modal.show').wait_for()
    await pg.locator('#kdDrop').check(); await pg.locator('#mOk').click()
    await soon(pg, f"() => [...document.querySelectorAll('#xlist .citem')].some(r=>r.dataset.conv==='{A}')")
    await row(A, 'xlist').hover(); await row(A, 'xlist').locator('[data-delnow]').click(); await pg.locator('#modal.show').wait_for()
    t = await pg.locator('#mBody').inner_text()
    check('Delete for good says the cards go too, as chosen, and doesn’t ask again', 'flashcards are deleted too' in t and await pg.locator('#kdDrop').count() == 0, t)
    await pg.locator('#mOk').click()
    await soon(pg, f"() => !Object.keys(localStorage).some(k=>k.startsWith('fakesrv:cards/k{A}'))")

    # unticked, then deleted for good: the note says the source is gone
    await row(B).hover(); await row(B).locator('[data-del]').click(); await pg.locator('#modal.show').wait_for(); await pg.locator('#mOk').click()
    await soon(pg, f"() => [...document.querySelectorAll('#xlist .citem')].some(r=>r.dataset.conv==='{B}')")
    await row(B, 'xlist').hover(); await row(B, 'xlist').locator('[data-delnow]').click(); await pg.locator('#modal.show').wait_for()
    check('Delete for good of an unticked one says the cards stay', 'stays in your review' in await pg.locator('#mBody').inner_text())
    await pg.locator('#mOk').click(); await settle(pg, 400)
    await pg.locator('#reviewBtn').click(); await settle(pg, 300)
    note = await pg.locator('#cardsModal .ksrcnote').inner_text() if await pg.locator('#cardsModal .ksrcnote').count() else ''
    check('…and in review the card says where it came from was deleted', 'was deleted' in note, note)
    await close_cards(pg)

    # a conversation without cards: no question
    await row(D).first.hover() if await row(D).count() else None
    await pg.locator(f'.citem[data-conv="{D}"] [data-del]').first.click(); await settle(pg, 300)
    check('without cards, it goes straight to the trash', await pg.locator('#modal.show').count() == 0)
    await pg.locator('#toast .tact').click(); await settle(pg, 300)

    # a branch with cards
    await pg.locator(f'.citem[data-conv="{D}"]').first.click(); await soon(pg, f"() => __digress.conv.id === '{D}'")
    await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body');
      const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf('likelihood'); if(i>=0){
      const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+10); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
    await pg.locator('#popIn').fill('Why the likelihood?'); await answered(pg, pg.locator('#popIn').press('Enter')); await saved(pg)
    bt = await pg.evaluate(f"Object.keys({C}.threads).find(t=>t!=='main')")
    await seed_cards(pg, [card(0, D, bt), card(1, D, bt), card(2, D)])
    await pg.locator(f'.pane[data-tid="{bt}"] [data-delb]').click(); await pg.locator('#modal.show').wait_for()
    check('deleting a branch offers to delete its cards too', 'Also delete its 2 flashcards' in await pg.locator('#mBody').inner_text(), await pg.locator('#mBody').inner_text())
    check('…and the OK button says Delete', await pg.locator('#mOk').inner_text() == 'Delete')
    await pg.locator('#kdDrop').check(); await pg.locator('#mOk').click()
    await soon(pg, f"() => !Object.keys(localStorage).some(k=>k.startsWith('fakesrv:cards/k{D}0')||k.startsWith('fakesrv:cards/k{D}1'))")
    check('…ticked, they’re deleted and the rest stay', await pg.evaluate(f"Object.keys(localStorage).some(k=>k==='fakesrv:cards/k{D}2')"))
    check('no page errors', not errs, errs[:3])
    await b.close()

def server_part():
    tmp = tempfile.mkdtemp(prefix='digress-trashcards-'); data = os.path.join(tmp, 'data')
    for d in ['convs', 'cards']: os.makedirs(os.path.join(data, d))
    day = 864e5
    def conv(id, **kw):
        c = {'id': id, 'title': id, 'created': now, 'updated': now, 'rev': 1, 'threads': {'main': {'id': 'main', 'parent': None}}, 'msgs': {}, 'order': {'main': []}, **kw}
        json.dump(c, open(os.path.join(data, 'convs', id + '.json'), 'w'), separators=(',', ':'))
    conv('drop', trashed=now - 8 * day, dropCards=True); conv('keepcards', trashed=now - 8 * day)
    for k in [card(0, 'drop'), card(1, 'drop'), card(0, 'keepcards')]:
        json.dump(k, open(os.path.join(data, 'cards', k['id'] + '.json'), 'w'), separators=(',', ':'))
    proc, base = start({'DATA_DIR': data, 'CLAUDE_BIN': '/nonexistent/claude'})
    try:
        has_conv = lambda cid: req(base, 'GET', f'/api/store/convs/{cid}')[0] == 200
        has_card = lambda kid: req(base, 'GET', f'/api/store/cards/{kid}')[0] == 200
        for _ in range(50):
            if not has_conv('drop') and not has_conv('keepcards'): break
            time.sleep(0.1)
        check('server: the cleanup deletes the cards of one trashed with “also delete its flashcards”', not has_card('kdrop0') and not has_card('kdrop1') and not has_conv('drop'))
        check('server: …and keeps the cards of one trashed without it', has_card('kkeepcards0') and not has_conv('keepcards'))
    finally:
        proc.kill()

async def main():
    server_part()
    async with async_playwright() as p:
        await page_part(p)
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
