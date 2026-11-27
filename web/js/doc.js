// Document mode: PDF.js rendering, Markdown/article reader, reading mark, document tools,
// web article fetching (Readability + Turndown), text-doc image snips, and Browser Clipper ingestion.
import { esc, trunc, pdfTitleOk, plain } from './text.js';
import { textWalker, nonWs, flatLen, charPos } from './anchors.js';
import {
  isDocBranch, isWholePage, docImgRefOf, pageText as pageTextOf,
  docTooLong as docTooLongOf, toolsWantedOf, cardToolOf,
} from './context.js';
import { normalizePageIndex } from './share.js';
import {
  state, app, io, paneEls, $, ic, rid, memoSet,
  color, hiddenNow, branchNum, newConv,
} from './state.js';
import {
  IMG_MAX, encodeCanvas, imageBlob, imageURL, blobB64,
  fileToImage, storeImages, screenScale,
} from './media.js';
import { quoteWords, quoteRe } from './cards.js';

export function createDoc() {
  Object.defineProperty(state, 'docState', {
    get: () => docState,
    set: (v) => { docState = v; },
    enumerable: true,
    configurable: true,
  });
  const applyPaneZoom = (...a) => app.applyPaneZoom(...a);
  const brCount = (...a) => app.brCount(...a);
  const contentScale = (...a) => app.contentScale(...a);
  const curPane = (...a) => app.curPane(...a);
  const descendants = (...a) => app.descendants(...a);
  const docInDock = (...a) => app.docInDock(...a);
  const flushNow = (...a) => app.flushNow(...a);
  const focusCard = (...a) => app.focusCard(...a);
  const hideTip = (...a) => app.hideTip(...a);
  const idxWrite = (...a) => app.idxWrite(...a);
  const importDigress = (...a) => app.importDigress(...a);
  const isDigressFile = (...a) => app.isDigressFile(...a);
  const isFocused = (...a) => app.isFocused(...a);
  const layout = (...a) => app.layout(...a);
  const leaveOk = (...a) => app.leaveOk(...a);
  const markBack = (...a) => app.markBack(...a);
  const openConv = (...a) => app.openConv(...a);
  const openDocImgPop = (...a) => app.openDocImgPop(...a);
  const openThread = (...a) => app.openThread(...a);
  const paneZoom = (...a) => app.paneZoom(...a);
  const rememberSpot = (...a) => app.rememberSpot(...a);
  const renderCanvas = (...a) => app.renderCanvas(...a);
  const renderMap = (...a) => app.renderMap(...a);
  const renderMermaid = (...a) => app.renderMermaid(...a);
  const renderRich = (...a) => app.renderRich(...a);
  const renderTitle = (...a) => app.renderTitle(...a);
  const revealMsg = (...a) => app.revealMsg(...a);
  const revealPane = (...a) => app.revealPane(...a);
  const save = (...a) => app.save(...a);
  const setConv = (...a) => app.setConv(...a);
  const setView = (...a) => app.setView(...a);
  const showQuote = (...a) => app.showQuote(...a);
  const toast = (...a) => app.toast(...a);
  const updateHeader = (...a) => app.updateHeader(...a);
  const updateJump = (...a) => app.updateJump(...a);
  const wires = (...a) => app.wires(...a);
  const wiresSoon = (...a) => app.wiresSoon(...a);
  const wrapText = (...a) => app.wrapText(...a);

/* ---------- document mode (everything here only runs when state.conv.doc exists) ---------- */
const PDFJS='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const DOC_STARTERS=['Give me an overview of this document','What\'s the main contribution or argument?','Outline the sections with page references','What background do I need to follow this?'];
let docState=null;
const docView={scale:1,width:0,current:1,rendered:new Map(),visible:new Set(),obs:null,ro:null,resizeT:0};
const docViewReady=()=>!!(docState&&(docState.loaded||docState.pdfReady));
const MAX_PDF_PAGES=16;
const docBlobCache=new Map();
function cacheDocBlob(id,data){memoSet(docBlobCache,id,data,3)}
function destroyDoc(st){if(st&&st.pdf){try{st.pdf.destroy().catch(()=>{})}catch(_){}}}
const docPagesLabel=(t,long)=>{const p=normalizePageIndex(t&&t.anchorPage);if(p==null)return '';const pe=t&&t.anchorEnd?normalizePageIndex(t.anchorEnd.page):null;return pe!=null&&pe>p?`${long?'pages':'pp.'} ${p+1}–${pe+1}`:`${long?'page':'p.'} ${p+1}`};   // a passage can run on to the next page
const docBranches=()=>state.conv&&state.conv.doc?Object.values(state.conv.threads).filter(isDocBranch).sort((a,b)=>(a.anchorPage-b.anchorPage)||(a.created-b.created)):[];
// a library (by its CDN address, a key of LIBS): this server's copy, else the CDN's, both checked against its hash;
// resolves with the address it came from
function addScript(src,hash){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;if(hash){s.integrity=hash;s.crossOrigin='anonymous'}s.onload=()=>res(src);s.onerror=()=>{s.remove();rej(new Error('Could not load '+src))};document.head.appendChild(s)})}
function loadScript(src){const l=LIBS[src];return l?addScript(l[0],l[1]).catch(()=>addScript(src,l[1])):addScript(src)}
let pdfLibP=null;
function loadPdfLib(){
  if(!pdfLibP)pdfLibP=(async()=>{
    const libUrl=await loadScript(PDFJS+'pdf.min.js');
    const workerEntry=LIBS[PDFJS+'pdf.worker.min.js'];
    // Same-origin /lib/ allows a real Web Worker (off the main UI thread); cross-origin CDN falls back to fake worker in-page.
    if(workerEntry&&libUrl===LIBS[PDFJS+'pdf.min.js'][0]){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc=workerEntry[0];
    }else{
      const worker=await loadScript(PDFJS+'pdf.worker.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc=worker;
    }
    return window.pdfjsLib;
  })().catch(e=>{pdfLibP=null;throw e});
  return pdfLibP;
}
function chunkText(text){
  const paras=String(text).split(/\n{2,}/),out=[];let cur='';
  for(const p of paras){if(cur&&cur.length+p.length>4000){out.push(cur);cur=''}cur+=(cur?'\n\n':'')+p}
  if(cur||!out.length)out.push(cur);return out;
}
/* the PDF's first page as a small image for its canvas card. Drawn once from the PDF that's already open
   (docState.pdf): nothing is downloaded or stored again, and the image lives only in memory. */
const docThumb={key:null,url:null,p:null};
function docThumbUrl(){
  if(!docState||!docState.pdf)return Promise.resolve(null);
  if(docThumb.key===docState.key&&docThumb.p)return docThumb.p;
  if(docThumb.url)URL.revokeObjectURL(docThumb.url);
  const st=docState;docThumb.key=st.key;docThumb.url=null;
  docThumb.p=(async()=>{
    const page=await st.pdf.getPage(1),w1=page.getViewport({scale:1}).width;
    const vp=page.getViewport({scale:app.CW*2*Math.min(2,devicePixelRatio||1)/w1});   // sharp up to 200% card zoom
    const c=document.createElement('canvas');c.width=Math.round(vp.width);c.height=Math.round(vp.height);
    await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));if(!blob)return null;
    if(docThumb.key!==st.key)return null;
    return docThumb.url=URL.createObjectURL(blob);
  })().catch(e=>{console.warn('preview failed',e);return null});
  return docThumb.p;
}
function startDoc(){
  const d=state.conv.doc,key=state.conv.id;
  if(docState&&docState.key===key)return docState.ready;
  destroyDoc(docState);
  if(docView.obs)docView.obs.disconnect();
  docView.rendered=new Map();docView.visible=new Set();docView.current=1;docView.width=0;docView.stale=false;
  const st=docState={key,kind:d.kind,name:d.name,pages:null,n:d.pages||0,error:null,loaded:false,pdfReady:false,progress:0};
  st.ready=(async()=>{
    try{
      let data=docBlobCache.get(key);
      if(data==null){
        if(d.assetId){await io.ready;data=await io.files.fetch(d.assetId,d.kind==='pdf'?'arrayBuffer':'text')}
        else if(d.text!=null)data=d.text;
        else throw {missing:true,message:d.left?`This conversation was shared without its document. Attach your copy of “${d.name||'the document'}” to read it alongside.`:'This document wasn\'t stored, so it needs to be attached again.'};
      }
      if(d.kind==='pdf'){
        const lib=await loadPdfLib();
        const pdf=await lib.getDocument({data:new Uint8Array(data.slice(0)),isEvalSupported:false}).promise;
        if(docState!==st){try{pdf.destroy().catch(()=>{})}catch(_){}return}
        st.pdf=pdf;st.n=pdf.numPages;st.pdfReady=true;
        if(!d.pages||d.pages!==st.n)d.pages=st.n;
        // Render visible pages immediately instead of blocking on full-document text extraction
        renderDocPane(true);updateHeader('doc');
        if(state.conv&&state.conv.id===key&&state.conv.autoTitle!=null)applyPdfTitle(pdf);
        const pages=[];
        for(let i=1;i<=pdf.numPages;i++){
          if(docState!==st)return;
          const tc=await (await pdf.getPage(i)).getTextContent();
          pages.push(tc.items.map(it=>(it.str||'')+(it.hasEOL?'\n':' ')).join('').replace(/[ \t]+/g,' ').trim());
          st.progress=i;
        }
        st.pages=pages;
        try{st.outline=await pdfOutline(pdf)}catch(e){st.outline=null}
      }else{st.text=String(data);st.pages=chunkText(st.text);st.n=st.pages.length}
      st.loaded=true;
      if(!d.pages||d.pages!==st.n){d.pages=st.n}
    }catch(e){st.error=e;console.warn('doc load failed',e)}
    if(docState===st){renderDocPane(st.kind!=='pdf'||!!st.error);updateHeader('doc');if(state.conv.ui.view==='canvas')renderCanvas();if(st.loaded&&state.conv.id===key&&(state.conv.order.main.length||Object.keys(state.conv.threads).length>1||state.conv.doc))idxWrite(state.conv,st.pages)}
  })();
  return st.ready;
}
// the PDF's built-in table of contents (bookmarks), flattened: [{title, depth, page}]; null if it has none
async function pdfOutline(pdf){
  const o=await pdf.getOutline();if(!o||!o.length)return null;
  const out=[],pageOf=async(dest)=>{try{if(typeof dest==='string')dest=await pdf.getDestination(dest);if(!Array.isArray(dest))return null;const r=dest[0];return typeof r==='number'?r+1:(await pdf.getPageIndex(r))+1}catch(e){return null}};
  const walk=async(items,d)=>{for(const x of items){if(out.length>=400)return;const title=String(x.title||'').replace(/\s+/g,' ').trim();if(title)out.push({title:title.slice(0,200),depth:d,page:await pageOf(x.dest)});if(x.items&&x.items.length)await walk(x.items,d+1)}};
  await walk(o,0);return out.length?out:null;
}
// name a new conversation after its PDF's own title, if it has a real one and the title is still the automatic one
async function applyPdfTitle(pdf){
  const c=state.conv;let meta;
  try{meta=await pdf.getMetadata()}catch(e){return}
  if(state.conv!==c||c.autoTitle==null)return;
  if(c.title===c.autoTitle&&!c.titleKept){
    let dc=null;try{dc=meta.metadata&&meta.metadata.get('dc:title')}catch(e){}
    if(Array.isArray(dc))dc=dc[0];
    const t=pdfTitleOk(meta.info&&meta.info.Title)||pdfTitleOk(dc);
    if(t){c.title=t;c.titleKept=true;renderTitle()}
  }
  delete c.autoTitle;save();
}
// pdfTitleOk lives in ./text.js.
async function docReady(){if(state.conv&&state.conv.doc&&docState)await docState.ready}

function docPaneEl(){
  const el=document.createElement('section');el.className='pane docpane';el.dataset.tid='doc';
  el.innerHTML=`<div class="ph"><span class="pgrip" title="Drag to reorder panes"></span><span class="docico">${ic('doc')}</span><div class="ph-main"><div class="ph-title"></div><div class="ph-orow"><div class="ph-origin"></div><button class="pox" data-act="oexp" title="Show the whole line"></button></div></div>
    <div class="ph-act"><button class="ib" data-act="newfromdoc" title="New conversation from this document: a fresh conversation on the same file. This one stays as it is.">${ic('docnew')}</button><button class="ib" data-act="snip" title="Snip: drag a box over part of a page (a figure, a table, an equation) to ask about it. Esc cancels.">${ic('snip')}</button><div class="pzoom"><button class="ib" data-act="zout" title="Zoom out">${ic('minus')}</button><button class="pzl" data-act="zedit"></button><button class="ib" data-act="zin" title="Zoom in">${ic('plus')}</button><button class="ib pzf" data-act="zfit" title="Fit the pages to the pane’s width (100%)">${ic('fitw')}</button></div><button class="ib" data-act="collapse" title="Collapse this pane to a thin strip. Click the strip to expand it. (⌘\\ / Ctrl+\\ for the pane you’re in)">${ic('collapse')}</button><button class="ib" data-act="focus"></button><button class="ib" data-act="close" title="Close the document’s pane. Its row at the top of Branches in the sidebar brings it back (so do page links and Show in source). (⌘⇧\\ / Ctrl+Shift+\\ for the pane you’re in)">${ic('x')}</button></div></div>
    <div class="pb"><div class="docwrap"></div></div>
    <div class="jumpw"><div class="jump"><button class="ib js" data-act="jsearch" title="Search this document">${ic('search')}</button><button class="ib jm" data-act="jmark" title="Mark where you got up to">${ic('mark')}</button><button class="ib jp" data-act="jprev" title="Return to where you were reading before you jumped here">${ic('jprev')}</button></div></div>
    <div class="rail-label"><span class="docico">${ic('doc')}</span><span class="rl"></span></div>`;
  const pb=el.querySelector('.pb');
  pb.addEventListener('scroll',()=>{wiresSoon();updateJump(el);trackDocPage();noteDocSpot()},{passive:true});
  if(docView.ro)docView.ro.disconnect();clearTimeout(docView.resizeT);
  docView.ro=new ResizeObserver(()=>{
    // a text document re-wraps the moment its width changes (another pane closed, the sidebar went): the same scroll
    // offset is now somewhere else, so put the reading spot back right away
    if(docState&&docState.loaded&&docState.kind!=='pdf'){const w=pb.clientWidth;if(pb.__tw&&w>100&&Math.abs(w-pb.__tw)>1){const sp=docSpotNow();if(sp)putDocSpot(sp)}pb.__tw=w;return}
    if(!docViewReady()||docState.kind!=='pdf')return;
    // a redraw that was put off while the pane had no width (hidden, mid-move) happens now; otherwise only a real change
    if(pb.clientWidth<100||(!docView.stale&&Math.abs(pb.clientWidth-docView.width)<40))return;
    // re-fit after the resize settles, but only if the same PDF is still open in this pane
    // (switching to another document inside the 250 ms used to rebuild the old one from the new state)
    const ds=docState;
    clearTimeout(docView.resizeT);docView.resizeT=setTimeout(async()=>{if(docState!==ds||!ds.pdf||paneEls.get('doc')!==el||!el.isConnected)return;const cur=docView.current,sp=docSpotNow();await buildPdfPages(el,el.querySelector('.docwrap'));if(!putDocSpot(sp))scrollDocToPage(cur,false)},250);
  });
  docView.ro.observe(pb);
  paneEls.set('doc',el);app.originRO.observe(el);return el;
}
let docPageRAF=0;
function trackDocPage(){
  if(docPageRAF)return;docPageRAF=requestAnimationFrame(()=>{docPageRAF=0;
    const el=paneEls.get('doc');if(!el||!docState||docState.kind!=='pdf')return;
    const pb=el.querySelector('.pb'),y=pb.getBoundingClientRect().top+pb.clientHeight*0.3;
    for(const pg of el.querySelectorAll('.dpage')){const r=pg.getBoundingClientRect();if(r.bottom>=y){if(docView.current!==+pg.dataset.page){docView.current=+pg.dataset.page;updateHeader('doc')}break}}
  });
}
function updateDocHeader(){
  const el=paneEls.get('doc');if(!el||!state.conv.doc)return;
  el.querySelector('.ph-title').textContent=state.conv.doc.name;
  const o=el.querySelector('.ph-origin'),nb=docBranches().filter(b=>!hiddenNow(b.id)).reduce((n,b)=>n+1+descendants(b.id).length,0),bl=brCount('doc',nb,true);   // always a list: it has the main thread
  if(o.querySelector('.pgin'))return;   // typing a page number: don't redraw it out from under you
  if(!docState||(!docState.loaded&&!docState.pdfReady&&!docState.error))o.textContent=docState&&docState.progress?`Reading ${docState.progress} of ${docState.n} pages…`:'Loading…';
  else if(docState.error)o.textContent='Couldn\'t load the document';
  else if(docState.kind==='pdf'){
    o.innerHTML=`<button type="button" class="pgn" data-gopage="1" title="Go to a page">Page ${docView.current}</button> of ${docState.n} · ${bl}`;
  }else o.innerHTML=bl;
  // opened from a link: show where it came from
  const src=state.conv.doc.source;if(src&&/^https?:\/\//i.test(src)&&docViewReady()){try{const a=document.createElement('a');a.href=src;a.target='_blank';a.rel='noopener noreferrer';a.className='docsrc';a.textContent=new URL(src).hostname;a.title=src;o.append(' · ',a)}catch(e){}}
  const f=el.querySelector('[data-act="focus"]');const on=isFocused('doc');f.innerHTML=ic('focus');f.setAttribute('aria-pressed',on?'true':'false');f.title=on?'Expand the other panes again (Esc)':'Collapse the other panes';f.classList.toggle('on',on);
  el.querySelector('.rl').textContent=state.conv.doc.name;
}
function renderDocPane(force){
  const el=paneEls.get('doc');if(!el||!state.conv.doc)return;
  if(!docState)startDoc();
  const wrap=el.querySelector('.docwrap');
  const ready=!!(docState.loaded||docState.pdfReady);
  if(!force&&wrap.dataset.key===docState.key+(ready?'L':'')+(docState.error?'E':'')){updateDocHeader();return}
  wrap.dataset.key=docState.key+(ready?'L':'')+(docState.error?'E':'');
  if(docState.error){
    wrap.innerHTML=`<div class="docerr"></div>`;const box=wrap.firstChild;box.textContent=docState.error.message||String(docState.error);
    if(docState.error.missing){
      const src=state.conv.doc&&typeof state.conv.doc.source==='string'&&/^https?:\/\//i.test(state.conv.doc.source)?state.conv.doc.source:'';
      if(src){
        const p=document.createElement('div');p.style.marginTop='8px';
        const a=document.createElement('a');a.href=src;a.target='_blank';a.rel='noopener noreferrer';a.textContent=src;
        p.append('Original link: ',a);box.appendChild(p);
      }
      const i=document.createElement('input');i.type='file';i.accept='.pdf,.md,.markdown,.txt';box.append(document.createElement('br'),i);i.onchange=()=>i.files[0]&&reattachDoc(i.files[0]);
    }
  }else if(!ready){wrap.innerHTML='<div class="docload">Loading the document…</div>'}
  else if(docState.kind==='pdf'){buildPdfPages(el,wrap)}
  else{
    const st=el.querySelector('.pb').scrollTop;
    wrap.innerHTML='<div class="docbody"></div>';const b=wrap.firstChild;
    renderRich(b,docState.text,true,{doc:true});articleFigures(b);docImages(b);applyDocAnchorsText(b);renderMermaid(b);
    articleBar(wrap,b);
    el.querySelector('.pb').scrollTop=st;
    placeMark();setTimeout(offerMark,300);
    // the text reflows with the pane's width: put the mark back on its character
    let mt=0;new ResizeObserver(()=>{clearTimeout(mt);mt=setTimeout(()=>{if(b.isConnected&&docMark())placeMark()},150)}).observe(b);
  }
  updateDocHeader();wiresSoon();
}
async function buildPdfPages(el,wrap){
  const pdf=docState&&docState.pdf,pb=el.querySelector('.pb');if(!pdf)return;
  // never at the width of a pane that's hidden or being moved (0: the pages came out at the 260px minimum and, with
  // the width noted as 0, were never redrawn): put it off, and the resize watcher redraws once it has a real width
  if(pb.clientWidth<100){docView.stale=true;return}
  const v1=(await pdf.getPage(1)).getViewport({scale:1});
  if(pb.clientWidth<100){docView.stale=true;return}   // (hidden while the page was fetched)
  docView.stale=false;
  const W=Math.max(260,pb.clientWidth-44-2);   // the padding, and nothing else: the scrollbar's space is already reserved (scrollbar-gutter)
  docView.scale=W/v1.width*paneZoom('doc');docView.width=pb.clientWidth;
  if(docView.obs)docView.obs.disconnect();
  docView.rendered=new Map();docView.visible=new Set();wrap.innerHTML='';
  docView.obs=new IntersectionObserver(ents=>{
    for(const en of ents){const p=+en.target.dataset.page;if(en.isIntersecting){docView.visible.add(p);renderPdfPage(p)}else docView.visible.delete(p)}
    evictPdfPages();
  },{root:pb,rootMargin:'900px 0px'});
  for(let i=1;i<=pdf.numPages;i++){
    const pg=document.createElement('div');pg.className='dpage';pg.dataset.page=i;
    pg.style.width=Math.round(v1.width*docView.scale)+'px';pg.style.height=Math.round(v1.height*docView.scale)+'px';
    pg.innerHTML=`<div class="pnum">${i}</div><button class="pask" data-pask="${i}" title="Open a side branch about this whole page; the AI gets an image of it">Ask about p. ${i}</button>`;wrap.appendChild(pg);docView.obs.observe(pg);
  }
  placeMark();setTimeout(offerMark,300);
}
async function makeTextLayer(page,vp){
  const tl=document.createElement('div');tl.className='textLayer';tl.style.setProperty('--scale-factor',vp.scale);
  const tc=await page.getTextContent();
  await window.pdfjsLib.renderTextLayer({textContentSource:tc,container:tl,viewport:vp}).promise;
  const end=document.createElement('div');end.className='endOfContent';tl.append(end);   // see pdfSelection below
  return tl;
}
/* Smooth text selection in PDFs, especially with a finger or the phone's selection handles (the approach
   pdf.js 4 takes). The text layer is transparent words placed over the page image, with gaps between
   them. When a finger or the mouse passes over a gap, the browser picks the nearest point in the page's
   text, often its start or end, so the selection jumps to cover half the page. Each text layer holds an
   empty, unselectable block (.endOfContent) that fills the page while you select. It's moved in the
   page's text order to just past the edge you're dragging, so a gap lands on it and the selection stays put. */
(function pdfSelection(){
  if(/firefox/i.test(navigator.userAgent))return;   // Firefox handles gaps fine by itself
  let prev=null;
  const reset=(tl)=>{const end=tl.querySelector('.endOfContent');if(end&&end!==tl.lastElementChild)tl.append(end);tl.classList.remove('selecting')};
  const layers=()=>document.querySelectorAll('.docpane .textLayer');
  document.addEventListener('pointerdown',e=>{
    const tl=e.target.closest&&e.target.closest('.docpane .textLayer');if(!tl)return;
    tl.classList.add('selecting');
    let a=e.target;if(a.nodeType===3)a=a.parentNode;
    if(a!==tl){
      while(a.parentElement&&a.parentElement!==tl&&!a.parentElement.classList.contains('markedContent'))a=a.parentElement;
      const end=tl.querySelector('.endOfContent');
      if(end&&end!==a&&a.parentElement)a.parentElement.insertBefore(end,a.nextSibling);
    }
  },true);
  document.addEventListener('pointerup',()=>{prev=null;layers().forEach(reset)});
  document.addEventListener('selectionchange',()=>{
    const sel=getSelection();
    if(!sel.rangeCount||sel.isCollapsed){prev=null;layers().forEach(reset);return}
    const r=sel.getRangeAt(0);
    for(const tl of layers()){if(r.intersectsNode(tl))tl.classList.add('selecting');else reset(tl)}
    // which edge moved since last time? put the block just past it (before the start, or after the end)
    const atStart=prev&&(r.compareBoundaryPoints(Range.END_TO_END,prev)===0||r.compareBoundaryPoints(Range.START_TO_END,prev)===0);
    prev=r.cloneRange();
    let a=atStart?r.startContainer:r.endContainer;if(a.nodeType===3)a=a.parentNode;
    const tl=a.closest&&a.closest('.docpane .textLayer');if(!tl||a===tl)return;
    // climb out of branch highlights (.anchor) to a word span, so the block is positioned against the page
    while(a.parentElement!==tl&&!a.parentElement.classList.contains('markedContent'))a=a.parentElement;
    const end=tl.querySelector('.endOfContent');if(end&&end!==a)a.parentElement.insertBefore(end,atStart?a:a.nextSibling);
  });
})();
function evictPdfPages(){
  if(docView.rendered.size<=MAX_PDF_PAGES)return;
  const el=paneEls.get('doc');if(!el)return;
  const sel=getSelection(),rng=sel&&sel.rangeCount&&!sel.isCollapsed?sel.getRangeAt(0):null;
  const cands=[...docView.rendered.keys()].filter(p=>!docView.visible.has(p)).sort((a,b)=>Math.abs(b-docView.current)-Math.abs(a-docView.current));
  for(const p of cands){
    if(docView.rendered.size<=MAX_PDF_PAGES)break;
    const pg=el.querySelector(`.dpage[data-page="${p}"]`);
    if(pg&&rng){try{if(rng.intersectsNode(pg))continue}catch(_){}}
    if(pg){pg.querySelectorAll('canvas').forEach(cv=>{cv.width=0;cv.height=0});pg.querySelectorAll('canvas,.textLayer,sup.fn,.dregion').forEach(n=>n.remove())}
    docView.rendered.delete(p);
  }
}
function renderPdfPage(i,force){
  const el=paneEls.get('doc');if(!el||!docState||!docState.pdf)return Promise.resolve();
  const pg=el.querySelector(`.dpage[data-page="${i}"]`);if(!pg)return Promise.resolve();
  if(docView.rendered.has(i)&&!force)return docView.rendered.get(i);
  const st=docState,scale=docView.scale;
  const job=(async()=>{
    const page=await st.pdf.getPage(i);const vp=page.getViewport({scale});
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const cv=document.createElement('canvas');cv.width=Math.floor(vp.width*dpr);cv.height=Math.floor(vp.height*dpr);cv.style.width=vp.width+'px';cv.style.height=vp.height+'px';
    await page.render({canvasContext:cv.getContext('2d'),viewport:vp,transform:dpr!==1?[dpr,0,0,dpr,0,0]:null}).promise;
    const tl=await makeTextLayer(page,vp);
    if(docState!==st||docView.scale!==scale)return;
    pg.style.width=vp.width+'px';pg.style.height=vp.height+'px';
    pg.querySelectorAll('canvas,.textLayer,sup.fn,.dregion').forEach(n=>n.remove());
    pg.appendChild(cv);pg.appendChild(tl);applyDocAnchorsPdf(pg,tl,i-1);wiresSoon();
  })().catch(e=>console.warn('page render failed',e));
  docView.rendered.set(i,job);return job;
}
function docMarker(t){const s=document.createElement('sup');s.className='fn'+(t.resolved?' res':'');s.dataset.tid=t.id;s.style.setProperty('--c',color(t));s.textContent=branchNum(t);s.title=`Open branch ${branchNum(t)}: ${t.title||''}`;return s}
function applyDocAnchorsPdf(pg,tl,pageIdx){
  const used=[];delete pg.dataset.cont;
  // the rest of a passage that started on an earlier page: highlighted here, its marker stays where it starts
  for(const t of docBranches().filter(t=>t.anchorEnd&&t.anchorPage<pageIdx&&t.anchorEnd.page>=pageIdx)){
    const lastPg=t.anchorEnd.page===pageIdx,e=lastPg?t.anchorEnd.e:flatLen(tl),s0=lastPg&&t.anchorEnd.s>0?t.anchorEnd.s:0;
    if(e>s0&&wrapText(tl,'',{...t,anchorRange:{s:s0,e}},{noMarker:true}))pg.dataset.cont='1';
  }
  for(const t of docBranches().filter(t=>t.anchorPage===pageIdx)){
    let y=6;
    if(t.anchorRegion){
      const r=t.anchorRegion;
      if(!isWholePage(r)){const d=document.createElement('div');d.className='dregion'+(t.resolved?' res':'');d.dataset.tid=t.id;d.style.cssText=`--c:${color(t)};left:${r.x*100}%;top:${r.y*100}%;width:${r.w*100}%;height:${r.h*100}%`;pg.appendChild(d);y=r.y*pg.offsetHeight}
    }else{const first=wrapText(tl,t.anchorText,t,{noMarker:true});if(first)y=first.getBoundingClientRect().top-pg.getBoundingClientRect().top}
    while(used.some(u=>Math.abs(u-y)<18))y+=18;used.push(y);
    const m=docMarker(t);m.style.top=Math.max(0,y)+'px';pg.appendChild(m);
  }
}
function applyDocAnchorsText(root){for(const t of docBranches()){
  if(t.anchorShot){if(t.anchorRange&&t.regionText)wrapText(root,t.regionText,t);continue}   // a snip: its text, where there was some
  if(t.anchorText&&!t.anchorImg)wrapText(root,t.anchorText,t)}}
async function refreshDocAnchors(page){
  if(!state.conv.doc||!docViewReady())return;
  const el=paneEls.get('doc');if(!el)return;
  if(docState.kind!=='pdf'){renderDocPane(true);return}
  let pages=page!=null?[page+1]:[...docView.rendered.keys()];
  if(page!=null){   // passages running on from this page, and pages showing the rest of one (whose branch may be gone)
    const more=new Set(pages);for(const t of docBranches())if(t.anchorPage===page&&t.anchorEnd)for(let i=page+2;i<=t.anchorEnd.page+1;i++)more.add(i);
    el.querySelectorAll('.dpage[data-cont]').forEach(p=>more.add(+p.dataset.page));pages=[...more];
  }
  for(const i of pages){
    const pg=el.querySelector(`.dpage[data-page="${i}"]`);if(!pg||!pg.querySelector('.textLayer'))continue;
    const page_=await docState.pdf.getPage(i);const vp=page_.getViewport({scale:docView.scale});
    const tl=await makeTextLayer(page_,vp);
    pg.querySelectorAll('.textLayer,sup.fn,.dregion').forEach(n=>n.remove());pg.appendChild(tl);applyDocAnchorsPdf(pg,tl,i-1);
  }
  wiresSoon();
}
function openDocPane(){
  if(!state.conv.doc)return;
  if(state.conv.ui.view==='canvas'&&!docInDock())setView(state.conv.ui.layout);
  if(!state.conv.ui.open.includes('doc'))state.conv.ui.open.unshift('doc');
  state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!=='doc');
  layout();renderMap();save();
}
async function scrollDocToPage(n,flash=true){
  const el=paneEls.get('doc');if(!el)return;const pb=el.querySelector('.pb');
  const pg=el.querySelector(`.dpage[data-page="${n}"]`);if(!pg)return;
  pb.scrollTop+=pg.getBoundingClientRect().top-pb.getBoundingClientRect().top-10;
  if(flash){pg.classList.remove('flash');void pg.offsetWidth;pg.classList.add('flash')}
}
/* ---------- reading mark: where you got up to in the document (state.conv.doc.mark, synced) ----------
   ['p', page, y] in a PDF (y: 0-1 down the page), ['o', offset] in a text document (characters, ignoring
   whitespace, counted like anchors). An array, so a merge takes one device's mark whole, never half of each.
   Set and moved with the ribbon button in the pane's corner (or by dragging the ribbon); the line it leaves
   across the page is drawn in the margin and never touches the text. */
const READ_LINE=0.15;   // the mark goes, and is brought back to, this far down the pane
const docMark=()=>{const m=state.conv&&state.conv.doc&&state.conv.doc.mark;return Array.isArray(m)&&(m[0]==='p'&&m[1]>=1||m[0]==='o'&&m[1]>=0)?m:null};
const markLabel=(m)=>{if(m[0]==='p')return `p. ${m[1]}`;const n=docState&&docState.text?nonWs(docState.text):0;return n?`${Math.min(99,Math.round(m[1]/n*100))}% in`:'in the text'};
function docBodyEl(){const el=paneEls.get('doc');return el&&el.querySelector('.docbody')}
// the text node and offset at nonWs character k of root (k past the end: the end)
function charAt(root,k){const w=textWalker(root);let n,c=0,last=null;
  while((n=w.nextNode())){last=n;const s=n.nodeValue;for(let i=0;i<s.length;i++){if(/\s/.test(s[i]))continue;if(c===k)return [n,i];c++}}
  return last?[last,last.nodeValue.length]:null}
/* Where you are in the document, kept as you scroll (as a mark: page and how far down it, or a character), so the
   view can be put back after the pane moves (Columns <-> the canvas's dock: moving an element resets its scroll)
   or is laid out again at another width (the pixels no longer point at the same place). One spot for both views. */
let docSpotT=0;
function noteDocSpot(){if(docView.restoring)return;clearTimeout(docSpotT);docSpotT=setTimeout(()=>{const el=paneEls.get('doc');
  if(!el||!el.isConnected||!el.getClientRects().length||docView.restoring)return;const m=readingSpot();if(m)docView.spot={conv:state.conv&&state.conv.id,m}},150)}
function docSpotNow(){const sp=docView.spot;return sp&&state.conv&&sp.conv===state.conv.id?sp.m:null}
function putDocSpot(m){
  const el=paneEls.get('doc');if(!m||!el)return false;const pb=el.querySelector('.pb');
  const sp=markSpot(m);if(!sp||!pb.clientHeight)return false;
  clearTimeout(docSpotT);docView.restoring=true;
  const r=sp.host.getBoundingClientRect();
  pb.scrollTop+=r.top+sp.f*r.height-pb.getBoundingClientRect().top-pb.clientHeight*READ_LINE;
  docView.spot={conv:state.conv.id,m};requestAnimationFrame(()=>{docView.restoring=false});
  return true;
}
// where the reading line is now, as a mark
function readingSpot(){
  const el=paneEls.get('doc');if(!el||!docViewReady())return null;
  const pb=el.querySelector('.pb'),r0=pb.getBoundingClientRect(),y=r0.top+pb.clientHeight*READ_LINE;
  if(docState.kind==='pdf'){
    let best=null;for(const pg of el.querySelectorAll('.dpage')){const r=pg.getBoundingClientRect();if(r.bottom>=y){best=[pg,r];break}}
    if(!best)return null;const [pg,r]=best;
    return ['p',+pg.dataset.page,Math.round(Math.min(1,Math.max(0,(y-r.top)/r.height))*1000)/1000];
  }
  const b=docBodyEl();if(!b)return null;
  // the first line of text at or below the reading line
  const w=textWalker(b);let n;const rg=document.createRange();
  while((n=w.nextNode())){if(!n.nodeValue.trim())continue;rg.selectNodeContents(n);const rs=[...rg.getClientRects()];
    if(rs.some(q=>q.bottom>=y)){
      // which character on it: the first whose box reaches the line
      let off=0;for(let i=0;i<n.nodeValue.length;i++){if(/\s/.test(n.nodeValue[i]))continue;rg.setStart(n,i);rg.setEnd(n,i+1);const q=rg.getBoundingClientRect();if(q.bottom>=y){off=i;break}}
      return ['o',charPos(b,n,off)];
    }}
  return null;
}
// the mark's box: the element it's drawn in and how far down it (a fraction)
function markSpot(m){
  const el=paneEls.get('doc');if(!el)return null;
  if(m[0]==='p'){const pg=el.querySelector(`.dpage[data-page="${m[1]}"]`);return pg?{host:pg,f:Math.min(1,Math.max(0,+m[2]||0))}:null}
  const b=docBodyEl();if(!b)return null;const at=charAt(b,m[1]);if(!at)return {host:b,f:0};
  const rg=document.createRange();rg.setStart(at[0],at[1]);rg.setEnd(at[0],Math.min(at[0].nodeValue.length,at[1]+1));
  const q=rg.getBoundingClientRect(),br=b.getBoundingClientRect();return {host:b,f:br.height?Math.min(1,Math.max(0,(q.top-br.top)/br.height)):0};
}
function placeMark(){
  const el=paneEls.get('doc');if(!el)return;
  el.querySelectorAll('.dmark').forEach(x=>x.remove());
  const m=docMark();el.classList.toggle('marked',!!m);
  const jm=el.querySelector('.jm');if(jm)jm.title=m?`Your mark (${markLabel(m)}): go back to it, move it here or remove it`:'Mark where you got up to';
  if(!m||!docViewReady())return;
  const sp=markSpot(m);if(!sp)return;
  const d=document.createElement('div');d.className='dmark';d.style.top=(sp.f*100)+'%';
  d.innerHTML=`<button class="rib" type="button" title="Where you got up to. Drag to move it."><svg viewBox="0 0 14 22" aria-hidden="true"><path d="M0 0h14v22l-7-5-7 5z"/></svg></button><button class="mx" type="button" title="Remove the mark">×</button>`;
  d.querySelector('.mx').onclick=(e)=>{e.stopPropagation();setMark(null)};
  dragMark(d.querySelector('.rib'));
  sp.host.appendChild(d);
}
function setMark(m,quiet){
  if(!state.conv||!state.conv.doc)return;
  if(m)state.conv.doc.mark=m;else delete state.conv.doc.mark;
  placeMark();save();
  if(!quiet)toast(m?`Marked where you got up to (${markLabel(m)}). The ribbon button in the corner brings you back.`:'Mark removed.');
}
async function goToMark(){
  const m=docMark();if(!m)return;openDocPane();await docReady();
  const el=paneEls.get('doc');if(!el)return;const pb=el.querySelector('.pb');
  const d=el.querySelector('.dmark');if(!d)return;
  rememberSpot(el);
  pb.scrollTop+=d.getBoundingClientRect().top-pb.getBoundingClientRect().top-pb.clientHeight*READ_LINE;
  d.classList.remove('flash');void d.offsetWidth;d.classList.add('flash');
}
// the corner button: no mark yet -> mark here; otherwise a small menu (go back to it, move it here, remove it)
function markButton(btn){
  if(!docViewReady())return;
  const m=docMark();if(!m){const h=readingSpot();if(h)setMark(h);return}
  let menu=$('#markMenu');if(!menu){menu=document.createElement('div');menu.className='thmenu';menu.id='markMenu';menu.setAttribute('role','menu');document.body.appendChild(menu);
    document.addEventListener('pointerdown',e=>{if(menu.classList.contains('open')&&!menu.contains(e.target)&&!e.target.closest('[data-act=jmark]'))menu.classList.remove('open')},true);
    addEventListener('keydown',e=>{if(e.key==='Escape')menu.classList.remove('open')})}
  if(menu.classList.contains('open')){menu.classList.remove('open');return}
  const h=readingSpot(),same=h&&h[0]===m[0]&&h[1]===m[1]&&(m[0]==='o'||Math.abs(h[2]-m[2])<0.05);
  menu.innerHTML=`<div class="thh">Where you got up to</div><button data-mk="go">${ic('mark')}Go back to it (${esc(markLabel(m))})</button>`+(h&&!same?`<button data-mk="here">${ic('jend')}Move it here${h[0]==='p'?` (p. ${h[1]})`:''}</button>`:'')+`<button data-mk="rm">${ic('x')}Remove it</button>`;
  menu.onclick=(e)=>{const b=e.target.closest('[data-mk]');if(!b)return;menu.classList.remove('open');
    if(b.dataset.mk==='go')goToMark();else if(b.dataset.mk==='here')setMark(h);else setMark(null)};   // here: where you were when you opened the menu
  menu.classList.add('open');const r=btn.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,r.left-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,r.bottom-menu.offsetHeight))+'px';
  menu.querySelector('button').focus();
}
// drag the ribbon to move the mark (to another page too)
function dragMark(rib){
  rib.addEventListener('pointerdown',e=>{
    if(e.button)return;e.preventDefault();e.stopPropagation();
    // listened for on the window: the ribbon moves to another page's element as it goes, which would end a pointer capture
    const el=paneEls.get('doc'),d=rib.closest('.dmark');d.classList.add('drag');let moved=null;
    const at=(y)=>{
      if(docState.kind==='pdf'){for(const pg of el.querySelectorAll('.dpage')){const r=pg.getBoundingClientRect();if(y<=r.bottom+7)return {host:pg,f:Math.min(1,Math.max(0,(y-r.top)/r.height)),m:['p',+pg.dataset.page,Math.round(Math.min(1,Math.max(0,(y-r.top)/r.height))*1000)/1000]}}return null}
      const b=docBodyEl(),r=b.getBoundingClientRect();return {host:b,f:Math.min(1,Math.max(0,(y-r.top)/r.height)),y};
    };
    const mv=(ev)=>{const t=at(ev.clientY);if(!t)return;moved=t;if(d.parentNode!==t.host)t.host.appendChild(d);d.style.top=(t.f*100)+'%'};
    const up=()=>{removeEventListener('pointermove',mv);removeEventListener('pointerup',up);removeEventListener('pointercancel',up);d.classList.remove('drag');
      if(!moved)return;
      if(moved.m)setMark(moved.m,true);
      else{   // a text document: the character nearest the line it was dropped on
        const pb=el.querySelector('.pb'),off=READ_LINE*pb.clientHeight,keep=pb.scrollTop;
        pb.scrollTop+=moved.y-(pb.getBoundingClientRect().top+off);   // put the drop line on the reading line, measure, put it back
        const n=readingSpot();pb.scrollTop=keep;if(n)setMark(n,true);else placeMark();
      }};
    addEventListener('pointermove',mv);addEventListener('pointerup',up);addEventListener('pointercancel',up);
  });
}
// opening a document you left a mark in: offer to go back to it (once per visit)
function offerMark(){
  const m=docMark();if(!m||!docViewReady()||docState.markOffered)return;docState.markOffered=true;
  const el=paneEls.get('doc'),d=el&&el.querySelector('.dmark');if(!d)return;
  const pb=el.querySelector('.pb'),r=d.getBoundingClientRect(),pr=pb.getBoundingClientRect();
  if(r.top>pr.top&&r.top<pr.bottom)return;   // already in view
  toast(`You left a mark ${m[0]==='p'?'at ':''}${markLabel(m)}.`,{label:'Go back to it',fn:goToMark});
}
async function goToPage(n,quote){
  openDocPane();await docReady();if(!docState||!docState.loaded)return;
  const el=paneEls.get('doc');if(!el)return;
  if(docState.kind!=='pdf'){revealPane('doc');return}
  n=Math.min(Math.max(1,n),docState.n);rememberSpot(el);
  if(quote){
    await scrollDocToPage(n,false);await renderPdfPage(n);revealPane('doc');
    const pg=el.querySelector(`.dpage[data-page="${n}"]`),pb=el.querySelector('.pb');
    if(pg&&showQuote(pg,pb,quote,1,{exact:true,unique:true,sticky:true}))return;
    await scrollDocToPage(n,true);return;
  }
  requestAnimationFrame(async()=>{await scrollDocToPage(n);revealPane('doc')});
}
async function goToDocPart(part,quote){
  openDocPane();await docReady();if(!docState||!docState.loaded)return;
  const el=paneEls.get('doc');if(!el)return;
  revealPane('doc');
  const body=el.querySelector('.docbody'),pb=el.querySelector('.pb');if(!body||!pb)return;
  rememberSpot(el);
  if(quote&&showQuote(body,pb,quote,1,{exact:true,unique:true,sticky:true}))return;
  if(part>=1&&docState.pages&&docState.pages[part-1]){
    const line=docState.pages[part-1].split(/\n+/).map(s=>s.trim()).find(s=>quoteWords(s).length>=3);
    if(line){
      const nodes=[],w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let text='',nd;
      while((nd=w.nextNode())){nodes.push([nd,text.length]);text+=nd.data}
      const m=text.toLowerCase().match(quoteRe(quoteWords(line).slice(0,8)));
      if(m){const at=o=>{let lo=0,hi=nodes.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(nodes[mid][1]<=o)lo=mid;else hi=mid-1}return [nodes[lo][0],o-nodes[lo][1]]};
        const r=document.createRange(),[a,ao]=at(m.index);r.setStart(a,ao);r.setEnd(a,ao);
        pb.scrollBy({top:r.getBoundingClientRect().top-pb.getBoundingClientRect().top-24,behavior:'smooth'})}
    }
  }
}
function goToEarlier(fromMid,quote){
  if(!state.conv||!quote)return;
  const from=state.conv.msgs[fromMid];if(!from)return;
  const prior=[];let stop=false;
  ThreadOps.walk(state.conv,from.thread,m=>{if(stop)return;if(m.id===fromMid){stop=true;return}prior.push(m)});
  const ws=quoteWords(quote);if(ws.length<2)return;
  const re=quoteRe(ws);
  let hit=null;
  for(const m of [...prior].reverse()){
    if(m.role!=='assistant'&&m.role!=='user'&&m.role!=='note')continue;
    if(re.test(String(m.content||'').toLowerCase())||re.test(plain(m.content||'').toLowerCase())){hit=m;break}
  }
  if(!hit){toast('Couldn’t find that earlier passage.');return}
  markBack();
  if(state.conv.ui.view==='canvas'){
    focusCard(hit.thread,hit.id);
    setTimeout(()=>{const n=$('#cv').querySelector(`.cnode[data-ctid="${hit.thread}"]`);if(!n)return;
      showQuote(n.querySelector(`.cfull .msg[data-mid="${hit.id}"] .body`),n.querySelector('.cfull'),quote,contentScale(n),{exact:true,sticky:true})},350);
    return;
  }
  openThread(hit.thread);state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==hit.thread);layout();revealPane(hit.thread);
  requestAnimationFrame(()=>{
    const pe=paneEls.get(hit.thread),b=pe&&pe.querySelector(`.msg[data-mid="${hit.id}"] .body`);
    if(b&&showQuote(b,pe.querySelector('.pb'),quote,1,{exact:true,sticky:true}))return;
    revealMsg(hit.thread,hit.id);
  });
}
async function revealDocAnchor(t,quiet){
  openDocPane();await docReady();if(!docState||!docState.loaded)return;
  const el=paneEls.get('doc');if(!el)return;const pb=el.querySelector('.pb');
  if(!quiet)rememberSpot(el);
  if(docState.kind==='pdf'){await scrollDocToPage(t.anchorPage+1,false);await renderPdfPage(t.anchorPage+1)}
  requestAnimationFrame(()=>{
    const a=el.querySelector(`.anchor[data-tid="${t.id}"]`)||el.querySelector(`.dregion[data-tid="${t.id}"]`)||el.querySelector(`.dimg sup.fn[data-tid="${t.id}"]`)||el.querySelector(`.dpage[data-page="${t.anchorPage+1}"]`);if(!a)return;
    if(t.anchorImg&&isWholePage(t.anchorImg)){const w=a.closest('.dimg');if(w){w.classList.remove('flash');void w.offsetWidth;w.classList.add('flash')}}
    pb.scrollBy({top:a.getBoundingClientRect().top-pb.getBoundingClientRect().top-pb.clientHeight/3,behavior:'smooth'});
    revealPane('doc');
    el.querySelectorAll(`.anchor[data-tid="${t.id}"],.dregion[data-tid="${t.id}"]`).forEach(s=>{s.classList.remove('flash');void s.offsetWidth;s.classList.add('flash')});
    setTimeout(wires,450);
  });
}
function linkPages(root,opts){
  // [p. 4], [p. 4 "exact phrase"], [p. 20–22], lists ([p. 2, 7]), [part 4 "exact phrase"], [doc "…"], and [earlier "…"]
  const hasDoc=opts&&'doc' in opts;
  const allowPdf=!hasDoc||!!(opts.doc&&opts.doc.kind==='pdf');
  const allowPart=!hasDoc||!!(opts.doc&&opts.doc.kind!=='pdf');
  const ITEM=String.raw`(?:pp?\.\s*)?\d+(?:\s*[–-]\s*\d+)?`;
  const PITEM=String.raw`(?:parts?\s*)?\d+(?:\s*[–-]\s*\d+)?`;
  const parts=[String.raw`\[earlier\s+["“]([^"”\n\]]+)["”]\]`];
  if(allowPdf){
    parts.push(String.raw`\[((?:pp?\.|pages?)\s*\d+(?:\s*[–-]\s*\d+)?)\s+["“]([^"”\n\]]+)["”]\]`);
    parts.push(String.raw`\[(?:pp?\.|pages?)\s*`+ITEM+String.raw`(?:\s*[,;]\s*`+ITEM+String.raw`)*\]`);
  }
  if(allowPart){
    parts.push(String.raw`\[((?:parts?)\s*\d+(?:\s*[–-]\s*\d+)?)\s+["“]([^"”\n\]]+)["”]\]`);
    parts.push(String.raw`\[doc\s+["“]([^"”\n\]]+)["”]\]`);
    parts.push(String.raw`\[parts?\s*`+PITEM+String.raw`(?:\s*[,;]\s*`+PITEM+String.raw`)*\]`);
  }
  const re=new RegExp(parts.join('|'),'gi'),item=new RegExp(ITEM,'g'),pitem=new RegExp(PITEM,'gi');
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement&&n.parentElement.closest('pre,code,.math,svg,a,mjx-container')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
  const hits=[];let n;while((n=w.nextNode())){re.lastIndex=0;if(re.test(n.nodeValue))hits.push(n)}
  for(const node of hits){
    const s=node.nodeValue,frag=document.createDocumentFragment();let last=0,m;re.lastIndex=0;
    const mk=(text,attrs,title)=>{const a=document.createElement('a');a.className='pref';for(const [k,v] of Object.entries(attrs))a.dataset[k]=v;a.textContent=text;a.title=title;return a};
    while((m=re.exec(s))){
      frag.append(s.slice(last,m.index));
      const c=m[0];
      const qm=c.match(/^\[((?:pp?\.|pages?|parts?)\s*\d+(?:\s*[–-]\s*\d+)?|earlier|doc)\s+["“]([^"”\n\]]+)["”]\]$/i);
      if(qm){
        const head=qm[1],quote=qm[2].trim();
        if(/^earlier$/i.test(head))frag.append(mk('[earlier]',{earlier:'1',cite:quote},'Show earlier passage'));
        else if(/^doc$/i.test(head))frag.append(mk('[doc]',{doccite:'1',cite:quote},'Show passage in the document'));
        else if(/^parts?/i.test(head)){const num=head.match(/\d+/)[0];frag.append(mk(`[${head}]`,{part:num,cite:quote},`Show passage in part ${num}`))}
        else{const num=head.match(/\d+/)[0];frag.append(mk(`[${head}]`,{page:num,cite:quote},`Show passage on page ${num}`))}
      }else if(/^\[parts?/i.test(c)){
        const open=c.match(/^\[parts?\s*/i)[0],items=[];let it;pitem.lastIndex=open.length;
        while((it=pitem.exec(c)))items.push({at:it.index,end:it.index+it[0].length,part:it[0].match(/\d+/)[0]});
        items.forEach((x,i)=>{
          if(i)frag.append(c.slice(items[i-1].end,x.at));
          frag.append(mk((i===0?c.slice(0,x.at):'')+c.slice(x.at,x.end)+(i===items.length-1?c.slice(x.end):''),{part:x.part},`Show part ${x.part} in the document`));
        });
      }else{
        const open=c.match(/^\[(?:pp?\.|pages?)\s*/i)[0],items=[];let it;item.lastIndex=open.length;
        while((it=item.exec(c)))items.push({at:it.index,end:it.index+it[0].length,page:it[0].match(/\d+/)[0]});
        items.forEach((x,i)=>{
          if(i)frag.append(c.slice(items[i-1].end,x.at));
          frag.append(mk((i===0?c.slice(0,x.at):'')+c.slice(x.at,x.end)+(i===items.length-1?c.slice(x.end):''),{page:x.page},`Show page ${x.page} in the document`));
        });
      }
      last=m.index+c.length;
    }
    frag.append(s.slice(last));node.replaceWith(frag);
  }
}
let lastDocSeen=null;      // set by buildContext: which pages the request it just built includes, when not all
const pageText=(i)=>pageTextOf(docState,i);
const docTooLong=()=>docTooLongOf(docState);
/* ---------- document tools: what runs here when the model calls one ----------
   The definitions the model sees, the rules and the loop are on the server (server/doctools.mjs); the server
   passes each call here, because this page has the document open. Each returns {parts:[text|image]} or
   {error} (which the model gets as an error), and adds an entry to `trail`, shown under the reply. */
const READ_MAX=8,READ_CHARS=60000;
const toolsWanted=(o)=>toolsWantedOf(state.conv,io,o);
// suggest_card is offered in every request of a conversation with flashcards on (replies, card drafts, takeaways
// alike, so they keep sharing one prompt cache); only a reply runs it (suggestCard), side jobs refuse it below
const cardTool=(o)=>cardToolOf(state.conv,io,o);
// the search tool. A query is found word for word, ignoring case, accents (ä = a), ligatures (ﬁ), and the spaces,
// line breaks, hyphens, dashes and quotes between letters, so "water-hero" finds "water- hero" split across a line;
// a match starts at the start of a word. A query not found that way gets the passages closest to it instead, ranked
// BM25-style by its words or words that start the same (divinity ~ divine, gods ~ god), clearly marked as such.
const SEARCH_MAXQ=6,SEARCH_HITS=24,SEARCH_NEAR=4,SEARCH_WIN=50;
const SQUEEZE=/[\s\-‐-―−'"‘-‟­​-‍⁠﻿]/u,ALNUM=/[\p{L}\p{N}]/u;
const foldCh=(ch)=>ch.charCodeAt(0)<128?ch.toLowerCase():ch.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const foldWord=(w)=>w.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
// t → s (folded, with the squeezed characters left out), at[k] (where s[k] came from in t), ws[k] (s[k] starts a word)
function foldText(t){
  let s='';const at=[],ws=[];let prev=false,i=0;
  for(const ch of t){
    if(SQUEEZE.test(ch)){if(!/['’]/.test(ch))prev=false}   // an apostrophe keeps "don't" one word
    else for(const c of foldCh(ch)){s+=c;at.push(i);ws.push(!prev);prev=ALNUM.test(c)}
    i+=ch.length}
  return {s,at,ws};
}
// t's words, folded, with where each is in t; a word broken at a line's hyphen ("infor- mation") is also there whole
function wordsOf(t){
  const out=[],re=/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;let m,last=null;
  while((m=re.exec(t))){const w={x:foldWord(m[0]),i:m.index,e:m.index+m[0].length};
    if(last&&/^-\s+$/.test(t.slice(last.e,w.i))&&/^\p{Ll}/u.test(m[0]))out.push({x:last.x+w.x,i:last.i,e:w.e,joined:true});
    out.push(w);last=w}
  return out;
}
function docFold(st){
  if(!st.__fold||st.__fold.P!==st.pages)st.__fold={P:st.pages,pages:st.pages.map(()=>null)};
  return (i)=>st.__fold.pages[i]||(st.__fold.pages[i]={...foldText(st.pages[i]),words:wordsOf(st.pages[i])});
}
const stemOf=(x)=>{if(x.length>3&&x.endsWith('s'))x=x.slice(0,-1);return x.length<=4?x:x.slice(0,Math.max(4,x.length-3))};
const oneLine=(x)=>x.replace(/\s+/g,' ').trim();
function docSearch(st,q,cap,trail,{one,many,N,pdf}){
  const fold=docFold(st),fq=foldText(q).s,hits=[],pages=[];let total=0;
  if(fq){const wordy=ALNUM.test(fq[0]);
    for(let i=0;i<N;i++){const f=fold(i),t=st.pages[i];let k=f.s.indexOf(fq);
      while(k>=0){
        if(!wordy||f.ws[k]){total++;if(!pages.includes(i+1))pages.push(i+1);
          if(hits.length<cap){const a=f.at[k],b=f.at[k+fq.length-1]+1;hits.push(`[${one} ${i+1}] …${oneLine(t.slice(Math.max(0,a-120),b+120))}…`)}
          k=f.s.indexOf(fq,k+fq.length)}
        else k=f.s.indexOf(fq,k+1)}}}
  if(total){
    trail.push({t:'search',q,n:total,pages:pages.slice(0,40)});
    return `${total} match${total>1?'es':''} for "${q}", on ${many} ${pages.length>40?pages.slice(0,40).join(', ')+', …':pages.join(', ')}${total>hits.length?`. The first ${hits.length}`:''}:\n\n${hits.join('\n\n')}`;
  }
  const near=nearPassages(st,fold,q,N);
  trail.push({t:'search',q,n:0,pages:[],near:[...new Set(near.map(x=>x.page))]});
  if(!near.length)return `No matches for "${q}" in the ${N} ${many}, word for word or close. It doesn't know synonyms, so try other words for the same thing.${pdf?' Text inside figures or scanned pages isn’t searchable; view_page shows those.':''}`;
  return `No exact match for "${q}". The closest passages, by its words or words that start the same (check they mean what you want):\n\n`+
    near.map(x=>`[${one} ${x.page}] …${oneLine(x.text)}… (has: ${x.has.join(', ')})`).join('\n\n');
}
// the passages (windows of SEARCH_WIN words, overlapping by half) that best match q's words, BM25-style
function nearPassages(st,fold,q,N){
  let terms=[...new Set(wordsOf(q).map(w=>w.x))];const keep=terms.filter(x=>!app.STOP.has(x));if(keep.length)terms=keep;
  if(!terms.length)return [];
  const like=terms.map(x=>{const st_=stemOf(x),num=/^\p{N}+$/u.test(x);return (w)=>w===x?1:!num&&w.startsWith(st_)?0.7:0});
  const wins=[];
  for(let i=0;i<N;i++){const W=fold(i).words;
    for(let a=0;a<W.length||a===0;a+=SEARCH_WIN/2){const ws=W.slice(a,a+SEARCH_WIN);if(!ws.length)break;
      const tf=terms.map(()=>0),has=terms.map(()=>new Set());
      for(const w of ws)like.forEach((f,j)=>{const v=f(w.x);if(v){tf[j]+=v;has[j].add(w.joined?st.pages[i].slice(w.i,w.e).replace(/-\s+/,''):st.pages[i].slice(w.i,w.e))}});
      if(tf.some(Boolean))wins.push({page:i+1,i:ws[0].i,e:ws[ws.length-1].e,tf,has});
      if(a+SEARCH_WIN>=W.length)break}}
  if(!wins.length)return [];
  const n=wins.length,idf=terms.map((_,j)=>{const df=wins.filter(w=>w.tf[j]).length;return Math.log(1+(n-df+0.5)/(df+0.5))});
  const need=terms.length>1?Math.ceil(terms.length/2):1;
  const scored=wins.filter(w=>w.tf.filter(Boolean).length>=need).map(w=>({...w,score:w.tf.reduce((s,f,j)=>s+idf[j]*f*2.2/(f+1.2),0)})).sort((a,b)=>b.score-a.score);
  const out=[];
  for(const w of scored){if(out.length>=SEARCH_NEAR)break;
    if(out.some(o=>o.page===w.page&&o.i<w.e&&w.i<o.e))continue;   // overlaps one already chosen
    out.push({page:w.page,text:st.pages[w.page-1].slice(w.i,w.e),has:[...new Set(w.has.flatMap(h=>[...h]))].slice(0,8)})}
  return out;
}
async function runDocTool(name,input,trail){
  if(name==='suggest_card')return {error:'Not in this request: it is a task with its own instructions (drafting flashcards or writing a takeaway). Do what it asks instead.'};
  const st=docState;
  if(!st||!st.loaded)return {error:'The document isn’t loaded in the reader’s browser right now, so it can’t be read. Tell the reader.'};
  const P=st.pages,N=P.length,pdf=st.kind==='pdf',one=pdf?'p.':'part',many=pdf?'pages':'parts';
  const num=(v)=>typeof v==='number'?v:typeof v==='string'&&/^\s*\d+\s*$/.test(v)?+v:NaN;
  if(name==='search'){
    // several queries in one call (one tool call from the budget); `query` too, as the tool once took
    let qs=input.queries!=null?input.queries:input.query;if(!Array.isArray(qs))qs=[qs];
    qs=[...new Set(qs.map(q=>String(q==null?'':q).replace(/\s+/g,' ').trim()).filter(Boolean))];
    if(!qs.length)return {error:'search needs "queries": a list of one or more words or phrases to find.'};
    const extra=qs.length>SEARCH_MAXQ?` (Only the first ${SEARCH_MAXQ} queries were searched; ask again for the rest.)`:'';qs=qs.slice(0,SEARCH_MAXQ);
    const per=Math.max(4,Math.floor(SEARCH_HITS/qs.length)),out=qs.map(q=>docSearch(st,q,per,trail,{one,many,N,pdf}));
    return {parts:[{type:'text',text:out.join('\n\n———\n\n')+extra}]};
  }
  if(name==='read_pages'){
    const a=num(input.from);let b=input.to==null||input.to===''?a:num(input.to);
    if(!Number.isInteger(a)||a<1)return {error:`read_pages needs "from": a ${pdf?'page':'part'} number from 1 to ${N}.`};
    if(!Number.isInteger(b)||b<a)return {error:`"to" must be a number no smaller than "from" (${a}).`};
    if(a>N)return {error:`There is no ${one} ${a}: the document has ${N} ${many}.`};
    let note='';
    if(b>N){note+=` The document has ${N} ${many}, so this stops at ${one} ${N}.`;b=N}
    if(b-a+1>READ_MAX){note+=` At most ${READ_MAX} per call, so this stops at ${one} ${a+READ_MAX-1}; ask again for the rest.`;b=a+READ_MAX-1}
    const out=[];let used=0;
    for(let i=a;i<=b;i++){if(i>a&&used+P[i-1].length>READ_CHARS){note+=` These are long, so this stops at ${one} ${i-1}; ask again from ${one} ${i}.`;b=i-1;break}used+=P[i-1].length;out.push(`[${one} ${i}]\n${pageText(i-1)}`)}
    trail.push({t:'read',a,b});
    return {parts:[{type:'text',text:(note?`(Note:${note})\n\n`:'')+out.join('\n\n')}]};
  }
  if(name==='view_page'&&!pdf){
    // a web article: the pictures in that part, downloaded now if the reader hasn't loaded them (only the
    // article's own image links, through the server's checks; the model can't name any other address)
    const n=num(input.page);
    if(!Number.isInteger(n)||n<1||n>N)return {error:`There is no part ${input.page}: the document has ${N} parts.`};
    const re=new RegExp(`\\[Image: ([^\\]]*)\\]\\((\\S+) "${IMG_MARK}"\\)`,'g'),found=[...P[n-1].matchAll(re)];
    if(!found.length)return {error:`Part ${n} has no pictures${state.conv.doc.article?'':' (this is a text document)'}; read_pages has its text.`};
    const parts=[{type:'text',text:`Part ${n} has ${found.length} picture${found.length>1?'s':''}${found.length>4?'; here are the first 4':''}:`}];
    for(const [,desc,url] of found.slice(0,4)){
      parts.push({type:'text',text:`[Image: ${desc}]`});
      try{const rec=await loadArticleImage(url,{quiet:true});const bl=await imageBlob(rec);parts.push({type:'image',mediaType:bl.type,data:await blobB64(bl)})}
      catch(e){parts.push({type:'text',text:`(couldn’t be loaded${e&&e.warnings?': it needs the reader’s OK first (an unencrypted or unusual address); ask them to load it in the document':e&&e.message?': '+e.message:''})`})}
    }
    trail.push({t:'view',p:n,part:true});
    return {parts};
  }
  if(name==='view_page'){
    const n=num(input.page);
    if(!Number.isInteger(n)||n<1||n>N)return {error:`There is no page ${input.page}: the document has ${N} pages.`};
    let bl;try{bl=await imageBlob({region:{page:n,x:0,y:0,w:1,h:1}})}catch(e){return {error:`Page ${n} couldn’t be drawn: ${(e&&e.message)||e}`}}
    trail.push({t:'view',p:n});
    return {parts:[{type:'text',text:`Page ${n}:`},{type:'image',mediaType:bl.type,data:await blobB64(bl)}]};
  }
  return {error:`There’s no tool called ${name}.`};
}
const trailText=(x)=>{const pd=!(docState&&docState.kind!=='pdf');
  return x.t==='search'?`searched “${x.q}”`:x.t==='read'?(x.a===x.b?`read ${pd?'p.':'part'} ${x.a}`:`read ${pd?'pp.':'parts'} ${x.a}–${x.b}`):pd?`looked at p. ${x.p}`:`looked at the pictures in part ${x.p}`};
// under a reply: what it read of the document beyond what it started with (kept outside .body, so anchors never count it)
// pages as short ranges: [41,42,43,2] → "pp. 2, 41–43" (at most 6 ranges, then …)
function pageList(ps,pd){
  const u=[...new Set(ps)].sort((a,b)=>a-b),r=[];for(const p of u){const l=r[r.length-1];if(l&&l[1]===p-1)l[1]=p;else r.push([p,p])}
  const txt=r.slice(0,6).map(([a,b])=>a===b?`${a}`:`${a}–${b}`).join(', ')+(r.length>6?', …':'');
  return (u.length>1?(pd?'pp. ':'parts '):(pd?'p. ':'part '))+txt;
}
// under a reply: what it had of the document and what it read with its tools (outside .body, so anchors never count it)
function docReads(m){
  const r=m.reads||[],seen=m.docSeen||null;
  if(!r.length&&!seen)return null;
  const pd=!(docState&&docState.kind!=='pdf'),unit=(n)=>pd?`page${n>1?'s':''}`:`part${n>1?'s':''}`;
  const d=document.createElement('details');d.className='wsrc dreads';
  const nS=r.filter(x=>x.t==='search').length;
  const read=r.filter(x=>x.t==='read').flatMap(x=>{const o=[];for(let p=x.a;p<=x.b&&o.length<400;p++)o.push(p);return o}),viewed=r.filter(x=>x.t==='view').map(x=>x.p);
  const nR=new Set(read).size,nV=new Set(viewed).size;
  const had=!seen?'':seen.all?`had all ${seen.of} ${unit(seen.of)}`:seen.tools?`started from ${seen.pages} of ${seen.of}`:`saw ${seen.n} of ${seen.of} ${unit(seen.of)} (${seen.pages})`;
  const sum=[had,nS&&`searched${nS>1?` ${nS}×`:''}`,nR&&`read ${nR} ${unit(nR)} (${pageList(read,pd)})`,nV&&`looked at ${nV} ${unit(nV)} (${pageList(viewed,pd)})`].filter(Boolean).join(' · ');
  d.innerHTML=`<summary>${ic('doc')}<span></span></summary>`;
  d.querySelector('summary span').textContent='Document: '+sum;
  d.title=seen&&seen.all?'The whole document was sent with this question.':seen&&seen.tools?`The document was too long to send whole. This reply started from ${seen.pages} and read the rest with its tools.`:seen?'The document was too long to send whole, and this connection can’t read more on its own: this reply only had these pages.':'';
  if(!r.length){d.classList.add('flat');return d}
  const ol=document.createElement('ol');
  for(const x of r){const li=document.createElement('li');
    const pg=x.t==='read'?x.a:x.t==='view'?x.p:null;li.textContent=trailText(x)+(x.t==='search'?` → ${x.n?`${x.n} match${x.n>1?'es':''}${x.pages.length?` (p. ${x.pages.slice(0,8).join(', ')}${x.pages.length>8?', …':''})`:''}`:x.near&&x.near.length?`no exact match; close passages (p. ${x.near.join(', ')})`:'no matches'}`:'');
    if(pg&&docState&&docState.kind==='pdf'){const a=document.createElement('a');a.className='pref';a.dataset.page=pg;a.textContent='show';a.title=`Show page ${pg} in the document`;li.append(' ',a)}
    ol.appendChild(li)}
  d.appendChild(ol);
  return d;
}
async function storeDocFile(c,kind,blob,text){
  await io.ready;
  if(io.files.canUpload){
    try{const up=await io.files.upload(kind==='pdf'?blob:new Blob([text],{type:'text/markdown'}),kind==='pdf'?'application/pdf':'text/markdown');c.doc.assetId=up.id;delete c.doc.unsaved;return true}
    catch(e){console.warn('upload failed',e);if(e&&e.code==='too_large')toast('That file is over the 20 MB storage limit.');else if(e&&e.code==='quota_or_state')toast('Document storage is full.')}
  }
  if(kind!=='pdf'&&text.length<150000){c.doc.text=text;delete c.doc.unsaved;return true}
  c.doc.unsaved=true;return false;
}
async function reattachDoc(file){
  const isPdf=/pdf$/i.test(file.type)||/\.pdf$/i.test(file.name);
  const data=isPdf?await file.arrayBuffer():await file.text();
  cacheDocBlob(state.conv.id,data);state.conv.doc.kind=isPdf?'pdf':'text';delete state.conv.doc.left;
  await storeDocFile(state.conv,state.conv.doc.kind,file,isPdf?null:data);
  docState=null;startDoc();renderDocPane(true);save();
}
/* new-from-document dialog */
let docLinkOk=null; // {link, codes}: warnings the reader accepted for this link
function openDocModal(){
  docLinkOk=null;$('#docGo').textContent='Start';
  $('#docFile').value='';$('#docPaste').value='';$('#docName').value='';$('#docFileLbl').textContent='Choose a PDF, Markdown or text file, or drop it here (a .digress file someone shared opens as its conversation)';$('#docMsg').textContent='';$('#docGo').disabled=false;
  hideTip();$('#docModal').classList.add('show');
}
function closeDocModal(){$('#docModal').classList.remove('show')}
/* ---------- web articles: a page from a link, kept as a Markdown document (reader view) ----------
   The server downloads the page (server/fetchdoc.mjs) and hands it over as text. Here it is parsed inertly
   (DOMParser: no scripts run, nothing loads), Readability (Firefox's reader view) keeps the article, and
   Turndown turns it into Markdown, so from then on it is an ordinary text document. Images aren't loaded:
   each becomes a placeholder, [Image: description](url "digress-image"), which the reader can load (the
   server downloads it with the same checks and a copy is kept with the conversation, in state.conv.doc.images)
   and which the model sees as text and can ask to look at with view_page. */
const IMG_MARK='digress-image';
let articleLibs=null;
function loadArticleLibs(){
  if(!articleLibs)articleLibs=Promise.all([loadScript('https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/Readability.js'),loadScript('https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js')])
    .then(()=>loadScript('https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js')).catch(e=>{articleLibs=null;throw e});
  return articleLibs;
}
// a math element's TeX, {t, d: display?}, or null. Only the outermost element of a formula matches (a .katex inside
// a .katex-display, the <math> inside either), so it's written once
const MATH_CLASSES=['katex','katex-display','mwe-math-element','mwe-math-fallback-image-inline','mwe-math-fallback-image-display'];   // Readability drops every other class
function articleTex(n){
  if(n.nodeType!==1)return null;
  const cl=n.classList,tag=n.nodeName.toUpperCase();
  const outer=cl.contains('katex-display')||cl.contains('mwe-math-element')||tag==='MJX-CONTAINER'||(cl.contains('katex')&&!n.parentElement.closest('.katex-display'))
    ||(tag==='MATH'&&!n.parentElement.closest('.katex,.katex-display,.mwe-math-element,mjx-container'));
  if(!outer)return null;
  const math=tag==='MATH'?n:n.querySelector('math'),ann=n.querySelector('annotation[encoding="application/x-tex"]');
  let t=((ann&&ann.textContent)||(math&&math.getAttribute('alttext'))||'').trim();
  if(!t)return null;
  const wiki=/^\{\\displaystyle\s([\s\S]*)\}$/.exec(t);if(wiki)t=wiki[1].trim();   // Wikipedia wraps every formula in it
  const d=cl.contains('katex-display')||n.getAttribute('display')==='true'||(math&&math.getAttribute('display')==='block')
    ||(cl.contains('mwe-math-element')&&!!n.querySelector('.mwe-math-fallback-image-display'));
  return {t:t.replace(/(^|[^\\])\$/g,'$1\\$'),d};   // a bare $ would end the formula
}
async function articleToMarkdown(html,url){
  await loadArticleLibs();
  const doc=new DOMParser().parseFromString(html,'text/html');
  const base=doc.createElement('base');base.href=url;doc.head.prepend(base);   // so relative links and images resolve against the page
  const a=new Readability(doc,{charThreshold:300,classesToPreserve:MATH_CLASSES}).parse();
  if(!a||!a.content||(a.textContent||'').trim().length<200)throw {message:'Couldn’t find an article on that page. If it needs a login or is an app rather than an article, copy the text and paste it instead.'};
  const abs=(u)=>{try{return new URL(u,url).href}catch(e){return ''}},safe=(u)=>u.replace(/[()\s<>]/g,c=>encodeURIComponent(c));
  const td=new TurndownService({headingStyle:'atx',codeBlockStyle:'fenced',bulletListMarker:'-',emDelimiter:'*'});
  td.use(turndownPluginGfm.gfm);
  td.remove(['script','style','iframe','video','audio','object','embed','form','button','noscript','canvas','svg']);
  td.addRule('image',{filter:'img',replacement:(_,n)=>{
    if(/\bmwe-math-fallback/.test(n.className))return '';   // Wikipedia's picture of a formula: the formula is kept as TeX
    const src=abs(n.getAttribute('src')||n.getAttribute('data-src')||(n.getAttribute('srcset')||'').trim().split(/\s+/)[0]||'');
    if(!/^https?:/i.test(src))return '';
    const fig=n.closest('figure'),cap=fig&&fig.querySelector('figcaption');
    const desc=(n.getAttribute('alt')||n.getAttribute('title')||'').replace(/\s+/g,' ').replace(/[\[\]]/g,'').trim();
    return `\n\n[Image: ${desc||(cap?'see the caption below':'no description')}](${safe(src)} "${IMG_MARK}")\n\n`;
  }});
  // math (KaTeX, MathJax, Wikipedia, plain MathML) → $…$ / $$…$$ from the TeX the page keeps beside it, typeset like a
  // reply's. Without this its text came through as the MathML's characters run together, then the TeX with every
  // \ and _ escaped: a table became one unbroken word that ran off the screen
  td.addRule('math',{filter:(n)=>!!articleTex(n),replacement:(_,n)=>{
    const m=articleTex(n);return m.d?`\n\n$$${m.t}$$\n\n`:`$${m.t.replace(/\s+/g,' ')}$`;
  }});
  td.addRule('figcaption',{filter:'figcaption',replacement:(c)=>c.trim()?`\n\n*${c.trim()}*\n\n`:''});
  td.addRule('link',{filter:(n)=>n.nodeName==='A'&&!!n.getAttribute('href'),replacement:(c,n)=>{
    if(c.includes(IMG_MARK))return c;   // an image wrapped in a link: keep the image
    const h=abs(n.getAttribute('href'));return /^(https?|mailto):/i.test(h)&&c.trim()?`[${c}](${safe(h)})`:c;
  }});
  let title=(a.title||'').replace(/\s+/g,' ').trim();
  const site=(a.siteName||'').replace(/\s+/g,' ').trim();   // "Post title | Site" → "Post title"
  if(site&&title.length>site.length+3){for(const sep of [' | ',' - ',' – ',' — ',' · ',' :: '])if(title.endsWith(sep+site)){title=title.slice(0,-(sep+site).length).trim();break}}
  let date='';try{if(a.publishedTime){const d=new Date(a.publishedTime);if(!isNaN(d))date=d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}}catch(e){}
  const meta=[a.byline,a.siteName,date].map(x=>String(x||'').replace(/\s+/g,' ').trim()).filter(Boolean).filter((x,i,l)=>l.indexOf(x)===i);
  let body=td.turndown(a.content).replace(/\n{3,}/g,'\n\n').trim();
  if(title&&body.startsWith('# '+title))body=body.slice(title.length+2).trim();
  return {md:`${title?`# ${title}\n\n`:''}${meta.length?`*${meta.join(' · ')}*\n\n`:''}${body}\n`,title};
}
// A note clipped with a web clipper (Obsidian Web Clipper and the like) starts with YAML front matter:
// title, source, author, published... Read the simple top-level fields, drop the block, and start the text
// with the same heading and byline a web article gets. Returns null when there is no front matter.
function clipFrontMatter(text){
  const m=/^\uFEFF?---[ \t]*\r?\n([\s\S]{0,8000}?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);if(!m)return null;
  const f={};let key=null;
  const val=(v)=>v.trim().replace(/^(["'])(.*)\1$/,'$2').replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g,'$1').trim();
  for(const line of m[1].split(/\r?\n/)){
    const kv=/^([A-Za-z][\w -]*):\s*(.*)$/.exec(line),li=/^\s+-\s+(.*)$/.exec(line);
    if(kv){key=kv[1].trim().toLowerCase();const v=val(kv[2]);f[key]=v?[v]:[]}
    else if(li&&key)f[key].push(val(li[1]));
  }
  const one=(...ks)=>{for(const k of ks)if(f[k]&&f[k].filter(Boolean).length)return f[k].filter(Boolean).join(', ');return ''};
  const title=one('title').replace(/\s+/g,' ').slice(0,300),src=one('source','url','link');
  const source=/^https?:\/\/\S+$/i.test(src)?src:'';
  let host='';try{host=source?new URL(source).hostname.replace(/^www\./,''):''}catch(e){}
  let date='';const pub=one('published','date');if(pub){const d=new Date(pub);date=isNaN(d)?pub:d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}
  const meta=[one('author','authors'),one('site','site_name')||host,date].map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  let body=text.slice(m[0].length).replace(/^\s+/,'');
  if(title&&body.startsWith('# '+title))body=body.slice(title.length+2).replace(/^\s+/,'');
  return {md:`${title?`# ${title}\n\n`:''}${meta.length?`*${meta.join(' · ')}*\n\n`:''}${body}`,title,source};
}
// placeholders → figures. The caption's text node is moved, not copied, and the buttons hold only icons,
// so the document's text (which highlights are counted in) is exactly the same as before
function articleFigures(root){
  root.querySelectorAll(`a[title="${IMG_MARK}"]`).forEach(a=>{
    const f=document.createElement('span');f.className='aimg';f.dataset.url=a.getAttribute('href');
    const cap=document.createElement('span');cap.className='acap';while(a.firstChild)cap.appendChild(a.firstChild);
    f.appendChild(cap);a.replaceWith(f);paintFigure(f);
  });
}
/* ---------- images in a text document: branch from one, or snip part of it, as from a PDF's pages ----------
   A Markdown document's own images (![alt](url)) and a web article's loaded figures. Each is wrapped in a .dimg
   (the image plus its boxes and markers: no text, so anchors are unaffected) with a button for the whole image,
   and Snip drags a box on it. The branch keeps which image (t.anchorImg = {key, n, x, y, w, h}: key is its URL, or
   a hash for a data: URL; n which of the images with that key, in order; the box as fractions of the image), and,
   like a PDF snip, the picture is drawn again when needed from a copy kept with the conversation
   (state.conv.doc.images[key], where an article's loaded images go): a remote image is downloaded once, by the server,
   with the same checks as a document from a link (loadArticleImage), never from the page. */
const strHash=(s)=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)}return (h>>>0).toString(16)};
const docImgKey=(src)=>/^data:/i.test(src)?`data:${src.length}.${strHash(src)}`:src;
const docImgRef=(t)=>docImgRefOf(state.conv,t);
function docImgAlt(w){const f=w.closest('.aimg'),im=w.querySelector('img');return ((f&&f.querySelector('.acap')&&f.querySelector('.acap').textContent)||(im&&im.getAttribute('alt'))||'').replace(/\s+/g,' ').trim()}
function docImages(root){
  const seen={};
  for(const im of root.querySelectorAll('img')){
    if(im.closest('.mermaid-box,.math'))continue;
    const fig=im.closest('.aimg'),src=fig?fig.dataset.url:(im.getAttribute('src')||'');
    if(!fig&&!/^(https?:|data:image\/)/i.test(src))continue;   // a relative path: nothing Digress can fetch
    const key=docImgKey(src),n=seen[key]||0;seen[key]=n+1;
    if(im.closest('.dimg'))continue;
    const w=document.createElement('span');w.className='dimg';w.dataset.key=key;w.dataset.n=n;w.__src=src;
    const host=fig?im.closest('.aview')||im:im;host.replaceWith(w);w.appendChild(host);
    const ask=document.createElement('button');ask.className='ib iask';ask.dataset.iask='';ask.title='Open a side branch about this image; the AI gets the image';ask.innerHTML=ic('branch');w.appendChild(ask);
    let i=0;for(const t of docBranches()){const a=t.anchorImg||t.anchorAt;if(a&&a.key===key&&a.n===n)imgMarker(w,t,i++)}
  }
  const el=paneEls.get('doc');if(el&&root.isConnected)applyPaneZoom('doc');   // Snip shows once there's an image to snip
}
function imgMarker(w,t,i){
  const r=t.anchorImg||{x:0,y:0,w:1,h:1};
  if(!isWholePage(r)){const d=document.createElement('div');d.className='dregion'+(t.resolved?' res':'');d.dataset.tid=t.id;d.style.cssText=`--c:${color(t)};left:${r.x*100}%;top:${r.y*100}%;width:${r.w*100}%;height:${r.h*100}%`;w.appendChild(d)}
  const m=docMarker(t);m.style.top=`calc(${isWholePage(r)?0:r.y*100}% + ${i*18}px)`;w.appendChild(m);
}
/* A picture of part of a text document (Snip anywhere but inside one image). The page has no way to photograph
   itself, so the blocks the box touches are copied into an off-screen .docbody of the same width, with their images
   swapped for the copies kept with the conversation (a remote one fetched by the server, never by the page) and
   the markers, highlights and buttons left out, and html-to-image draws that copy (an SVG foreignObject) onto a
   canvas. Its fonts are embedded once per font setting (docFontCss). The picture is kept as a file when the branch
   is made (t.anchorShot): unlike a PDF, the text re-wraps with the pane's width, theme and font, so it can't be
   drawn again the same. */
const HTML_TO_IMAGE='https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js';
const BLANK_PX='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let fontCssMemo=null;
function docFontCss(node){
  const k=(document.documentElement.dataset.font||'default')+(node.querySelector('code,pre')?'+mono':'');   // the families it uses
  if(!fontCssMemo||fontCssMemo.k!==k)fontCssMemo={k,p:htmlToImage.getFontEmbedCSS(node).catch(e=>{fontCssMemo=null;console.warn('fonts not embedded in the snip',e);return ''})};
  return fontCssMemo.p;
}
async function shotDocRegion(body,r){
  await loadScript(HTML_TO_IMAGE);
  const b=body.getBoundingClientRect(),T_=b.top+r.y,B_=T_+r.h,L=b.left+r.x,R_=L+r.w;
  const hit=(q)=>q.bottom>=T_&&q.top<=B_&&q.right>=L&&q.left<=R_;
  const kids=[...body.children].filter(c=>!c.classList.contains('snipbox')&&hit(c.getBoundingClientRect()));
  if(!kids.length)throw new Error('There’s nothing in that box.');
  const swap=new Map();   // img in the document → the kept copy's URL
  for(const w of body.querySelectorAll('.dimg')){
    if(!hit(w.getBoundingClientRect()))continue;const im=w.querySelector('img');if(!im)continue;
    try{const rec=await docImageRec(w);swap.set(im,await imageURL(rec.asset?{asset:rec.asset,type:rec.type}:{data:rec.data}))}catch(e){swap.set(im,BLANK_PX)}
  }
  // the copy sits in a frame the size of the box, which crops it (html-to-image sizes the node it draws, so the copy
  // itself can't be the one drawn: its border would end up across the picture). The frame is on screen but invisible
  // and behind everything: placed off screen, it's drawn blank
  const z=screenScale(body),cw=Math.max(1,Math.round(r.w/z)),ch=Math.max(1,Math.round(r.h/z));   // r is in screen pixels; the copy is laid out in CSS pixels
  const frame=document.createElement('div');frame.style.cssText=`position:fixed;left:0;top:0;width:${cw}px;height:${ch}px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1`;
  const copy=document.createElement('div');copy.className='docbody docshot';
  copy.style.cssText=`position:absolute;left:0;top:0;width:${body.offsetWidth}px;max-width:none;margin:0`;frame.appendChild(copy);
  for(const k of kids){
    const c=k.cloneNode(true),srcImgs=[...k.querySelectorAll('img')],cImgs=[...c.querySelectorAll('img')];
    srcImgs.forEach((im,i)=>{const u=swap.get(im);if(u&&cImgs[i])cImgs[i].src=u;else if(cImgs[i]&&/^https?:/i.test(cImgs[i].getAttribute('src')||''))cImgs[i].src=BLANK_PX});
    c.querySelectorAll('.iask,.snipbox,.dmark,.dregion,sup.fn').forEach(x=>x.remove());
    c.querySelectorAll('.anchor').forEach(x=>{x.className='';x.removeAttribute('style')});
    copy.appendChild(c);
  }
  body.parentElement.appendChild(frame);
  try{
    await Promise.all([...copy.querySelectorAll('img')].map(im=>im.decode().catch(()=>{})));
    const y=(r.y-(kids[0].getBoundingClientRect().top-b.top)+(copy.firstElementChild.getBoundingClientRect().top-copy.getBoundingClientRect().top))/z;
    copy.style.left=-r.x/z+'px';copy.style.top=-y+'px';
    const k=Math.min(2,IMG_MAX/Math.max(cw,ch));
    const cv=await htmlToImage.toCanvas(frame,{pixelRatio:k,fontEmbedCSS:await docFontCss(body),imagePlaceholder:BLANK_PX,
      backgroundColor:getComputedStyle(body).backgroundColor,style:{position:'relative',left:'0',top:'0',opacity:'1',zIndex:'auto'}});
    const blob=await encodeCanvas(cv);return {blob,type:blob.type,w:cv.width,h:cv.height};
  }finally{frame.remove()}
}
// the document's words inside a box (client coordinates), in order; where they are (anchorRange); and, with no
// text, the first image it touched (anchorAt), so the branch still has a place in the document
function docBoxText(body,L,T_,R_,B_){
  const w=textWalker(body),words=[];let n;const rg=document.createRange();
  while((n=w.nextNode())){
    rg.selectNodeContents(n);const q=rg.getBoundingClientRect();if(q.bottom<T_||q.top>B_||q.right<L||q.left>R_)continue;
    const re=/\S+/g,s=n.nodeValue;let m;
    while((m=re.exec(s))){rg.setStart(n,m.index);rg.setEnd(n,m.index+m[0].length);const c=rg.getBoundingClientRect(),cx=c.left+c.width/2,cy=c.top+c.height/2;
      if(c.width&&cx>=L&&cx<=R_&&cy>=T_&&cy<=B_)words.push([n,m.index,m.index+m[0].length,m[0]])}
  }
  let near=null;
  if(!words.length){const im=[...body.querySelectorAll('.dimg')].find(x=>{const q=x.getBoundingClientRect();return q.bottom>=T_&&q.top<=B_&&q.right>=L&&q.left<=R_});if(im)near={key:im.dataset.key,n:+im.dataset.n};return {text:'',range:null,near}}
  const s=charPos(body,words[0][0],words[0][1]),e=charPos(body,words.at(-1)[0],words.at(-1)[2]);
  const t=words.map(x=>x[3]).join(' ');
  return {text:t.length>600?t.slice(0,600)+' …(cut off; the image shows all of it)':t,range:s>=0&&e>s?{s,e}:null,near:null};
}
// the copy of an image kept with the conversation, made the first time it's asked about
async function docImageRec(w){
  const key=w.dataset.key,src=w.__src,c=state.conv;c.doc.images=c.doc.images||{};
  if(c.doc.images[key])return c.doc.images[key];
  if(!/^data:/i.test(src))return loadArticleImage(src);
  const [rec]=await storeImages([await fileToImage(await (await fetch(src)).blob())]);
  c.doc.images[key]=rec;if(c===state.conv)save();return rec;
}
document.addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('.dimg [data-iask]');if(!b)return;
  e.preventDefault();e.stopPropagation();openDocImgPop(b.closest('.dimg'),{x:0,y:0,w:1,h:1},b.closest('.dimg'));
},true);
function paintFigure(f){
  f.querySelectorAll('.abtns,.aview,.dimg').forEach(x=>x.remove());
  const url=f.dataset.url,rec=state.conv.doc&&state.conv.doc.images&&state.conv.doc.images[url];
  f.classList.toggle('loaded',!!rec);
  if(rec){const b=document.createElement('button');b.className='aview';b.dataset.zoomref='1';b.__ref=rec;b.title='Show larger';const im=document.createElement('img');im.alt='';b.appendChild(im);f.prepend(b);imageURL(rec).then(u=>{im.src=u}).catch(()=>b.remove());
    const body=f.closest('.docbody');if(body)docImages(body);return}
  const bt=document.createElement('span');bt.className='abtns';
  bt.innerHTML=`<button class="ib" data-aload title="Load this image. Digress downloads it (like the article itself) and keeps a copy with this conversation.">${ic('dl')}</button><a class="ib" target="_blank" rel="noopener noreferrer" title="Open the original image in a new tab">${ic('ext')}</a>`;
  bt.querySelector('a').href=url;f.appendChild(bt);
}
function articleBar(wrap,body){
  const n=body.querySelectorAll('.aimg').length;if(!n)return;
  const left=body.querySelectorAll('.aimg:not(.loaded)').length,bar=document.createElement('div');bar.className='abar';
  bar.innerHTML=`${ic('img')}<span></span>${left?`<button class="mbtn" data-aall>Load ${left===n?'all':'the other'} ${left}</button>`:''}`;
  bar.querySelector('span').textContent=`${n} image${n>1?'s':''} in this article${left?`, ${left===n?'not loaded':`${left} not loaded`}`:', all loaded'}. Images aren’t downloaded until you load them.`;
  wrap.prepend(bar);
}
const imgOk=new Map();   // url -> warning codes the reader has OK'd (http, bare IP, odd port)
async function loadArticleImage(url,o={}){
  const c=state.conv;c.doc.images=c.doc.images||{};if(c.doc.images[url])return c.doc.images[url];
  let blob;
  try{blob=await io.files.fetchImage(url,imgOk.get(url)||[])}
  catch(e){
    if(e&&e.warnings&&e.warnings.length&&!o.quiet){imgOk.set(url,e.warnings.map(w=>w.code));throw {message:`${e.message} ${e.warnings.map(w=>w.text).join('; ')}. Click again to load it anyway.`}}
    throw e;
  }
  const [rec]=await storeImages([await fileToImage(blob)]);
  c.doc.images[url]=rec;
  if(c===state.conv){save();const el=paneEls.get('doc');if(el){el.querySelectorAll('.aimg').forEach(f=>{if(f.dataset.url===url)paintFigure(f)});refreshArticleBar()}}
  return rec;
}
function refreshArticleBar(){const el=paneEls.get('doc');const w=el&&el.querySelector('.docwrap'),b=w&&w.querySelector('.docbody');if(!b)return;w.querySelectorAll('.abar').forEach(x=>x.remove());articleBar(w,b)}
document.addEventListener('click',async e=>{
  const one=e.target.closest&&e.target.closest('.aimg [data-aload]');
  if(one){e.preventDefault();e.stopPropagation();const f=one.closest('.aimg');one.disabled=true;f.classList.add('busy');
    try{await loadArticleImage(f.dataset.url)}catch(err){toast((err&&err.message)||'That image couldn’t be loaded.')}finally{one.disabled=false;f.classList.remove('busy')}return}
  const all=e.target.closest&&e.target.closest('[data-aall]');
  if(all){e.preventDefault();all.disabled=true;let bad=0;
    const urls=[...new Set([...paneEls.get('doc').querySelectorAll('.aimg:not(.loaded)')].map(f=>f.dataset.url))];
    for(const u of urls){try{await loadArticleImage(u,{quiet:true})}catch(err){bad++}}
    refreshArticleBar();if(bad)toast(`${bad} image${bad>1?'s':''} couldn’t be loaded (not a PNG, JPEG, WebP or GIF, unreachable, or needs your OK: load it on its own).`)}
},true);
async function startFromDoc(){
  const f=$('#docFile').files[0],pasted=$('#docPaste').value.trim(),msg=(s)=>$('#docMsg').textContent=s;
  if(!f&&!pasted){msg('Choose a file or paste some text.');return}
  let kind,name,blob=null,text=null,source=null,article=null;const typed=$('#docName').value.trim();
  const link=!f&&/^https?:\/\/\S+$/i.test(pasted)?pasted:null;
  if(link){
    if(!io.files.fromLink){msg('Opening a link needs the Digress server. Download the file and choose it above.');return}
    $('#docGo').disabled=true;msg('Downloading…');
    try{
      const d=await io.files.fromLink(link,docLinkOk&&docLinkOk.link===link?docLinkOk.codes:[]);
      kind=d.kind;source=d.url||link;
      if(d.blob.size>20*1024*1024){msg('That file is over 20 MB, the most this page can store.');$('#docGo').disabled=false;return}
      name=$('#docName').value.trim()||d.name||new URL(source).hostname;
      if(kind==='html'){   // a web page: keep just the article, as Markdown (reader view)
        msg('Reading the article…');
        const a=await articleToMarkdown(await d.blob.text(),source);
        kind='text';text=a.md;article=a;if(!typed&&a.title)name=a.title;
      }else if(kind==='pdf')blob=d.blob;else text=await d.blob.text();
    }catch(e){
      $('#docGo').disabled=false;$('#docGo').textContent='Start';
      if(e&&e.warnings&&e.warnings.length){
        // ask before fetching anything risky; the server stops before connecting to it
        const prev=docLinkOk&&docLinkOk.link===link?docLinkOk.codes:[];
        docLinkOk={link,codes:[...prev,...e.warnings.map(w=>w.code)]};
        let host='';try{host=new URL(e.url).host}catch(_){}
        msg(`${e.message} ${host?host+': ':''}${e.warnings.map(w=>w.text).join('; ')}. Only continue if you trust it.`);
        $('#docGo').textContent='Open anyway';return;
      }
      msg((e&&e.message)||'Could not download that link.');return;
    }
  }else if(f){
    const isPdf=/pdf$/i.test(f.type)||/\.pdf$/i.test(f.name);kind=isPdf?'pdf':'text';
    if(f.size>20*1024*1024){msg('That file is over 20 MB, the most this page can store.');return}
    name=$('#docName').value.trim()||f.name.replace(/\.[^.]+$/,'');
    if(isPdf)blob=f;else text=await f.text();
  }else{kind='text';text=pasted;name=$('#docName').value.trim()||trunc(pasted.split('\n').find(l=>l.trim())||'Pasted text',60).replace(/^#+\s*/,'')}
  const clip=kind==='text'&&!article&&clipFrontMatter(text);
  if(clip){text=clip.md;if(!typed&&clip.title)name=clip.title;if(clip.source&&!source)source=clip.source}
  $('#docGo').disabled=true;msg('Saving the document…');
  if(!await leaveOk()){$('#docGo').disabled=false;msg('');return}
  const c=newConv();c.title=name;c.doc={kind,name};
  // a typed title stays; otherwise a PDF may swap in its own title once pdf.js reads it (startDoc)
  if(typed||(article&&article.title)||(clip&&clip.title))c.titleKept=true;else if(kind==='pdf')c.autoTitle=name;if(source)c.doc.source=source;c.ui.open=['doc','main'];
  if(article){c.doc.article=true;c.doc.images={}}
  const stored=await storeDocFile(c,kind,blob,text);
  cacheDocBlob(c.id,kind==='pdf'?await blob.arrayBuffer():text);
  closeDocModal();setConv(c);state.dirty=true;save();
  if(!stored)toast('The document couldn\'t be stored here, so you\'ll need to attach it again after a reload.');
}
(()=>{
  const drop=$('#docDrop'),fi=$('#docFile');
  fi.onchange=()=>{const f=fi.files[0];if(!f)return;if(isDigressFile(f)){closeDocModal();importDigress(f);return}$('#docFileLbl').textContent=f.name};
  $('#docPaste').addEventListener('input',()=>{if(docLinkOk){docLinkOk=null;$('#docGo').textContent='Start';$('#docMsg').textContent=''}});
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over')});
  drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0]){fi.files=e.dataTransfer.files;fi.onchange()}});
  $('#docCancel').onclick=closeDocModal;$('#docGo').onclick=startFromDoc;
  $('#docModal').addEventListener('mousedown',e=>{if(e.target.id==='docModal')closeDocModal()});
  $('#docModal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeDocModal()}});
})();
// Browser clipper handoff (extension/bridge.js -> window.postMessage on this origin).
// mode: 'doc' (new document conversation from html/text) | 'branch' (new CLIP branch or into an existing branch)
function clipBranchesOf(c){
  if(!c||!c.threads)return [];
  const list=[{id:'main',title:'Main',isClip:false}];
  const kids=Object.values(c.threads).filter(t=>t&&t.id!=='main'&&!t.hidden).sort((a,b)=>(b.created||0)-(a.created||0));
  for(const t of kids)list.push({id:t.id,title:t.title||'Untitled branch',isClip:t.anchorMsg==='CLIP'});
  return list;
}
async function ingestClip(p){
  await io.ready;
  if(!p||typeof p!=='object')throw new Error('Invalid clip payload');
  const safeUrl=typeof p.url==='string'&&/^https?:\/\//i.test(p.url.trim())?p.url.trim():'';
  const mode=p.mode==='branch'?'branch':'doc';
  let title=String(p.title||'').trim();
  const rawText=String(p.text||'').trim();
  const rawHtml=String(p.html||'');
  if(mode==='doc'){
    let kind='text',text=rawText,name=title,article=null;
    if(!text&&rawHtml){
      const a=await articleToMarkdown(rawHtml,safeUrl||'https://example.invalid/');
      text=a.md;article=a;if(!name&&a.title)name=a.title;
    }
    if(!text)throw new Error('Nothing to clip');
    if(!name)name=trunc(text.split('\n').find(l=>l.trim())||'Clipped page',60).replace(/^#+\s*/,'');
    const c=newConv();c.title=name;c.titleKept=true;c.doc={kind,name};
    if(safeUrl)c.doc.source=safeUrl;
    if(article){c.doc.article=true;c.doc.images={}}
    c.ui.open=['doc','main'];
    await storeDocFile(c,kind,null,text);
    cacheDocBlob(c.id,text);
    setConv(c);state.dirty=true;await flushNow();
    toast(`Clipped “${trunc(name,40)}”`);
    return {convId:c.id,convTitle:c.title,threadId:'main',branchTitle:''};
  }
  let text=rawText;
  if(!text&&rawHtml){
    try{
      const a=await articleToMarkdown(rawHtml,safeUrl||'https://example.invalid/');
      text=String(a.md||'').trim();
      if(!title&&a.title)title=a.title;
    }catch(_){}
  }
  const convId=typeof p.convId==='string'?p.convId.trim():'';
  const convTitle=String(p.convTitle||'Clippings').trim()||'Clippings';
  if(p.useCurrentConv&&state.conv){
    // stay on the currently open conversation
  }else if(convId){
    const byId=state.convList.find(c=>!c.trashed&&c.id===convId);
    if(byId){if(!state.conv||state.conv.id!==byId.id)await openConv(byId.id)}
    else if(!state.conv||state.conv.id!==convId){
      const c=newConv();c.title=convTitle;c.titleKept=true;setConv(c);state.dirty=true;await flushNow();
    }
  }else{
    const want=convTitle.toLowerCase();
    const hit=state.convList.find(c=>!c.trashed&&String(c.title||'').trim().toLowerCase()===want);
    if(hit){if(!state.conv||state.conv.id!==hit.id)await openConv(hit.id)}
    else{
      const c=newConv();c.title=convTitle;c.titleKept=true;setConv(c);state.dirty=true;await flushNow();
    }
  }
  const targetTid=typeof p.targetThreadId==='string'?p.targetThreadId.trim():'';
  if(targetTid&&state.conv.threads[targetTid]){
    if(!state.conv.ui.open.includes(targetTid))state.conv.ui.open.push(targetTid);
    state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==targetTid);
    if(state.conv.ui.view==='canvas'){renderCanvas();focusCard(targetTid)}else{layout();revealPane(targetTid)}
    const pe=paneEls.get(targetTid),ta=pe&&pe.querySelector('textarea');
    if(ta){
      const parts=[];
      if(title||safeUrl)parts.push(`From ${title?`**${title}**`:'clip'}${safeUrl?` (${safeUrl})`:''}:`);
      if(text)parts.push('> '+text.replace(/\n/g,'\n> '));
      if(p.question)parts.push(String(p.question).trim());
      const block=parts.filter(Boolean).join('\n\n');
      if(block)ta.value=ta.value.trim()?ta.value.trimEnd()+'\n\n'+block:block;
      ta.focus();
    }
    const bt=targetTid==='main'?'Main':(state.conv.threads[targetTid].title||targetTid);
    toast(`Added to “${trunc(bt,32)}”`);
    return {convId:state.conv.id,convTitle:state.conv.title,threadId:targetTid,branchTitle:bt};
  }
  const rawImgs=Array.isArray(p.images)?p.images.slice(0,4):[];
  const readyImgs=[];
  for(const im of rawImgs){
    if(!im||typeof im.data!=='string'||!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(im.data))continue;
    try{const blob=await (await fetch(im.data)).blob();readyImgs.push(await fileToImage(blob))}catch(_){}
  }
  const anchorImages=readyImgs.length?await storeImages(readyImgs):[];
  const tid='t'+rid();
  const customBranch=String(p.branchTitle||'').trim();
  const bTitle=trunc(customBranch||title||text.split('\n').find(l=>l.trim())||'Clipping',52);
  const t={id:tid,parent:'main',anchorMsg:'CLIP',anchorText:text,anchorTitle:title,anchorUrl:safeUrl,title:bTitle,colorIdx:(state.conv.nextColor++)%6,created:Date.now()};
  if(customBranch)t.titleKept=true;
  if(anchorImages.length)t.anchorImages=anchorImages;
  state.conv.threads[tid]=t;state.conv.order[tid]=[];
  if(!state.conv.ui.open.includes(tid))state.conv.ui.open.push(tid);
  state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==tid);
  if(state.conv.ui.view==='canvas'){renderCanvas();focusCard(tid)}else{layout();revealPane(tid)}
  renderMap();state.dirty=true;await flushNow();
  const pe=paneEls.get(tid),ta=pe&&pe.querySelector('textarea');
  if(ta){if(p.question)ta.value=String(p.question);ta.focus()}
  toast(`Clipped to “${trunc(state.conv.title,32)}”`);
  return {convId:state.conv.id,convTitle:state.conv.title,threadId:tid,branchTitle:bTitle};
}
window.addEventListener('message',async e=>{
  if(e.source!==window||!e.data)return;
  if(e.data.digressClip===1){
    const id=e.data.id;
    try{const r=await ingestClip(e.data.payload);window.postMessage({digressClipAck:1,id,ok:true,...r},location.origin)}
    catch(err){window.postMessage({digressClipAck:1,id,ok:false,error:(err&&err.message)||'Could not clip'},location.origin)}
    return;
  }
  if(e.data.digressClipQuery===1){
    const id=e.data.id;
    try{
      await io.ready;
      const reqConvId=typeof e.data.convId==='string'?e.data.convId.trim():'';
      const conversations=state.convList.filter(c=>!c.trashed).slice().sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0,100)
        .map(c=>({id:c.id,title:c.title||'Untitled',updated:c.updated||0,hasDoc:!!c.doc}));
      let branches=[];
      if(reqConvId){
        if(state.conv&&state.conv.id===reqConvId)branches=clipBranchesOf(state.conv);
        else{const d=await io.store.get(reqConvId).catch(()=>null);branches=clipBranchesOf(d)}
      }else if(state.conv){
        branches=clipBranchesOf(state.conv);
      }
      window.postMessage({
        digressClipQueryAck:1,id,ok:true,
        currentConvId:state.conv?state.conv.id:'',
        currentConvTitle:state.conv?(state.conv.title||'Untitled'):'',
        currentThreadId:state.conv?(curPane()||'main'):'main',
        conversations,branches,
      },location.origin);
    }catch(err){window.postMessage({digressClipQueryAck:1,id,ok:false,error:(err&&err.message)||'Query failed'},location.origin)}
    return;
  }
  if(e.data.digressClipFocus===1){
    const id=e.data.id;
    try{
      await io.ready;
      const cid=typeof e.data.convId==='string'?e.data.convId.trim():'';
      const tid=typeof e.data.threadId==='string'?e.data.threadId.trim():'';
      if(cid&&(!state.conv||state.conv.id!==cid))await openConv(cid);
      if(tid&&state.conv&&state.conv.threads[tid]){
        if(!state.conv.ui.open.includes(tid))state.conv.ui.open.push(tid);
        state.conv.ui.collapsed=state.conv.ui.collapsed.filter(x=>x!==tid);
        if(state.conv.ui.view==='canvas'){renderCanvas();focusCard(tid)}else{layout();revealPane(tid)}
      }
      window.postMessage({digressClipFocusAck:1,id,ok:true},location.origin);
    }catch(err){window.postMessage({digressClipFocusAck:1,id,ok:false,error:(err&&err.message)||'Focus failed'},location.origin)}
  }
});


  return {
    DOC_STARTERS, get docState() { return docState; }, set docState(v) { docState = v; },
    docView, docViewReady, docBlobCache, cacheDocBlob, destroyDoc, docPagesLabel, docBranches,
    loadScript, docThumbUrl, startDoc, docReady, docPaneEl, updateDocHeader, renderDocPane,
    buildPdfPages, refreshDocAnchors, openDocPane, scrollDocToPage, READ_LINE, noteDocSpot,
    docSpotNow, putDocSpot, placeMark, markButton, goToPage, goToDocPart, goToEarlier,
    revealDocAnchor, linkPages, get lastDocSeen() { return lastDocSeen; }, set lastDocSeen(v) { lastDocSeen = v; },
    pageText, docTooLong, runDocTool, trailText,
    docReads, storeDocFile, openDocModal, closeDocModal, docImgRef, docImgAlt, shotDocRegion,
    docBoxText, docImageRec, ingestClip,
  };
}
