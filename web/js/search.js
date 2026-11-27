// Search & navigation: per-conversation index, Cmd+K palette, Describe-it-instead, hit landing, and Back stack.
import { esc, trunc, indexEntries, idxPages, sigOf } from './text.js';
import { state, app, io, settings, saveSettings, paneEls, $, ic, T, color, ancestors } from './state.js';

export function createSearch() {
  Object.defineProperties(state, {
    hitSticky: { get: () => hitSticky, set: (v) => { hitSticky = v; }, enumerable: true, configurable: true },
    hitTimer: { get: () => hitTimer, set: (v) => { hitTimer = v; }, enumerable: true, configurable: true },
  });
  const applyCam = (...a) => app.applyCam(...a);
  const closeModels = (...a) => app.closeModels(...a);
  const contentScale = (...a) => app.contentScale(...a);
  const curPane = (...a) => app.curPane(...a);
  const cvState = (...a) => app.cvState(...a);
  const focusCard = (...a) => app.focusCard(...a);
  const goToPage = (...a) => app.goToPage(...a);
  const hidePop = (...a) => app.hidePop(...a);
  const hideTip = (...a) => app.hideTip(...a);
  const keyClose = (...a) => app.keyClose(...a);
  const layout = (...a) => app.layout(...a);
  const loadScript = (...a) => app.loadScript(...a);
  const markCur = (...a) => app.markCur(...a);
  const menuFor = (...a) => app.menuFor(...a);
  const metaOf = (...a) => app.metaOf(...a);
  const modelsOpen = (...a) => app.modelsOpen(...a);
  const openConv = (...a) => app.openConv(...a);
  const openModelMenu = (...a) => app.openModelMenu(...a);
  const openThread = (...a) => app.openThread(...a);
  const rememberSpot = (...a) => app.rememberSpot(...a);
  const renderCanvas = (...a) => app.renderCanvas(...a);
  const renderMap = (...a) => app.renderMap(...a);
  const revealAnchor = (...a) => app.revealAnchor(...a);
  const revealMsg = (...a) => app.revealMsg(...a);
  const revealPane = (...a) => app.revealPane(...a);
  const save = (...a) => app.save(...a);
  const setView = (...a) => app.setView(...a);
  const setZen = (...a) => app.setZen(...a);
  const titleModel = (...a) => app.titleModel(...a);
  const toast = (...a) => app.toast(...a);
  const toggleCollapse = (...a) => app.toggleCollapse(...a);
  const wiresSoon = (...a) => app.wiresSoon(...a);
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
  const serverSearch=!!(io.index&&io.index.search);
  if(IDX.lastSig.get(c.id)===sig&&(serverSearch||(IDX.map.get(c.id)||{}).v===IDXV))return;
  const d={id:c.id,v:IDXV,updated:c.updated||Date.now(),sig,e:E};
  IDX.lastSig.set(c.id,sig);
  if(!serverSearch){IDX.map.set(c.id,d);idxTouch(c.id)}
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
    const stale=state.convList.filter(c=>c.id!==(state.conv&&state.conv.id)&&(!IDX.map.has(c.id)||IDX.map.get(c.id).v!==IDXV||(IDX.map.get(c.id).updated||0)<(c.updated||0)));
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
  const d=(state.conv&&state.conv.id===cid)?{id:cid,e:indexEntries(state.conv,state.docState&&state.docState.key===cid&&state.docState.loaded?state.docState.pages:idxPages(IDX.map.get(cid)))}:IDX.map.get(cid);
  return d&&d.e?d.e.map((en,i)=>({id:cid+'|'+i,cid,...en})):[];
}
async function idxEngine(){
  await loadMini();
  if(state.conv&&!IDX.indexedIds.has(state.conv.id))IDX.dirtyIds.add(state.conv.id);
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
  const ids=new Set(IDX.map.keys());if(state.conv)ids.add(state.conv.id);
  IDX.indexedIds.clear();
  const docs=[];
  for(const cid of ids){const ds=idxDocsFor(cid);if(ds.length){IDX.indexedIds.set(cid,ds.map(x=>x.id));for(const x of ds)docs.push(x)}}
  ms.addAll(docs);IDX.ms=ms;IDX.dirty=false;IDX.dirtyIds.clear();return ms;
}
/* ---------- search palette ---------- */
const PAL={results:[],sel:0,timer:0,q:'',scope:'all',stid:null};
/* Where a search looks: everywhere, this conversation, or one thread (the pane you were last in, or the one
   whose magnifier opened it; 'doc' = the document). Tab moves between them. */
const scopeTid=()=>{const ok=t=>t&&state.conv&&(t==='doc'?!!state.conv.doc:!!T(t));const lp=app.CANVAS_MOD.lastPane;return lp&&state.conv&&lp.cid===state.conv.id&&ok(lp.tid)?lp.tid:'main'};
function threadName(tid){return tid==='doc'?'The document':tid==='main'?'Main thread':'Thread “'+trunc(T(tid).title,32)+'”'}
function renderScope(){
  const box=$('#palScope');if(!state.conv){box.innerHTML='';PAL.scope='all';return}
  const opts=[['all','Everywhere'],['conv','This conversation'],['thread',threadName(PAL.stid)]];
  box.innerHTML=opts.map(([v,l])=>`<button type="button" data-pscope="${v}" class="${PAL.scope===v?'on':''}"></button>`).join('');
  [...box.children].forEach((b,i)=>{b.textContent=opts[i][1];b.title=i===2?'Search only this thread':i===1?'Search only this conversation':'Search every conversation'});
  $('#palIn').placeholder=PAL.scope==='thread'?(PAL.stid==='doc'?'Search the document…':'Search this thread…'):PAL.scope==='conv'?'Search this conversation…':'Search conversations, highlights, takeaways, documents…';
}
function setScope(v){PAL.scope=v;renderScope();runSearch();$('#palIn').focus()}
function openPalette(initial,scope,tid){
  hidePop();hideTip();PAL.marked=false;
  PAL.stid=tid||scopeTid();PAL.scope=state.conv&&scope?scope:'all';renderScope();
  const p=$('#pal');p.classList.add('show');const inp=$('#palIn');inp.value=initial||'';inp.focus();inp.setSelectionRange(inp.value.length,inp.value.length);
  $('#palFoot').textContent='';
  runSearch();
  (async()=>{
    if(io.index&&io.index.search){
      if(state.conv)await idxWrite(state.conv,state.docState&&state.docState.key===state.conv.id&&state.docState.loaded?state.docState.pages:null);
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
function convMeta(cid){return state.conv&&state.conv.id===cid?metaOf(state.conv):(state.convList.find(c=>c.id===cid)||{title:'Conversation'})}
function threadTitle(cid,tid,r){
  if(state.conv&&state.conv.id===cid){const t=T(tid);return t?(t.parent?t.title:'Main thread'):''}
  if(r&&r.bt)return r.bt;
  const p=(IDX.map.get(cid)||{e:[]}).e.find(e=>e.k==='bt'&&e.tid===tid);return p?p.x:(tid==='main'?'Main thread':'')
}
async function queryIndex(q){
  if(io.index&&io.index.search){
    return await io.index.search(q,{scope:PAL.scope,cid:state.conv?state.conv.id:'',tid:PAL.stid||''});
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
function scopeFilter(res){if(PAL.scope==='all'||!state.conv)return res;const id=state.conv.id,st=PAL.stid;return res.filter(r=>r.cid===id&&(PAL.scope==='conv'||(st==='doc'?r.k==='d':r.k!=='d'&&r.tid===st)))}
const resultKey=r=>r.cid+'|'+(r.mid||'')+'|'+r.k+'|'+(r.k==='d'?r.p:r.k==='bt'||r.k==='h'?r.tid:'');
async function searchNow(){
  const q=$('#palIn').value.trim();PAL.q=q;const box=$('#palRes');
  if(!q&&PAL.scope!=='all'){PAL.results=[];box.innerHTML=`<div class="pempty">Type to search ${PAL.scope==='thread'?(PAL.stid==='doc'?'the document':'this thread'):'this conversation'}.</div>`;return}
  if(!q){
    const items=[...state.convList.map(c=>state.conv&&c.id===state.conv.id?metaOf(state.conv):c)];if(state.conv&&!items.find(c=>c.id===state.conv.id))items.unshift(metaOf(state.conv));
    const act=items.filter(c=>!c.archived&&!c.trashed);const list=[...act.filter(c=>c.pinned),...act.filter(c=>!c.pinned).sort((a,b)=>(b.updated||0)-(a.updated||0))].slice(0,8);
    PAL.results=list.map(c=>({cid:c.id,k:'ct',tid:'main',x:c.title||'New conversation',jump:true,pinned:c.pinned}));PAL.sel=0;
    box.innerHTML=list.length?'<div class="pgrp">Pinned and recent</div>':'<div class="pempty">No conversations yet.</div>';
    PAL.results.forEach((r,i)=>box.appendChild(resultRow(r,i,[])));markSel();return;
  }
  let res;try{res=await queryIndex(q)}catch(e){box.innerHTML='<div class="pempty">Search couldn\'t load. Check your connection and try again.</div>';return}
  if(q!==PAL.q)return;
  res=scopeFilter(res);
  {const gone=new Set(state.convList.filter(c=>c.trashed).map(c=>c.id));if(state.conv&&state.conv.trashed)gone.add(state.conv.id);if(gone.size)res=res.filter(r=>!gone.has(r.cid))}   // not what's in the trash
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
  let c='var(--faint)';if(state.conv&&state.conv.id===r.cid&&r.tid&&T(r.tid)&&T(r.tid).parent)c=color(T(r.tid));
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
function fastModel(){return titleModel(state.conv||{msgs:{}},settings.model)}
/* Describe it instead is the one thing that reaches across conversations (titles; snippets if you let it pick), so it
   has its own model, picked beside it (settings.findModel). By default the quick model of the family in use, but never
   a Gemini one unless that's all there is: a free-tier Gemini key lets Google use what's sent. */
function findModel(){
  const ids=io.llm?io.llm.models().map(x=>x[0]):[];
  if(settings.findModel&&ids.includes(settings.findModel))return settings.findModel;
  const f=fastModel();if(app.MODEL_FAM(f)!=='google')return f;
  return ids.find(x=>/haiku/i.test(x))||ids.find(x=>/terra/i.test(x))||ids.find(x=>/mini|luna/i.test(x))||f;
}
function scopeTitles(){
  if(PAL.scope==='thread'&&state.conv){if(PAL.stid==='doc')return [state.conv.doc?state.conv.doc.name:'The document'];return [state.conv.title,...ancestors(PAL.stid).filter(id=>id!=='main').map(id=>T(id).title)].filter(Boolean)}   // its path: the conversation, then each thread down to this one
  if(PAL.scope==='conv'&&state.conv)return [state.conv.title,...Object.values(state.conv.threads).filter(t=>t.parent).map(t=>t.title),...(state.conv.doc?[state.conv.doc.name]:[])].filter(Boolean);
  const items=state.convList.map(c=>state.conv&&c.id===state.conv.id?metaOf(state.conv):c);if(state.conv&&!items.find(c=>c.id===state.conv.id))items.unshift(metaOf(state.conv));
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
  if(!state.conv||state.conv.id!==r.cid)await openConv(r.cid);
  if(!state.conv||state.conv.id!==r.cid)return;
  const terms=hitTerms(r);
  if(r.k==='d'){await goToPage(r.p||1);setTimeout(()=>{const el=paneEls.get('doc');if(!el)return;
    const root=el.querySelector(`.dpage[data-page="${r.p||1}"]`)||el.querySelector('.pb');showHit(root,el.querySelector('.pb'),terms,1,null,r.x)},450);return}
  if(r.k==='ct'||r.jump){if(state.conv.ui.view==='canvas')focusCard(state.conv.doc?'doc':'main');else revealPane('main');return}
  const tid=r.tid;if(!T(tid)){toast('That part of the conversation no longer exists.');return}
  if(state.conv.ui.view==='canvas'){focusCard(tid,r.mid);if(r.mid)setTimeout(()=>{const n=$('#cv').querySelector(`.cnode[data-ctid="${tid}"]`);if(!n)return;
    showHit(n.querySelector(`.cfull .msg[data-mid="${r.mid}"] .body`),n.querySelector('.cfull'),terms,contentScale(n),null,r.x)},350);return}
  if(r.k==='h'){openThread(tid);revealAnchor(tid);return}
  openThread(tid);state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==tid);layout();revealPane(tid);
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
  if(!state.conv)return;
  const scroll={};for(const [tid,el] of paneEls){const pb=el.querySelector('.pb');if(pb)scroll[tid]=pb.scrollTop}
  BACK.push({cid:state.conv.id,view:state.conv.ui.view,layout:state.conv.ui.layout,open:[...state.conv.ui.open],collapsed:[...state.conv.ui.collapsed],scroll,
    panesLeft:$('#panes').scrollLeft,panesTop:$('#panes').scrollTop,cam:{...app.cam},cvOpen:[...((state.conv.ui.cv||{}).open||[])]});
  if(BACK.length>10)BACK.shift();renderBack();
}
function renderBack(){
  const b=$('#backChip');while(BACK.length&&!(state.conv&&state.conv.id===BACK.at(-1).cid)&&!state.convList.some(c=>c.id===BACK.at(-1).cid))BACK.pop();
  if(!BACK.length){b.classList.remove('show');return}
  const s=BACK.at(-1),title=(state.conv&&state.conv.id===s.cid?state.conv.title:(state.convList.find(c=>c.id===s.cid)||{}).title)||'New conversation';
  b.querySelector('.bt').textContent=state.conv&&state.conv.id===s.cid?'Back to where you were':'Back to “'+trunc(title,40)+'”';
  b.title='Go back to where you were before the search'+(state.conv&&state.conv.id===s.cid?'':' (in “'+title+'”)');b.classList.add('show');
}
async function goBack(){
  const s=BACK.pop();renderBack();if(!s)return;clearHit();
  if(!state.conv||state.conv.id!==s.cid){await openConv(s.cid);if(!state.conv||state.conv.id!==s.cid)return}
  const ok=id=>id==='doc'?!!state.conv.doc:!!T(id);
  const open=s.open.filter(ok);if(open.length){state.conv.ui.open=open;state.conv.ui.collapsed=s.collapsed.filter(ok)}
  if(state.conv.ui.cv&&s.cvOpen)state.conv.ui.cv.open=s.cvOpen.filter(ok);
  if(s.view==='canvas'){if(state.conv.ui.view!=='canvas')setView('canvas');else renderCanvas();Object.assign(app.cam,s.cam);applyCam()}
  else{if(state.conv.ui.view==='canvas'||state.conv.ui.layout!==s.layout)setView(s.layout);else layout()}
  renderMap();save();
  const put=()=>{for(const [tid,top] of Object.entries(s.scroll)){const el=paneEls.get(tid),pb=el&&el.querySelector('.pb');if(pb)pb.scrollTop=top}$('#panes').scrollLeft=s.panesLeft;$('#panes').scrollTop=s.panesTop;wiresSoon()};
  requestAnimationFrame(put);setTimeout(put,300);   // again once the document's pages have their sizes
}
(()=>{
  const inp=$('#palIn');
  inp.addEventListener('input',()=>{clearTimeout(PAL.timer);PAL.timer=setTimeout(()=>{PAL.timer=0;runSearch()},90)});
  inp.addEventListener('keydown',e=>{
    if(e.key==='Tab'&&state.conv){e.preventDefault();const o=['all','conv','thread'],i=o.indexOf(PAL.scope);setScope(o[(i+(e.shiftKey?2:1))%3]);return}
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
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key==='.'){e.preventDefault();setZen(!app.zen)}},true);
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='b'){e.preventDefault();$('#tSide').click()}});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='k'){e.preventDefault();if($('#pal').classList.contains('show'))closePalette();else openPalette('')}},true);
  // ⌘' / Ctrl+': the canvas, or back to the panes (Columns or Rows, whichever you had); with Shift: Columns ⇄ Rows.
  // e.code, so it's the same key with or without Shift on any layout. Works while typing, like the others.
  document.addEventListener('keydown',e=>{if(!state.conv||!(e.metaKey||e.ctrlKey)||e.altKey||(e.code!=='Quote'&&e.key!=="'"))return;e.preventDefault();
    if(e.shiftKey)setView(state.conv.ui.layout==='rows'?'cols':'rows');else setView(state.conv.ui.view==='canvas'?state.conv.ui.layout:'canvas')},true);
  // ⌘\ / Ctrl+\: collapse the current pane to a strip, or expand it (on the canvas: shrink or expand the selected
  // card); with Shift: close it. See curPane.
  document.addEventListener('keydown',e=>{if(!state.conv||!(e.metaKey||e.ctrlKey)||e.altKey||(e.code!=='Backslash'&&e.key!=='\\'))return;e.preventDefault();
    if(state.conv.ui.view==='canvas'){const sel=cvState().sel,b=!e.shiftKey&&sel&&$(`#cv .cnode[data-ctid="${sel}"] [data-cact=exp]`);if(b)b.click();return}
    const tid=curPane();if(!tid)return;
    if(e.shiftKey)keyClose(tid);else{toggleCollapse(tid);markCur()}},true);
  const mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);
  document.querySelectorAll('.kmod').forEach(k=>k.textContent=mac?'⌘':'Ctrl+');
  document.querySelectorAll('.kshift').forEach(k=>k.textContent=mac?'⇧':'Shift+');
  document.querySelectorAll('.kalt').forEach(k=>k.textContent=mac?'⌥':'Alt+');
})();


  return {
    IDX, idxTouch, idxWrite, idxDelete, openPalette, closePalette, STOP, clearHit, BACK, markBack, renderBack, goBack,
  };
}
