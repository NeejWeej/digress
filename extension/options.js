const { DEFAULT_SETTINGS, normalizeDigressUrl } = window.DigressRules;

const urlEl = document.getElementById('digressUrl');
const bodyEl = document.getElementById('rulesBody');
const fbMode = document.getElementById('fbMode');
const fbConv = document.getElementById('fbConv');
const fbFocus = document.getElementById('fbFocus');
const statusEl = document.getElementById('status');

function rowEl(r = { pattern: '', mode: 'branch', convTitle: '', focus: true }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="pat" placeholder="x.com"></td>
    <td><select class="mode"><option value="branch">Branch in conv</option><option value="doc">New document</option></select></td>
    <td><input type="text" class="conv" placeholder="Twitter clippings"></td>
    <td style="text-align:center"><input type="checkbox" class="foc"></td>
    <td><button type="button" class="sec del" title="Remove">✕</button></td>`;
  tr.querySelector('.pat').value = r.pattern || '';
  tr.querySelector('.mode').value = r.mode === 'doc' ? 'doc' : 'branch';
  tr.querySelector('.conv').value = r.convTitle || '';
  tr.querySelector('.foc').checked = r.focus !== false;
  const syncConv = () => { tr.querySelector('.conv').disabled = tr.querySelector('.mode').value === 'doc'; };
  tr.querySelector('.mode').addEventListener('change', syncConv);
  syncConv();
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
  return tr;
}

function render(cfg) {
  urlEl.value = cfg.digressUrl || DEFAULT_SETTINGS.digressUrl;
  bodyEl.innerHTML = '';
  for (const r of cfg.rules || []) bodyEl.appendChild(rowEl(r));
  const fb = cfg.fallback || DEFAULT_SETTINGS.fallback;
  fbMode.value = fb.mode === 'branch' ? 'branch' : 'doc';
  fbConv.value = fb.convTitle || '';
  fbFocus.checked = fb.focus !== false;
  fbConv.disabled = fbMode.value === 'doc';
}
fbMode.addEventListener('change', () => { fbConv.disabled = fbMode.value === 'doc'; });

document.getElementById('addRule').addEventListener('click', () => bodyEl.appendChild(rowEl()));

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
  // If the user configured a custom domain outside localhost / *.ts.net, ask for host permission so bridge.js can deliver clips
  try {
    const origin = new URL(digressUrl).origin + '/*';
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|[^/]+\.ts\.net)(:\d+)?\//i.test(origin)) {
      await chrome.permissions.request({ origins: [origin] }).catch(() => {});
    }
  } catch (_) {}
  await chrome.storage.local.set({ digressUrl, rules, fallback });
  statusEl.textContent = 'Saved.';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

document.getElementById('reset').addEventListener('click', async () => {
  render(DEFAULT_SETTINGS);
  await chrome.storage.local.set(DEFAULT_SETTINGS);
  statusEl.textContent = 'Defaults restored.';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
});

(async () => {
  const saved = await chrome.storage.local.get(['digressUrl', 'rules', 'fallback']);
  render({
    digressUrl: saved.digressUrl || DEFAULT_SETTINGS.digressUrl,
    rules: Array.isArray(saved.rules) ? saved.rules : DEFAULT_SETTINGS.rules,
    fallback: saved.fallback || DEFAULT_SETTINGS.fallback,
  });
})();
