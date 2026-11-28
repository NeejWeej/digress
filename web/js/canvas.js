// Canvas view: infinite pan/zoom board, card layout, edge wires, docking/snapping, and saved views.
import { esc, trunc, plain } from './text.js';
import { isDocBranch } from './context.js';
import {
  state, app, paneEls, cvMsgCache, streaming, $, ic, rid, qid,
  T, color, children, branchesOn, hiddenNow, branchNum, isCollapsed,
  resetThreadIdx,
} from './state.js';
import { getPending, takePending, renderPending, userMsgBody } from './media.js';
import { copyText } from './render.js';
import { invalidate, onRedraw } from './redraw.js';

export function createCanvas() {
  // the parts of the page this module draws, for invalidate('…') from the others (web/js/redraw.js)
  onRedraw('canvas', renderCanvas);
  onRedraw('edges-soon', drawEdgesSoon);
  const altLine = (...a) => app.altLine(...a);
  const applyAnchors = (...a) => app.applyAnchors(...a);
  const askConfirm = (...a) => app.askConfirm(...a);
  const branchChips = (...a) => app.branchChips(...a);
  const buildFoot = (...a) => app.buildFoot(...a);
  const closeThread = (...a) => app.closeThread(...a);
  const continueReply = (...a) => app.continueReply(...a);
  const createBranch = (...a) => app.createBranch(...a);
  const docBranches = (...a) => app.docBranches(...a);
  const docInDock = (...a) => app.docInDock(...a);
  const docPagesLabel = (...a) => app.docPagesLabel(...a);
  const docReads = (...a) => app.docReads(...a);
  const docThumbUrl = (...a) => app.docThumbUrl(...a);
  const docViewReady = (...a) => app.docViewReady(...a);
  const editZoom = (...a) => app.editZoom(...a);
  const hidePop = (...a) => app.hidePop(...a);
  const holdScroll = (...a) => app.holdScroll(...a);
  const joinable = (...a) => app.joinable(...a);
  const msgKey = (...a) => app.msgKey(...a);
  const openDocPane = (...a) => app.openDocPane(...a);
  const openReplyMenu = (...a) => app.openReplyMenu(...a);
  const openThread = (...a) => app.openThread(...a);
  const openUsage = (...a) => app.openUsage(...a);
  const placeDocPane = (...a) => app.placeDocPane(...a);
  const redo = (...a) => app.redo(...a);
  const renderMermaid = (...a) => app.renderMermaid(...a);
  const renderPane = (...a) => app.renderPane(...a);
  const renderRich = (...a) => app.renderRich(...a);
  const retry = (...a) => app.retry(...a);
  const revealDocAnchor = (...a) => app.revealDocAnchor(...a);
  const revealMsg = (...a) => app.revealMsg(...a);
  const revealPane = (...a) => app.revealPane(...a);
  const save = (...a) => app.save(...a);
  const send = (...a) => app.send(...a);
  const setDraft = (...a) => app.setDraft(...a);
  const draftOf = (...a) => app.draftOf(...a);
  const setStatus = (...a) => app.setStatus(...a);
  const streamInto = (...a) => app.streamInto(...a);
  const syncPicker = (...a) => app.syncPicker(...a);
  const takeawayCuts = (...a) => app.takeawayCuts(...a);
  const tkcutEl = (...a) => app.tkcutEl(...a);
  const toast = (...a) => app.toast(...a);
  const webSources = (...a) => app.webSources(...a);
/* ---------- canvas view ---------- */
const cam={x:40,y:40,k:1};let camFitted=false;
const CW=320,CWX=580,HG=90,VG=26;
function kidsOf(tid){
  if(tid==='doc')return [T('main'),...docBranches().filter(c=>!hiddenNow(c.id))];
  const k=children(tid).filter(c=>!hiddenNow(c.id));return tid==='main'&&state.conv.doc?k.filter(c=>!isDocBranch(c)):k;
}
function visParentId(tid){if(tid==='doc')return null;if(tid==='main')return state.conv.doc?'doc':null;const t=T(tid);return t?(isDocBranch(t)?'doc':t.parent):null}
function cvState(){const u=state.conv.ui;u.cv=u.cv||{};u.cv.pos=u.cv.pos||{};u.cv.size=u.cv.size||{};u.cv.open=u.cv.open||[];u.cv.fold=u.cv.fold||[];return u.cv}
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
  if(!state.conv.msgs[mid])return;
  switch(a){
    case 'wbranch':createBranch(mid,'',null);break;
    case 'rmore':openReplyMenu(btn,mid);break;
    case 'ctxinfo':openUsage(btn,mid);break;
    case 'copy':copyText(state.conv.msgs[mid].content).then(()=>toast('Copied'),()=>toast('Copy isn\'t allowed here'));break;
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
  for(const id of Object.keys(S.dock))if(!(state.conv.threads[id]||(id==='doc'&&state.conv.doc)))delete S.dock[id];
  const keep={},prevNodes=new Map();
  $('#cv').querySelectorAll('.cnode').forEach(n=>{
    const id=n.dataset.ctid;prevNodes.set(id,n);
    const f=n.querySelector('.cfull'),i=n.querySelector('.cask textarea');
    keep[id]={st:f?f.scrollTop:0,v:i?i.value:'',focus:i&&document.activeElement===i};
  });
  S.open=S.open.filter(id=>state.conv.threads[id]);S.fold=S.fold.filter(id=>state.conv.threads[id]||(id==='doc'&&state.conv.doc));
  const descMemo=new Map();
  const descCount=(id)=>{if(descMemo.has(id))return descMemo.get(id);let c=0;for(const k of kidsOf(id))c+=1+descCount(k.id);descMemo.set(id,c);return c};
  const nodes={},rebuilt=new Set();
  for(const t of Object.values(state.conv.threads)){
    if(foldHidden(t.id))continue;
    const docked=!!S.dock[t.id],exp=S.open.includes(t.id)||docked,kids=kidsOf(t.id),folded=S.fold.includes(t.id),nd=kids.length?descCount(t.id):0;
    const mids=(state.conv.order[t.id]||[]).filter(id=>state.conv.msgs[id]);
    const cuts=exp?takeawayCuts(t.id):null;
    const sz=S.size[t.id],dk=S.dock[t.id];
    let csig=`${state.conv.id}|${t.id}|${t.parent?t.title:state.conv.title}|${t.resolved?1:0}|${t.colorIdx}|${t.alt?1:0}|${t.alt&&joinable(t)?1:0}|${t.anchorMsg||''}|${t.anchorText||''}|${exp?1:0}|${docked?1:0}|${folded?1:0}|${kids.length}|${nd}|${S.cz[t.id]||''}|${sz?sz.w+'x'+sz.h:''}|${dk?dk.x+','+dk.y+','+dk.w+','+dk.h:''}|${getPending(t.id).length}|${cvPrev.has(cvPrevKey(t.id))?1:0}|`;
    if(exp){
      for(const mid of mids){const m=state.conv.msgs[mid];csig+=(m.pending?'P'+Math.random():msgKey(m))+';';if(cuts&&cuts.has(mid))csig+='c'+cuts.get(mid).length+';'}
    }else{
      csig+=mids.length+':';
      for(const mid of mids){const m=state.conv.msgs[mid];const bs=branchesOn(mid);csig+=mid+m.role+(m.content||'').length+(m.ver||0)+bs.map(b=>b.id+(b.resolved?'r':'')+b.colorIdx+branchNum(b)).join(',')+';'}
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
    n.querySelector('.ct').textContent=t.parent?t.title:(state.conv.title||'Main thread');
    const cq=n.querySelector('.cq');
    if(cq&&t.alt){   // another version or a moved-out part: say which, where it starts, and offer to use it or move it back, as the pane does
      cq.classList.add('cqw','cqv');cq.title=joinable(t)?'Show the message this came after, in the card it came from':'Show the version it\'s an alternative to, in the card it came from';
      cq.innerHTML=altLine(t,40,false)}
    else if(cq&&t.anchorText){cq.textContent=t.anchorText;cq.title='Jump to this passage in the card it came from'}
    else if(cq){cq.textContent='The whole reply';cq.classList.add('cqw');cq.title='Jump to the reply this branch is about, in the card it came from'}
    if(exp){
      const full=document.createElement('div');full.className='cfull';
      if(!mids.length)full.innerHTML='<div class="empty" style="padding:12px 0">Nothing here yet. Ask below.</div>';
      for(const mid of mids){full.appendChild(canvasMsgEl(state.conv.msgs[mid]));for(const nn of cuts.get(mid)||[])full.appendChild(tkcutEl(nn))}
      n.appendChild(full);
      const cj=document.createElement('div');cj.className='cjump';
      cj.innerHTML=`<button class="ib cjp" data-cact="jprev" title="Return to where you were reading before you jumped here">${ic('jprev')}</button><button class="ib" data-cact="jlast" title="Jump to the start of the latest reply">${ic('jlast')}</button><button class="ib" data-cact="jend" title="Jump to the very bottom">${ic('jend')}</button>`;
      n.appendChild(cj);
      const ask=document.createElement('div');ask.className='cask';
      ask.innerHTML=`<textarea rows="1" placeholder="${t.parent?'Ask a follow-up in this branch…':'Ask anything…'}"></textarea><button class="sendb" data-cact="ask" title="Send (Enter). Shift+Enter adds a new line.">${ic('send')}</button>`;
      n.appendChild(ask);if(getPending(t.id).length)queueMicrotask(()=>renderPending(t.id));
      const cta=ask.querySelector('textarea');cta.addEventListener('input',()=>{autosizeCask(cta);setDraft(t.id,cta.value,cta)});
      const k=keep[t.id],dv=k&&k.v||draftOf(t.id);if(dv){cta.value=dv;requestAnimationFrame(()=>autosizeCask(cta))}
      const upd=()=>{n.classList.toggle('away',full.scrollHeight-full.scrollTop-full.clientHeight>100);
        const k=cvPrevKey(t.id),p=cvPrev.get(k);if(p&&!p.jumping&&Math.abs(full.scrollTop-p.top)<40){cvPrev.delete(k);n.classList.remove('hasprev')}};
      if(cvPrev.has(cvPrevKey(t.id)))n.classList.add('hasprev');   // survives the card being redrawn
      full.addEventListener('scroll',()=>{drawEdgesSoon();upd()},{passive:true});requestAnimationFrame(upd);
    }else{
      const rows=document.createElement('div');rows.className='crs';
      // a long thread's summary keeps only its first exchange, every message a branch comes off (the lines between
      // cards start there) with the question before it and its latest exchange; each run in between is one "⋯ N more" row that expands the card there
      const show=mids.length<=CARD_ROWS_ALL?null:new Set([...mids.slice(0,2),...mids.slice(-2),...mids.flatMap((id,i)=>branchesOn(id).length?[id,...(i&&state.conv.msgs[mids[i-1]].role==='user'?[mids[i-1]]:[])]:[])]);
      let gap=[];const flush=()=>{if(!gap.length)return;const r=document.createElement('div');r.className='cr gap';r.dataset.cmid=gap[0];
        r.textContent=`⋯ ${gap.length} more message${gap.length>1?'s':''}`;r.title='Expand the card here (shrink it back with its top bar\'s button)';rows.appendChild(r);gap=[]};
      for(const mid of mids){
        if(show&&!show.has(mid)){gap.push(mid);continue}
        flush();
        const m=state.conv.msgs[mid];
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
  if(state.conv.doc&&S.dock.doc){
    // stuck to the screen: the real document pane (the one Columns shows) sits in it, at reading size, so
    // pages stay sharp and highlighting, snips, zoom and page jumps all work as in the pane (placeDocPane)
    const whole=S.dock.doc.w>=.99&&S.dock.doc.h>=.99;
    const dsig=`doc-dock|${state.conv.id}|${state.conv.doc.name}|${whole?1:0}|${S.dock.doc.x},${S.dock.doc.y},${S.dock.doc.w},${S.dock.doc.h}`;
    const prev=prevNodes.get('doc');
    if(prev&&prev.__csig===dsig&&prev.parentElement===dock){
      prev.classList.remove('flash');prevNodes.delete('doc');nodes.doc=prev;
    }else{
      const n=document.createElement('div');n.className='cnode main docnode docked docpanecard';n.dataset.ctid='doc';n.style.setProperty('--c','var(--faint)');n.__csig=dsig;
      // Expand fills the canvas; dragging it to a side edge (or Side) keeps it to half, with the canvas beside it
      n.innerHTML=`<div class="ch" title="Drag to move it, or to another edge. Double-click to open the document in the pane view."><span class="docico">${ic('doc')}</span><span class="ct"></span>${whole?`<button class="ib" data-cact="docside" title="Keep it to the left half, with the canvas beside it (or drag it to an edge)">${ic('side')}</button>`:`<button class="ib" data-cact="docdock" title="Fill the canvas with the document">${ic('expand')}</button>`}<button class="ib" data-cact="restore" title="Put it back on the canvas as a card (Esc)">${ic('unfocus')}</button><button class="ib" data-cact="panes" title="Open the document in the pane view">${ic('cols')}</button></div><div class="cdocpane"></div>`;
      n.querySelector('.ct').textContent=state.conv.doc.name;
      addSizing(n,'doc',true,S);
      if(prev){prev.remove();prevNodes.delete('doc')}
      dock.appendChild(n);nodes.doc=n;
    }
  }else if(state.conv.doc){
    const nb=docBranches(),folded=S.fold.includes('doc'),nd=descCount('doc');
    const hasThumb=docViewReady()&&state.docState.kind==='pdf'&&state.docState.pdf;
    const dsig=`doc-card|${state.conv.id}|${state.conv.doc.name}|${folded?1:0}|${nd}|${hasThumb?1:0}|${docViewReady()?(state.docState.kind==='pdf'?state.docState.n:'t'):'l'}|${nb.map(b=>b.id+(b.resolved?'r':'')+b.colorIdx+branchNum(b)+b.anchorText).join(';')}`;
    const prev=prevNodes.get('doc');
    if(prev&&prev.__csig===dsig&&prev.parentElement===world){
      prev.classList.remove('flash');prevNodes.delete('doc');nodes.doc=prev;
    }else{
      const n=document.createElement('div');n.className='cnode main docnode';n.dataset.ctid='doc';n.style.setProperty('--c','var(--faint)');n.__csig=dsig;
      n.innerHTML=`<div class="ch" title="Drag to move. Double-click to open the document."><span class="docico">${ic('doc')}</span><span class="ct"></span><button class="fold${folded?' on':''}" data-cact="fold" title="${folded?'Show':'Hide'} everything below the document">${folded?'+'+nd:ic('minus').replace('class="i"','class="i" style="width:12px;height:12px"')+(nb.length+1)}</button><button class="ib" data-cact="docdock" title="Read the document here, filling the canvas (or drag this card to an edge to keep it to one side)">${ic('expand')}</button><button class="ib" data-cact="panes" title="Open the document in the pane view">${ic('cols')}</button></div><div class="crs"></div>`;
      n.querySelector('.ct').textContent=state.conv.doc.name;
      const rows=n.querySelector('.crs');
      if(hasThumb){   // first page preview; fixed height, so the layout doesn't shift when the image arrives
        const th=document.createElement('div');th.className='cthumb';th.dataset.cact='panes';th.title='Open the document';rows.before(th);
        docThumbUrl().then(u=>{if(!th.isConnected)return;if(!u){th.remove();return}const img=new Image();img.alt='First page of '+state.conv.doc.name;img.src=u;th.appendChild(img)});
      }
      const info=document.createElement('div');info.className='cr a';info.textContent=docViewReady()?(state.docState.kind==='pdf'?`${state.docState.n} pages`:'Text document'):'Loading…';rows.appendChild(info);
      for(const b of nb){const r=document.createElement('div');r.className='cr';r.dataset.cdocrow=b.id;r.title='Go to this branch';
        const f=document.createElement('span');f.className='fns';const sp=document.createElement('sup');sp.className='fn'+(b.resolved?' res':'');sp.dataset.tid=b.id;sp.style.setProperty('--c',color(b));sp.textContent=branchNum(b);f.appendChild(sp);r.appendChild(f);
        r.append((state.conv.doc.kind==='pdf'?`${docPagesLabel(b)} · `:'')+'“'+trunc(b.anchorText,70)+'”');rows.appendChild(r)}
      addSizing(n,'doc',false,S);
      if(prev){prev.remove();prevNodes.delete('doc')}
      world.appendChild(n);nodes.doc=n;
    }
  }
  for(const stale of prevNodes.values())stale.remove();
  cvNodes=new Map(Object.entries(nodes));
  // positions: saved positions win; unsaved cards sit where the automatic layout puts them, relative to their parent
  const auto={},colW=[],depthOf={};
  const root=state.conv.doc?'doc':'main';
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
  markHere();placeDocPane();invalidate('badges');
}
let edgeRAF=0;
function drawEdgesSoon(){if(!edgeRAF)edgeRAF=requestAnimationFrame(()=>{edgeRAF=0;drawEdges()})}
/* a card's box in canvas units, whether it lives on the canvas or is stuck to the screen */
function boxW(el,wr){
  if(el.classList.contains('docked')){const r=el.getBoundingClientRect();return {offsetLeft:(r.left-wr.left)/cam.k,offsetTop:(r.top-wr.top)/cam.k,offsetWidth:r.width/cam.k,offsetHeight:r.height/cam.k}}
  return {offsetLeft:el.offsetLeft,offsetTop:el.offsetTop,offsetWidth:el.offsetWidth,offsetHeight:el.offsetHeight};
}
function drawEdges(){
  const world=$('#world'),edges=$('#edges');if(!state.conv||state.conv.ui.view!=='canvas'){return}
  const wr=world.getBoundingClientRect();let paths='';
  for(const t of Object.values(state.conv.threads)){
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
  const ok=tid=>state.conv.ui.open.includes(tid)&&!isCollapsed(tid)&&paneEls.has(tid);
  if(lastPane&&lastPane.cid===state.conv.id&&ok(lastPane.tid))return lastPane.tid;
  const pr=$('#panes').getBoundingClientRect();let best=null,area=0;   // else the one most in view (the later on a tie)
  for(const tid of state.conv.ui.open){if(!ok(tid))continue;const r=paneEls.get(tid).getBoundingClientRect();
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
for(const t of ['pointerdown','focusin','wheel'])$('#panes').addEventListener(t,e=>{const p=e.target.closest&&e.target.closest('.pane[data-tid]');if(p&&state.conv&&(t==='pointerdown'||!p.classList.contains('rail'))){lastPane={cid:state.conv.id,tid:p.dataset.tid};markCur()}},{passive:true,capture:true});
// The pane the keyboard acts on (⌘\ collapse, ⌘⇧\ close): the one last clicked, typed in or scrolled. A strip
// counts, so ⌘\ again expands what it just collapsed. Outlined faintly (.cur) when there's more than one pane.
function curPane(){
  if(!state.conv||state.conv.ui.view==='canvas')return null;
  if(lastPane&&lastPane.cid===state.conv.id&&state.conv.ui.open.includes(lastPane.tid)&&paneEls.has(lastPane.tid))return lastPane.tid;
  return focusedPane();
}
function markCur(){const c=state.conv&&state.conv.ui.view!=='canvas'&&state.conv.ui.open.length>1?curPane():null;for(const [tid,el] of paneEls)el.classList.toggle('cur',tid===c);syncPicker()}
// ⌘⇧\: close the current pane; the one after it (or before) becomes current. Undo puts it all back.
function keyClose(tid){
  const ui=state.conv.ui;if(ui.open.length<2){toast('At least one pane stays open');return}
  const before={open:[...ui.open],collapsed:[...ui.collapsed]},i=ui.open.indexOf(tid),next=ui.open[i+1]||ui.open[i-1];
  const name=tid==='doc'?'the document':tid==='main'?'the main thread':`“${trunc(T(tid).title||'branch',40)}”`;
  closeThread(tid,{quiet:true});lastPane={cid:state.conv.id,tid:next};markCur();
  const c0=state.conv;
  toast(`Closed ${name}.`,{label:'Undo',fn:()=>{if(state.conv!==c0)return;const u=state.conv.ui;
    u.open=before.open.filter(x=>x==='doc'?!!state.conv.doc:!!T(x));u.collapsed=before.collapsed.filter(x=>u.open.includes(x));
    lastPane={cid:state.conv.id,tid};invalidate('panes');invalidate('map');revealPane(tid);save();markCur()}});
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
  const S=cvState();S.z=(S.z||[]).filter(x=>x!==tid&&(x==='doc'||state.conv.threads[x]));S.z.push(tid);S.sel=tid;applyStack();
}
function applyStack(){
  const S=cvState(),z=S.z||[];
  $('#cv').querySelectorAll('.cnode').forEach(n=>{const i=z.indexOf(n.dataset.ctid);n.style.zIndex=i<0?1:i+2;n.classList.toggle('picked',S.sel===n.dataset.ctid)});
  syncPicker();
}
// where a card was being read before "jump to the passage" moved it ({top, jumping}), per conversation and card,
// outside the card's element because the canvas redraws cards; the card's Return button (cjp) goes back to it
const cvPrev=new Map(),cvPrevKey=tid=>state.conv.id+'|'+tid;
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
  else if(act==='panes'){if(tid==='doc'){setView(state.conv.ui.layout);openDocPane();revealPane('doc')}else openFromCanvas(tid)}   // docked or not: to Columns/Rows, document open
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
  else if(act==='ask'){if(streaming.has(tid))return;const i=btn.closest('.cnode').querySelector('.cask textarea');const v=i.value.trim();if(!v&&!getPending(tid).length)return;const imgs=takePending(tid);i.value='';autosizeCask(i);setDraft(tid,'');send(tid,v,imgs)}
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
  // in the docked document or a card it passes over, and checkSelection opens no branch popup from it (state.cvTook)
  const cvTake=()=>{state.cvTook=true;document.documentElement.classList.add('cvnosel');const s=getSelection();if(s&&!s.isCollapsed)s.removeAllRanges()};
  document.addEventListener('pointerdown',()=>{state.cvTook=false},true);   // a new press starts out nobody's
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
      for(const [_id,s] of Object.entries(cd.start)){s.el.style.left=(s.x+dx)+'px';s.el.style.top=(s.y+dy)+'px'}
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
   docked, their zoom, where the camera is), kept in the conversation (state.conv.views), so all your devices have
   it. The canvas itself is per device (it's in the layout). Loading a view copies it onto this device's
   canvas: moving cards afterwards changes only this device until you choose Update. "This device" goes back
   to the arrangement this device had before it loaded a view (ui.cvOwn). Nothing changes unless you use them. */
const cvSnap=()=>({cv:JSON.parse(JSON.stringify(cvState())),cam:{x:cam.x,y:cam.y,k:cam.k}});
function cvLoad(snap){state.conv.ui.cv=JSON.parse(JSON.stringify(snap.cv||{}));if(snap.cam){Object.assign(cam,snap.cam);camFitted=true}renderCanvas();applyCam();save()}
function useView(vid){
  const ui=state.conv.ui;
  if(!vid){if(ui.cvOwn)cvLoad(ui.cvOwn);delete ui.cvOwn;delete ui.cvView}
  else{const v=(state.conv.views||{})[vid];if(!v)return;if(!ui.cvView)ui.cvOwn=cvSnap();ui.cvView=vid;cvLoad(v)}
  syncViewsUI();save();
}
function saveView(name){
  name=(name||'').trim().slice(0,60);if(!name)return;
  const id='v'+rid();state.conv.views=state.conv.views||{};state.conv.views[id]={name,...cvSnap(),at:Date.now()};
  state.conv.ui.cvView=id;syncViewsUI();save();setStatus(`Saved “${name}”`);
}
function updateView(vid){const v=(state.conv.views||{})[vid];if(!v)return;Object.assign(v,cvSnap(),{at:Date.now()});syncViewsUI();save();setStatus(`Updated “${v.name}”`)}
function deleteView(vid){const v=(state.conv.views||{})[vid];if(!v)return;delete state.conv.views[vid];if(!Object.keys(state.conv.views).length)delete state.conv.views;if(state.conv.ui.cvView===vid)delete state.conv.ui.cvView;syncViewsUI();save()}
function syncViewsUI(){
  const b=$('#zViews');if(!b||!state.conv)return;
  const v=state.conv.ui.cvView&&(state.conv.views||{})[state.conv.ui.cvView];if(state.conv.ui.cvView&&!v)delete state.conv.ui.cvView;
  b.innerHTML=ic('views')+`<span class="vn">${esc(v?v.name:'Views')}</span>`;
  const m=$('#cvViews');if(m&&m.classList.contains('open'))renderViewsMenu();
}
function renderViewsMenu(edit){
  const m=$('#cvViews'),cur=state.conv.ui.cvView,vs=Object.entries(state.conv.views||{}).sort((a,b)=>a[1].name.localeCompare(b[1].name));
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
    const d=e.target.closest('[data-vdel]');if(d){const v=state.conv.views[d.dataset.vdel];closeViews();askConfirm('Delete this view?',`<b>${esc(v.name)}</b> will be removed from all your devices. The canvas stays as it is.`,()=>deleteView(d.dataset.vdel))}
  });
  m.addEventListener('submit',e=>{
    e.preventDefault();const f=e.target,name=f.querySelector('input').value;
    if(f.dataset.vren){const v=state.conv.views[f.dataset.vren];if(v&&name.trim()){v.name=name.trim().slice(0,60);save()}syncViewsUI();renderViewsMenu();return}
    saveView(name);closeViews();
  });
  m.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeViews();$('#zViews').focus()}});
  document.addEventListener('pointerdown',e=>{if(m.classList.contains('open')&&!m.contains(e.target)&&!e.target.closest('#zViews'))closeViews()});
})();
function openFromCanvas(tid,mid){
  setView(state.conv.ui.layout);
  openThread(tid);state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==tid);invalidate('panes');
  if(mid)revealMsg(tid,mid);
}
function setView(v){
  if(v!=='canvas')clearHere();
  // the panes are hidden while the canvas shows, and Safari forgets a hidden element's scroll: note each pane's, to put back
  if(v==='canvas'&&state.conv.ui.view!=='canvas')for(const [tid,el] of paneEls){if(tid==='doc')continue;const pb=el.querySelector(':scope>.pb');if(pb)el.__viewTop=pb.scrollTop}   // (the document keeps its own spot: noteDocSpot)
  if(v==='canvas'){const from=state.conv.ui.view!=='canvas'?focusedPane():null;state.conv.ui.view='canvas';$('#stage').classList.add('canvas');hidePop();renderCanvas();if(from)requestAnimationFrame(()=>cvArrive(from))}
  else{
    const was=state.conv.ui.view;state.conv.ui.view='panes';$('#stage').classList.remove('canvas');
    if(v!==state.conv.ui.layout){state.conv.ui.layout=v;state.conv.ui.sizes={}}
    invalidate('panes');if(was==='canvas'){state.conv.ui.open.forEach(id=>renderPane(id));
      for(const [,el] of paneEls){const pb=el.querySelector(':scope>.pb');if(pb&&el.__viewTop!=null&&el.isConnected&&Math.abs(pb.scrollTop-el.__viewTop)>1)holdScroll(pb,el.__viewTop);el.__viewTop=null}}
  }
  syncViewSeg();save();
}
// Tab name: the conversation's title ("Bayes' rule · Digress"), kept in step by renderTitle. It does end up in browser
// history and the OS window switcher; the reader chose that over the old "Digress 2 · Canvas", which said nothing useful.
// a reply that finished while this tab was in the background puts a dot in front of the tab's name until you come back
let tabReady=false;
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tabReady){tabReady=false;if(state.conv)tabName()}});
function tabName(){if(!state.conv)return;const t=`${tabReady?'● ':''}${state.conv.title||'New conversation'} · Digress`;if(document.title!==t)document.title=t}
function syncViewSeg(){tabName();const v=state.conv.ui.view==='canvas'?'canvas':state.conv.ui.layout;document.querySelectorAll('#viewSeg button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
  $('#resetOrder').style.display=state.conv.ui.view!=='canvas'&&state.conv.ui.open.join()!==branchOrder().join()?'':'none'}
// the order panes open in: the document, then main, each branch right after the thread it came from (oldest first)
function branchOrder(){
  const open=state.conv.ui.open,out=open.includes('doc')?['doc']:[];
  const walk=(tid)=>{if(open.includes(tid))out.push(tid);for(const c of children(tid))walk(c.id)};walk('main');
  for(const x of open)if(!out.includes(x))out.push(x);return out;
}
$('#resetOrder').addEventListener('click',()=>{state.conv.ui.open=branchOrder();invalidate('panes');save()});


  return {
    cam, CW, kidsOf, cvState, descendants, applyCam, replyAct, statusDot,
    get cvNodes() { return cvNodes; }, set cvNodes(v) { cvNodes = v; },
    renderCanvas, drawEdgesSoon, fitCanvas, focusCard,
    get lastPane() { return lastPane; }, set lastPane(v) { lastPane = v; },
    clearHere, curPane, markCur, keyClose, contentScale, REGIONS, placeDocked, dockCard,
    restoreCard, canvasRevealSource, canvasAction, syncViewsUI, closeViews, setView,
    get tabReady() { return tabReady; }, set tabReady(v) { tabReady = v; },
    get camFitted() { return camFitted; }, set camFitted(v) { camFitted = v; },
    tabName, syncViewSeg, autosizeCask,
  };
}
