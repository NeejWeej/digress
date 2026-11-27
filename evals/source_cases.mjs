// Both arms get the same saved conversation. Only the representation of its references changes.
export const SOURCE_CASES = [
  { id: 'source-gap', question: 'What was the URL of the calibration appendix for that study?', look: 'Returns the Larch calibration appendix URL after intervening turns.' },
  { id: 'source-earlier', question: 'What was the calibration appendix URL for the first study, not the second?', look: 'Selects the earlier Larch list and returns its appendix URL.' },
  { id: 'source-cited', question: 'Repeat the appendix link you gave me.', look: 'Repeats the explicit citation without a lookup.' },
  { id: 'source-sibling', question: 'What was the calibration appendix URL in my other branch?', look: 'Acknowledges the missing source without inventing a URL.' },
  { id: 'source-verbose', question: 'What is random assignment, in one sentence?', look: 'Answers without a lookup after a reply with twenty URL-shaped titles and query-heavy links.' },
  { id: 'source-unrelated', question: 'What is random assignment, in one sentence?', look: 'Answers directly without a lookup.' },
];

export function sourceFixture(c) {
  const conv = { threads: { main: { id: 'main', parent: null } }, msgs: {}, order: { main: [] } };
  function add(tid, role, content, extra = {}) {
    const id = 'm' + Object.keys(conv.msgs).length;
    conv.msgs[id] = { id, thread: tid, role, content, ...extra };
    conv.order[tid].push(id);
    return id;
  }
  function study(tid, name, appendix) {
    add(tid, 'user', 'How was the ' + name + ' study organized?');
    const sources = ['Protocol', 'Rater handbook', 'Calibration appendix', 'Recruitment flow',
      'Eligibility criteria', 'Survey instrument', 'Analysis plan', 'Reliability audit'].map((title,i) => ({
      title: name + ' study — ' + title,
      url: 'https://archive.example.org/papers/' + (i === 2 ? appendix : name.toLowerCase() + '-' + (i + 1)),
    }));
    if (c.id === 'source-verbose') {
      sources.length = 0;
      for (let i = 1; i <= 20; i++) {
        const url = 'https://archive.example.org/studies/larch/appendix?id=' + i + '&utm_source=research-newsletter&utm_campaign=pilot-study';
        sources.push({title:url, url});
      }
    }
    const citation = c.id === 'source-cited' ? ' [Calibration appendix](' + sources[2].url + ')' : '';
    add(tid, 'assistant', 'Assessors were trained before enrollment.' + citation, { web: true, sources });
  }
  add('main','user','I want to understand two pilot studies.');
  const anchorMsg = add('main','assistant','Which study would you like to discuss?');
  let tid = 'main';
  if (c.id === 'source-sibling') {
    for (const id of ['left','right']) {
      conv.threads[id] = { id, parent:'main', anchorMsg };
      conv.order[id] = [];
    }
    study('left', 'Larch', 'r7x-p14');
    tid = 'right';
  } else {
    study(tid, 'Larch', 'r7x-p14');
    if (c.id === 'source-earlier') study(tid, 'Alder', 'j2v-p06');
    if (c.id === 'source-gap') {
      add(tid,'user','What is an assessor?');
      add(tid,'assistant','Someone who measures a study outcome.', { web:true, sources:[] });
      add(tid,'user','Is that always a doctor?');
      add(tid,'assistant','No, the appropriate training depends on the outcome.');
    }
  }
  add(tid,'user',c.question);
  return { conv, tid };
}
