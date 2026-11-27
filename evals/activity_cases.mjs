// Saved conversation fixtures shared by the context tests and the manual paired eval.
export const ACTIVITY_CASES = [
  { id: 'figure-page', question: 'Which page was that figure on?', look: 'Recalls page 47.' },
  { id: 'figure-value', question: 'What value did the blue line end at?', look: 'Locates page 47 and acknowledges that the numeric endpoint is unavailable.' },
  { id: 'web-source', question: 'Which source was that, and did it establish causation?', look: 'Identifies the reported appendix and distinguishes the source reference from evidence of causation.' },
  { id: 'sibling-page', question: 'Which page was the figure we discussed in the other branch on?', look: 'Acknowledges the missing information without giving a page number.' },
];

export function activityFixture(c, withActivity = true) {
  const web = c.id === 'web-source', sibling = c.id === 'sibling-page';
  const conv = {
    threads: { main: { id: 'main', parent: null } }, order: { main: [] }, msgs: {},
  };
  if (!web) conv.doc = { name: 'Pilot report', kind: 'pdf', left: true };
  function add(thread, id, role, content, extra = {}) {
    conv.order[thread].push(id);
    conv.msgs[id] = { id, thread, role, content, ...extra };
  }
  add('main', 'q', 'user', 'I am reading about a small pilot study.');
  add('main', 'a', 'assistant', 'What would you like to explore?');
  let thread = 'main';
  if (sibling) {
    for (const id of ['figure', 'other']) {
      conv.threads[id] = { id, parent: 'main', anchorMsg: 'a' };
      conv.order[id] = [];
    }
    thread = 'figure';
  }
  add(thread, 'first', 'user', web ? 'Did the groups differ?' : 'Describe the two curves in the figure.');
  const activity = web ? { sources: [{ title: 'Larch pilot methods appendix', url: 'https://example.org/larch/appendix' }] } : { reads: [{ t: 'view', p: 47 }] };
  add(thread, 'reply', 'assistant', web ? 'The treated group recovered sooner.' : 'The red line rises while the blue line flattens.', { web, ...(withActivity && activity) });
  const tid = sibling ? 'other' : 'main';
  add(tid, 'follow', 'user', c.question);
  return { conv, tid };
}
