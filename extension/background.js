importScripts('rules.js');

const { DEFAULT_SETTINGS, normalizeDigressUrl, matchRule } = self.DigressRules;

async function getSettings() {
  const saved = await chrome.storage.local.get(['digressUrl', 'rules', 'fallback']);
  return {
    digressUrl: normalizeDigressUrl(saved.digressUrl || DEFAULT_SETTINGS.digressUrl),
    rules: Array.isArray(saved.rules) ? saved.rules : DEFAULT_SETTINGS.rules,
    fallback: saved.fallback || DEFAULT_SETTINGS.fallback,
  };
}

function isXUrl(url) {
  return /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(String(url || ''));
}

async function extractFromTab(tab) {
  if (isXUrl(tab.url)) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'extractTweet' });
      if (r && r.ok && r.payload) return r.payload;
    } catch (_) { /* fall through to generic extractor */ }
  }
  const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js'] });
  return (res && res[0] && res[0].result) || { title: tab.title || '', url: tab.url || '', text: '' };
}

function waitTabReady(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); setTimeout(resolve, 400); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, 12000);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId, (tb) => { if (tb && tb.status === 'complete') done(); });
  });
}

async function ensureDigressTab(digressUrl, focus) {
  const origin = new URL(digressUrl).origin;
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((t) => t.url && t.url.startsWith(origin));
  if (!tab) {
    tab = await chrome.tabs.create({ url: digressUrl, active: !!focus });
    await waitTabReady(tab.id);
  } else if (focus) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return tab;
}

async function deliverToDigress(payload, overrideRule) {
  const cfg = await getSettings();
  const rule = overrideRule || matchRule(payload.url || '', cfg);
  const full = {
    ...payload,
    mode: rule.mode,
    convTitle: rule.convTitle || 'Clippings',
  };
  const tab = await ensureDigressTab(cfg.digressUrl, rule.focus);
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'deliverClip', payload: full });
  } catch (_) {
    // bridge.js wasn't injected yet (e.g. custom host or fresh install): inject once and retry
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] });
    res = await chrome.tabs.sendMessage(tab.id, { type: 'deliverClip', payload: full });
  }
  flashBadge(res && res.ok);
  return res || { ok: false, error: 'No response from Digress' };
}

function flashBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'digress-send', title: 'Send to Digress', contexts: ['page', 'selection', 'link'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'digress-send' || !tab || !tab.id) return;
  try {
    const payload = await extractFromTab(tab);
    await deliverToDigress(payload);
  } catch (e) {
    console.warn('Digress clip failed:', e);
    flashBadge(false);
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'clip-now') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    const payload = await extractFromTab(tab);
    await deliverToDigress(payload);
  } catch (e) {
    console.warn('Digress clip failed:', e);
    flashBadge(false);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'clipFromPage') {
    deliverToDigress(msg.payload).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'clipActiveTab') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return { ok: false, error: 'No active tab' };
      const payload = await extractFromTab(tab);
      return await deliverToDigress(payload, msg.rule);
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
