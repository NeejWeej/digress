// Runs on x.com / twitter.com:
//  1. Remembers the last right-clicked tweet so context-menu "Send to Digress" grabs that exact tweet from the feed.
//  2. Supports clipping either a single tweet or the thread up to that tweet.
//  3. Injects a subtle 1-click Digress button into each tweet's action bar (Shift+Click opens Digress immediately).
(() => {
  let lastTweet = null;

  document.addEventListener('contextmenu', (e) => {
    const art = e.target && e.target.closest && e.target.closest('article[data-testid="tweet"]');
    if (art) lastTweet = art;
  }, true);

  async function imgToDataUrl(src) {
    try {
      const r = await fetch(src, { mode: 'cors', credentials: 'omit' });
      if (!r.ok) return null;
      const b = await r.blob();
      if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(b.type)) return null;
      return await new Promise((ok, no) => {
        const fr = new FileReader();
        fr.onload = () => ok({ data: String(fr.result), type: b.type });
        fr.onerror = () => no(fr.error);
        fr.readAsDataURL(b);
      });
    } catch (_) {
      return null;
    }
  }

  function parseUserHeader(el) {
    const raw = el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
    const m = raw.match(/@[A-Za-z0-9_]+/);
    const handle = m ? m[0] : '';
    const author = handle ? raw.split(handle)[0].trim() : raw;
    return { author, handle };
  }

  function tweetUrlOf(art) {
    const timeEl = art.querySelector('time');
    const linkEl = timeEl ? timeEl.closest('a') : null;
    if (linkEl && linkEl.href) return linkEl.href;
    const statusLink = art.querySelector('a[href*="/status/"]');
    return (statusLink && statusLink.href) || location.href;
  }

  function parseTweetNode(art) {
    const userEls = [...art.querySelectorAll('[data-testid="User-Name"]')];
    const mainUser = parseUserHeader(userEls[0]);
    const quotedUser = userEls[1] ? parseUserHeader(userEls[1]) : { author: '', handle: '' };
    const url = tweetUrlOf(art);
    const textEls = [...art.querySelectorAll('[data-testid="tweetText"]')];
    const mainText = textEls[0] ? textEls[0].innerText.trim() : '';
    const quotedText = textEls[1] ? textEls[1].innerText.trim() : '';
    const imgSrcs = [...art.querySelectorAll('img[src*="pbs.twimg.com/media"]')].map((im) => im.src).filter(Boolean);
    return {
      author: mainUser.author,
      handle: mainUser.handle,
      url,
      mainText,
      quotedAuthor: quotedUser.author,
      quotedHandle: quotedUser.handle,
      quotedText,
      imgSrcs,
    };
  }

  function formatTweetPart(info, sel) {
    const parts = [];
    if (info.author || info.handle) {
      parts.push(`**${info.author || info.handle}**${info.author && info.handle ? ` (${info.handle})` : ''}`);
    }
    if (info.mainText) parts.push(info.mainText);
    if (info.quotedText) {
      const qHead = (info.quotedAuthor || info.quotedHandle)
        ? `**${info.quotedAuthor || info.quotedHandle}**${info.quotedAuthor && info.quotedHandle ? ` (${info.quotedHandle})` : ''}: `
        : '';
      parts.push('> ' + (qHead + info.quotedText).replace(/\n+/g, '\n> '));
    }
    if (sel && (!info.mainText || !info.mainText.includes(sel))) {
      parts.push(`Highlighted: “${sel}”`);
    }
    return parts.join('\n\n') || '(empty post)';
  }

  // Detects X's 2px vertical thread-connector bar linking a tweet cell down to the next cell.
  function hasDownConnector(art) {
    if (!art) return false;
    const avatar = art.querySelector('[data-testid="Tweet-User-Avatar"]');
    const col = avatar ? avatar.parentElement : null;
    if (!col) return false;
    for (const el of col.querySelectorAll('div')) {
      const r = el.getBoundingClientRect();
      if (r.width >= 1.5 && r.width <= 3 && r.height >= 12) return true;
    }
    return false;
  }

  function statusPathMatch(url) {
    try {
      const u = new URL(url);
      return u.pathname.replace(/\/+$/, '').toLowerCase() === location.pathname.replace(/\/+$/, '').toLowerCase();
    } catch (_) {
      return false;
    }
  }

  function collectThreadArticles(targetArt) {
    const col = targetArt.closest('[data-testid="primaryColumn"]') || document;
    const all = [...col.querySelectorAll('article[data-testid="tweet"]')];
    const idx = all.indexOf(targetArt);
    if (idx <= 0) return [targetArt];

    const onStatusPage = /\/status\/\d+/.test(location.pathname);
    if (onStatusPage) {
      const focalIdx = all.findIndex((a) => statusPathMatch(tweetUrlOf(a)));
      // Target is the focal tweet or one of its ancestors: every preceding tweet in the column is part of the thread.
      if (focalIdx < 0 || idx <= focalIdx) {
        return all.slice(0, idx + 1);
      }
      // Target is a reply below the focal tweet: include ancestors up through focal, plus any directly connected replies leading to target.
      const ancestors = all.slice(0, focalIdx + 1);
      const chain = [targetArt];
      for (let i = idx - 1; i > focalIdx; i--) {
        if (hasDownConnector(all[i])) chain.unshift(all[i]);
        else break;
      }
      return [...ancestors, ...chain];
    }

    // Feed / profile page: walk backwards while each preceding tweet has a vertical thread connector line.
    const chain = [targetArt];
    for (let i = idx - 1; i >= 0; i--) {
      if (hasDownConnector(all[i])) chain.unshift(all[i]);
      else break;
    }
    return chain;
  }

  async function extractTweet(art, opts) {
    const includeThread = !!(opts && opts.includeThread);
    if (!art) art = lastTweet || document.querySelector('article[data-testid="tweet"]');
    const sel = String(window.getSelection() || '').trim();
    if (!art) {
      return { title: document.title, url: location.href, text: sel || document.body.innerText.slice(0, 4000), images: [], tweetCount: 0 };
    }

    const arts = includeThread ? collectThreadArticles(art) : [art];
    // Deduplicate by permalink while preserving chronological order
    const seen = new Set();
    const parsed = [];
    for (const a of arts) {
      const info = parseTweetNode(a);
      const key = info.url + '|' + info.mainText.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(info);
    }

    const targetInfo = parsed[parsed.length - 1] || parseTweetNode(art);
    const blocks = parsed.map((info, i) => formatTweetPart(info, i === parsed.length - 1 ? sel : ''));
    const text = blocks.join('\n\n---\n\n') || sel || '(empty post)';

    // Prioritize images from the clicked tweet first, then earlier tweets in the thread, up to 4 total.
    const orderedSrcs = [
      ...targetInfo.imgSrcs,
      ...parsed.slice(0, -1).flatMap((p) => p.imgSrcs),
    ];
    const uniqueSrcs = [...new Set(orderedSrcs)].slice(0, 4);
    const images = (await Promise.all(uniqueSrcs.map((src) => imgToDataUrl(src)))).filter(Boolean);

    const who = targetInfo.handle || targetInfo.author || 'Post';
    const title = parsed.length > 1 ? `${who} thread (${parsed.length} tweets)` : `${who} on X`;
    return { title, url: targetInfo.url, text, images, tweetCount: parsed.length };
  }

  // Subtle 1-click Digress button in each tweet's action bar
  const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v18"/><path d="M6 9c4 0 5-4 10-4h2"/><circle cx="19" cy="5" r="2"/><path d="M6 15c4 0 5 4 10 4h2"/><circle cx="19" cy="19" r="2"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function addButtons() {
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const bar = art.querySelector('[role="group"]:last-of-type');
      if (!bar || bar.querySelector('.digress-clip-btn')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'digress-clip-btn';
      btn.title = 'Send to Digress (Shift+Click to open Digress)';
      btn.setAttribute('aria-label', 'Send to Digress');
      btn.style.cssText = 'background:none;border:0;color:rgb(113,118,123);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border-radius:999px;transition:color .15s,background .15s;';
      btn.innerHTML = ICON;
      btn.addEventListener('mouseenter', () => { btn.style.color = '#d97706'; btn.style.background = 'rgba(217,119,6,0.12)'; });
      btn.addEventListener('mouseleave', () => { btn.style.color = 'rgb(113,118,123)'; btn.style.background = 'none'; });
      btn.addEventListener('click', async (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        btn.style.opacity = '0.5';
        try {
          const saved = await chrome.storage.local.get(['xThreadMode']).catch(() => ({}));
          const includeThread = saved && saved.xThreadMode === 'thread';
          const payload = await extractTweet(art, { includeThread });
          const res = await chrome.runtime.sendMessage({
            type: 'clipFromPage',
            payload,
            forceFocus: !!e.shiftKey,
          });
          if (res && res.ok) {
            btn.innerHTML = CHECK;
            btn.style.color = '#16a34a';
            setTimeout(() => { btn.innerHTML = ICON; btn.style.color = 'rgb(113,118,123)'; }, 1800);
          } else {
            btn.title = (res && res.error) || 'Could not reach Digress';
            btn.style.color = '#dc2626';
          }
        } catch (_) {
          btn.style.color = '#dc2626';
        } finally {
          btn.disabled = false;
          btn.style.opacity = '1';
        }
      });
      bar.appendChild(btn);
    }
  }

  addButtons();
  let obsTimer = 0;
  new MutationObserver(() => {
    if (obsTimer) return;
    obsTimer = setTimeout(() => { obsTimer = 0; addButtons(); }, 250);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'extractTweet') {
      extractTweet(null, { includeThread: !!msg.includeThread })
        .then((payload) => sendResponse({ ok: true, payload }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  });
})();
