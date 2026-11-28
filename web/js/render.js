// Markdown, MathJax, Mermaid, remote-content sanitization, diagram/image zoom, and code-copy rendering for Digress.
import { esc } from './text.js';
import { state, app, ic, rid, memoSet } from './state.js';
import { invalidate } from './redraw.js';

const MATHJAX_CDN = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg-full.js';
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js';

export function protectMath(md, maths) {
  const parts = md.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts.map((p, i) => {
    if (i % 2) return p;
    return p.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/g, (raw, a, b, c, d) => {
      const disp = a != null || b != null;
      maths.push({ t: (a ?? b ?? c ?? d).trim(), d: disp, raw });
      const k = `@@M${maths.length - 1}@@`;
      return disp ? `\n\n${k}\n\n` : k;
    });
  }).join('');
}

// The clipboard API exists only on https or localhost; over plain http (a tailnet address)
// the older copy command still works, from a click. Resolves once copied, rejects if neither could.
export function copyText(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  return new Promise((ok, no) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    const was = document.activeElement;
    ta.select();
    let done = false;
    try { done = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    if (was && was.focus) was.focus({ preventScroll: true });
    done ? ok() : no();
  });
}

export function createRenderer() {
  marked.setOptions({ gfm: true, breaks: false });

  let mathLoadP = null;
  function loadMath() {
    if (state.mathReady) return Promise.resolve();
    if (window.MathJax && MathJax.tex2svg) {
      window.__mathReady && window.__mathReady();
      return Promise.resolve();
    }
    if (!mathLoadP) {
      mathLoadP = app.loadScript(MATHJAX_CDN)
        .then(() => { if (window.MathJax && MathJax.tex2svg && window.__mathReady) window.__mathReady(); })
        .catch(() => { mathLoadP = null; });
    }
    return mathLoadP;
  }

  const TEXC = new Map();
  function texSvg(t, d) {
    const k = (d ? 'D' : 'I') + t;
    let n = TEXC.get(k);
    if (!n) {
      n = MathJax.tex2svg(t, { display: d });
      if (TEXC.size > 300) TEXC.delete(TEXC.keys().next().value);
      TEXC.set(k, n);
    }
    return n.cloneNode(true);
  }

  /* What a model writes never makes the browser fetch anything by itself. A document being read can tell the model to
     write ![](https://site/?q=<the conversation>), and the browser would send that the moment the reply showed. So in
     replies, takeaways, cards and the guide (not the document itself, which the reader chose), DOMPurify is run with
     noRemote: an image from another site becomes a placeholder (remoteImg) showing where it's from, loaded only by its
     button; anything else that would load from another site (srcset, a poster, CSS url(), an svg image or use) is
     dropped. Links stay: they go nowhere until clicked. The placeholder's words are drawn by CSS (attr()), so the
     text that anchors count is the same as with the bare image. */
  let noRemote = false;
  const nearUrl = (u) => {
    const v = String(u || '').trim();
    if (!v || v[0] === '#' || /^(data|blob):/i.test(v)) return true;
    try { return new URL(v, location.href).origin === location.origin; } catch (e) { return false; }
  };
  const cssRemote = (css) => /\\|@import|image-set|src\s*:/i.test(css) || [...css.matchAll(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].some((x) => !nearUrl(x[2]));

  DOMPurify.addHook('uponSanitizeElement', (n, d) => {
    if (noRemote && d.tagName === 'style' && cssRemote(n.textContent || '')) n.textContent = '';
  });
  DOMPurify.addHook('afterSanitizeAttributes', (n) => {
    if (!noRemote || !n.attributes) return;
    const tag = n.nodeName.toLowerCase();
    for (const a of [...n.attributes]) {
      const k = a.name.toLowerCase(), v = a.value;
      if (k === 'style' || /url\s*\(/i.test(v)) {
        if (cssRemote(v)) n.removeAttribute(a.name);
      } else if (['srcset', 'poster', 'background', 'ping', 'lowsrc', 'dynsrc'].includes(k)) {
        if (k === 'srcset' && tag === 'img' && !n.getAttribute('src')) {
          const u = v.trim().split(/\s+/)[0];
          if (u && !nearUrl(u)) n.setAttribute('data-rsrc', u);
          else if (u) n.setAttribute('src', u);
        }
        n.removeAttribute(a.name);
      } else if ((k === 'src' || k === 'data' || (tag !== 'a' && (k === 'href' || k === 'xlink:href'))) && !nearUrl(v)) {
        if (tag === 'img') n.setAttribute('data-rsrc', v);
        n.removeAttribute(a.name);
      }
    }
  });

  const purifyNoRemote = (html, cfg) => {
    noRemote = true;
    try { return DOMPurify.sanitize(html, cfg); } finally { noRemote = false; }
  };

  const RIMG_OK = new Set();
  function remoteImg(im) {
    const url = im.dataset.rsrc;
    im.removeAttribute('data-rsrc');
    if (RIMG_OK.has(url)) {
      im.replaceWith(rimgBox(url, im.getAttribute('alt') || ''));
      return;
    }
    let host = '';
    try { host = new URL(url).host; } catch (e) {}
    const alt = (im.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    const f = document.createElement('span');
    f.className = 'rimg';
    f.dataset.rurl = url;
    f.innerHTML = `<span class="rtx"></span><button class="ib" data-rload title="Load this image from ${esc(host || 'its site')}. Images in replies aren’t loaded until you ask, since an address can carry text from the conversation.">${ic('img')}</button>`;
    const t = f.firstChild;
    t.dataset.label = (alt ? 'Image: ' + alt : 'Image') + (host ? ' · from ' + host : '');
    t.dataset.url = url;
    t.title = url;
    im.replaceWith(f);
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.rimg [data-rload]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const url = b.closest('.rimg').dataset.rurl;
    RIMG_OK.add(url);
    document.querySelectorAll('.rimg').forEach((f) => {
      if (f.dataset.rurl !== url) return;
      const a = f.querySelector('.rtx').dataset.label.replace(/^Image(: )?/, '').replace(/ · from .*$/, '');
      f.replaceWith(rimgBox(url, a));
    });
  }, true);

  const MM_BAR = `<div class="mm-bar"><span class="mm-ctl"><button type="button" data-mmz="out" title="Zoom out">${ic('minus')}</button><button type="button" data-mmz="in" title="Zoom in">${ic('plus')}</button><button type="button" data-mmz="fit" title="Fit the whole diagram">${ic('fit')}</button><span class="mm-sep"></span>` +
    [['l', 'left'], ['u', 'up'], ['d', 'down'], ['r', 'right']].map(([d, w]) => `<button type="button" data-mmz="${d}" title="Move ${w} (hold to keep going)">${ic('a' + d)}</button>`).join('') +
    `</span><button type="button" class="mm-tog" data-mmz="tog" title="Zoom into this diagram" aria-expanded="false">${ic('zoom')}</button></div>`;

  function rimgBox(url, alt) {
    const box = document.createElement('span');
    box.className = 'rimgbox';
    const v = document.createElement('span');
    v.className = 'mm-view';
    const im = document.createElement('img');
    im.src = url;
    if (alt) im.alt = alt;
    im.title = 'Show larger';
    im.addEventListener('load', () => {
      if (box.dataset.k) mmZoom(box, +box.dataset.k);
      else mmState(box);
    });
    v.appendChild(im);
    box.appendChild(v);
    box.insertAdjacentHTML('beforeend', MM_BAR.replace('Zoom into this diagram', 'Zoom into this image'));
    return box;
  }

  document.addEventListener('click', (e) => {
    const im = e.target.closest && e.target.closest('.rimgbox:not([data-k]) .mm-view>img');
    if (!im) return;
    e.stopPropagation();
    e.preventDefault();
    app.lightbox({ url: im.currentSrc || im.src });
  }, true);

  const HLJS_CACHE = new Map(), HLJS_MAX = 120;
  function highlightCode(code, lang) {
    if (!window.hljs) return;
    const src = code.textContent, k = (lang || '') + '\0' + src;
    const hit = HLJS_CACHE.get(k);
    if (hit) { code.innerHTML = hit.h; code.className = hit.c; return; }
    try {
      hljs.highlightElement(code);
      memoSet(HLJS_CACHE, k, { h: code.innerHTML, c: code.className }, HLJS_MAX);
    } catch (e) {}
  }

  let cpyPress = null;
  function copyCode(b) {
    const code = b.parentElement.querySelector('pre code');
    if (!code) return;
    copyText(code.textContent.replace(/\n$/, '')).then(() => {
      b.classList.add('done');
      b.innerHTML = ic('check');
      b.title = 'Copied';
      clearTimeout(b.__t);
      b.__t = setTimeout(() => { b.classList.remove('done'); b.innerHTML = ic('copy'); b.title = 'Copy'; }, 1500);
    }, () => app.toast("Copy isn't allowed here"));
  }
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.cbx .cpy');
    if (!b) return;
    e.stopPropagation();
    e.preventDefault();
    cpyPress = { b, moved: false };
  }, true);
  document.addEventListener('pointerup', (e) => {
    const p = cpyPress;
    cpyPress = null;
    if (!p || !p.moved) return;
    const u = document.elementFromPoint(e.clientX, e.clientY);
    if (u && u.closest('.cbx .cpy') === p.b) copyCode(p.b);
  }, true);
  document.addEventListener('pointercancel', () => { cpyPress = null; }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.cbx .cpy');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    copyCode(b);
  }, true);

  let mermaidReady = null, mermaidOk = false;
  const mermaidSrc = new WeakMap();

  function renderRich(el, md, final, o = {}) {
    if (final) { delete el.__streamMd; delete el.__liveKey; delete el.__streamMath; }
    const maths = [];
    const cpys = [...el.querySelectorAll('.cbx>.cpy')];
    let src = md || '';
    if (!final && !o.doc) src = src.replace(/\[((?:pp?\.|pages?|parts?)\s*\d+|earlier|doc)\s+["“][^"”\n\]]*$/i, '[$1…]');
    let html = marked.parse(protectMath(src, maths));
    html = o.doc ? DOMPurify.sanitize(html) : purifyNoRemote(html);
    html = html.replace(/@@M(\d+)@@/g, (_, i) => `<span class="math${maths[+i] && maths[+i].d ? ' display' : ''}" data-i="${i}"></span>`);
    el.innerHTML = html;
    if (!o.doc) el.querySelectorAll('img[data-rsrc]').forEach(remoteImg);
    const mReady = state.mathReady;
    if (maths.length && !mReady) loadMath();
    el.querySelectorAll('span.math').forEach((s) => {
      const m = maths[+s.dataset.i];
      if (!m) return;
      if (mReady) { try { s.appendChild(texSvg(m.t, m.d)); return; } catch (e) {} }
      s.classList.add('raw');
      s.textContent = m.raw;
    });
    const codes = [...el.querySelectorAll('pre code')];
    const openCode = !final && ((md || '').match(/^\s*(```|~~~)/gm) || []).length % 2 === 1 ? codes[codes.length - 1] : null;
    codes.forEach((code) => {
      const lang = ((code.className || '').match(/language-(\S+)/) || [])[1];
      if (lang === 'mermaid') {
        const box = document.createElement('div');
        box.className = 'mermaid-box';
        mermaidSrc.set(box, code.textContent);
        box.textContent = final ? 'Rendering diagram…' : 'Drawing diagram…';
        code.parentElement.replaceWith(box);
      } else {
        highlightCode(code, lang);
        const pre = code.parentElement, w = document.createElement('div');
        w.className = 'cbx';
        pre.replaceWith(w);
        w.appendChild(pre);
        if (!final) w.dataset.live = '';
        if (code !== openCode) w.insertAdjacentHTML('beforeend', `<button type="button" class="cpy" title="Copy">${ic('copy')}</button>`);
      }
    });
    el.querySelectorAll('.cbx').forEach((w, i) => {
      const n = w.querySelector('.cpy'), prev = cpys[i];
      if (n && prev) {
        n.replaceWith(prev);
        if (cpyPress && cpyPress.b === prev) cpyPress.moved = true;
      }
    });
    el.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    if (!o.doc && !el.classList.contains('docbody')) app.linkPages(el, { doc: state.conv && state.conv.doc });
  }

  function mermaidTheme() {
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const dark = document.documentElement.dataset.mode === 'dark';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'themeCSS', 'fontFamily', 'altFontFamily'],
      theme: 'base',
      fontFamily: 'Inter, system-ui, sans-serif',
      themeVariables: {
        darkMode: dark,
        background: v('--panel'),
        primaryColor: v('--panel-2'),
        primaryTextColor: v('--ink'),
        primaryBorderColor: v('--line2'),
        secondaryColor: v('--user-bg'),
        tertiaryColor: v('--code-bg'),
        lineColor: v('--muted'),
        textColor: v('--ink'),
        noteBkgColor: v('--user-bg'),
        noteTextColor: v('--ink'),
        noteBorderColor: v('--line2'),
        fontSize: '14px',
      },
    });
  }

  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise((res) => {
      app.loadScript(MERMAID_CDN).then(() => {
        try { mermaidTheme(); mermaidOk = true; } catch (e) {}
        res();
      }, () => res());
    });
    return mermaidReady;
  }

  function showMermaidSrc(box, why, err) {
    const reply = box.closest('.msg.assistant') && box.closest('.pane[data-tid]');
    box.classList.add('mm-bad');
    box.innerHTML = `<div class="mm-why"><span></span>${reply && err ? `<button class="tb" data-mmfix="1" title="Put a request for a corrected diagram in this thread's question box">${ic('retry')}Ask for a fix</button>` : ''}</div>${err ? '<pre class="mm-msg"></pre>' : ''}<pre class="mm-err"><code></code></pre>`;
    box.querySelector('.mm-why span').textContent = why;
    box.querySelector('code').textContent = mermaidSrc.get(box) || '';
    if (err) { box.querySelector('.mm-msg').textContent = err; box.dataset.err = err; }
  }

  async function renderMermaid(root) {
    const boxes = [...root.querySelectorAll('.mermaid-box:not([data-done])')];
    if (!boxes.length) return;
    await loadMermaid();
    for (const box of boxes) {
      if (box.dataset.done) continue;
      box.dataset.done = '1';
      if (!mermaidOk) { showMermaidSrc(box, 'The diagram library couldn’t load, so this is its source.'); continue; }
      const id = 'mm' + rid();
      try {
        const { svg } = await mermaid.render(id, mermaidSrc.get(box) || '');
        box.classList.remove('mm-bad', 'mmz-on');
        delete box.dataset.k;
        const v = document.createElement('div');
        v.className = 'mm-view';
        v.append(purifyNoRemote(svg, {
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
          ADD_TAGS: ['foreignObject', 'style'],
          HTML_INTEGRATION_POINTS: { foreignobject: true },
          RETURN_DOM_FRAGMENT: true,
        }));
        box.replaceChildren(v);
        box.insertAdjacentHTML('beforeend', MM_BAR);
      } catch (e) {
        showMermaidSrc(box, 'This diagram has a syntax error, so it can’t be drawn. Its source is below.', ((e && e.message) || String(e)).split('\n').slice(0, 3).join('\n'));
        for (const x of [id, 'd' + id, 'i' + id]) {
          const n = document.getElementById(x);
          if (n && n.parentElement === document.body) n.remove();
        }
      }
    }
    invalidate('wires-soon');
  }

  const MMZ_MAX = 6, MMZ_STEP = 1.5;
  function mmZoom(box, k) {
    const v = box.querySelector('.mm-view'), svg = v && v.querySelector(':scope>svg,:scope>img');
    if (!svg) return;
    k = Math.max(1, Math.min(MMZ_MAX, k));
    const was = +box.dataset.k || 1;
    if (k === 1) {
      if (was !== 1) { svg.style.width = ''; svg.style.maxHeight = ''; svg.style.maxWidth = box.dataset.mw || ''; v.style.height = ''; }
      v.scrollTo(0, 0);
      delete box.dataset.k;
      mmState(box);
      return;
    }
    if (was === 1) {
      const vb = svg.viewBox && svg.viewBox.baseVal, a = vb && vb.width ? vb.height / vb.width : 0;
      box.dataset.w = a ? Math.min(svg.clientWidth, svg.clientHeight / a) : svg.clientWidth;
      box.dataset.mw = svg.style.maxWidth;
      v.style.height = v.clientHeight + 'px';
    }
    const fx = (v.scrollLeft + v.clientWidth / 2) / v.scrollWidth;
    const fy = (v.scrollTop + v.clientHeight / 2) / v.scrollHeight;
    svg.style.maxWidth = 'none';
    svg.style.maxHeight = 'none';
    svg.style.width = (+box.dataset.w * k) + 'px';
    box.dataset.k = k;
    v.scrollLeft = fx * v.scrollWidth - v.clientWidth / 2;
    v.scrollTop = fy * v.scrollHeight - v.clientHeight / 2;
    mmState(box);
  }

  function mmState(box) {
    const v = box.querySelector('.mm-view');
    if (!v) return;
    const k = +box.dataset.k || 1, b = (n) => box.querySelector(`[data-mmz="${n}"]`);
    const L = v.scrollLeft > 1, T = v.scrollTop > 1, R = v.scrollLeft < v.scrollWidth - v.clientWidth - 1, D = v.scrollTop < v.scrollHeight - v.clientHeight - 1;
    b('out').disabled = k <= 1;
    b('fit').disabled = k <= 1;
    b('in').disabled = k >= MMZ_MAX;
    b('l').disabled = !L;
    b('u').disabled = !T;
    b('r').disabled = !R;
    b('d').disabled = !D;
  }

  const MM_DIR = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };
  function mmMove(box, d, frac, smooth) {
    const v = box.querySelector('.mm-view');
    if (!v) return;
    const [x, y] = MM_DIR[d];
    v.scrollBy({ left: x * v.clientWidth * frac, top: y * v.clientHeight * frac, behavior: smooth ? 'smooth' : 'auto' });
  }

  const mmHold = { t: 0, iv: 0, done: false };
  function mmHoldEnd() { clearTimeout(mmHold.t); clearInterval(mmHold.iv); mmHold.t = mmHold.iv = 0; }

  function mmAct(btn) {
    const box = btn.closest('.mermaid-box,.rimgbox'), a = btn.dataset.mmz;
    if (!box) return;
    if (a === 'tog') {
      const on = box.classList.toggle('mmz-on'), what = box.classList.contains('rimgbox') ? 'image' : 'diagram';
      btn.setAttribute('aria-expanded', on);
      btn.innerHTML = ic(on ? 'x' : 'zoom');
      btn.title = on ? `Done: back to the whole ${what}` : `Zoom into this ${what}`;
      if (!on) mmZoom(box, 1);
      else mmState(box);
      return;
    }
    if (a === 'in' || a === 'out') { mmZoom(box, (+box.dataset.k || 1) * (a === 'in' ? MMZ_STEP : 1 / MMZ_STEP)); return; }
    if (a === 'fit') { mmZoom(box, 1); return; }
    if (MM_DIR[a]) {
      if (mmHold.done) { mmHold.done = false; return; }
      mmMove(box, a, 0.5, true);
    }
  }

  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.mm-bar [data-mmz]');
    if (!b || !MM_DIR[b.dataset.mmz] || b.disabled) return;
    const box = b.closest('.mermaid-box,.rimgbox'), d = b.dataset.mmz;
    mmHoldEnd();
    mmHold.done = false;
    mmHold.t = setTimeout(() => {
      mmHold.done = true;
      mmHold.iv = setInterval(() => { if (b.disabled) return mmHoldEnd(); mmMove(box, d, 0.04, false); }, 30);
    }, 350);
  });
  ['pointerup', 'pointercancel', 'blur'].forEach((t) => addEventListener(t, mmHoldEnd, true));
  document.addEventListener('pointerdown', (e) => {
    const v = e.target.closest && e.target.closest('.mermaid-box[data-k] .mm-view,.rimgbox[data-k] .mm-view');
    if (!v || e.button > 0) return;
    e.preventDefault();
    v.classList.add('mm-drag');
    let x = e.clientX, y = e.clientY;
    try { v.setPointerCapture(e.pointerId); } catch (_) {}
    const z = v.getBoundingClientRect().width / v.clientWidth || 1;
    const mv = (ev) => { v.scrollLeft -= (ev.clientX - x) / z; v.scrollTop -= (ev.clientY - y) / z; x = ev.clientX; y = ev.clientY; };
    const up = () => { v.classList.remove('mm-drag'); v.removeEventListener('pointermove', mv); v.removeEventListener('pointerup', up); v.removeEventListener('pointercancel', up); };
    v.addEventListener('pointermove', mv);
    v.addEventListener('pointerup', up);
    v.addEventListener('pointercancel', up);
  });
  document.addEventListener('pointerleave', (e) => { if (e.target.closest && e.target.closest('.mm-bar [data-mmz]')) mmHoldEnd(); }, true);
  document.addEventListener('scroll', (e) => { const v = e.target; if (v.classList && v.classList.contains('mm-view')) mmState(v.closest('.mermaid-box,.rimgbox')); }, true);

  return {
    purifyNoRemote,
    renderRich,
    renderMermaid,
    loadMath,
    loadMermaid,
    mermaidTheme,
    mermaidSrc,
    isMermaidOk: () => mermaidOk,
    mmAct,
  };
}
