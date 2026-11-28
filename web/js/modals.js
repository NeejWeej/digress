// Modals & secondary panels: Activity, Prompts & skills, Export/Import/Share, and Connections/Model picker.
import { DAY, fsrsNext } from './fsrs.js';
import { esc, trunc, plain, stripCiteQuotes } from './text.js';
import {
  PUBLIC_DEMO_URL, FILE_MAX_DECODED, gunzipBytesCapped, encodeSharePayload, decodeSharePayload,
  buildShareUrl, parseShareHash, shareSizeStatus, sliceBranch, cardInScope, remapConvIds,
  normalizePageIndex, parseInlineImageDataUrl,
} from './share.js';
import { okOrThrow } from './connectors.js';
import {
  state, app, io, settings, CUSTOM, paneEls,
  defaultSys, sysPrompt, fullSys, quickList, convSkills, skillsPrompt,
  modelLabel, $, ic, rid, T, newConv, } from './state.js';
import { blobB64, storeImages } from './media.js';
import { copyText } from './render.js';
import { invalidate } from './redraw.js';

export function createModals() {
  const mSel = $('#mSel');
  const applyCam = (...a) => app.applyCam(...a);
  const askConfirm = (...a) => app.askConfirm(...a);
  const buildContext = (...a) => app.buildContext(...a);
  const closeThemes = (...a) => app.closeThemes(...a);
  const contentOf = (...a) => app.contentOf(...a);
  const docPagesLabel = (...a) => app.docPagesLabel(...a);
  const fillModelPicker = (...a) => app.fillModelPicker(...a);
  const fillPopChips = (...a) => app.fillPopChips(...a);
  const focusCard = (...a) => app.focusCard(...a);
  const leaveOk = (...a) => app.leaveOk(...a);
  const loadCards = (...a) => app.loadCards(...a);
  const loadList = (...a) => app.loadList(...a);
  const modelTier = (...a) => app.modelTier(...a);
  const openCards = (...a) => app.openCards(...a);
  const openConv = (...a) => app.openConv(...a);
  const openThread = (...a) => app.openThread(...a);
  const pickerTid = (...a) => app.pickerTid(...a);
  const placeDocked = (...a) => app.placeDocked(...a);
  const putCard = (...a) => app.putCard(...a);
  const renderBack = (...a) => app.renderBack(...a);
  const renderPane = (...a) => app.renderPane(...a);
  const resolvedModel = (...a) => app.resolvedModel(...a);
  const revealPane = (...a) => app.revealPane(...a);
  const save = (...a) => app.save(...a);
  const setConv = (...a) => app.setConv(...a);
  const setStatus = (...a) => app.setStatus(...a);
  const setView = (...a) => app.setView(...a);
  const showBanner = (...a) => app.showBanner(...a);
  const storeDocFile = (...a) => app.storeDocFile(...a);
  const sysScope = (...a) => app.sysScope(...a);
  const tabName = (...a) => app.tabName(...a);
  const toast = (...a) => app.toast(...a);
  const updateHeader = (...a) => app.updateHeader(...a);
/* ---------- Activity: what you did each day, what you remember, where you dug deepest ----------
   All of it is worked out from what's already saved (messages' ts, threads' created, cards' reviews); nothing
   new is recorded. Conversations come from io.store.list() (the open one from memory, which is newer). */
const ACT={kind:'all',day:null,data:null};
const dayKey=(t)=>{const d=new Date(t);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const ACT_KINDS=[['all','Everything'],['q','Questions'],['b','Branches'],['r','Reviews']];
async function actGather(){
  await loadCards();let list=[];try{list=(await io.store.list()).map(x=>x.data)}catch(e){console.warn(e)}
  const convs=list.filter(c=>c&&c.threads&&!c.trashed).map(c=>state.conv&&c.id===state.conv.id?state.conv:c);
  const days=new Map(),bump=(t,k,cid)=>{if(!t)return;const key=dayKey(+t);let d=days.get(key);if(!d)days.set(key,d={q:0,b:0,r:0,convs:new Map()});d[k]++;if(cid){const e=d.convs.get(cid)||{q:0,b:0,r:0};e[k]++;d.convs.set(cid,e)}};
  for(const c of convs){
    for(const m of Object.values(c.msgs||{}))if(m&&m.role==='user')bump(m.ts,'q',c.id);
    for(const t of Object.values(c.threads))if(t.parent&&!t.alt)bump(t.created,'b',c.id);
  }
  const cards=[...app.CARDS.values()];
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
  box.innerHTML=`<div class="acdayh">${dt.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}</div>`+rows.map(([cid,e])=>{const c=D.byId.get(cid),t=c?c.title||'New conversation':(([...app.CARDS.values()].find(k=>k.conv===cid)||{}).convTitle||'A deleted conversation');
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
  closeActivity();if(!state.conv||state.conv.id!==cid)await openConv(cid);
  if(!tid||!state.conv||state.conv.id!==cid||!T(tid))return;
  if(state.conv.ui.view==='canvas'){focusCard(tid);return}
  openThread(tid);state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==tid);invalidate('panes');invalidate('map');revealPane(tid);
}
$('#activity').addEventListener('click',e=>{
  const t=e.target.closest('[data-aact],[data-akind],[data-aday],[data-aconv],[data-acard]');if(!t)return;
  if(t.dataset.aact==='close')closeActivity();
  else if(t.dataset.akind){ACT.kind=t.dataset.akind;renderActivity()}
  else if(t.dataset.aday){ACT.day=ACT.day===t.dataset.aday?null:t.dataset.aday;const sc=$('#activity .acscroll'),l=sc?sc.scrollLeft:0;actGridSection($('#activity .acgridsec'),ACT.data);requestAnimationFrame(()=>{const n=$('#activity .acscroll');if(n)n.scrollLeft=l})}
  else if(t.dataset.aconv)actGo(t.dataset.aconv,t.dataset.athread);
  else if(t.dataset.acard){const c=app.CARDS.get(t.dataset.acard);if(c){closeActivity();app.KS.focus=c.id;openCards(c.conv,'all')}}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&$('#activity').classList.contains('show')&&!$('#cardsModal').classList.contains('show')){e.preventDefault();closeActivity()}});
$('#actBtn').addEventListener('click',openActivity);
/* ---------- Prompts & skills (the sidebar's Prompts & skills; the top bar's Skills) ----------
   The reader's own system prompt and quick questions (the store's prompts/custom: {system?, quick?}, only what differs
   from web/prompts.js) and skills: SKILL.md files ({id, name, description, body, text, source}), turned on per
   conversation (state.conv.skills, ids) and added to its system prompt (skillsPrompt), so all its threads share one cache. */
async function loadCustom(){
  if(!io.skills)return;
  try{
    const [list,pr]=await Promise.all([io.skills.list(),io.prompts.get('custom')]);
    CUSTOM.skills=new Map(list.filter(x=>x.data&&typeof x.data.body==='string').sort((a,b)=>(a.data.added||0)-(b.data.added||0)).map(({id,data})=>[id,{...data,id}]));
    CUSTOM.prompts=pr&&typeof pr==='object'&&!Array.isArray(pr)?pr:{};
  }catch(e){console.warn('prompts and skills failed to load',e)}
  fillPopChips();syncSkillT();
  app.SIDEBAR_MOD.convListSig='';invalidate('conv-list');   // folders' prompts are marked in the sidebar
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
  const b=$('#skillT');if(!b)return;const on=convSkills(state.conv),own=ownSys(state.conv),lit=!!on.length||own;
  b.style.display=state.conv?'':'none';
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
  const on=new Set((state.conv&&state.conv.skills)||[]);
  const own=ownSys(state.conv);
  menu.innerHTML=`<div class="thh">This conversation</div><button class="skrow" data-sk="="><span class="skchk">${ic('tune')}</span><span class="skt"><b>System prompt</b><small>${own?esc('Its own: “'+trunc(state.conv.system.replace(/\s+/g,' '),70)+'”'):'Your default. Click to see it or give this conversation its own.'}</small></span></button>`+
    `<div class="thh">Skills</div>`+(CUSTOM.skills.size?'':`<div class="sknone">None yet. Add one in Prompts, skills &amp; tools.</div>`)+[...CUSTOM.skills.values()].map(s=>`<button class="skrow" data-sk="${esc(s.id)}" role="menuitemcheckbox" aria-checked="${on.has(s.id)}" title="${esc(s.description||'')}"><span class="skchk">${on.has(s.id)?ic('check'):''}</span><span class="skt"><b>${esc(skillLabel(s))}</b>${s.description?`<small>${esc(trunc(s.description,110))}</small>`:''}</span></button>`).join('')+
    `<div class="thh thsep" style="padding:0"></div><button data-sk="-">${ic('tune')}Prompts, skills &amp; tools…</button><button data-sk="?" class="skdbg" title="Debug: the exact request the next question in this thread sends">What the model sees here…</button>`;
}
function toggleSkill(id){
  if(!state.conv)return;const s=CUSTOM.skills.get(id);if(!s)return;
  const on=new Set(state.conv.skills||[]),was=on.has(id);if(was)on.delete(id);else on.add(id);
  if(on.size)state.conv.skills=[...on];else delete state.conv.skills;
  save();syncSkillT();
  toast(was?`${skillLabel(s)} is off in this conversation.`:`${skillLabel(s)} is on in this conversation, from the next reply, in every thread.`);
}
// this conversation's system prompt, from the top bar's Prompt: a dialog with it filled in
function editConvSystem(){
  if(!state.conv)return;const own=ownSys(state.conv);
  askConfirm('System prompt for this conversation',`<p class="ppnote">${own?'This conversation has its own.':'This conversation follows your default, shown here: change it to give it its own.'} ${sysScope()} A change applies from the next reply on; replies already written keep what they were written with.</p><textarea class="pptext" id="cSysEd" rows="14" spellcheck="false" aria-label="System prompt for this conversation"></textarea>${own?'<button class="elink" id="cSysDef" type="button">Put my default back</button>':''}`,
    ()=>{const was=ownSys(state.conv);setConvSystem($('#cSysEd').value);if(state.conv.order.main.length===0)renderPane('main');
      toast(ownSys(state.conv)?'Saved: this conversation has its own system prompt, from the next reply.':was?'This conversation follows your default again.':'Unchanged: it follows your default.')},{ok:'Save',kind:'primary'});
  $('#cSysEd').value=sysPrompt(state.conv);
  const d=$('#cSysDef');if(d)d.onclick=()=>{$('#cSysEd').value=defaultSys();$('#cSysEd').focus()};
  setTimeout(()=>$('#cSysEd').focus(),30);
}
// a conversation's own system prompt: '' or the default puts it back to following your default
// Debug: the request the next question in this thread would send, exactly as built (buildContext), before images are
// loaded: the tools, the system prompt in its parts, and every message on the path with its markers.
function showModelView(tid){
  if(!state.conv)return;tid=tid||pickerTid();if(!T(tid))tid='main';
  const keep=app.DOC_MOD.lastDocSeen;let ctx;try{ctx=buildContext(tid,null,{captureSources:false})}finally{app.DOC_MOD.lastDocSeen=keep}
  const own=sysPrompt(state.conv),sk=skillsPrompt(state.conv),rest=ctx.system.slice(fullSys(state.conv).length).replace(/^\n\n/,'');
  const n=(x)=>`${x.length.toLocaleString()} characters`;
  const part=(title,text,open)=>text?`<details class="mvp"${open?' open':''}><summary>${esc(title)} <small>${n(text)}</small></summary><pre>${esc(text)}</pre></details>`:'';
  const msgText=(c)=>typeof c==='string'?c:c.map(p=>p.type==='text'?p.text:`[image: ${p.label||'an image'}]`).join('');
  const t=T(tid),name=tid==='main'?'the main thread':`“${t.title||'a branch'}”`;
  const msgs=ctx.messages.map((m,i)=>`<details class="mvp"${i>=ctx.messages.length-2?' open':''}><summary>${i+1}. ${m.role==='user'?'User':'Assistant'} <small>${n(msgText(m.content))}</small></summary><pre>${esc(msgText(m.content))}</pre></details>`).join('');
  askConfirm('What the model sees here',`<div class="mview"><p class="ppnote">The request the next question in ${esc(name)} sends, before your question is added: exactly what the model gets, nothing else. Thread names and labels on screen aren’t sent.</p>
    <h3>Tools</h3><p class="ppnote">${ctx.tools?ctx.tools.map(x=>`<code>${esc(x)}</code>`).join(', '):'None'}${settings.web&&io.llm&&io.llm.supportsWeb?', and web search (Web is on)':''}.</p>
    <h3>System prompt</h3>${part(ownSys(state.conv)?'This conversation’s own prompt':'Your default prompt',own,true)}${part('How Digress works (fixed)',PROMPTS.howDigress)}${part('Skills',sk.trim())}${part('The document',rest)}
    <h3>Messages, oldest first</h3>${msgs||'<p class="ppnote">None yet.</p>'}</div>`,
    ()=>{copyText(JSON.stringify(ctx,null,2)).then(()=>toast('Copied the request as JSON.'),()=>toast('It couldn’t be copied.'))},
    {ok:'Copy as JSON',kind:'plain',cancel:'Close',wide:true});
}
function setConvSystem(v){
  if(!state.conv)return;v=String(v||'').trim();
  if(!v||v===defaultSys().trim())delete state.conv.system;else state.conv.system=v;
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
  ['Saved web references',['list_sources'],'An earlier reply on this path has web references.','Looks up a saved list even when Web is off.'],
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
function refreshChips(){fillPopChips();if(state.conv)for(const id of state.conv.ui.open)if(id!=='doc'&&T(id))renderPane(id)}
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
  if(state.conv&&state.conv.id===id)return contentOf(state.conv);
  const d=await io.store.get(id);if(!d)throw new Error('That conversation couldn’t be loaded.');
  const {rev:_rev,ui:_ui,...rest}=d;return JSON.parse(JSON.stringify({...rest,id}));
}
// every image record in a conversation (pasted into questions, an article's pictures, clipped images): {asset|data, type, w, h}
const imageRecs=(c)=>[...Object.values(c.msgs||{}).flatMap(m=>(m&&m.images)||[]),...Object.values((c.doc&&c.doc.images)||{}),...Object.values(c.threads||{}).map(t=>t&&t.anchorShot),...Object.values(c.threads||{}).flatMap(t=>(t&&t.anchorImages)||[])].filter(Boolean);
function exportScope(raw,branch){
  if(!branch||branch==='main')return raw;
  const c=sliceBranch(raw,branch);
  if(!c)throw new Error('That branch could not be found.');
  return c;
}
async function digressFile(id,o={}){
  const raw=await convFull(id),c=exportScope(raw,o.branch),files={},withImgs=o.images!==false;
  const grab=async(assetId,type)=>{if(!assetId||files[assetId])return;const buf=await io.files.fetch(assetId);files[assetId]={type:type||'application/octet-stream',data:await blobB64(new Blob([buf]))}};
  for(const k of ['trashed','archived','pinned','folder','dropCards','cards'])delete c[k];
  for(const t of Object.values(c.threads))delete t.pinned;
  for(const m of Object.values(c.msgs)){delete m.run;delete m.runFrom;delete m.runSourceIds;if(!withImgs)delete m.images}
  if(!withImgs){for(const t of Object.values(c.threads)){delete t.anchorShot;delete t.anchorImages}}
  if(c.doc){
    delete c.doc.mark;delete c.doc.unsaved;
    if(!o.docSource)delete c.doc.source;
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
    for(const k of app.CARDS.values()){if(k.conv!==id||k.fix)continue;
      if(o.branch&&!cardInScope(k,c))continue;
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
async function exportMarkdown(id,branch){const raw=await convFull(id),c=exportScope(raw,branch);saveFile(new Blob([convMarkdown(c)],{type:'text/markdown'}),fileSafe(c.title)+'.md')}
// Anki imports this as is (File → Import): front, back, the sentence it came from, and a tag for the conversation
async function exportAnki(id,branch){
  await loadCards();const raw=await convFull(id),c=exportScope(raw,branch);
  const cards=[...app.CARDS.values()].filter(k=>k.conv===id&&k.status!=='inbox'&&(!branch||cardInScope(k,c)));
  const cell=(v)=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"',tag='digress::'+fileSafe(c.title).replace(/[\s:]+/g,'_');
  const lines=['#separator:comma','#html:false','#columns:Front,Back,Source,Tags','#tags column:4',...cards.map(k=>[k.front,k.back,k.quote?k.quote.text:'',tag].map(cell).join(','))];
  saveFile(new Blob([lines.join('\n')+'\n'],{type:'text/csv'}),fileSafe(c.title)+' (cards).csv');
}
function isQueryFreeUrl(src){
  if(typeof src!=='string'||!/^https?:\/\//i.test(src))return false;
  try{const u=new URL(src);return !u.search&&!u.hash&&!u.username&&!u.password}catch(_){return false}
}
async function openExport(id,branch){
  const m=state.convList.find(x=>x.id===id)||{};let nCards=0,hasDoc=!!m.doc,docName=m.docName||'',docSource='',hasImgs=false,isPdf=false,scope=null,title=m.title||'this conversation';
  try{const raw=await convFull(id);scope=exportScope(raw,branch);hasImgs=imageRecs(scope).length>0;hasDoc=!!scope.doc;docName=(scope.doc&&scope.doc.name)||docName;docSource=(scope.doc&&typeof scope.doc.source==='string'&&/^https?:\/\//i.test(scope.doc.source))?scope.doc.source:'';isPdf=!!(scope.doc&&scope.doc.kind==='pdf');if(branch&&scope.title)title=scope.title}catch(e){if(branch){toast(e.message||'That branch could not be found.');return}}
  try{await loadCards();nCards=[...app.CARDS.values()].filter(k=>k.conv===id&&!k.fix&&(!branch||cardInScope(k,scope))).length}catch(e){}
  const kept=[...app.CARDS.values()].filter(k=>k.conv===id&&k.status!=='inbox'&&(!branch||cardInScope(k,scope))).length;
  const curBase=location.origin+location.pathname,onPublic=curBase===PUBLIC_DEMO_URL;
  const defaultDocSrc=isQueryFreeUrl(docSource);
  let docSrcHost='';try{docSrcHost=docSource?new URL(docSource).hostname:''}catch(_){}
  const srcNote=defaultDocSrc?`${esc(docSrcHost||docSource)}. Lets whoever opens it download their own copy.`:`${esc(docSrcHost||docSource)} — this URL has query parameters or credentials that may grant private access.`;
  let linkUrl='',linkOk=false,linkSeq=0;
  askConfirm(`${branch?'Export branch':'Export'} “${trunc(title,60)}”`,`<div class="xopts">
    <label class="xopt"><input type="radio" name="xfmt" value="digress" checked><span><span><b>Digress file</b> <i class="xext">.digress</i></span><small>${branch?'This branch (its path and any sub-branches). Open it in your Digress, or someone else’s, to read it and carry on.':'Everything: every branch, highlight and takeaway. Open it in your Digress, or someone else’s, to read it and carry on.'}</small></span></label>
    <div class="xsub" id="xFileSub">${hasDoc?`<label><input type="checkbox" id="xDoc"><span>Include the document <small>${esc(trunc(docName||'the document',50))}. Without it, whoever opens the file attaches their own copy.</small></span></label>`:''}${hasDoc&&docSource?`<label id="xDocSrcRow"><input type="checkbox" id="xDocSrc"${defaultDocSrc?' checked':''}><span>Include the original link <small>${srcNote}</small></span></label>`:''}${nCards?`<label><input type="checkbox" id="xCards"><span>Include ${nCards>1?`the ${nCards} flashcards`:'its flashcard'} <small>They arrive in the inbox, without your review history.</small></span></label>`:''}</div>
    <label class="xopt"><input type="radio" name="xfmt" value="link"><span><span><b>Shareable link</b> <i class="xext">#share=…</i></span><small>Paste in a message to share with one click. The conversation lives in the URL’s <code>#</code> fragment, which browsers never send to any server.</small></span></label>
    <div class="xsub off" id="xLinkSub">
      ${hasDoc?`<label><input type="checkbox" id="xLDoc"><span>Include the document <small>${esc(trunc(docName||'the document',50))}${isPdf?' (PDFs are usually too large for a link)':''}. Without it, whoever opens the link attaches their own copy.</small></span></label>`:''}
      ${hasDoc&&docSource?`<label id="xLDocSrcRow"><input type="checkbox" id="xLDocSrc"${defaultDocSrc?' checked':''}><span>Include the original link <small>${srcNote}</small></span></label>`:''}
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
        const doc=!!($('#xDoc')||{}).checked,docSource=!!($('#xDocSrc')||{}).checked,cards=!!($('#xCards')||{}).checked;
        await exportDigress(id,{doc,docSource,cards,branch});setStatus('Exported');
      }
    }catch(e){console.warn(e);toast('Couldn’t export it: '+((e&&e.message)||'error'))}},{ok:'Export',kind:'primary',wide:true});
  const fileSub=$('#xFileSub'),linkSub=$('#xLinkSub'),sizeEl=$('#xLSize'),okBtn=$('#mOk');
  const estimateLink=async()=>{
    const seq=++linkSeq;linkUrl='';linkOk=false;
    if(sizeEl){sizeEl.className='xsize';sizeEl.textContent='Estimating link size…'}
    if(okBtn)okBtn.disabled=true;
    try{
      const doc=!!($('#xLDoc')||{}).checked,docSource=!!($('#xLDocSrc')||{}).checked,images=!!($('#xLImg')||{}).checked,cards=!!($('#xLCards')||{}).checked;
      const pub=!!($('#xLPub')||{}).checked;
      const {file}=await digressFile(id,{doc,docSource,images,cards,branch,inlineText:true});
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
    for(const m of Object.values(c.msgs)){for(const f of [...app.LOCAL_MSG,'run','runFrom','runSourceIds'])delete m[f];for(const im of m.images||[])await restore(im)}
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
  await loadList();invalidate('conv-list');await openConv(first.id);
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
const famOf=(v)=>{const f=app.MODEL_FAM(v);return FAMILIES.some(([k])=>k===f)?f:'other'};
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
$('#tSide').addEventListener('click',()=>{const appEl=$('#app');if(app.zen){appEl.classList.toggle('zenside');return}if(innerWidth<760){appEl.classList.toggle('sideopen')}else{appEl.classList.toggle('noside');try{localStorage.setItem('sq:noside',appEl.classList.contains('noside')?'1':'')}catch(e){}}setTimeout(()=>{invalidate('wires');if(state.conv.ui.view==='canvas')applyCam()},50)});
try{if(localStorage.getItem('sq:noside'))$('#app').classList.add('noside')}catch(e){}
(()=>{
  // The sidebar's width, dragged by its edge. A phone's drawer (an overlay under 760px) has a width of its own
  // (--sidew-m, sq:sidew-m): from 220px to all but a sliver of the screen, so widening it there leaves the desktop's alone.
  const appEl=$('#app'),g=$('#sgrip'),phone=()=>innerWidth<760;
  const K={d:{v:'--sidew',k:'sq:sidew',clamp:(w)=>Math.min(Math.max(200,w),Math.min(620,innerWidth-360))},m:{v:'--sidew-m',k:'sq:sidew-m',clamp:(w)=>Math.min(Math.max(220,w),innerWidth-24)}};
  const setW=(m,w)=>{if(w)appEl.style.setProperty(m.v,Math.round(m.clamp(w))+'px');else appEl.style.removeProperty(m.v)};
  const after=()=>{invalidate('wires');if(state.conv&&state.conv.ui.view==='canvas')applyCam()};
  for(const m of Object.values(K))try{const w=+localStorage.getItem(m.k);if(w)setW(m,w)}catch(e){}
  let drag=null;
  g.addEventListener('pointerdown',e=>{drag={x:e.clientX,w:$('#side').offsetWidth,m:phone()?K.m:K.d};g.classList.add('on');appEl.classList.add('sizing');try{g.setPointerCapture(e.pointerId)}catch(_){}e.preventDefault()});
  g.addEventListener('pointermove',e=>{if(drag)setW(drag.m,drag.w+e.clientX-drag.x)});
  const end=()=>{if(!drag)return;const m=drag.m;drag=null;g.classList.remove('on');appEl.classList.remove('sizing');try{localStorage.setItem(m.k,String($('#side').offsetWidth))}catch(e){}after()};
  g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);
  g.addEventListener('dblclick',()=>{const m=phone()?K.m:K.d;setW(m,0);try{localStorage.removeItem(m.k)}catch(e){}after()});
})();
$('#viewSeg').addEventListener('click',e=>{const b=e.target.closest('[data-v]');if(b)setView(b.dataset.v)});
$('#newConv').addEventListener('click',async()=>{if(!await leaveOk())return;app.BACK.length=0;renderBack();setConv(newConv());setTimeout(()=>{if(!$('#pal').classList.contains('show'))paneEls.get('main').querySelector('textarea').focus()},30)});   // not if search opened meanwhile
const ct=$('#cTitle');
ct.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();ct.blur()}});
ct.addEventListener('blur',()=>{const v=ct.textContent.trim();if(v&&v!==state.conv.title){state.conv.title=v;state.conv.titleKept=true;delete state.conv.autoTitle;updateHeader('main');tabName();save()}else invalidate('title')});
addEventListener('resize',() => invalidate('wires-soon'));
$('#panes').addEventListener('scroll',() => invalidate('wires-soon'),{passive:true});
new ResizeObserver(()=>{invalidate('wires-soon');if(state.conv&&state.conv.ui.view==='canvas'){placeDocked();invalidate('edges-soon')}}).observe($('#stage'));


  return {
    openActivity, closeActivity, loadCustom, putSkill, skillLink, ownSys, syncSkillT, setConvSystem, closeSkillMenu, closePrompts, savePrompts, isDigressFile, convMarkdown, openExport, fresh, importDigress, importShareHash, connModal, closeConnections, syncPick, menuFor, modelsOpen, closeModels, openModelMenu,
  };
}
