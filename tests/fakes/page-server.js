// A stand-in for server/server.mjs that runs inside the test page, so the UI tests can drive the app
// without starting Node. common.goto_app() serves web/index.html at http://digress.test/ and injects
// this before the page's scripts; it answers the page's /api/* requests the way the real server does
// (same paths and shapes; agents/server.md has the contract). tests/test_server.py and test_context.py
// cover the real server.
//
// The fake model is whatever the test puts in window.fakeLLM:
//   window.fakeLLM = { use: async (name) => name === 'sample' ? async (messages, opts) => ({text, truncated}) : null }
// It gets the conversation with the system prompt folded into the first message, and
// opts = {model, effort, web, signal, onText({text}), onSearch(query), tools, callTool(name, input)}; call onText
// with the text so far to stream, onSearch to report a web search the way the server does. With window.fakeTools
// set, health says tools work; tools is what the page offered (names) and callTool runs one in the page as the
// server does ({tool} down the stream, the page posts api/chat/tool), resolving to {parts} or {error}.
// Until window.fakeLLM exists, /api/health waits (up to 6 s), like a server that is slow to start.
// Conversations, the search index and files are kept in localStorage, so they survive a reload.
(() => {
  const realFetch = window.fetch.bind(window);
  const runs = new Map();   // chat id -> AbortController, for Stop
  const toolWait = new Map();   // tool call id -> resolve, for the page's answer
  const KEY = 'fakesrv:';
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const keys = (prefix) => { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(prefix)) out.push(k); } return out; };
  const readBody = async (body) => (body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body || []));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const textOf = (c) => (typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '[image]')).join(''));

  async function waitForModel() {
    for (let i = 0; i < 60 && !window.fakeLLM; i++) await new Promise((r) => setTimeout(r, 100));
    return window.fakeLLM ? await window.fakeLLM.use('sample') : null;
  }

  function chat(body, signal) {
    (window.__chatBodies = window.__chatBodies || []).push(body);   // as sent, images included (the fake model gets text)
    const msgs = body.messages.map((m) => ({ role: m.role, content: textOf(m.content) }));
    if (body.system && msgs.length) msgs[0] = { role: 'user', content: body.system + '\n\n---\n\n' + msgs[0].content };
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        const line = (o) => c.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        let sent = '';
        const callTool = (name, input) => new Promise((resolve) => {
          if (!(body.tools || []).includes(name)) return resolve({ error: `There is no tool called "${name}".` });
          const id = Math.random().toString(16).slice(2); toolWait.set(id, resolve); line({ tool: { id, name, input } });
        });
        const push = (text) => { if (text.startsWith(sent) && text.length > sent.length) { line({ d: text.slice(sent.length) }); sent = text; } };
        try {
          // the title call (PROMPTS.title) gets no answer, so titles stay the questions, unless a test sets window.fakeTitles
          if (!window.fakeTitles && /^You name notes in a learner's study app/.test(body.system || '')) { line({ done: true, model: 'claude-haiku-5-5', truncated: false }); c.close(); return; }
          const sample = await waitForModel();
          if (!sample) throw new Error('No fake model (window.fakeLLM) in this test.');
          const model = body.model && body.model !== 'auto' ? body.model : undefined;
          const effort = body.effort && body.effort !== 'auto' ? body.effort : undefined;
          const r = await sample(msgs, { model, effort, web: !!body.web, signal, onText: ({ text }) => push(text), onSearch: (q) => line({ search: q }), tools: body.tools || [], callTool });
          push(r.text);
          line({ done: true, model: r.modelApplied || model || 'claude-opus-5-5', truncated: !!r.truncated });
        } catch (e) {
          if (!(signal && signal.aborted)) line({ error: (e && e.message) || 'fake model error' });
        }
        try { c.close(); } catch (_) { /* aborted */ }
      },
    }), { headers: { 'content-type': 'application/x-ndjson' } });
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
    if (p[1] === 'health') { const ok = !!(await waitForModel()); return json({ app: 'digress', llm: ok, provider: 'fake', providers: ok ? ['fake'] : [], web: true, tools: !!window.fakeTools, why: 'No fake model in this test.' }); }
    // Connections: Claude Code on; a Gemini key can be added (gemini-test-key-0000000000 is the one Google "accepts")
    const conn = window.__fakeConn || (window.__fakeConn = { gemini: null });
    const gemModels = [['gemini-3.8-flash', 'Gemini 3.8 Flash'], ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite']];
    if (p[1] === 'connections') {
      const list = () => json({ providers: [
        { id: 'claude-code', name: 'Claude Code', kind: 'cli', on: true, note: 'Your Claude subscription, through the Claude Code CLI' },
        { id: 'anthropic', name: 'Anthropic API', kind: 'key', on: false, from: null },
        { id: 'chatgpt', name: 'ChatGPT', kind: 'login', on: false, note: 'ChatGPT is not connected.' },
        { id: 'gemini', name: 'Google Gemini', kind: 'key', on: !!conn.gemini, ...(conn.gemini ? { from: 'app', last4: conn.gemini.slice(-4) } : { from: null }) }] });
      if (!p[2] && method === 'GET') return list();
      if (p[2] === 'gemini' && method === 'PUT') { const k = JSON.parse(init.body).key; if (k !== 'gemini-test-key-0000000000') return json({ error: 'Google rejected the Gemini API key. Check it in Connections.' }, 400); conn.gemini = k; return list(); }
      if (p[2] === 'gemini' && method === 'DELETE') { conn.gemini = null; return list(); }
      return json({ error: 'Not found' }, 404);
    }
    if (p[1] === 'models') return json({ models: [...(window.fakeModels || [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']]), ...(conn.gemini ? gemModels : [])], defaultLabel: 'Opus 5.5' });   // a test can list others (window.fakeModels)
    if (p[1] === 'chat' && p[2] === 'tool' && method === 'POST') { const b = JSON.parse(init.body), r = toolWait.get(b.id); toolWait.delete(b.id); if (r) r(b.error ? { error: b.error } : { parts: b.parts }); return json({ ok: true }); }
    if (p[1] === 'tools') return json({ tools: [{ name: 'suggest_card', description: 'Suggest one flashcard (fake).', schema: { type: 'object', properties: { front: {}, back: {} } } }], maxCalls: 30, maxCards: 10 });
    if (p[1] === 'chat' && p[2] === 'stop' && method === 'POST') { const c = runs.get(JSON.parse(init.body).chat); if (c) c.abort(); return json({ ok: true }); }
    if (p[1] === 'chat' && p[2] === 'run') return json({ error: 'Not found' }, 404);   // reconnecting isn't faked (test_runs.py covers the real server)
    if (p[1] === 'chat' && method === 'POST') {
      const body = JSON.parse(init.body), ctrl = new AbortController();
      if (body.chat) runs.set(body.chat, ctrl);
      if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort());
      return chat(body, ctrl.signal);
    }
    if (p[1] === 'layout') {
      const k = KEY + 'layout/' + p[2], d = JSON.parse(localStorage.getItem(k) || '{"devices":{}}');
      if (method === 'GET') return json(d);
      d.devices[url.searchParams.get('device')] = { ui: JSON.parse(init.body), at: Date.now() }; localStorage.setItem(k, JSON.stringify(d)); return json({ ok: true });
    }
    if (p[1] === 'store') {
      if (window.fakeOffline && method !== 'GET') throw new TypeError('Failed to fetch');   // a test can drop the connection for saves (window.fakeOffline)
      if (method !== 'GET') window.__saves = (window.__saves || 0) + 1;
      const coll = p[2], id = p[3], k = KEY + coll + '/';
      if (!id && method === 'GET') return json(keys(k).map((key) => ({ id: key.slice(k.length), data: JSON.parse(localStorage.getItem(key)) })));
      if (method === 'GET' && url.searchParams.has('rev')) { const v = localStorage.getItem(k + id); return v ? json({ rev: JSON.parse(v).rev || 0 }) : json({ error: 'Not found' }, 404); }
      if (method === 'GET') { const v = localStorage.getItem(k + id); return v ? json(JSON.parse(v)) : json({ error: 'Not found' }, 404); }
      if (method === 'PUT') {   // conversations: versions, as the real server (x-base-rev -> 409 / 410)
        if (coll !== 'convs') { localStorage.setItem(k + id, init.body); return json({ ok: true }); }
        const cur = JSON.parse(localStorage.getItem(k + id) || 'null'), h = new Headers(init.headers || {}), base = h.get('x-base-rev');
        if (base !== null && !cur && Number(base) > 0) return json({ error: 'deleted' }, 410);
        if (base !== null && cur && (cur.rev || 0) !== Number(base)) return json({ error: 'Changed elsewhere', current: cur }, 409);
        const d = JSON.parse(init.body); d.rev = (cur ? cur.rev || 0 : 0) + 1; localStorage.setItem(k + id, JSON.stringify(d));
        return json({ ok: true, rev: d.rev });
      }
      if (method === 'PATCH') { const v = localStorage.getItem(k + id); if (!v) return json({ error: 'Not found' }, 404); localStorage.setItem(k + id, JSON.stringify({ ...JSON.parse(v), ...JSON.parse(init.body) })); return json({ ok: true }); }
      if (method === 'DELETE') { localStorage.removeItem(k + id); return json({ ok: true }); }
    }
    if (p[1] === 'files') {
      if (method === 'POST') {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
        const type = url.searchParams.get('type') || 'application/octet-stream';
        localStorage.setItem(KEY + 'file/' + id, JSON.stringify({ type, data: b64(await readBody(init.body)) }));
        (window.__uploads = window.__uploads || []).push(type);
        return json({ id });
      }
      const v = localStorage.getItem(KEY + 'file/' + p[2]);
      if (method === 'DELETE') { localStorage.removeItem(KEY + 'file/' + p[2]); return json({ ok: true }); }
      if (!v) return json({ error: 'Not found' }, 404);
      const f = JSON.parse(v);
      return new Response(unb64(f.data), { headers: { 'content-type': f.type } });
    }
    if (p[1] === 'fetch-doc') {   // images only, from window.fakeImages ({url: base64 PNG}); opening documents from links isn't faked here (see test_server.py)
      const b = JSON.parse(init.body || '{}'), img = b.image && window.fakeImages && window.fakeImages[b.url];
      (window.__fetchedImages = window.__fetchedImages || []).push(b.url);
      if (img) return new Response(unb64(img), { headers: { 'content-type': 'image/png' } });
      return json({ error: 'Opening links isn’t faked in the UI tests (see test_server.py).' }, 502);
    }
    return json({ error: 'Not found' }, 404);
  };
})();
