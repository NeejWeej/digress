// Google Gemini (the Gemini API, with your own API key). Same shape as the other providers: it streams the reply as
// the NDJSON lines the page reads ({d}, {search}, {sources}, {tool} via the session, then {done} or {error}), runs
// the document tools' loop, and sends Google Search only when the reader turned Web on.
//
// The key is sent in the x-goog-api-key header (never in the URL). Free-tier keys: Google may use what's sent to
// improve its products, and Google Search isn't available on the free tier (Google's terms and pricing pages);
// the page says so where the models are picked.
//
// The demo runs this same file in the browser, with the visitor's key (demo/build.mjs copies it, with doctools.mjs
// and content.mjs): no Node APIs here. Its settings come from the environment where there is one, and the demo
// passes its own fetch (configure); the reply is written through an `io` the caller gives (chat, below).
import { MAX_TOOL_ROUNDS } from './doctools.mjs';
import { sourcesLine } from './content.mjs';

const env = (globalThis.process && globalThis.process.env) || {};
export const API = (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const MAX_OUTPUT = Number(env.MAX_TOKENS || 16000);
let doFetch = (...a) => globalThis.fetch(...a);
// the demo's page answers its own /api/* with a patched window.fetch: it hands this the real one
export function configure({ fetch } = {}) { if (fetch) doFetch = fetch; }
// When Google is overloaded it sometimes says so at once (503 "high demand") and sometimes doesn't answer at all. A
// quick refusal is tried again (twice, a moment apart, as Google suggests); no answer at all ends after WAIT_MS with
// a plain message, rather than "thinking" for minutes. Both only before the reply starts.
const WAIT_MS = Number(env.GEMINI_WAIT_MS || 90000);
const RETRY_MS = Number(env.GEMINI_RETRY_MS || 2000);

// Markdown links to Google Search's result redirects in a reply's text: [title](https://vertexaisearch.cloud.google.com/grounding-api-redirect/…)
const REDIRECT = /\[([^\]\n]{1,300})\]\((https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=%.~]+)\)/g;
export function groundedLinks(text) {
  const out = [], seen = new Set();
  for (const m of String(text || '').matchAll(REDIRECT)) {
    if (seen.has(m[2])) continue; seen.add(m[2]);
    out.push({ title: m[1].replace(/[*_`]/g, '').trim() || 'Source', url: m[2] });
  }
  return out;
}

// ---- models ----------------------------------------------------------------------------------
const windows = new Map();   // model id -> context window (the model list's inputTokenLimit)
let cache = null;
export const resetModels = () => { cache = null; };
// chat models only: what can generateContent, without the special-purpose ones (embeddings, images, speech, live)
// (Nano Banana makes images; the Omni models aren't on the free tier and run differently: neither answers a chat here)
const SPECIAL = /embedding|image|imagen|nano-banana|omni|tts|audio|live|transcribe|aqa|veo|lyria|genie|robotics|computer-use/i;
export async function listModels(key) {
  if (!key) return [];
  if (cache && cache.key === key && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  let list = [];
  try {
    const r = await doFetch(API + '/models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
    if (r.ok) {
      const ms = ((await r.json()).models || []).filter((m) => /^models\/gemini/.test(m.name || '') && (m.supportedGenerationMethods || []).includes('generateContent') && !SPECIAL.test(m.name));
      list = ms.map((m) => [m.name.slice(7), m.displayName || m.name.slice(7)]);
      for (const m of ms) if (Number.isFinite(m.inputTokenLimit)) windows.set(m.name.slice(7), m.inputTokenLimit);
    }
  } catch (e) { console.warn('Gemini model list failed:', e.message); }
  cache = { key, at: Date.now(), list };
  return list;
}
// the model a reply uses when none is chosen: the one chosen in the app if this key still offers it, else Google's
// first (the server's builtinDefault and the demo alike)
export function defaultModel(list, chosen) {
  if (chosen && chosen !== 'auto' && list.some(([id]) => id === chosen)) return chosen;
  return list.length ? list[0][0] : null;
}
// is this key accepted? -> {ok} | {error}
export async function checkKey(key) {
  try {
    const r = await doFetch(API + '/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
    if (r.ok) return { ok: true };
    return { error: errorMessage(await r.text(), r.status) };
  } catch (e) { return { error: 'Could not reach Google: ' + e.message }; }
}

// ---- requests ----------------------------------------------------------------------------------
// the page's messages ({role, parts:[text | image]}) as Gemini contents
export const toGemini = (msgs) => msgs.map((m) => ({
  role: m.role === 'assistant' ? 'model' : 'user',
  parts: m.parts.filter((p) => p.type !== 'text' || p.text !== '').map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data } })),
})).filter((c) => c.parts.length);
const toolDecls = (s) => [{ functionDeclarations: s.tools.map((t) => ({ name: t.name, description: t.description, parameters: plainSchema(t.schema) })) }];
// Gemini's schemas are OpenAPI-like: no additionalProperties
function plainSchema(s) {
  if (Array.isArray(s)) return s.map(plainSchema);   // required: [...], enum: [...] stay lists
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== 'additionalProperties') out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, plainSchema(x)])) : plainSchema(v);
  return out;
}
const THINKING = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
export function requestBody({ system, contents, effort, web, session, final }, withEffort, withSearch) {
  const body = { contents, generationConfig: { maxOutputTokens: MAX_OUTPUT } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (withEffort && THINKING[effort]) body.generationConfig.thinkingConfig = { thinkingLevel: THINKING[effort] };
  const tools = [...(session ? toolDecls(session) : []), ...(web && withSearch ? [{ googleSearch: {} }] : [])];
  if (tools.length) body.tools = tools;
  if (session) body.toolConfig = { functionCallingConfig: { mode: final ? 'NONE' : 'AUTO' } };   // the tool loop ran out of rounds: answer from what was read
  // Google Search with the document tools: Gemini 4 refuses the pair unless its own search steps come back as parts
  // (toolCall / toolResponse, with their signatures), which the tool loop then sends back as they came
  if (session && web && withSearch) body.toolConfig.includeServerSideToolInvocations = true;
  return body;
}
// a document tool's result as a function response; its pictures go in the same turn, after it
function resultParts(r, name, id) {
  const text = r.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') || '(empty)';
  const images = r.parts.filter((p) => p.type === 'image').map((p) => ({ inlineData: { mimeType: p.mediaType, data: p.data } }));
  return [{ functionResponse: { ...(id ? { id } : {}), name, response: r.error ? { error: text } : { result: text } } }, ...images];   // the call's id, when it had one
}

// ---- errors -------------------------------------------------------------------------------------
// Google refusing its search tool (on the free tier, or together with function calling). Not just "search": that's
// also the name of a document tool, which shows up in other errors (a schema it didn't take, say).
const SEARCH_REFUSED = /google_?search|grounding|function calling is unsupported|server_?side_?tool_?invocations/i;   // (the last: a model that doesn't know that setting)
// web: whether the request asked for Google Search (a free key asking for it gets a plain 429 "quota exceeded")
export function errorMessage(txt, status, web) {
  let msg = ''; try { const j = JSON.parse(txt); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; msg = (e && e.message) || ''; } catch { /* not JSON */ }
  if (status === 503) return 'Gemini is busy right now (Google says this model is in high demand). Try again in a little while, or pick another model.';
  if (status === 429 && web) return 'Google refused this for quota. With Web on, that’s usually because web search isn’t included on Gemini’s free tier: turn Web off and try again (or use a paid key). If it happens with Web off too, you’ve reached the free tier’s request limit; wait a minute.';
  if (status === 429) return 'Gemini’s rate limit was reached (free-tier keys allow only a few requests a minute, and a daily cap). Wait a little and try again.';
  if (/API key not valid|API_KEY_INVALID/i.test(msg) || status === 401) return 'Google rejected the Gemini API key. Check it in Connections.';
  if (status === 403) return 'Google refused this request with this key' + (msg ? ': ' + msg : '.') + ' (A Google Cloud API key has to be restricted to the Gemini API; keys made in AI Studio work as they are.)';
  if (SEARCH_REFUSED.test(msg) && status === 400) return 'This Gemini key or model can’t search the web (Google Search isn’t available on the free tier). Turn Web off, or use a paid key.';
  return msg ? 'Gemini: ' + msg : 'The Gemini request failed (' + status + ').';
}

const NO_ANSWER = `Gemini hasn’t answered in ${Math.round(WAIT_MS / 1000)} seconds (Google may be overloaded). Try again in a little while, or pick another model.`;

// ---- the reply ----------------------------------------------------------------------------------
// payload = {system, messages, model, effort, web, session}; key: the API key.
// io: where the reply goes, so the server (an HTTP response) and the demo (a stream in the page) share all of this:
//   onClose(fn): fn runs if the reader goes away (Stop, the page closed) · fail(status, message): refuse before the
//   reply starts · start() -> out(line): the reply has started · end()
export async function chat(payload, io, key) {
  const ctrl = new AbortController();
  io.onClose(() => ctrl.abort());   // Stop pressed or page closed
  let contents = toGemini(payload.messages), final = false, withEffort = true, withSearch = true;
  const once = async () => {
    if (ctrl.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });   // stopped: no new request
    const t = setTimeout(() => ctrl.abort(new Error('no answer')), WAIT_MS);
    try {
      return await doFetch(`${API}/models/${encodeURIComponent(payload.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal: ctrl.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(requestBody({ ...payload, contents, final }, withEffort, withSearch)),
      });
    } finally { clearTimeout(t); }
  };
  let stopped = false;
  io.onClose(() => { stopped = true; });
  // a quick 503 is tried again, at most twice
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
    // refused for something it can do without: a model without thinking levels (ask again without one), or Google
    // Search together with the document tools (answer with the tools, without searching); each at most once, either order
    while (up.status === 400) {
      const txt = await up.text();
      if (withEffort && /thinking/i.test(txt)) withEffort = false;
      else if (withSearch && payload.web && payload.session && SEARCH_REFUSED.test(txt)) withSearch = false;
      else return io.fail(400, errorMessage(txt, 400));
      up = await send();
    }
  } catch (e) {
    if (stopped) return;
    if (ctrl.signal.aborted) return io.fail(504, NO_ANSWER);
    return io.fail(502, 'Could not reach Google: ' + e.message);
  }
  if (!up.ok) return io.fail(up.status === 401 ? 502 : up.status, errorMessage(await up.text(), up.status, payload.web && withSearch));

  const out = io.start();
  if (payload.session) payload.session.out = out;
  const st = { model: null, any: false, usage: null, end: null, text: '', gotSources: false, grounding: null };
  const sources = (list) => { const s = sourcesLine(list); if (s) { st.gotSources = true; out(s); } };
  for (let round = 0; ; round++) {
    const modelParts = [], calls = [];
    let finish = null, searched = new Set();
    try {
      const dec = new TextDecoder(), rd = up.body.getReader(); let buf = '';   // (a reader: a browser's stream may not be async-iterable)
      for (;;) {
        const { value: chunk, done } = await rd.read();
        if (done) break;
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.error) { st.end = { error: errorMessage(JSON.stringify(ev), ev.error.code || 500) }; continue; }
          if (ev.modelVersion) st.model = ev.modelVersion;
          const u = ev.usageMetadata;
          if (u) st.lastUsage = u;
          const c = (ev.candidates || [])[0];
          if (!c) continue;
          for (const p of (c.content && c.content.parts) || []) {
            modelParts.push(p);   // kept as sent (with any thoughtSignature), to send back in a tool loop
            if (p.thought) continue;
            if (typeof p.text === 'string' && p.text) { st.any = true; st.text += p.text; out({ d: p.text }); }
            if (p.functionCall) calls.push(p.functionCall);
          }
          const g = c.groundingMetadata;
          if (g) {
            st.grounding = Object.keys(g);
            for (const q of g.webSearchQueries || []) if (!searched.has(q)) { searched.add(q); out({ search: String(q).slice(0, 500) }); }
            sources((g.groundingChunks || []).map((x) => x.web).filter(Boolean).map((w) => ({ title: w.title, url: w.uri })));
          }
          if (c.finishReason) finish = c.finishReason;
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return io.end();
      st.end = { error: 'The connection to Gemini was interrupted.' };
    }
    // token counts: ctx is the last request's input (each tool round resends everything), out across all of them
    if (st.lastUsage) {
      const u = st.lastUsage, g = st.usage || (st.usage = { ctx: 0, cached: 0, out: 0, rounds: 0 });
      g.rounds++; g.ctx = u.promptTokenCount || 0; g.cached = u.cachedContentTokenCount || 0; g.out += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
      st.lastUsage = null;
    }
    if (st.end && st.end.error) break;
    // the document tools' loop: run each call in the page, send back the model's turn and the results, ask again
    if (calls.length && payload.session && !final) {
      if (round + 1 >= MAX_TOOL_ROUNDS) final = true;
      const resp = [];
      for (const fc of calls) resp.push(...resultParts(await payload.session.call(fc.name, fc.args || {}), fc.name, fc.id));
      if (stopped || ctrl.signal.aborted) return io.end();   // stopped while the tools ran: ask Google nothing more
      contents = [...contents, { role: 'model', parts: modelParts }, { role: 'user', parts: resp }];
      try { up = await send(); } catch (e) { if (stopped) return io.end(); st.end = { error: ctrl.signal.aborted ? NO_ANSWER : 'Could not reach Google: ' + e.message }; break; }
      if (!up.ok) { st.end = { error: errorMessage(await up.text(), up.status, payload.web && withSearch) }; break; }
      continue;
    }
    if (/SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII/.test(finish || '') && !st.any) st.end = { error: 'Gemini didn’t answer this (its ' + finish.toLowerCase() + ' filter stopped it).' };
    else st.end = { done: true, truncated: finish === 'MAX_TOKENS' };
    break;
  }
  if (st.end && st.end.error) out({ error: st.end.error });
  else {
    // Google sometimes leaves out the list of what a search found (no groundingChunks) while the reply still links
    // to its results through Google's redirect: then those links are the sources, named by their link text.
    if (!st.gotSources && payload.web) {
      const found = groundedLinks(st.text);
      if (found.length) {
        if (env.DEV) console.warn(`gemini: no grounding sources came (grounding keys: ${st.grounding ? st.grounding.join(',') || 'none' : 'no groundingMetadata'}); took ${found.length} from the reply's links`);
        sources(found);
      }
    }
    const w = windows.get(payload.model), u = st.usage;
    out({ done: true, model: payload.model, truncated: !!(st.end && st.end.truncated), ...(u ? { usage: { ctx: u.ctx, cached: u.cached, out: u.out, rounds: u.rounds, ...(w ? { window: w } : {}) } } : {}) });
  }
  io.end();
}
