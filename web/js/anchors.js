/* Positions are counted in non-whitespace characters of the reply's visible text (skipping math,
   diagrams and markers), so they survive re-rendering and don't depend on how the browser
   turns a selection into text. */
export const textWalker = (root) => document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
  acceptNode: n => n.parentElement && n.parentElement.closest('svg,.math,.mermaid-box,mjx-container,sup.fn') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
});
export const nonWs = (s) => s.replace(/\s+/g, '').length;
export const flatLen = (root) => { const w = textWalker(root); let n, c = 0; while ((n = w.nextNode())) c += nonWs(n.nodeValue); return c; };
export function charPos(root, cont, off) {
  const r = document.createRange(); r.setStart(root, 0); try { r.setEnd(cont, off); } catch (e) { return -1; }
  const w = textWalker(root); let n, c = 0;
  while ((n = w.nextNode())) {
    if (n === cont) { c += nonWs(n.nodeValue.slice(0, off)); break; }
    if (r.comparePoint(n, 0) > 0) break;
    if (r.comparePoint(n, n.nodeValue.length) <= 0) c += nonWs(n.nodeValue); else break;
  }
  return c;
}
