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
  const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
  const MAX_OUTPUT = 16000, WAIT_MS = 90000, RETRY_MS = 2000;
  const PBKDF2_ITER = 600000;
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
      const range = IDBKeyRange.bound(prefix, prefix + '\ufffd');
      const [ks, vs] = await Promise.all([tx('readonly', (s) => s.getAllKeys(range)), tx('readonly', (s) => s.getAll(range))]);
      return ks.map((k, i) => [k.slice(prefix.length), vs[i]]);
    },
    clear: () => tx('readwrite', (s) => s.clear()),
  };

  // ---- BYOK key state (private to this closure; never exposed on window or returned by /api/connections) ----
  let activeKey = null;          // decrypted Gemini API key, kept in memory only
  let savedMeta = null;          // { last4 } if an encrypted key exists in IndexedDB ('byok/gemini')
  let pendingAction = null;      // { type: 'unlock'|'lock'|'forget', pass? } coordinated with #connModal
  let modelsCache = null;        // { key, at, list }
  const windows = new Map();     // model id -> inputTokenLimit
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

  // ---- Gemini API helpers (matching server/gemini.mjs) ----
  const SPECIAL = /embedding|image|imagen|nano-banana|omni|tts|audio|live|transcribe|aqa|veo|lyria|genie|robotics|computer-use/i;
  const SEARCH_REFUSED = /google_?search|grounding|function calling is unsupported|server_?side_?tool_?invocations/i;
  const REDIRECT = /\[([^\]\n]{1,300})\]\((https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=%.~]+)\)/g;
  const THINKING = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

  function groundedLinks(text) {
    const out = [], seen = new Set();
    for (const m of String(text || '').matchAll(REDIRECT)) {
      if (seen.has(m[2])) continue; seen.add(m[2]);
      out.push({ title: m[1].replace(/[*_`]/g, '').trim() || 'Source', url: m[2] });
    }
    return out;
  }
  function geminiError(txt, status, web) {
    let msg = ''; try { const j = JSON.parse(txt); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; msg = (e && e.message) || ''; } catch { /* not JSON */ }
    if (status === 503) return 'Gemini is busy right now (Google says this model is in high demand). Try again in a little while, or pick another model.';
    if (status === 429 && web) return 'Google refused this for quota. With Web on, that’s usually because web search isn’t included on Gemini’s free tier: turn Web off and try again (or use a paid key). If it happens with Web off too, you’ve reached the free tier’s request limit; wait a minute.';
    if (status === 429) return 'Gemini’s rate limit was reached (free-tier keys allow only a few requests a minute, and a daily cap). Wait a little and try again.';
    if (/API key not valid|API_KEY_INVALID/i.test(msg) || status === 401) return 'Google rejected the Gemini API key. Check it in Connections.';
    if (status === 403) return 'Google refused this request with this key' + (msg ? ': ' + msg : '.') + ' (A Google Cloud API key has to be restricted to the Gemini API; keys made in AI Studio work as they are.)';
    if (SEARCH_REFUSED.test(msg) && status === 400) return 'This Gemini key or model can’t search the web (Google Search isn’t available on the free tier). Turn Web off, or use a paid key.';
    return msg ? 'Gemini: ' + msg : 'The Gemini request failed (' + status + ').';
  }
  async function checkGeminiKey(key) {
    try {
      const r = await realFetch(GEMINI_API + '/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
      if (r.ok) return { ok: true };
      return { error: geminiError(await r.text(), r.status) };
    } catch (e) { return { error: 'Could not reach Google: ' + ((e && e.message) || e) }; }
  }
  async function listGeminiModels(key) {
    if (!key) return [];
    if (modelsCache && modelsCache.key === key && Date.now() - modelsCache.at < 10 * 60e3) return modelsCache.list;
    let list = [];
    try {
      const r = await realFetch(GEMINI_API + '/models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
      if (r.ok) {
        const ms = ((await r.json()).models || []).filter((m) => /^models\/gemini/.test(m.name || '') && (m.supportedGenerationMethods || []).includes('generateContent') && !SPECIAL.test(m.name));
        list = ms.map((m) => [m.name.slice(7), m.displayName || m.name.slice(7)]);
        for (const m of ms) if (Number.isFinite(m.inputTokenLimit)) windows.set(m.name.slice(7), m.inputTokenLimit);
      }
    } catch (e) { console.warn('demo: Gemini model list failed', e); }
    modelsCache = { key, at: Date.now(), list };
    return list;
  }
  function pickDefaultModel(list, chosen) {
    if (!list.length) return ['demo', 'Demo replies', 'auto'];
    if (chosen && chosen !== 'auto') {
      const hit = list.find(([id]) => id === chosen);
      if (hit) return [hit[0], hit[1], chosen];
    }
    const pref = list.find(([id]) => id === 'gemini-2.5-flash')
      || list.find(([id]) => /flash/i.test(id) && !/lite|preview|exp/i.test(id))
      || list.find(([id]) => /flash/i.test(id))
      || list[0];
    return [pref[0], pref[1], 'auto'];
  }
  function toParts(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return Array.isArray(content) ? content : [];
  }
  const toGemini = (msgs) => (msgs || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: toParts(m.content).filter((p) => p && (p.type !== 'text' || p.text !== '')).map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data } })),
  })).filter((c) => c.parts.length);
  function plainSchema(s) {
    if (Array.isArray(s)) return s.map(plainSchema);
    if (!s || typeof s !== 'object') return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) if (k !== 'additionalProperties') out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, plainSchema(x)])) : plainSchema(v);
    return out;
  }
  const toolDecls = (tools) => [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: plainSchema(t.schema) })) }];
  function resultParts(r, name, id) {
    const text = (r.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n') || '(empty)';
    const images = (r.parts || []).filter((p) => p.type === 'image').map((p) => ({ inlineData: { mimeType: p.mediaType, data: p.data } }));
    return [{ functionResponse: { ...(id ? { id } : {}), name, response: r.error ? { error: text } : { result: text } } }, ...images];
  }
  function geminiRequestBody({ system, contents, effort, web, session, final }, withEffort, withSearch) {
    const body = { contents, generationConfig: { maxOutputTokens: MAX_OUTPUT } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (withEffort && THINKING[effort]) body.generationConfig.thinkingConfig = { thinkingLevel: THINKING[effort] };
    const tools = [...(session ? toolDecls(session.tools) : []), ...(web && withSearch ? [{ googleSearch: {} }] : [])];
    if (tools.length) body.tools = tools;
    if (session) body.toolConfig = { functionCallingConfig: { mode: final ? 'NONE' : 'AUTO' } };
    if (session && web && withSearch) body.toolConfig.includeServerSideToolInvocations = true;
    return body;
  }

  // ---- in-browser tool sessions (same limits and contract as server/doctools.mjs) ----
  let toolsMetaP = null;
  const loadToolsMeta = () => toolsMetaP || (toolsMetaP = realFetch('demo/tools.json').then((r) => r.json()).catch(() => ({ tools: [], maxCalls: 30, maxCards: 10 })));
  const toolSessions = new Map();
  const failedTool = (text) => ({ error: true, parts: [{ type: 'text', text }] });
  const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');

  async function openToolSession(chatId, want, emit) {
    if (!chatId || !want) return null;
    const meta = await loadToolsMeta();
    const docNames = new Set(['search', 'read_pages', 'view_page']);
    const tools = want === true ? meta.tools.filter((t) => docNames.has(t.name))
      : Array.isArray(want) ? meta.tools.filter((t) => want.includes(t.name)) : [];
    if (!tools.length) return null;
    const maxCalls = meta.maxCalls || 30, maxCards = meta.maxCards || 10, maxRounds = maxCalls + 3;
    const names = new Set(tools.map((t) => t.name));
    const s = { chatId, tools, maxRounds, calls: 0, cards: 0, pending: new Map(), closed: false };
    s.call = (name, input) => {
      if (s.closed) return Promise.resolve(failedTool('The reader stopped this reply.'));
      if (!names.has(name)) return Promise.resolve(failedTool(`There is no tool called "${name}". The tools are: ${[...names].join(', ')}.`));
      const isCard = name === 'suggest_card';
      if (isCard) { if (++s.cards > maxCards) return Promise.resolve(failedTool(`That is the limit of ${maxCards} suggested cards for one answer.`)); }
      else if (++s.calls > maxCalls) return Promise.resolve(failedTool(`That is the limit of ${maxCalls} document tool calls for one answer. Answer now with what you have, and say plainly which parts of the document you did not get to read.`));
      const id = randHex(8);
      emit({ tool: { id, name, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {} } });
      return new Promise((resolve) => {
        const timer = setTimeout(() => done(failedTool('The browser did not return this tool result in time.')), 120000);
        const done = (r) => {
          clearTimeout(timer); s.pending.delete(id);
          const left = isCard ? 99 : maxCalls - s.calls;
          if (left <= 3) r = { ...r, parts: [...(r.parts || []), { type: 'text', text: left ? `(${left} document tool call${left > 1 ? 's' : ''} left for this answer.)` : '(That was the last document tool call for this answer: answer now with what you have, and say what you didn’t get to read.)' }] };
          resolve(r);
        };
        s.pending.set(id, done);
      });
    };
    s.close = () => {
      if (s.closed) return;
      s.closed = true;
      for (const done of [...s.pending.values()]) done(failedTool('The reply was stopped.'));
      toolSessions.delete(chatId);
    };
    toolSessions.set(chatId, s);
    return s;
  }

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

  // ---- replies: Gemini (when a key is connected) or demo/replies.js ----
  const runs = new Map();
  let resetting = false;   // "Start over" was pressed
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

  async function chatGemini(body) {
    const key = activeKey;
    if (!key) return chatDemo(body);
    const list = await listGeminiModels(key);
    const prefs = (await kv.get('prefs')) || {};
    const [defId] = pickDefaultModel(list, prefs.defaultModel);
    const model = body.model && body.model !== 'auto' && body.model !== 'demo' ? body.model : defId;
    if (!model || model === 'demo') return json({ error: 'No Gemini models were returned for this key.' }, 502);

    const ctrl = new AbortController();
    let stopped = false, session = null;
    const stopAll = () => { stopped = true; ctrl.abort(); if (session) session.close(); };
    if (body.chat) runs.set(body.chat, { abort: stopAll });

    return new Response(new ReadableStream({
      cancel() { stopAll(); },
      async start(c) {
        const line = (o) => { try { c.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch { stopAll(); } };
        const hb = setInterval(() => { if (!stopped) line({ hb: 1 }); }, 15000);
        try {
          session = await openToolSession(body.chat, body.tools, line);
          let contents = toGemini(body.messages), final = false, withEffort = true, withSearch = true;
          const NO_ANSWER = `Gemini hasn’t answered in ${Math.round(WAIT_MS / 1000)} seconds (Google may be overloaded). Try again in a little while, or pick another model.`;
          const once = async () => {
            const reqCtrl = new AbortController();
            const onStop = () => reqCtrl.abort();
            ctrl.signal.addEventListener('abort', onStop, { once: true });
            const t = setTimeout(() => reqCtrl.abort(new Error('no answer')), WAIT_MS);
            try {
              return await realFetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
                method: 'POST', signal: reqCtrl.signal,
                headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify(geminiRequestBody({ system: body.system, contents, effort: body.effort, web: !!body.web, session, final }, withEffort, withSearch)),
              });
            } finally { clearTimeout(t); ctrl.signal.removeEventListener('abort', onStop); }
          };
          const send = async () => {
            for (let i = 0; ; i++) {
              const t0 = Date.now(), r = await once();
              if (r.status !== 503 || i >= 2 || Date.now() - t0 > 15000 || stopped) return r;
              await r.text().catch(() => {});
              await new Promise((ok) => setTimeout(ok, RETRY_MS * (i + 1)));
              if (stopped) return r;
            }
          };

          let up;
          try {
            up = await send();
            while (up.status === 400) {
              const txt = await up.text();
              if (withEffort && /thinking/i.test(txt)) withEffort = false;
              else if (withSearch && body.web && session && SEARCH_REFUSED.test(txt)) withSearch = false;
              else { line({ error: geminiError(txt, 400, body.web && withSearch) }); return; }
              up = await send();
            }
          } catch (e) {
            if (stopped) { line({ stopped: 'stop' }); return; }
            line({ error: e && e.name === 'AbortError' ? NO_ANSWER : 'Could not reach Google: ' + ((e && e.message) || e) });
            return;
          }
          if (!up.ok) { line({ error: geminiError(await up.text(), up.status, body.web && withSearch) }); return; }

          const st = { any: false, usage: null, lastUsage: null, end: null, text: '', gotSources: false };
          const emitSources = (srcs) => {
            const clean = srcs.filter((x) => x && /^https?:\/\//i.test(x.url));
            if (clean.length) { st.gotSources = true; line({ sources: clean }); }
          };

          for (let round = 0; ; round++) {
            const modelParts = [], calls = [];
            let finish = null; const searched = new Set();
            try {
              const rd = up.body.getReader(), sdec = new TextDecoder();
              let buf = '';
              for (;;) {
                const { value, done } = await rd.read();
                if (done) break;
                if (stopped) { rd.cancel().catch(() => {}); break; }
                buf += sdec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                  const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                  if (!ln.startsWith('data:')) continue;
                  let ev; try { ev = JSON.parse(ln.slice(5)); } catch { continue; }
                  if (ev.error) { st.end = { error: geminiError(JSON.stringify(ev), ev.error.code || 500) }; continue; }
                  if (ev.usageMetadata) st.lastUsage = ev.usageMetadata;
                  const cand = (ev.candidates || [])[0];
                  if (!cand) continue;
                  for (const p of (cand.content && cand.content.parts) || []) {
                    modelParts.push(p);
                    if (p.thought) continue;
                    if (typeof p.text === 'string' && p.text) { st.any = true; st.text += p.text; line({ d: p.text }); }
                    if (p.functionCall) calls.push(p.functionCall);
                  }
                  const g = cand.groundingMetadata;
                  if (g) {
                    for (const q of g.webSearchQueries || []) if (!searched.has(q)) { searched.add(q); line({ search: String(q).slice(0, 500) }); }
                    emitSources((g.groundingChunks || []).map((x) => x.web).filter(Boolean).map((w) => ({ title: w.title, url: w.uri })));
                  }
                  if (cand.finishReason) finish = cand.finishReason;
                }
              }
            } catch {
              if (stopped) { line({ stopped: 'stop' }); return; }
              st.end = { error: 'The connection to Gemini was interrupted.' };
            }
            if (stopped) { line({ stopped: 'stop' }); return; }
            if (st.lastUsage) {
              const u = st.lastUsage, g = st.usage || (st.usage = { ctx: 0, cached: 0, out: 0, rounds: 0 });
              g.rounds++; g.ctx = u.promptTokenCount || 0; g.cached = u.cachedContentTokenCount || 0; g.out += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
              st.lastUsage = null;
            }
            if (st.end && st.end.error) break;
            if (calls.length && session && !final) {
              if (round + 1 >= session.maxRounds) final = true;
              const resp = [];
              for (const fc of calls) resp.push(...resultParts(await session.call(fc.name, fc.args || {}), fc.name, fc.id));
              if (stopped) { line({ stopped: 'stop' }); return; }
              contents = [...contents, { role: 'model', parts: modelParts }, { role: 'user', parts: resp }];
              try { up = await send(); } catch (e) {
                if (stopped) { line({ stopped: 'stop' }); return; }
                st.end = { error: e && e.name === 'AbortError' ? NO_ANSWER : 'Could not reach Google: ' + ((e && e.message) || e) };
                break;
              }
              if (!up.ok) { st.end = { error: geminiError(await up.text(), up.status, body.web && withSearch) }; break; }
              continue;
            }
            if (/SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII/.test(finish || '') && !st.any) st.end = { error: 'Gemini didn’t answer this (its ' + finish.toLowerCase() + ' filter stopped it).' };
            else st.end = { done: true, truncated: finish === 'MAX_TOKENS' };
            break;
          }
          if (st.end && st.end.error) line({ error: st.end.error });
          else {
            if (!st.gotSources && body.web) {
              const found = groundedLinks(st.text);
              if (found.length) emitSources(found);
            }
            const w = windows.get(model), u = st.usage;
            line({ done: true, model, truncated: !!(st.end && st.end.truncated), ...(u ? { usage: { ctx: u.ctx, cached: u.cached, out: u.out, rounds: u.rounds, ...(w ? { window: w } : {}) } } : {}) });
          }
        } finally {
          clearInterval(hb);
          if (session) session.close();
          runs.delete(body.chat);
          try { c.close(); } catch { /* already closed */ }
        }
      },
    }), { headers: { 'content-type': 'application/x-ndjson' } });
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
      const [defId, defLabel, chosen] = pickDefaultModel(list, prefs.defaultModel);
      return json({ models: list.length ? list : [['demo', 'Demo replies']], defaultLabel: defLabel, default: defId, chosen });
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
        const act = pendingAction; pendingAction = null;
        if (act && act.type === 'unlock') {
          const rec = await kv.get('byok/gemini');
          if (!rec || !rec.ct) return json({ error: 'No saved key found in this browser.' }, 404);
          let key;
          try { key = await decryptKey(rec, act.pass); } catch (e) { return json({ error: e.message }, 400); }
          const chk = await checkGeminiKey(key);
          if (!chk.ok) return json({ error: chk.error }, 400);
          activeKey = key; modelsCache = null;
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
        if (!chk.ok) return json({ error: chk.error }, 400);
        if (wantSave) {
          try {
            const encRec = await encryptKey(key, pass);
            await kv.put('byok/gemini', encRec);
            savedMeta = { last4: encRec.last4 };
            if (passIn) passIn.value = '';
          } catch (e) { return json({ error: (e && e.message) || 'Could not encrypt key.' }, 400); }
        } else {
          await kv.del('byok/gemini'); savedMeta = null;
        }
        activeKey = key; modelsCache = null;
        dismissDemoNote(); syncDemoUi();
        return json(connectionPayload());
      }
      if (method === 'DELETE') {
        const act = pendingAction; pendingAction = null;
        activeKey = null; modelsCache = null;
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
        const b = await body(), s = b && toolSessions.get(b.chat), done = s && s.pending.get(b && b.id);
        if (!done) return json({ error: 'No tool call waiting' }, 404);
        if (typeof b.error === 'string') done(failedTool(b.error.slice(0, 4000)));
        else done({ error: false, parts: Array.isArray(b.parts) ? b.parts : [] });
        return json({ ok: true });
      }
      const b = await body();
      return activeKey ? chatGemini(b) : chatDemo(b);
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
        const rows = await kv.list(coll + '/');
        if (coll === 'convs' && url.searchParams.has('meta')) {
          return json(rows.map(([i, c]) => ({ id: i, data: { _meta: true, dropCards: !!c.dropCards, id: c.id || i, title: c.title, updated: c.updated, created: c.created, pinned: !!c.pinned, archived: !!c.archived, trashed: c.trashed || 0, folder: c.folder || '', system: typeof c.system === 'string' ? c.system : '', doc: !!c.doc, docName: c.doc ? c.doc.name || '' : '', asset: (c.doc && c.doc.assetId) || '', pins: Object.values(c.threads || {}).filter((t) => t && t.pinned).map((t) => ({ tid: t.id, title: t.title, ci: t.colorIdx })) } })));
        }
        return json(rows.map(([i, data]) => ({ id: i, data })));
      }
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
        const id = randHex(16);
        await kv.put('file/' + id, { type: url.searchParams.get('type') || 'application/octet-stream', buf: await new Response(init.body).arrayBuffer(), at: Date.now() });
        return json({ id });
      }
      if (method === 'DELETE') { await kv.del('file/' + p[1]); return json({ ok: true }); }
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
    activeKey = null; savedMeta = null; modelsCache = null;
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
    n.innerHTML = `<div class="full"><b>This is a demo of Digress.</b> Replies are pre-written unless you <button class="lk" data-demo="conn">connect your own Gemini key</button> (runs straight from your browser). Everything stays local. <button class="lk" data-demo="reset">Start over</button> · <button class="lk" data-demo="dismiss" title="Hide this floating box (you can bring it back from the sidebar)">Hide</button> · <a href="https://github.com/NeejWeej/digress#readme" target="_blank" rel="noopener">Get Digress</a></div>
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

  // the tab says it's the demo when no real key is connected
  const demoTitle = () => {
    if (!activeKey && !document.title.startsWith('Demo · ')) document.title = 'Demo · ' + document.title;
    else if (activeKey && document.title.startsWith('Demo · ')) document.title = document.title.slice(7);
  };
  const watchTitle = () => {
    const t = document.querySelector('title');
    demoTitle();
    if (t) new MutationObserver(demoTitle).observe(t, { childList: true, characterData: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTitle); else watchTitle();
})();
