// Generation & branching: context assembly, streaming replies, retries/versions, takeaways, and thread lifecycle.
import { trunc, plain } from './text.js';
import { textWalker, nonWs } from './anchors.js';
import {
  listSources, resumeSourceLists, DOC_TOOL_NAMES, isDocBranch, joinParts,
  appendText, buildContext as buildContextPure, cardsSuggest,
} from './context.js';
import { runId } from './connectors.js';
import {
  state, app, io, settings, CUSTOM, paneEls, msgCache, streaming, unread, newConv,
  $, ic, rid, qid, T, color, isDesc, branchesOn, hiddenNow, isCollapsed,
  } from './state.js';
import { imageBlob, blobB64, storeImages } from './media.js';
import { invalidate, onRedraw } from './redraw.js';

export function createGeneration() {
  // the parts of the page this module draws, for invalidate('…') from the others (web/js/redraw.js)
  onRedraw('badges', markReplies);
  const applyConvLlm = (...a) => app.applyConvLlm(...a);
  const cacheDocBlob = (...a) => app.cacheDocBlob(...a);
  const cardsAfterReply = (...a) => app.cardsAfterReply(...a);
  const confirmDeleteBranch = (...a) => app.confirmDeleteBranch(...a);
  const cvState = (...a) => app.cvState(...a);
  const discardBlank = (...a) => app.discardBlank(...a);
  const docReady = (...a) => app.docReady(...a);
  const docView = (...a) => app.docView(...a);
  const flushNow = (...a) => app.flushNow(...a);
  const focusCard = (...a) => app.focusCard(...a);
  const isBlank = (...a) => app.isBlank(...a);
  const leaveOk = (...a) => app.leaveOk(...a);
  const openCards = (...a) => app.openCards(...a);
  const putCard = (...a) => app.putCard(...a);
  const queueStream = (...a) => app.queueStream(...a);
  const refreshAll = (...a) => app.refreshAll(...a);
  const refreshAnchorsFor = (...a) => app.refreshAnchorsFor(...a);
  const refreshDocAnchors = (...a) => app.refreshDocAnchors(...a);
  const rememberSpot = (...a) => app.rememberSpot(...a);
  const renderPane = (...a) => app.renderPane(...a);
  const revealDocAnchor = (...a) => app.revealDocAnchor(...a);
  const runDocTool = (...a) => app.runDocTool(...a);
  const save = (...a) => app.save(...a);
  const setConv = (...a) => app.setConv(...a);
  const setStatus = (...a) => app.setStatus(...a);
  const setView = (...a) => app.setView(...a);
  const stickLlm = (...a) => app.stickLlm(...a);
  const suggestCard = (...a) => app.suggestCard(...a);
  const tabName = (...a) => app.tabName(...a);
  const toast = (...a) => app.toast(...a);
  const trailText = (...a) => app.trailText(...a);
  const updateComposer = (...a) => app.updateComposer(...a);
  const updateHeader = (...a) => app.updateHeader(...a);
/* ---------- context for the model (pure logic lives in ./context.js) ---------- */
const ctxEnv=()=>({conv:state.conv,docState:state.docState,docView,custom:CUSTOM,prompts:PROMPTS,threadOps:ThreadOps,settings,io});
function buildContext(tid,excludeMid,opts){
  const res=buildContextPure(ctxEnv(),tid,excludeMid,{captureSources:true,...opts});
  app.DOC_MOD.lastDocSeen=res.docSeen;
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
  const back=Object.values(state.conv.threads).filter(t=>t.parent===tid&&joinable(t));
  state.conv.msgs[m.id]=m;state.conv.order[tid].push(m.id);
  if(back.length)setTimeout(()=>{for(const t of back)if(T(t.id))renderPane(t.id);if(state.conv.ui.view==='canvas')invalidate('canvas')});
  return m;
}
async function send(tid,text,imgs){
  text=(text||'').trim();imgs=imgs||[];if(!text&&!imgs.length)return;
  if(streaming.has(tid)){toast('Wait for the current reply to finish');return}
  const c0=state.conv,t=T(tid);if(!c0||!t)return;
  let extra;
  if(imgs.length){
    streaming.set(tid,{mid:null,ctrl:new AbortController(),conv:c0});
    try{extra={images:await storeImages(imgs)}}
    finally{streaming.delete(tid);for(const im of imgs)if(im&&im.url)try{URL.revokeObjectURL(im.url)}catch(_){}}
    if(state.conv!==c0||!c0.threads[tid])return;
  }
  if(tid==='main'&&!state.conv.titleKept&&!state.conv.order.main.some(id=>state.conv.msgs[id].role==='user')){state.conv.title=trunc(text||'Question about an image',120);delete state.conv.autoTitle;invalidate('title')}
  if(t.autoTitle&&!state.conv.order[tid].length){t.title=trunc(text||'About an image',48);delete t.autoTitle;refreshAnchorsFor(tid)}
  // asked in main with the PDF open beside it: the question keeps the page it was asked on (PROMPTS.lookingAt)
  if(tid==='main'&&state.docState&&state.docState.kind==='pdf'&&state.conv.ui.open.includes('doc')&&!isCollapsed('doc')&&docView.current)extra={...extra,lookAt:docView.current};
  addMsg(tid,'user',text,extra);
  const am=addMsg(tid,'assistant','');am.pending=true;
  renderPane(tid,true);invalidate('map');save();
  if(state.conv.ui.view==='canvas'){invalidate('canvas');const f=document.querySelector(`#cv .cnode[data-ctid="${tid}"] .cfull`);if(f)f.scrollTop=f.scrollHeight}
  await docReady();
  if(state.conv!==c0||!c0.threads[tid])return;
  await generate(am,buildContext(tid,am.id),tid);
}
// Writes reply m. The reply runs on the server as run m.run (server/runs.mjs), saved with the message while
// it's being written, so it survives this page losing its connection, switching conversation or reloading
// (resumeRuns picks it up again), and the server writes it in itself if nobody comes back.
// o.resume: reconnect to m.run instead of asking. o.prefix: text it carries on from (Continue).
async function generate(m,ctx,lockTid,o={}){
  const ctrl=new AbortController(),run=o.resume?m.run:runId(),st={mid:m.id,ctrl,run,conv:state.conv};
  streaming.set(lockTid,st);updateComposer(lockTid);markReplies();let tick=0;
  const prefix=o.prefix||'';
  try{
    if(!io.llm)await io.ready;
    let web=!!m.web,sendModel=settings.model,sendEffort=settings.effort;
    const targetConvId=st.conv.id;
    if(!o.resume){
      web=!!(settings.web&&io.llm.supportsWeb);if(web)m.web=true;else delete m.web;delete m.searches;delete m.sources;delete m.reads;delete m.toolNow;delete m.cut;
      applyConvLlm(m.thread,true);   // the model this thread asks with (the picker follows it)
      sendModel=settings.model;sendEffort=settings.effort;   // capture before async save / context prep
      if(io.llm.supportsEffort)m.effort=sendEffort;else delete m.effort;
      stickLlm(m.thread,false);   // a thread keeps the model it started with
      if(ctx.docSeen)m.docSeen=ctx.docSeen;else delete m.docSeen;
      if(ctx.sourceLists?.length)m.runSourceIds=ctx.sourceLists.map(s=>s.id);
      else delete m.runSourceIds;
      m.run=run;save();await flushNow();   // saved with its run first, so the server can finish it into this message
    }
    // m.live: what it has done so far, shown while it works (not saved: generate drops it when done)
    m.live=[];m.t0=m.t0||Date.now();tick=setInterval(()=>queueStream(m.id),1000);
    const step=(icon,text,done)=>{const l=m.live[m.live.length-1];if(l)l.done=true;m.live.push({icon,text,done});queueStream(m.id)};
    const toolText=(name,input)=>name==='list_sources'?'checked saved web references':name==='suggest_card'?`suggested a flashcard: “${trunc(String(input.front||''),60)}”`:trailText(name==='search'?{t:'search',q:[].concat(input.queries!=null?input.queries:input.query||'').map(String).join('”, “')}:name==='read_pages'?{t:'read',a:input.from,b:input.to||input.from}:{t:'view',p:input.page});
    let nCards=0;
    const trail=[...(o.resume&&m.reads||[])],tools=ctx.tools?{names:ctx.tools,run:async(name,input)=>{   // the model reading the document or suggesting a card: run the call here, show what it's doing
      if(name==='list_sources')return listSources(ctx.sourceLists,input);
      if(name==='suggest_card'){try{const r=await suggestCard(st.conv,m,input);if(!r.error)nCards++;return r}finally{const l=m.live[m.live.length-1];if(l)l.done=true;queueStream(m.id)}}
      try{await docReady();return await runDocTool(name,input,trail,targetConvId)}finally{m.reads=[...trail];const l=m.live[m.live.length-1];if(l)l.done=true;queueStream(m.id)}}}:undefined;
    let nq=0;
    const keepSearch=(x)=>{if(x.searches&&x.searches.length){m.searches=[...x.searches];for(;nq<x.searches.length;nq++)step('globe',`searched the web for “${x.searches[nq]}”`,false)}if(x.sources&&x.sources.length)m.sources=x.sources.slice(0,30)};
    const onTool=(call,done)=>step(call.name==='suggest_card'?'cards':'doc',toolText(call.name,call.input||{}),done);
    const onText=(text)=>{m.content=prefix+text;const l=m.live[m.live.length-1];if(l)l.done=true;queueStream(m.id)};
    let r;
    if(o.resume)r=await io.llm.complete({resume:true,run,signal:ctrl.signal,onText,onSearch:(x)=>{keepSearch(x);queueStream(m.id)},onTool,tools});
    else{
      const rc=await resolveContext(ctx,!!io.llm.supportsImages);
      if(rc.skipped)toast('This connection can’t send images, so the AI only gets a note where each image was.');
      r=await io.llm.complete({system:rc.system,messages:rc.messages,model:sendModel,effort:sendEffort,web,signal:ctrl.signal,run,save:{conv:targetConvId,msg:m.id},
        onText,onSearch:(x)=>{keepSearch(x);queueStream(m.id)},onTool,tools});
    }
    m.content=prefix+r.text;if(r.model)m.model=r.model;if(r.usage)m.usage=r.usage;keepSearch(r);
    if(nCards){const c0=st.conv;toast(`The AI suggested ${nCards} flashcard${nCards>1?'s':''}: ${nCards>1?'they’re':'it’s'} in your inbox`,{label:'Open',fn:()=>{if(state.conv===c0)openCards(c0.id,'inbox')}})}
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
  if(state.conv!==st.conv)return;
  delete m.pending;delete m.run;delete m.runFrom;delete m.runSourceIds;delete m.toolNow;delete m.live;delete m.t0;if(m.reads&&!m.reads.length)delete m.reads;m.ver++;streaming.delete(lockTid);
  if(!seenNow(m.thread))unread.add(m.thread);   // finished out of sight: badge it until it's opened
  if(document.hidden&&!m.error){app.CANVAS_MOD.tabReady=true;tabName()}
  cardsAfterReply(m);nameAfterReply(m);
  renderPane(m.thread);updateComposer(lockTid);invalidate('map');save();
  if(state.conv.ui.view==='canvas')invalidate('canvas');
  markReplies();
}
// --- titles: a conversation or branch is named by its first question; a long or vague one gets a short title from
// a fast model once its first reply ends. Never over a title you set (titleKept) or one that's no longer the question.
const MODEL_FAM=(id)=>/claude|haiku|sonnet|opus/i.test(id||'')?'claude':/gpt|^o\d/i.test(id||'')?'gpt':/^gemini/i.test(id||'')?'google':null;
// the fast model of the family this conversation uses (Haiku or Terra): the one family its replies came from, else its
// kept model's, else the reply's; with only one provider connected, that one
function titleModel(c,hint){
  const ids=io.llm.models().map(x=>x[0]),fast={claude:ids.find(x=>/haiku/i.test(x)),gpt:ids.find(x=>/terra/i.test(x))||ids.find(x=>/mini|luna/i.test(x)),google:ids.find(x=>/^gemini.*flash-lite/i.test(x))||ids.find(x=>/^gemini.*flash/i.test(x))};
  const avail=Object.keys(fast).filter(k=>fast[k]);
  // Bind to the provider of the triggering reply/selection; never route content across providers.
  const hf=MODEL_FAM(hint);
  if(hf)return fast[hf]||hint;
  if(!avail.length)return hint||settings.model;
  const used=new Set(Object.values((c&&c.msgs)||{}).filter(m=>m.role==='assistant'&&m.model).map(m=>MODEL_FAM(m.model)).filter(Boolean));
  const f=used.size===1?[...used][0]:MODEL_FAM(c&&c.llm&&c.llm[0])||MODEL_FAM(io.llm.defaultModel);
  if(f)return fast[f]||hint||settings.model;
  return fast[avail[0]]||hint||settings.model;
}
const qText=(m)=>String((m&&(m.content||m.text))||'').replace(/\s+/g,' ').trim();
// the question names it well enough as it is: short and more than a word or two
const goodAsTitle=(q,max)=>q.length<=max&&q.split(' ').length>=3;
async function nameAfterReply(m){
  if(!m||m.error||!io.llm||!io.llm.models||io.offline)return;
  const c0=state.conv,tid=m.thread,t=T(tid);if(!t||t.alt)return;
  const ord=c0.order[tid]||[],q=c0.msgs[ord.find(id=>c0.msgs[id].role==='user')];
  if(!q||ord.find(id=>c0.msgs[id].role==='assistant')!==m.id)return;   // only after a thread's first reply
  const question=qText(q);if(!question)return;
  const isMain=tid==='main',limit=isMain?120:48,cur=()=>isMain?c0.title:T(tid)&&T(tid).title;
  const was=trunc(q.content||(isMain?'Question about an image':'About an image'),limit);
  const still=()=>state.conv===c0&&(isMain?!c0.titleKept:!(T(tid)||{}).titleKept)&&cur()===was;
  if(!still()||goodAsTitle(question,isMain?50:48))return;
  try{
    const r=await io.llm.complete({system:PROMPTS.title.system,messages:[{role:'user',content:PROMPTS.title.ask({kind:isMain?'conversation':'branch',question:trunc(question,600),reply:trunc(plain(m.content||''),1500),passage:isMain?'':trunc(t.regionText||t.anchorText||'',300),doc:c0.doc&&c0.doc.name})}],model:titleModel(c0,m.model),effort:'low',web:false});
    const name=cleanTitle(r.text);if(!name||!still())return;
    if(isMain){c0.title=name;delete c0.autoTitle;invalidate('title')}else{T(tid).title=name;delete T(tid).autoTitle;refreshAnchorsFor(tid);updateHeader(tid)}
    invalidate('map');if(state.conv.ui.view==='canvas')invalidate('canvas');save();
  }catch(e){console.warn('no title',e)}
}
const cleanTitle=(s)=>{let x=String(s||'').split('\n').map(l=>l.trim()).find(Boolean)||'';x=x.replace(/^(title:\s*)/i,'').replace(/^["'“”‘’*#\s]+|["'“”‘’*.\s]+$/g,'');return x.length>=2&&x.length<=80?x:''};
// Stop: tell the server to stop the model, and stop reading
function stopReply(s){if(!s)return;s.stopped=true;if(s.run&&io.llm&&io.llm.stop)io.llm.stop(s.run);s.ctrl.abort()}
// replies saved as still being written (m.run): from this page before a reload, or from another device.
// Reconnect to each; the server replays it from the start and goes on with it.
function resumeRuns(){
  for(const m of Object.values(state.conv.msgs)){
    if(!m.run||m.role!=='assistant'||[...streaming.values()].some(s=>s.mid===m.id))continue;
    if(streaming.has(m.thread))continue;
    const prefix=(m.content||'').slice(0,m.runFrom||0);m.content=prefix;m.pending=true;m.ver++;
    const names=io.llm&&io.llm.supportsTools?[...(state.conv.doc?DOC_TOOL_NAMES:[]),...(cardsSuggest(state.conv)?['suggest_card']:[])]:[];
    let sourceLists;
    if(Array.isArray(m.runSourceIds)&&m.runSourceIds.length){
      names.push('list_sources');
      const current=buildContext(m.thread,m.id).sourceLists || [];
      // Keep the original handles on reconnect. A deleted or off-path list must fail lookup.
      sourceLists=resumeSourceLists(m.runSourceIds,current);
    }
    generate(m,{sourceLists,tools:names.length?names:false},m.thread,{resume:true,prefix});
  }
}
// a reply that was cut off: ask the model to carry on from where it stopped
async function continueReply(mid){
  const m=state.conv.msgs[mid];if(!m||m.role!=='assistant'||streaming.has(m.thread))return;
  if(retryBlock(mid)){const q=questionOf(mid);if(q)newVersion(q.id,q.content);return}
  const before=m.content||'';delete m.cut;delete m.error;m.pending=true;m.runFrom=before.length;m.ver++;renderPane(m.thread);
  await docReady();
  const ctx=buildContext(m.thread,m.id);
  ctx.messages.push({role:'assistant',content:before},{role:'user',content:PROMPTS.continueCut});
  await generate(m,ctx,m.thread,{prefix:before});
}
function retry(mid){
  const m=state.conv.msgs[mid];if(!m||streaming.has(m.thread))return;
  // a reply the conversation went on from (or that has branches or cards) isn't replaced: ask again as another version
  if(m.role==='assistant'&&retryBlock(mid)){const q=questionOf(mid);if(q)newVersion(q.id,q.content);return}
  if(m.role==='note'){m.thread&&delete state.conv.msgs[mid];state.conv.order[m.thread]=state.conv.order[m.thread].filter(x=>x!==mid);bringBack(m.fromThread,m.focus||'');return}
  m.content='';delete m.error;m.pending=true;m.ver++;renderPane(m.thread);generate(m,buildContext(m.thread,m.id),m.thread);
}
/* Redo and Edit (the simple case): replace the latest reply in a thread, or change the question before it,
   only while nothing depends on that reply: it's the thread's last message, no branch starts from it and no
   flashcard was drafted from it. Anything else would leave branches or cards pointing at text that's gone. */
function redoBlock(mid){   // why this reply can't be redone in place, or '' if it can
  const m=state.conv.msgs[mid];if(!m||m.role!=='assistant'||m.pending)return 'busy';
  if(streaming.has(m.thread))return 'busy';
  const ord=state.conv.order[m.thread];if(ord[ord.length-1]!==mid)return 'later';
  if(branchesOn(mid).length)return 'branches';
  for(const c of app.CARDS.values())if(c.conv===state.conv.id&&c.at&&c.at.msg===mid)return 'cards';
  return '';
}
// Retry and Continue change a reply in place too, so the same rule: not once anything builds on it
function retryBlock(mid){const m=state.conv.msgs[mid];if(!m||m.role!=='assistant')return '';const t=m.pending;m.pending=false;const w=redoBlock(mid);m.pending=t;return w==='busy'?'':w}
const REDO_WHY={keep:'the answer you have is kept',later:'the conversation has gone on after it',branches:'branches start from it',cards:'flashcards were drafted from it',busy:'a reply is being written'};
function questionOf(mid){const m=state.conv.msgs[mid],ord=state.conv.order[m.thread],i=ord.indexOf(mid);for(let k=i-1;k>=0;k--){const q=state.conv.msgs[ord[k]];if(q&&q.role==='user')return q;if(q&&q.role==='assistant')return null}return null}
// the reply to a question, if it's right after it
function replyTo(qid){const q=state.conv.msgs[qid],ord=state.conv.order[q.thread],n=state.conv.msgs[ord[ord.indexOf(qid)+1]];return n&&n.role==='assistant'?n:null}
/* Edit and Redo never replace an answer: with one there, they ask again in a new branch that starts just before the
   question (newVersion), beside the original, which stays as it was: the same anywhere in a thread, the last question
   included. Only a reply that failed or never came (an error, nothing written) is replaced in
   place, since there's nothing to keep. (Retry and Continue keep their own rule: retryBlock.) */
const hasAnswer=(m)=>!!m&&m.role==='assistant'&&!m.error&&!!String(m.content||'').trim();
const redoKeep=(mid)=>redoBlock(mid)||(hasAnswer(state.conv.msgs[mid])?'keep':'');
const editKeep=(qid)=>{const w=editBlock(qid);if(w)return w;const r=replyTo(qid);return r&&hasAnswer(r)?'keep':''};
function editBlock(qid){   // why this question can't be edited in place, or ''
  const q=state.conv.msgs[qid];if(!q||q.role!=='user')return 'busy';if(streaming.has(q.thread))return 'busy';
  const ord=state.conv.order[q.thread],r=replyTo(qid),last=r?r.id:qid;
  if(ord[ord.length-1]!==last)return 'later';
  return r?redoBlock(r.id):'';
}
/* Another version: when a reply can't be replaced in place, Redo and Edit ask again in a new thread that
   starts where the question did (threads.js: an 'alt' thread, no side-question prefix). Nothing that was
   there changes. "Use this version" (ThreadOps.swap) makes it the one the conversation goes on with. */
// the question's versions: [{tid, qid}] for every thread that asks it from the same starting point
function versionsOf(qid){
  const q=state.conv.msgs[qid];if(!q||q.role!=='user')return [];
  const t=T(q.thread),ord=state.conv.order[q.thread],i=ord.indexOf(qid);
  let base=q.thread,anchor=i?ord[i-1]:'START';
  if(i===0&&t.alt){base=t.parent;anchor=t.anchorMsg}
  if(i===0&&!t.alt&&t.parent)return [];   // the first question of a side branch has no versions
  const out=[],bo=state.conv.order[base],j=anchor==='START'?0:bo.indexOf(anchor)+1;
  if(j>=0&&bo[j]&&state.conv.msgs[bo[j]].role==='user')out.push({tid:base,qid:bo[j]});
  for(const x of Object.values(state.conv.threads))if(x.alt&&x.parent===base&&x.anchorMsg===anchor&&state.conv.order[x.id].length)out.push({tid:x.id,qid:state.conv.order[x.id][0]});
  return out;
}
function openVersions(qid){
  const q=state.conv.msgs[qid];if(!q)return;
  for(const v of versionsOf(qid))if(v.tid!==q.thread)openThread(v.tid,q.thread);
  const base=versionsOf(qid).find(v=>!T(v.tid).alt||v.tid===T(q.thread).parent);
  if(base&&base.tid!==q.thread)revealMsg(base.tid,base.qid);
  invalidate('map');save();
}
async function newVersion(qid,text){
  const q=state.conv.msgs[qid],t=T(q.thread),ord=state.conv.order[q.thread],i=ord.indexOf(qid);
  text=(text||'').trim();if(!text&&!(q.images&&q.images.length))return;
  let x;
  if(i===0&&ThreadOps.prefixed(t)){   // the first question of a side branch: ask it again as a new side branch about the same passage
    x={...t,id:'t'+rid(),created:Date.now(),colorIdx:state.conv.nextColor++};for(const k of ['pinned','resolved','hidden','autoTitle'])delete x[k];
  }else{
    let parent=q.thread,anchor=i?ord[i-1]:'START';
    if(i===0&&t.alt){parent=t.parent;anchor=t.anchorMsg}   // a version of a version starts where both do
    x={id:'t'+rid(),parent,anchorMsg:anchor,anchorText:'',alt:true,created:Date.now(),colorIdx:state.conv.nextColor++,title:'↻ '+trunc(text||'Another version',46)};
  }
  state.conv.threads[x.id]=x;state.conv.order[x.id]=[];
  addMsg(x.id,'user',text,q.images&&q.images.length?{images:q.images}:undefined);
  const am=addMsg(x.id,'assistant','');am.pending=true;
  q.ver++;renderPane(q.thread);openThread(x.id,q.thread);invalidate('map');save();
  if(state.conv.ui.view==='canvas'){const S=cvState();if(!S.open.includes(x.id))S.open.push(x.id);invalidate('canvas');focusCard(x.id)}
  await docReady();
  await generate(am,buildContext(x.id,am.id),x.id);
}
function useVersion(tid){
  const t=T(tid);if(!t||!t.alt)return;
  if(joinable(t))return moveBack(tid);   // nothing on the parent's side to trade: swapping would leave an empty version
  if(streaming.has(tid)||streaming.has(t.parent)){toast('Wait for the reply to finish');return}
  const firstQ=(id)=>state.conv.order[id].find(x=>state.conv.msgs[x].role==='user');
  const oldFirst=t.parent==='main'?firstQ('main'):null;
  let changed;try{changed=ThreadOps.swap(state.conv,[...app.CARDS.values()],tid)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  // a title that came from the first question follows the version now in use
  if(t.parent==='main'&&!state.conv.titleKept&&oldFirst&&state.conv.title===trunc(state.conv.msgs[oldFirst].content||'Question about an image',120)){const q=state.conv.msgs[firstQ('main')];state.conv.title=trunc(q.content||'Question about an image',120);invalidate('title')}
  const newQ=state.conv.msgs[state.conv.order[tid][0]];if(newQ&&newQ.role==='user')t.title='↻ '+trunc(newQ.content||'Another version',46);
  for(const id of [t.parent,tid])for(const m of state.conv.order[id])state.conv.msgs[m].ver++;
  refreshAll();if(state.conv.ui.view==='canvas')focusCard(t.parent);else revealPane(t.parent);
  setStatus('Now using this version; the other one is in “'+t.title+'”');
  // the old version is now that branch: one click to drop it (the usual delete, which asks about its cards)
  toast('Now using this version. The old one is in its own branch.',{label:'Delete the old version',fn:()=>{if(T(tid))confirmDeleteBranch(tid)}});
}
async function redo(mid){
  const why=redoKeep(mid);
  if(why){const q=questionOf(mid);if(why==='busy'||!q){toast(`This reply can’t be redone: ${REDO_WHY[why]}.`);return}return newVersion(q.id,q.content)}
  const m=state.conv.msgs[mid];
  m.content='';for(const k of ['error','model','effort','usage','docSeen','reads','searches','sources','web'])delete m[k];
  m.pending=true;m.ver++;renderPane(m.thread);invalidate('map');
  await docReady();
  await generate(m,buildContext(m.thread,m.id),m.thread);
}
/* Start main over (document conversations): main's messages move into another version of it (ThreadOps.split
   before its first message: an 'alt' thread from START), so main is empty and the next question starts from just
   the document. Branches, takeaways and cards go with the messages they came from. Undo joins it back
   (ThreadOps.join, while main is still empty); later, "Use this version" swaps it back. */
async function startMainOver(){
  const ord=state.conv.order.main;if(!ord.length)return;
  if(streaming.size){toast('Wait for the reply to finish');return}
  const first=ord.find(id=>state.conv.msgs[id].role==='user'),fq=first?state.conv.msgs[first].content:'';
  const fresh={id:'t'+rid(),created:Date.now(),colorIdx:state.conv.nextColor++,anchorText:'',title:fq?'Earlier main · '+trunc(fq,40):'Earlier main thread'};
  let changed;try{changed=ThreadOps.split(state.conv,[...app.CARDS.values()],'main',ord[0],fresh)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  const oldTitle=state.conv.title,named=!state.conv.titleKept&&first&&state.conv.title===trunc(fq||'Question about an image',120);
  if(named){state.conv.title=state.conv.doc?state.conv.doc.name:'New conversation';invalidate('title')}   // the next first question names it again
  state.conv.ui.open=state.conv.ui.open.filter(x=>x!==fresh.id);if(!state.conv.ui.open.includes('main'))state.conv.ui.open.push('main');
  refreshAll();invalidate('map');invalidate('conv-list');save();revealPane('main');
  const ta=paneEls.get('main')&&paneEls.get('main').querySelector('textarea');if(ta)ta.focus();
  toast('Started the main thread over. What was in it is now another version, under Branches.',{label:'Undo',fn:()=>{
    if(state.conv.order.main.length){toast('Main has gone on since: open the earlier version and use “Use this version”.');return}
    let ch;try{ch=ThreadOps.join(state.conv,[...app.CARDS.values()],fresh.id)}catch(e){toast(e.message);return}
    for(const c of ch)putCard(c);if(named)state.conv.title=oldTitle;invalidate('title');refreshAll();invalidate('map');invalidate('conv-list');save();
  }});
}
/* Move what follows a reply into a branch (the reply's ⋯): ThreadOps.split just after it, so the rest becomes
   another version starting there, each message seeing exactly what it saw before; the thread ends at the reply and
   the next question goes on from it. Until the thread goes on, the moved part shows as a chip under the reply
   (movedOn); deleting that branch is rewinding. Undo joins it back while the thread still ends there. */
const movedOn=(mid)=>{const m=state.conv.msgs[mid];if(!m)return [];const ord=state.conv.order[m.thread]||[];if(ord[ord.length-1]!==mid)return [];
  return Object.values(state.conv.threads).filter(t=>t.alt&&t.parent===m.thread&&t.anchorMsg===mid&&!hiddenNow(t.id))};
// a version whose parent stops right where it starts: what followed there was moved out (or main was started
// over), so it can simply go back (ThreadOps.join). "Use this version" would swap in an empty side and leave an
// empty version behind.
const joinable=(t)=>{if(!t||!t.alt||!T(t.parent))return false;const o=state.conv.order[t.parent]||[];return t.anchorMsg===(o.length?o[o.length-1]:'START')};
// the message of its parent a version starts after, quoted for its header and first card; null when it starts at the start
function versionAfter(t,n){
  if(t.anchorMsg==='START')return null;
  const m=state.conv.msgs[t.anchorMsg];if(!m)return 'an earlier message';
  const s=trunc(plain(m.content).replace(/\s+/g,' ').trim(),n);
  return s?(m.role==='note'?'the takeaway “'+s+'”':'“'+s+'”'):(m.role==='user'?'a question about an image':'a reply');
}
const versionWhere=(t,n)=>{const a=versionAfter(t,n);return a?'after '+a:'from the start'};
// a version made here opens beside its parent (a card on the canvas); one joined back is gone from view
function showVersion(tid,parent){
  openThread(tid,parent);
  if(state.conv.ui.view==='canvas'){const S=cvState();if(!S.open.includes(tid))S.open.push(tid);invalidate('canvas');focusCard(tid)}
}
function dropJoined(tid,parent){
  const ui=state.conv.ui;delete (ui.sizes||{})[tid];
  if(!ui.open.length)ui.open=[parent];ui.collapsed=ui.collapsed.filter(x=>ui.open.includes(x));
  if(!ui.open.some(x=>!isCollapsed(x)))ui.collapsed=[];
  invalidate('panes');
}
// Move back: a moved-out version goes back onto the end of its parent and the branch goes away. Undo moves it out again.
function moveBack(tid){
  const t=T(tid);if(!joinable(t))return;
  if(streaming.has(tid)||streaming.has(t.parent)){toast('Wait for the reply to finish');return}
  const keep={...t},ids=[...state.conv.order[tid]],parent=t.parent,pn=parent==='main'?'the main thread':'“'+T(parent).title+'”';
  let changed;try{changed=ThreadOps.join(state.conv,[...app.CARDS.values()],tid)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  for(const m of ids)state.conv.msgs[m].ver++;
  dropJoined(tid,parent);refreshAll();invalidate('conv-list');if(state.conv.ui.view==='canvas')focusCard(parent);else revealPane(parent);
  if(!ids.length){toast('Removed the empty branch.');return}
  toast(`Moved back into ${pn}.`,{label:'Undo',fn:()=>{
    const o=state.conv.order[parent]||[];
    if(T(keep.id)||o.length<ids.length||o.slice(-ids.length).join()!==ids.join()){toast(`${pn[0].toUpperCase()+pn.slice(1)} has changed since, so this can’t be undone.`);return}
    let ch;try{ch=ThreadOps.split(state.conv,[...app.CARDS.values()],parent,ids[0],keep)}catch(e){toast(e.message);return}
    for(const c of ch)putCard(c);for(const m of ids)state.conv.msgs[m].ver++;refreshAll();invalidate('conv-list');showVersion(keep.id,parent);
  }});
}
function replyMenuItems(m){
  const ord=state.conv.order[m.thread]||[],i=ord.indexOf(m.id);
  return m.role==='assistant'&&!m.pending&&i>=0&&i<ord.length-1?['moverest']:[];
}
function openReplyMenu(btn,mid){
  let menu=$('#replyMenu');if(!menu){menu=document.createElement('div');menu.className='thmenu';menu.id='replyMenu';menu.setAttribute('role','menu');document.body.appendChild(menu);
    document.addEventListener('pointerdown',e=>{if(menu.classList.contains('open')&&!menu.contains(e.target)&&!e.target.closest('[data-act=rmore]'))menu.classList.remove('open')},true);
    menu.onclick=(e)=>{const b=e.target.closest('[data-rm]');if(!b)return;menu.classList.remove('open');if(b.dataset.rm==='moverest')moveRestOut(menu.dataset.mid)}}
  if(menu.classList.contains('open')&&menu.dataset.mid===mid){menu.classList.remove('open');return}
  const m=state.conv.msgs[mid];if(!m)return;menu.dataset.mid=mid;
  const n=state.conv.order[m.thread].length-state.conv.order[m.thread].indexOf(mid)-1;
  menu.innerHTML=`<button data-rm="moverest" title="The ${n} message${n>1?'s':''} after this reply move into a branch of their own, as they are. This thread then goes on from here.">${ic('branch')}Move what follows into a branch</button>`;
  menu.classList.add('open');const r=btn.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,r.left))+'px';
  menu.style.top=(r.bottom+4+menu.offsetHeight<=innerHeight-8?r.bottom+4:Math.max(8,r.top-4-menu.offsetHeight))+'px';
  menu.querySelector('button').focus();
}
const closeReplyMenu=()=>{const m=$('#replyMenu');if(m&&m.classList.contains('open')){m.classList.remove('open');return true}return false};
function moveRestOut(mid){
  const m=state.conv.msgs[mid];if(!m)return;const tid=m.thread,ord=state.conv.order[tid],i=ord.indexOf(mid);
  if(i<0||i===ord.length-1)return;
  const tail=ord.slice(i+1);
  if(tail.some(id=>state.conv.msgs[id].pending)){toast('Wait for the reply to finish');return}
  const q=tail.map(id=>state.conv.msgs[id]).find(x=>x.role==='user');
  const fresh={id:'t'+rid(),created:Date.now(),colorIdx:state.conv.nextColor++,anchorText:'',title:q?trunc(q.content||'Question about an image',60):'Moved from '+T(tid).title};
  let changed;try{changed=ThreadOps.split(state.conv,[...app.CARDS.values()],tid,tail[0],fresh)}catch(e){toast(e.message);return}
  for(const c of changed)putCard(c);
  refreshAll();invalidate('conv-list');showVersion(fresh.id,tid);
  toast(`Moved ${tail.length} message${tail.length>1?'s':''} into a branch, opened beside this one. This thread goes on from that reply; the branch’s Move back puts them back.`,{label:'Undo',fn:()=>{
    if(!T(fresh.id))return;
    let ch;try{ch=ThreadOps.join(state.conv,[...app.CARDS.values()],fresh.id)}catch(e){toast('This thread has gone on since, so it can’t be undone. The moved part is still a branch.');return}
    for(const c of ch)putCard(c);dropJoined(fresh.id,tid);refreshAll();invalidate('conv-list');
  }});
}
/* New conversation from this document: the same file (the same stored asset; a file goes only when nothing uses it),
   nothing else. The reading mark stays with the old one. */
async function newFromDoc(){
  if(!state.conv.doc)return;
  if(!await leaveOk())return;
  const src=state.conv,c=newConv(),d=JSON.parse(JSON.stringify(src.doc));delete d.mark;
  c.doc=d;c.ui.open=['doc','main'];
  if(src.titleKept){c.title=src.title;c.titleKept=true}else{c.title=d.name||'New conversation';if(d.kind==='pdf')c.autoTitle=c.title}
  const data=app.docBlobCache.get(src.id);if(data!=null)cacheDocBlob(c.id,data);
  setConv(c);state.dirty=true;save();
  toast('A new conversation on the same document. The other one is still in the sidebar.');
}
async function saveEdit(qid,text){
  const why=editKeep(qid);if(why==='busy'){toast(`This question can’t be edited now: ${REDO_WHY[why]}.`);return false}
  if(why){if(!(text||'').trim()&&!(state.conv.msgs[qid].images||[]).length)return false;newVersion(qid,text);return false}
  const q=state.conv.msgs[qid],tid=q.thread,t=T(tid),old=q.content||'';text=(text||'').trim();
  if(!text&&!(q.images&&q.images.length))return false;
  q.content=text;q.ver++;
  // a title that came from this question follows it
  if(tid==='main'&&!state.conv.titleKept&&state.conv.order.main.find(id=>state.conv.msgs[id].role==='user')===qid&&state.conv.title===trunc(old||'Question about an image',120)){state.conv.title=trunc(text||'Question about an image',120);invalidate('title')}
  if(t.parent&&state.conv.order[tid].find(id=>state.conv.msgs[id].role==='user')===qid&&t.title===trunc(old||'About an image',48)){t.title=trunc(text||'About an image',48);refreshAnchorsFor(tid);updateHeader(tid)}
  let r=replyTo(qid);
  if(!r){r=addMsg(tid,'assistant','');r.pending=true;renderPane(tid);save();await docReady();await generate(r,buildContext(tid,r.id),tid);return true}
  await redo(r.id);return true;
}
function startEdit(el,qid){
  const q=state.conv.msgs[qid];const why=editKeep(qid);if(why==='busy'){toast(`This question can’t be edited now: ${REDO_WHY[why]}.`);return}
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
  const o=(state.conv.order[n.fromThread]||[]).filter(id=>state.conv.msgs[id]);
  if(n.upTo&&o.includes(n.upTo))return n.upTo;
  let cut=null;for(const id of o)if((state.conv.msgs[id].ts||0)<=(n.ts||0))cut=id;return cut;
}
function takeawayCuts(tid){   // message id -> the takeaways that stop after it, only where the branch goes on below
  const out=new Map(),o=(state.conv.order[tid]||[]).filter(id=>state.conv.msgs[id]);if(!o.length)return out;
  for(const n of Object.values(state.conv.msgs)){
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
  const n=state.conv.msgs[noteId];if(!n)return;
  if(state.conv.ui.view==='canvas'){focusCard(n.thread,n.id);flashMsgIn(n.thread,n.id);return}
  openThread(n.thread);revealMsg(n.thread,n.id);
}
function goToTakeawaySource(noteId){   // from a takeaway's header to the last reply it saw, in its branch
  const n=state.conv.msgs[noteId];if(!n||!T(n.fromThread))return;const cut=takeawayCut(n);
  if(state.conv.ui.view==='canvas'){focusCard(n.fromThread,cut||undefined);if(cut)flashMsgIn(n.fromThread,cut);return}
  openThread(n.fromThread);if(cut)revealMsg(n.fromThread,cut);
}
function flashMsgIn(tid,mid){   // on the canvas, once focusCard has opened the card and scrolled it
  requestAnimationFrame(()=>{const m=$('#cv').querySelector(`.cnode[data-ctid="${tid}"] .cfull .msg[data-mid="${mid}"]`);if(!m)return;
    m.style.setProperty('--c',color(T(tid)));m.classList.remove('flash');void m.offsetWidth;m.classList.add('flash')});
}
async function bringBack(tid,focus){
  const t=T(tid);if(!t||!t.parent)return;
  if(!state.conv.order[tid].some(id=>state.conv.msgs[id].role==='assistant'&&state.conv.msgs[id].content)){toast('Ask something in this branch first');return}
  const parent=t.parent;
  if(streaming.has(parent)){toast('Wait for the parent thread to finish replying');return}
  await docReady();
  const ctx=buildContext(tid);
  const ask=PROMPTS.takeawayAsk(focus);
  const msgs=ctx.messages,last=msgs[msgs.length-1];if(last&&last.role==='user')appendText(last,'\n\n'+ask);else msgs.push({role:'user',content:ask});
  const upTo=(state.conv.order[tid]||[]).filter(id=>state.conv.msgs[id]).at(-1);   // the last message this takeaway sees (takeawayCut)
  const note=addMsg(parent,'note','',{fromThread:tid,focus,upTo});note.pending=true;
  if(!state.conv.ui.open.includes(parent))openThread(parent);
  state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==parent);invalidate('panes');
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
  const isDoc=mid==='DOC';const m=isDoc?null:state.conv.msgs[mid];const parent=isDoc?'main':m.thread;
  const t={id:'t'+rid(),parent,anchorMsg:mid,anchorText:anchorText||'',created:Date.now(),colorIdx:state.conv.nextColor++};
  if(anchorText&&range)t.anchorRange=range;
  if(isDoc)t.anchorPage=page||0;
  if(isDoc&&range&&img&&img.end&&img.end.page>t.anchorPage)t.anchorEnd={page:img.end.page,e:img.end.e,...(img.end.s>0?{s:img.end.s}:{})};   // runs on to a later page (from s on it, when a header comes first)
  const r4=(v)=>Math.round(v*1e4)/1e4;
  if(isDoc&&img&&img.region){const g=img.region;t.anchorRegion={x:r4(g.x),y:r4(g.y),w:r4(g.w),h:r4(g.h)};if(img.regionText)t.regionText=img.regionText}
  if(isDoc&&img&&img.image){const g=img.image;t.anchorImg={key:g.key,n:g.n,x:r4(g.x),y:r4(g.y),w:r4(g.w),h:r4(g.h)}}
  if(isDoc&&img&&img.shot){t.anchorShot=img.shot;if(img.regionText)t.regionText=img.regionText;if(!range&&img.near)t.anchorAt=img.near}
  if(title)t.title=title;else if(question)t.title=trunc(question,48);else{t.title=anchorText?trunc(anchorText,40):'Side question';t.autoTitle=!anchorText}
  state.conv.threads[t.id]=t;state.conv.order[t.id]=[];
  if(isDoc)refreshDocAnchors(t.anchorPage);else{m.ver++;renderPane(parent)}
  openThread(t.id,parent);invalidate('map');save();
  if(state.conv.ui.view==='canvas'){const S=cvState();if(!S.open.includes(t.id))S.open.push(t.id);invalidate('canvas');focusCard(t.id)}
  if(question)send(t.id,question);
  else setTimeout(()=>{const ta=state.conv.ui.view==='canvas'?document.querySelector(`#cv .cnode[data-ctid="${t.id}"] .cask textarea`):paneEls.get(t.id)&&paneEls.get(t.id).querySelector('textarea');ta&&ta.focus({preventScroll:state.conv.ui.view==='canvas'})},30);
}
function deleteBranch(tid){
  const t=T(tid);if(!t||!t.parent)return;
  const kill=[tid,...Object.keys(state.conv.threads).filter(x=>isDesc(x,tid))];
  for(const k of kill)stopReply(streaming.get(k));
  for(const k of kill){for(const mid of state.conv.order[k]||[]){delete state.conv.msgs[mid];msgCache.delete(mid)}delete state.conv.order[k];delete state.conv.threads[k]}
  const keep=x=>state.conv.threads[x]||(x==='doc'&&state.conv.doc);
  state.conv.ui.open=state.conv.ui.open.filter(keep);state.conv.ui.collapsed=state.conv.ui.collapsed.filter(keep);
  for(const k of kill)delete state.conv.ui.sizes[k];
  if(state.conv.msgs[t.anchorMsg])state.conv.msgs[t.anchorMsg].ver++;
  if(isDocBranch(t))refreshDocAnchors(t.anchorPage);
  for(const m of Object.values(state.conv.msgs))if(m.role==='note'&&kill.includes(m.fromThread))m.ver++;
  invalidate('panes');state.conv.ui.open.forEach(id=>renderPane(id));invalidate('map');save();
  if(state.conv.ui.view==='canvas')invalidate('canvas');
  toast('Branch deleted');
}
function openThread(tid,from){
  const ui=state.conv.ui;
  if(ui.open.includes(tid)){ui.collapsed=ui.collapsed.filter(x=>x!==tid);invalidate('panes');revealPane(tid);return}
  const src=from||T(tid).parent;
  if(src&&src!=='main'&&src!=='doc'&&!ui.open.includes(src))openThread(src);   // a closed main or document stays closed: you closed it
  let i=ui.open.indexOf(src);
  if(tid==='main')i=ui.open.indexOf('doc');   // main comes back first (after the document)
  else if(i<0)i=ui.open.length-1;else while(i+1<ui.open.length&&isDesc(ui.open[i+1],src))i++;
  ui.open.splice(i+1,0,tid);
  invalidate('panes');invalidate('map');revealPane(tid);save();
}
// Any pane can close, main and the document included, as long as another stays open. Main thread and the document
// have rows in the sidebar's Branches that bring them back.
function closeThread(tid,o={}){
  const t=T(tid),ui=state.conv.ui;if(!ui.open.includes(tid))return;
  if(ui.open.length<2){if(tid==='main'&&isBlank(state.conv)){discardBlank();return}toast('At least one pane stays open');return}
  const kids=tid==='main'||tid==='doc'?[]:ui.open.filter(x=>isDesc(x,tid));   // open branches under it stay open (each one's crumb reopens this pane)
  ui.open=ui.open.filter(x=>x!==tid);ui.collapsed=ui.collapsed.filter(x=>ui.open.includes(x));
  if(!ui.open.some(x=>!isCollapsed(x)))ui.collapsed=[];   // never leave only strips
  invalidate('panes');invalidate('map');save();   // only closes: no scrolling to where it came from (that's Back, in the branch)
  if(!kids.length||o.quiet)return;
  const c0=state.conv,name=(t.title||'branch').length>40?(t.title.slice(0,38)+'…'):(t.title||'branch');
  toast(`Closed “${name}”, ${kids.length} branch${kids.length>1?'es':''} under it still open`,
    {label:'Close them too',fn:()=>{if(state.conv!==c0)return;const u=state.conv.ui;u.open=u.open.filter(x=>!kids.includes(x));u.collapsed=u.collapsed.filter(x=>u.open.includes(x));
      if(!u.open.length)u.open=['main'];invalidate('panes');invalidate('map');save()}});
}
/* Is this thread's conversation showing? Columns/Rows: its pane is open and not a strip. Canvas: its card is open. */
function seenNow(tid){
  if(!state.conv||!state.conv.ui)return false;
  if(state.conv.ui.view==='canvas'){const S=state.conv.ui.cv||{};return !!((S.open||[]).includes(tid)||(S.dock||{})[tid])}
  return state.conv.ui.open.includes(tid)&&!isCollapsed(tid);
}
const replyState=(tid)=>streaming.has(tid)?'writing':unread.has(tid)?'ready':'';
// the badge on a strip, a folded canvas card and a sidebar row: a pulsing ring while it writes, a dot once it's ready
function markReplies(){
  if(!state.conv)return;
  for(const tid of [...unread])if(!state.conv.threads[tid]||seenNow(tid))unread.delete(tid);
  const put=(host,before,st,wrap)=>{if(!host)return;let b=host.querySelector(':scope > .rbadge');
    if(!st){if(b)b.remove();if(wrap)wrap.classList.remove('rready');return}
    if(!b){b=document.createElement('span');host.insertBefore(b,before||null)}
    if(!b.classList.contains(st)){b.className='rbadge '+st;b.innerHTML=st==='ready'?'Ready':'<i></i><i></i><i></i>'}b.title=st==='ready'?'A reply is ready: open it to read':'Writing a reply…';
    if(wrap)wrap.classList.toggle('rready',st==='ready')};
  const st=(tid)=>seenNow(tid)?'':replyState(tid);
  for(const [tid,el] of paneEls){if(tid==='doc')continue;const lb=el.querySelector('.rail-label');put(lb,lb&&lb.querySelector('.rl'),el.classList.contains('rail')?st(tid):'',el)}
  document.querySelectorAll('#panes .rail-stack[data-stack]').forEach(el=>{
    const ids=(el.dataset.stack||'').split(',').filter(Boolean);
    const sts=ids.map(st);
    const agg=sts.includes('ready')?'ready':sts.includes('writing')?'writing':'';
    const host=el.querySelector('.rs-inner');
    put(host,host&&host.querySelector('.rs-count'),agg,el);
  });
  // the open stack's popover: each row its own (writing, or Ready), at the row's end
  document.querySelectorAll('.rspop .rsitem[data-rstid]').forEach(n=>{const g=n.querySelector('.rsgo');put(g,null,n.dataset.rstid==='doc'?'':st(n.dataset.rstid))});
  document.querySelectorAll('#cv .cnode[data-ctid]').forEach(n=>{const ch=n.querySelector('.ch');put(ch,ch&&ch.querySelector('.ct')&&ch.querySelector('.ct').nextSibling,st(n.dataset.ctid),n)});
  document.querySelectorAll('#tree .mnode[data-map]').forEach(n=>put(n,n.querySelector('.mc'),st(n.dataset.map)));
}
function toggleCollapse(tid){
  const ui=state.conv.ui;
  if(isCollapsed(tid))ui.collapsed=ui.collapsed.filter(x=>x!==tid);
  else{
    if(ui.open.filter(x=>!isCollapsed(x)).length<=1){toast('At least one pane stays open');return}
    ui.collapsed.push(tid);
  }
  invalidate('panes');save();
}
const isFocused=(tid)=>state.conv.ui.open.length>1&&!isCollapsed(tid)&&state.conv.ui.open.every(x=>x===tid||isCollapsed(x));
function toggleFocus(tid){
  const ui=state.conv.ui;
  if(isFocused(tid))ui.collapsed=[];else ui.collapsed=ui.open.filter(x=>x!==tid);
  invalidate('panes');revealPane(tid);save();
}
function revealPane(tid){
  const el=paneEls.get(tid);if(!el)return;
  requestAnimationFrame(()=>{
    const p=$('#panes');const r=el.getBoundingClientRect(),pr=p.getBoundingClientRect();
    if(state.conv.ui.layout==='cols'){if(r.right>pr.right||r.left<pr.left)p.scrollBy({left:r.right>pr.right?r.right-pr.right+12:r.left-pr.left-12,behavior:'smooth'})}
    else{if(r.bottom>pr.bottom||r.top<pr.top)p.scrollBy({top:r.bottom>pr.bottom?r.bottom-pr.bottom+12:r.top-pr.top-12,behavior:'smooth'})}
    el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');
    setTimeout(() => invalidate('wires'),350);
  });
}
/* take the user to the exact spot a branch came from */
// quiet: don't offer "back to where you were" in the parent (closing a branch is already going back)
function revealAnchor(tid,quiet){
  const t=T(tid);if(!t||!t.parent)return;
  if(isDocBranch(t)){revealDocAnchor(t,quiet);return}
  if(state.conv.ui.view==='canvas')setView(state.conv.ui.layout);
  if(!state.conv.ui.open.includes(t.parent))openThread(t.parent);
  if(isCollapsed(t.parent)){state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==t.parent);invalidate('panes')}
  const pe=paneEls.get(t.parent);if(!pe)return;
  requestAnimationFrame(()=>{
    const po=state.conv.order[t.parent],alt=t.alt?po[t.anchorMsg==='START'?0:po.indexOf(t.anchorMsg)+1]:null;
    const a=alt?pe.querySelector(`.msg[data-mid="${qid(alt)}"]`):pe.querySelector(`.anchor[data-tid="${qid(tid)}"]`)||pe.querySelector(`.msg[data-mid="${qid(t.anchorMsg)}"]`);
    if(!a)return;
    const pb=pe.querySelector('.pb');const ar=a.getBoundingClientRect(),br=pb.getBoundingClientRect();
    if(!quiet)rememberSpot(pe);
    pb.scrollBy({top:ar.top-br.top-br.height/3,behavior:'smooth'});
    revealPane(t.parent);
    const spans=pe.querySelectorAll(`.anchor[data-tid="${qid(tid)}"]`);
    if(spans.length)spans.forEach(s=>{s.classList.remove('flash');void s.offsetWidth;s.classList.add('flash')});
    else{const m=pe.querySelector(`.msg[data-mid="${qid(alt||t.anchorMsg)}"]`);if(m){m.style.setProperty('--c',color(t));m.classList.remove('flash');void m.offsetWidth;m.classList.add('flash')}}
    setTimeout(() => invalidate('wires'),450);
  });
}
function revealMsg(tid,mid){
  const pe=paneEls.get(tid);if(!pe)return;
  requestAnimationFrame(()=>{const m=pe.querySelector(`.msg[data-mid="${qid(mid)}"]`);if(!m)return;const pb=pe.querySelector('.pb');rememberSpot(pe);
    pb.scrollBy({top:m.getBoundingClientRect().top-pb.getBoundingClientRect().top-20,behavior:'smooth'});
    m.style.setProperty('--c',color(T(tid)));m.classList.remove('flash');void m.offsetWidth;m.classList.add('flash')});
}


  return {
    buildContext, resolveContext, send, MODEL_FAM, titleModel, stopReply, resumeRuns, continueReply, retry, redoBlock, retryBlock, REDO_WHY, questionOf, redoKeep, editKeep, versionsOf, openVersions, useVersion, redo, startMainOver, movedOn, joinable, versionAfter, versionWhere, replyMenuItems, openReplyMenu, closeReplyMenu, newFromDoc, startEdit, takeawayCuts, tkcutEl, goToTakeaway, goToTakeawaySource, bringBack, crossPageText, createBranch, deleteBranch, openThread, closeThread, markReplies, toggleCollapse, isFocused, toggleFocus, revealPane, revealAnchor, revealMsg,
  };
}
