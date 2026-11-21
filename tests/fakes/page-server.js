// A stand-in for server/server.mjs that runs inside the test page, so the UI tests can drive the app
// without starting Node. common.goto_app() serves web/index.html at http://digress.test/ and injects
// this before the page's scripts; it answers the page's /api/* requests the way the real server does
// (same paths and shapes; AGENTS.md has the contract). tests/test_server.py and test_context.py
// cover the real server.
//
// The fake model is whatever the test puts in window.fakeLLM:
//   window.fakeLLM = { use: async (name) => name === 'sample' ? async (messages, opts) => ({text, truncated}) : null }
// It gets the conversation with the system prompt folded into the first message, and
// opts = {model, effort, web, signal, onText({text}), onSearch(query)}; call onText with the text so far to stream,
// onSearch to report a web search the way the server does.
// Until window.fakeLLM exists, /api/health waits (up to 6 s), like a server that is slow to start.
// Conversations, the search index and files are kept in localStorage, so they survive a reload.
(() => {
  const realFetch = window.fetch.bind(window);
  const runs = new Map();   // chat id -> AbortController, for Stop
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
    const msgs = body.messages.map((m) => ({ role: m.role, content: textOf(m.content) }));
    if (body.system && msgs.length) msgs[0] = { role: 'user', content: body.system + '\n\n---\n\n' + msgs[0].content };
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        const line = (o) => c.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        let sent = '';
        const push = (text) => { if (text.startsWith(sent) && text.length > sent.length) { line({ d: text.slice(sent.length) }); sent = text; } };
        try {
          // the title call (PROMPTS.title) gets no answer, so titles stay the questions, unless a test sets window.fakeTitles
          if (!window.fakeTitles && /^You name notes in a learner's study app/.test(body.system || '')) { line({ done: true, model: 'claude-haiku-5-5', truncated: false }); c.close(); return; }
          const sample = await waitForModel();
          if (!sample) throw new Error('No fake model (window.fakeLLM) in this test.');
          const model = body.model && body.model !== 'auto' ? body.model : undefined;
          const effort = body.effort && body.effort !== 'auto' ? body.effort : undefined;
          const r = await sample(msgs, { model, effort, web: !!body.web, signal, onText: ({ text }) => push(text), onSearch: (q) => line({ search: q }) });
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
    if (p[1] === 'health') { const ok = !!(await waitForModel()); return json({ app: 'digress', llm: ok, provider: 'fake', providers: ok ? ['fake'] : [], web: true, why: 'No fake model in this test.' }); }
    if (p[1] === 'models') return json({ models: [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']], defaultLabel: 'Opus 5.5' });
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
    if (p[1] === 'fetch-doc') return json({ error: 'Opening links isn’t faked in the UI tests (see test_server.py).' }, 502);
    return json({ error: 'Not found' }, 404);
  };
})();
