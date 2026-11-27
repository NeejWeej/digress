// Shared client state, constants, DOM/icon/thread helpers, and cross-module action registry.
// Imported by every UI subsystem under web/js/ so modules stay decoupled without large callback bags.
import {
  defaultSysOf, sysPromptOf, convSkillsOf, skillsPromptOf, fullSysOf,
} from './context.js';

/* ---------- constants & icons ---------- */
export const PALETTE = ['#d9774b', '#3f8fd2', '#3fa077', '#9d6ad6', '#cc9a2e', '#d65a8a', '#2a9ea3', '#7f8f36'];
export const qid = (v) => CSS.escape(String(v));
export const STARTERS = [
  'How does self-attention in transformers work?',
  'Explain the Raft consensus algorithm',
  'What is a Fourier transform, intuitively?',
  'How does a B-tree index speed up queries?',
];
// Shown until the server's own model list (/api/models) arrives
export const MODELS = [
  ['auto', 'Auto'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-2', 'Fable 5.2'],
];
export const EFFORTS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
export const effortLabel = (e) => e === 'auto'
  ? 'auto effort'
  : ((EFFORTS.find((x) => x[0] === e) || [0, e])[1] + ' effort').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export const I = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  tune: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  chev: '<path d="M6 9.5l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  locate: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  sparkle: '<path d="M12 4l1.8 4.7L18.5 10.5 13.8 12.3 12 17l-1.8-4.7L5.5 10.5l4.7-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  dots: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.3 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7c1.8 0 3.4-.5 4.8-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  restart: '<path d="M5 4h14v12H9l-4 4z"/><path d="M12 7v6M9 10h6"/>',
  docnew: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M13 11v7M9.5 14.5h7"/>',
  versions: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7h2a5 5 0 0 0 5-5C21.4 6.4 17.2 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15.5" cy="7.5" r="1.2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  cols: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 14.5h18"/>',
  canvas: '<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><rect x="14" y="4" width="7" height="6" rx="1.5"/><path d="M10 7h4M17.5 10v4"/>',
  focus: '<rect x="8" y="4" width="8" height="16" rx="1.5"/><path d="M4 6v12M20 6v12"/>',
  unfocus: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  fitw: '<path d="M4 5v14M20 5v14M7.5 12h9M10 9.5 7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5"/>',
  collapse: '<path d="M6 12h12"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 5-6 4-11 7.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  snip: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  cards: '<rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  pin: '<path d="M9 3h6l-1 7 3.5 3.5h-11L10 10zM12 13.5V21"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.2h8A1.5 1.5 0 0 1 20.5 9.2V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  retry: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/>',
  take: '<path d="M20 12H8M12 7l-5 5 5 5M4 5v14"/>',
  jend: '<path d="M12 4v13M6 11l6 6 6-6M5 20h14"/>',
  jlast: '<path d="M12 6v12M6 12l6 6 6-6M5 4h14"/>',
  jprev: '<path d="M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  views: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  img: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  zoom: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8.5v5M8.5 11h5"/>',
  al: '<path d="M15 6l-6 6 6 6"/>',
  ar: '<path d="M9 6l6 6-6 6"/>',
  au: '<path d="M6 15l6-6 6 6"/>',
  ad: '<path d="M6 9l6 6 6-6"/>',
  zen: '<path d="M18.4 8.2A7 7 0 1 0 19 12"/>',
  mark: '<path d="M7 4h10v16l-5-3.6L7 20z"/>',
};
export const ic = (n) => `<svg class="i" viewBox="0 0 24 24">${I[n]}</svg>`;
export const $ = (s, r = document) => r.querySelector(s);
export const rid = () => Math.random().toString(36).slice(2, 10);

export function memoSet(map, k, v, max, onEvict) {
  if (map.has(k)) map.delete(k);
  map.set(k, v);
  while (map.size > max) {
    const fk = map.keys().next().value;
    const fv = map.get(fk);
    map.delete(fk);
    onEvict && onEvict(fv, fk);
  }
}

/* ---------- settings & prompts ---------- */
export const settings = { model: 'auto', effort: 'auto', web: false, theme: 'system', pdf: 'original', wires: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('sq:settings') || '{}')); } catch (e) {}
export function saveSettings() {
  try { localStorage.setItem('sq:settings', JSON.stringify(settings)); } catch (e) {}
}

export const CUSTOM = { prompts: {}, skills: new Map() };
export const defaultSys = () => defaultSysOf(CUSTOM, PROMPTS);
export const sysPrompt = (c) => sysPromptOf(c, CUSTOM, PROMPTS);
export const fullSys = (c) => fullSysOf(c, CUSTOM, PROMPTS);
export const quickList = () => (CUSTOM.prompts.quick && CUSTOM.prompts.quick.length ? CUSTOM.prompts.quick : PROMPTS.quick);
export const convSkills = (c) => convSkillsOf(c, CUSTOM);
export const skillsPrompt = (c) => skillsPromptOf(c, CUSTOM, PROMPTS);

/* ---------- shared mutable runtime state ---------- */
export const io = { llm: null, store: null, layout: null, index: null, files: null, cards: null, ready: null };
export const modelLabel = (v) => {
  if (!v) return '';
  if (typeof v === 'object') v = v.model || v.id || '';
  const list = (io.llm && io.llm.models()) || MODELS;
  const m = list.find((x) => x[0] === v) || MODELS.find((x) => x[0] === v);
  return m ? m[1] : String(v).replace(/^claude-/, '');
};

export const msgCache = new Map();
export const cvMsgCache = new Map();
export const paneEls = new Map();
export const gutEls = new Map();
export const streaming = new Map();
export const unread = new Set();

export const state = {
  conv: null,
  convList: [],
  convListLoaded: false,
  docState: null,
  mathReady: false,
  popState: null,
  hitSticky: false,
  hitTimer: null,
  dirty: false,
  cvTook: false,
};

// Cross-module action registry: each subsystem attaches its public hooks here so modules
// can call across boundaries without circular imports or giant callback bags.
export const app = {};

/* ---------- conversation & thread tree helpers ---------- */
export function newConv() {
  return {
    id: 'c' + Date.now().toString(36) + rid().slice(0, 4),
    title: 'New conversation',
    created: Date.now(),
    updated: Date.now(),
    threads: { main: { id: 'main', parent: null, title: 'Main thread', colorIdx: -1 } },
    msgs: {},
    order: { main: [] },
    ui: { open: ['main'], collapsed: [], layout: 'cols', view: 'panes', sizes: {} },
    nextColor: 0,
  };
}

export const T = (id) => state.conv.threads[id];
export const color = (t) => (t && t.parent ? PALETTE[t.colorIdx % PALETTE.length] : 'var(--faint)');
export function ancestors(tid) {
  const p = [];
  let t = T(tid);
  while (t) { p.unshift(t.id); t = t.parent ? T(t.parent) : null; }
  return p;
}
export function isDesc(a, b) {
  let t = T(a);
  while (t && t.parent) { if (t.parent === b) return true; t = T(t.parent); }
  return false;
}

export const EMPTY_ARR = Object.freeze([]);
let _tidx = null, _tidxQueued = false;
export function resetThreadIdx() { _tidx = null; }
export function threadIdx() {
  const conv = state.conv;
  if (_tidx && _tidx.conv === conv) return _tidx;
  const byParent = new Map(), byAnchor = new Map(), numOf = new Map();
  const all = Object.values(conv.threads).sort((a, b) => (a.created || 0) - (b.created || 0));
  for (const t of all) {
    if (t.parent != null) {
      let l = byParent.get(t.parent);
      if (!l) { l = []; byParent.set(t.parent, l); }
      l.push(t);
    }
    if (t.anchorMsg != null) {
      let l = byAnchor.get(t.anchorMsg);
      if (!l) { l = []; byAnchor.set(t.anchorMsg, l); }
      l.push(t);
      numOf.set(t.id, l.length);
    }
  }
  _tidx = { conv, byParent, byAnchor, numOf };
  if (!_tidxQueued) {
    _tidxQueued = true;
    queueMicrotask(() => { _tidx = null; _tidxQueued = false; });
  }
  return _tidx;
}
export const children = (tid) => threadIdx().byParent.get(tid) || EMPTY_ARR;
export const branchesOn = (mid) => threadIdx().byAnchor.get(mid) || EMPTY_ARR;
export function hiddenNow(tid) {
  if (state.conv.ui.showHidden) return false;
  let t = T(tid);
  while (t) { if (t.hidden) return true; t = t.parent ? T(t.parent) : null; }
  return false;
}
export const shownOn = (mid) => branchesOn(mid).filter((t) => !t.alt && !hiddenNow(t.id));
export const branchNum = (t) => threadIdx().numOf.get(t.id) || 0;
export const isCollapsed = (tid) => state.conv.ui.collapsed.includes(tid);
