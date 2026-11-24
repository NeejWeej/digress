// The prompt eval's questions. Each case is sent once with the "before" prompts and once with the "after" ones, built
// from that version's web/prompts.js, so the only difference is the prompt text. `look` is what a reader should check
// when comparing the two answers (nothing is scored automatically).
//
//   messages(P): the conversation, built with that version's PROMPTS (branch markers come from P.branch)
//   doc:         optional {name, pages: [text]}: sent the way a short document is (whole, with [p. N] labels)

const BAYES_Q = 'What is Bayes’ theorem, in plain terms?';
const BAYES_A = 'Bayes’ theorem tells you how to update a belief when you see evidence: the posterior is proportional to the prior times the likelihood, $P(H\\mid E) \\propto P(E\\mid H)\\,P(H)$. You start with how plausible a hypothesis was before (the prior), weigh it by how well it predicts what you saw (the likelihood), and renormalise.';

export const CASES = [
  {
    id: 'false-premise',
    look: 'Says plainly that the premise is wrong (in a vacuum they fall at the same rate) before explaining; doesn’t play along.',
    messages: () => [{ role: 'user', content: 'Why does a heavier object fall faster than a lighter one in a vacuum?' }],
  },
  {
    id: 'quick-fact',
    look: 'A short, direct answer: no headings, no essay, no “want me to…” at the end.',
    messages: () => [{ role: 'user', content: 'What does HTTP status 418 mean?' }],
  },
  {
    id: 'explain',
    look: 'Answer first, then intuition, then precision; terms defined; sensible length; no trailing offer.',
    messages: () => [{ role: 'user', content: 'How does a hash table deal with two keys that land in the same slot?' }],
  },
  {
    id: 'beginner',
    look: 'Pitched at a beginner: defines terms on first use, doesn’t bury them in notation, stays short.',
    messages: () => [{ role: 'user', content: 'whats a gradient?? im new to ML and everyone keeps saying it' }],
  },
  {
    id: 'analogy',
    look: 'Uses an analogy and says where it stops holding.',
    messages: () => [{ role: 'user', content: 'Explain electrical voltage with an analogy.' }],
  },
  {
    id: 'tone-entropy',
    look: 'Engaging because of the idea (a concrete start, what’s surprising about it), not because of jokes, exclamation marks or praise; still accurate.',
    messages: () => [{ role: 'user', content: 'What is entropy, really?' }],
  },
  {
    id: 'tone-sky',
    look: 'Starts from something familiar and builds up; lively without forced humour or cheerleading; answers first.',
    messages: () => [{ role: 'user', content: 'Why is the sky blue and not violet?' }],
  },
  {
    id: 'unsure',
    look: 'Says how sure it is; doesn’t state a precise figure as fact if it isn’t certain.',
    messages: () => [{ role: 'user', content: 'Exactly how many lines of code were in the first version of Unix, in 1971?' }],
  },
  {
    id: 'branch-first',
    look: 'Answers the side question directly and focused on the highlighted phrase, without re-explaining Bayes from scratch.',
    messages: (P) => [
      { role: 'user', content: BAYES_Q },
      { role: 'assistant', content: BAYES_A },
      { role: 'user', content: P.branch.replyPassage('> the prior') + 'Why is it called a prior?' },
    ],
  },
  {
    id: 'branch-later',
    look: 'The second question in the branch (no marker of its own) is still treated as part of the side question: direct, in context, no course restart.',
    messages: (P) => [
      { role: 'user', content: BAYES_Q },
      { role: 'assistant', content: BAYES_A },
      { role: 'user', content: P.branch.replyPassage('> the prior') + 'Why is it called a prior?' },
      { role: 'assistant', content: 'Because it is what you believe *prior to* seeing the evidence: your starting point before the likelihood weighs in.' },
      { role: 'user', content: 'And where does it come from in practice?' },
    ],
  },
  {
    id: 'unseen-branch',
    look: 'Says it can’t see that other branch (rather than pretending it remembers it), then still helps with the question.',
    messages: () => [
      { role: 'user', content: BAYES_Q },
      { role: 'assistant', content: BAYES_A },
      { role: 'user', content: 'Like we worked out in the other branch with the coin example, the denominator is just a normaliser. So can I always ignore it?' },
    ],
  },
  {
    id: 'doc-wrong',
    look: 'Separates what the document says (cited as [p. N]) from its own knowledge, and says the document is wrong about Monty Hall.',
    doc: {
      name: 'Notes on probability puzzles',
      pages: [
        'Notes on probability puzzles.\n\nThe Monty Hall problem: you pick one of three doors; the host, who knows where the car is, opens another door showing a goat and offers a switch.',
        'Since two doors remain, the car is equally likely to be behind either, so switching gives a 1/2 chance and makes no difference.',
      ],
    },
    messages: () => [{ role: 'user', content: 'Is the document right about whether switching matters?' }],
  },
];
