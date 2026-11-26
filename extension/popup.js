const { DEFAULT_SETTINGS, normalizeDigressUrl, matchRule } = window.DigressRules;

const modeEl = document.getElementById('mode');
const convWrap = document.getElementById('convWrap');
const convEl = document.getElementById('convTitle');
const focusEl = document.getElementById('focus');
const metaEl = document.getElementById('meta');
const msgEl = document.getElementById('msg');
const sendBtn = document.getElementById('send');

function syncVis() {
  convWrap.style.display = modeEl.value === 'branch' ? 'block' : 'none';
}
modeEl.addEventListener('change', syncVis);

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = await chrome.storage.local.get(['digressUrl', 'rules', 'fallback']);
  const cfg = {
    digressUrl: normalizeDigressUrl(saved.digressUrl || DEFAULT_SETTINGS.digressUrl),
    rules: Array.isArray(saved.rules) ? saved.rules : DEFAULT_SETTINGS.rules,
    fallback: saved.fallback || DEFAULT_SETTINGS.fallback,
  };
  const rule = matchRule((tab && tab.url) || '', cfg);
  modeEl.value = rule.mode;
  convEl.value = rule.convTitle || 'Clippings';
  focusEl.checked = !!rule.focus;
  syncVis();
  metaEl.textContent = `Target: ${cfg.digressUrl} · rule: ${rule.pattern}`;
})();

sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  msgEl.className = 'msg';
  msgEl.textContent = 'Sending…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'clipActiveTab',
      rule: {
        mode: modeEl.value,
        convTitle: convEl.value.trim() || 'Clippings',
        focus: focusEl.checked,
      },
    });
    if (res && res.ok) {
      msgEl.className = 'msg ok';
      msgEl.textContent = 'Sent to Digress.';
      setTimeout(() => window.close(), 700);
    } else {
      msgEl.className = 'msg err';
      msgEl.textContent = (res && res.error) || 'Could not reach Digress.';
    }
  } catch (e) {
    msgEl.className = 'msg err';
    msgEl.textContent = String(e && e.message || e);
  } finally {
    sendBtn.disabled = false;
  }
});
