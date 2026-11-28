// The server contract (agents/server.md), as checks that run IN A PAGE against any of the three things that
// answer /api/*: the real server, the demo's in-browser stand-in (demo/demo.js) and the UI tests' in-page fake
// (tests/fakes/page-server.js). tests/test_contract.py loads this into each one and fails on any check that fails.
// It checks response SHAPES and STATUS CODES, not content. A plain script (no imports): it defines
// globalThis.digressContract(opts) -> [{name, ok, detail}], opts = {impl: 'server' | 'demo' | 'fake', chatBody?}.
// It calls the relative URLs `api/...` with the page's own fetch, as web/js/connectors.js does.
// Where an implementation is meant to differ from the real server, the check says so with `impl !== ...`, and why.
globalThis.digressContract = async (opts) => {
  const impl = opts.impl, results = [];
  const run = (name, fn) => queue.push([name, fn]);
  const queue = [];
  const sfx = Math.random().toString(36).slice(2, 10);
  const ID = 'ctr-' + sfx, DEVICE = 'ctrdev-' + sfx, CHAT = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
  const call = async (method, path, o = {}) => {
    const init = { method, headers: { ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.headers || {}) } };
    if (o.json !== undefined) init.body = JSON.stringify(o.json);
    if (o.raw !== undefined) init.body = o.raw;
    const r = await fetch('api/' + path, init);
    const text = await r.clone().text().catch(() => '');
    let json; try { json = JSON.parse(text); } catch (_) { json = undefined; }
    return { r, status: r.status, json, text, type: r.headers.get('content-type') || '' };
  };
  const need = (cond, detail) => { if (!cond) throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)); };
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const conv = (extra = {}) => ({ id: ID, title: 'contract ' + sfx, created: 1, updated: 1, msgs: {}, threads: {}, order: { main: [] }, ...extra });

  run('GET health: app digress, llm/provider/providers/web fields', async () => {
    const h = await call('GET', 'health');
    need(h.status === 200 && h.json && h.json.app === 'digress', h.text);
    need(typeof h.json.llm === 'boolean' && typeof h.json.provider === 'string' && Array.isArray(h.json.providers) && typeof h.json.web === 'boolean', h.text);
  });
  run('GET health: search:true only on the server', async () => {
    // intended (agents/search.md): the server advertises its FTS5 search; the demo and the fake omit it, so the page keeps using client-side MiniSearch
    const h = await call('GET', 'health');
    need(impl === 'server' ? h.json.search === true : h.json.search === undefined, h.text);
  });
  let modelId = null;
  run('GET models: models is [[id,label]], defaultLabel is a string', async () => {
    const m = await call('GET', 'models');
    need(m.status === 200 && Array.isArray(m.json.models) && m.json.models.length > 0, m.text);
    need(m.json.models.every((x) => Array.isArray(x) && x.length >= 2 && typeof x[0] === 'string' && typeof x[1] === 'string'), m.text);
    need(typeof m.json.defaultLabel === 'string', m.text);
    modelId = m.json.models[0][0];
  });
  run('GET models: default and chosen are present', async () => {
    const m = await call('GET', 'models');
    need('default' in m.json && 'chosen' in m.json, m.text);
  });
  run('GET tools: {tools:[{name,description,schema}], maxCalls, maxCards}', async () => {
    // the tool NAMES aren't compared: the fake lists only a couple on purpose
    const t = await call('GET', 'tools');
    need(t.status === 200 && Array.isArray(t.json.tools) && t.json.tools.length > 0, t.text);
    need(t.json.tools.every((x) => typeof x.name === 'string' && typeof x.description === 'string' && obj(x.schema)), t.text);
    need(typeof t.json.maxCalls === 'number' && typeof t.json.maxCards === 'number', t.text);
  });
  run('prefs: PUT {defaultModel} then GET gives it back', async () => {
    const put = await call('PUT', 'prefs', { json: { defaultModel: modelId } });
    need(put.status === 200 && obj(put.json) && put.json.defaultModel === modelId, put.status + ' ' + put.text);
    const get = await call('GET', 'prefs');
    need(get.status === 200 && get.json.defaultModel === modelId, get.status + ' ' + get.text);
  });

  // ---- conversations ----
  run('store/convs: GET a missing conversation is 404', async () => {
    const g = await call('GET', 'store/convs/' + ID);
    need(g.status === 404 && g.json && typeof g.json.error === 'string', g.status + ' ' + g.text);
  });
  run('store/convs: GET ?rev of a missing conversation is 404', async () => {
    const g = await call('GET', 'store/convs/' + ID + '?rev');
    need(g.status === 404, g.status + ' ' + g.text);
  });
  let rev1 = 0;
  run('store/convs: PUT a new conversation -> {ok:true, rev:1}', async () => {
    const p = await call('PUT', 'store/convs/' + ID, { json: conv(), headers: { 'x-base-rev': '0' } });
    need(p.status === 200 && p.json.ok === true && p.json.rev === 1, p.status + ' ' + p.text);
    rev1 = p.json.rev;
  });
  run('store/convs: GET it back with the same content and its rev', async () => {
    const g = await call('GET', 'store/convs/' + ID);
    need(g.status === 200 && g.json.id === ID && g.json.title === 'contract ' + sfx && g.json.rev === rev1, g.status + ' ' + g.text.slice(0, 300));
  });
  run('store/convs: GET ?rev -> {rev}', async () => {
    const g = await call('GET', 'store/convs/' + ID + '?rev');
    need(g.status === 200 && g.json.rev === rev1, g.status + ' ' + g.text);
  });
  run('store/convs: PUT with the current x-base-rev bumps rev', async () => {
    const p = await call('PUT', 'store/convs/' + ID, { json: conv({ title: 'second ' + sfx }), headers: { 'x-base-rev': String(rev1) } });
    need(p.status === 200 && p.json.rev === rev1 + 1, p.status + ' ' + p.text);
  });
  run('store/convs: PUT with a stale x-base-rev -> 409 {error, current}', async () => {
    const p = await call('PUT', 'store/convs/' + ID, { json: conv({ title: 'stale' }), headers: { 'x-base-rev': String(rev1) } });
    need(p.status === 409 && typeof p.json.error === 'string' && obj(p.json.current) && p.json.current.title === 'second ' + sfx && p.json.current.rev === rev1 + 1, p.status + ' ' + p.text.slice(0, 300));
  });
  run('store/convs: PUT without x-base-rev overwrites', async () => {
    const p = await call('PUT', 'store/convs/' + ID, { json: conv({ title: 'third ' + sfx }) });
    need(p.status === 200 && p.json.rev === rev1 + 2, p.status + ' ' + p.text);
  });
  run('store/convs: PATCH merges fields -> {ok:true}', async () => {
    const p = await call('PATCH', 'store/convs/' + ID, { json: { pinned: true } });
    need(p.status === 200 && p.json.ok === true, p.status + ' ' + p.text);
    const g = await call('GET', 'store/convs/' + ID);
    need(g.json.pinned === true && g.json.title === 'third ' + sfx, g.text.slice(0, 300));
  });
  run('store/convs: PATCH a missing conversation is 404', async () => {
    const p = await call('PATCH', 'store/convs/ctr-none-' + sfx, { json: { pinned: true } });
    need(p.status === 404, p.status + ' ' + p.text);
  });
  run('store/convs?meta=1: the list has metadata rows (_meta, no msgs/threads)', async () => {
    const l = await call('GET', 'store/convs?meta=1');
    need(l.status === 200 && Array.isArray(l.json), l.text.slice(0, 300));
    const row = l.json.find((x) => x.id === ID);
    need(row && obj(row.data) && row.data._meta === true && row.data.title === 'third ' + sfx && !('msgs' in row.data) && !('threads' in row.data), row ? JSON.stringify(row) : 'no row for ' + ID);
    need(l.json.every((x) => typeof x.id === 'string' && obj(x.data) && x.data._meta === true), 'a row is not a meta row');
  });
  run('store/convs: the full list has {id, data} rows with msgs', async () => {
    const l = await call('GET', 'store/convs');
    const row = Array.isArray(l.json) && l.json.find((x) => x.id === ID);
    need(l.status === 200 && row && obj(row.data) && obj(row.data.msgs) && !row.data._meta, l.text.slice(0, 300));
  });
  run('store/convs: DELETE -> {ok:true}, then GET is 404', async () => {
    const d = await call('DELETE', 'store/convs/' + ID);
    need(d.status === 200 && d.json.ok === true, d.status + ' ' + d.text);
    const g = await call('GET', 'store/convs/' + ID);
    need(g.status === 404, g.status + ' ' + g.text);
  });
  run('store/convs: PUT a deleted conversation with a non-zero x-base-rev -> 410', async () => {
    const p = await call('PUT', 'store/convs/' + ID, { json: conv(), headers: { 'x-base-rev': '3' } });
    need(p.status === 410 && typeof p.json.error === 'string', p.status + ' ' + p.text);
  });
  run('store/convs: …but a base rev of 0 creates it again', async () => {
    const p = await call('PUT', 'store/convs/' + ID, { json: conv(), headers: { 'x-base-rev': '0' } });
    need(p.status === 200 && p.json.rev === 1, p.status + ' ' + p.text);
    await call('DELETE', 'store/convs/' + ID);
  });

  // ---- the other collections ----
  for (const coll of ['index', 'cards']) {
    run(`store/${coll}: PUT, GET, list, PATCH, DELETE`, async () => {
      const id = 'ctr-' + coll + '-' + sfx, k = 'store/' + coll + '/' + id;
      need((await call('GET', k)).status === 404, 'GET before PUT is not 404');
      const p = await call('PUT', k, { json: { a: 1, items: [1, 2] } });
      need(p.status === 200 && p.json.ok === true, p.status + ' ' + p.text);
      const g = await call('GET', k);
      need(g.status === 200 && g.json.a === 1 && Array.isArray(g.json.items), g.status + ' ' + g.text);
      const l = await call('GET', 'store/' + coll);
      need(l.status === 200 && Array.isArray(l.json) && l.json.some((x) => x.id === id && x.data.a === 1), l.text.slice(0, 300));
      const pa = await call('PATCH', k, { json: { b: 2 } });
      need(pa.status === 200 && pa.json.ok === true, pa.status + ' ' + pa.text);
      const g2 = await call('GET', k);
      need(g2.json.a === 1 && g2.json.b === 2, g2.text);
      const d = await call('DELETE', k);
      need(d.status === 200 && d.json.ok === true, d.status + ' ' + d.text);
      need((await call('GET', k)).status === 404, 'GET after DELETE is not 404');
    });
  }

  // ---- layouts ----
  run('layout: GET of an unknown conversation -> {devices:{}}', async () => {
    const g = await call('GET', 'layout/ctr-nolayout-' + sfx);
    need(g.status === 200 && obj(g.json.devices) && Object.keys(g.json.devices).length === 0, g.status + ' ' + g.text);
  });
  run('layout: PUT ?device= then GET -> {devices:{id:{ui,at}}}', async () => {
    const ui = { view: 'panes', zoom: 1.5, nested: { a: [1] } };
    // the real server keeps a layout only for a conversation that exists (a missing one gives {ok:false}); the demo and fake keep any
    await call('PUT', 'store/convs/' + ID, { json: conv() });
    const p = await call('PUT', 'layout/' + ID + '?device=' + DEVICE, { json: ui });
    need(p.status === 200 && 'ok' in p.json, p.status + ' ' + p.text);
    const g = await call('GET', 'layout/' + ID);
    const d = g.json && g.json.devices && g.json.devices[DEVICE];
    need(g.status === 200 && d && JSON.stringify(d.ui) === JSON.stringify(ui) && typeof d.at === 'number', g.status + ' ' + g.text);
  });
  run('layout: a second device is kept beside the first', async () => {
    await call('PUT', 'layout/' + ID + '?device=' + DEVICE + 'b', { json: { z: 2 } });
    const g = await call('GET', 'layout/' + ID);
    need(Object.keys(g.json.devices).length === 2 && g.json.devices[DEVICE + 'b'].ui.z === 2, g.text);
  });
  run('layout: deleting the conversation takes its layouts with it', async () => {
    // agents/server.md: "Deleting a conversation also deletes its layouts"
    await call('DELETE', 'store/convs/' + ID);
    const g = await call('GET', 'layout/' + ID);
    const gone = g.status === 200 && Object.keys(g.json.devices).length === 0;
    need(gone, g.text);
  });

  // ---- files ----
  run('files: POST raw bytes with ?type= -> {id}; GET returns the bytes and the type; DELETE; then 404', async () => {
    const bytes = new TextEncoder().encode('# contract ' + sfx + '\nsome text é\n');
    const p = await call('POST', 'files?type=text/markdown', { raw: bytes, headers: { 'content-type': 'text/markdown' } });
    need(p.status === 200 && typeof p.json.id === 'string' && /^[a-f0-9]{32}$/.test(p.json.id), p.status + ' ' + p.text);
    const g = await fetch('api/files/' + p.json.id);
    const back = new Uint8Array(await g.arrayBuffer());
    need(g.status === 200 && g.headers.get('content-type').startsWith('text/markdown'), g.status + ' ' + g.headers.get('content-type'));
    need(back.length === bytes.length && back.every((x, i) => x === bytes[i]), 'bytes differ: ' + back.length + ' vs ' + bytes.length);
    const d = await call('DELETE', 'files/' + p.json.id);
    need(d.status === 200 && d.json.ok === true, d.status + ' ' + d.text);
    const g2 = await fetch('api/files/' + p.json.id + '?after-delete', { cache: 'no-store' });   // (the app's service worker serves a file it has seen from its cache, as ids are never reused (web/sw.js): ask under another URL)
    need(g2.status === 404, g2.status);
  });
  run('files: a binary body (all 256 byte values) comes back unchanged', async () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
    bytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
    const p = await call('POST', 'files?type=application/pdf', { raw: bytes });
    need(p.status === 200 && p.json.id, p.status + ' ' + p.text);
    const g = await fetch('api/files/' + p.json.id), back = new Uint8Array(await g.arrayBuffer());
    need(g.headers.get('content-type').startsWith('application/pdf') && back.length === bytes.length && back.every((x, i) => x === bytes[i]), 'bytes or type differ');
    await call('DELETE', 'files/' + p.json.id);
  });
  run('files: GET an unknown id is 404', async () => {
    const g = await call('GET', 'files/' + '0'.repeat(32));
    need(g.status === 404, g.status + ' ' + g.text);
  });

  // ---- chat ----
  const stream = async (body, path = 'chat') => {
    const r = await fetch('api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text(), lines = text.split('\n').filter((l) => l.trim());
    return { r, status: r.status, text, lines, objs: lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }) };
  };
  const chatBody = (extra = {}) => ({ messages: [{ role: 'user', content: 'Say hello for the contract test.' }], model: modelId || 'auto', chat: CHAT, ...(opts.chatBody || {}), ...extra });
  let lastChat = null;
  run('chat: POST streams NDJSON: every line is JSON, text is {d}, it ends with {done} or {error}', async () => {
    const s = lastChat = await stream(chatBody());
    need(s.status === 200 && /ndjson|json/.test(s.r.headers.get('content-type') || ''), s.status + ' ' + s.r.headers.get('content-type') + ' ' + s.text.slice(0, 300));
    need(s.objs.length > 0 && s.objs.every((o) => obj(o)), 'a line is not a JSON object: ' + s.text.slice(0, 300));
    const text = s.objs.map((o) => o.d || '').join('');
    const last = s.objs[s.objs.length - 1];
    need(last.done || last.error, 'ends with ' + JSON.stringify(last));
    need(last.done && !s.objs.some((o) => o.error), 'the reply failed: ' + s.text.slice(0, 300));
    need(text.length > 0 && s.objs.filter((o) => 'd' in o).every((o) => typeof o.d === 'string'), 'no text arrived');
  });
  run('chat: the {done} line has model (string) and truncated (boolean)', async () => {
    const last = lastChat.objs[lastChat.objs.length - 1];
    need(typeof last.model === 'string' && typeof last.truncated === 'boolean', JSON.stringify(last));
  });
  run('chat: a malformed request is refused with JSON {error}', async () => {
    // all three check the request's shape first (the server's normalizeMessages; the demo's and the fake's badChat)
    const s = await stream({ messages: [{ role: 'user', content: 12 }] });
    need(s.status === 400 && s.objs[0] && typeof s.objs[0].error === 'string', s.status + ' ' + s.text.slice(0, 200));
  });
  run('chat/stop: POST {chat} -> {ok:true}, even for a reply that is not running', async () => {
    const s = await call('POST', 'chat/stop', { json: { chat: 'f'.repeat(32) } });
    need(s.status === 200 && s.json.ok === true, s.status + ' ' + s.text);
  });
  run('chat/run: an unknown run is 404 with {error}', async () => {
    const g = await call('GET', 'chat/run/' + 'e'.repeat(32) + '?from=0');
    need(g.status === 404 && typeof g.json.error === 'string', g.status + ' ' + g.text);
  });
  run('chat/run: a reply that just finished can be replayed from line 0', async () => {
    // intended: only the real server keeps replies as runs that outlive the connection (agents/server.md, "Replies are
    // server runs"). The fake says reconnecting isn't faked (test_runs.py covers the server) and the demo's replies
    // "never outlive the page": both answer 404 always.
    const g = await fetch('api/chat/run/' + CHAT + '?from=0');
    if (impl !== 'server') { need(g.status === 404, 'expected 404, got ' + g.status); return; }
    const text = await g.text(), objs = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    need(g.status === 200 && objs.length === lastChat.objs.length && JSON.stringify(objs[objs.length - 1]) === JSON.stringify(lastChat.objs[lastChat.objs.length - 1]), g.status + ' ' + text.slice(0, 300));
  });
  run('chat/tool: a result for a tool call nobody is waiting for is 404', async () => {
    const t = await call('POST', 'chat/tool', { json: { chat: 'd'.repeat(32), id: 'nothing', parts: [] } });
    need(t.status === 404, t.status + ' ' + t.text);
  });
  run('unknown routes are 404 with {error}', async () => {
    const g = await call('GET', 'nothing-here-' + sfx);
    need(g.status === 404 && typeof g.json.error === 'string', g.status + ' ' + g.text.slice(0, 200));
  });
  run('fetch-doc: POST of a link nobody may fetch fails with JSON {error} (never 200)', async () => {
    // the server refuses the address (400-ish); the demo can't fetch (CORS) and the fake doesn't open links: both 502.
    const f = await call('POST', 'fetch-doc', { json: { url: 'http://127.0.0.1:9/x.pdf', confirm: [] } });
    need(f.status >= 400 && typeof f.json.error === 'string' || f.status === 409, f.status + ' ' + f.text.slice(0, 200));
  });

  for (const [name, fn] of queue) {
    try { await fn(); results.push({ name, ok: true, detail: '' }); }
    catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e).slice(0, 400) }); }
  }
  return results;
};
