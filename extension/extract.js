// Injected on demand into non-X tabs to grab either the active selection or the full page HTML.
(() => {
  const sel = String(window.getSelection() || '').trim();
  if (sel) {
    return { title: document.title || location.hostname, url: location.href, text: sel, hasSelection: true };
  }
  return { title: document.title || location.hostname, url: location.href, html: document.documentElement.outerHTML, hasSelection: false };
})();
