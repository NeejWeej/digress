import asyncio, json
from playwright.async_api import async_playwright
from common import ROOT, PAGE, OUT, FIX, CHROME, launch_args
MAP = {
    'marked.min.js': ROOT + 'marked/marked.min.js', 'purify.min.js': ROOT + 'dompurify/dist/purify.min.js',
    'highlight.min.js': ROOT + '@highlightjs/cdn-assets/highlight.min.js', 'tex-svg-full.js': ROOT + 'mathjax/es5/tex-svg-full.js',
    'mermaid.min.js': ROOT + 'mermaid/dist/mermaid.min.js', 'minisearch@7.1.0/dist/umd/index.js': ROOT + 'minisearch/dist/umd/index.js',
    'pdf.js/3.11.174/pdf.min.js': ROOT + 'pdfjs-dist/build/pdf.min.js', 'pdf.js/3.11.174/pdf.worker.min.js': ROOT + 'pdfjs-dist/build/pdf.worker.min.js',
}
# A stand-in for claude.ai's db / user / assets / sample capabilities. The database persists in
# sessionStorage so a reload sees the same data, like the real thing.
FAKE = r"""
(()=>{
const KEY='__fakedb';const load=()=>JSON.parse(sessionStorage.getItem(KEY)||'{}');const store=(d)=>sessionStorage.setItem(KEY,JSON.stringify(d));
const BLOBS=window.__blobs={};
function docRef(path){return {id:path.split('/').pop(),path,
  get:async()=>{const d=load();return {id:path.split('/').pop(),exists:path in d,data:()=>d[path]}},
  set:async(v)=>{const d=load();d[path]=JSON.parse(JSON.stringify(v));store(d)},
  update:async(v)=>{const d=load();if(!(path in d))throw {code:'invalid_argument'};Object.assign(d[path],JSON.parse(JSON.stringify(v)));store(d)},
  delete:async()=>{const d=load();delete d[path];store(d)},
  collection:(c)=>coll(path+'/'+c)}}
function coll(path){let ord=null,lim=1000;const q={path,
  doc:(id)=>docRef(path+'/'+id),
  orderBy:(f,dir)=>{ord=[f,dir];return q},limit:(n)=>{lim=n;return q},
  get:async()=>{const d=load();let docs=Object.keys(d).filter(k=>k.startsWith(path+'/')&&k.slice(path.length+1).indexOf('/')<0).map(k=>({id:k.split('/').pop(),exists:true,data:()=>d[k]}));
    if(ord)docs.sort((a,b)=>(b.data()[ord[0]]||0)-(a.data()[ord[0]]||0));return {docs:docs.slice(0,lim)}}};return q}
const db={collection:coll,doc:docRef};
window.__calls=[];
window.claude={use:async(n)=>{
  if(n==='db')return db;
  if(n==='user')return {id:async()=>'u_test'};
  if(n==='assets')return {upload:async(blob,o)=>{const id='a'+Math.random().toString(36).slice(2,10);BLOBS[id]=blob;window.__uploads=(window.__uploads||[]).concat([o.type]);return {id,url:'/_blob/'+id}},delete:async(id)=>{delete BLOBS[id];window.__deleted=(window.__deleted||[]).concat([id])}};
  if(n==='sample')return async(input,opts)=>{window.__calls.push({input,opts:{model:opts.model,modelTier:opts.modelTier,effort:opts.effort}});
    const REPLY='## Overview\n\nAttention is a soft dictionary lookup [p. 2].';let out='';
    for(const ch of REPLY.match(/[\s\S]{1,20}/g)){out+=ch;opts.onText&&opts.onText({text:out});await new Promise(r=>setTimeout(r,5))}
    return {text:out,truncated:false,modelApplied:opts.model||'claude-sonnet-5-5'}};
  return null}};
const of=window.fetch;window.fetch=async(u,...r)=>{const s=String(u);const m=s.match(/\/_blob\/(\w+)$/);if(m){const b=BLOBS[m[1]]||(window.__persistBlob&&window.__persistBlob[m[1]]);if(!b)return new Response('',{status:404});return new Response(b)}return of(u,...r)};
})();
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**launch_args())
        pg = await b.new_page(viewport={'width': 1500, 'height': 900}); errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        async def route(r):
            u = r.request.url
            for k, v in MAP.items():
                if u.endswith(k): return await r.fulfill(path=v, content_type='application/javascript')
            if 'fonts.g' in u: return await r.fulfill(body='', content_type='text/css')
            await r.continue_()
        await pg.route('**/*', route); await pg.add_init_script(FAKE)
        await pg.goto('file://' + PAGE); await pg.wait_for_timeout(1500)
        await pg.select_option('#mSel', 'claude-opus-5-5'); await pg.select_option('#eSel', 'high')
        ta = pg.locator('.pane[data-tid=main] textarea'); await ta.fill('Explain attention'); await ta.press('Enter'); await pg.wait_for_timeout(1800)
        c = await pg.evaluate("window.__calls[0]")
        print('system prompt folded into first message:', c['input'][0]['content'].startswith('You are a patient'), '| messages:', len(c['input']), '| model/tier/effort:', c['opts'])
        print('reply model label:', await pg.locator('.pane[data-tid=main] .model').text_content())
        await pg.wait_for_timeout(1200)
        keys = await pg.evaluate("Object.keys(JSON.parse(sessionStorage.getItem('__fakedb')||'{}'))")
        print('stored paths:', sorted(k.replace('u_test','<uid>') for k in keys))
        # branch, pin, then a PDF conversation (upload path)
        await pg.evaluate("""() => { const b=document.querySelector('.pane[data-tid=main] .msg.assistant .body'); const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT); let n;
          while((n=w.nextNode())){const i=n.nodeValue.indexOf('soft dictionary'); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+15); const s=getSelection(); s.removeAllRanges(); s.addRange(r); break}}
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); }""")
        await pg.wait_for_timeout(150); await pg.locator('#popIn').fill('Why?'); await pg.locator('#popIn').press('Enter'); await pg.wait_for_timeout(1800)
        await pg.locator('.pane').nth(1).locator('[data-act=pin]').click(); await pg.wait_for_timeout(1200)
        await pg.locator('#newDoc').click(); await pg.wait_for_timeout(200)
        await pg.set_input_files('#docFile', FIX + '/paper.pdf'); await pg.locator('#docGo').click(); await pg.wait_for_timeout(3000)
        print('uploaded:', await pg.evaluate('window.__uploads'), '| pages shown:', await pg.locator('.dpage').count())
        await pg.wait_for_timeout(1200)
        # keep uploaded files across the reload (the real store keeps them on the server)
        blobs = await pg.evaluate("Promise.all(Object.entries(window.__blobs).map(async([k,b])=>[k,Array.from(new Uint8Array(await b.arrayBuffer()))]))")
        await pg.add_init_script("window.__persistBlob=Object.fromEntries(" + json.dumps(blobs) + ".map(([k,a])=>[k,new Blob([new Uint8Array(a)],{type:'application/pdf'})]))")
        await pg.reload(); await pg.wait_for_timeout(3500)
        print('after reload: conversations', await pg.evaluate("[...document.querySelectorAll('#clist .citem .t, #plist .citem .t')].map(e=>e.textContent)"))
        print('after reload: opened latest =', await pg.locator('#cTitle').text_content(), '| pdf pages', await pg.locator('.dpage').count(), '| doc error', await pg.locator('.docerr').count())
        await pg.locator('#plist [data-pinb]').click(); await pg.wait_for_timeout(1200)
        print('pinned branch opens:', await pg.evaluate("[...document.querySelectorAll('.pane .ph-title')].map(t=>t.textContent)"))
        await pg.keyboard.press('Control+k'); await pg.wait_for_timeout(500); await pg.locator('#palIn').fill('saturating'); await pg.wait_for_timeout(800)
        print('search finds pdf text:', await pg.evaluate("[...document.querySelectorAll('#palRes .pr .pk')].map(e=>e.textContent)"))
        await pg.keyboard.press('Escape')
        # archive, then delete the PDF conversation (removes its file and search entry)
        it = pg.locator('#clist .citem', has_text='paper'); await it.hover(); await it.locator('[data-del]').click(); await pg.wait_for_timeout(200); await pg.locator('#mOk').click(); await pg.wait_for_timeout(1200)
        keys = await pg.evaluate("Object.keys(JSON.parse(sessionStorage.getItem('__fakedb')||'{}'))")
        print('after delete: file removed', bool(await pg.evaluate('window.__deleted')), '| stored paths', sorted(k.replace('u_test','<uid>').split('/')[-2] + '/…' for k in keys))
        print('\n'.join(errs[:10]) or 'no errors'); await b.close()
asyncio.run(main())
