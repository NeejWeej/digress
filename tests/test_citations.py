"""Exact-passage citations for PDFs ([p. N "…"]), Markdown/text docs ([part N "…"]), and earlier messages ([earlier "…"]).
  - Quoted citations render only the bracketed label ([p. 1], [part 2], [earlier]), keeping the quote in data-cite so
    DOM text and stored highlight anchors stay unchanged.
  - While streaming, an unclosed quoted citation renders as a stub ([p. 4…], [earlier…]) instead of raw quote text.
  - plain() and convMarkdown() strip the quote syntax cleanly; code spans are untouched.
  - Clicking a PDF or Markdown exact citation scrolls to and highlights the line with a sticky CSS Highlight
    (clears on Esc or clicking in .docpane); a non-matching quote falls back cleanly to a plain page jump.
  - Clicking [earlier] walks the ancestor chain, highlights the earlier message, and pushes onto the Back chip.
Asserts and exits non-zero."""
import asyncio, sys
from playwright.async_api import async_playwright
from common import FIX, launch_args, goto_app, booted, soon, frames, settle, pdf_drawn

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

FAKE_LLM = """window.fakeLLM = {
  use: async (name) => name === 'sample' ? async (messages, opts) => {
    const last = messages[messages.length - 1];
    const txt = typeof last.content === 'string' ? last.content : last.content.filter(p => p.type === 'text').map(p => p.text).join(' ');
    let reply = 'Default reply.';
    if (txt.includes('CITE_PDF')) {
      reply = 'Exact [p. 1 "differentiable dictionary lookup"] and missing [p. 1 "nonexistent phantom phrase"].';
    } else if (txt.includes('CITE_MD')) {
      reply = 'See the mechanism [part 2 "quantum tunnel barrier"] here.';
    } else if (txt.includes('SEED_MAIN')) {
      reply = 'Remember the epistemic boundary between source and tutor when studying.';
    } else if (txt.includes('CITE_EARLIER')) {
      reply = 'This connects back to [earlier "epistemic boundary between source and tutor"].';
    }
    if (opts && opts.onToken) opts.onToken(reply);
    return { text: reply };
  } : null
};"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1280, 'height': 850})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE_LLM)
        await goto_app(pg); await booted(pg)

        # 1. Parsing, rendering, streaming stub, plain(), and convMarkdown()
        r = await pg.evaluate("""() => {
          const d = document.createElement('div');
          __digress.renderRich(d, 'A [p. 4 "short exact phrase"], B [part 2 "second section"], C [earlier "prior point"], and `[p. 4 "in code"]`.', true);
          const links = [...d.querySelectorAll('a.pref')].map(a => ({
            text: a.textContent, page: a.dataset.page || '', part: a.dataset.part || '',
            earlier: a.dataset.earlier || '', cite: a.dataset.cite || ''
          }));
          const s1 = document.createElement('div');
          __digress.renderRich(s1, 'Streaming [p. 12 "half typed quote', false);
          const s2 = document.createElement('div');
          __digress.renderRich(s2, 'Streaming [earlier "half typed', false);
          const p = __digress.plain('See [p. 4 "short exact phrase"] and [part 2 "second section"] and [earlier "prior point"].');
          const md = __digress.convMarkdown({
            title: 'T', threads: { main: { id: 'main', parent: null, title: 'Main' } },
            order: { main: ['m1'] },
            msgs: { m1: { id: 'm1', thread: 'main', role: 'assistant', content: 'Claim [p. 4 "short exact phrase"] and [earlier "prior point"].' } }
          });
          return { text: d.textContent, links, stub1: s1.textContent.trim(), stub2: s2.textContent.trim(), plain: p, md };
        }""")
        check('without a doc, only [earlier "…"] links and strips its quote',
              'prior point' not in r['text'] and '[earlier]' in r['text'], r['text'])
        check('parsed link datasets match (and code span is skipped)',
              len(r['links']) == 1 and r['links'][0]['earlier'] == '1' and r['links'][0]['cite'] == 'prior point', r['links'])
        # With doc context explicitly passed to linkPages, all three kinds link
        r2 = await pg.evaluate("""() => {
          const d = document.createElement('div');
          d.innerHTML = 'A [p. 4 "short exact phrase"], B [part 2 "second section"], C [earlier "prior point"], <code>[p. 4 "in code"]</code>.';
          __digress.linkPages(d);
          return [...d.querySelectorAll('a.pref')].map(a => [a.textContent, a.dataset.page||a.dataset.part||a.dataset.earlier, a.dataset.cite]);
        }""")
        check('linkPages parses PDF, part, and earlier quoted citations (skipping code)',
              r2 == [['[p. 4]', '4', 'short exact phrase'], ['[part 2]', '2', 'second section'], ['[earlier]', '1', 'prior point']], r2)
        check('streaming unclosed [p. N "… hides raw quote behind stub', r['stub1'] == 'Streaming [p. 12…]', r['stub1'])
        check('streaming unclosed [earlier "… hides raw quote behind stub', r['stub2'] == 'Streaming [earlier…]', r['stub2'])
        check('plain() strips inline citation quotes', r['plain'] == 'See [p. 4] and [part 2] and [earlier].', r['plain'])
        check('convMarkdown() strips inline citation quotes', 'Claim [p. 4] and [earlier].' in r['md'], r['md'])

        # 2. PDF exact-passage jump, sticky highlight, Esc & click clearing, and honest fallback
        await pg.locator('#newDoc').click()
        await pg.set_input_files('#docFile', FIX + '/paper.pdf')
        await pg.locator('#docGo').click(); await pdf_drawn(pg); await settle(pg)
        await pg.locator('.pane[data-tid="main"] textarea').fill('CITE_PDF')
        await pg.locator('.pane[data-tid="main"] textarea').press('Enter')
        await soon(pg, "() => document.querySelectorAll('.pane[data-tid=\"main\"] .msg.assistant a.pref').length === 2")

        # Click exact-match PDF citation
        await pg.locator('.pane[data-tid="main"] .msg.assistant a.pref').nth(0).click()
        await soon(pg, "() => typeof CSS !== 'undefined' && CSS.highlights && CSS.highlights.has('digress-hit')")
        check('PDF exact citation highlights the matched passage', True)
        # Press Esc -> clears sticky highlight
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Esc clears sticky citation highlight',
              not await pg.evaluate("CSS.highlights.has('digress-hit')"))
        # Click again -> highlights, then click in .docpane -> clears
        await pg.locator('.pane[data-tid="main"] .msg.assistant a.pref').nth(0).click()
        await soon(pg, "() => CSS.highlights.has('digress-hit')")
        await pg.locator('.docpane .pb').click(position={'x': 20, 'y': 20}); await frames(pg)
        check('clicking in document pane clears sticky highlight',
              not await pg.evaluate("CSS.highlights.has('digress-hit')"))
        # Click non-matching citation -> falls back cleanly (no fake highlight)
        await pg.locator('.pane[data-tid="main"] .msg.assistant a.pref').nth(1).click()
        await settle(pg, 300)
        check('non-matching PDF citation degrades cleanly without fake highlight',
              not await pg.evaluate("CSS.highlights.has('digress-hit')"))

        # 3. Markdown document exact-passage jump ([part N "…"])
        await pg.locator('#newDoc').click()
        md_doc = "# First section\n\nIntroductory paragraph.\n\n" + ("Filler sentence. " * 200) + "\n\n# Second section\n\nParticles cross the quantum tunnel barrier exponentially.\n"
        await pg.locator('#docPaste').fill(md_doc)
        await pg.locator('#docName').fill('Notes')
        await pg.locator('#docGo').click()
        await soon(pg, "() => !!document.querySelector('.docpane .docbody')")
        await pg.locator('.pane[data-tid="main"] textarea').fill('CITE_MD')
        await pg.locator('.pane[data-tid="main"] textarea').press('Enter')
        await soon(pg, "() => document.querySelectorAll('.pane[data-tid=\"main\"] .msg.assistant a.pref[data-part]').length === 1")
        await pg.locator('.pane[data-tid="main"] .msg.assistant a.pref[data-part]').click()
        await soon(pg, "() => CSS.highlights.has('digress-hit')")
        check('Markdown [part N "…"] citation highlights exact passage in .docbody', True)
        await pg.keyboard.press('Escape'); await frames(pg)

        # 4. Earlier-message citation across a branch chain + Back chip
        await pg.locator('#newConv').click(); await frames(pg)
        await pg.locator('.pane[data-tid="main"] textarea').fill('SEED_MAIN')
        await pg.locator('.pane[data-tid="main"] textarea').press('Enter')
        await soon(pg, "() => document.querySelectorAll('.pane[data-tid=\"main\"] .msg.assistant').length === 1 && !document.querySelector('.pane[data-tid=\"main\"] .msg.assistant.streaming')")
        # Open a branch off the reply using the reply's Side question button
        await pg.locator('.pane[data-tid="main"] .msg.assistant [data-act="wbranch"]').click()
        await soon(pg, "() => document.querySelectorAll('.pane:not(.docpane)').length === 2")
        branch_pane = pg.locator('.pane:not(.docpane):not([data-tid="main"])')
        await branch_pane.locator('textarea').fill('CITE_EARLIER')
        await branch_pane.locator('textarea').press('Enter')
        await soon(pg, "() => document.querySelectorAll('.pane:not([data-tid=\"main\"]) .msg.assistant a.pref[data-earlier]').length === 1")
        await branch_pane.locator('.msg.assistant a.pref[data-earlier]').click()
        await soon(pg, "() => CSS.highlights.has('digress-hit') && document.querySelector('#backChip').classList.contains('show')")
        check('[earlier "…"] jumps to ancestor message, highlights it, and shows Back chip', True)
        await pg.locator('#backChip').click(); await frames(pg)
        check('clicking Back chip clears highlight and returns',
              not await pg.evaluate("CSS.highlights.has('digress-hit')"))

        check('no page errors', not errs, '; '.join(errs[:3]))
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
