#!/usr/bin/env node
// Digress server: serves the app, keeps your data on disk, and relays model calls to Claude
// (through the Claude Code CLI on your subscription, or the Anthropic API with a key).
// No dependencies; needs Node 18 or newer. Configuration comes from the environment or a .env file.
//
//   GET  /api/health                   {app:'digress', llm:bool, provider, why}
//   GET  /api/models                   {models:[[id,label]], defaultLabel}
//   POST /api/chat                     {system, messages, model, effort} -> streamed lines: {d}, then {done,model,truncated} or {error}
//   GET  /api/store/:coll              [{id, data}]          (coll: convs | index)
//   GET|PUT|PATCH|DELETE /api/store/:coll/:id
//   POST /api/files?type=...           raw body -> {id}
//   GET|DELETE /api/files/:id

import http from 'node:http';
import { promises as fs, createReadStream, readFileSync, existsSync, watch } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- config ---------------------------------------------------------------
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // localhost only by default; expose it with `tailscale serve`
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const API_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-opus-5-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 16000);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024;
const MAX_JSON = 8 * 1024 * 1024;
const WEB = path.join(ROOT, 'web', 'index.html');
const COLLECTIONS = new Set(['convs', 'index']);
const FILE_TYPES = new Set(['application/pdf', 'text/markdown', 'text/plain']);

// ---- helpers --------------------------------------------------------------
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_.:@+-]{1,200}$/.test(id) && id !== '.' && id !== '..';

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
const fail = (res, status, error) => send(res, status, { error });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  try { return JSON.parse(buf.toString('utf8') || 'null'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

// write via a temp file + rename, so a crash never leaves half a conversation on disk
async function writeAtomic(file, data) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}
// one write at a time per file
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// ---- storage: one JSON file per document ------------------------------------
const docPath = (coll, id) => path.join(DATA, coll, id + '.json');
async function listDocs(coll) {
  const dir = path.join(DATA, coll);
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push({ id: n.slice(0, -5), data: JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) }); } catch { /* skip unreadable */ }
  }
  return out;
}
async function readDoc(coll, id) {
  try { return JSON.parse(await fs.readFile(docPath(coll, id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// ---- model providers ----------------------------------------------------------
// claude-code: runs the Claude Code CLI (`claude -p`) signed in with your Claude subscription. Personal use only.
// anthropic:   calls the Anthropic API with ANTHROPIC_API_KEY.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
function hasClaudeCli() {
  try { return spawnSync(CLAUDE_BIN, ['--version'], { timeout: 15000, stdio: 'ignore' }).status === 0; } catch { return false; }
}
const PROVIDER = (process.env.LLM_PROVIDER || (API_KEY ? 'anthropic' : 'claude-code')).toLowerCase();
const LLM_OK = PROVIDER === 'anthropic' ? !!API_KEY : PROVIDER === 'claude-code' ? hasClaudeCli() : false;
const LLM_WHY = PROVIDER === 'anthropic'
  ? 'The server has no Anthropic API key. Add ANTHROPIC_API_KEY to .env and restart it.'
  : PROVIDER === 'claude-code'
    ? `The server could not find the Claude Code CLI ("${CLAUDE_BIN}"). Install it, run \`claude\` once to sign in, then restart the server.`
    : `Unknown LLM_PROVIDER "${PROVIDER}". Use claude-code or anthropic.`;

const CC_MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
let modelCache = null;
async function listModels() {
  if (PROVIDER === 'claude-code') return CC_MODELS;
  if (modelCache && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.list;
  let list = [];
  if (API_KEY) {
    try {
      const r = await fetch(API_BASE + '/v1/models?limit=100', { headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' } });
      if (r.ok) list = ((await r.json()).data || []).map((m) => [m.id, m.display_name || m.id]);
    } catch (e) { console.warn('model list failed:', e.message); }
  }
  if (!list.length) list = [[DEFAULT_MODEL, DEFAULT_MODEL]];
  modelCache = { at: Date.now(), list };
  return list;
}
const pickModel = (model) => (!model || model === 'auto' ? DEFAULT_MODEL : model);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function handleChat(req, res) {
  if (!LLM_OK) return fail(res, 503, LLM_WHY);
  const payload = await readJson(req);
  if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) return fail(res, 400, 'messages are required');
  return PROVIDER === 'claude-code' ? chatViaClaudeCode(payload, res) : chatViaApi(payload, res);
}
function startStream(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  return (o) => res.write(JSON.stringify(o) + '\n');
}
// both providers speak Anthropic's streaming events; this turns one into our {d} lines
function relayEvent(ev, out, st) {
  if (ev.type === 'message_start') st.model = ev.message && ev.message.model;
  else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { st.any = true; out({ d: ev.delta.text }); }
  else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') st.truncated = true;
  else if (ev.type === 'error') { st.failed = true; out({ error: (ev.error && ev.error.message) || 'The model returned an error.' }); }
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '');

// ---- provider: Claude Code CLI (your subscription) ----
function transcriptPrompt(messages) {
  const last = messages[messages.length - 1];
  if (messages.length === 1) return textOf(last.content);
  const turns = messages.slice(0, -1).map((m) => `<${m.role}>\n${textOf(m.content)}\n</${m.role}>`).join('\n\n');
  return `Our conversation so far:\n\n${turns}\n\nNow reply to my latest message:\n\n${textOf(last.content)}`;
}
async function chatViaClaudeCode(payload, res) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'digress-'));
  const sysFile = path.join(work, 'system.txt');
  // the system prompt can carry a whole paper, too long for a command-line argument, so it goes in a file
  await fs.writeFile(sysFile, payload.system || 'You are a helpful tutor.');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--system-prompt-file', sysFile, '--model', pickModel(payload.model)];
  if (EFFORTS.has(payload.effort)) args.push('--effort', payload.effort);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // make the CLI use your subscription sign-in, not an API key
  // run in an empty folder so no project files or CLAUDE.md get pulled in
  const child = spawn(CLAUDE_BIN, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const cleanup = () => fs.rm(work, { recursive: true, force: true }).catch(() => {});
  res.on('close', () => { if (!res.writableFinished && child.exitCode === null) child.kill('SIGTERM'); });
  child.stdin.end(transcriptPrompt(payload.messages));

  const out = startStream(res), st = { model: null, truncated: false, any: false, failed: false };
  let stderr = '', buf = '', resultErr = null;
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  child.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'stream_event' && m.event) relayEvent(m.event, out, st);
      else if (m.type === 'assistant' && !st.any && m.message) {
        // no partial chunks arrived (older CLI): send the whole reply at once
        const t = textOf(m.message.content); if (t) { st.any = true; out({ d: t }); }
        st.model = st.model || m.message.model;
      } else if (m.type === 'result' && m.is_error) resultErr = String(m.result || m.subtype || 'The model returned an error.');
    }
  });
  await new Promise((resolve) => child.on('close', resolve).on('error', (e) => { stderr += e.message; resolve(); }));
  cleanup();
  if (res.destroyed) return;
  if (resultErr || (child.exitCode !== 0 && !st.failed)) {
    let msg = resultErr || stderr.trim().split('\n').pop() || 'Claude Code exited with code ' + child.exitCode;
    if (/log ?in|auth|credential|api key/i.test(msg)) msg += ' — run `claude` on the server once and sign in with your Claude account.';
    out({ error: msg });
  } else if (!st.failed) out({ done: true, model: st.model, truncated: st.truncated });
  res.end();
}

// ---- provider: Anthropic API ----
function anthropicRequest({ system, messages, model, effort }, withEffort, signal) {
  const body = { model: pickModel(model), max_tokens: MAX_TOKENS, stream: true, messages };
  // cache the system prompt (which carries any document text), so follow-ups about the same paper are cheaper
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (withEffort && EFFORTS.has(effort)) body.output_config = { effort };
  return fetch(API_BASE + '/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
}
async function chatViaApi(payload, res) {
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); }); // the reader pressed Stop or left
  let upstream = await anthropicRequest(payload, true, ctrl.signal);
  if (upstream.status === 400 && EFFORTS.has(payload.effort)) {
    // some models don't take an effort setting: ask again without it
    const txt = await upstream.text();
    if (/effort|output_config/i.test(txt)) upstream = await anthropicRequest(payload, false, ctrl.signal);
    else return fail(res, 400, errorText(txt, 400));
  }
  if (!upstream.ok) return fail(res, upstream.status === 401 ? 502 : upstream.status, errorText(await upstream.text(), upstream.status));
  const out = startStream(res), st = { model: null, truncated: false, any: false, failed: false };
  let buf = '';
  const dec = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        relayEvent(ev, out, st);
      }
    }
    if (!st.failed) out({ done: true, model: st.model, truncated: st.truncated });
  } catch (e) {
    if (!ctrl.signal.aborted) out({ error: 'The connection to the model was interrupted.' });
  }
  res.end();
}
function errorText(txt, status) {
  try { const j = JSON.parse(txt); if (j.error && j.error.message) return j.error.message; } catch { /* not JSON */ }
  if (status === 401) return 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.';
  return 'The model request failed (' + status + ').';
}

// ---- dev live reload (DEV=1, `npm run dev`) ---------------------------------------
// The page keeps an EventSource open. When web/ changes we tell it to reload. When the server
// restarts (node --watch, after a server edit) the page reconnects, sees a new boot id and reloads.
// It holds off while a reply is streaming or you're typing, and shows a small "reload" pill instead.
const DEV = /^(1|true|yes)$/i.test(process.env.DEV || '');
const BOOT = crypto.randomBytes(6).toString('hex');
const devClients = new Set();
function devEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  res.write(`event: hello\ndata: ${BOOT}\n\n`);
  devClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); devClients.delete(res); });
}
if (DEV) {
  let t = null;
  watch(path.dirname(WEB), () => {
    clearTimeout(t);
    t = setTimeout(() => { for (const c of devClients) c.write('event: reload\ndata: web\n\n'); console.log('[dev] web changed, reloading', devClients.size, 'page(s)'); }, 120);
  });
}
const DEV_CLIENT = `<script>(()=>{
  let boot=null,want=false;
  const pill=document.createElement('button');
  pill.textContent='Updated · reload';
  pill.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 12px;border-radius:999px;border:0;background:#2563eb;color:#fff;font:13px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;display:none';
  pill.onclick=()=>location.reload();
  addEventListener('DOMContentLoaded',()=>document.body.appendChild(pill));
  const typing=()=>{const a=document.activeElement;return a&&(a.tagName==='TEXTAREA'||a.tagName==='INPUT'||a.isContentEditable)&&((a.value||a.textContent||'').trim().length>0)};
  const busy=()=>(window.__digressBusy&&window.__digressBusy())||typing();
  function go(){want=true;if(busy())pill.style.display='block'}
  let idle=0; // wait for ~2s of quiet after a reply so the app has saved it
  setInterval(()=>{idle=busy()?0:idle+1;if(want&&idle>=2)location.reload()},1000);
  const es=new EventSource('/__dev/events');
  es.addEventListener('hello',e=>{if(boot&&boot!==e.data)go();boot=e.data});
  es.addEventListener('reload',go);
})();</script>
`;

// ---- routes -----------------------------------------------------------------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    if (DEV) {
      const html = await fs.readFile(WEB, 'utf8');
      const i = html.lastIndexOf('</body>');
      return res.end(i < 0 ? html + DEV_CLIENT : html.slice(0, i) + DEV_CLIENT + html.slice(i));
    }
    return createReadStream(WEB).pipe(res);
  }
  if (DEV && url.pathname === '/__dev/events') return devEvents(req, res);
  if (parts[0] !== 'api') return fail(res, 404, 'Not found');

  if (parts[1] === 'health' && req.method === 'GET') return send(res, 200, { app: 'digress', llm: LLM_OK, provider: PROVIDER, why: LLM_OK ? undefined : LLM_WHY });
  if (parts[1] === 'models' && req.method === 'GET') {
    const models = await listModels();
    const d = models.find((m) => m[0] === DEFAULT_MODEL);
    return send(res, 200, { models, defaultLabel: d ? d[1] : DEFAULT_MODEL });
  }
  if (parts[1] === 'chat' && req.method === 'POST') return handleChat(req, res);

  if (parts[1] === 'store') {
    const [, , coll, id] = parts;
    if (!COLLECTIONS.has(coll)) return fail(res, 404, 'Unknown collection');
    if (!id) return req.method === 'GET' ? send(res, 200, await listDocs(coll)) : fail(res, 405, 'Method not allowed');
    if (!validId(id) || parts.length > 4) return fail(res, 400, 'Bad id');
    await fs.mkdir(path.join(DATA, coll), { recursive: true });
    const file = docPath(coll, id);
    if (req.method === 'GET') { const d = await readDoc(coll, id); return d === null ? fail(res, 404, 'Not found') : send(res, 200, d); }
    if (req.method === 'PUT') { const d = await readJson(req); if (!d || typeof d !== 'object' || Array.isArray(d)) return fail(res, 400, 'Body must be an object'); await withLock(file, () => writeAtomic(file, JSON.stringify(d))); return send(res, 200, { ok: true }); }
    if (req.method === 'PATCH') {
      const p = await readJson(req);
      return withLock(file, async () => {
        const d = await readDoc(coll, id);
        if (d === null) return fail(res, 404, 'Not found');
        Object.assign(d, p); await writeAtomic(file, JSON.stringify(d)); send(res, 200, { ok: true });
      });
    }
    if (req.method === 'DELETE') { await withLock(file, () => fs.rm(file, { force: true })); return send(res, 200, { ok: true }); }
    return fail(res, 405, 'Method not allowed');
  }

  if (parts[1] === 'files') {
    const dir = path.join(DATA, 'files');
    await fs.mkdir(dir, { recursive: true });
    if (req.method === 'POST' && parts.length === 2) {
      const type = url.searchParams.get('type') || '';
      if (!FILE_TYPES.has(type)) return fail(res, 415, 'Only PDF, Markdown and text files are accepted');
      const buf = await readBody(req, MAX_UPLOAD);
      if (!buf.length) return fail(res, 400, 'Empty file');
      const id = crypto.randomBytes(16).toString('hex');
      await fs.writeFile(path.join(dir, id), buf);
      await fs.writeFile(path.join(dir, id + '.meta.json'), JSON.stringify({ type, size: buf.length, created: Date.now() }));
      return send(res, 200, { id });
    }
    const id = parts[2];
    if (!id || !/^[a-f0-9]{32}$/.test(id) || parts.length > 3) return fail(res, 400, 'Bad id');
    const file = path.join(dir, id);
    if (req.method === 'GET') {
      let meta; try { meta = JSON.parse(await fs.readFile(file + '.meta.json', 'utf8')); } catch { return fail(res, 404, 'Not found'); }
      res.writeHead(200, { 'content-type': meta.type, 'content-length': meta.size, 'cache-control': 'private, max-age=31536000, immutable' });
      return createReadStream(file).pipe(res);
    }
    if (req.method === 'DELETE') { await fs.rm(file, { force: true }); await fs.rm(file + '.meta.json', { force: true }); return send(res, 200, { ok: true }); }
    return fail(res, 405, 'Method not allowed');
  }
  return fail(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e.status) return fail(res, e.status, e.status === 413 ? 'That is too large.' : e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Server error');
    else res.end();
  });
});
server.listen(PORT, HOST, () => {
  console.log(`Digress is running at http://${HOST}:${PORT}`);
  console.log(`Data folder: ${DATA}`);
  console.log(LLM_OK ? `Model: ${PROVIDER === 'claude-code' ? 'Claude Code CLI (your Claude subscription)' : 'Anthropic API'}, default ${DEFAULT_MODEL}` : 'No model yet: ' + LLM_WHY);
});
