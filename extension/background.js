importScripts('rules.js');

const { mergeSettings, matchRule } = self.DigressRules;

async function getSettings() {
  const saved = await chrome.storage.local.get(['digressUrl', 'rules', 'fallback', 'xThreadMode', 'showToast']);
  return mergeSettings(saved);
}

function isXUrl(url) {
  return /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(String(url || ''));
}

async function extractFromTab(tab, opts) {
  const includeThread = !!(opts && opts.includeThread);
  if (isXUrl(tab.url)) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'extractTweet', includeThread });
      if (r && r.ok && r.payload) return r.payload;
    } catch (_) { /* fall through to generic extractor */ }
  }
  const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js'] });
  return (res && res[0] && res[0].result) || { title: tab.title || '', url: tab.url || '', text: '' };
}

function waitTabReady(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); setTimeout(resolve, 450); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, 12000);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId, (tb) => { if (tb && tb.status === 'complete') done(); });
  });
}

function matchesDigressUrl(tabUrl, digressUrl) {
  if (!tabUrl || !digressUrl) return false;
  let target, actual;
  try { target = new URL(digressUrl); actual = new URL(tabUrl); } catch (_) { return false; }
  if (actual.origin !== target.origin) return false;
  const basePath = target.pathname.replace(/\/+$/, '');
  if (!basePath) return true;
  return actual.pathname === basePath || actual.pathname.startsWith(basePath + '/');
}

async function findDigressTab(digressUrl) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => matchesDigressUrl(t.url, digressUrl)) || null;
}

async function ensureDigressTab(digressUrl, focus) {
  let tab = await findDigressTab(digressUrl);
  if (!tab) {
    tab = await chrome.tabs.create({ url: digressUrl, active: !!focus });
    await waitTabReady(tab.id);
  } else if (focus) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return tab;
}

async function sendToDigressTab(tabId, msg, expectedDigressUrl) {
  if (expectedDigressUrl) {
    const cur = await chrome.tabs.get(tabId);
    if (!cur || !matchesDigressUrl(cur.url, expectedDigressUrl)) {
      throw new Error('Digress tab navigated away.');
    }
  }
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    if (expectedDigressUrl) {
      const cur = await chrome.tabs.get(tabId);
      if (!cur || !matchesDigressUrl(cur.url, expectedDigressUrl)) {
        throw new Error('Digress tab navigated away.');
      }
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['bridge.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// Injected into the source tab on demand (isolated world, Shadow DOM so page styles never interfere).
function showInPageToast(opts) {
  const HOST_ID = 'digress-clipper-toast-host';
  const prev = document.getElementById(HOST_ID);
  if (prev) prev.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });

  const isErr = !opts.ok;
  const style = document.createElement('style');
  style.textContent = `
    .toast {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      max-width: 360px;
      padding: 10px 13px;
      border-radius: 10px;
      font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      color: #f3f4f6;
      background: ${isErr ? '#7f1d1d' : '#18181b'};
      border: 1px solid ${isErr ? '#dc2626' : 'rgba(255,255,255,0.12)'};
      box-shadow: 0 10px 28px rgba(0,0,0,0.32);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .18s ease, transform .18s ease;
    }
    .toast.in { opacity: 1; transform: translateY(0); }
    .dot {
      width: 8px; height: 8px; border-radius: 999px; flex: 0 0 auto;
      background: ${isErr ? '#fca5a5' : '#22c55e'};
    }
    .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .open {
      flex: 0 0 auto;
      background: #d97706;
      color: #fff;
      border: 0;
      border-radius: 6px;
      padding: 4px 9px;
      font: 600 12px/1.2 system-ui, -apple-system, sans-serif;
      cursor: pointer;
    }
    .open:hover { background: #b45309; }
    .x {
      flex: 0 0 auto;
      background: none;
      border: 0;
      color: rgba(255,255,255,0.65);
      cursor: pointer;
      padding: 0 2px;
      font-size: 14px;
      line-height: 1;
    }
    .x:hover { color: #fff; }
  `;

  const box = document.createElement('div');
  box.className = 'toast';

  const dot = document.createElement('span');
  dot.className = 'dot';
  box.appendChild(dot);

  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = opts.text || (isErr ? 'Could not clip to Digress' : 'Clipped to Digress');
  box.appendChild(txt);

  if (opts.ok && opts.convId) {
    const openBtn = document.createElement('button');
    openBtn.className = 'open';
    openBtn.type = 'button';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'openDigressClip', convId: opts.convId, threadId: opts.threadId || '' });
      dismiss();
    });
    box.appendChild(openBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'x';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', dismiss);
  box.appendChild(closeBtn);

  shadow.appendChild(style);
  shadow.appendChild(box);
  (document.documentElement || document.body).appendChild(host);

  let timer = 0;
  function dismiss() {
    clearTimeout(timer);
    box.classList.remove('in');
    setTimeout(() => host.remove(), 200);
  }
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(dismiss, isErr ? 5000 : 3800);
  }
  box.addEventListener('mouseenter', () => clearTimeout(timer));
  box.addEventListener('mouseleave', arm);
  requestAnimationFrame(() => box.classList.add('in'));
  arm();
}

async function notifyTab(tabId, opts) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showInPageToast, args: [opts] });
  } catch (_) { /* restricted pages like chrome:// cannot show toasts */ }
}

async function deliverToDigress(payload, overrideRule, sourceTabId) {
  const cfg = await getSettings();
  const baseRule = matchRule(payload.url || '', cfg);
  const rule = overrideRule ? { ...baseRule, ...overrideRule } : baseRule;
  const focus = rule.focus !== false;
  const full = {
    ...payload,
    mode: rule.mode === 'branch' ? 'branch' : 'doc',
    convTitle: rule.convTitle || 'Clippings',
  };
  if (rule.convId) full.convId = rule.convId;
  if (rule.useCurrentConv) full.useCurrentConv = true;
  if (rule.targetThreadId) full.targetThreadId = rule.targetThreadId;
  if (rule.branchTitle) full.branchTitle = rule.branchTitle;
  if (rule.question) full.question = rule.question;

  let res;
  try {
    const tab = await ensureDigressTab(cfg.digressUrl, focus);
    res = await sendToDigressTab(tab.id, { type: 'deliverClip', payload: full }, cfg.digressUrl);
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e || 'Could not reach Digress') };
  }
  flashBadge(res && res.ok);

  if (cfg.showToast && sourceTabId && (!focus || !(res && res.ok))) {
    const ok = !!(res && res.ok);
    const countNote = payload.tweetCount > 1 ? ` (${payload.tweetCount} tweets)` : '';
    const dest = (res && res.convTitle) || full.convTitle || 'Digress';
    const text = ok
      ? `Clipped to ${dest}${countNote}`
      : ((res && res.error) || 'Could not reach Digress');
    notifyTab(sourceTabId, { ok, text, convId: res && res.convId, threadId: res && res.threadId });
  }
  return res || { ok: false, error: 'No response from Digress' };
}

function flashBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

function rebuildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'selection', 'link'];
    chrome.contextMenus.create({ id: 'digress-root', title: 'Send to Digress', contexts });
    chrome.contextMenus.create({ id: 'digress-auto', parentId: 'digress-root', title: 'Send using site rule', contexts });
    chrome.contextMenus.create({
      id: 'digress-x-thread',
      parentId: 'digress-root',
      title: 'Send thread up to here',
      contexts,
      documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*'],
    });
    chrome.contextMenus.create({
      id: 'digress-x-single',
      parentId: 'digress-root',
      title: 'Send just this tweet',
      contexts,
      documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*'],
    });
    chrome.contextMenus.create({ id: 'digress-sep', parentId: 'digress-root', type: 'separator', contexts });
    chrome.contextMenus.create({ id: 'digress-current', parentId: 'digress-root', title: 'Branch in current conversation', contexts });
    chrome.contextMenus.create({ id: 'digress-doc', parentId: 'digress-root', title: 'New document conversation', contexts });
  });
}

chrome.runtime.onInstalled.addListener(rebuildContextMenus);
chrome.runtime.onStartup.addListener(rebuildContextMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const id = info.menuItemId;
  if (!String(id).startsWith('digress-')) return;
  const cfg = await getSettings();
  try {
    let includeThread = cfg.xThreadMode === 'thread';
    let overrideRule = null;
    if (id === 'digress-x-thread') {
      includeThread = true;
    } else if (id === 'digress-x-single') {
      includeThread = false;
    } else if (id === 'digress-current') {
      overrideRule = { mode: 'branch', useCurrentConv: true, focus: false };
    } else if (id === 'digress-doc') {
      overrideRule = { mode: 'doc', focus: true };
    }
    const payload = await extractFromTab(tab, { includeThread });
    await deliverToDigress(payload, overrideRule, tab.id);
  } catch (e) {
    console.warn('Digress clip failed:', e);
    flashBadge(false);
    if (cfg.showToast) notifyTab(tab.id, { ok: false, text: String((e && e.message) || e) });
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'clip-now') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const cfg = await getSettings();
  try {
    const payload = await extractFromTab(tab, { includeThread: cfg.xThreadMode === 'thread' });
    await deliverToDigress(payload, null, tab.id);
  } catch (e) {
    console.warn('Digress clip failed:', e);
    flashBadge(false);
    if (cfg.showToast) notifyTab(tab.id, { ok: false, text: String((e && e.message) || e) });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'clipFromPage') {
    const sourceTabId = sender && sender.tab ? sender.tab.id : null;
    const override = msg.forceFocus ? { focus: true } : null;
    deliverToDigress(msg.payload, override, sourceTabId).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'clipActiveTab') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return { ok: false, error: 'No active tab' };
      const cfg = await getSettings();
      const includeThread = typeof msg.includeThread === 'boolean' ? msg.includeThread : cfg.xThreadMode === 'thread';
      const payload = await extractFromTab(tab, { includeThread });
      return await deliverToDigress(payload, msg.rule, tab.id);
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'queryDigress') {
    (async () => {
      const cfg = await getSettings();
      const url = msg.digressUrl || cfg.digressUrl;
      const tab = await findDigressTab(url);
      if (!tab) return { ok: false, connected: false, error: 'No Digress tab open' };
      const res = await sendToDigressTab(tab.id, { type: 'queryDigress', convId: msg.convId || '' }, url);
      return { connected: !!(res && res.ok), ...res };
    })().then(sendResponse, (e) => sendResponse({ ok: false, connected: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'detectDigressTab') {
    (async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id || !tab.url || !/^https?:\/\//i.test(tab.url)) continue;
        try {
          const res = await sendToDigressTab(tab.id, { type: 'queryDigress', convId: '' });
          if (res && res.ok) return { ok: true, url: new URL(tab.url).origin };
        } catch (_) { /* not a Digress tab or no permission */ }
      }
      return { ok: false, error: 'No open Digress tab found.' };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'openDigressClip') {
    (async () => {
      const cfg = await getSettings();
      const tab = await ensureDigressTab(cfg.digressUrl, true);
      if (msg.convId || msg.threadId) {
        await sendToDigressTab(tab.id, { type: 'focusClip', convId: msg.convId || '', threadId: msg.threadId || '' }, cfg.digressUrl).catch(() => {});
      }
      return { ok: true };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'getTabPreview') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return { ok: false };
      let sel = '';
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => String(window.getSelection() || '').trim().slice(0, 200),
        });
        sel = (res && res[0] && res[0].result) || '';
      } catch (_) {}
      return {
        ok: true,
        title: tab.title || '',
        url: tab.url || '',
        isX: isXUrl(tab.url),
        selection: sel,
      };
    })().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
});
