// Image handling: PDF region snips, text-doc image crops, pasted/dropped screenshots,
// pending composer image attachments, lightbox viewer, and drag-to-snip overlay.
import { esc } from './text.js';
import { isWholePage } from './context.js';
import { parseInlineImageDataUrl } from './share.js';
import { state, app, io, ic, paneEls, memoSet } from './state.js';

export const IMG_MAX = 1568;
export const regionRef = (t) => ({
  region: { page: t.anchorPage + 1, x: t.anchorRegion.x, y: t.anchorRegion.y, w: t.anchorRegion.w, h: t.anchorRegion.h },
});

const imgMemo = new Map();
const urlMemo = new Map();
const IMG_MEMO_MAX = 80;

export function clearImgMemo() {
  for (const u of urlMemo.values()) {
    try { URL.revokeObjectURL(u); } catch (_) {}
  }
  urlMemo.clear();
  imgMemo.clear();
}

export const canvasBlob = (cv, type, q) => new Promise((r) => cv.toBlob(r, type, q));

export async function encodeCanvas(cv) {
  let b = await canvasBlob(cv, 'image/png');
  if (b && b.size > 3.5e6) b = await canvasBlob(cv, 'image/jpeg', 0.9);
  if (!b) throw new Error('The image couldn’t be encoded.');
  return b;
}

export async function renderRegion(pageNo, r) {
  const docState = state.docState;
  if (!docState || !docState.pdf) throw new Error('The document isn’t loaded.');
  const page = await docState.pdf.getPage(pageNo);
  const v1 = page.getViewport({ scale: 1 });
  const rw = r.w * v1.width, rh = r.h * v1.height;
  const k = Math.min(4, IMG_MAX / Math.max(rw, rh));
  const vp = page.getViewport({ scale: k });
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(rw * k));
  cv.height = Math.max(1, Math.round(rh * k));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -r.x * vp.width, -r.y * vp.height] }).promise;
  return cv;
}

export async function renderCrop(c) {
  if (!c.asset && !c.data) throw new Error('The image this branch is about isn’t kept with the conversation.');
  const src = await imageBlob(c.asset ? { asset: c.asset, type: c.type } : { data: c.data });
  if (isWholePage(c)) return src;
  const bm = await createImageBitmap(src);
  const sx = c.x * bm.width, sy = c.y * bm.height;
  const sw = Math.max(1, c.w * bm.width), sh = Math.max(1, c.h * bm.height);
  const k = Math.min(IMG_MAX / Math.max(sw, sh), Math.max(1, Math.min(4, 400 / Math.max(sw, sh))));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(sw * k));
  cv.height = Math.max(1, Math.round(sh * k));
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bm, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  if (bm.close) bm.close();
  return encodeCanvas(cv);
}

export function imageBlob(ref) {
  if (!ref || typeof ref !== 'object') return Promise.reject(new Error('Invalid image reference.'));
  const docState = state.docState;
  const cs = (c) => (c && c.asset ? 'a' + c.asset : c && typeof c.data === 'string' ? 'd' + c.data.length + c.data.slice(-64) : '-');
  const k = ref.region
    ? ['r', docState && docState.key, ref.region.page, ref.region.x, ref.region.y, ref.region.w, ref.region.h].join('|')
    : ref.crop
      ? ['c', cs(ref.crop), ref.crop.x, ref.crop.y, ref.crop.w, ref.crop.h].join('|')
      : ref.asset
        ? 'a|' + ref.asset
        : typeof ref.data === 'string'
          ? 'd|' + ref.data.length + '|' + ref.data.slice(-64)
          : 'bad';
  if (!imgMemo.has(k)) {
    memoSet(imgMemo, k, (async () => {
      if (ref.region) return encodeCanvas(await renderRegion(ref.region.page, ref.region));
      if (ref.crop) return renderCrop(ref.crop);
      if (ref.asset) {
        if (typeof ref.asset !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.asset)) {
          throw new Error('Invalid image attachment reference.');
        }
        await io.ready;
        if (!io.files) throw new Error('No file storage here.');
        return new Blob([await io.files.fetch(ref.asset, 'arrayBuffer')], { type: ref.type });
      }
      const { type, bytes } = parseInlineImageDataUrl(ref.data);
      return new Blob([bytes], { type });
    })().catch((e) => { imgMemo.delete(k); throw e; }), IMG_MEMO_MAX);
  }
  return imgMemo.get(k);
}

export async function imageURL(ref) {
  const b = await imageBlob(ref);
  if (!urlMemo.has(b)) {
    memoSet(urlMemo, b, URL.createObjectURL(b), IMG_MEMO_MAX, (u) => {
      try { URL.revokeObjectURL(u); } catch (_) {}
    });
  }
  return urlMemo.get(b);
}

export const blobB64 = (b) => new Promise((ok, no) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(',')[1]);
  fr.onerror = () => no(fr.error);
  fr.readAsDataURL(b);
});

export async function fileToImage(file) {
  const bm = await createImageBitmap(file);
  const k = Math.min(1, IMG_MAX / Math.max(bm.width, bm.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bm.width * k));
  cv.height = Math.max(1, Math.round(bm.height * k));
  cv.getContext('2d').drawImage(bm, 0, 0, cv.width, cv.height);
  if (bm.close) bm.close();
  const blob = await encodeCanvas(cv);
  return { blob, type: blob.type, w: cv.width, h: cv.height };
}

export async function storeImages(list) {
  const out = [];
  for (const im of list) {
    const rec = { type: im.type, w: im.w, h: im.h };
    if (io.files && io.files.canUpload) {
      try {
        rec.asset = (await io.files.upload(im.blob, im.type)).id;
        imgMemo.set('a|' + rec.asset, Promise.resolve(im.blob));
      } catch (e) {
        console.warn('image upload failed; keeping it in the message', e);
      }
    }
    if (!rec.asset) rec.data = 'data:' + im.type + ';base64,' + await blobB64(im.blob);
    out.push(rec);
  }
  return out;
}

export const pendingImgs = new Map();
const pendingKey = (tid, cid = state.conv && state.conv.id) => (cid && tid ? cid + '\0' + tid : null);

export function getPending(tid, cid) {
  const k = pendingKey(tid, cid);
  return (k && pendingImgs.get(k)) || [];
}

export async function addPending(tid, files) {
  const cid = state.conv && state.conv.id;
  if (!cid) return;
  const k = pendingKey(tid, cid);
  for (const f of files) {
    try {
      const im = await fileToImage(f);
      im.url = URL.createObjectURL(im.blob);
      if (!pendingImgs.has(k)) pendingImgs.set(k, []);
      pendingImgs.get(k).push(im);
    } catch (e) {
      app.toast('That image couldn’t be read.');
    }
  }
  if (state.conv && state.conv.id === cid) renderPending(tid);
}

export function takePending(tid, cid) {
  const k = pendingKey(tid, cid);
  const l = (k && pendingImgs.get(k)) || [];
  if (k) pendingImgs.delete(k);
  if (!cid || (state.conv && state.conv.id === cid)) renderPending(tid);
  return l;
}

export function renderPending(tid) {
  const cid = (state.conv && state.conv.id) || '';
  const list = getPending(tid, cid);
  const hosts = [];
  const pe = paneEls.get(tid);
  if (pe && pe.querySelector('.composer')) hosts.push([pe.querySelector('.composer'), pe.querySelector('.cbox')]);
  const ck = document.querySelector(`#cv .cnode[data-ctid="${tid}"] .cask`);
  if (ck) hosts.push([ck.parentElement, ck]);
  for (const [host, before] of hosts) {
    let st = host.querySelector(':scope > .cimgs');
    if (!list.length) { if (st) st.remove(); continue; }
    if (!st) { st = document.createElement('div'); st.className = 'cimgs'; host.insertBefore(st, before); }
    st.innerHTML = list.map((im, i) => `<span class="cimg"><img src="${im.url}" alt="Pasted image ${i + 1}"><button type="button" class="cix" data-unpaste="${i}" data-utid="${esc(tid)}" data-ucid="${esc(cid)}" title="Remove this image">${ic('x')}</button></span>`).join('');
  }
  app.updateComposer(tid);
}

const composerTid = (el) => {
  if (!el || !el.closest) return null;
  const f = el.closest('.pane .composer');
  if (f) return f.closest('.pane').dataset.tid;
  const c = el.closest('.cask');
  return c ? c.closest('.cnode').dataset.ctid : null;
};
const imageFiles = (list) => [...(list || [])].filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));

export function userMsgBody(el, m) {
  const imgs = m.images || [];
  el.classList.toggle('hasimg', imgs.length > 0);
  el.innerHTML = (imgs.length ? '<div class="uimgs"></div>' : '') + '<div class="body"></div>';
  el.querySelector('.body').textContent = m.content || '';
  if (!imgs.length) return;
  const box = el.querySelector('.uimgs');
  imgs.forEach((ref, i) => {
    const b = document.createElement('button');
    b.className = 'uimg';
    b.title = 'Show larger';
    b.__ref = ref;
    b.dataset.zoomref = '1';
    const im = document.createElement('img');
    im.alt = `Image ${i + 1}`;
    if (ref.w && ref.h) { im.width = ref.w; im.height = ref.h; }
    b.appendChild(im);
    box.appendChild(b);
    imageURL(ref).then((u) => {
      im.src = u;
      im.removeAttribute('width');
      im.removeAttribute('height');
    }).catch(() => { b.innerHTML = '<span class="gone">Image unavailable</span>'; });
  });
}

export function lightbox(ref) {
  const d = document.createElement('div');
  d.className = 'lightbox';
  d.innerHTML = '<img alt="">';
  document.body.appendChild(d);
  (ref.url ? Promise.resolve(ref.url) : imageURL(ref)).then((u) => { d.firstChild.src = u; }).catch(() => d.remove());
  const close = () => { d.remove(); removeEventListener('keydown', esc_, true); };
  const esc_ = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  d.addEventListener('click', close);
  addEventListener('keydown', esc_, true);
}

export function setSnip(on) {
  const el = paneEls.get('doc');
  if (!el) return;
  el.classList.toggle('snipping', on);
  const b = el.querySelector('[data-act=snip]');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  if (on) {
    app.hidePop();
    getSelection().removeAllRanges();
    app.toast(state.docState && state.docState.kind !== 'pdf'
      ? 'Drag a box over the part of the document you want to ask about. Esc cancels.'
      : 'Drag a box over the part of the page you want to ask about. Esc cancels.');
  }
}

export function regionText(pageNo, r) {
  const pg = paneEls.get('doc') && paneEls.get('doc').querySelector(`.dpage[data-page="${pageNo}"]`);
  const tl = pg && pg.querySelector('.textLayer');
  if (!tl) return '';
  const b = pg.getBoundingClientRect();
  const L = b.left + r.x * b.width, T_ = b.top + r.y * b.height, R = L + r.w * b.width, B = T_ + r.h * b.height;
  const out = [];
  for (const sp of tl.querySelectorAll('span')) {
    if (sp.querySelector('span')) continue;
    const q = sp.getBoundingClientRect();
    if (!q.width) continue;
    const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
    if (cx >= L && cx <= R && cy >= T_ && cy <= B) out.push(sp.textContent);
  }
  const t = out.join(' ').replace(/\s+/g, ' ').trim();
  return t.length > 600 ? t.slice(0, 600) + ' …(cut off; the image shows all of it)' : t;
}

let snipUpAt = 0;
export const screenScale = (el) => {
  const r = el.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  return h > w && h ? r.height / h : w ? r.width / w : 1;
};

function startSnip(e) {
  const pg = e.target.closest('.dpage,.docbody');
  if (!pg) return;
  e.preventDefault();
  e.stopPropagation();
  document.querySelectorAll('.snipbox').forEach((b) => b.remove());
  const box = document.createElement('div');
  box.className = 'snipbox';
  pg.appendChild(box);
  const b0 = pg.getBoundingClientRect(), x0 = e.clientX - b0.left, y0 = e.clientY - b0.top;
  let rect = null;
  try { pg.setPointerCapture(e.pointerId); } catch (_) {}
  const move = (ev) => {
    const b = pg.getBoundingClientRect();
    const x1 = Math.min(Math.max(ev.clientX - b.left, 0), b.width);
    const y1 = Math.min(Math.max(ev.clientY - b.top, 0), b.height);
    rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), W: b.width, H: b.height };
    const k = screenScale(pg);
    Object.assign(box.style, { left: rect.x / k + 'px', top: rect.y / k + 'px', width: rect.w / k + 'px', height: rect.h / k + 'px' });
  };
  const up = () => {
    pg.removeEventListener('pointermove', move);
    pg.removeEventListener('pointerup', up);
    pg.removeEventListener('pointercancel', up);
    if (rect) snipUpAt = Date.now();
    if (!rect || rect.w < 12 || rect.h < 12) { box.remove(); return; }
    setSnip(false);
    const reg = { x: rect.x / rect.W, y: rect.y / rect.H, w: rect.w / rect.W, h: rect.h / rect.H };
    if (!pg.classList.contains('docbody')) { app.openImagePop(+pg.dataset.page, reg, box); return; }
    const b = pg.getBoundingClientRect(), L = b.left + rect.x, T_ = b.top + rect.y, R_ = L + rect.w, B_ = T_ + rect.h;
    const w = [...pg.querySelectorAll('.dimg')].find((el) => {
      const q = el.getBoundingClientRect();
      return L >= q.left - 2 && T_ >= q.top - 2 && R_ <= q.right + 2 && B_ <= q.bottom + 2;
    });
    if (w) {
      const q = w.getBoundingClientRect(), c = (v) => Math.min(1, Math.max(0, v));
      const x = c((L - q.left) / q.width), y = c((T_ - q.top) / q.height);
      app.openDocImgPop(w, { x, y, w: c((R_ - q.left) / q.width) - x, h: c((B_ - q.top) / q.height) - y }, box);
    } else {
      app.openDocShotPop(pg, { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, box);
    }
  };
  pg.addEventListener('pointermove', move);
  pg.addEventListener('pointerup', up);
  pg.addEventListener('pointercancel', up);
}

export function initMediaListeners() {
  document.addEventListener('paste', (e) => {
    const tid = composerTid(e.target);
    if (!tid || !e.clipboardData) return;
    const files = imageFiles(e.clipboardData.files);
    if (!files.length) return;
    if (!(e.clipboardData.getData('text/plain') || '').trim()) e.preventDefault();
    addPending(tid, files);
  });
  document.addEventListener('dragover', (e) => {
    if (composerTid(e.target) && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const tid = composerTid(e.target);
    if (!tid || !e.dataTransfer) return;
    const files = imageFiles(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    addPending(tid, files);
  });
  document.addEventListener('click', (e) => {
    const u = e.target.closest && e.target.closest('[data-unpaste]');
    if (u) {
      const cid = u.dataset.ucid || (state.conv && state.conv.id);
      const k = pendingKey(u.dataset.utid, cid);
      const l = (k && pendingImgs.get(k)) || [];
      const [im] = l.splice(+u.dataset.unpaste, 1);
      if (im) URL.revokeObjectURL(im.url);
      if (k && !l.length) pendingImgs.delete(k);
      if (!cid || (state.conv && state.conv.id === cid)) renderPending(u.dataset.utid);
      return;
    }
    const z = e.target.closest && e.target.closest('[data-zoomref]');
    if (z && z.__ref) { e.stopPropagation(); lightbox(z.__ref); }
  }, true);
  document.addEventListener('click', (e) => {
    if (Date.now() - snipUpAt < 400) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest && e.target.closest('.docpane.snipping');
    if (el && !e.target.closest('.ph')) startSnip(e);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.docpane.snipping')) setSnip(false);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-pask]');
    if (!b) return;
    e.stopPropagation();
    app.openImagePop(+b.dataset.pask, { x: 0, y: 0, w: 1, h: 1 }, b.closest('.dpage'));
  }, true);
}
