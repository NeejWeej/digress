// What the page sends as a conversation, and how each provider receives it.
//
// The page sends messages as {role:'user'|'assistant', content}, where content is either a string or
// a list of parts: {type:'text', text} and, in user messages only, {type:'image', mediaType, data}
// (data = base64). Images are an area snipped from a PDF page, a whole page, or a pasted screenshot.
//
// normalizeMessages() checks all of it and refuses anything it doesn't understand (400) rather than
// quietly leaving it out: nothing the reader sent may go missing on the way to the model. The
// converters below keep every part, in order; tests/test_context.py checks that for every provider.
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the Anthropic API's per-image limit
export const MAX_IMAGES = 60;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
// the first bytes of each allowed format, so a part can't claim to be an image it isn't
const MAGIC = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export const isImage = (type, buf) => !!MAGIC[type] && buf.length > 12 && MAGIC[type](buf);

// -> [{role, parts:[{type:'text',text} | {type:'image',mediaType,data}]}]
export function normalizeMessages(list) {
  if (!Array.isArray(list) || !list.length) throw bad('messages are required');
  let images = 0;
  return list.map((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw bad(`message ${i + 1} has no valid role`);
    const raw = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (!Array.isArray(raw)) throw bad(`message ${i + 1} has no content`);
    const parts = raw.map((p, j) => {
      if (p && p.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text };
      if (p && p.type === 'image') {
        if (m.role !== 'user') throw bad(`message ${i + 1}: only your own messages can carry images`);
        if (!IMAGE_TYPES.has(p.mediaType)) throw bad(`message ${i + 1}: image ${j + 1} isn't PNG, JPEG, WebP or GIF`);
        if (typeof p.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) throw bad(`message ${i + 1}: image ${j + 1} isn't valid base64`);
        const head = Buffer.from(p.data.slice(0, 24), 'base64');
        if (!MAGIC[p.mediaType](head)) throw bad(`message ${i + 1}: image ${j + 1} isn't really ${p.mediaType}`);
        if (p.data.length * 0.75 > MAX_IMAGE_BYTES) throw bad(`message ${i + 1}: image ${j + 1} is over 5 MB`);
        if (++images > MAX_IMAGES) throw bad(`too many images in one conversation (over ${MAX_IMAGES})`);
        return { type: 'image', mediaType: p.mediaType, data: p.data };
      }
      throw bad(`message ${i + 1}: part ${j + 1} isn't text or an image`);
    });
    return { role: m.role, parts };
  });
}

export const textOfParts = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
const onlyText = (parts) => parts.every((p) => p.type === 'text');
const nonEmpty = (p) => p.type !== 'text' || p.text !== ''; // the APIs reject empty text blocks; they carry nothing

// Anthropic Messages API. Text-only messages stay plain strings, as before images existed.
export const toAnthropic = (msgs) => msgs.map((m) => ({
  role: m.role,
  content: onlyText(m.parts) ? textOfParts(m.parts) : m.parts.filter(nonEmpty).map((p) => p.type === 'text'
    ? { type: 'text', text: p.text }
    : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }),
}));

// OpenAI Responses API input items (after the developer message).
export const toOpenAI = (msgs) => msgs.map((m) => ({
  role: m.role,
  content: m.role === 'assistant' || onlyText(m.parts) ? textOfParts(m.parts) : m.parts.filter(nonEmpty).map((p) => p.type === 'text'
    ? { type: 'input_text', text: p.text }
    : { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}`, detail: 'auto' }),
}));

// Claude Code CLI: `claude -p` takes one user message, so earlier turns go in as a transcript, with
// each image placed where it was in the conversation. Sent as stream-json content blocks.
export function toClaudeCodeBlocks(msgs) {
  const seq = [];
  const add = (x) => { if (x === '') return; if (typeof x === 'string' && typeof seq[seq.length - 1] === 'string') seq[seq.length - 1] += x; else seq.push(x); };
  const body = (m) => m.parts.forEach((p) => add(p.type === 'text' ? p.text : p));
  const last = msgs[msgs.length - 1];
  if (msgs.length === 1) body(last);
  else {
    add('Our conversation so far:\n\n');
    msgs.slice(0, -1).forEach((m, i) => { add(`${i ? '\n\n' : ''}<${m.role}>\n`); body(m); add(`\n</${m.role}>`); });
    add('\n\nNow reply to my latest message:\n\n');
    body(last);
  }
  return seq.map((x) => typeof x === 'string'
    ? { type: 'text', text: x }
    : { type: 'image', source: { type: 'base64', media_type: x.mediaType, data: x.data } });
}
