#!/usr/bin/env node
// ChatGPT models on your ChatGPT plan (Plus or Pro), through OpenAI's "Sign in with ChatGPT" for
// open-source, locally hosted apps: https://developers.openai.com/siwc/token-sharing-open-source
// No API key and no Codex: Digress signs in once as its own app, then calls the public Responses API.
//
//   npm run chatgpt -- login      sign in (opens your browser; --no-browser prints the link instead)
//   npm run chatgpt -- status     connected or not (never prints tokens)
//   npm run chatgpt -- logout     revoke the sign-in and forget the tokens
//
// What the model can do: OpenAI's hosted `web_search`, only when you turned Web on for that message (it
// runs on OpenAI's servers; nothing is fetched from this machine), and, in a conversation with a
// document, the document tools from doctools.mjs (search / read_pages / view_page), which only read the
// document open in your browser. Nothing else: no code here runs any other tool.
// `store: false` means OpenAI doesn't keep the conversation as a stored response.
//
// The sign-in is saved in ~/.config/digress/chatgpt.json (owner-only, 0600), outside the data folder,
// so nothing the server serves can reach it. Change the place with CHATGPT_AUTH_FILE.
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, readFileSync, lstatSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toOpenAI } from './content.mjs';
import { toolsForOpenAI, resultForOpenAI, MAX_TOOL_ROUNDS } from './doctools.mjs';

// The *_BASE overrides exist for the tests' fake OpenAI; leave them unset.
const AUTH = (process.env.CHATGPT_AUTH_BASE || 'https://auth.openai.com').replace(/\/$/, '');
const API = (process.env.CHATGPT_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
const RESOURCE = 'https://api.openai.com/v1'; // what the token is for; always the real API's name
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'; // the permission to spend your plan's usage
const SCOPES = 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE;
const FIRST_CLIENT = 'dynamic_agent_client'; // first sign-in registers Digress and gets its own client id
export const authFile = () => path.resolve(process.env.CHATGPT_AUTH_FILE || path.join(os.homedir(), '.config', 'digress', 'chatgpt.json'));

// ---- the saved sign-in ------------------------------------------------------------------------
class AuthError extends Error {}
function readCreds() {
  const file = authFile();
  let info;
  try { info = lstatSync(file); } catch { return null; }
  // refuse a file others could read or swap: it holds tokens that spend your plan
  if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
    throw new AuthError(`${file} must be a regular file only you can read (chmod 600).`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
async function saveCreds(rec) {
  const file = authFile();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(rec, null, 1), { mode: 0o600 });
  await fs.rename(tmp, file); // atomic: a crash never leaves half a token file
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const form = (o) => new URLSearchParams(o).toString();
async function postForm(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body), redirect: 'error' });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* not JSON */ }
  return { status: r.status, ok: r.ok, j: j || {} };
}

// The ID token says who signed in. Check it the way OpenAI's guide asks: signature against their
// published keys, then issuer, audience (our client id), expiry and the nonce from this sign-in.
async function verifyIdToken(idToken, clientId, nonce) {
  if (typeof idToken !== 'string') throw new AuthError('OpenAI did not return an ID token.');
  const disc = await (await fetch(AUTH + '/.well-known/openid-configuration', { redirect: 'error' })).json();
  if (new URL(disc.jwks_uri).origin !== new URL(AUTH).origin) throw new AuthError('Unexpected signing-key address from OpenAI.');
  const { keys = [] } = await (await fetch(disc.jwks_uri, { redirect: 'error' })).json();
  const [h, p, s] = idToken.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  if (header.alg !== 'RS256') throw new AuthError('Unexpected ID token signature type.');
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError('OpenAI signing key not found.');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(s, 'base64url'))) throw new AuthError('ID token signature is invalid.');
  const c = JSON.parse(Buffer.from(p, 'base64url'));
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== AUTH || !aud.includes(clientId) || !(c.exp * 1000 > Date.now() - 60000) || !c.sub) throw new AuthError('ID token does not match this sign-in.');
  if (nonce !== null && c.nonce !== nonce) throw new AuthError('ID token nonce mismatch.');
  return c;
}

function tokenRecord(data, prev, claims) {
  const scopes = String(data.scope || (prev.scopes || []).join(' ')).split(/\s+/).filter(Boolean);
  if (!scopes.includes(PLAN_SCOPE)) throw new AuthError('ChatGPT plan usage was not granted, so Digress cannot use it. Sign in again and allow it.');
  if (!data.access_token || !data.refresh_token || String(data.token_type || 'bearer').toLowerCase() !== 'bearer') throw new AuthError('OpenAI returned an unusable sign-in.');
  const rec = { ...prev, access_token: data.access_token, refresh_token: data.refresh_token, scopes, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 };
  if (data.id_token) rec.id_token = data.id_token;
  if (claims) Object.assign(rec, { subject: claims.sub, email: claims.email || rec.email });
  return rec;
}

// ---- tokens for requests: refreshed shortly before they expire (they last an hour) ----------------
const DEAD_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
let refreshing = null; // one refresh at a time: refresh tokens rotate, and reusing an old one kills the sign-in
async function refresh(rec) {
  const r = await postForm(AUTH + '/api/accounts/oauth/token', { grant_type: 'refresh_token', client_id: rec.client_id, refresh_token: rec.refresh_token, resource: RESOURCE });
  if (!r.ok) {
    const code = r.j.error && (r.j.error.code || r.j.error) || '';
    if (DEAD_REFRESH.has(code)) {
      await saveCreds({ client_id: rec.client_id, host_id: rec.host_id, subject: rec.subject, email: rec.email, id_token: rec.id_token });
      throw new AuthError('The ChatGPT sign-in expired. Run `npm run chatgpt -- login` again.');
    }
    throw new AuthError(`Could not renew the ChatGPT sign-in (HTTP ${r.status}).`);
  }
  const claims = r.j.id_token ? await verifyIdToken(r.j.id_token, rec.client_id, null) : null;
  if (claims && rec.subject && claims.sub !== rec.subject) throw new AuthError('The renewed sign-in belongs to a different account.');
  const next = tokenRecord(r.j, rec, claims);
  await saveCreds(next);
  return next.access_token;
}
export async function accessToken(force = false) {
  const rec = readCreds();
  if (!rec || !rec.refresh_token) throw new AuthError('ChatGPT is not connected. Run `npm run chatgpt -- login` on the server.');
  if (!(rec.scopes || []).includes(PLAN_SCOPE)) throw new AuthError('This ChatGPT sign-in does not allow plan usage. Run `npm run chatgpt -- login` again.');
  if (!force && rec.expires_at > Date.now() + 120000) return rec.access_token;
  refreshing = refreshing || refresh(rec).finally(() => { refreshing = null; });
  return refreshing;
}
export function available() {
  try { const r = readCreds(); return !!(r && r.refresh_token && (r.scopes || []).includes(PLAN_SCOPE)); } catch { return false; }
}
export const WHY = 'ChatGPT is not connected. Run `npm run chatgpt -- login` once (needs ChatGPT Plus or Pro).';

// ---- models available to your account -----------------------------------------------------
let modelCache = null;
const windows = new Map();   // model slug -> context window (the model list's context_window)
export async function listModels() {
  if (modelCache && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.list;
  let list = [];
  try {
    const r = await fetch(API + '/models', { headers: { authorization: 'Bearer ' + (await accessToken()) } });
    if (r.ok) {
      const ms = ((await r.json()).models || []).filter((m) => m && m.visibility === 'list' && m.slug);
      list = ms.map((m) => [String(m.slug), String(m.display_name || m.slug)]);
      for (const m of ms) if (Number.isFinite(m.context_window)) windows.set(String(m.slug), m.context_window);
    }
    else console.warn('ChatGPT model list failed: HTTP', r.status);
  } catch (e) { console.warn('ChatGPT model list failed:', e.message); }
  if (list.length) modelCache = { at: Date.now(), list };
  return list;
}

// ---- one reply ----------------------------------------------------------------------------
// Built so OpenAI's prompt cache can reuse as much as possible between follow-ups (it matches the
// longest unchanged prefix, ending at a message boundary):
//  - the system prompt (with any document) goes first, as a developer message, and never changes
//    within a conversation; the history follows as separate messages, oldest first, never rewritten.
//  - prompt_cache_key keeps requests about the same document together on OpenAI's side.
//  - the tools stay the same from message to message: web_search is always listed where web access is
//    allowed, and Web on or off only changes which tools may run (tool_choice allowed_tools), which OpenAI
//    keeps out of the cached prefix: https://developers.openai.com/api/docs/guides/keep-prefix-unchanged
//  - changing the reasoning effort costs one uncached reply, then caching resumes.
// The plan route rejects `system` messages, max_output_tokens, temperature and previous_response_id,
// and requires store:false + stream:true.
// `more`: what this reply has added so far in a tool loop (the model's own output items, then the tool results).
export function requestBody({ system, messages, model, effort, web, webListed, session }, withEffort, more = []) {
  const input = [];
  if (system) input.push({ role: 'developer', content: system });
  input.push(...toOpenAI(messages), ...more); // messages arrive checked by server/content.mjs; images become input_image parts
  const body = { model, input, store: false, stream: true, prompt_cache_key: 'digress-' + crypto.createHash('sha256').update(system || '').digest('hex').slice(0, 32) };
  if (withEffort && effort) body.reasoning = { effort };
  const listed = webListed || web;
  const tools = [...(listed ? [{ type: 'web_search' }] : []), ...(session ? toolsForOpenAI() : [])];
  // with store:false nothing is kept on OpenAI's side, so the model's reasoning comes back encrypted and is
  // sent again with the tool results, letting it carry on from where it stopped
  const include = [...(listed ? ['web_search_call.action.sources'] : []), ...(session ? ['reasoning.encrypted_content'] : [])];
  if (tools.length) {
    body.tools = tools;
    // which of them may run: web_search only when the reader turned Web on
    const may = tools.filter((t) => web || t.type !== 'web_search').map((t) => (t.type === 'function' ? { type: 'function', name: t.name } : { type: t.type }));
    body.tool_choice = may.length ? { type: 'allowed_tools', mode: 'auto', tools: may } : 'none';
  }
  if (include.length) body.include = include;
  return body;
}

const PLAN_ERRORS = {
  subscription_sharing_usage_limit_exceeded: 'You have hit your ChatGPT plan’s usage limit for now (or the weekly cap you set for Digress). See chatgpt.com/settings/usage.',
  subscription_sharing_usage_unavailable: 'ChatGPT plan usage is unavailable right now. Try again in a little while.',
  subscription_sharing_user_unavailable: 'ChatGPT plan usage is unavailable right now. Try again in a little while.',
  subscription_sharing_user_not_eligible: 'This ChatGPT account can’t use its plan in other apps (it needs Plus or Pro, and your workspace has to allow it).',
  subscription_sharing_invalid_user: 'OpenAI rejected the ChatGPT sign-in. Run `npm run chatgpt -- login` again.',
};
function errorMessage(err, status, web) {
  const e = (err && err.error) || err || {};
  const code = e.code || '';
  if (PLAN_ERRORS[code]) return PLAN_ERRORS[code];
  if (code === 'subscription_sharing_unsupported_capability') {
    if (web && /tool|web/i.test(String(e.param || '') + ' ' + String(e.message || ''))) return 'Web search isn’t available for this model or account. Turn Web off, or pick another model.';
    return `ChatGPT plan usage doesn’t support part of this request${e.param ? ` (${e.param})` : ''}.`;
  }
  if (e.message) return String(e.message);
  if (err && err.detail) return String(err.detail);
  if (status === 401) return 'OpenAI rejected the ChatGPT sign-in. Run `npm run chatgpt -- login` again.';
  return `The ChatGPT request failed (${status}).`;
}

// h = {startStream, sourcesLine, fail} from the server, so this speaks the same NDJSON lines as the
// Claude providers: {d}, {search}, {sources}, then {done, model, truncated} or {error}.
export async function chat(payload, res, h) {
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); }); // Stop pressed or page closed
  let more = []; // the tool loop's additions, resent with each round (store:false keeps nothing between requests)
  const send = async (withEffort, force) => fetch(API + '/responses', {
    method: 'POST', signal: ctrl.signal, redirect: 'error',
    headers: { authorization: 'Bearer ' + (await accessToken(force)), 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(requestBody(payload, withEffort, more)),
  });
  let up, withEffort = !!payload.effort;
  try {
    up = await send(withEffort, false);
    if (up.status === 401) up = await send(withEffort, true); // token revoked early: renew once and retry
    if (up.status === 400 && withEffort) {
      // some models don't take a reasoning effort: ask again without it
      const txt = await up.text();
      if (/reasoning|effort/i.test(txt)) { withEffort = false; up = await send(false, false); }
      else { let j = null; try { j = JSON.parse(txt); } catch { /* */ } return h.fail(res, 400, errorMessage(j, 400, payload.web)); }
    }
  } catch (e) {
    if (ctrl.signal.aborted) return;
    return h.fail(res, 502, e instanceof AuthError ? e.message : 'Could not reach OpenAI: ' + e.message);
  }
  if (!up.ok) {
    const txt = await up.text(); let j = null; try { j = JSON.parse(txt); } catch { /* */ }
    return h.fail(res, up.status === 401 ? 502 : up.status, errorMessage(j, up.status, payload.web));
  }

  const out = h.startStream(res), st = { model: null, any: false, sep: false, end: null, items: [] };
  // token counts: ctx is the last request's input (it includes what came from the cache), out is written across
  // all requests, rounds how many (each document tool round resends everything, so their inputs aren't added up)
  const useRound = (u) => {
    if (!u) return;
    const g = st.usage || (st.usage = { ctx: 0, cached: 0, out: 0, rounds: 0 });
    g.rounds++; g.ctx = u.input_tokens || 0; g.cached = (u.input_tokens_details || {}).cached_tokens || 0; g.out += u.output_tokens || 0;
  };
  if (payload.session) payload.session.out = out;
  const sources = (list) => { const s = h.sourcesLine(list); if (s) out(s); };
  const onEvent = (ev) => {
    const r = ev.response;
    if (r && r.model) st.model = r.model;
    if (ev.type === 'response.output_item.added') {
      if (ev.item && ev.item.type === 'message' && st.any) st.sep = true; // text again after a search
    } else if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      let t = ev.delta;
      if (st.sep) { t = t.replace(/^\s+/, ''); if (!t) return; t = '\n\n' + t; st.sep = false; }
      st.any = true; out({ d: t });
    } else if (ev.type === 'response.output_item.done' && ev.item) {
      const it = ev.item;
      st.items.push(it);
      if (it.type === 'web_search_call') {
        const a = it.action || {};
        const q = a.query || (Array.isArray(a.queries) ? a.queries.join(' · ') : '');
        if (q) out({ search: String(q).slice(0, 500) });
        sources(a.sources);
      } else if (it.type === 'message') {
        sources((it.content || []).flatMap((c) => (c.annotations || []).filter((x) => x.type === 'url_citation')));
      }
    } else if (ev.type === 'response.completed') {
      st.end = { done: true, truncated: false }; useRound(r && r.usage);
    } else if (ev.type === 'response.incomplete') { st.end = { done: true, truncated: true }; useRound(r && r.usage); }
    else if (ev.type === 'response.failed') st.end = { error: errorMessage(r && r.error, 200, payload.web) };
    else if (ev.type === 'error') st.end = { error: errorMessage(ev.error || ev, 200, payload.web) };
  };
  // The agentic loop: one request per round. The reply streams to the page; if the model called document
  // tools, run them (in the page, via session.call), add its output and the results to `more`, and ask
  // again. It ends when the model answers without calling a tool.
  for (let round = 0; ; round++) {
    try {
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of up.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          onEvent(ev);
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return res.end();
    }
    const calls = st.items.filter((it) => it.type === 'function_call');
    if (!payload.session || !calls.length || !st.end || st.end.error || round + 1 >= MAX_TOOL_ROUNDS) break;
    // send back what the model produced this round (its reasoning, any text, the calls), then each result
    more = [...more, ...st.items.filter((it) => ['reasoning', 'message', 'function_call'].includes(it.type))];
    for (const c of calls) {
      let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch { /* the tool reports missing arguments */ }
      more.push(resultForOpenAI(await payload.session.call(c.name, args), c.call_id));
    }
    st.items = []; st.end = null;
    try {
      up = await send(withEffort, false);
      if (up.status === 401) up = await send(withEffort, true);
    } catch (e) {
      if (ctrl.signal.aborted) return res.end();
      st.end = { error: 'Could not reach OpenAI: ' + e.message }; break;
    }
    if (!up.ok) { const txt = await up.text(); let j = null; try { j = JSON.parse(txt); } catch { /* */ } st.end = { error: errorMessage(j, up.status, payload.web) }; break; }
  }
  if (st.end && st.end.error) out({ error: st.end.error });
  else if (st.end) {
    if (!windows.size) await listModels().catch(() => {});
    const w = windows.get(st.model) || windows.get(payload.model), u = st.usage;
    out({ done: true, model: st.model || payload.model, truncated: st.end.truncated, ...(u ? { usage: { ctx: u.ctx, cached: u.cached, out: u.out, rounds: u.rounds, ...(w ? { window: w } : {}) } } : {}) });
  }
  else out({ error: 'The connection to ChatGPT dropped before the reply finished.' });
  res.end();
}

// ---- sign in / status / sign out (command line) ---------------------------------------------
async function login({ noBrowser }) {
  const prev = readCreds() || {};
  // a stable, random id for this machine, chosen before the first sign-in and kept from then on
  const host_id = prev.host_id || 'urn:uuid:' + crypto.randomUUID();
  if (!prev.host_id) await saveCreds({ ...prev, host_id });
  const clientId = prev.client_id || FIRST_CLIENT;
  const [state, nonce, verifier] = [0, 0, 0].map(() => b64url(crypto.randomBytes(32)));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const LOGIN_PORT = Number(process.env.CHATGPT_LOGIN_PORT || 1457); // 1455 is Codex's; avoid clashing
  const redirect = `http://127.0.0.1:${LOGIN_PORT}/auth/callback`;

  const got = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/auth/callback' || u.searchParams.get('state') !== state) { res.writeHead(400); return res.end('Not the sign-in this terminal is waiting for.'); }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
      res.end('Digress got your sign-in. You can close this tab and look at the terminal.');
      srv.close(); clearTimeout(timer); resolve(Object.fromEntries(u.searchParams));
    });
    const timer = setTimeout(() => { srv.close(); reject(new AuthError('Sign-in timed out after 15 minutes.')); }, 15 * 60 * 1000);
    srv.on('error', (e) => reject(new AuthError(`Could not listen on 127.0.0.1:${LOGIN_PORT} (${e.code}). Set CHATGPT_LOGIN_PORT to a free port.`)));
    srv.listen(LOGIN_PORT, '127.0.0.1', () => {
      const q = { client_id: clientId, ext_agent_host_id: host_id, response_type: 'code', redirect_uri: redirect, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge };
      if (clientId === FIRST_CLIENT) q.agent_name_hint = 'Digress';
      else if (prev.id_token) q.id_token_hint = prev.id_token;
      const url = AUTH + '/api/accounts/authorize?' + form(q);
      console.log('Sign in with ChatGPT to let Digress use your plan (no API key, no billing fallback):\n\n' + url + '\n');
      console.log(`On a remote machine, forward the port first: ssh -N -L ${LOGIN_PORT}:127.0.0.1:${LOGIN_PORT} <server>`);
      if (!noBrowser) { try { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* print only */ } }
    });
  });
  if (got.error) throw new AuthError(got.error === 'access_denied' ? 'Sign-in was cancelled.' : 'Sign-in failed: ' + got.error);
  if (!got.code) throw new AuthError('OpenAI did not return a sign-in code.');
  const issued = got.client_id || (clientId !== FIRST_CLIENT ? clientId : null);
  if (!issued || issued === FIRST_CLIENT || (prev.client_id && got.client_id && got.client_id !== prev.client_id)) throw new AuthError('OpenAI returned an unexpected app registration.');
  await saveCreds({ ...readCreds(), host_id, client_id: issued }); // keep the registration even if the next step fails
  const r = await postForm(AUTH + '/api/accounts/oauth/token', { grant_type: 'authorization_code', client_id: issued, code: got.code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE });
  if (!r.ok) throw new AuthError(`Could not finish signing in (HTTP ${r.status}). Run the login again.`);
  const claims = await verifyIdToken(r.j.id_token, issued, nonce);
  if (prev.subject && claims.sub !== prev.subject) throw new AuthError('You signed in with a different account than before. Run logout first to switch accounts.');
  await saveCreds(tokenRecord(r.j, { ...readCreds(), host_id, client_id: issued }, claims));
  console.log(`Connected${claims.email ? ' as ' + claims.email : ''}. Restart is not needed; ChatGPT models now show in Digress's model picker.`);
  console.log('Limit how much of your plan Digress may use at chatgpt.com/settings/usage.');
}
async function logout() {
  const rec = readCreds();
  if (!rec || !rec.refresh_token) { console.log('Not connected.'); return; }
  let revoked = false;
  try {
    const disc = await (await fetch(AUTH + '/.well-known/openid-configuration')).json();
    revoked = disc.revocation_endpoint && (await postForm(disc.revocation_endpoint, { token: rec.refresh_token, token_type_hint: 'refresh_token', client_id: rec.client_id })).ok;
  } catch { /* offline */ }
  // keep the app registration and machine id (signing in again reuses them), drop the tokens
  await saveCreds({ client_id: rec.client_id, host_id: rec.host_id });
  console.log(revoked ? 'Signed out and revoked.' : 'Forgot the tokens here, but could not confirm OpenAI revoked them: disconnect Digress in ChatGPT settings to be sure.');
}
function status() {
  const rec = readCreds();
  const ok = !!(rec && rec.refresh_token && (rec.scopes || []).includes(PLAN_SCOPE));
  console.log(JSON.stringify({ connected: ok, account: ok ? rec.email || null : null, file: authFile(), tools: 'none, or web_search when you turn Web on' }, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const run = cmd === 'login' ? () => login({ noBrowser: process.argv.includes('--no-browser') }) : cmd === 'logout' ? logout : cmd === 'status' ? status : null;
  if (!run) { console.log('usage: npm run chatgpt -- login [--no-browser] | status | logout'); process.exit(2); }
  // the server's .env can set CHATGPT_AUTH_FILE; read it the same simple way the server does
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) for (const line of readFileSync(env, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(CHATGPT_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  Promise.resolve().then(run).catch((e) => { console.error(e instanceof AuthError ? e.message : e); process.exit(1); });
}
