// Runs on x.com / twitter.com:
//  1. Remembers the last right-clicked tweet so context-menu "Send to Digress" grabs that exact tweet from the feed.
//  2. Injects a subtle 1-click Digress button into each tweet's action bar.
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

  async function extractTweet(art) {
    if (!art) art = lastTweet || document.querySelector('article[data-testid="tweet"]');
    const sel = String(window.getSelection() || '').trim();
    if (!art) {
      return { title: document.title, url: location.href, text: sel || document.body.innerText.slice(0, 4000), images: [] };
    }
    const nameEl = art.querySelector('[data-testid="User-Name"]');
    const nameText = nameEl ? nameEl.innerText.replace(/\s+/g, ' ').trim() : '';
    const handleMatch = nameText.match(/@[A-Za-z0-9_]+/);
    const handle = handleMatch ? handleMatch[0] : '';
    const author = handle ? nameText.split(handle)[0].trim() : nameText;

    const timeEl = art.querySelector('time');
    const linkEl = timeEl ? timeEl.closest('a') : null;
    const url = linkEl && linkEl.href ? linkEl.href : location.href;

    const textEls = [...art.querySelectorAll('[data-testid="tweetText"]')];
    const mainText = textEls[0] ? textEls[0].innerText.trim() : '';
    const quotedText = textEls[1] ? textEls[1].innerText.trim() : '';

    const parts = [];
    if (author || handle) parts.push(`**${author || handle}**${author && handle ? ` (${handle})` : ''}`);
    if (mainText) parts.push(mainText);
    if (quotedText) parts.push('> ' + quotedText.replace(/\n+/g, '\n> '));
    if (sel && (!mainText || !mainText.includes(sel))) parts.push(`Highlighted: “${sel}”`);

    const imgEls = [...art.querySelectorAll('img[src*="pbs.twimg.com/media"]')].slice(0, 4);
    const images = (await Promise.all(imgEls.map((im) => imgToDataUrl(im.src)))).filter(Boolean);

    const title = handle ? `${handle} on X` : (author ? `${author} on X` : 'Post on X');
    return { title, url, text: parts.join('\n\n') || sel || '(empty post)', images };
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
      btn.title = 'Send to Digress';
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
          const payload = await extractTweet(art);
          const res = await chrome.runtime.sendMessage({ type: 'clipFromPage', payload });
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
    if (!msg || msg.type !== 'extractTweet') return;
    extractTweet(null).then((payload) => sendResponse({ ok: true, payload }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });
})();
