#!/usr/bin/env node
// Digress server: serves the app, keeps your data on disk, and relays model calls to Claude
// (through the Claude Code CLI on your subscription, or the Anthropic API with a key).
// No dependencies; needs Node 18 or newer. Configuration comes from the environment or a .env file.
//
//   GET  /api/health                   {app:'digress', llm:bool, provider, web:bool, why}
//   GET  /api/models                   {models:[[id,label]], defaultLabel, default, chosen}
//   GET|PUT /api/prefs                 {defaultModel}: preferences shared by every device
//   GET  /api/guide                    {docs:[{name,file,text}]}: Digress's own documentation (Ask about Digress)
//   POST /api/chat                     {system, messages, model, effort, web} -> streamed lines: {d}, {search}, {sources},
//                                      then {done,model,truncated} or {error}  (see PROVIDERS)
//   GET  /api/store/:coll              [{id, data}]          (coll: convs | index)
//   GET|PUT|PATCH|DELETE /api/store/:coll/:id   (convs: PUT with x-base-rev -> 409 {current} / 410; GET ?rev -> {rev})
//   GET /api/chat/run/:id?from=N       reattach to a reply (runs.mjs);  POST /api/chat/stop {chat}
//   GET|PUT /api/layout/:conv[?device=]  per-device layout
//   POST /api/files?type=...           raw body -> {id}
//   GET|DELETE /api/files/:id

import http from 'node:http';
import { promises as fs, createReadStream, readFileSync, existsSync, watch } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import * as chatgpt from './chatgpt.mjs';
import { fetchDocument, WARNINGS } from './fetchdoc.mjs';
import { normalizeMessages, toAnthropic, toClaudeCodeBlocks, IMAGE_TYPES, isImage } from './content.mjs';
import { createRun, getRun, DETACH_MS } from './runs.mjs';
import { GUIDE_DOCS } from './guide.mjs';
import { openSession, deliverResult, handleMcp, toolsForAnthropic, resultForAnthropic, CLAUDE_CODE_TOOL_NAMES, MAX_TOOL_ROUNDS } from './doctools.mjs';

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
const MAX_CHAT_JSON = 64 * 1024 * 1024; // a conversation can carry images (snips, pages, screenshots), each up to 5 MB
const WEB = path.join(ROOT, 'web', 'index.html');
const COLLECTIONS = new Set(['convs', 'index', 'cards']); // cards: flashcards, kept apart from conversations because review spans all of them
const FILE_TYPES = new Set(['application/pdf', 'text/markdown', 'text/plain', ...IMAGE_TYPES]); // images: pasted screenshots (no SVG: it can carry scripts)

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
async function readJson(req, limit = MAX_JSON) {
  const buf = await readBody(req, limit);
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

// change a stored conversation in place, as one more version (rev), the way a page's save would
async function updateConv(id, fn) {
  const file = docPath('convs', id);
  return withLock(file, async () => {
    const d = await readDoc('convs', id);
    if (!d || !fn(d)) return false;
    d.rev = (d.rev || 0) + 1; d.updated = Date.now();
    await writeAtomic(file, JSON.stringify(d));
    return true;
  });
}
const LAYOUT_DAYS = Number(process.env.LAYOUT_DAYS || 90);
const layoutPath = (conv) => path.join(DATA, 'layouts', conv + '.json');

// Uploaded files (documents, pasted images, article images, card snips) are referenced from conversations and
// cards as "asset" / "assetId". Delete the ones nothing references any more. Files younger than minAgeMs are
// left alone (a page uploads before it saves the conversation that points at it). If any conversation or card
// can't be read, nothing is deleted: better a leftover file than a missing one.
async function sweepFiles(minAgeMs = 24 * 3600e3) {
  const dir = path.join(DATA, 'files');
  let names; try { names = await fs.readdir(dir); } catch { return 0; }
  const used = new Set();
  for (const coll of ['convs', 'cards']) {
    let files = []; try { files = (await fs.readdir(path.join(DATA, coll))).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const n of files) {
      let txt; try { txt = await fs.readFile(path.join(DATA, coll, n), 'utf8'); JSON.parse(txt); } catch { return 0; }
      for (const m of txt.matchAll(/"asset(?:Id)?":"([a-f0-9]{32})"/g)) used.add(m[1]);
    }
  }
  let gone = 0;
  for (const n of names) {
    const m = n.match(/^([a-f0-9]{32})$/); if (!m || used.has(m[1])) continue;
    let created = 0; try { created = JSON.parse(await fs.readFile(path.join(dir, n + '.meta.json'), 'utf8')).created || 0; } catch { /* no meta: old */ }
    if (Date.now() - created < minAgeMs) continue;
    await fs.rm(path.join(dir, n), { force: true }); await fs.rm(path.join(dir, n + '.meta.json'), { force: true }); gone++;
  }
  return gone;
}

// ---- model providers ----------------------------------------------------------
// claude-code: runs the Claude Code CLI (`claude -p`) signed in with your Claude subscription. Personal use only.
// anthropic:   calls the Anthropic API with ANTHROPIC_API_KEY.
// chatgpt:     ChatGPT models on your ChatGPT plan, via "Sign in with ChatGPT" (server/chatgpt.mjs).
// One Claude provider is used (the CLI, or the API when there's a key), and ChatGPT joins it once you've
// signed in, so both sets of models show in the picker. Each reply goes to the provider that owns its model.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
let cliFound = null;
function hasClaudeCli() {
  if (cliFound === null) { try { cliFound = spawnSync(CLAUDE_BIN, ['--version'], { timeout: 15000, stdio: 'ignore' }).status === 0; } catch { cliFound = false; } }
  return cliFound;
}
// Every provider has the same shape, so adding one means adding an entry here:
//   label        shown in the server log
//   available()  can it run at all (key present, CLI installed, signed in)?   why: what to do when it can't
//   models()     [[id, label]] it offers
//   web          can it search the web when a request asks for it?
//   chat(payload, res)  streams the reply as NDJSON lines (see startStream / relayEvent):
//       {d:"text"}                    reply text, in order
//       {search:"query"}              the model ran a web search
//       {sources:[{title, url}]}      pages that search returned
//       then {done:true, model, truncated} or {error}
//       {tool:{id, name, input}}      (from doctools.mjs) the model called a document tool; the page runs it
//     payload = {system, messages:[{role, content}], model, effort, web, session}
//     web is only true when the reader turned web access on for this message. Off means the provider
//     must not reach the internet at all. Keep it to search: no page fetching from this machine, no code.
//   tools        can it use the document tools (server/doctools.mjs)? When payload.session is set, it offers
//     them and runs the loop: while the model stops on tool calls, run each through session.call and send
//     the results back. Set session.out once the stream starts.
const PROVIDERS = {
  'claude-code': {
    label: 'Claude Code CLI (your Claude subscription)', web: true, tools: true, available: hasClaudeCli, models: async () => CC_MODELS, chat: chatViaClaudeCode,
    why: `The server could not find the Claude Code CLI ("${CLAUDE_BIN}"). Install it, run \`claude\` once to sign in, then restart the server.`,
  },
  anthropic: {
    label: 'Anthropic API', web: true, tools: true, available: () => !!API_KEY, models: anthropicModels, chat: chatViaApi,
    why: 'The server has no Anthropic API key. Add ANTHROPIC_API_KEY to .env and restart it.',
  },
  chatgpt: {
    label: 'ChatGPT (your ChatGPT plan)', web: true, tools: true, available: chatgpt.available, why: chatgpt.WHY, models: chatgpt.listModels,
    chat: (payload, res) => chatgpt.chat(payload, res, { startStream, sourcesLine, fail }),
  },
};
// LLM_PROVIDER picks the default (used when the picker says "Default"); the others still work when available.
const PRIMARY = (process.env.LLM_PROVIDER || (API_KEY ? 'anthropic' : 'claude-code')).toLowerCase();
const CLAUDE_SIDE = ['anthropic', 'claude-code'].includes(PRIMARY) ? PRIMARY : API_KEY ? 'anthropic' : 'claude-code';
const CANDIDATES = [...new Set([PRIMARY, CLAUDE_SIDE, 'chatgpt'])].filter((k) => PROVIDERS[k]);
const enabled = () => CANDIDATES.filter((k) => PROVIDERS[k].available()); // checked per request: signing in needs no restart
const llmWhy = () => (PROVIDERS[PRIMARY] ? PROVIDERS[PRIMARY].why : `Unknown LLM_PROVIDER "${PRIMARY}". Use ${Object.keys(PROVIDERS).join(', ')}.`);
const WEB_ALLOWED = !/^(0|false|no|off)$/i.test(process.env.WEB_SEARCH || '');
const webOk = (k) => WEB_ALLOWED && !!(PROVIDERS[k] && PROVIDERS[k].web);
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 5);

const CC_MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
// all models from every available provider, remembering which provider each belongs to
const owner = new Map();
async function listModels() {
  const all = [];
  for (const k of enabled()) for (const m of await PROVIDERS[k].models()) { owner.set(m[0], k); all.push(m); }
  return all;
}
// Preferences shared by every device (data/prefs.json): today just the default model, chosen in the app.
const PREFS_FILE = path.join(DATA, 'prefs.json');
let prefsCache = null;
async function getPrefs() {
  if (!prefsCache) { try { prefsCache = JSON.parse(await fs.readFile(PREFS_FILE, 'utf8')); } catch { prefsCache = {}; } }
  return prefsCache;
}
async function setPrefs(patch) {
  return withLock(PREFS_FILE, async () => {
    const next = { ...(await getPrefs()), ...patch };
    for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
    await fs.mkdir(DATA, { recursive: true }); await writeAtomic(PREFS_FILE, JSON.stringify(next)); prefsCache = next; return next;
  });
}
// "Default" means: the default chosen in the app (if a connected provider still offers it), else DEFAULT_MODEL
// if set, else the default provider's first choice
async function defaultModel() {
  const chosen = (await getPrefs()).defaultModel;
  if (chosen) { const ids = (await listModels()).map((m) => m[0]); if (ids.includes(chosen)) return chosen; }
  return builtinDefault();
}
async function builtinDefault() {
  if (process.env.DEFAULT_MODEL) return process.env.DEFAULT_MODEL;
  const k = enabled()[0];
  if (k === 'chatgpt') { const m = await chatgpt.listModels(); if (m.length) return m[0][0]; }
  return DEFAULT_MODEL;
}
async function providerFor(model) {
  const on = enabled();
  if (!owner.has(model)) await listModels();
  const k = owner.get(model);
  if (k && on.includes(k)) return k;
  // not in any list (an older Claude model id, say): Claude ids go to the Claude provider
  return /^claude/i.test(model) && on.includes(CLAUDE_SIDE) ? CLAUDE_SIDE : on[0];
}
let anthropicCache = null;
const apiWindows = new Map();   // model id -> context window (max_input_tokens, from the Models API)
async function anthropicModels() {
  if (anthropicCache && Date.now() - anthropicCache.at < 10 * 60 * 1000) return anthropicCache.list;
  let list = [];
  if (API_KEY) {
    try {
      const r = await fetch(API_BASE + '/v1/models?limit=100', { headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' } });
      if (r.ok) { const data = (await r.json()).data || []; list = data.map((m) => [m.id, m.display_name || m.id]); for (const m of data) if (Number.isFinite(m.max_input_tokens)) apiWindows.set(m.id, m.max_input_tokens); }
    } catch (e) { console.warn('model list failed:', e.message); }
  }
  if (!list.length) list = [[DEFAULT_MODEL, DEFAULT_MODEL]];
  anthropicCache = { at: Date.now(), list };
  return list;
}
// how Claude Code, running on this machine, reaches this server (for the document tools' MCP endpoint)
const selfUrl = () => { const h = hostOf(HOST); return `http://${!h || ['0.0.0.0', '[::]', 'localhost'].includes(h) ? '127.0.0.1' : h}:${server.address().port}`; };
const pickModel = (model) => (!model || model === 'auto' ? DEFAULT_MODEL : model);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function handleChat(req, res) {
  if (!enabled().length) return fail(res, 503, llmWhy());
  const payload = await readJson(req, MAX_CHAT_JSON);
  if (!payload) return fail(res, 400, 'messages are required');
  // checked here, once, for every provider: anything not understood is refused, never silently dropped
  try { payload.messages = normalizeMessages(payload.messages); } catch (e) { return fail(res, e.status || 400, e.message); }
  payload.model = !payload.model || payload.model === 'auto' ? await defaultModel() : String(payload.model);
  const k = await providerFor(payload.model);
  payload.web = payload.web === true && webOk(k); // the one place web access gets switched on, for every provider
  // document tools: only when the page asked for them (a conversation with a document open) and the provider can
  // The reply is a run (runs.mjs): the provider writes into it, and this request is only the first page
  // watching it. If the connection drops, the model keeps going and the page can reattach.
  const id = typeof payload.chat === 'string' && /^[a-f0-9]{32}$/.test(payload.chat) ? payload.chat : crypto.randomBytes(16).toString('hex');
  if (getRun(id)) return fail(res, 409, 'That reply is already running.');
  payload.session = payload.tools === true && PROVIDERS[k].tools ? openSession(id) : null;
  const target = payload.save && validId(payload.save.conv) && validId(payload.save.msg) ? { conv: payload.save.conv, msg: payload.save.msg } : null;
  delete payload.tools; delete payload.chat; delete payload.save;
  const run = createRun(id, { session: payload.session, onOrphan: target ? (r) => saveOrphan(target, id, r) : null });
  run.attach(res, 0);
  Promise.resolve().then(() => PROVIDERS[k].chat(payload, run)).catch((e) => {
    console.error('chat:', e);
    if (run.ended) return;
    if (!run.headersSent) fail(run, 500, 'Server error'); else { run.write(JSON.stringify({ error: 'The server failed while writing this reply.' }) + '\n'); run.end(); }
  });
}
// A reply that finished (or was given up on) while no page was watching: write it into its conversation, the
// way the page would have, so it's there when you come back. Only if that message is still waiting for this
// run: if it was deleted or asked again meanwhile, the result is dropped.
async function saveOrphan({ conv, msg }, runId, r) {
  await updateConv(conv, (d) => {
    const m = d.msgs && d.msgs[msg];
    if (!m || m.run !== runId) return false;
    m.content = r.text;
    if (r.model) m.model = r.model;
    if (r.usage) m.usage = r.usage;
    if (r.searches.length) m.searches = r.searches;
    if (r.sources.length) m.sources = r.sources.slice(0, 30);
    if (r.error) m.error = r.error;
    else if (r.cut) { m.cut = true; m.error = 'Cut off before it finished: no page came back to it within ' + Math.round(DETACH_MS / 60000) + ' minutes.'; }
    else if (r.truncated) m.error = 'Reply was cut off (length limit).';
    delete m.run;
    return true;
  });
}
function startStream(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  return (o) => res.write(JSON.stringify(o) + '\n');
}
// Both Claude providers speak Anthropic's streaming events; this turns them into our lines.
// It also rebuilds the content blocks of the current message (st.blocks), which the API needs
// to resume a turn the server paused in the middle of searching.
const SEARCH_TOOLS = new Set(['web_search', 'WebSearch']);
function sourcesLine(list) {
  const seen = new Set(), out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const url = r && typeof r.url === 'string' ? r.url : '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url); out.push({ title: String(r.title || url).slice(0, 300), url: url.slice(0, 2000) });
  }
  return out.length ? { sources: out.slice(0, 20) } : null;
}
// Token counts, from each request's message_start / message_delta (the API and Claude Code's stream events alike).
// usage.ctx is the last request's whole input (new + written to cache + read from cache): how full the context
// was when the reply ended. With document tools or a paused search a reply is several requests, each resending
// everything, so adding them up would overstate it. out is everything written across them; rounds, how many.
function useRound(st, u, first) {
  if (!u) return;
  const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const g = st.usage || (st.usage = { ctx: 0, cached: 0, out: 0, rounds: 0 });
  if (first) { g.rounds++; g.lastOut = 0; }
  if (ctx) { g.ctx = ctx; g.cached = u.cache_read_input_tokens || 0; }
  if (typeof u.output_tokens === 'number') { g.out += u.output_tokens - (g.lastOut || 0); g.lastOut = u.output_tokens; }   // a request's output count only grows
}
// the {usage} on a reply's done line, with the model's context window when the provider says it
function usageLine(st, window) {
  if (!st.usage || !st.usage.ctx) return {};
  const { ctx, cached, out, rounds } = st.usage;
  return { usage: { ctx, cached, out, rounds, ...(window ? { window } : {}) } };
}
function relayEvent(ev, out, st) {
  if (ev.type === 'message_start') { st.model = ev.message && ev.message.model; st.blocks = []; useRound(st, ev.message && ev.message.usage, true); }
  else if (ev.type === 'content_block_start' && ev.content_block) {
    const b = { ...ev.content_block };
    (st.blocks || (st.blocks = []))[ev.index] = b;
    if (b.type === 'tool_use' || b.type === 'server_tool_use') b._json = '';
    if (b.type === 'text' && st.any) st.sep = true; // text again after a search: start a new paragraph
    if (b.type === 'web_search_tool_result') { const s = sourcesLine(b.content); if (s) out(s); }
  } else if (ev.type === 'content_block_delta' && ev.delta) {
    const d = ev.delta, b = st.blocks && st.blocks[ev.index];
    if (d.type === 'text_delta') {
      if (b) b.text = (b.text || '') + d.text;
      let t = d.text;
      if (st.sep) { t = t.replace(/^\s+/, ''); if (!t) return; t = '\n\n' + t; st.sep = false; }
      st.any = true; out({ d: t });
    } else if (!b) return;
    else if (d.type === 'input_json_delta') b._json += d.partial_json || '';
    else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
    else if (d.type === 'signature_delta') b.signature = d.signature;
    else if (d.type === 'citations_delta') (b.citations || (b.citations = [])).push(d.citation);
  } else if (ev.type === 'content_block_stop') {
    const b = st.blocks && st.blocks[ev.index];
    if (b && '_json' in b) {
      try { b.input = b._json ? JSON.parse(b._json) : b.input || {}; } catch { b.input = {}; }
      delete b._json;
      if (SEARCH_TOOLS.has(b.name) && b.input && b.input.query) out({ search: String(b.input.query).slice(0, 500) });
    }
  } else if (ev.type === 'message_delta' && ev.delta) {
    useRound(st, ev.usage, false);
    st.stop = ev.delta.stop_reason;
    if (st.stop === 'max_tokens') st.truncated = true;
  } else if (ev.type === 'error') { st.failed = true; out({ error: (ev.error && ev.error.message) || 'The model returned an error.' }); }
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '');

// ---- provider: Claude Code CLI (your subscription) ----
async function chatViaClaudeCode(payload, res) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'digress-'));
  const sysFile = path.join(work, 'system.txt');
  // the system prompt can carry a whole paper, too long for a command-line argument, so it goes in a file
  await fs.writeFile(sysFile, payload.system || 'You are a helpful tutor.');
  // Tools are off unless the reader turned web access on, and then the only one is WebSearch, which runs
  // on Anthropic's side. Never WebFetch: it fetches from this machine, so a page could steer it at
  // this server (127.0.0.1, no login) or the local network.
  // The document tools come from this server, as an MCP server made for this one reply (doctools.mjs).
  const s = payload.session;
  const allowed = [...(payload.web ? ['WebSearch'] : []), ...(s ? CLAUDE_CODE_TOOL_NAMES : [])];
  const tools = ['--tools', payload.web ? 'WebSearch' : '', ...(allowed.length ? ['--allowedTools', allowed.join(',')] : [])];
  // And none of your own Claude Code setup: no MCP servers, hooks, CLAUDE.md, memory, skills or plugins.
  // --safe-mode does all of that, but it also turns off --mcp-config servers, so with document tools the
  // same is done piece by piece: no settings files (hooks, plugins, permissions), hooks off anyway, only our
  // MCP server, no slash commands or skills, and no CLAUDE.md or auto-memory (the two env switches below).
  const isolate = s
    ? ['--mcp-config', JSON.stringify({ mcpServers: { digress: { type: 'http', url: `${selfUrl()}/api/mcp/${s.token}` } } }), '--strict-mcp-config',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--max-turns', String(MAX_TOOL_ROUNDS)]
    : ['--strict-mcp-config', '--safe-mode', '--disable-slash-commands'];
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...tools, ...isolate, '--no-session-persistence', '--system-prompt-file', sysFile, '--model', pickModel(payload.model)];
  if (EFFORTS.has(payload.effort)) args.push('--effort', payload.effort);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // make the CLI use your subscription sign-in, not an API key
  if (s) Object.assign(env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  // run in an empty folder so no project files or CLAUDE.md get pulled in
  const child = spawn(CLAUDE_BIN, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const cleanup = () => fs.rm(work, { recursive: true, force: true }).catch(() => {});
  res.on('close', () => { if (!res.writableFinished && child.exitCode === null) child.kill('SIGTERM'); });
  // the conversation goes in as one stream-json user message: a transcript with any images in place (server/content.mjs)
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: toClaudeCodeBlocks(payload.messages) } }) + '\n');

  const out = startStream(res), st = { model: null, truncated: false, any: false, failed: false };
  if (s) s.out = out;
  let stderr = '', buf = '', resultErr = null;
  // decode as UTF-8 across chunk boundaries: a character split between two chunks would otherwise turn into �
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
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
      } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
        // WebSearch results come back as a tool result: "Web search results for query: ...\n\nLinks: [{title,url},...]\n..."
        for (const b of m.message.content) {
          const txt = b && b.type === 'tool_result' ? textOf(b.content) : '';
          if (!txt.startsWith('Web search results for query')) continue; // a document tool's result can contain anything
          const at = txt.indexOf('Links: [');
          if (at < 0) continue;
          const end = txt.indexOf('\n', at), raw = txt.slice(at + 7, end < 0 ? undefined : end);
          try { const s = sourcesLine(JSON.parse(raw)); if (s) out(s); } catch { /* not the shape we know: skip the sources */ }
        }
      } else if (m.type === 'result') {
        if (m.is_error) resultErr = String(m.result || m.subtype || 'The model returned an error.');
        // the context window of the model that answered (the CLI reports it per model it used)
        const mu = m.modelUsage && typeof m.modelUsage === 'object' ? m.modelUsage : {};
        const e = mu[st.model] || Object.values(mu).find((x) => x && x.contextWindow);
        if (e && Number.isFinite(e.contextWindow)) st.window = e.contextWindow;
      }
    }
  });
  await new Promise((resolve) => child.on('close', resolve).on('error', (e) => { stderr += e.message; resolve(); }));
  cleanup();
  if (res.destroyed) return;
  if (resultErr || (child.exitCode !== 0 && !st.failed)) {
    let msg = resultErr || stderr.trim().split('\n').pop() || 'Claude Code exited with code ' + child.exitCode;
    if (/log ?in|auth|credential|api key/i.test(msg)) msg += ' — run `claude` on the server once and sign in with your Claude account.';
    out({ error: msg });
  } else if (!st.failed) out({ done: true, model: st.model, truncated: st.truncated, ...usageLine(st, st.window) });
  res.end();
}

// ---- provider: Anthropic API ----
function anthropicRequest({ system, messages, model, effort, web, session }, withEffort, signal) {
  const body = { model: pickModel(model), max_tokens: MAX_TOKENS, stream: true, messages };
  // cache the system prompt (which carries any document text), so follow-ups about the same paper are cheaper
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (withEffort && EFFORTS.has(effort)) body.output_config = { effort };
  // web search runs on Anthropic's servers; nothing is fetched from this machine
  const tools = [...(web ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES }] : []), ...(session ? toolsForAnthropic() : [])];
  if (tools.length) body.tools = tools;
  return fetch(API_BASE + '/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
}
async function chatViaApi(payload, res) {
  payload = { ...payload, messages: toAnthropic(payload.messages) };
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); }); // the reader pressed Stop or left
  let upstream = await anthropicRequest(payload, true, ctrl.signal), withEffort = true;
  if (upstream.status === 400 && EFFORTS.has(payload.effort)) {
    // some models don't take an effort setting: ask again without it
    const txt = await upstream.text();
    if (/effort|output_config/i.test(txt)) { withEffort = false; upstream = await anthropicRequest(payload, false, ctrl.signal); }
    else return fail(res, 400, errorText(txt, 400));
  }
  if (!upstream.ok) return fail(res, upstream.status === 401 ? 502 : upstream.status, errorText(await upstream.text(), upstream.status));
  const out = startStream(res), st = { model: null, truncated: false, any: false, failed: false };
  if (payload.session) payload.session.out = out;
  const dec = new TextDecoder();
  let messages = payload.messages, pauses = 0, rounds = 0;
  try {
    // The agentic loop: one request per round. The model's reply streams to the page; if it stopped to call
    // document tools, run them (in the page, via session.call), add its reply and the results to the
    // conversation, and ask again. It ends when the model answers without calling a tool.
    for (let turn = 0; ; turn++) {
      if (turn > 0) {
        upstream = await anthropicRequest({ ...payload, messages }, withEffort, ctrl.signal);
        if (!upstream.ok) { st.failed = true; out({ error: errorText(await upstream.text(), upstream.status) }); break; }
      }
      let buf = '';
      st.stop = null;
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
      if (st.failed) break;
      const blocks = (st.blocks || []).filter(Boolean);
      // a long search turn can pause; send back what came so far and the model carries on
      if (st.stop === 'pause_turn' && pauses++ < 4) { messages = [...messages, { role: 'assistant', content: blocks }]; continue; }
      const calls = blocks.filter((b) => b.type === 'tool_use');
      if (st.stop === 'tool_use' && payload.session && calls.length && ++rounds < MAX_TOOL_ROUNDS) {
        const results = [];
        for (const b of calls) results.push(resultForAnthropic(await payload.session.call(b.name, b.input), b.id));
        messages = [...messages, { role: 'assistant', content: blocks }, { role: 'user', content: results }];
        continue;
      }
      break;
    }
    if (!st.failed) {
      if (!apiWindows.size) await anthropicModels().catch(() => {});
      out({ done: true, model: st.model, truncated: st.truncated, ...usageLine(st, apiWindows.get(st.model) || apiWindows.get(pickModel(payload.model))) });
    }
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

// ---- open a document from a link (see server/fetchdoc.mjs for what is and isn't fetched) -------------
// POST {url, confirm:[warning codes the reader accepted]} -> the file's bytes, with x-doc-kind, x-doc-name
// and x-doc-url (final address, after redirects) headers; or {error} / 409 {error, warnings:[{code,text}], url}.
// Nothing is stored here: the page stores it the same way as an uploaded file.
async function handleFetchDoc(req, res) {
  const p = await readJson(req);
  if (!p || typeof p.url !== 'string' || p.url.length > 4000) return fail(res, 400, 'A link is required.');
  const ctrl = new AbortController();
  req.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  try {
    const d = await fetchDocument(p.url, { confirmed: Array.isArray(p.confirm) ? p.confirm.map(String) : [], maxBytes: MAX_UPLOAD, signal: ctrl.signal, testAllow: process.env.DOC_FETCH_TEST_ALLOW || '', want: p.image === true ? 'image' : 'doc' });
    res.writeHead(200, { 'content-type': d.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment',
      'x-doc-kind': d.kind, 'x-doc-name': encodeURIComponent(d.name), 'x-doc-url': encodeURIComponent(d.url) });
    res.end(d.body);
  } catch (e) {
    if (ctrl.signal.aborted) return res.destroy();
    if (!e.status) { console.error('fetch-doc:', e); return fail(res, 502, 'Could not download that link.'); }
    if (e.warnings) return send(res, 409, { error: e.message, url: e.url, warnings: e.warnings.map((code) => ({ code, text: WARNINGS[code] })) });
    return fail(res, e.status, e.message);
  }
}

// ---- who may talk to this server ----------------------------------------------
// The server has no login: anything that can reach it can read and change every conversation.
// Listening on 127.0.0.1 keeps other machines out, but not web pages open in your own browser.
// Two browser tricks need closing:
//
//  1. DNS rebinding. A site you visit (evil.example) briefly points its own name at 127.0.0.1.
//     Your browser then treats this server as "evil.example", the same origin as the attacker's
//     page, so the page may read every response. The request still says `Host: evil.example`,
//     so we only answer requests addressed to a name we expect.
//  2. Cross-site requests. Any page can send a form-style POST here (to start a model call on your
//     subscription, or upload a file) even though it can't read the answer. Browsers mark those
//     with an Origin header naming the other site, so we refuse requests whose Origin isn't us.
//
// Expected names, all configurable in .env without code changes:
//   - localhost and the loopback addresses: always.
//   - the address in HOST, if you bound the server to a specific one (HOST=192.168.1.20).
//   - ALLOWED_HOSTS, comma separated. An entry starting with a dot matches any name under it.
//     Default ".ts.net", for Tailscale Serve (see README); only Tailscale controls DNS for those names.
//     Setting ALLOWED_HOSTS replaces the default, so add ".ts.net" yourself if you still want it,
//     or set it to "none" to allow only localhost.
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? '.ts.net').split(',').map((h) => h.trim().toLowerCase()).filter((h) => h && h !== 'none');
function hostOf(value) {
  try { return new URL(value.includes('://') ? value : 'http://' + value).hostname.toLowerCase(); } catch { return null; }
}
const EXACT = new Set(['localhost', '127.0.0.1', '[::1]', ...ALLOWED_HOSTS.filter((h) => !h.startsWith('.'))]);
const bound = hostOf(HOST);
if (bound && !['0.0.0.0', '[::]'].includes(bound)) EXACT.add(bound); // 0.0.0.0 means "every address": list the names you use
const SUFFIXES = ALLOWED_HOSTS.filter((h) => h.startsWith('.'));
const knownHost = (h) => !!h && (EXACT.has(h) || SUFFIXES.some((s) => h.endsWith(s)));
function requestAllowed(req) {
  const host = hostOf(req.headers.host || '');
  if (!knownHost(host)) return false; // rebinding: the browser thinks it's talking to some other site
  const origin = req.headers.origin;
  // no Origin: not a cross-site browser request (same-origin GETs, curl, the tests).
  // "null" comes from sandboxed frames and file:// pages; they don't get in either.
  return !origin || hostOf(origin) === host;
}

// ---- routes -----------------------------------------------------------------
async function route(req, res) {
  // checked before anything else, so a refused request can't read or change data or start a model call
  if (!requestAllowed(req)) return fail(res, 403, 'This server only answers its own page (see ALLOWED_HOSTS in .env.example).');
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
  // sw.js: the service worker that lets you review flashcards offline; prompts.js: what the page tells the
  // model; threads.js: how a conversation's threads fit together
  if (req.method === 'GET' && ['/sw.js', '/prompts.js', '/threads.js'].includes(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return createReadStream(path.join(ROOT, 'web', url.pathname.slice(1))).pipe(res);
  }
  // the logo: the browser tab icon (follows light/dark) and the phone home-screen icon
  if (req.method === 'GET' && ['/icon.svg', '/apple-touch-icon.png'].includes(url.pathname)) {
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
    return createReadStream(path.join(ROOT, 'web', url.pathname.slice(1))).pipe(res);
  }
  if (DEV && url.pathname === '/__dev/events') return devEvents(req, res);
  if (parts[0] !== 'api') return fail(res, 404, 'Not found');

  if (parts[1] === 'health' && req.method === 'GET') {
    const on = enabled();
    return send(res, 200, { app: 'digress', llm: on.length > 0, provider: on[0] || PRIMARY, providers: on, web: on.some(webOk), tools: on.length > 0 && on.every((k) => PROVIDERS[k].tools), why: on.length ? undefined : llmWhy() });
  }
  if (parts[1] === 'models' && req.method === 'GET') {
    const models = await listModels(), def = await defaultModel();
    const d = models.find((m) => m[0] === def);
    return send(res, 200, { models, defaultLabel: d ? d[1] : def, default: def, chosen: (await getPrefs()).defaultModel || null });
  }
  // GET /api/guide: Digress's own documentation, for "Ask about Digress" (the page puts it in a one-off chat's
  // system prompt). A fixed list of files from this repository, read fresh each time so it's as current as they are.
  if (parts[1] === 'guide' && req.method === 'GET') {
    const docs = [];
    for (const [file, name] of GUIDE_DOCS) { try { docs.push({ name, file, text: await fs.readFile(path.join(ROOT, file), 'utf8') }); } catch { /* not in this copy */ } }
    return send(res, 200, { docs });
  }
  // PUT /api/prefs {defaultModel: id | null}: the model "Default" means, on every device (null: back to the built-in one)
  if (parts[1] === 'prefs' && parts.length === 2) {
    if (req.method === 'GET') return send(res, 200, await getPrefs());
    if (req.method === 'PUT') {
      const p = await readJson(req, 4096), m = p && p.defaultModel;
      if (m != null) {
        if (typeof m !== 'string' || m.length > 120) return fail(res, 400, 'Bad model');
        if (!(await listModels()).some((x) => x[0] === m)) return fail(res, 400, 'No connected provider offers that model');
      }
      return send(res, 200, await setPrefs({ defaultModel: m || null }));
    }
    return fail(res, 405, 'Method not allowed');
  }
  if (parts[1] === 'chat' && req.method === 'POST' && parts.length === 2) return handleChat(req, res);
  // a page coming back to a reply: the lines from `from` on, then the rest as it comes (runs.mjs)
  if (parts[1] === 'chat' && parts[2] === 'run' && req.method === 'GET' && parts.length === 4) {
    const run = getRun(parts[3]); if (!run) return fail(res, 404, 'That reply isn’t running here (it finished long ago, or the server restarted).');
    return run.attach(res, Number(url.searchParams.get('from')) || 0);
  }
  if (parts[1] === 'chat' && parts[2] === 'stop' && req.method === 'POST' && parts.length === 3) {   // the Stop button
    const p = await readJson(req), run = p && getRun(p.chat); if (run) run.cancel();
    return send(res, 200, { ok: true });
  }
  if (parts[1] === 'chat' && parts[2] === 'tool' && req.method === 'POST' && parts.length === 3) {   // the page returns a document tool's result
    const r = deliverResult(await readJson(req, MAX_CHAT_JSON));
    return r.status === 200 ? send(res, 200, { ok: true }) : fail(res, r.status, r.error);
  }
  if (parts[1] === 'mcp' && parts.length === 3) return handleMcp(parts[2], req, res, readJson);   // Claude Code calling the document tools
  if (parts[1] === 'fetch-doc' && req.method === 'POST' && parts.length === 2) return handleFetchDoc(req, res);

  if (parts[1] === 'store') {
    const [, , coll, id] = parts;
    if (!COLLECTIONS.has(coll)) return fail(res, 404, 'Unknown collection');
    if (!id) return req.method === 'GET' ? send(res, 200, await listDocs(coll)) : fail(res, 405, 'Method not allowed');
    if (!validId(id) || parts.length > 4) return fail(res, 400, 'Bad id');
    await fs.mkdir(path.join(DATA, coll), { recursive: true });
    const file = docPath(coll, id);
    if (req.method === 'GET' && url.searchParams.has('rev')) { const d = await readDoc(coll, id); return d === null ? fail(res, 404, 'Not found') : send(res, 200, { rev: d.rev || 0 }); }
    if (req.method === 'GET') { const d = await readDoc(coll, id); return d === null ? fail(res, 404, 'Not found') : send(res, 200, d); }
    if (req.method === 'PUT') {
      const d = await readJson(req); if (!d || typeof d !== 'object' || Array.isArray(d)) return fail(res, 400, 'Body must be an object');
      if (coll !== 'convs') { await withLock(file, () => writeAtomic(file, JSON.stringify(d))); return send(res, 200, { ok: true }); }
      // Conversations carry a version (rev). A page says which one its changes started from (x-base-rev);
      // if another device saved since, it gets 409 with the current copy and merges (web/threads.js: merge).
      // A conversation that's gone was deleted elsewhere: 410, so a stale tab can't bring it back.
      // No x-base-rev (an older page, or a new conversation): saved as before.
      const base = req.headers['x-base-rev'];
      return withLock(file, async () => {
        const cur = await readDoc(coll, id);
        if (base !== undefined) {
          if (cur === null && Number(base) > 0) return fail(res, 410, 'This conversation was deleted.');
          if (cur !== null && (cur.rev || 0) !== Number(base)) return send(res, 409, { error: 'Changed elsewhere', current: cur });
        }
        d.rev = (cur ? cur.rev || 0 : 0) + 1;
        await writeAtomic(file, JSON.stringify(d));
        send(res, 200, { ok: true, rev: d.rev });
      });
    }
    if (req.method === 'PATCH') {
      const p = await readJson(req);
      return withLock(file, async () => {
        const d = await readDoc(coll, id);
        if (d === null) return fail(res, 404, 'Not found');
        Object.assign(d, p); if (coll === 'convs') d.rev = (d.rev || 0) + 1;
        await writeAtomic(file, JSON.stringify(d)); send(res, 200, { ok: true });
      });
    }
    if (req.method === 'DELETE') {
      await withLock(file, () => fs.rm(file, { force: true }));
      if (coll === 'convs') { await fs.rm(layoutPath(id), { force: true }); await sweepFiles(10 * 60e3); } // its layouts, and files nothing uses now
      return send(res, 200, { ok: true });
    }
    return fail(res, 405, 'Method not allowed');
  }

  // Layout (open panes, sizes, view, zoom, canvas) is per device: GET /api/layout/:conv -> {devices:{id:{ui,at}}},
  // PUT /api/layout/:conv?device=ID with the ui. One small file per conversation, removed with it; a device
  // that hasn't opened it for LAYOUT_DAYS drops out the next time the file is written.
  if (parts[1] === 'layout' && parts.length === 3) {
    const conv = parts[2]; if (!validId(conv)) return fail(res, 400, 'Bad id');
    const file = layoutPath(conv);
    if (req.method === 'GET') { let d = null; try { d = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* none yet */ } return send(res, 200, d && d.devices ? d : { devices: {} }); }
    if (req.method === 'PUT') {
      const device = url.searchParams.get('device') || '', ui = await readJson(req);
      if (!validId(device) || !ui || typeof ui !== 'object' || Array.isArray(ui)) return fail(res, 400, 'Bad layout');
      if (!existsSync(docPath('convs', conv))) return send(res, 200, { ok: false }); // not saved yet, or deleted: nothing to lay out
      await fs.mkdir(path.dirname(file), { recursive: true });
      return withLock(file, async () => {
        let d = { devices: {} }; try { d = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* new */ }
        const now = Date.now(), devices = {};
        for (const [k, v] of Object.entries(d.devices || {})) if (v && now - (v.at || 0) < LAYOUT_DAYS * 864e5) devices[k] = v;
        devices[device] = { ui, at: now };
        await writeAtomic(file, JSON.stringify({ devices }));
        send(res, 200, { ok: true });
      });
    }
    return fail(res, 405, 'Method not allowed');
  }

  if (parts[1] === 'files') {
    const dir = path.join(DATA, 'files');
    await fs.mkdir(dir, { recursive: true });
    if (req.method === 'POST' && parts.length === 2) {
      const type = url.searchParams.get('type') || '';
      if (!FILE_TYPES.has(type)) return fail(res, 415, 'Only PDF, Markdown, text and image files are accepted');
      const buf = await readBody(req, MAX_UPLOAD);
      if (!buf.length) return fail(res, 400, 'Empty file');
      if (IMAGE_TYPES.has(type) && !isImage(type, buf)) return fail(res, 415, 'That isn’t a ' + type + ' image');
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
      res.writeHead(200, { 'content-type': meta.type, 'content-length': meta.size, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
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
  sweepFiles().then((n) => { if (n) console.log(`Removed ${n} uploaded file${n > 1 ? 's' : ''} no conversation or card uses any more.`); }).catch((e) => console.warn('file cleanup:', e.message));
  console.log(`Digress is running at http://${HOST}:${PORT}`);
  console.log(`Data folder: ${DATA}`);
  const on = enabled();
  console.log(on.length ? `Models: ${on.map((k) => PROVIDERS[k].label).join(' + ')}${on.some(webOk) ? '; web search available (off until you turn it on)' : ''}` : 'No model yet: ' + llmWhy());
  if (!on.includes('chatgpt')) console.log('ChatGPT models: run `npm run chatgpt -- login` to add them (ChatGPT Plus or Pro).');
});
