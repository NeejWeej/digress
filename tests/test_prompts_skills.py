"""Prompts & skills: your own system prompt and quick questions, and skills turned on per conversation.
  - A saved system prompt replaces the default in the next request; Reset puts the default back.
  - Quick questions you save are the highlight popup's chips.
  - A pasted SKILL.md is added (name and description from its header); Prompt in the top bar turns it on for this
    conversation only, and it's added to the end of the system prompt, the same in every thread of it.
  - A conversation can have its own system prompt: its empty main thread shows the one it starts with, prefilled,
    to change before the first question; the Prompts page changes it later or puts it back to the default.
  - In a document conversation, branches from the document use main's prompt too, even while main is empty.
  - "What the model sees" (Prompt menu) shows the thread you're in: the system prompt's parts, then its messages.
  - The system prompt is the reader's part, then PROMPTS.howDigress (always, even with a custom prompt), then skills.
  - With no skills, Prompt still opens the menu (none yet, System prompt, What the model sees); no skill comes built in.
  - It stays on after a reload; deleting the skill takes it out of the prompt.
  - GitHub links to a skill's folder or file become its raw SKILL.md.
Asserts and exits non-zero."""
import asyncio, os, sys
from playwright.async_api import async_playwright
from common import launch_args, goto_app, booted, answered, frames, soon, quiet, OUT

FAKE = r"""window.__calls=[];window.fakeLLM={use:async(n)=>n!=='sample'?null:async(msgs,opts)=>{
  window.__calls.push(JSON.parse(JSON.stringify(msgs)));
  const out='Reply '+window.__calls.length+'.';opts.onText&&opts.onText({text:out});return {text:out,truncated:false}}};"""
SKILL = """---
name: "test-tutor"
description: "Teaches by asking one question at a time."
---

# Test tutor

Ask the learner ONE question at a time. Never give the answer first."""
sys_of = lambda msgs: msgs[0]['content'].split('\n\n---\n\n')[0]   # the fake folds the system prompt into the first message
HOW = ''   # PROMPTS.howDigress, read from the page
# the system prompt is: the reader's part, then howDigress (always), then skills, then the document
reader_of = lambda msgs: sys_of(msgs).split('\n\n' + HOW)[0]
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:400])
    if not ok: fails.append(name)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1300, 'height': 860})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(FAKE)
        await goto_app(pg); await booted(pg)
        ta = pg.locator('.pane[data-tid=main] textarea:not(.pptext)')
        async def ask(t, area=None):
            a = area or ta; await a.fill(t); await answered(pg, a.press('Enter')); await frames(pg)
        global HOW
        default = await pg.evaluate('PROMPTS.system'); HOW = await pg.evaluate('PROMPTS.howDigress')
        check('howDigress holds the fork rule and is not part of the default prompt', '[Side question about' in HOW and HOW not in default and default.startswith('You are a tutor'))
        check('the Prompt button says the default is in use', await pg.locator('#skillT').inner_text() == 'Prompt' and await pg.locator('#skillT').get_attribute('aria-pressed') == 'false')

        # --- the system prompt ---
        await pg.locator('#promptsBtn').click(); await pg.locator('#promptsPage #ppSys').wait_for()
        check('the page shows the default system prompt', await pg.locator('#ppSys').input_value() == default)
        check('the page shows how Digress works, read-only, apart from the prompt', await pg.locator('#promptsPage details.pphow').count() == 1
              and 'how digress works' in (await pg.locator('#promptsPage details.pphow summary').inner_text()).lower()
              and HOW in (await pg.locator('#promptsPage details.pphow').text_content()))
        check('…with no textarea of its own', await pg.locator('#promptsPage details.pphow textarea, #promptsPage details.pphow input').count() == 0)
        await pg.locator('#ppSys').fill('You are a terse tutor.')
        await pg.locator('[data-pp=syssave]').click(); await soon(pg, "() => __digress.custom.prompts.system === 'You are a terse tutor.'")
        check('…marked as yours, with a Reset', 'Yours' in await pg.locator('.ppsys h2').inner_text() and await pg.locator('[data-pp=sysreset]').is_visible())

        # --- quick questions ---
        await pg.locator('.ppqrow .ppql').first.fill('ELI5')
        await pg.locator('[data-pp=qsave]').click(); await soon(pg, "() => __digress.custom.prompts.quick && __digress.custom.prompts.quick[0][0] === 'ELI5'")
        check('saved quick questions are the popup’s chips', await pg.evaluate("document.querySelector('#popChips .chip').textContent") == 'ELI5')

        # --- a skill, pasted ---
        await pg.locator('#ppSkIn').fill(SKILL); await pg.locator('[data-pp=skadd]').click()
        await soon(pg, "() => __digress.custom.skills.has('sk-test-tutor')")
        rec = await pg.evaluate("__digress.custom.skills.get('sk-test-tutor')")
        check('name and description come from the header, the body without it', rec['name'] == 'test-tutor' and rec['description'].startswith('Teaches') and rec['body'].startswith('# Test tutor'), rec)
        check('it’s listed', 'Test tutor' in await pg.locator('#ppSkills').inner_text())
        await pg.screenshot(path=os.path.join(OUT, 'prompts_page.png'), full_page=False)
        await pg.locator('#ppTools table').scroll_into_view_if_needed(); await frames(pg)
        await pg.screenshot(path=os.path.join(OUT, 'prompts_tools.png'))
        await pg.keyboard.press('Escape'); await frames(pg)
        check('Esc closes the page', not await pg.locator('#promptsPage').is_visible())

        await ask('First question.')
        calls = await pg.evaluate('window.__calls')
        check('your system prompt is the one sent', reader_of(calls[-1]) == 'You are a terse tutor.', sys_of(calls[-1])[:200])
        check('…and how Digress works follows it, with nothing after', sys_of(calls[-1]) == 'You are a terse tutor.\n\n' + HOW, sys_of(calls[-1])[-300:])

        # --- turned on for this conversation ---
        check('Prompt is in the top bar', await pg.locator('#skillT').is_visible())
        await pg.locator('#skillT').click(); await pg.locator('#skillMenu [data-sk="sk-test-tutor"]').click()
        await soon(pg, "() => (__digress.conv.skills||[]).includes('sk-test-tutor')")
        check('the button says which skill is on', await pg.locator('#skillT').inner_text() == 'Test tutor' and await pg.locator('#skillT').get_attribute('aria-pressed') == 'true')
        await pg.screenshot(path=os.path.join(OUT, 'prompts_skill_menu.png'))
        await pg.keyboard.press('Escape'); await frames(pg)
        await ask('Second question.')
        s2 = sys_of((await pg.evaluate('window.__calls'))[-1])
        intro = await pg.evaluate('PROMPTS.skills.intro')
        check('the skill is added after your prompt and how Digress works', s2.startswith('You are a terse tutor.\n\n' + HOW + '\n\n' + intro) and '<skill name="test-tutor">\n# Test tutor' in s2, s2[:400])
        # a branch: the same system prompt (one cache for the whole conversation)
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').first.click()
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1'); await frames(pg, 3)
        bt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        await ask('A side question.', pg.locator(f'.pane[data-tid="{bt}"] textarea'))
        check('a branch gets the same system prompt, skill and all', sys_of((await pg.evaluate('window.__calls'))[-1]) == s2)

        # --- another conversation: off there ---
        cid = await pg.evaluate('__digress.conv.id')
        await pg.locator('#newConv').click(); await frames(pg, 3)
        check('a new conversation starts without it', await pg.locator('#skillT').inner_text() == 'Prompt' and await pg.locator('#skillT').get_attribute('aria-pressed') == 'false')

        # --- this conversation's own system prompt, from its empty main thread ---
        box = pg.locator('.pane[data-tid=main] .csys')
        check('an empty conversation shows the system prompt it starts with', 'your default' in await box.locator('summary').inner_text())
        await box.locator('summary').click()
        cta = box.locator('textarea')
        check('…prefilled with your default', await cta.input_value() == 'You are a terse tutor.')
        await cta.fill('You are a patient guide.'); await box.locator('[data-csys=save]').click()
        await soon(pg, "() => __digress.conv.system === 'You are a patient guide.'")
        check('the top bar says it has its own', await pg.locator('#skillT').inner_text() == 'Own prompt')
        await ask('Own prompt question.')
        check('the conversation’s own prompt is the one sent, with how Digress works after it', sys_of((await pg.evaluate('window.__calls'))[-1]) == 'You are a patient guide.\n\n' + HOW)
        own_cid = await pg.evaluate('__digress.conv.id')
        # later, from the top bar's Prompt menu: a dialog with it filled in
        async def edit_prompt():
            await pg.locator('#skillT').click(); await pg.locator('#skillMenu [data-sk="="]').click(); await pg.locator('#cSysEd').wait_for()
        await edit_prompt()
        await soon(pg, "() => getComputedStyle(document.querySelector('#modal .mbox') || document.querySelector('#modal')).opacity === '1'"); await frames(pg, 3)
        await pg.screenshot(path=os.path.join(OUT, 'prompts_conv_dialog.png'))
        check('the dialog shows this conversation’s prompt', await pg.locator('#cSysEd').input_value() == 'You are a patient guide.')
        await pg.locator('#cSysEd').fill('You are a patient guide. Use short paragraphs.'); await pg.locator('#mOk').click()
        await soon(pg, "() => __digress.conv.system === 'You are a patient guide. Use short paragraphs.'")
        await edit_prompt(); await pg.locator('#cSysDef').click()
        check('Put my default back fills in the default', await pg.locator('#cSysEd').input_value() == 'You are a terse tutor.')
        await pg.locator('#mOk').click(); await soon(pg, "() => !__digress.conv.system && !(__digress.sync.base && __digress.sync.base.system)")
        check('…and saving it follows the default again', await pg.locator('#skillT').inner_text() == 'Prompt')
        await edit_prompt(); await pg.locator('#cSysEd').fill('You are a patient guide.'); await pg.locator('#mOk').click()
        await soon(pg, "() => __digress.sync.base && __digress.sync.base.system === 'You are a patient guide.'")

        # --- after a reload ---
        await quiet(pg); await pg.goto(pg.url.split('#')[0] + '#c=' + cid); await booted(pg); await frames(pg, 3)
        check('after a reload: the skill, your prompt and chips are still there', await pg.evaluate("[__digress.conv.id, (__digress.conv.skills||[]).join(), __digress.custom.prompts.system, document.querySelector('#popChips .chip').textContent]") == [cid, 'sk-test-tutor', 'You are a terse tutor.', 'ELI5'])
        check('…and the button says so', await pg.locator('#skillT').inner_text() == 'Test tutor')

        # --- links ---
        links = await pg.evaluate("""[__digress.skillLink('https://github.com/janestreet/agent_skills/tree/master/socratic-tutor'),
          __digress.skillLink('https://github.com/o/r/blob/main/x/SKILL.md'), __digress.skillLink('https://github.com/o/r'), __digress.skillLink('https://example.com/a.md'), __digress.skillLink('nope')]""")
        check('GitHub links become the raw SKILL.md', links == ['https://raw.githubusercontent.com/janestreet/agent_skills/master/socratic-tutor/SKILL.md',
            'https://raw.githubusercontent.com/o/r/main/x/SKILL.md', 'https://raw.githubusercontent.com/o/r/HEAD/SKILL.md', 'https://example.com/a.md', None], links)
        bad = await pg.evaluate("__digress.putSkill('<!doctype html><p>hi').then(()=>'added',e=>e.message)")
        check('a web page isn’t taken as a skill', 'web page' in bad, bad)

        # --- delete the skill, reset the prompt ---
        await pg.locator('#promptsBtn').click(); await pg.locator('.ppsk [data-pp=skdel]').click(); await pg.locator('#mOk').click()
        await soon(pg, "() => !__digress.custom.skills.size")
        await pg.locator('[data-pp=sysreset]').click(); await pg.locator('#mOk').click()
        await soon(pg, "() => !__digress.custom.prompts.system")
        await pg.locator('[data-pp=qreset]').click(); await soon(pg, "() => !__digress.custom.prompts.quick")
        await pg.keyboard.press('Escape'); await frames(pg)
        check('with your skill gone the button is plain Prompt', await pg.locator('#skillT').inner_text() == 'Prompt')
        check('no skill comes with Digress: the store starts empty', await pg.evaluate("__digress.custom.skills.size") == 0)
        await pg.locator('#promptsBtn').click(); await pg.locator('#promptsPage #ppSkills').wait_for()
        check('the Skills section says none yet', 'No skills yet' in await pg.locator('#ppSkills').inner_text(), await pg.locator('#ppSkills').inner_text())
        await pg.keyboard.press('Escape'); await frames(pg)
        # with no skills the button still opens the menu, never the dialog
        await pg.locator('#skillT').click(); await pg.locator('#skillMenu.open').wait_for()
        check('with no skills, Prompt opens the menu: none-yet line, System prompt row, What the model sees', await pg.locator('#skillMenu .sknone').count() == 1
              and await pg.locator('#skillMenu [data-sk="="]').count() == 1 and await pg.locator('#skillMenu [data-sk="?"]').count() == 1 and await pg.locator('#skillMenu [data-sk="-"]').count() == 1
              and not await pg.locator('#cSysEd').count(), await pg.locator('#skillMenu').inner_text())
        await pg.locator('#skillMenu [data-sk="="]').click(); await pg.locator('#cSysEd').wait_for()
        check('…and its System prompt row opens the dialog', await pg.locator('#cSysEd').is_visible())
        await pg.locator('#mCancel').click(); await frames(pg)
        await pg.keyboard.press('Escape'); await frames(pg)
        await ask('Third question.')
        s3 = sys_of((await pg.evaluate('window.__calls'))[-1])
        check('without the skill and with the default prompt again', s3 == default + '\n\n' + HOW, s3[:200])
        check('the default chips again', await pg.evaluate("document.querySelector('#popChips .chip').textContent") == (await pg.evaluate('PROMPTS.quick'))[0][0])
        check('the defaults include Quiz me, last', await pg.evaluate("[PROMPTS.quick.length, PROMPTS.quick.at(-1)[0], [...document.querySelectorAll('#popChips .chip')].at(-1).textContent]") == [5, 'Quiz me', 'Quiz me'])

        # the other conversation kept its own prompt through all that
        await quiet(pg); await pg.goto(pg.url.split('#')[0] + '#c=' + own_cid)
        await pg.wait_for_function("id => __digress.conv && __digress.conv.id === id", arg=own_cid); await frames(pg, 3)
        check('a conversation’s own prompt is saved with it', await pg.evaluate('__digress.conv.system') == 'You are a patient guide.' and await pg.locator('#skillT').inner_text() == 'Own prompt')
        await ask('Back here.')
        check('…and still sent after the default was reset', sys_of((await pg.evaluate('window.__calls'))[-1]) == 'You are a patient guide.\n\n' + HOW)

        # --- What the model sees ---
        await pg.locator('#newConv').click(); await frames(pg, 3)
        await ask('Main question.')
        await pg.locator('.pane[data-tid="main"] [data-act="wbranch"]').last.click()
        await pg.wait_for_function('Object.keys(__digress.conv.threads).length > 1'); await frames(pg, 3)
        mt = await pg.evaluate("Object.keys(__digress.conv.threads).find(t=>t!=='main')")
        bta = pg.locator(f'.pane[data-tid="{mt}"] textarea')
        await ask('Branch question.', bta)
        async def view():
            await pg.locator('#skillT').click(); await pg.locator('#skillMenu [data-sk="?"]').click()
            await pg.locator('#modal .mview').wait_for(); await frames(pg)
            return await pg.evaluate("""() => ({
              parts: [...document.querySelectorAll('#modal .mview details.mvp')].map(d => ({t: d.querySelector('summary').textContent.trim(), x: d.querySelector('pre').textContent})),
              note: document.querySelector('#modal .mview .ppnote').textContent})""")
        await bta.click(); await frames(pg)
        v = await view(); await pg.screenshot(path=os.path.join(OUT, 'prompts_model_view.png'))
        msgs = [p for p in v['parts'] if p['t'][:1].isdigit()]
        check('the view lists the system parts: your prompt, then how Digress works', v['parts'][0]['t'].startswith('Your default prompt') and v['parts'][1]['t'].startswith('How Digress works (fixed)') and HOW == v['parts'][1]['x'], [p['t'] for p in v['parts']])
        check('from a branch: main question, main reply, then the branch question with its [Side question marker, then its reply',
              len(msgs) == 4 and msgs[0]['t'].startswith('1. User') and 'Main question.' in msgs[0]['x'] and msgs[1]['t'].startswith('2. Assistant') and msgs[1]['x'].startswith('Reply')
              and msgs[2]['t'].startswith('3. User') and msgs[2]['x'].startswith('[Side question') and 'Branch question.' in msgs[2]['x'] and msgs[3]['t'].startswith('4. Assistant'), [(p['t'], p['x'][:60]) for p in msgs])
        check('the note names the branch, not main', 'main thread' not in v['note'], v['note'])
        await pg.locator('#modal #mCancel').click(); await frames(pg)
        check('Close closes it', not await pg.locator('#modal .mview').is_visible())
        await pg.locator('.pane[data-tid="main"] textarea').click(); await frames(pg)
        v = await view()
        msgs = [p for p in v['parts'] if p['t'][:1].isdigit()]
        check('from main: only main messages, no branch question', len(msgs) == 2 and not any('Branch question' in p['x'] for p in msgs) and 'main thread' in v['note'], [(p['t'], p['x'][:40]) for p in msgs])
        await pg.locator('#modal #mCancel').click(); await frames(pg)

        # --- a document conversation: main's prompt is the one its document branches use, even with main empty ---
        await pg.locator('#newDoc').click()
        await pg.locator('#docPaste').fill('# Notes on Raft\n\nRaft elects a **leader** that replicates the log to followers.')
        await pg.locator('#docGo').click(); await soon(pg, "() => (document.querySelector('.docbody')||{}).textContent?.includes('replicates')")
        box = pg.locator('.pane[data-tid=main] .csys')
        check('a document conversation’s box says branches from the document use it', 'branches from the document' in await box.locator('summary').inner_text())
        await box.locator('summary').click()
        check('…and so does its note', 'even if nothing is ever asked here' in await box.locator('.csysn').inner_text())
        await box.locator('textarea').fill('You are a careful reader.'); await box.locator('[data-csys=save]').click()
        await soon(pg, "() => __digress.conv.system === 'You are a careful reader.'")
        await pg.evaluate("""() => { const b=document.querySelector('.docbody'); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf('replicates the log'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+18); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.locator('#popIn').fill('Why one leader?'); await answered(pg, pg.locator('#popIn').press('Enter')); await frames(pg)
        check('(main is still empty)', await pg.evaluate('__digress.conv.order.main.length') == 0)
        sd = sys_of((await pg.evaluate('window.__calls'))[-1])
        check('a branch from the document is sent main’s own prompt', sd.startswith('You are a careful reader.\n\n' + HOW) and 'Raft' in sd, sd[:200])

        check('no page errors', not errs, errs[:3])
        await b.close()
    print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
    sys.exit(1 if fails else 0)

asyncio.run(main())
