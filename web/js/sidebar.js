// Sidebar: conversation list, folders, tree map, branch list popover, pins, archive, and trash.
import { esc, trunc } from './text.js';
import { isDocBranch } from './context.js';
import {
  state, app, io, CUSTOM, defaultSys, paneEls, streaming,
  PALETTE, $, ic, T, color, hiddenNow, isCollapsed, newConv,
} from './state.js';

export function createSidebar() {
  const askConfirm = (...a) => app.askConfirm(...a);
  const cardsChoice = (...a) => app.cardsChoice(...a);
  const convInfo = (...a) => app.convInfo(...a);
  const deleteConv = (...a) => app.deleteConv(...a);
  const descendants = (...a) => app.descendants(...a);
  const docBranches = (...a) => app.docBranches(...a);
  const docPagesLabel = (...a) => app.docPagesLabel(...a);
  const flushNow = (...a) => app.flushNow(...a);
  const focusCard = (...a) => app.focusCard(...a);
  const inInbox = (...a) => app.inInbox(...a);
  const kidsOf = (...a) => app.kidsOf(...a);
  const layout = (...a) => app.layout(...a);
  const leaveOk = (...a) => app.leaveOk(...a);
  const markBack = (...a) => app.markBack(...a);
  const markReplies = (...a) => app.markReplies(...a);
  const openConv = (...a) => app.openConv(...a);
  const openThread = (...a) => app.openThread(...a);
  const renderBack = (...a) => app.renderBack(...a);
  const renderCanvas = (...a) => app.renderCanvas(...a);
  const renderPane = (...a) => app.renderPane(...a);
  const revealPane = (...a) => app.revealPane(...a);
  const save = (...a) => app.save(...a);
  const savePrompts = (...a) => app.savePrompts(...a);
  const setConv = (...a) => app.setConv(...a);
  const setConvSystem = (...a) => app.setConvSystem(...a);
  const setStatus = (...a) => app.setStatus(...a);
  const sideFold = (...a) => app.sideFold(...a);
  const statusDot = (...a) => app.statusDot(...a);
  const stopReply = (...a) => app.stopReply(...a);
  const syncCardsUI = (...a) => app.syncCardsUI(...a);
  const tabName = (...a) => app.tabName(...a);
  const toast = (...a) => app.toast(...a);
  const updateHeader = (...a) => app.updateHeader(...a);
  Object.defineProperty(state, 'convListLoaded', {
    get: () => convListLoaded,
    set: (v) => { convListLoaded = v; },
    enumerable: true,
    configurable: true,
  });
/* ---------- sidebar ---------- */
function renderTitle(){const el=$('#cTitle');if(document.activeElement!==el)el.textContent=state.conv.title||'New conversation';updateHeader('main');tabName()}
// the branch count in a pane's header opens a list of those branches (the sidebar's tree from that pane down)
function brCount(tid,nb,always){const l=`${nb} branch${nb===1?'':'es'}`;return nb||always?`<button type="button" class="bcount" data-brlist="${esc(tid)}" title="${tid==='doc'?'See the branches off the document, and the main thread':'See the branches off this'}">${l}</button>`:l}
let brPop=null;   // {tid, el, btn}
function closeBrList(){if(!brPop)return;brPop.el.remove();brPop.btn&&brPop.btn.classList.remove('on');brPop=null}
function fillBrList(){
  if(!brPop)return;const {tid,el}=brPop;
  if(!state.conv||brPop.conv!==state.conv.id||(tid!=='doc'&&!T(tid))||(tid==='doc'&&!state.conv.doc)){closeBrList();return}
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
  document.body.appendChild(el);brPop={tid,el,btn,conv:state.conv.id};btn.classList.add('on');fillBrList();
}
addEventListener('resize',()=>placeBrList());
document.addEventListener('scroll',e=>{if(brPop&&!brPop.el.contains(e.target))placeBrList()},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&brPop){closeBrList();e.stopPropagation();e.preventDefault()}},true);
// one row of the branch tree (and its subtree): the sidebar's, or with o.lite the header's branch list (no fold, no row buttons)
function mapNode(tid,o){
  const fold=o.lite?[]:o.fold,chev=o.lite?()=>'':o.chev,hiddenBadge=o.lite?()=>'':o.hiddenBadge,build=id=>mapNode(id,o);
  const t=T(tid),li=document.createElement('li');
  const n=document.createElement('div');n.className='mnode'+(state.conv.ui.open.includes(tid)&&!isCollapsed(tid)?' open':'')+(t.resolved?' res':'');n.dataset.map=tid;n.style.setProperty('--c',tid==='main'?'var(--faint)':color(t));
  const cnt=(state.conv.order[tid]||[]).filter(id=>state.conv.msgs[id]&&state.conv.msgs[id].role==='user').length;
  const kids=kidsOf(tid);
  n.innerHTML=`${chev(tid,kids)}${tid==='main'?'<span class="dot"></span>':statusDot(t)}<div style="min-width:0;flex:1"><div class="mt"></div>${t.anchorText?'<div class="ma"></div>':''}</div>${hiddenBadge(tid)}<span class="mc" title="Questions asked in this thread">${cnt||''}</span>${t.pinned?`<span class="mpin" title="Pinned">${ic('pin')}</span>`:''}${tid==='main'||o.lite?'':`<span class="macts"><button class="ib mp${t.pinned?' pinned':''}" data-pinthread="${esc(tid)}" title="${t.pinned?'Unpin this branch':'Pin this branch to the top of the sidebar'}">${ic('pin')}</button><button class="ib mh" data-hideb="${esc(tid)}" title="${t.hidden?'Show this branch in the tree again':'Hide this branch (and what’s under it) from the tree and canvas; nothing is deleted'}">${ic(t.hidden?'eye':'eyeoff')}</button><button class="ib dz mx" data-delb="${esc(tid)}" title="Delete this branch and everything branched from it">${ic('trash')}</button></span>`}`;
  if(t.hidden)n.classList.add('hiddenb');
  n.title=tid==='main'?'Show the main thread':`Open “${t.title}”`+(t.anchorText?`, from “${trunc(t.anchorText,240)}”`:'');
  n.querySelector('.mt').textContent=tid==='main'?'Main thread':t.title;
  if(t.anchorText)n.querySelector('.ma').textContent=(isDocBranch(t)&&state.conv.doc.kind==='pdf'?`${docPagesLabel(t)} · `:'')+'“'+trunc(t.anchorText,60)+'”';
  li.appendChild(n);
  if(kids.length&&!fold.includes(tid)){const ul=document.createElement('ul');kids.forEach(c=>ul.appendChild(build(c.id)));li.appendChild(ul)}
  return li;
}
function renderMap(){
  const tree=$('#tree');
  const fold=state.conv.ui.tfold=(state.conv.ui.tfold||[]).filter(id=>id==='doc'?state.conv.doc:state.conv.threads[id]);
  const chev=(id,kids)=>{
    if(!kids.length)return '<span class="tchev none"></span>';
    const f=fold.includes(id),n=descendants(id).length;
    return `<button class="tchev${f?'':' open'}" data-tfold="${esc(id)}" title="${f?'Show':'Hide'} the ${n} branch${n===1?'':'es'} under this">${ic('back').replace('class="i"','class="i" style="transform:rotate(180deg)"')}</button>`;
  };
  const hiddenBadge=(id)=>{const n=descendants(id).length;return fold.includes(id)&&n?`<span class="hid" title="${n} hidden branch${n===1?'':'es'}">+${n}</span>`:''};
  const build=tid=>mapNode(tid,{fold,chev,hiddenBadge});
  const ul=document.createElement('ul');
  if(state.conv.doc){
    const li=document.createElement('li'),n=document.createElement('div');
    n.className='mnode'+(state.conv.ui.open.includes('doc')&&!isCollapsed('doc')?' open':'');n.dataset.mapdoc='1';n.title='Show the document';
    const kids=kidsOf('doc');
    n.innerHTML=`${chev('doc',kids)}<span class="docico">${ic('doc')}</span><div style="min-width:0;flex:1"><div class="mt"></div></div>${hiddenBadge('doc')}`;n.querySelector('.mt').textContent=state.conv.doc.name;
    li.appendChild(n);if(!fold.includes('doc')){const sub=document.createElement('ul');kids.forEach(c=>sub.appendChild(build(c.id)));li.appendChild(sub)}ul.appendChild(li);
  }else ul.appendChild(build('main'));
  tree.replaceChildren(ul);fillBrList();markReplies();
  const nh=Object.values(state.conv.threads).filter(t=>t.hidden).length;
  if(nh){const b=document.createElement('button');b.className='showhid';b.dataset.showhid='1';b.textContent=state.conv.ui.showHidden?'Hide the hidden branches again':`Show ${nh} hidden branch${nh>1?'es':''}`;tree.appendChild(b)}
  const any=fold.length>0,ta=$('#treeAll'),has=Object.keys(state.conv.threads).length>1;
  ta.style.visibility=has?'':'hidden';ta.textContent=any?'Expand all':'Collapse all';
  ta.title=any?'Show every branch':'Collapse every thread to its top level, so the tree is easier to scan';
}
function toggleTreeFold(id){const f=state.conv.ui.tfold||[];state.conv.ui.tfold=f.includes(id)?f.filter(x=>x!==id):[...f,id];renderMap();save()}
function treeAll(){
  if((state.conv.ui.tfold||[]).length){state.conv.ui.tfold=[]}
  else{
    // keep the top level visible: fold every thread that has branches, except the root
    const root=state.conv.doc?'doc':'main';const ids=[root,...descendants(root)];
    state.conv.ui.tfold=ids.filter(id=>id!==root&&kidsOf(id).length);
    if(!state.conv.ui.tfold.length&&kidsOf(root).length)state.conv.ui.tfold=[root];
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
  const items=state.convList.map(c=>state.conv&&c.id===state.conv.id?metaOf(state.conv):c);
  if(state.conv&&!items.find(c=>c.id===state.conv.id))items.unshift(metaOf(state.conv));
  // every save lands here; rebuild only when something shown changed, so rows don't vanish from under the pointer
  // All · Docs · Chats: only once there's a document conversation to tell apart (pinned ones always show)
  const anyDoc=items.some(c=>c.doc),filt=anyDoc?convFilt:'all';
  const fb=$('#cFilt');fb.classList.toggle('show',anyDoc);fb.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.cf===filt));
  const shown=c=>filt==='all'||(filt==='doc')===!!c.doc||(state.conv&&c.id===state.conv.id);   // the open one always shows
  // flashcards per conversation: a badge (due count) and, on hover, a button that opens just its cards
  const kc={},now=Date.now();for(const k of app.CARDS.values()){if(k.status==='suspended')continue;const e=kc[k.conv]||(kc[k.conv]={n:0,due:0,inbox:0});e.n++;if(inInbox(k))e.inbox++;else if((k.due||0)<=now&&!k.fix)e.due++}
  const sig=JSON.stringify([state.conv&&state.conv.id,archOpen,trashOpen,filt,kc,new Date().toDateString(),items.map(c=>[c.id,c.title,c.pinned,c.archived,c.trashed,c.dropCards,c.doc,c.pins,c.folder]),[...folderFolded]]);
  if(sig===convListSig&&$('#clist').childElementCount+$('#plist').childElementCount+$('#flist').childElementCount+$('#alist').childElementCount+$('#xlist').childElementCount)return;
  // two conversations with the same name (say, two on one document) are told apart by the day they started
  const names={};for(const c of items)if(!c.trashed){const n=c.title||'New conversation';names[n]=(names[n]||0)+1}
  convListSig=sig;
  const row=(c,extra)=>{
    const d=document.createElement('div');d.className='citem'+(state.conv&&c.id===state.conv.id?' cur':'');d.dataset.conv=c.id;
    const k=kc[c.id],kt=k&&`Flashcards from this conversation: ${k.due?k.due+' due':'none due'}${k.inbox?`, ${k.inbox} in the inbox`:''}`;
    d.innerHTML=`${c.doc?`<span class="docico" style="color:var(--faint)">${ic('doc').replace('class="i"','class="i" style="width:13px;height:13px"')}</span>`:''}<span class="t"></span>${extra||''}`+
      (k?`<span class="cbadge${k.due?' due':''}" title="${esc(kt)}">${ic('cards')}${k.due||''}</span>`:'')+`<span class="acts">`+
      (k?`<button class="ib${k.due?' kdue':''}" data-cardsconv="${esc(c.id)}" title="${esc(kt+'. Click to review them.')}">${ic('cards')}</button>`:'')+
      (c.archived?'':`<button class="ib${c.pinned?' pinned':''}" data-pinconv="${esc(c.id)}" title="${c.pinned?'Unpin':'Pin to the top of the sidebar'}">${ic('pin')}</button>`)+
      (c.archived||(state.conv&&c.id===state.conv.id&&isBlank(state.conv))?'':`<button class="ib" data-folderconv="${esc(c.id)}" title="${esc(c.folder?`Move to…: in “${c.folder}” now; another folder, out of it, or the archive`:'Move to…: a folder, a new one, or the archive')}">${ic('folder')}</button>`)+
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
  if(state.conv&&listCur!==state.conv.id){listCur=state.conv.id;requestAnimationFrame(()=>{for(const l of [el,pl,fl]){const r=l.querySelector('.citem.cur');if(r&&(r.offsetTop<l.scrollTop||r.offsetTop+r.offsetHeight>l.scrollTop+l.clientHeight))l.scrollTop=r.offsetTop-l.clientHeight/3}})}
  if(!el.children.length)el.innerHTML=`<div class="citem" style="cursor:default;color:var(--faint)">${filt==='doc'?'No document conversations':filt==='chat'?'No chats without a document':'No other conversations'}</div>`;
  const al=$('#alist');al.replaceChildren();arch.filter(shown).forEach(c=>al.appendChild(row(c)));
  $('#archWrap').style.display=arch.length?'':'none';$('#archLbl').textContent=`Archive · ${arch.length}`;
  $('#archToggle').classList.toggle('open',archOpen);al.classList.toggle('show',archOpen);
  // the trash: restore, or delete for good now; on its own after TRASH_DAYS
  const xl=$('#xlist');xl.replaceChildren();
  for(const c of trash){
    const d=document.createElement('div');d.className='citem'+(state.conv&&c.id===state.conv.id?' cur':'');d.dataset.conv=c.id;
    const left=trashLeft(c),when=left<=1?'goes today':`${left} days left`;
    d.innerHTML=`<span class="t"></span><span class="xleft">${when}</span><span class="acts"><button class="ib" data-restore="${esc(c.id)}" title="Restore: move back to your conversations">${ic('back')}</button><button class="ib dz" data-delnow="${esc(c.id)}" title="Delete for good now">${ic('trash')}</button></span>`;
    d.querySelector('.t').textContent=c.title||'New conversation';const df=docFate(c.id);d.dataset.tip=(c.title||'New conversation')+` · in the trash, deleted for good ${left<=1?'today':'in '+left+' days'}`+(df&&!df.shared?`, with its document “${df.name}”`:'')+(c.dropCards?`, and its flashcards`:'');d.dataset.clip='';
    xl.appendChild(d);
  }
  $('#trashWrap').style.display=trash.length?'':'none';$('#trashLbl').textContent=`Trash · ${trash.length}`;
  $('#trashToggle').classList.toggle('open',trashOpen);xl.classList.toggle('show',trashOpen);
}
var listCur=null;   // var: renderConvList may run before this line
/* Folders: state.conv.folder is a name (one per conversation, no nesting). A folder exists while something is in it,
   archived and trashed ones included (restoring one puts it back where it was). Which folders are folded is per device. */
var folderFolded=new Set();try{folderFolded=new Set(JSON.parse(localStorage.getItem('digress:ffold')||'[]'))}catch(e){}
const folderNames=(items)=>[...new Set(items.filter(c=>c.folder&&!c.trashed).map(c=>c.folder))].sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base',numeric:true}));
// the folders the sidebar shows (one whose conversations are all archived isn't offered); a name that differs only in case is the same folder
const shownFolders=()=>folderNames(allConvMeta().filter(c=>!c.archived));
const sameFolder=(f,except)=>f&&folderNames(allConvMeta()).find(n=>n!==except&&n.toLowerCase()===f.toLowerCase())||f;
const allConvMeta=()=>{const items=state.convList.map(c=>state.conv&&c.id===state.conv.id?metaOf(state.conv):c);if(state.conv&&!isBlank(state.conv)&&!items.find(c=>c.id===state.conv.id))items.unshift(metaOf(state.conv));return items};
function toggleFolder(name){folderFolded.has(name)?folderFolded.delete(name):folderFolded.add(name);try{localStorage.setItem('digress:ffold',JSON.stringify([...folderFolded]))}catch(e){}renderConvList()}
const cleanFolder=(n)=>String(n||'').replace(/\s+/g,' ').trim().slice(0,60);
async function setFolder(id,name){const f=sameFolder(cleanFolder(name));await setConvFlag(id,{folder:f});
  if(f&&folderFolded.has(f))toggleFolder(f);   // filing into a folded one opens it, so you see where it went
  setStatus(f?`Moved to “${f}”`:'Taken out of its folder');if(f)offerFolderPrompt(f,[id])}
// rename or remove a folder: every conversation in it (archived and trashed too, so none is left behind in the old name)
/* A folder's prompt (CUSTOM.prompts.folders: {name: text}) is where its new chats start: a new chat in the folder gets
   a copy as its own system prompt (state.conv.system). Nothing follows it after that: editing it changes no conversation, and
   one moved in is asked whether to switch (kept as it is unless the reader says so). */
const folderPrompts=()=>((CUSTOM.prompts&&CUSTOM.prompts.folders)||{});
const folderPrompt=(f)=>{const m=folderPrompts(),k=f&&Object.keys(m).find(n=>n.toLowerCase()===f.toLowerCase());return k?m[k]:''};
async function setFolderPrompt(f,v,from){const m={...folderPrompts()};
  for(const k of Object.keys(m))if(k.toLowerCase()===f.toLowerCase()||(from&&k.toLowerCase()===from.toLowerCase()))delete m[k];
  v=String(v||'').trim();if(v)m[f]=v;await savePrompts({folders:Object.keys(m).length?m:null})}
const convSys=(id)=>{const c=state.conv&&state.conv.id===id?state.conv:state.convList.find(x=>x.id===id);return ((c&&typeof c.system==='string'&&c.system.trim())||defaultSys()).trim()};
// conversations just moved into a folder with a prompt: switch to it? Keeping theirs is the default (Cancel, Esc)
function offerFolderPrompt(f,ids){const p=folderPrompt(f).trim();if(!p)return;
  const differ=ids.filter(id=>convSys(id)!==p);if(!differ.length)return;
  const n=differ.length,one=n===1;
  askConfirm('Use the folder’s prompt?',`<p class="ppnote"><b>${esc(f)}</b> has its own system prompt for new chats. ${one?'This conversation has a different one':`${n} of these conversations have a different one`}. Switch ${one?'it':'them'} to the folder’s from the next reply, or keep what ${one?'it has':'they have'}?</p><details class="fpview"><summary>The folder’s prompt</summary><pre></pre></details>`,
    async()=>{for(const id of differ){if(state.conv&&state.conv.id===id){setConvSystem(p);continue}await setConvFlag(id,{system:p===defaultSys().trim()?'':p})}
      setStatus(one?'It uses the folder’s prompt now':`${n} conversations use the folder’s prompt now`)},
    {ok:'Use the folder’s',cancel:one?'Keep its own':'Keep their own',kind:'primary'});
  $('#mBody .fpview pre').textContent=p}
function editFolderPrompt(f){const cur=folderPrompt(f);
  askConfirm(`Prompt for new chats in “${f}”`,`<p class="ppnote">A new chat started in this folder begins with this as its system prompt (it becomes that chat’s own, so you can still change it there). Conversations already in the folder keep theirs. Leave it empty to start new chats with your default.</p><textarea class="pptext" id="fSysEd" rows="10" spellcheck="false"></textarea>`,
    async()=>{const v=$('#fSysEd').value.trim();try{await setFolderPrompt(f,v)}catch(e){toast(e.message||'It couldn’t be saved.');return}convListSig='';renderConvList();setStatus(v?'Folder prompt saved':'New chats here start with your default')},
    {ok:'Save',kind:'primary'});
  const ta=$('#fSysEd');ta.value=cur;ta.placeholder=defaultSys();setTimeout(()=>ta.focus(),30)}
async function newChatIn(f){if(!await leaveOk())return;app.BACK.length=0;renderBack();
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
  const end=async(ok)=>{if(done)return;done=true;convRenaming=null;const to=cleanFolder(inp.value);
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
function archiveConv(id){const m=state.convList.find(c=>c.id===id)||(state.conv.id===id?metaOf(state.conv):{});const a=!m.archived;setConvFlag(id,a?{archived:true,pinned:false}:{archived:false});setStatus(a?'Archived':'Moved back to conversations')}
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
  state.modalOk=async()=>{const f=sameFolder(cleanFolder(nm.value)),ids=picked();if(!f||!ids.length)return;
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
async function openNextAfter(id){state.dirty=false;const next=state.convList.find(c=>c.id!==id&&!c.trashed&&!c.archived);if(next)await openConv(next.id);else setConv(newConv())}
// put away an empty new conversation (✕ on its only pane, or Delete): saved, it's deleted; never saved, just dropped
async function discardBlank(){const id=state.conv.id;if(state.convList.some(c=>c.id===id)){await deleteConv(id);return}await openNextAfter(id);renderConvList()}
async function trashConv(id,o={}){
  const isOpen=state.conv&&state.conv.id===id;
  if(isOpen&&isBlank(state.conv)){discardBlank();return}
  const cards=[...app.CARDS.values()].filter(c=>c.conv===id);
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
  if(isOpen){await flushNow();const next=state.convList.find(c=>c.id!==id&&!c.trashed&&!c.archived);if(next)await openConv(next.id);else{state.dirty=false;setConv(newConv())}}
  toast(`Moved to the trash. It’s deleted for good in ${TRASH_DAYS} days${df&&!df.shared?`, with its document “${trunc(df.name,40)}”`:''}.`,{label:'Undo',fn:()=>restoreConv(id)});
}
// what deleting this conversation for good does to its document: the name, and whether another conversation
// (in the trash or not) still uses the same file, which then stays
function docFate(id){
  const m=(state.conv&&state.conv.id===id)?metaOf(state.conv):state.convList.find(c=>c.id===id);if(!m||!m.doc)return null;
  const shared=!!m.asset&&[...state.convList,...(state.conv?[metaOf(state.conv)]:[])].some(c=>c.id!==id&&c.asset===m.asset);
  return {name:m.docName||'its document',shared};
}
async function restoreConv(id){await setConvFlag(id,{trashed:0,dropCards:false});syncCardsUI();setStatus('Restored')}
/* Rename from the sidebar: double-click a conversation's title. Enter or clicking away keeps it, Esc cancels.
   The title is shared content: the open conversation saves (and merges) as usual, another is PATCHed. */
let convRenaming=null;
function renameInSide(row){
  const id=row.dataset.conv,t=row.querySelector('.t');if(!t||convRenaming)return;
  const m=state.convList.find(c=>c.id===id)||(state.conv&&state.conv.id===id?metaOf(state.conv):null);if(!m)return;
  const was=m.title||'';convRenaming={id};row.classList.add('renaming');
  t.contentEditable='plaintext-only';t.spellcheck=false;t.textContent=was;t.focus();document.getSelection().selectAllChildren(t);
  let done=false;
  const end=async keep=>{
    if(done)return;done=true;const v=t.textContent.replace(/\s+/g,' ').trim().slice(0,200);
    convRenaming=null;t.removeAttribute('contenteditable');row.classList.remove('renaming');
    if(keep&&v&&v!==was){
      if(state.conv&&state.conv.id===id){state.conv.title=v;state.conv.titleKept=true;delete state.conv.autoTitle;renderTitle();save()}
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
  const m=state.convList.find(c=>c.id===id);
  if(state.conv&&state.conv.id===id){Object.assign(state.conv,patch);save()}
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
function refreshAll(){for(const id of state.conv.ui.open)if(id!=='doc'&&T(id)){renderPane(id);updateHeader(id)}if(state.conv.doc)updateHeader('doc');renderMap();if(state.conv.ui.view==='canvas')renderCanvas();save()}
function toggleBranchPin(tid){
  const t=T(tid);if(!t||!t.parent)return;
  t.pinned=!t.pinned;if(!t.pinned)delete t.pinned;
  updateHeader(tid);renderMap();renderConvList();save();
  setStatus(t.pinned?'Branch pinned':'Branch unpinned');
}
async function unpinRemoteBranch(cid,tid){
  if(state.conv&&state.conv.id===cid){toggleBranchPin(tid);return}
  let data=null;
  try{
    data=await io.store.get(cid);
    if(!data||!data.threads[tid])return;
    delete data.threads[tid].pinned;
    await io.store.update(cid,{threads:data.threads});
  }catch(e){toast('Couldn\'t unpin it.');return}
  const m=state.convList.find(c=>c.id===cid);if(m)m.pins=(m.pins||[]).filter(p=>p.tid!==tid);renderConvList();
}
async function openPinnedBranch(cid,tid){
  markBack();
  if(!state.conv||state.conv.id!==cid)await openConv(cid);
  if(!state.conv||state.conv.id!==cid||!T(tid)){toast('That branch no longer exists.');return}
  if(state.conv.ui.view==='canvas'){focusCard(tid);return}
  openThread(tid);state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==tid);layout();revealPane(tid);
}


  return {
    renderTitle, brCount, get brPop() { return brPop; }, closeBrList, toggleBrList, renderMap, toggleTreeFold, treeAll, metaOf, get convFilt() { return convFilt; }, set convFilt(v) { convFilt = v; }, get archOpen() { return archOpen; }, set archOpen(v) { archOpen = v; }, get convListSig() { return convListSig; }, set convListSig(v) { convListSig = v; }, renderConvList, toggleFolder, editFolderPrompt, newChatIn, renameFolder, dropFolder, openFolderMenu, archiveConv, newFolderDialog, closeFolderMenu, trashLeft, get convListLoaded() { return convListLoaded; }, set convListLoaded(v) { convListLoaded = v; }, get trashOpen() { return trashOpen; }, set trashOpen(v) { trashOpen = v; }, isBlank, openNextAfter, discardBlank, trashConv, docFate, restoreConv, setConvFlag, toggleHidden, refreshAll, toggleBranchPin, unpinRemoteBranch, openPinnedBranch,
  };
}
