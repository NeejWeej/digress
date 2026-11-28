// Tools that let the model read the open document itself: search it, read pages, look at a page.
//
// Written once, here, for every provider:
//  - DOC_TOOLS: what the tools are (name, description, JSON Schema for the arguments). Each provider gets
//    them in its own spelling (toolsForAnthropic / toolsForOpenAI / the MCP endpoint for Claude Code).
//  - The tools never run on the server. The browser tab that asked the question has the PDF open (its text
//    and pdf.js to draw pages), so each call is passed to that tab as a {tool:{id,name,input}} line in the
//    reply's own stream; the tab runs it and POSTs the result to /api/chat/tool, and the waiting call resumes.
//  - Results are parts, the same shape messages use: {type:'text',text} | {type:'image',mediaType,data}.
//    resultForAnthropic / resultForOpenAI / mcpContent spell them for each provider.
//  - The rules live in session.call: only these tools, at most MAX_TOOL_CALLS per answer, and every problem
//    comes back to the model as an error it can read (never an empty result it might take as "nothing there").
//
// The agentic loop itself is in each provider: chatViaApi (server.mjs) and chat (chatgpt.mjs) send the
// request, and while the model's reply stops on tool calls they run them through session.call and send
// the results back; Claude Code runs its own loop and calls the tools through handleMcp below.
import { IMAGE_TYPES, MAX_IMAGE_BYTES, isImage, fromBase64 } from './content.mjs';

// (no Node APIs: the demo runs this file in the browser too; see content.mjs)
const env = (globalThis.process && globalThis.process.env) || {};
const randHex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('');
export const MAX_TOOL_CALLS = Number(env.MAX_TOOL_CALLS || 30);
// requests per answer in a tool loop, the same for every provider: past MAX_TOOL_CALLS the model is told to
// answer, so it needs a round or two more; this only stops a model that keeps calling anyway. A model still
// calling tools then gets one last request with the tools switched off (tool_choice none), so it has to answer
// from what it read: stopping there used to end the reply with no text at all.
export const MAX_TOOL_ROUNDS = MAX_TOOL_CALLS + 3;
const WAIT_MS = 120_000; // how long a call waits for the browser before telling the model it failed

export const DOC_TOOLS = [
  {
    name: 'search',
    description: 'Search the document’s text. Give one or more queries in one call (up to 6): words, phrases, names, "Section 4.2", "Figure 12", or several wordings of the same idea, e.g. ["divine child", "child god", "primordial child"]; they count as one call. Each query is matched word for word, ignoring case, accents, quotes, hyphens and line breaks (a word hyphenated across lines still matches); you get the pages it appears on with the text around each match. A query not found word for word gets the passages closest to it instead (sharing its words, or words that start the same), marked as such. It does not know synonyms: give them as more queries.',
    schema: {
      type: 'object',
      properties: { queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'What to find: one or more words or short phrases, each searched separately.' } },
      required: ['queries'], additionalProperties: false,
    },
  },
  {
    name: 'read_pages',
    description: 'Read the extracted text of a range of pages, at most 8 per call. Pages are numbered from 1, the same numbers as the [p. N] labels. Figures, charts and images are not in the text; use view_page for those.',
    schema: {
      type: 'object',
      properties: { from: { type: 'integer', minimum: 1, description: 'First page.' }, to: { type: 'integer', minimum: 1, description: 'Last page (leave out for just one page).' } },
      required: ['from'], additionalProperties: false,
    },
  },
  {
    name: 'view_page',
    description: 'See one page as an image: figures, charts, tables, equations and layout that the extracted text loses or garbles. Larger than its text, so use it when the visual matters. For a web article (no pages), it shows the pictures marked [Image: …] in that part instead.',
    schema: { type: 'object', properties: { page: { type: 'integer', minimum: 1 } }, required: ['page'], additionalProperties: false },
  },
];
// the budget is said up front, in every tool's description, so it never comes as a surprise
const BUDGET = ` You can make up to ${MAX_TOOL_CALLS} reading tool calls per answer, shared by document reads, searches, page views and saved source lookups, so plan what to read; when only a few are left, each result says how many.`;
for (const t of DOC_TOOLS) t.description += BUDGET;

// Suggesting flashcards: offered only in a conversation with flashcards on (the page asks for it then), and the
// page refuses it otherwise. The cards go to the learner's inbox, never straight into review. Its own limit,
// apart from the document tools' budget.
export const MAX_CARD_CALLS = Number(env.MAX_CARD_CALLS || 10);
export const CARD_TOOL = {
  name: 'suggest_card',
  description: `Suggest one flashcard for the learner's spaced-repetition review, when something in this conversation is worth remembering for months: a key idea, a definition, a reason, or a misunderstanding the learner just cleared up. It goes to their inbox, where they keep it or throw it away; it doesn't interrupt them, and you don't need to mention it in your answer unless they ask. Use it when you judge a point has landed, not on every reply, and don't suggest the same thing twice. "front" asks one specific question, understandable on its own months from now; "back" is a short answer (one to three sentences; Markdown and LaTeX are fine); "quote" is the one sentence (under 40 words) in this conversation or the document that the answer rests on, copied word for word: leave it out rather than paraphrase. Call it once per card, at most ${MAX_CARD_CALLS} per answer. It only works while the learner has flashcards on for this conversation.`,
  schema: {
    type: 'object',
    properties: { front: { type: 'string', description: 'The question.' }, back: { type: 'string', description: 'The answer.' }, quote: { type: 'string', description: 'The sentence it rests on, word for word (optional).' } },
    required: ['front', 'back'], additionalProperties: false,
  },
};
const SOURCE_TOOL = {
  name: 'list_sources',
  description: 'Get saved web references and their originating question. Defaults to the latest list on this path. Pass a marker such as S1 for an earlier reply. No new web search. Shares the reading-tool budget.',
  schema: { type: 'object', properties: { reply: { type: 'string' } }, additionalProperties: false },
};
export const ALL_TOOLS = [...DOC_TOOLS, CARD_TOOL, SOURCE_TOOL];
// what the page asked for: true (older pages) is the document tools; a list names them; anything else, none
export function pickTools(want) {
  if (want === true) return DOC_TOOLS;
  if (!Array.isArray(want)) return [];
  return ALL_TOOLS.filter((t) => want.includes(t.name));
}

// ---- one session per reply that may use tools ----------------------------------------------
const byChat = new Map(), byToken = new Map();
const failed = (text) => ({ error: true, parts: [{ type: 'text', text }] });

// chatId comes from the browser (it posts results under it); token is for Claude Code's MCP connection.
// session.out is set by the provider once the reply's stream has started.
// tools: the ones this reply offers (pickTools); none, no session.
export function openSession(chatId, tools = DOC_TOOLS) {
  if (typeof chatId !== 'string' || !/^[a-f0-9]{32}$/.test(chatId) || byChat.has(chatId) || !tools.length) return null;
  const s = { chatId, token: randHex(24), calls: 0, cards: 0, tools, pending: new Map(), closed: false, out: null };
  const NAMES = new Set(tools.map((t) => t.name)), isCard = (name) => name === CARD_TOOL.name;
  s.call = async (name, input) => {
    if (s.closed) return failed('The reader stopped this reply.');
    if (!NAMES.has(name)) return failed(`There is no tool called "${name}". The tools are: ${[...NAMES].join(', ')}.`);
    if (isCard(name)) { if (++s.cards > MAX_CARD_CALLS) return failed(`That is the limit of ${MAX_CARD_CALLS} suggested cards for one answer.`); }
    else if (++s.calls > MAX_TOOL_CALLS) return failed(`That is the limit of ${MAX_TOOL_CALLS} reading tool calls for one answer. Answer now with what you have, and say plainly which evidence you could not retrieve.`);
    if (!s.out) return failed('The tools are not connected for this reply.');
    const id = randHex(8);
    s.out({ tool: { id, name, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {} } });
    return new Promise((resolve) => {
      const done = (r) => {
        clearTimeout(done.timer); s.pending.delete(id);
        const left = isCard(name) ? 99 : MAX_TOOL_CALLS - s.calls;   // running low: say so in the result, so the model can plan its last reads
        if (left <= 3) r = { ...r, parts: [...r.parts, { type: 'text', text: left ? `(${left} reading tool call${left > 1 ? 's' : ''} left for this answer.)` : '(That was the last reading tool call for this answer: answer now with what you have, and say what you didn’t get to read.)' }] };
        resolve(r);
      };
      s.pending.set(id, done); arm(done);
    });
  };
  // The call waits for the page, which runs it. While no page is attached (a phone locked mid-reply) there's
  // no timer: the run stops the whole reply if nobody comes back (runs.mjs). Once one is, it gets WAIT_MS.
  const arm = (done) => { clearTimeout(done.timer); done.timer = s.attached ? setTimeout(() => done(failed('The reader’s browser did not return this result in time, so it is missing. Don’t guess what it would have said.')), WAIT_MS) : null; };
  s.attached = true;
  s.setAttached = (on) => { s.attached = on; for (const done of s.pending.values()) arm(done); };
  s.close = () => {
    if (s.closed) return;
    s.closed = true;
    for (const done of [...s.pending.values()]) done(failed('The reply was stopped.'));
    byChat.delete(chatId); byToken.delete(s.token);
  };
  byChat.set(chatId, s); byToken.set(s.token, s);
  return s;
}

// What the browser posts back: {chat, id, parts} or {chat, id, error}. Checked like message content:
// anything we don't understand becomes an error for the model, never a silently empty result.
function checkParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 12) return null;
  const out = [];
  for (const p of parts) {
    if (p && p.type === 'text' && typeof p.text === 'string' && p.text.length <= 400_000) out.push({ type: 'text', text: p.text });
    else if (p && p.type === 'image' && IMAGE_TYPES.has(p.mediaType) && typeof p.data === 'string') {
      let buf; try { buf = fromBase64(p.data); } catch { return null; }
      if (buf.length > MAX_IMAGE_BYTES || !isImage(p.mediaType, buf)) return null;
      out.push({ type: 'image', mediaType: p.mediaType, data: p.data });
    } else return null;
  }
  return out;
}
export function deliverResult(body) {
  const s = body && byChat.get(body.chat), done = s && s.pending.get(body && body.id);
  if (!done) return { status: 404, error: 'No tool call is waiting for that result (the reply may have finished or been stopped).' };
  if (typeof body.error === 'string') { done(failed(body.error.slice(0, 4000))); return { status: 200 }; }
  const parts = checkParts(body.parts);
  if (!parts) { done(failed('The tool returned something that could not be read, so this result is missing.')); return { status: 400, error: 'Bad tool result' }; }
  done({ error: false, parts });
  return { status: 200 };
}

// ---- each provider's spelling --------------------------------------------------------------
// each takes the reply's session (its tools)
export const toolsForAnthropic = (s) => s.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
export const toolsForOpenAI = (s) => s.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false }));
export const claudeCodeToolNames = (s) => s.tools.map((t) => 'mcp__digress__' + t.name); // how Claude Code names MCP tools

export const resultForAnthropic = (r, toolUseId) => ({
  type: 'tool_result', tool_use_id: toolUseId, ...(r.error ? { is_error: true } : {}),
  content: r.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text || '(empty)' } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } })),
});
// OpenAI's function results have no error flag, so an error says so in its text
export const resultForOpenAI = (r, callId) => ({
  type: 'function_call_output', call_id: callId,
  output: r.parts.map((p, i) => (p.type === 'text' ? { type: 'input_text', text: (r.error && i === 0 ? 'Error: ' : '') + (p.text || '(empty)') } : { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` })),
});
const mcpContent = (r) => ({
  content: r.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text || '(empty)' } : { type: 'image', data: p.data, mimeType: p.mediaType })),
  ...(r.error ? { isError: true } : {}),
});

// ---- Claude Code: a minimal MCP server (Streamable HTTP, JSON responses) -------------------
// Claude Code only takes extra tools from MCP servers. The server is passed to it with --mcp-config as
// http://<this server>/api/mcp/<token>; the token is random, made for one reply, and dropped when it ends.
// It lists the reply's tools and sends each call through the same session.call as the other providers.
export async function handleMcp(token, req, res, readJson) {
  const s = byToken.get(token);
  const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (!s) return json(404, { error: 'Unknown or finished session' });
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); } // no server-sent stream: every answer is a JSON reply
  const m = await readJson(req);
  if (!m || Array.isArray(m)) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'One JSON-RPC message per request' } });
  if (m.id === undefined || m.id === null) { res.writeHead(202); return res.end(); } // a notification
  const reply = (result) => json(200, { jsonrpc: '2.0', id: m.id, result });
  const p = m.params || {};
  if (m.method === 'initialize') return reply({ protocolVersion: p.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'digress', version: '1' } });
  if (m.method === 'ping') return reply({});
  if (m.method === 'tools/list') return reply({ tools: s.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
  if (m.method === 'tools/call') return reply(mcpContent(await s.call(p.name, p.arguments || {})));
  return json(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
}
