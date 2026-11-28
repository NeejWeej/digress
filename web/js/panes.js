// Pane view: message elements, composer, pane headers, per-pane zoom, resize/reorder, and connector wires.
import { esc, trunc } from './text.js';
import { isDocBranch, isClipBranch, isWholePage, shotRef } from './context.js';
import { normalizePageIndex } from './share.js';
import {
  state, app, paneEls, gutEls, msgCache, streaming, $, ic, qid, T, color, ancestors, branchesOn, hiddenNow, shownOn, branchNum, isCollapsed,
  STARTERS, effortLabel, modelLabel, sysPrompt, quickList, resetThreadIdx,
} from './state.js';
import { imageURL, getPending, takePending, userMsgBody, regionRef } from './media.js';
import { invalidate, onRedraw } from './redraw.js';

export function createPanes() {
  // the parts of the page this module draws, for invalidate('…') from the others (web/js/redraw.js)
  onRedraw('panes', layout);
  onRedraw('wires', wires);
  onRedraw('wires-soon', wiresSoon);
  const applyAnchors = (...a) => app.applyAnchors(...a);
  const brCount = (...a) => app.brCount(...a);
  const bringBack = (...a) => app.bringBack(...a);
  const buildPdfPages = (...a) => app.buildPdfPages(...a);
  const descendants = (...a) => app.descendants(...a);
  const docImgRef = (...a) => app.docImgRef(...a);
  const docPagesLabel = (...a) => app.docPagesLabel(...a);
  const docPaneEl = (...a) => app.docPaneEl(...a);
  const docReads = (...a) => app.docReads(...a);
  const docSpotNow = (...a) => app.docSpotNow(...a);
  const docView = (...a) => app.docView(...a);
  const docViewReady = (...a) => app.docViewReady(...a);
  const editKeep = (...a) => app.editKeep(...a);
  const isFocused = (...a) => app.isFocused(...a);
  const joinable = (...a) => app.joinable(...a);
  const markCardButtons = (...a) => app.markCardButtons(...a);
  const markCur = (...a) => app.markCur(...a);
  const movedOn = (...a) => app.movedOn(...a);
  const ownSys = (...a) => app.ownSys(...a);
  const putDocSpot = (...a) => app.putDocSpot(...a);
  const questionOf = (...a) => app.questionOf(...a);
  const redoBlock = (...a) => app.redoBlock(...a);
  const redoKeep = (...a) => app.redoKeep(...a);
  const refreshDocAnchors = (...a) => app.refreshDocAnchors(...a);
  const renderDocPane = (...a) => app.renderDocPane(...a);
  const renderMermaid = (...a) => app.renderMermaid(...a);
  const renderRich = (...a) => app.renderRich(...a);
  const replyMenuItems = (...a) => app.replyMenuItems(...a);
  const retryBlock = (...a) => app.retryBlock(...a);
  const save = (...a) => app.save(...a);
  const scrollDocToPage = (...a) => app.scrollDocToPage(...a);
  const send = (...a) => app.send(...a);
  const setConvSystem = (...a) => app.setConvSystem(...a);
  const stopReply = (...a) => app.stopReply(...a);
  const syncViewSeg = (...a) => app.syncViewSeg(...a);
  const takeawayCuts = (...a) => app.takeawayCuts(...a);
  const tkcutEl = (...a) => app.tkcutEl(...a);
  const toast = (...a) => app.toast(...a);
  const updateDocHeader = (...a) => app.updateDocHeader(...a);
  const versionAfter = (...a) => app.versionAfter(...a);
  const versionWhere = (...a) => app.versionWhere(...a);
  const versionsOf = (...a) => app.versionsOf(...a);
/* ---------- message elements ---------- */
function anchorsKey(m){return branchesOn(m.id).map(t=>t.id+t.title+(t.resolved?'r':'')+(hiddenNow(t.id)?'h':'')).join(',')}
function msgKey(m){return `${m.ver}|${m.pending?1:0}|${state.mathReady?1:0}|${m.role==='user'?editKeep(m.id)+versionsOf(m.id).length:m.role==='assistant'?redoKeep(m.id):''}|${m.role!=='user'?anchorsKey(m):''}|${m.role==='note'&&T(m.fromThread)?T(m.fromThread).title:''}|${m.role==='assistant'?replyMenuItems(m).length+movedOn(m.id).map(t=>t.id+t.title).join(','):''}`}
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
  const m=state.conv.msgs[mid],u=m&&m.usage,ctx=u&&+u.ctx;if(!ctx)return;
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
  f.innerHTML=`<button class="tb" data-act="wbranch" title="Open a side branch about this whole reply (no specific passage)">${ic('branch')}Side question</button><button class="ib" data-act="copy" title="Copy Markdown">${ic('copy')}</button>`+(replyMenuItems(m).length?`<button class="ib" data-act="rmore" title="More">${ic('dots')}</button>`:'')+(m.cut&&!retryBlock(m.id)?`<button class="tb" data-act="continue" title="Ask the model to carry on from where it stopped">${ic('send')}Continue</button>`:'')+(m.error?`<button class="ib" data-act="retry" title="${m.role==='assistant'&&retryBlock(m.id)?'Ask again as another version, next to this one ('+app.REDO_WHY[retryBlock(m.id)]+'). Nothing here changes.':m.cut?'Ask again from the start':'Retry'}">${ic('retry')}</button>`:m.role==='assistant'&&redoBlock(m.id)!=='busy'&&questionOf(m.id)?`<button class="ib" data-act="redo" title="${redoKeep(m.id)?'Redo in a new branch beside this one, with the model and effort selected now. This answer stays as it is.':'Redo: ask again with the model and effort selected now'}">${ic('retry')}</button>`:'')+(m.model?`<span class="model">${esc(modelLabel(m.model))}${m.effort?` · ${esc(effortLabel(m.effort))}`:''}</span>`:'')+ctxLabel(m.usage,m.ts);
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
// Decoupled from body rendering so the 1s elapsed-time tick updates .lt in place without re-running renderRich.
function updateLiveTime(headEl,secs){
  if(!headEl||secs<2)return;
  let lt=headEl.querySelector('.lt');
  if(!lt){lt=document.createElement('span');lt.className='lt';headEl.appendChild(lt)}
  const txt=secs+'s';
  if(lt.textContent!==txt)lt.textContent=txt;
}
function streamInto(body,m){
  const st=m.live||[],cur=st.length&&!st[st.length-1].done?st[st.length-1]:null,secs=m.t0?Math.floor((Date.now()-m.t0)/1000):0;
  const cap=(x)=>x[0].toUpperCase()+x.slice(1),now=(x)=>x.replace(/^searched /,'searching ').replace(/^read /,'reading ').replace(/^looked at /,'looking at ');
  const what=cur?cap(now(cur.text)):m.content?'':st.length?'Thinking about what it found':'Thinking';
  const head=what?`<div class="lhead">${ic(cur?cur.icon:'dots')}<span class="shimmer">${esc(trunc(what,110))}…</span>${secs>=2?`<span class="lt">${secs}s</span>`:''}</div>`:'';
  if(!m.content){
    const done=st.filter(x=>x!==cur),shown=done.slice(-10),more=done.length-shown.length;
    const stepKey=`${what}\0${cur?cur.icon:''}\0${more}\0${shown.map(x=>x.icon+':'+x.text).join('\0')}`;
    if(body.__streamMd===''&&body.__liveKey===stepKey&&body.firstElementChild&&body.firstElementChild.classList.contains('live')){
      updateLiveTime(body.firstElementChild.querySelector('.lhead'),secs);
      return false;
    }
    const list=shown.length?`<ol class="lsteps">${more?`<li class="more"><span>${more} earlier step${more>1?'s':''}</span></li>`:''}${shown.map(x=>`<li>${ic(x.icon)}<span>${esc(trunc(cap(x.text),120))}</span></li>`).join('')}</ol>`:'';
    body.innerHTML=`<div class="live">${head}${list}</div>`;
    body.__streamMd='';body.__liveKey=stepKey;
    return true;
  }
  const mReady=!!state.mathReady;
  let changed=false;
  if(body.__streamMd!==m.content||body.__streamMath!==mReady){
    renderRich(body,m.content,false);
    body.__streamMd=m.content;body.__streamMath=mReady;body.__liveKey='';
    changed=true;
  }
  const liveEl=body.lastElementChild&&body.lastElementChild.classList.contains('live')?body.lastElementChild:null;
  if(!head){
    if(liveEl){liveEl.remove();body.__liveKey='';changed=true}
  }else{
    const liveKey=`${what}\0${cur?cur.icon:''}`;
    if(liveEl&&body.__liveKey===liveKey){
      updateLiveTime(liveEl.querySelector('.lhead'),secs);
    }else{
      if(liveEl)liveEl.innerHTML=head;
      else body.insertAdjacentHTML('beforeend',`<div class="live">${head}</div>`);
      body.__liveKey=liveKey;changed=true;
    }
  }
  return changed;
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
    const onCv=state.conv&&state.conv.ui.view==='canvas';
    let anyChanged=false;
    if(!onCv){
      for(const id of streamQ){
        const m=state.conv.msgs[id];const c=msgCache.get(id);if(!m||!c||!m.pending)continue;
        const pb=c.el.closest('.pb');const stick=pb&&pb.scrollHeight-pb.scrollTop-pb.clientHeight<80;
        if(streamInto(c.el.querySelector('.body'),m)){anyChanged=true;if(stick)pb.scrollTop=pb.scrollHeight}
      }
    }else{
      for(const id of streamQ){const m=state.conv.msgs[id];const b=m&&m.pending&&document.querySelector(`#cv .msg[data-mid="${id}"] .body`);if(b){const f=b.closest('.cfull');const stick=f&&f.scrollHeight-f.scrollTop-f.clientHeight<80;if(streamInto(b,m)){anyChanged=true;if(stick)f.scrollTop=f.scrollHeight}}}
    }
    streamQ.clear();if(anyChanged){if(!onCv)wiresSoon();else invalidate('edges-soon')}
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
    <div class="jumpw"><div class="jback"><button class="jb-go" data-act="jback" title="Return to where you were reading before you jumped here">${ic('jprev')}Back to where you were</button><button class="jb-x" data-act="jbackx" title="Dismiss">${ic('x')}</button></div><div class="jump"><button class="ib js" data-act="jsearch" title="Search this thread">${ic('search')}</button><button class="ib jp" data-act="jprev" title="Return to where you were reading before you jumped here">${ic('jprev')}</button><button class="ib jl" data-act="jlast" title="Jump to the start of the latest reply">${ic('jlast')}</button><button class="ib je" data-act="jend" title="Jump to the very bottom">${ic('jend')}</button></div></div>
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
  title.addEventListener('blur',()=>{if(title.contentEditable!=='true')return;title.contentEditable='false';const v=title.textContent.trim();if(v&&T(tid)){const ch=v!==T(tid).title;T(tid).title=v;if(ch)T(tid).titleKept=true;delete T(tid).autoTitle;refreshAnchorsFor(tid);invalidate('map');save()}});
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
  const top=pb.getBoundingClientRect().top,y=top+pb.clientHeight*app.READ_LINE,msgs=[...pb.querySelectorAll(':scope .msgs>.msg')];
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
    pb.scrollTop+=r.top+sp.f*r.height-pb.getBoundingClientRect().top-pb.clientHeight*app.READ_LINE}}
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
  if(el.__prev!=null&&Math.abs(pb.scrollTop-el.__prev)<40&&!el.__jumping){el.__prev=null;el.classList.remove('hasprev','backpill')}
}
// pill: also float a "Back to where you were" pill over the pane (a jump within the thread you're reading, which
// would otherwise leave you only the small ↩ button to find your way back)
function rememberSpot(pe,pill){
  const pb=pe.querySelector('.pb');pe.__prev=pb.scrollTop;pe.__jumping=true;pe.classList.add('hasprev');if(pill)pe.classList.add('backpill');
  setTimeout(()=>{pe.__jumping=false},900);
}
function autosize(ta){ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,200)+'px'}
function submit(tid){if(streaming.has(tid))return;const el=paneEls.get(tid);const ta=el.querySelector('textarea');const v=ta.value.trim();if(!v&&!getPending(tid).length)return;const imgs=takePending(tid);ta.value='';autosize(ta);send(tid,v,imgs)}
function updateComposer(tid){
  const el=paneEls.get(tid);if(!el)return;const b=el.querySelector('.sendb');const s=streaming.has(tid);
  b.innerHTML=s?ic('stop'):ic('send');b.title=s?'Stop':'Send';b.disabled=!s&&!el.querySelector('textarea').value.trim()&&!getPending(tid).length;
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
  const title=el.querySelector('.ph-title');if(title.contentEditable!=='true')title.textContent=tid==='main'?(state.conv.title||'Main thread'):t.title;
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
  const pb_=el.querySelector('[data-act="pin"]');if(pb_){const pinned=tid==='main'?!!state.conv.pinned:!!t.pinned;pb_.innerHTML=ic('pin');pb_.classList.toggle('pinned',pinned);pb_.title=tid==='main'?(pinned?'Unpin this conversation':'Pin this conversation to the top of the sidebar'):(pinned?'Unpin this branch':'Pin this branch to the top of the sidebar, so you can jump straight back to it')}
  const f=el.querySelector('[data-act="focus"]');const on=isFocused(tid);f.innerHTML=ic('focus');f.setAttribute('aria-pressed',on?'true':'false');f.title=on?'Expand the other panes again (Esc)':'Collapse the other panes';f.classList.toggle('on',on);
  el.querySelector('.rl').textContent=tid==='main'?'Main':t.title;
  const sd=el.querySelector('.sdot');if(sd){sd.classList.toggle('res',!!t.resolved);sd.title=t.resolved?'Resolved. Click to mark as still open.':'Open. Click to mark as resolved once you\'ve got it.'}
  el.classList.toggle('res',!!t.resolved);
  fitOrigin(el);
}
// what a version is and where it starts, with the button that uses it: for a pane's first card and a canvas card's line
function altLine(t,n,show){
  const p=T(t.parent),pn=esc(p.parent?'“'+trunc(p.title,30)+'”':'the main thread'),full=esc(p.parent?'“'+p.title+'”':'the main thread'),a=versionAfter(t,n),back=joinable(t),empty=!(state.conv.order[t.id]||[]).length;
  const what=back?(a?`Moved out of ${pn}: what came after ${esc(a)}`:`Moved out of ${pn}: what was in it, from the start`):`Another version of a question in ${pn}, ${a?'after '+esc(a):'at the start'}`;
  const showB=show&&a?`<button data-back="1" title="${back?'Show the message this came after':'Show the version it\'s an alternative to'}">${back?'Show where':'Show other'}</button>`:'';
  const useB=back?`<button class="usev" data-usev="${esc(t.id)}" title="${empty?'Nothing is in this branch: remove it':`Put these messages back at the end of ${full}, where they came from. This branch goes away; nothing is lost.`}">${empty?'Remove':'Move back'}</button>`
    :empty?'':`<button class="usev" data-usev="${esc(t.id)}" title="Make this the version ${full} goes on with. The other one moves here; nothing is lost.">Use this version</button>`;
  return `${show?'<div class="ol">':''}<span>${what}</span>${showB}${useB}${show?'</div>':''}`;
}
const originExpanded=new Set();
function wireOriginExpand(d,t){
  const oq=d.querySelector('.oq');if(!oq)return;
  const key=(state.conv?state.conv.id:'')+':'+t.id;
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
  if(isDocBranch(t)){const pl=state.conv.doc&&state.conv.doc.kind==='pdf'?docPagesLabel(t,true):'';d.innerHTML=`<div class="ol"><span></span><button data-back="1" title="Scroll the document to the exact passage this branch came from">Show in source</button></div><div class="oq"></div>`;d.querySelector('.ol span').textContent='Branched from the document'+(pl?`, ${pl}`:'');const oq0=d.querySelector('.oq');oq0.textContent=t.anchorText;oq0.dataset.back='1';oq0.title='Jump to this passage in the document';wireOriginExpand(d,t);return d}
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
  if(t.id==='main'&&state.conv.doc){
    d.innerHTML=`<h2>Ask about the whole document</h2><div>Or highlight any passage in the document to open a branch about just that part. Page references in answers are links.</div><div class="chips"></div>`;
    app.DOC_STARTERS.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s;b.dataset.ask=s;d.lastChild.appendChild(b)});
  }else if(t.id==='main'){
    d.innerHTML=`<h2>What do you want to understand?</h2><div>Ask a question. When a phrase in the answer raises a new question, highlight it to open a side branch next to the main thread.</div><div class="chips"></div>`;
    STARTERS.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s;b.dataset.ask=s;d.lastChild.appendChild(b)});
    d.insertAdjacentHTML('beforeend',`<div class="eor"><button class="elink" data-newdoc="1">${ic('doc')}Or start from something to read: a PDF, a web page, a text file</button></div>`);
    // the very first time (nothing saved yet): the idea in three steps
    if(!state.convList.some(c=>c.id!==state.conv.id))d.insertAdjacentHTML('beforeend',`<ol class="esteps"><li><b>Ask</b><span>anything, or about a document you open.</span></li><li><b>Highlight</b><span>a phrase in the answer to branch off into it, beside the main thread.</span></li><li><b>Keep</b><span>what you learn: carry a takeaway back, or turn on flashcards.</span></li></ol><div class="ekeys">Press <kbd>?</kbd> for keyboard shortcuts.</div>`);
  }else{
    d.innerHTML=`<div>${t.anchorText?'Ask anything about this passage':'Ask a side question about that reply'}, or start with one of these:</div><div class="chips"></div>`;
    quickList().forEach(([l,q])=>{const b=document.createElement('button');b.className='chip';b.textContent=l;b.dataset.ask=q;b.title='Asks: '+q;d.lastChild.appendChild(b)});
  }
  if(t.id==='main')d.appendChild(convSysBox());
  return d;
}
// in an empty main thread: the system prompt this conversation starts with, ready to change before the first question
let csysDraft=null;   // {conv:state.conv, v, open}: kept across redraws of the pane
// one system prompt per conversation (one prompt cache): say so, and that a document's branches use it even while main is empty
const sysScope=()=>state.conv.doc?'Every thread of this conversation uses it: this main thread and every branch, including branches from the document, even if nothing is ever asked here.':'Every thread of this conversation uses it: this main thread and every branch off it.';
function convSysBox(){
  const own=ownSys(state.conv),dr=csysDraft&&csysDraft.conv===state.conv.id?csysDraft:null;
  const el=document.createElement('details');el.className='csys';if(dr&&dr.open)el.open=true;
  el.innerHTML=`<summary>${ic('tune')}<span>System prompt: <b>${own?'this conversation’s own':'your default'}</b>${state.conv.doc?'<span class="csyss"> · for every thread, branches from the document too</span>':''}</span></summary><div class="csysb"></div>`;
  // the editor is made only while open, so the pane's composer stays its only textarea otherwise
  const fill=()=>{const w=el.querySelector('.csysb');if(!el.open){w.innerHTML='';return}if(w.firstChild)return;
    w.innerHTML=`<p class="ppnote csysn">${sysScope()}</p><textarea class="pptext" rows="9" spellcheck="false" aria-label="System prompt for this conversation"></textarea>
    <div class="ppbar"><span class="ppmsg"></span><span class="sp"></span>${own?'<button class="mbtn" data-csys="reset">Use my default</button>':''}<button class="mbtn primary" data-csys="save" disabled>Use for this conversation</button></div>`;
    const ta=w.querySelector('textarea'),sv=w.querySelector('[data-csys=save]'),d=csysDraft&&csysDraft.conv===state.conv.id?csysDraft:null;
    ta.value=d&&d.v!=null?d.v:sysPrompt(state.conv);sv.disabled=ta.value.trim()===sysPrompt(state.conv).trim();
    ta.oninput=()=>{csysDraft={conv:state.conv.id,v:ta.value,open:true};sv.disabled=ta.value.trim()===sysPrompt(state.conv).trim()}};
  el.ontoggle=()=>{csysDraft={...(csysDraft&&csysDraft.conv===state.conv.id?csysDraft:{conv:state.conv.id,v:null}),open:el.open};fill()};
  el.onclick=(e)=>{const b=e.target.closest('[data-csys]');if(!b)return;e.stopPropagation();
    setConvSystem(b.dataset.csys==='save'?el.querySelector('.csysb textarea').value:'');csysDraft={conv:state.conv.id,v:null,open:false};
    renderPane('main');toast(ownSys(state.conv)?`This conversation has its own system prompt, ${state.conv.doc?'for main and every branch, those from the document too':'for main and every branch'}.`:'This conversation uses your default system prompt.')};
  if(el.open)fill();
  return el;
}
/* ---- zoom inside a pane (Columns / Rows views). state.conv.ui.pz[tid] = factor.
   Chat and text panes scale their content with CSS zoom (text reflows to the pane). The PDF is re-rendered
   at the new size instead, so it stays sharp: its 100% is "fit the width", and the fit button returns to it.
   (Fitting a whole page was tried and dropped: in a side pane a portrait page ends up small, with wide gray margins.) */
const PZ=[0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3];
function paneZoom(tid){const v=state.conv.ui.pz&&state.conv.ui.pz[tid];return typeof v==='number'&&v>=PZ[0]&&v<=PZ[PZ.length-1]?v:1}
const isPdfPane=(tid)=>tid==='doc'&&state.conv.doc&&state.conv.doc.kind==='pdf';
function applyPaneZoom(tid){
  const el=paneEls.get(tid);if(!el)return;const v=paneZoom(tid),pdf=isPdfPane(tid);
  if(pdf||v===1)el.style.removeProperty('--pz');else el.style.setProperty('--pz',v);
  const l=el.querySelector('.pzl');if(l){l.textContent=Math.round(v*100)+'%';l.title=pdf?'Click to type a zoom level (100% fits the page to the width)':'Click to type a zoom level'}
  el.classList.toggle('zoomed',v!==1);
  const sn=el.querySelector('[data-act=snip]');if(sn)sn.style.display=tid==='doc'&&state.conv.doc?'':'none';
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
  const pz=state.conv.ui.pz||(state.conv.ui.pz={});if(v===1)delete pz[tid];else pz[tid]=v;
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
  if(tid==='main'){const rb=el.querySelector('.ph [data-act=restart]');if(rb)rb.style.display=state.conv.doc&&state.conv.order.main.length?'':'none'}
  // a redraw keeps the scroll offset: a rebuilt message (a new branch marker or chip) leaves the page for a moment while
  // the others are built, the pane is shorter meanwhile and the browser pulls the scroll up (Side question jumped up
  // by a screenful, and the width change that followed then took it as the reader's own jump and left it there)
  const t=T(tid),list=el.querySelector('.msgs'),nodes=[],pb0=el.querySelector('.pb'),top0=pb0.scrollTop;
  if(t.parent)nodes.push(originCard(t));
  const mids=state.conv.order[tid]||[];
  if(!mids.length)nodes.push(emptyState(t));
  const cuts=takeawayCuts(tid);
  for(const mid of mids)if(state.conv.msgs[mid]){nodes.push(msgEl(state.conv.msgs[mid]));for(const n of cuts.get(mid)||[])nodes.push(tkcutEl(n))}
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
function refreshAnchorsFor(tid){const t0=T(tid);if(isDocBranch(t0))refreshDocAnchors(t0.anchorPage);const t=T(tid);if(t&&t.anchorMsg&&state.conv.msgs[t.anchorMsg]){state.conv.msgs[t.anchorMsg].ver++;renderPane(t.parent)}state.conv.ui.open.forEach(updateHeader)}
function gutEl(tid){
  let g=gutEls.get(tid);if(g)return g;
  g=document.createElement('div');g.className='gut';g.dataset.left=tid;g.title='Drag to resize, double-click to reset';
  // no text selection or native drag while resizing: in Safari, a selection left elsewhere turned the press into a
  // drag of that text, and the handle got no more pointer events
  g.addEventListener('pointerdown',e=>{e.preventDefault();try{getSelection().removeAllRanges()}catch(_){}startDrag(e,g)});
  g.addEventListener('dblclick',()=>{const t=gutTarget(g);if(t){delete state.conv.ui.sizes[t.tid];layout();save()}});
  gutEls.set(tid,g);return g;
}
// the document is docked on the canvas (and the canvas is showing): its pane lives in that card, not in #panes
const docInDock=()=>!!(state.conv&&state.conv.doc&&state.conv.ui.view==='canvas'&&state.conv.ui.cv&&state.conv.ui.cv.dock&&state.conv.ui.cv.dock.doc);
function placeDocPane(){
  if(!docInDock())return;
  const slot=$('#dock .docpanecard .cdocpane');if(!slot)return;
  if(!state.conv.ui.open.includes('doc')){state.conv.ui.open.unshift('doc');state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!=='doc')}
  const el=paneEl('doc');el.classList.remove('rail');
  const sp=docSpotNow();
  if(el.parentNode!==slot){slot.appendChild(el);renderDocPane();putDocSpot(sp);return}   // moving it resets its scroll
  renderDocPane();
}
let railStackPop=null;
function closeRailStack(){
  if(!railStackPop)return false;
  railStackPop.el.remove();
  if(railStackPop.btn)railStackPop.btn.classList.remove('open');
  railStackPop=null;
  return true;
}
function placeRailStack(){
  if(!railStackPop)return;
  const {el,btn}=railStackPop;
  if(!btn||!btn.isConnected){closeRailStack();return}
  const r=btn.getBoundingClientRect(),w=Math.min(340,innerWidth-16),rows=state.conv&&state.conv.ui.layout==='rows';
  el.style.width=w+'px';
  if(rows){
    el.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
    const below=innerHeight-r.bottom-12,above=r.top-12,up=below<180&&above>below;
    el.style.maxHeight=Math.max(120,Math.min(innerHeight*.6,up?above:below))+'px';
    el.style.top=up?'':(r.bottom+6)+'px';el.style.bottom=up?(innerHeight-r.top+6)+'px':'';
  }else{
    const right=innerWidth-r.right-12,left=r.left-12,goLeft=right<w&&left>right;
    el.style.left=Math.max(8,Math.min(goLeft?r.left-w-6:r.right+6,innerWidth-w-8))+'px';
    el.style.top=Math.max(8,Math.min(r.top,innerHeight-240))+'px';
    el.style.bottom='';
    el.style.maxHeight=Math.max(120,Math.min(innerHeight*.7,innerHeight-parseFloat(el.style.top)-12))+'px';
  }
}
function railRowInfo(tid){
  if(tid==='doc'){
    const n=state.docState&&state.docState.kind==='pdf'&&state.docState.n?`${state.docState.n} pages`:'Document';
    return {title:(state.conv.doc&&state.conv.doc.name)||'Document',sub:n,where:'',quote:'',firstQ:'',qCount:0,hasMore:false};
  }
  const t=T(tid);if(!t)return null;
  const ord=state.conv.order[tid]||[];
  const qs=ord.map(id=>state.conv.msgs[id]).filter(m=>m&&m.role==='user');
  const firstQ=qs[0]?String(qs[0].content||qs[0].text||'').replace(/\s+/g,' ').trim():'';
  const qCount=qs.length;
  if(tid==='main'){
    return {title:'Main thread',sub:qCount?`${qCount} question${qCount===1?'':'s'}`:'',where:'',quote:'',firstQ,qCount,hasMore:!!firstQ};
  }
  const where=isDocBranch(t)
    ?(state.conv.doc&&state.conv.doc.kind==='pdf'&&typeof t.anchorPage==='number'?docPagesLabel(t):'Document')
    :t.anchorMsg==='CLIP'
      ?(t.anchorTitle?`Clipped · ${trunc(t.anchorTitle,36)}`:'Clipping')
      :(t.parent==='main'?'Main thread':((T(t.parent)&&T(t.parent).title)||'Branch'));
  const quote=t.anchorText?String(t.anchorText).replace(/\s+/g,' ').trim():'';
  const sub=[where,quote?`“${trunc(quote,56)}”`:''].filter(Boolean).join(' · ');
  return {title:t.title||'Branch',sub,where,quote,firstQ,qCount,hasMore:!!(firstQ||qCount||quote.length>56)};
}
function openRailStack(btn,tids){
  const same=railStackPop&&railStackPop.btn===btn;
  closeRailStack();
  if(same||!tids.length)return;
  const el=document.createElement('div');
  el.className='rspop';el.setAttribute('role','dialog');
  el.innerHTML=`<div class="rsph"><span>${tids.length} collapsed</span><button type="button" class="shbtn" data-unstack-all="1">Expand all</button></div><div class="rslist"></div>`;
  const list=el.querySelector('.rslist');
  for(const tid of tids){
    const info=railRowInfo(tid);if(!info)continue;
    const isDoc=tid==='doc',t=isDoc?null:T(tid);
    const item=document.createElement('div');
    item.className='rsitem';item.dataset.rstid=tid;
    item.style.setProperty('--c',isDoc||tid==='main'?'var(--faint)':color(t));
    item.innerHTML=`<div class="rsrow"><button type="button" class="rsgo" data-rsexpand="${esc(tid)}">${isDoc?`<span class="docico">${ic('doc')}</span>`:'<span class="dot"></span>'}<span class="rsbody"><span class="rst"></span>${info.sub?'<span class="rssub"></span>':''}</span></button>${info.hasMore?`<button type="button" class="ib rsmore" data-rsmore="${esc(tid)}" aria-expanded="false" title="Show branch details">${ic('back').replace('class="i"','class="i" style="transform:rotate(180deg)"')}</button>`:''}<button type="button" class="ib rsx" data-rsclose="${esc(tid)}" title="Close pane (nothing is deleted)">${ic('x')}</button></div>${info.hasMore?'<div class="rsdet"></div>':''}`;
    item.querySelector('.rst').textContent=info.title;
    if(info.sub)item.querySelector('.rssub').textContent=info.sub;
    if(info.hasMore){
      const det=item.querySelector('.rsdet');
      if(info.where||info.quote){
        const o=document.createElement('div');o.className='rsd-orig';
        o.textContent=(info.where?`From ${info.where}`:'')+(info.quote?(info.where?' · ':'')+`“${trunc(info.quote,180)}”`:'');
        det.appendChild(o);
      }
      if(info.firstQ){
        const q=document.createElement('div');q.className='rsd-q';
        const lbl=document.createElement('b');lbl.textContent='Asked: ';
        q.append(lbl,trunc(info.firstQ,220));
        det.appendChild(q);
      }
      if(info.qCount){
        const m=document.createElement('div');m.className='rsd-meta';
        m.textContent=`${info.qCount} question${info.qCount===1?'':'s'}`;
        det.appendChild(m);
      }
    }
    list.appendChild(item);
  }
  el.addEventListener('click',e=>{
    if(e.target.closest('[data-unstack-all]')){
      state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>!tids.includes(x));
      closeRailStack();layout();save();return;
    }
    const more=e.target.closest('[data-rsmore]');
    if(more){
      const item=more.closest('.rsitem');
      const open=item.classList.toggle('det-open');
      more.setAttribute('aria-expanded',open?'true':'false');
      more.title=open?'Hide branch details':'Show branch details';
      placeRailStack();
      return;
    }
    const cls=e.target.closest('[data-rsclose]');
    if(cls){
      const id=cls.dataset.rsclose;
      closeRailStack();app.closeThread(id);return;
    }
    const exp=e.target.closest('[data-rsexpand]');
    if(exp){
      const id=exp.dataset.rsexpand;
      state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==id);
      closeRailStack();layout();save();app.revealPane(id);
    }
  });
  document.body.appendChild(el);
  btn.classList.add('open');
  railStackPop={el,btn,tids};
  placeRailStack();
  invalidate('badges');   // each row's own reply state (the strip shows only the stack's)
}
addEventListener('resize',()=>placeRailStack());
document.addEventListener('pointerdown',e=>{if(railStackPop&&!railStackPop.el.contains(e.target)&&!railStackPop.btn.contains(e.target))closeRailStack()},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&railStackPop){closeRailStack();e.stopPropagation();e.preventDefault()}},true);

function makeRailStackEl(run){
  const el=document.createElement('div');
  el.className='rail-stack';el.setAttribute('role','button');el.tabIndex=0;
  el.dataset.stack=run.join(',');
  const names=run.map(tid=>tid==='doc'?((state.conv.doc&&state.conv.doc.name)||'Document'):(tid==='main'?'Main thread':((T(tid)&&T(tid).title)||'Branch')));
  el.title=`${run.length} collapsed panes: ${names.join(', ')}. Click to choose one or expand all.`;
  const dots=run.slice(0,5).map(tid=>{
    if(tid==='doc')return `<span class="docico">${ic('doc')}</span>`;
    const t=T(tid),c=tid==='main'||!t?'var(--faint)':color(t);
    return `<span class="dot" style="background:${c}"></span>`;
  }).join('');
  el.innerHTML=`<div class="rs-inner"><span class="rs-dots">${dots}</span><span class="rs-count">${run.length} collapsed</span></div>`;
  el.addEventListener('click',()=>openRailStack(el,run));
  el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openRailStack(el,run)}});
  return el;
}

function layout(){
  closeRailStack();
  resetThreadIdx();
  const wrap=$('#panes'),ui=state.conv.ui;
  wrap.className='panes '+ui.layout;
  for(const [tid,el] of paneEls)if(!ui.open.includes(tid)||(!T(tid)&&!(tid==='doc'&&state.conv.doc))){el.remove();paneEls.delete(tid);gutEls.get(tid)&&gutEls.get(tid).remove();gutEls.delete(tid)}
  const seq=[],fresh=[];
  const inDock=docInDock(),dEl=paneEls.get('doc'),dWas=dEl&&dEl.parentNode,dSpot=dEl&&docSpotNow();
  // when every pane not collapsed has a width you dragged it to (always so for the only one), the last of them fills
  // the space: its width is kept (it comes back when a pane without one opens) but only as its least, so closing or
  // collapsing the pane that was taking up the rest doesn't leave them all narrow beside empty space
  const shown=ui.open.filter(x=>!isCollapsed(x)&&!(inDock&&x==='doc'));
  const filler=shown.every(x=>ui.sizes[x])?shown.at(-1):null;
  const visible=ui.open.filter(tid=>{
    if(inDock&&tid==='doc'){if(!paneEls.has(tid))fresh.push(tid);paneEl(tid);return false}
    return true;
  });
  for(let i=0;i<visible.length;i++){
    const tid=visible[i];
    if(isCollapsed(tid)){
      // Group 2+ adjacent collapsed panes into a single compact stack strip
      let j=i;
      while(j<visible.length&&isCollapsed(visible[j]))j++;
      const run=visible.slice(i,j);
      for(const rtid of run){
        const isNew=!paneEls.has(rtid);const el=paneEl(rtid);
        el.classList.add('rail');el.classList.remove('sized');el.style.flex='';el.title='Click to expand';
        if(isNew)fresh.push(rtid);else updateHeader(rtid);
      }
      if(run.length===1){
        seq.push(paneEl(tid));
      }else{
        seq.push(makeRailStackEl(run));
      }
      if(j<visible.length){const g=gutEl(run[run.length-1]);g.classList.toggle('glast',false);seq.push(g)}
      i=j-1;
      continue;
    }
    const isNew=!paneEls.has(tid);const el=paneEl(tid);
    el.classList.remove('rail');el.title='';
    const sz=ui.sizes[tid];el.style.flex=sz?`${tid===filler?1:0} 0 ${sz}px`:'';el.classList.toggle('sized',!!sz);
    seq.push(el);if(isNew)fresh.push(tid);else updateHeader(tid);
    const g=gutEl(tid);g.classList.toggle('glast',i===visible.length-1);seq.push(g);   // the last pane gets one too, so its size can be changed
  }
  for(const [_tid,g] of gutEls)if(!seq.includes(g))g.remove();
  // drop what's left over (the old collapsed-pane stack: it's made anew each time) before putting things in order:
  // otherwise the loop below moves every pane after it to make room, and moving an element resets its scroll
  for(const n of [...wrap.children])if(!seq.includes(n)&&!n.classList.contains('pane'))n.remove();
  seq.forEach((n,i)=>{if(wrap.children[i]!==n)wrap.insertBefore(n,wrap.children[i]||null)});
  if(dEl&&dWas&&dWas!==wrap&&dEl.parentNode===wrap)putDocSpot(dSpot);   // back from the canvas's dock: moving it reset its scroll
  while(wrap.children.length>seq.length)wrap.lastChild.remove();
  fresh.forEach(tid=>renderPane(tid,true));
  syncViewSeg();
  wiresSoon();markCur();invalidate('badges');markCardButtons();
  if(inDock)placeDocPane();
}
/* Reorder panes by dragging the grip at the left of a pane's header, or a collapsed strip itself (Columns / Rows). The drag starts after a
   few pixels, so a click on the grip does nothing. Only the grip drags: the header's crumbs, quote, title and
   buttons are left to clicks, and a swipe on the header scrolls. The order is state.conv.ui.open. */
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
      if(state.conv.ui.open.length<2)return;
      st={tid:h.parentElement.dataset.tid,pane:h.parentElement,x:e.clientX,y:e.clientY,id:e.pointerId,touch:true,on:false,timer:0};
      st.timer=setTimeout(()=>{if(st&&st.touch&&!st.on)begin()},PANE_HOLD_MS);return}
    if(!g||e.button>0)return;   // a collapsed strip is its own grip: a click still expands it
    const pane=g.classList.contains('pane')?g:g.parentElement.parentElement;if(state.conv.ui.open.length<2)return;
    e.preventDefault();
    st={tid:pane.dataset.tid,pane,x:e.clientX,y:e.clientY,id:e.pointerId,touch:false,on:false,timer:0};
  });
  function begin(){st.on=true;st.pane.classList.add('pdrag');$('#panes').classList.add('reordering');getSelection().removeAllRanges();if(navigator.vibrate)try{navigator.vibrate(10)}catch(_){}}
  document.addEventListener('pointermove',e=>{
    if(!st||e.pointerId!==st.id)return;
    const moved=Math.hypot(e.clientX-st.x,e.clientY-st.y);
    if(!st.on){if(st.touch){if(moved>8){clearTimeout(st.timer);st=null}return}if(moved<6)return;begin()}
    const wrap=$('#panes'),cols=state.conv.ui.layout==='cols',pos=cols?e.clientX:e.clientY;
    const wr=wrap.getBoundingClientRect(),edge=cols?[wr.left,wr.right]:[wr.top,wr.bottom];   // scroll along near the edges
    if(pos<edge[0]+40)wrap[cols?'scrollLeft':'scrollTop']-=14;else if(pos>edge[1]-40)wrap[cols?'scrollLeft':'scrollTop']+=14;
    const others=[...wrap.querySelectorAll(':scope>.pane')].filter(p=>p!==st.pane);
    let idx=others.filter(p=>{const r=p.getBoundingClientRect();return (cols?r.left+r.width/2:r.top+r.height/2)<pos}).length;
    const order=state.conv.ui.open.filter(x=>x!==st.tid);order.splice(idx,0,st.tid);
    if(order.join()!==state.conv.ui.open.join()){state.conv.ui.open=order;layout()}
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
  const prev=g.previousElementSibling;
  if(prev&&prev.classList.contains('pane')&&!prev.classList.contains('rail'))return {tid:prev.dataset.tid,el:prev,sign:1};
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
  const cols=state.conv.ui.layout==='cols';const r=el.getBoundingClientRect();
  drag={tid,el,cols,sign,start:cols?e.clientX:e.clientY,size:cols?r.width:r.height,g,at:cols?e.clientX:e.clientY,raf:0,t:0};g.classList.add('drag');(()=>{try{g.setPointerCapture(e.pointerId)}catch(_){}})();
  drag.el.classList.add('sized');const min=drag.cols?(innerWidth<=760?220:360):200;   // phones: narrow enough for two side by side
  const d0=drag,box=$('#panes');
  const raw=()=>Math.max(min,d0.size+(d0.at-d0.start)*d0.sign);   // where the pointer puts the handle
  const set=s=>{d0.el.style.flex=`0 0 ${s}px`;state.conv.ui.sizes[d0.tid]=Math.round(s);wiresSoon();return s};
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
  const svg=$('#wires');if(!state.conv||state.conv.ui.view==='canvas'){svg.innerHTML='';return}
  const st=$('#stage').getBoundingClientRect(),pr=$('#panes').getBoundingClientRect();
  const cols=state.conv.ui.layout==='cols';let out='',defs='';
  for(const tid of state.conv.ui.open){
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
    const gap=state.conv.ui.open.indexOf(tid)-state.conv.ui.open.indexOf(pid);
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


  return {
    msgKey, openUsage, closeUsage, buildFoot, branchChips, streamInto, webSources, queueStream, updateJump, rememberSpot, autosize, submit, updateComposer, fitOrigin, originRO, updateHeader, altLine, sysScope, paneZoom, applyPaneZoom, editZoom, setPaneZoom, stepPaneZoom, renderPane, refreshAnchorsFor, docInDock, placeDocPane, layout, closeRailStack, get drag() { return drag; }, set drag(v) { drag = v; }, wiresSoon, wires,
  };
}
