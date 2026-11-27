// Pure model-context and prompt assembly: system prompt, skills, branch prefixes/images,
// document preamble (whole vs. tools vs. page-picking budget), and buildContext().
// No DOM or module-level mutable state; safe to import directly from Node unit tests.
import { trunc } from './text.js';

export const DOC_BUDGET = 200000;   // characters of document text per request (~50k tokens)
export const DOC_FIRST = 3;         // with the document tools: pages always given up front when a document is too long to send whole
export const DOC_TOOL_NAMES = ['search', 'read_pages', 'view_page'];

export const isDocBranch = (t) => !!t && t.anchorMsg === 'DOC';
export const isClipBranch = (t) => !!t && t.anchorMsg === 'CLIP';
export const isWholePage = (r) => !!r && r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999;
export const cropRef = (rec, r) => ({ crop: { asset: rec.asset, data: rec.data, type: rec.type, x: r.x, y: r.y, w: r.w, h: r.h } });
export const shotRef = (t) => { const a = t.anchorShot || {}; return a.asset ? { asset: a.asset, type: a.type } : { data: a.data || '' }; };
export const docImgRefOf = (conv, t) => { const a = t.anchorImg, rec = conv && conv.doc && conv.doc.images && conv.doc.images[a.key]; return cropRef(rec || {}, a); };
export const docImgLabel = (t) => String(t.anchorText || '').replace(/^(Image|Snip of an image)(: )?/, '');

export const defaultSysOf = (custom, prompts) => (custom && custom.prompts && custom.prompts.system) || prompts.system;
export const sysPromptOf = (c, custom, prompts) => (c && typeof c.system === 'string' && c.system.trim()) ? c.system : defaultSysOf(custom, prompts);
export const convSkillsOf = (c, custom) => ((c && c.skills) || []).map(id => custom && custom.skills && custom.skills.get(id)).filter(Boolean);
export function skillsPromptOf(c, custom, prompts) {
  const s = convSkillsOf(c, custom);
  return s.length ? '\n\n' + prompts.skills.intro + '\n\n' + s.map(prompts.skills.one).join('\n\n') : '';
}
export const fullSysOf = (c, custom, prompts) => sysPromptOf(c, custom, prompts) + '\n\n' + prompts.howDigress + skillsPromptOf(c, custom, prompts);

export const pageText = (docState, i) => {
  const t = docState.pages[i], pdf = docState.kind === 'pdf';
  return t.trim() ? t : `(no text on this ${pdf ? 'page' : 'part'}: it may be a scan, an image or a figure${pdf ? '; view_page shows it' : ''})`;
};
export const docTooLong = (docState, budget = DOC_BUDGET) => !!(docState && docState.loaded && docState.pages.reduce((n, p) => n + p.length, 0) > budget);

export const toolsWantedOf = (conv, io, o) => !!(conv && conv.doc && io && io.llm && io.llm.supportsTools && !(o && o.tools === false));
export const cardToolOf = (conv, io, o) => conv && conv.cards && conv.cards.on && io && io.llm && io.llm.supportsTools && !(o && o.tools === false) ? ['suggest_card'] : [];

export const partsText = (parts) => parts.filter(p => p.type === 'text').map(p => p.text).join('');
export function joinParts(parts) {   // neighbouring text parts become one; all-text becomes a string
  const out = [];
  for (const p of parts) {
    const l = out[out.length - 1];
    if (p.type === 'text' && l && l.type === 'text') l.text += p.text;
    else out.push({ ...p });
  }
  return out.every(p => p.type === 'text') ? partsText(out) : out.filter(p => p.type !== 'text' || p.text);
}
export function appendText(msg, s) {
  if (typeof msg.content === 'string') msg.content += s;
  else msg.content = [...msg.content, { type: 'text', text: s }];
}

function ancestorsOf(conv, tid) {
  const p = [];
  let t = conv && conv.threads && conv.threads[tid];
  while (t) { p.unshift(t); t = t.parent ? conv.threads[t.parent] : null; }
  return p;
}

export function branchPrefix(conv, t, prompts) {
  const quote = (x) => '> ' + String(x || '').replace(/\n+/g, '\n> ');
  if (isDocBranch(t)) return prompts.branch.docPassage(quote(t.anchorText), conv && conv.doc && conv.doc.kind === 'pdf' ? t.anchorPage + 1 : 0, t.anchorEnd ? t.anchorEnd.page + 1 : 0);
  return t.anchorText ? prompts.branch.replyPassage(quote(t.anchorText)) : prompts.branch.reply();
}

// With the document tools and a document too long to send whole, a branch about a passage also gets the
// full text of its page and the pages on either side, in its first message, where it stays for the branch.
export function aroundParts(docState, t, prompts) {
  const P = docState.pages, pdf = docState.kind === 'pdf';
  const a = Math.max(0, t.anchorPage - 1), b = Math.min(P.length - 1, Math.max(t.anchorPage, t.anchorEnd ? t.anchorEnd.page : 0) + 1);
  const lab = (i) => pdf ? `p. ${i + 1}` : `part ${i + 1}`;
  return [{ type: 'text', text: prompts.branch.around(a === b ? lab(a) : `${pdf ? 'pp.' : 'parts'} ${a + 1}–${b + 1}`, P.slice(a, b + 1).map((_, k) => `[${lab(a + k)}]\n${pageText(docState, a + k)}`).join('\n\n')) }];
}

export function branchParts(env, t, tools) {
  const { conv, docState, prompts, budget = DOC_BUDGET } = env;
  if (isClipBranch(t)) {
    const quote = (x) => '> ' + String(x || '').replace(/\n+/g, '\n> ');
    const imgs = Array.isArray(t.anchorImages) ? t.anchorImages : [];
    return [{ type: 'text', text: prompts.branch.clip(quote(t.anchorText || ''), t.anchorTitle || '', t.anchorUrl || '', imgs.length > 0) },
      ...imgs.map((ref, k) => ({ type: 'image', ref, label: `clipped image ${k + 1}` })),
      ...(imgs.length ? [{ type: 'text', text: '\n\n' }] : [])];
  }
  if (tools && isDocBranch(t) && docTooLong(docState, budget) && Number.isInteger(t.anchorPage)) return [...branchParts(env, t, false), ...aroundParts(docState, t, prompts)];
  if (isDocBranch(t) && t.anchorShot) {
    return [{ type: 'text', text: prompts.branch.docShot(t.regionText) }, { type: 'image', ref: shotRef(t), label: 'the snip of the document' }, { type: 'text', text: '\n\n' }];
  }
  if (isDocBranch(t) && t.anchorImg) {
    const whole = isWholePage(t.anchorImg);
    return [{ type: 'text', text: prompts.branch.docImage(docImgLabel(t), whole) }, { type: 'image', ref: docImgRefOf(conv, t), label: whole ? 'the image' : 'the snip of an image' }, { type: 'text', text: '\n\n' }];
  }
  if (isDocBranch(t) && t.anchorRegion) {
    const r = t.anchorRegion, p = t.anchorPage + 1, whole = isWholePage(r);
    const head = whole ? prompts.branch.docPage(p) : prompts.branch.docSnip(p, t.regionText);
    return [{ type: 'text', text: head }, { type: 'image', ref: { region: { page: p, x: r.x, y: r.y, w: r.w, h: r.h } }, label: whole ? `page ${p}` : `the snip from p. ${p}` }, { type: 'text', text: '\n\n' }];
  }
  return [{ type: 'text', text: branchPrefix(conv, t, prompts) }];
}

export function safeDocSource(src) {
  if (typeof src !== 'string' || !src.trim()) return '';
  try {
    const u = new URL(src);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin + (u.pathname && u.pathname !== '/' ? u.pathname : '');
  } catch { return ''; }
}

export function docPreamble(env, tid, question, tools) {
  const { conv, docState, docView, prompts, budget = DOC_BUDGET } = env;
  if (!conv || !conv.doc) return { text: '', docSeen: null };
  if (!docState || !docState.loaded) return { text: prompts.doc.notLoaded(conv.doc.name), docSeen: null };
  const P = docState.pages, pdf = docState.kind === 'pdf', label = i => pdf ? `p. ${i + 1}` : `part ${i + 1}`;
  const D = prompts.doc, cite = D.cite(pdf), unit = pdf ? 'pages' : 'parts', srcLabel = safeDocSource(conv.doc.source);
  if (tools) {
    // With the document tools the model reads what it needs itself. What it starts with is fixed for the
    // whole conversation (the same text every question, so every thread shares one prompt cache): all of
    // it when it fits; otherwise the table of contents and the first pages. Branches about a passage add
    // the pages around it to their own first message (branchParts), where they stay for the whole branch.
    const head = D.head(docState.name, P.length, unit, srcLabel);
    const look = pdf ? D.lookPdf : conv.doc.article ? D.lookArticle : '';
    if (!docTooLong(docState, budget)) {
      return {
        docSeen: { of: P.length, all: true, tools: true },
        text: `${head}${D.whole}${look} ${cite}\n<document>\n${P.map((_, i) => `[${label(i)}]\n${pageText(docState, i)}`).join('\n\n')}\n</document>`,
      };
    }
    const ol = docState.outline, n = Math.min(DOC_FIRST, P.length);
    let toc = '';
    if (ol && ol.length) {
      for (const x of ol) {
        const l = '  '.repeat(Math.min(x.depth, 6)) + x.title + (x.page ? ` … ${label(x.page - 1)}` : '');
        if (toc.length + l.length > 16000) { toc += '  … (the contents go on)\n'; break; }
        toc += l + '\n';
      }
    }
    return {
      docSeen: { of: P.length, tools: true, pages: `${toc ? 'the contents and ' : ''}${n > 1 ? `pp. 1–${n}` : 'p. 1'}` },
      text: `${head}${D.tooLong({ toc: !!toc, n, unit, pdf })}${look} ${cite}\n${toc ? `<contents>\n${toc}</contents>\n` : ''}<document>\n${P.slice(0, n).map((_, i) => `[${label(i)}]\n${pageText(docState, i)}`).join('\n\n')}\n[the rest (${n < P.length - 1 ? `${pdf ? 'pp.' : 'parts'} ${n + 1}–${P.length}` : label(P.length - 1)}) is available through the tools]\n</document>`,
    };
  }
  // The whole document goes in whenever it fits (most papers, reports, model cards): the model then never
  // misses a page, and the instructions stay identical for every question in the conversation, so all its
  // threads share one prompt cache. Only bigger documents are cut down, with every gap marked.
  const total = P.reduce((n, p) => n + p.length, 0), pick = new Set();
  if (total <= budget) P.forEach((_, i) => pick.add(i));
  else {
    let used = 0;
    const add = i => { if (i < 0 || i >= P.length || pick.has(i) || used + P[i].length > budget) return; pick.add(i); used += P[i].length; };
    add(0); add(1);
    const anc = ancestorsOf(conv, tid).find(isDocBranch);
    if (anc) { add(anc.anchorPage); add(anc.anchorPage - 1); add(anc.anchorPage + 1); }
    else if (pdf && docView && docView.current) add(docView.current - 1);
    const words = (question || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
    if (words.length) P.map((p, i) => { const lp = p.toLowerCase(); return [words.reduce((s, w) => s + (lp.split(w).length - 1), 0), i]; }).sort((a, b) => b[0] - a[0]).forEach(([s, i]) => { if (s > 0) add(i); });
    for (let i = 0; i < P.length; i++) add(i);
  }
  const partial = pick.size < P.length, sorted = [...pick].sort((a, b) => a - b);
  const ranges = (ix) => { const r = []; for (const i of ix) { const l = r[r.length - 1]; if (l && l[1] === i - 1) l[1] = i; else r.push([i, i]); } return r; };
  const span = ([a, b]) => a === b ? label(a) : pdf ? `pp. ${a + 1}–${b + 1}` : `parts ${a + 1}–${b + 1}`;
  const missing = ranges(P.map((_, i) => i).filter(i => !pick.has(i)));
  const out = []; let prev = -1;
  for (const i of sorted) {
    if (i > prev + 1) out.push(`[${span([prev + 1, i - 1])} not included]`);
    out.push(`[${label(i)}]\n${P[i].trim() ? P[i] : `(no text on this ${pdf ? 'page' : 'part'}: it may be a scan, an image or a figure)`}`);
    prev = i;
  }
  if (prev < P.length - 1) out.push(`[${span([prev + 1, P.length - 1])} not included]`);
  const docSeen = partial ? { n: pick.size, of: P.length, pages: ranges(sorted).map(span).join(', ') } : { of: P.length, all: true };
  const cut = partial ? D.cut({ n: pick.size, of: P.length, unit, missing: missing.map(span).join(', '), one: pdf ? 'page' : 'part' }) : '';
  return {
    docSeen,
    text: `${D.head(docState.name, P.length, unit, srcLabel)}${D.textOnly}${cut} ${cite}${D.noVisuals}\n<document>\n${out.join('\n\n')}\n</document>`,
  };
}

export function buildContext(env, tid, excludeMid, opts) {
  const { conv, docState, custom, prompts, threadOps, settings, io } = env;
  const tools = toolsWantedOf(conv, io, opts);   // the model can read the document itself (see runDocTool); opts.tools:false for side jobs like drafting cards
  const out = [];
  const push = (role, c) => {
    const parts = typeof c === 'string' ? [{ type: 'text', text: c }] : c;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push({ type: 'text', text: '\n\n' }, ...parts);
    else out.push({ role, parts: [...parts] });
  };
  // the messages on this thread's path, in order (threads.js: the same walk its checks use)
  const seq = [];
  threadOps.walk(conv, tid, (m, pre) => seq.push([m, pre]));
  // Everything added to a question is worked out from what's saved with it (its reply's Web, the page it was asked
  // on), never from how things are now, so earlier questions read the same in every request: the prompt cache
  // depends on it. The question being answered (its reply is excludeMid) gets Web as it is now, as generate does.
  const webFor = (i) => {
    for (let j = i + 1; j < seq.length; j++) {
      const r = seq[j][0];
      if (r.role === 'user') return false;
      if (r.role === 'assistant') return r.id === excludeMid ? !!(settings && settings.web && io && io.llm && io.llm.supportsWeb) : !!r.web;
    }
    return false;
  };
  let lastQ = '';
  seq.forEach(([m, pre], i) => {
    if (m.id === excludeMid) return;
    let c = m.content || '';
    if (m.role === 'user') lastQ = c;
    if (m.role === 'note') {
      if (c && !m.pending) push('user', prompts.takeawayNote(conv.threads[m.fromThread] ? conv.threads[m.fromThread].title : (m.fromTitle || '(deleted)'), c));
      return;
    }
    if (m.role === 'assistant' && (!c || m.pending)) return;
    let parts = [{ type: 'text', text: c }];
    if (m.role === 'user') {
      if (m.images && m.images.length) parts = [...m.images.map((ref, k) => ({ type: 'image', ref, label: `image ${k + 1} attached to “${trunc(c || 'a message', 40)}”` })), ...(c ? parts : [])];
      if (pre) parts = [...branchParts(env, pre, tools), ...parts];
      if (m.lookAt) parts.push({ type: 'text', text: prompts.lookingAt(m.lookAt) });
      if (webFor(i)) parts.push({ type: 'text', text: prompts.webOn });
    }
    push(m.role, parts);
  });
  while (out.length && out[0].role !== 'user') out.shift();
  // the same for every thread and question in this conversation (the prompt cache): the system prompt, its skills, the document
  const base = fullSysOf(conv, custom, prompts);
  let system = base, docSeen = null;
  if (out.length && conv.doc) {
    const last = out[out.length - 1];
    const pre = docPreamble(env, tid, last.role === 'user' ? lastQ : '', tools);
    system = base + '\n\n' + pre.text;
    docSeen = pre.docSeen;
  }
  const names = [...(tools && conv.doc && docState && docState.loaded ? DOC_TOOL_NAMES : []), ...cardToolOf(conv, io, opts)];
  return { system, messages: out.map(o => ({ role: o.role, content: joinParts(o.parts) })), docSeen, tools: names.length ? names : false };
}
