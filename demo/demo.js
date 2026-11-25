// The demo site's stand-in for server/server.mjs. demo/build.mjs puts this (and replies.js) in front of the real
// web/index.html, so the page that runs is the real one, unchanged: it calls /api/* as always, and this answers
// in the browser, with the same paths and shapes (agents/server.md has the contract).
//  - Everything is kept in this browser (IndexedDB): conversations, cards, layouts, files. Nothing is sent anywhere.
//  - The first visit loads the sample conversation from demo/seed.json (made by demo/make_sample.py).
//  - Replies come from demo/replies.js: written in advance for the sample, otherwise quotes from the document.
//  - A small note says it's a demo, with "Start over" (clears this browser's copy) and a link to the real thing.
// tests/test_demo.py builds the site and drives it, so a change to the page that breaks the demo fails the tests.
(() => {
  const realFetch = window.fetch.bind(window);
  const API = new URL('api/', document.baseURI).pathname;   // the site may live under a path (user.github.io/digress/)
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  // ---- a key-value store in IndexedDB ----
  // Files are kept as bytes (ArrayBuffer), not Blobs: Safari's private browsing can't store a Blob in IndexedDB, and
  // then nothing loaded (the sample, its PDF).
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, no) => {
    const r = indexedDB.open('digress-demo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const tx = async (mode, f) => { const d = await db(); return new Promise((ok, no) => { const t = d.transaction('kv', mode), s = t.objectStore('kv'); let out; const r = f(s); if (r) r.onsuccess = () => { out = r.result; }; t.oncomplete = () => ok(out); t.onerror = t.onabort = () => no(t.error || new Error('the demo’s storage refused it')); }); };
  const kv = {
    get: (k) => tx('readonly', (s) => s.get(k)),
    put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    async list(prefix) {
      const range = IDBKeyRange.bound(prefix, prefix + '￿');
      const [ks, vs] = await Promise.all([tx('readonly', (s) => s.getAllKeys(range)), tx('readonly', (s) => s.getAll(range))]);
      return ks.map((k, i) => [k.slice(prefix.length), vs[i]]);
    },
    clear: () => tx('readwrite', (s) => s.clear()),
  };

  // ---- the sample conversation, loaded once (again when a newer seed is published) ----
  let seeding = null;
  const seed = () => seeding || (seeding = (async () => {
    let s; try { s = await (await realFetch('demo/seed.json', { cache: 'no-cache' })).json(); } catch (e) { console.warn('demo: no sample conversation', e); return; }
    if ((await kv.get('seeded')) === s.v) return;
    // a newer sample replaces the old one: its conversations, and every card made from them (not only the cards it
    // came with), since a card whose conversation is gone has nothing to open
    const old = (await kv.get('seededKeys')) || [], gone = new Set(old.filter((k) => k.startsWith('convs/')).map((k) => k.slice(6)));
    for (const k of old) await kv.del(k);
    for (const [id, c] of await kv.list('cards/')) if (c && gone.has(c.conv)) await kv.del('cards/' + id);
    for (const [id, f] of Object.entries(s.files || {})) {
      await kv.put('file/' + id, { type: f.type, buf: await (await realFetch(f.src)).arrayBuffer() });
    }
    for (const [k, v] of Object.entries(s.store || {})) await kv.put(k, v);
    await kv.put('seededKeys', [...Object.keys(s.store || {}), ...Object.keys(s.files || {}).map((id) => 'file/' + id)]);
    await kv.put('seeded', s.v);
  })());

  // ---- as the real server: files nothing uses go (not ones just uploaded: the page uploads before it saves), and
  // the trash empties after TRASH_DAYS ----
  async function sweepFiles() {
    const used = new Set();
    for (const coll of ['convs/', 'cards/']) for (const [, d] of await kv.list(coll)) for (const m of JSON.stringify(d).matchAll(/"asset(?:Id)?":"([a-f0-9]{32})"/g)) used.add(m[1]);
    for (const [id, f] of await kv.list('file/')) if (!used.has(id) && Date.now() - ((f && f.at) || 0) > 10 * 60e3) await kv.del('file/' + id);
  }
  const TRASH_DAYS = 7;
  let purged = null;
  const purgeTrash = () => purged || (purged = (async () => {
    let n = 0;
    for (const [id, c] of await kv.list('convs/')) if (c && c.trashed && Date.now() - c.trashed > TRASH_DAYS * 864e5) {
      await kv.del('convs/' + id); await kv.del('layout/' + id); await kv.del('index/' + id); n++;
      if (c.dropCards) for (const [kid, k] of await kv.list('cards/')) if (k && k.conv === id) await kv.del('cards/' + kid);
    }
    if (n) await sweepFiles();
  })());

  // ---- replies: demo/replies.js writes them; streamed in small pieces like a real reply ----
  const runs = new Map();
  let resetting = false;   // "Start over" was pressed (see note())
  function chat(body) {
    const enc = new TextEncoder(), ctrl = new AbortController();
    if (body.chat) runs.set(body.chat, ctrl);
    const quick = /^You (help someone find something|name notes)/.test(body.system || '');
    return new Response(new ReadableStream({
      cancel() { ctrl.abort(); },   // the page stopped reading
      async start(c) {
        const line = (o) => { try { c.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch (e) { ctrl.abort(); } };
        try {
          const text = window.DemoReplies.reply(body);
          await new Promise((r) => setTimeout(r, quick ? 0 : 350));   // a moment's "thinking"
          for (const piece of text.match(/[\s\S]{1,9}/g) || []) {
            if (ctrl.signal.aborted) break;
            line({ d: piece });
            if (!quick) await new Promise((r) => setTimeout(r, 12));
          }
          line(ctrl.signal.aborted ? { stopped: 'stop' } : { done: true, model: 'demo', truncated: false });
        } catch (e) { line({ error: 'Demo reply failed: ' + ((e && e.message) || e) }); }
        runs.delete(body.chat); try { c.close(); } catch (e) { /* already cancelled */ }
      },
    }), { headers: { 'content-type': 'application/x-ndjson' } });
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(API)) return realFetch(input, init);
    await seed().catch((e) => console.warn('demo: the sample couldn’t be loaded', e));
    await purgeTrash().catch((e) => console.warn('demo: emptying the trash', e));
    const method = (init.method || 'GET').toUpperCase();
    if (resetting && method !== 'GET') return json({ error: 'Starting over' }, 503);
    const p = url.pathname.slice(API.length).split('/').filter(Boolean).map(decodeURIComponent);
    const body = async () => JSON.parse(init.body);
    if (p[0] === 'health') return json({ app: 'digress', llm: true, provider: 'demo', providers: ['demo'], web: false, why: '' });
    if (p[0] === 'models') return json({ models: [['demo', 'Demo replies']], defaultLabel: 'Demo replies', default: 'demo', chosen: 'auto' });
    if (p[0] === 'prefs') return json({ defaultModel: 'auto' });
    if (p[0] === 'connections') return json({ error: 'This is the demo: there’s no server, and replies here were written in advance. In your own Digress, Connections is where you add an Anthropic or Gemini key.' }, 404);
    if (p[0] === 'guide') return realFetch('demo/guide.json');
    if (p[0] === 'tools') return realFetch('demo/tools.json');
    if (p[0] === 'chat') {
      if (p[1] === 'stop') { const r = runs.get((await body()).chat); if (r) r.abort(); return json({ ok: true }); }
      if (p[1] === 'run') return json({ error: 'Not found' }, 404);   // replies here never outlive the page
      if (p[1] === 'tool') return json({ ok: true });
      return chat(await body());
    }
    if (p[0] === 'fetch-doc') return json({ error: 'The demo can’t open links: in the real Digress its server fetches them. Open a PDF or paste text instead.' }, 502);
    if (p[0] === 'layout') {
      const k = 'layout/' + p[1], d = (await kv.get(k)) || { devices: {} };
      if (method === 'GET') return json(d);
      d.devices[url.searchParams.get('device')] = { ui: await body(), at: Date.now() }; await kv.put(k, d); return json({ ok: true });
    }
    if (p[0] === 'store') {
      const coll = p[1], id = p[2], k = coll + '/' + id;
      if (!id) return json((await kv.list(coll + '/')).map(([i, data]) => ({ id: i, data })));
      const cur = await kv.get(k);
      if (method === 'GET') return cur ? json(url.searchParams.has('rev') ? { rev: cur.rev || 0 } : cur) : json({ error: 'Not found' }, 404);
      if (method === 'PUT') {
        if (coll !== 'convs') { await kv.put(k, await body()); return json({ ok: true }); }
        const base = new Headers(init.headers || {}).get('x-base-rev');   // versions, as the real server
        if (base !== null && !cur && Number(base) > 0) return json({ error: 'deleted' }, 410);
        if (base !== null && cur && (cur.rev || 0) !== Number(base)) return json({ error: 'Changed elsewhere', current: cur }, 409);
        const d = await body(); d.rev = (cur ? cur.rev || 0 : 0) + 1; await kv.put(k, d); return json({ ok: true, rev: d.rev });
      }
      if (method === 'PATCH') { if (!cur) return json({ error: 'Not found' }, 404); await kv.put(k, { ...cur, ...(await body()) }); return json({ ok: true }); }
      if (method === 'DELETE') { await kv.del(k); if (coll === 'convs') { await kv.del('layout/' + id); await kv.del('index/' + id); await sweepFiles(); } return json({ ok: true }); }
    }
    if (p[0] === 'files') {
      if (method === 'POST') {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
        await kv.put('file/' + id, { type: url.searchParams.get('type') || 'application/octet-stream', buf: await new Response(init.body).arrayBuffer(), at: Date.now() });
        return json({ id });
      }
      if (method === 'DELETE') { await kv.del('file/' + p[1]); return json({ ok: true }); }
      const f = await kv.get('file/' + p[1]);
      return f ? new Response(f.buf || f.blob, { headers: { 'content-type': f.type } }) : json({ error: 'Not found' }, 404);   // (blob: saved before files were kept as bytes)
    }
    return json({ error: 'Not found' }, 404);
  };

  // ---- the note in the corner ----
  const NOTE_CSS = `#demoNote{position:fixed;left:12px;bottom:12px;z-index:60;max-width:330px;background:var(--panel);border:1px solid var(--line2);border-radius:10px;box-shadow:var(--shadow);padding:9px 30px 9px 12px;font:12.5px/1.45 var(--sans,system-ui);color:var(--muted)}
#demoNote b{color:var(--ink)}#demoNote a,#demoNote button.lk{color:var(--accent);background:none;border:0;padding:0;font:inherit;cursor:pointer;text-decoration:underline}
#demoNote .x{position:absolute;right:6px;top:5px;border:0;background:none;color:var(--faint);font-size:15px;cursor:pointer;padding:2px 5px}
#demoNote.small{padding:4px 10px;max-width:none}#demoNote.small .full,#demoNote:not(.small) .short{display:none}
@media (max-width:700px){#demoNote{bottom:auto;top:52px;left:8px;right:8px;max-width:none}#demoNote.small{right:auto}}
#demoNote{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}#demoNote.dragging{cursor:grabbing;opacity:.92}#demoNote a,#demoNote button{cursor:pointer}`;
  function note() {
    const st = document.createElement('style'); st.textContent = NOTE_CSS; document.head.appendChild(st);
    const n = document.createElement('div'); n.id = 'demoNote';
    n.title = 'Drag to move it out of the way';
    n.innerHTML = `<div class="full"><b>This is a demo of Digress.</b> There's no model behind it: the sample's replies were written in advance, and other questions get the closest passages of the document. Everything stays in this browser. <button class="lk" data-demo="reset">Start over</button> · <a href="https://github.com/NeejWeej/digress#readme" target="_blank" rel="noopener">Get Digress</a></div>
<div class="short"><button class="lk" data-demo="open">Demo</button> · <button class="lk" data-demo="reset">Start over</button></div><button class="x full" data-demo="hide" title="Make this smaller">×</button>`;
    let small = false; try { small = sessionStorage.getItem('digress:demo-note') === 'small'; } catch (e) { /* no storage */ }
    n.classList.toggle('small', small);
    n.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-demo]'); if (!a) return;
      if (a.dataset.demo === 'reset') {
        if (!confirm('Start the demo over? This removes everything you did here and brings back the sample.')) return;
        resetting = true;   // from here on this page saves nothing (a last save while it unloads would undo the reset)
        await kv.clear(); try { localStorage.clear(); } catch (err) { /* no storage */ }
        location.replace(location.href.split('#')[0]); return;   // one navigation: the page without its #c=… (a hash change then a reload is two)
      }
      const s = a.dataset.demo === 'hide'; n.classList.toggle('small', s);
      try { sessionStorage.setItem('digress:demo-note', s ? 'small' : 'big'); } catch (err) { /* no storage */ }
    });
    // drag it anywhere (it can sit over the keyboard shortcuts or a pane's buttons); where it was is kept for this tab
    const KEY = 'digress:demo-note-at', clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const place = (x, y) => { const r = n.getBoundingClientRect();
      x = clamp(x, 4, innerWidth - r.width - 4); y = clamp(y, 4, innerHeight - r.height - 4);
      Object.assign(n.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' }); return [x, y]; };
    let drag = null, at = null;
    n.addEventListener('pointerdown', (e) => {
      if (e.button || e.target.closest('a,button')) return;
      const r = n.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      n.setPointerCapture(e.pointerId); n.classList.add('dragging'); e.preventDefault();
    });
    n.addEventListener('pointermove', (e) => { if (drag) at = place(e.clientX - drag.dx, e.clientY - drag.dy); });
    const end = () => { if (!drag) return; drag = null; n.classList.remove('dragging');
      if (at) try { sessionStorage.setItem(KEY, JSON.stringify(at)); } catch (err) { /* no storage */ } };
    n.addEventListener('pointerup', end); n.addEventListener('pointercancel', end);
    document.body.appendChild(n);
    try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s) at = place(s[0], s[1]); } catch (err) { /* no storage */ }
    addEventListener('resize', () => { if (at) at = place(at[0], at[1]); });   // still on screen after the window shrinks
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', note); else note();

  // the tab says it's the demo, so it can't be mistaken for your own Digress: the page names the tab itself
  // (tabName: "<title> · Digress"), so put "Demo · " in front whenever it does
  const demoTitle = () => { if (!document.title.startsWith('Demo · ')) document.title = 'Demo · ' + document.title; };
  const watchTitle = () => { const t = document.querySelector('title'); demoTitle(); if (t) new MutationObserver(demoTitle).observe(t, { childList: true, characterData: true, subtree: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTitle); else watchTitle();
})();
