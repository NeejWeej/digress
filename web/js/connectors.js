// Storage, layout, file, and LLM connectors for Digress (self-hosted server, offline flashcards, and in-memory fallback).
// Kept pure of UI/DOM state so app.js only wires them into `io = { llm, store, layout, index, files, cards, ready }`.

const randId = () => Math.random().toString(36).slice(2, 10);

export function memoryStore(label) {
  const m = new Map();
  return {
    kind: 'memory',
    label: label || '',
    list: async () => [...m.entries()].map(([id, data]) => ({ id, data: structuredClone(data) })),
    get: async (id) => (m.has(id) ? structuredClone(m.get(id)) : null),
    put: async (id, d) => { m.set(id, structuredClone(d)); },
    save: async (id, d) => {
      const rev = ((m.get(id) || {}).rev || 0) + 1;
      m.set(id, { ...structuredClone(d), rev });
      return { rev };
    },
    update: async (id, p) => { if (m.has(id)) Object.assign(m.get(id), structuredClone(p)); },
    remove: async (id) => { m.delete(id); },
  };
}

export function noLlm(why) {
  return {
    kind: 'none',
    supportsEffort: false,
    supportsWeb: false,
    why,
    models: () => [['auto', 'Auto']],
    ready: async () => false,
    complete: async () => { throw { message: why }; },
    stop: async () => {},
  };
}

export const noFiles = {
  kind: 'none',
  canUpload: false,
  upload: async () => { throw { code: 'unavailable' }; },
  fetch: async () => { throw new Error("This document's file isn't available here."); },
  remove: async () => {},
};

export async function findServer() {
  if (!/^https?:$/.test(location.protocol)) return null; // opened as a file: no server to ask
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === 'digress' ? j : null;
  } catch (e) {
    return null;
  }
}

export async function okOrThrow(r) {
  if (r.ok) return r;
  let msg = '';
  try { msg = (await r.json()).error || ''; } catch (e) {}
  const err = new Error(msg || ('Server error ' + r.status));
  err.status = r.status;
  throw err;
}

/* Flashcards keep working offline: a copy of every card is kept in this browser (localStorage), and
   changes made while the server can't be reached wait in an outbox, sent in order once it's back
   (the latest change per card wins). Paired with web/sw.js, which keeps the page and its libraries. */
export function offlineCards(base) {
  const MK = 'digress:cards', QK = 'digress:cards-outbox';
  const rd = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const wr = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { console.warn('local copy of cards not saved', e); return false; }
  };
  let memMap = rd(MK, {}), memQ = rd(QK, []);
  const localOnly = new Map(); // ops that failed localStorage write (quota/unavailable)
  const readQ = () => {
    const stored = rd(QK, null);
    if (Array.isArray(stored)) {
      if (!localOnly.size) { memQ = stored; return memQ; }
      const out = stored.slice();
      for (const [id, op] of localOnly) {
        const idx = out.findIndex((o) => o.id === id);
        if (idx < 0) out.push(op);
        else if ((op.at || 0) > (out[idx].at || 0)) out[idx] = op;
      }
      memQ = out;
      return memQ;
    }
    return memQ;
  };
  const withLock = (fn) => {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('digress:cards-outbox', fn);
    }
    return fn();
  };
  let flushing = null, retry = 0;
  const st = {
    kind: 'cards',
    stuck: false,
    onchange: null,
    pending: () => readQ().length,
    flush() {
      if (!flushing) {
        flushing = withLock(async () => {
          for (let q = readQ(); q.length; q = readQ()) {
            const op = q[0];
            try {
              if (op.del) await base.remove(op.id);
              else await base.put(op.id, op.card);
            } catch (e) { return false; }
            const lo = localOnly.get(op.id);
            if (lo && ((op.opId && lo.opId === op.opId) || (!op.opId && lo.at === op.at))) localOnly.delete(op.id);
            const now = rd(QK, null);
            if (Array.isArray(now)) {
              const idx = now.findIndex((o) => o.id === op.id && (op.opId ? o.opId === op.opId : o.at === op.at));
              if (idx >= 0) now.splice(idx, 1);
              wr(QK, now);
            } else {
              const idx = memQ.findIndex((o) => o.id === op.id && (op.opId ? o.opId === op.opId : o.at === op.at));
              if (idx >= 0) memQ.splice(idx, 1);
            }
            memQ = readQ();
          }
          return true;
        }).then((ok) => {
          const was = st.stuck;
          st.stuck = !ok;
          clearTimeout(retry);
          if (!ok) { retry = setTimeout(() => st.flush(), 30000); if (retry && retry.unref) retry.unref(); }
          if (was !== st.stuck || ok) st.onchange && st.onchange();
          return ok;
        });
        flushing.finally(() => { flushing = null; if (!st.stuck && readQ().length) st.flush(); });
      }
      return flushing;
    },
    async list() {
      const m0 = rd(MK, null);
      if (m0 && typeof m0 === 'object') memMap = m0;
      const local = () => Object.entries(memMap).map(([id, data]) => ({ id, data }));
      const remote = (async () => {
        if (!await st.flush()) throw new Error('offline');
        const l = await base.list(), m = {};
        for (const { id, data } of l) m[id] = data;
        memMap = m;
        wr(MK, m);
        return l;
      })();
      remote.catch(() => {});
      const slow = Object.keys(memMap).length ? new Promise((ok) => setTimeout(() => ok(null), 2500)) : null;
      try { return (await (slow ? Promise.race([remote, slow]) : remote)) || local(); } catch (e) { return local(); }
    },
    async get(id) { const m0 = rd(MK, null); if (m0 && typeof m0 === 'object') return m0[id] || null; return memMap[id] || null; },
    async put(id, d) { memMap = { ...rd(MK, memMap), [id]: d }; wr(MK, memMap); await send({ id, card: d }); },
    async update(id, p) { const cur = await st.get(id); if (!cur) return; const next = { ...cur, ...p }; await st.put(id, next); },
    async remove(id) { memMap = { ...rd(MK, memMap) }; delete memMap[id]; wr(MK, memMap); await send({ id, del: true }); },
  };
  async function send(op) {
    op.at = Date.now() + Math.random();
    op.opId = randId() + randId();
    const next = readQ().filter((o) => o.id !== op.id);
    next.push(op);
    memQ = next;
    const savedLocal = wr(QK, next);
    if (!savedLocal) {
      localOnly.set(op.id, op);
      const ok = await st.flush();
      if (!ok) throw new Error('Could not save card: local storage is unavailable and the server could not be reached.');
      return;
    }
    localOnly.delete(op.id);
    st.flush();
  }
  if (typeof addEventListener === 'function') addEventListener('online', () => st.flush());
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && readQ().length) st.flush();
    });
  }
  return st;
}

export function serverStore(coll, label, o = {}) {
  const base = 'api/store/' + coll;
  const u = (id) => base + '/' + encodeURIComponent(id);
  const json = { 'content-type': 'application/json' };
  const doFetch = o.timeout
    ? (url, opt = {}) => window.fetch(url, { ...opt, signal: AbortSignal.timeout(o.timeout) })
    : window.fetch.bind(window);
  return {
    kind: 'server',
    label: label || '',
    list: async () => (await okOrThrow(await doFetch(base))).json(),
    listMeta: async () => (await okOrThrow(await doFetch(base + '?meta=1'))).json(),
    get: async (id) => {
      const r = await doFetch(u(id));
      if (r.status === 404) return null;
      return (await okOrThrow(r)).json();
    },
    put: async (id, d) => { await okOrThrow(await doFetch(u(id), { method: 'PUT', headers: json, body: JSON.stringify(d) })); },
    save: async (id, d, baseRev) => {
      const r = await doFetch(u(id), {
        method: 'PUT',
        headers: { ...json, ...(baseRev != null ? { 'x-base-rev': String(baseRev) } : {}) },
        body: JSON.stringify(d),
      });
      if (r.status === 409) { const j = await r.json(); if (j.current) return { current: j.current }; }
      if (r.status === 410) return { deleted: true };
      return { rev: (await (await okOrThrow(r)).json()).rev || 1 };
    },
    rev: async (id) => {
      const r = await doFetch(u(id) + '?rev=1', { cache: 'no-store' });
      if (r.status === 404) return null;
      return (await (await okOrThrow(r)).json()).rev || 0;
    },
    update: async (id, p) => { await okOrThrow(await doFetch(u(id), { method: 'PATCH', headers: json, body: JSON.stringify(p) })); },
    remove: async (id) => { await okOrThrow(await doFetch(u(id), { method: 'DELETE' })); },
  };
}

// A layout from another device keeps what's open, the view and the canvas's arrangement,
// but not what was sized for that device's screen: pane widths, zoom levels, cards stuck to the screen.
export function otherScreen(ui) {
  const u = JSON.parse(JSON.stringify(ui || {}));
  delete u.sizes;
  delete u.pz;
  if (u.cv) { delete u.cv.dock; delete u.cv.pre; delete u.cv.cz; }
  return u;
}

export const DEVICE = (() => {
  try {
    let d = localStorage.getItem('digress:device');
    if (!d) { d = 'd' + randId() + randId(); localStorage.setItem('digress:device', d); }
    return d;
  } catch (e) { return 'd' + randId() + randId(); }
})();

export const WINDOW = (async () => {
  try {
    if (typeof navigator === 'undefined' || !(navigator.locks && navigator.locks.request)) return 1;
    let want = 0;
    try { want = +sessionStorage.getItem('digress:window') || 0; } catch (e) {}
    const take = (n) => new Promise((ok) => {
      navigator.locks.request('digress:window:' + n, { ifAvailable: true }, (lock) => {
        ok(!!lock);
        if (lock) return new Promise(() => {});
      }).catch(() => ok(false));
    });
    let n = want > 0 && await take(want) ? want : 0;
    for (let i = 1; !n && i <= 50; i++) if (await take(i)) n = i;
    n = n || 1;
    try { sessionStorage.setItem('digress:window', String(n)); } catch (e) {}
    return n;
  } catch (e) { return 1; }
})();

export const layoutKey = async () => { const n = await WINDOW; return n > 1 ? DEVICE + 'w' + n : DEVICE; };

export function serverLayout() {
  const u = (id) => 'api/layout/' + encodeURIComponent(id);
  return {
    get: async (id) => (await okOrThrow(await fetch(u(id), { cache: 'no-store' }))).json(),
    put: async (id, ui) => {
      await okOrThrow(await fetch(u(id) + '?device=' + encodeURIComponent(await layoutKey()), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ui),
      }));
    },
  };
}

export const WINDOWS = (() => { try { const ch = new BroadcastChannel('digress'); if (ch.unref) ch.unref(); return ch; } catch (e) { return null; } })();
export function tellWindows(id) { try { WINDOWS && WINDOWS.postMessage({ conv: id }); } catch (e) {} }
export function toldWindows(st) {
  const w = { ...st };
  for (const k of ['put', 'update', 'remove']) w[k] = async (id, ...a) => { const r = await st[k](id, ...a); tellWindows(id); return r; };
  w.save = async (id, ...a) => { const r = await st.save(id, ...a); if (r && r.rev) tellWindows(id); return r; };
  return w;
}

export function serverFiles() {
  return {
    kind: 'server',
    canUpload: true,
    fromLink: async (url, confirm) => {
      const r = await fetch('api/fetch-doc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, confirm: confirm || [] }) });
      if (r.status === 409) { const j = await r.json(); throw { message: j.error, warnings: j.warnings || [], url: j.url }; }
      await okOrThrow(r);
      const dec = (h) => { try { return decodeURIComponent(r.headers.get(h) || ''); } catch (e) { return ''; } };
      const k = r.headers.get('x-doc-kind');
      return { blob: await r.blob(), kind: k === 'pdf' ? 'pdf' : k === 'html' ? 'html' : 'text', name: dec('x-doc-name'), url: dec('x-doc-url') };
    },
    fetchImage: async (url, confirm) => {
      const r = await fetch('api/fetch-doc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, confirm: confirm || [], image: true }) });
      if (r.status === 409) { const j = await r.json(); throw { message: j.error, warnings: j.warnings || [], url: j.url }; }
      return (await okOrThrow(r)).blob();
    },
    upload: async (blob, type) => {
      const r = await fetch('api/files?type=' + encodeURIComponent(type), { method: 'POST', body: blob });
      if (r.status === 413) throw { code: 'too_large' };
      return (await okOrThrow(r)).json();
    },
    fetch: async (id, as) => {
      const r = await okOrThrow(await fetch('api/files/' + encodeURIComponent(id)));
      return as === 'text' ? r.text() : r.arrayBuffer();
    },
    remove: async (id) => { await fetch('api/files/' + encodeURIComponent(id), { method: 'DELETE' }); },
  };
}

const LLM_RECONNECT_MS = 11 * 60e3, LLM_SILENT_MS = 40e3;
export const runId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function serverLlm(info) {
  let models = [['auto', 'Default']];
  const llm = {
    kind: 'server',
    supportsEffort: true,
    supportsWeb: !!(info.llm && info.web),
    supportsImages: true,
    supportsTools: !!(info.llm && info.tools),
    why: info.why || 'The server has no model configured yet. See the README to connect one.',
    models: () => models,
    ready: async () => !!info.llm,
    async loadModels() {
      try {
        const j = await (await okOrThrow(await fetch('api/models'))).json();
        models = [['auto', 'Default' + (j.defaultLabel ? ' (' + j.defaultLabel + ')' : '')], ...j.models];
        llm.defaultModel = j.default || null;
      } catch (e) { console.warn('model list failed', e); }
    },
    async connections() { return (await okOrThrow(await fetch('api/connections'))).json(); },
    async setKey(id, key) {
      const r = await fetch('api/connections/' + encodeURIComponent(id), {
        method: id && key ? 'PUT' : 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: key ? JSON.stringify({ key }) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw { message: j.error || ('The server answered ' + r.status) };
      await llm.refresh();
      return j;
    },
    async refresh() {
      try {
        const h = await (await okOrThrow(await fetch('api/health', { cache: 'no-store' }))).json();
        Object.assign(info, h);
        llm.supportsWeb = !!(h.llm && h.web);
        llm.supportsTools = !!(h.llm && h.tools);
        if (h.why) llm.why = h.why;
      } catch (e) { console.warn(e); }
      await llm.loadModels();
    },
    async toolList() { return (await okOrThrow(await fetch('api/tools', { cache: 'no-store' }))).json(); },
    async setDefault(id) {
      await okOrThrow(await fetch('api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultModel: id }) }));
      await llm.loadModels();
    },
    async complete({ system, messages, model, effort, web, signal, onText, onSearch, onTool, tools, run, save, resume }) {
      if (!info.llm) throw { message: llm.why };
      const useTools = !!(tools && tools.names && tools.names.length && llm.supportsTools), chat = run || runId();
      const st = { text: '', model: null, truncated: false, searches: [], sources: [], n: 0, end: false, error: null };
      const answer = async (call) => {
        let res;
        try { res = await tools.run(call.name, call.input || {}); } catch (e) { res = { error: 'The tool failed: ' + ((e && e.message) || e) }; }
        try { await fetch('api/chat/tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat, id: call.id, ...res }) }); } catch (e) { console.warn('tool result not delivered', e); }
      };
      const handle = (ev) => {
        if (ev.hb) return;
        st.n++;
        if (ev.d) { st.text += ev.d; onText && onText(st.text); }
        else if (ev.search) { st.searches.push(String(ev.search)); onSearch && onSearch({ searches: st.searches, sources: st.sources }); }
        else if (ev.sources) {
          for (const x of ev.sources) if (x && /^https?:\/\//i.test(x.url) && !st.sources.some((y) => y.url === x.url)) st.sources.push({ title: String(x.title || x.url), url: String(x.url) });
          onSearch && onSearch({ searches: st.searches, sources: st.sources });
        }
        else if (ev.tool) { if (useTools || resume) { onTool && onTool(ev.tool, false); if (tools) answer(ev.tool); } }
        else if (ev.toolDone) { onTool && onTool(ev.toolDone, true); }
        else if (ev.error) { st.error = String(ev.error); st.end = true; }
        else if (ev.done) { st.model = ev.model || null; st.truncated = !!ev.truncated; st.usage = ev.usage && typeof ev.usage === 'object' ? ev.usage : null; st.end = true; }
        else if (ev.stopped) { st.stopped = String(ev.stopped); st.end = true; }
      };
      const read = async (r) => {
        const rd = r.body.getReader(), dec = new TextDecoder();
        let buf = '', last = Date.now();
        const kick = () => { if (Date.now() - last > LLM_SILENT_MS) rd.cancel().catch(() => {}); };
        const dog = setInterval(kick, 3000);
        const vis = () => { if (document.visibilityState === 'visible' && Date.now() - last > 20000) rd.cancel().catch(() => {}); };
        document.addEventListener('visibilitychange', vis);
        try {
          for (;;) {
            const { value, done } = await rd.read();
            if (done) break;
            last = Date.now();
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              if (line.trim()) handle(JSON.parse(line));
              if (st.end) return 'end';
            }
          }
        } catch (e) { if (signal && signal.aborted) throw e; }
        finally { clearInterval(dog); document.removeEventListener('visibilitychange', vis); }
        return st.end ? 'end' : 'lost';
      };
      const fail = (o) => Object.assign({ text: st.text, searches: st.searches, sources: st.sources }, o);
      let state = 'lost';
      if (!resume) {
        let r = null;
        try {
          r = await fetch('api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ system, messages, model, effort, web: !!(web && llm.supportsWeb), chat, ...(useTools ? { tools: tools.names } : {}), ...(save ? { save } : {}) }),
            signal,
          });
        } catch (e) { if (signal && signal.aborted) throw e; }
        if (r) { await okOrThrow(r); state = await read(r); }
      }
      for (let wait = 400, until = Date.now() + LLM_RECONNECT_MS; state === 'lost'; wait = Math.min(wait * 2, 4000)) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (Date.now() > until) throw fail({ message: 'Lost the connection to the server before the reply finished.', cut: true });
        if (st.n || resume || wait > 400) await new Promise((ok) => setTimeout(ok, wait));
        let g;
        try { g = await fetch('api/chat/run/' + chat + '?from=' + st.n, { signal, cache: 'no-store' }); } catch (e) { if (signal && signal.aborted) throw e; continue; }
        if (g.status === 404) throw fail(st.n || resume ? { message: 'The server no longer has this reply, so it stops here.', cut: true } : { message: 'Couldn’t reach the server.' });
        if (!g.ok) {
          if (g.status >= 500 && g.status !== 500) {
            let j = null;
            try { j = await g.clone().json(); } catch (e) {}
            if (!(j && j.error)) continue;
          }
          await okOrThrow(g);
        }
        state = await read(g);
      }
      if (st.error) throw fail({ message: st.error });
      if (st.stopped) throw fail(st.stopped === 'away' ? { message: 'no page was connected to it for too long, so the server stopped it.', cut: true } : { message: 'Stopped.', stopped: true });
      return { text: st.text, truncated: st.truncated, model: st.model, usage: st.usage, searches: st.searches, sources: st.sources };
    },
    stop: (run) => fetch('api/chat/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: run }) }).catch(() => {}),
  };
  return llm;
}
