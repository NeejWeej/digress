// Pure text, Markdown-to-plain, citation-stripping, PDF-title, and search-passage helpers.
// No DOM or application state; safe to import directly from Node tests.

export const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// inline LaTeX as readable text: \sqrt{d_k} → √d_k, q \cdot k → q · k, \mathrm{Var} → Var
export const TEXW = { cdot: '·', times: '×', sqrt: '√', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', to: '→', rightarrow: '→', infty: '∞', pm: '±', sum: 'Σ', int: '∫', in: '∈', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', partial: '∂', nabla: '∇' };
export const texText = (t) => t.replace(/\\(?:mathrm|text|mathbf|mathit|operatorname|left|right|big|Big)\b/g, '').replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2').replace(/\\([a-zA-Z]+)/g, (m, w) => TEXW[w] ?? w).replace(/[{}]/g, '').replace(/\\[,;! ]/g, ' ');

export const CITE_Q_RE = /\[((?:pp?\.|pages?|parts?)\s*\d+(?:\s*[–-]\s*\d+)?|earlier|doc)\s+["“]([^"”\n\]]+)["”]\]/gi;
export const stripCiteQuotes = (s) => String(s || '').replace(CITE_Q_RE, '[$1]');

export const plain = (md) => stripCiteQuotes(md)
  .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')                     // --- rules
  .replace(/^[ \t]*\|?[ \t]*:?-{2,}[-:| \t]*$/gm, '')                        // table separator rows
  .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*?)[ \t]*$/gm, (m, x) => /[.?!:;,]$/.test(x) ? x : x + ';')   // list markers go; items stay apart
  .replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (m, h) => /[.?!:;]$/.test(h) ? h : h + '.')   // a heading reads as a sentence
  .replace(/```mermaid[\s\S]*?(```|$)/g, ' [diagram] ').replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/\$\$[\s\S]*?\$\$/g, ' [equation] ').replace(/\$([^$\n]+)\$/g, (m, t) => texText(t)).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();

// a PDF's Title metadata, cleaned, or '' when it's missing or junk (a file name, "Untitled", "Microsoft Word - x.docx", "Slide 1"...)
export function pdfTitleOk(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/[\u0000-\u001f\u007f\ufeff\u200b]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  s = s.replace(/^(microsoft\s+)?(word|powerpoint|excel|publisher)\s*-\s*/i, '');
  if (/^[a-z]:[\\/]|^\/|^\\\\|^(https?|file):/i.test(s) || /[\\/][^ ]*\.[a-z0-9]{2,5}$/i.test(s)) return '';
  const ext = /\.(pdf|docx?|dotx?|odt|rtf|txt|md|tex|dvi|ps|eps|pptx?|odp|key|xlsx?|pages|indd|html?|qxd|wpd|png|jpe?g|tiff?)$/i;
  if (ext.test(s)) { s = s.slice(0, s.search(ext)).trim(); if (!/\s/.test(s)) return ''; }
  if (!/\s/.test(s) && /[_.]|\d{3}/.test(s)) return '';
  if (s.length < 3 || (s.match(/\p{L}/gu) || []).length < 2) return '';
  if (/^(untitled|no title|title|none|null|unknown|default|blank|draft|document|new document|presentation|slide|page|layout|doc|file|pdf|print|microsoft word|powerpoint presentation|title of (the )?(paper|document|thesis)|your title here|insert title here|template|output|scan|scanned document|image)(\s*[-_#:]?\s*\d+)?$/i.test(s)) return '';
  if (/^untitled\b/i.test(s)) return '';
  return trunc(s, 120);
}

export const PASS = 900;
export const OVERLAP = 120;

export function passages(md) {
  const blocks = []; let cur = [], fence = false;
  for (const line of String(md || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim()) { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } continue; }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  const out = []; let buf = '';
  const add = t => { if (!t) return; if (buf && buf.length + t.length + 1 > PASS) { out.push(buf); buf = t; } else buf = buf ? buf + ' ' + t : t; };
  for (const b of blocks) {
    let t = plain(b);
    while (t.length > PASS * 1.5) {   // one long paragraph: split at a sentence end (or a space) near PASS
      let cut = t.lastIndexOf('. ', PASS); if (cut < PASS / 2) cut = t.indexOf(' ', PASS); if (cut < 0) break;
      add(t.slice(0, cut + 1).trim()); t = t.slice(cut + 1).trim();
    }
    add(t);
  }
  if (buf) out.push(buf);
  return out.map((x, i) => { if (!i) return { x, o: 0 }; const prev = out[i - 1], tail = prev.slice(Math.max(0, prev.length - OVERLAP)).replace(/^\S*\s/, ''); return { x: tail + ' ' + x, o: tail.length + 1 }; });
}

export function indexEntries(c, pages) {
  const E = [], push = (k, x, o) => { x = plain(x); if (x) E.push({ k, x, ...o }); };
  const pass = (k, md, o) => passages(md).forEach((p, n) => E.push({ k, x: p.x, ...o, n, o: p.o }));
  push('ct', c.title, { tid: 'main' });
  for (const t of Object.values(c.threads || {})) { if (!t.parent) continue; push('bt', t.title, { tid: t.id }); if (t.anchorText) push('h', t.anchorText, { tid: t.id }); }
  for (const m of Object.values(c.msgs || {})) { if (!m.content) continue; pass(m.role === 'user' ? 'q' : m.role === 'note' ? 'n' : 'a', m.content, { tid: m.thread, mid: m.id }); }
  if (pages) pages.forEach((p, i) => pass('d', p, { p: i + 1 }));
  return E;
}

// a document's page texts, put back together from its index (for when the document itself isn't loaded)
export function idxPages(d) {
  const by = new Map(); for (const e of (d && d.e) || []) if (e.k === 'd') { const a = by.get(e.p) || []; a.push(e); by.set(e.p, a); }
  const n = Math.max(0, ...by.keys()); return Array.from({ length: n }, (_, i) => (by.get(i + 1) || []).sort((a, b) => (a.n || 0) - (b.n || 0)).map(e => e.x.slice(e.o || 0)).join(' '));
}

export function sigOf(E) { const s = JSON.stringify(E); let h = 0; for (let i = 0; i < s.length; i += 3) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ':' + h; }

/* The text of root as one string, with each text node's offset in it, for finding a quote and putting a Range on
   it. A PDF's text layer is a span per line with a <br> between them and no space at the line's end, so read
   naively "the failure⏎message" is "the failuremessage" and a quote across a line never matches. A <br> becomes a
   space here (one character that belongs to no node; an offset on it falls at the end of the node before). With
   hyphens, a line ending in a letter and "-" keeps its hyphen but as a soft hyphen (U+00AD, the same length, so
   offsets don't move), which quoteRe lets sit inside a word: "be-⏎cause" matches both "because" and "be-cause".
   skip(el): leave that element's text out. */
export function linedText(root, skip, hyphens) {
  const nodes = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => (n.nodeType === 1 ? (skip && skip(n) ? NodeFilter.FILTER_REJECT : n.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) : (skip && skip(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)) });
  let text = '', n, br = false;
  while ((n = w.nextNode())) {
    if (n.nodeType === 1) { br = true; continue; }
    if (br && text) { if (hyphens && /\p{L}-$/u.test(text)) text = text.slice(0, -1) + '\u00AD'; else if (!/\s$/.test(text)) text += ' '; }
    br = false; nodes.push([n, text.length]); text += n.data;
  }
  return { nodes, text };
}
