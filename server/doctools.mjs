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
import crypto from 'node:crypto';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, isImage } from './content.mjs';

export const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS || 15);
// requests per answer in a tool loop, the same for every provider: past MAX_TOOL_CALLS the model is told to
// answer, so it needs a round or two more; this only stops a model that keeps calling anyway
export const MAX_TOOL_ROUNDS = MAX_TOOL_CALLS + 3;
const WAIT_MS = 120_000; // how long a call waits for the browser before telling the model it failed

export const DOC_TOOLS = [
  {
    name: 'search',
    description: 'Search the document’s text for a word or phrase (not case-sensitive; spaces and line breaks don’t matter). Returns the pages it appears on, with the text around each match. Use it to find where something is discussed, defined or referred to, e.g. "Section 4.2", "Figure 12" or a term. Short exact phrases work best; it does not match synonyms.',
    schema: { type: 'object', properties: { query: { type: 'string', description: 'The words to find.' } }, required: ['query'], additionalProperties: false },
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
const BUDGET = ` You can make up to ${MAX_TOOL_CALLS} document tool calls per answer, all three tools together, so plan what to read; when only a few are left, each result says how many.`;
for (const t of DOC_TOOLS) t.description += BUDGET;
const NAMES = new Set(DOC_TOOLS.map((t) => t.name));

// ---- one session per reply that may use tools ----------------------------------------------
const byChat = new Map(), byToken = new Map();
const failed = (text) => ({ error: true, parts: [{ type: 'text', text }] });

// chatId comes from the browser (it posts results under it); token is for Claude Code's MCP connection.
// session.out is set by the provider once the reply's stream has started.
export function openSession(chatId) {
  if (typeof chatId !== 'string' || !/^[a-f0-9]{32}$/.test(chatId) || byChat.has(chatId)) return null;
  const s = { chatId, token: crypto.randomBytes(24).toString('hex'), calls: 0, pending: new Map(), closed: false, out: null };
  s.call = async (name, input) => {
    if (s.closed) return failed('The reader stopped this reply.');
    if (!NAMES.has(name)) return failed(`There is no tool called "${name}". The tools are: ${[...NAMES].join(', ')}.`);
    if (++s.calls > MAX_TOOL_CALLS) return failed(`That is the limit of ${MAX_TOOL_CALLS} document tool calls for one answer. Answer now with what you have, and say plainly which parts of the document you did not get to read.`);
    if (!s.out) return failed('The document tools are not connected for this reply.');
    const id = crypto.randomBytes(8).toString('hex');
    s.out({ tool: { id, name, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {} } });
    return new Promise((resolve) => {
      const done = (r) => {
        clearTimeout(done.timer); s.pending.delete(id);
        const left = MAX_TOOL_CALLS - s.calls;   // running low: say so in the result, so the model can plan its last reads
        if (left <= 3) r = { ...r, parts: [...r.parts, { type: 'text', text: left ? `(${left} document tool call${left > 1 ? 's' : ''} left for this answer.)` : '(That was the last document tool call for this answer: answer now with what you have, and say what you didn’t get to read.)' }] };
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
      const buf = Buffer.from(p.data, 'base64');
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
export const toolsForAnthropic = () => DOC_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
export const toolsForOpenAI = () => DOC_TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false }));
export const CLAUDE_CODE_TOOL_NAMES = DOC_TOOLS.map((t) => 'mcp__digress__' + t.name); // how Claude Code names MCP tools

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
// It lists DOC_TOOLS and sends each call through the same session.call as the other providers.
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
  if (m.method === 'tools/list') return reply({ tools: DOC_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
  if (m.method === 'tools/call') return reply(mcpContent(await s.call(p.name, p.arguments || {})));
  return json(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
}
