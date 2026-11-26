const { DEFAULT_SETTINGS, normalizeDigressUrl, mergeSettings } = window.DigressRules;

const urlEl = document.getElementById('digressUrl');
const detectBtn = document.getElementById('detect');
const testBtn = document.getElementById('testConn');
const connStatus = document.getElementById('connStatus');
const xThreadEl = document.getElementById('xThreadMode');
const showToastEl = document.getElementById('showToast');
const bodyEl = document.getElementById('rulesBody');
const fbMode = document.getElementById('fbMode');
const fbConv = document.getElementById('fbConv');
const fbFocus = document.getElementById('fbFocus');
const statusEl = document.getElementById('status');
const convSuggestions = document.getElementById('convSuggestions');

function rowEl(r = { pattern: '', mode: 'branch', convTitle: '', focus: true }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="pat" placeholder="x.com"></td>
    <td><select class="mode"><option value="branch">Branch in conv</option><option value="doc">New document</option></select></td>
    <td><input type="text" class="conv" list="convSuggestions" placeholder="Twitter clippings"></td>
    <td style="text-align:center"><input type="checkbox" class="foc"></td>
    <td>
      <div class="act-cell">
        <button type="button" class="icon-btn up" title="Move up">↑</button>
        <button type="button" class="icon-btn dn" title="Move down">↓</button>
        <button type="button" class="icon-btn del" title="Remove">✕</button>
      </div>
    </td>`;
  tr.querySelector('.pat').value = r.pattern || '';
  tr.querySelector('.mode').value = r.mode === 'doc' ? 'doc' : 'branch';
  tr.querySelector('.conv').value = r.convTitle || '';
  tr.querySelector('.foc').checked = r.focus !== false;
  const syncConv = () => { tr.querySelector('.conv').disabled = tr.querySelector('.mode').value === 'doc'; };
  tr.querySelector('.mode').addEventListener('change', syncConv);
  syncConv();
  tr.querySelector('.up').addEventListener('click', () => {
    if (tr.previousElementSibling) bodyEl.insertBefore(tr, tr.previousElementSibling);
  });
  tr.querySelector('.dn').addEventListener('click', () => {
    if (tr.nextElementSibling) bodyEl.insertBefore(tr.nextElementSibling, tr);
  });
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
  return tr;
}

function render(cfg) {
  urlEl.value = cfg.digressUrl;
  xThreadEl.value = cfg.xThreadMode;
  showToastEl.checked = cfg.showToast;
  bodyEl.innerHTML = '';
  for (const r of cfg.rules) bodyEl.appendChild(rowEl(r));
  fbMode.value = cfg.fallback.mode === 'branch' ? 'branch' : 'doc';
  fbConv.value = cfg.fallback.convTitle || '';
  fbFocus.checked = cfg.fallback.focus !== false;
  fbConv.disabled = fbMode.value === 'doc';
}

fbMode.addEventListener('change', () => { fbConv.disabled = fbMode.value === 'doc'; });
document.getElementById('addRule').addEventListener('click', () => bodyEl.appendChild(rowEl()));

async function refreshSuggestions(digressUrl) {
  const res = await chrome.runtime.sendMessage({ type: 'queryDigress', digressUrl }).catch(() => null);
  convSuggestions.innerHTML = '';
  if (res && res.ok && Array.isArray(res.conversations)) {
    for (const c of res.conversations) {
      const opt = document.createElement('option');
      opt.value = c.title;
      convSuggestions.appendChild(opt);
    }
    return res;
  }
  return null;
}

detectBtn.addEventListener('click', async () => {
  connStatus.className = 'status';
  connStatus.textContent = 'Scanning open tabs…';
  const res = await chrome.runtime.sendMessage({ type: 'detectDigressTab' }).catch(() => null);
  if (res && res.ok && res.url) {
    urlEl.value = res.url;
    connStatus.textContent = `Found Digress at ${res.url}`;
    refreshSuggestions(res.url);
  } else {
    connStatus.className = 'status err';
    connStatus.textContent = (res && res.error) || 'No open Digress tab found.';
  }
});

testBtn.addEventListener('click', async () => {
  const url = normalizeDigressUrl(urlEl.value);
  urlEl.value = url;
  connStatus.className = 'status';
  connStatus.textContent = 'Testing…';
  const res = await refreshSuggestions(url);
  if (res && res.ok) {
    const n = (res.conversations || []).length;
    connStatus.textContent = `Connected (${n} conversation${n === 1 ? '' : 's'} found).`;
  } else {
    connStatus.className = 'status err';
    connStatus.textContent = 'No open Digress tab at this URL.';
  }
});

document.getElementById('save').addEventListener('click', async () => {
  const digressUrl = normalizeDigressUrl(urlEl.value);
  urlEl.value = digressUrl;
  const rules = [...bodyEl.querySelectorAll('tr')].map((tr) => ({
    pattern: tr.querySelector('.pat').value.trim(),
    mode: tr.querySelector('.mode').value,
    convTitle: tr.querySelector('.conv').value.trim(),
    focus: tr.querySelector('.foc').checked,
  })).filter((r) => r.pattern);
  const fallback = { mode: fbMode.value, convTitle: fbConv.value.trim(), focus: fbFocus.checked };
  const xThreadMode = xThreadEl.value === 'thread' ? 'thread' : 'single';
  const showToast = showToastEl.checked;
  try {
    const origin = new URL(digressUrl).origin + '/*';
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|[^/]+\.ts\.net)(:\d+)?\//i.test(origin)) {
      await chrome.permissions.request({ origins: [origin] }).catch(() => {});
    }
  } catch (_) {}
  await chrome.storage.local.set({ digressUrl, rules, fallback, xThreadMode, showToast });
  statusEl.className = 'status';
  statusEl.textContent = 'Saved.';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

document.getElementById('reset').addEventListener('click', async () => {
  const cfg = mergeSettings(DEFAULT_SETTINGS);
  render(cfg);
  await chrome.storage.local.set(cfg);
  statusEl.className = 'status';
  statusEl.textContent = 'Defaults restored.';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

(async () => {
  const saved = await chrome.storage.local.get(['digressUrl', 'rules', 'fallback', 'xThreadMode', 'showToast']);
  const cfg = mergeSettings(saved);
  render(cfg);
  refreshSuggestions(cfg.digressUrl);
})();
