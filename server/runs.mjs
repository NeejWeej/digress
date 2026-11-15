// Replies that outlive the page's connection.
//
// A reply used to live and die with the HTTP request that asked for it: when the connection dropped, the
// server stopped the model. On a phone, locking the screen or switching apps drops it, so replies got cut
// off. Now each reply is a run, kept here by its id (the `chat` id the page made up):
//
//  - The provider writes into the run (a stand-in for the HTTP response: writeHead / write / end / 'close'),
//    never to a connection. The run keeps every line it wrote.
//  - Pages attach to it: the request that started it, and later GET /api/chat/run/:id?from=N, which replays
//    from line N and then follows along. A dropped connection only detaches that page.
//  - It stops the model only when asked (Stop: POST /api/chat/stop), or after DETACH_MS with no page
//    attached. Document tool calls wait for a page to come back (they run in the page) instead of timing out.
//  - If it ends with no page attached, it writes the reply into the conversation itself (onOrphan), so a
//    reply finished while you were elsewhere is there when you come back.
//  - A finished run stays KEEP_MS for a page that reconnects late, then it's dropped.
//
// Lines are counted without the heartbeats ({hb:1}, sent to each page every HB_MS so it can tell a live but
// quiet stream from a dead one). A document tool call that was already answered is replayed as {toolDone}
// so a page that reloads doesn't run it again. A run the server stops ends with {stopped:'stop'} (Stop was
// pressed) or {stopped:'away'} (no page for DETACH_MS), so a page that is attached, or attaches later, knows it
// ended and doesn't take the end for a dropped connection and keep reconnecting.

export const DETACH_MS = Number(process.env.RUN_DETACH_MS || 10 * 60_000);
const KEEP_MS = Number(process.env.RUN_KEEP_MS || 10 * 60_000);
const HB_MS = Number(process.env.RUN_HEARTBEAT_MS || 15_000);

const runs = new Map();
export const getRun = (id) => runs.get(id) || null;

export function createRun(id, { session, onOrphan } = {}) {
  const run = {
    id, session, status: null, headers: null, lines: [], tail: '', ended: false, cancelled: false,
    clients: new Set(), closeFns: [], detachTimer: null, keepTimer: null,
    get writableFinished() { return run.ended && !run.cancelled; },
    get destroyed() { return run.cancelled; },
    get headersSent() { return run.status !== null; },
    on(ev, fn) { if (ev === 'close') { if (run.ended) queueMicrotask(fn); else run.closeFns.push(fn); } return run; },
    writeHead(status, headers) { run.status = status; run.headers = headers || {}; for (const c of run.clients) start(c); return run; },
    write(s) {
      if (run.ended) return false;
      s = String(s);
      if (run.status !== 200) { run.tail += s; return true; }
      for (const raw of s.split('\n')) {
        if (!raw) continue;
        let tool = null; try { const o = JSON.parse(raw); if (o && o.tool && o.tool.id) tool = o.tool.id; } catch { /* not ours */ }
        const line = { s: raw, tool }; run.lines.push(line);
        for (const c of run.clients) if (c.started) c.res.write(raw + '\n');
      }
      return true;
    },
    end(s) {
      if (run.ended) return run;
      if (s) { if (run.status === 200) run.write(s); else run.tail += String(s); }
      run.ended = true;
      const seen = [...run.clients].some((c) => c.started);   // was a page there to get the end?
      for (const c of [...run.clients]) finish(c);
      finished(seen);
      return run;
    },
  };
  function start(c) {
    if (c.started || run.status === null) return;
    c.started = true;
    c.res.writeHead(run.status, run.status === 200 ? { ...run.headers, 'x-run': id } : run.headers);
    if (run.status === 200) for (const l of run.lines.slice(c.from)) c.res.write(replay(l) + '\n');
    if (run.ended) finish(c);
  }
  function replay(l) {
    if (!l.tool || !session || session.pending.has(l.tool)) return l.s;
    try { return JSON.stringify({ toolDone: JSON.parse(l.s).tool }); } catch { return l.s; }
  }
  function finish(c) { if (!c.started) start(c); if (c.started) c.res.end(run.status === 200 ? '' : run.tail); clearInterval(c.hb); run.clients.delete(c); }
  function fireClose() { const fns = run.closeFns; run.closeFns = []; for (const f of fns) try { f(); } catch (e) { console.error(e); } }
  function finished(seen) {
    clearTimeout(run.detachTimer);
    fireClose();
    if (session) session.close();
    if (!seen && onOrphan) Promise.resolve().then(() => onOrphan(summary())).catch((e) => console.error('saving a finished reply:', e));
    run.keepTimer = setTimeout(() => runs.delete(id), KEEP_MS);
  }
  // what the reply came to, read back from its own lines (the same lines the page reads)
  function summary() {
    const out = { text: '', searches: [], sources: [], model: null, truncated: false, error: null, cut: run.cancelled, usage: null };
    if (run.status !== 200) { try { out.error = JSON.parse(run.tail).error || 'The model request failed.'; } catch { out.error = 'The model request failed.'; } return out; }
    for (const l of run.lines) {
      let o; try { o = JSON.parse(l.s); } catch { continue; }
      if (typeof o.d === 'string') out.text += o.d;
      else if (o.search) out.searches.push(String(o.search));
      else if (Array.isArray(o.sources)) { for (const x of o.sources) if (x && !out.sources.some((y) => y.url === x.url)) out.sources.push(x); }
      else if (o.error) out.error = String(o.error);
      else if (o.done) { out.model = o.model || null; out.truncated = !!o.truncated; out.usage = o.usage || null; }
    }
    return out;
  }
  // a page connects (res: its HTTP response; from: how many lines it already has)
  run.attach = (res, from = 0) => {
    const c = { res, from: Math.max(0, from | 0), started: false, hb: null };
    run.clients.add(c);
    clearTimeout(run.detachTimer); run.detachTimer = null;
    if (session && session.setAttached) session.setAttached(true);
    c.hb = setInterval(() => { if (c.started && run.status === 200 && !run.ended) res.write('{"hb":1}\n'); }, HB_MS);
    res.on('close', () => {
      clearInterval(c.hb);
      if (!run.clients.delete(c) || run.ended) return;
      if (!run.clients.size) detached();
    });
    start(c);
  };
  function detached() {
    if (session && session.setAttached) session.setAttached(false);
    clearTimeout(run.detachTimer);
    run.detachTimer = setTimeout(() => { if (!run.clients.size && !run.ended) run.cancel('away'); }, DETACH_MS);
  }
  // Stop, or nobody came back in time: stop the model and keep what it wrote
  run.cancel = (why = 'stop') => {
    if (run.ended) return;
    run.cancelled = true;
    if (run.status === null) run.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    fireClose();
    if (run.status === 200) run.write(JSON.stringify({ stopped: why }) + '\n');   // the end line, for pages attached now or later
    run.end();
  };
  runs.set(id, run);
  return run;
}
