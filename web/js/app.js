import { DAY, fsrsNext } from './fsrs.js';
import { esc, trunc, stripCiteQuotes, plain, pdfTitleOk, indexEntries, idxPages, sigOf } from './text.js';
import { textWalker, nonWs, flatLen, charPos } from './anchors.js';
import {
  DOC_TOOL_NAMES,
  isDocBranch, isClipBranch, isWholePage, cropRef, shotRef, docImgRefOf,
  pageText as pageTextOf, docTooLong as docTooLongOf, toolsWantedOf, cardToolOf,
  joinParts, appendText, buildContext as buildContextPure,
} from './context.js';
import {
  PUBLIC_DEMO_URL, FILE_MAX_DECODED, gunzipBytesCapped, encodeSharePayload, decodeSharePayload,
  buildShareUrl, parseShareHash, shareSizeStatus, sliceBranch, remapConvIds,
  parseInlineImageDataUrl, normalizePageIndex,
} from './share.js';
import {
  memoryStore, noLlm, noFiles, findServer, okOrThrow, offlineCards, serverStore,
  otherScreen, DEVICE, layoutKey, serverLayout, WINDOWS, toldWindows,
  serverFiles, runId, serverLlm,
} from './connectors.js';
import {
  state, app, io, settings, saveSettings, CUSTOM,
  defaultSys, sysPrompt, fullSys, quickList, convSkills, skillsPrompt,
  STARTERS, MODELS, EFFORTS, effortLabel, modelLabel,
  PALETTE, ic, $, rid, qid, memoSet,
  msgCache, cvMsgCache, paneEls, gutEls, streaming, unread,
  newConv, T, color, ancestors, isDesc, resetThreadIdx, children, branchesOn, hiddenNow, shownOn, branchNum, isCollapsed,
} from './state.js';
import { copyText, createRenderer } from './render.js';
import { createCards, quoteWords, quoteRe } from './cards.js';
import {
  IMG_MAX, regionRef, encodeCanvas, imageBlob, imageURL, blobB64,
  fileToImage, storeImages, pendingImgs, takePending, renderPending,
  userMsgBody, lightbox, setSnip, regionText, screenScale, initMediaListeners,
} from './media.js';
import { createDoc } from './doc.js';

/* ---------- state bindings (live bridge into state.js S while app.js is being split) ---------- */
let conv = null, convList = [];
let mathReady = false;
let popState = null;
Object.defineProperties(state, {
  conv: { get: () => conv, set: (v) => { conv = v; }, enumerable: true, configurable: true },
  convList: { get: () => convList, set: (v) => { convList = v; }, enumerable: true, configurable: true },
  convListLoaded: { get: () => convListLoaded, set: (v) => { convListLoaded = v; }, enumerable: true, configurable: true },
  mathReady: { get: () => mathReady, set: (v) => { mathReady = v; }, enumerable: true, configurable: true },
  popState: { get: () => popState, set: (v) => { popState = v; }, enumerable: true, configurable: true },
  hitSticky: { get: () => hitSticky, set: (v) => { hitSticky = v; }, enumerable: true, configurable: true },
  hitTimer: { get: () => hitTimer, set: (v) => { hitTimer = v; }, enumerable: true, configurable: true },
  dirty: { get: () => dirty, set: (v) => { dirty = v; }, enumerable: true, configurable: true },
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

/* ---------- Activity: what you did each day, what you remember, where you dug deepest ----------
   All of it is worked out from what's already saved (messages' ts, threads' created, cards' reviews); nothing
   new is recorded. Conversations come from io.store.list() (the open one from memory, which is newer). */
const ACT={kind:'all',day:null,data:null};
const dayKey=(t)=>{const d=new Date(t);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const ACT_KINDS=[['all','Everything'],['q','Questions'],['b','Branches'],['r','Reviews']];
async function actGather(){
  await loadCards();let list=[];try{list=(await io.store.list()).map(x=>x.data)}catch(e){console.warn(e)}
  const convs=list.filter(c=>c&&c.threads&&!c.trashed).map(c=>conv&&c.id===conv.id?conv:c);
  const days=new Map(),bump=(t,k,cid)=>{if(!t)return;const key=dayKey(+t);let d=days.get(key);if(!d)days.set(key,d={q:0,b:0,r:0,convs:new Map()});d[k]++;if(cid){const e=d.convs.get(cid)||{q:0,b:0,r:0};e[k]++;d.convs.set(cid,e)}};
  for(const c of convs){
    for(const m of Object.values(c.msgs||{}))if(m&&m.role==='user')bump(m.ts,'q',c.id);
    for(const t of Object.values(c.threads))if(t.parent&&!t.alt)bump(t.created,'b',c.id);
  }
  const cards=[...CARDS.values()];
  for(const k of cards)for(const r of k.reviews||[])bump(r.at,'r',k.conv);
  return {convs,days,cards,byId:new Map(convs.map(c=>[c.id,c]))};
}
async function openActivity(){
  $('#activity').classList.add('show');ACT.day=null;
  $('#activity .acwrap').innerHTML='<div class="achead"><h1>Activity</h1></div><div class="acskel" aria-label="Gathering your history…"><i style="height:300px"></i><i style="height:340px"></i><i style="height:260px"></i></div>';
  ACT.data=await actGather();renderActivity();
}
function closeActivity(){$('#activity').classList.remove('show')}
const actCount=(d,k)=>!d?0:k==='all'?d.q+d.b+d.r:d[k];
const plural=(n,w)=>n+' '+w+(n===1?'':'s');
function renderActivity(){
  const D=ACT.data;if(!D)return;const w=$('#activity .acwrap');
  w.innerHTML=`<div class="achead"><h1>Activity</h1><span class="sp"></span><button class="ib" data-aact="close" title="Close (Esc)">${ic('x')}</button></div>
    <section class="acsec acgridsec"></section><section class="acsec acmem"></section><section class="acsec acholes"></section>`;
  actGridSection(w.querySelector('.acgridsec'),D);actMemory(w.querySelector('.acmem'),D);actHoles(w.querySelector('.acholes'),D);
}
// --- a year of days ---
function actGridSection(el,D){
  const k=ACT.kind,today=new Date();today.setHours(0,0,0,0);
  // from the week of your first activity (at least 33 weeks, at most a year), Monday first; the squares grow to fill the width
  const first=[...D.days.keys()].sort()[0],since=first?Math.ceil((today-new Date(first+'T00:00'))/(7*DAY))+1:0,weeks=Math.min(53,Math.max(33,since));
  const start=new Date(today);start.setDate(start.getDate()-7*(weeks-1)-((today.getDay()+6)%7));
  const cells=[],vals=[];
  for(const d=new Date(start);d<=today;d.setDate(d.getDate()+1)){const key=dayKey(d),n=actCount(D.days.get(key),k);cells.push([key,n,new Date(d)]);if(n)vals.push(n)}
  vals.sort((a,b)=>a-b);const q=(p)=>vals[Math.min(vals.length-1,Math.floor(p*vals.length))]||1,cuts=[q(.25),q(.5),q(.75)];
  const lvl=(n)=>!n?0:n<=cuts[0]?1:n<=cuts[1]?2:n<=cuts[2]?3:4;
  // the week so far, and the last 7 days (not a streak: a gap doesn't reset anything)
  let last7=0;for(let i=0;i<7;i++){const d=new Date(today);d.setDate(d.getDate()-i);if(actCount(D.days.get(dayKey(d)),'all'))last7++}
  const year=cells.reduce((s,[key])=>{const d=D.days.get(key);if(d){s.q+=d.q;s.b+=d.b;s.r+=d.r;if(d.q+d.b+d.r)s.days++}return s},{q:0,b:0,r:0,days:0});
  let best=null;for(const [key,n] of cells)if(n&&(!best||n>best[1]))best=[key,n];
  const fmt=(dt,o)=>dt.toLocaleDateString(undefined,o||{weekday:'short',month:'short',day:'numeric'});
  const tip=(key,n,dt)=>{const d=D.days.get(key);return fmt(dt)+': '+(d&&(d.q+d.b+d.r)?[d.q&&plural(d.q,'question'),d.b&&plural(d.b,'branch').replace('branchs','branches'),d.r&&plural(d.r,'review')].filter(Boolean).join(', '):'nothing')};
  let months='',lastM=cells[0][2].getMonth();for(let i=0;i<cells.length;i+=7){const m=cells[i][2].getMonth(),w=i/7;   // a month's name over its first week (the first column's only if the month has 2+ weeks left)
    const lab=w===0?(new Date(cells[0][2].getFullYear(),m+1,1)-cells[0][2]>14*DAY):m!==lastM;months+=`<span style="grid-column:${w+1}">${lab?fmt(cells[i][2],{month:'short'}):''}</span>`;lastM=m}
  el.innerHTML=`<div class="actop"><div class="acstat"><b>${last7}</b> of the last 7 days</div><div class="acstat"><b>${year.days}</b> active day${year.days===1?'':'s'}${weeks>=53?' in the last year':''}</div><div class="acstat"><b>${year.q}</b> questions · <b>${year.b}</b> branches · <b>${year.r}</b> reviews</div></div>
    <div class="ackinds">${ACT_KINDS.map(([v,l])=>`<button data-akind="${v}" class="${k===v?'on':''}">${l}</button>`).join('')}</div>
    <div class="acscroll" style="--n:${weeks}"><div class="acmonths">${months}</div><div class="acgrid">${cells.map(([key,n,dt])=>`<button class="acday l${lvl(n)}${ACT.day===key?' sel':''}" data-aday="${key}" title="${esc(tip(key,n,dt))}"></button>`).join('')}</div></div>
    <div class="aclegend"><span>${best?`Busiest day: ${esc(busyText(D,best[0],k))}`:''}</span><span class="sp"></span>Less<i class="acday l0"></i><i class="acday l1"></i><i class="acday l2"></i><i class="acday l3"></i><i class="acday l4"></i>More</div>
    <div class="acdaybox"></div>`;
  const sc=el.querySelector('.acscroll');requestAnimationFrame(()=>{sc.scrollLeft=sc.scrollWidth});
  if(ACT.day)actDay(el.querySelector('.acdaybox'),D,ACT.day);
}
function busyText(D,key,k){const d=D.days.get(key),dt=new Date(key+'T12:00').toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const parts=[(k==='all'||k==='q')&&d.q&&plural(d.q,'question'),(k==='all'||k==='b')&&d.b&&(d.b+' branch'+(d.b>1?'es':'')),(k==='all'||k==='r')&&d.r&&plural(d.r,'review')].filter(Boolean);
  return dt+' · '+parts.join(', ')}
function actDay(box,D,key){
  const d=D.days.get(key),dt=new Date(key+'T12:00');
  if(!d||!(d.q+d.b+d.r)){box.innerHTML=`<div class="acdayh">${dt.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}: a day off.</div>`;return}
  const rows=[...d.convs].sort((a,b)=>(b[1].q+b[1].b+b[1].r)-(a[1].q+a[1].b+a[1].r));
  box.innerHTML=`<div class="acdayh">${dt.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}</div>`+rows.map(([cid,e])=>{const c=D.byId.get(cid),t=c?c.title||'New conversation':(([...CARDS.values()].find(k=>k.conv===cid)||{}).convTitle||'A deleted conversation');
    return `<button class="acrow" ${c?`data-aconv="${esc(cid)}"`:'disabled'}><span class="t">${esc(t)}</span><span class="m">${[e.q&&plural(e.q,'question'),e.b&&(e.b+' branch'+(e.b>1?'es':'')),e.r&&plural(e.r,'review')].filter(Boolean).join(' · ')}</span></button>`}).join('');
}
// --- what you remember (FSRS: recall after t days is (1 + 19/81·t/S)^-0.5, 90% at t = S) ---
const knownAt=(f,at,ahead)=>!!f&&f.state==='review'&&f.S>=(at-f.last)/DAY+ahead;
const recallAt=(f,at)=>!f?0:Math.pow(1+19/81*Math.max(0,(at-f.last)/DAY)/f.S,-0.5);   // the odds you'd recall it at that moment
function actMemory(el,D){
  const now=Date.now(),kept=D.cards.filter(c=>c.status==='active'),known=Math.round(kept.reduce((s,c)=>s+recallAt(c.fsrs,now),0)),month=kept.filter(c=>knownAt(c.fsrs,now,30)).length;
  const rev30=D.cards.flatMap(c=>(c.reviews||[]).filter(r=>r.at>now-30*DAY)),pass=rev30.filter(r=>r.g>1).length;
  if(!kept.length&&!rev30.length){el.innerHTML=`<h2>What you remember</h2><div class="acnone">No flashcards yet. Turn them on in a conversation (the cards button in its header) and this fills in as you review.</div>`;return}
  // how many cards you'd recall (the sum of each one's odds), over time: each card's reviews replayed through the scheduler; from your first review
  // (at most 26 weeks back), in at most 26 steps
  const pts=[];const hist=kept.filter(c=>(c.reviews||[]).length).map(c=>{let f=null;return (c.reviews||[]).slice().sort((a,b)=>a.at-b.at).map(r=>{f=fsrsNext(f,r.g,r.at).fsrs;return f})});
  const t0=Math.max(now-182*DAY,Math.min(now,...hist.map(h=>h[0].last))),step=Math.max(DAY,(now-t0)/25);
  for(let at=t0;at<now+step/2;at+=step){const t=Math.min(at,now);let n=0;for(const h of hist){let f=null;for(const s of h){if(s.last>t)break;f=s}n+=recallAt(f,t)}pts.push(Math.round(n))}
  if(pts.length)pts[pts.length-1]=known;   // today as the headline says (the card's own state: a fix may have restarted it)
  const firstUse=hist.length?0:-1;
  // what's coming due: the next 14 days (anything overdue counts as today)
  const today=new Date();today.setHours(0,0,0,0);const due=Array(14).fill(0);
  for(const c of kept){if(c.fix)continue;const i=Math.max(0,Math.floor(((c.due||0)-today)/DAY));if(i<14)due[i]++}
  const hard=D.cards.map(c=>[c,(c.reviews||[]).filter(r=>r.g===1).length]).filter(([c,n])=>n>=2&&c.status!=='inbox').sort((a,b)=>b[1]-a[1]).slice(0,5);
  el.innerHTML=`<h2>What you remember</h2>
    <div class="acnums"><div class="acnum"><b>~${known}</b><span>of your ${kept.length} cards you’d recall right now</span><small>${month?`${month} solid for a month or more · `:''}FSRS’s estimate</small></div>
    <div class="acnum"><b>${rev30.length?Math.round(100*pass/rev30.length)+'%':'–'}</b><span>recalled, over the last 30 days</span><small>${plural(rev30.length,'review')}</small></div></div>
    <div class="accharts"><figure class="acfig"><figcaption>Cards you’d recall, over time</figcaption>${firstUse<0?'<div class="acnone">Review a few cards and this starts to climb.</div>':lineChart(pts,[new Date(t0).toLocaleDateString(undefined,{month:'short',day:'numeric'}),'Today'])}</figure>
    <figure class="acfig"><figcaption>Coming due, next two weeks</figcaption>${barChart(due,today)}</figure></div>
    ${hard.length?`<div class="achard"><div class="acsub">The ones that keep slipping</div>${hard.map(([c,n])=>`<button class="acrow" data-acard="${esc(c.id)}"><span class="t">${esc(trunc(plain(c.front).replace(/\s+/g,' '),110))}</span><span class="m">missed ${n} times</span></button>`).join('')}</div>`:''}`;
}
function lineChart(p,ends){
  const W=320,H=90,max=Math.max(1,...p),x=(i)=>p.length<2?W/2:4+i*(W-8)/(p.length-1),y=(v)=>H-8-(v/max)*(H-22);
  const line=p.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)).join(' ');
  return `<svg class="acline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cards known each week, now ${p.at(-1)}"><path class="area" d="${line} L${x(p.length-1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z"/><path class="ln" d="${line}"/><circle cx="${x(p.length-1)}" cy="${y(p.at(-1))}" r="3"/><text x="${Math.min(W-4,x(p.length-1))}" y="${Math.max(10,y(p.at(-1))-8)}" text-anchor="end">${p.at(-1)}</text>${ends?`<text class="ax" x="2" y="${H+12}">${esc(ends[0])}</text><text class="ax" x="${W-2}" y="${H+12}" text-anchor="end">${ends[1]}</text>`:''}</svg>`;
}
function barChart(v,today){
  const W=320,H=90,max=Math.max(1,...v),bw=(W-4)/v.length;
  return `<svg class="acbars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cards due each day for two weeks">${v.map((n,i)=>{const h=n?Math.max(3,(n/max)*(H-30)):0,d=new Date(+today+i*DAY);
    return `<g><title>${i===0?'Today':d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}: ${n} due</title><rect x="${2+i*bw+2}" y="${H-16-h}" width="${bw-4}" height="${h}" rx="2" class="${i===0?'now':''}"/>${n?`<text x="${2+i*bw+bw/2}" y="${H-20-h}" text-anchor="middle">${n}</text>`:''}<text class="ax" x="${2+i*bw+bw/2}" y="${H-3}" text-anchor="middle">${i===0?'T':d.toLocaleDateString(undefined,{weekday:'narrow'})}</text></g>`}).join('')}</svg>`;
}
// --- rabbit holes: how deep and where you dug ---
function actHoles(el,D){
  const branches=(c)=>Object.values(c.threads).filter(t=>t.parent&&!t.alt);
  const nameOf=(t)=>t.id==='main'?'Main':trunc(String(t.title||t.anchorText||'Branch').replace(/\s+/g,' '),48);
  let deep=null;
  for(const c of D.convs)for(const t of branches(c)){const path=[];let x=t;while(x&&x.id!=='main'&&path.length<60){if(!x.alt)path.unshift(x);x=c.threads[x.parent]}if(!deep||path.length>deep.path.length)deep={c,path}}
  const most=D.convs.map(c=>[c,branches(c).length]).filter(x=>x[1]).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const spots=new Map();for(const c of D.convs)for(const t of branches(c)){const a=String(t.anchorText||'').replace(/\s+/g,' ').trim();if(!a||t.anchorMsg==null)continue;const key=c.id+'|'+t.anchorMsg+'|'+a.toLowerCase();const e=spots.get(key)||spots.set(key,{c,a,n:0,t}).get(key);e.n++}
  const again=[...spots.values()].filter(e=>e.n>=2).sort((a,b)=>b.n-a.n).slice(0,3);
  const nb=D.convs.reduce((s,c)=>s+branches(c).length,0),nt=D.convs.reduce((s,c)=>s+Object.values(c.msgs||{}).filter(m=>m&&m.role==='note').length,0),nd=D.convs.filter(c=>c.doc).length;
  if(!nb){el.innerHTML=`<h2>Rabbit holes</h2><div class="acnone">No branches yet. Highlight anything in a reply to ask about it, and your dives show up here.</div>`;return}
  el.innerHTML=`<h2>Rabbit holes</h2>
    <div class="actotal">${[plural(D.convs.length,'conversation'),nb+' branch'+(nb>1?'es':''),nt&&plural(nt,'takeaway'),nd&&plural(nd,'document')].filter(Boolean).join(' · ')}</div>
    ${deep&&deep.path.length>1?`<div class="acsub">Your deepest dive: ${deep.path.length} levels down</div><div class="acpath" style="--c:var(--accent)"><button class="acstep" data-aconv="${esc(deep.c.id)}">${esc(trunc(deep.c.title||'New conversation',40))}</button>${deep.path.map((t,i)=>`<span class="acarr">›</span><button class="acstep" data-aconv="${esc(deep.c.id)}" data-athread="${esc(t.id)}" style="--i:${i}">${esc(nameOf(t))}</button>`).join('')}</div>`:''}
    <div class="acsub">Most branched</div><div class="acmost">${most.map(([c,n])=>`<button class="acrow acbar" data-aconv="${esc(c.id)}" style="--w:${Math.round(100*n/most[0][1])}%"><span class="t">${esc(c.title||'New conversation')}</span><span class="m">${n}</span></button>`).join('')}</div>
    ${again.length?`<div class="acsub">Passages you kept coming back to</div>${again.map(e=>`<button class="acrow" data-aconv="${esc(e.c.id)}" data-athread="${esc(e.t.id)}"><span class="t">“${esc(trunc(e.a,90))}”</span><span class="m">${e.n} branches</span></button>`).join('')}`:''}`;
}
async function actGo(cid,tid){
  closeActivity();if(!conv||conv.id!==cid)await openConv(cid);
  if(!tid||!conv||conv.id!==cid||!T(tid))return;
  if(conv.ui.view==='canvas'){focusCard(tid);return}
  openThread(tid);conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!==tid);layout();renderMap();revealPane(tid);
}
$('#activity').addEventListener('click',e=>{
  const t=e.target.closest('[data-aact],[data-akind],[data-aday],[data-aconv],[data-acard]');if(!t)return;
  if(t.dataset.aact==='close')closeActivity();
  else if(t.dataset.akind){ACT.kind=t.dataset.akind;renderActivity()}
  else if(t.dataset.aday){ACT.day=ACT.day===t.dataset.aday?null:t.dataset.aday;const sc=$('#activity .acscroll'),l=sc?sc.scrollLeft:0;actGridSection($('#activity .acgridsec'),ACT.data);requestAnimationFrame(()=>{const n=$('#activity .acscroll');if(n)n.scrollLeft=l})}
  else if(t.dataset.aconv)actGo(t.dataset.aconv,t.dataset.athread);
  else if(t.dataset.acard){const c=CARDS.get(t.dataset.acard);if(c){closeActivity();KS.focus=c.id;openCards(c.conv,'all')}}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&$('#activity').classList.contains('show')&&!$('#cardsModal').classList.contains('show')){e.preventDefault();closeActivity()}});
$('#actBtn').addEventListener('click',openActivity);
/* ---------- Prompts & skills (the sidebar's Prompts & skills; the top bar's Skills) ----------
   The reader's own system prompt and quick questions (the store's prompts/custom: {system?, quick?}, only what differs
   from web/prompts.js) and skills: SKILL.md files ({id, name, description, body, text, source}), turned on per
   conversation (conv.skills, ids) and added to its system prompt (skillsPrompt), so all its threads share one cache. */
async function loadCustom(){
  if(!io.skills)return;
  try{
    const [list,pr]=await Promise.all([io.skills.list(),io.prompts.get('custom')]);
    CUSTOM.skills=new Map(list.filter(x=>x.data&&typeof x.data.body==='string').sort((a,b)=>(a.data.added||0)-(b.data.added||0)).map(({id,data})=>[id,{...data,id}]));
    CUSTOM.prompts=pr&&typeof pr==='object'&&!Array.isArray(pr)?pr:{};
  }catch(e){console.warn('prompts and skills failed to load',e)}
  fillPopChips();syncSkillT();
  convListSig='';renderConvList();   // folders' prompts are marked in the sidebar
}
const skillLabel=(s)=>String(s.name||'Skill').replace(/[-_]+/g,' ').trim().replace(/^./,c=>c.toUpperCase());
// SKILL.md: an optional header between --- lines (name:, description:), then the instructions
function parseSkill(text){
  text=String(text||'').replace(/^﻿/,'').replace(/\r\n?/g,'\n');
  const head={};let body=text;
  const m=/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if(m){body=text.slice(m[0].length);for(const line of m[1].split('\n')){const k=/^([A-Za-z_-]+):\s*(.*)$/.exec(line);if(!k)continue;let v=k[2].trim();if(/^(["']).*\1$/.test(v))v=v.slice(1,-1);head[k[1].toLowerCase()]=v}}
  body=body.trim();const h1=/^#\s+(.+)$/m.exec(body);
  return {name:String(head.name||(h1&&h1[1])||'').trim().slice(0,80),description:String(head.description||'').trim().slice(0,1000),body,text};
}
async function putSkill(text,o={}){
  if(!io.skills)throw new Error('Adding a skill needs the Digress server.');
  if(text.length>200000)throw new Error('That’s too long for a skill (over 200,000 characters).');
  const p=parseSkill(text);
  if(!p.body)throw new Error('That’s empty.');
  if(/^<(!doctype|html)/i.test(p.body))throw new Error('That’s a web page, not a SKILL.md. Link to the file itself (on GitHub: the skill’s folder, or its SKILL.md).');
  if(!p.name)throw new Error('It needs a name: a header with “name: …”, or a # heading at the top.');
  const id=o.id||('sk-'+(p.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||rid()));
  const old=CUSTOM.skills.get(id);
  const rec={id,name:p.name,description:p.description,body:p.body,text:p.text,source:o.source!=null?o.source:(old&&old.source)||'',added:old?old.added:Date.now(),updated:Date.now()};
  await io.skills.put(id,rec);CUSTOM.skills.set(id,rec);syncSkillT();
  return {rec,replaced:!!old};
}
// a GitHub page for a skill's folder or file -> its raw SKILL.md; anything else as it is
function skillLink(u){
  let x;try{x=new URL(u.trim())}catch(e){return null}
  if(!/^https?:$/.test(x.protocol))return null;
  if(x.hostname==='github.com'){
    const p=x.pathname.split('/').filter(Boolean);   // owner/repo[/(tree|blob)/branch/path…]
    if(p.length>=4&&(p[2]==='tree'||p[2]==='blob')){const rest=p.slice(4).join('/');return `https://raw.githubusercontent.com/${p[0]}/${p[1]}/${p[3]}/${p[2]==='blob'?rest:(rest?rest+'/':'')+'SKILL.md'}`}
    if(p.length===2)return `https://raw.githubusercontent.com/${p[0]}/${p[1]}/HEAD/SKILL.md`;
  }
  return x.href;
}
async function skillFromLink(link){
  if(!io.files.fromLink)throw new Error('Opening a link needs the Digress server. Download the file and choose it instead.');
  const raw=skillLink(link);if(!raw)throw new Error('That isn’t a link.');
  let d;try{d=await io.files.fromLink(raw,[])}catch(e){
    const gh=/^https:\/\/raw\.githubusercontent\.com\//.test(raw);
    throw new Error((e.message||'It couldn’t be fetched.')+(gh&&/404|not found/i.test(e.message||'')?' If that repository holds several skills, link to one skill’s folder.':''))}
  if(d.kind!=='text')throw new Error(d.kind==='pdf'?'That’s a PDF, not a SKILL.md.':'That’s a web page, not a SKILL.md. Link to the file itself (on GitHub: the skill’s folder, or its SKILL.md).');
  return putSkill(await d.blob.text(),{source:link.trim()});
}
// the top bar's Skills: which skills this conversation has on
// the top bar's Prompt button: this conversation's system prompt and skills (lit when either isn't the default)
const ownSys=(c)=>!!(c&&typeof c.system==='string'&&c.system.trim());
function syncSkillT(){
  const b=$('#skillT');if(!b)return;const on=convSkills(conv),own=ownSys(conv),lit=!!on.length||own;
  b.style.display=conv?'':'none';
  b.classList.toggle('on',lit);b.setAttribute('aria-pressed',lit?'true':'false');
  b.querySelector('.lbl').textContent=on.length===1?skillLabel(on[0]):on.length?on.length+' skills':own?'Own prompt':'Prompt';
  b.title=[own?'This conversation has its own system prompt.':'This conversation uses your default system prompt.',on.length?`Skills on: ${on.map(skillLabel).join(', ')}.`:CUSTOM.skills.size?'No skills on.':'',' Click to change.'].join(' ').replace(/\s+/g,' ').trim();
}
function openSkillMenu(btn){
  let menu=$('#skillMenu');
  if(!menu){menu=document.createElement('div');menu.className='thmenu';menu.id='skillMenu';menu.setAttribute('role','menu');document.body.appendChild(menu);
    document.addEventListener('pointerdown',e=>{if(menu.classList.contains('open')&&!menu.contains(e.target)&&!e.target.closest('#skillT'))menu.classList.remove('open')},true);
    // Esc closes it (it stayed open, so the next click on Prompt closed it instead of opening it)
    addEventListener('keydown',e=>{if(e.key==='Escape'&&menu.classList.contains('open')){e.stopPropagation();e.preventDefault();menu.classList.remove('open');const t=$('#skillT');t&&t.isConnected&&t.focus({preventScroll:true})}},true);
    menu.onclick=(e)=>{const b=e.target.closest('[data-sk]');if(!b)return;
      if(b.dataset.sk==='-'){menu.classList.remove('open');openPrompts();return}
      if(b.dataset.sk==='='){menu.classList.remove('open');editConvSystem();return}
      if(b.dataset.sk==='?'){menu.classList.remove('open');showModelView();return}
      toggleSkill(b.dataset.sk);fillSkillMenu(menu)}}
  if(menu.classList.contains('open')){menu.classList.remove('open');return}
  fillSkillMenu(menu);menu.classList.add('open');
  const r=btn.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,r.right-menu.offsetWidth))+'px';
  menu.style.top=(r.bottom+4+menu.offsetHeight<=innerHeight-8?r.bottom+4:Math.max(8,r.top-4-menu.offsetHeight))+'px';
  const f=menu.querySelector('button');f&&f.focus();
}
function fillSkillMenu(menu){
  const on=new Set((conv&&conv.skills)||[]);
  const own=ownSys(conv);
  menu.innerHTML=`<div class="thh">This conversation</div><button class="skrow" data-sk="="><span class="skchk">${ic('tune')}</span><span class="skt"><b>System prompt</b><small>${own?esc('Its own: “'+trunc(conv.system.replace(/\s+/g,' '),70)+'”'):'Your default. Click to see it or give this conversation its own.'}</small></span></button>`+
    `<div class="thh">Skills</div>`+(CUSTOM.skills.size?'':`<div class="sknone">None yet. Add one in Prompts, skills &amp; tools.</div>`)+[...CUSTOM.skills.values()].map(s=>`<button class="skrow" data-sk="${esc(s.id)}" role="menuitemcheckbox" aria-checked="${on.has(s.id)}" title="${esc(s.description||'')}"><span class="skchk">${on.has(s.id)?ic('check'):''}</span><span class="skt"><b>${esc(skillLabel(s))}</b>${s.description?`<small>${esc(trunc(s.description,110))}</small>`:''}</span></button>`).join('')+
    `<div class="thh thsep" style="padding:0"></div><button data-sk="-">${ic('tune')}Prompts, skills &amp; tools…</button><button data-sk="?" class="skdbg" title="Debug: the exact request the next question in this thread sends">What the model sees here…</button>`;
}
function toggleSkill(id){
  if(!conv)return;const s=CUSTOM.skills.get(id);if(!s)return;
  const on=new Set(conv.skills||[]),was=on.has(id);if(was)on.delete(id);else on.add(id);
  if(on.size)conv.skills=[...on];else delete conv.skills;
  save();syncSkillT();
  toast(was?`${skillLabel(s)} is off in this conversation.`:`${skillLabel(s)} is on in this conversation, from the next reply, in every thread.`);
}
// this conversation's system prompt, from the top bar's Prompt: a dialog with it filled in
function editConvSystem(){
  if(!conv)return;const own=ownSys(conv);
  askConfirm('System prompt for this conversation',`<p class="ppnote">${own?'This conversation has its own.':'This conversation follows your default, shown here: change it to give it its own.'} ${sysScope()} A change applies from the next reply on; replies already written keep what they were written with.</p><textarea class="pptext" id="cSysEd" rows="14" spellcheck="false" aria-label="System prompt for this conversation"></textarea>${own?'<button class="elink" id="cSysDef" type="button">Put my default back</button>':''}`,
    ()=>{const was=ownSys(conv);setConvSystem($('#cSysEd').value);if(conv.order.main.length===0)renderPane('main');
      toast(ownSys(conv)?'Saved: this conversation has its own system prompt, from the next reply.':was?'This conversation follows your default again.':'Unchanged: it follows your default.')},{ok:'Save',kind:'primary'});
  $('#cSysEd').value=sysPrompt(conv);
  const d=$('#cSysDef');if(d)d.onclick=()=>{$('#cSysEd').value=defaultSys();$('#cSysEd').focus()};
  setTimeout(()=>$('#cSysEd').focus(),30);
}
// a conversation's own system prompt: '' or the default puts it back to following your default
// Debug: the request the next question in this thread would send, exactly as built (buildContext), before images are
// loaded: the tools, the system prompt in its parts, and every message on the path with its markers.
function showModelView(tid){
  if(!conv)return;tid=tid||pickerTid();if(!T(tid))tid='main';
  const keep=DOC_MOD.lastDocSeen;let ctx;try{ctx=buildContext(tid)}finally{DOC_MOD.lastDocSeen=keep}
  const own=sysPrompt(conv),sk=skillsPrompt(conv),rest=ctx.system.slice(fullSys(conv).length).replace(/^\n\n/,'');
  const n=(x)=>`${x.length.toLocaleString()} characters`;
  const part=(title,text,open)=>text?`<details class="mvp"${open?' open':''}><summary>${esc(title)} <small>${n(text)}</small></summary><pre>${esc(text)}</pre></details>`:'';
  const msgText=(c)=>typeof c==='string'?c:c.map(p=>p.type==='text'?p.text:`[image: ${p.label||'an image'}]`).join('');
  const t=T(tid),name=tid==='main'?'the main thread':`“${t.title||'a branch'}”`;
  const msgs=ctx.messages.map((m,i)=>`<details class="mvp"${i>=ctx.messages.length-2?' open':''}><summary>${i+1}. ${m.role==='user'?'User':'Assistant'} <small>${n(msgText(m.content))}</small></summary><pre>${esc(msgText(m.content))}</pre></details>`).join('');
  askConfirm('What the model sees here',`<div class="mview"><p class="ppnote">The request the next question in ${esc(name)} sends, before your question is added: exactly what the model gets, nothing else. Thread names and labels on screen aren’t sent.</p>
    <h3>Tools</h3><p class="ppnote">${ctx.tools?ctx.tools.map(x=>`<code>${esc(x)}</code>`).join(', '):'None'}${settings.web&&io.llm&&io.llm.supportsWeb?', and web search (Web is on)':''}.</p>
    <h3>System prompt</h3>${part(ownSys(conv)?'This conversation’s own prompt':'Your default prompt',own,true)}${part('How Digress works (fixed)',PROMPTS.howDigress)}${part('Skills',sk.trim())}${part('The document',rest)}
    <h3>Messages, oldest first</h3>${msgs||'<p class="ppnote">None yet.</p>'}</div>`,
    ()=>{copyText(JSON.stringify(ctx,null,2)).then(()=>toast('Copied the request as JSON.'),()=>toast('It couldn’t be copied.'))},
    {ok:'Copy as JSON',kind:'plain',cancel:'Close',wide:true});
}
function setConvSystem(v){
  if(!conv)return;v=String(v||'').trim();
  if(!v||v===defaultSys().trim())delete conv.system;else conv.system=v;
  save();syncSkillT();
}
const closeSkillMenu=()=>{const m=$('#skillMenu');if(m&&m.classList.contains('open')){m.classList.remove('open');return true}return false};

// the page itself
const PP={q:null,editing:null};
function openPrompts(at){
  $('#promptsPage').classList.add('show');closeSkillMenu();renderPrompts();
  if(at){const s=$('#promptsPage .pp'+at);s&&s.scrollIntoView({block:'start'})}
}
function closePrompts(){$('#promptsPage').classList.remove('show')}
const sameJson=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function savePrompts(patch){
  if(!io.prompts)throw new Error('Changing these needs the Digress server.');
  const next={...CUSTOM.prompts,...patch};for(const k of Object.keys(next))if(next[k]==null)delete next[k];
  await io.prompts.put('custom',next);CUSTOM.prompts=next;
}
function renderPrompts(){
  const w=$('#promptsPage .acwrap'),cp=CUSTOM.prompts,can=!!io.prompts;
  PP.q=JSON.parse(JSON.stringify(quickList()));PP.editing=null;
  w.innerHTML=`<div class="achead"><h1>Prompts, skills &amp; tools</h1><span class="sp"></span><button class="ib" data-pp="close" title="Close (Esc)">${ic('x')}</button></div>
  ${can?'':'<section class="acsec"><div class="acnone">Changing these needs the Digress server; here you can only read them.</div></section>'}
  <section class="acsec ppsys"><h2>Your default system prompt <span class="pptag">${cp.system?'Yours':'Digress’s'}</span></h2>
    <p class="ppnote">Who the tutor is and how it writes: what the model is told before every question, in every conversation that doesn’t have its own (<b>Prompt</b> in the top bar gives one its own), on every device. After it Digress always adds how the app works (below), then the conversation’s skills and its document. A change applies from the next reply.</p>
    <textarea class="pptext" id="ppSys" spellcheck="false" rows="14"></textarea>
    <div class="ppbar"><span class="ppmsg" id="ppSysMsg"></span><span class="sp"></span>${cp.system?'<button class="mbtn" data-pp="sysreset">Reset to default</button>':''}<button class="mbtn primary" data-pp="syssave" disabled>Save</button></div>
    ${cp.system?'<details class="ppdef"><summary>The default</summary><pre class="ppsrc"></pre></details>':''}
    <details class="pphow"><summary>Always added after it: how Digress works</summary><p class="ppnote">Digress adds this after your prompt every time, so nothing you write can remove it: the formatting the page can draw, when the model may search the web, how branches are marked, and what the model sees. It can’t be edited here.</p><pre class="ppsrc"></pre></details>
  </section>
  <section class="acsec ppquick"><h2>Quick questions <span class="pptag">${cp.quick&&cp.quick.length?'Yours':'Default'}</span></h2>
    <p class="ppnote">The chips in the highlight popup and in a new branch: a label, and what it asks.</p>
    <div class="ppq" id="ppQ"></div>
    <div class="ppbar"><button class="mbtn" data-pp="qadd">Add one</button><span class="ppmsg" id="ppQMsg"></span><span class="sp"></span>${cp.quick&&cp.quick.length?'<button class="mbtn" data-pp="qreset">Reset to default</button>':''}<button class="mbtn primary" data-pp="qsave" disabled>Save</button></div>
  </section>
  <section class="acsec ppskills"><h2>Skills</h2>
    <p class="ppnote">A skill is a set of instructions for the model, in the SKILL.md format many AI tools share. Add one here, then turn it on in a conversation with <b>Prompt</b> in the top bar: it’s added to that conversation’s system prompt and applies in every thread of it.</p>
    <div id="ppSkills"></div>
    <div class="ppadd"><textarea class="pptext" id="ppSkIn" rows="3" spellcheck="false" placeholder="Paste a SKILL.md, or a link to one (a GitHub folder or file works)"></textarea>
      <div class="ppbar"><label class="mbtn ppfile">Choose a file<input type="file" id="ppSkFile" accept=".md,.markdown,.txt,text/markdown,text/plain"></label><span class="ppmsg" id="ppSkMsg"></span><span class="sp"></span><button class="mbtn primary" data-pp="skadd">Add</button></div></div>
  </section>
  <section class="acsec pptools"><h2>Tools</h2>
    <p class="ppnote">What the model can do besides write, and what switches each on. Read-only: the page runs them, so their names and what they take are part of the code (<code>server/doctools.mjs</code>).</p>
    <div id="ppTools"><div class="acnone">Loading…</div></div>
  </section>
  <section class="acsec ppall"><h2>Everything else Digress tells the model</h2>
    <p class="ppnote">Read-only here: branch markers, takeaways, flashcards, titles, the document’s preamble. The code relies on their wording or on the shape of the reply they ask for, so they’re changed in <code>web/prompts.js</code>.</p>
    <details id="ppAll"><summary>Show web/prompts.js</summary><pre class="ppsrc">Loading…</pre></details>
  </section>`;
  const sys=$('#ppSys');sys.value=defaultSys();sys.readOnly=!can;
  sys.oninput=()=>{$('[data-pp=syssave]').disabled=sys.value===defaultSys();$('#ppSysMsg').textContent=''};
  renderToolList();
  const def=w.querySelector('.ppdef pre');if(def)def.textContent=PROMPTS.system;
  w.querySelector('.pphow pre').textContent=PROMPTS.howDigress;
  $('#ppAll').addEventListener('toggle',async e=>{const pre=e.target.querySelector('pre');if(!e.target.open||pre.dataset.done)return;
    try{const r=await fetch('prompts.js',{cache:'no-store'});pre.textContent=await (await okOrThrow(r)).text();pre.dataset.done=1}catch(err){pre.textContent='It couldn’t be loaded: '+(err.message||err)}});
  $('#ppSkFile').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;await addSkillFrom(()=>f.text().then(t=>putSkill(t,{source:''})))};
  renderQuickRows();renderSkillList();
}
function renderQuickRows(){
  const box=$('#ppQ');if(!box)return;const can=!!io.prompts;
  box.innerHTML=PP.q.map(([l,q],i)=>`<div class="ppqrow" data-i="${i}"><input class="ppql" value="${esc(l)}" placeholder="Label" ${can?'':'readonly'}><input class="ppqq" value="${esc(q)}" placeholder="What it asks" ${can?'':'readonly'}><button class="ib" data-pp="qdel" title="Remove" ${can?'':'disabled'}>${ic('x')}</button></div>`).join('');
}
function quickChanged(){const b=$('[data-pp=qsave]');if(b)b.disabled=sameJson(PP.q,quickList());$('#ppQMsg').textContent=''}
function renderSkillList(){
  const box=$('#ppSkills');if(!box)return;const can=!!io.skills;
  box.innerHTML=CUSTOM.skills.size?[...CUSTOM.skills.values()].map(s=>{const ed=can,open=PP.editing===s.id;return `<div class="ppsk" data-skid="${esc(s.id)}">
    <div class="ppskh"><b>${esc(skillLabel(s))}</b><span class="sp"></span>${ed?`<button class="mbtn" data-pp="skedit">${open?'Close':'View and edit'}</button><button class="mbtn" data-pp="skdel">Delete</button>`:`<button class="mbtn" data-pp="skedit">${open?'Close':'View'}</button>`}</div>
    ${s.description?`<div class="ppskd">${esc(s.description)}</div>`:''}
    ${s.source?`<div class="ppsks">From <a href="${esc(s.source)}" target="_blank" rel="noopener noreferrer">${esc(trunc(s.source.replace(/^https?:\/\//,''),80))}</a></div>`:''}
    ${open?`<div class="ppsked"><textarea class="pptext" rows="18" spellcheck="false" ${ed?'':'readonly'}></textarea>${ed?'<div class="ppbar"><span class="ppmsg"></span><span class="sp"></span><button class="mbtn primary" data-pp="sksave">Save</button></div>':''}</div>`:''}
  </div>`}).join(''):'<div class="acnone">No skills yet.</div>';
  const ed=box.querySelector('.ppsked textarea');if(ed){const s=CUSTOM.skills.get(PP.editing);ed.value=s.text||s.body}
}
async function addSkillFrom(get){
  const msg=$('#ppSkMsg'),btn=$('[data-pp=skadd]');msg.textContent='Adding…';msg.classList.remove('bad');btn.disabled=true;
  try{const {rec,replaced}=await get();$('#ppSkIn').value='';msg.textContent=(replaced?'Updated ':'Added ')+skillLabel(rec)+'. Turn it on in a conversation with Prompt in the top bar.';renderSkillList()}
  catch(e){msg.textContent=e.message||String(e);msg.classList.add('bad')}
  finally{btn.disabled=false}
}
// the Tools section: each tool as the model sees it (GET api/tools), with what turns it on here
const TOOL_INFO=[
  ['Web search',null,'Web in the top bar, per question.','The one that reaches outside (your words go to a search engine), so it’s yours to switch. The provider runs it.'],
  ['Reading the document',['search','read_pages','view_page'],'Always, with a document.','Only reads what you opened, in this browser.'],
  ['Suggesting flashcards',['suggest_card'],'Flashcards on in the conversation.','Adds a card to your inbox when the model judges something has landed.'],
];
async function renderToolList(){
  const box=$('#ppTools');if(!box)return;
  let d=null;try{if(io.llm&&io.llm.toolList)d=await io.llm.toolList()}catch(e){console.warn(e)}
  if(!box.isConnected)return;
  const lim={search:d&&d.maxCalls,suggest_card:d&&d.maxCards};
  box.innerHTML=`<table class="pptools"><tr><th>Tool</th><th>On when</th><th>What it does</th></tr>${TOOL_INFO.map(([name,ids,on,what])=>`<tr><td><b>${esc(name)}</b>${ids?`<br><code>${esc(ids.join(', '))}</code>`:''}</td><td>${esc(on)}</td><td>${esc(what)}${ids&&lim[ids[0]]?` Up to ${lim[ids[0]]} calls per answer.`:''}</td></tr>`).join('')}</table>`+
    (d&&d.tools?`<details class="pptool"><summary>What the model reads about each</summary><pre class="ppsrc">${esc(d.tools.map(t=>`${t.name}\n${t.description}\nTakes: ${JSON.stringify(t.schema.properties)}`).join('\n\n'))}</pre></details>`:'<div class="acnone">The descriptions the model reads come from the Digress server, which isn’t answering.</div>');
}
function refreshChips(){fillPopChips();if(conv)for(const id of conv.ui.open)if(id!=='doc'&&T(id))renderPane(id)}
$('#promptsPage').addEventListener('input',e=>{
  const row=e.target.closest('.ppqrow');if(!row)return;const i=+row.dataset.i;
  PP.q[i]=[row.querySelector('.ppql').value,row.querySelector('.ppqq').value];quickChanged();
});
$('#promptsPage').addEventListener('click',async e=>{
  const b=e.target.closest('[data-pp]');if(!b)return;const a=b.dataset.pp;
  const fail=(el,err)=>{if(el){el.textContent=err.message||String(err);el.classList.add('bad')}};
  if(a==='close')closePrompts();
  else if(a==='syssave'){const v=$('#ppSys').value.trim();
    try{await savePrompts({system:v&&v!==PROMPTS.system.trim()?v:null});renderPrompts();$('#ppSysMsg').textContent='Saved. It applies from the next reply.'}catch(err){fail($('#ppSysMsg'),err)}}
  else if(a==='sysreset')askConfirm('Go back to the default system prompt?','Your version is replaced by the one Digress comes with.',async()=>{try{await savePrompts({system:null});renderPrompts();$('#ppSysMsg').textContent='Back to the default.'}catch(err){toast(err.message||String(err))}},{ok:'Reset',kind:'primary'});
  else if(a==='qadd'){PP.q.push(['','']);renderQuickRows();quickChanged();const r=$('#ppQ').lastElementChild;r&&r.querySelector('input').focus()}
  else if(a==='qdel'){PP.q.splice(+b.closest('.ppqrow').dataset.i,1);renderQuickRows();quickChanged()}
  else if(a==='qsave'){const q=PP.q.map(([l,x])=>[l.trim(),x.trim()]).filter(([l,x])=>l&&x);
    if(!q.length){fail($('#ppQMsg'),new Error('Keep at least one, with a label and a question, or Reset to default.'));return}
    try{await savePrompts({quick:sameJson(q,PROMPTS.quick)?null:q});refreshChips();renderPrompts();$('#ppQMsg').textContent='Saved.'}catch(err){fail($('#ppQMsg'),err)}}
  else if(a==='qreset'){try{await savePrompts({quick:null});refreshChips();renderPrompts();$('#ppQMsg').textContent='Back to the default.'}catch(err){fail($('#ppQMsg'),err)}}
  else if(a==='skadd'){const v=$('#ppSkIn').value.trim();if(!v){fail($('#ppSkMsg'),new Error('Paste a SKILL.md or a link first, or choose a file.'));return}
    await addSkillFrom(()=>/^https?:\/\/\S+$/.test(v)?skillFromLink(v):putSkill(v,{source:''}))}
  else if(a==='skedit'){const id=b.closest('.ppsk').dataset.skid;PP.editing=PP.editing===id?null:id;renderSkillList()}
  else if(a==='sksave'){const el=b.closest('.ppsk'),id=el.dataset.skid,m=el.querySelector('.ppmsg');
    try{await putSkill(el.querySelector('textarea').value,{id});PP.editing=null;renderSkillList();setStatus('Skill saved')}catch(err){fail(m,err)}}
  else if(a==='skdel'){const id=b.closest('.ppsk').dataset.skid,s=CUSTOM.skills.get(id);if(!s)return;
    askConfirm(`Delete the skill “${skillLabel(s)}”?`,'Conversations that had it on carry on without it.',async()=>{
      try{await io.skills.remove(id);CUSTOM.skills.delete(id);if(PP.editing===id)PP.editing=null;renderSkillList();syncSkillT()}catch(err){toast(err.message||String(err))}})}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&$('#promptsPage').classList.contains('show')&&!$('#modal').classList.contains('show')){e.preventDefault();closePrompts()}});
$('#promptsBtn').addEventListener('click',()=>openPrompts());
$('#skillT').addEventListener('click',e=>{e.stopPropagation();openSkillMenu(e.currentTarget)});


/* ---------- export and import ----------
   A .digress file is one gzipped JSON document: {digress: 1, exported, conversations: [content as saved, without
   layout or version], cards: [...], files: {id: {type, data (base64)}}}. It's made in this browser and saved to this
   device; nothing is sent anywhere (reading the conversation's own files from this server is the only request).
   Left out: the document unless asked (the reader can attach their own copy: doc.left), the reading mark, pins,
   archive/trash state and flashcard schedules (cards, when asked, arrive in the inbox, fresh). Import gives
   everything new ids, so a file can be opened twice or next to the original. Markdown (to read elsewhere) and
   Anki CSV (the kept cards) are export only. */
const DIGRESS_V=1;
const isDigressFile=(f)=>!!f&&/\.digress$/i.test(f.name||'');
const b64Blob=(b64,type)=>{const s=atob(b64),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return new Blob([u],{type})};
async function gzip(text){if(typeof CompressionStream==='undefined')return new Blob([text],{type:'application/json'});return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()}
async function gunzipText(buf){
  const u=new Uint8Array(buf);
  if(u.length>=2&&u[0]===0x1f&&u[1]===0x8b)return new TextDecoder().decode(await gunzipBytesCapped(u,FILE_MAX_DECODED));
  if(u.byteLength>FILE_MAX_DECODED)throw new Error('That file is too large to open safely.');
  return new TextDecoder().decode(u);
}
function saveFile(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),20000)}
const fileSafe=(t)=>String(t||'').replace(/[\\/:*?"<>|\x00-\x1f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,80)||'conversation';
async function convFull(id){
  if(conv&&conv.id===id)return contentOf(conv);
  const d=await io.store.get(id);if(!d)throw new Error('That conversation couldn’t be loaded.');
  const {rev,ui,...rest}=d;return JSON.parse(JSON.stringify({...rest,id}));
}
// every image record in a conversation (pasted into questions, an article's pictures, clipped images): {asset|data, type, w, h}
const imageRecs=(c)=>[...Object.values(c.msgs||{}).flatMap(m=>(m&&m.images)||[]),...Object.values((c.doc&&c.doc.images)||{}),...Object.values(c.threads||{}).map(t=>t&&t.anchorShot),...Object.values(c.threads||{}).flatMap(t=>(t&&t.anchorImages)||[])].filter(Boolean);
async function digressFile(id,o={}){
  const raw=await convFull(id),c=o.branch?sliceBranch(raw,o.branch):raw,files={},withImgs=o.images!==false;
  const grab=async(assetId,type)=>{if(!assetId||files[assetId])return;const buf=await io.files.fetch(assetId);files[assetId]={type:type||'application/octet-stream',data:await blobB64(new Blob([buf]))}};
  for(const k of ['trashed','archived','pinned','folder','dropCards','cards'])delete c[k];
  for(const t of Object.values(c.threads))delete t.pinned;
  for(const m of Object.values(c.msgs)){delete m.run;delete m.runFrom;if(!withImgs)delete m.images}
  if(!withImgs){for(const t of Object.values(c.threads)){delete t.anchorShot;delete t.anchorImages}}
  if(c.doc){
    delete c.doc.mark;delete c.doc.unsaved;
    if(o.doc){
      if(o.inlineText&&c.doc.kind!=='pdf'&&c.doc.assetId){
        c.doc.text=await io.files.fetch(c.doc.assetId,'text');
        delete c.doc.assetId;
      }else if(c.doc.assetId)await grab(c.doc.assetId,c.doc.kind==='pdf'?'application/pdf':'text/markdown');
      if(!withImgs)delete c.doc.images;
    }else{delete c.doc.assetId;delete c.doc.text;delete c.doc.images;c.doc.left=true}
  }
  if(withImgs)for(const im of imageRecs(c))if(im.asset)await grab(im.asset,im.type).catch(e=>{console.warn('image left out',e);delete im.asset});
  let cards=[];
  if(o.cards){await loadCards();
    for(const k of CARDS.values()){if(k.conv!==id||k.fix)continue;
      if(o.branch&&!c.threads[k.thread])continue;
      const x={front:k.front,back:k.back,thread:k.thread,at:k.at,where:k.where,src:k.src,created:k.created};
      if(k.quote)x.quote=k.quote;if(withImgs&&k.image){x.image={...k.image};if(x.image.asset)await grab(x.image.asset,x.image.type).catch(()=>{delete x.image})}
      cards.push(x)}}
  return {file:{digress:DIGRESS_V,exported:Date.now(),conversations:[c],cards,files},title:c.title};
}
async function exportDigress(id,o){const {file,title}=await digressFile(id,o);saveFile(await gzip(JSON.stringify(file)),fileSafe(title)+'.digress')}
// Markdown: each thread a section; a branch follows the thread it came from, under the passage it was about
function convMarkdown(c){
  const kids=(tid)=>Object.values(c.threads).filter(t=>t.parent===tid&&!t.alt).sort((a,b)=>(a.created||0)-(b.created||0));
  const say=(m)=>stripCiteQuotes(String(m.content||m.text||'')).trim(),out=[`# ${c.title||'Conversation'}`,''];
  const meta=[`Exported from Digress, ${new Date().toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'})}`,c.doc&&`about “${c.doc.name||'a document'}”`].filter(Boolean).join(', ');
  out.push(`*${meta}.*`,'');
  const walk=(tid,depth)=>{
    const t=c.threads[tid];if(!t)return;const h='#'.repeat(Math.min(6,2+depth));
    out.push(`${h} ${tid==='main'?'Main thread':(t.title||'Branch')}`,'');
    if(t.parent){const p=c.threads[t.parent],from=t.anchorMsg==='DOC'?`the document${t.anchorPage!=null?`, ${docPagesLabel(t)}`:''}`:t.anchorMsg==='CLIP'?`${t.anchorTitle?`“${t.anchorTitle}”`:'a clipping'}${t.anchorUrl?` (${t.anchorUrl})`:''}`:(t.parent==='main'?'the main thread':`“${(p&&p.title)||'a branch'}”`);
      out.push(t.anchorText?`> ${String(t.anchorText).replace(/\s+/g,' ').trim()}`:'',`*Branched from ${from}${t.anchorText?'':' (the whole reply)'}.*`,'')}
    for(const id of c.order[tid]||[]){const m=c.msgs[id];if(!m)continue;const x=say(m);
      if(m.role==='user')out.push(`**You:** ${x}${(m.images||[]).length?` *(${m.images.length} image${m.images.length>1?'s':''})*`:''}`,'');
      else if(m.role==='note'){const f=c.threads[m.fromThread];out.push(`> **Takeaway from “${(f&&f.title)||m.fromTitle||'a branch'}”:**`,...x.split('\n').map(l=>'> '+l),'')}
      else if(x)out.push(x,'',m.model?`<sub>${modelLabel(m.model)}</sub>`:'','')}
    for(const k of kids(tid))walk(k.id,depth+1);
  };
  walk('main',0);
  return out.filter((l,i,a)=>!(l===''&&a[i-1]==='')).join('\n').trim()+'\n';
}
async function exportMarkdown(id,branch){const raw=await convFull(id),c=branch?sliceBranch(raw,branch):raw;saveFile(new Blob([convMarkdown(c)],{type:'text/markdown'}),fileSafe(c.title)+'.md')}
// Anki imports this as is (File → Import): front, back, the sentence it came from, and a tag for the conversation
async function exportAnki(id,branch){
  await loadCards();const raw=await convFull(id),c=branch?sliceBranch(raw,branch):raw;
  const cards=[...CARDS.values()].filter(k=>k.conv===id&&k.status!=='inbox'&&(!branch||c.threads[k.thread]));
  const cell=(v)=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"',tag='digress::'+fileSafe(c.title).replace(/[\s:]+/g,'_');
  const lines=['#separator:comma','#html:false','#columns:Front,Back,Source,Tags','#tags column:4',...cards.map(k=>[k.front,k.back,k.quote?k.quote.text:'',tag].map(cell).join(','))];
  saveFile(new Blob([lines.join('\n')+'\n'],{type:'text/csv'}),fileSafe(c.title)+' (cards).csv');
}
async function openExport(id,branch){
  const m=convList.find(x=>x.id===id)||{};let nCards=0,hasDoc=!!m.doc,docName=m.docName||'',hasImgs=false,isPdf=false,scope=null,title=m.title||'this conversation';
  try{const raw=await convFull(id);scope=branch?sliceBranch(raw,branch):raw;hasImgs=imageRecs(scope).length>0;hasDoc=!!scope.doc;docName=(scope.doc&&scope.doc.name)||docName;isPdf=!!(scope.doc&&scope.doc.kind==='pdf');if(branch&&scope.title)title=scope.title}catch(e){}
  try{await loadCards();nCards=[...CARDS.values()].filter(k=>k.conv===id&&!k.fix&&(!branch||!scope||scope.threads[k.thread])).length}catch(e){}
  const kept=[...CARDS.values()].filter(k=>k.conv===id&&k.status!=='inbox'&&(!branch||!scope||scope.threads[k.thread])).length;
  const curBase=location.origin+location.pathname,onPublic=curBase===PUBLIC_DEMO_URL;
  let linkUrl='',linkOk=false,linkSeq=0;
  askConfirm(`${branch?'Export branch':'Export'} “${trunc(title,60)}”`,`<div class="xopts">
    <label class="xopt"><input type="radio" name="xfmt" value="digress" checked><span><span><b>Digress file</b> <i class="xext">.digress</i></span><small>${branch?'This branch (its path and any sub-branches). Open it in your Digress, or someone else’s, to read it and carry on.':'Everything: every branch, highlight and takeaway. Open it in your Digress, or someone else’s, to read it and carry on.'}</small></span></label>
    <div class="xsub" id="xFileSub">${hasDoc?`<label><input type="checkbox" id="xDoc"><span>Include the document <small>${esc(trunc(docName||'the document',50))}. Without it, whoever opens the file attaches their own copy.</small></span></label>`:''}${nCards?`<label><input type="checkbox" id="xCards"><span>Include ${nCards>1?`the ${nCards} flashcards`:'its flashcard'} <small>They arrive in the inbox, without your review history.</small></span></label>`:''}</div>
    <label class="xopt"><input type="radio" name="xfmt" value="link"><span><span><b>Shareable link</b> <i class="xext">#share=…</i></span><small>Paste in a message to share with one click. The conversation lives in the URL’s <code>#</code> fragment, which browsers never send to any server.</small></span></label>
    <div class="xsub off" id="xLinkSub">
      ${hasDoc?`<label><input type="checkbox" id="xLDoc"><span>Include the document <small>${esc(trunc(docName||'the document',50))}${isPdf?' (PDFs are usually too large for a link)':''}. Without it, whoever opens the link attaches their own copy.</small></span></label>`:''}
      ${hasImgs?`<label><input type="checkbox" id="xLImg"><span>Include images <small>Pasted screenshots and snips make links much longer.</small></span></label>`:''}
      ${nCards?`<label><input type="checkbox" id="xLCards"><span>Include ${nCards>1?`the ${nCards} flashcards`:'its flashcard'} <small>They arrive in the inbox, without your review history.</small></span></label>`:''}
      ${onPublic?'':`<label><input type="checkbox" id="xLPub"><span>Use public Digress link <small>Links to <code>digress.neejweej.workers.dev</code> instead of this address, so someone outside your network can open it.</small></span></label>`}
      <div class="xsize" id="xLSize">Select Shareable link to estimate size.</div>
    </div>
    <label class="xopt"><input type="radio" name="xfmt" value="md"><span><span><b>Markdown</b> <i class="xext">.md</i></span><small>To read in another app: each branch a section, under the passage it came from.</small></span></label>
    ${kept?`<label class="xopt"><input type="radio" name="xfmt" value="anki"><span><span><b>Flashcards for Anki</b> <i class="xext">.csv</i></span><small>Your ${kept} kept card${kept>1?'s':''}, with the sentence each came from. In Anki: File → Import.</small></span></label>`:''}
    <div class="xnote">${ic('check')}Made in your browser and saved to this device. Nothing is uploaded.</div></div>`,
  async()=>{const f=(document.querySelector('[name=xfmt]:checked')||{}).value;
    try{
      if(f==='md'){await exportMarkdown(id,branch);setStatus('Exported')}
      else if(f==='anki'){await exportAnki(id,branch);setStatus('Exported')}
      else if(f==='link'){
        if(!linkUrl||!linkOk)throw new Error('This conversation is too large for a shareable link. Export it as a .digress file instead.');
        const p=copyText(linkUrl);await p;setStatus('Link copied');toast('Share link copied. Nothing was uploaded.');
      }else{
        const doc=!!($('#xDoc')||{}).checked,cards=!!($('#xCards')||{}).checked;
        await exportDigress(id,{doc,cards,branch});setStatus('Exported');
      }
    }catch(e){console.warn(e);toast('Couldn’t export it: '+((e&&e.message)||'error'))}},{ok:'Export',kind:'primary',wide:true});
  const fileSub=$('#xFileSub'),linkSub=$('#xLinkSub'),sizeEl=$('#xLSize'),okBtn=$('#mOk');
  const estimateLink=async()=>{
    const seq=++linkSeq;linkUrl='';linkOk=false;
    if(sizeEl){sizeEl.className='xsize';sizeEl.textContent='Estimating link size…'}
    if(okBtn)okBtn.disabled=true;
    try{
      const doc=!!($('#xLDoc')||{}).checked,images=!!($('#xLImg')||{}).checked,cards=!!($('#xLCards')||{}).checked;
      const pub=!!($('#xLPub')||{}).checked;
      const {file}=await digressFile(id,{doc,images,cards,branch,inlineText:true});
      const {token}=await encodeSharePayload(file);
      if(seq!==linkSeq)return;
      const url=buildShareUrl(token,pub?PUBLIC_DEMO_URL:curBase);
      const st=shareSizeStatus(url.length);
      linkUrl=url;linkOk=st.ok;
      if(sizeEl){sizeEl.className='xsize '+st.level;sizeEl.textContent=st.text}
      if(okBtn&&document.querySelector('[name=xfmt]:checked')?.value==='link')okBtn.disabled=!st.ok;
    }catch(e){
      if(seq!==linkSeq)return;
      if(sizeEl){sizeEl.className='xsize over';sizeEl.textContent=(e&&e.message)||'Could not build share link.'}
    }
  };
  const syncFmt=()=>{
    const v=(document.querySelector('[name=xfmt]:checked')||{}).value;
    if(fileSub)fileSub.classList.toggle('off',v!=='digress');
    if(linkSub)linkSub.classList.toggle('off',v!=='link');
    if(okBtn){okBtn.textContent=v==='link'?'Copy link':'Export';okBtn.disabled=v==='link'&&!linkOk}
    if(v==='link')estimateLink();
  };
  document.querySelectorAll('#mBody [name=xfmt]').forEach(r=>r.addEventListener('change',syncFmt));
  if(linkSub)linkSub.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{if(document.querySelector('[name=xfmt]:checked')?.value==='link')estimateLink()}));
}
// --- import ---
function fresh(c){
  const bad=[];if(!c||typeof c!=='object'||!c.threads||!c.msgs||!c.order||typeof c.threads!=='object'||typeof c.msgs!=='object')return ['not a conversation'];
  for(const m of Object.values(c.msgs)){if(!m||!['user','assistant','note'].includes(m.role))bad.push('a message of an unknown kind');else for(const k of ['content','text'])if(m[k]!=null&&typeof m[k]!=='string')bad.push('a message that isn’t text')}
  return bad.concat(ThreadOps.check(c));
}
async function importDigressData(d,kind='file'){
  if(!d||d.digress!==DIGRESS_V||!Array.isArray(d.conversations)||!d.conversations.length){toast(d&&d.digress>DIGRESS_V?`That ${kind} is from a newer Digress. Update this one to open it.`:`That isn’t a Digress ${kind}.`);return false}
  await io.ready;if(!io.store){toast('Nothing can be saved here, so it can’t be imported.');return false}
  const files=d.files&&typeof d.files==='object'?d.files:{},made=new Map();
  const restore=async(rec)=>{if(!rec||typeof rec!=='object')return;
    if(rec.asset){const f=files[rec.asset];const old=rec.asset;delete rec.asset;delete rec.data;if(!f||typeof f.data!=='string')return;
      if(!made.has(old))made.set(old,(await storeImages([{blob:b64Blob(f.data,f.type),type:f.type,w:rec.w,h:rec.h}]))[0]);
      const r=made.get(old);if(r.asset)rec.asset=r.asset;else rec.data=r.data;return}
    if(rec.data!=null){try{parseInlineImageDataUrl(rec.data)}catch(_){delete rec.data}}};
  let first=null,n=0,nc=0;
  for(const src of d.conversations){
    const c=JSON.parse(JSON.stringify(src)),problems=fresh(c);
    if(problems.length){console.warn('import: skipped a conversation',problems);toast(`Part of that ${kind} is damaged, so it was left out.`);continue}
    const old=c.id,id='c'+Date.now().toString(36)+rid().slice(0,4);
    for(const k of ['rev','ui','trashed','archived','pinned','folder','dropCards','cards'])delete c[k];
    const {tMap,mMap}=remapConvIds(c,(p)=>p+rid());
    c.id=id;c.title=typeof c.title==='string'&&c.title?c.title:'Shared conversation';c.created=+c.created||Date.now();c.updated=Date.now();c.nextColor=+c.nextColor||0;
    for(const m of Object.values(c.msgs)){for(const f of [...LOCAL_MSG,'run','runFrom'])delete m[f];for(const im of m.images||[])await restore(im)}
    if(c.doc){
      if(typeof c.doc!=='object'){delete c.doc}
      else{
        const a=c.doc.assetId&&files[c.doc.assetId];delete c.doc.assetId;
        if(a){const blob=b64Blob(a.data,a.type),pdf=c.doc.kind==='pdf';if(!await storeDocFile(c,c.doc.kind,blob,pdf?null:await blob.text()))c.doc.left=true}
        else if(typeof c.doc.text==='string'){const txt=c.doc.text;delete c.doc.text;if(!await storeDocFile(c,c.doc.kind,null,txt))c.doc.text=txt}
        else if(c.doc.text==null)c.doc.left=true;
        for(const im of Object.values(c.doc.images||{}))await restore(im);
        for(const t of Object.values(c.threads||{}))if(t&&t.anchorShot)await restore(t.anchorShot);
      }
    }
    for(const t of Object.values(c.threads||{})){
      if(!t)continue;
      if(t.anchorPage!=null){const p=normalizePageIndex(t.anchorPage);if(p==null)delete t.anchorPage;else t.anchorPage=p}
      if(t.anchorEnd!=null){
        const pe=typeof t.anchorEnd==='object'?normalizePageIndex(t.anchorEnd.page):null;
        if(pe==null||t.anchorPage==null||pe<=t.anchorPage)delete t.anchorEnd;
        else t.anchorEnd={...t.anchorEnd,page:pe};
      }
      for(const im of t.anchorImages||[])await restore(im);
    }
    try{const r=await io.store.save(id,c,0);if(!r||!r.rev)throw new Error('not saved')}catch(e){console.warn(e);toast('Couldn’t save the imported conversation.');continue}
    n++;first=first||{id,title:c.title};
    for(const k of Array.isArray(d.cards)?d.cards:[]){
      if(!k||typeof k.front!=='string'||typeof k.back!=='string'||!k.front.trim()||(k.conv&&k.conv!==old))continue;
      const newThread=(k.thread&&tMap.get(k.thread))||'main';
      const newAt=k.at&&typeof k.at==='object'&&mMap.has(k.at.msg)?{...k.at,msg:mMap.get(k.at.msg),thread:tMap.get(k.at.thread)||c.msgs[mMap.get(k.at.msg)].thread}:null;
      const card={id:'k'+rid()+rid(),conv:id,convTitle:c.title,thread:c.threads[newThread]?newThread:'main',at:newAt,where:typeof k.where==='string'?k.where:'',src:typeof k.src==='string'?k.src:'',front:k.front,back:k.back,status:'inbox',created:Date.now(),due:null,fsrs:null,reviews:[]};
      if(k.quote&&typeof k.quote.text==='string')card.quote=k.quote.msg&&mMap.has(k.quote.msg)?{...k.quote,msg:mMap.get(k.quote.msg)}:{...k.quote};
      if(k.image&&typeof k.image==='object'){card.image={...k.image};await restore(card.image);if(!card.image.asset&&!card.image.data)delete card.image}
      await putCard(card);nc++;
    }
  }
  if(!first)return false;
  await loadList();renderConvList();await openConv(first.id);
  toast(`Opened “${trunc(first.title,50)}”${n>1?` and ${n-1} more`:''}${nc?`, with ${nc} card${nc>1?'s':''} in your inbox`:''}.${window.DemoReplies?' It’s kept only in this browser; delete it from the sidebar to remove it.':''}`);
  return true;
}
async function importDigress(file){
  let d;
  try{d=JSON.parse(await gunzipText(await file.arrayBuffer()))}catch(e){toast('That file couldn’t be read as a Digress file.');return}
  await importDigressData(d,'file');
}
async function importShareHash(hash){
  const token=parseShareHash(hash);if(!token)return false;
  // Clear #share= from the address bar immediately so reloading never prompts a second time.
  try{history.replaceState(history.state,'',location.pathname+location.search)}catch(e){}
  let d;
  try{d=await decodeSharePayload(token)}catch(e){toast((e&&e.message)||'That share link couldn’t be read.');return false}
  if(!d||d.digress!==DIGRESS_V||!Array.isArray(d.conversations)||!d.conversations.length){toast(d&&d.digress>DIGRESS_V?'That link is from a newer Digress. Update this one to open it.':'That isn’t a Digress link.');return false}
  const c0=d.conversations[0];
  if(!c0||fresh(c0).length){toast('That share link is damaged and couldn’t be opened.');return false}
  const title=typeof c0.title==='string'&&c0.title?c0.title:'Shared conversation';
  const nMsgs=Object.keys(c0.msgs||{}).length;
  const nBranches=Object.values(c0.threads||{}).filter(t=>t&&t.parent&&!t.alt).length;
  const nCards=Array.isArray(d.cards)?d.cards.length:0;
  const parts=[`${nMsgs} message${nMsgs===1?'':'s'}`];
  if(nBranches)parts.push(`${nBranches} branch${nBranches===1?'':'es'}`);
  if(c0.doc&&!c0.doc.left)parts.push('with document');
  if(nCards)parts.push(`${nCards} flashcard${nCards===1?'':'s'}`);
  return new Promise((resolve)=>{
    askConfirm('Open shared conversation?',
      `<p><b>${esc(trunc(title,80))}</b></p><p style="color:var(--muted);font-size:13px;margin-top:4px">${esc(parts.join(' · '))}. Nothing was uploaded; opening adds a local copy to your Digress.</p>`,
      async()=>{resolve(await importDigressData(d,'link'))},
      {ok:'Open',kind:'primary',onCancel:()=>resolve(false)});
  });
}
window.addEventListener('hashchange',()=>{if(parseShareHash(location.hash))importShareHash(location.hash)});
// a .digress file dropped anywhere (outside a question box) opens as its conversation
document.addEventListener('dragover',e=>{if(e.dataTransfer&&[...(e.dataTransfer.items||[])].some(i=>i.kind==='file'))e.preventDefault()});
document.addEventListener('drop',e=>{const f=e.dataTransfer&&[...e.dataTransfer.files].find(isDigressFile);if(!f||e.target.closest('#docDrop'))return;e.preventDefault();importDigress(f)});

/* ---------- context for the model (pure logic lives in ./context.js) ---------- */
const ctxEnv=()=>({conv,docState:state.docState,docView,custom:CUSTOM,prompts:PROMPTS,threadOps:ThreadOps,settings,io});
function buildContext(tid,excludeMid,opts){
  const res=buildContextPure(ctxEnv(),tid,excludeMid,opts);
  DOC_MOD.lastDocSeen=res.docSeen;
  return res;
}
// Turns image refs into what the connector sends: {type:'image',mediaType,data(base64)}. If an image
// can't be loaded the whole request fails with a clear error: nothing is sent with a piece missing.
// Connectors that can't take images get a note in its place saying so (and the reader a toast).
async function resolveContext(ctx,canImages){
  let skipped=0;const messages=[];
  for(const m of ctx.messages){
    if(typeof m.content==='string'){messages.push(m);continue}
    const parts=[];
    for(const p of m.content){
      if(p.type!=='image'){parts.push(p);continue}
      if(!canImages){skipped++;parts.push({type:'text',text:PROMPTS.noImages(p.label||'an image')});continue}
      let b;try{b=await imageBlob(p.ref)}catch(e){throw {message:`An image in this conversation (${p.label||'an image'}) couldn’t be loaded, so nothing was sent. ${(e&&e.message)||''}`}}
      parts.push({type:'image',mediaType:b.type,data:await blobB64(b)});
    }
    messages.push({role:m.role,content:joinParts(parts)});
  }
  return {...ctx,messages,skipped};
}

/* ---------- generation ---------- */
function addMsg(tid,role,content,extra){
  const m={id:'m'+rid(),thread:tid,role,content,ts:Date.now(),ver:0,...(extra||{})};
  const back=Object.values(conv.threads).filter(t=>t.parent===tid&&joinable(t));
  conv.msgs[m.id]=m;conv.order[tid].push(m.id);
  if(back.length)setTimeout(()=>{for(const t of back)if(T(t.id))renderPane(t.id);if(conv.ui.view==='canvas')renderCanvas()});
  return m;
}
async function send(tid,text,imgs){
  text=(text||'').trim();imgs=imgs||[];if(!text&&!imgs.length)return;
  if(streaming.has(tid)){toast('Wait for the current reply to finish');return}
  const t=T(tid);
  let extra;
  if(imgs.length){streaming.set(tid,{mid:null,ctrl:new AbortController()});try{extra={images:await storeImages(imgs)}}finally{streaming.delete(tid)}}
  if(tid==='main'&&!conv.titleKept&&!conv.order.main.some(id=>conv.msgs[id].role==='user')){conv.title=trunc(text||'Question about an image',120);delete conv.autoTitle;renderTitle()}
  if(t.autoTitle&&!conv.order[tid].length){t.title=trunc(text||'About an image',48);delete t.autoTitle;refreshAnchorsFor(tid)}
  // asked in main with the PDF open beside it: the question keeps the page it was asked on (PROMPTS.lookingAt)
  if(tid==='main'&&state.docState&&state.docState.kind==='pdf'&&conv.ui.open.includes('doc')&&!isCollapsed('doc')&&docView.current)extra={...extra,lookAt:docView.current};
  addMsg(tid,'user',text,extra);
  const am=addMsg(tid,'assistant','');am.pending=true;
  renderPane(tid,true);renderMap();save();
  if(conv.ui.view==='canvas'){renderCanvas();const f=document.querySelector(`#cv .cnode[data-ctid="${tid}"] .cfull`);if(f)f.scrollTop=f.scrollHeight}
  await docReady();
  await generate(am,buildContext(tid,am.id),tid);
}
// Writes reply m. The reply runs on the server as run m.run (server/runs.mjs), saved with the message while
// it's being written, so it survives this page losing its connection, switching conversation or reloading
// (resumeRuns picks it up again), and the server writes it in itself if nobody comes back.
// o.resume: reconnect to m.run instead of asking. o.prefix: text it carries on from (Continue).
async function generate(m,ctx,lockTid,o={}){
  const ctrl=new AbortController(),run=o.resume?m.run:runId(),st={mid:m.id,ctrl,run,conv};
  streaming.set(lockTid,st);updateComposer(lockTid);markReplies();let tick=0;
  const prefix=o.prefix||'';
  try{
    if(!io.llm)await io.ready;
    let web=!!m.web;
    if(!o.resume){
      web=!!(settings.web&&io.llm.supportsWeb);if(web)m.web=true;else delete m.web;delete m.searches;delete m.sources;delete m.reads;delete m.toolNow;delete m.cut;
      applyConvLlm(m.thread,true);   // the model this thread asks with (the picker follows it)
      if(io.llm.supportsEffort)m.effort=settings.effort;else delete m.effort;
      stickLlm(m.thread,false);   // a thread keeps the model it started with
      if(ctx.docSeen)m.docSeen=ctx.docSeen;else delete m.docSeen;
      m.run=run;save();await flushNow();   // saved with its run first, so the server can finish it into this message
    }
    // m.live: what it has done so far, shown while it works (not saved: generate drops it when done)
    m.live=[];m.t0=m.t0||Date.now();tick=setInterval(()=>queueStream(m.id),1000);
    const step=(icon,text,done)=>{const l=m.live[m.live.length-1];if(l)l.done=true;m.live.push({icon,text,done});queueStream(m.id)};
    const toolText=(name,input)=>name==='suggest_card'?`suggested a flashcard: “${trunc(String(input.front||''),60)}”`:trailText(name==='search'?{t:'search',q:[].concat(input.queries!=null?input.queries:input.query||'').map(String).join('”, “')}:name==='read_pages'?{t:'read',a:input.from,b:input.to||input.from}:{t:'view',p:input.page});
    let nCards=0;
    const trail=[...(o.resume&&m.reads||[])],tools=ctx.tools?{names:ctx.tools,run:async(name,input)=>{   // the model reading the document or suggesting a card: run the call here, show what it's doing
      if(name==='suggest_card'){try{const r=await suggestCard(st.conv,m,input);if(!r.error)nCards++;return r}finally{const l=m.live[m.live.length-1];if(l)l.done=true;queueStream(m.id)}}
      try{await docReady();return await runDocTool(name,input,trail)}finally{m.reads=[...trail];const l=m.live[m.live.length-1];if(l)l.done=true;queueStream(m.id)}}}:undefined;
    let nq=0;
    const keepSearch=(x)=>{if(x.searches&&x.searches.length){m.searches=[...x.searches];for(;nq<x.searches.length;nq++)step('globe',`searched the web for “${x.searches[nq]}”`,false)}if(x.sources&&x.sources.length)m.sources=x.sources.slice(0,30)};
    const onTool=(call,done)=>step(call.name==='suggest_card'?'cards':'doc',toolText(call.name,call.input||{}),done);
    const onText=(text)=>{m.content=prefix+text;const l=m.live[m.live.length-1];if(l)l.done=true;queueStream(m.id)};
    let r;
    if(o.resume)r=await io.llm.complete({resume:true,run,signal:ctrl.signal,onText,onSearch:(x)=>{keepSearch(x);queueStream(m.id)},onTool,tools});
    else{
      const rc=await resolveContext(ctx,!!io.llm.supportsImages);
      if(rc.skipped)toast('This connection can’t send images, so the AI only gets a note where each image was.');
      r=await io.llm.complete({system:rc.system,messages:rc.messages,model:settings.model,effort:settings.effort,web,signal:ctrl.signal,run,save:{conv:conv.id,msg:m.id},
        onText,onSearch:(x)=>{keepSearch(x);queueStream(m.id)},onTool,tools});
    }
    m.content=prefix+r.text;if(r.model)m.model=r.model;if(r.usage)m.usage=r.usage;keepSearch(r);
    if(nCards){const c0=st.conv;toast(`The AI suggested ${nCards} flashcard${nCards>1?'s':''}: ${nCards>1?'they’re':'it’s'} in your inbox`,{label:'Open',fn:()=>{if(conv===c0)openCards(c0.id,'inbox')}})}
    if(r.truncated)m.error='Reply was cut off (length limit).';
    else if(!String(r.text||'').trim())m.error='No answer came back from the model. Retry, or ask something narrower.';   // never a blank reply that looks finished
  }catch(e){
    if(st.detached){clearInterval(tick);return}   // the page moved to another conversation: the reply carries on without it
    if(e&&e.text!==undefined)m.content=prefix+e.text;
    if(e&&e.searches&&e.searches.length)m.searches=[...e.searches];if(e&&e.sources&&e.sources.length)m.sources=e.sources.slice(0,30);
    if(e&&e.cut&&!st.stopped){m.cut=true;m.error='Cut off before it finished: '+e.message}
    else m.error=st.stopped||ctrl.signal.aborted||(e&&e.stopped)?'Stopped.':(e&&e.code==='rate_limited'?'Rate limited. Wait a moment and retry.':(e&&e.message)||'Something went wrong.');
  }
  clearInterval(tick);
  if(conv!==st.conv)return;
  delete m.pending;delete m.run;delete m.runFrom;delete m.toolNow;delete m.live;delete m.t0;if(m.reads&&!m.reads.length)delete m.reads;m.ver++;streaming.delete(lockTid);
  if(!seenNow(m.thread))unread.add(m.thread);   // finished out of sight: badge it until it's opened
  if(document.hidden&&!m.error){tabReady=true;tabName()}
  cardsAfterReply(m);nameAfterReply(m);
  renderPane(m.thread);updateComposer(lockTid);renderMap();save();
  if(conv.ui.view==='canvas')renderCanvas();
  markReplies();
}
// --- titles: a conversation or branch is named by its first question; a long or vague one gets a short title from
// a fast model once its first reply ends. Never over a title you set (titleKept) or one that's no longer the question.
const MODEL_FAM=(id)=>/claude|haiku|sonnet|opus/i.test(id||'')?'claude':/gpt|^o\d/i.test(id||'')?'gpt':/^gemini/i.test(id||'')?'google':null;
// the fast model of the family this conversation uses (Haiku or Terra): the one family its replies came from, else its
// kept model's, else the reply's; with only one provider connected, that one
function titleModel(c,hint){
  const ids=io.llm.models().map(x=>x[0]),fast={claude:ids.find(x=>/haiku/i.test(x)),gpt:ids.find(x=>/terra/i.test(x))||ids.find(x=>/mini|luna/i.test(x)),google:ids.find(x=>/^gemini.*flash-lite/i.test(x))||ids.find(x=>/^gemini.*flash/i.test(x))};
  const avail=Object.keys(fast).filter(k=>fast[k]);if(!avail.length)return hint||settings.model;if(avail.length===1)return fast[avail[0]];
  const used=new Set(Object.values(c.msgs).filter(m=>m.role==='assistant'&&m.model).map(m=>MODEL_FAM(m.model)).filter(Boolean));
  const f=used.size===1?[...used][0]:MODEL_FAM(c.llm&&c.llm[0])||MODEL_FAM(hint);return fast[f]||fast[avail[0]];
}
const qText=(m)=>String((m&&(m.content||m.text))||'').replace(/\s+/g,' ').trim();
// the question names it well enough as it is: short and more than a word or two
const goodAsTitle=(q,max)=>q.length<=max&&q.split(' ').length>=3;
async function nameAfterReply(m){
  if(!m||m.error||!io.llm||!io.llm.models||io.offline)return;
  const c0=conv,tid=m.thread,t=T(tid);if(!t||t.alt)return;
  const ord=c0.order[tid]||[],q=c0.msgs[ord.find(id=>c0.msgs[id].role==='user')];
  if(!q||ord.find(id=>c0.msgs[id].role==='assistant')!==m.id)return;   // only after a thread's first reply
  const question=qText(q);if(!question)return;
  const isMain=tid==='main',limit=isMain?120:48,cur=()=>isMain?c0.title:T(tid)&&T(tid).title;
  const was=trunc(q.content||(isMain?'Question about an image':'About an image'),limit);
  const still=()=>conv===c0&&(isMain?!c0.titleKept:!(T(tid)||{}).titleKept)&&cur()===was;
  if(!still()||goodAsTitle(question,isMain?50:48))return;
  try{
    const r=await io.llm.complete({system:PROMPTS.title.system,messages:[{role:'user',content:PROMPTS.title.ask({kind:isMain?'conversation':'branch',question:trunc(question,600),reply:trunc(plain(m.content||''),1500),passage:isMain?'':trunc(t.regionText||t.anchorText||'',300),doc:c0.doc&&c0.doc.name})}],model:titleModel(c0,m.model),effort:'low',web:false});
    const name=cleanTitle(r.text);if(!name||!still())return;
    if(isMain){c0.title=name;delete c0.autoTitle;renderTitle()}else{T(tid).title=name;delete T(tid).autoTitle;refreshAnchorsFor(tid);updateHeader(tid)}
    renderMap();if(conv.ui.view==='canvas')renderCanvas();save();
  }catch(e){console.warn('no title',e)}
}
const cleanTitle=(s)=>{let x=String(s||'').split('\n').map(l=>l.trim()).find(Boolean)||'';x=x.replace(/^(title:\s*)/i,'').replace(/^["'“”‘’*#\s]+|["'“”‘’*.\s]+$/g,'');return x.length>=2&&x.length<=80?x:''};
// Stop: tell the server to stop the model, and stop reading
function stopReply(s){if(!s)return;s.stopped=true;if(s.run&&io.llm&&io.llm.stop)io.llm.stop(s.run);s.ctrl.abort()}
// replies saved as still being written (m.run): from this page before a reload, or from another device.
// Reconnect to each; the server replays it from the start and goes on with it.
function resumeRuns(){
  for(const m of Object.values(conv.msgs)){
    if(!m.run||m.role!=='assistant'||[...streaming.values()].some(s=>s.mid===m.id))continue;
    if(streaming.has(m.thread))continue;
    const prefix=(m.content||'').slice(0,m.runFrom||0);m.content=prefix;m.pending=true;m.ver++;
    const names=io.llm&&io.llm.supportsTools?[...(conv.doc?DOC_TOOL_NAMES:[]),...(cardsOn()?['suggest_card']:[])]:[];
    generate(m,{tools:names.length?names:false},m.thread,{resume:true,prefix});
  }
}
// a reply that was cut off: ask the model to carry on from where it stopped
async function continueReply(mid){
  const m=conv.msgs[mid];if(!m||m.role!=='assistant'||streaming.has(m.thread))return;
  if(retryBlock(mid)){const q=questionOf(mid);if(q)newVersion(q.id,q.content);return}
  const before=m.content||'';delete m.cut;delete m.error;m.pending=true;m.runFrom=before.length;m.ver++;renderPane(m.thread);
  await docReady();
  const ctx=buildContext(m.thread,m.id);
  ctx.messages.push({role:'assistant',content:before},{role:'user',content:PROMPTS.continueCut});
  await generate(m,ctx,m.thread,{prefix:before});
}
function retry(mid){
  const m=conv.msgs[mid];if(!m||streaming.has(m.thread))return;
  // a reply the conversation went on from (or that has branches or cards) isn't replaced: ask again as another version
  if(m.role==='assistant'&&retryBlock(mid)){const q=questionOf(mid);if(q)newVersion(q.id,q.content);return}
  if(m.role==='note'){m.thread&&delete conv.msgs[mid];conv.order[m.thread]=conv.order[m.thread].filter(x=>x!==mid);bringBack(m.fromThread,m.focus||'');return}
  m.content='';delete m.error;m.pending=true;m.ver++;renderPane(m.thread);generate(m,buildContext(m.thread,m.id),m.thread);
}
/* Redo and Edit (the simple case): replace the latest reply in a thread, or change the question before it,
   only while nothing depends on that reply: it's the thread's last message, no branch starts from it and no
   flashcard was drafted from it. Anything else would leave branches or cards pointing at text that's gone. */
function redoBlock(mid){   // why this reply can't be redone in place, or '' if it can
  const m=conv.msgs[mid];if(!m||m.role!=='assistant'||m.pending)return 'busy';
  if(streaming.has(m.thread))return 'busy';
  const ord=conv.order[m.thread];if(ord[ord.length-1]!==mid)return 'later';
  if(branchesOn(mid).length)return 'branches';
  for(const c of CARDS.values())if(c.conv===conv.id&&c.at&&c.at.msg===mid)return 'cards';
  return '';
}
// Retry and Continue change a reply in place too, so the same rule: not once anything builds on it
function retryBlock(mid){const m=conv.msgs[mid];if(!m||m.role!=='assistant')return '';const t=m.pending;m.pending=false;const w=redoBlock(mid);m.pending=t;return w==='busy'?'':w}
const REDO_WHY={keep:'the answer you have is kept',later:'the conversation has gone on after it',branches:'branches start from it',cards:'flashcards were drafted from it',busy:'a reply is being written'};
function questionOf(mid){const m=conv.msgs[mid],ord=conv.order[m.thread],i=ord.indexOf(mid);for(let k=i-1;k>=0;k--){const q=conv.msgs[ord[k]];if(q&&q.role==='user')return q;if(q&&q.role==='assistant')return null}return null}
// the reply to a question, if it's right after it
function replyTo(qid){const q=conv.msgs[qid],ord=conv.order[q.thread],n=conv.msgs[ord[ord.indexOf(qid)+1]];return n&&n.role==='assistant'?n:null}
/* Edit and Redo never replace an answer: with one there, they ask again in a new branch that starts just before the
   question (newVersion), beside the original, which stays as it was: the same anywhere in a thread, the last question
   included. Only a reply that failed or never came (an error, nothing written) is replaced in
   place, since there's nothing to keep. (Retry and Continue keep their own rule: retryBlock.) */
const hasAnswer=(m)=>!!m&&m.role==='assistant'&&!m.error&&!!String(m.content||'').trim();
const redoKeep=(mid)=>redoBlock(mid)||(hasAnswer(conv.msgs[mid])?'keep':'');
const editKeep=(qid)=>{const w=editBlock(qid);if(w)return w;const r=replyTo(qid);return r&&hasAnswer(r)?'keep':''};
function editBlock(qid){   // why this question can't be edited in place, or ''
  const q=conv.msgs[qid];if(!q||q.role!=='user')return 'busy';if(streaming.has(q.thread))return 'busy';
  const ord=conv.order[q.thread],r=replyTo(qid),last=r?r.id:qid;
  if(ord[ord.length-1]!==last)return 'later';
  return r?redoBlock(r.id):'';
}
/* Another version: when a reply can't be replaced in place, Redo and Edit ask again in a new thread that
   starts where the question did (threads.js: an 'alt' thread, no side-question prefix). Nothing that was
   there changes. "Use this version" (ThreadOps.swap) makes it the one the conversation goes on with. */
// the question's versions: [{tid, qid}] for every thread that asks it from the same starting point
function versionsOf(qid){
  const q=conv.msgs[qid];if(!q||q.role!=='user')return [];
  const t=T(q.thread),ord=conv.order[q.thread],i=ord.indexOf(qid);
  let base=q.thread,anchor=i?ord[i-1]:'START';
  if(i===0&&t.alt){base=t.parent;anchor=t.anchorMsg}
  if(i===0&&!t.alt&&t.parent)return [];   // the first question of a side branch has no versions
  const out=[],bo=conv.order[base],j=anchor==='START'?0:bo.indexOf(anchor)+1;
  if(j>=0&&bo[j]&&conv.msgs[bo[j]].role==='user')out.push({tid:base,qid:bo[j]});
  for(const x of Object.values(conv.threads))if(x.alt&&x.parent===base&&x.anchorMsg===anchor&&conv.order[x.id].length)out.push({tid:x.id,qid:conv.order[x.id][0]});
  return out;
}
function openVersions(qid){
  const q=conv.msgs[qid];if(!q)return;
  for(const v of versionsOf(qid))if(v.tid!==q.thread)openThread(v.tid,q.thread);
  const base=versionsOf(qid).find(v=>!T(v.tid).alt||v.tid===T(q.thread).parent);
  if(base&&base.tid!==q.thread)revealMsg(base.tid,base.qid);
  renderMap();save();
}
async function newVersion(qid,text){
  const q=conv.msgs[qid],t=T(q.thread),ord=conv.order[q.thread],i=ord.indexOf(qid);
  text=(text||'').trim();if(!text&&!(q.images&&q.images.length))return;
  let x;
  if(i===0&&ThreadOps.prefixed(t)){   // the first question of a side branch: ask it again as a new side branch about the same passage
    x={...t,id:'t'+rid(),created:Date.now(),colorIdx:conv.nextColor++};for(const k of ['pinned','resolved','hidden','autoTitle'])delete x[k];
  }else{
    let parent=q.thread,anchor=i?ord[i-1]:'START';
    if(i===0&&t.alt){parent=t.parent;anchor=t.anchorMsg}   // a version of a version starts where both do
    x={id:'t'+rid(),parent,anchorMsg:anchor,anchorText:'',alt:true,created:Date.now(),colorIdx:conv.nextColor++,title:'↻ '+trunc(text||'Another version',46)};
  }
  conv.threads[x.id]=x;conv.order[x.id]=[];
  addMsg(x.id,'user',text,q.images&&q.images.length?{images:q.images}:undefined);
  const am=addMsg(x.id,'assistant','');am.pending=true;
  q.ver++;renderPane(q.thread);openThread(x.id,q.thread);renderMap();save();
  if(conv.ui.view==='canvas'){const S=cvState();if(!S.open.includes(x.id))S.open.push(x.id);renderCanvas();focusCard(x.id)}
  await docReady();
  await generate(am,buildContext(x.id,am.id),x.id);
}
function useVersion(tid){
  const t=T(tid);if(!t||!t.alt)return;
  if(joinable(t))return moveBack(tid);   // nothing on the parent's side to trade: swapping would leave an empty version
  if(streaming.has(tid)||streaming.has(t.parent)){toast('Wait for the reply to finish');return}
  const firstQ=(id)=>conv.order[id].find(x=>conv.msgs[x].role==='user');
  const oldFirst=t.parent==='main'?firstQ('main'):null;
  let changed;try{changed=ThreadOps.swap(conv,[...CARDS.values()],tid)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  // a title that came from the first question follows the version now in use
  if(t.parent==='main'&&!conv.titleKept&&oldFirst&&conv.title===trunc(conv.msgs[oldFirst].content||'Question about an image',120)){const q=conv.msgs[firstQ('main')];conv.title=trunc(q.content||'Question about an image',120);renderTitle()}
  const newQ=conv.msgs[conv.order[tid][0]];if(newQ&&newQ.role==='user')t.title='↻ '+trunc(newQ.content||'Another version',46);
  for(const id of [t.parent,tid])for(const m of conv.order[id])conv.msgs[m].ver++;
  refreshAll();if(conv.ui.view==='canvas')focusCard(t.parent);else revealPane(t.parent);
  setStatus('Now using this version; the other one is in “'+t.title+'”');
  // the old version is now that branch: one click to drop it (the usual delete, which asks about its cards)
  toast('Now using this version. The old one is in its own branch.',{label:'Delete the old version',fn:()=>{if(T(tid))confirmDeleteBranch(tid)}});
}
async function redo(mid){
  const why=redoKeep(mid);
  if(why){const q=questionOf(mid);if(why==='busy'||!q){toast(`This reply can’t be redone: ${REDO_WHY[why]}.`);return}return newVersion(q.id,q.content)}
  const m=conv.msgs[mid];
  m.content='';for(const k of ['error','model','effort','usage','docSeen','reads','searches','sources','web'])delete m[k];
  m.pending=true;m.ver++;renderPane(m.thread);renderMap();
  await docReady();
  await generate(m,buildContext(m.thread,m.id),m.thread);
}
/* Start main over (document conversations): main's messages move into another version of it (ThreadOps.split
   before its first message: an 'alt' thread from START), so main is empty and the next question starts from just
   the document. Branches, takeaways and cards go with the messages they came from. Undo joins it back
   (ThreadOps.join, while main is still empty); later, "Use this version" swaps it back. */
async function startMainOver(){
  const ord=conv.order.main;if(!ord.length)return;
  if(streaming.size){toast('Wait for the reply to finish');return}
  const first=ord.find(id=>conv.msgs[id].role==='user'),fq=first?conv.msgs[first].content:'';
  const fresh={id:'t'+rid(),created:Date.now(),colorIdx:conv.nextColor++,anchorText:'',title:fq?'Earlier main · '+trunc(fq,40):'Earlier main thread'};
  let changed;try{changed=ThreadOps.split(conv,[...CARDS.values()],'main',ord[0],fresh)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  const oldTitle=conv.title,named=!conv.titleKept&&first&&conv.title===trunc(fq||'Question about an image',120);
  if(named){conv.title=conv.doc?conv.doc.name:'New conversation';renderTitle()}   // the next first question names it again
  conv.ui.open=conv.ui.open.filter(x=>x!==fresh.id);if(!conv.ui.open.includes('main'))conv.ui.open.push('main');
  refreshAll();renderMap();renderConvList();save();revealPane('main');
  const ta=paneEls.get('main')&&paneEls.get('main').querySelector('textarea');if(ta)ta.focus();
  toast('Started the main thread over. What was in it is now another version, under Branches.',{label:'Undo',fn:()=>{
    if(conv.order.main.length){toast('Main has gone on since: open the earlier version and use “Use this version”.');return}
    let ch;try{ch=ThreadOps.join(conv,[...CARDS.values()],fresh.id)}catch(e){toast(e.message);return}
    for(const c of ch)putCard(c);if(named)conv.title=oldTitle;renderTitle();refreshAll();renderMap();renderConvList();save();
  }});
}
/* Move what follows a reply into a branch (the reply's ⋯): ThreadOps.split just after it, so the rest becomes
   another version starting there, each message seeing exactly what it saw before; the thread ends at the reply and
   the next question goes on from it. Until the thread goes on, the moved part shows as a chip under the reply
   (movedOn); deleting that branch is rewinding. Undo joins it back while the thread still ends there. */
const movedOn=(mid)=>{const m=conv.msgs[mid];if(!m)return [];const ord=conv.order[m.thread]||[];if(ord[ord.length-1]!==mid)return [];
  return Object.values(conv.threads).filter(t=>t.alt&&t.parent===m.thread&&t.anchorMsg===mid&&!hiddenNow(t.id))};
// a version whose parent stops right where it starts: what followed there was moved out (or main was started
// over), so it can simply go back (ThreadOps.join). "Use this version" would swap in an empty side and leave an
// empty version behind.
const joinable=(t)=>{if(!t||!t.alt||!T(t.parent))return false;const o=conv.order[t.parent]||[];return t.anchorMsg===(o.length?o[o.length-1]:'START')};
// the message of its parent a version starts after, quoted for its header and first card; null when it starts at the start
function versionAfter(t,n){
  if(t.anchorMsg==='START')return null;
  const m=conv.msgs[t.anchorMsg];if(!m)return 'an earlier message';
  const s=trunc(plain(m.content).replace(/\s+/g,' ').trim(),n);
  return s?(m.role==='note'?'the takeaway “'+s+'”':'“'+s+'”'):(m.role==='user'?'a question about an image':'a reply');
}
const versionWhere=(t,n)=>{const a=versionAfter(t,n);return a?'after '+a:'from the start'};
// a version made here opens beside its parent (a card on the canvas); one joined back is gone from view
function showVersion(tid,parent){
  openThread(tid,parent);
  if(conv.ui.view==='canvas'){const S=cvState();if(!S.open.includes(tid))S.open.push(tid);renderCanvas();focusCard(tid)}
}
function dropJoined(tid,parent){
  const ui=conv.ui;delete (ui.sizes||{})[tid];
  if(!ui.open.length)ui.open=[parent];ui.collapsed=ui.collapsed.filter(x=>ui.open.includes(x));
  if(!ui.open.some(x=>!isCollapsed(x)))ui.collapsed=[];
  layout();
}
// Move back: a moved-out version goes back onto the end of its parent and the branch goes away. Undo moves it out again.
function moveBack(tid){
  const t=T(tid);if(!joinable(t))return;
  if(streaming.has(tid)||streaming.has(t.parent)){toast('Wait for the reply to finish');return}
  const keep={...t},ids=[...conv.order[tid]],parent=t.parent,pn=parent==='main'?'the main thread':'“'+T(parent).title+'”';
  let changed;try{changed=ThreadOps.join(conv,[...CARDS.values()],tid)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  for(const m of ids)conv.msgs[m].ver++;
  dropJoined(tid,parent);refreshAll();renderConvList();if(conv.ui.view==='canvas')focusCard(parent);else revealPane(parent);
  if(!ids.length){toast('Removed the empty branch.');return}
  toast(`Moved back into ${pn}.`,{label:'Undo',fn:()=>{
    const o=conv.order[parent]||[];
    if(T(keep.id)||o.length<ids.length||o.slice(-ids.length).join()!==ids.join()){toast(`${pn[0].toUpperCase()+pn.slice(1)} has changed since, so this can’t be undone.`);return}
    let ch;try{ch=ThreadOps.split(conv,[...CARDS.values()],parent,ids[0],keep)}catch(e){toast(e.message);return}
    for(const c of ch)putCard(c);for(const m of ids)conv.msgs[m].ver++;refreshAll();renderConvList();showVersion(keep.id,parent);
  }});
}
function replyMenuItems(m){
  const ord=conv.order[m.thread]||[],i=ord.indexOf(m.id);
  return m.role==='assistant'&&!m.pending&&i>=0&&i<ord.length-1?['moverest']:[];
}
function openReplyMenu(btn,mid){
  let menu=$('#replyMenu');if(!menu){menu=document.createElement('div');menu.className='thmenu';menu.id='replyMenu';menu.setAttribute('role','menu');document.body.appendChild(menu);
    document.addEventListener('pointerdown',e=>{if(menu.classList.contains('open')&&!menu.contains(e.target)&&!e.target.closest('[data-act=rmore]'))menu.classList.remove('open')},true);
    menu.onclick=(e)=>{const b=e.target.closest('[data-rm]');if(!b)return;menu.classList.remove('open');if(b.dataset.rm==='moverest')moveRestOut(menu.dataset.mid)}}
  if(menu.classList.contains('open')&&menu.dataset.mid===mid){menu.classList.remove('open');return}
  const m=conv.msgs[mid];if(!m)return;menu.dataset.mid=mid;
  const n=conv.order[m.thread].length-conv.order[m.thread].indexOf(mid)-1;
  menu.innerHTML=`<button data-rm="moverest" title="The ${n} message${n>1?'s':''} after this reply move into a branch of their own, as they are. This thread then goes on from here.">${ic('branch')}Move what follows into a branch</button>`;
  menu.classList.add('open');const r=btn.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,r.left))+'px';
  menu.style.top=(r.bottom+4+menu.offsetHeight<=innerHeight-8?r.bottom+4:Math.max(8,r.top-4-menu.offsetHeight))+'px';
  menu.querySelector('button').focus();
}
const closeReplyMenu=()=>{const m=$('#replyMenu');if(m&&m.classList.contains('open')){m.classList.remove('open');return true}return false};
function moveRestOut(mid){
  const m=conv.msgs[mid];if(!m)return;const tid=m.thread,ord=conv.order[tid],i=ord.indexOf(mid);
  if(i<0||i===ord.length-1)return;
  const tail=ord.slice(i+1);
  if(tail.some(id=>conv.msgs[id].pending)){toast('Wait for the reply to finish');return}
  const q=tail.map(id=>conv.msgs[id]).find(x=>x.role==='user');
  const fresh={id:'t'+rid(),created:Date.now(),colorIdx:conv.nextColor++,anchorText:'',title:q?trunc(q.content||'Question about an image',60):'Moved from '+T(tid).title};
  let changed;try{changed=ThreadOps.split(conv,[...CARDS.values()],tid,tail[0],fresh)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  refreshAll();renderConvList();showVersion(fresh.id,tid);
  toast(`Moved ${tail.length} message${tail.length>1?'s':''} into a branch, opened beside this one. This thread goes on from that reply; the branch’s Move back puts them back.`,{label:'Undo',fn:()=>{
    if(!T(fresh.id))return;
    let ch;try{ch=ThreadOps.join(conv,[...CARDS.values()],fresh.id)}catch(e){toast('This thread has gone on since, so it can’t be undone. The moved part is still a branch.');return}
    for(const c of ch)putCard(c);dropJoined(fresh.id,tid);refreshAll();renderConvList();
  }});
}
/* New conversation from this document: the same file (the same stored asset; a file goes only when nothing uses it),
   nothing else. The reading mark stays with the old one. */
async function newFromDoc(){
  if(!conv.doc)return;
  if(!await leaveOk())return;
  const src=conv,c=newConv(),d=JSON.parse(JSON.stringify(src.doc));delete d.mark;
  c.doc=d;c.ui.open=['doc','main'];
  if(src.titleKept){c.title=src.title;c.titleKept=true}else{c.title=d.name||'New conversation';if(d.kind==='pdf')c.autoTitle=c.title}
  const data=docBlobCache.get(src.id);if(data!=null)cacheDocBlob(c.id,data);
  setConv(c);dirty=true;save();
  toast('A new conversation on the same document. The other one is still in the sidebar.');
}
async function saveEdit(qid,text){
  const why=editKeep(qid);if(why==='busy'){toast(`This question can’t be edited now: ${REDO_WHY[why]}.`);return false}
  if(why){if(!(text||'').trim()&&!(conv.msgs[qid].images||[]).length)return false;newVersion(qid,text);return false}
  const q=conv.msgs[qid],tid=q.thread,t=T(tid),old=q.content||'';text=(text||'').trim();
  if(!text&&!(q.images&&q.images.length))return false;
  q.content=text;q.ver++;
  // a title that came from this question follows it
  if(tid==='main'&&!conv.titleKept&&conv.order.main.find(id=>conv.msgs[id].role==='user')===qid&&conv.title===trunc(old||'Question about an image',120)){conv.title=trunc(text||'Question about an image',120);renderTitle()}
  if(t.parent&&conv.order[tid].find(id=>conv.msgs[id].role==='user')===qid&&t.title===trunc(old||'About an image',48)){t.title=trunc(text||'About an image',48);refreshAnchorsFor(tid);updateHeader(tid)}
  let r=replyTo(qid);
  if(!r){r=addMsg(tid,'assistant','');r.pending=true;renderPane(tid);save();await docReady();await generate(r,buildContext(tid,r.id),tid);return true}
  await redo(r.id);return true;
}
function startEdit(el,qid){
  const q=conv.msgs[qid];const why=editKeep(qid);if(why==='busy'){toast(`This question can’t be edited now: ${REDO_WHY[why]}.`);return}
  el.classList.add('editing');
  const box=document.createElement('div');box.className='uedit';
  box.innerHTML=`<textarea rows="3"></textarea><div class="ubtns"><span class="hint">${why?'Asks it in a new branch beside this one, with the model and effort selected now. This stays as it is.':'Asks again with the model and effort selected now.'}</span><button class="mbtn" data-ue="cancel">Cancel</button><button class="mbtn primary" data-ue="save">Send</button></div>`;
  const ta=box.querySelector('textarea');ta.value=q.content||'';
  [...el.children].forEach(c=>c.style.display='none');el.appendChild(box);ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);
  const close=()=>{box.remove();el.classList.remove('editing');[...el.children].forEach(c=>c.style.display='')};
  box.addEventListener('click',async e=>{const b=e.target.closest('[data-ue]');if(!b)return;e.stopPropagation();if(b.dataset.ue==='cancel')return close();
    b.disabled=true;const ok=await saveEdit(qid,ta.value);if(!ok){b.disabled=false;close()}});
  ta.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close()}else if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();box.querySelector('[data-ue=save]').click()}});
}
/* Where a takeaway's knowledge ends in its branch: the last message it saw. Recorded as upTo when it's made; older
   ones are worked out from the times (the last message from before the takeaway). The branch shows a divider there
   once it has gone on past it (anything below isn't in the takeaway), and the takeaway's header links to it. */
function takeawayCut(n){
  const o=(conv.order[n.fromThread]||[]).filter(id=>conv.msgs[id]);
  if(n.upTo&&o.includes(n.upTo))return n.upTo;
  let cut=null;for(const id of o)if((conv.msgs[id].ts||0)<=(n.ts||0))cut=id;return cut;
}
function takeawayCuts(tid){   // message id -> the takeaways that stop after it, only where the branch goes on below
  const out=new Map(),o=(conv.order[tid]||[]).filter(id=>conv.msgs[id]);if(!o.length)return out;
  for(const n of Object.values(conv.msgs)){
    if(n.role!=='note'||n.fromThread!==tid||n.pending||!T(n.thread))continue;
    const c=takeawayCut(n);if(!c||c===o[o.length-1])continue;
    if(!out.has(c))out.set(c,[]);out.get(c).push(n);
  }
  return out;
}
function tkcutEl(n){
  const d=document.createElement('div');d.className='tkcut';d.dataset.tknote=n.id;d.style.setProperty('--c',color(T(n.fromThread)));
  const p=T(n.thread);d.title='Go to this takeaway. Everything below this line came after it, so it isn’t in the takeaway.';
  d.innerHTML='<span></span>';d.firstChild.textContent='Takeaway carried back to '+(p&&p.parent?'“'+trunc(p.title||'branch',40)+'”':'the main thread');
  return d;
}
function goToTakeaway(noteId){   // from a branch's divider to the takeaway in its parent
  const n=conv.msgs[noteId];if(!n)return;
  if(conv.ui.view==='canvas'){focusCard(n.thread,n.id);flashMsgIn(n.thread,n.id);return}
  openThread(n.thread);revealMsg(n.thread,n.id);
}
function goToTakeawaySource(noteId){   // from a takeaway's header to the last reply it saw, in its branch
  const n=conv.msgs[noteId];if(!n||!T(n.fromThread))return;const cut=takeawayCut(n);
  if(conv.ui.view==='canvas'){focusCard(n.fromThread,cut||undefined);if(cut)flashMsgIn(n.fromThread,cut);return}
  openThread(n.fromThread);if(cut)revealMsg(n.fromThread,cut);
}
function flashMsgIn(tid,mid){   // on the canvas, once focusCard has opened the card and scrolled it
  requestAnimationFrame(()=>{const m=$('#cv').querySelector(`.cnode[data-ctid="${tid}"] .cfull .msg[data-mid="${mid}"]`);if(!m)return;
    m.style.setProperty('--c',color(T(tid)));m.classList.remove('flash');void m.offsetWidth;m.classList.add('flash')});
}
async function bringBack(tid,focus){
  const t=T(tid);if(!t||!t.parent)return;
  if(!conv.order[tid].some(id=>conv.msgs[id].role==='assistant'&&conv.msgs[id].content)){toast('Ask something in this branch first');return}
  const parent=t.parent;
  if(streaming.has(parent)){toast('Wait for the parent thread to finish replying');return}
  await docReady();
  const ctx=buildContext(tid);
  const ask=PROMPTS.takeawayAsk(focus);
  const msgs=ctx.messages,last=msgs[msgs.length-1];if(last&&last.role==='user')appendText(last,'\n\n'+ask);else msgs.push({role:'user',content:ask});
  const upTo=(conv.order[tid]||[]).filter(id=>conv.msgs[id]).at(-1);   // the last message this takeaway sees (takeawayCut)
  const note=addMsg(parent,'note','',{fromThread:tid,focus,upTo});note.pending=true;
  if(!conv.ui.open.includes(parent))openThread(parent);
  conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!==parent);layout();
  renderPane(parent,true);revealPane(parent);
  await generate(note,ctx,parent);
}

/* A PDF passage selected across a page break. The browser's range follows the text layer's order, which isn't always
   the reading order: a selection from the foot of one page onto the next once took a box printed at the top of the
   first page and its footer along with it (both highlighted, and quoted to the model in the middle of the passage).
   So only the text that sits where the selection is counts: on the first page from where it starts, on down, up to
   the first piece that isn't (so the highlight is one run), on the last page from its first piece that is, up to
   where it ends, and nowhere a running header or footer (the top and bottom PAGE_EDGE of a page, except the line
   the selection itself starts or ends on). Lines are joined with a space: the text layer marks a line's end with
   a <br>, which a range's text leaves out ("Oneof"). Returns the text, where the first page's part starts and
   ends (s, e1), and where the last page's starts and ends (s2, e2), as anchor offsets. */
const PAGE_EDGE=0.07;
function crossPageText(rng,tl1,p1,p2){
  const pane=tl1.closest('.pane'),pieces=[];let s=-1,e1=-1,s2=-1,e2=-1;
  const sr=document.createRange();sr.setStart(rng.startContainer,rng.startOffset);sr.collapse(true);
  const er=document.createRange();er.setStart(rng.endContainer,rng.endOffset);er.collapse(true);
  const at=(r)=>{const b=r.getClientRects();return b.length?b[0]:r.getBoundingClientRect()};
  const startY=at(sr),endY=at(er);
  for(let i=p1;i<=p2;i++){
    const tl=pane.querySelector(`.dpage[data-page="${i}"] .textLayer`);if(!tl)continue;
    const box=tl.getBoundingClientRect(),first=i===p1,last=i===p2;
    const w=textWalker(tl);let n,c=0,run=first?'on':'wait';
    while((n=w.nextNode())){
      const L=n.nodeValue.length,before=c;c+=nonWs(n.nodeValue);
      if(!rng.intersectsNode(n))continue;
      const a=n===rng.startContainer?rng.startOffset:0,b=n===rng.endContainer?rng.endOffset:L;if(b<=a)continue;
      const str=n.nodeValue.slice(a,b);if(!str.trim())continue;
      const r=document.createRange();r.setStart(n,a);r.setEnd(n,b);const q=r.getBoundingClientRect();if(!q.height)continue;
      const mid=(q.top+q.bottom)/2,own=(first&&mid>=startY.top-1&&mid<=startY.bottom+1)||(last&&mid>=endY.top-1&&mid<=endY.bottom+1);
      let ok=own||(mid>box.top+box.height*PAGE_EDGE&&mid<box.bottom-box.height*PAGE_EDGE);
      if(ok&&first&&q.bottom<startY.top-1)ok=false;   // printed above where the selection starts
      if(ok&&last&&q.top>endY.bottom+1)ok=false;      // below where it ends
      const from=before+nonWs(n.nodeValue.slice(0,a)),to=before+nonWs(n.nodeValue.slice(0,b));
      if(first){if(run!=='on')continue;if(!ok){run='done';continue}if(s<0)s=from;e1=to}
      else if(!ok)continue;
      else if(last){if(s2<0)s2=from;e2=to}
      pieces.push({str,q,page:i});
    }
  }
  if(s<0||s2<0)return null;
  let text='';
  for(let k=0;k<pieces.length;k++){const x=pieces[k],p=pieces[k-1];
    if(p&&(p.page!==x.page||x.q.top>=p.q.bottom-p.q.height*0.5||x.q.bottom<=p.q.top))text=text.replace(/\s+$/,'')+(p.page!==x.page?'\n':' ')+x.str.replace(/^\s+/,'');
    else text+=x.str}
  return {text:text.trim(),s,e1,s2,e2};
}

/* ---------- branching ---------- */
function createBranch(mid,anchorText,question,title,range,page,img){
  const isDoc=mid==='DOC';const m=isDoc?null:conv.msgs[mid];const parent=isDoc?'main':m.thread;
  const t={id:'t'+rid(),parent,anchorMsg:mid,anchorText:anchorText||'',created:Date.now(),colorIdx:conv.nextColor++};
  if(anchorText&&range)t.anchorRange=range;
  if(isDoc)t.anchorPage=page||0;
  if(isDoc&&range&&img&&img.end&&img.end.page>t.anchorPage)t.anchorEnd={page:img.end.page,e:img.end.e,...(img.end.s>0?{s:img.end.s}:{})};   // runs on to a later page (from s on it, when a header comes first)
  const r4=(v)=>Math.round(v*1e4)/1e4;
  if(isDoc&&img&&img.region){const g=img.region;t.anchorRegion={x:r4(g.x),y:r4(g.y),w:r4(g.w),h:r4(g.h)};if(img.regionText)t.regionText=img.regionText}
  if(isDoc&&img&&img.image){const g=img.image;t.anchorImg={key:g.key,n:g.n,x:r4(g.x),y:r4(g.y),w:r4(g.w),h:r4(g.h)}}
  if(isDoc&&img&&img.shot){t.anchorShot=img.shot;if(img.regionText)t.regionText=img.regionText;if(!range&&img.near)t.anchorAt=img.near}
  if(title)t.title=title;else if(question)t.title=trunc(question,48);else{t.title=anchorText?trunc(anchorText,40):'Side question';t.autoTitle=!anchorText}
  conv.threads[t.id]=t;conv.order[t.id]=[];
  if(isDoc)refreshDocAnchors(t.anchorPage);else{m.ver++;renderPane(parent)}
  openThread(t.id,parent);renderMap();save();
  if(conv.ui.view==='canvas'){const S=cvState();if(!S.open.includes(t.id))S.open.push(t.id);renderCanvas();focusCard(t.id)}
  if(question)send(t.id,question);
  else setTimeout(()=>{const ta=conv.ui.view==='canvas'?document.querySelector(`#cv .cnode[data-ctid="${t.id}"] .cask textarea`):paneEls.get(t.id)&&paneEls.get(t.id).querySelector('textarea');ta&&ta.focus({preventScroll:conv.ui.view==='canvas'})},30);
}
function deleteBranch(tid){
  const t=T(tid);if(!t||!t.parent)return;
  const kill=[tid,...Object.keys(conv.threads).filter(x=>isDesc(x,tid))];
  for(const k of kill)stopReply(streaming.get(k));
  for(const k of kill){for(const mid of conv.order[k]||[]){delete conv.msgs[mid];msgCache.delete(mid)}delete conv.order[k];delete conv.threads[k]}
  const keep=x=>conv.threads[x]||(x==='doc'&&conv.doc);
  conv.ui.open=conv.ui.open.filter(keep);conv.ui.collapsed=conv.ui.collapsed.filter(keep);
  for(const k of kill)delete conv.ui.sizes[k];
  if(conv.msgs[t.anchorMsg])conv.msgs[t.anchorMsg].ver++;
  if(isDocBranch(t))refreshDocAnchors(t.anchorPage);
  for(const m of Object.values(conv.msgs))if(m.role==='note'&&kill.includes(m.fromThread))m.ver++;
  layout();conv.ui.open.forEach(id=>renderPane(id));renderMap();save();
  if(conv.ui.view==='canvas')renderCanvas();
  toast('Branch deleted');
}
function openThread(tid,from){
  const ui=conv.ui;
  if(ui.open.includes(tid)){ui.collapsed=ui.collapsed.filter(x=>x!==tid);layout();revealPane(tid);return}
  const src=from||T(tid).parent;
  if(src&&src!=='main'&&src!=='doc'&&!ui.open.includes(src))openThread(src);   // a closed main or document stays closed: you closed it
  let i=ui.open.indexOf(src);
  if(tid==='main')i=ui.open.indexOf('doc');   // main comes back first (after the document)
  else if(i<0)i=ui.open.length-1;else while(i+1<ui.open.length&&isDesc(ui.open[i+1],src))i++;
  ui.open.splice(i+1,0,tid);
  layout();renderMap();revealPane(tid);save();
}
// Any pane can close, main and the document included, as long as another stays open. Main thread and the document
// have rows in the sidebar's Branches that bring them back.
function closeThread(tid,o={}){
  const t=T(tid),ui=conv.ui;if(!ui.open.includes(tid))return;
  if(ui.open.length<2){if(tid==='main'&&isBlank(conv)){discardBlank();return}toast('At least one pane stays open');return}
  const kids=tid==='main'||tid==='doc'?[]:ui.open.filter(x=>isDesc(x,tid));   // open branches under it stay open (each one's crumb reopens this pane)
  ui.open=ui.open.filter(x=>x!==tid);ui.collapsed=ui.collapsed.filter(x=>ui.open.includes(x));
  if(!ui.open.some(x=>!isCollapsed(x)))ui.collapsed=[];   // never leave only strips
  layout();renderMap();save();   // only closes: no scrolling to where it came from (that's Back, in the branch)
  if(!kids.length||o.quiet)return;
  const c0=conv,name=(t.title||'branch').length>40?(t.title.slice(0,38)+'…'):(t.title||'branch');
  toast(`Closed “${name}”, ${kids.length} branch${kids.length>1?'es':''} under it still open`,
    {label:'Close them too',fn:()=>{if(conv!==c0)return;const u=conv.ui;u.open=u.open.filter(x=>!kids.includes(x));u.collapsed=u.collapsed.filter(x=>u.open.includes(x));
      if(!u.open.length)u.open=['main'];layout();renderMap();save()}});
}
/* Is this thread's conversation showing? Columns/Rows: its pane is open and not a strip. Canvas: its card is open. */
function seenNow(tid){
  if(!conv||!conv.ui)return false;
  if(conv.ui.view==='canvas'){const S=conv.ui.cv||{};return !!((S.open||[]).includes(tid)||(S.dock||{})[tid])}
  return conv.ui.open.includes(tid)&&!isCollapsed(tid);
}
const replyState=(tid)=>streaming.has(tid)?'writing':unread.has(tid)?'ready':'';
// the badge on a strip, a folded canvas card and a sidebar row: a pulsing ring while it writes, a dot once it's ready
function markReplies(){
  if(!conv)return;
  for(const tid of [...unread])if(!conv.threads[tid]||seenNow(tid))unread.delete(tid);
  const put=(host,before,st,wrap)=>{if(!host)return;let b=host.querySelector(':scope > .rbadge');
    if(!st){if(b)b.remove();if(wrap)wrap.classList.remove('rready');return}
    if(!b){b=document.createElement('span');host.insertBefore(b,before||null)}
    if(!b.classList.contains(st)){b.className='rbadge '+st;b.innerHTML=st==='ready'?'Ready':'<i></i><i></i><i></i>'}b.title=st==='ready'?'A reply is ready: open it to read':'Writing a reply…';
    if(wrap)wrap.classList.toggle('rready',st==='ready')};
  const st=(tid)=>seenNow(tid)?'':replyState(tid);
  for(const [tid,el] of paneEls){if(tid==='doc')continue;const lb=el.querySelector('.rail-label');put(lb,lb&&lb.querySelector('.rl'),el.classList.contains('rail')?st(tid):'',el)}
  document.querySelectorAll('#cv .cnode[data-ctid]').forEach(n=>{const ch=n.querySelector('.ch');put(ch,ch&&ch.querySelector('.ct')&&ch.querySelector('.ct').nextSibling,st(n.dataset.ctid),n)});
  document.querySelectorAll('#tree .mnode[data-map]').forEach(n=>put(n,n.querySelector('.mc'),st(n.dataset.map)));
}
function toggleCollapse(tid){
  const ui=conv.ui;
  if(isCollapsed(tid))ui.collapsed=ui.collapsed.filter(x=>x!==tid);
  else{
    if(ui.open.filter(x=>!isCollapsed(x)).length<=1){toast('At least one pane stays open');return}
    ui.collapsed.push(tid);
  }
  layout();save();
}
const isFocused=(tid)=>conv.ui.open.length>1&&!isCollapsed(tid)&&conv.ui.open.every(x=>x===tid||isCollapsed(x));
function toggleFocus(tid){
  const ui=conv.ui;
  if(isFocused(tid))ui.collapsed=[];else ui.collapsed=ui.open.filter(x=>x!==tid);
  layout();revealPane(tid);save();
}
function revealPane(tid){
  const el=paneEls.get(tid);if(!el)return;
  requestAnimationFrame(()=>{
    const p=$('#panes');const r=el.getBoundingClientRect(),pr=p.getBoundingClientRect();
    if(conv.ui.layout==='cols'){if(r.right>pr.right||r.left<pr.left)p.scrollBy({left:r.right>pr.right?r.right-pr.right+12:r.left-pr.left-12,behavior:'smooth'})}
    else{if(r.bottom>pr.bottom||r.top<pr.top)p.scrollBy({top:r.bottom>pr.bottom?r.bottom-pr.bottom+12:r.top-pr.top-12,behavior:'smooth'})}
    el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');
    setTimeout(wires,350);
  });
}
/* take the user to the exact spot a branch came from */
// quiet: don't offer "back to where you were" in the parent (closing a branch is already going back)
function revealAnchor(tid,quiet){
  const t=T(tid);if(!t||!t.parent)return;
  if(isDocBranch(t)){revealDocAnchor(t,quiet);return}
  if(conv.ui.view==='canvas')setView(conv.ui.layout);
  if(!conv.ui.open.includes(t.parent))openThread(t.parent);
  if(isCollapsed(t.parent)){conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!==t.parent);layout()}
  const pe=paneEls.get(t.parent);if(!pe)return;
  requestAnimationFrame(()=>{
    const po=conv.order[t.parent],alt=t.alt?po[t.anchorMsg==='START'?0:po.indexOf(t.anchorMsg)+1]:null;
    const a=alt?pe.querySelector(`.msg[data-mid="${qid(alt)}"]`):pe.querySelector(`.anchor[data-tid="${qid(tid)}"]`)||pe.querySelector(`.msg[data-mid="${qid(t.anchorMsg)}"]`);
    if(!a)return;
    const pb=pe.querySelector('.pb');const ar=a.getBoundingClientRect(),br=pb.getBoundingClientRect();
    if(!quiet)rememberSpot(pe);
    pb.scrollBy({top:ar.top-br.top-br.height/3,behavior:'smooth'});
    revealPane(t.parent);
    const spans=pe.querySelectorAll(`.anchor[data-tid="${qid(tid)}"]`);
    if(spans.length)spans.forEach(s=>{s.classList.remove('flash');void s.offsetWidth;s.classList.add('flash')});
    else{const m=pe.querySelector(`.msg[data-mid="${qid(alt||t.anchorMsg)}"]`);if(m){m.style.setProperty('--c',color(t));m.classList.remove('flash');void m.offsetWidth;m.classList.add('flash')}}
    setTimeout(wires,450);
  });
}
function revealMsg(tid,mid){
  const pe=paneEls.get(tid);if(!pe)return;
  requestAnimationFrame(()=>{const m=pe.querySelector(`.msg[data-mid="${qid(mid)}"]`);if(!m)return;const pb=pe.querySelector('.pb');rememberSpot(pe);
    pb.scrollBy({top:m.getBoundingClientRect().top-pb.getBoundingClientRect().top-20,behavior:'smooth'});
    m.style.setProperty('--c',color(T(tid)));m.classList.remove('flash');void m.offsetWidth;m.classList.add('flash')});
}

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

/* ---------- message elements ---------- */
function anchorsKey(m){return branchesOn(m.id).map(t=>t.id+t.title+(t.resolved?'r':'')+(hiddenNow(t.id)?'h':'')).join(',')}
function msgKey(m){return `${m.ver}|${m.pending?1:0}|${mathReady?1:0}|${m.role==='user'?editKeep(m.id)+versionsOf(m.id).length:m.role==='assistant'?redoKeep(m.id):''}|${m.role!=='user'?anchorsKey(m):''}|${m.role==='note'&&T(m.fromThread)?T(m.fromThread).title:''}|${m.role==='assistant'?replyMenuItems(m).length+movedOn(m.id).map(t=>t.id+t.title).join(','):''}`}
function msgEl(m){
  const key=msgKey(m);
  const c=msgCache.get(m.id);if(c&&c.key===key)return c.el;
  const el=document.createElement('div');el.className='msg '+m.role;el.dataset.mid=m.id;
  if(m.role==='user'){userMsgBody(el,m);const eb=editKeep(m.id),vs=versionsOf(m.id);
    if(eb!=='busy'||vs.length>1)el.insertAdjacentHTML('beforeend',`<div class="uact${vs.length>1?' has-v':''}">${vs.length>1?`<button class="vchip" data-vers="${esc(m.id)}" title="This question was asked more than once from here. Open the other versions side by side.">${ic('versions')}${vs.length} versions</button>`:''}${eb!=='busy'?`<button class="ib" data-act="edit" title="${eb?'Edit and ask again in a new branch beside this one (this stays as it is)':'Edit this question and ask again'}">${ic('edit')}</button>`:''}</div>`)}
  else if(m.role==='note'){
    const src=T(m.fromThread);el.style.setProperty('--c',src?color(src):'var(--faint)');
    el.innerHTML=`<div class="nh"><span class="d"></span>Takeaway from ${src?`<button class="nl" data-tkfrom="${esc(m.id)}" title="Open the branch at the last reply this takeaway saw"></button>`:'<i>deleted branch</i>'}<span style="flex:1"></span>${m.error?`<button class="ib" data-act="retry" title="Retry">${ic('retry')}</button>`:''}<button class="ib" data-act="delnote" title="Remove takeaway">${ic('x')}</button></div><div class="body"></div>`;
    if(src)el.querySelector('.nl').textContent=src.title;
    const body=el.querySelector('.body');
    if(m.pending)streamInto(body,m);else{renderRich(body,m.content,true);if(m.error){const e=document.createElement('div');e.className='err';e.textContent=m.error;body.appendChild(e)}}
  }else{
    el.innerHTML='<div class="body"></div><div class="mfoot"></div>';
    const body=el.firstChild;
    if(m.pending){streamInto(body,m)}
    else{
      renderRich(body,m.content,true);applyAnchors(body,m);renderMermaid(body);
      if(m.error){const e=document.createElement('div');e.className='err';e.textContent=m.error;body.appendChild(e)}
      const ws=webSources(m);if(ws)el.insertBefore(ws,el.lastChild);
      const dr=docReads(m);if(dr)el.insertBefore(dr,el.lastChild);
      buildFoot(el.lastChild,m);
    }
  }
  msgCache.set(m.id,{key,el});return el;
}
// Under a reply: how full the context was when it ended ("52k / 1M context · 75% cached"), from the provider's own count.
// The hover gives the exact numbers; the window is left out when the provider didn't say it.
const ktok=(n)=>n<1000?String(n):n<1e6?(n<1e4?(Math.round(n/100)/10)+'k':Math.round(n/1000)+'k'):(Math.round(n/1e5)/10)+'M';
const tokPc=(a,b)=>{const v=a/b*100;return (v>0&&v<1?v.toFixed(1):Math.round(v))+'%'};
// Prompt cache window for providers with a known TTL (e.g. Anthropic's 5m or 1h ephemeral cache):
// cacheAt is UTC epoch ms from the server (or m.ts); clock formats in the browser's local timezone.
function cacheInfo(u,ts){
  const ttl=u&&+u.cacheTtl>0?+u.cacheTtl:0,at=ttl?(+u.cacheAt||+ts||0):0;
  if(!ttl||!at)return null;
  const until=at+ttl*1000,left=until-Date.now();
  const clock=new Date(until).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const win=ttl>=3600?Math.round(ttl/3600)+'h':Math.round(ttl/60)+'m';
  return {ttl,until,left,warm:left>0,clock,win,leftText:left<60000?'<1m':Math.ceil(left/60000)+'m'};
}
function ctxLabel(u,ts){
  const ctx=u&&+u.ctx;if(!ctx||!isFinite(ctx))return '';
  const w=+u.window>0?+u.window:0,cached=Math.min(+u.cached||0,ctx),out=+u.out||0,rounds=+u.rounds||1,n=(x)=>Math.round(x).toLocaleString();
  const ci=cacheInfo(u,ts);
  const tip=`Context when this reply ended: ${n(ctx)} tokens`+(w?` of the model’s ${n(w)} (${Math.max(ctx/w*100,0.1).toFixed(ctx/w<0.1?1:0)}%)`:'')+'.'
    +(cached?` ${n(cached)} of them came from the cache (${tokPc(cached,ctx)}).`:'')+(out?` It wrote ${n(out)} tokens.`:'')
    +(rounds>1?` That took ${rounds} requests (reading the document or searching), each sending the whole context again.`:'')
    +(ci&&ci.warm?` Cache warm until ${ci.clock} (${ci.leftText} left).`:'');
  return `<button type="button" class="model ctxu" data-act="ctxinfo" aria-haspopup="dialog" title="${esc(tip+' Click for the breakdown.')}">${ktok(ctx)}${w?` / ${ktok(w)}`:''} context${cached?` · ${tokPc(cached,ctx)} cached`:''}</button>`;
}
// The breakdown behind that label, on click (a tap on a tablet, which has no hover): input (cached and new),
// output, how many requests, how full the window was, and prompt cache warmth when the provider has a known TTL.
function openUsage(btn,mid){
  let el=$('#usagePop');
  if(!el){el=document.createElement('div');el.className='thmenu upop';el.id='usagePop';el.setAttribute('role','dialog');el.setAttribute('aria-label','Tokens for this reply');document.body.appendChild(el);
    document.addEventListener('pointerdown',e=>{if(el.classList.contains('open')&&!el.contains(e.target)&&!e.target.closest('[data-act=ctxinfo]'))el.classList.remove('open')},true);
    document.addEventListener('scroll',e=>{if(el.classList.contains('open')&&!el.contains(e.target))el.classList.remove('open')},true);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&el.classList.contains('open')){el.classList.remove('open');e.stopPropagation();e.preventDefault()}},true)}
  if(el.classList.contains('open')&&el.dataset.mid===mid){el.classList.remove('open');return}
  const m=conv.msgs[mid],u=m&&m.usage,ctx=u&&+u.ctx;if(!ctx)return;
  const w=+u.window>0?+u.window:0,cached=Math.min(+u.cached||0,ctx),out=+u.out||0,rounds=+u.rounds||1,n=(x)=>Math.round(x).toLocaleString();
  const ci=cacheInfo(u,m.ts);
  const row=(k,v,sub)=>`<div class="ur${sub?' usub':''}"><span>${k}</span><b>${v}</b></div>`;
  el.dataset.mid=mid;
  el.innerHTML=`<div class="thh">Tokens for this reply${m.model?' · '+esc(modelLabel(m.model)):''}</div>`
    +row('Input',n(ctx))+row('from the cache',cached?`${n(cached)} (${tokPc(cached,ctx)})`:'none',1)+row('new',n(ctx-cached),1)
    +row('Output',out?n(out):'not reported')
    +(rounds>1?row('Requests',String(rounds)):'')
    +(w?row('Context window',`${tokPc(ctx,w)} of ${ktok(w)}`):'')
    +(ci?row('Prompt cache',ci.warm?`until ${ci.clock} (${ci.leftText})`:'expired'):'')
    +`<div class="unote">${rounds>1?`Input is the last of the ${rounds} requests (reading the document or searching each sent the whole context again); output counts all of them.`:'Input is everything the model was sent for this reply: the system prompt, the conversation so far and your question.'}${cached?'':' Nothing came from the cache: the provider caches a prefix only when it’s long enough and was sent recently.'}${ci?(ci.warm?` The provider keeps this cached prefix for ${ci.win} from the last request (shown in your local time).`:` This reply’s ${ci.win} cache window has passed unless a later reply refreshed it.`):''}</div>`;
  el.classList.add('open');const r=btn.getBoundingClientRect();
  el.style.left=Math.max(8,Math.min(innerWidth-el.offsetWidth-8,r.left))+'px';
  el.style.top=(r.bottom+4+el.offsetHeight<=innerHeight-8?r.bottom+4:Math.max(8,r.top-4-el.offsetHeight))+'px';
}
const closeUsage=()=>{const m=$('#usagePop');if(m&&m.classList.contains('open')){m.classList.remove('open');return true}return false};
function buildFoot(f,m){
  f.innerHTML=`<button class="tb" data-act="wbranch" title="Open a side branch about this whole reply (no specific passage)">${ic('branch')}Side question</button><button class="ib" data-act="copy" title="Copy Markdown">${ic('copy')}</button>`+(replyMenuItems(m).length?`<button class="ib" data-act="rmore" title="More">${ic('dots')}</button>`:'')+(m.cut&&!retryBlock(m.id)?`<button class="tb" data-act="continue" title="Ask the model to carry on from where it stopped">${ic('send')}Continue</button>`:'')+(m.error?`<button class="ib" data-act="retry" title="${m.role==='assistant'&&retryBlock(m.id)?'Ask again as another version, next to this one ('+REDO_WHY[retryBlock(m.id)]+'). Nothing here changes.':m.cut?'Ask again from the start':'Retry'}">${ic('retry')}</button>`:m.role==='assistant'&&redoBlock(m.id)!=='busy'&&questionOf(m.id)?`<button class="ib" data-act="redo" title="${redoKeep(m.id)?'Redo in a new branch beside this one, with the model and effort selected now. This answer stays as it is.':'Redo: ask again with the model and effort selected now'}">${ic('retry')}</button>`:'')+(m.model?`<span class="model">${esc(modelLabel(m.model))}${m.effort?` · ${esc(effortLabel(m.effort))}`:''}</span>`:'')+ctxLabel(m.usage,m.ts);
  const w=branchChips(m.id);if(w)f.appendChild(w);
}
// a chip under a reply for each branch off it (the only way into a branch about the whole reply, which has no
// highlight to click); the same in a pane and in a canvas card
function branchChips(mid){
  const bs=[...shownOn(mid),...movedOn(mid)];if(!bs.length)return null;
  const wrap=document.createElement('div');wrap.className='bchips';
  for(const t of bs){
    const b=document.createElement('span');b.className='bchip'+(t.resolved?' res':'');b.dataset.tid=t.id;b.style.setProperty('--c',color(t));
    b.innerHTML=`<span class="n">${branchNum(t)}</span><span class="bt"></span><button class="bx" data-delb="${esc(t.id)}" title="Delete this branch and everything branched from it">${ic('trash')}</button>`;
    b.querySelector('.bt').textContent=t.title;b.title=`Open branch ${branchNum(t)}`+(t.alt?', what followed this reply until it was moved out':t.anchorText?`, from “${trunc(t.anchorText,120)}”`:', about the whole reply');
    wrap.appendChild(b);
  }
  return wrap;
}
// While a reply is being written: a shimmering line saying what it's doing now (with the time so far) and,
// before any text arrives, the steps so far (searches, pages read), the 10 most recent.
function streamInto(body,m){
  const st=m.live||[],cur=st.length&&!st[st.length-1].done?st[st.length-1]:null,secs=m.t0?Math.floor((Date.now()-m.t0)/1000):0;
  const cap=(x)=>x[0].toUpperCase()+x.slice(1),now=(x)=>x.replace(/^searched /,'searching ').replace(/^read /,'reading ').replace(/^looked at /,'looking at ');
  const what=cur?cap(now(cur.text)):m.content?'':st.length?'Thinking about what it found':'Thinking';
  const head=what?`<div class="lhead">${ic(cur?cur.icon:'dots')}<span class="shimmer">${esc(trunc(what,110))}…</span>${secs>=2?`<span class="lt">${secs}s</span>`:''}</div>`:'';
  if(!m.content){
    const done=st.filter(x=>x!==cur),shown=done.slice(-10),more=done.length-shown.length;
    const list=shown.length?`<ol class="lsteps">${more?`<li class="more"><span>${more} earlier step${more>1?'s':''}</span></li>`:''}${shown.map(x=>`<li>${ic(x.icon)}<span>${esc(trunc(cap(x.text),120))}</span></li>`).join('')}</ol>`:'';
    body.innerHTML=`<div class="live">${head}${list}</div>`;return;
  }
  renderRich(body,m.content,false);
  if(head)body.insertAdjacentHTML('beforeend',`<div class="live">${head}</div>`);   // still working after some text: say so (the final render drops it)
}
/* where a reply looked on the web: the searches it ran and the pages they returned (kept outside .body, so anchors never count it) */
function webSources(m){
  const qs=m.searches||[],src=(m.sources||[]).filter(s=>/^https?:\/\//i.test(s.url));
  if(!qs.length&&!src.length)return null;
  const d=document.createElement('details');d.className='wsrc';
  const host=(u)=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch(e){return ''}};
  d.innerHTML=`<summary>${ic('globe')}<span></span></summary>`;
  d.querySelector('summary span').textContent='Searched the web'+(qs.length>1?` ${qs.length} times`:'')+(src.length?` · ${src.length} source${src.length>1?'s':''}`:'');
  if(qs.length){const p=document.createElement('div');p.className='wq';p.textContent=qs.map(q=>'“'+q+'”').join(' · ');d.appendChild(p)}
  if(src.length){const ol=document.createElement('ol');
    for(const s of src){const li=document.createElement('li'),a=document.createElement('a');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=s.title||s.url;
      const h=document.createElement('span');h.className='wh';h.textContent=host(s.url);li.append(a,' ',h);ol.appendChild(li)}
    d.appendChild(ol)}
  return d;
}
const streamQ=new Set();let streamTimer=0;
function queueStream(mid){
  streamQ.add(mid);
  if(streamTimer)return;
  streamTimer=setTimeout(()=>{
    streamTimer=0;
    const onCv=conv&&conv.ui.view==='canvas';
    if(!onCv){
      for(const id of streamQ){
        const m=conv.msgs[id];const c=msgCache.get(id);if(!m||!c||!m.pending)continue;
        const pb=c.el.closest('.pb');const stick=pb&&pb.scrollHeight-pb.scrollTop-pb.clientHeight<80;
        streamInto(c.el.querySelector('.body'),m);
        if(stick)pb.scrollTop=pb.scrollHeight;
      }
    }else{
      for(const id of streamQ){const m=conv.msgs[id];const b=m&&m.pending&&document.querySelector(`#cv .msg[data-mid="${id}"] .body`);if(b){const f=b.closest('.cfull');const stick=f&&f.scrollHeight-f.scrollTop-f.clientHeight<80;streamInto(b,m);if(stick)f.scrollTop=f.scrollHeight}}
    }
    streamQ.clear();if(!onCv)wiresSoon();else drawEdgesSoon();
  },70);
}

/* ---------- panes ---------- */
function paneEl(tid){
  let el=paneEls.get(tid);if(el)return el;
  if(tid==='doc')return docPaneEl();
  const isMain=tid==='main';
  el=document.createElement('section');el.className='pane'+(isMain?' main':'');el.dataset.tid=tid;
  el.innerHTML=`<div class="ph"><span class="pgrip" title="Drag to reorder panes"></span>${isMain?'<span class="dot"></span>':`<span class="sdot" data-resolve="${esc(tid)}"></span>`}<div class="ph-main"><div class="ph-title" spellcheck="false"></div><div class="ph-orow"><div class="ph-origin"></div><button class="pox" data-act="oexp" title="Show the whole line"></button></div></div>
    <div class="ph-act"><div class="pzoom"><button class="ib" data-act="zout" title="Zoom out">${ic('minus')}</button><button class="pzl" data-act="zedit"></button><button class="ib" data-act="zin" title="Zoom in">${ic('plus')}</button></div>${isMain?'':`<button class="tb" data-act="take" title="Add a short takeaway from this branch to its parent">${ic('take')}<span class="tl">Takeaway</span></button><button class="tb kmk" data-act="mkcards" title="Have the model draft flashcards from this branch into your inbox">${ic('cards')}<span class="tl">Cards</span></button>`}${isMain?`<button class="ib kicon" data-act="cards" title="Flashcards for this conversation">${ic('cards')}</button><button class="ib" data-act="restart" title="Start the main thread over: an empty main thread, from just the document. What was in it is kept as another version (Branches in the sidebar), with its branches and flashcards; “Use this version” there brings it back.">${ic('restart')}</button>`:`<button class="ib" data-act="export" title="Export or share this branch">${ic('dl')}</button>`}
    <button class="ib" data-act="pin"></button><button class="ib" data-act="collapse" title="Collapse this pane to a thin strip. Click the strip to expand it. (⌘\\ / Ctrl+\\ for the pane you’re in)">${ic('collapse')}</button><button class="ib" data-act="focus"></button>${isMain?`<button class="ib" data-act="close" title="Close the main thread’s pane. Main thread, under Branches in the sidebar, brings it back. (⌘⇧\\ / Ctrl+Shift+\\ for the pane you’re in)">${ic('x')}</button>`:`<button class="ib dz" data-delb="${esc(tid)}" title="Delete this branch and everything branched from it">${ic('trash')}</button><button class="ib" data-act="close" title="Close this pane. Branches open under it stay open; the branch stays saved. (⌘⇧\\ / Ctrl+Shift+\\ for the pane you’re in)">${ic('x')}</button>`}</div></div>
    <div class="pb"><div class="msgs"></div></div>
    <div class="jumpw"><div class="jump"><button class="ib js" data-act="jsearch" title="Search this thread">${ic('search')}</button><button class="ib jp" data-act="jprev" title="Return to where you were reading before you jumped here">${ic('jprev')}</button><button class="ib jl" data-act="jlast" title="Jump to the start of the latest reply">${ic('jlast')}</button><button class="ib je" data-act="jend" title="Jump to the very bottom">${ic('jend')}</button></div></div>
    ${isMain?'':`<div class="tk"><div class="tkb"><span class="tkl">Takeaway to parent</span><input placeholder="Optional: what to focus on" autocomplete="off"><button class="go" title="Generate 2–4 takeaway bullets and add them to the end of the parent thread">Add</button><button class="ib" data-act="take" title="Cancel">${ic('x')}</button></div></div>`}
    <form class="composer"><div class="cbox"><textarea rows="1"></textarea><button class="sendb" type="submit"></button></div></form>
    <div class="rail-label"><span class="dot"></span><span class="rl"></span></div>`;
  const ta=el.querySelector('textarea');
  ta.placeholder=isMain?'Ask anything…':'Ask a follow-up in this branch…';
  ta.addEventListener('input',()=>{autosize(ta);updateComposer(tid)});
  ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submit(tid)}});
  el.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const s=streaming.get(tid);if(s){stopReply(s);return}submit(tid)});
  const tk=el.querySelector('.tk');
  // the takeaway bar goes away with its ✕, Esc, or a swipe (sideways or down; not from inside the text field)
  if(tk){let sw=null;tk.addEventListener('touchstart',e=>{sw=e.target.closest('input,button')?null:{x:e.touches[0].clientX,y:e.touches[0].clientY}},{passive:true});
    tk.addEventListener('touchmove',e=>{if(!sw)return;const dx=e.touches[0].clientX-sw.x,dy=e.touches[0].clientY-sw.y;if(Math.abs(dx)>60||dy>40){sw=null;tk.classList.remove('show')}},{passive:true})}
  if(tk){const inp=tk.querySelector('input');const go=()=>{tk.classList.remove('show');const f=inp.value.trim();inp.value='';bringBack(tid,f)};
    tk.querySelector('.go').addEventListener('click',go);inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();go()}else if(e.key==='Escape')tk.classList.remove('show')})}
  const title=el.querySelector('.ph-title');
  title.addEventListener('dblclick',()=>{if(isMain)return;title.contentEditable='true';title.focus();document.getSelection().selectAllChildren(title)});
  title.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();title.blur()}});
  title.addEventListener('blur',()=>{if(title.contentEditable!=='true')return;title.contentEditable='false';const v=title.textContent.trim();if(v&&T(tid)){const ch=v!==T(tid).title;T(tid).title=v;if(ch)T(tid).titleKept=true;delete T(tid).autoTitle;refreshAnchorsFor(tid);renderMap();save()}});
  const pb=el.querySelector('.pb');
  pb.addEventListener('scroll',()=>{wiresSoon();updateJump(el);notePaneSpot(el)},{passive:true});
  paneRO.observe(pb);
  paneEls.set(tid,el);originRO.observe(el);return el;
}
/* Every thread pane keeps its place when its width changes (another pane collapsed, closed or opened, the sidebar
   went, the window resized): text re-wraps at once, and the same scroll offset would point somewhere else. As you
   scroll, a pane notes what's at its reading line (the message, the paragraph in it, how far into that) or that it's
   at the bottom; a width change puts that back. Safari has no scroll anchoring of its own, and Chrome's misses this. */
const PANE_BLOCKS='p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,table,.mermaid-box,mjx-container[display],img,hr';
function paneSpotNow(pb){
  if(pb.scrollHeight-pb.scrollTop-pb.clientHeight<4)return {bottom:true};
  const top=pb.getBoundingClientRect().top,y=top+pb.clientHeight*READ_LINE,msgs=[...pb.querySelectorAll(':scope .msgs>.msg')];
  const m=msgs.find(x=>{const r=x.getBoundingClientRect();return r.bottom>y})||msgs[msgs.length-1];if(!m)return null;
  const blocks=[...m.querySelectorAll(PANE_BLOCKS)].filter(b=>!b.parentElement.closest(PANE_BLOCKS));
  const host=blocks.find(b=>b.getBoundingClientRect().bottom>y)||m,r=host.getBoundingClientRect();
  const sp={mid:m.dataset.mid,i:host===m?-1:blocks.indexOf(host),f:r.height?Math.max(0,Math.min(1,(y-r.top)/r.height)):0};
  // exactly: the character at the reading line, and how far below its line's top the reading line is
  const c=caretAt(pb.getBoundingClientRect().left+pb.clientWidth/2,y);
  // measured from the top of the pane, not of its scrolling part: the header can change height too (a narrow pane's
  // buttons wrap onto a second row), and the text should stay where it is on screen
  if(c&&pb.contains(c.node)){const cr=charRect(c.node,c.off);if(cr)sp.text={node:c.node,off:c.off,y:cr.top-pb.closest('.pane').getBoundingClientRect().top}}
  return sp;
}
function caretAt(x,y){
  if(document.caretRangeFromPoint){const r=document.caretRangeFromPoint(x,y);if(r&&r.startContainer.nodeType===3)return {node:r.startContainer,off:r.startOffset}}
  else if(document.caretPositionFromPoint){const p=document.caretPositionFromPoint(x,y);if(p&&p.offsetNode.nodeType===3)return {node:p.offsetNode,off:p.offset}}
  return null;
}
function charRect(node,off){
  const n=node.length;if(!n)return null;const a=Math.min(off,n-1),r=document.createRange();r.setStart(node,a);r.setEnd(node,a+1);
  const rs=r.getClientRects();return rs.length?rs[0]:r.getBoundingClientRect();
}
// the full spot is worked out once scrolling pauses (120 ms); whether it's at the bottom is noted at once (cheap), so a
// width change right after scrolling to the end keeps it there instead of going back to the spot from before
function notePaneSpot(el){if(el.__restoring)return;const pb=el.querySelector('.pb');
  // a scroll while the width differs from the one last handled is the text re-wrapping (Safari fires one before the
  // resize is handled), not the reader: it mustn't replace the spot that's about to be put back
  if(pb&&pb.__tw&&Math.abs(pb.clientWidth-pb.__tw)>1)return;
  if(pb&&pb.clientWidth>100){el.__lag=true;el.__atEnd=pb.scrollHeight-pb.scrollTop-pb.clientHeight<4}
  clearTimeout(el.__spotT);el.__spotT=setTimeout(()=>{if(pb&&pb.clientWidth>100&&!el.__restoring){el.__spot=paneSpotNow(pb);el.__spotTop=pb.scrollTop;el.__lag=false}},120)}
function putPaneSpot(el,sp){
  const pb=el.querySelector('.pb');if(!sp||!pb)return;
  el.__restoring=true;clearTimeout(el.__spotT);
  const t=sp.text,cr=t&&t.node.isConnected&&pb.contains(t.node)&&charRect(t.node,t.off);
  if(sp.bottom)pb.scrollTop=pb.scrollHeight;
  else if(cr&&cr.height)pb.scrollTop+=cr.top-el.getBoundingClientRect().top-t.y;
  else{const m=pb.querySelector(`.msgs>.msg[data-mid="${CSS.escape(sp.mid)}"]`);if(m){
    const blocks=[...m.querySelectorAll(PANE_BLOCKS)].filter(b=>!b.parentElement.closest(PANE_BLOCKS)),host=sp.i>=0&&blocks[sp.i]||m,r=host.getBoundingClientRect();
    pb.scrollTop+=r.top+sp.f*r.height-pb.getBoundingClientRect().top-pb.clientHeight*READ_LINE}}
  requestAnimationFrame(()=>requestAnimationFrame(()=>{el.__restoring=false;el.__spotTop=pb.scrollTop}));
}
const paneRO=new ResizeObserver(es=>{for(const e of es){
  const pb=e.target,el=pb.closest('.pane');if(!el||el.dataset.tid==='doc')continue;const w=pb.clientWidth;
  if(w<100)continue;   // a collapsed strip: keep the width it had, so expanding it puts the place back too
  // unless something jumped it elsewhere meanwhile (a jump to a passage while panes open must win): restore if it hasn't
  // scrolled, or only a little (the browser's own scroll anchoring nudging it), i.e. it's still at about the same place
  if(pb.__tw&&Math.abs(w-pb.__tw)>1&&el.__lag){   // scrolled moments ago: the noted spot is out of date
    clearTimeout(el.__spotT);el.__spot=null;if(el.__atEnd)putPaneSpot(el,{bottom:true});el.__lag=false;pb.__tw=w;setTimeout(()=>notePaneSpot(el),60);continue}
  if(pb.__tw&&Math.abs(w-pb.__tw)>1&&el.__spot){const sp=el.__spot,now=Math.abs(pb.scrollTop-el.__spotTop)<2?null:paneSpotNow(pb);
    if(sp.bottom||!now||(now.mid===sp.mid&&Math.abs(now.i-sp.i)<=3))putPaneSpot(el,sp)}
  pb.__tw=w;
}});
function updateJump(el){
  const pb=el.querySelector('.pb');if(!pb)return;
  el.classList.toggle('away',pb.scrollHeight-pb.scrollTop-pb.clientHeight>100);
  if(el.__prev!=null&&Math.abs(pb.scrollTop-el.__prev)<40&&!el.__jumping){el.__prev=null;el.classList.remove('hasprev')}
}
function rememberSpot(pe){
  const pb=pe.querySelector('.pb');pe.__prev=pb.scrollTop;pe.__jumping=true;pe.classList.add('hasprev');
  setTimeout(()=>{pe.__jumping=false},900);
}
function autosize(ta){ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,200)+'px'}
function submit(tid){if(streaming.has(tid))return;const el=paneEls.get(tid);const ta=el.querySelector('textarea');const v=ta.value.trim();if(!v&&!(pendingImgs.get(tid)||[]).length)return;const imgs=takePending(tid);ta.value='';autosize(ta);send(tid,v,imgs)}
function updateComposer(tid){
  const el=paneEls.get(tid);if(!el)return;const b=el.querySelector('.sendb');const s=streaming.has(tid);
  b.innerHTML=s?ic('stop'):ic('send');b.title=s?'Stop':'Send';b.disabled=!s&&!el.querySelector('textarea').value.trim()&&!(pendingImgs.get(tid)||[]).length;
}
function fitOrigin(pe){   // show the ⌄ when the origin line is cut off
  const ph=pe&&pe.querySelector(':scope>.ph'),o=ph&&ph.querySelector('.ph-origin');if(!o)return;
  const b=ph.querySelector('.pox');if(b&&!b.firstChild)b.innerHTML=ic('chev');
  if(!ph.classList.contains('oexp'))ph.classList.toggle('cut',o.scrollWidth>o.clientWidth+1);
}
const originRO=new ResizeObserver(es=>{for(const e of es)fitOrigin(e.target)});
function updateHeader(tid){
  if(tid==='doc'){updateDocHeader();const d=paneEls.get('doc');d&&fitOrigin(d);return}
  const el=paneEls.get(tid);const t=T(tid);if(!el||!t)return;
  el.style.setProperty('--c',color(t));
  const title=el.querySelector('.ph-title');if(title.contentEditable!=='true')title.textContent=tid==='main'?(conv.title||'Main thread'):t.title;
  title.title=tid==='main'?'':'Double-click to rename';
  // what branches off this thread (and off those), as the sidebar's tree shows it; in a document conversation main's
  // count leaves out the document's branches, which the document's header counts
  const o=el.querySelector('.ph-origin'),nb=descendants(tid).length;
  if(t.parent){
    const path=ancestors(tid);
    // each crumb is an ancestor; clicking it shows the spot in that ancestor where the path continues
    // the last one (the direct parent) shows where this branch starts, as the quote does
    const crumbs=path.slice(0,-1).map((id,i)=>{const via=path[i+1],name=id==='main'?(isDocBranch(T(via))?'the document':'the main thread'):`“${T(id).title}”`;
      const label=esc(trunc(id==='main'?(isDocBranch(T(via))?'Document':'Main'):T(id).title,22));
      // real buttons, not styled spans: a phone's tap goes to the nearest thing that is clickable, which a span isn't (the tap landed on the line around it and did nothing)
      if(via===tid)return `<button type="button" class="crumb" data-crumb="${esc(id)}" data-via="${esc(via)}" title="${esc(`Show where this branch starts in ${name}`)}">${label}</button>`;
      return `<button type="button" class="crumb" data-crumb="${esc(id)}" data-via="${esc(via)}" title="${esc(`Show where “${T(via).title}” branches off ${name}`)}">${label}</button>`}).join(' › ');
    o.innerHTML=`↳ ${crumbs} <sup style="font-size:10px;color:${color(t)}">${branchNum(t)}</sup>${t.anchorText?` · <button type="button" class="oqt" data-back="1" title="Show this passage in its source">${esc(trunc(t.anchorText,70))}</button>`:t.alt?` · <button type="button" class="oqt" data-back="1" title="${t.anchorMsg==='START'?'':'Show the message it starts after'}">${joinable(t)?'moved out':'another version'}, ${esc(versionWhere(t,50))}</button>`:' · whole reply'}${nb?` · ${brCount(tid,nb)}`:''}`;
  }else o.innerHTML=brCount(tid,nb);
  const pb_=el.querySelector('[data-act="pin"]');if(pb_){const pinned=tid==='main'?!!conv.pinned:!!t.pinned;pb_.innerHTML=ic('pin');pb_.classList.toggle('pinned',pinned);pb_.title=tid==='main'?(pinned?'Unpin this conversation':'Pin this conversation to the top of the sidebar'):(pinned?'Unpin this branch':'Pin this branch to the top of the sidebar, so you can jump straight back to it')}
  const f=el.querySelector('[data-act="focus"]');const on=isFocused(tid);f.innerHTML=ic('focus');f.setAttribute('aria-pressed',on?'true':'false');f.title=on?'Expand the other panes again (Esc)':'Collapse the other panes';f.classList.toggle('on',on);
  el.querySelector('.rl').textContent=tid==='main'?'Main':t.title;
  const sd=el.querySelector('.sdot');if(sd){sd.classList.toggle('res',!!t.resolved);sd.title=t.resolved?'Resolved. Click to mark as still open.':'Open. Click to mark as resolved once you\'ve got it.'}
  el.classList.toggle('res',!!t.resolved);
  fitOrigin(el);
}
// what a version is and where it starts, with the button that uses it: for a pane's first card and a canvas card's line
function altLine(t,n,show){
  const p=T(t.parent),pn=esc(p.parent?'“'+trunc(p.title,30)+'”':'the main thread'),full=esc(p.parent?'“'+p.title+'”':'the main thread'),a=versionAfter(t,n),back=joinable(t),empty=!(conv.order[t.id]||[]).length;
  const what=back?(a?`Moved out of ${pn}: what came after ${esc(a)}`:`Moved out of ${pn}: what was in it, from the start`):`Another version of a question in ${pn}, ${a?'after '+esc(a):'at the start'}`;
  const showB=show&&a?`<button data-back="1" title="${back?'Show the message this came after':'Show the version it\'s an alternative to'}">${back?'Show where':'Show other'}</button>`:'';
  const useB=back?`<button class="usev" data-usev="${esc(t.id)}" title="${empty?'Nothing is in this branch: remove it':`Put these messages back at the end of ${full}, where they came from. This branch goes away; nothing is lost.`}">${empty?'Remove':'Move back'}</button>`
    :empty?'':`<button class="usev" data-usev="${esc(t.id)}" title="Make this the version ${full} goes on with. The other one moves here; nothing is lost.">Use this version</button>`;
  return `${show?'<div class="ol">':''}<span>${what}</span>${showB}${useB}${show?'</div>':''}`;
}
const originExpanded=new Set();
function wireOriginExpand(d,t){
  const oq=d.querySelector('.oq');if(!oq)return;
  const key=(conv?conv.id:'')+':'+t.id;
  const btn=document.createElement('button');btn.type='button';btn.className='oexp';
  const sync=()=>{
    const exp=originExpanded.has(key);
    d.classList.toggle('exp',exp);
    btn.textContent=exp?'Show less':'Show full';
    btn.title=exp?'Collapse back to compact preview':'Expand full clipped passage';
  };
  btn.addEventListener('click',(e)=>{e.stopPropagation();if(originExpanded.has(key))originExpanded.delete(key);else originExpanded.add(key);sync()});
  sync();
  requestAnimationFrame(()=>{
    if(!oq.isConnected)return;
    if(originExpanded.has(key)||oq.scrollHeight>oq.clientHeight+4){
      oq.after(btn);
    }
  });
}
function originCard(t){
  const d=document.createElement('div');d.className='origin';d.style.setProperty('--c',color(t));
  if(isDocBranch(t)&&t.anchorShot){const ref=shotRef(t);d.innerHTML=`<div class="ol"><span>Branched from a snip of the document</span><button data-back="1" title="Scroll the document to where it came from">Show in source</button></div><button class="oimg" data-zoomref="1" title="Show larger"><img alt=""></button>`;const im=d.querySelector('img');im.alt=t.anchorText;imageURL(ref).then(u=>{im.src=u}).catch(()=>{im.replaceWith(Object.assign(document.createElement('span'),{className:'gone',textContent:'The snip isn’t available, so it can’t be shown.'}))});d.querySelector('.oimg').__ref=ref;return d}
  if(isDocBranch(t)&&t.anchorImg){const whole=isWholePage(t.anchorImg),ref=docImgRef(t);d.innerHTML=`<div class="ol"><span>Branched from ${whole?'an image':'a snip of an image'} in the document</span><button data-back="1" title="Scroll the document to this image">Show in source</button></div><button class="oimg" data-zoomref="1" title="Show larger"><img alt=""></button>`;const im=d.querySelector('img');im.alt=t.anchorText;imageURL(ref).then(u=>{im.src=u}).catch(()=>{im.replaceWith(Object.assign(document.createElement('span'),{className:'gone',textContent:'The image isn’t kept with this conversation, so it can’t be shown.'}))});d.querySelector('.oimg').__ref=ref;return d}
  if(isDocBranch(t)&&t.anchorRegion){const p=normalizePageIndex(t.anchorPage);d.innerHTML=`<div class="ol"><span></span><button data-back="1" title="Scroll the document to this ${isWholePage(t.anchorRegion)?'page':'snip'}">Show in source</button></div><button class="oimg" data-zoomref="1" title="Show larger"><img alt=""></button>`;d.querySelector('.ol span').textContent=`Branched from ${isWholePage(t.anchorRegion)?'':'a snip of '}${p!=null?`page ${p+1} of `:''}the document`;const im=d.querySelector('img');im.alt=t.anchorText;imageURL(regionRef(t)).then(u=>{im.src=u}).catch(()=>{im.replaceWith(Object.assign(document.createElement('span'),{className:'gone',textContent:'The document isn’t loaded, so the snip can’t be shown.'}))});d.querySelector('.oimg').__ref=regionRef(t);return d}
  if(isDocBranch(t)){const pl=conv.doc&&conv.doc.kind==='pdf'?docPagesLabel(t,true):'';d.innerHTML=`<div class="ol"><span></span><button data-back="1" title="Scroll the document to the exact passage this branch came from">Show in source</button></div><div class="oq"></div>`;d.querySelector('.ol span').textContent='Branched from the document'+(pl?`, ${pl}`:'');const oq0=d.querySelector('.oq');oq0.textContent=t.anchorText;oq0.dataset.back='1';oq0.title='Jump to this passage in the document';wireOriginExpand(d,t);return d}
  if(isClipBranch(t)){
    const safeUrl=t.anchorUrl&&/^https?:\/\//i.test(t.anchorUrl)?t.anchorUrl:'';
    const host=safeUrl?(()=>{try{return new URL(safeUrl).hostname.replace(/^www\./,'')}catch(_){return ''}})():'';
    const label=t.anchorTitle||host||'the web';
    d.innerHTML=`<div class="ol"><span>Clipped from ${esc(label)}</span>${safeUrl?`<a class="clink" href="${esc(safeUrl)}" target="_blank" rel="noopener">Open source ↗</a>`:''}</div>${t.anchorText?'<div class="oq"></div>':''}`;
    if(t.anchorText){d.querySelector('.oq').textContent=t.anchorText;wireOriginExpand(d,t)}
    for(const ref of (t.anchorImages||[])){
      const btn=document.createElement('button');btn.className='oimg';btn.dataset.zoomref='1';btn.title='Show larger';btn.__ref=ref;
      const im=document.createElement('img');im.alt=t.anchorTitle||'Clipped image';btn.appendChild(im);d.appendChild(btn);
      imageURL(ref).then(u=>{im.src=u}).catch(()=>{im.replaceWith(Object.assign(document.createElement('span'),{className:'gone',textContent:'The image isn’t available.'}))});
    }
    return d;
  }
  const p=T(t.parent);
  if(t.alt){d.innerHTML=altLine(t,60,'Show');return d}
  d.innerHTML=`<div class="ol"><span>Branched from ${esc(p.parent?p.title:'the main thread')}${t.anchorText?'':' (the whole reply)'}</span><button data-back="1" title="Scroll the parent to the exact passage this branch came from">Show in source</button></div>${t.anchorText?'<div class="oq"></div>':''}`;
  if(t.anchorText){const oq=d.querySelector('.oq');oq.textContent=t.anchorText;oq.dataset.back='1';oq.title='Jump to this passage in the reply it came from';wireOriginExpand(d,t)}
  return d;
}
function emptyState(t){
  const d=document.createElement('div');d.className='empty';
  if(t.id==='main'&&conv.doc){
    d.innerHTML=`<h2>Ask about the whole document</h2><div>Or highlight any passage in the document to open a branch about just that part. Page references in answers are links.</div><div class="chips"></div>`;
    DOC_STARTERS.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s;b.dataset.ask=s;d.lastChild.appendChild(b)});
  }else if(t.id==='main'){
    d.innerHTML=`<h2>What do you want to understand?</h2><div>Ask a question. When a phrase in the answer raises a new question, highlight it to open a side branch next to the main thread.</div><div class="chips"></div>`;
    STARTERS.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s;b.dataset.ask=s;d.lastChild.appendChild(b)});
    d.insertAdjacentHTML('beforeend',`<div class="eor"><button class="elink" data-newdoc="1">${ic('doc')}Or start from something to read: a PDF, a web page, a text file</button></div>`);
    // the very first time (nothing saved yet): the idea in three steps
    if(!convList.some(c=>c.id!==conv.id))d.insertAdjacentHTML('beforeend',`<ol class="esteps"><li><b>Ask</b><span>anything, or about a document you open.</span></li><li><b>Highlight</b><span>a phrase in the answer to branch off into it, beside the main thread.</span></li><li><b>Keep</b><span>what you learn: carry a takeaway back, or turn on flashcards.</span></li></ol><div class="ekeys">Press <kbd>?</kbd> for keyboard shortcuts.</div>`);
  }else{
    d.innerHTML=`<div>${t.anchorText?'Ask anything about this passage':'Ask a side question about that reply'}, or start with one of these:</div><div class="chips"></div>`;
    quickList().forEach(([l,q])=>{const b=document.createElement('button');b.className='chip';b.textContent=l;b.dataset.ask=q;b.title='Asks: '+q;d.lastChild.appendChild(b)});
  }
  if(t.id==='main')d.appendChild(convSysBox());
  return d;
}
// in an empty main thread: the system prompt this conversation starts with, ready to change before the first question
let csysDraft=null;   // {conv, v, open}: kept across redraws of the pane
// one system prompt per conversation (one prompt cache): say so, and that a document's branches use it even while main is empty
const sysScope=()=>conv.doc?'Every thread of this conversation uses it: this main thread and every branch, including branches from the document, even if nothing is ever asked here.':'Every thread of this conversation uses it: this main thread and every branch off it.';
function convSysBox(){
  const own=ownSys(conv),dr=csysDraft&&csysDraft.conv===conv.id?csysDraft:null;
  const el=document.createElement('details');el.className='csys';if(dr&&dr.open)el.open=true;
  el.innerHTML=`<summary>${ic('tune')}<span>System prompt: <b>${own?'this conversation’s own':'your default'}</b>${conv.doc?'<span class="csyss"> · for every thread, branches from the document too</span>':''}</span></summary><div class="csysb"></div>`;
  // the editor is made only while open, so the pane's composer stays its only textarea otherwise
  const fill=()=>{const w=el.querySelector('.csysb');if(!el.open){w.innerHTML='';return}if(w.firstChild)return;
    w.innerHTML=`<p class="ppnote csysn">${sysScope()}</p><textarea class="pptext" rows="9" spellcheck="false" aria-label="System prompt for this conversation"></textarea>
    <div class="ppbar"><span class="ppmsg"></span><span class="sp"></span>${own?'<button class="mbtn" data-csys="reset">Use my default</button>':''}<button class="mbtn primary" data-csys="save" disabled>Use for this conversation</button></div>`;
    const ta=w.querySelector('textarea'),sv=w.querySelector('[data-csys=save]'),d=csysDraft&&csysDraft.conv===conv.id?csysDraft:null;
    ta.value=d&&d.v!=null?d.v:sysPrompt(conv);sv.disabled=ta.value.trim()===sysPrompt(conv).trim();
    ta.oninput=()=>{csysDraft={conv:conv.id,v:ta.value,open:true};sv.disabled=ta.value.trim()===sysPrompt(conv).trim()}};
  el.ontoggle=()=>{csysDraft={...(csysDraft&&csysDraft.conv===conv.id?csysDraft:{conv:conv.id,v:null}),open:el.open};fill()};
  el.onclick=(e)=>{const b=e.target.closest('[data-csys]');if(!b)return;e.stopPropagation();
    setConvSystem(b.dataset.csys==='save'?el.querySelector('.csysb textarea').value:'');csysDraft={conv:conv.id,v:null,open:false};
    renderPane('main');toast(ownSys(conv)?`This conversation has its own system prompt, ${conv.doc?'for main and every branch, those from the document too':'for main and every branch'}.`:'This conversation uses your default system prompt.')};
  if(el.open)fill();
  return el;
}
/* ---- zoom inside a pane (Columns / Rows views). conv.ui.pz[tid] = factor.
   Chat and text panes scale their content with CSS zoom (text reflows to the pane). The PDF is re-rendered
   at the new size instead, so it stays sharp: its 100% is "fit the width", and the fit button returns to it.
   (Fitting a whole page was tried and dropped: in a side pane a portrait page ends up small, with wide gray margins.) */
const PZ=[0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3];
function paneZoom(tid){const v=conv.ui.pz&&conv.ui.pz[tid];return typeof v==='number'&&v>=PZ[0]&&v<=PZ[PZ.length-1]?v:1}
const isPdfPane=(tid)=>tid==='doc'&&conv.doc&&conv.doc.kind==='pdf';
function applyPaneZoom(tid){
  const el=paneEls.get(tid);if(!el)return;const v=paneZoom(tid),pdf=isPdfPane(tid);
  if(pdf||v===1)el.style.removeProperty('--pz');else el.style.setProperty('--pz',v);
  const l=el.querySelector('.pzl');if(l){l.textContent=Math.round(v*100)+'%';l.title=pdf?'Click to type a zoom level (100% fits the page to the width)':'Click to type a zoom level'}
  el.classList.toggle('zoomed',v!==1);
  const sn=el.querySelector('[data-act=snip]');if(sn)sn.style.display=tid==='doc'&&conv.doc?'':'none';
  const f=el.querySelector('.pzf');if(f){f.style.display=pdf?'':'none';f.disabled=v===1;f.title='Fit the width'}
}
// Click a zoom percentage to type one instead of stepping with − / +: Enter or clicking away applies it
// (kept within 50–300%), Esc cancels.
function editZoom(label,current,apply){
  if(label.nextElementSibling&&label.nextElementSibling.classList.contains('zin'))return;
  const inp=document.createElement('input');inp.className='zin';inp.type='text';inp.inputMode='numeric';inp.autocomplete='off';
  inp.value=Math.round(current*100);inp.setAttribute('aria-label','Zoom level, in percent');
  label.style.display='none';label.after(inp);inp.focus();inp.select();
  let done=false;
  const finish=(ok)=>{if(done)return;done=true;const n=parseFloat(inp.value.replace(/[^\d.]/g,''));inp.remove();label.style.display='';
    if(ok&&n>0&&Math.round(n)!==Math.round(current*100))apply(Math.min(300,Math.max(50,n))/100)};
  inp.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();finish(true)}else if(e.key==='Escape'){e.preventDefault();finish(false)}});
  inp.addEventListener('blur',()=>finish(true));
  ['click','pointerdown','mousedown','dblclick'].forEach(t=>inp.addEventListener(t,e=>e.stopPropagation()));
}
function setPaneZoom(tid,v){
  if(typeof v==='number')v=Math.round(v*100)/100;
  const pz=conv.ui.pz||(conv.ui.pz={});if(v===1)delete pz[tid];else pz[tid]=v;
  applyPaneZoom(tid);save();
  if(isPdfPane(tid)){if(docViewReady()&&state.docState.pdf)rebuildPdf()}
  else wiresSoon();
}
function stepPaneZoom(tid,dir){
  const cur=paneZoom(tid);
  const next=dir>0?PZ.find(z=>z>cur+1e-3):[...PZ].reverse().find(z=>z<cur-1e-3);
  if(next!=null)setPaneZoom(tid,next);
}
async function rebuildPdf(){
  const el=paneEls.get('doc');if(!el||!state.docState||!state.docState.pdf)return;
  const cur=docView.current;await buildPdfPages(el,el.querySelector('.docwrap'));scrollDocToPage(cur,false);
}
function renderPane(tid,toBottom){
  resetThreadIdx();
  applyPaneZoom(tid);
  if(tid==='doc'){renderDocPane();return}
  const el=paneEls.get(tid);if(!el||!T(tid))return;
  if(tid==='main'){const rb=el.querySelector('.ph [data-act=restart]');if(rb)rb.style.display=conv.doc&&conv.order.main.length?'':'none'}
  // a redraw keeps the scroll offset: a rebuilt message (a new branch marker or chip) leaves the page for a moment while
  // the others are built, the pane is shorter meanwhile and the browser pulls the scroll up (Side question jumped up
  // by a screenful, and the width change that followed then took it as the reader's own jump and left it there)
  const t=T(tid),list=el.querySelector('.msgs'),nodes=[],pb0=el.querySelector('.pb'),top0=pb0.scrollTop;
  if(t.parent)nodes.push(originCard(t));
  const mids=conv.order[tid]||[];
  if(!mids.length)nodes.push(emptyState(t));
  const cuts=takeawayCuts(tid);
  for(const mid of mids)if(conv.msgs[mid]){nodes.push(msgEl(conv.msgs[mid]));for(const n of cuts.get(mid)||[])nodes.push(tkcutEl(n))}
  list.replaceChildren(...nodes);
  if(!toBottom&&pb0.scrollTop!==top0)pb0.scrollTop=top0;
  // the noted spot's character may be in a message just rebuilt: note it again in the new one, so a width change
  // right after (the branch's pane opening) puts back that exact character, not just its paragraph
  const sp0=el.__spot;if(!toBottom&&sp0&&sp0.text&&!sp0.text.node.isConnected&&Math.abs(top0-el.__spotTop)<2&&pb0.clientWidth>100){el.__spot=paneSpotNow(pb0);el.__spotTop=pb0.scrollTop}
  updateHeader(tid);updateComposer(tid);
  if(toBottom){const pb=el.querySelector('.pb');pb.scrollTop=pb.scrollHeight}
  requestAnimationFrame(()=>updateJump(el));
  wiresSoon();
}
function refreshAnchorsFor(tid){const t0=T(tid);if(isDocBranch(t0))refreshDocAnchors(t0.anchorPage);const t=T(tid);if(t&&t.anchorMsg&&conv.msgs[t.anchorMsg]){conv.msgs[t.anchorMsg].ver++;renderPane(t.parent)}conv.ui.open.forEach(updateHeader)}
function gutEl(tid){
  let g=gutEls.get(tid);if(g)return g;
  g=document.createElement('div');g.className='gut';g.dataset.left=tid;g.title='Drag to resize, double-click to reset';
  // no text selection or native drag while resizing: in Safari, a selection left elsewhere turned the press into a
  // drag of that text, and the handle got no more pointer events
  g.addEventListener('pointerdown',e=>{e.preventDefault();try{getSelection().removeAllRanges()}catch(_){}startDrag(e,g)});
  g.addEventListener('dblclick',()=>{const t=gutTarget(g);if(t){delete conv.ui.sizes[t.tid];layout();save()}});
  gutEls.set(tid,g);return g;
}
// the document is docked on the canvas (and the canvas is showing): its pane lives in that card, not in #panes
const docInDock=()=>!!(conv&&conv.doc&&conv.ui.view==='canvas'&&conv.ui.cv&&conv.ui.cv.dock&&conv.ui.cv.dock.doc);
function placeDocPane(){
  if(!docInDock())return;
  const slot=$('#dock .docpanecard .cdocpane');if(!slot)return;
  if(!conv.ui.open.includes('doc')){conv.ui.open.unshift('doc');conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!=='doc')}
  const el=paneEl('doc');el.classList.remove('rail');
  const sp=docSpotNow();
  if(el.parentNode!==slot){slot.appendChild(el);renderDocPane();putDocSpot(sp);return}   // moving it resets its scroll
  renderDocPane();
}
function layout(){
  resetThreadIdx();
  const wrap=$('#panes'),ui=conv.ui;
  wrap.className='panes '+ui.layout;
  for(const [tid,el] of paneEls)if(!ui.open.includes(tid)||(!T(tid)&&!(tid==='doc'&&conv.doc))){el.remove();paneEls.delete(tid);gutEls.get(tid)&&gutEls.get(tid).remove();gutEls.delete(tid)}
  const seq=[],fresh=[];
  const inDock=docInDock(),dEl=paneEls.get('doc'),dWas=dEl&&dEl.parentNode,dSpot=dEl&&docSpotNow();
  // when every pane not collapsed has a width you dragged it to (always so for the only one), the last of them fills
  // the space: its width is kept (it comes back when a pane without one opens) but only as its least, so closing or
  // collapsing the pane that was taking up the rest doesn't leave them all narrow beside empty space
  const shown=ui.open.filter(x=>!isCollapsed(x)&&!(inDock&&x==='doc'));
  const filler=shown.every(x=>ui.sizes[x])?shown.at(-1):null;
  ui.open.forEach((tid,i)=>{
    if(inDock&&tid==='doc'){if(!paneEls.has(tid))fresh.push(tid);paneEl(tid);return}   // it's in its canvas card
    const isNew=!paneEls.has(tid);const el=paneEl(tid);
    const rail=isCollapsed(tid);el.classList.toggle('rail',rail);
    el.title=rail?'Click to expand':'';
    const sz=ui.sizes[tid];el.style.flex=(sz&&!rail)?`${tid===filler?1:0} 0 ${sz}px`:'';el.classList.toggle('sized',!!(sz&&!rail));
    seq.push(el);if(isNew)fresh.push(tid);else updateHeader(tid);
    if(i<ui.open.length-1||!rail){const g=gutEl(tid);g.classList.toggle('glast',i===ui.open.length-1);seq.push(g)}   // the last pane gets one too, so its size can be changed
  });
  for(const [tid,g] of gutEls)if(!seq.includes(g))g.remove();
  seq.forEach((n,i)=>{if(wrap.children[i]!==n)wrap.insertBefore(n,wrap.children[i]||null)});
  if(dEl&&dWas&&dWas!==wrap&&dEl.parentNode===wrap)putDocSpot(dSpot);   // back from the canvas's dock: moving it reset its scroll
  while(wrap.children.length>seq.length)wrap.lastChild.remove();
  fresh.forEach(tid=>renderPane(tid,true));
  syncViewSeg();
  wiresSoon();markCur();markReplies();markCardButtons();
  if(inDock)placeDocPane();
}
/* Reorder panes by dragging the grip at the left of a pane's header, or a collapsed strip itself (Columns / Rows). The drag starts after a
   few pixels, so a click on the grip does nothing. Only the grip drags: the header's crumbs, quote, title and
   buttons are left to clicks, and a swipe on the header scrolls. The order is conv.ui.open. */
const PANE_HOLD_MS=380;   // how long a finger rests on a pane's header before the pane comes up to be dragged
(function paneReorder(){
  let st=null,quietUntil=0;
  addEventListener('click',e=>{if(Date.now()<quietUntil){e.stopPropagation();e.preventDefault()}},true);   // the click that ends a drag does nothing
  $('#panes').addEventListener('pointerdown',e=>{
    const g=e.target.closest('.pane>.ph>.pgrip, .pane.rail');
    // by touch, a long press anywhere on a pane's header (not its buttons or a title being renamed) picks it up too:
    // the grip alone is a thin strip at the edge, and a press that missed it selected the title instead
    const h=!g&&e.pointerType==='touch'&&e.target.closest('.panes>.pane>.ph');
    if(h&&!e.target.closest('button,a,input,textarea,select,[contenteditable=true],.sdot,.dot')){
      if(conv.ui.open.length<2)return;
      st={tid:h.parentElement.dataset.tid,pane:h.parentElement,x:e.clientX,y:e.clientY,id:e.pointerId,touch:true,on:false,timer:0};
      st.timer=setTimeout(()=>{if(st&&st.touch&&!st.on)begin()},PANE_HOLD_MS);return}
    if(!g||e.button>0)return;   // a collapsed strip is its own grip: a click still expands it
    const pane=g.classList.contains('pane')?g:g.parentElement.parentElement;if(conv.ui.open.length<2)return;
    e.preventDefault();
    st={tid:pane.dataset.tid,pane,x:e.clientX,y:e.clientY,id:e.pointerId,touch:false,on:false,timer:0};
  });
  function begin(){st.on=true;st.pane.classList.add('pdrag');$('#panes').classList.add('reordering');getSelection().removeAllRanges();if(navigator.vibrate)try{navigator.vibrate(10)}catch(_){}}
  document.addEventListener('pointermove',e=>{
    if(!st||e.pointerId!==st.id)return;
    const moved=Math.hypot(e.clientX-st.x,e.clientY-st.y);
    if(!st.on){if(st.touch){if(moved>8){clearTimeout(st.timer);st=null}return}if(moved<6)return;begin()}
    const wrap=$('#panes'),cols=conv.ui.layout==='cols',pos=cols?e.clientX:e.clientY;
    const wr=wrap.getBoundingClientRect(),edge=cols?[wr.left,wr.right]:[wr.top,wr.bottom];   // scroll along near the edges
    if(pos<edge[0]+40)wrap[cols?'scrollLeft':'scrollTop']-=14;else if(pos>edge[1]-40)wrap[cols?'scrollLeft':'scrollTop']+=14;
    const others=[...wrap.querySelectorAll(':scope>.pane')].filter(p=>p!==st.pane);
    let idx=others.filter(p=>{const r=p.getBoundingClientRect();return (cols?r.left+r.width/2:r.top+r.height/2)<pos}).length;
    const order=conv.ui.open.filter(x=>x!==st.tid);order.splice(idx,0,st.tid);
    if(order.join()!==conv.ui.open.join()){conv.ui.open=order;layout()}
  });
  document.addEventListener('touchmove',e=>{if(st&&st.on)e.preventDefault()},{passive:false});
  const end=(e)=>{
    if(!st||(e&&e.pointerId!==st.id))return;clearTimeout(st.timer);
    if(st.on){st.pane.classList.remove('pdrag');$('#panes').classList.remove('reordering');save();wiresSoon();
      quietUntil=Date.now()+250}
    st=null;
  };
  document.addEventListener('pointerup',end);document.addEventListener('pointercancel',e=>{if(st&&!st.on)end(e);else if(st&&e.pointerId===st.id)end(e)});
  $('#panes').addEventListener('contextmenu',e=>{if(st&&st.touch)e.preventDefault()});
})();
let drag=null;
// Which pane a handle resizes: the one before it, or, when that one is a collapsed strip, the one after it
// (dragging then works the other way round: toward that pane makes it smaller).
function gutTarget(g){
  const el=paneEls.get(g.dataset.left);if(!el)return null;
  if(!el.classList.contains('rail'))return {tid:g.dataset.left,el,sign:1};
  const nx=g.nextElementSibling;if(!nx||!nx.classList.contains('pane')||nx.classList.contains('rail'))return null;
  return {tid:nx.dataset.tid,el:nx,sign:-1};
}
/* Resizing a pane by its handle. Held near the far edge of the panes area (right in Columns, bottom in Rows) the pane
   keeps growing on its own and the row scrolls with it, so the handle stays under the pointer: a pane at the end can
   grow past the screen. Faster the closer to the edge, capped (EDGE_GROW), and easing in (EDGE_EASE).
   The snap: whenever the pane comes up to the size that exactly fills the panes area, by hand or growing at the edge,
   it stops there ("Fits the window": the handle lights up, a phone buzzes). Let go and that's its size. It lets go
   when the pointer moves SNAP_PULL past where it stopped, or, held at the edge, after SNAP_HOLD (then it carries on
   growing, easing in again). Back below the size by SNAP_REARM and it's ready to snap again. */
const EDGE_ZONE=44,EDGE_GROW=700,EDGE_WAIT=400,EDGE_EASE=600,SNAP_HOLD=700,SNAP_PULL=40,SNAP_REARM=24;   // px from the edge where it starts; px per second at most; ms held there first (a drag that merely ends near the edge doesn't grow); ms to reach full speed; ms the snap holds at the edge; px of pointer that pull it out of the snap by hand; px below it that make it ready again
function snapTag(on,x,y,cols){
  let t=$('#snapTag');if(!t){if(!on)return;t=document.createElement('div');t.id='snapTag';t.textContent='Fits the window';document.body.appendChild(t)}
  if(on){const w=t.offsetWidth;t.style.left=Math.max(8,cols?x-w-14:x-w/2)+'px';t.style.top=Math.max(8,cols?y-14:y-40)+'px'}
  t.classList.toggle('on',!!on);
}
function startDrag(e,g){
  const tg=gutTarget(g);if(!tg)return;const {tid,el,sign}=tg;
  const cols=conv.ui.layout==='cols';const r=el.getBoundingClientRect();
  drag={tid,el,cols,sign,start:cols?e.clientX:e.clientY,size:cols?r.width:r.height,g,at:cols?e.clientX:e.clientY,raf:0,t:0};g.classList.add('drag');(()=>{try{g.setPointerCapture(e.pointerId)}catch(_){}})();
  drag.el.classList.add('sized');const min=drag.cols?(innerWidth<=760?220:360):200;   // phones: narrow enough for two side by side
  const d0=drag,box=$('#panes');
  const raw=()=>Math.max(min,d0.size+(d0.at-d0.start)*d0.sign);   // where the pointer puts the handle
  const set=s=>{d0.el.style.flex=`0 0 ${s}px`;conv.ui.sizes[d0.tid]=Math.round(s);wiresSoon();return s};
  const edgeDist=()=>{const b=box.getBoundingClientRect();return (d0.cols?Math.min(b.right,innerWidth):Math.min(b.bottom,innerHeight))-d0.at};
  // the size at which the pane fills the panes area (less its padding and this handle)
  const fit=()=>{const cs=getComputedStyle(box);return d0.cols?box.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-g.offsetWidth:box.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom)-g.offsetHeight};
  const mark=on=>{if(on===!!d0.marked)return;d0.marked=on;g.classList.toggle('snap',on);
    snapTag(on,d0.cols?d0.at:d0.y,d0.cols?d0.y:d0.at,d0.cols);if(on)try{navigator.vibrate&&navigator.vibrate(12)}catch(_){}};
  // the snap: armed (ready), stuck (the pointer position where it stopped, and when), prev (the last size from the pointer)
  d0.armed=true;d0.stuck=null;d0.prev=raw();
  const size=()=>{
    const r=raw(),f=fit();
    if(d0.stuck!=null){
      if(Math.abs(d0.at-d0.stuck)<=SNAP_PULL){d0.prev=r;return f}
      d0.stuck=null;mark(false);   // pulled out of it
    }
    if(r<f-SNAP_REARM)d0.armed=true;
    if(d0.armed&&d0.prev<f&&r>=f){d0.armed=false;d0.stuck=d0.at;d0.since=performance.now();mark(true);d0.prev=r;return f}
    if(r>f)d0.armed=false;
    d0.prev=r;return r;
  };
  const tick=t=>{
    d0.raf=0;if(drag!==d0)return;
    const dist=edgeDist();if(d0.sign!==1||dist>=EDGE_ZONE){d0.t=0;d0.in=0;return}
    if(!d0.in)d0.in=t;if(t-d0.in<EDGE_WAIT){d0.raf=requestAnimationFrame(tick);return}
    if(d0.stuck!=null){
      if(t-Math.max(d0.since,d0.in+EDGE_WAIT)<SNAP_HOLD){d0.t=0;d0.raf=requestAnimationFrame(tick);return}
      // held past the snap: carry on from it, the handle where the pointer is, easing in again
      d0.start=d0.at-(fit()-d0.size);d0.prev=raw();d0.stuck=null;mark(false);d0.go=t;
    }
    if(!d0.go)d0.go=t;
    const dt=d0.t?Math.min(.05,(t-d0.t)/1000):1/60;d0.t=t;
    const grow=EDGE_GROW*Math.min(1,(EDGE_ZONE-dist)/EDGE_ZONE)*Math.min(1,.15+(t-d0.go)/EDGE_EASE)*dt;
    const was=parseFloat(d0.el.style.flex.split(' ')[2])||raw();
    d0.start-=grow;const now=set(size());
    if(d0.stuck!=null)d0.start=d0.at-(now-d0.size);   // stopped at the snap: no overshoot kept for later
    // scroll by as much, kept as an exact number: Safari rounds scrollLeft to whole pixels, so += a fraction each frame
    // fell behind (the handle ended up ~40px past the pointer)
    const moved=now-was;if(moved>0){const k=d0.cols?'scrollLeft':'scrollTop';if(d0.scrollAt==null||Math.abs(box[k]-d0.scrollAt)>1)d0.scrollAt=box[k];d0.scrollAt+=moved;box[k]=d0.scrollAt}
    d0.raf=requestAnimationFrame(tick);
  };
  const edge=()=>{if(!d0.raf&&d0.sign===1&&edgeDist()<EDGE_ZONE){d0.t=0;d0.in=0;d0.go=0;d0.raf=requestAnimationFrame(tick)}};
  d0.y=d0.cols?e.clientY:e.clientX;
  g.onpointermove=ev=>{d0.at=d0.cols?ev.clientX:ev.clientY;d0.y=d0.cols?ev.clientY:ev.clientX;set(size());edge()};
  g.onpointerup=g.onpointercancel=()=>{cancelAnimationFrame(d0.raf);d0.raf=0;mark(false);g.classList.remove('drag');g.onpointermove=g.onpointerup=g.onpointercancel=null;drag=null;save()};
  edge();
}

/* ---------- connector wires (pane view) ---------- */
let wireRAF=0;
function wiresSoon(){if(!wireRAF)wireRAF=requestAnimationFrame(()=>{wireRAF=0;wires()})}
function wires(){
  const svg=$('#wires');if(!conv||conv.ui.view==='canvas'){svg.innerHTML='';return}
  const st=$('#stage').getBoundingClientRect(),pr=$('#panes').getBoundingClientRect();
  const cols=conv.ui.layout==='cols';let out='',defs='';
  for(const tid of conv.ui.open){
    const t=T(tid);if(!t||!t.parent)continue;
    const pid=isDocBranch(t)?'doc':t.parent;
    const pe=paneEls.get(tid),ppe=paneEls.get(pid);
    if(!pe||!ppe||isCollapsed(tid)||isCollapsed(pid))continue;
    const c=color(t),hdr=pe.querySelector('.ph').getBoundingClientRect(),body=ppe.querySelector('.pb').getBoundingClientRect();
    let a=ppe.querySelector(`sup.fn[data-tid="${qid(tid)}"]`)||ppe.querySelector(`.bchip[data-tid="${qid(tid)}"]`)||ppe.querySelector(`.msg[data-mid="${qid(t.anchorMsg)}"]`);
    if(!a)continue;
    const ar=a.getClientRects()[0]||a.getBoundingClientRect();
    let ay=ar.top+ar.height/2,off=false;
    if(ay<body.top+4){ay=body.top+4;off=true}if(ay>body.bottom-4){ay=body.bottom-4;off=true}
    const gap=conv.ui.open.indexOf(tid)-conv.ui.open.indexOf(pid);
    let d,ax,bx,by;
    if(cols){
      ax=body.right;bx=hdr.left;by=hdr.top+hdr.height/2;
      if(bx<pr.left-2||ax>pr.right+2)continue;
      const dx=Math.max(18,(bx-ax)/2);
      d=`M${ax-st.left} ${ay-st.top} C${ax+dx-st.left} ${ay-st.top},${bx-dx-st.left} ${by-st.top},${bx-st.left} ${by-st.top}`;
    }else{
      ax=body.left;bx=hdr.left;by=hdr.top+hdr.height/2;
      const gx=Math.min(ax,bx)-12-(Math.max(0,gap-1)%3)*3;
      d=`M${ax-st.left} ${ay-st.top} C${gx-st.left} ${ay-st.top},${gx-st.left} ${ay-st.top},${gx-st.left} ${Math.min(ay+18,by)-st.top} L${gx-st.left} ${Math.max(by-18,ay)-st.top} C${gx-st.left} ${by-st.top},${gx-st.left} ${by-st.top},${bx-st.left} ${by-st.top}`;
    }
    const op=off?0.4:0.9;
    // a line that has to cross other panes (its branch isn't next to where it came from) goes faint over
    // them, so it doesn't strike through their text; it's full strength in the gaps and at both ends
    let mask='';
    if(cols){const lo=Math.min(ax,bx),hi=Math.max(ax,bx),over=[];
      for(const [id,el] of paneEls){if(id===tid||id===pid||!el.isConnected)continue;const r=el.getBoundingClientRect();if(r.right>lo+1&&r.left<hi-1)over.push(r)}
      if(over.length){const mid='wm'+tid.replace(/\W/g,'');
        defs+=`<mask id="${mid}" maskUnits="userSpaceOnUse" x="-10000" y="-10000" width="30000" height="30000"><rect x="-10000" y="-10000" width="30000" height="30000" fill="#fff"/>${over.map(r=>`<rect x="${r.left-st.left}" y="${r.top-st.top}" width="${r.width}" height="${r.height}" fill="#262626"/>`).join('')}</mask>`;
        mask=` mask="url(#${mid})" data-crossing="${over.length}"`}}
    out+=`<path d="${d}" fill="none" stroke="${c}" stroke-width="1.7" opacity="${op}"${off?' stroke-dasharray="4 4"':''}${mask} data-wire="${esc(tid)}"/>`;
    out+=`<circle cx="${ax-st.left}" cy="${ay-st.top}" r="3.2" fill="${c}" opacity="${op}"/><circle cx="${bx-st.left}" cy="${by-st.top}" r="3.2" fill="${c}"/>`;
  }
  svg.innerHTML=(defs?`<defs>${defs}</defs>`:'')+out;
}

/* ---------- canvas view ---------- */
const cam={x:40,y:40,k:1};let camFitted=false;
const CW=320,CWX=580,HG=90,VG=26;
function kidsOf(tid){
  if(tid==='doc')return [T('main'),...docBranches().filter(c=>!hiddenNow(c.id))];
  const k=children(tid).filter(c=>!hiddenNow(c.id));return tid==='main'&&conv.doc?k.filter(c=>!isDocBranch(c)):k;
}
function visParentId(tid){if(tid==='doc')return null;if(tid==='main')return conv.doc?'doc':null;const t=T(tid);return t?(isDocBranch(t)?'doc':t.parent):null}
function cvState(){const u=conv.ui;u.cv=u.cv||{};u.cv.pos=u.cv.pos||{};u.cv.size=u.cv.size||{};u.cv.open=u.cv.open||[];u.cv.fold=u.cv.fold||[];return u.cv}
function foldHidden(tid){if(tid!=='doc'&&tid!=='main'&&hiddenNow(tid))return true;let p=visParentId(tid);while(p){if(cvState().fold.includes(p))return true;p=visParentId(p)}return false}
function descendants(tid){const out=[];const go=id=>kidsOf(id).forEach(k=>{out.push(k.id);go(k.id)});go(tid);return out}
function applyCam(){$('#world').style.transform=`translate(${cam.x}px,${cam.y}px) scale(${cam.k})`;if($('#dock').children.length)drawEdgesSoon()}
function canvasMsgEl(m){
  const key=msgKey(m);
  if(!m.pending){const hit=cvMsgCache.get(m.id);if(hit&&hit.key===key)return hit.el}
  const el=document.createElement('div');el.className='msg '+m.role;el.dataset.mid=m.id;
  if(m.role==='user'){userMsgBody(el,m);if(!m.pending)cvMsgCache.set(m.id,{key,el});return el}
  if(m.role==='note'){
    const src=T(m.fromThread);el.style.setProperty('--c',src?color(src):'var(--faint)');
    el.innerHTML=`<div class="nh"><span class="d"></span>Takeaway from ${src?`<button class="nl" data-tkfrom="${esc(m.id)}" title="Go to the last reply this takeaway saw, in its branch"></button>`:'<i>deleted branch</i>'}<span style="flex:1"></span>${m.error&&!m.pending?`<button class="ib" data-act="retry" title="Retry">${ic('retry')}</button>`:''}</div><div class="body"></div>`;
    if(src)el.querySelector('.nl').textContent=src.title;
  }else el.innerHTML='<div class="body"></div>';
  const body=el.querySelector('.body');
  if(m.pending)streamInto(body,m);
  else{renderRich(body,m.content,true);if(m.role==='assistant')applyAnchors(body,m);renderMermaid(body).then(drawEdgesSoon);
    if(m.error){const e=document.createElement('div');e.className='err';e.textContent=m.error;body.appendChild(e)}
    if(m.role==='assistant'){   // the same line under it as in a pane: Side question, Copy, ⋯, Redo / Retry / Continue, model, context, branch chips
      const ws=webSources(m);if(ws)el.appendChild(ws);
      const dr=docReads(m);if(dr)el.appendChild(dr);
      const f=document.createElement('div');f.className='mfoot';buildFoot(f,m);el.appendChild(f)}
    else{const w=branchChips(m.id);if(w)el.appendChild(w)}
    cvMsgCache.set(m.id,{key,el})}
  return el;
}
// the buttons under a reply (buildFoot) and a takeaway's Retry: the same in a pane and in an expanded canvas card
function replyAct(a,mid,btn){
  if(!conv.msgs[mid])return;
  switch(a){
    case 'wbranch':createBranch(mid,'',null);break;
    case 'rmore':openReplyMenu(btn,mid);break;
    case 'ctxinfo':openUsage(btn,mid);break;
    case 'copy':copyText(conv.msgs[mid].content).then(()=>toast('Copied'),()=>toast('Copy isn\'t allowed here'));break;
    case 'retry':retry(mid);break;
    case 'continue':continueReply(mid);break;
    case 'redo':redo(mid);break;
  }
}
function statusDot(t){
  if(!t.parent)return '<span class="mdot"></span>';
  return `<span class="sdot${t.resolved?' res':''}" data-resolve="${esc(t.id)}" style="--c:${color(t)}" title="${t.resolved?'Resolved. Click to mark as still open.':'Open. Click to mark as resolved once you\'ve got it.'}"></span>`;
}
const CARD_ROWS_ALL=8;   // a card's summary lists every message up to this many (renderCanvas)
let cvNodes=new Map();
function renderCanvas(){
  resetThreadIdx();
  const S=cvState(),world=$('#world'),dock=$('#dock');S.dock=S.dock||{};S.cz=S.cz||{};
  for(const id of Object.keys(S.dock))if(!(conv.threads[id]||(id==='doc'&&conv.doc)))delete S.dock[id];
  const keep={},prevNodes=new Map();
  $('#cv').querySelectorAll('.cnode').forEach(n=>{
    const id=n.dataset.ctid;prevNodes.set(id,n);
    const f=n.querySelector('.cfull'),i=n.querySelector('.cask textarea');
    keep[id]={st:f?f.scrollTop:0,v:i?i.value:'',focus:i&&document.activeElement===i};
  });
  S.open=S.open.filter(id=>conv.threads[id]);S.fold=S.fold.filter(id=>conv.threads[id]||(id==='doc'&&conv.doc));
  const descMemo=new Map();
  const descCount=(id)=>{if(descMemo.has(id))return descMemo.get(id);let c=0;for(const k of kidsOf(id))c+=1+descCount(k.id);descMemo.set(id,c);return c};
  const nodes={},rebuilt=new Set();
  for(const t of Object.values(conv.threads)){
    if(foldHidden(t.id))continue;
    const docked=!!S.dock[t.id],exp=S.open.includes(t.id)||docked,kids=kidsOf(t.id),folded=S.fold.includes(t.id),nd=kids.length?descCount(t.id):0;
    const mids=(conv.order[t.id]||[]).filter(id=>conv.msgs[id]);
    const cuts=exp?takeawayCuts(t.id):null;
    const sz=S.size[t.id],dk=S.dock[t.id];
    let csig=`${conv.id}|${t.id}|${t.parent?t.title:conv.title}|${t.resolved?1:0}|${t.colorIdx}|${t.alt?1:0}|${t.alt&&joinable(t)?1:0}|${t.anchorMsg||''}|${t.anchorText||''}|${exp?1:0}|${docked?1:0}|${folded?1:0}|${kids.length}|${nd}|${S.cz[t.id]||''}|${sz?sz.w+'x'+sz.h:''}|${dk?dk.x+','+dk.y+','+dk.w+','+dk.h:''}|${(pendingImgs.get(t.id)||[]).length}|${cvPrev.has(cvPrevKey(t.id))?1:0}|`;
    if(exp){
      for(const mid of mids){const m=conv.msgs[mid];csig+=(m.pending?'P'+Math.random():msgKey(m))+';';if(cuts&&cuts.has(mid))csig+='c'+cuts.get(mid).length+';'}
    }else{
      csig+=mids.length+':';
      for(const mid of mids){const m=conv.msgs[mid];const bs=branchesOn(mid);csig+=mid+m.role+(m.content||'').length+(m.ver||0)+bs.map(b=>b.id+(b.resolved?'r':'')+b.colorIdx+branchNum(b)).join(',')+';'}
    }
    const targetParent=docked?dock:world;
    const prev=prevNodes.get(t.id);
    if(prev&&prev.__csig===csig&&prev.parentElement===targetParent){
      prev.classList.remove('flash');prevNodes.delete(t.id);nodes[t.id]=prev;continue;
    }
    const n=document.createElement('div');n.className='cnode'+(t.parent?'':' main')+(exp?' exp':'')+(docked?' docked':'')+(t.resolved?' res':'');n.dataset.ctid=t.id;n.style.setProperty('--c',color(t));n.__csig=csig;
    n.innerHTML=`<div class="ch" title="Drag to move. Shift-drag moves its sub-branches too. Double-click to open in panes.">${statusDot(t)}<span class="ct"></span>`+
      (kids.length?`<button class="fold${folded?' on':''}" data-cact="fold" title="${folded?'Show':'Hide'} the ${nd} branch${nd===1?'':'es'} below this card">${folded?'+'+nd:ic('minus').replace('class="i"','class="i" style="width:12px;height:12px"')+kids.length}</button>`:'')+
      `<span class="czoom"><button class="ib" data-cact="zout" title="Make just this card smaller (or Alt+scroll over it)">−</button><span class="zl" data-cact="zedit" title="This card's own zoom. Click to type a zoom level.">100%</span><button class="ib" data-cact="zin" title="Make just this card bigger (or Alt+scroll over it)">+</button></span>`+
      `<button class="ib${docked?' stuck':''}" data-cact="stick" title="${docked?'Stuck to the screen: it stays put while you pan and zoom. Click to drop it onto the canvas where it is.':'Stick to the screen: keep this card in view at reading size while you pan and zoom around it.'}">${ic('pin')}</button>`+
      (docked?`<button class="ib" data-cact="restore" title="Put it back where it was on the canvas (↓ or Esc)">${ic('unfocus')}</button>`:`<button class="ib" data-cact="exp" title="${exp?'Shrink back to a summary':'Expand to read the full thread here'} (⌘\\ / Ctrl+\\ for the selected card)">${ic(exp?'unfocus':'expand')}</button>`)+
      `<button class="ib" data-cact="panes" title="Open this thread in the pane view">${ic('cols')}</button>`+
      (t.parent?`<button class="ib dz" data-delb="${esc(t.id)}" title="Delete this branch and everything branched from it">${ic('trash')}</button>`:'')+`</div>`+
      (t.anchorText||(t.parent&&t.anchorMsg&&!isDocBranch(t))?'<div class="cq"></div>':'');   // a whole-reply branch has a line too, to jump to its reply
    n.querySelector('.ct').textContent=t.parent?t.title:(conv.title||'Main thread');
    const cq=n.querySelector('.cq');
    if(cq&&t.alt){   // another version or a moved-out part: say which, where it starts, and offer to use it or move it back, as the pane does
      cq.classList.add('cqw','cqv');cq.title=joinable(t)?'Show the message this came after, in the card it came from':'Show the version it\'s an alternative to, in the card it came from';
      cq.innerHTML=altLine(t,40,false)}
    else if(cq&&t.anchorText){cq.textContent=t.anchorText;cq.title='Jump to this passage in the card it came from'}
    else if(cq){cq.textContent='The whole reply';cq.classList.add('cqw');cq.title='Jump to the reply this branch is about, in the card it came from'}
    if(exp){
      const full=document.createElement('div');full.className='cfull';
      if(!mids.length)full.innerHTML='<div class="empty" style="padding:12px 0">Nothing here yet. Ask below.</div>';
      for(const mid of mids){full.appendChild(canvasMsgEl(conv.msgs[mid]));for(const nn of cuts.get(mid)||[])full.appendChild(tkcutEl(nn))}
      n.appendChild(full);
      const cj=document.createElement('div');cj.className='cjump';
      cj.innerHTML=`<button class="ib cjp" data-cact="jprev" title="Return to where you were reading before you jumped here">${ic('jprev')}</button><button class="ib" data-cact="jlast" title="Jump to the start of the latest reply">${ic('jlast')}</button><button class="ib" data-cact="jend" title="Jump to the very bottom">${ic('jend')}</button>`;
      n.appendChild(cj);
      const ask=document.createElement('div');ask.className='cask';
      ask.innerHTML=`<textarea rows="1" placeholder="${t.parent?'Ask a follow-up in this branch…':'Ask anything…'}"></textarea><button class="sendb" data-cact="ask" title="Send (Enter). Shift+Enter adds a new line.">${ic('send')}</button>`;
      n.appendChild(ask);if((pendingImgs.get(t.id)||[]).length)queueMicrotask(()=>renderPending(t.id));
      const cta=ask.querySelector('textarea');cta.addEventListener('input',()=>{autosizeCask(cta)});
      const k=keep[t.id];if(k&&k.v){cta.value=k.v;requestAnimationFrame(()=>autosizeCask(cta))}
      const upd=()=>{n.classList.toggle('away',full.scrollHeight-full.scrollTop-full.clientHeight>100);
        const k=cvPrevKey(t.id),p=cvPrev.get(k);if(p&&!p.jumping&&Math.abs(full.scrollTop-p.top)<40){cvPrev.delete(k);n.classList.remove('hasprev')}};
      if(cvPrev.has(cvPrevKey(t.id)))n.classList.add('hasprev');   // survives the card being redrawn
      full.addEventListener('scroll',()=>{drawEdgesSoon();upd()},{passive:true});requestAnimationFrame(upd);
    }else{
      const rows=document.createElement('div');rows.className='crs';
      // a long thread's summary keeps only its first exchange, every message a branch comes off (the lines between
      // cards start there) with the question before it and its latest exchange; each run in between is one "⋯ N more" row that expands the card there
      const show=mids.length<=CARD_ROWS_ALL?null:new Set([...mids.slice(0,2),...mids.slice(-2),...mids.flatMap((id,i)=>branchesOn(id).length?[id,...(i&&conv.msgs[mids[i-1]].role==='user'?[mids[i-1]]:[])]:[])]);
      let gap=[];const flush=()=>{if(!gap.length)return;const r=document.createElement('div');r.className='cr gap';r.dataset.cmid=gap[0];
        r.textContent=`⋯ ${gap.length} more message${gap.length>1?'s':''}`;r.title='Expand the card here (shrink it back with its top bar\'s button)';rows.appendChild(r);gap=[]};
      for(const mid of mids){
        if(show&&!show.has(mid)){gap.push(mid);continue}
        flush();
        const m=conv.msgs[mid];
        const r=document.createElement('div');r.className='cr '+(m.role==='user'?'q':m.role==='note'?'n':'a');r.dataset.cmid=mid;r.title='Expand the card at this message';
        r.textContent=m.role==='note'?'Takeaway: '+trunc(plain(m.content),160):trunc(plain(m.content),m.role==='user'?140:180)||'…';
        const bs=branchesOn(mid);
        if(bs.length){const f=document.createElement('span');f.className='fns';bs.forEach(b=>{const s=document.createElement('sup');s.className='fn'+(b.resolved?' res':'');s.dataset.tid=b.id;s.style.setProperty('--c',color(b));s.textContent=branchNum(b);s.title='Go to branch: '+b.title;f.appendChild(s)});r.prepend(f)}
        rows.appendChild(r);
      }
      flush();
      if(!mids.length){const r=document.createElement('div');r.className='cr a';r.textContent='(empty)';rows.appendChild(r)}
      n.appendChild(rows);
    }
    addSizing(n,t.id,exp,S);
    if(prev&&prev.parentElement===targetParent){prev.replaceWith(n);prevNodes.delete(t.id)}
    else{if(prev){prev.remove();prevNodes.delete(t.id)}targetParent.appendChild(n)}
    nodes[t.id]=n;rebuilt.add(t.id);
  }
  if(conv.doc&&S.dock.doc){
    // stuck to the screen: the real document pane (the one Columns shows) sits in it, at reading size, so
    // pages stay sharp and highlighting, snips, zoom and page jumps all work as in the pane (placeDocPane)
    const whole=S.dock.doc.w>=.99&&S.dock.doc.h>=.99;
    const dsig=`doc-dock|${conv.id}|${conv.doc.name}|${whole?1:0}|${S.dock.doc.x},${S.dock.doc.y},${S.dock.doc.w},${S.dock.doc.h}`;
    const prev=prevNodes.get('doc');
    if(prev&&prev.__csig===dsig&&prev.parentElement===dock){
      prev.classList.remove('flash');prevNodes.delete('doc');nodes.doc=prev;
    }else{
      const n=document.createElement('div');n.className='cnode main docnode docked docpanecard';n.dataset.ctid='doc';n.style.setProperty('--c','var(--faint)');n.__csig=dsig;
      // Expand fills the canvas; dragging it to a side edge (or Side) keeps it to half, with the canvas beside it
      n.innerHTML=`<div class="ch" title="Drag to move it, or to another edge. Double-click to open the document in the pane view."><span class="docico">${ic('doc')}</span><span class="ct"></span>${whole?`<button class="ib" data-cact="docside" title="Keep it to the left half, with the canvas beside it (or drag it to an edge)">${ic('side')}</button>`:`<button class="ib" data-cact="docdock" title="Fill the canvas with the document">${ic('expand')}</button>`}<button class="ib" data-cact="restore" title="Put it back on the canvas as a card (Esc)">${ic('unfocus')}</button><button class="ib" data-cact="panes" title="Open the document in the pane view">${ic('cols')}</button></div><div class="cdocpane"></div>`;
      n.querySelector('.ct').textContent=conv.doc.name;
      addSizing(n,'doc',true,S);
      if(prev){prev.remove();prevNodes.delete('doc')}
      dock.appendChild(n);nodes.doc=n;
    }
  }else if(conv.doc){
    const nb=docBranches(),folded=S.fold.includes('doc'),nd=descCount('doc');
    const hasThumb=docViewReady()&&state.docState.kind==='pdf'&&state.docState.pdf;
    const dsig=`doc-card|${conv.id}|${conv.doc.name}|${folded?1:0}|${nd}|${hasThumb?1:0}|${docViewReady()?(state.docState.kind==='pdf'?state.docState.n:'t'):'l'}|${nb.map(b=>b.id+(b.resolved?'r':'')+b.colorIdx+branchNum(b)+b.anchorText).join(';')}`;
    const prev=prevNodes.get('doc');
    if(prev&&prev.__csig===dsig&&prev.parentElement===world){
      prev.classList.remove('flash');prevNodes.delete('doc');nodes.doc=prev;
    }else{
      const n=document.createElement('div');n.className='cnode main docnode';n.dataset.ctid='doc';n.style.setProperty('--c','var(--faint)');n.__csig=dsig;
      n.innerHTML=`<div class="ch" title="Drag to move. Double-click to open the document."><span class="docico">${ic('doc')}</span><span class="ct"></span><button class="fold${folded?' on':''}" data-cact="fold" title="${folded?'Show':'Hide'} everything below the document">${folded?'+'+nd:ic('minus').replace('class="i"','class="i" style="width:12px;height:12px"')+(nb.length+1)}</button><button class="ib" data-cact="docdock" title="Read the document here, filling the canvas (or drag this card to an edge to keep it to one side)">${ic('expand')}</button><button class="ib" data-cact="panes" title="Open the document in the pane view">${ic('cols')}</button></div><div class="crs"></div>`;
      n.querySelector('.ct').textContent=conv.doc.name;
      const rows=n.querySelector('.crs');
      if(hasThumb){   // first page preview; fixed height, so the layout doesn't shift when the image arrives
        const th=document.createElement('div');th.className='cthumb';th.dataset.cact='panes';th.title='Open the document';rows.before(th);
        docThumbUrl().then(u=>{if(!th.isConnected)return;if(!u){th.remove();return}const img=new Image();img.alt='First page of '+conv.doc.name;img.src=u;th.appendChild(img)});
      }
      const info=document.createElement('div');info.className='cr a';info.textContent=docViewReady()?(state.docState.kind==='pdf'?`${state.docState.n} pages`:'Text document'):'Loading…';rows.appendChild(info);
      for(const b of nb){const r=document.createElement('div');r.className='cr';r.dataset.cdocrow=b.id;r.title='Go to this branch';
        const f=document.createElement('span');f.className='fns';const sp=document.createElement('sup');sp.className='fn'+(b.resolved?' res':'');sp.dataset.tid=b.id;sp.style.setProperty('--c',color(b));sp.textContent=branchNum(b);f.appendChild(sp);r.appendChild(f);
        r.append((conv.doc.kind==='pdf'?`${docPagesLabel(b)} · `:'')+'“'+trunc(b.anchorText,70)+'”');rows.appendChild(r)}
      addSizing(n,'doc',false,S);
      if(prev){prev.remove();prevNodes.delete('doc')}
      world.appendChild(n);nodes.doc=n;
    }
  }
  for(const stale of prevNodes.values())stale.remove();
  cvNodes=new Map(Object.entries(nodes));
  // positions: saved positions win; unsaved cards sit where the automatic layout puts them, relative to their parent
  const auto={},colW=[],depthOf={};
  const root=conv.doc?'doc':'main';
  const isD=(id)=>nodes[id]&&nodes[id].classList.contains('docked');
  const wOf=(id)=>isD(id)?CW:nodes[id].offsetWidth,hOf=(id)=>isD(id)?60:nodes[id].offsetHeight;
  const measure=(tid,d)=>{if(!nodes[tid])return;depthOf[tid]=d;colW[d]=Math.max(colW[d]||0,wOf(tid));kidsOf(tid).forEach(k=>measure(k.id,d+1))};
  measure(root,0);
  const colX=[0];for(let d=1;d<colW.length;d++)colX[d]=colX[d-1]+colW[d-1]+HG;
  const place=(tid,depth,y0)=>{
    const node=nodes[tid];if(!node)return 0;
    const h=hOf(tid),kids=kidsOf(tid).filter(k=>nodes[k.id]);
    const x=colX[depth]||0;
    if(!kids.length){auto[tid]={x,y:y0};return h}
    let y=y0;for(const k of kids)y+=place(k.id,depth+1,y)+VG;
    const span=y-VG-y0;auto[tid]={x,y:y0+Math.max(0,(span-h)/2)};return Math.max(span,h);
  };
  place(root,0,0);
  const fin={};
  const walk=(tid)=>{
    if(!nodes[tid])return;const pid=visParentId(tid);
    if(S.pos[tid])fin[tid]=S.pos[tid];
    else if(pid&&fin[pid]&&auto[pid]){
      const pw=wOf(pid);
      fin[tid]={x:fin[pid].x+pw+HG,y:fin[pid].y+(auto[tid].y-auto[pid].y)};
    }else fin[tid]=auto[tid]||{x:0,y:0};
    kidsOf(tid).forEach(k=>walk(k.id));
  };
  walk(root);
  for(const [tid,p] of Object.entries(fin)){if(isD(tid))continue;nodes[tid].style.left=p.x+'px';nodes[tid].style.top=p.y+'px'}
  placeDocked();
  for(const tid of rebuilt){const k=keep[tid],n=nodes[tid];if(!k||!n)continue;const f=n.querySelector('.cfull');if(f)f.scrollTop=k.st;if(k.focus){const i=n.querySelector('.cask textarea');i&&i.focus()}}
  applyStack();
  drawEdges();
  if(!camFitted){fitCanvas();camFitted=true}else applyCam();
  markHere();placeDocPane();markReplies();
}
let edgeRAF=0;
function drawEdgesSoon(){if(!edgeRAF)edgeRAF=requestAnimationFrame(()=>{edgeRAF=0;drawEdges()})}
/* a card's box in canvas units, whether it lives on the canvas or is stuck to the screen */
function boxW(el,wr){
  if(el.classList.contains('docked')){const r=el.getBoundingClientRect();return {offsetLeft:(r.left-wr.left)/cam.k,offsetTop:(r.top-wr.top)/cam.k,offsetWidth:r.width/cam.k,offsetHeight:r.height/cam.k}}
  return {offsetLeft:el.offsetLeft,offsetTop:el.offsetTop,offsetWidth:el.offsetWidth,offsetHeight:el.offsetHeight};
}
function drawEdges(){
  const world=$('#world'),edges=$('#edges');if(!conv||conv.ui.view!=='canvas'){return}
  const wr=world.getBoundingClientRect();let paths='';
  for(const t of Object.values(conv.threads)){
    const pid=visParentId(t.id);if(!pid)continue;
    const cEl=cvNodes.get(t.id),pEl=cvNodes.get(pid);if(!cEl||!pEl||!cEl.isConnected||!pEl.isConnected)continue;
    const p=boxW(pEl,wr),c=boxW(cEl,wr);
    const a=pid==='doc'?(t.id==='main'?null:pEl.querySelector(`[data-cdocrow="${qid(t.id)}"]`)):(pEl.querySelector(`.cfull sup.fn[data-tid="${qid(t.id)}"]`)||pEl.querySelector(`.cfull .bchip[data-tid="${qid(t.id)}"]`)||pEl.querySelector(`[data-cmid="${qid(t.anchorMsg)}"]`)||pEl.querySelector(`.cfull .msg[data-mid="${qid(t.anchorMsg)}"]`));
    let ay;
    if(a){const r=(a.getClientRects()[0]||a.getBoundingClientRect());ay=(r.top+r.height/2-wr.top)/cam.k}else ay=p.offsetTop+p.offsetHeight/2;
    const top=p.offsetTop+30,bot=p.offsetTop+p.offsetHeight-12;const off=ay<top||ay>bot;ay=Math.min(Math.max(ay,top),bot);
    const right=c.offsetLeft>=p.offsetLeft+p.offsetWidth/2;
    const ax=right?p.offsetLeft+p.offsetWidth:p.offsetLeft;
    const bx=right?c.offsetLeft:c.offsetLeft+c.offsetWidth,by=c.offsetTop+18;
    const dx=Math.max(30,Math.abs(bx-ax)/2)*(right?1:-1);
    const col=t.id==='main'?'#a29d92':color(t),op=t.resolved?0.45:(off?0.55:0.95);
    paths+=`<path d="M${ax} ${ay} C${ax+dx} ${ay},${bx-dx} ${by},${bx} ${by}" fill="none" stroke="${col}" stroke-width="1.8" opacity="${op}"${off?' stroke-dasharray="5 4"':''}/><circle cx="${ax}" cy="${ay}" r="3.5" fill="${col}" opacity="${op}"/>`;
  }
  edges.innerHTML=paths;
}
function fitCanvas(){
  const nodes=[...document.querySelectorAll('#world .cnode')];if(!nodes.length)return;
  let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
  nodes.forEach(n=>{const x=n.offsetLeft,y=n.offsetTop;x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x+n.offsetWidth);y2=Math.max(y2,y+n.offsetHeight)});
  const cv=$('#cv').getBoundingClientRect();
  cam.k=Math.min(1.1,Math.max(0.25,Math.min((cv.width-80)/(x2-x1),(cv.height-80)/(y2-y1))));
  cam.x=(cv.width-(x2-x1)*cam.k)/2-x1*cam.k;cam.y=Math.max(30,(cv.height-(y2-y1)*cam.k)/2)-y1*cam.k;applyCam();
}
function zoomAt(f,cx,cy){
  const k=Math.min(2.5,Math.max(0.15,cam.k*f));const r=$('#cv').getBoundingClientRect();
  if(cx==null){cx=r.width/2;cy=r.height/2}
  cam.x=cx-(cx-cam.x)*(k/cam.k);cam.y=cy-(cy-cam.y)*(k/cam.k);cam.k=k;applyCam();
}
function focusCard(tid,mid){
  const S=cvState();if(tid!=='doc'&&!T(tid))return;
  let changed=false;let p=visParentId(tid);while(p){if(S.fold.includes(p)){S.fold=S.fold.filter(x=>x!==p);changed=true}p=visParentId(p)}
  if(mid&&!S.open.includes(tid)){S.open.push(tid);changed=true}
  if(changed){renderCanvas();save()}
  const n=$('#cv').querySelector(`.cnode[data-ctid="${tid}"]`);if(!n)return;
  if(n.classList.contains('docked')){raiseCard(tid);n.classList.remove('flash');void n.offsetWidth;n.classList.add('flash');if(mid)requestAnimationFrame(()=>{const m=n.querySelector(`.cfull .msg[data-mid="${mid}"]`),f=n.querySelector('.cfull');if(m&&f)f.scrollTop=m.offsetTop-12});return}
  panToCard(n);
  n.classList.remove('flash');void n.offsetWidth;n.classList.add('flash');
  if(mid)requestAnimationFrame(()=>{const m=n.querySelector(`.cfull .msg[data-mid="${mid}"]`),f=n.querySelector('.cfull');if(m&&f){f.scrollTop=m.offsetTop-12;drawEdgesSoon()}});
}
/* Coming to the canvas from panes: point out the card for the pane you were in. Look only: it flashes, and
   the camera moves only if that card is off screen. Nothing is folded, unfolded, expanded or saved
   (unlike focusCard). A card folded away under another is shown by the visible card that holds it. */
let lastPane=null;   // {cid, tid}: the pane last clicked, typed in or scrolled
function focusedPane(){
  const ok=tid=>conv.ui.open.includes(tid)&&!isCollapsed(tid)&&paneEls.has(tid);
  if(lastPane&&lastPane.cid===conv.id&&ok(lastPane.tid))return lastPane.tid;
  const pr=$('#panes').getBoundingClientRect();let best=null,area=0;   // else the one most in view (the later on a tie)
  for(const tid of conv.ui.open){if(!ok(tid))continue;const r=paneEls.get(tid).getBoundingClientRect();
    const a=Math.max(0,Math.min(r.right,pr.right)-Math.max(r.left,pr.left))*Math.max(0,Math.min(r.bottom,pr.bottom)-Math.max(r.top,pr.top));if(a>=area&&a>0){area=a;best=tid}}
  return best;
}
/* …and it stays marked (a quiet ring and "You were here") for the whole visit: whatever you do on the canvas,
   until you switch to Columns or Rows or open another conversation. Per page, never saved; survives the
   canvas redrawing (renderCanvas → markHere). */
let cvHere=null;
function markHere(){
  document.querySelectorAll('#cv .cnode.here').forEach(n=>n.classList.remove('here'));
  const n=cvHere&&$('#cv').querySelector(`.cnode[data-ctid="${cvHere}"]`);let tag=$('#cvHereTag');
  if(n)n.classList.add('here');
  $('#zHereW').style.display=n?'':'none';
  if(hereObs){hereObs.disconnect();hereObs=null}
  if(!n||n.classList.contains('docked')){tag&&tag.remove();return}   // a card stuck to the screen gets the ring only
  if(!tag){tag=document.createElement('div');tag.id='cvHereTag';tag.textContent='You were here'}
  if(tag.parentNode!==$('#world'))$('#world').appendChild(tag);
  const place=()=>{tag.style.left=(n.offsetLeft+10)+'px';tag.style.top=n.offsetTop+'px'};
  place();tag.style.color=getComputedStyle(n).getPropertyValue('--c');
  hereObs=new MutationObserver(place);hereObs.observe(n,{attributes:true,attributeFilter:['style']});   // the label follows the card wherever it's moved
}
let hereObs=null;
function clearHere(){if(cvHere){cvHere=null;markHere()}}
// glide the camera so a card is in view (its top in sight); a card stuck to the screen is already there
/* The part of the canvas you can see past the docked cards (the document docked at a side, a card snapped to an
   edge), relative to #cv: a card brought into view is centred there, not behind a docked card. A dock that would
   leave too little room is ignored. */
function cvFree(){
  const cv=$('#cv').getBoundingClientRect();let l=0,r=cv.width,t=0,b=cv.height;
  for(const d of $('#dock').querySelectorAll('.cnode')){
    const x=d.getBoundingClientRect();if(!x.width||!x.height)continue;
    const cx=(x.left+x.right)/2-cv.left,cy=(x.top+x.bottom)/2-cv.top;
    if(x.height>cv.height*0.5){if(cx<cv.width/2)l=Math.max(l,x.right-cv.left);else r=Math.min(r,x.left-cv.left)}   // docked at a side
    else if(x.width>cv.width*0.5){if(cy<cv.height/2)t=Math.max(t,x.bottom-cv.top);else b=Math.min(b,x.top-cv.top)}   // at the top or bottom
  }
  if(r-l<220){l=0;r=cv.width}if(b-t<160){t=0;b=cv.height}
  return {l,r,t,b,cv};
}
function panToCard(n){
  if(n.classList.contains('docked'))return;
  const f=cvFree();
  animateCam((f.l+f.r)/2-(n.offsetLeft+n.offsetWidth/2)*cam.k,Math.min((f.t+f.b)/2-(n.offsetTop+Math.min(n.offsetHeight,500)/2)*cam.k,f.t+100-n.offsetTop*cam.k));
}
function cvArrive(tid){
  const box=$('#cv');let n=null;
  for(let id=tid;id&&!(n=box.querySelector(`.cnode[data-ctid="${id}"]`));id=visParentId(id));
  if(!n)return;
  cvHere=n.dataset.ctid;markHere();
  const f=cvFree(),h=(n.querySelector('.ch')||n).getBoundingClientRect(),L=f.cv.left,T=f.cv.top;   // seen: its title bar is in view, not behind a docked card
  const seen=n.classList.contains('docked')||(h.left>=L+f.l&&h.right<=L+f.r&&h.top>=T+f.t&&h.bottom<=T+f.b);
  if(!seen)panToCard(n);
  n.classList.remove('flash');void n.offsetWidth;n.classList.add('flash');
}
for(const t of ['pointerdown','focusin','wheel'])$('#panes').addEventListener(t,e=>{const p=e.target.closest&&e.target.closest('.pane[data-tid]');if(p&&conv&&(t==='pointerdown'||!p.classList.contains('rail'))){lastPane={cid:conv.id,tid:p.dataset.tid};markCur()}},{passive:true,capture:true});
// The pane the keyboard acts on (⌘\ collapse, ⌘⇧\ close): the one last clicked, typed in or scrolled. A strip
// counts, so ⌘\ again expands what it just collapsed. Outlined faintly (.cur) when there's more than one pane.
function curPane(){
  if(!conv||conv.ui.view==='canvas')return null;
  if(lastPane&&lastPane.cid===conv.id&&conv.ui.open.includes(lastPane.tid)&&paneEls.has(lastPane.tid))return lastPane.tid;
  return focusedPane();
}
function markCur(){const c=conv&&conv.ui.view!=='canvas'&&conv.ui.open.length>1?curPane():null;for(const [tid,el] of paneEls)el.classList.toggle('cur',tid===c);syncPicker()}
// ⌘⇧\: close the current pane; the one after it (or before) becomes current. Undo puts it all back.
function keyClose(tid){
  const ui=conv.ui;if(ui.open.length<2){toast('At least one pane stays open');return}
  const before={open:[...ui.open],collapsed:[...ui.collapsed]},i=ui.open.indexOf(tid),next=ui.open[i+1]||ui.open[i-1];
  const name=tid==='doc'?'the document':tid==='main'?'the main thread':`“${trunc(T(tid).title||'branch',40)}”`;
  closeThread(tid,{quiet:true});lastPane={cid:conv.id,tid:next};markCur();
  const c0=conv;
  toast(`Closed ${name}.`,{label:'Undo',fn:()=>{if(conv!==c0)return;const u=conv.ui;
    u.open=before.open.filter(x=>x==='doc'?!!conv.doc:!!T(x));u.collapsed=before.collapsed.filter(x=>u.open.includes(x));
    lastPane={cid:conv.id,tid};layout();renderMap();revealPane(tid);save();markCur()}});
}
let camAnim=0;
function animateCam(tx,ty){
  const sx=cam.x,sy=cam.y,t0=performance.now(),me=++camAnim;
  const step=(now)=>{if(me!==camAnim)return;const p=Math.min(1,(now-t0)/280),e=1-Math.pow(1-p,3);cam.x=sx+(tx-sx)*e;cam.y=sy+(ty-sy)*e;applyCam();if(p<1)requestAnimationFrame(step)};
  requestAnimationFrame(step);
}
const contentScale=(n)=>(n.classList.contains('docked')?1:cam.k)*cardZoom(n.dataset.ctid);
/* click a card's quote: move over to the parent card and show exactly where the branch came from */
function autosizeCask(ta){ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight+2,220)+'px';drawEdgesSoon()}
const sizeKey=(tid,exp)=>tid+(exp?':x':'');
/* stored sizes are "at 100%"; a card's own zoom scales its box and its text together */
const cardZoom=(tid)=>((cvState().cz||{})[tid])||1;
function baseWidth(tid,exp){const sz=cvState().size[sizeKey(tid,exp)];return sz&&sz.w?sz.w:(tid==='doc'?CW:(exp?CWX:CW))}
function applyCardZoom(n,tid,exp){
  const z=cardZoom(tid);n.style.setProperty('--cz',z);
  if(!n.classList.contains('docked'))n.style.width=Math.round(baseWidth(tid,exp)*z)+'px';
  const zl=n.querySelector('.zl');if(zl)zl.textContent=Math.round(z*100)+'%';
}
function addSizing(n,tid,exp,S){
  const sz=S.size[sizeKey(tid,exp)],docked=n.classList.contains('docked');
  applyCardZoom(n,tid,exp);
  if(sz&&!docked){const f=n.querySelector('.cfull');if(f&&sz.h){f.style.height=sz.h+'px';f.style.maxHeight='none'}}
  // edges change width; corners (on expanded cards, whose height is adjustable) change both
  // and the bottom edge changes the height (the top edge is the title bar, which moves the card)
  const dirs=exp||docked?['e','w','s','se','sw','ne','nw']:['e','w'];
  for(const d of dirs){const h=document.createElement('div');h.className='rzh'+(d.length===2?' cor':'');h.dataset.dir=d;h.title=d.length===2?'Drag to resize. Double-click to reset.':d==='s'?'Drag to change the height. Double-click to reset.':'Drag to change the width. Double-click to reset.';n.appendChild(h)}
}
/* ---- snapping and sticking cards to the screen ----
   S.dock[tid] = region as fractions of the canvas view; S.pre[tid] = where it sat on the canvas before */
const REGIONS={left:{x:0,y:0,w:.5,h:1},right:{x:.5,y:0,w:.5,h:1},fill:{x:0,y:0,w:1,h:1},tl:{x:0,y:0,w:.5,h:.5},tr:{x:.5,y:0,w:.5,h:.5},bl:{x:0,y:.5,w:.5,h:.5},br:{x:.5,y:.5,w:.5,h:.5}};
const DGAP=10;
function cvRect(){return $('#cv').getBoundingClientRect()}
/* stuck cards stop above a strip at the bottom, so the canvas toolbar never covers them */
const DBOT=46;
function usableH(){return cvRect().height-DBOT}
function regionPx(r){const c=cvRect(),H=usableH();return {l:r.x*c.width+DGAP,t:r.y*H+DGAP,w:r.w*c.width-2*DGAP,h:r.h*H-2*DGAP}}
function pxRegion(l,t,w,h){const c=cvRect(),H=usableH();return {x:(l-DGAP)/c.width,y:(t-DGAP)/H,w:(w+2*DGAP)/c.width,h:(h+2*DGAP)/H}}
function placeDocked(){const S=cvState();$('#dock').querySelectorAll('.cnode').forEach(n=>{const r=S.dock&&S.dock[n.dataset.ctid];if(!r)return;const p=regionPx(r);n.style.left=p.l+'px';n.style.top=p.t+'px';n.style.width=Math.max(260,p.w)+'px';n.style.height=Math.max(180,p.h)+'px'})}
function snapZone(e){
  const c=cvRect(),x=e.clientX-c.left,y=e.clientY-c.top,E=26,C=90;
  if(x<0||y<0||x>c.width||y>c.height)return null;
  if(y<E&&x<C)return 'tl';if(y<E&&x>c.width-C)return 'tr';if(y>c.height-E&&x<C)return 'bl';if(y>c.height-E&&x>c.width-C)return 'br';
  if(x<E)return 'left';if(x>c.width-E)return 'right';if(y<E)return 'fill';return null;
}
function showSnapPreview(zone){const el=$('#snapPrev');if(!zone){el.style.display='none';return}const p=regionPx(REGIONS[zone]);Object.assign(el.style,{display:'block',left:p.l+'px',top:p.t+'px',width:p.w+'px',height:p.h+'px'})}
function dockCard(tid,region,prePos){
  const S=cvState();S.dock=S.dock||{};S.pre=S.pre||{};
  if(!S.dock[tid]){
    const n=$('#world').querySelector(`.cnode[data-ctid="${tid}"]`);
    const pos=prePos||(n?{x:n.offsetLeft,y:n.offsetTop}:S.pos[tid]||null);
    S.pre[tid]={pos,exp:S.open.includes(tid)};
    // pin the cards that stay on the canvas, so nothing shifts when this one leaves
    $('#world').querySelectorAll('.cnode').forEach(el=>{if(el.dataset.ctid!==tid)S.pos[el.dataset.ctid]={x:Math.round(el.offsetLeft),y:Math.round(el.offsetTop)}});
    if(pos)S.pos[tid]=pos;
  }
  S.dock[tid]={x:region.x,y:region.y,w:region.w,h:region.h};
  raiseCard(tid);renderCanvas();save();
}
function restoreCard(tid){
  const S=cvState();if(!S.dock||!S.dock[tid])return;
  const pre=S.pre&&S.pre[tid];delete S.dock[tid];
  if(pre){if(pre.pos)S.pos[tid]=pre.pos;S.open=S.open.filter(x=>x!==tid);if(pre.exp)S.open.push(tid);delete S.pre[tid]}
  renderCanvas();save();
}
/* drop a stuck card onto the canvas exactly where it appears; its own zoom absorbs the canvas zoom */
function unstickCard(tid){
  const S=cvState(),n=$('#dock').querySelector(`.cnode[data-ctid="${tid}"]`);if(!n)return;
  const c=cvRect(),r=n.getBoundingClientRect(),z=cardZoom(tid),k=cam.k,f=n.querySelector('.cfull');
  const nz=Math.min(4,Math.max(.25,z/k));
  S.pos[tid]={x:Math.round((r.left-c.left-cam.x)/k),y:Math.round((r.top-c.top-cam.y)/k)};
  S.size[sizeKey(tid,true)]={w:Math.round(r.width/z),h:Math.round((f?f.getBoundingClientRect().height:400)/z)};
  if(Math.abs(nz-1)<.02)delete S.cz[tid];else S.cz[tid]=Math.round(nz*100)/100;
  if(!S.open.includes(tid))S.open.push(tid);
  delete S.dock[tid];if(S.pre)delete S.pre[tid];
  renderCanvas();save();setStatus('Dropped onto the canvas');
}
/* lift a canvas card onto the screen where it is, at reading size */
function stickCard(tid){
  const n=$('#world').querySelector(`.cnode[data-ctid="${tid}"]`);if(!n)return;
  const S=cvState(),c=cvRect(),r=n.getBoundingClientRect(),z=cardZoom(tid),shown=z*cam.k;
  const nz=Math.min(3,Math.max(1,shown));const grow=nz/shown;
  const H=usableH();let w=Math.max(360,r.width*grow),h=Math.max(320,r.height*grow);w=Math.min(w,c.width-2*DGAP);h=Math.min(h,H-2*DGAP);
  let l=Math.min(Math.max(DGAP,r.left-c.left),c.width-w-DGAP),t=Math.min(Math.max(DGAP,r.top-c.top),H-h-DGAP);
  if(Math.abs(nz-1)<.02)delete S.cz[tid];else S.cz[tid]=Math.round(nz*100)/100;
  dockCard(tid,pxRegion(l,t,w,h));
}
let czSave=0;
function setCardZoom(tid,z){
  const S=cvState();S.cz=S.cz||{};z=Math.min(3,Math.max(.5,z));
  if(Math.abs(z-1)<.02)delete S.cz[tid];else S.cz[tid]=Math.round(z*100)/100;
  const n=$('#cv').querySelector(`.cnode[data-ctid="${tid}"]`);if(n)applyCardZoom(n,tid,n.classList.contains('exp'));
  drawEdgesSoon();clearTimeout(czSave);czSave=setTimeout(save,600);
}
/* stacking: the card you last touched sits on top, and the order is remembered */
function raiseCard(tid){
  const S=cvState();S.z=(S.z||[]).filter(x=>x!==tid&&(x==='doc'||conv.threads[x]));S.z.push(tid);S.sel=tid;applyStack();
}
function applyStack(){
  const S=cvState(),z=S.z||[];
  $('#cv').querySelectorAll('.cnode').forEach(n=>{const i=z.indexOf(n.dataset.ctid);n.style.zIndex=i<0?1:i+2;n.classList.toggle('picked',S.sel===n.dataset.ctid)});
  syncPicker();
}
// where a card was being read before "jump to the passage" moved it ({top, jumping}), per conversation and card,
// outside the card's element because the canvas redraws cards; the card's Return button (cjp) goes back to it
const cvPrev=new Map(),cvPrevKey=tid=>conv.id+'|'+tid;
function canvasRevealSource(tid){
  const t=T(tid);if(!t||!t.parent)return;
  if(isDocBranch(t)&&docInDock()){focusCard('doc');revealDocAnchor(t);return}   // the document is open beside the canvas: scroll it to the passage, as Show in source does in Columns
  if(isDocBranch(t)){focusCard('doc');requestAnimationFrame(()=>{const r=$('#cv').querySelector(`[data-cdocrow="${tid}"]`);if(r){r.style.setProperty('--c',color(t));r.classList.remove('flash');void r.offsetWidth;r.classList.add('flash')}});return}
  const S=cvState();
  const was=S.open.includes(t.parent)&&$('#cv').querySelector(`.cnode[data-ctid="${t.parent}"] .cfull`);
  if(!S.open.includes(t.parent)){S.open.push(t.parent);renderCanvas();save()}
  focusCard(t.parent);
  requestAnimationFrame(()=>{
    const n=$('#cv').querySelector(`.cnode[data-ctid="${t.parent}"]`);if(!n)return;const f=n.querySelector('.cfull');if(!f)return;
    if(was){const k=cvPrevKey(t.parent),p={top:was.scrollTop,jumping:true};cvPrev.set(k,p);n.classList.add('hasprev');setTimeout(()=>{p.jumping=false},900)}   // the card's Return button goes back here
    const a=f.querySelector(`.anchor[data-tid="${tid}"]`)||f.querySelector(`sup.fn[data-tid="${tid}"]`)||f.querySelector(`.msg[data-mid="${t.anchorMsg}"]`);if(!a)return;
    // scroll inside the card so the passage sits a third of the way down (scroll distances are in the card's own, unzoomed pixels)
    const sc=contentScale(n),fr=f.getBoundingClientRect();
    f.scrollTop+=(a.getBoundingClientRect().top-fr.top)/sc-fr.height/sc/3;
    // then aim the camera at the passage itself, not just the card: a big or zoomed card can be taller than the view
    if(!n.classList.contains('docked')){
      const wr=$('#world').getBoundingClientRect(),ar=a.getBoundingClientRect(),c=cvRect();
      const ax=(ar.left-wr.left)/cam.k,ay=(ar.top-wr.top)/cam.k,cw=n.offsetWidth*cam.k;
      const tx=cw<=c.width-40?c.width/2-(n.offsetLeft+n.offsetWidth/2)*cam.k:c.width*0.12-ax*cam.k;
      animateCam(tx,c.height*0.38-ay*cam.k);
    }
    const spans=f.querySelectorAll(`.anchor[data-tid="${tid}"]`);
    if(spans.length)spans.forEach(s=>{s.classList.remove('flash');void s.offsetWidth;s.classList.add('flash')});
    else{a.style.setProperty('--c',color(t));a.classList.remove('flash');void a.offsetWidth;a.classList.add('flash')}
    drawEdgesSoon();
  });
}
function canvasAction(act,tid,btn){
  const S=cvState();
  if(act==='exp'){S.open=S.open.includes(tid)?S.open.filter(x=>x!==tid):[...S.open,tid];renderCanvas();save()}
  else if(act==='fold'){S.fold=S.fold.includes(tid)?S.fold.filter(x=>x!==tid):[...S.fold,tid];renderCanvas();save()}
  else if(act==='panes'){if(tid==='doc'){setView(conv.ui.layout);openDocPane();revealPane('doc')}else openFromCanvas(tid)}   // docked or not: to Columns/Rows, document open
  else if(act==='jprev'){
    const n=btn.closest('.cnode'),f=n.querySelector('.cfull'),k=cvPrevKey(tid),p=cvPrev.get(k);
    if(f&&p)f.scrollTo({top:p.top,behavior:'smooth'});cvPrev.delete(k);n.classList.remove('hasprev');
  }
  else if(act==='jend'||act==='jlast'){
    const f=btn.closest('.cnode').querySelector('.cfull');if(!f)return;
    if(act==='jend'){f.scrollTo({top:f.scrollHeight,behavior:'smooth'});return}
    const ms=f.querySelectorAll(':scope>.msg');let m=ms[ms.length-1];if(m&&m.classList.contains('assistant')&&ms.length>1&&ms[ms.length-2].classList.contains('user'))m=ms[ms.length-2];
    if(m)f.scrollTo({top:f.scrollTop+(m.getBoundingClientRect().top-f.getBoundingClientRect().top)/contentScale(btn.closest('.cnode'))-10,behavior:'smooth'});
  }
  else if(act==='stick'){if(cvState().dock&&cvState().dock[tid])unstickCard(tid);else stickCard(tid)}
  else if(act==='restore'){restoreCard(tid)}
  else if(act==='docdock'){dockCard('doc',REGIONS.fill)}
  else if(act==='docside'){dockCard('doc',REGIONS.left)}
  else if(act==='zin'){setCardZoom(tid,cardZoom(tid)*1.15)}
  else if(act==='zout'){setCardZoom(tid,cardZoom(tid)/1.15)}
  else if(act==='zedit'){editZoom(btn,cardZoom(tid),z=>setCardZoom(tid,z))}
  else if(act==='ask'){if(streaming.has(tid))return;const i=btn.closest('.cnode').querySelector('.cask textarea');const v=i.value.trim();if(!v&&!(pendingImgs.get(tid)||[]).length)return;const imgs=takePending(tid);i.value='';autosizeCask(i);send(tid,v,imgs)}
}
(()=>{
  const cv=$('#cv');let pan=null,cd=null;
  let rs=null,dd=null;
  // touch: fingers currently down, and a two-finger pinch (zoom + pan around the fingers' midpoint)
  const pts=new Map();let pinch=null;
  const two=()=>{const [a,b]=[...pts.values()],r=cvRect();return {d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),mx:(a.x+b.x)/2-r.left,my:(a.y+b.y)/2-r.top}};
  const startPinch=()=>{
    if(cd){for(const s of Object.values(cd.start)){s.el.style.left=s.x+'px';s.el.style.top=s.y+'px'}cd.n.classList.remove('lift');showSnapPreview(null);cd=null;drawEdgesSoon()}
    pan=null;dd=null;cv.classList.remove('drag');
    const g=two();pinch={...g,k:cam.k,x:cam.x,y:cam.y};
  };
  // a canvas drag (pan, move or resize a card) owns its press: no text is selected anywhere while it lasts, not even
  // in the docked document or a card it passes over, and checkSelection opens no branch popup from it (cvTook)
  const cvTake=()=>{cvTook=true;document.documentElement.classList.add('cvnosel');const s=getSelection();if(s&&!s.isCollapsed)s.removeAllRanges()};
  document.addEventListener('pointerdown',()=>{cvTook=false},true);   // a new press starts out nobody's
  for(const t of ['pointerup','pointercancel'])document.addEventListener(t,()=>document.documentElement.classList.remove('cvnosel'),true);   // wherever it ends
  cv.addEventListener('pointerdown',e=>{
    if(e.pointerType==='touch'){
      if(e.isPrimary)pts.clear();   // first finger of a new gesture: forget any finger whose lift we missed
      pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pts.size===2&&!rs){startPinch();(()=>{try{cv.setPointerCapture(e.pointerId)}catch(_){}})();e.preventDefault();return}
      if(pinch||(rs&&pts.size>1))return;   // extra fingers during a pinch or a resize do nothing
    }
    const anyCard=e.target.closest('.cnode');if(anyCard)raiseCard(anyCard.dataset.ctid);
    const hz=e.target.closest('.cnode .rzh');
    if(hz){
      const n=hz.closest('.cnode'),f=n.querySelector('.cfull');
      const tid=n.dataset.ctid,z=cardZoom(tid),docked=n.classList.contains('docked');
      rs={n,tid,z,docked,exp:n.classList.contains('exp'),dir:hz.dataset.dir,sx:e.clientX,sy:e.clientY,x:n.offsetLeft,y:n.offsetTop,w:n.offsetWidth,f,
        h:docked?n.offsetHeight:(f?(parseFloat(f.style.height)||f.getBoundingClientRect().height/cam.k/z):0)};
      cvTake();n.classList.add('sizing');(()=>{try{hz.setPointerCapture(e.pointerId)}catch(_){}})();e.preventDefault();e.stopPropagation();return;
    }
    const h=e.target.closest('.cnode .ch');
    if(h&&!e.target.closest('button,[data-resolve],.czoom')&&h.closest('.cnode').classList.contains('docked')){
      const n=h.closest('.cnode'),r=n.getBoundingClientRect();
      dd={n,tid:n.dataset.ctid,sx:e.clientX,sy:e.clientY,gx:(e.clientX-r.left)/r.width};cvTake();e.preventDefault();return;
    }
    if(h&&!e.target.closest('button,[data-resolve],.czoom')){
      const n=h.closest('.cnode'),tid=n.dataset.ctid,move=[tid,...(e.shiftKey?descendants(tid):[])];
      const start={};move.forEach(id=>{const el=$('#cv').querySelector(`.cnode[data-ctid="${id}"]`);if(el)start[id]={el,x:el.offsetLeft,y:el.offsetTop}});
      cvTake();cd={sx:e.clientX,sy:e.clientY,start,moved:false,n,tid,snap:!e.shiftKey,zone:null};(()=>{try{h.setPointerCapture(e.pointerId)}catch(_){}})();e.preventDefault();return;
    }
    if(e.target.closest('.cnode,.cvtools'))return;
    {const S=cvState();if(S.sel){S.sel=null;applyStack()}}
    cvTake();e.preventDefault();pan={x:e.clientX,y:e.clientY,cx:cam.x,cy:cam.y};cv.classList.add('drag');(()=>{try{cv.setPointerCapture(e.pointerId)}catch(_){}})();
  });
  cv.addEventListener('pointermove',e=>{
    if(pts.has(e.pointerId))pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pinch){
      if(pts.size<2)return;
      const g=two(),k=Math.min(2.5,Math.max(0.15,pinch.k*g.d/pinch.d));
      // keep the world point that was under the starting midpoint under the current midpoint
      cam.x=g.mx-(pinch.mx-pinch.x)*(k/pinch.k);cam.y=g.my-(pinch.my-pinch.y)*(k/pinch.k);cam.k=k;applyCam();return;
    }
    if(rs){
      const d=rs.dir,clamp=(v,a,b)=>Math.round(Math.min(b,Math.max(a,v)));
      if(rs.docked){   // stuck cards resize in screen pixels
        const dx=e.clientX-rs.sx,dy=e.clientY-rs.sy;
        if(d.includes('e')||d.includes('w')){const w=clamp(d.includes('e')?rs.w+dx:rs.w-dx,260,4000);rs.n.style.width=w+'px';if(d.includes('w'))rs.n.style.left=(rs.x+rs.w-w)+'px'}
        if(d.includes('s')||d.includes('n')){const h=clamp(d.includes('s')?rs.h+dy:rs.h-dy,180,4000);rs.n.style.height=h+'px';if(d.includes('n'))rs.n.style.top=(rs.y+rs.h-h)+'px'}
        drawEdgesSoon();return;
      }
      const dx=(e.clientX-rs.sx)/cam.k,dy=(e.clientY-rs.sy)/cam.k;
      if(d.includes('e')||d.includes('w')){
        const w=clamp(d.includes('e')?rs.w+dx:rs.w-dx,240*rs.z,1400*rs.z);
        rs.n.style.width=w+'px';if(d.includes('w'))rs.n.style.left=(rs.x+rs.w-w)+'px';   // left side: the right edge stays put
      }
      if(rs.f&&(d.includes('s')||d.includes('n'))){
        const h=clamp(d.includes('s')?rs.h+dy/rs.z:rs.h-dy/rs.z,140,1600);   // stored at 100%, shown at the card's zoom
        rs.f.style.maxHeight='none';rs.f.style.height=h+'px';if(d.includes('n'))rs.n.style.top=(rs.y-(h-rs.h)*rs.z)+'px';   // top side: the bottom stays put
      }
      drawEdgesSoon();return;
    }
    if(dd){
      if(Math.hypot(e.clientX-dd.sx,e.clientY-dd.sy)<6)return;
      // dragging a stuck card off: it goes back onto the canvas under the pointer, and the drag continues
      const tid=dd.tid,S=cvState(),pre=S.pre&&S.pre[tid];dd=null;
      delete S.dock[tid];if(pre){S.open=S.open.filter(x=>x!==tid);if(pre.exp)S.open.push(tid);delete S.pre[tid]}
      renderCanvas();
      const n=$('#world').querySelector(`.cnode[data-ctid="${tid}"]`);if(!n)return;
      const c=cvRect(),wx=(e.clientX-c.left-cam.x)/cam.k,wy=(e.clientY-c.top-cam.y)/cam.k;
      n.style.left=Math.round(wx-n.offsetWidth*.3)+'px';n.style.top=Math.round(wy-14)+'px';
      cd={sx:e.clientX,sy:e.clientY,start:{[tid]:{el:n,x:n.offsetLeft,y:n.offsetTop}},moved:true,n,tid,snap:true,zone:null};n.classList.add('lift');raiseCard(tid);drawEdges();return;
    }
    if(cd){
      const dx=(e.clientX-cd.sx)/cam.k,dy=(e.clientY-cd.sy)/cam.k;
      if(!cd.moved&&Math.hypot(dx,dy)*cam.k<4)return;
      if(!cd.moved){cd.moved=true;cd.n.classList.add('lift')}
      for(const [id,s] of Object.entries(cd.start)){s.el.style.left=(s.x+dx)+'px';s.el.style.top=(s.y+dy)+'px'}
      if(cd.snap){cd.zone=snapZone(e);showSnapPreview(cd.zone)}
      drawEdgesSoon();return;
    }
    if(!pan)return;cam.x=pan.cx+e.clientX-pan.x;cam.y=pan.cy+e.clientY-pan.y;applyCam();
  });
  const end=e=>{
    document.documentElement.classList.remove('cvnosel');
    if(e&&e.pointerType==='touch'){
      pts.delete(e.pointerId);
      if(pinch){
        if(pts.size<2){pinch=null;
          // one finger left: carry on panning with it
          const [f]=pts.values();if(f){pan={x:f.x,y:f.y,cx:cam.x,cy:cam.y};cv.classList.add('drag')}}
        return;
      }
    }
    if(rs&&rs.docked){
      const S=cvState();S.dock[rs.tid]=pxRegion(rs.n.offsetLeft,rs.n.offsetTop,rs.n.offsetWidth,rs.n.offsetHeight);
      rs.n.classList.remove('sizing');rs=null;drawEdges();save();return;
    }
    if(dd){dd=null;return}
    if(rs){
      const S=cvState(),k=sizeKey(rs.tid,rs.exp);
      S.size[k]={w:Math.round(rs.n.offsetWidth/rs.z),...(rs.f&&rs.f.style.height?{h:parseInt(rs.f.style.height)}:(S.size[k]&&S.size[k].h?{h:S.size[k].h}:{}))};
      // resizing from the left or top moves the card, so pin positions like a drag does
      if(rs.dir.includes('w')||rs.dir.includes('n'))$('#world').querySelectorAll('.cnode').forEach(el=>{S.pos[el.dataset.ctid]={x:Math.round(el.offsetLeft),y:Math.round(el.offsetTop)}});
      rs.n.classList.remove('sizing');rs=null;drawEdges();save();return;
    }
    if(cd){
      showSnapPreview(null);
      if(cd.moved&&cd.zone){const st=cd.start[cd.tid],z=cd.zone,tid=cd.tid;cd.n.classList.remove('lift');cd=null;dockCard(tid,REGIONS[z],st?{x:st.x,y:st.y}:null);return}
      if(cd.moved){const S=cvState();
        // pin every visible card where it is, so moving one never makes the others jump
        $('#world').querySelectorAll('.cnode').forEach(el=>{S.pos[el.dataset.ctid]={x:Math.round(el.offsetLeft),y:Math.round(el.offsetTop)}});
        cd.n.classList.remove('lift');save()}
      cd=null;return;
    }
    pan=null;cv.classList.remove('drag');
  };
  cv.addEventListener('pointerup',end);cv.addEventListener('pointercancel',end);
  cv.addEventListener('dblclick',e=>{const hz=e.target.closest('.cnode .rzh');if(hz){const n=hz.closest('.cnode');delete cvState().size[sizeKey(n.dataset.ctid,n.classList.contains('exp'))];renderCanvas();save();return}
    const h=e.target.closest('.cnode .ch');if(h&&!e.target.closest('button,[data-resolve]')){const id=h.closest('.cnode').dataset.ctid;if(id==='doc')openDocPane();else openFromCanvas(id)}});
  cv.addEventListener('wheel',e=>{
    const zc=e.altKey&&e.target.closest('.cnode');
    if(zc){e.preventDefault();if(cvState().sel!==zc.dataset.ctid)raiseCard(zc.dataset.ctid);setCardZoom(zc.dataset.ctid,cardZoom(zc.dataset.ctid)*Math.exp(-e.deltaY*0.002));return}
    if(e.target.closest('.cq,.cfull,.cdocpane')&&!e.ctrlKey)return;   // scroll the card's content (or the docked document), not the canvas
    e.preventDefault();const r=cv.getBoundingClientRect();
    if(e.ctrlKey||Math.abs(e.deltaY)>=Math.abs(e.deltaX))zoomAt(Math.exp(-e.deltaY*(e.ctrlKey?0.01:0.0015)),e.clientX-r.left,e.clientY-r.top);
    else{cam.x-=e.deltaX;applyCam()}
  },{passive:false});
  cv.addEventListener('keydown',e=>{const i=e.target.closest('.cask textarea');if(i&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();canvasAction('ask',i.closest('.cnode').dataset.ctid,i)}});
  $('#zIn').innerHTML=ic('plus');$('#zOut').innerHTML=ic('minus');$('#zFit').innerHTML=ic('fit');
  $('#zTidy').innerHTML=ic('canvas')+'Tidy';
  $('#zHere').innerHTML=ic('locate')+'You were here';
  $('#zHereX').onclick=()=>clearHere();
  $('#zHere').onclick=()=>{const n=cvHere&&$('#cv').querySelector(`.cnode[data-ctid="${cvHere}"]`);if(n){panToCard(n);n.classList.remove('flash');void n.offsetWidth;n.classList.add('flash')}};
  $('#zIn').onclick=()=>zoomAt(1.2);$('#zOut').onclick=()=>zoomAt(1/1.2);$('#zFit').onclick=fitCanvas;
  $('#zTidy').onclick=()=>{cvState().pos={};renderCanvas();fitCanvas();save()};
  $('#zViews').onclick=(e)=>{e.stopPropagation();$('#cvViews').classList.contains('open')?closeViews():openViews()};
})();
/* ---------- canvas views ----------
   A view is a saved arrangement of the canvas (card positions and sizes, which cards are open, folded or
   docked, their zoom, where the camera is), kept in the conversation (conv.views), so all your devices have
   it. The canvas itself is per device (it's in the layout). Loading a view copies it onto this device's
   canvas: moving cards afterwards changes only this device until you choose Update. "This device" goes back
   to the arrangement this device had before it loaded a view (ui.cvOwn). Nothing changes unless you use them. */
const cvSnap=()=>({cv:JSON.parse(JSON.stringify(cvState())),cam:{x:cam.x,y:cam.y,k:cam.k}});
function cvLoad(snap){conv.ui.cv=JSON.parse(JSON.stringify(snap.cv||{}));if(snap.cam){Object.assign(cam,snap.cam);camFitted=true}renderCanvas();applyCam();save()}
function useView(vid){
  const ui=conv.ui;
  if(!vid){if(ui.cvOwn)cvLoad(ui.cvOwn);delete ui.cvOwn;delete ui.cvView}
  else{const v=(conv.views||{})[vid];if(!v)return;if(!ui.cvView)ui.cvOwn=cvSnap();ui.cvView=vid;cvLoad(v)}
  syncViewsUI();save();
}
function saveView(name){
  name=(name||'').trim().slice(0,60);if(!name)return;
  const id='v'+rid();conv.views=conv.views||{};conv.views[id]={name,...cvSnap(),at:Date.now()};
  conv.ui.cvView=id;syncViewsUI();save();setStatus(`Saved “${name}”`);
}
function updateView(vid){const v=(conv.views||{})[vid];if(!v)return;Object.assign(v,cvSnap(),{at:Date.now()});syncViewsUI();save();setStatus(`Updated “${v.name}”`)}
function deleteView(vid){const v=(conv.views||{})[vid];if(!v)return;delete conv.views[vid];if(!Object.keys(conv.views).length)delete conv.views;if(conv.ui.cvView===vid)delete conv.ui.cvView;syncViewsUI();save()}
function syncViewsUI(){
  const b=$('#zViews');if(!b||!conv)return;
  const v=conv.ui.cvView&&(conv.views||{})[conv.ui.cvView];if(conv.ui.cvView&&!v)delete conv.ui.cvView;
  b.innerHTML=ic('views')+`<span class="vn">${esc(v?v.name:'Views')}</span>`;
  const m=$('#cvViews');if(m&&m.classList.contains('open'))renderViewsMenu();
}
function renderViewsMenu(edit){
  const m=$('#cvViews'),cur=conv.ui.cvView,vs=Object.entries(conv.views||{}).sort((a,b)=>a[1].name.localeCompare(b[1].name));
  const ck=(on)=>`<span class="vck">${on?ic('check'):''}</span>`;
  m.innerHTML=`<div class="thh">Canvas views, shared with your other devices</div>`+
    `<div class="vrow"><button data-vuse="">${ck(!cur)}<span>This device</span><small>its own arrangement</small></button></div>`+
    vs.map(([id,v])=>edit===id?`<form data-vren="${id}"><input value="${esc(v.name)}" maxlength="60" aria-label="New name"><button class="tb">Rename</button></form>`:
      `<div class="vrow"><button data-vuse="${id}" title="Lay this canvas out like this view (on this device; the view itself only changes with Update)">${ck(cur===id)}<span>${esc(v.name)}</span></button>`+
      (cur===id?`<button class="ib" data-vupd="${id}" title="Update: save this canvas as it is now into “${esc(v.name)}”">${ic('retry')}</button>`:'')+
      `<button class="ib" data-vedit="${id}" title="Rename">${ic('edit')}</button><button class="ib" data-vdel="${id}" title="Delete this view">${ic('trash')}</button></div>`).join('')+
    `<form data-vnew><input placeholder="Name this arrangement…" maxlength="60" aria-label="Name for a new view"><button class="tb">Save view</button></form>`;
  const r=$('#zViews').getBoundingClientRect();
  m.style.right=Math.max(8,innerWidth-r.right)+'px';m.style.bottom=Math.max(8,innerHeight-r.top+6)+'px';m.style.left='auto';m.style.top='auto';
  if(edit){const i=m.querySelector(`form[data-vren="${edit}"] input`);i.focus();i.select()}
}
function openViews(){$('#cvViews').classList.add('open');renderViewsMenu()}
function closeViews(){const m=$('#cvViews');if(m)m.classList.remove('open')}
(()=>{
  const m=document.createElement('div');m.className='thmenu cvviews';m.id='cvViews';m.setAttribute('role','menu');document.body.appendChild(m);
  m.addEventListener('click',e=>{
    const u=e.target.closest('[data-vuse]');if(u){useView(u.dataset.vuse||null);closeViews();return}
    const up=e.target.closest('[data-vupd]');if(up){updateView(up.dataset.vupd);return}
    const ed=e.target.closest('[data-vedit]');if(ed){renderViewsMenu(ed.dataset.vedit);return}
    const d=e.target.closest('[data-vdel]');if(d){const v=conv.views[d.dataset.vdel];closeViews();askConfirm('Delete this view?',`<b>${esc(v.name)}</b> will be removed from all your devices. The canvas stays as it is.`,()=>deleteView(d.dataset.vdel))}
  });
  m.addEventListener('submit',e=>{
    e.preventDefault();const f=e.target,name=f.querySelector('input').value;
    if(f.dataset.vren){const v=conv.views[f.dataset.vren];if(v&&name.trim()){v.name=name.trim().slice(0,60);save()}syncViewsUI();renderViewsMenu();return}
    saveView(name);closeViews();
  });
  m.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeViews();$('#zViews').focus()}});
  document.addEventListener('pointerdown',e=>{if(m.classList.contains('open')&&!m.contains(e.target)&&!e.target.closest('#zViews'))closeViews()});
})();
function openFromCanvas(tid,mid){
  setView(conv.ui.layout);
  openThread(tid);conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!==tid);layout();
  if(mid)revealMsg(tid,mid);
}
function setView(v){
  if(v!=='canvas')clearHere();
  // the panes are hidden while the canvas shows, and Safari forgets a hidden element's scroll: note each pane's, to put back
  if(v==='canvas'&&conv.ui.view!=='canvas')for(const [tid,el] of paneEls){if(tid==='doc')continue;const pb=el.querySelector(':scope>.pb');if(pb)el.__viewTop=pb.scrollTop}   // (the document keeps its own spot: noteDocSpot)
  if(v==='canvas'){const from=conv.ui.view!=='canvas'?focusedPane():null;conv.ui.view='canvas';$('#stage').classList.add('canvas');hidePop();renderCanvas();if(from)requestAnimationFrame(()=>cvArrive(from))}
  else{
    const was=conv.ui.view;conv.ui.view='panes';$('#stage').classList.remove('canvas');
    if(v!==conv.ui.layout){conv.ui.layout=v;conv.ui.sizes={}}
    layout();if(was==='canvas'){conv.ui.open.forEach(id=>renderPane(id));
      for(const [,el] of paneEls){const pb=el.querySelector(':scope>.pb');if(pb&&el.__viewTop!=null&&el.isConnected&&Math.abs(pb.scrollTop-el.__viewTop)>1)holdScroll(pb,el.__viewTop);el.__viewTop=null}}
  }
  syncViewSeg();save();
}
// Tab name: the conversation's title ("Bayes' rule · Digress"), kept in step by renderTitle. It does end up in browser
// history and the OS window switcher; the reader chose that over the old "Digress 2 · Canvas", which said nothing useful.
// a reply that finished while this tab was in the background puts a dot in front of the tab's name until you come back
let tabReady=false;
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tabReady){tabReady=false;if(conv)tabName()}});
function tabName(){if(!conv)return;const t=`${tabReady?'● ':''}${conv.title||'New conversation'} · Digress`;if(document.title!==t)document.title=t}
function syncViewSeg(){tabName();const v=conv.ui.view==='canvas'?'canvas':conv.ui.layout;document.querySelectorAll('#viewSeg button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
  $('#resetOrder').style.display=conv.ui.view!=='canvas'&&conv.ui.open.join()!==branchOrder().join()?'':'none'}
// the order panes open in: the document, then main, each branch right after the thread it came from (oldest first)
function branchOrder(){
  const open=conv.ui.open,out=open.includes('doc')?['doc']:[];
  const walk=(tid)=>{if(open.includes(tid))out.push(tid);for(const c of children(tid))walk(c.id)};walk('main');
  for(const x of open)if(!out.includes(x))out.push(x);return out;
}
$('#resetOrder').addEventListener('click',()=>{conv.ui.open=branchOrder();layout();save()});

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

/* ---------- search: a per-conversation text index (kept separately, updated on save) + BM25 ranking ---------- */
const KIND={ct:['Conversation',3],bt:['Branch',2.4],h:['Highlight',2.2],n:['Takeaway',2],q:['Question',1.6],a:['Answer',1],d:['Document',0.9]};
const IDX={map:new Map(),loaded:false,loading:null,ms:null,dirty:true,dirtyIds:new Set(),indexedIds:new Map(),lastSig:new Map(),backfilling:false};
function idxTouch(id){if(id)IDX.dirtyIds.add(id);else IDX.dirty=true}
let miniP=null;
function loadMini(){if(!miniP)miniP=loadScript('https://cdn.jsdelivr.net/npm/minisearch@7.1.0/dist/umd/index.js').catch(e=>{miniP=null;throw e});return miniP}
/* The search index holds passages, not whole messages: each message and document page is split into
   paragraphs packed to about PASS characters (code blocks never split), and each passage after the first
   starts with the last ~OVERLAP characters of the one before (`o` = how many), so a phrase across a boundary
   is still found. Nothing is cut off: every word of every message is searchable, a passage that has all
   the search words is usually the one you want, and a result points at its passage (`n`). IDXV marks the
   format; indexes written by an older one are rebuilt (idxBackfill). */
const IDXV=2;   // passages, indexEntries, idxPages, sigOf live in ./text.js
async function idxWrite(c,pages){
  if(!io.index)return;
  if(!pages&&c.doc){
    let old=IDX.map.get(c.id);
    if(!old&&io.index.search&&io.index.get){try{old=await io.index.get(c.id)}catch(_){}}
    if(old)pages=idxPages(old);
  }
  const E=indexEntries(c,pages),sig=sigOf(E);
  if(IDX.lastSig.get(c.id)===sig&&(IDX.map.get(c.id)||{}).v===IDXV)return;
  const d={id:c.id,v:IDXV,updated:c.updated||Date.now(),sig,e:E};
  IDX.lastSig.set(c.id,sig);IDX.map.set(c.id,d);idxTouch(c.id);
  try{await io.index.put(c.id,d)}
  catch(e){console.warn('index write failed',e);IDX.lastSig.delete(c.id)}
}
async function idxDelete(id){IDX.map.delete(id);IDX.lastSig.delete(id);idxTouch(id);try{io.index&&await io.index.remove(id)}catch(e){}}
function idxLoadAll(){
  if(IDX.loaded)return Promise.resolve();
  if(!IDX.loading)IDX.loading=(async()=>{
    try{
      await io.ready;
      for(const {id,data} of await io.index.list()){IDX.map.set(id,data);IDX.lastSig.set(id,data.sig)}
    }catch(e){console.warn('index load failed',e)}
    IDX.loaded=true;IDX.dirty=true;
  })();
  return IDX.loading;
}
/* index any conversation that has no entry yet, changed since, or was indexed in an older format */
async function idxBackfill(onProgress){
  if(IDX.backfilling||!io.store)return;IDX.backfilling=true;
  try{
    const stale=convList.filter(c=>c.id!==(conv&&conv.id)&&(!IDX.map.has(c.id)||IDX.map.get(c.id).v!==IDXV||(IDX.map.get(c.id).updated||0)<(c.updated||0)));
    let i=0;
    for(const c of stale){
      onProgress&&onProgress(++i,stale.length);
      let data=null;
      try{data=await io.store.get(c.id)}catch(e){}
      if(data)await idxWrite({...data,id:c.id},null);
    }
  }finally{IDX.backfilling=false}
}
function idxDocsFor(cid){
  const d=(conv&&conv.id===cid)?{id:cid,e:indexEntries(conv,state.docState&&state.docState.key===cid&&state.docState.loaded?state.docState.pages:idxPages(IDX.map.get(cid)))}:IDX.map.get(cid);
  return d&&d.e?d.e.map((en,i)=>({id:cid+'|'+i,cid,...en})):[];
}
async function idxEngine(){
  await loadMini();
  if(conv&&!IDX.indexedIds.has(conv.id))IDX.dirtyIds.add(conv.id);
  if(IDX.ms&&!IDX.dirty){
    if(IDX.dirtyIds.size){
      for(const cid of IDX.dirtyIds){
        const prev=IDX.indexedIds.get(cid);
        if(prev)for(const docId of prev)try{IDX.ms.discard(docId)}catch(_){}
        const docs=idxDocsFor(cid);
        if(docs.length){IDX.ms.addAll(docs);IDX.indexedIds.set(cid,docs.map(x=>x.id))}
        else IDX.indexedIds.delete(cid);
      }
      IDX.dirtyIds.clear();
      if(IDX.ms.dirtCount>500)try{IDX.ms.vacuum()}catch(_){}
    }
    return IDX.ms;
  }
  const ms=new MiniSearch({fields:['x'],storeFields:['cid','k','tid','mid','p','n','o','x'],
    searchOptions:{fuzzy:(t)=>t.length>=5?0.2:false,prefix:(t,i,ts)=>i===ts.length-1&&t.length>1,boostDocument:(id,term,st)=>(KIND[st&&st.k]||[0,1])[1]}});
  const ids=new Set(IDX.map.keys());if(conv)ids.add(conv.id);
  IDX.indexedIds.clear();
  const docs=[];
  for(const cid of ids){const ds=idxDocsFor(cid);if(ds.length){IDX.indexedIds.set(cid,ds.map(x=>x.id));for(const x of ds)docs.push(x)}}
  ms.addAll(docs);IDX.ms=ms;IDX.dirty=false;IDX.dirtyIds.clear();return ms;
}
/* ---------- search palette ---------- */
const PAL={results:[],sel:0,timer:0,q:'',scope:'all',stid:null};
/* Where a search looks: everywhere, this conversation, or one thread (the pane you were last in, or the one
   whose magnifier opened it; 'doc' = the document). Tab moves between them. */
const scopeTid=()=>{const ok=t=>t&&conv&&(t==='doc'?!!conv.doc:!!T(t));return lastPane&&conv&&lastPane.cid===conv.id&&ok(lastPane.tid)?lastPane.tid:'main'};
function threadName(tid){return tid==='doc'?'The document':tid==='main'?'Main thread':'Thread “'+trunc(T(tid).title,32)+'”'}
function renderScope(){
  const box=$('#palScope');if(!conv){box.innerHTML='';PAL.scope='all';return}
  const opts=[['all','Everywhere'],['conv','This conversation'],['thread',threadName(PAL.stid)]];
  box.innerHTML=opts.map(([v,l])=>`<button type="button" data-pscope="${v}" class="${PAL.scope===v?'on':''}"></button>`).join('');
  [...box.children].forEach((b,i)=>{b.textContent=opts[i][1];b.title=i===2?'Search only this thread':i===1?'Search only this conversation':'Search every conversation'});
  $('#palIn').placeholder=PAL.scope==='thread'?(PAL.stid==='doc'?'Search the document…':'Search this thread…'):PAL.scope==='conv'?'Search this conversation…':'Search conversations, highlights, takeaways, documents…';
}
function setScope(v){PAL.scope=v;renderScope();runSearch();$('#palIn').focus()}
function openPalette(initial,scope,tid){
  hidePop();hideTip();PAL.marked=false;
  PAL.stid=tid||scopeTid();PAL.scope=conv&&scope?scope:'all';renderScope();
  const p=$('#pal');p.classList.add('show');const inp=$('#palIn');inp.value=initial||'';inp.focus();inp.setSelectionRange(inp.value.length,inp.value.length);
  $('#palFoot').textContent='';
  runSearch();
  (async()=>{
    if(io.index&&io.index.search){
      if(conv)await idxWrite(conv,state.docState&&state.docState.key===conv.id&&state.docState.loaded?state.docState.pages:null);
      if($('#pal').classList.contains('show'))runSearch();
      return;
    }
    const wasLoaded=IDX.loaded;
    await idxLoadAll();if(!wasLoaded)IDX.dirty=true;
    await idxBackfill((i,n)=>{$('#palFoot').textContent=`Indexing older conversations: ${i} of ${n}…`});
    $('#palFoot').textContent='';if($('#pal').classList.contains('show'))runSearch();
  })();
}
function closePalette(){$('#pal').classList.remove('show')}
/* Where a result matches. MiniSearch finds the entries (typo-tolerant, any order); these place the match:
   the typed phrase if it's there, else the spot with the most different search words close together.
   Typo matches ("machine" for "matching") count only when a typed word isn't there as such. */
const reEsc=t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),WB='(?<![\\p{L}\\p{N}])';
const qWords=q=>(q||'').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>1);
// words too common to point anywhere: never highlighted or landed on (a phrase containing them still counts)
const STOP=new Set('a an and are as at be but by can do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this those to too two up us was we were what when where which while who why will with you your'.split(' '));
function matchTerms(r,q){
  const qw=qWords(q).filter(w=>!STOP.has(w)),low=(r.x||'').toLowerCase(),missing=qw.some(w=>!new RegExp(WB+reEsc(w),'u').test(low));
  return [...new Set([...qw,...(missing?(r.terms||[]):[])])];
}
function bestSpot(low,terms,q){
  const out={hits:[],from:0,to:0};if(!terms.length)return out;
  const re=new RegExp(WB+'('+terms.map(reEsc).sort((a,b)=>b.length-a.length).join('|')+')','gu');
  let m;while((m=re.exec(low))){out.hits.push([m.index,m.index+m[0].length,m[0]]);if(out.hits.length>2000)break}
  if(!out.hits.length)return out;
  const qw=qWords(q),ph=qw.length>1&&new RegExp(WB+qw.map(reEsc).join('[^\\p{L}\\p{N}]+'),'u').exec(low);
  if(ph){out.from=ph.index;out.to=Math.max(ph.index+ph[0].length,ph.index+200);out.phrase=true;return out}
  let best=0,bestN=-1;for(let i=0;i<out.hits.length;i++){const seen=new Set();for(let j=i;j<out.hits.length&&out.hits[j][0]<out.hits[i][0]+200;j++)seen.add(out.hits[j][2]);if(seen.size>bestN){bestN=seen.size;best=i}}
  out.from=out.hits[best][0];out.to=out.from+200;return out;
}
function snippet(x,terms,q=PAL.q){
  const re=terms.length?new RegExp('('+terms.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).sort((a,b)=>b.length-a.length).join('|')+')','gi'):null;
  let start=0;if(re){const sp=bestSpot(x.toLowerCase(),terms,q);if(sp.hits.length)start=Math.max(0,sp.from-70)}
  let s=x.slice(start,start+260);if(start>0)s='…'+s.replace(/^\S*\s/,'');if(start+260<x.length)s+='…';
  return re?esc(s).replace(new RegExp('('+terms.map(t=>esc(t).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','gi'),'<mark>$1</mark>'):esc(s);
}
function convMeta(cid){return conv&&conv.id===cid?metaOf(conv):(convList.find(c=>c.id===cid)||{title:'Conversation'})}
function threadTitle(cid,tid,r){
  if(conv&&conv.id===cid){const t=T(tid);return t?(t.parent?t.title:'Main thread'):''}
  if(r&&r.bt)return r.bt;
  const p=(IDX.map.get(cid)||{e:[]}).e.find(e=>e.k==='bt'&&e.tid===tid);return p?p.x:(tid==='main'?'Main thread':'')
}
async function queryIndex(q){
  if(io.index&&io.index.search){
    return await io.index.search(q,{scope:PAL.scope,cid:conv?conv.id:'',tid:PAL.stid||''});
  }
  const ms=await idxEngine();
  let res=ms.search(q,{combineWith:'AND'});if(!res.length)res=ms.search(q);
  // the exact phrase first, then more of the typed words as typed (not just typo matches), then BM25
  const qw=qWords(q),ph=qw.length>1&&new RegExp(WB+qw.map(reEsc).join('[^\\p{L}\\p{N}]+'),'u'),wr=qw.map(w=>new RegExp(WB+reEsc(w),'u'));
  for(const r of res){const low=(r.x||'').toLowerCase();r.phrase=ph&&ph.test(low)?1:0;r.exact=wr.filter(x=>x.test(low)).length}
  res.sort((a,b)=>(b.phrase-a.phrase)||(b.exact-a.exact)||(b.score-a.score));
  return res;
}
function runSearch(){AIQ.seq++;PAL.ai=null;PAL.running=searchNow();return PAL.running}
function scopeFilter(res){if(PAL.scope==='all'||!conv)return res;const id=conv.id,st=PAL.stid;return res.filter(r=>r.cid===id&&(PAL.scope==='conv'||(st==='doc'?r.k==='d':r.k!=='d'&&r.tid===st)))}
const resultKey=r=>r.cid+'|'+(r.mid||'')+'|'+r.k+'|'+(r.k==='d'?r.p:r.k==='bt'||r.k==='h'?r.tid:'');
async function searchNow(){
  const q=$('#palIn').value.trim();PAL.q=q;const box=$('#palRes');
  if(!q&&PAL.scope!=='all'){PAL.results=[];box.innerHTML=`<div class="pempty">Type to search ${PAL.scope==='thread'?(PAL.stid==='doc'?'the document':'this thread'):'this conversation'}.</div>`;return}
  if(!q){
    const items=[...convList.map(c=>conv&&c.id===conv.id?metaOf(conv):c)];if(conv&&!items.find(c=>c.id===conv.id))items.unshift(metaOf(conv));
    const act=items.filter(c=>!c.archived&&!c.trashed);const list=[...act.filter(c=>c.pinned),...act.filter(c=>!c.pinned).sort((a,b)=>(b.updated||0)-(a.updated||0))].slice(0,8);
    PAL.results=list.map(c=>({cid:c.id,k:'ct',tid:'main',x:c.title||'New conversation',jump:true,pinned:c.pinned}));PAL.sel=0;
    box.innerHTML=list.length?'<div class="pgrp">Pinned and recent</div>':'<div class="pempty">No conversations yet.</div>';
    PAL.results.forEach((r,i)=>box.appendChild(resultRow(r,i,[])));markSel();return;
  }
  let res;try{res=await queryIndex(q)}catch(e){box.innerHTML='<div class="pempty">Search couldn\'t load. Check your connection and try again.</div>';return}
  if(q!==PAL.q)return;
  res=scopeFilter(res);
  {const gone=new Set(convList.filter(c=>c.trashed).map(c=>c.id));if(conv&&conv.trashed)gone.add(conv.id);if(gone.size)res=res.filter(r=>!gone.has(r.cid))}   // not what's in the trash
  {const seen=new Set();res=res.filter(r=>{const k=resultKey(r);if(seen.has(k))return false;seen.add(k);return true})}   // one row per message: its best passage
  // keep the best few hits per conversation, conversations ordered by their best hit
  const cap=PAL.scope==='all'?4:40;   // one conversation: show its matches, not just the best few
  const by=new Map();for(const r of res){const a=by.get(r.cid)||[];if(a.length<cap)a.push(r);by.set(r.cid,a)}
  const groups=[...by.entries()].slice(0,12);
  PAL.results=[];PAL.sel=0;box.replaceChildren();
  if(!groups.length){box.innerHTML=`<div class="pempty">No matches for “${esc(q)}”${PAL.scope==='thread'?(PAL.stid==='doc'?' in the document':' in this thread'):PAL.scope==='conv'?' in this conversation':''}.</div>`;aiExpandRow(box,true);markSel();return}
  for(const [cid,rs] of groups){
    const m=convMeta(cid);const g=document.createElement('div');g.className='pgrp';
    g.innerHTML=`${m.doc?ic('doc').replace('class="i"','class="i" style="width:12px;height:12px"'):''}<span></span>${m.archived?'<span class="arc">archived</span>':''}`;g.querySelector('span').textContent=m.title||'Conversation';box.appendChild(g);
    for(const r of rs){const i=PAL.results.length;PAL.results.push(r);box.appendChild(resultRow(r,i,matchTerms(r,q)))}
  }
  aiExpandRow(box,false);
  markSel();
}
function resultRow(r,i,terms){
  const d=document.createElement('div');d.className='pr';d.dataset.i=i;
  const [label]=KIND[r.k]||['Match'];
  let c='var(--faint)';if(conv&&conv.id===r.cid&&r.tid&&T(r.tid)&&T(r.tid).parent)c=color(T(r.tid));
  d.style.setProperty('--c',c);
  if(r.ai){d.classList.add('pai');d.innerHTML=`<span class="pk">${ic('sparkle')}</span><div class="pm"><div class="ps"></div><div class="pt"></div></div>`;
    d.querySelector('.ps').textContent=r.label;d.querySelector('.pt').textContent=r.sub||'';d.title=r.tip||'';return d}
  const where0=r.jump?(r.pinned?'Pinned':''):r.k==='d'?`Page ${r.p}`:r.k==='ct'?'':threadTitle(r.cid,r.tid,r);
  const where=r.why?where0+(where0?' · ':'')+r.why:r.q&&r.q!==PAL.q?where0+(where0?' · ':'')+'found with “'+r.q+'”':where0;
  d.innerHTML=`<span class="pk">${r.jump?'Open':label+(r.k==='d'&&r.p?' p. '+r.p:'')}</span><div class="pm">${where?`<div class="pt"></div>`:''}<div class="ps">${r.jump?esc(r.x):snippet(r.x||'',terms,r.q||PAL.q)}</div></div>`;
  if(where)d.querySelector('.pt').textContent=where;
  return d;
}
/* ---------- "Describe it instead": find something you half remember ----------
   Step 1 (findExpand): one quick model call with only what you typed and the titles in the search's scope;
   it returns likely search phrases, each searched as usual, results merged (found by more phrases = higher).
   Step 2 (findPick, only when asked): short snippets of the best candidates go to the model, which picks
   the ones that match, with a reason. Both are one-off calls: nothing is added to any conversation or saved. */
const canAskModel=()=>io.llm&&io.llm.kind!=='none'&&!io.offline;
// one-off calls (Describe it instead): the fast model of the family in use, as for titles (Haiku or Terra)
function fastModel(){return titleModel(conv||{msgs:{}},settings.model)}
/* Describe it instead is the one thing that reaches across conversations (titles; snippets if you let it pick), so it
   has its own model, picked beside it (settings.findModel). By default the quick model of the family in use, but never
   a Gemini one unless that's all there is: a free-tier Gemini key lets Google use what's sent. */
function findModel(){
  const ids=io.llm?io.llm.models().map(x=>x[0]):[];
  if(settings.findModel&&ids.includes(settings.findModel))return settings.findModel;
  const f=fastModel();if(MODEL_FAM(f)!=='google')return f;
  return ids.find(x=>/haiku/i.test(x))||ids.find(x=>/terra/i.test(x))||ids.find(x=>/mini|luna/i.test(x))||f;
}
function scopeTitles(){
  if(PAL.scope==='thread'&&conv){if(PAL.stid==='doc')return [conv.doc?conv.doc.name:'The document'];return [conv.title,...ancestors(PAL.stid).filter(id=>id!=='main').map(id=>T(id).title)].filter(Boolean)}   // its path: the conversation, then each thread down to this one
  if(PAL.scope==='conv'&&conv)return [conv.title,...Object.values(conv.threads).filter(t=>t.parent).map(t=>t.title),...(conv.doc?[conv.doc.name]:[])].filter(Boolean);
  const items=convList.map(c=>conv&&c.id===conv.id?metaOf(conv):c);if(conv&&!items.find(c=>c.id===conv.id))items.unshift(metaOf(conv));
  return [...items.filter(c=>c.pinned),...items.filter(c=>!c.pinned).sort((a,b)=>(b.updated||0)-(a.updated||0))].slice(0,150).map(c=>c.title).filter(Boolean);
}
const AIQ={seq:0};
async function askFind(text){
  const r=await io.llm.complete({system:PROMPTS.find.system,messages:[{role:'user',content:text}],model:findModel(),effort:'low',web:false});
  return r.text||'';
}
function aiRows(box,rows){for(const r of rows){const i=PAL.results.length;PAL.results.push(r);const el=resultRow(r,i,[]);box.appendChild(el);if(r.ai)el.appendChild(findModelButton())}}
// "Asks: Haiku 5.5 ▾": which model Describe it instead uses; opens the same grouped menu as the top bar's
function findModelButton(){
  const b=document.createElement('button');b.type='button';b.className='paimodel';b.setAttribute('aria-haspopup','true');
  const id=findModel(),l=(io.llm.models().find(x=>x[0]===id)||[0,id])[1];b.textContent='Asks: '+l;b.title='The model Describe it instead asks (what you typed and titles; snippets only if you let it pick)';
  b.addEventListener('click',e=>{e.stopPropagation();e.preventDefault();if(modelsOpen()&&menuFor&&menuFor.anchor===b)return closeModels();
    openModelMenu({anchor:b,find:true,cur:()=>findModel(),pick:(v)=>{settings.findModel=v||null;saveSettings();for(const x of document.querySelectorAll('.paimodel'))x.textContent='Asks: '+(io.llm.models().find(m=>m[0]===findModel())||[0,findModel()])[1]}})});
  b.addEventListener('mousedown',e=>e.stopPropagation());
  return b;
}
function aiExpandRow(box,none){
  if(!canAskModel()||PAL.q.length<3)return;
  aiRows(box,[{ai:'expand',label:none?'Nothing matched. Describe it instead: find it with AI':'Describe it instead: find it with AI',
    sub:'Sends what you typed and your '+(PAL.scope==='thread'?'thread’s':PAL.scope==='conv'?'conversation’s':'conversations’')+' titles, nothing else',tip:'The model suggests the words you probably used; Digress searches for them. Your conversations’ text isn’t sent.'}]);
}
async function findExpand(){
  const desc=PAL.q,seq=++AIQ.seq,box=$('#palRes'),row=box.querySelector('.pr.pai');
  if(row){row.querySelector('.ps').textContent='Thinking of the words you might have used…';row.classList.add('busy')}
  let phrases;
  try{phrases=(await askFind(PROMPTS.find.expand({desc,titles:scopeTitles()}))).split('\n').map(x=>x.replace(/^[\s\-*•\d.)]+/,'').replace(/["“”]/g,'').trim()).filter(x=>x&&x.length<60).slice(0,8)}
  catch(e){if(seq===AIQ.seq&&row){row.classList.remove('busy');row.querySelector('.ps').textContent='Couldn’t ask the model: '+((e&&e.message)||'error')}return}
  if(seq!==AIQ.seq||desc!==PAL.q)return;
  const found=new Map();
  for(const ph of [...phrases,desc]){   // the model's phrases first: a passage they find lands on their words, not on yours
    let rs=scopeFilter(await queryIndex(ph));
    rs.slice(0,30).forEach((r,i)=>{const k=resultKey(r),f=found.get(k);if(f){f.score2+=1/(i+2)}else found.set(k,{...r,q:ph,score2:1/(i+2)})});
  }
  const list=[...found.values()].sort((a,b)=>b.score2-a.score2);
  PAL.ai={desc,phrases,list};
  showAiResults(list.slice(0,12),`Found with AI · ${phrases.slice(0,4).map(p=>'“'+p+'”').join(' ')}`);
  if(list.length)aiRows(box,[{ai:'pick',label:'Still not it? Let the model pick from these',sub:'Sends short snippets of '+(list.length===1?'the top match':'the top '+Math.min(25,list.length)+' matches'),tip:'The model reads ~300-character snippets of these passages and picks the ones that fit your description.'}]);
  else box.insertAdjacentHTML('beforeend','<div class="pempty">The model’s words didn’t match anything either.</div>');
  markSel();
}
async function findPick(){
  const ai=PAL.ai;if(!ai)return;const seq=++AIQ.seq,box=$('#palRes'),row=[...box.querySelectorAll('.pr.pai')].pop();
  if(row){row.querySelector('.ps').textContent='Reading the snippets…';row.classList.add('busy')}
  const cand=ai.list.slice(0,25),items=cand.map(r=>{const low=(r.x||'').toLowerCase(),sp=bestSpot(low,matchTerms(r,r.q),r.q),a=Math.max(0,(sp.hits.length?sp.from:0)-120);
    return {where:(convMeta(r.cid).title||'')+(r.k==='d'?' · p. '+r.p:''),text:(a?'…':'')+r.x.slice(a,a+300).replace(/\s+/g,' ')+'…'}});
  let picks=[];
  try{const t=await askFind(PROMPTS.find.pick({desc:ai.desc,items}));const a=t.indexOf('['),b=t.lastIndexOf(']');picks=JSON.parse(t.slice(a,b+1))}
  catch(e){if(seq===AIQ.seq&&row){row.classList.remove('busy');row.querySelector('.ps').textContent='Couldn’t ask the model: '+((e&&e.message)||'its reply wasn’t a list')}return}
  if(seq!==AIQ.seq||PAL.ai!==ai)return;
  const chosen=(Array.isArray(picks)?picks:[]).map(p=>p&&cand[(p.n|0)-1]&&{...cand[(p.n|0)-1],why:String(p.why||'').slice(0,120)}).filter(Boolean).slice(0,5);
  if(!chosen.length){if(row){row.classList.remove('busy');row.querySelector('.ps').textContent='The model didn’t find it among these.'}return}
  showAiResults(chosen,'Picked by AI');markSel();
}
function showAiResults(list,head){
  const box=$('#palRes');PAL.results=[];PAL.sel=0;box.replaceChildren();
  const g=document.createElement('div');g.className='pgrp';g.textContent=head;box.appendChild(g);
  for(const r of list){const i=PAL.results.length;PAL.results.push(r);box.appendChild(resultRow(r,i,matchTerms(r,r.q)))}
}
function markSel(){document.querySelectorAll('#palRes .pr').forEach(el=>el.classList.toggle('sel',+el.dataset.i===PAL.sel));const s=document.querySelector('#palRes .pr.sel');s&&s.scrollIntoView({block:'nearest'})}
async function openResult(r,keep){
  if(!r)return;
  if(r.ai){if(r.ai==='expand')findExpand();else findPick();$('#palIn').focus();return}
  if(!keep)closePalette();
  if(!PAL.marked){PAL.marked=true;markBack()}   // one Back per search, however many results it opens
  if(!conv||conv.id!==r.cid)await openConv(r.cid);
  if(!conv||conv.id!==r.cid)return;
  const terms=hitTerms(r);
  if(r.k==='d'){await goToPage(r.p||1);setTimeout(()=>{const el=paneEls.get('doc');if(!el)return;
    const root=el.querySelector(`.dpage[data-page="${r.p||1}"]`)||el.querySelector('.pb');showHit(root,el.querySelector('.pb'),terms,1,null,r.x)},450);return}
  if(r.k==='ct'||r.jump){if(conv.ui.view==='canvas')focusCard(conv.doc?'doc':'main');else revealPane('main');return}
  const tid=r.tid;if(!T(tid)){toast('That part of the conversation no longer exists.');return}
  if(conv.ui.view==='canvas'){focusCard(tid,r.mid);if(r.mid)setTimeout(()=>{const n=$('#cv').querySelector(`.cnode[data-ctid="${tid}"]`);if(!n)return;
    showHit(n.querySelector(`.cfull .msg[data-mid="${r.mid}"] .body`),n.querySelector('.cfull'),terms,contentScale(n),null,r.x)},350);return}
  if(r.k==='h'){openThread(tid);revealAnchor(tid);return}
  openThread(tid);conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!==tid);layout();revealPane(tid);
  if(r.mid)requestAnimationFrame(()=>{const pe=paneEls.get(tid);const b=pe&&pe.querySelector(`.msg[data-mid="${r.mid}"] .body`);
    if(b&&showHit(b,pe.querySelector('.pb'),terms,1,()=>rememberSpot(pe),r.x))return;revealMsg(tid,r.mid)});
}
/* ---------- landing on the words a search found ----------
   The matched words are painted with the CSS Highlight API (no DOM changes, so anchors are untouched) and
   the pane scrolls to the place where most of them sit close together. Without the API it still scrolls. */
function hitTerms(r){return matchTerms(r,r.q||PAL.q)}
let hitTimer=0,hitSticky=false;
function clearHit(){clearTimeout(hitTimer);hitTimer=0;hitSticky=false;try{CSS.highlights.delete('digress-hit')}catch(e){}}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&hitSticky)clearHit()});
// where a passage (plain text from the index) sits in the rendered text: find a run of its words
// (from its start, middle or end, since math and diagrams render differently); null if none matches
function passageAt(low,near){
  const ws=qWords(near);if(ws.length<4)return null;
  for(const at of [0,Math.floor(ws.length/2)-3,ws.length-6]){
    const run=ws.slice(Math.max(0,at),Math.max(0,at)+6);if(run.length<4)continue;
    const re=new RegExp(WB+run.map(reEsc).join('[^\\p{L}\\p{N}]+'),'gu'),ms=[...low.matchAll(re)];
    const m=ms.length===1&&ms[0];   // only a run that occurs once says where the passage is
    if(m){const before=near.length*Math.max(0,at)/ws.length;return [Math.max(0,m.index-before-40),m.index-before+near.length*1.3+80]}
  }
  return null;
}
function showHit(root,scroller,terms,scale,before,near){
  if(!root||!scroller||!terms.length)return false;
  const nodes=[],w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('.acts,button,mjx-container,svg')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
  let text='',n;while((n=w.nextNode())){nodes.push([n,text.length]);text+=n.data}
  // search within the result's passage when it can be found (so a word that's also earlier in the message
  // doesn't win); else the whole text
  const low=text.toLowerCase(),reg=near&&passageAt(low,near.toLowerCase()),a=reg?Math.floor(reg[0]):0;
  let sp=bestSpot(reg?low.slice(a,Math.ceil(reg[1])):low,terms,PAL.q);
  if(reg&&sp.hits.length){sp.hits=sp.hits.map(h=>[h[0]+a,h[1]+a,h[2]]);sp.from+=a;sp.to+=a}
  if(reg&&!sp.phrase){const whole=bestSpot(low,terms,PAL.q);if(whole.phrase||!sp.hits.length)sp=whole}   // the typed phrase anywhere beats a loose match in the passage
  const hits=sp.hits;   // the typed phrase, else the closest cluster
  if(!hits.length)return false;
  const at=o=>{let lo=0,hi=nodes.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(nodes[mid][1]<=o)lo=mid;else hi=mid-1}return [nodes[lo][0],o-nodes[lo][1]]};
  const ranges=[];for(let j=0;j<hits.length;j++){if(hits[j][0]<sp.from||hits[j][0]>=sp.to)continue;
    const r=document.createRange(),[a,ao]=at(hits[j][0]),[b,bo]=at(hits[j][1]-1);r.setStart(a,ao);r.setEnd(b,bo+1);ranges.push(r)}
  before&&before();
  const rr=ranges[0].getBoundingClientRect(),sr=scroller.getBoundingClientRect();
  scroller.scrollBy({top:(rr.top-sr.top-sr.height/3)/scale,behavior:'smooth'});
  clearHit();try{CSS.highlights.set('digress-hit',new Highlight(...ranges))}catch(e){}
  hitTimer=setTimeout(clearHit,6000);
  return true;
}
/* ---------- Back: to where you were before a search (or a pinned branch) took you somewhere ---------- */
const BACK=[];
function markBack(){
  if(!conv)return;
  const scroll={};for(const [tid,el] of paneEls){const pb=el.querySelector('.pb');if(pb)scroll[tid]=pb.scrollTop}
  BACK.push({cid:conv.id,view:conv.ui.view,layout:conv.ui.layout,open:[...conv.ui.open],collapsed:[...conv.ui.collapsed],scroll,
    panesLeft:$('#panes').scrollLeft,panesTop:$('#panes').scrollTop,cam:{...cam},cvOpen:[...((conv.ui.cv||{}).open||[])]});
  if(BACK.length>10)BACK.shift();renderBack();
}
function renderBack(){
  const b=$('#backChip');while(BACK.length&&!(conv&&conv.id===BACK.at(-1).cid)&&!convList.some(c=>c.id===BACK.at(-1).cid))BACK.pop();
  if(!BACK.length){b.classList.remove('show');return}
  const s=BACK.at(-1),title=(conv&&conv.id===s.cid?conv.title:(convList.find(c=>c.id===s.cid)||{}).title)||'New conversation';
  b.querySelector('.bt').textContent=conv&&conv.id===s.cid?'Back to where you were':'Back to “'+trunc(title,40)+'”';
  b.title='Go back to where you were before the search'+(conv&&conv.id===s.cid?'':' (in “'+title+'”)');b.classList.add('show');
}
async function goBack(){
  const s=BACK.pop();renderBack();if(!s)return;clearHit();
  if(!conv||conv.id!==s.cid){await openConv(s.cid);if(!conv||conv.id!==s.cid)return}
  const ok=id=>id==='doc'?!!conv.doc:!!T(id);
  const open=s.open.filter(ok);if(open.length){conv.ui.open=open;conv.ui.collapsed=s.collapsed.filter(ok)}
  if(conv.ui.cv&&s.cvOpen)conv.ui.cv.open=s.cvOpen.filter(ok);
  if(s.view==='canvas'){if(conv.ui.view!=='canvas')setView('canvas');else renderCanvas();Object.assign(cam,s.cam);applyCam()}
  else{if(conv.ui.view==='canvas'||conv.ui.layout!==s.layout)setView(s.layout);else layout()}
  renderMap();save();
  const put=()=>{for(const [tid,top] of Object.entries(s.scroll)){const el=paneEls.get(tid),pb=el&&el.querySelector('.pb');if(pb)pb.scrollTop=top}$('#panes').scrollLeft=s.panesLeft;$('#panes').scrollTop=s.panesTop;wiresSoon()};
  requestAnimationFrame(put);setTimeout(put,300);   // again once the document's pages have their sizes
}
(()=>{
  const inp=$('#palIn');
  inp.addEventListener('input',()=>{clearTimeout(PAL.timer);PAL.timer=setTimeout(()=>{PAL.timer=0;runSearch()},90)});
  inp.addEventListener('keydown',e=>{
    if(e.key==='Tab'&&conv){e.preventDefault();const o=['all','conv','thread'],i=o.indexOf(PAL.scope);setScope(o[(i+(e.shiftKey?2:1))%3]);return}
    if(e.key==='ArrowDown'){e.preventDefault();PAL.sel=Math.min(PAL.results.length-1,PAL.sel+1);markSel()}
    else if(e.key==='ArrowUp'){e.preventDefault();PAL.sel=Math.max(0,PAL.sel-1);markSel()}
    else if(e.key==='Enter'){e.preventDefault();const keep=e.metaKey||e.ctrlKey;
      // results for what's typed may still be on their way (debounce, index loading, a redraw): wait for them
      (async()=>{if(PAL.timer||PAL.q!==inp.value.trim()){clearTimeout(PAL.timer);PAL.timer=0;await runSearch()}else await PAL.running;
        openResult(PAL.results[PAL.sel],keep);if(keep)inp.focus()})()}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePalette()}
  });
  $('#palScope').addEventListener('mousedown',e=>e.preventDefault());   // keep the caret in the box
  $('#palScope').addEventListener('click',e=>{const b=e.target.closest('[data-pscope]');if(b)setScope(b.dataset.pscope)});
  $('#palRes').addEventListener('mousemove',e=>{const r=e.target.closest('.pr');if(r&&+r.dataset.i!==PAL.sel){PAL.sel=+r.dataset.i;markSel()}});
  $('#palRes').addEventListener('click',e=>{const r=e.target.closest('.pr');if(r){const keep=e.metaKey||e.ctrlKey;openResult(PAL.results[+r.dataset.i],keep);if(keep)inp.focus()}});
  $('#pal').addEventListener('mousedown',e=>{if(e.target.id==='pal')closePalette()});
  const sb=$('#sboxIn');
  sb.addEventListener('focus',()=>{const v=sb.value;sb.value='';sb.blur();openPalette(v)});
  // ⌘B / Ctrl+B: show or hide the sidebar (as in VS Code), from anywhere, even while typing
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key==='.'){e.preventDefault();setZen(!zen)}},true);
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='b'){e.preventDefault();$('#tSide').click()}});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='k'){e.preventDefault();if($('#pal').classList.contains('show'))closePalette();else openPalette('')}},true);
  // ⌘' / Ctrl+': the canvas, or back to the panes (Columns or Rows, whichever you had); with Shift: Columns ⇄ Rows.
  // e.code, so it's the same key with or without Shift on any layout. Works while typing, like the others.
  document.addEventListener('keydown',e=>{if(!conv||!(e.metaKey||e.ctrlKey)||e.altKey||(e.code!=='Quote'&&e.key!=="'"))return;e.preventDefault();
    if(e.shiftKey)setView(conv.ui.layout==='rows'?'cols':'rows');else setView(conv.ui.view==='canvas'?conv.ui.layout:'canvas')},true);
  // ⌘\ / Ctrl+\: collapse the current pane to a strip, or expand it (on the canvas: shrink or expand the selected
  // card); with Shift: close it. See curPane.
  document.addEventListener('keydown',e=>{if(!conv||!(e.metaKey||e.ctrlKey)||e.altKey||(e.code!=='Backslash'&&e.key!=='\\'))return;e.preventDefault();
    if(conv.ui.view==='canvas'){const sel=cvState().sel,b=!e.shiftKey&&sel&&$(`#cv .cnode[data-ctid="${sel}"] [data-cact=exp]`);if(b)b.click();return}
    const tid=curPane();if(!tid)return;
    if(e.shiftKey)keyClose(tid);else{toggleCollapse(tid);markCur()}},true);
  const mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);
  document.querySelectorAll('.kmod').forEach(k=>k.textContent=mac?'⌘':'Ctrl+');
  document.querySelectorAll('.kshift').forEach(k=>k.textContent=mac?'⇧':'Shift+');
  document.querySelectorAll('.kalt').forEach(k=>k.textContent=mac?'⌥':'Alt+');
})();

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

/* ---------- sidebar ---------- */
function renderTitle(){const el=$('#cTitle');if(document.activeElement!==el)el.textContent=conv.title||'New conversation';updateHeader('main');tabName()}
// the branch count in a pane's header opens a list of those branches (the sidebar's tree from that pane down)
function brCount(tid,nb,always){const l=`${nb} branch${nb===1?'':'es'}`;return nb||always?`<button type="button" class="bcount" data-brlist="${esc(tid)}" title="${tid==='doc'?'See the branches off the document, and the main thread':'See the branches off this'}">${l}</button>`:l}
let brPop=null;   // {tid, el, btn}
function closeBrList(){if(!brPop)return;brPop.el.remove();brPop.btn&&brPop.btn.classList.remove('on');brPop=null}
function fillBrList(){
  if(!brPop)return;const {tid,el}=brPop;
  if(!conv||brPop.conv!==conv.id||(tid!=='doc'&&!T(tid))||(tid==='doc'&&!conv.doc)){closeBrList();return}
  const kids=tid==='doc'?docBranches().filter(b=>!hiddenNow(b.id)):kidsOf(tid);
  if(!kids.length&&tid!=='doc'){closeBrList();return}
  const n=tid==='doc'?kids.reduce((n,b)=>n+1+descendants(b.id).length,0):descendants(tid).length;
  const h=document.createElement('div');h.className='brhead';h.textContent=`${n} branch${n===1?'':'es'} off ${tid==='doc'?'the document':tid==='main'?'the main thread':'“'+trunc(T(tid).title,40)+'”'}`;
  const ul=document.createElement('ul');ul.className='brtop';kids.forEach(c=>ul.appendChild(mapNode(c.id,{lite:true})));
  // the document's list starts with the main thread (the chat about the whole document): the other head of the
  // conversation, one tap from the document even when its pane is closed. Just its row, not its branches.
  const top=[];if(tid==='doc'){const li=mapNode('main',{lite:true}),sub=li.querySelector(':scope>ul');if(sub)sub.remove();li.firstChild.title='Open the main thread: the chat about the whole document';
    const m=document.createElement('ul');m.className='brtop brmain';m.appendChild(li);top.push(m)}
  el.replaceChildren(...top,h,...(kids.length?[ul]:[]));placeBrList();
}
function placeBrList(){
  if(!brPop)return;const {el}=brPop;
  if(!brPop.btn.isConnected){   // the header was redrawn (a save, a reply): follow its new button
    const pe=paneEls.get(brPop.tid),nb=pe&&pe.querySelector(`.ph-origin [data-brlist="${CSS.escape(brPop.tid)}"]`);if(!nb){closeBrList();return}
    brPop.btn=nb;nb.classList.add('on')}
  const btn=brPop.btn;
  const r=btn.getBoundingClientRect(),w=Math.min(360,innerWidth-16);el.style.width=w+'px';
  el.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
  const below=innerHeight-r.bottom-12,above=r.top-12,up=below<220&&above>below;
  el.style.maxHeight=Math.max(120,Math.min(innerHeight*.6,up?above:below))+'px';
  el.style.top=up?'':(r.bottom+6)+'px';el.style.bottom=up?(innerHeight-r.top+6)+'px':'';
}
function toggleBrList(tid,btn){
  const same=brPop&&brPop.tid===tid&&brPop.btn===btn;closeBrList();if(same)return;
  const el=document.createElement('div');el.className='brpop tree';el.setAttribute('role','dialog');
  document.body.appendChild(el);brPop={tid,el,btn,conv:conv.id};btn.classList.add('on');fillBrList();
}
addEventListener('resize',()=>placeBrList());
document.addEventListener('scroll',e=>{if(brPop&&!brPop.el.contains(e.target))placeBrList()},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&brPop){closeBrList();e.stopPropagation();e.preventDefault()}},true);
// one row of the branch tree (and its subtree): the sidebar's, or with o.lite the header's branch list (no fold, no row buttons)
function mapNode(tid,o){
  const fold=o.lite?[]:o.fold,chev=o.lite?()=>'':o.chev,hiddenBadge=o.lite?()=>'':o.hiddenBadge,build=id=>mapNode(id,o);
  const t=T(tid),li=document.createElement('li');
  const n=document.createElement('div');n.className='mnode'+(conv.ui.open.includes(tid)&&!isCollapsed(tid)?' open':'')+(t.resolved?' res':'');n.dataset.map=tid;n.style.setProperty('--c',tid==='main'?'var(--faint)':color(t));
  const cnt=(conv.order[tid]||[]).filter(id=>conv.msgs[id]&&conv.msgs[id].role==='user').length;
  const kids=kidsOf(tid);
  n.innerHTML=`${chev(tid,kids)}${tid==='main'?'<span class="dot"></span>':statusDot(t)}<div style="min-width:0;flex:1"><div class="mt"></div>${t.anchorText?'<div class="ma"></div>':''}</div>${hiddenBadge(tid)}<span class="mc" title="Questions asked in this thread">${cnt||''}</span>${t.pinned?`<span class="mpin" title="Pinned">${ic('pin')}</span>`:''}${tid==='main'||o.lite?'':`<span class="macts"><button class="ib mp${t.pinned?' pinned':''}" data-pinthread="${esc(tid)}" title="${t.pinned?'Unpin this branch':'Pin this branch to the top of the sidebar'}">${ic('pin')}</button><button class="ib mh" data-hideb="${esc(tid)}" title="${t.hidden?'Show this branch in the tree again':'Hide this branch (and what’s under it) from the tree and canvas; nothing is deleted'}">${ic(t.hidden?'eye':'eyeoff')}</button><button class="ib dz mx" data-delb="${esc(tid)}" title="Delete this branch and everything branched from it">${ic('trash')}</button></span>`}`;
  if(t.hidden)n.classList.add('hiddenb');
  n.title=tid==='main'?'Show the main thread':`Open “${t.title}”`+(t.anchorText?`, from “${trunc(t.anchorText,240)}”`:'');
  n.querySelector('.mt').textContent=tid==='main'?'Main thread':t.title;
  if(t.anchorText)n.querySelector('.ma').textContent=(isDocBranch(t)&&conv.doc.kind==='pdf'?`${docPagesLabel(t)} · `:'')+'“'+trunc(t.anchorText,60)+'”';
  li.appendChild(n);
  if(kids.length&&!fold.includes(tid)){const ul=document.createElement('ul');kids.forEach(c=>ul.appendChild(build(c.id)));li.appendChild(ul)}
  return li;
}
function renderMap(){
  const tree=$('#tree');
  const fold=conv.ui.tfold=(conv.ui.tfold||[]).filter(id=>id==='doc'?conv.doc:conv.threads[id]);
  const chev=(id,kids)=>{
    if(!kids.length)return '<span class="tchev none"></span>';
    const f=fold.includes(id),n=descendants(id).length;
    return `<button class="tchev${f?'':' open'}" data-tfold="${esc(id)}" title="${f?'Show':'Hide'} the ${n} branch${n===1?'':'es'} under this">${ic('back').replace('class="i"','class="i" style="transform:rotate(180deg)"')}</button>`;
  };
  const hiddenBadge=(id)=>{const n=descendants(id).length;return fold.includes(id)&&n?`<span class="hid" title="${n} hidden branch${n===1?'':'es'}">+${n}</span>`:''};
  const build=tid=>mapNode(tid,{fold,chev,hiddenBadge});
  const ul=document.createElement('ul');
  if(conv.doc){
    const li=document.createElement('li'),n=document.createElement('div');
    n.className='mnode'+(conv.ui.open.includes('doc')&&!isCollapsed('doc')?' open':'');n.dataset.mapdoc='1';n.title='Show the document';
    const kids=kidsOf('doc');
    n.innerHTML=`${chev('doc',kids)}<span class="docico">${ic('doc')}</span><div style="min-width:0;flex:1"><div class="mt"></div></div>${hiddenBadge('doc')}`;n.querySelector('.mt').textContent=conv.doc.name;
    li.appendChild(n);if(!fold.includes('doc')){const sub=document.createElement('ul');kids.forEach(c=>sub.appendChild(build(c.id)));li.appendChild(sub)}ul.appendChild(li);
  }else ul.appendChild(build('main'));
  tree.replaceChildren(ul);fillBrList();markReplies();
  const nh=Object.values(conv.threads).filter(t=>t.hidden).length;
  if(nh){const b=document.createElement('button');b.className='showhid';b.dataset.showhid='1';b.textContent=conv.ui.showHidden?'Hide the hidden branches again':`Show ${nh} hidden branch${nh>1?'es':''}`;tree.appendChild(b)}
  const any=fold.length>0,ta=$('#treeAll'),has=Object.keys(conv.threads).length>1;
  ta.style.visibility=has?'':'hidden';ta.textContent=any?'Expand all':'Collapse all';
  ta.title=any?'Show every branch':'Collapse every thread to its top level, so the tree is easier to scan';
}
function toggleTreeFold(id){const f=conv.ui.tfold||[];conv.ui.tfold=f.includes(id)?f.filter(x=>x!==id):[...f,id];renderMap();save()}
function treeAll(){
  if((conv.ui.tfold||[]).length){conv.ui.tfold=[]}
  else{
    // keep the top level visible: fold every thread that has branches, except the root
    const root=conv.doc?'doc':'main';const ids=[root,...descendants(root)];
    conv.ui.tfold=ids.filter(id=>id!==root&&kidsOf(id).length);
    if(!conv.ui.tfold.length&&kidsOf(root).length)conv.ui.tfold=[root];
  }
  renderMap();save();
}
function metaOf(c){
  return {dropCards:!!c.dropCards,id:c.id,title:c.title,updated:c.updated,created:c.created,pinned:!!c.pinned,archived:!!c.archived,trashed:c.trashed||0,folder:c.folder||'',system:typeof c.system==='string'?c.system:'',doc:!!c.doc,docName:c.doc?c.doc.name||'':'',asset:(c.doc&&c.doc.assetId)||'',
    pins:Object.values(c.threads||{}).filter(t=>t.pinned).map(t=>({tid:t.id,title:t.title,ci:t.colorIdx}))};
}
let convFilt='all';try{convFilt=localStorage.getItem('digress:cfilt')||'all'}catch(e){}
let archOpen=false;try{archOpen=localStorage.getItem('sq:arch')==='1'}catch(e){}
let convListSig='';
function renderConvList(){
  if(convRenaming){convRenaming.later=true;return}   // don't rebuild the row being renamed out from under the reader
  const items=convList.map(c=>conv&&c.id===conv.id?metaOf(conv):c);
  if(conv&&!items.find(c=>c.id===conv.id))items.unshift(metaOf(conv));
  // every save lands here; rebuild only when something shown changed, so rows don't vanish from under the pointer
  // All · Docs · Chats: only once there's a document conversation to tell apart (pinned ones always show)
  const anyDoc=items.some(c=>c.doc),filt=anyDoc?convFilt:'all';
  const fb=$('#cFilt');fb.classList.toggle('show',anyDoc);fb.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.cf===filt));
  const shown=c=>filt==='all'||(filt==='doc')===!!c.doc||(conv&&c.id===conv.id);   // the open one always shows
  // flashcards per conversation: a badge (due count) and, on hover, a button that opens just its cards
  const kc={},now=Date.now();for(const k of CARDS.values()){if(k.status==='suspended')continue;const e=kc[k.conv]||(kc[k.conv]={n:0,due:0,inbox:0});e.n++;if(inInbox(k))e.inbox++;else if((k.due||0)<=now&&!k.fix)e.due++}
  const sig=JSON.stringify([conv&&conv.id,archOpen,trashOpen,filt,kc,new Date().toDateString(),items.map(c=>[c.id,c.title,c.pinned,c.archived,c.trashed,c.dropCards,c.doc,c.pins,c.folder]),[...folderFolded]]);
  if(sig===convListSig&&$('#clist').childElementCount+$('#plist').childElementCount+$('#flist').childElementCount+$('#alist').childElementCount+$('#xlist').childElementCount)return;
  // two conversations with the same name (say, two on one document) are told apart by the day they started
  const names={};for(const c of items)if(!c.trashed){const n=c.title||'New conversation';names[n]=(names[n]||0)+1}
  convListSig=sig;
  const row=(c,extra)=>{
    const d=document.createElement('div');d.className='citem'+(conv&&c.id===conv.id?' cur':'');d.dataset.conv=c.id;
    const k=kc[c.id],kt=k&&`Flashcards from this conversation: ${k.due?k.due+' due':'none due'}${k.inbox?`, ${k.inbox} in the inbox`:''}`;
    d.innerHTML=`${c.doc?`<span class="docico" style="color:var(--faint)">${ic('doc').replace('class="i"','class="i" style="width:13px;height:13px"')}</span>`:''}<span class="t"></span>${extra||''}`+
      (k?`<span class="cbadge${k.due?' due':''}" title="${esc(kt)}">${ic('cards')}${k.due||''}</span>`:'')+`<span class="acts">`+
      (k?`<button class="ib${k.due?' kdue':''}" data-cardsconv="${esc(c.id)}" title="${esc(kt+'. Click to review them.')}">${ic('cards')}</button>`:'')+
      (c.archived?'':`<button class="ib${c.pinned?' pinned':''}" data-pinconv="${esc(c.id)}" title="${c.pinned?'Unpin':'Pin to the top of the sidebar'}">${ic('pin')}</button>`)+
      (c.archived||(conv&&c.id===conv.id&&isBlank(conv))?'':`<button class="ib" data-folderconv="${esc(c.id)}" title="${esc(c.folder?`Move to…: in “${c.folder}” now; another folder, out of it, or the archive`:'Move to…: a folder, a new one, or the archive')}">${ic('folder')}</button>`)+
      `<button class="ib" data-expconv="${esc(c.id)}" title="Export: a .digress file to share or keep, Markdown, or flashcards for Anki">${ic('download')}</button>`+
      (c.archived?`<button class="ib" data-archconv="${esc(c.id)}" title="Move back to your conversations">${ic('archive')}</button>`:'')+
      `<button class="ib dz" data-del="${esc(c.id)}" title="Move to the trash (deleted for good after ${TRASH_DAYS} days; restore it from Trash before then)">${ic('trash')}</button></span>`;
    const tt=d.querySelector('.t');tt.textContent=c.title||'New conversation';d.dataset.tip=tt.textContent;d.dataset.clip='';
    const ft=d.querySelector('.ftag');if(ft){ft.textContent=c.folder;ft.title='In the folder “'+c.folder+'”';d.dataset.tip+=' · in '+c.folder}
    if(names[tt.textContent]>1&&c.created){const sm=document.createElement('small');sm.className='cday';sm.textContent=' · '+dayLabel(c.created);tt.appendChild(sm);d.dataset.tip+=' · started '+dayLabel(c.created)}
    return d;
  };
  const trash=items.filter(c=>c.trashed).sort((a,b)=>b.trashed-a.trashed),active=items.filter(c=>!c.archived&&!c.trashed),arch=items.filter(c=>c.archived&&!c.trashed);
  // pinned: whole conversations, each with its own pinned branches under it (indented, no conversation name),
  // then the pinned branches of conversations that aren't pinned themselves
  const pl=$('#plist');pl.replaceChildren();
  const pinRow=(c,b,under)=>{
    const d=document.createElement('div');d.className='citem pb'+(under?' psub':'');d.dataset.pinb=c.id+'|'+b.tid;d.style.setProperty('--c',PALETTE[(b.ci||0)%PALETTE.length]);
    d.innerHTML=`<span class="bd"></span><span class="t"></span><span class="acts"><button class="ib pinned" data-unpinb="${esc(c.id+'|'+b.tid)}" title="Unpin this branch">${ic('pin')}</button></span>`;
    const tt=d.querySelector('.t');tt.textContent=b.title+(under?'':' ');
    if(!under){const sm=document.createElement('small');sm.textContent='· '+(c.title||'');tt.appendChild(sm)}
    d.dataset.tip=b.title+' · '+(c.title||'');d.dataset.clip='';
    return d;
  };
  for(const c of active.filter(c=>c.pinned)){pl.appendChild(row(c,`<span class="pmark" title="Pinned">${ic('pin')}</span>`));for(const b of (c.pins||[]))pl.appendChild(pinRow(c,b,true))}
  for(const c of active.filter(c=>!c.pinned))for(const b of (c.pins||[]))pl.appendChild(pinRow(c,b,false));
  $('#pinWrap').style.display=pl.children.length?'':'none';
  // folders: every conversation filed in one (pinned ones too: a folder shows all of its own), by name
  const fl=$('#flist');fl.replaceChildren();const byF=new Map();
  for(const c of active)if(c.folder&&shown(c)){if(!byF.has(c.folder))byF.set(c.folder,[]);byF.get(c.folder).push(c)}
  for(const name of folderNames(active)){const cs=byF.get(name);if(!cs)continue;
    const g=document.createElement('div');g.className='fgrp'+(folderFolded.has(name)?' ffolded':'');g.dataset.folder=name;
    g.innerHTML=`<div class="citem fhd" data-ftog title="Fold or unfold this folder"><span class="chev">${$('#archToggle .chev').innerHTML}</span><span class="fic">${ic('folder')}</span><span class="t"></span>${folderPrompt(name)?`<span class="fpmark" title="New chats here start with this folder’s own prompt">${ic('tune')}</span>`:''}<span class="fcount">${cs.length}</span><span class="acts"><button class="ib" data-fchat title="New chat in this folder${folderPrompt(name)?', starting with its prompt':''}">${ic('plus')}</button><button class="ib${folderPrompt(name)?' on':''}" data-fprompt title="${folderPrompt(name)?'Edit the prompt new chats here start with':'Give new chats in this folder a prompt of their own to start with'}">${ic('tune')}</button><button class="ib" data-fren title="Rename this folder">${ic('edit')}</button><button class="ib dz" data-fdrop title="Remove this folder: its conversations go back to the list (nothing is deleted)">${ic('x')}</button></span></div><div class="fbody"></div>`;
    g.querySelector('.t').textContent=name;g.querySelector('.fhd').setAttribute('aria-expanded',String(!folderFolded.has(name)));
    const body=g.querySelector('.fbody');for(const c of cs)body.appendChild(row(c,c.pinned?`<span class="pmark" title="Pinned">${ic('pin')}</span>`:''));
    fl.appendChild(g);
  }
  const el=$('#clist');el.replaceChildren();
  for(const c of active.filter(c=>!c.pinned&&shown(c)))el.appendChild(row(c,c.folder?'<span class="ftag"></span>':''));
  // the list scrolls inside itself: when another conversation opens, bring its row into view there (only the list moves)
  if(conv&&listCur!==conv.id){listCur=conv.id;requestAnimationFrame(()=>{for(const l of [el,pl,fl]){const r=l.querySelector('.citem.cur');if(r&&(r.offsetTop<l.scrollTop||r.offsetTop+r.offsetHeight>l.scrollTop+l.clientHeight))l.scrollTop=r.offsetTop-l.clientHeight/3}})}
  if(!el.children.length)el.innerHTML=`<div class="citem" style="cursor:default;color:var(--faint)">${filt==='doc'?'No document conversations':filt==='chat'?'No chats without a document':'No other conversations'}</div>`;
  const al=$('#alist');al.replaceChildren();arch.filter(shown).forEach(c=>al.appendChild(row(c)));
  $('#archWrap').style.display=arch.length?'':'none';$('#archLbl').textContent=`Archive · ${arch.length}`;
  $('#archToggle').classList.toggle('open',archOpen);al.classList.toggle('show',archOpen);
  // the trash: restore, or delete for good now; on its own after TRASH_DAYS
  const xl=$('#xlist');xl.replaceChildren();
  for(const c of trash){
    const d=document.createElement('div');d.className='citem'+(conv&&c.id===conv.id?' cur':'');d.dataset.conv=c.id;
    const left=trashLeft(c),when=left<=1?'goes today':`${left} days left`;
    d.innerHTML=`<span class="t"></span><span class="xleft">${when}</span><span class="acts"><button class="ib" data-restore="${esc(c.id)}" title="Restore: move back to your conversations">${ic('back')}</button><button class="ib dz" data-delnow="${esc(c.id)}" title="Delete for good now">${ic('trash')}</button></span>`;
    d.querySelector('.t').textContent=c.title||'New conversation';const df=docFate(c.id);d.dataset.tip=(c.title||'New conversation')+` · in the trash, deleted for good ${left<=1?'today':'in '+left+' days'}`+(df&&!df.shared?`, with its document “${df.name}”`:'')+(c.dropCards?`, and its flashcards`:'');d.dataset.clip='';
    xl.appendChild(d);
  }
  $('#trashWrap').style.display=trash.length?'':'none';$('#trashLbl').textContent=`Trash · ${trash.length}`;
  $('#trashToggle').classList.toggle('open',trashOpen);xl.classList.toggle('show',trashOpen);
}
var listCur=null;   // var: renderConvList may run before this line
/* Folders: conv.folder is a name (one per conversation, no nesting). A folder exists while something is in it,
   archived and trashed ones included (restoring one puts it back where it was). Which folders are folded is per device. */
var folderFolded=new Set();try{folderFolded=new Set(JSON.parse(localStorage.getItem('digress:ffold')||'[]'))}catch(e){}
const folderNames=(items)=>[...new Set(items.filter(c=>c.folder&&!c.trashed).map(c=>c.folder))].sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base',numeric:true}));
// the folders the sidebar shows (one whose conversations are all archived isn't offered); a name that differs only in case is the same folder
const shownFolders=()=>folderNames(allConvMeta().filter(c=>!c.archived));
const sameFolder=(f,except)=>f&&folderNames(allConvMeta()).find(n=>n!==except&&n.toLowerCase()===f.toLowerCase())||f;
const allConvMeta=()=>{const items=convList.map(c=>conv&&c.id===conv.id?metaOf(conv):c);if(conv&&!isBlank(conv)&&!items.find(c=>c.id===conv.id))items.unshift(metaOf(conv));return items};
function toggleFolder(name){folderFolded.has(name)?folderFolded.delete(name):folderFolded.add(name);try{localStorage.setItem('digress:ffold',JSON.stringify([...folderFolded]))}catch(e){}renderConvList()}
const cleanFolder=(n)=>String(n||'').replace(/\s+/g,' ').trim().slice(0,60);
async function setFolder(id,name){const f=sameFolder(cleanFolder(name));await setConvFlag(id,{folder:f});
  if(f&&folderFolded.has(f))toggleFolder(f);   // filing into a folded one opens it, so you see where it went
  setStatus(f?`Moved to “${f}”`:'Taken out of its folder');if(f)offerFolderPrompt(f,[id])}
// rename or remove a folder: every conversation in it (archived and trashed too, so none is left behind in the old name)
/* A folder's prompt (CUSTOM.prompts.folders: {name: text}) is where its new chats start: a new chat in the folder gets
   a copy as its own system prompt (conv.system). Nothing follows it after that: editing it changes no conversation, and
   one moved in is asked whether to switch (kept as it is unless the reader says so). */
const folderPrompts=()=>((CUSTOM.prompts&&CUSTOM.prompts.folders)||{});
const folderPrompt=(f)=>{const m=folderPrompts(),k=f&&Object.keys(m).find(n=>n.toLowerCase()===f.toLowerCase());return k?m[k]:''};
async function setFolderPrompt(f,v,from){const m={...folderPrompts()};
  for(const k of Object.keys(m))if(k.toLowerCase()===f.toLowerCase()||(from&&k.toLowerCase()===from.toLowerCase()))delete m[k];
  v=String(v||'').trim();if(v)m[f]=v;await savePrompts({folders:Object.keys(m).length?m:null})}
const convSys=(id)=>{const c=conv&&conv.id===id?conv:convList.find(x=>x.id===id);return ((c&&typeof c.system==='string'&&c.system.trim())||defaultSys()).trim()};
// conversations just moved into a folder with a prompt: switch to it? Keeping theirs is the default (Cancel, Esc)
function offerFolderPrompt(f,ids){const p=folderPrompt(f).trim();if(!p)return;
  const differ=ids.filter(id=>convSys(id)!==p);if(!differ.length)return;
  const n=differ.length,one=n===1;
  askConfirm('Use the folder’s prompt?',`<p class="ppnote"><b>${esc(f)}</b> has its own system prompt for new chats. ${one?'This conversation has a different one':`${n} of these conversations have a different one`}. Switch ${one?'it':'them'} to the folder’s from the next reply, or keep what ${one?'it has':'they have'}?</p><details class="fpview"><summary>The folder’s prompt</summary><pre></pre></details>`,
    async()=>{for(const id of differ){if(conv&&conv.id===id){setConvSystem(p);continue}await setConvFlag(id,{system:p===defaultSys().trim()?'':p})}
      setStatus(one?'It uses the folder’s prompt now':`${n} conversations use the folder’s prompt now`)},
    {ok:'Use the folder’s',cancel:one?'Keep its own':'Keep their own',kind:'primary'});
  $('#mBody .fpview pre').textContent=p}
function editFolderPrompt(f){const cur=folderPrompt(f);
  askConfirm(`Prompt for new chats in “${f}”`,`<p class="ppnote">A new chat started in this folder begins with this as its system prompt (it becomes that chat’s own, so you can still change it there). Conversations already in the folder keep theirs. Leave it empty to start new chats with your default.</p><textarea class="pptext" id="fSysEd" rows="10" spellcheck="false"></textarea>`,
    async()=>{const v=$('#fSysEd').value.trim();try{await setFolderPrompt(f,v)}catch(e){toast(e.message||'It couldn’t be saved.');return}convListSig='';renderConvList();setStatus(v?'Folder prompt saved':'New chats here start with your default')},
    {ok:'Save',kind:'primary'});
  const ta=$('#fSysEd');ta.value=cur;ta.placeholder=defaultSys();setTimeout(()=>ta.focus(),30)}
async function newChatIn(f){if(!await leaveOk())return;BACK.length=0;renderBack();
  const c=newConv();c.folder=f;const p=folderPrompt(f).trim();if(p&&p!==defaultSys().trim())c.system=p;
  if(folderFolded.has(f)){folderFolded.delete(f);try{localStorage.setItem('digress:ffold',JSON.stringify([...folderFolded]))}catch(e){}}
  setConv(c);if(!isBlank(c))save();   // with a prompt of its own it's kept from the start, like one given a prompt by hand
  if(innerWidth<760)$('#app').classList.remove('sideopen');
  setTimeout(()=>{if(!$('#pal').classList.contains('show'))paneEls.get('main').querySelector('textarea').focus()},30)}
async function refileFolder(from,to){const ids=allConvMeta().filter(c=>c.folder===from).map(c=>c.id);
  const fp=folderPrompt(from);if(fp||to)try{if(to){if(fp&&!folderPrompt(to))await setFolderPrompt(to,fp,from);else if(fp)await setFolderPrompt(from,'')}else if(fp)await setFolderPrompt(from,'')}catch(e){console.warn(e)}
  const wasFolded=folderFolded.has(from);folderFolded.delete(from);if(to&&wasFolded)folderFolded.add(to);try{localStorage.setItem('digress:ffold',JSON.stringify([...folderFolded]))}catch(e){}
  for(const id of ids)await setConvFlag(id,{folder:to||''});return ids.length}
function renameFolder(g){const name=g.dataset.folder,hd=g.querySelector('.fhd'),t=hd.querySelector('.t');
  const inp=document.createElement('input');inp.className='fren';inp.value=name;inp.setAttribute('aria-label','Folder name');t.replaceWith(inp);inp.focus();inp.select();
  convRenaming={later:false};let done=false;
  const end=async(ok)=>{if(done)return;done=true;const later=convRenaming&&convRenaming.later;convRenaming=null;const to=cleanFolder(inp.value);
    const into=sameFolder(to,name);   // renamed onto another folder's name, in any case: the two become one
    if(ok&&into&&into!==name){await refileFolder(name,into);setStatus(into===to?`Renamed to “${into}”`:`Joined “${into}”`)}convListSig='';renderConvList()};
  inp.onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();end(true)}else if(e.key==='Escape'){e.preventDefault();end(false)}};
  inp.onblur=()=>end(true);inp.onclick=e=>e.stopPropagation();inp.onpointerdown=e=>e.stopPropagation()}
function dropFolder(name){const n=allConvMeta().filter(c=>c.folder===name&&!c.trashed).length;
  askConfirm('Remove this folder?',`<b>${esc(name)}</b> goes, and its ${n} conversation${n===1?'':'s'} go${n===1?'es':''} back to the list. Nothing is deleted${folderPrompt(name)?'; its prompt for new chats goes, and the conversations keep the prompts they have':''}.`,async()=>{await refileFolder(name,'');setStatus('Folder removed')},{ok:'Remove folder',kind:'primary'})}
// the menu from a row's folder button: the folders there are, a new one, or out of the one it's in
function openFolderMenu(btn,id){
  let menu=$('#folderMenu');if(!menu){menu=document.createElement('div');menu.className='thmenu';menu.id='folderMenu';menu.setAttribute('role','menu');document.body.appendChild(menu);
    document.addEventListener('pointerdown',e=>{if(menu.classList.contains('open')&&!menu.contains(e.target)&&!e.target.closest('[data-folderconv]'))menu.classList.remove('open')},true);
    menu.onclick=(e)=>{const b=e.target.closest('[data-fm]');if(!b)return;const cid=menu.dataset.cid,a=b.dataset.fm;menu.classList.remove('open');
      if(a==='new')newFolderDialog([cid]);else if(a==='out')setFolder(cid,'');else if(a==='arch')archiveConv(cid);else setFolder(cid,a.slice(2))}}
  if(menu.classList.contains('open')&&menu.dataset.cid===id){menu.classList.remove('open');return}
  const items=allConvMeta(),cur=(items.find(c=>c.id===id)||{}).folder||'';menu.dataset.cid=id;
  const names=shownFolders();
  menu.innerHTML=names.map(n=>`<button data-fm="f:${esc(n)}" class="${n===cur?'fmcur':''}" ${n===cur?'aria-current="true"':''}>${ic(n===cur?'check':'folder')}<span></span></button>`).join('')+
    `<button data-fm="new">${ic('plus')}New folder…</button><div class="fmsep"></div>`+(cur?`<button data-fm="out">${ic('x')}Take out of “<span></span>”</button>`:'')+
    `<button data-fm="arch" title="Out of the way, without deleting: it moves to Archive at the bottom of the sidebar">${ic('archive')}Archive</button>`;
  const spans=menu.querySelectorAll('button[data-fm^="f:"] span');names.forEach((n,i)=>spans[i].textContent=n);if(cur)menu.querySelector('[data-fm=out] span').textContent=cur;
  menu.classList.add('open');const r=btn.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,r.left))+'px';
  menu.style.top=(r.bottom+4+menu.offsetHeight<=innerHeight-8?r.bottom+4:Math.max(8,r.top-4-menu.offsetHeight))+'px';
  menu.querySelector('button').focus();
}
function archiveConv(id){const m=convList.find(c=>c.id===id)||(conv.id===id?metaOf(conv):{});const a=!m.archived;setConvFlag(id,a?{archived:true,pinned:false}:{archived:false});setStatus(a?'Archived':'Moved back to conversations')}
/* New folder: a dialog, since a name typed into a menu was too cramped to read. A folder only exists while something is
   in it, so it asks for the name and what goes in (the conversation it was opened from is ticked already). */
function newFolderDialog(pre=[]){
  const items=allConvMeta().filter(c=>!c.trashed&&!c.archived),names=shownFolders(),has=(f)=>names.find(n=>n.toLowerCase()===f.toLowerCase());
  const order=[...items.filter(c=>pre.includes(c.id)),...items.filter(c=>!pre.includes(c.id))];
  askConfirm('New folder',`<input class="nfname" id="nfName" maxlength="60" autocomplete="off" spellcheck="false" placeholder="Name it: Statistics, Side projects…" aria-label="Folder name"><div class="nfhint" id="nfHint"></div>
    <div class="nfsub"><span>Put in it</span><span id="nfCount"></span></div><div class="nflist" id="nfList"></div>`,()=>{},{ok:'Create folder',kind:'primary'});
  const list=$('#nfList');
  for(const c of order){const r=document.createElement('label');r.className='nfrow';r.innerHTML=`<input type="checkbox" value="${esc(c.id)}"${pre.includes(c.id)?' checked':''}><span></span>${c.folder?'<small></small>':''}`;
    r.querySelector('span').textContent=c.title||'New conversation';if(c.folder)r.querySelector('small').textContent=c.folder;list.appendChild(r)}
  if(!order.length)list.innerHTML='<div class="nfrow" style="cursor:default;color:var(--faint)">No conversations yet</div>';
  const nm=$('#nfName'),ok=$('#mOk');
  const picked=()=>[...list.querySelectorAll('input:checked')].map(x=>x.value);
  const upd=()=>{const f=cleanFolder(nm.value),n=picked().length;ok.disabled=!f||!n;
    $('#nfCount').textContent=n?`${n} chosen`:'';
    $('#nfHint').textContent=!f?'':has(f)?`There’s already a folder called “${has(f)}”: these join it.`:!n?'Choose at least one conversation: a folder holds something.':'';
    ok.textContent=f&&has(f)?'Add to folder':'Create folder'};
  nm.oninput=upd;list.onchange=upd;upd();
  nm.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();if(!ok.disabled)ok.click()}};
  modalOk=async()=>{const f=sameFolder(cleanFolder(nm.value)),ids=picked();if(!f||!ids.length)return;
    for(const cid of ids)await setConvFlag(cid,{folder:f});
    if(folderFolded.has(f))toggleFolder(f);if(sideFold.folders){sideFold.folders=false;$('#foldWrap').classList.remove('folded');try{localStorage.setItem('sq:fold',JSON.stringify(sideFold))}catch(e){}}
    setStatus(`${ids.length===1?'Moved':ids.length+' conversations moved'} to “${f}”`);setTimeout(()=>offerFolderPrompt(f,ids),0)};   // after this dialog has closed
  setTimeout(()=>nm.focus(),30);
}
const closeFolderMenu=()=>{const m=$('#folderMenu');if(m&&m.classList.contains('open')){m.classList.remove('open');return true}return false};
const TRASH_DAYS=7;   // server.mjs TRASH_DAYS empties it
const trashLeft=c=>Math.max(1,Math.ceil((c.trashed+TRASH_DAYS*864e5-Date.now())/864e5));
const dayLabel=t=>{const d=new Date(t);return d.toLocaleDateString(undefined,{month:'short',day:'numeric',...(d.getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{})})};
let convListLoaded=false;   // cardSource says nothing until the list is in
let trashOpen=false;try{trashOpen=localStorage.getItem('digress:trash')==='1'}catch(e){}
/* Deleting moves a conversation to the trash (shared: every device sees it there) for TRASH_DAYS; Restore brings it
   back. An empty conversation, or "Delete for good", is deleted at once (deleteConv). Its flashcards stay either way. */
// a conversation with nothing in it yet (no question, no document): never saved, so there's nothing to keep
const isBlank=(c)=>!!c&&!c.doc&&!(c.order.main||[]).length&&Object.keys(c.threads).length===1&&!c.system&&!(c.skills||[]).length;
// after the open conversation goes: the latest other one, else a fresh one
async function openNextAfter(id){dirty=false;const next=convList.find(c=>c.id!==id&&!c.trashed&&!c.archived);if(next)await openConv(next.id);else setConv(newConv())}
// put away an empty new conversation (✕ on its only pane, or Delete): saved, it's deleted; never saved, just dropped
async function discardBlank(){const id=conv.id;if(convList.some(c=>c.id===id)){await deleteConv(id);return}await openNextAfter(id);renderConvList()}
async function trashConv(id,o={}){
  const isOpen=conv&&conv.id===id;
  if(isOpen&&isBlank(conv)){discardBlank();return}
  const cards=[...CARDS.values()].filter(c=>c.conv===id);
  if(cards.length&&o.drop===undefined){
    const m=convInfo(id)||{};
    askConfirm('Move to the trash?',`<b>${esc(m.title||'This conversation')}</b> goes to the trash. Restore it within ${TRASH_DAYS} days and it’s all back; after that it’s deleted for good.`+cardsChoice(cards,'its')+
      `<div class="kdnote">Ticked, its flashcards leave your review now and are deleted with the conversation. Restore it and they’re back, as they were. Unticked, they stay in your review, but once the conversation is deleted they can’t take you back to where they came from.</div>`,
      ()=>trashConv(id,{drop:!!($('#kdDrop')||{}).checked}),{ok:'Move to trash'});
    return;
  }
  if(isOpen)for(const s of [...streaming.values()])stopReply(s);
  const df=docFate(id);   // before another conversation opens
  await setConvFlag(id,{trashed:Date.now(),pinned:false,dropCards:!!o.drop});
  if(o.drop)syncCardsUI();
  if(isOpen){await flushNow();const next=convList.find(c=>c.id!==id&&!c.trashed&&!c.archived);if(next)await openConv(next.id);else{dirty=false;setConv(newConv())}}
  toast(`Moved to the trash. It’s deleted for good in ${TRASH_DAYS} days${df&&!df.shared?`, with its document “${trunc(df.name,40)}”`:''}.`,{label:'Undo',fn:()=>restoreConv(id)});
}
// what deleting this conversation for good does to its document: the name, and whether another conversation
// (in the trash or not) still uses the same file, which then stays
function docFate(id){
  const m=(conv&&conv.id===id)?metaOf(conv):convList.find(c=>c.id===id);if(!m||!m.doc)return null;
  const shared=!!m.asset&&[...convList,...(conv?[metaOf(conv)]:[])].some(c=>c.id!==id&&c.asset===m.asset);
  return {name:m.docName||'its document',shared};
}
async function restoreConv(id){await setConvFlag(id,{trashed:0,dropCards:false});syncCardsUI();setStatus('Restored')}
/* Rename from the sidebar: double-click a conversation's title. Enter or clicking away keeps it, Esc cancels.
   The title is shared content: the open conversation saves (and merges) as usual, another is PATCHed. */
let convRenaming=null;
function renameInSide(row){
  const id=row.dataset.conv,t=row.querySelector('.t');if(!t||convRenaming)return;
  const m=convList.find(c=>c.id===id)||(conv&&conv.id===id?metaOf(conv):null);if(!m)return;
  const was=m.title||'';convRenaming={id};row.classList.add('renaming');
  t.contentEditable='plaintext-only';t.spellcheck=false;t.textContent=was;t.focus();document.getSelection().selectAllChildren(t);
  let done=false;
  const end=async keep=>{
    if(done)return;done=true;const v=t.textContent.replace(/\s+/g,' ').trim().slice(0,200),later=convRenaming.later;
    convRenaming=null;t.removeAttribute('contenteditable');row.classList.remove('renaming');
    if(keep&&v&&v!==was){
      if(conv&&conv.id===id){conv.title=v;conv.titleKept=true;delete conv.autoTitle;renderTitle();save()}
      else await setConvFlag(id,{title:v,titleKept:true});
    }
    if(!keep||!v||v===was)t.textContent=was||'New conversation';
    convListSig='';renderConvList();
  };
  t.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();end(true)}else if(e.key==='Escape'){e.preventDefault();end(false)}});
  t.addEventListener('blur',()=>end(true),{once:true});
}
$('#side').addEventListener('dblclick',e=>{const r=e.target.closest('.citem[data-conv]');if(r&&!e.target.closest('.acts')){e.preventDefault();renameInSide(r)}});
async function setConvFlag(id,patch){
  await io.ready;
  const m=convList.find(c=>c.id===id);
  if(conv&&conv.id===id){Object.assign(conv,patch);save()}
  else{
    try{
      await io.store.update(id,patch);
    }catch(e){console.warn(e);toast('Couldn\'t update that conversation.');return}
  }
  if(m)Object.assign(m,patch);
  renderConvList();updateHeader('main');
}
function toggleHidden(tid){
  const t=T(tid);if(!t||!t.parent)return;
  t.hidden=!t.hidden;if(!t.hidden)delete t.hidden;
  refreshAll();setStatus(t.hidden?'Hidden from the tree and canvas (“Show hidden” under the tree brings it back)':'Shown again');
}
// after something changes which branches show: every pane, the tree and the canvas
function refreshAll(){for(const id of conv.ui.open)if(id!=='doc'&&T(id)){renderPane(id);updateHeader(id)}if(conv.doc)updateHeader('doc');renderMap();if(conv.ui.view==='canvas')renderCanvas();save()}
function toggleBranchPin(tid){
  const t=T(tid);if(!t||!t.parent)return;
  t.pinned=!t.pinned;if(!t.pinned)delete t.pinned;
  updateHeader(tid);renderMap();renderConvList();save();
  setStatus(t.pinned?'Branch pinned':'Branch unpinned');
}
async function unpinRemoteBranch(cid,tid){
  if(conv&&conv.id===cid){toggleBranchPin(tid);return}
  let data=null;
  try{
    data=await io.store.get(cid);
    if(!data||!data.threads[tid])return;
    delete data.threads[tid].pinned;
    await io.store.update(cid,{threads:data.threads});
  }catch(e){toast('Couldn\'t unpin it.');return}
  const m=convList.find(c=>c.id===cid);if(m)m.pins=(m.pins||[]).filter(p=>p.tid!==tid);renderConvList();
}
async function openPinnedBranch(cid,tid){
  markBack();
  if(!conv||conv.id!==cid)await openConv(cid);
  if(!conv||conv.id!==cid||!T(tid)){toast('That branch no longer exists.');return}
  if(conv.ui.view==='canvas'){focusCard(tid);return}
  openThread(tid);conv.ui.collapsed=conv.ui.collapsed.filter(x=>x!==tid);layout();revealPane(tid);
}

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
    convList.sort((a,b)=>(b.updated||0)-(a.updated||0));convListLoaded=true;
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
  msgCache.clear();cvMsgCache.clear();cvNodes.clear();resetThreadIdx();for(const el of paneEls.values())el.remove();paneEls.clear();for(const g of gutEls.values())g.remove();gutEls.clear();
  camFitted=false;
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
  if(brPop&&!e.target.closest('.brpop')&&!e.target.closest('[data-brlist]'))closeBrList();
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
  if(hitSticky&&e.target.closest('.docpane')&&window.getSelection().isCollapsed)clearHit();
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
$('#cFilt').addEventListener('click',e=>{const b=e.target.closest('[data-cf]');if(!b)return;e.stopPropagation();convFilt=b.dataset.cf;try{localStorage.setItem('digress:cfilt',convFilt)}catch(e){}renderConvList()});
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
$('#archToggle').onclick=()=>{archOpen=!archOpen;try{localStorage.setItem('sq:arch',archOpen?'1':'')}catch(e){}renderConvList()};
$('#trashToggle').querySelector('.chev').innerHTML=$('#archToggle').querySelector('.chev').innerHTML;
$('#trashToggle').onclick=()=>{trashOpen=!trashOpen;try{localStorage.setItem('digress:trash',trashOpen?'1':'')}catch(e){}renderConvList()};
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
  if(brPop){closeBrList();return true}
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
  if(hitSticky){clearHit();return true}
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
/* ---------- Connections: the model providers, and API keys added or removed here ----------
   A key goes to this computer's Digress server (data/keys.json, readable only by its user), is checked with its
   provider, and is never shown or sent back: only "Connected · key ending …1234". A key set in .env shows as such
   and is changed there. Claude Code and ChatGPT sign in outside the app (their notes say how). */
const connModal=document.createElement('div');connModal.className='modal';connModal.id='connModal';
connModal.innerHTML='<div class="mbox wide conn" role="dialog" aria-modal="true" aria-label="Connections"></div>';document.body.appendChild(connModal);
const CONN_NOTES={
  anthropic:'Calls the Anthropic API with your key (billed to that account); while it’s set, Claude models go through it instead of Claude Code. The key stays on this computer’s Digress server and is sent only to Anthropic.',
  gemini:'Calls Google’s Gemini API with your key. The key stays on this computer’s Digress server and is sent only to Google. Free-tier keys: Google may use what you send to improve its products, and people may read it, so don’t send anything sensitive; web search isn’t available on the free tier. A key made in AI Studio works as it is; restricting it to the Gemini API there (API keys → Restrict to Gemini API only) is good practice. A Google Cloud API key has to be restricted to the Gemini API.',
};
const CONN_HELP={anthropic:'https://console.anthropic.com/settings/keys',gemini:'https://aistudio.google.com/apikey'};
async function openConnections(){
  const box=connModal.querySelector('.mbox');connModal.classList.add('show');
  box.innerHTML='<div class="mt">Connections</div><div class="cnload">Checking…</div>';
  if(!io.llm||!io.llm.connections){box.innerHTML='<div class="mt">Connections</div><div class="mb">Connections are set on the Digress server, so they need it running. In the demo there’s no server: replies there are written in advance.</div><div class="ma"><button class="mbtn primary" data-cx="close">Close</button></div>';return}
  let list;try{list=(await io.llm.connections()).providers}catch(e){box.innerHTML='<div class="mt">Connections</div><div class="mb"></div><div class="ma"><button class="mbtn primary" data-cx="close">Close</button></div>';box.querySelector('.mb').textContent=(e&&e.message)||'The server didn’t answer.';return}
  renderConnections(list);
}
function renderConnections(list,err){
  const box=connModal.querySelector('.mbox');
  box.innerHTML=`<div class="mt">Connections</div><div class="mb cnsub">Which models Digress can use. A provider you connect here shows up in the model picker at once.</div><div class="cnlist"></div><div class="ma"><button class="mbtn primary" data-cx="close">Done</button></div>`;
  const ul=box.querySelector('.cnlist');
  for(const p of list){
    const row=document.createElement('div');row.className='cnrow'+(p.on?' on':'');row.dataset.cid=p.id;
    const head=`<div class="cnh"><span class="cndot"></span><b></b><span class="cnstate"></span></div>`;
    row.innerHTML=head+'<div class="cnnote"></div>';
    row.querySelector('b').textContent=p.name;
    const state=row.querySelector('.cnstate'),note=row.querySelector('.cnnote');
    if(p.kind==='key'){
      state.textContent=p.from?`Connected · key ending …${p.last4}${p.from==='env'?' (from .env)':''}`:'Not connected';
      note.textContent=CONN_NOTES[p.id]||'';
      const act=document.createElement('div');act.className='cnact';
      if(p.from==='app')act.innerHTML=`<button class="mbtn" data-cx="remove" data-cid="${p.id}">Remove key</button>`;
      else if(p.from==='env')act.innerHTML=`<span class="cnfaint">Set in .env: change or remove it there.</span>`;
      else act.innerHTML=`<input type="password" class="cnkey" placeholder="Paste an API key" autocomplete="off" spellcheck="false" aria-label="${esc(p.name)} API key"><button class="mbtn primary" data-cx="add" data-cid="${p.id}">Connect</button><a class="cnget" href="${CONN_HELP[p.id]}" target="_blank" rel="noopener noreferrer">Get a key</a>`;
      row.appendChild(act);
    }else{state.textContent=p.on?'Connected':'Not connected';note.textContent=p.note||''}
    if(err&&err.id===p.id){const e=document.createElement('div');e.className='cnerr';e.textContent=err.message;row.appendChild(e)}
    ul.appendChild(row);
  }
}
connModal.addEventListener('click',async e=>{
  if(e.target===connModal)return closeConnections();
  const b=e.target.closest('[data-cx]');if(!b)return;
  if(b.dataset.cx==='close')return closeConnections();
  const id=b.dataset.cid,row=b.closest('.cnrow');
  try{
    let key='';if(b.dataset.cx==='add'){key=row.querySelector('.cnkey').value.trim();if(!key)return;b.disabled=true;b.textContent='Checking…'}
    const j=await io.llm.setKey(id,b.dataset.cx==='add'?key:'');
    fillModelPicker();showBanner(!(await io.llm.ready()),io.llm.why);
    renderConnections(j.providers);setStatus(b.dataset.cx==='add'?'Connected':'Key removed');
  }catch(err){let list;try{list=(await io.llm.connections()).providers}catch(_){list=[]}renderConnections(list,{id,message:(err&&err.message)||'That didn’t work.'})}
});
connModal.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.classList.contains('cnkey')){e.preventDefault();e.target.closest('.cnrow').querySelector('[data-cx=add]').click()}if(e.key==='Escape'){e.stopPropagation();closeConnections()}});
function closeConnections(){connModal.classList.remove('show');connModal.querySelectorAll('.cnkey').forEach(i=>{i.value=''})}
/* The model picker: a button that opens a menu of the models grouped by who makes them (Anthropic, OpenAI), each
   group folding like Appearance's sections: opened, the group with the current model is unfolded and the others
   folded, so a long list (OpenAI's) is out of the way. With one family, it's a plain list. The <select> (#mSel)
   stays, hidden, as the source of truth: picking here sets it and fires its change, so everything that reads or
   sets it (the tests, the ⋯ menu moving it) is unchanged. */
const FAMILIES=[['claude','Anthropic'],['gpt','OpenAI'],['google','Google']];
const famOf=(v)=>{const f=MODEL_FAM(v);return FAMILIES.some(([k])=>k===f)?f:'other'};
// a model's version, as the numbers in its id (gpt-6.2-sol → [6,2], claude-opus-5-5 → [5,5]); compared part by part
const modelVer=(v)=>(String(v).match(/\d+/g)||[]).map(Number);
const verCmp=(a,b)=>{for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]||0)-(b[i]||0);if(d)return d}return 0};
const mPick=document.createElement('button');mPick.type='button';mPick.id='mPick';mPick.className='mpick';mPick.setAttribute('aria-haspopup','true');mPick.setAttribute('aria-expanded','false');
mSel.after(mPick);mSel.classList.add('mnative');mSel.tabIndex=-1;mSel.setAttribute('aria-hidden','true');
const modelMenu=document.createElement('div');modelMenu.className='thmenu mmenu';modelMenu.setAttribute('role','menu');document.body.appendChild(modelMenu);
function syncPick(){const o=mSel.selectedOptions[0];mPick.textContent=o?o.textContent:'Model'}
mSel.addEventListener('change',syncPick);
let menuFor=null;   // {anchor, cur(), pick(id), find}: the top bar's picker, or Describe it instead's
function fillModelMenu(){
  const find=!!(menuFor&&menuFor.find),cur=menuFor?menuFor.cur():mSel.value;
  const opts=[...mSel.options].map(o=>[o.value,o.textContent]).filter(([v])=>!(find&&v==='auto'));
  const item=(v,l)=>{const b=document.createElement('button');b.type='button';b.dataset.model=v;b.setAttribute('role','menuitemradio');b.setAttribute('aria-checked',v===cur?'true':'false');
    b.innerHTML=`<span></span><span class="ck">${ic('check')}</span>`;b.firstChild.textContent=l;return b};
  const head=document.createElement('div');head.className='thh';head.textContent=find?'Describe it instead asks':'Model';modelMenu.replaceChildren(head);
  if(find){const n=document.createElement('div');n.className='mnote';n.textContent='It gets what you typed and your conversations’ titles; short snippets only if you let it pick.';modelMenu.append(n)}
  const auto=opts.find(([v])=>v==='auto'),rest=opts.filter(([v])=>v!=='auto');if(auto)modelMenu.append(item(...auto));
  const fams=[...FAMILIES,['other','Other']].map(([k,n])=>[k,n,rest.filter(([v])=>famOf(v)===k)]).filter(f=>f[2].length);
  const tail=()=>{if(find)return;const c=document.createElement('button');c.type='button';c.className='thwire mconn';c.dataset.conn='1';c.innerHTML=`${ic('plug')}<span>Connections…</span>`;c.title='Which providers are connected; add or remove an API key (Anthropic, Google Gemini)';modelMenu.append(c)};
  if(fams.length<2){for(const [v,l] of rest)modelMenu.append(item(v,l));if(fams.length&&fams[0][0]==='google')modelMenu.append(geminiNote());tail();return}
  let open=famOf(cur==='auto'?resolvedModel():cur);   // Default: the family of the model it stands for
  if(!fams.some(f=>f[0]===open))open=fams[0][0];   // (not known yet: the first)
  for(const [k,n,ms] of fams){
    const g=document.createElement('button');g.type='button';g.className='thgrp';g.dataset.g=k;g.setAttribute('aria-expanded',k===open?'true':'false');
    g.innerHTML=`<span class="chev">${ic('chev')}</span><span class="thgn"></span><span class="thcur"></span><span class="mcount"></span>`;
    g.querySelector('.thgn').textContent=n;g.querySelector('.mcount').textContent=ms.length;
    const c=ms.find(([v])=>v===cur);if(c)g.querySelector('.thcur').textContent=c[1];   // folded, it still says which is picked
    const list=document.createElement('div');list.className='thlist';list.setAttribute('role','group');
    if(k==='google')list.append(geminiNote());
    // the newest of each kind first (another Opus, another GPT Sol); earlier versions fold under Older, opened when
    // the current model is one of them
    const newest=new Map();for(const [v] of ms){const t=modelTier(v),n=modelVer(v);if(!newest.has(t)||verCmp(n,newest.get(t))>0)newest.set(t,n)}
    const old=ms.filter(([v])=>verCmp(modelVer(v),newest.get(modelTier(v)))<0);
    for(const [v,l] of ms)if(!old.some(o=>o[0]===v))list.append(item(v,l));
    if(old.length){
      const ob=document.createElement('button');ob.type='button';ob.className='molder';ob.setAttribute('aria-expanded',old.some(([v])=>v===cur)?'true':'false');
      ob.innerHTML=`<span class="chev">${ic('chev')}</span><span>Older</span><span class="mcount"></span>`;ob.querySelector('.mcount').textContent=old.length;
      const ol=document.createElement('div');ol.className='molist';ol.setAttribute('role','group');for(const [v,l] of old)ol.append(item(v,l));
      list.append(ob,ol);
    }
    modelMenu.append(g,list);
  }
  tail();
}
function geminiNote(){const n=document.createElement('div');n.className='mnote';n.textContent='Free-tier Gemini keys: Google may use what you send to improve its products, and people may read it.';return n}
function placeModels(){
  const r=(menuFor?menuFor.anchor:mPick).getBoundingClientRect(),vh=(window.visualViewport?visualViewport.height:innerHeight);
  modelMenu.style.maxHeight=(vh-16)+'px';const h=modelMenu.offsetHeight;
  modelMenu.style.top=Math.max(8,Math.min(r.bottom+6,vh-h-8))+'px';
  modelMenu.style.left=Math.max(8,Math.min(innerWidth-modelMenu.offsetWidth-8,r.left))+'px';
}
const modelsOpen=()=>modelMenu.classList.contains('open');
function closeModels(){if(!modelsOpen())return;modelMenu.classList.remove('open');const a=menuFor&&menuFor.anchor;if(a)a.setAttribute('aria-expanded','false')}
function openModelMenu(m){
  menuFor=m;closeThemes();fillModelMenu();modelMenu.classList.toggle('mfind',!!m.find);modelMenu.classList.add('open');m.anchor.setAttribute('aria-expanded','true');modelMenu.scrollTop=0;placeModels();
  const ck=modelMenu.querySelector('button[aria-checked=true]');if(ck&&ck.offsetParent)ck.focus({preventScroll:true});
}
const mainPick={anchor:mPick,cur:()=>mSel.value,pick:(v)=>{if(mSel.value!==v){mSel.value=v;mSel.dispatchEvent(new Event('change'))}}};
mPick.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(modelsOpen()&&menuFor===mainPick)return closeModels();openModelMenu(mainPick)});
modelMenu.addEventListener('click',e=>{e.stopPropagation();
  const o=e.target.closest('.molder');if(o){o.setAttribute('aria-expanded',o.getAttribute('aria-expanded')==='true'?'false':'true');placeModels();return}
  const g=e.target.closest('.thgrp');
  if(g){g.setAttribute('aria-expanded',g.getAttribute('aria-expanded')==='true'?'false':'true');placeModels();
    if(g.getAttribute('aria-expanded')==='true'){const l=g.nextElementSibling;if(l.getBoundingClientRect().bottom>modelMenu.getBoundingClientRect().bottom)g.scrollIntoView({block:'start',behavior:'smooth'})}return}
  if(e.target.closest('[data-conn]')){closeModels();openConnections();return}
  const b=e.target.closest('button[data-model]');if(!b)return;
  const m=menuFor||mainPick;closeModels();m.pick(b.dataset.model);m.anchor.focus({preventScroll:true})});
document.addEventListener('click',closeModels);
addEventListener('keydown',e=>{if(e.key==='Escape'&&modelsOpen()){e.stopPropagation();e.preventDefault();const a=menuFor&&menuFor.anchor;closeModels();(a&&a.isConnected?a:mPick).focus({preventScroll:true})}},true);
addEventListener('resize',()=>{if(modelsOpen())placeModels()});
syncPick();
$('#tSide').addEventListener('click',()=>{const app=$('#app');if(zen){app.classList.toggle('zenside');return}if(innerWidth<760){app.classList.toggle('sideopen')}else{app.classList.toggle('noside');try{localStorage.setItem('sq:noside',app.classList.contains('noside')?'1':'')}catch(e){}}setTimeout(()=>{wires();if(conv.ui.view==='canvas')applyCam()},50)});
try{if(localStorage.getItem('sq:noside'))$('#app').classList.add('noside')}catch(e){}
(()=>{
  const app=$('#app'),g=$('#sgrip'),W0=272,clampW=(w)=>Math.round(Math.min(Math.max(200,w),Math.min(620,innerWidth-360)));
  const setW=(w)=>{if(w)app.style.setProperty('--sidew',clampW(w)+'px');else app.style.removeProperty('--sidew')};
  const after=()=>{wires();if(conv&&conv.ui.view==='canvas')applyCam()};
  try{const w=+localStorage.getItem('sq:sidew');if(w)setW(w)}catch(e){}
  let drag=null;
  g.addEventListener('pointerdown',e=>{drag={x:e.clientX,w:$('#side').offsetWidth};g.classList.add('on');app.classList.add('sizing');try{g.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault()});
  g.addEventListener('pointermove',e=>{if(drag)setW(drag.w+e.clientX-drag.x)});
  const end=()=>{if(!drag)return;drag=null;g.classList.remove('on');app.classList.remove('sizing');try{localStorage.setItem('sq:sidew',String($('#side').offsetWidth))}catch(e){}after()};
  g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);
  g.addEventListener('dblclick',()=>{setW(0);try{localStorage.removeItem('sq:sidew')}catch(e){}after()});
})();
$('#viewSeg').addEventListener('click',e=>{const b=e.target.closest('[data-v]');if(b)setView(b.dataset.v)});
$('#newConv').addEventListener('click',async()=>{if(!await leaveOk())return;BACK.length=0;renderBack();setConv(newConv());setTimeout(()=>{if(!$('#pal').classList.contains('show'))paneEls.get('main').querySelector('textarea').focus()},30)});   // not if search opened meanwhile
const ct=$('#cTitle');
ct.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();ct.blur()}});
ct.addEventListener('blur',()=>{const v=ct.textContent.trim();if(v&&v!==conv.title){conv.title=v;conv.titleKept=true;delete conv.autoTitle;updateHeader('main');tabName();save()}else renderTitle()});
addEventListener('resize',wiresSoon);
$('#panes').addEventListener('scroll',wiresSoon,{passive:true});
new ResizeObserver(()=>{wiresSoon();if(conv&&conv.ui.view==='canvas'){placeDocked();drawEdgesSoon()}}).observe($('#stage'));

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
});

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
