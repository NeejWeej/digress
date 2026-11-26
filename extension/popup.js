const { mergeSettings, matchRule } = window.DigressRules;

const connPill = document.getElementById('connPill');
const connTxt = document.getElementById('connTxt');
const previewKind = document.getElementById('previewKind');
const ruleBadge = document.getElementById('ruleBadge');
const previewTxt = document.getElementById('previewTxt');
const xSeg = document.getElementById('xSeg');
const modeSeg = document.getElementById('modeSeg');
const branchFields = document.getElementById('branchFields');
const convSelectWrap = document.getElementById('convSelectWrap');
const convSelect = document.getElementById('convSelect');
const newConvWrap = document.getElementById('newConvWrap');
const newConvTitle = document.getElementById('newConvTitle');
const branchSelectWrap = document.getElementById('branchSelectWrap');
const branchSelect = document.getElementById('branchSelect');
const branchTitleWrap = document.getElementById('branchTitleWrap');
const branchTitle = document.getElementById('branchTitle');
const questionEl = document.getElementById('question');
const focusEl = document.getElementById('focus');
const rememberWrap = document.getElementById('rememberWrap');
const rememberEl = document.getElementById('remember');
const rememberLbl = document.getElementById('rememberLbl');
const sendBtn = document.getElementById('send');
const msgEl = document.getElementById('msg');

let cfg = null;
let mode = 'branch';
let xMode = 'single';
let isX = false;
let tabHost = '';
let connected = false;
let digressInfo = null; // { currentConvId, currentConvTitle, conversations, branches }
const branchCache = new Map();

function setMode(m) {
  mode = m === 'doc' ? 'doc' : 'branch';
  for (const b of modeSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
  branchFields.classList.toggle('hidden', mode !== 'branch');
}

function setXMode(m) {
  xMode = m === 'thread' ? 'thread' : 'single';
  for (const b of xSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.xmode === xMode);
  }
}

for (const b of modeSeg.querySelectorAll('button')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
for (const b of xSeg.querySelectorAll('button')) {
  b.addEventListener('click', () => setXMode(b.dataset.xmode));
}

function populateBranches(branches) {
  branchSelect.innerHTML = '';
  const optNew = document.createElement('option');
  optNew.value = '__new__';
  optNew.textContent = '+ New clipped branch';
  branchSelect.appendChild(optNew);
  for (const br of branches || []) {
    const opt = document.createElement('option');
    opt.value = br.id;
    opt.textContent = br.id === 'main' ? 'Main thread' : br.title;
    branchSelect.appendChild(opt);
  }
  branchSelect.value = '__new__';
  syncBranchInputs();
}

function syncBranchInputs() {
  const isNewConv = !connected || convSelect.value === '__new__';
  newConvWrap.classList.toggle('hidden', !isNewConv);
  branchSelectWrap.classList.toggle('hidden', isNewConv);
  const isNewBranch = isNewConv || branchSelect.value === '__new__';
  branchTitleWrap.classList.toggle('hidden', !isNewBranch);
}

async function onConvChange() {
  syncBranchInputs();
  if (!connected) return;
  const val = convSelect.value;
  if (val === '__new__') {
    newConvTitle.focus();
    return;
  }
  const targetId = val === '__current__' ? (digressInfo && digressInfo.currentConvId) : val;
  if (!targetId) {
    populateBranches([]);
    return;
  }
  if (branchCache.has(targetId)) {
    populateBranches(branchCache.get(targetId));
    return;
  }
  branchSelect.innerHTML = '<option value="__new__">Loading branches…</option>';
  const res = await chrome.runtime.sendMessage({ type: 'queryDigress', convId: targetId }).catch(() => null);
  const list = (res && res.ok && Array.isArray(res.branches)) ? res.branches : [];
  branchCache.set(targetId, list);
  populateBranches(list);
}

convSelect.addEventListener('change', onConvChange);
branchSelect.addEventListener('change', syncBranchInputs);

function populateConversations(rule) {
  if (!connected || !digressInfo) {
    convSelectWrap.classList.add('hidden');
    newConvWrap.classList.remove('hidden');
    newConvTitle.value = rule.convTitle || 'Clippings';
    branchSelectWrap.classList.add('hidden');
    branchTitleWrap.classList.remove('hidden');
    return;
  }
  convSelectWrap.classList.remove('hidden');
  convSelect.innerHTML = '';

  if (digressInfo.currentConvId) {
    const curOpt = document.createElement('option');
    curOpt.value = '__current__';
    curOpt.textContent = `Current: ${digressInfo.currentConvTitle || 'Untitled'}`;
    convSelect.appendChild(curOpt);
  }

  const convs = digressInfo.conversations || [];
  const wantLower = (rule.convTitle || '').trim().toLowerCase();
  let matchedConvId = '';

  if (convs.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'Existing conversations';
    for (const c of convs) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title || 'Untitled';
      grp.appendChild(opt);
      if (!matchedConvId && wantLower && String(c.title || '').trim().toLowerCase() === wantLower) {
        matchedConvId = c.id;
      }
    }
    convSelect.appendChild(grp);
  }

  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New conversation…';
  convSelect.appendChild(newOpt);

  if (matchedConvId) {
    convSelect.value = matchedConvId;
  } else if (wantLower) {
    convSelect.value = '__new__';
    newConvTitle.value = rule.convTitle;
  } else if (digressInfo.currentConvId) {
    convSelect.value = '__current__';
  } else {
    convSelect.value = '__new__';
    newConvTitle.value = 'Clippings';
  }

  if (digressInfo.currentConvId && Array.isArray(digressInfo.branches)) {
    branchCache.set(digressInfo.currentConvId, digressInfo.branches);
  }
  onConvChange();
}

async function init() {
  const [saved, preview, query] = await Promise.all([
    chrome.storage.local.get(['digressUrl', 'rules', 'fallback', 'xThreadMode', 'showToast']),
    chrome.runtime.sendMessage({ type: 'getTabPreview' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'queryDigress' }).catch(() => null),
  ]);

  cfg = mergeSettings(saved);
  const url = (preview && preview.url) || '';
  const rule = matchRule(url, cfg);

  // Connection pill
  connected = !!(query && query.connected);
  digressInfo = connected ? query : null;
  connPill.classList.toggle('on', connected);
  connTxt.textContent = connected ? 'Connected' : 'Will open tab';

  // Preview card
  isX = !!(preview && preview.isX);
  try { tabHost = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { tabHost = ''; }
  ruleBadge.textContent = `rule: ${rule.pattern}`;
  if (preview && preview.selection) {
    previewKind.textContent = `Selection · ${preview.selection.length} chars`;
    previewTxt.textContent = `“${preview.selection}”`;
  } else if (isX) {
    previewKind.textContent = 'Post on X';
    previewTxt.textContent = (preview && preview.title) || 'x.com';
  } else {
    previewKind.textContent = tabHost ? `Full page · ${tabHost}` : 'Full page';
    previewTxt.textContent = (preview && preview.title) || url || 'Current tab';
  }

  if (isX) {
    xSeg.classList.remove('hidden');
    setXMode(cfg.xThreadMode);
  }

  if (tabHost) {
    rememberWrap.classList.remove('hidden');
    rememberLbl.textContent = `Remember for ${tabHost}`;
  }

  setMode(rule.mode);
  focusEl.checked = !!rule.focus;
  populateConversations(rule);
}

async function saveSiteRule(convTitle) {
  if (!tabHost || !cfg) return;
  const rules = cfg.rules.filter((r) => String(r.pattern || '').trim().toLowerCase() !== tabHost.toLowerCase());
  rules.unshift({
    pattern: tabHost,
    mode,
    convTitle: mode === 'branch' ? convTitle : '',
    focus: focusEl.checked,
  });
  await chrome.storage.local.set({ rules });
}

async function doSend() {
  sendBtn.disabled = true;
  msgEl.className = 'msg';
  msgEl.textContent = 'Sending…';

  try {
    const rule = { mode, focus: focusEl.checked };
    let rememberedTitle = '';

    if (mode === 'branch') {
      if (connected && convSelect.value === '__current__') {
        rule.useCurrentConv = true;
        rememberedTitle = (digressInfo && digressInfo.currentConvTitle) || 'Clippings';
      } else if (connected && convSelect.value && convSelect.value !== '__new__') {
        rule.convId = convSelect.value;
        const found = (digressInfo.conversations || []).find((c) => c.id === rule.convId);
        rule.convTitle = (found && found.title) || 'Clippings';
        rememberedTitle = rule.convTitle;
      } else {
        rule.convTitle = newConvTitle.value.trim() || 'Clippings';
        rememberedTitle = rule.convTitle;
      }

      if (connected && convSelect.value !== '__new__' && branchSelect.value && branchSelect.value !== '__new__') {
        rule.targetThreadId = branchSelect.value;
      } else {
        const bt = branchTitle.value.trim();
        if (bt) rule.branchTitle = bt;
      }

      const q = questionEl.value.trim();
      if (q) rule.question = q;
    }

    if (rememberEl.checked) {
      await saveSiteRule(rememberedTitle);
    }

    const res = await chrome.runtime.sendMessage({
      type: 'clipActiveTab',
      rule,
      includeThread: isX ? xMode === 'thread' : undefined,
    });

    if (res && res.ok) {
      msgEl.className = 'msg ok';
      msgEl.textContent = res.convTitle ? `Sent to ${res.convTitle}.` : 'Sent to Digress.';
      setTimeout(() => window.close(), 650);
    } else {
      msgEl.className = 'msg err';
      msgEl.textContent = (res && res.error) || 'Could not reach Digress.';
    }
  } catch (e) {
    msgEl.className = 'msg err';
    msgEl.textContent = String((e && e.message) || e);
  } finally {
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', doSend);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!sendBtn.disabled) doSend();
  }
});

init();
