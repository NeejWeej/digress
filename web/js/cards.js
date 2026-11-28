// Flashcards: opt-in per conversation, drafting from branches/takeaways/suggest_card,
// FSRS-4.5 review panel (Review / Inbox / All), Fix…, quote verification/highlighting, and source jumping.
import { fsrsNext, ivlText } from './fsrs.js';
import { esc, trunc, plain } from './text.js';
import { listSources, isWholePage, shotRef, appendText } from './context.js';
import { state, app, $, ic, io, paneEls, settings, T, color, isCollapsed, fullSys, rid } from './state.js';
import { invalidate } from './redraw.js';

const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const quoteWords = (q) => String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const quoteRe = (ws) => new RegExp('(?<![\\p{L}\\p{N}])' + ws.map(reEsc).join('[^\\p{L}\\p{N}]+') + '(?![\\p{L}\\p{N}])', 'u');

export function createCards() {
  const getConv = () => state.conv;
  const getConvList = () => state.convList;
  const getConvListLoaded = () => state.convListLoaded;
  const getDocState = () => state.docState;
  const getSettings = () => settings;
  const getRegions = () => app.REGIONS;
  const setHitSticky = (v) => { state.hitSticky = v; };
  const setHitTimer = (t) => { state.hitTimer = t; };
  const toast = (...a) => app.toast(...a);
  const renderRich = (...a) => app.renderRich(...a);
  const imageBlob = (...a) => app.imageBlob(...a);
  const imageURL = (...a) => app.imageURL(...a);
  const storeImages = (...a) => app.storeImages(...a);
  const openActivity = (...a) => app.openActivity(...a);
  const cvState = (...a) => app.cvState(...a);
  const contentScale = (...a) => app.contentScale(...a);
  const save = (...a) => app.save(...a);
  const catchUp = (...a) => app.catchUp(...a);
  const docReady = (...a) => app.docReady(...a);
  const buildContext = (...a) => app.buildContext(...a);
  const resolveContext = (...a) => app.resolveContext(...a);
  const modelFor = (...a) => app.modelFor(...a);
  const runDocTool = (...a) => app.runDocTool(...a);
  const trashLeft = (...a) => app.trashLeft(...a);
  const openConv = (...a) => app.openConv(...a);
  const restoreConv = (...a) => app.restoreConv(...a);
  const dockCard = (...a) => app.dockCard(...a);
  const openDocPane = (...a) => app.openDocPane(...a);
  const goToPage = (...a) => app.goToPage(...a);
  const focusCard = (...a) => app.focusCard(...a);
  const revealAnchor = (...a) => app.revealAnchor(...a);
  const openThread = (...a) => app.openThread(...a);
  const revealPane = (...a) => app.revealPane(...a);
  const revealMsg = (...a) => app.revealMsg(...a);
  const clearHit = (...a) => app.clearHit(...a);
  const docImgRef = (...a) => app.docImgRef(...a);
  const regionRef = (...a) => app.regionRef(...a);

  const CARDS = new Map();
  let cardsLoaded = null;
  let offlineNoted = false;

  function loadCards() {
    if (!cardsLoaded) {
      cardsLoaded = (async () => {
        await io.ready;
        try { for (const { id, data } of await io.cards.list()) CARDS.set(id, data); } catch (e) { console.warn('cards failed to load', e); }
        syncCardsUI();
        // fetch each card's image once while online, so the service worker has it for offline review
        if (!io.offline && navigator.serviceWorker && navigator.serviceWorker.controller) {
          for (const c of CARDS.values()) if (c.image && c.image.asset) imageBlob(c.image).catch(() => {});
        }
      })();
    }
    return cardsLoaded;
  }

  async function putCard(c) {
    c.updated = Date.now();
    CARDS.set(c.id, c);
    try { await io.cards.put(c.id, c); } catch (e) { toast('Couldn’t save the card.'); }
    syncCardsUI();
  }

  const pendNote = () => {
    const k = io.cards && io.cards.stuck && io.cards.pending ? io.cards.pending() : 0;
    return k ? `${k} change${k > 1 ? 's' : ''} saved on this device, not synced yet` : '';
  };

  function cardsSyncChanged() {
    if (io.cards.stuck && !offlineNoted) {
      offlineNoted = true;
      toast('Saved on this device; it will sync when the server is back.');
    }
    if (!io.cards.stuck) offlineNoted = false;
    const n = $('#cardsModal .kpend');
    if (n) n.textContent = pendNote();
  }

  async function dropCard(id) {
    CARDS.delete(id);
    try { await io.cards.remove(id); } catch (e) { console.warn(e); }
    syncCardsUI();
  }

  const inInbox = (c) => c.status === 'inbox' || !!c.fix;
  const cardsOn = () => { const conv = getConv(); return !!(conv && conv.cards && conv.cards.on); };
  const inScope = (c, scope) => !cardHeld(c) && (scope === 'all' || (c.conv === scope && (!KS.thread || c.thread === KS.thread)));
  const dueCards = (scope) => [...CARDS.values()]
    .filter((c) => c.status === 'active' && !c.fix && (c.due || 0) <= Date.now() && inScope(c, scope))
    .sort((a, b) => (a.due || 0) - (b.due || 0));

  function convInfo(id) {
    const conv = getConv();
    if (conv && conv.id === id) return { id, trashed: conv.trashed || 0, dropCards: !!conv.dropCards, title: conv.title };
    return getConvList().find((c) => c.id === id) || null;
  }

  function cardHeld(c) {
    const m = convInfo(c.conv);
    return !!(m && m.trashed && m.dropCards);
  }

  function cardSource(c) {
    if (io.offline || !getConvListLoaded()) return '';
    const m = convInfo(c.conv);
    if (!m) return 'gone';
    if (m.trashed) return 'trash';
    const conv = getConv();
    if (conv && conv.id === c.conv && c.thread && !T(c.thread)) return 'gone';
    return '';
  }

  function srcLabel(c) {
    return ({ highlight: 'from a highlight', snip: 'from a snip', page: 'from a page', takeaway: 'from a takeaway', made: 'made from a branch', suggested: 'suggested while answering' })[c.src] || '';
  }

  function cardsChoice(cards, what) {
    if (!cards.length) return '';
    const n = cards.length;
    const rows = cards.slice().sort((a, b) => (a.created || 0) - (b.created || 0))
      .map((c) => `<div class="kdrow"><span class="kdf">${esc(trunc((c.front || '').replace(/\s+/g, ' '), 110))}</span><span class="kdw">${c.status === 'inbox' ? 'draft · ' : ''}${esc(c.where || srcLabel(c) || '')}</span></div>`).join('');
    return `<label class="kdchk"><input type="checkbox" id="kdDrop"> Also delete ${what} ${n} flashcard${n > 1 ? 's' : ''}</label><details class="kdlist"><summary>See the ${n === 1 ? 'card' : n + ' cards'}</summary><div class="kdbox">${rows}</div></details>`;
  }

  let draftChain = Promise.resolve(), drafting = 0;
  const draftingT = new Map();
  const dKey = (tid) => { const conv = getConv(); return (conv ? conv.id : '') + ':' + tid; };

  function syncCardsUI() {
    $('#stage').classList.toggle('cardson', cardsOn());
    const k = paneEls.get('main') && paneEls.get('main').querySelector('.kicon');
    if (k) k.classList.toggle('on', cardsOn());
    const due = dueCards('all').length, inbox = [...CARDS.values()].filter(inInbox).length, any = CARDS.size > 0;
    const b = $('#reviewBtn');
    b.style.display = any ? '' : 'none';
    b.innerHTML = ic('cards') + 'Review' + (due ? ` · ${due} due` : '') + (inbox ? ` · ${inbox} in inbox` : '') + (drafting ? '<span class="kdrafting"> · drafting…</span>' : '');
    markCardButtons();
    invalidate('conv-list');
    if ($('#cardsModal').classList.contains('show')) renderCards();
  }

  const lastReply = (tid) => {
    const conv = getConv();
    const ids = (conv.order[tid] || []).filter((id) => {
      const m = conv.msgs[id];
      return m && (m.role === 'assistant' || m.role === 'note') && m.content && !m.pending && !m.error;
    });
    return ids[ids.length - 1] || null;
  };

  function newForCards() {
    if (!cardsOn()) return [];
    const conv = getConv();
    const done = conv.cards.done || {};
    return Object.keys(conv.threads).filter((tid) => { const r = lastReply(tid); return r && done[tid] !== r; });
  }

  function cardsAfterReply(m) {
    if (!cardsOn() || m.error || !m.content) return;
    const conv = getConv(), t = T(m.thread);
    if (m.role === 'note' && T(m.fromThread)) {
      queueDraft(m.fromThread, { takeaway: m.content, note: m.id, noteThread: m.thread, src: 'takeaway', quiet: true });
    } else if (m.role === 'assistant' && t && t.parent && (t.anchorText || t.anchorRegion) && conv.order[t.id].filter((id) => conv.msgs[id].role === 'assistant').length === 1) {
      queueDraft(t.id, { src: t.anchorRegion ? (isWholePage(t.anchorRegion) ? 'page' : 'snip') : (t.anchorImg || t.anchorShot) ? 'snip' : 'highlight', quiet: true });
    }
  }

  function makeCardsFor(tid) {
    if (draftingT.get(dKey(tid))) return;
    if (!lastReply(tid)) { toast('Ask something in this branch first'); return; }
    const conv = getConv();
    const done = conv.cards && conv.cards.done && conv.cards.done[tid];
    if (done === lastReply(tid)) { openCards(conv.id, null, tid); return; }
    queueDraft(tid, { src: 'made', since: done && conv.msgs[done] ? done : null });
  }

  function markCardButtons() {
    const conv = getConv();
    if (!conv) return;
    const done = (conv.cards && conv.cards.done) || {};
    for (const [tid, el] of paneEls) {
      const b = el.querySelector('[data-act=mkcards]');
      if (!b) continue;
      const busy = !!draftingT.get(dKey(tid));
      const n = [...CARDS.values()].filter((c) => c.conv === conv.id && c.thread === tid).length;
      const fresh = lastReply(tid) && done[tid] === lastReply(tid);
      b.classList.toggle('busy', busy);
      b.disabled = busy;
      b.querySelector('.tl').textContent = busy ? 'Drafting…' : n && fresh ? `Cards · ${n}` : 'Cards';
      b.title = busy
        ? 'Drafting flashcards from this branch…'
        : fresh
          ? (n ? `This branch’s ${n} card${n > 1 ? 's' : ''}: review or edit them` : 'No cards came from this branch. Open its cards to draft more')
          : done[tid]
            ? 'Draft flashcards from what’s new in this branch since cards were last made'
            : 'Have the model draft flashcards from this branch into your inbox';
    }
  }

  function makeNewCards() {
    const l = newForCards();
    if (!l.length) { toast('Nothing new since cards were last made.'); return; }
    for (const tid of l) queueDraft(tid, { src: 'made', quiet: true });
    toast(`Drafting cards from ${l.length} thread${l.length > 1 ? 's' : ''}…`);
  }

  function queueDraft(tid, o) {
    const k = dKey(tid);
    drafting++;
    draftingT.set(k, (draftingT.get(k) || 0) + 1);
    syncCardsUI();
    const c0 = getConv();
    draftChain = draftChain
      .then(() => draftCards(c0, tid, o))
      .catch((e) => { console.warn('card drafting failed', e); toast('Couldn’t draft cards: ' + ((e && e.message) || e)); })
      .finally(() => {
        drafting--;
        const n = draftingT.get(k) - 1;
        if (n > 0) draftingT.set(k, n);
        else draftingT.delete(k);
        syncCardsUI();
      });
    return draftChain;
  }

  async function draftCards(c0, tid, o) {
    if (getConv() !== c0) return;
    if (!o.takeaway) {
      const had = c0.cards && c0.cards.done && c0.cards.done[tid];
      await catchUp(true);
      if (getConv() !== c0) return;
      const now = c0.cards && c0.cards.done && c0.cards.done[tid];
      if (now && now !== had && now === lastReply(tid)) {
        if (!o.quiet) toast('Cards for this were already drafted on another device.');
        return;
      }
    }
    const conv = getConv(), t = c0.threads[tid];
    if (conv !== c0 || !t) return;
    const model = modelFor(tid, c0);
    await docReady();
    if (getConv() !== c0 || !c0.threads[tid]) return;
    const ctxObj = buildContext(tid), seen = lastReply(tid);
    const have = [...CARDS.values()].filter((c) => c.conv === c0.id).map((c) => '- ' + c.front.replace(/\s+/g, ' ').slice(0, 160)).slice(-80);
    const ord = c0.order[tid] || [], from = o.since ? ord.indexOf(o.since) : -1;
    const nextQ = from >= 0 ? ord.slice(from + 1).map((id) => c0.msgs[id]).find((m) => m && m.role === 'user') : null;
    const ask = PROMPTS.cardsAsk({
      what: o.takeaway ? 'takeaway' : tid === 'main' ? 'main' : 'branch',
      about: t.anchorText ? trunc(t.regionText || t.anchorText, 120) : '',
      takeaway: o.takeaway,
      snip: !!((t.anchorRegion && !isWholePage(t.anchorRegion)) || t.anchorImg || t.anchorShot),
      max: o.takeaway ? 4 : 3,
      have,
      after: nextQ ? trunc(String(nextQ.text || nextQ.content || '').replace(/\s+/g, ' '), 140) : '',
    });
    const msgs = ctxObj.messages, last = msgs[msgs.length - 1];
    if (last && last.role === 'user') appendText(last, '\n\n' + ask);
    else msgs.push({ role: 'user', content: ask });
    if (!io.llm) await io.ready;
    if (getConv() !== c0 || !c0.threads[tid]) return;
    const rc = await resolveContext(ctxObj, !!io.llm.supportsImages);
    if (getConv() !== c0 || !c0.threads[tid]) return;
    const r = await io.llm.complete({
      system: rc.system,
      messages: rc.messages,
      model,
      effort: 'low',
      web: false,
      tools: ctxObj.tools ? { names: ctxObj.tools, run: (n, i) => n === 'list_sources' ? listSources(ctxObj.sourceLists, i) : runDocTool(n, i, [], c0.id) } : undefined,
    });
    let list = [];
    try {
      const a = r.text.indexOf('['), b = r.text.lastIndexOf(']');
      list = JSON.parse(r.text.slice(a, b + 1));
    } catch (e) { throw new Error('the model’s reply wasn’t a list of cards'); }
    list = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.front === 'string' && typeof x.back === 'string' && x.front.trim()).slice(0, 6);
    for (const x of list) {
      const q = typeof x.quote === 'string' && getConv() === c0 && findQuote(x.quote, o.note ? [o.note] : c0.order[tid] || []);
      x.q = q || null;
    }
    let image = null;
    if (list.length && ((t.anchorRegion && !isWholePage(t.anchorRegion)) || t.anchorImg || t.anchorShot) && o.src !== 'takeaway') {
      try {
        const ref = t.anchorShot ? shotRef(t) : t.anchorImg ? docImgRef(t, c0) : regionRef(t, c0.id);
        const bl = await imageBlob(ref);
        const [im] = await storeImages([{ blob: bl, type: bl.type }]);
        image = im;
      } catch (e) { console.warn('snip not kept with the card', e); }
    }
    const at = o.note ? { thread: o.noteThread, msg: o.note } : { thread: tid, msg: seen };
    const where = tid === 'main' ? 'Main thread' : trunc(t.title || t.anchorText || 'Branch', 70);
    for (const x of list) {
      await putCard({
        id: 'k' + rid() + rid(), conv: c0.id, convTitle: c0.title || '', thread: tid, at, where, src: o.src,
        front: x.front.trim(), back: x.back.trim(), ...(image ? { image } : {}), ...(x.q ? { quote: x.q } : {}),
        status: 'inbox', created: Date.now(), due: null, fsrs: null, reviews: [],
      });
    }
    if (seen && !o.takeaway) {
      c0.cards.done = c0.cards.done || {};
      c0.cards.done[tid] = seen;
      if (getConv() === c0) save();
      else io.store.update(c0.id, { cards: c0.cards }).catch(() => {});
    }
    if (!o.quiet || list.length) {
      if (list.length) {
        toast(`${list.length} card${list.length > 1 ? 's' : ''} drafted into your inbox`, {
          label: 'Open',
          fn: () => { const cur = getConv(); if (cur && cur.id === c0.id) openCards(c0.id, 'inbox', o.src === 'made' ? tid : null); },
        });
      } else toast('Nothing new worth a card there.');
    }
  }

  async function suggestCard(c, m, input) {
    if (!(c && c.cards && c.cards.on)) return { error: 'Flashcards are off in this conversation, so no card was made. Don’t mention it to the learner.' };
    const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    const front = str(input && input.front, 600), back = str(input && input.back, 3000), qt = str(input && input.quote, 600);
    if (!front || !back) return { error: 'A card needs a "front" (the question) and a "back" (the answer).' };
    const norm = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if ([...CARDS.values()].some((k) => k.conv === c.id && norm(k.front) === norm(front))) {
      return { error: 'This conversation already has a card asking that, so it wasn’t added again.' };
    }
    const tid = m.thread, t = c.threads[tid], q = qt && getConv() === c ? findQuote(qt, c.order[tid] || []) : null;
    const where = tid === 'main' ? 'Main thread' : trunc((t && (t.title || t.anchorText)) || 'Branch', 70);
    await putCard({
      id: 'k' + rid() + rid(), conv: c.id, convTitle: c.title || '', thread: tid, at: { thread: tid, msg: m.id }, where,
      src: 'suggested', front, back, ...(q ? { quote: q } : {}), status: 'inbox', created: Date.now(), due: null, fsrs: null, reviews: [],
    });
    return { parts: [{ type: 'text', text: 'Added to the learner’s flashcard inbox.' }] };
  }

  function findQuote(text, mids) {
    const conv = getConv(), docState = getDocState();
    const ws = quoteWords(text);
    if (ws.length < 3) return null;
    const re = quoteRe(ws), q = text.trim().replace(/\s+/g, ' ');
    for (const id of [...mids].reverse()) {
      const m = conv.msgs[id];
      if (m && (m.role === 'assistant' || m.role === 'note') && re.test(String(m.content || '').toLowerCase())) return { text: q, msg: id };
    }
    const P = docState && docState.loaded ? docState.pages : [];
    for (let i = 0; i < P.length; i++) if (re.test((P[i] || '').toLowerCase())) return { text: q, page: i + 1 };
    return null;
  }

  function showQuote(root, scroller, quote, scale, opts = {}) {
    if (!root || !scroller) return false;
    const nodes = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('.acts,button,svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    let text = '', n;
    while ((n = w.nextNode())) { nodes.push([n, text.length]); text += n.data; }
    const low = text.toLowerCase(), ws = quoteWords(quote);
    if (ws.length < (opts.exact ? 2 : 3)) return false;
    let from = -1, to = -1;
    const re = new RegExp(quoteRe(ws).source, 'gu'), matches = [...low.matchAll(re)];
    if (opts.exact) {
      if (!matches.length || (opts.unique && matches.length !== 1)) return false;
      from = matches[0].index; to = from + matches[0][0].length;
    } else if (matches.length) {
      from = matches[0].index; to = from + matches[0][0].length;
    } else {
      const k = Math.min(6, ws.length), a = low.match(quoteRe(ws.slice(0, k))), b = low.match(quoteRe(ws.slice(-k)));
      if (a && b && b.index >= a.index) { from = a.index; to = b.index + b[0].length; } else return false;
    }
    const at = (o) => {
      let lo = 0, hi = nodes.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid][1] <= o) lo = mid; else hi = mid - 1; }
      return [nodes[lo][0], o - nodes[lo][1]];
    };
    const r = document.createRange(), [a, ao] = at(from), [b, bo] = at(to - 1);
    r.setStart(a, ao); r.setEnd(b, bo + 1);
    const rr = r.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    scroller.scrollBy({ top: (rr.top - sr.top - sr.height / 3) / scale, behavior: 'smooth' });
    clearHit();
    try { CSS.highlights.set('digress-hit', new Highlight(r)); } catch (e) {}
    if (opts.sticky) setHitSticky(true);
    else setHitTimer(setTimeout(clearHit, 8000));
    return true;
  }

  const KS = { scope: 'all', thread: null, tab: 'review', shown: false, editing: null, fixing: null, skipped: [], reviewed: 0 };
  const reviewQueue = (scope) => {
    const d = dueCards(scope), sk = KS.skipped;
    return [...d.filter((c) => !sk.includes(c.id)), ...sk.map((id) => d.find((c) => c.id === id)).filter(Boolean)];
  };

  async function openCards(scope, tab, thread) {
    await loadCards();
    const conv = getConv();
    KS.scope = scope === 'conv' || !scope ? (conv ? conv.id : 'all') : scope;
    KS.thread = KS.scope !== 'all' && thread || null;
    KS.reviewed = 0; KS.tally = [0, 0, 0, 0, 0];
    KS.tab = tab || (dueCards(KS.scope).length ? 'review' : [...CARDS.values()].some((c) => inInbox(c) && inScope(c, KS.scope)) ? 'inbox' : KS.thread ? 'all' : 'review');
    KS.shown = false; KS.editing = null; KS.fixing = null; KS.skipped = [];
    hideBackToReview();
    $('#cardsModal').classList.add('show');
    renderCards();
  }

  function closeCards() { $('#cardsModal').classList.remove('show'); }
  const hideBackToReview = () => { const b = $('#backReview'); if (b) b.classList.remove('show'); };

  function renderCards() {
    const conv = getConv();
    const box = $('#cardsModal .kbox'), scope = KS.scope, all = [...CARDS.values()].filter((c) => inScope(c, scope));
    const due = reviewQueue(scope), inbox = all.filter(inInbox), kept = all.filter((c) => c.status !== 'inbox');
    const here = !!conv && scope === conv.id, on = here && cardsOn(), br = here && KS.thread && T(KS.thread);
    const off = here && !cardsOn() && !all.length, paused = here && !cardsOn() && all.length > 0, nNew = on && !br ? newForCards().length : 0;
    box.innerHTML = `<div class="khead"><span class="kt">Flashcards</span>${cardsPicker(scope)}${br ? `<span class="kbranch" style="--c:${color(br)}"><i></i><span></span><button data-kact="allbranches" title="All of this conversation’s cards">${ic('x')}</button></span>` : ''}<span class="sp"></span>${on && !br ? `<button class="mbtn" data-kact="make" ${nNew && !drafting ? '' : 'disabled'} title="Have the model draft cards from the threads that changed since cards were last made">${drafting ? 'Drafting…' : nNew ? `Make cards · ${nNew} new` : 'Up to date'}</button>` : ''}${on && br ? `<button class="mbtn" data-kact="draftmore" ${draftingT.get(dKey(KS.thread)) ? 'disabled' : ''} title="Have the model draft more cards from this branch, besides the ones it has">${draftingT.get(dKey(KS.thread)) ? 'Drafting…' : 'Draft more'}</button>` : ''}<button class="ib" data-kact="close" title="Close (Esc)">${ic('x')}</button></div>
      ${off ? '' : `<div class="ktabs"><button data-ktab="review" class="${KS.tab === 'review' ? 'on' : ''}">Review${due.length ? ` (${due.length})` : ''}</button><button data-ktab="inbox" class="${KS.tab === 'inbox' ? 'on' : ''}">Inbox${inbox.length ? ` (${inbox.length})` : ''}</button><button data-ktab="all" class="${KS.tab === 'all' ? 'on' : ''}">All cards (${kept.length})</button></div>`}
      <div class="kbody"></div>${on ? `<div class="kfoot" style="padding:0 14px 12px"><span class="sp"></span><button data-kact="off" title="Stop drafting cards for this conversation. Cards you have stay.">Turn off for this conversation</button></div>` : paused ? `<div class="kfoot" style="padding:0 14px 12px"><span style="color:var(--faint);font-size:12.5px">New cards are off for this conversation.</span><span class="sp"></span><button data-kact="on" title="Draft cards from this conversation again">Turn back on</button></div>` : ''}`;
    box.querySelector('[data-kscope]').value = scope;
    if (br) box.querySelector('.kbranch>span').textContent = trunc(br.title || br.anchorText || 'Branch', 40);
    const body = box.querySelector('.kbody');
    if (off) {
      body.innerHTML = `<div class="kempty"><b>Flashcards are off for this conversation.</b><br>Turn them on and the model drafts cards from your highlights, snips and takeaways into an inbox, and can suggest one while it answers. You keep the ones you want and review them with spaced repetition. Nothing changes until you do.<br><button class="mbtn primary" data-kact="on">Turn on for this conversation</button></div>`;
      return;
    }
    if (KS.tab === 'review') renderReview(body, due);
    else if (KS.tab === 'inbox') renderInbox(body, inbox);
    else renderAllCards(body, kept);
  }

  function cardsPicker(scope) {
    const conv = getConv(), by = new Map();
    for (const c of CARDS.values()) {
      if (cardHeld(c)) continue;
      const e = by.get(c.conv) || by.set(c.conv, { due: 0, inbox: 0, title: c.convTitle }).get(c.conv);
      if (inInbox(c)) e.inbox++;
      else if (c.status === 'active' && (c.due || 0) <= Date.now()) e.due++;
    }
    if (conv && !by.has(conv.id)) by.set(conv.id, { due: 0, inbox: 0 });
    if (scope !== 'all' && !by.has(scope)) by.set(scope, { due: 0, inbox: 0 });
    const counts = (e) => [e.due ? e.due + ' due' : '', e.inbox ? e.inbox + ' new' : ''].filter(Boolean).join(', ');
    const all = { due: dueCards('all').length, inbox: [...CARDS.values()].filter((c) => inInbox(c) && !cardHeld(c)).length };
    const rows = [...by].map(([id, e]) => { const m = convInfo(id); return [id, e, (m && m.title) || e.title || 'New conversation']; })
      .sort((a, b) => b[1].due - a[1].due || b[1].inbox - a[1].inbox || a[2].localeCompare(b[2]));
    return `<select data-kscope aria-label="Which cards"><option value="all">All conversations${counts(all) ? ' · ' + counts(all) : ''}</option>${rows.map(([id, e, t]) => `<option value="${esc(id)}">${esc(trunc(t, 40))}${counts(e) ? ' · ' + counts(e) : ''}</option>`).join('')}</select>`;
  }

  function cardFace(el, text, image) {
    if (image) {
      const b = document.createElement('button');
      b.className = 'kimg'; b.dataset.zoomref = '1'; b.__ref = image; b.title = 'Show larger';
      const im = document.createElement('img'); im.alt = ''; b.appendChild(im); el.appendChild(b);
      imageURL(image).then((u) => { im.src = u; }).catch(() => b.remove());
    }
    const d = document.createElement('div'); d.className = 'kface'; el.appendChild(d); renderRich(d, text, true);
  }

  function srcLink(c, withConv) {
    const b = document.createElement('button');
    b.className = 'ksrc'; b.dataset.kact = 'open'; b.dataset.kid = c.id;
    b.title = `Open it in its conversation, at the reply it came from (${srcLabel(c)})${KS.tab === 'review' ? '. Key: O' : ''}`;
    b.textContent = '↗ ' + [withConv && c.convTitle ? trunc(c.convTitle, 40) : '', c.where || srcLabel(c)].filter(Boolean).join(' › ');
    return b;
  }

  function srcNote(c) {
    const st = cardSource(c);
    if (!st) return null;
    const d = document.createElement('div'); d.className = 'ksrcnote ' + st;
    if (st === 'trash') {
      const m = convInfo(c.conv), left = trashLeft(m);
      d.innerHTML = `Its conversation is in the trash: deleted for good in ${left} day${left > 1 ? 's' : ''}. <button data-kact="restoreconv" data-kid="${esc(c.id)}">Restore it</button>`;
    } else d.textContent = 'Where this came from was deleted, so it can’t take you back there any more. Keep it, or delete it below.';
    return d;
  }

  const docLabel = (c) => { const conv = getConv(); return conv && conv.id === c.conv && conv.doc && conv.doc.kind !== 'pdf' ? 'Part' : 'p.'; };

  function renderReview(body, due) {
    if (!due.length && KS.reviewed) { body.innerHTML = ''; body.appendChild(reviewDone()); return; }
    if (!due.length) {
      const next = [...CARDS.values()].filter((c) => c.status === 'active' && inScope(c, KS.scope)).sort((a, b) => a.due - b.due)[0];
      const n = [...CARDS.values()].filter((c) => inInbox(c) && inScope(c, KS.scope)).length;
      body.innerHTML = `<div class="kempty">${next ? `Nothing due right now. The next card is due in ${ivlText(next.due - Date.now())}.` : 'No cards to review yet.'}${n ? `<br><button class="mbtn" data-ktab="inbox">${n} card${n > 1 ? 's' : ''} waiting in the inbox</button>` : ''}</div>`;
      return;
    }
    const conv = getConv(), c = due[0], now = Date.now(), t = conv && conv.id === c.conv && T(c.thread);
    if (KS.editing === c.id) { body.innerHTML = ''; body.appendChild(cardEditor(c, false)); body.querySelector('.kef').focus(); return; }
    const pct = Math.round(100 * KS.reviewed / (KS.reviewed + due.length));
    body.innerHTML = `<div class="kcard${KS.shown ? ' shown' : ''}" style="--c:${t ? color(t) : 'var(--faint)'}"><div class="kprog" style="--p:${pct}%" title="${KS.reviewed} reviewed, ${due.length} to go"></div><div class="korigin"><i></i><span></span><span class="kleft">${due.length} to go</span></div><div class="kfront"></div></div><div class="kfoot"><button data-kact="del" data-kid="${c.id}">Delete card</button><span class="kpend">${esc(pendNote())}</span><span class="sp"></span>${due.length > 1 ? `<button data-kact="skip" data-kid="${c.id}" title="Not now: go on to the next card. This one comes back at the end. (S)">Skip</button>` : ''}</div>`;
    body.querySelector('.korigin>span').textContent = [KS.scope === 'all' ? trunc((convInfo(c.conv) || {}).title || c.convTitle || '', 40) : '', c.where || srcLabel(c)].filter(Boolean).join(' · ');
    const sn = srcNote(c); if (sn) body.prepend(sn);
    const card = body.querySelector('.kcard'); cardFace(card.querySelector('.kfront'), c.front, c.image);
    if (!KS.shown) {
      const b = document.createElement('button'); b.className = 'kshow'; b.dataset.kact = 'show'; b.innerHTML = 'Show answer <kbd>Space</kbd>'; card.appendChild(b);
      return;
    }
    const back = document.createElement('div'); back.className = 'kback'; card.appendChild(back); cardFace(back, c.back);
    const src = document.createElement('div'); src.className = 'kfrom';
    if (c.quote) { const q = document.createElement('blockquote'); q.className = 'kquote'; q.textContent = plain(c.quote.text); src.appendChild(q); }
    const go = document.createElement('button'); go.className = 'kopen'; go.dataset.kact = 'open'; go.dataset.kid = c.id; go.title = 'Open it in its conversation (O)';
    go.textContent = (c.quote && c.quote.page ? (docLabel(c) + ' ' + c.quote.page + ' · ') : '') + 'Open in conversation →';
    const acts = document.createElement('div'); acts.className = 'kacts'; acts.appendChild(go);
    acts.insertAdjacentHTML('beforeend', `<span class="sp"></span><button class="klink" data-kact="edit" data-kid="${c.id}" title="Edit this card yourself (E)">Edit</button>${io.offline ? '' : `<button class="klink" data-kact="fix" data-kid="${c.id}" title="Something’s off: have the model check it against the conversation and suggest a fix, which waits in your inbox (F)">Fix…</button>`}`);
    src.appendChild(acts); card.appendChild(src);
    if (KS.fixing === c.id) { card.after(fixForm(c)); return; }
    const rate = document.createElement('div'); rate.className = 'krate';
    rate.innerHTML = [['Again', 1], ['Hard', 2], ['Good', 3], ['Easy', 4]].map(([l, g]) => `<button data-krate="${g}" data-kid="${c.id}" data-g="${g}" title="${l} (${g})">${l}<small>${ivlText(fsrsNext(c.fsrs, g, now).due - now)}</small></button>`).join('');
    card.after(rate);
  }

  function reviewDone() {
    const t = KS.tally || [0, 0, 0, 0, 0], n = KS.reviewed, ok = n - t[1], pct = Math.round(100 * ok / n);
    const next = [...CARDS.values()].filter((c) => c.status === 'active' && !c.fix && inScope(c, KS.scope)).sort((a, b) => a.due - b.due)[0];
    const inbox = [...CARDS.values()].filter((c) => inInbox(c) && inScope(c, KS.scope)).length;
    const d = document.createElement('div'); d.className = 'kdone';
    d.innerHTML = `<div class="kdmark">${ic('check')}</div><div class="kdt">Done for now</div>
      <div class="kdstats"><div><b>${n}</b><span>card${n > 1 ? 's' : ''} reviewed</span></div><div><b>${pct}%</b><span>recalled</span></div>${t[1] ? `<div><b>${t[1]}</b><span>to see again soon</span></div>` : ''}</div>
      <div class="kdbar" title="Again ${t[1]} · Hard ${t[2]} · Good ${t[3]} · Easy ${t[4]}">${[1, 2, 3, 4].filter((g) => t[g]).map((g) => `<i data-g="${g}" style="flex:${t[g]}"></i>`).join('')}</div>
      <div class="kdnext">${next ? `Next card due in ${ivlText(next.due - Date.now())}.` : 'No more cards scheduled.'}</div>
      <div class="kdacts">${inbox ? `<button class="mbtn" data-ktab="inbox">${inbox} in the inbox</button>` : ''}<button class="mbtn" data-kact="activity">See your activity</button><button class="mbtn primary" data-kact="close">Close</button></div>`;
    return d;
  }

  function renderInbox(body, inbox) {
    if (!inbox.length) {
      body.innerHTML = `<div class="kempty">The inbox is empty.${KS.scope !== 'all' ? ' Cards drafted from your highlights, snips and takeaways land here, and so do the ones from “Make cards”.' : ''}</div>`;
      return;
    }
    body.innerHTML = inbox.some((c) => !c.fix) ? `<div class="kbar"><span>Keep the cards worth reviewing; edit them first if you like.</span><span class="sp"></span><button class="mbtn" data-kact="keepall">Keep all</button><button class="mbtn" data-kact="delall">Delete all</button></div>` : '';
    for (const c of inbox.sort((a, b) => (a.fix ? a.fix.at : a.created) - (b.fix ? b.fix.at : b.created))) body.appendChild(c.fix ? fixItem(c) : cardEditor(c, true));
  }

  function cardEditor(c, isInbox) {
    const it = document.createElement('div'); it.className = 'kitem'; it.dataset.kid = c.id;
    if (c.image) cardFace(it, '', c.image);
    it.insertAdjacentHTML('beforeend', `<textarea class="kef" rows="2" aria-label="Front"></textarea><textarea class="keb" rows="3" aria-label="Back"></textarea><div class="kfoot">${isInbox ? `<button class="mbtn primary" data-kact="keep" data-kid="${c.id}">Keep</button>` : `<button class="mbtn primary" data-kact="saveedit" data-kid="${c.id}">Save</button><button data-kact="canceledit">Cancel</button>`}<button data-kact="del" data-kid="${c.id}">Delete</button><span class="sp"></span><span class="kmeta"></span></div>`);
    it.querySelector('.kef').value = c.front; it.querySelector('.keb').value = c.back;
    it.querySelector('.kmeta').replaceWith(srcLink(c, KS.scope === 'all'));
    return it;
  }

  function renderAllCards(body, kept) {
    if (!kept.length) { body.innerHTML = '<div class="kempty">No kept cards yet. Keep some from the inbox.</div>'; return; }
    for (const c of kept.sort((a, b) => (a.due || 0) - (b.due || 0))) {
      if (KS.editing === c.id) { body.appendChild(cardEditor(c, false)); continue; }
      const it = document.createElement('div'); it.className = 'kitem'; it.dataset.kid = c.id;
      it.innerHTML = `<div class="kfr"></div><div class="kbk"></div><div class="kfoot"><span class="kmeta"></span><span class="sp"></span><button data-kact="edit" data-kid="${c.id}">Edit</button><button data-kact="suspend" data-kid="${c.id}">${c.status === 'suspended' ? 'Resume' : 'Suspend'}</button><button data-kact="del" data-kid="${c.id}">Delete</button></div>`;
      it.querySelector('.kfr').textContent = c.front; it.querySelector('.kbk').textContent = c.back;
      it.querySelector('.kmeta').textContent = (c.status === 'suspended' ? 'suspended' : c.due <= Date.now() ? 'due now' : 'due in ' + ivlText(c.due - Date.now())) + ' · ';
      it.querySelector('.kmeta').after(srcLink(c, KS.scope === 'all'));
      body.appendChild(it);
    }
    if (KS.focus) {
      const el = body.querySelector(`.kitem[data-kid="${CSS.escape(KS.focus)}"]`);
      KS.focus = null;
      if (el) { el.classList.add('kfocus'); requestAnimationFrame(() => el.scrollIntoView({ block: 'center' })); }
    }
  }

  const FIX_TAGS = ['Wrong', 'Unclear', 'Too vague', 'Two questions in one', 'Answer too long'];
  function fixForm(c) {
    const f = document.createElement('div'); f.className = 'kfix';
    f.innerHTML = `<div class="kfixt">What’s off? <span>Optional. The model checks it against the conversation; its suggestion waits in your inbox.</span></div><div class="kchips">${FIX_TAGS.map((x) => `<button data-kchip="${esc(x)}">${esc(x)}</button>`).join('')}</div><textarea class="kfixn" rows="2" placeholder="Say why, if you like"></textarea><div class="kfoot"><span class="sp"></span><button data-kact="cancelfix">Cancel</button><button class="mbtn primary" data-kact="sendfix" data-kid="${c.id}">Send <kbd>${/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+'}↵</kbd></button></div>`;
    const d = KS.fixDraft && KS.fixDraft.id === c.id ? KS.fixDraft : (KS.fixDraft = { id: c.id, note: '', tags: [] });
    const t = f.querySelector('textarea'); t.value = d.note; t.oninput = () => { d.note = t.value; };
    f.querySelectorAll('[data-kchip]').forEach((x) => x.classList.toggle('on', d.tags.includes(x.dataset.kchip)));
    setTimeout(() => t.focus({ preventScroll: true }), 0);
    return f;
  }

  const fixJobs = new Set();
  async function sendFix(c, note, tags) {
    KS.fixing = null; KS.fixDraft = null; KS.shown = false;
    c.fix = { state: 'pending', note, tags, at: Date.now() };
    await putCard(c); renderCards();
    toast('Working on a fix. It will wait in your inbox.');
    runFix(c);
  }

  async function runFix(c) {
    fixJobs.add(c.id);
    if (c.fix.state !== 'pending') { c.fix = { ...c.fix, state: 'pending', at: Date.now(), err: '' }; await putCard(c); }
    try {
      const r = await askFix(c), f = CARDS.get(c.id);
      if (!f || !f.fix) return;
      Object.assign(f.fix, r, { state: 'ready' });
      await putCard(f);
      toast(r.verdict === 'right' ? 'The model thinks that card is right; its reasons are in your inbox.' : 'A fix for that card is in your inbox.', {
        label: 'Open',
        fn: () => { const conv = getConv(); openCards(KS.scope === 'all' || !conv ? 'all' : conv.id, 'inbox'); },
      });
    } catch (e) {
      console.warn('card fix failed', e);
      const f = CARDS.get(c.id);
      if (f && f.fix) { f.fix.state = 'failed'; f.fix.err = String((e && e.message) || e).slice(0, 200); await putCard(f); }
      toast('Couldn’t fix the card: ' + ((e && e.message) || e));
    } finally {
      fixJobs.delete(c.id);
      if ($('#cardsModal').classList.contains('show')) renderCards();
    }
  }

  async function askFix(c) {
    if (!io.llm) await io.ready;
    const conv = getConv(), settings = getSettings();
    const ask = PROMPTS.cardFix({ front: c.front, back: c.back, quote: c.quote && c.quote.text, note: c.fix.note, tags: c.fix.tags || [] });
    let req, mine = !!(conv && conv.id === c.conv && T(c.thread)), src = null;
    let model = mine ? modelFor(c.thread, conv) : settings.model;
    if (mine) {
      await docReady();
      if (getConv() !== conv || !conv.threads[c.thread]) {
        mine = false;
      } else {
        const ctxObj = buildContext(c.thread), msgs = ctxObj.messages, last = msgs[msgs.length - 1];
        if (last && last.role === 'user') appendText(last, '\n\n' + ask); else msgs.push({ role: 'user', content: ask });
        const rc = await resolveContext(ctxObj, !!io.llm.supportsImages);
        if (getConv() !== conv || !conv.threads[c.thread]) {
          mine = false;
        } else {
          req = { system: rc.system, messages: rc.messages, tools: ctxObj.tools ? { names: ctxObj.tools, run: (n, i) => n === 'list_sources' ? listSources(ctxObj.sourceLists, i) : runDocTool(n, i, [], conv.id) } : undefined };
        }
      }
    }
    if (!mine) {
      src = await io.store.get(c.conv).catch(() => null);
      model = src ? modelFor(c.thread, src) : settings.model;
      const lines = [];
      if (src && src.threads && src.threads[c.thread]) {
        ThreadOps.walk(src, c.thread, (m) => {
          const x = String(m.content || m.text || '').trim();
          if (x) lines.push((m.role === 'user' ? 'Learner: ' : m.role === 'note' ? 'Takeaway: ' : 'Tutor: ') + x);
        });
      }
      const text = lines.join('\n\n').slice(-60000);
      req = { system: fullSys(src), messages: [{ role: 'user', content: (text ? PROMPTS.cardFixSource(text) + '\n\n' : '') + ask }] };
    }
    const r = await io.llm.complete({ ...req, model, effort: 'low', web: false });
    let o;
    try { const a = r.text.indexOf('{'), b = r.text.lastIndexOf('}'); o = JSON.parse(r.text.slice(a, b + 1)); } catch (e) { throw new Error('the model’s reply wasn’t a fix'); }
    const verdict = ['rewrite', 'split', 'delete', 'right'].includes(o && o.verdict) ? o.verdict : null;
    if (!verdict) throw new Error('the model’s reply wasn’t a fix');
    let cards = (Array.isArray(o.cards) ? o.cards : []).filter((x) => x && typeof x.front === 'string' && typeof x.back === 'string' && x.front.trim()).slice(0, verdict === 'split' ? 2 : 1);
    if ((verdict === 'rewrite' || verdict === 'split') && !cards.length) throw new Error('the model’s fix had no card in it');
    cards = cards.map((x) => {
      const q = mine && getConv() === conv && typeof x.quote === 'string' ? findQuote(x.quote, conv.order[c.thread] || []) : null;
      return { front: x.front.trim(), back: x.back.trim(), ...(q ? { quote: q } : {}) };
    });
    return { verdict, why: typeof o.why === 'string' ? o.why.trim().slice(0, 600) : '', change: o.change === 'answer' ? 'answer' : 'wording', cards };
  }

  function fixItem(c) {
    const f = c.fix, it = document.createElement('div'); it.className = 'kitem kfixit'; it.dataset.kid = c.id;
    const stale = f.state === 'pending' && !fixJobs.has(c.id) && Date.now() - (f.at || 0) > 3 * 60e3, state = stale ? 'failed' : f.state;
    const said = [(f.tags || []).join(', '), f.note].filter(Boolean).join('. ');
    it.innerHTML = `<div class="kfixh"><b>Fix</b><span class="kfixs"></span><span class="sp"></span><span class="kmeta"></span></div><div class="kwas"><div class="kfr"></div><div class="kbk"></div></div><div class="kfixb"></div><div class="kfoot"></div>`;
    it.querySelector('.kfixs').textContent = said ? '· you said: ' + said : '';
    it.querySelector('.kfr').textContent = c.front; it.querySelector('.kbk').textContent = c.back;
    it.querySelector('.kmeta').replaceWith(srcLink(c, KS.scope === 'all'));
    const b = it.querySelector('.kfixb'), foot = it.querySelector('.kfoot');
    if (state === 'pending') {
      b.innerHTML = '<div class="kwhy busy">Checking it against the conversation…</div>';
      foot.innerHTML = `<span class="sp"></span><button data-kact="dropfix" data-kid="${c.id}" title="Never mind: the card goes back into review as it is">Cancel</button>`;
      return it;
    }
    if (state === 'failed') {
      b.innerHTML = `<div class="kwhy">${stale ? 'This fix didn’t finish (the page was closed while it ran).' : 'Couldn’t fix it: ' + esc(f.err || '')}</div>`;
      foot.innerHTML = `<span class="sp"></span><button data-kact="dropfix" data-kid="${c.id}">Never mind</button><button class="mbtn primary" data-kact="retryfix" data-kid="${c.id}">Try again</button>`;
      return it;
    }
    const why = document.createElement('div'); why.className = 'kwhy';
    why.textContent = ({ right: 'Looks right as it is. ', delete: 'Suggests deleting it. ', split: 'Suggests two cards. ', rewrite: '' })[f.verdict] + (f.why || '');
    b.appendChild(why);
    const after = f.verdict === 'right' ? [{ front: c.front, back: c.back }] : f.verdict === 'delete' ? [] : f.cards;
    for (const x of after) {
      const p = document.createElement('div'); p.className = 'kpair';
      p.innerHTML = '<textarea class="kef" rows="2" aria-label="Front"></textarea><textarea class="keb" rows="3" aria-label="Back"></textarea>';
      p.querySelector('.kef').value = x.front; p.querySelector('.keb').value = x.back;
      b.appendChild(p);
    }
    if (f.verdict === 'rewrite' || f.verdict === 'split') {
      const n = document.createElement('div'); n.className = 'kchg';
      n.textContent = f.change === 'answer' ? 'The answer changed, so it starts over as a new card.' : 'Same fact, better wording: it keeps its schedule.';
      b.appendChild(n);
    }
    foot.innerHTML = f.verdict === 'delete'
      ? `<button data-kact="dropfix" data-kid="${c.id}">Keep the card</button><span class="sp"></span><button class="mbtn primary" data-kact="del" data-kid="${c.id}">Delete it</button>`
      : f.verdict === 'right'
        ? `<button data-kact="del" data-kid="${c.id}">Delete card</button><span class="sp"></span><button class="mbtn primary" data-kact="acceptfix" data-kid="${c.id}">Keep it</button>`
        : `<button data-kact="del" data-kid="${c.id}">Delete card</button><span class="sp"></span><button data-kact="dropfix" data-kid="${c.id}" title="Ignore the suggestion: the card goes back into review as it was">Keep original</button><button class="mbtn primary" data-kact="acceptfix" data-kid="${c.id}">Accept${f.verdict === 'split' ? ' both' : ''}</button>`;
    return it;
  }

  async function acceptFix(c, it) {
    const f = c.fix, pairs = [...it.querySelectorAll('.kpair')].map((p) => ({ front: p.querySelector('.kef').value.trim(), back: p.querySelector('.keb').value.trim() }));
    if (pairs.some((p) => !p.front)) { toast('A card needs a front.'); return; }
    const reset = f.verdict !== 'right' && f.change === 'answer', [one, two] = pairs, q = (i) => f.cards && f.cards[i] && f.cards[i].quote;
    delete c.fix; Object.assign(c, one);
    if (f.verdict !== 'right' && q(0)) c.quote = q(0);
    if (reset) { c.fsrs = null; c.due = Date.now(); }
    await putCard(c);
    if (two) {
      const n = { ...c, id: 'k' + rid() + rid(), front: two.front, back: two.back, status: 'active', created: Date.now(), due: Date.now(), fsrs: null, reviews: [] };
      delete n.quote;
      if (q(1)) n.quote = q(1);
      await putCard(n);
    }
  }

  function skipCard(id) { KS.skipped = [...KS.skipped.filter((x) => x !== id), id]; KS.shown = false; renderCards(); }

  async function rateCard(id, g) {
    const c = CARDS.get(id); if (!c) return;
    const now = Date.now(), n = fsrsNext(c.fsrs, g, now);
    c.fsrs = n.fsrs; c.due = n.due; (c.reviews = c.reviews || []).push({ at: now, g });
    KS.shown = false; KS.reviewed++; (KS.tally = KS.tally || [0, 0, 0, 0, 0])[g]++;
    await putCard(c);
  }

  async function openCardSource(c) {
    if (io.offline) { toast('The conversation opens once you’re back online.'); return; }
    let conv = getConv();
    if (!conv || conv.id !== c.conv) {
      if (!getConvList().some((x) => x.id === c.conv)) { toast('That conversation was deleted.'); return; }
      closeCards(); await openConv(c.conv); conv = getConv();
    }
    if (!T(c.thread)) { toast('That branch was deleted.'); return; }
    closeCards(); showBackToReview();
    const q = c.quote, qm = q && q.msg && conv.msgs[q.msg];
    if (q && q.page && conv.doc) {
      if (conv.ui.view === 'canvas' && !(cvState().dock || {}).doc) dockCard('doc', getRegions().fill);
      else if (conv.ui.view !== 'canvas') openDocPane();
      await goToPage(q.page);
      setTimeout(() => {
        const el = paneEls.get('doc'), docState = getDocState();
        if (!el) return;
        const pdf = docState.kind === 'pdf';
        showQuote(pdf ? el.querySelector(`.dpage[data-page="${q.page}"]`) : el.querySelector('.pb'), el.querySelector('.pb'), q.text, 1);
      }, 450);
      return;
    }
    const at = qm && T(qm.thread) ? { thread: qm.thread, msg: q.msg } : c.at && T(c.at.thread) && conv.msgs[c.at.msg] ? c.at : { thread: c.thread, msg: lastReply(c.thread) };
    if (conv.ui.view === 'canvas') {
      focusCard(at.thread, at.msg);
      if (qm) {
        setTimeout(() => {
          const n = $('#cv').querySelector(`.cnode[data-ctid="${at.thread}"]`);
          if (!n) return;
          showQuote(n.querySelector(`.cfull .msg[data-mid="${at.msg}"] .body`), n.querySelector('.cfull'), q.text, contentScale(n));
        }, 350);
      }
      return;
    }
    const t = T(c.thread);
    if (t.parent && !qm) revealAnchor(c.thread);
    if (at.thread !== 'main' && !conv.ui.open.includes(at.thread)) openThread(at.thread, T(at.thread).parent);
    if (isCollapsed(at.thread)) { conv.ui.collapsed = conv.ui.collapsed.filter((x) => x !== at.thread); invalidate('panes'); }
    revealPane(at.thread);
    if (qm) {
      requestAnimationFrame(() => {
        const pe = paneEls.get(at.thread), b = pe && pe.querySelector(`.msg[data-mid="${at.msg}"] .body`);
        if (!showQuote(b, pe && pe.querySelector('.pb'), q.text, 1)) revealMsg(at.thread, at.msg);
      });
    } else if (at.msg) revealMsg(at.thread, at.msg);
  }

  function showBackToReview() {
    let b = $('#backReview');
    if (!b) {
      b = document.createElement('div'); b.id = 'backReview';
      b.innerHTML = `<button class="br-go" title="Back to the card you were on (Esc on the card closes it)">← Back to review</button><button class="br-x" title="Dismiss">${ic('x')}</button>`;
      document.body.appendChild(b);
      b.querySelector('.br-go').onclick = () => { b.classList.remove('show'); $('#cardsModal').classList.add('show'); renderCards(); };
      b.querySelector('.br-x').onclick = () => b.classList.remove('show');
    }
    b.classList.add('show');
  }

  $('#cardsModal').addEventListener('click', async (e) => {
    if (e.target.id === 'cardsModal') { closeCards(); return; }
    const tab = e.target.closest('[data-ktab]');
    if (tab) { KS.tab = tab.dataset.ktab; KS.shown = false; KS.editing = null; renderCards(); return; }
    const ch = e.target.closest('[data-kchip]');
    if (ch) { ch.classList.toggle('on'); if (KS.fixDraft) KS.fixDraft.tags = [...ch.parentNode.querySelectorAll('.on')].map((x) => x.dataset.kchip); return; }
    const r = e.target.closest('[data-krate]');
    if (r) { await rateCard(r.dataset.kid, +r.dataset.krate); return; }
    const b = e.target.closest('[data-kact]');
    if (!b) return;
    const conv = getConv(), a = b.dataset.kact, c = b.dataset.kid && CARDS.get(b.dataset.kid), it = b.closest('.kitem');
    const edited = () => ({ front: it.querySelector('.kef').value.trim(), back: it.querySelector('.keb').value.trim() });
    if (a === 'close') closeCards();
    else if (a === 'activity') { closeCards(); openActivity(); }
    else if (a === 'on') { conv.cards = { ...(conv.cards || {}), on: true, done: (conv.cards && conv.cards.done) || {} }; save(); syncCardsUI(); renderCards(); const n = newForCards().length; if (n) toast(`Turned on. “Make cards” can draft cards from the ${n} thread${n > 1 ? 's' : ''} already here.`); }
    else if (a === 'off') { conv.cards.on = false; save(); syncCardsUI(); renderCards(); }
    else if (a === 'make') makeNewCards();
    else if (a === 'draftmore' && KS.thread) { queueDraft(KS.thread, { src: 'made' }); renderCards(); }
    else if (a === 'allbranches') { KS.thread = null; KS.shown = false; renderCards(); }
    else if (a === 'show') { KS.shown = true; renderCards(); }
    else if (a === 'skip' && c) skipCard(c.id);
    else if (a === 'open' && c) openCardSource(c);
    else if (a === 'del' && c) await dropCard(c.id);
    else if (a === 'keep' && c) { const x = edited(); if (!x.front) { toast('A card needs a front.'); return; } Object.assign(c, x, { status: 'active', due: Date.now() }); await putCard(c); }
    else if (a === 'keepall') { for (const k of [...CARDS.values()].filter((k) => k.status === 'inbox' && !k.fix && inScope(k, KS.scope))) { const el = $('#cardsModal').querySelector(`.kitem[data-kid="${k.id}"]`); if (el) { k.front = el.querySelector('.kef').value.trim() || k.front; k.back = el.querySelector('.keb').value.trim(); } k.status = 'active'; k.due = Date.now(); await putCard(k); } }
    else if (a === 'restoreconv') { if (c) { await restoreConv(c.conv); renderCards(); } }
    else if (a === 'delall') { for (const k of [...CARDS.values()].filter((k) => k.status === 'inbox' && !k.fix && inScope(k, KS.scope))) await dropCard(k.id); }
    else if (a === 'edit' && c) { KS.editing = c.id; KS.fixing = null; renderCards(); }
    else if (a === 'canceledit') { KS.editing = null; renderCards(); }
    else if (a === 'fix' && c) { KS.fixing = c.id; KS.editing = null; renderCards(); }
    else if (a === 'cancelfix') { KS.fixing = null; renderCards(); }
    else if (a === 'sendfix' && c) { const f = b.closest('.kfix'); sendFix(c, f.querySelector('.kfixn').value.trim(), [...f.querySelectorAll('[data-kchip].on')].map((x) => x.dataset.kchip)); }
    else if (a === 'retryfix' && c) { runFix(c); renderCards(); }
    else if (a === 'dropfix' && c) { delete c.fix; await putCard(c); }
    else if (a === 'acceptfix' && c && c.fix) await acceptFix(c, it);
    else if (a === 'saveedit' && c) { const x = edited(); if (!x.front) { toast('A card needs a front.'); return; } KS.editing = null; Object.assign(c, x); await putCard(c); }
    else if (a === 'suspend' && c) { c.status = c.status === 'suspended' ? 'active' : 'suspended'; await putCard(c); }
  });

  $('#cardsModal').addEventListener('change', (e) => {
    if (e.target.matches('[data-kscope]')) {
      KS.scope = e.target.value; KS.thread = null; KS.shown = false; KS.editing = null; KS.reviewed = 0; KS.tally = [0, 0, 0, 0, 0];
      renderCards();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!$('#cardsModal').classList.contains('show')) return;
    if (e.key === 'Escape') { e.preventDefault(); if (KS.fixing || (KS.editing && KS.tab === 'review')) { KS.fixing = KS.editing = null; renderCards(); } else closeCards(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.closest('.kfix')) { e.preventDefault(); e.target.closest('.kfix').querySelector('[data-kact=sendfix]').click(); return; }
    if (e.target.closest('textarea,input,select') || KS.tab !== 'review' || KS.fixing || KS.editing) return;
    const due = reviewQueue(KS.scope);
    if (!due.length) return;
    if (!KS.shown && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); KS.shown = true; renderCards(); }
    else if ((e.key === 's' || e.key === 'S') && due.length > 1) { e.preventDefault(); skipCard(due[0].id); }
    else if (KS.shown && /^[1-4]$/.test(e.key)) { e.preventDefault(); rateCard(due[0].id, +e.key); }
    else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); openCardSource(due[0]); }
    else if (KS.shown && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); KS.editing = due[0].id; renderCards(); }
    else if (KS.shown && (e.key === 'f' || e.key === 'F') && !io.offline) { e.preventDefault(); KS.fixing = due[0].id; renderCards(); }
  });

  $('#reviewBtn').addEventListener('click', () => openCards('all'));

  return {
    CARDS, KS, loadCards, putCard, dropCard, cardsSyncChanged, syncCardsUI, cardsOn, dueCards,
    inInbox, cardHeld, convInfo, cardsChoice, cardsAfterReply, makeCardsFor, suggestCard,
    openCards, closeCards, hideBackToReview, showQuote, findQuote, renderCards, markCardButtons,
  };
}
