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
import { createPanes } from './panes.js';
import { createCanvas } from './canvas.js';
import { createGeneration } from './generation.js';
import { createSearch } from './search.js';

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
  dirty: { get: () => dirty, set: (v) => { dirty = v; }, enumerable: true, configurable: true },
  cvTook: { get: () => cvTook, set: (v) => { cvTook = v; }, enumerable: true, configurable: true },
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
