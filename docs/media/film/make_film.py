"""Make the Digress demo film (about 30 s): docs/media/film/digress-film.mp4 and its README thumbnail, poster.png.

    .venv/bin/python docs/media/film/make_film.py            # everything, end to end (about 3 minutes)

Needs what the tests need (`npm install`, Playwright with Chromium) plus numpy, Pillow and imageio-ffmpeg
(`.venv/bin/pip install numpy pillow imageio-ffmpeg`; the last one ships its own ffmpeg binary). The page
fonts (Inter, Source Serif 4) come from Google Fonts, so a network connection gives the intended look.

The story, in five beats: the twig and the name; a line-drawn head whose thought branches ("Every answer
raises new questions"); the core move (highlight a phrase, ask, the branch opens beside it); the canvas map
of the conversation, then ⌘K search landing on the words inside a PDF in another conversation; the closing card.

How it works:
  1. capture  It starts its own Digress server on a free port with a throwaway data folder and a stand-in
              for the Claude Code CLI that streams the canned replies below (no model is called, your own
              conversations and any running dev server are never touched), then drives the real app in
              headless Chromium. Two shots are recorded: 'core' (select, ask, the branch opens) and 'tour'
              (the canvas, then ⌘K into a PDF conversation set up off camera). Each is recorded as 1920x1080
              screenshots (the page at 1280x720 CSS px, 1.5x), with the pointer path, named time marks and
              element boxes logged alongside. The pointer is not in the screenshots; it is drawn in step 3,
              so it moves smoothly at 30 fps whatever the capture rate. The top bar's model picker is hidden
              (CALM_CSS): it changes often and says nothing in a film.
  2. cards    Title and illustration cards from cards.html (next to this file), one frame per call of
              show(scene, t), so every frame is a pure function of time; the captions are rendered there too.
  3. compose  BEATS below is the edit: which stretch of which shot, retimed (waits shortened), with eased
              camera moves and captions; cards crossfade in and out. The music is composed and synthesized
              here in numpy (music()), fitted to the cut. ffmpeg (from imageio-ffmpeg) writes a file that
              plays everywhere, including GitHub's inline player: H.264 High@4.0, yuv420p, constant 30 fps,
              AAC-LC, +faststart, kept under 5 MB (the free-plan limit for videos attached on GitHub is 10 MB).

GitHub's repository file viewer does not play videos at all (a blob page of any .mp4 only offers "View raw",
which downloads it as application/octet-stream). For a player in the README, drag this file once into
GitHub's web editor for README.md (or any issue comment); GitHub uploads it and inserts a
https://github.com/user-attachments/assets/... URL, which renders as an inline player on a line of its own.

Intermediate files go to a temporary folder that is removed at the end (pass --keep DIR to keep them
there and reuse them: `make_film.py --keep /tmp/film` captures once, later runs with the same DIR skip
straight to composing; delete DIR to capture again). Sub-steps for working on the edit:
    make_film.py capture DIR | cards DIR | compose DIR OUT.mp4 | stills DIR OUTDIR t1 t2 ... | poster DIR OUT.png
"""
import asyncio, base64, io, json, math, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
NM = os.path.join(REPO, 'node_modules') + '/'

# the page loads its libraries from CDNs; serve the local copies from node_modules
MAP = {
    'marked.min.js': NM + 'marked/marked.min.js',
    'purify.min.js': NM + 'dompurify/dist/purify.min.js',
    'highlight.min.js': NM + '@highlightjs/cdn-assets/highlight.min.js',
    'tex-svg-full.js': NM + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': NM + 'mermaid/dist/mermaid.min.js',
    'minisearch@7.1.0/dist/umd/index.js': NM + 'minisearch/dist/umd/index.js',
    'pdf.js/3.11.174/pdf.min.js': NM + 'pdfjs-dist/build/pdf.min.js',
    'pdf.js/3.11.174/pdf.worker.min.js': NM + 'pdfjs-dist/build/pdf.worker.min.js',
}

# ---- the story: two conversations, canned replies ------------------------------------------------
Q_MAIN = 'Why is the sky blue?'
SEL_MAIN = 'inverse fourth power of the wavelength'
Q_WHY4 = 'Why the fourth power?'
SEL_DIPOLE = 'oscillating dipole'
Q_DIPOLE = "What's a dipole, here?"
SEL_EYE = 'our eyes are much less sensitive'
Q_EYE = 'How do our eyes see colour?'
Q_DOC = 'Give me the big picture of these notes.'
SEL_DOC = 'every line of sight would end on a star'
Q_SIGHT = 'Why would every line of sight hit a star?'

REPLIES = [
    ('takeaway', r"""- Light's electric field shakes the electrons in air molecules, turning each one into a tiny antenna.
- An antenna radiates power that grows as frequency to the fourth, so scattering goes as 1/λ⁴.
- That is why blue (450 nm) is scattered nearly six times more than red (700 nm)."""),
    (Q_WHY4.lower(), r"""It comes from how a tiny molecule re-radiates light.

The light's electric field pushes the molecule's electrons back and forth, so the molecule becomes a small **oscillating dipole**. An oscillating dipole radiates power in proportion to the square of its acceleration.

- The electrons follow the field, so how far they move is set by its strength.
- Their acceleration is that distance times the frequency squared: *a* ∝ *ω*².
- Radiated power goes as *a*², so as *ω*⁴.

Since *ω* = 2π*c*/*λ*, that is 1/*λ*⁴. Halve the wavelength and the scattering grows sixteen-fold."""),
    (Q_DIPOLE.lower(), r"""A **dipole** is a pair of equal and opposite charges a small distance apart.

When light passes, its field pulls the electron cloud of a molecule one way and the nucleus the other, so the molecule briefly becomes a dipole. As the field oscillates, the dipole flips back and forth billions of times a second, and like a tiny radio antenna it sends out light of its own."""),
    (Q_EYE.lower(), r"""With three kinds of cone cells, each tuned to a different band of wavelengths: roughly short (blue), medium (green) and long (red).

Every colour you see is the brain's reading of how strongly each kind responds. Skylight excites the short cones a lot, but also the medium ones, and the brain reads that mix as a pale **sky blue** rather than violet."""),
    (Q_SIGHT.lower(), r"""Picture a forest. Close by there are gaps between the trunks, but if the forest goes on far enough, every direction you look ends on a tree.

Stars work the same way. Each one covers a tiny patch of sky, but the number of stars at distance *r* grows like *r*², exactly as fast as each star's patch shrinks. Go out far enough and the patches cover the whole sky with no gaps [p. 1].

The catch is *far enough*: a typical line of sight would have to run something like 10²³ light-years before it met a star, far longer than light has had time to travel."""),
    ('big picture', r"""The notes turn a simple observation into evidence about the universe:

1. **The puzzle.** In an infinite, unchanging universe full of stars, the night sky should blaze like the Sun [p. 1].
2. **Shells of stars.** Each distant shell sends us as much light as a near one, so the total diverges [p. 1].
3. **The way out.** The universe has a finite age, and expansion stretches distant light toward the red [p. 2].

The punchline: the darkness of the night sky is a clue that the universe had a beginning."""),
    ('sky blue', r"""Sunlight looks white, but it is a mix of every colour. On its way down it meets the molecules of the air, which are far smaller than a wavelength of light, and they scatter part of it in every direction. This is **Rayleigh scattering**.

Scattering depends steeply on colour: it goes as the inverse fourth power of the wavelength, $1/\lambda^4$. Blue light, around 450 nm, is scattered nearly six times more than red light at 700 nm.

So wherever you look away from the Sun, you see light that was knocked sideways toward you, and most of that light is blue.

### Then why not violet?
Violet scatters even more, but sunlight carries less of it, some is absorbed high in the atmosphere, and our eyes are much less sensitive to it.

### And at sunset
Near the horizon, light crosses far more air before it reaches you. Most of the blue is scattered out along the way, and what is left is orange and red."""),
]

FAKE_CLI = r"""#!/usr/bin/env node
// Stand-in for `claude -p` (stream-json), streaming canned replies for the film.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0 (film fake)'); process.exit(0); }
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const replies = JSON.parse(fs.readFileSync(process.env.FILM_REPLIES, 'utf8'));
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  const msg = JSON.parse(input.trim().split('\n')[0]);
  let prompt = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const k = prompt.lastIndexOf('Now reply to my latest message:'); if (k >= 0) prompt = prompt.slice(k);
  const low = prompt.toLowerCase();
  const hit = replies.find(([key]) => low.includes(key));
  const text = hit ? hit[1] : 'Good question.';
  const model = arg('--model');
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'system', subtype: 'init', model });
  emit({ type: 'stream_event', event: { type: 'message_start', message: { model } } });
  const delay = Number(fs.readFileSync(process.env.FILM_DELAY, 'utf8') || 12);
  await new Promise((r) => setTimeout(r, delay * 25));
  const parts = text.match(/[\s\S]{1,6}/g);
  for (const p of parts) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } } });
    await new Promise((r) => setTimeout(r, delay));
  }
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
  emit({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text });
});
"""

# ---- a two-page PDF of notes, printed by Chromium ------------------------------------------------
NOTES = """<!doctype html><html><head><meta charset="utf-8"><title>Why is the night sky dark?</title><style>
@page{size:A5;margin:16mm 15mm}
body{font-family:Georgia,'DejaVu Serif',serif;font-size:10.5pt;line-height:1.5;color:#1d1d1f;font-variant-ligatures:none}
h1{font-size:18pt;margin:0 0 2pt;font-weight:normal}
.sub{color:#666;font-style:italic;margin-bottom:16pt}
h2{font-size:11.5pt;margin:14pt 0 4pt}
p{margin:0 0 7pt}
.pb{page-break-before:always}
</style></head><body>
<h1>Why is the night sky dark?</h1>
<div class="sub">Notes on Olbers' paradox</div>
<h2>1. The puzzle</h2>
<p>Suppose the universe were infinite, unchanging, and evenly filled with stars.</p>
<p>Then every line of sight would end on a star, and the whole night sky would shine as brightly as the surface of the Sun.</p>
<p>It does not. Between the stars the sky is dark, and that simple fact is the paradox.</p>
<h2>2. Shells of stars</h2>
<p>Divide space into thin shells centred on the Earth. A shell twice as far away holds four times as many stars, and each of them looks a quarter as bright. Every shell therefore sends us the same amount of light, and infinitely many shells add up to a blinding sky.</p>
<p>The argument is old: Kepler worried about it in 1610, and Olbers stated it in 1823.</p>
<h2 class="pb">3. The way out</h2>
<p>The universe is not infinitely old. It began about 13.8 billion years ago, so light from beyond a certain distance has not had time to reach us. The shells we can see are finite in number.</p>
<p>Space is also expanding. Light from distant galaxies is stretched to longer, dimmer wavelengths on its way here, which darkens the sky further.</p>
<h2>4. What the darkness tells us</h2>
<p>A glance at the night sky, with no telescope at all, is evidence that the universe had a beginning.</p>
</body></html>"""


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def start_server(tmp):
    """Our own Digress server: free port, throwaway data folder, the fake CLI above. Never the user's."""
    cli = os.path.join(tmp, 'claude'); open(cli, 'w').write(FAKE_CLI); os.chmod(cli, 0o755)
    rep = os.path.join(tmp, 'replies.json'); json.dump(REPLIES, open(rep, 'w'))
    delay = os.path.join(tmp, 'delay'); open(delay, 'w').write('12')
    port = free_port()
    env = {**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1', 'DATA_DIR': os.path.join(tmp, 'data'),
           'LLM_PROVIDER': 'claude-code', 'CLAUDE_BIN': cli, 'ANTHROPIC_API_KEY': '', 'DEFAULT_MODEL': 'claude-opus-5-5',
           'CHATGPT_AUTH_FILE': os.path.join(tmp, 'no-chatgpt.json'), 'DEV': '0',
           'FILM_REPLIES': rep, 'FILM_DELAY': delay}
    proc = subprocess.Popen(['node', os.path.join(REPO, 'server', 'server.mjs')], env=env, cwd=tmp,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}/'
    for _ in range(100):
        try:
            if json.load(urllib.request.urlopen(url + 'api/health')).get('app') == 'digress': return proc, url
        except Exception: time.sleep(0.1)
    proc.kill(); sys.exit('server did not start')


def set_delay(tmp, ms): open(os.path.join(tmp, 'delay'), 'w').write(str(ms))


# ---- driving the app ------------------------------------------------------------------------------
VW, VH, DSF = 1280, 720, 1.5        # the browser viewport (CSS px) and its device scale factor (1920x1080 frames)

FIND = """([root, phrase, scroll]) => { const el=document.querySelector(root); if(!el) return null;
  // whitespace-blind, since a PDF's text layer has no spaces between its lines
  const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); const map=[]; let n, all='';
  while((n=w.nextNode())){ const v=n.nodeValue; for(let k=0;k<v.length;k++) if(!/\\s/.test(v[k])){ map.push([n,k]); all+=v[k]; } }
  const p=phrase.replace(/\\s+/g,''); const i=all.indexOf(p); if(i<0) return null;
  const [a,ao]=map[i], [b,bo]=map[i+p.length-1];
  if(scroll){ a.parentElement.scrollIntoView({block:scroll}); return 'scrolled'; }
  const r=document.createRange(); r.setStart(a,ao); r.setEnd(b,bo+1);
  const rs=[...r.getClientRects()].filter(q=>q.width>0); const f=rs[0], l=rs[rs.length-1];
  return [f.left+1, f.top+f.height/2, l.right-1, l.top+l.height/2]; }"""

# hide the text cursor blink and scrollbars so frames stay calm
CALM_CSS = """
*{scrollbar-width:none!important}
*::-webkit-scrollbar{display:none!important}
.top label.sel:has(#mSel),#mSel,#mDef{display:none!important}
"""


async def new_app_page(browser, url, mac=True):
    ctx = await browser.new_context(viewport={'width': VW, 'height': VH}, device_scale_factor=DSF, color_scheme='light')
    if mac:   # show ⌘ in the hints, as most readers will
        await ctx.add_init_script("Object.defineProperty(Navigator.prototype,'platform',{get:()=>'MacIntel'})")
    pg = await ctx.new_page()
    pg.errors = []
    pg.on('pageerror', lambda e: pg.errors.append(str(e)))

    async def route(r):
        u = r.request.url
        for k, v in MAP.items():
            if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
        await r.continue_()
    await pg.route('**/*', route)
    await pg.goto(url); await pg.wait_for_timeout(1500)
    await pg.add_style_tag(content=CALM_CSS)
    return pg


async def ask_main(pg, q, wait=4000):
    ta = pg.locator('.pane[data-tid=main] textarea')
    await ta.fill(q); await ta.press('Enter'); await pg.wait_for_timeout(wait)


async def quick_select(pg, root, phrase):
    assert await pg.evaluate(FIND, [root, phrase, 'center']), f'{phrase!r} not found in {root}'
    await pg.wait_for_timeout(500)
    x0, y0, x1, y1 = await pg.evaluate(FIND, [root, phrase, False])
    await pg.mouse.move(x0, y0); await pg.mouse.down(); await pg.mouse.move(x1, y1, steps=6); await pg.mouse.up()


async def branch(pg, root, phrase, q, wait=4500):
    await quick_select(pg, root, phrase)
    await pg.wait_for_selector('#pop.show', timeout=3000)
    await pg.locator('#popIn').fill(q); await pg.locator('#popIn').press('Enter')
    await pg.wait_for_timeout(wait)


# ---- recording ------------------------------------------------------------------------------------
def ease(u):   # smootherstep: zero velocity and acceleration at both ends
    u = min(1.0, max(0.0, u)); return u * u * u * (u * (u * 6 - 15) + 10)


class Rig:
    """Records one shot: Chrome screencast frames (JPEG, wall-clock stamped), the pointer path (drawn in
    post, so it moves smoothly whatever the capture rate), named time marks and element rectangles."""
    def __init__(self, pg, name):
        self.pg, self.name = pg, name
        self.frames, self.cursor, self.marks, self.rects = [], [], {}, {}
        self.x, self.y, self.down_ = VW * 0.82, VH * 0.86, False

    async def start(self):
        # Screenshots in a loop rather than Page.startScreencast: the screencast only delivers CSS-pixel
        # frames in headless Chromium, and we want device pixels (2x) for crisp text.
        self.cdp = await self.pg.context.new_cdp_session(self.pg)
        await self.pg.mouse.move(self.x, self.y)
        self.running = True
        self.task = asyncio.ensure_future(self._grab())
        await asyncio.sleep(0.3)
        self.t0 = time.time(); self.log(); self.mark('start')

    async def _grab(self):
        clip = {'x': 0, 'y': 0, 'width': VW, 'height': VH, 'scale': DSF}
        last = None
        while self.running:
            a = time.time()
            r = await self.cdp.send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 92, 'clip': clip})
            t = (a + time.time()) / 2
            if r['data'] != last:            # unchanged frames add nothing: the previous one is held
                self.frames.append((t, base64.b64decode(r['data']))); last = r['data']
            await asyncio.sleep(0.005)

    async def stop(self):
        self.mark('end'); self.log()
        await asyncio.sleep(0.3)
        self.running = False; await self.task
        await self.cdp.detach()

    def log(self): self.cursor.append((time.time(), self.x, self.y, self.down_))
    def mark(self, k): self.marks[k] = time.time()

    async def rect(self, k, js):
        """Remember an element's box (CSS px) for the camera, e.g. rect('pop', "#pop")."""
        r = await self.pg.evaluate("""(s)=>{const e=typeof s==='string'&&!s.includes('=>')?document.querySelector(s):(0,eval)(s)();
            if(!e) return null; const b=e.getBoundingClientRect(); return [b.left,b.top,b.right,b.bottom]}""", js)
        self.rects[k] = r; return r

    async def hold(self, s):
        end = time.time() + s
        while time.time() < end: self.log(); await asyncio.sleep(min(0.1, max(0, end - time.time())))

    async def move(self, x, y, dur=None, arc=0.06):
        x0, y0 = self.x, self.y; d = math.hypot(x - x0, y - y0)
        if d < 1: return
        dur = dur or min(1.3, 0.45 + d / 1100)
        nx, ny = (-(y - y0) / d, (x - x0) / d)          # a slight bow, as a hand moves
        t0 = time.time()
        while True:
            u = min(1.0, (time.time() - t0) / dur); e = ease(u); b = math.sin(math.pi * e) * arc * d
            self.x, self.y = x0 + (x - x0) * e + nx * b, y0 + (y - y0) * e + ny * b
            await self.pg.mouse.move(self.x, self.y); self.log()
            if u >= 1: break
            await asyncio.sleep(0.012)

    async def press(self):
        self.down_ = True; self.log(); await self.pg.mouse.down(); await asyncio.sleep(0.06)

    async def release(self):
        await self.pg.mouse.up(); self.down_ = False; self.log()

    async def click(self, target, dx=0.5, dy=0.5, dur=None, settle=0.18):
        if isinstance(target, str):
            b = await self.pg.locator(target).first.bounding_box()
            assert b, f'{target} not visible'
            x, y = b['x'] + b['width'] * dx, b['y'] + b['height'] * dy
        else: x, y = target
        await self.move(x, y, dur); await self.hold(settle)
        await self.press(); await asyncio.sleep(0.05); await self.release()

    async def type(self, text, base=0.075):
        import random
        rnd = random.Random(7)
        for ch in text:
            await self.pg.keyboard.type(ch)
            pause = base * (0.6 + 0.8 * rnd.random()) + (0.06 if ch == ' ' else 0) + (0.12 if ch in ',?.' else 0)
            await self.hold(pause)

    async def select(self, root, phrase, dur=1.0):
        """Drag across a phrase, like a reader does."""
        box = await self.pg.evaluate(FIND, [root, phrase, False])
        assert box, f'{phrase!r} not found in {root}'
        x0, y0, x1, y1 = box
        await self.move(x0 - 1, y0); await self.hold(0.25)
        await self.press()
        t0 = time.time()
        while True:   # along the text: ease along the line, steady in y
            u = min(1.0, (time.time() - t0) / dur); e = ease(u)
            self.x, self.y = x0 + (x1 - x0) * e, y0 + (y1 - y0) * e
            await self.pg.mouse.move(self.x, self.y); self.log()
            if u >= 1: break
            await asyncio.sleep(0.012)
        await self.hold(0.12); await self.release()
        return box

    def save(self, outdir):
        d = os.path.join(outdir, self.name); os.makedirs(d, exist_ok=True)
        idx = []
        for i, (t, jpg) in enumerate(self.frames):
            fn = f'{i:05d}.jpg'; open(os.path.join(d, fn), 'wb').write(jpg); idx.append([t, fn])
        json.dump({'frames': idx, 'cursor': self.cursor, 'marks': self.marks, 'rects': self.rects, 't0': self.t0},
                  open(os.path.join(d, 'shot.json'), 'w'))
        print(f'  shot {self.name}: {len(idx)} frames over {self.marks["end"] - self.marks["start"]:.1f}s '
              f'({len(idx) / max(0.1, self.marks["end"] - self.marks["start"]):.0f} fps)')


async def scroll_to(pg, root, phrase, block='center'):
    assert await pg.evaluate(FIND, [root, phrase, block]), f'{phrase!r} not found in {root}'
    await pg.wait_for_timeout(400)


async def math_ready(pg):
    await pg.wait_for_function("!document.querySelector('.msg .body') || !/\\$[^$]+\\$/.test([...document.querySelectorAll('.msg .body')].map(e=>e.textContent).join(''))", timeout=15000)


async def wait_idle(r, panes=0):
    """Until every reply has finished streaming (text steady, no Stop button), logging the pointer meanwhile."""
    last, same = None, 0
    for _ in range(300):
        st = await r.pg.evaluate("""()=>[document.querySelectorAll('.pane').length,
            [...document.querySelectorAll('button')].some(b=>b.title==='Stop'),
            [...document.querySelectorAll('.msg .body')].map(e=>e.textContent).join('').length]""")
        if st[0] >= panes and not st[1] and st == last: same += 1
        else: same = 0
        if same >= 5: return
        last = st; await r.hold(0.1)
    raise TimeoutError('replies did not finish')


MAIN = '.pane[data-tid=main] .msg.assistant .body'
DOCP = '.pane[data-tid=doc] .dpage[data-page="1"] .textLayer'


async def capture(outdir, tmp, url):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox'])
        # the notes, printed to a PDF
        np_ = await b.new_page(); await np_.set_content(NOTES); pdf = os.path.join(tmp, 'night-sky-notes.pdf')
        await np_.pdf(path=pdf, format='A5', print_background=True); await np_.close()

        pg = await new_app_page(b, url)
        set_delay(tmp, 4)
        bp = '.pane:not([data-tid=main]):not([data-tid=doc])'

        # ---- the core move: highlight, ask, a branch opens beside it ----
        await pg.locator('#newConv').click(); await pg.wait_for_timeout(400)
        await ask_main(pg, Q_MAIN, 3500); await math_ready(pg)
        await pg.locator('#tSide').click(); await pg.wait_for_timeout(500)       # sidebar away: more room
        await pg.evaluate("document.querySelector('.pane[data-tid=main] .pb').scrollTop=0"); await pg.wait_for_timeout(300)
        set_delay(tmp, 14)
        r = Rig(pg, 'core'); await r.start()
        await r.hold(1.0)
        r.mark('sel0'); await r.select(MAIN, SEL_MAIN, 1.0); r.mark('sel1')
        await pg.wait_for_selector('#pop.show'); await r.hold(0.4)
        await r.rect('pop', '#pop')
        await r.click('#popIn', 0.3); await r.hold(0.2)
        r.mark('type0'); await r.type(Q_WHY4, 0.06); r.mark('type1'); await r.hold(0.4)
        await pg.keyboard.press('Enter'); r.mark('sent')
        await r.move(VW * 0.62, VH * 0.84, 1.2)
        await wait_idle(r, 2)
        await math_ready(pg); r.mark('done')
        await r.hold(2.4)
        await r.stop(); r.save(outdir)

        # off camera: two more branches, for the canvas
        set_delay(tmp, 3)
        await branch(pg, MAIN, SEL_EYE, Q_EYE, 3000)
        await branch(pg, f'{bp} .msg.assistant .body', SEL_DIPOLE, Q_DIPOLE, 3000)
        await math_ready(pg)
        for q in (Q_DIPOLE, Q_EYE):
            await pg.locator('.pane').filter(has=pg.locator('.ph-title', has_text=q)).locator('[data-act=close]').click()
            await pg.wait_for_timeout(500)

        # off camera: a second conversation, a PDF with a branch from it, for the search to land in
        await pg.locator('#tSide').click(); await pg.wait_for_timeout(400)
        await pg.locator('#newDoc').click(); await pg.wait_for_timeout(300)
        await pg.set_input_files('#docFile', pdf)
        await pg.locator('#docGo').click(); await pg.wait_for_timeout(2500)
        await ask_main(pg, Q_DOC, 3000)
        await pg.locator('#tSide').click(); await pg.wait_for_timeout(500)
        await branch(pg, DOCP, SEL_DOC, Q_SIGHT, 3500)
        await pg.locator('.pane[data-tid=main] [data-act=collapse]').click(); await pg.wait_for_timeout(1000)
        for _ in range(2):
            await pg.locator('.pane[data-tid=doc] [data-act=zout]').click(); await pg.wait_for_timeout(600)
        await pg.evaluate("document.querySelectorAll('.pb').forEach(e=>e.scrollTop=0)"); await pg.wait_for_timeout(500)

        # back to the sky conversation, last in the "fourth power" branch
        await pg.locator('#tSide').click(); await pg.wait_for_timeout(400)
        await pg.locator('#clist .citem', has_text=Q_MAIN).first.click(); await pg.wait_for_timeout(1500)
        await pg.locator('#tSide').click(); await pg.wait_for_timeout(500)
        if await pg.locator('#backChip.show').count(): await pg.locator('#backX').click()
        await pg.evaluate("document.querySelectorAll('.pb').forEach(e=>e.scrollTop=0)")
        await pg.locator(f'{bp} .ph-title').first.click(); await pg.wait_for_timeout(300)
        await pg.mouse.move(VW * 0.62, VH * 0.84); await pg.wait_for_timeout(800)

        # ---- the tour: the canvas, then ⌘K into the PDF ----
        r = Rig(pg, 'tour'); r.x, r.y = VW * 0.62, VH * 0.84; await r.start()
        await r.hold(0.5)
        await r.click('[data-v=canvas]'); r.mark('canvas'); await r.hold(0.6)
        await r.move(VW * 0.86, VH * 0.17, 1.6); await r.hold(1.6)   # rest on empty canvas, above where the search
        # results will be, so the way down to the Document row doesn't pass over the 'Describe it instead' row
        await pg.keyboard.press('Meta+K'); r.mark('open'); await r.hold(0.6)
        if not await pg.locator('#pal.show').count():
            await pg.keyboard.press('Control+K'); await r.hold(0.4)
        await r.type('line of sight', 0.08); r.mark('typed'); await r.hold(0.9)
        await r.click('#palRes .pr:has(.pk:text-matches("Document"))', 0.4); r.mark('go')
        await r.move(VW * 0.47, VH * 0.86, 1.2)
        await r.hold(2.6)
        await r.stop(); r.save(outdir)

        if pg.errors: print('page errors:', *pg.errors[:5], sep='\n  ')
        await b.close()



# ---- the cut ---------------------------------------------------------------------------------------
FPS, OW, OH = 30, 1920, 1080
XF = 0.6                                   # crossfade between beats, seconds
WIN = (208, 178, 1504, 846)                # where the app window sits in the frame (x, y, w, h)
CAP_H = 160                                # the caption band above it
BG = (243, 239, 230)                       # the cream around the window (cards use the same)
FULL = (VW / 2, VH / 2, 1.0)

# Each beat: a card scene with its length, or a stretch of a recorded shot.
#   warp: (film time, (mark, offset)) points; source time is interpolated between them, so waits can be
#         shortened without touching the moments that matter.
#   cam:  (film time, (cx, cy, zoom)) in CSS px of the 1280x720 page; eased between points.
#   caps: (text, from, to) in film time within the beat.
BEATS = [
    {'card': 'open', 'dur': 3.2},
    {'card': 'think', 'dur': 3.4},
    {'shot': 'core',
     'warp': [(0, ('start', 0.6)), (None, ('sel1', 0)), ('x1.25', ('sent', 0)), ('x1.2', ('done', 0)), (None, ('done', 1.7))],
     'cam': [(0, (640, 400, 1.14)), (('sel0', -0.3), (640, 381, 1.28)), (('sent', -0.3), (640, 381, 1.28)), (('sent', 0.8), FULL)],
     'caps': [('Highlight what puzzles you, and ask.', 0.4, ('sent', -0.3)),
              ('The answer opens beside it.', ('sent', 0.2), ('done', 1.7))]},
    {'shot': 'tour',
     'warp': [(0, ('canvas', -1.2)), (None, ('canvas', 0.2)), ('x1.3', ('open', 0)), (None, ('typed', 0)), ('x1.2', ('go', 0)), (None, ('go', 3.2))],
     'cam': [(0, FULL)],
     'caps': [('See the whole conversation as a map.', 0.3, ('open', -0.2)),
              ('<kbd>⌘K</kbd> finds any thought again, even in a PDF.', ('open', 0.1), ('go', 3.2))]},
    {'card': 'close', 'dur': 4.6},
]


def resolve(b, shots):
    """Turn a beat's mark-based times into film times. In 'warp', None means "1:1 since the last point"
    and a number on a later point means "this many film seconds since the last point"."""
    sh = shots[b['shot']]
    pts, ft = [], 0.0
    for i, (f, (m, o)) in enumerate(b['warp']):
        st = sh.marks[m] + o
        if i == 0: ft = f
        elif f is None: ft = pts[-1][0] + (st - pts[-1][1])
        elif isinstance(f, str): ft = pts[-1][0] + (st - pts[-1][1]) / float(f[1:])     # 'x1.2': 1.2x speed
        else: ft = pts[-1][0] + f
        pts.append((ft, st))
    def film(x):
        if not isinstance(x, tuple): return x
        st = sh.marks[x[0]] + x[1]
        return interp([(a, f) for f, a in pts], st)
    b['_warp'] = pts
    b['_cam'] = [(film(t), c) for t, c in b['cam']]
    b['_caps'] = [(text, film(a), film(e)) for text, a, e in b.get('caps', [])]
    b['dur'] = pts[-1][0]


def beat_times():
    t, out = 0.0, []
    for b in BEATS:
        d = b['dur']
        out.append((t, d)); t += d - XF
    return out, t + XF


POSTER_CAP = ('<svg class="pm" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round">'
              '<path stroke="#2a2723" d="M3.5 20.5C8 16 12 12 15 4.8"/><path stroke="#c4643c" d="M10.6 13.7c3-.4 5.7.3 8.9 2"/>'
              '<path stroke="#c4643c" d="M15.2 14c1.1-1.6 2.7-2.6 5-3.1"/><circle fill="#2a2723" stroke="none" cx="15.2" cy="4.3" r="1.9"/>'
              '<circle fill="#c4643c" stroke="none" cx="19.8" cy="15.9" r="1.7"/><circle fill="#c4643c" stroke="none" cx="20.4" cy="10.5" r="1.4"/></svg>'
              'Digress<span class="mu">a branching chat for learning</span>'
              '<span class="play"><svg viewBox="0 0 16 16"><path d="M4 2.5v11l9.5-5.5z" fill="#fffdf9"/></svg>Watch the 30-second film</span>')
POSTER_AT = ('core', ('done', 1.5))      # the app frame behind the poster's title


def captions_of():
    return sorted({c[0] for b in BEATS for c in b.get('caps', [])}) + [POSTER_CAP]


async def render_cards(browser, outdir):
    """Card frames (one PNG per film frame) and the caption images, from cards.html."""
    pg = await browser.new_page(viewport={'width': OW, 'height': OH})
    await pg.goto('file://' + os.path.join(HERE, 'cards.html'))
    await pg.evaluate('document.fonts.ready'); await pg.wait_for_timeout(300)
    for b in BEATS:
        if 'card' not in b: continue
        d = os.path.join(outdir, 'card-' + b['card']); os.makedirs(d, exist_ok=True)
        for i in range(int(round(b['dur'] * FPS))):
            await pg.evaluate(f'show({json.dumps(b["card"])}, {i / FPS})')
            await pg.screenshot(path=os.path.join(d, f'{i:05d}.png'))
    d = os.path.join(outdir, 'captions'); os.makedirs(d, exist_ok=True)
    for k, text in enumerate(captions_of()):
        await pg.evaluate(f'caption({json.dumps(text)})')
        await pg.screenshot(path=os.path.join(d, f'{k}.png'), clip={'x': 0, 'y': 0, 'width': OW, 'height': CAP_H}, omit_background=True)
    await pg.close()


class Shot:
    def __init__(self, d):
        from PIL import Image
        self.d = d; m = json.load(open(os.path.join(d, 'shot.json')))
        t0 = m['marks']['start']
        self.marks = {k: v - t0 for k, v in m['marks'].items()}
        self.ft = [f[0] - t0 for f in m['frames']]; self.ff = [f[1] for f in m['frames']]
        self.cur = [(c[0] - t0, c[1], c[2], c[3]) for c in m['cursor']]
        self.presses = [c[0] for i, c in enumerate(self.cur) if c[3] and (i == 0 or not self.cur[i - 1][3])]
        self.cache = {}

    def frame(self, t):
        import bisect
        from PIL import Image
        i = max(0, bisect.bisect_right(self.ft, t) - 1)
        if i not in self.cache:
            if len(self.cache) > 6: self.cache.clear()
            self.cache[i] = Image.open(os.path.join(self.d, self.ff[i])).convert('RGB')
        return self.cache[i]

    def cursor(self, t):
        import bisect
        ts = [c[0] for c in self.cur]
        i = bisect.bisect_right(ts, t)
        if i <= 0: return self.cur[0][1:3]
        if i >= len(self.cur): return self.cur[-1][1:3]
        a, b = self.cur[i - 1], self.cur[i]
        u = (t - a[0]) / max(1e-6, b[0] - a[0])
        return a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u


def interp(points, t, f=lambda a, b, u: a + (b - a) * u, eased=False):
    if t <= points[0][0]: return points[0][1]
    for (t0, a), (t1, b) in zip(points, points[1:]):
        if t <= t1:
            u = (t - t0) / max(1e-6, t1 - t0)
            return f(a, b, ease(u) if eased else u)
    return points[-1][1]


def cursor_sprite():
    """A classic arrow pointer, drawn at 4x and kept as RGBA."""
    from PIL import Image, ImageDraw, ImageFilter
    S = 8
    pts = [(3, 2), (3, 19), (7.4, 15), (10.4, 21.4), (13.1, 20.2), (10.2, 14), (16, 14)]
    im = Image.new('RGBA', (26 * S, 28 * S), (0, 0, 0, 0))
    sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x * S + 0.8 * S, y * S + 1.2 * S) for x, y in pts], fill=(0, 0, 0, 70))
    sh = sh.filter(ImageFilter.GaussianBlur(1.3 * S))
    im = Image.alpha_composite(im, sh)
    d = ImageDraw.Draw(im)
    d.polygon([(x * S, y * S) for x, y in pts], fill=(255, 255, 255, 255))
    inner = [(3.9, 4.3), (3.9, 16.9), (7.7, 13.5), (10.8, 20.0), (12.0, 19.5), (9.0, 13.1), (14.0, 13.1)]
    d.polygon([(x * S, y * S) for x, y in inner], fill=(26, 24, 21, 255))
    return im, (3 * S, 2 * S), S


class Composer:
    def __init__(self, work):
        import numpy as np
        from PIL import Image, ImageDraw, ImageFilter
        self.np, self.Image = np, Image
        self.work = work
        self.shots = {b['shot']: Shot(os.path.join(work, 'shots', b['shot'])) for b in BEATS if 'shot' in b}
        for b in BEATS:
            if 'shot' in b: resolve(b, self.shots)
        self.times, self.total = beat_times()
        caps = captions_of()
        self.caps = {t: np.asarray(Image.open(os.path.join(work, 'cards', 'captions', f'{k}.png')).convert('RGBA')).astype(np.float32) / 255
                     for k, t in enumerate(caps)}
        x, y, w, h = WIN
        bg = Image.new('RGB', (OW, OH), BG)
        sh = Image.new('L', (OW, OH), 0)
        ImageDraw.Draw(sh).rounded_rectangle((x, y + 14, x + w, y + h + 14), 18, fill=46)
        sh = sh.filter(ImageFilter.GaussianBlur(26))
        bg = Image.composite(Image.new('RGB', (OW, OH), (120, 100, 70)), bg, sh)
        ImageDraw.Draw(bg).rounded_rectangle((x - 1, y - 1, x + w, y + h), 15, outline=(214, 206, 192), width=1)
        self.bg = np.asarray(bg).astype(np.float32)
        m = Image.new('L', (w * 4, h * 4), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, w * 4 - 1, h * 4 - 1), 14 * 4, fill=255)
        self.mask = (np.asarray(m.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255)[..., None]
        self.cur_im, self.cur_tip, self.cur_s = cursor_sprite()
        self.cards = {}

    def card(self, name, t):
        i = min(int(round(t * FPS)), len(os.listdir(os.path.join(self.work, 'cards', 'card-' + name))) - 1)
        p = os.path.join(self.work, 'cards', 'card-' + name, f'{max(0, i):05d}.png')
        return self.np.asarray(self.Image.open(p).convert('RGB')).astype(self.np.float32)

    def app(self, b, t):
        np, Image = self.np, self.Image
        sh = self.shots[b['shot']]
        src = interp(b['_warp'], t)
        cx, cy, z = interp(b['_cam'], t, lambda a, c, u: tuple(a[i] + (c[i] - a[i]) * u for i in range(3)), eased=True)
        cw, ch = VW / z, VH / z
        x0 = min(max(cx - cw / 2, 0), VW - cw); y0 = min(max(cy - ch / 2, 0), VH - ch)
        x, y, w, h = WIN
        im = sh.frame(src); f = im.width / VW
        win = im.resize((w, h), Image.LANCZOS, box=(x0 * f, y0 * f, (x0 + cw) * f, (y0 + ch) * f))
        # the pointer, scaled with the page
        k = w / cw
        px, py = sh.cursor(src)
        sc = k * 1.0 / self.cur_s
        cur = self.cur_im.resize((max(1, int(self.cur_im.width * sc)), max(1, int(self.cur_im.height * sc))), Image.LANCZOS)
        cxp, cyp = (px - x0) * k - self.cur_tip[0] * sc, (py - y0) * k - self.cur_tip[1] * sc
        # a soft ring where it clicks
        from PIL import ImageDraw
        for pt in sh.presses:
            age = src - pt
            if 0 <= age < 0.45:
                ov = Image.new('RGBA', win.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
                r = (6 + 16 * ease(age / 0.45)) * k; a = int(110 * (1 - age / 0.45))
                d.ellipse(((px - x0) * k - r, (py - y0) * k - r, (px - x0) * k + r, (py - y0) * k + r), outline=(196, 100, 60, a), width=max(2, int(2 * k)))
                win = Image.alpha_composite(win.convert('RGBA'), ov).convert('RGB')
        win.paste(cur, (int(round(cxp)), int(round(cyp))), cur)
        out = self.bg.copy()
        wa = np.asarray(win.convert('RGB')).astype(np.float32)
        out[y:y + h, x:x + w] = out[y:y + h, x:x + w] * (1 - self.mask) + wa * self.mask
        for text, a, e in b['_caps']:
            al = min(ease((t - a) / 0.6), ease((e - t) / 0.5))
            if al <= 0: continue
            dy = int(round((1 - ease((t - a) / 0.6)) * 10)) if t - a < 0.6 else 0
            c = self.caps[text]; band = out[dy:dy + CAP_H]
            alpha = c[..., 3:4] * al
            band[:] = band * (1 - alpha) + c[..., :3] * 255 * alpha
        return out

    def poster(self, path):
        np = self.np
        shot, (m, o) = POSTER_AT
        b = {'shot': shot, '_warp': [(0, self.shots[shot].marks[m] + o)], '_cam': [(0, FULL)],
             '_caps': [(POSTER_CAP, -10, 10)]}
        sh = self.shots[shot]; keep = sh.cur; sh.cur = [(0, -500, -500, False)]   # no pointer on the poster
        fr = self.app(b, 0); sh.cur = keep
        self.Image.fromarray(np.clip(fr, 0, 255).astype(np.uint8)).save(path, optimize=True)

    def beat(self, b, t):
        return self.card(b['card'], t) if 'card' in b else self.app(b, t)

    def frame(self, T):
        np = self.np
        live = [(b, t0, d) for b, (t0, d) in zip(BEATS, self.times) if t0 <= T < t0 + d]
        if not live: live = [(BEATS[-1], self.times[-1][0], self.times[-1][1])]
        if len(live) == 1:
            b, t0, _ = live[0]; return self.beat(b, T - t0)
        (b1, s1, d1), (b2, s2, _) = live[0], live[1]
        u = ease((T - s2) / XF)
        return self.beat(b1, T - s1) * (1 - u) + self.beat(b2, T - s2) * u


# ---- the music: composed and synthesized here ------------------------------------------------------
def music(total, sr=44100):
    """A slow piano-like piece over a soft pad: D major, four chords in 6/4, one per bar, the tempo set so that
    the fourth chord (A, the dominant) resolves to D exactly as the closing card comes in; that last chord
    rings out under it. Additive synthesis + a synthetic reverb; nothing sampled."""
    import numpy as np
    rng = np.random.default_rng(3)
    n = int(total * sr) + sr
    L = np.zeros(n); R = np.zeros(n)
    hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)
    close = beat_times()[0][-1][0] + 0.1          # the last chord lands with the closing card
    start = 0.35
    bar = (close - start) / 4                       # four bars: about 5.8 s each for the 30-second cut
    beat = bar / 6                                  # about 62 bpm
    # (bass root, pad voicing, arpeggio notes), MIDI numbers
    prog = [
        (38, [62, 66, 69, 73], [74, 78, 81, 85, 81, 78]),        # Dmaj7
        (35, [62, 66, 69, 71], [74, 78, 83, 81, 78, 74]),        # Bm7
        (43, [62, 66, 67, 71], [74, 79, 83, 86, 83, 79]),        # Gmaj7
        (45, [61, 64, 67, 69], [73, 76, 81, 79, 76, 73]),        # A7sus feel
    ]
    def piano(m, t, vel, pan):
        f = hz(m); dur = 4.0; k = int(dur * sr); tt = np.arange(k) / sr
        s = np.zeros(k)
        for p in range(1, 9):
            fp = f * p * math.sqrt(1 + 0.0004 * p * p)
            if fp > sr / 2.2: break
            s += (1 / p ** 1.6) * np.sin(2 * np.pi * fp * tt + rng.random()) * np.exp(-tt * (0.9 + 0.55 * p))
        att = np.minimum(1, tt / 0.006)
        s *= att * vel
        i = int(t * sr); j = min(n, i + k)
        L[i:j] += s[:j - i] * (1 - pan) ; R[i:j] += s[:j - i] * pan
    def pad(ms, t, dur, vol):
        k = int((dur + 3) * sr); tt = np.arange(k) / sr
        env = np.minimum(1, tt / 2.2) * np.where(tt < dur, 1, np.exp(-(tt - dur) / 1.0))
        for m in ms:
            for det, side in ((-0.06, 0), (0.06, 1)):
                f = hz(m) * 2 ** (det / 12)
                s = (np.sin(2 * np.pi * f * tt) + 0.18 * np.sin(4 * np.pi * f * tt)) * env * vol
                s *= 1 + 0.15 * np.sin(2 * np.pi * 0.18 * tt + rng.random() * 6)
                i = int(t * sr); j = min(n, i + k)
                (L if side == 0 else R)[i:j] += s[:j - i]
    t = start
    for c, (root, voicing, arp) in enumerate(prog):
        pad(voicing, t, bar, 0.022)
        pad([root], t, bar, 0.036)
        for q in range(6):
            if q in (0, 2, 3, 5) and (c > 0 or q >= 2):
                note = arp[(q + c) % len(arp)]
                piano(note, t + q * beat + rng.normal(0, 0.012), 0.14 + 0.06 * rng.random(), 0.35 + 0.3 * rng.random())
        t += bar
    # the last chord: D major 9, rolled
    pad([50, 62, 66, 69, 76], close, total - close - 1.0, 0.022)
    for i, m in enumerate([62, 69, 74, 78, 81, 88]):
        piano(m, close + 0.11 * i, 0.12 - 0.008 * i, 0.3 + 0.08 * i)
    # reverb: decaying filtered noise, a little different on each side
    def ir(seed):
        g = np.random.default_rng(seed); k = int(3.2 * sr); tt = np.arange(k) / sr
        x = g.standard_normal(k) * np.exp(-tt / 0.9)
        x = np.convolve(x, np.ones(9) / 9, mode='same'); x[0] = 0; return x / np.sqrt((x ** 2).sum())
    def conv(a, h):
        m = 1 << int(np.ceil(np.log2(len(a) + len(h))))
        return np.fft.irfft(np.fft.rfft(a, m) * np.fft.rfft(h, m), m)[:len(a)]
    wl, wr = conv(L, ir(1)), conv(R, ir(2))
    L, R = 0.75 * L + 0.55 * wl, 0.75 * R + 0.55 * wr
    # gentle low-pass, then fades
    k = np.ones(3) / 3; L = np.convolve(L, k, 'same'); R = np.convolve(R, k, 'same')
    tt = np.arange(n) / sr
    fade = np.minimum(1, tt / 1.2) * np.clip((total - tt) / 2.4, 0, 1) ** 1.5
    L *= fade; R *= fade
    st = np.stack([L, R], 1)[:int(total * sr)]
    st *= 10 ** (-20 / 20) / np.sqrt(np.mean(st ** 2))     # quiet: about -20 dBFS RMS
    peak = np.abs(st).max()
    if peak > 10 ** (-3 / 20): st *= 10 ** (-3 / 20) / peak
    return st, sr


def write_wav(path, st, sr):
    import wave, numpy as np
    pcm = (np.clip(st, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())


MAX_BYTES = 4_900_000      # GitHub's free plan takes videos up to 10 MB; keep well under 5 MB


def encode(ff, master, wav, out_mp4, crf):
    """The delivery file: H.264 High, level 4.0, yuv420p (BT.709, tagged), constant 30 fps, AAC-LC 128k stereo,
    moov atom up front (+faststart) so a browser starts playing before the download ends."""
    cmd = [ff, '-y', '-loglevel', 'error', '-i', master, '-i', wav,
           '-map', '0:v:0', '-map', '1:a:0',
           '-vf', 'scale=out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p',
           '-c:v', 'libx264', '-preset', 'veryslow', '-tune', 'animation', '-crf', str(crf),
           '-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p',
           '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
           '-r', str(FPS), '-fps_mode', 'cfr', '-x264-params', f'keyint={FPS * 2}:min-keyint={FPS}:force-cfr=1:colorprim=bt709:transfer=bt709:colormatrix=bt709',
           '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
           '-shortest', '-movflags', '+faststart', out_mp4]
    subprocess.run(cmd, check=True)


def compose(work, out_mp4):
    import imageio_ffmpeg
    import numpy as np
    C = Composer(work)
    total = C.total
    wav = os.path.join(work, 'music.wav'); st, sr = music(total); write_wav(wav, st, sr)
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    # first a lossless master (RGB, in the work folder), so the size search below doesn't redraw every frame
    master = os.path.join(work, 'master.mkv')
    cmd = [ff, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-',
           '-c:v', 'libx264rgb', '-qp', '0', '-preset', 'ultrafast', master]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    N = int(round(total * FPS))
    t0 = time.time()
    for i in range(N):
        fr = C.frame(i / FPS)
        p.stdin.write(np.clip(fr, 0, 255).astype(np.uint8).tobytes())
        if i % 150 == 0: print(f'  frame {i}/{N} ({time.time() - t0:.0f}s)', flush=True)
    p.stdin.close(); p.wait()
    for crf in (18, 20, 22, 24, 26, 28):     # the best quality that fits
        encode(ff, master, wav, out_mp4, crf)
        size = os.path.getsize(out_mp4)
        print(f'  crf {crf}: {size / 1e6:.2f} MB')
        if size <= MAX_BYTES: break
    print(f'{out_mp4}: {total:.1f}s, {os.path.getsize(out_mp4) / 1e6:.2f} MB')
    os.remove(master)


def stills(work, times, outdir):
    from PIL import Image
    import numpy as np
    C = Composer(work)
    for t in times:
        Image.fromarray(np.clip(C.frame(t), 0, 255).astype(np.uint8)).save(os.path.join(outdir, f'still_{t:05.1f}.png'))
    print('total', round(C.total, 2))


def run_capture(work):
    tmp = tempfile.mkdtemp(prefix='digress-film-')
    proc, url = start_server(tmp)
    try:
        asyncio.run(capture(os.path.join(work, 'shots'), tmp, url))
    finally:
        proc.terminate(); proc.wait(timeout=5); shutil.rmtree(tmp, ignore_errors=True)


async def _cards(work):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--no-sandbox'])
        await render_cards(b, os.path.join(work, 'cards')); await b.close()


def build(keep=None):
    work = keep or tempfile.mkdtemp(prefix='digress-film-work-')
    try:
        if not os.path.isdir(os.path.join(work, 'shots')): run_capture(work)
        if not os.path.isdir(os.path.join(work, 'cards')): asyncio.run(_cards(work))
        Composer(work).poster(os.path.join(HERE, 'poster.png'))
        compose(work, os.path.join(HERE, 'digress-film.mp4'))
    finally:
        if not keep: shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if cmd == 'all': build()
    elif cmd == '--keep': build(sys.argv[2])
    elif cmd == 'poster': Composer(sys.argv[2]).poster(sys.argv[3])
    elif cmd == 'capture': run_capture(sys.argv[2])
    elif cmd == 'cards': asyncio.run(_cards(sys.argv[2]))
    elif cmd == 'stills': stills(sys.argv[2], [float(x) for x in sys.argv[4:]], sys.argv[3])
    elif cmd == 'compose': compose(sys.argv[2], sys.argv[3])
