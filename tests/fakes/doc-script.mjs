// One scripted "model reading a document", shared by all three fake providers so tests/test_doc_tools.py
// can check every provider's tool loop the same way. When the reader's latest question contains READDOC
// and the request offers the document tools, the fake model:
//   round 1: calls search("ZEBRA-42") and view_page(2) together (two calls in one turn)
//   round 2: calls read_pages(41, 43) and read_pages(9999) (that one must come back as an error)
//   then answers "DOCREPLY" plus a line per result: what it got back, exactly as the provider delivered it.
import crypto from 'node:crypto';

export const TRIGGER = 'READDOC';
export const ROUNDS = [
  [['search', { query: 'ZEBRA-42' }], ['view_page', { page: 2 }]],
  [['read_pages', { from: 41, to: 43 }], ['read_pages', { from: 9999 }]],
];
export const INTRO = 'Let me look in the document.';
// READART: a web article: look at the pictures in part 1
const SCRIPTS = { READART: [[['view_page', { page: 1 }]]], [TRIGGER]: ROUNDS };
// the script a question asks for (by its trigger word), or null
export const scriptFor = (text) => { for (const [k, r] of Object.entries(SCRIPTS)) if (text.includes(k)) return r; return null; };

// results: [{name, error, parts:[{type:'text',text} | {type:'image', mediaType, data(base64)}]}]
export function answer(results) {
  const lines = results.map((r) => {
    const bits = r.parts.map((p) => {
      if (p.type === 'text') return 'text:' + p.text.replace(/\s+/g, ' ').slice(0, 300);
      const buf = Buffer.from(p.data, 'base64');
      return `image:${p.mediaType}:${buf.length}:png=${buf.subarray(1, 4).toString() === 'PNG'}:sha=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`;
    });
    return `- ${r.name}${r.error ? ' ERROR' : ''}: ${bits.join(' | ')}`;
  });
  return `DOCREPLY after ${results.length} tool results:\n${lines.join('\n')}`;
}
