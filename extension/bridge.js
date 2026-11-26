// Runs on the Digress tab's own origin: relays clip payloads from background.js into Digress via window.postMessage.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'deliverClip') return;
  const id = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    window.removeEventListener('message', onAck);
    sendResponse({ ok: false, error: 'Digress did not respond (is this tab running Digress?).' });
  }, 15000);
  function onAck(e) {
    if (e.source !== window || !e.data || e.data.digressClipAck !== 1 || e.data.id !== id) return;
    if (done) return;
    done = true;
    clearTimeout(timer);
    window.removeEventListener('message', onAck);
    sendResponse({ ok: !!e.data.ok, convId: e.data.convId, threadId: e.data.threadId, error: e.data.error });
  }
  window.addEventListener('message', onAck);
  window.postMessage({ digressClip: 1, id, payload: msg.payload }, location.origin);
  return true;
});
