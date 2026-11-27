import { esc, trunc, plain } from './text.js';
import { textWalker, charPos } from './anchors.js';
import { isDocBranch, isWholePage, cropRef } from './context.js';
import { parseShareHash } from './share.js';
import {
  memoryStore, noLlm, noFiles, findServer, okOrThrow, offlineCards, serverStore,
  otherScreen, DEVICE, layoutKey, serverLayout, WINDOWS, toldWindows,
  serverFiles, runId, serverLlm,
} from './connectors.js';
import {
  state, app, io, settings, saveSettings, CUSTOM, quickList,
  MODELS, EFFORTS, modelLabel, PALETTE, ic, $, rid, qid,
  msgCache, cvMsgCache, paneEls, gutEls, streaming, unread,
  newConv, T, color, isDesc, resetThreadIdx, shownOn, branchNum,
} from './state.js';
import { createRenderer } from './render.js';
import { createCards } from './cards.js';
import { regionRef, imageBlob, imageURL, storeImages, lightbox, setSnip, regionText, initMediaListeners } from './media.js';
import { createDoc } from './doc.js';
import { createPanes } from './panes.js';
import { createCanvas } from './canvas.js';
import { createGeneration } from './generation.js';
import { createSearch } from './search.js';
import { createSidebar } from './sidebar.js';
import { createModals } from './modals.js';

/* ---------- state bindings (live bridge into state.js S while app.js is being split) ---------- */
let conv = null, convList = [];
let mathReady = false;
let popState = null;
Object.defineProperties(state, {
  conv: { get: () => conv, set: (v) => { conv = v; }, enumerable: true, configurable: true },
  convList: { get: () => convList, set: (v) => { convList = v; }, enumerable: true, configurable: true },
  mathReady: { get: () => mathReady, set: (v) => { mathReady = v; }, enumerable: true, configurable: true },
  popState: { get: () => popState, set: (v) => { popState = v; }, enumerable: true, configurable: true },
  dirty: { get: () => dirty, set: (v) => { dirty = v; }, enumerable: true, configurable: true },
  cvTook: { get: () => cvTook, set: (v) => { cvTook = v; }, enumerable: true, configurable: true },
  modalOk: { get: () => modalOk, set: (v) => { modalOk = v; }, enumerable: true, configurable: true },
});
window.__digressBusy = () => streaming.size > 0; // read by the server's dev live-reload, so it never reloads mid-reply
window.__digress = { get conv() { return conv; }, get sync() { return sync; }, deleteConv: (id) => deleteConv(id), refresh: () => refreshAll(), get convList() { return convList; }, get keys() { return KEYS; }, get custom() { return CUSTOM; }, skillLink: (u) => skillLink(u), putSkill: (t, o) => putSkill(t, o), get cards() { return CARDS; }, runDocTool: (n, i, t) => runDocTool(n, i, t), set docState(v) { DOC_MOD.docState = v; }, linkPages: (r, o) => linkPages(r, o), renderRich: (el, md, f, o) => renderRich(el, md, f, o), plain, convMarkdown: (c) => convMarkdown(c), ingestClip: (p) => ingestClip(p) };   // for tests and the console

/* ---------- connectors: the only code that knows where the app is running ----------
   io.llm    complete({system, messages, model, effort, web, signal, onText, onSearch})
               -> {text, model, truncated, searches:[query], sources:[{title, url}]}
               web: may search the web for this reply (only pass true when supportsWeb). onSearch({searches, sources}) reports progress.
             ready() -> bool, why (reason it's unavailable), models() -> [[id, label]], supportsEffort, supportsWeb
   io.store  conversations: list() -> [{id, data}], get(id), put(id, data), update(id, patch), remove(id)
   io.index  search index entries, same shape as io.store
   io.files  upload(blob, type) -> {id}, fetch(id, 'text'|'arrayBuffer'), remove(id), canUpload
   They come from the Digress server (server/server.mjs); nothing else in the app should call the server directly. */
async function initConnectors(){
  const srv=await findServer();
  if(srv){
    io.llm=serverLlm(srv);io.store=toldWindows(serverStore('convs','Saved'));io.layout=serverLayout();
    io.index=srv.search?Object.assign(serverStore('index'),{
      search:async(q,o={})=>{
        const p=new URLSearchParams({q});
        if(o.scope&&o.scope!=='all')p.set('scope',o.scope);
        if(o.cid)p.set('cid',o.cid);
        if(o.tid)p.set('tid',o.tid);
        if(o.limit)p.set('limit',String(o.limit));
        const j=await (await okOrThrow(await fetch('api/search?'+p))).json();
        return Array.isArray(j.results)?j.results:[];
      },
    }):serverStore('index');
    io.cards=offlineCards(serverStore('cards','',{timeout:8000}));io.cards.onchange=cardsSyncChanged;io.files=serverFiles();
    io.skills=serverStore('skills');io.prompts=serverStore('prompts');
    await Promise.all([io.llm.loadModels(),loadCustom()]);
    if(!srv.llm)showBanner(true,io.llm.why);
    return;
  }
  if(/^https?:$/.test(location.protocol))offlineMode();else noServer();
}
// served over http(s) but the server can't be reached: flashcards only, from this browser's copy
const OFFLINE='You’re offline: the Digress server can’t be reached. Your flashcards still work (Review, in the sidebar); changes are sent once it’s back.';
function offlineMode(){
  io.offline=true;io.llm=noLlm(OFFLINE);io.store=memoryStore();io.index=memoryStore();io.cards=offlineCards(serverStore('cards','',{timeout:8000}));io.cards.onchange=cardsSyncChanged;io.files=serverFiles();
  showBanner(true,OFFLINE);
  const tryBack=async()=>{if(!await findServer())return;clearInterval(t);await io.cards.flush();const b=$('#banner');b.textContent='Back online. Click here to reload and chat again.';b.style.cursor='pointer';b.onclick=()=>location.reload()};
  const t=setInterval(tryBack,15000);addEventListener('online',tryBack);
}
// opened without its server (e.g. the HTML file on its own): nothing is saved and there's no model
function noServer(){io.llm=noLlm(NO_SERVER);io.store=io.store||memoryStore();io.index=io.index||memoryStore();io.cards=io.cards||memoryStore();io.files=noFiles;showBanner(true,NO_SERVER)}
const NO_SERVER='Digress needs its server: run `npm start` in the digress folder and open the address it prints.';

/* ---------- images (web/js/media.js) ---------- */
initMediaListeners();

/* ---------- flashcards (web/js/cards.js) ---------- */
const {
  CARDS, KS, loadCards, putCard, dropCard, cardsSyncChanged, syncCardsUI, cardsOn,
  inInbox, convInfo, cardsChoice, cardsAfterReply, makeCardsFor, suggestCard,
  openCards, closeCards, showQuote, renderCards, markCardButtons,
} = createCards();

/* ---------- modals & panels (web/js/modals.js) ---------- */
const {
  openActivity, closeActivity, loadCustom, putSkill, skillLink, ownSys,
  syncSkillT, setConvSystem, closeSkillMenu, closePrompts, savePrompts,
  isDigressFile, convMarkdown, openExport, importDigress, importShareHash,
  connModal, closeConnections, syncPick, menuFor, modelsOpen, closeModels, openModelMenu,
} = createModals();

/* ---------- generation & branching (web/js/generation.js) ---------- */
const {
  buildContext, resolveContext, send, MODEL_FAM, titleModel, stopReply, resumeRuns,
  continueReply, retry, redoBlock, retryBlock, REDO_WHY, questionOf, redoKeep, editKeep,
  versionsOf, openVersions, useVersion, redo, startMainOver, movedOn, joinable,
  versionAfter, versionWhere, replyMenuItems, openReplyMenu, closeReplyMenu, newFromDoc,
  startEdit, takeawayCuts, tkcutEl, goToTakeaway, goToTakeawaySource, bringBack,
  crossPageText, createBranch, deleteBranch, openThread, closeThread, markReplies,
  toggleCollapse, isFocused, toggleFocus, revealPane, revealAnchor, revealMsg,
} = createGeneration();

/* ---------- markdown / math / mermaid (web/js/render.js) ---------- */
const {
  renderRich, renderMermaid, mermaidTheme, mermaidSrc, isMermaidOk, mmAct,
} = createRenderer();

/* anchors: wrap the highlighted text and add a numbered footnote marker after it */
function applyAnchors(root,m){
  for(const t of shownOn(m.id))if(t.anchorText)wrapText(root,t.anchorText,t);
}
// Anchor offset measurement (textWalker, nonWs, flatLen, charPos) lives in ./anchors.js.
function wrapText(root,needle,t,opts){
  const w=textWalker(root);
  let flat='',map=[],n;
  while((n=w.nextNode())){const s=n.nodeValue;for(let i=0;i<s.length;i++){if(/\s/.test(s[i]))continue;flat+=s[i];map.push([n,i])}}
  let idx=-1,len=0;
  const ar=t.anchorRange;
  if(ar&&ar.e>ar.s&&ar.e<=flat.length){idx=ar.s;len=ar.e-ar.s}
  else{
    const nd=(needle||'').replace(/\s+/g,'');if(!nd)return;
    idx=flat.indexOf(nd);len=nd.length;
    if(idx<0){
      // Older branches only stored the passage's text, and some browsers include equation
      // symbols in it that aren't part of the visible text. Match the passage by its start
      // and end instead, allowing anything (e.g. math) in between.
      const lo=flat.toLowerCase(),ln=nd.toLowerCase();let st=-1,en=-1;
      for(let L=Math.min(40,ln.length);L>=6&&st<0;L--){const k=lo.indexOf(ln.slice(0,L));if(k>=0)st=k}
      if(st>=0)for(let L=Math.min(40,ln.length);L>=6&&en<0;L--){const k=lo.indexOf(ln.slice(-L),st);if(k>=0)en=k+L}
      if(st>=0&&en>st&&(en-st)<=ln.length*1.5+20){idx=st;len=en-st}
    }
  }
  const c=color(t);
  const marker=()=>{const s=document.createElement('sup');s.className='fn'+(t.resolved?' res':'');s.dataset.tid=t.id;s.style.setProperty('--c',c);s.textContent=branchNum(t);s.title=`Open branch ${branchNum(t)}: ${t.title||''}`;return s};
  if(idx<0){
    // passage couldn't be located: put the marker at the end of the reply
    if(opts&&opts.noMarker)return null;
    const last=root.lastElementChild||root;last.appendChild(marker());return null;
  }
  const segs=new Map();
  for(let k=idx;k<idx+len;k++){const [node,off]=map[k];const s=segs.get(node);if(s){s.to=off+1}else segs.set(node,{from:off,to:off+1})}
  let first=true,lastSpan=null,firstSpan=null;
  for(const [node,{from,to}] of segs){
    if(!node.nodeValue.slice(from,to).trim())continue;
    const r=document.createRange();r.setStart(node,from);r.setEnd(node,to);
    const sp=document.createElement('span');sp.className='anchor'+(t.resolved?' res':'');sp.dataset.tid=t.id;sp.style.setProperty('--c',c);
    sp.title='Open branch: '+(t.title||'');if(first){sp.dataset.first='1';first=false}
    try{r.surroundContents(sp);lastSpan=sp;if(!firstSpan)firstSpan=sp}catch(e){}
  }
  if(lastSpan&&!(opts&&opts.noMarker))lastSpan.after(marker());
  return firstSpan;
}

/* ---------- panes (web/js/panes.js) ---------- */
const PANES_MOD = createPanes();
const {
  msgKey, openUsage, closeUsage, buildFoot, branchChips, streamInto,
  webSources, queueStream, updateJump, rememberSpot, autosize, submit,
  updateComposer, fitOrigin, originRO, updateHeader, altLine, sysScope,
  paneZoom, applyPaneZoom, editZoom, setPaneZoom, stepPaneZoom,
  renderPane, refreshAnchorsFor, docInDock, placeDocPane, layout,
  wiresSoon, wires,
} = PANES_MOD;

/* ---------- canvas view (web/js/canvas.js) ---------- */
const CANVAS_MOD = createCanvas();
const {
  cam, CW, kidsOf, cvState, descendants, applyCam, replyAct, statusDot,
  renderCanvas, drawEdgesSoon, fitCanvas, focusCard,
  clearHere, curPane, markCur, keyClose, contentScale, REGIONS,
  placeDocked, dockCard, restoreCard, canvasRevealSource, canvasAction,
  syncViewsUI, closeViews, setView, tabName, syncViewSeg,
} = CANVAS_MOD;

/* ---------- open / resolved status ---------- */
function toggleResolved(tid){
  const t=T(tid);if(!t||!t.parent)return;
  t.resolved=!t.resolved;if(!t.resolved)delete t.resolved;
  if(conv.msgs[t.anchorMsg])conv.msgs[t.anchorMsg].ver++;
  renderPane(t.parent);updateHeader(tid);renderMap();if(isDocBranch(t))refreshDocAnchors(t.anchorPage);updateHeader('doc');
  if(conv.ui.view==='canvas')renderCanvas();
  setStatus(t.resolved?'Marked resolved':'Marked open');save();
}

/* ---------- document mode (web/js/doc.js) ---------- */
const DOC_MOD = createDoc();
const {
  DOC_STARTERS, docView, docViewReady, docBlobCache, cacheDocBlob, destroyDoc, docPagesLabel, docBranches,
  loadScript, docThumbUrl, startDoc, docReady, docPaneEl, updateDocHeader, renderDocPane,
  buildPdfPages, refreshDocAnchors, openDocPane, scrollDocToPage, READ_LINE, noteDocSpot,
  docSpotNow, putDocSpot, placeMark, markButton, goToPage, goToDocPart, goToEarlier,
  revealDocAnchor, linkPages, runDocTool, trailText,
  docReads, storeDocFile, openDocModal, closeDocModal, docImgRef, docImgAlt, shotDocRegion,
  docBoxText, docImageRec, ingestClip,
} = DOC_MOD;

/* ---------- search (web/js/search.js) ---------- */
const {
  IDX, idxTouch, idxWrite, idxDelete, openPalette, closePalette, STOP,
  clearHit, BACK, markBack, renderBack, goBack,
} = createSearch();

/* ---------- keyboard shortcuts: one list, shown in a small panel in a corner ----------
   The panel has no backdrop and doesn't take focus, so the keys still work with it open (the row of a key you
   press lights up). ? toggles it (not while typing), Esc or ✕ closes it; ⇆ moves it to the other corner. On a
   phone it's a sheet at the bottom. Keys: Mod is ⌘ on a Mac, else Ctrl; `m` are KeyboardEvent codes it lights up
   for. README.md's table must list each of them (tests/test_keys_panel.py). */
const IS_MAC=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);
const IS_IPAD=/iPad/.test(navigator.userAgent)||(/Mac/.test(navigator.platform||'')&&navigator.maxTouchPoints>1);   // iPadOS says it's a Mac
const KEYS=[
  ['Anywhere',[
    [['Mod+K'],'Search',['Mod+KeyK']],
    [['Mod+B'],'Show or hide the sidebar',['Mod+KeyB']],
    [[IS_IPAD?'Ctrl+.':'Mod+.'],'Zen: just the panes'+(IS_IPAD?' (on an iPad, ⌘. is taken by iPadOS)':''),['Mod+Period']],
    [["Mod+'"],'Canvas, or back to the panes',['Mod+Quote']],
    [["Mod+Shift+'"],'Switch Columns and Rows',['Mod+Shift+Quote']],
    [['Mod+\\'],'Collapse the pane you’re in, or expand it again',['Mod+Backslash']],
    [['Mod+Shift+\\'],'Close the pane you’re in (the toast can undo it)',['Mod+Shift+Backslash']],
    [['?'],'Show or hide this list',['Shift+Slash']],
  ]],
  ['Asking',[
    [['Enter'],'Send',['Enter']],
    [['Shift+Enter'],'A new line',['Shift+Enter']],
    [['Esc'],'Close the question box; expand the panes “Collapse others” folded',['Escape']],
  ]],
  ['In search',[
    [['↑','↓','Enter'],'Pick and open a result',['ArrowUp','ArrowDown']],
    [['Mod+Enter'],'Open it, keep searching',['Mod+Enter']],
    [['Tab'],'Everywhere / this conversation / this pane',['Tab']],
  ]],
  ['Reviewing flashcards',[
    [['Space'],'Show the answer',['Space']],
    [['1','2','3','4'],'Again, Hard, Good, Easy',['Digit1','Digit2','Digit3','Digit4']],
    [['S'],'Skip: it comes back at the end',['KeyS']],
    [['O'],'Open where the card came from',['KeyO']],
    [['E'],'Edit the card',['KeyE']],
    [['F'],'Fix…: have the model check it',['KeyF']],
  ]],
  ['On the canvas',[
    [['Space'],'Read the selected card full screen (again or Esc: back)',[]],
    [['Mod+\\'],'Expand the selected card, or shrink it',[]],
    [['Mod+Alt+←','Mod+Alt+→'],'Dock it left or right',['Mod+Alt+ArrowLeft','Mod+Alt+ArrowRight']],
    [['Mod+Alt+↑','Mod+Alt+↓'],'Full screen; undock',['Mod+Alt+ArrowUp','Mod+Alt+ArrowDown']],
    [['Alt+scroll'],'Zoom one card',[]],
  ]],
  ['In the sidebar',[
    [['Mod+click'],'Open a conversation in a new window',[]],
  ]],
];
const KP={el:$('#keysPanel'),q:'',side:(()=>{try{return localStorage.getItem('sq:keysSide')||'right'}catch(e){return 'right'}})()};
const keyLabel=(k)=>k.split('+').map(p=>p==='Mod'?(IS_MAC?'⌘':'Ctrl'):p==='Ctrl'?(IS_MAC?'⌃':'Ctrl'):p==='Shift'?(IS_MAC?'⇧':'Shift'):p==='Alt'?(IS_MAC?'⌥':'Alt'):p).join(IS_MAC?'':'+');
function renderKeys(){
  const q=KP.q.trim().toLowerCase();
  const secs=KEYS.map(([sec,rows])=>[sec,rows.filter(([ks,what])=>!q||what.toLowerCase().includes(q)||sec.toLowerCase().includes(q)||ks.some(k=>keyLabel(k).toLowerCase().includes(q)))]).filter(x=>x[1].length);
  KP.el.querySelector('.kpbody').innerHTML=secs.length?secs.map(([sec,rows])=>`<div class="kpsec">${esc(sec)}</div>`+rows.map(([ks,what,m])=>`<div class="kprow" data-m="${esc(m.join(' '))}"><span class="kpk">${ks.map(k=>`<kbd>${esc(keyLabel(k))}</kbd>`).join('')}</span><span class="kpw">${esc(what)}</span></div>`).join('')).join(''):'<div class="kpnone">No shortcut matches.</div>';
}
function openKeys(){
  if(!KP.el.firstChild){
    KP.el.innerHTML=`<div class="kphead"><b>Keyboard shortcuts</b><span class="sp"></span><button class="ib" data-kp="side" title="Move to the other corner">${ic('swap')}</button><button class="ib" data-kp="close" title="Close (? or Esc)">${ic('x')}</button></div><input class="kpq" placeholder="Filter: pane, canvas, search…" aria-label="Filter shortcuts" autocomplete="off"><div class="kpbody"></div>`;
    const inp=KP.el.querySelector('.kpq');inp.addEventListener('input',()=>{KP.q=inp.value;renderKeys()});
    inp.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();e.preventDefault();if(inp.value){inp.value='';KP.q='';renderKeys()}else{inp.blur()}}});
    KP.el.addEventListener('click',e=>{const b=e.target.closest('[data-kp]');if(!b)return;if(b.dataset.kp==='close')closeKeys();else{KP.side=KP.side==='right'?'left':'right';try{localStorage.setItem('sq:keysSide',KP.side)}catch(e){}KP.el.dataset.side=KP.side}});
    // on a phone: swipe the sheet down to put it away
    let y0=null;KP.el.addEventListener('touchstart',e=>{y0=e.target.closest('.kphead')?e.touches[0].clientY:null},{passive:true});
    KP.el.addEventListener('touchmove',e=>{if(y0!=null&&e.touches[0].clientY-y0>60){y0=null;closeKeys()}},{passive:true});
  }
  KP.el.dataset.side=KP.side;renderKeys();KP.el.classList.add('show');
}
function closeKeys(){KP.el.classList.remove('show')}
const keysOpen=()=>KP.el.classList.contains('show');
const typingIn=(t)=>t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
document.addEventListener('keydown',e=>{
  if(e.key==='?'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!typingIn(e.target)){e.preventDefault();keysOpen()?closeKeys():openKeys();return}
  if(!keysOpen())return;
  if(e.key==='Escape'&&!e.defaultPrevented&&!typingIn(e.target)&&!document.querySelector('.modal.show,.pal.show,#activity.show')){closeKeys();return}
  // light up the row of the key just pressed (it still does what it does)
  const code=[(e.metaKey||e.ctrlKey)&&'Mod',e.altKey&&'Alt',e.shiftKey&&'Shift',e.code].filter(Boolean).join('+');
  KP.el.querySelectorAll('.kprow').forEach(r=>{if(r.dataset.m.split(' ').includes(code)){r.classList.remove('hit');void r.offsetWidth;r.classList.add('hit')}});
},true);
document.addEventListener('click',e=>{if(e.target.closest('[data-keys]')){e.preventDefault();keysOpen()?closeKeys():openKeys()}});

/* ---------- sidebar (web/js/sidebar.js) ---------- */
const SIDEBAR_MOD = createSidebar();
const {
  renderTitle, brCount, closeBrList, toggleBrList, renderMap,
  toggleTreeFold, treeAll, metaOf, renderConvList, toggleFolder,
  editFolderPrompt, newChatIn, renameFolder, dropFolder, openFolderMenu,
  archiveConv, newFolderDialog, closeFolderMenu, trashLeft, isBlank,
  openNextAfter, discardBlank, trashConv, docFate, restoreConv, setConvFlag,
  toggleHidden, refreshAll, toggleBranchPin, unpinRemoteBranch, openPinnedBranch,
} = SIDEBAR_MOD;

/* ---------- persistence, and the same conversation on several devices ----------
   Only a conversation's content is saved with it; its layout (open panes, sizes, view, zoom, canvas) is per
   device (saveLayout: api/layout). Each save says which version (rev) it started from. If another device saved
   in between, the server refuses and sends its copy, and this page merges the two (ThreadOps.merge in
   threads.js: nothing either side added is lost, and every message keeps what it saw) and saves that. If they
   can't be combined, this page's version is kept as a separate conversation. Coming back to the tab (catchUp)
   fetches whatever changed elsewhere, so switching devices finds everything where it was left. */
let saveTimer=0,saving=false,dirty=false;
/* A save that fails (no connection) isn't dropped: the change stays pending and is tried again, after 2 s, then
   less often (at most every 30 s), and at once when the connection comes back or the tab is shown. Leaving the
   conversation with it still unsaved asks first (leaveOk), and so does closing the tab. When the tab is hidden
   (another tab or app, the screen locked, usually a close or reload too), a pending change is saved right away
   instead of 0.7 s later. */
let saveFailed=false,saveTries=0,retryT=0;
function retrySave(){clearTimeout(retryT);retryT=setTimeout(()=>{if(dirty&&conv){saveTries++;flush()}},Math.min(30000,2000*Math.pow(2,saveTries)))}
function saveSoon(){if(dirty&&conv&&!saving){clearTimeout(saveTimer);clearTimeout(retryT);flush()}}
addEventListener('online',saveSoon);
document.addEventListener('visibilitychange',saveSoon);   // hidden: don't wait the 0.7 s; shown again: retry now
addEventListener('pagehide',saveSoon);
addEventListener('beforeunload',e=>{if(saveFailed&&dirty){e.preventDefault();e.returnValue=''}});   // a change that couldn't be saved: the browser asks
const sync={id:null,rev:0,base:null,sent:'',ui:'',uiSaving:0};   // for the open conversation: its version, content as last saved/loaded, what that was
function save(){if(!conv)return;dirty=true;if(typeof IDX!=='undefined')idxTouch(conv.id);clearTimeout(saveTimer);saveTimer=setTimeout(flush,700)}
const LOCAL_MSG=['pending','ver','live','t0','toolNow'];   // per page, never saved
const plainMsg=(m)=>{const x={...m};for(const f of LOCAL_MSG)delete x[f];return x};
function serialize(c){const msgs={};for(const [k,m] of Object.entries(c.msgs))msgs[k]=plainMsg(m);return {...c,msgs}}
function contentOf(c){const {ui,rev,...rest}=serialize(c);return JSON.parse(JSON.stringify(rest))}
const contentKey=(x)=>JSON.stringify({...x,updated:0});
function syncReset(c){sync.id=c.id;sync.rev=c.rev||0;sync.base=contentOf(c);sync.sent=c.rev?contentKey(sync.base):'';sync.ui=JSON.stringify(c.ui||{})}
async function flush(){
  if(!dirty||!conv)return;
  if(saving){clearTimeout(saveTimer);saveTimer=setTimeout(flush,500);return}
  if(isBlank(conv)){dirty=false;return}   // the one rule for "nothing to keep": a prompt or skills of its own count
  if(!io.store){clearTimeout(saveTimer);saveTimer=setTimeout(flush,400);return}
  dirty=false;saving=true;const c=conv;
  try{
    const content=contentOf(c);
    const changed=contentKey(content)!==sync.sent||sync.id!==c.id;
    if(changed){
      c.updated=content.updated=Date.now();
      if(await saveContent(c,content)&&io.store.label)setStatus(io.store.label);
    }
    await saveLayout(c);
    if(changed)await idxWrite(c,state.docState&&state.docState.key===c.id&&state.docState.loaded?state.docState.pages:null);
  }catch(e){
    console.warn('save failed',e);
    if(e&&e.code==='quota_exceeded')toast('Storage is full. Delete an old conversation.');
    else if(e&&e.code==='invalid_argument'&&JSON.stringify(contentOf(c)).length>250000)toast('This conversation is too large to save (256 KB limit).');
    else if(c===conv){if(!saveFailed)toast('Couldn’t save just now. It keeps trying in the background.');dirty=true;saveFailed=true;retrySave();setStatus('Not saved yet: retrying')}   // (a connection that dropped: keep it and try again; one popup, not one per try)
    else setStatus('Not saved');
  }
  if(c===conv&&!dirty&&saveFailed){saveFailed=false;saveTries=0;clearTimeout(retryT);setStatus('Saved');toast('Saved. All caught up.')}
  saving=false;
  if(!convList.length&&c!==conv)return;
  const i=convList.findIndex(x=>x.id===c.id);const meta=metaOf(c);
  if(i>=0)convList[i]=meta;else if(c===conv)convList.unshift(meta);
  convList.sort((a,b)=>b.updated-a.updated);renderConvList();
}
// -> true once saved. Merges and tries again when another device saved first.
async function saveContent(c,content){
  for(let tries=0;tries<4;tries++){
    const mine=sync.id===c.id;
    const r=await io.store.save(c.id,content,mine?(sync.rev||null):(c.rev||null));
    if(r.rev){c.rev=r.rev;if(mine&&c===conv){sync.rev=r.rev;sync.base=content;sync.sent=contentKey(content);showInUrl()}return true}
    if(r.deleted){deletedElsewhere(c,content);return false}
    if(!r.current)throw new Error('unexpected answer from the store');
    const next=mergeRemote(c,r.current,content);
    if(!next){dirty=true;return false}   // a reply here is still being written: saved once it's done
    if(contentKey(next)===sync.sent)return true;   // nothing of ours left to add
    content=next;c.updated=content.updated=Math.max(Date.now(),content.updated||0);
  }
  throw new Error('This conversation kept changing on another device.');
}
// Merge `theirs` (the server's copy) into conversation c, whose content is `mine`. Returns c's content after,
// or null when it has to wait (see ThreadOps.merge: later). The page shows the result.
function mergeRemote(c,theirs,mine){
  const t={...theirs};delete t.ui;
  const base=sync.id===c.id?sync.base:null;let res=null;
  if(base){
    try{res=ThreadOps.merge(base,mine,t,{newId:(k)=>(k==='t'?'b':'m')+rid()+rid().slice(0,3),keep:[...streaming.values()].filter(s=>s.conv===c).map(s=>s.mid)})}
    catch(e){if(e&&e.later)return null;if(!(e&&e.conflict))console.warn('merge failed',e);else console.info('not merged:',e.message)}
  }
  if(!res){keepCopy(c,mine);res={conv:JSON.parse(JSON.stringify(t))}}
  applyContent(c,res.conv);
  if(c===conv){sync.rev=theirs.rev||0;sync.base=JSON.parse(JSON.stringify(t));delete sync.base.rev;sync.sent=contentKey(sync.base);refreshAfterSync()}
  return contentOf(c);
}
// put merged content into the live conversation, keeping the objects of replies being written here
function applyContent(c,next){
  const live=new Set([...streaming.values()].filter(s=>s.conv===c).map(s=>s.mid)),msgs={};
  for(const [id,x] of Object.entries(next.msgs||{})){
    const old=c.msgs[id];
    if(old&&live.has(id)){old.thread=x.thread;msgs[id]=old;continue}
    if(old&&JSON.stringify(plainMsg(old))===JSON.stringify(x)){msgs[id]=old;continue}
    msgs[id]={...x,ver:((old&&old.ver)||0)+1};msgCache.delete(id);cvMsgCache.delete(id);
  }
  for(const id of Object.keys(c.msgs))if(!msgs[id]){for(const s of streaming.values())if(s.mid===id&&s.conv===c)stopReply(s);msgCache.delete(id);cvMsgCache.delete(id)}
  for(const k of Object.keys(c))if(!['id','ui','msgs','rev'].includes(k)&&!(k in next))delete c[k];
  for(const [k,v] of Object.entries(next))if(k!=='msgs'&&k!=='ui'&&k!=='rev')c[k]=v;
  c.msgs=msgs;
  // flashcards drafted from messages that now sit in another thread follow them
  for(const card of CARDS.values()){
    if(card.conv!==c.id||!card.at)continue;const m=msgs[card.at.msg];
    if(m&&card.at.thread!==m.thread){if(card.thread===card.at.thread)card.thread=m.thread;card.at.thread=m.thread;putCard(card)}
  }
  if(c===conv)tabName();   // a rename on another device
}
// redraw the panes without losing where each was scrolled: Safari resets a pane's scroll to the top when the layout
// moves it (Chrome keeps it), so a pane that came back at the top is put back where it was
function keepPaneTops(f){
  const tops=[];for(const [tid,el] of paneEls){if(tid==='doc')continue;const pb=el.querySelector(':scope>.pb');if(pb&&pb.scrollTop>0)tops.push([el,pb,pb.scrollTop])}
  f();for(const [el,pb,t] of tops)if(el.isConnected&&pb.scrollTop===0)holdScroll(pb,t);
}
// put a pane's scroll back to `top`, and keep it there for a moment while the pane is still being laid out (content
// that renders a frame later, math, would otherwise leave it short: the first try is clamped to a shorter pane).
// Stops at once if the reader scrolls, touches, clicks or types.
function holdScroll(pb,top,ms=1000){
  pb.scrollTop=top;const end=performance.now()+ms;let stop=false;
  const quit=()=>{stop=true};const evs=['wheel','touchstart','pointerdown','keydown'];
  for(const t of evs)pb.addEventListener(t,quit,{passive:true,once:true});
  const tick=()=>{if(stop||performance.now()>end||!pb.isConnected){for(const t of evs)pb.removeEventListener(t,quit);return}
    if(Math.abs(pb.scrollTop-top)>1&&pb.scrollHeight-pb.clientHeight>=top-1)pb.scrollTop=top;requestAnimationFrame(tick)};
  requestAnimationFrame(tick);
}
// redraw the open conversation after it changed underneath (layout stays as it is on this device)
function refreshAfterSync(){
  const ui=conv.ui,keep=x=>conv.threads[x]||(x==='doc'&&conv.doc);
  ui.open=ui.open.filter(keep);if(!ui.open.length)ui.open=['main'];ui.collapsed=(ui.collapsed||[]).filter(keep);
  for(const [tid,el] of paneEls)if(!ui.open.includes(tid)){el.remove();paneEls.delete(tid)}
  keepPaneTops(()=>{layout();for(const id of ui.open)if(id!=='doc'&&T(id))renderPane(id)});
  renderTitle();renderMap();renderConvList();syncCardsUI();syncViewsUI();if(ui.view==='canvas')renderCanvas();
  placeMark();applyConvLlm();resumeRuns();
}
// this page's version, as its own conversation (when it couldn't be combined with another device's)
function keepCopy(c,mine,why){
  const id='c'+Date.now().toString(36)+rid().slice(0,4),copy={...JSON.parse(JSON.stringify(mine)),id,title:(mine.title||'Conversation')+' (from this device)',titleKept:true,updated:Date.now(),ui:JSON.parse(JSON.stringify(c.ui||{}))};
  for(const m of Object.values(copy.msgs))delete m.run;
  io.store.put(id,copy).then(()=>{convList.unshift(metaOf(copy));renderConvList()}).catch(e=>console.warn('copy not saved',e));
  if(why!=='deleted')toast(`This conversation changed on another device in a way that couldn’t be combined with yours, so yours was kept as “${copy.title}”.`);
  return copy;
}
function deletedElsewhere(c,content){
  const base=sync.id===c.id?sync.base:null,added=!base||Object.keys(content.msgs).some(id=>!base.msgs[id]);
  convList=convList.filter(x=>x.id!==c.id);
  const copy=added?keepCopy(c,content,'deleted'):null;
  if(c===conv){dirty=false;setConv(copy?JSON.parse(JSON.stringify(copy)):newConv())}
  renderConvList();
  toast(copy?'This conversation was deleted on another device. What you added here was kept as a copy.':'This conversation was deleted on another device.');
}
async function saveLayout(c){
  if(!io.layout||c!==conv||!c.rev)return;
  const k=JSON.stringify(c.ui);if(k===sync.ui)return;
  sync.ui=k;sync.uiSaving++;   // set before it's sent, so a second change doesn't send it twice; uiSaving: still on its way
  try{await io.layout.put(c.id,c.ui)}catch(e){sync.ui='';console.warn('layout not saved',e)}finally{sync.uiSaving--}
}
// Back to this tab (or online again): whatever changed on other devices
let catching=null,lastCatch=0;
function catchUp(force){
  if(!conv||!io.store||!io.store.rev||document.visibilityState==='hidden')return Promise.resolve();
  if(catching){if(force)catchUp.again=true;return catching}
  if(!force&&Date.now()-lastCatch<1500)return Promise.resolve();
  lastCatch=Date.now();
  catching=(async()=>{
    try{
      loadList();
      const c=conv;if(sync.id!==c.id||!sync.rev)return;
      const rev=await io.store.rev(c.id);
      if(c!==conv)return;
      if(rev===null){deletedElsewhere(c,contentOf(c));return}
      if(rev===sync.rev)return;
      if(dirty||saving){await flushNow();return}   // saving finds the newer version and merges
      const cur=await io.store.get(c.id);if(!cur||c!==conv)return;
      const next=mergeRemote(c,cur,contentOf(c));
      if(next&&contentKey(next)!==sync.sent)save();
    }catch(e){console.warn('catching up failed',e)}
  })().finally(()=>{catching=null;if(catchUp.again){catchUp.again=false;catchUp(true)}});
  return catching;
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')catchUp()});
addEventListener('focus',()=>catchUp());
if(WINDOWS)WINDOWS.onmessage=e=>{const id=e.data&&e.data.conv;if(!id||!conv)return;
  if(id===conv.id)catchUp(true);else{clearTimeout(WINDOWS.t);WINDOWS.t=setTimeout(loadList,300)}};   // another window savedaddEventListener('online',()=>catchUp(true));addEventListener('pageshow',e=>{if(e.persisted)catchUp(true)});
async function loadList(){
  await io.ready;
  try{
    const rows=await (io.store.listMeta?io.store.listMeta():io.store.list());
    convList=rows.map(({id,data})=>(data&&data._meta?{...data,id}:{...metaOf(data),id}));
    convList.sort((a,b)=>(b.updated||0)-(a.updated||0));SIDEBAR_MOD.convListLoaded=true;
  }catch(e){console.warn('list failed',e)}
  renderConvList();
}
// before leaving the open conversation: save what's pending; if that fails (no connection), ask, since leaving drops it
async function leaveOk(){
  await flushNow();if(!dirty||!saveFailed||!conv||isBlank(conv))return true;
  return new Promise(ok=>askConfirm('This change isn’t saved yet','The last change to this conversation couldn’t be saved (no connection?). It’s still trying. If you leave now, the change is lost.',()=>ok(true),{ok:'Leave anyway',cancel:'Stay',onCancel:()=>ok(false)}));
}
async function openConv(id){
  if(conv&&conv.id===id)return;
  await io.ready;
  if(!await leaveOk())return;
  let data=null;
  try{
    data=await io.store.get(id);
  }catch(e){console.warn(e)}
  if(!data){toast('Couldn\'t open that conversation.');return}
  // this window's layout for it; the first time here, the one last used on another device or window
  if(io.layout){try{
    const d=(await io.layout.get(id)).devices||{},key=await layoutKey();
    // none of this window's own: another window of this device as it is, or else the latest from another device, but
    // without what's sized for that screen (a desktop's 800px panes are wider than a phone)
    const pick=d[key]?[key,d[key]]:Object.entries(d).sort((a,b)=>(b[1].at||0)-(a[1].at||0)).sort((a,b)=>(b[0].startsWith(DEVICE)?1:0)-(a[0].startsWith(DEVICE)?1:0))[0];
    if(pick&&pick[1].ui)data.ui=pick[0].startsWith(DEVICE)?pick[1].ui:otherScreen(pick[1].ui);
  }catch(e){console.warn('layout not loaded',e)}}
  if(conv&&conv.id===id)return;
  clearHit();
  setConv(data);
  if(conv.trashed)toast(`This conversation is in the trash: it’s deleted for good in ${trashLeft(conv)} day${trashLeft(conv)>1?'s':''}.`,{label:'Restore',fn:()=>restoreConv(id)});
}
async function flushNow(){clearTimeout(saveTimer);for(let i=0;saving&&i<200;i++)await new Promise(ok=>setTimeout(ok,25));if(dirty)await flush()}
async function deleteConv(id){
  await io.ready;
  if(conv&&conv.id===id)for(const s of [...streaming.values()])stopReply(s);
  // its document's file isn't deleted here: another conversation may use it. The server deletes files nothing uses.
  const dropK=!!(convInfo(id)||{}).dropCards;
  try{await io.store.remove(id)}catch(e){toast('Couldn\'t delete it.');return}
  if(dropK)for(const k of [...CARDS.values()].filter(k=>k.conv===id))await dropCard(k.id);
  idxDelete(id);
  convList=convList.filter(c=>c.id!==id);
  if(conv&&conv.id===id)await openNextAfter(id);else renderConvList();
}
function setConv(c){
  clearHere();   // "You were here" belongs to this conversation's canvas visit
  for(const s of streaming.values()){s.detached=true;s.ctrl.abort()}streaming.clear();unread.clear();   // replies carry on on the server; back here, resumeRuns picks them up
  conv=c;const ui=conv.ui=conv.ui||{};
  ui.open=(ui.open||[]).filter(id=>conv.threads[id]||(id==='doc'&&conv.doc));   // main or the document may have been closed here
  if(!ui.open.length)ui.open=conv.doc?['doc','main']:['main'];
  ui.collapsed=(ui.collapsed||[]).filter(id=>ui.open.includes(id));
  if(ui.focus){ui.collapsed=ui.open.filter(x=>x!==ui.focus);delete ui.focus}
  ui.layout=ui.layout==='rows'?'rows':'cols';ui.view=ui.view==='canvas'?'canvas':'panes';ui.sizes=ui.sizes||{};
  // after ui is complete: a document already loaded draws straight away, and its header reads ui.collapsed
  destroyDoc(state.docState);if(docView.obs)docView.obs.disconnect();state.docState=null;if(conv.doc)startDoc();
  for(const m of Object.values(conv.msgs)){m.ver=m.ver||0;if(m.pending){delete m.pending;if(!m.content)m.error='Interrupted.'}}
  msgCache.clear();cvMsgCache.clear();CANVAS_MOD.cvNodes.clear();resetThreadIdx();for(const el of paneEls.values())el.remove();paneEls.clear();for(const g of gutEls.values())g.remove();gutEls.clear();
  CANVAS_MOD.camFitted=false;
  layout();renderTitle();renderMap();renderConvList();hidePop();syncCardsUI();
  $('#stage').classList.toggle('canvas',ui.view==='canvas');if(ui.view==='canvas')renderCanvas();
  syncViewSeg();
  syncReset(conv);dirty=false;closeViews();syncViewsUI();
  applyConvLlm();showInUrl();resumeRuns();syncSkillT();
}
// The address names the open conversation (#c=ID) once it's saved, so a window can be opened, reloaded or
// bookmarked straight to it. replaceState: switching conversations doesn't add Back steps.
const urlConv=()=>{const m=/^#c=([^&]+)/.exec(location.hash);try{return m?decodeURIComponent(m[1]):null}catch(e){return null}};
let urlOn=false;   // not until startup has read the address (maybeOpenLatest)
function showInUrl(){
  if(!urlOn)return;
  const h=conv&&conv.rev?'#c='+encodeURIComponent(conv.id):'';
  if(location.hash!==h)try{history.replaceState(history.state,'',location.pathname+location.search+h)}catch(e){}
}
addEventListener('hashchange',()=>{const id=urlConv();if(!id||(conv&&conv.id===id))return;
  if(!convList.some(x=>x.id===id)){toast('That conversation isn’t here (it may have been deleted).');showInUrl();return}
  BACK.length=0;renderBack();openConv(id)});
function setStatus(s){const el=$('#status');el.textContent=s;el.style.visibility='';if(s)requestAnimationFrame(()=>{if(el.scrollWidth>el.clientWidth+1)el.style.visibility='hidden'});   // whole or not at all, never "Sa…"
clearTimeout(setStatus.t);setStatus.t=setTimeout(()=>el.textContent='',2500)}
// toast(text) shows a note for 3 s; toast(text,{label,fn}) adds a button and stays 6 s (the button hides it)
function toast(s,act){const el=$('#toast');el.textContent=s;el.classList.toggle('act',!!act);
  if(act){const b=document.createElement('button');b.className='tact';b.textContent=act.label;
    b.onclick=()=>{el.classList.remove('show');clearTimeout(toast.t);act.fn()};el.append(' · ',b)}
  el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),act?6000:3000)}

/* ---------- selection popover ---------- */
const pop=$('#pop'),popIn=$('#popIn');
function fillPopChips(){$('#popChips').replaceChildren();quickList().forEach(([l,q])=>{const b=document.createElement('button');b.className='chip';b.textContent=l;b.dataset.q=q;b.title='Opens a branch asking: '+q;$('#popChips').appendChild(b)})}
fillPopChips();
$('#popGo').innerHTML=ic('send');
let cvTook=false;   // the current press was taken by a canvas drag (see cvTake)
function checkSelection(){
  if(cvTook)return;   // the press was a canvas drag (pan, move, resize): whatever it swept over isn't a highlight
  const sel=window.getSelection();
  if(!sel||sel.isCollapsed||!sel.rangeCount)return;
  const elOf=n=>n&&(n.nodeType===1?n:n.parentElement);
  const rng=sel.getRangeAt(0);
  let raw=sel.toString().trim();
  // a PDF passage that runs on to the next page(s): each page has its own text layer. Its text is taken from
  // the text layers only, not the page numbers and buttons between them
  const tl1=conv.doc&&elOf(rng.startContainer)&&elOf(rng.startContainer).closest('.textLayer'),tl2=conv.doc&&elOf(rng.endContainer)&&elOf(rng.endContainer).closest('.textLayer');
  const p1=tl1&&+tl1.closest('.dpage').dataset.page,p2=tl2&&+tl2.closest('.dpage').dataset.page;
  const across=!!(tl1&&tl2&&p2>p1&&tl1.closest('.pane')===tl2.closest('.pane'));
  const cross=across&&crossPageText(rng,tl1,p1,p2);
  if(across&&!cross)return;   // nothing of it sits on the pages' text (it was all header, footer or out of place)
  if(cross)raw=cross.text;
  const txt=raw.replace(/\s+/g,' ');if(txt.length<2)return;
  const d1=conv.doc&&elOf(sel.anchorNode)&&elOf(sel.anchorNode).closest('.textLayer,.docbody');
  const d2=conv.doc&&elOf(sel.focusNode)&&elOf(sel.focusNode).closest('.textLayer,.docbody');
  if(across){
    const {s,e1,s2,e2}=cross;
    popState={doc:true,page:p1-1,text:txt.slice(0,1500),range:s>=0&&e1>s?{s,e:e1}:null,end:e2>s2?{page:p2-1,e:e2,...(s2>0?{s:s2}:{})}:null};
  }else if(d1&&d1===d2){
    const page=d1.classList.contains('textLayer')?(+d1.closest('.dpage').dataset.page-1):0;
    const s=charPos(d1,rng.startContainer,rng.startOffset),e2=charPos(d1,rng.endContainer,rng.endOffset);
    popState={doc:true,page,text:txt.slice(0,1500),range:s>=0&&e2>s?{s,e:e2}:null};
  }else{
    const b1=elOf(sel.anchorNode)&&elOf(sel.anchorNode).closest('.msg.assistant .body');
    const b2=elOf(sel.focusNode)&&elOf(sel.focusNode).closest('.msg.assistant .body');
    if(!b1||b1!==b2)return;
    const mid=b1.closest('.msg').dataset.mid;const m=conv.msgs[mid];if(!m||m.pending)return;
    const s=charPos(b1,rng.startContainer,rng.startOffset),e2=charPos(b1,rng.endContainer,rng.endOffset);
    popState={mid,text:txt.slice(0,1500),range:s>=0&&e2>s?{s,e:e2}:null};
  }
  $('#popQ').textContent=raw.slice(0,1500);$('#popHint').textContent='Opens a side branch. The AI sees the whole conversation so far, with this passage marked as your focus.';popIn.value='';popIn.style.height='';
  pop.style.setProperty('--c',PALETTE[conv.nextColor%PALETTE.length]);
  const r=sel.getRangeAt(0).getBoundingClientRect();
  showPopAt(r);
}
function showPopAt(r){
  pop.classList.add('show');$('#popQ').scrollTop=0;
  const pw=pop.offsetWidth,ph=pop.offsetHeight;
  let left=Math.min(Math.max(8,r.left+r.width/2-pw/2),innerWidth-pw-8);
  let top=r.bottom+10;if(top+ph>innerHeight-8)top=Math.max(8,r.top-ph-10);
  pop.style.left=left+'px';pop.style.top=Math.max(8,top)+'px';
}
// the same popover, for a snip or a whole page: shows the image the AI will get
function openImagePop(pageNo,reg,anchorEl){
  const whole=isWholePage(reg),txt=whole?'':regionText(pageNo,reg);
  const label=whole?`Page ${pageNo}`:`Snip from p. ${pageNo}`+(txt?`: ${trunc(txt,60)}`:'');
  popState={doc:true,page:pageNo-1,region:reg,regionText:txt,text:label};
  const q=$('#popQ');q.innerHTML='<img class="pimg" alt=""><div class="pimgcap"></div>';q.querySelector('.pimgcap').textContent=whole?`The whole of page ${pageNo}`:`From page ${pageNo}`+(txt?` · “${trunc(txt,80)}”`:'');
  const im=q.querySelector('img');im.alt=label;
  $('#popHint').textContent='Opens a side branch. The AI gets this image along with the conversation so far.';
  popIn.value='';popIn.style.height='';
  pop.style.setProperty('--c',PALETTE[conv.nextColor%PALETTE.length]);
  imageURL({region:{page:pageNo,...reg}}).then(u=>{im.src=u;if(pop.classList.contains('show'))requestAnimationFrame(()=>showPopAt(anchorEl.getBoundingClientRect()))}).catch(e=>{q.querySelector('.pimgcap').textContent='The image couldn’t be drawn: '+((e&&e.message)||e)});
  showPopAt(anchorEl.getBoundingClientRect());
  if(!matchMedia('(hover:none)').matches)popIn.focus();
}
// the same popover, for an image in a text document (all of it, or a box on it). The image is fetched and kept
// with the conversation first (docImageRec), so what's shown is exactly what the AI will get
function openDocImgPop(w,reg,anchorEl){
  const whole=isWholePage(reg),alt=docImgAlt(w);
  const label=(whole?'Image':'Snip of an image')+(alt?`: ${trunc(alt,60)}`:'');
  const st=popState={doc:true,page:0,image:{key:w.dataset.key,n:+w.dataset.n,...reg},text:label};
  const q=$('#popQ');q.innerHTML='<img class="pimg" alt=""><div class="pimgcap"></div>';const cap=q.querySelector('.pimgcap');
  cap.textContent=(whole?'The whole image':'Part of the image')+(alt?` · “${trunc(alt,80)}”`:'');
  const im=q.querySelector('img');im.alt=label;
  $('#popHint').textContent='Opens a side branch. The AI gets this image along with the conversation so far.';
  popIn.value='';popIn.style.height='';
  pop.style.setProperty('--c',PALETTE[conv.nextColor%PALETTE.length]);
  st.imgP=docImageRec(w).then(rec=>imageURL(cropRef(rec,reg))).then(u=>{im.src=u;if(popState===st)requestAnimationFrame(()=>showPopAt(anchorEl.getBoundingClientRect()))});
  st.imgP.catch(e=>{cap.textContent='The image couldn’t be loaded: '+((e&&e.message)||e)});
  showPopAt(anchorEl.getBoundingClientRect());
  if(!matchMedia('(hover:none)').matches)popIn.focus();
}
// …and for any other box on a text document: a picture of that part, with the text found inside it
function openDocShotPop(body,r,anchorEl){
  const b=body.getBoundingClientRect(),found=docBoxText(body,b.left+r.x,b.top+r.y,b.left+r.x+r.w,b.top+r.y+r.h);
  const label='Snip of the document'+(found.text?`: ${trunc(found.text,60)}`:'');
  const st=popState={doc:true,page:0,shot:true,regionText:found.text,range:found.range,near:found.near,text:label};
  const q=$('#popQ');q.innerHTML='<img class="pimg" alt=""><div class="pimgcap"></div>';const cap=q.querySelector('.pimgcap');
  cap.textContent='From the document'+(found.text?` · “${trunc(found.text,80)}”`:'');
  const im=q.querySelector('img');im.alt=label;
  $('#popHint').textContent='Opens a side branch. The AI gets this image along with the conversation so far.';
  popIn.value='';popIn.style.height='';
  pop.style.setProperty('--c',PALETTE[conv.nextColor%PALETTE.length]);
  st.imgP=shotDocRegion(body,r).then(shot=>{st.shotImg=shot;im.src=URL.createObjectURL(shot.blob);if(popState===st)requestAnimationFrame(()=>showPopAt(anchorEl.getBoundingClientRect()))});
  st.imgP.catch(e=>{cap.textContent='The picture couldn’t be made: '+((e&&e.message)||e)});
  showPopAt(anchorEl.getBoundingClientRect());
  if(!matchMedia('(hover:none)').matches)popIn.focus();
}
function hidePop(){pop.classList.remove('show');popState=null;document.querySelectorAll('.snipbox').forEach(b=>b.remove())}
async function popSubmit(q,chip){
  if(!popState)return;const st=popState,{mid,text,range,doc,page,region,regionText:rt,image,imgP,shot,near}=st;
  if(imgP){try{await imgP}catch(e){toast('That image couldn’t be loaded, so there’s nothing to ask about yet. '+((e&&e.message)||''));return}}
  hidePop();window.getSelection().removeAllRanges();
  let kept=null;   // a picture of part of a text document is kept as a file (it can't be drawn again: the text re-wraps)
  if(shot){try{[kept]=await storeImages([st.shotImg])}catch(e){toast('The picture couldn’t be saved: '+((e&&e.message)||e));return}}
  createBranch(doc?'DOC':mid,text,q||'',q&&chip?trunc(text,40):null,range,page,region?{region,regionText:rt}:image?{image}:shot?{shot:kept,regionText:rt,near}:st.end&&range?{end:st.end}:null);
}
popIn.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();popSubmit(popIn.value.trim())}else if(e.key==='Escape'){hidePop()}});
popIn.addEventListener('input',()=>{
  popIn.style.height='auto';popIn.style.height=Math.min(popIn.scrollHeight+2,200)+'px';
  // keep the whole popup on screen as it grows
  const r=pop.getBoundingClientRect();if(r.bottom>innerHeight-8)pop.style.top=Math.max(8,innerHeight-8-r.height)+'px';
});
$('#popGo').addEventListener('click',()=>popSubmit(popIn.value.trim()));
$('#popChips').addEventListener('click',e=>{const b=e.target.closest('[data-q]');if(b)popSubmit(b.dataset.q,true)});
document.addEventListener('mouseup',e=>{if(pop.contains(e.target))return;setTimeout(checkSelection,0)});
let mouseHeld=false,selT=0;
document.addEventListener('mousedown',()=>{mouseHeld=true},true);document.addEventListener('mouseup',()=>{mouseHeld=false},true);
document.addEventListener('selectionchange',()=>{
  if(mouseHeld||pop.contains(document.activeElement))return;
  clearTimeout(selT);selT=setTimeout(()=>{if(!mouseHeld&&!pop.classList.contains('show'))checkSelection()},450);
});
document.addEventListener('mousedown',e=>{if(!pop.contains(e.target))hidePop()});
document.addEventListener('keydown',e=>{
  if(e.key==='Tab'&&pop.classList.contains('show')&&document.activeElement!==popIn){e.preventDefault();popIn.focus();return}
  if(conv&&conv.ui.view==='canvas'&&!e.target.closest('input,textarea,select,[contenteditable="true"]')&&!$('#pal').classList.contains('show')&&!pop.classList.contains('show')){
    const S=cvState(),tid=S.sel,isD=tid&&S.dock&&S.dock[tid];
    if(tid&&(e.ctrlKey||e.metaKey)&&e.altKey&&/^Arrow/.test(e.key)){
      e.preventDefault();
      if(e.key==='ArrowLeft')dockCard(tid,REGIONS.left);else if(e.key==='ArrowRight')dockCard(tid,REGIONS.right);else if(e.key==='ArrowUp')dockCard(tid,REGIONS.fill);else if(isD)restoreCard(tid);
      return;
    }
    if(tid&&e.key===' '){e.preventDefault();if(isD)restoreCard(tid);else dockCard(tid,REGIONS.fill);return}
    if(isD&&(e.key==='Escape'||e.key==='ArrowDown')){e.preventDefault();restoreCard(tid);return}
  }
  if(e.key==='Escape'){
    if(pop.classList.contains('show')){hidePop();return}
    if(conv.ui.view==='panes'&&conv.ui.open.some(isFocused)){conv.ui.collapsed=[];layout();save()}
  }
});
document.addEventListener('keyup',e=>{if(e.shiftKey&&/Arrow/.test(e.key))checkSelection()});

/* ---------- global clicks ---------- */
document.addEventListener('click',e=>{
  if(SIDEBAR_MOD.brPop&&!e.target.closest('.brpop')&&!e.target.closest('[data-brlist]'))closeBrList();
  const brl=e.target.closest('[data-brlist]');if(brl){e.stopPropagation();toggleBrList(brl.dataset.brlist,brl);return}
  const delb=e.target.closest('[data-delb]');
  if(delb){e.stopPropagation();confirmDeleteBranch(delb.dataset.delb);return}
  const pref=e.target.closest('a.pref');
  if(pref){
    e.preventDefault();
    if(pref.dataset.earlier){const msg=pref.closest('.msg');if(msg)goToEarlier(msg.dataset.mid,pref.dataset.cite||'')}
    else if(pref.dataset.part||pref.dataset.doccite)goToDocPart(+(pref.dataset.part||0),pref.dataset.cite||'');
    else goToPage(+pref.dataset.page,pref.dataset.cite||'');
    return;
  }
  if(state.hitSticky&&e.target.closest('.docpane')&&window.getSelection().isCollapsed)clearHit();
  const tf=e.target.closest('[data-tfold]');if(tf){e.stopPropagation();toggleTreeFold(tf.dataset.tfold);return}
  const md=e.target.closest('[data-mapdoc]');if(md){if(conv.ui.view==='canvas')focusCard('doc');else{openDocPane();revealPane('doc')}return}
  const rs=e.target.closest('[data-resolve]');if(rs){e.stopPropagation();toggleResolved(rs.dataset.resolve);return}
  const mz=e.target.closest('.mm-bar [data-mmz]');if(mz){e.stopPropagation();mmAct(mz);return}
  let cnode=e.target.closest('.cnode');
  if(cnode&&e.target.closest('.cdocpane')){   // the document pane docked in a card: branch links go to their cards; the rest is the pane's own
    const fn=e.target.closest('sup.fn,.anchor');if(fn&&window.getSelection().isCollapsed){
      const r=cvState().dock.doc;if(r&&r.w>=.99&&r.h>=.99)dockCard('doc',REGIONS.left);   // filling the canvas: make room beside it for the card
      focusCard(fn.dataset.tid);return}
    cnode=null;
  }
  if(cnode){
    const tid=cnode.dataset.ctid;
    const ca=e.target.closest('[data-cact]');if(ca){canvasAction(ca.dataset.cact,tid,ca);return}
    const uv=e.target.closest('[data-usev]');if(uv){useVersion(uv.dataset.usev);return}
    const ra=e.target.closest('.msg [data-act]');if(ra){replyAct(ra.dataset.act,ra.closest('.msg').dataset.mid,ra);return}
    const tkf=e.target.closest('[data-tkfrom]');if(tkf){goToTakeawaySource(tkf.dataset.tkfrom);return}
    const tkc=e.target.closest('[data-tknote]');if(tkc){goToTakeaway(tkc.dataset.tknote);return}
    const fn=e.target.closest('sup.fn,.anchor,.bchip');if(fn&&window.getSelection().isCollapsed){focusCard(fn.dataset.tid);return}
    const cq=e.target.closest('.cq');if(cq&&window.getSelection().isCollapsed){canvasRevealSource(tid);return}
    const drow=e.target.closest('[data-cdocrow]');if(drow){focusCard(drow.dataset.cdocrow);return}
    const row=e.target.closest('[data-cmid]');if(row){focusCard(tid,row.dataset.cmid);return}
    return;
  }
  const fn=e.target.closest('sup.fn');if(fn){openThread(fn.dataset.tid,fn.closest('.pane').dataset.tid);return}
  const a=e.target.closest('.anchor');if(a&&window.getSelection().isCollapsed){openThread(a.dataset.tid,a.closest('.pane').dataset.tid);return}
  const chip=e.target.closest('.bchip');if(chip){openThread(chip.dataset.tid,chip.closest('.pane').dataset.tid);return}
  const crumb=e.target.closest('[data-crumb]');if(crumb){e.stopPropagation();revealAnchor(crumb.dataset.via);return}
  const back=e.target.closest('[data-back]');if(back&&window.getSelection().isCollapsed){revealAnchor(back.closest('.pane').dataset.tid);return}
  const tkf=e.target.closest('[data-tkfrom]');if(tkf){goToTakeawaySource(tkf.dataset.tkfrom);return}
  const tkc=e.target.closest('[data-tknote]');if(tkc){goToTakeaway(tkc.dataset.tknote);return}
  const op=e.target.closest('[data-open]');if(op){openThread(op.dataset.open);return}
  if(e.target.closest('[data-newdoc]')){$('#newDoc').click();return}
  const ask=e.target.closest('[data-ask]');if(ask){send(ask.closest('.pane').dataset.tid,ask.dataset.ask);return}
  const act=e.target.closest('[data-act]');
  if(act){
    const pane=act.closest('.pane'),tid=pane&&pane.dataset.tid,msg=act.closest('.msg'),mid=msg&&msg.dataset.mid;
    switch(act.dataset.act){
      case 'focus':toggleFocus(tid);break;
      case 'oexp':{const ph=act.closest('.ph'),on=ph.classList.toggle('oexp');act.title=on?'Back to one line':'Show the whole line';fitOrigin(pane);wiresSoon();break}
      case 'pin':if(tid==='main')setConvFlag(conv.id,{pinned:!conv.pinned});else toggleBranchPin(tid);break;
      case 'collapse':toggleCollapse(tid);break;
      case 'close':closeThread(tid);break;
      case 'restart':startMainOver();break;
      case 'newfromdoc':newFromDoc();break;
      case 'back':revealAnchor(tid);break;
      case 'export':openExport(conv.id,tid);break;
      case 'jend':{const pb=pane.querySelector('.pb');pb.scrollTo({top:pb.scrollHeight,behavior:'smooth'});break}
      case 'jsearch':openPalette('','thread',tid);break;
      case 'jmark':markButton(act);break;
      case 'jlast':{const pb=pane.querySelector('.pb');const ms=pane.querySelectorAll('.msgs>.msg');let m=ms[ms.length-1];if(m&&m.classList.contains('assistant')&&ms.length>1&&ms[ms.length-2].classList.contains('user'))m=ms[ms.length-2];if(m)pb.scrollTo({top:pb.scrollTop+m.getBoundingClientRect().top-pb.getBoundingClientRect().top-12,behavior:'smooth'});break}
      case 'jprev':{const pb=pane.querySelector('.pb');if(pane.__prev!=null)pb.scrollTo({top:pane.__prev,behavior:'smooth'});pane.__prev=null;pane.classList.remove('hasprev');break}
      case 'zin':stepPaneZoom(tid,1);break;
      case 'zout':stepPaneZoom(tid,-1);break;
      case 'zedit':editZoom(act,paneZoom(tid),z=>setPaneZoom(tid,Math.abs(z-1)<.005?1:z));break;
      case 'zfit':setPaneZoom(tid,1);break;
      case 'snip':setSnip(!pane.classList.contains('snipping'));break;
      case 'cards':openCards('conv');break;
      case 'mkcards':makeCardsFor(tid);break;
      case 'take':{const tk=pane.querySelector('.tk');tk.classList.toggle('show');if(tk.classList.contains('show'))tk.querySelector('input').focus();break}
      case 'wbranch':case 'rmore':case 'ctxinfo':case 'copy':case 'retry':case 'continue':case 'redo':replyAct(act.dataset.act,mid,act);break;
      case 'edit':startEdit(act.closest('.msg'),mid);break;
      case 'delnote':{const m=conv.msgs[mid];if(!m)break;const s=streaming.get(m.thread);if(s&&s.mid===mid)stopReply(s);try{ThreadOps.removeNote(conv,mid)}catch(e){toast('This takeaway can’t be deleted: '+e.message+'.');break}msgCache.delete(mid);renderPane(m.thread);renderMap();save();break}
    }
    return;
  }
  const rail=e.target.closest('.pane.rail');if(rail){toggleCollapse(rail.dataset.tid);return}
  // buttons on a tree row, before the row itself opens its thread
  const pt=e.target.closest('[data-pinthread]');if(pt){e.stopPropagation();toggleBranchPin(pt.dataset.pinthread);return}
  const hb=e.target.closest('[data-hideb]');if(hb){e.stopPropagation();toggleHidden(hb.dataset.hideb);return}
  const mn=e.target.closest('[data-map]');if(mn){const id=mn.dataset.map;if(mn.closest('.brpop'))closeBrList();if(conv.ui.view==='canvas'){focusCard(id);return}openThread(id);conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!==id);layout();renderMap();revealPane(id);return}
  const del=e.target.closest('[data-del]');if(del){e.stopPropagation();trashConv(del.dataset.del);return}
  const rsb=e.target.closest('[data-restore]');if(rsb){e.stopPropagation();restoreConv(rsb.dataset.restore);return}
  const dn=e.target.closest('[data-delnow]');if(dn){e.stopPropagation();const id=dn.dataset.delnow;const c=convList.find(x=>x.id===id)||(conv.id===id?conv:null);
    const nk=[...CARDS.values()].filter(k=>k.conv===id).length,dropK=!!(convInfo(id)||{}).dropCards;
    const df=docFate(id),dt=!df?'':df.shared?` Its document <b>${esc(df.name)}</b> stays: another conversation uses it.`:` <b>Its document, ${esc(df.name)}, is deleted too</b>: no other conversation uses it.`;
    askConfirm('Delete for good?',`<b>${esc((c&&c.title)||'This conversation')}</b> and all of its branches will be permanently deleted.${dt}${nk?(dropK?` <b>Its ${nk} flashcard${nk>1?'s are':' is'} deleted too</b>, as you chose when you moved it to the trash.`:` Its ${nk} flashcard${nk>1?'s stay':' stays'} in your review, as you chose when you moved it to the trash.`):''} This can’t be undone.`,()=>deleteConv(id));return}
  const pc=e.target.closest('[data-pinconv]');if(pc){e.stopPropagation();const id=pc.dataset.pinconv;const m=convList.find(c=>c.id===id)||(conv.id===id?metaOf(conv):{});setConvFlag(id,{pinned:!m.pinned});return}
  const fc=e.target.closest('[data-folderconv]');if(fc){e.stopPropagation();openFolderMenu(fc,fc.dataset.folderconv);return}
  const fr=e.target.closest('[data-fren]');if(fr){e.stopPropagation();renameFolder(fr.closest('.fgrp'));return}
  const fch=e.target.closest('[data-fchat]');if(fch){e.stopPropagation();newChatIn(fch.closest('.fgrp').dataset.folder);return}
  const fpr=e.target.closest('[data-fprompt]');if(fpr){e.stopPropagation();editFolderPrompt(fpr.closest('.fgrp').dataset.folder);return}
  const fd=e.target.closest('[data-fdrop]');if(fd){e.stopPropagation();dropFolder(fd.closest('.fgrp').dataset.folder);return}
  const ft=e.target.closest('[data-ftog]');if(ft){if(ft.querySelector('.fren'))return;toggleFolder(ft.closest('.fgrp').dataset.folder);return}
  const xc=e.target.closest('[data-expconv]');if(xc){e.stopPropagation();openExport(xc.dataset.expconv);return}
  const ac=e.target.closest('[data-archconv]');if(ac){e.stopPropagation();archiveConv(ac.dataset.archconv);return}
  const ub=e.target.closest('[data-unpinb]');if(ub){e.stopPropagation();const [c,t]=ub.dataset.unpinb.split('|');unpinRemoteBranch(c,t);return}
  const pbr=e.target.closest('[data-pinb]');if(pbr){const [c,t]=pbr.dataset.pinb.split('|');openPinnedBranch(c,t);return}
  const sh=e.target.closest('[data-showhid]');if(sh){e.stopPropagation();conv.ui.showHidden=!conv.ui.showHidden;if(!conv.ui.showHidden)delete conv.ui.showHidden;refreshAll();return}
  const uv=e.target.closest('[data-usev]');if(uv){e.stopPropagation();useVersion(uv.dataset.usev);return}
  const vc=e.target.closest('[data-vers]');if(vc){e.stopPropagation();openVersions(vc.dataset.vers);return}
  const mf=e.target.closest('[data-mmfix]');if(mf){const box=mf.closest('.mermaid-box'),pane=mf.closest('.pane[data-tid]'),ta=pane&&pane.querySelector('.composer textarea');
    if(ta){ta.value=`The diagram that starts “${trunc((mermaidSrc.get(box)||'').trim().split('\n')[0],40)}” has a syntax error and can’t be drawn:\n${box.dataset.err||''}\nPlease send a corrected version of just that diagram.`;autosize(ta);updateComposer(pane.dataset.tid);ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length)}return}
  // the PDF's "Page N": click to type a page and jump there (Enter), Esc or clicking away to leave it
  const gp=e.target.closest('[data-gopage]');if(gp){e.stopPropagation();
    const inp=document.createElement('input');inp.className='pgin';inp.type='number';inp.min=1;inp.max=state.docState.n;inp.value=docView.current;inp.setAttribute('aria-label','Page number');
    const lbl=document.createTextNode('Page ');gp.replaceWith(lbl,inp);inp.focus();inp.select();
    let done=false;const end=go=>{if(done)return;done=true;const n=Math.round(+inp.value);inp.remove();lbl.remove();updateDocHeader();if(go&&n>=1)goToPage(Math.min(n,state.docState.n))};
    inp.addEventListener('keydown',ev=>{ev.stopPropagation();if(ev.key==='Enter'){ev.preventDefault();end(true)}else if(ev.key==='Escape'){ev.preventDefault();end(false)}});
    inp.addEventListener('blur',()=>end(false));return}
  const kb=e.target.closest('[data-cardsconv]');if(kb){e.stopPropagation();const id=kb.dataset.cardsconv;(async()=>{if(!conv||conv.id!==id)await openConv(id);if(conv&&conv.id===id){if(innerWidth<760)$('#app').classList.remove('sideopen');openCards('conv')}})();return}
  const ci=e.target.closest('[data-conv]');if(ci&&ci.classList.contains('renaming'))return;
  if(ci&&(e.ctrlKey||e.metaKey)&&ci.matches('.citem')&&!e.target.closest('.acts')){openWindow(ci.dataset.conv);return}
  if(ci){BACK.length=0;renderBack();openConv(ci.dataset.conv);if(innerWidth<760)$('#app').classList.remove('sideopen');$('#app').classList.remove('zenside');return}
});
// ⌘/Ctrl-click or middle-click a conversation in the sidebar: open it in a new window (#c=ID)
function openWindow(id){window.open(location.pathname+location.search+'#c='+encodeURIComponent(id),'_blank','noopener')}
document.addEventListener('auxclick',e=>{const ci=e.button===1&&!e.target.closest('.acts')&&e.target.closest('.citem[data-conv]');if(ci&&!ci.classList.contains('renaming')){e.preventDefault();openWindow(ci.dataset.conv)}});
document.addEventListener('mouseover',e=>{
  document.querySelectorAll('.pane.hl').forEach(p=>p.classList.remove('hl'));
  document.querySelectorAll('.anchor.hot,sup.fn.hot').forEach(p=>p.classList.remove('hot'));
  const a=e.target.closest('.anchor,.bchip,sup.fn');
  if(a&&!a.closest('.cnode')){const p=paneEls.get(a.dataset.tid);p&&p.classList.add('hl');return}
  const o=e.target.closest('[data-back],.origin,[data-act="back"]');
  if(o&&o.closest('.pane')){const tid=o.closest('.pane').dataset.tid;document.querySelectorAll(`.anchor[data-tid="${qid(tid)}"],sup.fn[data-tid="${qid(tid)}"]`).forEach(s=>s.classList.add('hot'))}
});

/* ---------- confirm dialog ---------- */
let modalOk=null;
let modalCancel=null;
function askConfirm(title,html,onOk,o={}){
  if(modalCancel){const f=modalCancel;modalCancel=null;f()}   // (one still open: it's answered as cancelled)
  $('#mTitle').textContent=title;$('#mBody').innerHTML=html;modalOk=onOk;modalCancel=o.onCancel||null;$('#mCancel').textContent=o.cancel||'Cancel';hideTip();$('#mOk').textContent=o.ok||'Delete';$('#mOk').disabled=false;$('#mOk').className='mbtn '+(o.kind||'danger');$('#modal .mbox').classList.toggle('wide',!!o.wide);
  $('#modal').classList.add('show');setTimeout(()=>$('#mOk').focus(),20);
}
function closeModal(){$('#modal').classList.remove('show');modalOk=null;const f=modalCancel;modalCancel=null;f&&f()}
$('#mCancel').onclick=closeModal;
$('#mOk').onclick=()=>{const f=modalOk;modalCancel=null;closeModal();f&&f()};
$('#modal').addEventListener('mousedown',e=>{if(e.target.id==='modal')closeModal()});
$('#modal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeModal()}});
function confirmDeleteBranch(tid){
  const t=T(tid);if(!t||!t.parent)return;
  const sub=Object.keys(conv.threads).filter(x=>isDesc(x,tid));
  const all=[tid,...sub];
  const msgs=all.reduce((n,k)=>n+(conv.order[k]||[]).filter(id=>conv.msgs[id]&&conv.msgs[id].role==='user').length,0);
  const notes=Object.values(conv.msgs).filter(m=>m.role==='note'&&all.includes(m.fromThread)).length;
  let html=`<b>${esc(t.title)}</b> will be permanently deleted`;
  html+=sub.length?`, along with <b>${sub.length} sub-branch${sub.length===1?'':'es'}</b> branched from it:`:'.';
  if(sub.length)html+='<ul>'+sub.slice(0,6).map(x=>`<li>${esc(T(x).title)}</li>`).join('')+(sub.length>6?`<li>and ${sub.length-6} more</li>`:'')+'</ul>';
  html+=`<div style="margin-top:8px">That's ${msgs} question${msgs===1?'':'s'} and their answers.${notes?` Takeaways already added to a parent stay, labeled as from a deleted branch.`:''}</div>`;
  const cards=[...CARDS.values()].filter(c=>c.conv===conv.id&&(all.includes(c.thread)||(c.at&&all.includes(c.at.thread))));
  if(cards.length)html+=cardsChoice(cards,sub.length?'their':'its')+`<div class="kdnote">Unticked, they stay in your review, but they can’t take you back to where they came from any more.</div>`;
  askConfirm(sub.length?'Delete branch and its sub-branches?':'Delete branch?',html,()=>{const drop=!!($('#kdDrop')||{}).checked;deleteBranch(tid);if(drop){for(const c of cards)dropCard(c.id);toast(`Branch deleted, with ${cards.length} flashcard${cards.length>1?'s':''}`)}});
}

/* ---------- tooltips ---------- */
const tipbox=$('#tipbox');let tipFor=null,tipTimer=0;
function hideTip(){clearTimeout(tipTimer);tipbox.classList.remove('show');tipFor=null}
// the element whose tooltip applies at this point (converts title= to data-tip= so the browser's own tooltip stays away)
function tipTarget(from){
  const el=from&&from.closest('[title],[data-tip]');if(!el)return null;
  if(el.hasAttribute('title')){const t=el.getAttribute('title');el.removeAttribute('title');if(t)el.dataset.tip=t;else delete el.dataset.tip}
  if(!el.dataset.tip)return null;
  if('clip' in el.dataset){const t=el.querySelector('.t')||el;if(t.scrollWidth<=t.clientWidth+1)return null}   // data-clip: only when the title (.t) is cut off
  return el;
}
function showTip(el){
  if(tipHeld)return;
  if(!el.isConnected){   // re-rendered while we waited: use whatever now sits under the pointer
    const h=[...document.querySelectorAll(':hover')].pop();el=tipTarget(h);if(!el)return;tipFor=el;
  }
  tipbox.textContent=el.dataset.tip;tipbox.classList.add('show');
  const r=el.getBoundingClientRect(),w=tipbox.offsetWidth,h=tipbox.offsetHeight;
  let top=r.bottom+8;if(top+h>innerHeight-6)top=r.top-h-8;
  const left=Math.min(Math.max(6,r.left+r.width/2-w/2),innerWidth-w-6);
  tipbox.style.left=left+'px';tipbox.style.top=Math.max(6,top)+'px';
}
let tipHeld=false;   // a button is down (dragging a card, resizing, selecting): no tooltips until it's let go
document.addEventListener('mouseover',e=>{
  if(tipHeld||e.buttons)return;
  const el=e.target.closest('[title],[data-tip]');
  if(el===tipFor)return;
  hideTip();if(!el||!tipTarget(el))return;
  tipFor=el;tipTimer=setTimeout(()=>showTip(el),380);
});
// pointerdown too: a drag that calls preventDefault on it (canvas cards) never sends mousedown
for(const t of ['mousedown','pointerdown'])document.addEventListener(t,()=>{tipHeld=true;hideTip()},true);
for(const t of ['pointerup','pointercancel','mouseup'])addEventListener(t,()=>{tipHeld=false},true);
document.addEventListener('scroll',hideTip,true);
document.addEventListener('mouseleave',hideTip);

/* ---------- top bar ---------- */
$('#tSide').innerHTML=ic('side');$('#logo').innerHTML=`<svg class="i logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 20.5C8 16 12 12 15 4.8"/><path class="a" d="M10.6 13.7c3-.4 5.7.3 8.9 2"/><path class="a" d="M15.2 14c1.1-1.6 2.7-2.6 5-3.1"/><circle class="fi" cx="15.2" cy="4.3" r="1.9"/><circle class="fa" cx="19.8" cy="15.9" r="1.7"/><circle class="fa" cx="20.4" cy="10.5" r="1.4"/></svg>`;   // the Digress mark (web/icon.svg)
$('#cFilt').addEventListener('click',e=>{const b=e.target.closest('[data-cf]');if(!b)return;e.stopPropagation();SIDEBAR_MOD.convFilt=b.dataset.cf;try{localStorage.setItem('digress:cfilt',SIDEBAR_MOD.convFilt)}catch(e){}renderConvList()});
$('#backChip .bi').innerHTML=ic('back');
$('#backGo').addEventListener('click',goBack);$('#backX').addEventListener('click',()=>{BACK.length=0;renderBack()});
// How it works: closed until opened; remembered on this device
{const h=$('#help');h.querySelector('.chev').innerHTML=ic('back').replace('class="i"','class="i" style="width:12px;height:12px;transform:rotate(180deg)"');
  try{h.open=localStorage.getItem('digress:help')==='1'}catch(e){}
  h.addEventListener('toggle',()=>{try{localStorage.setItem('digress:help',h.open?'1':'0')}catch(e){}})}
$('#archToggle').querySelector('.chev').innerHTML=ic('back').replace('class="i"','class="i" style="width:12px;height:12px;transform:rotate(180deg)"');
$('#treeAll').onclick=treeAll;
$('#newFolder').innerHTML=ic('plus')+'<span>New folder</span>';$('#newFolder').onclick=(e)=>{e.stopPropagation();newFolderDialog(conv&&!isBlank(conv)&&!conv.folder?[conv.id]:[])};
// Pinned / Conversations fold (this device remembers which)
let sideFold={};try{sideFold=JSON.parse(localStorage.getItem('sq:fold')||'{}')||{}}catch(e){}
for(const w of document.querySelectorAll('.sfoldw')){const k=w.dataset.fold,b=w.querySelector('.sfold');
  b.querySelector('.chev').innerHTML=$('#archToggle').querySelector('.chev').innerHTML;w.classList.toggle('folded',!!sideFold[k]);b.setAttribute('aria-expanded',String(!sideFold[k]));
  b.onclick=()=>{sideFold[k]=!sideFold[k];w.classList.toggle('folded',sideFold[k]);b.setAttribute('aria-expanded',String(!sideFold[k]));try{localStorage.setItem('sq:fold',JSON.stringify(sideFold))}catch(e){}}}
$('#archToggle').onclick=()=>{SIDEBAR_MOD.archOpen=!SIDEBAR_MOD.archOpen;try{localStorage.setItem('sq:arch',SIDEBAR_MOD.archOpen?'1':'')}catch(e){}renderConvList()};
$('#trashToggle').querySelector('.chev').innerHTML=$('#archToggle').querySelector('.chev').innerHTML;
$('#trashToggle').onclick=()=>{SIDEBAR_MOD.trashOpen=!SIDEBAR_MOD.trashOpen;try{localStorage.setItem('digress:trash',SIDEBAR_MOD.trashOpen?'1':'')}catch(e){}renderConvList()};
$('#newConv').innerHTML=ic('plus')+'New conversation';$('#actBtn').innerHTML=ic('activity')+'Activity';$('#promptsBtn').innerHTML=ic('tune');$('#skillT .wi').outerHTML=ic('tune');$('#newDoc').innerHTML=ic('doc')+'New from a document';$('#newDoc').onclick=openDocModal;
['cols','rows','canvas'].forEach(v=>{document.querySelector(`[data-v="${v}"] span`).outerHTML=ic(v)});
const mSel=$('#mSel'),eSel=$('#eSel'),webT=$('#webT');
MODELS.forEach(([v,l])=>mSel.add(new Option(l,v)));EFFORTS.forEach(([v,l])=>eSel.add(new Option(l,v)));
function fillModelPicker(){
  const list=io.llm?io.llm.models():MODELS;mSel.replaceChildren();list.forEach(([v,l])=>mSel.add(new Option(l,v)));
  applyConvLlm();syncPick();
  eSel.closest('.sel').style.display=io.llm&&io.llm.supportsEffort?'':'none';
  webT.style.display=io.llm&&io.llm.supportsWeb?'':'none';
}
webT.querySelector('.wi').outerHTML=ic('globe');
/* theme menu: hovering a theme previews it, clicking keeps it (the menu stays open to try others) */
// Zen (per window, kept across reloads in sessionStorage): only the panes. Selecting, branching and Back work as
// usual; the tab at the top of the screen (#zenX), the Zen button or ⌘/Ctrl+. switch it.
let zen=false;
function setZen(on){
  zen=!!on;$('#app').classList.toggle('zen',zen);$('#app').classList.remove('zenside');$('#zenB').setAttribute('aria-pressed',String(zen));$('#zenB').classList.toggle('on',zen);
  try{if(zen)sessionStorage.setItem('digress:zen','1');else sessionStorage.removeItem('digress:zen')}catch(e){}
  closeMore();if(themeMenu.classList.contains('open'))themeMenu.classList.remove('open');
}
$('#zenB').innerHTML=ic('zen')+'<b class="mlbl">Zen</b>';$('#zenB').onclick=()=>setZen(!zen);$('#zenX').onclick=()=>setZen(false);
$('#zenS').innerHTML=ic('side');$('#zenS').onclick=()=>$('#app').classList.add('zenside');
const zenSideAway=()=>$('#app').classList.remove('zenside');
document.addEventListener('pointerdown',e=>{if(zen&&$('#app').classList.contains('zenside')&&!e.target.closest('#side,#zenS'))zenSideAway()},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&zen&&$('#app').classList.contains('zenside'))zenSideAway()});
/* ---------- installed as an app (Install app on Android; manifest.webmanifest) ---------- */
// installed: opened from the home screen in its own window, not in a browser tab
const installedApp=()=>matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches;
/* Android's back gesture, in the installed app. A browser tab goes back a page; here that would close the app.
   So back closes whatever is open on top (a dialog, a menu, search, flashcards, the sidebar, the branch popup),
   never a pane or anything you'd lose; with nothing open, the first back says how to leave and only a second
   one, right after, closes the app. It works by keeping one extra history entry (BACK_GUARD) on top. */
const BACK_GUARD={digressBack:1},BACK_AGAIN_MS=2500;
function closeTopmost(){
  const lb=document.querySelector('.lightbox');if(lb){lb.click();return true}
  if($('#modal').classList.contains('show')){closeModal();return true}
  if($('#docModal').classList.contains('show')){closeDocModal();return true}
  if($('#pal').classList.contains('show')){closePalette();return true}
  if(themeMenu.classList.contains('open')){closeThemes();return true}
  if(modelsOpen()){closeModels();return true}
  if(connModal.classList.contains('show')){closeConnections();return true}
  if(moreMenu.classList.contains('open')){closeMore();return true}
  const vw=$('#cvViews');if(vw&&vw.classList.contains('open')){closeViews();return true}
  if(SIDEBAR_MOD.brPop){closeBrList();return true}
  if(closeReplyMenu())return true;
  if(closeUsage())return true;
  if(closeFolderMenu())return true;
  if(pop.classList.contains('show')){hidePop();return true}
  if(document.querySelector('.docpane.snipping')){setSnip(false);return true}
  if($('#cardsModal').classList.contains('show')){closeCards();return true}
  if(closeSkillMenu())return true;
  if($('#promptsPage').classList.contains('show')){closePrompts();return true}
  if($('#activity').classList.contains('show')){closeActivity();return true}
  if($('#guide').classList.contains('open')){closeGuide();return true}
  if(keysOpen()){closeKeys();return true}
  const app=$('#app');
  if(app.classList.contains('zenside')){zenSideAway();return true}
  if(app.classList.contains('sideopen')){app.classList.remove('sideopen');return true}
  if(state.hitSticky){clearHit();return true}
  return false;
}
let backArmed=0;
function guardBack(){if(!installedApp())return;if(!(history.state&&history.state.digressBack))history.pushState(BACK_GUARD,'',location.href)}
addEventListener('popstate',()=>{
  if(!installedApp())return;
  showInUrl();   // the entry under the guard may name the conversation you had open before; keep this one
  if(closeTopmost()){guardBack();return}
  if(Date.now()-backArmed<BACK_AGAIN_MS)return;   // never armed this time round: the guard is already gone
  // nothing open: say so, and leave the guard off for a moment, so a second back closes the app
  backArmed=Date.now();toast('Swipe back again to leave Digress');
  setTimeout(()=>{if(Date.now()-backArmed>=BACK_AGAIN_MS-50)guardBack()},BACK_AGAIN_MS);
});
/* Ask about Digress (the ? beside How it works): a one-off chat with Digress's own documentation in its system
   prompt (GET api/guide, the files listed in GUIDE_DOCS in server.mjs). Kept only in this page's memory: never
   saved, never in a conversation, gone on reload. It uses the model picked in the top bar. */
const GUIDE={msgs:[],docs:null,busy:null};
function openGuide(){
  const g=$('#guide');g.classList.add('open');renderGuide();setTimeout(()=>$('#guideIn').focus(),30);
}
function closeGuide(){$('#guide').classList.remove('open');if(GUIDE.busy)GUIDE.busy.stop()}
function renderGuide(){
  const box=$('#guideMsgs');box.innerHTML='';
  if(!GUIDE.msgs.length){
    const e=document.createElement('div');e.className='gempty';e.textContent='Ask anything about how Digress works: branches, documents, search, flashcards, phones, where things are saved.';box.appendChild(e);
    const c=document.createElement('div');c.className='gchips';
    for(const q of PROMPTS.guide.chips){const b=document.createElement('button');b.className='chip';b.textContent=q;b.onclick=()=>askGuide(q);c.appendChild(b)}
    box.appendChild(c);
  }
  for(const m of GUIDE.msgs){
    const d=document.createElement('div');d.className='gm '+(m.role==='user'?'u':'a')+(m.error?' err':'')+(m.pending&&!m.content?' wait':'');
    if(m.role==='user'){const t=document.createElement('div');t.textContent=m.content;d.appendChild(t)}
    else if(m.error)d.textContent=(m.content?m.content+'\n\n':'')+m.error;
    else renderRich(d,m.content||'',!m.pending);
    box.appendChild(d);m.el=d;
  }
  syncGuideSend();
}
function syncGuideSend(){const b=$('#guideSend');b.innerHTML=GUIDE.busy?ic('stop'):ic('send');b.title=GUIDE.busy?'Stop':'Send';b.disabled=!GUIDE.busy&&!$('#guideIn').value.trim()}
async function askGuide(q){
  q=(q||'').trim();if(!q||GUIDE.busy)return;
  await io.ready;
  if(!io.llm||!io.llm.ready||!(await io.llm.ready().catch(()=>false))){toast('Ask about Digress needs a model, and none is connected.');return}
  const ta=$('#guideIn');ta.value='';autosize(ta);
  const box=$('#guideMsgs'),stick=()=>{box.scrollTop=box.scrollHeight};
  GUIDE.msgs.push({role:'user',content:q});const a={role:'assistant',content:'',pending:true};GUIDE.msgs.push(a);
  const ctrl=new AbortController(),run=runId();let stopped=false;
  GUIDE.busy={stop:()=>{stopped=true;io.llm.stop&&io.llm.stop(run).catch(()=>{});ctrl.abort()}};
  renderGuide();stick();
  try{
    if(!GUIDE.docs){const r=await fetch('api/guide');if(!r.ok)throw {message:'Couldn’t load Digress’s documentation from the server.'};GUIDE.docs=(await r.json()).docs||[]}
    let raf=0;
    const r=await io.llm.complete({system:PROMPTS.guide.system(GUIDE.docs),
      messages:GUIDE.msgs.filter(m=>m!==a&&!m.error).map(m=>({role:m.role,content:m.content})),
      model:settings.model,effort:'low',web:false,signal:ctrl.signal,run,
      onText:(t)=>{a.content=t;if(!raf)raf=requestAnimationFrame(()=>{raf=0;if(a.el&&a.el.isConnected){a.el.classList.remove('wait');renderRich(a.el,a.content,false);stick()}})}});
    a.content=r.text;
  }catch(e){
    if(e&&e.text)a.content=e.text;
    a.error=stopped||ctrl.signal.aborted?'Stopped.':(e&&e.message)||'Something went wrong.';
  }
  a.pending=false;GUIDE.busy=null;
  if($('#guide').classList.contains('open')){renderGuide();stick()}
}
$('#guideB').onclick=(e)=>{e.preventDefault();e.stopPropagation();$('#guide').classList.contains('open')?closeGuide():openGuide()};
$('#guideX').innerHTML=ic('x');$('#guideX').onclick=closeGuide;
$('#guideNew').innerHTML=ic('retry');$('#guideNew').onclick=()=>{if(GUIDE.busy)GUIDE.busy.stop();GUIDE.msgs=[];renderGuide();$('#guideIn').focus()};
$('#guideIn').addEventListener('input',()=>{autosize($('#guideIn'));syncGuideSend()});
$('#guideIn').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();askGuide($('#guideIn').value)}});
$('#guideSend').onclick=()=>{if(GUIDE.busy)GUIDE.busy.stop();else askGuide($('#guideIn').value)};
$('#guide').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeGuide()}});
const themeB=$('#themeB');themeB.innerHTML=ic('palette')+'<b class="mlbl">Appearance</b>';
const themeMenu=document.createElement('div');themeMenu.className='thmenu thapp';themeMenu.setAttribute('role','menu');themeMenu.innerHTML='<div class="thh">Appearance</div>';
const sw=(id)=>`<span class="thsw" data-theme="${id}"><i></i><i></i><i></i></span>`;
// a section: its header (folds the list; folded, it shows a dot per choice and which one is picked) and its list
function themeGroup(g,name,items,dot){
  const h=document.createElement('button');h.className='thgrp';h.dataset.g=g;h.setAttribute('aria-expanded','false');
  h.innerHTML=`<span class="chev">${ic('chev')}</span><span class="thgn"></span><span class="thcur"></span><span class="thmini">${items.map(dot).join('')}</span>`;
  h.querySelector('.thgn').textContent=name;
  const list=document.createElement('div');list.className='thlist';list.setAttribute('role','group');
  themeMenu.append(h,list);return list;
}
const themeButton=(id,name)=>{const b=document.createElement('button');b.dataset.theme=id;b.setAttribute('role','menuitemradio');
  b.innerHTML=(id==='system'?`<span class="thsys">${sw('light')}${sw('dark')}</span>`:sw(id))+`<span></span><span class="ck">${ic('check')}</span>`;
  b.children[1].textContent=name;return b};
themeMenu.appendChild(themeButton('system',THEMES[0][1]));
for(const [mode,label] of [['light','Light'],['dark','Dark']]){
  const ts=THEMES.filter(t=>t[2]===mode),list=themeGroup(mode,label,ts,([id])=>`<span class="thsw thdot" data-theme="${id}"></span>`);
  for(const [id,name] of ts)list.appendChild(themeButton(id,name));
}
const pdfList=themeGroup('pdf','PDF pages',PDF_LOOKS,([id])=>`<span class="pdsw thdot" data-p="${id}"></span>`);
for(const [id,name] of PDF_LOOKS){
  const b=document.createElement('button');b.dataset.pdf=id;b.setAttribute('role','menuitemradio');
  b.title={original:'As the PDF is printed',match:'Dark pages with a dark theme, as printed with a light one',dark:'Light text on dark pages (pictures look like negatives)',dim:'Less bright, colors unchanged',sepia:'Warm paper'}[id];
  b.innerHTML=`<span class="pdsw" data-p="${id}">Aa</span><span></span><span class="ck">${ic('check')}</span>`;b.children[1].textContent=name;pdfList.appendChild(b);
}
const FONT_TIPS={default:'Sans for the app, serif for replies',sans:'Inter everywhere, replies too',serif:'Source Serif everywhere, the app too',system:'Your device’s own font',mono:'JetBrains Mono everywhere',
  lexend:'Lexend: made to make reading easier, often suggested for dyslexia',atkinson:'Atkinson Hyperlegible: letters that are hard to mistake for each other (I l 1, O 0)',literata:'Literata for replies (made for reading books on screens), Inter for the app',newsreader:'Newsreader for replies (a calm newspaper serif), Inter for the app',
  plex:'IBM Plex: Plex Sans for the app, Plex Serif for replies',inclusive:'Inclusive Sans: clear letter shapes, designed for accessibility',sourcesans:'Source Sans: a plain, open sans-serif, the app and replies alike',
  comicneue:'Comic Neue: a cleaned-up Comic Sans; some dyslexic readers find this style easiest'};
const fontList=themeGroup('font','Font',FONTS,([id])=>`<span class="fnsw thdot" data-f="${id}"></span>`);
for(const [id,name] of FONTS){
  const b=document.createElement('button');b.dataset.font=id;b.setAttribute('role','menuitemradio');b.title=FONT_TIPS[id]||'';
  b.innerHTML=`<span class="fnsw" data-f="${id}">Aa</span><span></span><span class="ck">${ic('check')}</span>`;b.children[1].textContent=name;fontList.appendChild(b);
}
// one switch below the sections: the lines from a branch's pane to where it came from (Columns and Rows;
// the canvas keeps its own lines). On unless turned off; kept on this device with the theme.
const wireRow=document.createElement('button');wireRow.className='thwire';wireRow.dataset.wires='';wireRow.setAttribute('role','menuitemcheckbox');
wireRow.title='The lines from each branch’s pane to where it came from, in Columns and Rows (the canvas always shows its own)';
wireRow.innerHTML=`${ic('branch')}<span>Lines between panes</span><span class="ck">${ic('check')}</span>`;themeMenu.appendChild(wireRow);
function setWires(on,keep){$('#app').classList.toggle('nowires',!on);wireRow.setAttribute('aria-checked',on?'true':'false');
  if(keep){settings.wires=on;saveSettings()}if(on)wiresSoon()}
setWires(settings.wires!==false);
// and one action: fit this conversation to this screen. Pane widths set by dragging go back to sharing the
// window, each pane's zoom (the PDF's too) back to 100%, and on the canvas each card's own zoom; the canvas fits the tree
const fitRow=document.createElement('button');fitRow.className='thfit';fitRow.dataset.fitscreen='';fitRow.setAttribute('role','menuitem');
fitRow.title='Undo the pane widths and zoom levels in this conversation, so it fits this screen (after a bigger screen, say)';
fitRow.innerHTML=`${ic('fit')}<span>Fit to this screen</span>`;themeMenu.appendChild(fitRow);
function fitScreen(){
  if(!conv)return;const u=conv.ui;
  u.sizes={};for(const t of Object.keys(u.pz||{}))setPaneZoom(t,1);
  if(u.cv)delete u.cv.cz;
  if(u.view==='canvas'){renderCanvas();fitCanvas()}else layout();
  save();setStatus('Fitted to this screen');
}
document.body.appendChild(themeMenu);
// each folded header names the choice in it ("Nord"), so you can see what's picked without opening it
function themeHeads(){
  for(const h of themeMenu.querySelectorAll('.thgrp')){
    const ck=h.nextElementSibling.querySelector('button[aria-checked=true]');h.querySelector('.thcur').textContent=ck?ck.children[1].textContent:'';
  }
}
// opened, the section holding the current theme is unfolded and the others folded, so the menu stays short;
// it fits under its button or, short of room (a phone, or opened from ⋯), moves up and scrolls inside
function placeThemes(){
  const r=themeB.getBoundingClientRect(),vh=(window.visualViewport?visualViewport.height:innerHeight);
  themeMenu.style.maxHeight=(vh-16)+'px';
  const h=themeMenu.offsetHeight;
  themeMenu.style.top=Math.max(8,Math.min(r.bottom+6,vh-h-8))+'px';
  themeMenu.style.left=Math.max(8,Math.min(innerWidth-themeMenu.offsetWidth-8,r.right-themeMenu.offsetWidth))+'px';
}
function setPdfLook(id,keep){applyPdfLook(id);if(keep){settings.pdf=document.documentElement.dataset.pdf;saveSettings();themeMenu.querySelectorAll('button[data-pdf]').forEach(b=>b.setAttribute('aria-checked',b.dataset.pdf===settings.pdf?'true':'false'));themeHeads()}}
setPdfLook(settings.pdf||'original',true);
function setFont(id,keep){applyFont(id);if(keep){settings.font=document.documentElement.dataset.font;saveSettings();themeMenu.querySelectorAll('button[data-font]').forEach(b=>b.setAttribute('aria-checked',b.dataset.font===settings.font?'true':'false'));themeHeads()}}
setFont(settings.font||'default',true);
function setTheme(id,keep){
  const was=document.documentElement.dataset.theme;id=applyTheme(id);
  if(keep){settings.theme=id;saveSettings();themeMenu.querySelectorAll('button[data-theme]').forEach(b=>b.setAttribute('aria-checked',b.dataset.theme===settings.theme?'true':'false'));themeHeads()}
  if(document.documentElement.dataset.theme!==was&&isMermaidOk()){mermaidTheme();document.querySelectorAll('.mermaid-box[data-done]').forEach(b=>b.removeAttribute('data-done'));renderMermaid(document)}
}
setTheme(settings.theme,true);
function closeThemes(){if(!themeMenu.classList.contains('open'))return;themeMenu.classList.remove('open');themeB.setAttribute('aria-expanded','false');setTheme(settings.theme);setPdfLook(settings.pdf);setFont(settings.font)}
themeB.onclick=(e)=>{e.stopPropagation();if(themeMenu.classList.contains('open'))return closeThemes();
  const cur=THEMES.find(t=>t[0]===settings.theme),g=cur&&cur[2]!=='auto'?cur[2]:document.documentElement.dataset.mode;
  for(const h of themeMenu.querySelectorAll('.thgrp'))h.setAttribute('aria-expanded',h.dataset.g===g?'true':'false');
  themeMenu.classList.add('open');themeB.setAttribute('aria-expanded','true');themeMenu.scrollTop=0;placeThemes()};
// hovering previews (a theme, or how PDF pages look); leaving puts back what's chosen; clicking keeps it
// anything else in the menu (a section's header, the gaps, the rows below) shows what's chosen again, so a preview
// doesn't stay on after the pointer has moved off its row
const unpreview=()=>{setTheme(settings.theme);setPdfLook(settings.pdf);setFont(settings.font)};
themeMenu.addEventListener('mouseover',e=>{const b=e.target.closest('button[data-theme],button[data-pdf],button[data-font]');if(!b)return unpreview();
  if(b.dataset.font){setTheme(settings.theme);setPdfLook(settings.pdf);setFont(b.dataset.font);return}setFont(settings.font);if(b.dataset.pdf){setTheme(settings.theme);setPdfLook(b.dataset.pdf)}else{setTheme(b.dataset.theme);setPdfLook(settings.pdf)}});
themeMenu.addEventListener('mouseleave',unpreview);
themeMenu.addEventListener('click',e=>{e.stopPropagation();
  const h=e.target.closest('.thgrp');
  if(h){h.setAttribute('aria-expanded',h.getAttribute('aria-expanded')==='true'?'false':'true');placeThemes();
    if(h.getAttribute('aria-expanded')==='true'){const l=h.nextElementSibling;if(l.getBoundingClientRect().bottom>themeMenu.getBoundingClientRect().bottom)h.scrollIntoView({block:'start',behavior:'smooth'})}return}
  if(e.target.closest('button[data-wires]'))return setWires(settings.wires===false,true);
  if(e.target.closest('button[data-fitscreen]')){closeThemes();return fitScreen()}
  const b=e.target.closest('button[data-theme],button[data-pdf],button[data-font]');if(!b)return;if(b.dataset.font)setFont(b.dataset.font,true);else if(b.dataset.pdf)setPdfLook(b.dataset.pdf,true);else setTheme(b.dataset.theme,true)});
document.addEventListener('click',closeThemes);
addEventListener('keydown',e=>{if(e.key==='Escape'&&themeMenu.classList.contains('open')){e.stopPropagation();closeThemes()}},true);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(settings.theme==='system')setTheme('system')});
/* The top bar keeps what fits. The rest moves, in this order, into the "more" menu (⋯): the same controls,
   moved, not copied, so they keep working the same way. Rechecked whenever the bar's size or contents change. */
const topBar=$('.top'),moreB=$('#moreB'),moreMenu=document.createElement('div');moreMenu.className='tmore';moreMenu.setAttribute('role','menu');document.body.appendChild(moreMenu);
moreB.innerHTML=ic('dots');
const TOP_MOVABLE=[$('#resetOrder'),$('#zenB'),themeB,$('#skillT'),webT,eSel.closest('.sel'),$('#viewSeg'),mSel.closest('.sel')];
const MENU_ORDER=new Map([[mSel.closest('.sel'),0],[eSel.closest('.sel'),1],[webT,2],[$('#skillT'),3],[$('#viewSeg'),4],[themeB,5],[$('#zenB'),6],[$('#resetOrder'),7]]);
for(const el of TOP_MOVABLE){el.__home=document.createComment('');el.before(el.__home)}
let fitting=false;
function fitTop(){
  if(fitting)return;fitting=true;
  try{
    for(const el of TOP_MOVABLE)if(el.parentNode!==topBar)el.__home.after(el);
    moreB.style.display='';
    const over=()=>topBar.scrollWidth>topBar.clientWidth+1;
    const moved=[];
    for(const el of TOP_MOVABLE){if(!over())break;if(el.style.display==='none')continue;moreMenu.appendChild(el);moved.push(el)}
    moved.sort((a,b)=>MENU_ORDER.get(a)-MENU_ORDER.get(b)).forEach(el=>moreMenu.appendChild(el));
    moreB.style.display=moved.length?'':'none';
    if(!moved.length)closeMore();
  }finally{fitting=false;if(typeof topObs!=='undefined')topObs.takeRecords()}   // its own moves aren't a reason to run again
}
function closeMore(){moreMenu.classList.remove('open');moreB.setAttribute('aria-expanded','false')}
moreB.onclick=(e)=>{e.stopPropagation();if(moreMenu.classList.contains('open'))return closeMore();
  moreMenu.classList.add('open');moreB.setAttribute('aria-expanded','true');const r=moreB.getBoundingClientRect();
  moreMenu.style.top=(r.bottom+6)+'px';moreMenu.style.left=Math.max(8,Math.min(innerWidth-moreMenu.offsetWidth-8,r.right-moreMenu.offsetWidth))+'px'};
document.addEventListener('click',e=>{if(moreMenu.classList.contains('open')&&!moreMenu.contains(e.target)&&!themeMenu.contains(e.target))closeMore()});
addEventListener('keydown',e=>{if(e.key==='Escape'&&moreMenu.classList.contains('open')&&!themeMenu.classList.contains('open')){closeMore()}});
new ResizeObserver(()=>fitTop()).observe(topBar);
const topObs=new MutationObserver(()=>fitTop());topObs.observe(topBar,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class'],characterData:true});
function showWeb(){webT.setAttribute('aria-pressed',settings.web?'true':'false');webT.classList.toggle('on',!!settings.web)}
showWeb();
webT.onclick=()=>{settings.web=!settings.web;saveSettings();showWeb();setStatus(settings.web?'Web search on for new replies':'Web search off')};
mSel.value=settings.model;eSel.value=settings.effort;if(!mSel.value)mSel.value=settings.model='auto';if(!eSel.value)eSel.value=settings.effort='auto';
/* Each conversation keeps its model and effort (conv.llm = [model, effort], synced; an array so a merge takes one
   side's pair whole). It's the actual model, never "Default", so changing the default later doesn't switch old
   conversations. Set by the first question, or by changing the picker while the conversation is open; opening it
   puts the picker back to it. Older conversations use their latest reply's model. A new one starts at Default.
   A model that isn't offered right now (signed out of ChatGPT) leaves the picker on Default without forgetting
   it. Web is not kept: it's off until turned on, every time. */
let llmMissing=null,llmSub=null,llmMissSaid='',pickerFor=null;
const modelsKnown=()=>!!io.llm&&io.llm.models().length>1;
const resolvedModel=()=>settings.model!=='auto'?settings.model:(io.llm&&io.llm.defaultModel)||'auto';
function convLlm(c){
  if(Array.isArray(c.llm))return c.llm;
  const last=Object.values(c.msgs).filter(m=>m.role==='assistant'&&m.model&&!m.pending).sort((a,b)=>(b.ts||0)-(a.ts||0))[0];
  return last?[typeof last.model==='string'?last.model:'',last.effort||'auto',true]:null;
}
/* A model per branch: a thread asks with its own model (t.llm, the same [model, effort] pair; main's is conv.llm),
   else the one of the thread it branched from, up to main. It's stamped on the thread's first question, so a branch
   keeps its model even if its parent switches later. The picker shows and changes the model of the thread you're
   in (the pane last used; on the canvas, the selected card). */
const llmTid=(tid)=>!tid||tid==='doc'||!conv||!T(tid)?'main':tid;
function threadLlm(tid){
  let t=T(llmTid(tid)),n=0;
  while(t&&t.id!=='main'&&n++<500){if(Array.isArray(t.llm))return t.llm;t=T(t.parent)||T('main')}
  return convLlm(conv);
}
const ownLlm=(tid)=>{tid=llmTid(tid);return tid==='main'?conv.llm:T(tid).llm};
const pickerTid=()=>!conv?'main':llmTid(conv.ui.view==='canvas'?cvState().sel:curPane());
// a model that isn't offered here (another provider, signed out, retired): the newest of the same kind (another Opus,
// another GPT Sol), else the same family (Claude or GPT), else Default
const modelTier=(id)=>String(id||'').toLowerCase().replace(/[\d.]+/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'');
function closestModel(id,ids){const tier=modelTier(id),fam=MODEL_FAM(id);return ids.find(x=>modelTier(x)===tier)||(fam&&ids.find(x=>MODEL_FAM(x)===fam))||null}
function applyConvLlm(tid,quiet){
  if(!conv)return;tid=llmTid(tid||pickerTid());pickerFor=conv.id+'|'+tid;
  const want=threadLlm(tid),ids=io.llm?io.llm.models().map(x=>x[0]):[];
  let model='auto',effort='auto';llmMissing=null;llmSub=null;
  if(want){
    if(ids.includes(want[0]))model=want[0];
    else if(!want[2]&&modelsKnown()){llmMissing=want[0];const c=closestModel(want[0],ids);if(c)model=llmSub=c}   // only a model it was set to counts as missing
    if(EFFORTS.some(e=>e[0]===want[1]))effort=want[1];
  }
  settings.model=model;settings.effort=effort;mSel.value=model;if(!mSel.value)mSel.value=settings.model='auto';eSel.value=effort;
  syncDefStar();syncPick();
  const lbl=mSel.closest('.sel');if(lbl)lbl.title=`Which model answers in ${tid==='main'?'the main thread':'this branch'}. A new branch starts with the model of the one it came from; each reply shows the model that answered.`;
  const said=conv.id+'|'+llmMissing;
  if(llmMissing&&llmMissSaid!==said&&!quiet){llmMissSaid=said;
    toast(`This ${tid==='main'?'conversation':'branch'} used ${modelLabel(llmMissing)}, which isn’t available here, so new replies use ${llmSub?modelLabel(llmSub):'the default'}. It switches back once ${modelLabel(llmMissing)} is available again.`)}
}
// the pane or card you're in changed: the picker shows its model
// the model to call for a thread's own work (cards, fixes): its model if offered here, else the closest one, else the picker's
function modelFor(tid){const w=threadLlm(tid),ids=io.llm?io.llm.models().map(x=>x[0]):[];if(!w||!w[0])return settings.model;return ids.includes(w[0])?w[0]:closestModel(w[0],ids)||settings.model}
function syncPicker(){if(!conv||!io.llm)return;const k=conv.id+'|'+pickerTid();if(k!==pickerFor)applyConvLlm()}
// the picker changed (force), or a thread's first question is being sent: the thread keeps what the picker says
function stickLlm(tid,force=true){
  tid=llmTid(tid||pickerTid());if(!force&&Array.isArray(ownLlm(tid)))return false;
  const model=llmMissing&&(settings.model==='auto'||settings.model===llmSub)?llmMissing:resolvedModel();
  if(model==='auto')return false;
  const next=[model,settings.effort];if(JSON.stringify(ownLlm(tid))===JSON.stringify(next))return false;
  if(tid==='main')conv.llm=next;else T(tid).llm=next;return true;
}
const hasMsgs=()=>Object.keys(conv.msgs).length>0;
mSel.onchange=()=>{settings.model=mSel.value;llmMissing=null;llmSub=null;syncDefStar();const tid=pickerTid();
  if(stickLlm(tid)&&hasMsgs())save();
  setStatus((tid==='main'?'The main thread':'This branch')+' now uses '+modelLabel(resolvedModel()))};
/* ☆ beside the picker: make the model picked here what "Default" means, on every device. It shows only when
   a specific model is picked (not "Default" itself); afterwards the picker goes back to following Default. */
const mDef=$('#mDef');mDef.innerHTML=ic('star');
function syncDefStar(){
  const on=!!(io.llm&&io.llm.setDefault)&&settings.model!=='auto'&&settings.model!==io.llm.defaultModel;
  mDef.style.display=on?'':'none';if(on)mDef.title=`Make ${modelLabel(settings.model)} the default, on all your devices`;
}
mDef.onclick=async(e)=>{e.preventDefault();e.stopPropagation();const id=settings.model,name=modelLabel(id);
  try{await io.llm.setDefault(id)}catch(err){toast('Couldn’t change the default: '+((err&&err.message)||'error'));return}
  if(!Object.keys(conv.msgs).length)delete conv.llm;   // a conversation not started yet follows Default; one already going keeps its model
  settings.model='auto';saveSettings();fillModelPicker();setStatus(name+' is now the default');toast(`${name} is now the default model, on all your devices.`)};
// another device may have changed the default: refresh the list when this tab comes back
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&io.llm&&io.llm.setDefault)io.llm.loadModels().then(fillModelPicker)});
eSel.onchange=()=>{settings.effort=eSel.value;if(stickLlm(pickerTid())&&hasMsgs())save()};
/* ---------- cross-module action registry ---------- */
Object.assign(app, {
  toast, lightbox, loadScript, linkPages, wiresSoon, renderRich,
  imageBlob, imageURL, storeImages, renderConvList, openActivity,
  cvState, REGIONS, contentScale, save, catchUp, docReady,
  buildContext, resolveContext, modelFor, runDocTool,
  trashLeft, openConv, restoreConv, dockCard, openDocPane, goToPage, focusCard,
  revealAnchor, openThread, layout, revealPane, revealMsg,
  clearHit, docImgRef, regionRef,
  updateComposer, hidePop, openImagePop, openDocImgPop, openDocShotPop,
  CW, STOP, applyPaneZoom, brCount, curPane, descendants, docInDock, flushNow,
  hideTip, idxWrite, importDigress, isDigressFile, isFocused, leaveOk, markBack,
  originRO, paneZoom, rememberSpot, renderCanvas, renderMap, renderMermaid,
  renderTitle, setConv, setView, showQuote, updateHeader, updateJump, wires, wrapText,
  DOC_STARTERS, READ_LINE, REDO_WHY, altLine, applyAnchors, askConfirm, branchChips,
  bringBack, buildFoot, buildPdfPages, closeThread, continueReply, createBranch,
  docBranches, docPagesLabel, docPaneEl, docReads, docSpotNow, docThumbUrl, docView,
  docViewReady, drawEdgesSoon, editKeep, editZoom, holdScroll, joinable, markCardButtons,
  markCur, markReplies, movedOn, msgKey, openReplyMenu, openUsage, ownSys, placeDocPane,
  putDocSpot, questionOf, redo, redoBlock, redoKeep, refreshDocAnchors, renderDocPane,
  renderPane, replyMenuItems, retry, retryBlock, revealDocAnchor, scrollDocToPage, send,
  setConvSystem, setStatus, stopReply, streamInto, syncPicker, syncViewSeg, takeawayCuts,
  tkcutEl, updateDocHeader, versionAfter, versionWhere, versionsOf, webSources,
  CANVAS_MOD, CARDS, DOC_MOD, MODEL_FAM, applyCam, applyConvLlm, cacheDocBlob,
  cam, cardsAfterReply, cardsOn, closeModels, confirmDeleteBranch, discardBlank,
  docBlobCache, isBlank, keyClose, menuFor, metaOf, modelsOpen, openCards,
  openModelMenu, putCard, queueStream, refreshAll, refreshAnchorsFor, setZen,
  stickLlm, suggestCard, tabName, titleModel, toggleCollapse, trailText,
  BACK, KS, LOCAL_MSG, SIDEBAR_MOD, cardsChoice, closeThemes, contentOf, convInfo,
  deleteConv, fillModelPicker, fillPopChips, inInbox, kidsOf, loadCards, loadList,
  mSel, modelTier, pickerTid, placeDocked, renderBack, resolvedModel,
  savePrompts, showBanner, sideFold, statusDot, storeDocFile, syncCardsUI, sysScope,
});
Object.defineProperty(app, 'zen', { get: () => zen, enumerable: true, configurable: true });
syncPick();

/* ---------- boot ---------- */
window.__mathReady=()=>{
  if(mathReady)return;mathReady=true;
  try{document.head.appendChild(MathJax.svgStylesheet())}catch(e){}
  if(conv)for(const tid of conv.ui.open){try{renderPane(tid)}catch(e){console.warn(e)}}
  if(conv&&conv.doc&&state.docState&&state.docState.loaded&&state.docState.kind!=='pdf')renderDocPane(true);
  if(conv&&conv.ui.view==='canvas')renderCanvas();
  if($('#cardsModal').classList.contains('show'))renderCards();
};
try{if(sessionStorage.getItem('digress:zen')==='1')setZen(true)}catch(e){}
setConv(newConv());
if(window.MathJax&&MathJax.tex2svg)window.__mathReady();
{const ta=paneEls.get('main')&&paneEls.get('main').querySelector('textarea');ta&&ta.focus()}

if('serviceWorker' in navigator&&window.isSecureContext&&/^https?:$/.test(location.protocol))navigator.serviceWorker.register('sw.js').catch(e=>console.warn('offline support unavailable',e));
io.ready=initConnectors().catch(e=>{console.warn('connector setup failed',e);noServer()});
io.ready.then(async()=>{fillModelPicker();await loadList();await maybeOpenLatest();loadCards();guardBack()});
async function maybeOpenLatest(){
  const shareHash=parseShareHash(location.hash)?location.hash:'';
  if(shareHash)try{history.replaceState(history.state,'',location.pathname+location.search)}catch(e){}
  try{
    if(!conv.order.main.length&&convList.length){
      const want=urlConv();
      if(want&&convList.some(x=>x.id===want))await openConv(want);
      else{
        if(want)toast('That conversation isn’t here (it may have been deleted), so here’s the latest.');
        const latest=convList.find(c=>!c.trashed);if(latest)await openConv(latest.id);
      }
    }
  }finally{urlOn=true;showInUrl()}
  if(shareHash)await importShareHash(shareHash);
}
function showBanner(on,msg){const b=$('#banner');b.textContent=msg||NO_SERVER;b.style.display=on?'block':'none'}
