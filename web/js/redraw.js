// "This part of the page needs drawing again": how one module asks another to redraw, without reaching into it.
// The module that owns a part registers its redraw once (onRedraw('panes', layout)); anyone else calls
// invalidate('panes'). Today invalidate redraws at once, exactly as calling the function did, so code that
// redraws and then measures or scrolls (layout(); revealPane(tid)) still sees the new page. Batching redraws to one
// per frame would need a flush() before every such read; see agents/ui.md, "Redraws". redrawCounts() says how often
// each part was redrawn (for measuring whether batching would save anything).
const handlers = new Map(), counts = new Map();

export function onRedraw(key, fn) {
  if (handlers.has(key)) throw new Error(`onRedraw('${key}') registered twice`);
  handlers.set(key, fn);
}

export function invalidate(key) {
  const fn = handlers.get(key);
  if (!fn) throw new Error(`nothing redraws '${key}' (no onRedraw('${key}', …))`);
  counts.set(key, (counts.get(key) || 0) + 1);
  return fn();
}

export const redrawCounts = () => Object.fromEntries(counts);
