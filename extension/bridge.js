// Runs on the Digress tab's own origin: relays clip payloads, metadata queries, and focus requests via window.postMessage.
if (!window.__digressBridgeInstalled) {
  window.__digressBridgeInstalled = true;

  function relay(reqKey, ackKey, body, timeoutMs, sendResponse, fallbackErr) {
    const id = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onAck);
      sendResponse({ ok: false, error: fallbackErr || 'Digress did not respond (is this tab running Digress?).' });
    }, timeoutMs);
    function onAck(e) {
      if (e.source !== window || !e.data || e.data[ackKey] !== 1 || e.data.id !== id) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onAck);
      const out = { ...e.data };
      delete out[ackKey];
      delete out.id;
      sendResponse(out);
    }
    window.addEventListener('message', onAck);
    window.postMessage({ [reqKey]: 1, id, ...body }, location.origin);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'deliverClip') {
      relay('digressClip', 'digressClipAck', { payload: msg.payload }, 15000, sendResponse);
      return true;
    }
    if (msg.type === 'queryDigress') {
      relay('digressClipQuery', 'digressClipQueryAck', { convId: msg.convId || '' }, 4000, sendResponse, 'Digress tab did not respond.');
      return true;
    }
    if (msg.type === 'focusClip') {
      relay('digressClipFocus', 'digressClipFocusAck', { convId: msg.convId || '', threadId: msg.threadId || '' }, 4000, sendResponse, 'Digress tab did not respond.');
      return true;
    }
  });
}
