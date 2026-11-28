// The demo site's stand-in for server/server.mjs. demo/build.mjs puts this (and replies.js) in front of the real
// web/index.html, so the page that runs is the real one, unchanged: it calls /api/* as always, and this answers
// in the browser, with the same paths and shapes (agents/server.md has the contract).
//  - Everything is kept in this browser (IndexedDB): conversations, cards, layouts, files. Nothing is sent to Digress.
//  - By default, replies come from demo/replies.js (written in advance for the sample, otherwise quotes from the document).
//  - Optionally, a visitor can connect their own Google Gemini API key in Connections: requests go directly from this
//    browser to generativelanguage.googleapis.com (with streaming, document tools, and optional Google Search).
//    The key lives in memory for the current tab by default, or can be saved encrypted with a user password
//    (PBKDF2-SHA256 + AES-GCM-256 via Web Crypto) in IndexedDB.
//  - A small note explains the demo, can be hidden completely (brought back anytime from the sidebar), and offers "Start over".
// tests/test_demo.py builds the site and drives it, so a change to the page that breaks the demo fails the tests.
(() => {
  const realFetch = window.fetch.bind(window);
  const API = new URL('api/', document.baseURI).pathname;   // works both at root (workers.dev) and under a path
  const PBKDF2_ITER = 600000;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  // ---- the server's own code, run here: server/gemini.mjs (the Gemini API: request, stream, tool loop, errors,
  // models), doctools.mjs (the tools' sessions and their checks) and content.mjs (what a request may contain),
  // copied next to this file by demo/build.mjs. So a Gemini reply in the demo goes through exactly the code a
  // self-hosted one does; what's left here is the server's job of passing it a request and a place to write. ----
  const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');
  const here = document.currentScript.src;
  let sharedP = null;
  const shared = () => sharedP || (sharedP = Promise.all(['gemini', 'doctools', 'content'].map((n) => import(new URL(`server/${n}.mjs`, here).href)))
    .then(([G, D, C]) => { G.configure({ fetch: realFetch }); return { G, D, C }; }));

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
    batch: (fn) => tx('readwrite', (s) => { fn(s); }),
    async list(prefix) {
      const range = IDBKeyRange.bound(prefix, prefix + '\ufffd');
      const d = await db();
      return new Promise((ok, no) => {
        const t = d.transaction('kv', 'readonly'), s = t.objectStore('kv');
        let ks, vs;
        const rk = s.getAllKeys(range), rv = s.getAll(range);
        rk.onsuccess = () => { ks = rk.result; };
        rv.onsuccess = () => { vs = rv.result; };
        t.oncomplete = () => ok((ks || []).map((k, i) => [k.slice(prefix.length), vs[i]]));
        t.onerror = t.onabort = () => no(t.error || new Error('the demo’s storage refused it'));
      });
    },
    clear: () => tx('readwrite', (s) => s.clear()),
  };

  // ---- small metadata projections (updated in the same transaction as convs/ and file/) ----
  // Keeps sidebar ?meta, startup trash expiry, and file cleanup from loading full conversations or file bytes.
  const META_V = 1;
  const ASSET_RE = /"asset(?:Id)?":"([a-f0-9]{32})"/g;
  const assetRefs = (d) => [...new Set([...JSON.stringify(d).matchAll(ASSET_RE)].map((m) => m[1]))];
  function convSummary(id, c) {
    return {
      _meta: true,
      dropCards: !!c.dropCards,
      id: c.id || id,
      title: c.title,
      updated: c.updated,
      created: c.created,
      pinned: !!c.pinned,
      archived: !!c.archived,
      trashed: c.trashed || 0,
      folder: c.folder || '',
      system: typeof c.system === 'string' ? c.system : '',
      doc: !!c.doc,
      docName: c.doc ? c.doc.name || '' : '',
      asset: (c.doc && c.doc.assetId) || '',
      pins: Object.values(c.threads || {}).filter((t) => t && t.pinned).map((t) => ({ tid: t.id, title: t.title, ci: t.colorIdx })),
      _refs: assetRefs(c),
    };
  }
  const publicMeta = ({ _refs, ...m }) => m;
  const putConv = (id, c) => kv.batch((s) => { s.put(c, 'convs/' + id); s.put(convSummary(id, c), 'meta/convs/' + id); });
  const txConvWrite = async (id, fn) => {
    const d = await db();
    return new Promise((ok, no) => {
      const t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv');
      let out;
      const gr = s.get('convs/' + id);
      gr.onsuccess = () => {
        out = fn(gr.result || null);
        if (out && out.write) {
          s.put(out.write, 'convs/' + id);
          s.put(convSummary(id, out.write), 'meta/convs/' + id);
        }
      };
      t.oncomplete = () => ok(out);
      t.onerror = t.onabort = () => no(t.error || new Error('the demo’s storage refused it'));
    });
  };
  const txDocPatch = async (k, patch) => {
    const d = await db();
    return new Promise((ok, no) => {
      const t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv');
      let found = false;
      const gr = s.get(k);
      gr.onsuccess = () => {
        if (!gr.result) return;
        found = true;
        s.put({ ...gr.result, ...patch }, k);
      };
      t.oncomplete = () => ok(found);
      t.onerror = t.onabort = () => no(t.error || new Error('the demo’s storage refused it'));
    });
  };
  const delConv = (id) => kv.batch((s) => { s.delete('convs/' + id); s.delete('meta/convs/' + id); s.delete('layout/' + id); s.delete('index/' + id); });
  const putFile = (id, rec) => kv.batch((s) => { s.put(rec, 'file/' + id); s.put({ type: rec.type, at: rec.at || 0 }, 'meta/file/' + id); });
  const delFile = (id) => kv.batch((s) => { s.delete('file/' + id); s.delete('meta/file/' + id); });

  let metaReadyP = null;
  const ensureMeta = () => metaReadyP || (metaReadyP = (async () => {
    if ((await kv.get('metaV')) === META_V) return;
    const d = await db();
    // Backfill meta/convs/ and meta/file/ via cursors so large file payloads are streamed one at a time.
    await new Promise((ok, no) => {
      const t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv');
      const walk = (prefix, onItem, done) => {
        const cur = s.openCursor(IDBKeyRange.bound(prefix, prefix + '\ufffd'));
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) { done(); return; }
          onItem(String(c.key).slice(prefix.length), c.value);
          c.continue();
        };
      };
      walk('convs/', (id, c) => { if (c) s.put(convSummary(id, c), 'meta/convs/' + id); }, () => {
        walk('file/', (id, f) => { if (f) s.put({ type: f.type, at: f.at || 0 }, 'meta/file/' + id); }, () => {
          s.put(META_V, 'metaV');
        });
      });
      t.oncomplete = () => ok();
      t.onerror = t.onabort = () => no(t.error || new Error('the demo’s storage refused it'));
    });
  })());

  // ---- BYOK key state (private to this closure; never exposed on window or returned by /api/connections) ----
  let activeKey = null;          // decrypted Gemini API key, kept in memory only
  let keyGen = 0;                // incremented on Lock / Forget / key change to invalidate in-flight runs & caches
  let credOp = 0;                // monotonic credential transition counter so an older Unlock/Connect cannot beat a newer Forget/Lock
  let savedMeta = null;          // { last4 } if an encrypted key exists in IndexedDB ('byok/gemini')
  let pendingAction = null;      // { type: 'unlock'|'lock'|'forget', pass? } coordinated with #connModal
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveAes(passphrase, salt, iter, usage) {
    if (!crypto.subtle) throw new Error('Password encryption needs HTTPS (Web Crypto is unavailable here).');
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }
  async function encryptKey(apiKey, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aes = await deriveAes(passphrase, salt, PBKDF2_ITER, 'encrypt');
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(apiKey)));
    return { v: 1, iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct), last4: apiKey.slice(-4) };
  }
  async function decryptKey(rec, passphrase) {
    const aes = await deriveAes(passphrase, unb64(rec.salt), rec.iter || PBKDF2_ITER, 'decrypt');
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, aes, unb64(rec.ct));
      return dec.decode(pt);
    } catch {
      throw new Error('Wrong password. Try again, or forget the saved key and paste it again.');
    }
  }
  let metaLoaded = null;
  const loadSavedMeta = () => metaLoaded || (metaLoaded = (async () => {
    try { const r = await kv.get('byok/gemini'); savedMeta = r && r.ct ? { last4: r.last4 || '????' } : null; } catch { savedMeta = null; }
    syncDemoUi();
  })());

  // the models this key offers (gemini.mjs's list, cached there per key), none once the key has changed
  async function listGeminiModels(key, gen = keyGen) {
    if (!key || gen !== keyGen) return [];
    const list = await (await shared()).G.listModels(key);
    return gen === keyGen ? list : [];
  }
  const checkGeminiKey = async (key) => (await shared()).G.checkKey(key);

  // ---- the sample conversation, loaded once (again when a newer seed is published) ----
  let seeding = null;
  const seed = () => seeding || (seeding = (async () => {
    let s; try { s = await (await realFetch('demo/seed.json', { cache: 'no-cache' })).json(); } catch (e) { console.warn('demo: no sample conversation', e); return; }
    if ((await kv.get('seeded')) === s.v) return;
    // a newer sample replaces the old one: its conversations, and every card made from them (not only the cards it
    // came with), since a card whose conversation is gone has nothing to open. Not its files: the sample PDF keeps
    // its id from one sample to the next (make_sample.py), and a conversation kept from the old sample (the copy a
    // tab that had it open saves when it's gone) still uses it; sweepFiles below removes it only if nothing does.
    const old = (await kv.get('seededKeys')) || [], gone = new Set(old.filter((k) => k.startsWith('convs/')).map((k) => k.slice(6)));
    for (const k of old) {
      if (k.startsWith('convs/')) await delConv(k.slice(6));
      else if (!k.startsWith('file/')) await kv.del(k);
    }
    for (const [id, c] of await kv.list('cards/')) if (c && gone.has(c.conv)) await kv.del('cards/' + id);
    for (const [id, f] of Object.entries(s.files || {})) {
      await putFile(id, { type: f.type, buf: await (await realFetch(f.src)).arrayBuffer(), at: 0 });
    }
    for (const [k, v] of Object.entries(s.store || {})) {
      if (k.startsWith('convs/')) await putConv(k.slice(6), v);
      else await kv.put(k, v);
    }
    await kv.put('seededKeys', [...Object.keys(s.store || {}), ...Object.keys(s.files || {}).map((id) => 'file/' + id)]);
    await kv.put('seeded', s.v);
    if (old.length) await sweepFiles();   // the old sample's files, if nothing uses them any more
  })());

  // ---- as the real server: files nothing uses go (not ones just uploaded: the page uploads before it saves), and
  // the trash empties after TRASH_DAYS ----
  async function sweepFiles() {
    const used = new Set();
    for (const [, m] of await kv.list('meta/convs/')) if (m && Array.isArray(m._refs)) for (const id of m._refs) used.add(id);
    for (const [, d] of await kv.list('cards/')) for (const id of assetRefs(d)) used.add(id);
    for (const [id, f] of await kv.list('meta/file/')) if (!used.has(id) && Date.now() - ((f && f.at) || 0) > 10 * 60e3) await delFile(id);
  }
  const TRASH_DAYS = 7;
  let purged = null;
  const purgeTrash = () => purged || (purged = (async () => {
    let n = 0;
    for (const [id, m] of await kv.list('meta/convs/')) if (m && m.trashed && Date.now() - m.trashed > TRASH_DAYS * 864e5) {
      await delConv(id); n++;
      if (m.dropCards) for (const [kid, k] of await kv.list('cards/')) if (k && k.conv === id) await kv.del('cards/' + kid);
    }
    if (n) await sweepFiles();
  })());

  // ---- replies: Gemini (when a key is connected) or demo/replies.js ----
  const runs = new Map();
  let resetting = false;   // "Start over" was pressed
  function setActiveKey(nextKey) {
    keyGen++;
    activeKey = nextKey || null;
    for (const r of [...runs.values()]) { try { r.abort(); } catch { /* ignore */ } }
  }
  function chatDemo(body) {
    const ctrl = new AbortController();
    if (body.chat) runs.set(body.chat, ctrl);
    const quick = /^You (help someone find something|name notes)/.test(body.system || '');
    return new Response(new ReadableStream({
      cancel() { ctrl.abort(); },
      async start(c) {
        const line = (o) => { try { c.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch { ctrl.abort(); } };
        try {
          const text = window.DemoReplies.reply(body);
          await new Promise((r) => setTimeout(r, quick ? 0 : 350));
          for (const piece of text.match(/[\s\S]{1,9}/g) || []) {
            if (ctrl.signal.aborted) break;
            line({ d: piece });
            if (!quick) await new Promise((r) => setTimeout(r, 12));
          }
          line(ctrl.signal.aborted ? { stopped: 'stop' } : { done: true, model: 'demo', truncated: false });
        } catch (e) { line({ error: 'Demo reply failed: ' + ((e && e.message) || e) }); }
        runs.delete(body.chat); try { c.close(); } catch { /* already cancelled */ }
      },
    }), { headers: { 'content-type': 'application/x-ndjson' } });
  }

  // A reply from Gemini, as the server's handleChat makes one: the model (the default, as the server picks it), the
  // tools' session (doctools.mjs), then gemini.mjs's chat writing NDJSON lines into the response's stream. Stop, a
  // locked or changed key, or the page cancelling the stream all end it the same way.
  async function chatGemini(body) {
    const key = activeKey, gen = keyGen;
    if (!key) return chatDemo(body);
    const { G, D } = await shared();
    const list = await listGeminiModels(key, gen);
    if (gen !== keyGen) return json({ error: 'Gemini key was locked or changed.' }, 401);
    const prefs = (await kv.get('prefs')) || {};
    const model = body.model && body.model !== 'auto' && body.model !== 'demo' ? String(body.model) : G.defaultModel(list, prefs.defaultModel);
    if (!model) return json({ error: 'No Gemini models were returned for this key.' }, 502);
    const id = typeof body.chat === 'string' && /^[a-f0-9]{32}$/.test(body.chat) ? body.chat : randHex(16);
    if (runs.has(id)) return json({ error: 'That reply is already running.' }, 409);
    const session = D.openSession(id, D.pickTools(body.tools));
    const payload = { ...body, model, web: body.web === true, webListed: true, session };
    delete payload.tools; delete payload.chat; delete payload.save;
    return new Promise((resolve) => {
      let c = null, answered = false, closed = false, hb = 0;
      const closers = [];
      const out = (o) => { if (closed || !c) return; try { c.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch { stop(); } };
      const finish = () => {
        if (closed) return; closed = true; clearInterval(hb);
        if (session) session.close(); runs.delete(id);
        try { if (c) c.close(); } catch { /* cancelled */ }
      };
      const stream = () => { answered = true; resolve(new Response(new ReadableStream({ start(ctl) { c = ctl; }, cancel() { stop(); } }), { headers: { 'content-type': 'application/x-ndjson' } })); };
      const stop = () => {
        if (closed) return;
        for (const f of closers.splice(0)) { try { f(); } catch { /* ignore */ } }
        if (!answered) stream();
        out({ stopped: 'stop' }); finish();
      };
      runs.set(id, { abort: stop });
      const io = {
        onClose: (fn) => closers.push(fn),
        fail: (status, error) => { if (!answered) { answered = true; resolve(json({ error }, status)); } finish(); },
        start: () => { stream(); hb = setInterval(() => out({ hb: 1 }), 15000); return out; },   // heartbeats, as runs.mjs sends
        end: finish,
      };
      G.chat(payload, io, key).then(() => { if (!answered) stop(); }, (e) => {
        console.warn('demo: Gemini reply failed', e);
        if (!answered) { answered = true; resolve(json({ error: 'The demo failed while asking Gemini.' }, 500)); finish(); }
        else { out({ error: 'The demo failed while writing this reply.' }); finish(); }
      });
    });
  }

  function connectionPayload() {
    return {
      providers: [{
        id: 'gemini',
        name: 'Google Gemini',
        kind: 'key',
        on: !!activeKey,
        from: activeKey ? 'app' : undefined,
        last4: activeKey ? activeKey.slice(-4) : undefined,
      }],
    };
  }

  // ---- intercept /api/* ----
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(API)) return realFetch(input, init);
    await seed().catch((e) => console.warn('demo: the sample couldn’t be loaded', e));
    await ensureMeta().catch((e) => console.warn('demo: indexing metadata', e));
    await loadSavedMeta();
    await purgeTrash().catch((e) => console.warn('demo: emptying the trash', e));
    const method = (init.method || 'GET').toUpperCase();
    if (resetting && method !== 'GET') return json({ error: 'Starting over' }, 503);
    const p = url.pathname.slice(API.length).split('/').filter(Boolean).map(decodeURIComponent);
    const body = async () => JSON.parse(init.body);

    if (p[0] === 'health') {
      const on = !!activeKey;
      return json({ app: 'digress', llm: true, provider: on ? 'gemini' : 'demo', providers: on ? ['gemini'] : ['demo'], web: on, tools: on, why: '' });
    }
    if (p[0] === 'models') {
      if (!activeKey) return json({ models: [['demo', 'Demo replies']], defaultLabel: 'Demo replies', default: 'demo', chosen: 'auto' });
      const list = await listGeminiModels(activeKey);
      const prefs = (await kv.get('prefs')) || {};
      if (!list.length) return json({ models: [['demo', 'Demo replies']], defaultLabel: 'Demo replies', default: 'demo', chosen: 'auto' });
      const defId = (await shared()).G.defaultModel(list, prefs.defaultModel), chosen = prefs.defaultModel && prefs.defaultModel !== 'auto' && defId === prefs.defaultModel ? defId : 'auto';
      return json({ models: list, defaultLabel: (list.find(([x]) => x === defId) || [defId, defId])[1], default: defId, chosen });
    }
    if (p[0] === 'prefs') {
      if (method === 'PUT') {
        const d = await body(), cur = (await kv.get('prefs')) || {};
        const next = { ...cur, defaultModel: d.defaultModel || 'auto' };
        await kv.put('prefs', next);
        return json(next);
      }
      const cur = (await kv.get('prefs')) || {};
      return json({ defaultModel: cur.defaultModel || 'auto' });
    }
    if (p[0] === 'connections') {
      if (method === 'GET') return json(connectionPayload());
      if (p[1] !== 'gemini') return json({ error: 'Only Google Gemini is supported in the browser demo.' }, 404);
      if (method === 'PUT') {
        const op = ++credOp;
        const act = pendingAction; pendingAction = null;
        if (act && act.type === 'unlock') {
          const rec = await kv.get('byok/gemini');
          if (op !== credOp) return json(connectionPayload());
          if (!rec || !rec.ct) return json({ error: 'No saved key found in this browser.' }, 404);
          let key;
          try { key = await decryptKey(rec, act.pass); } catch (e) { return json({ error: e.message }, 400); }
          if (op !== credOp) return json(connectionPayload());
          const chk = await checkGeminiKey(key);
          if (op !== credOp) return json(connectionPayload());
          if (!chk.ok) return json({ error: chk.error }, 400);
          setActiveKey(key);
          dismissDemoNote(); syncDemoUi();
          return json(connectionPayload());
        }
        const d = await body(), key = String((d && d.key) || '').trim();
        if (!key) return json({ error: 'Paste a Gemini API key first.' }, 400);
        // read optional "Remember with password" controls from the modal
        const rem = document.querySelector('#connModal .demo-rem-cb');
        const passIn = document.querySelector('#connModal .demo-rem-pass');
        const wantSave = !!(rem && rem.checked), pass = passIn ? passIn.value : '';
        if (wantSave && pass.length < 4) return json({ error: 'Choose a password of at least 4 characters to encrypt the saved key (or uncheck Remember for session-only).' }, 400);
        const chk = await checkGeminiKey(key);
        if (op !== credOp) return json(connectionPayload());
        if (!chk.ok) return json({ error: chk.error }, 400);
        if (wantSave) {
          try {
            const encRec = await encryptKey(key, pass);
            if (op !== credOp) return json(connectionPayload());
            await kv.put('byok/gemini', encRec);
            if (op !== credOp) { await kv.del('byok/gemini'); savedMeta = null; return json(connectionPayload()); }
            savedMeta = { last4: encRec.last4 };
            if (passIn) passIn.value = '';
          } catch (e) { return json({ error: (e && e.message) || 'Could not encrypt key.' }, 400); }
        } else {
          await kv.del('byok/gemini'); savedMeta = null;
        }
        if (op !== credOp) return json(connectionPayload());
        setActiveKey(key);
        dismissDemoNote(); syncDemoUi();
        return json(connectionPayload());
      }
      if (method === 'DELETE') {
        credOp++;
        const act = pendingAction; pendingAction = null;
        setActiveKey(null);
        if (!act || act.type !== 'lock') {
          await kv.del('byok/gemini'); savedMeta = null;
        }
        syncDemoUi();
        return json(connectionPayload());
      }
      return json({ error: 'Method not allowed' }, 405);
    }
    if (p[0] === 'guide') return realFetch('demo/guide.json');
    if (p[0] === 'tools') return realFetch('demo/tools.json');
    if (p[0] === 'chat') {
      if (p[1] === 'stop') { const r = runs.get((await body()).chat); if (r) r.abort(); return json({ ok: true }); }
      if (p[1] === 'run') return json({ error: 'Not found' }, 404);   // replies here never outlive the page
      if (p[1] === 'tool') {
        const r = (await shared()).D.deliverResult(await body());   // as the server's /api/chat/tool: checked the same way
        return r.status === 200 ? json({ ok: true }) : json({ error: r.error }, r.status);
      }
      const b = await body();
      // checked as the server checks it (normalizeMessages): anything not understood is refused, never dropped
      let msgs; try { msgs = (await shared()).C.normalizeMessages(b && b.messages); } catch (e) { return json({ error: e.message }, e.status || 400); }
      return activeKey ? chatGemini({ ...b, messages: msgs }) : chatDemo(b);
    }
    if (p[0] === 'fetch-doc') return json({ error: 'The browser demo can’t fetch web links (CORS). Upload a PDF, Markdown or text file, or paste text instead.' }, 502);
    if (p[0] === 'layout') {
      const k = 'layout/' + p[1], d = (await kv.get(k)) || { devices: {} };
      if (method === 'GET') return json(d);
      d.devices[url.searchParams.get('device')] = { ui: await body(), at: Date.now() }; await kv.put(k, d); return json({ ok: true });
    }
    if (p[0] === 'store') {
      const coll = p[1], id = p[2], k = coll + '/' + id;
      if (!id) {
        if (coll === 'convs' && url.searchParams.has('meta')) {
          const rows = await kv.list('meta/convs/');
          return json(rows.map(([i, m]) => ({ id: i, data: publicMeta(m) })));
        }
        const rows = await kv.list(coll + '/');
        return json(rows.map(([i, data]) => ({ id: i, data })));
      }
      if (method === 'GET') {
        const cur = await kv.get(k);
        return cur ? json(url.searchParams.has('rev') ? { rev: cur.rev || 0 } : cur) : json({ error: 'Not found' }, 404);
      }
      if (method === 'PUT') {
        const d = await body();
        if (coll !== 'convs') { await kv.put(k, d); return json({ ok: true }); }
        const base = new Headers(init.headers || {}).get('x-base-rev');   // versions, as the real server
        const res = await txConvWrite(id, (cur) => {
          if (base !== null && !cur && Number(base) > 0) return { status: 410, body: { error: 'deleted' } };
          if (base !== null && cur && (cur.rev || 0) !== Number(base)) return { status: 409, body: { error: 'Changed elsewhere', current: cur } };
          d.rev = (cur ? cur.rev || 0 : 0) + 1;
          return { write: d, status: 200, body: { ok: true, rev: d.rev } };
        });
        return json(res.body, res.status);
      }
      if (method === 'PATCH') {
        const patch = await body();
        if (coll !== 'convs') {
          const ok = await txDocPatch(k, patch);
          return ok ? json({ ok: true }) : json({ error: 'Not found' }, 404);
        }
        const res = await txConvWrite(id, (cur) => {
          if (!cur) return { status: 404, body: { error: 'Not found' } };
          const next = { ...cur, ...patch, rev: (cur.rev || 0) + 1 };
          return { write: next, status: 200, body: { ok: true, rev: next.rev } };
        });
        return json(res.body, res.status);
      }
      if (method === 'DELETE') {
        if (coll === 'convs') { await delConv(id); await sweepFiles(); } else await kv.del(k);
        return json({ ok: true });
      }
    }
    if (p[0] === 'files') {
      if (method === 'POST') {
        const id = randHex(16);
        await putFile(id, { type: url.searchParams.get('type') || 'application/octet-stream', buf: await new Response(init.body).arrayBuffer(), at: Date.now() });
        return json({ id });
      }
      if (method === 'DELETE') { await delFile(p[1]); return json({ ok: true }); }
      const f = await kv.get('file/' + p[1]);
      return f ? new Response(f.buf || f.blob, { headers: { 'content-type': f.type } }) : json({ error: 'Not found' }, 404);
    }
    return json({ error: 'Not found' }, 404);
  };

  // ---- Connections modal enhancements: password encryption, unlock/lock, and clear privacy/security/MIT notice ----
  const DEMO_CSS = `#demoNote{position:fixed;left:12px;bottom:12px;z-index:60;max-width:345px;background:var(--panel);border:1px solid var(--line2);border-radius:10px;box-shadow:var(--shadow);padding:9px 30px 9px 12px;font:12.5px/1.45 var(--sans,system-ui);color:var(--muted)}
#demoNote b{color:var(--ink)}#demoNote a,#demoNote button.lk{color:var(--accent);background:none;border:0;padding:0;font:inherit;cursor:pointer;text-decoration:underline}
#demoNote .x{position:absolute;right:6px;top:5px;border:0;background:none;color:var(--faint);font-size:15px;cursor:pointer;padding:2px 5px}
#demoNote.small{padding:4px 10px;max-width:none}#demoNote.small .full,#demoNote:not(.small) .short{display:none}
#demoNote.hidden{display:none}
@media (max-width:700px){#demoNote{bottom:auto;top:52px;left:8px;right:8px;max-width:none}#demoNote.small{right:auto}}
#demoNote{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}#demoNote.dragging{cursor:grabbing;opacity:.92}#demoNote a,#demoNote button{cursor:pointer}
#demoSide{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;padding:7px 8px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font:12px/1.3 var(--sans,system-ui);color:var(--muted)}
#demoSide button{border:1px solid var(--line2);background:none;color:var(--ink);border-radius:6px;padding:3px 7px;font:inherit;cursor:pointer}
#demoSide button:hover{border-color:var(--accent);color:var(--accent)}
#demoSide .ds-main{font-weight:600;margin-right:auto;border-color:transparent;padding-left:2px;color:var(--muted)}
#demoSide .ds-main:hover{color:var(--ink);border-color:transparent}
#demoSide .ds-on{color:var(--accent)}
.demo-byok-box{margin-top:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font:12px/1.45 var(--sans,system-ui);color:var(--muted)}
.demo-byok-box b{color:var(--ink)}
.demo-byok-box ul{margin:4px 0 0;padding-left:16px}
.demo-byok-box li{margin:2px 0}
.demo-rem{margin-top:8px;display:flex;flex-direction:column;gap:6px;font:12px/1.4 var(--sans,system-ui);color:var(--muted)}
.demo-rem label{display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--ink)}
.demo-rem-pass{padding:6px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit;max-width:290px}
.demo-unlock{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.demo-unlock input{flex:1;min-width:170px;padding:6px 8px;border:1px solid var(--line2);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
.demo-sep{margin-top:8px;font:11.5px/1.3 var(--sans,system-ui);color:var(--faint)}`;

  function openConnectionsUi() {
    const pick = document.getElementById('mPick');
    if (!pick) return;
    pick.click();
    const btn = document.querySelector('.mmenu [data-conn]');
    if (btn) btn.click();
  }

  async function doReset() {
    if (!confirm('Start the demo over? This removes everything you did here (including any saved API key) and brings back the sample.')) return;
    resetting = true;
    activeKey = null; savedMeta = null;
    await kv.clear();
    try { localStorage.clear(); } catch { /* no storage */ }
    location.replace(location.href.split('#')[0]);
  }

  function enhanceConnectionsModal(modal) {
    const row = modal.querySelector('.cnrow[data-cid=gemini]');
    if (!row || row.dataset.demoEnhanced) return;
    row.dataset.demoEnhanced = '1';

    const state = row.querySelector('.cnstate');
    const note = row.querySelector('.cnnote');
    const act = row.querySelector('.cnact');

    if (activeKey && state) {
      state.textContent = `Connected · key ending …${activeKey.slice(-4)} (${savedMeta ? 'encrypted in this browser' : 'this tab only'})`;
    } else if (!activeKey && savedMeta && state) {
      state.textContent = `Locked · saved key ending …${savedMeta.last4}`;
    }

    if (note) {
      note.innerHTML = 'Calls Google’s Gemini API <b>directly from your browser</b> — there is no Digress server here, so your key, prompts, and documents never pass through us.';
      const box = document.createElement('div');
      box.className = 'demo-byok-box';
      box.innerHTML = '<b>Privacy, security &amp; terms</b><ul>'
        + '<li><b>Direct to Google:</b> requests go straight to <code>generativelanguage.googleapis.com</code>. Conversations and files stay in this browser’s IndexedDB.</li>'
        + '<li><b>Billing &amp; free tier:</b> you pay Google directly (set a low monthly spend limit and restrict the key to the Gemini API in AI Studio). On Google’s free tier, Google may use what you send to improve its products and web search isn’t included.</li>'
        + '<li><b>Security &amp; warranty:</b> open-source under the MIT License, provided “as is” without warranty. Browser extensions with page access or shared devices can still read an active key — self-host Digress for full local isolation.</li>'
        + '</ul>';
      note.after(box);
    }

    if (activeKey && act && savedMeta) {
      const lockBtn = document.createElement('button');
      lockBtn.type = 'button'; lockBtn.className = 'mbtn'; lockBtn.textContent = 'Lock now';
      lockBtn.title = 'Clear the decrypted key from memory (keeps the password-encrypted copy in this browser)';
      lockBtn.addEventListener('click', () => {
        pendingAction = { type: 'lock' };
        const rm = act.querySelector('[data-cx=remove]');
        if (rm) rm.click();
      });
      act.appendChild(lockBtn);
    }

    if (!activeKey && act) {
      // Hidden remove trigger for "Forget saved key" so web/index.html refreshes cleanly
      const hiddenRm = document.createElement('button');
      hiddenRm.type = 'button'; hiddenRm.dataset.cx = 'remove'; hiddenRm.dataset.cid = 'gemini'; hiddenRm.style.display = 'none';
      act.appendChild(hiddenRm);

      if (savedMeta) {
        const un = document.createElement('div');
        un.className = 'demo-unlock';
        un.innerHTML = `<input type="password" class="demo-unlock-pass" placeholder="Password to unlock key …${savedMeta.last4}" autocomplete="current-password">`
          + '<button type="button" class="mbtn primary" data-demo-unlock="1">Unlock</button>'
          + '<button type="button" class="mbtn" data-demo-forget="1">Forget saved key</button>';
        const doUnlock = () => {
          const inp = un.querySelector('.demo-unlock-pass');
          const pass = inp.value;
          if (!pass) { inp.focus(); return; }
          inp.value = '';
          pendingAction = { type: 'unlock', pass };
          const keyIn = act.querySelector('.cnkey'), addBtn = act.querySelector('[data-cx=add]');
          if (keyIn && addBtn) { keyIn.value = '__unlock__'; addBtn.click(); keyIn.value = ''; }
        };
        un.querySelector('[data-demo-unlock]').addEventListener('click', doUnlock);
        un.querySelector('.demo-unlock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doUnlock(); } });
        un.querySelector('[data-demo-forget]').addEventListener('click', () => {
          pendingAction = { type: 'forget' };
          hiddenRm.click();
        });
        act.before(un);
        const sep = document.createElement('div');
        sep.className = 'demo-sep';
        sep.textContent = 'Or paste a different Gemini API key:';
        act.before(sep);
      }

      const rem = document.createElement('div');
      rem.className = 'demo-rem';
      rem.innerHTML = '<label><input type="checkbox" class="demo-rem-cb"> Remember in this browser (encrypted with a password)</label>'
        + '<input type="password" class="demo-rem-pass" style="display:none" placeholder="Choose a password (min 4 chars)" autocomplete="new-password">'
        + '<span class="demo-rem-hint">Session only by default: kept in memory and cleared when you close or reload this tab.</span>';
      const cb = rem.querySelector('.demo-rem-cb'), pIn = rem.querySelector('.demo-rem-pass'), hint = rem.querySelector('.demo-rem-hint');
      cb.addEventListener('change', () => {
        pIn.style.display = cb.checked ? '' : 'none';
        hint.textContent = cb.checked
          ? 'Encrypted with PBKDF2-SHA256 + AES-256-GCM before saving. Your password is never stored.'
          : 'Session only by default: kept in memory and cleared when you close or reload this tab.';
        if (cb.checked) pIn.focus(); else pIn.value = '';
      });
      pIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = act.querySelector('[data-cx=add]'); if (b) b.click(); } });
      act.after(rem);
    }
  }

  // ---- floating demo note (dismissible) + sidebar Demo bar ----
  let noteEl = null, sideEl = null;
  const HIDDEN_KEY = 'digress:demo-note-hidden';
  function isNoteHidden() { try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } }
  function setNoteHidden(hide) {
    try { if (hide) localStorage.setItem(HIDDEN_KEY, '1'); else localStorage.removeItem(HIDDEN_KEY); } catch { /* no storage */ }
    if (noteEl) noteEl.classList.toggle('hidden', hide);
    syncDemoUi();
  }
  function dismissDemoNote() { setNoteHidden(true); }

  function syncDemoUi() {
    if (sideEl) {
      const m = sideEl.querySelector('.ds-main'), k = sideEl.querySelector('[data-demo=conn]');
      if (m) m.textContent = noteEl && noteEl.classList.contains('hidden') ? 'Demo note' : 'Demo';
      if (k) {
        k.classList.toggle('ds-on', !!activeKey);
        k.textContent = activeKey ? `Gemini …${activeKey.slice(-4)}` : (savedMeta ? 'Unlock key' : 'API key');
      }
    }
    demoTitle();
  }

  function mountUi() {
    const st = document.createElement('style'); st.textContent = DEMO_CSS; document.head.appendChild(st);

    // Floating demo note (can be minimized on phones, dragged anywhere, or hidden completely into the sidebar)
    const n = document.createElement('div'); n.id = 'demoNote'; noteEl = n;
    n.title = 'Drag to move it out of the way';
    n.innerHTML = `<div class="full"><b>This is a demo of Digress.</b> Replies are pre-written unless you <button class="lk" data-demo="conn">connect your own Gemini key</button> (sent straight from your browser to Google). No Digress server stores your data—conversations stay in this browser unless you share a link. <button class="lk" data-demo="reset">Start over</button> · <button class="lk" data-demo="dismiss" title="Hide this floating box (you can bring it back from the sidebar)">Hide</button> · <a href="https://github.com/NeejWeej/digress#readme" target="_blank" rel="noopener">Get Digress</a></div>
<div class="short"><button class="lk" data-demo="open">Demo</button> · <button class="lk" data-demo="reset">Start over</button> · <button class="lk" data-demo="dismiss" title="Hide this floating box (you can bring it back from the sidebar)">Hide</button></div><button class="x full" data-demo="hide" title="Make this smaller">×</button>`;
    let small = false; try { small = sessionStorage.getItem('digress:demo-note') === 'small'; } catch { /* no storage */ }
    n.classList.toggle('small', small);
    n.classList.toggle('hidden', isNoteHidden());
    n.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-demo]'); if (!a) return;
      if (a.dataset.demo === 'reset') return doReset();
      if (a.dataset.demo === 'conn') return openConnectionsUi();
      if (a.dataset.demo === 'dismiss') return setNoteHidden(true);
      const s = a.dataset.demo === 'hide'; n.classList.toggle('small', s);
      try { sessionStorage.setItem('digress:demo-note', s ? 'small' : 'big'); } catch { /* no storage */ }
    });
    const KEY = 'digress:demo-note-at', clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const place = (x, y) => {
      const r = n.getBoundingClientRect();
      x = clamp(x, 4, innerWidth - r.width - 4); y = clamp(y, 4, innerHeight - r.height - 4);
      Object.assign(n.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' }); return [x, y];
    };
    let drag = null, at = null;
    n.addEventListener('pointerdown', (e) => {
      if (e.button || e.target.closest('a,button')) return;
      const r = n.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      n.setPointerCapture(e.pointerId); n.classList.add('dragging'); e.preventDefault();
    });
    n.addEventListener('pointermove', (e) => { if (drag) at = place(e.clientX - drag.dx, e.clientY - drag.dy); });
    const end = () => {
      if (!drag) return; drag = null; n.classList.remove('dragging');
      if (at) try { sessionStorage.setItem(KEY, JSON.stringify(at)); } catch { /* no storage */ }
    };
    n.addEventListener('pointerup', end); n.addEventListener('pointercancel', end);
    document.body.appendChild(n);
    try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s) at = place(s[0], s[1]); } catch { /* no storage */ }
    addEventListener('resize', () => { if (at && !n.classList.contains('hidden')) at = place(at[0], at[1]); });

    // Compact sidebar bar (always accessible, never hovers over your panes)
    const side = document.getElementById('side');
    if (side) {
      const bar = document.createElement('div'); bar.id = 'demoSide'; sideEl = bar;
      bar.innerHTML = '<button type="button" class="ds-main" data-demo="toggle-note" title="Show or hide the floating demo note">Demo</button>'
        + '<button type="button" data-demo="conn" title="Connect or manage your Google Gemini API key (runs directly in your browser)">API key</button>'
        + '<button type="button" data-demo="reset" title="Clear this browser’s data and bring back the sample">Start over</button>';
      bar.addEventListener('click', (e) => {
        const a = e.target.closest('[data-demo]'); if (!a) return;
        if (a.dataset.demo === 'reset') return doReset();
        if (a.dataset.demo === 'conn') return openConnectionsUi();
        if (a.dataset.demo === 'toggle-note') {
          const nowHidden = noteEl && noteEl.classList.contains('hidden');
          setNoteHidden(!nowHidden);
          if (nowHidden && noteEl) noteEl.classList.remove('small');
        }
      });
      side.appendChild(bar);
    }

    // Watch #connModal (created by web/index.html) and enhance Gemini's row with browser-BYOK controls & notices
    const attachConn = (m) => {
      if (!m || m.dataset.demoWatched) return;
      m.dataset.demoWatched = '1';
      enhanceConnectionsModal(m);
      new MutationObserver(() => enhanceConnectionsModal(m)).observe(m, { childList: true, subtree: true });
    };
    const existing = document.getElementById('connModal');
    if (existing) attachConn(existing);
    else {
      const bo = new MutationObserver(() => {
        const m = document.getElementById('connModal');
        if (m) { attachConn(m); bo.disconnect(); }
      });
      bo.observe(document.body, { childList: true });
    }

    loadSavedMeta();
    syncDemoUi();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUi); else mountUi();

  // the tab always says it's the demo, with a Gemini key connected too (it's still this site, its storage, its limits)
  const demoTitle = () => { if (!document.title.startsWith('Demo · ')) document.title = 'Demo · ' + document.title; };
  const watchTitle = () => {
    const t = document.querySelector('title');
    demoTitle();
    if (t) new MutationObserver(demoTitle).observe(t, { childList: true, characterData: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTitle); else watchTitle();
})();
