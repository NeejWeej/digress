#!/usr/bin/env node
// Digress server: serves the app, keeps your data on disk, and relays model calls to Claude
// (through the Claude Code CLI on your subscription, or the Anthropic API with a key).
// No dependencies; needs Node 18 or newer. Configuration comes from the environment or a .env file.
//
//   GET  /api/health                   {app:'digress', llm:bool, provider, web:bool, why}
//   GET  /api/models                   {models:[[id,label]], defaultLabel}
//   POST /api/chat                     {system, messages, model, effort, web} -> streamed lines: {d}, {search}, {sources},
//                                      then {done,model,truncated} or {error}  (see PROVIDERS)
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
import * as chatgpt from './chatgpt.mjs';
import { fetchDocument, WARNINGS } from './fetchdoc.mjs';
import { normalizeMessages, toAnthropic, toClaudeCodeBlocks, IMAGE_TYPES, isImage } from './content.mjs';

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
const COLLECTIONS = new Set(['convs', 'index']);
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
//     payload = {system, messages:[{role, content}], model, effort, web}
//     web is only true when the reader turned web access on for this message. Off means the provider
//     must not reach the internet at all. Keep it to search: no page fetching from this machine, no code.
const PROVIDERS = {
  'claude-code': {
    label: 'Claude Code CLI (your Claude subscription)', web: true, available: hasClaudeCli, models: async () => CC_MODELS, chat: chatViaClaudeCode,
    why: `The server could not find the Claude Code CLI ("${CLAUDE_BIN}"). Install it, run \`claude\` once to sign in, then restart the server.`,
  },
  anthropic: {
    label: 'Anthropic API', web: true, available: () => !!API_KEY, models: anthropicModels, chat: chatViaApi,
    why: 'The server has no Anthropic API key. Add ANTHROPIC_API_KEY to .env and restart it.',
  },
  chatgpt: {
    label: 'ChatGPT (your ChatGPT plan)', web: true, available: chatgpt.available, why: chatgpt.WHY, models: chatgpt.listModels,
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
// "Default" means DEFAULT_MODEL if set, else the default provider's first choice
async function defaultModel() {
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
async function anthropicModels() {
  if (anthropicCache && Date.now() - anthropicCache.at < 10 * 60 * 1000) return anthropicCache.list;
  let list = [];
  if (API_KEY) {
    try {
      const r = await fetch(API_BASE + '/v1/models?limit=100', { headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' } });
      if (r.ok) list = ((await r.json()).data || []).map((m) => [m.id, m.display_name || m.id]);
    } catch (e) { console.warn('model list failed:', e.message); }
  }
  if (!list.length) list = [[DEFAULT_MODEL, DEFAULT_MODEL]];
  anthropicCache = { at: Date.now(), list };
  return list;
}
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
  return PROVIDERS[k].chat(payload, res);
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
function relayEvent(ev, out, st) {
  if (ev.type === 'message_start') { st.model = ev.message && ev.message.model; st.blocks = []; }
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
  const tools = payload.web ? ['--tools', 'WebSearch', '--allowedTools', 'WebSearch'] : ['--tools', ''];
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // and none of your own Claude Code setup: no MCP servers, hooks, CLAUDE.md, skills or custom agents
    ...tools, '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence',
    '--system-prompt-file', sysFile, '--model', pickModel(payload.model)];
  if (EFFORTS.has(payload.effort)) args.push('--effort', payload.effort);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // make the CLI use your subscription sign-in, not an API key
  // run in an empty folder so no project files or CLAUDE.md get pulled in
  const child = spawn(CLAUDE_BIN, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const cleanup = () => fs.rm(work, { recursive: true, force: true }).catch(() => {});
  res.on('close', () => { if (!res.writableFinished && child.exitCode === null) child.kill('SIGTERM'); });
  // the conversation goes in as one stream-json user message: a transcript with any images in place (server/content.mjs)
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: toClaudeCodeBlocks(payload.messages) } }) + '\n');

  const out = startStream(res), st = { model: null, truncated: false, any: false, failed: false };
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
          const at = txt.indexOf('Links: [');
          if (at < 0) continue;
          const end = txt.indexOf('\n', at), raw = txt.slice(at + 7, end < 0 ? undefined : end);
          try { const s = sourcesLine(JSON.parse(raw)); if (s) out(s); } catch { /* not the shape we know: skip the sources */ }
        }
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
function anthropicRequest({ system, messages, model, effort, web }, withEffort, signal) {
  const body = { model: pickModel(model), max_tokens: MAX_TOKENS, stream: true, messages };
  // cache the system prompt (which carries any document text), so follow-ups about the same paper are cheaper
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (withEffort && EFFORTS.has(effort)) body.output_config = { effort };
  // web search runs on Anthropic's servers; nothing is fetched from this machine
  if (web) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES }];
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
  const dec = new TextDecoder();
  let messages = payload.messages;
  try {
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
      // a long search turn can pause; send back what came so far and the model carries on
      if (st.stop !== 'pause_turn' || st.failed || turn >= 4) break;
      messages = [...messages, { role: 'assistant', content: (st.blocks || []).filter(Boolean) }];
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
    const d = await fetchDocument(p.url, { confirmed: Array.isArray(p.confirm) ? p.confirm.map(String) : [], maxBytes: MAX_UPLOAD, signal: ctrl.signal, testAllow: process.env.DOC_FETCH_TEST_ALLOW || '' });
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
  if (DEV && url.pathname === '/__dev/events') return devEvents(req, res);
  if (parts[0] !== 'api') return fail(res, 404, 'Not found');

  if (parts[1] === 'health' && req.method === 'GET') {
    const on = enabled();
    return send(res, 200, { app: 'digress', llm: on.length > 0, provider: on[0] || PRIMARY, providers: on, web: on.some(webOk), why: on.length ? undefined : llmWhy() });
  }
  if (parts[1] === 'models' && req.method === 'GET') {
    const models = await listModels(), def = await defaultModel();
    const d = models.find((m) => m[0] === def);
    return send(res, 200, { models, defaultLabel: d ? d[1] : def });
  }
  if (parts[1] === 'chat' && req.method === 'POST') return handleChat(req, res);
  if (parts[1] === 'fetch-doc' && req.method === 'POST' && parts.length === 2) return handleFetchDoc(req, res);

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
  console.log(`Digress is running at http://${HOST}:${PORT}`);
  console.log(`Data folder: ${DATA}`);
  const on = enabled();
  console.log(on.length ? `Models: ${on.map((k) => PROVIDERS[k].label).join(' + ')}${on.some(webOk) ? '; web search available (off until you turn it on)' : ''}` : 'No model yet: ' + llmWhy());
  if (!on.includes('chatgpt')) console.log('ChatGPT models: run `npm run chatgpt -- login` to add them (ChatGPT Plus or Pro).');
});
