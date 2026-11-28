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
  // with several Digress tabs or windows open, the one you used last (not whichever Chrome lists first)
  const tabs = (await chrome.tabs.query({})).filter((t) => matchesDigressUrl(t.url, digressUrl));
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));   // lastAccessed: Chrome 121+; older keeps the listed order
  return tabs[0] || null;
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
  if (rule.useCurrentThread) full.useCurrentThread = true;
  if (rule.targetThreadId) full.targetThreadId = rule.targetThreadId;
  if (rule.branchTitle) full.branchTitle = rule.branchTitle;
  if (rule.question) full.question = rule.question;

  let res;
  try {
    // the current thread is in a Digress tab you have open: without one there's nothing to add to (don't open one and guess)
    const tab = rule.needTab ? await findDigressTab(cfg.digressUrl) : await ensureDigressTab(cfg.digressUrl, focus);
    if (!tab) throw new Error('Open Digress first: there’s no current thread to add to.');
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
      ? (full.useCurrentThread ? `Added to “${(res && res.branchTitle) || 'the thread'}” · ${dest}${countNote}. Not sent yet: it’s in the message box.` : `Clipped to ${dest}${countNote}`)
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

/* The right-click menu: two choices, each made by the item you click, never a hidden default.
   What: on a threaded site (only X for now: THREAD_SITE) just the post you clicked, or the thread up to it.
   Where: your site rule (the first two items), or one of DESTS.
   On the threaded site, the rule's two items come first, and each destination is a submenu with the two scopes.
   Elsewhere there's no post to pick, so "Send selection or page" and the destinations are plain items.
   Chrome can show an item only on some pages (documentUrlPatterns) but not "everywhere but", so the plain items'
   visibility follows the active tab (syncSendItem). onThreadSite must match exactly the pages THREAD_SITE.patterns
   do, or a page could be left with no way to send. Another threaded site would be another THREAD_SITE (patterns,
   labels, its extractor in extractFromTab), not a new menu. */
const THREAD_SITE = {
  patterns: ['https://x.com/*', 'https://twitter.com/*'],
  single: 'Send just this tweet', thread: 'Send thread up to here',
  subSingle: 'Just this tweet', subThread: 'Thread up to here',
};
const X_PATTERNS = THREAD_SITE.patterns;
const onTweetMenuPage = (url) => /^https:\/\/(?:x|twitter)\.com\//i.test(String(url || ''));
// focus: whether Digress comes to the front. needTab: an open Digress tab is required (never open one to guess).
const DESTS = [
  { key: 'thread', title: 'Add to current thread', rule: { mode: 'branch', useCurrentConv: true, useCurrentThread: true, focus: false, needTab: true } },
  { key: 'current', title: 'Branch in current conversation', rule: { mode: 'branch', useCurrentConv: true, focus: false } },
  { key: 'doc', title: 'New document conversation', rule: { mode: 'doc', focus: true } },
];
const PLAIN_IDS = ['digress-auto', ...DESTS.map((d) => 'digress-' + d.key)];   // shown only off the threaded site

async function syncSendItem() {
  let url = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    url = (tab && tab.url) || '';
  } catch (_) {}
  // shown when unsure (no tab, no url): at worst the X menu has the plain items too, never a page without them
  const visible = !onTweetMenuPage(url);
  for (const id of PLAIN_IDS) chrome.contextMenus.update(id, { visible }, () => void chrome.runtime.lastError);
}

function rebuildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'selection', 'link'], documentUrlPatterns = THREAD_SITE.patterns;
    const add = (o) => chrome.contextMenus.create({ parentId: 'digress-root', contexts, ...o });
    chrome.contextMenus.create({ id: 'digress-root', title: 'Send to Digress', contexts });
    add({ id: 'digress-x-single', title: THREAD_SITE.single, documentUrlPatterns });
    add({ id: 'digress-x-thread', title: THREAD_SITE.thread, documentUrlPatterns });
    add({ id: 'digress-auto', title: 'Send selection or page' });
    add({ id: 'digress-sep', type: 'separator' });
    for (const d of DESTS) {
      add({ id: `digress-${d.key}-x`, title: d.title, documentUrlPatterns });
      add({ id: `digress-${d.key}-x-single`, parentId: `digress-${d.key}-x`, title: THREAD_SITE.subSingle, documentUrlPatterns });
      add({ id: `digress-${d.key}-x-thread`, parentId: `digress-${d.key}-x`, title: THREAD_SITE.subThread, documentUrlPatterns });
      add({ id: `digress-${d.key}`, title: d.title });
    }
    syncSendItem();
  });
}

// what a menu item asks for: includeThread (true/false, or null for your default) and the destination's rule (null: site rule)
function menuChoice(id) {
  id = String(id);
  if (id === 'digress-x-single') return { includeThread: false, rule: null };
  if (id === 'digress-x-thread') return { includeThread: true, rule: null };
  if (id === 'digress-auto') return { includeThread: null, rule: null };
  for (const d of DESTS) {
    if (id === `digress-${d.key}`) return { includeThread: null, rule: d.rule };
    if (id === `digress-${d.key}-x-single`) return { includeThread: false, rule: d.rule };
    if (id === `digress-${d.key}-x-thread`) return { includeThread: true, rule: d.rule };
  }
  return null;
}

chrome.runtime.onInstalled.addListener(rebuildContextMenus);
chrome.runtime.onStartup.addListener(rebuildContextMenus);
chrome.tabs.onActivated.addListener(syncSendItem);
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.active && (change.url || change.status === 'complete')) syncSendItem(); });
chrome.windows.onFocusChanged.addListener((w) => { if (w !== chrome.windows.WINDOW_ID_NONE) syncSendItem(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const choice = menuChoice(info.menuItemId);
  if (!choice) return;
  const cfg = await getSettings();
  try {
    const includeThread = choice.includeThread == null ? cfg.xThreadMode === 'thread' : choice.includeThread;
    const payload = await extractFromTab(tab, { includeThread });
    await deliverToDigress(payload, choice.rule, tab.id);
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
