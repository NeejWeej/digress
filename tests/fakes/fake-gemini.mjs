#!/usr/bin/env node
// A pretend Gemini API for tests: GET /v1beta/models and a streaming :streamGenerateContent (SSE). The key must be
// sent in the x-goog-api-key header (never ?key=), and be gemini-test-key-0000000000. Each request body is
// appended to FAKE_LOG.
//   - the document tools: the shared script (doc-script.mjs). Function calls carry a thoughtSignature that must come
//     back with the model's turn, as Gemini requires; a turn sent back without it is refused (400).
//   - NEVERSTOP: keeps calling search until toolConfig says NONE, then answers FINALANSWER.
//   - SEARCHME with the googleSearch tool: a grounded answer with a query and a source.
//   - RATELIMIT: 429. OVERLOAD: 503, as Google answers when a model is busy (BUSYONCE: only the first time). HANG: no answer.
//   - function declarations are checked like the real API's OpenAPI schemas: `required` and `enum` must be lists of
//     strings, and additionalProperties isn't allowed (400 INVALID_ARGUMENT otherwise).
//   - gemini-old-1 refuses a thinking level, and Google Search together with function calling (400 each), as older
//     models do: the server must drop each and ask again.
import http from 'node:http';
import fs from 'node:fs';
import { scriptFor, INTRO, answer } from './doc-script.mjs';
const port = Number(process.argv[2] || 8797);
const KEY = 'gemini-test-key-0000000000';
const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
const MODELS = [
  { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-old-1', displayName: 'Gemini Old', inputTokenLimit: 32768, supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-nano-banana-2.1', displayName: 'Nano Banana 2.1', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-omni-1.2-flash', displayName: 'Gemini Omni 1.2 Flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
];
const textOf = (c) => (c.parts || []).map((p) => p.text || '').join('');
const isResults = (c) => c.role === 'user' && (c.parts || []).some((p) => p.functionResponse);

http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.searchParams.has('key')) return json(400, { error: { code: 400, message: 'test: the key must go in the x-goog-api-key header' } });
    if (req.headers['x-goog-api-key'] !== KEY) return json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
    if (u.pathname === '/v1beta/models' && req.method === 'GET') return json(200, { models: MODELS });
    const m = u.pathname.match(/^\/v1beta\/models\/([^:]+):streamGenerateContent$/);
    if (!m || req.method !== 'POST' || u.searchParams.get('alt') !== 'sse') return json(404, { error: { code: 404, message: 'not found' } });
    const j = JSON.parse(body);
    log({ gemini: true, model: m[1], ...j });
    // the schema rules the real API enforces on function declarations
    const badSchema = (s, at) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
      if ('additionalProperties' in s) return at + ': additionalProperties is not supported';
      for (const k of ['required', 'enum']) if (k in s && !(Array.isArray(s[k]) && s[k].every((x) => typeof x === 'string'))) return `${at}.${k}: must be a list of strings`;
      for (const [n, p] of Object.entries(s.properties || {})) { const e = badSchema(p, `${at}.properties.${n}`); if (e) return e; }
      return null;
    };
    for (const t of j.tools || []) for (const f of t.functionDeclarations || []) { const e = badSchema(f.parameters, f.name); if (e) return json(400, { error: { code: 400, message: 'Invalid JSON payload: ' + e, status: 'INVALID_ARGUMENT' } }); }
    if (m[1] === 'gemini-old-1' && (j.generationConfig || {}).thinkingConfig) return json(400, { error: { code: 400, message: 'Thinking level is not supported for this model.', status: 'INVALID_ARGUMENT' } });
    if (m[1] === 'gemini-old-1' && (j.tools || []).some((t) => t.googleSearch) && (j.tools || []).some((t) => t.functionDeclarations)) return json(400, { error: { code: 400, message: 'Tool use with function calling is unsupported together with search.', status: 'INVALID_ARGUMENT' } });
    const contents = j.contents || [], fnTools = (j.tools || []).some((t) => t.functionDeclarations), search = (j.tools || []).some((t) => t.googleSearch);
    const mode = ((j.toolConfig || {}).functionCallingConfig || {}).mode;
    const asked = [...contents].reverse().find((c) => c.role === 'user' && !isResults(c)), q = asked ? textOf(asked) : '';
    // BUSYONCE: 503 the first time, then answers (a quick refusal is tried again); HANG: never answers
    if (q.includes('BUSYONCE') && !(globalThis.busyOnce = (globalThis.busyOnce || 0) + 1, globalThis.busyOnce > 1)) return json(503, { error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } });
    if (q.includes('HANG')) return;   // no answer at all
    if (q.includes('OVERLOAD')) return json(503, { error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } });
    // FREESEARCH: a free key asking for Google Search: Google answers with a plain quota error, nothing about search
    if (q.includes('FREESEARCH') && (j.tools || []).some((t) => t.googleSearch)) return json(429, { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } });
    if (q.includes('RATELIMIT')) return json(429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } });
    // a model turn with function calls must come back with their thought signatures
    for (const c of contents) if (c.role === 'model') for (const p of c.parts || []) if (p.functionCall && !p.thoughtSignature) return json(400, { error: { code: 400, message: 'Function call is missing a thought_signature.' } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (parts, extra = {}) => res.write('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...extra }], modelVersion: m[1] }) + '\n\n');
    const end = (finishReason = 'STOP') => { res.write('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason }], usageMetadata: { promptTokenCount: Math.ceil(body.length / 4), cachedContentTokenCount: 0, candidatesTokenCount: 9, thoughtsTokenCount: 2 }, modelVersion: m[1] }) + '\n\n'); res.end(); };
    const done = contents.filter(isResults).length;
    if (fnTools && q.includes('NEVERSTOP')) {
      if (mode === 'NONE') { chunk([{ text: `FINALANSWER after ${done} tool results` }]); return end(); }
      chunk([{ functionCall: { name: 'search', args: { query: 'Section ' + (done + 1) } }, thoughtSignature: 'sig-n' + done }]); return end();
    }
    const ROUNDS = scriptFor(q);
    if (fnTools && ROUNDS) {
      if (done < ROUNDS.length) {
        if (done === 0) chunk([{ text: 'thinking about it', thought: true }, { text: INTRO }]);
        chunk(ROUNDS[done].map(([name, args], k) => ({ functionCall: { name, args }, thoughtSignature: `sig-${done}${k}` })));
        return end();
      }
      // every result, with the pictures that follow it in the same turn
      const results = [];
      for (const c of contents.filter(isResults)) for (const p of c.parts) {
        if (p.functionResponse) { const r = p.functionResponse.response || {}; results.push({ name: p.functionResponse.name, error: 'error' in r, parts: [{ type: 'text', text: String(r.error ?? r.result ?? '') }] }); }
        else if (p.inlineData && results.length) results[results.length - 1].parts.push({ type: 'image', mediaType: p.inlineData.mimeType, data: p.inlineData.data });
      }
      chunk([{ text: answer(results) }]); return end();
    }
    if (search && q.includes('SEARCHME')) {
      chunk([{ text: 'Searched and found it.' }], { groundingMetadata: { webSearchQueries: ['gemini search'], groundingChunks: [{ web: { uri: 'https://example.org/g', title: 'Gemini source' } }] } });
      return end();
    }
    const thinking = ((j.generationConfig || {}).thinkingConfig || {}).thinkingLevel || 'none';
    const text = `gemini reply web=${search} thinking=${thinking} n=${contents.length} system=${!!j.systemInstruction}`;
    for (const piece of text.match(/.{1,8}/g)) { chunk([{ text: piece }]); await new Promise((r) => setTimeout(r, 3)); }
    end(contents.some((c) => textOf(c).includes('CUTOFF')) ? 'MAX_TOKENS' : 'STOP');
  });
}).listen(port, '127.0.0.1', () => console.log('fake gemini on', port));
