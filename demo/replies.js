// The demo's "model": no model at all. demo/demo.js calls DemoReplies.reply(body) with exactly what the page sent to
// POST /api/chat ({system, messages, ...}) and streams back the text it returns.
//  - The sample reading's suggested questions, and the questions in the sample conversation, get replies written
//    in advance (PREPARED), so the demo shows what a real answer looks like: math, a diagram, page links.
//  - Anything else gets an honest reply: the passages of the document closest to the question, quoted with page
//    links, and a line saying a real model would explain them. Takeaways, flashcards, "Describe it instead" and
//    "Ask about Digress" get the same kind of treatment, in the format the page asks for.
// Nothing here pretends to be a model: every fallback says it's the demo.
(() => {
  const SAMPLE = 'Bayes’ Rule and the Base-Rate Fallacy';
  // the sample reading, known by its text (its file name and title could be anything)
  const isSample = (doc) => doc.pages.length > 0 && /Bayes. Rule and the Base-Rate Fallacy/.test(doc.pages[0].text);
  const INSTALL = 'https://github.com/NeejWeej/digress#readme';
  const NOTE = `*This is the demo, so there's no model here to explain it. With Claude or ChatGPT connected, you'd get an answer written for your question. [Get Digress](${INSTALL}).*`;

  // ---- replies written in advance (sample reading only), keyed by the question as asked ----
  const PREPARED = {
    'give me an overview of this document': `This reading is about one question: **when a test comes back positive, how much should you believe it?** Its answer is "usually much less than it seems", and the reason is the *base rate*: how common the thing was before you tested.

**The puzzle** [p. 1]. A disease affects 1 in 100 people; the test catches 90% of cases and wrongly flags 9% of healthy people. A positive result feels like "90% sure", but the real chance of being ill is about **9%**.

**Counting** [p. 1]. Imagine 1,000 people: 10 are ill and 9 of them test positive; 990 are healthy and about 89 of *them* test positive. So only 9 of the 98 positives are real, and Figure 1 [p. 1] draws exactly this split.

**The rule** [p. 2]. Bayes' rule is that counting, written generally:

$$P(H \\mid E) = \\frac{P(E \\mid H)\\,P(H)}{P(E)}$$

with the **prior** $P(H)$, the **likelihood** $P(E \\mid H)$ and the **posterior** $P(H \\mid E)$.

**The odds form** [p. 2]. Easier in your head: *posterior odds = prior odds × likelihood ratio*. Here the ratio is $0.90 / 0.09 = 10$, so odds of 1 : 99 become 10 : 99, about 9.2%. A second independent positive gets you to about 50% [p. 2].

**Why intuition fails** [p. 2]. *Base-rate neglect* (ignoring how rare the disease is) and *confusing the inverse* (treating $P(E \\mid H)$ as $P(H \\mid E)$), which in court is the *prosecutor's fallacy*.

**Where it shows up** [p. 3]: medical screening, spam filters, experiments, and debugging a flaky test.

The one-line version is the summary on [p. 3]: evidence tells you how much to *change* what you believed, not what to believe.`,

    'whats the main contribution or argument': `The argument is that **a piece of evidence can't be judged on its own; it only tells you how far to move from where you started.**

It makes that case in three steps:

1. **A concrete failure of intuition** [p. 1]. A "90% accurate" test, a disease that affects 1 in 100, and a positive result that means only about a 9% chance of being ill. Most people, doctors included, say 90%.
2. **A way to see the right answer** [p. 1]. Count 1,000 people instead of multiplying percentages. The healthy group is so large that its small error rate swamps the true positives: 89 false alarms against 9 real cases.
3. **The general rule** [p. 2], in its odds form: *posterior odds = prior odds × likelihood ratio*. Evidence is a multiplier, and a multiplier applied to a tiny prior still gives a small result.

The practical claim, in the box on [p. 2]: *a test can only move you as far as its likelihood ratio allows*, so a rare condition needs very strong or repeated evidence before it becomes likely.`,

    'outline the sections with page references': `1. **A puzzle** [p. 1]: a rare disease, a "90% accurate" test, and why the answer is about 9%, not 90%.
2. **Counting instead of calculating** [p. 1]: the same question with 1,000 imagined people (*natural frequencies*), and Figure 1 [p. 1], the tree of who is ill and who tests positive.
3. **The rule itself** [p. 2]: Bayes' rule, $P(H \\mid E) = P(E \\mid H)\\,P(H) / P(E)$, and the names prior, likelihood and posterior.
4. **The odds form** [p. 2]: posterior odds = prior odds × likelihood ratio; updating on a second test; the rule-of-thumb box.
5. **Why intuition gets this wrong** [p. 2]: base-rate neglect, confusing the inverse, and the prosecutor's fallacy.
6. **Where it shows up** [p. 3]: screening, spam filters, experiments, debugging.
7. **Summary** [p. 3].`,

    'what background do i need to follow this': `Very little. The reading is built to be followed with arithmetic alone.

- **Percentages and fractions**: "9% of 990" and "9 out of 98" are the whole of section 2 [p. 1].
- **Conditional probability notation**, $P(A \\mid B)$, read "the probability of A given B". Section 3 [p. 2] introduces it, and the one thing to hold on to is that $P(A \\mid B)$ and $P(B \\mid A)$ are different numbers. The whole reading is about mixing them up.
- **Odds**, as in "10 to 99". Odds of $a : b$ are a probability of $\\frac{a}{a+b}$. Section 4 [p. 2] uses them.

If you want one thing to try first, redo the count in section 2 with a disease that affects 1 in 10 people instead of 1 in 100, and watch the answer jump.`,

    'why does such a small falsepositive rate matter so much': `Because it's a small rate of a **huge** group.

The 9% only applies to healthy people, and almost everyone is healthy: 990 of every 1,000 [p. 1]. So 9% of 990 is about **89 false alarms**. The disease group is tiny, 10 people, so even catching 90% of them gives just **9 true positives**.

| | ill (10) | healthy (990) |
|---|---|---|
| test positive | 9 | 89 |
| test negative | 1 | 901 |

A positive result puts you in the top row, and that row is mostly healthy people. What matters is not the error *rate* but the error *count*, and the count depends on how big the group it applies to is.

You can see how much the base rate drives this by changing it. If 1 in 10 people had the disease, the top row would be 90 ill against 81 healthy, and a positive would mean about 53%. Same test, same 9%, very different meaning.`,

    // a follow-up in the false-positive branch, asked after its takeaway (so the branch shows where the takeaway ends)
    'what if the falsepositive rate were 1 instead': `Then a positive result means a lot more: about **47%**, up from 9%.

Redo the count with the same 1,000 people:

| | ill (10) | healthy (990) |
|---|---|---|
| test positive | 9 | about 10 |
| test negative | 1 | about 980 |

Now 9 of the 19 positives are real: $9 / 19 \\approx 47\\%$.

In odds form, the likelihood ratio jumps from $0.90 / 0.09 = 10$ to $0.90 / 0.01 = 90$, so the prior odds of 1 : 99 become 90 : 99. Cutting false alarms is worth far more here than catching more of the ill: a perfect 100% sensitivity with the original 9% false-positive rate would only get you to about 10%.`,

    // asked about a snip of Figure 1 (the tree of 1,000 people)
    'how do i read this tree': `Read it from the top down, as the same 1,000 people being sorted twice.

1. **First split, by whether they're ill.** The disease affects 1 in 100, so the 1,000 people become **10 ill** (pink) and **990 healthy** (blue).
2. **Second split, by the test result.** Each group is split again by what the test says:
   - of the 10 ill, the test catches 90%: **9 positive**, 1 negative;
   - of the 990 healthy, it wrongly flags 9%: **89 positive**, 901 negative.
3. **The red outlines are everyone who tested positive:** 9 + 89 = **98 people**.

Your question, "I tested positive, am I ill?", only concerns the red boxes. Of those 98 people, 9 are ill:

$$P(\\text{ill} \\mid \\text{positive}) = \\frac{9}{9 + 89} \\approx 9.2\\%$$

The picture makes the reason visible: the right-hand red box (89) is ten times the left-hand one (9), even though the test is quite good, because it sits under the much bigger healthy branch [p. 1].`,

    'why is the odds form easier': `Because it turns updating into **one multiplication**, and the number you multiply by belongs to the test alone.

With probabilities you have to compute $P(E)$ every time, adding up the true and the false positives [p. 2]. With odds, the base rate and the test are kept apart:

$$\\underbrace{\\tfrac{1}{99}}_{\\text{prior odds}} \\times \\underbrace{10}_{\\text{likelihood ratio}} = \\tfrac{10}{99} \\approx 9.2\\%$$

That separation buys you two things:

- **The test has one number.** "A positive multiplies the odds by 10" is true whoever is tested; only the starting odds change.
- **More evidence is just more multiplying**, as long as each piece is independent:

\`\`\`mermaid
flowchart LR
  A["prior 1 to 99"] -->|"positive, x10"| B["10 to 99, about 9%"]
  B -->|"second positive, x10"| C["100 to 99, about 50%"]
\`\`\`

This is the rule of thumb on [p. 2]: from a small prior, even a ×10 test leaves you small. You need either a much bigger ratio or a few independent results.`,
  };

  // the sample conversation without a document (how HTTPS works), keyed the same way
  const PREPARED_CHAT = {
    'how does https keep my connection private': `HTTPS is ordinary HTTP sent through an encrypted tunnel called **TLS**. Setting up the tunnel solves two problems before any of your data moves:

1. **Who am I talking to?** The server proves it really is \`example.com\` with a **certificate**.
2. **How do we get a shared secret key** when everything we send can be read by anyone on the network? With a **key exchange**.

Once both sides hold the same secret key, everything else (your requests, cookies, passwords, the pages that come back) is encrypted with fast *symmetric* encryption such as AES.

\`\`\`mermaid
sequenceDiagram
  participant B as Your browser
  participant S as Server
  B->>S: Hello, here are the ciphers I support
  S->>B: My certificate, and my half of the key exchange
  B->>S: My half of the key exchange
  Note over B,S: Both compute the same secret key
  B->>S: Encrypted request
  S->>B: Encrypted response
\`\`\`

A few things this gives you, and one it doesn't:

- **Privacy:** someone on the café Wi-Fi sees that you connected to \`example.com\`, and roughly how much data moved, but not which pages or what was in them.
- **Integrity:** every encrypted record carries a check, so a change in transit is detected and the connection is dropped.
- **Authenticity:** the certificate ties the key exchange to the real site, so nobody in the middle can quietly stand in for it.
- **Not hidden:** the site's name usually still travels in the clear at the start, and the server itself sees everything you send it.

The clever part is the key exchange: two machines that have never met agree on a secret while the whole conversation is overheard.`,

    'how can two strangers agree on a secret while everyone is listening': `With a **Diffie–Hellman** exchange. Each side keeps one number private and sends something computed from it in public; combining your own private number with the other side's public value gives both of you the same result.

Publicly agreed: a prime $p$ and a base $g$. Then:

- You pick a secret $a$ and send $A = g^a \\bmod p$.
- The server picks a secret $b$ and sends $B = g^b \\bmod p$.
- You compute $B^a \\bmod p$; the server computes $A^b \\bmod p$. Both equal $g^{ab} \\bmod p$.

A tiny example with $p = 23$, $g = 5$:

| | secret | sends |
|---|---|---|
| you | $a = 6$ | $A = 5^6 \\bmod 23 = 8$ |
| server | $b = 15$ | $B = 5^{15} \\bmod 23 = 19$ |

You compute $19^6 \\bmod 23 = 2$, the server computes $8^{15} \\bmod 23 = 2$. The shared secret is **2**, and it never crossed the network.

An eavesdropper sees $p$, $g$, $8$ and $19$. To get the secret they'd need $a$ or $b$, which means solving $5^a \\equiv 8 \\pmod{23}$ for $a$: the **discrete logarithm**. With numbers this small you can just try them all; with the sizes real TLS uses (or its elliptic-curve version), nobody knows a way to do it in any useful amount of time.

Real connections also pick fresh secrets every time, so recording traffic today and stealing the server's long-term key later still doesn't unlock it. That property is called *forward secrecy*.`,

    'what stops someone in the middle from pretending to be the server': `On its own, nothing: a key exchange gives you a secret shared with *whoever answered*. Someone in the middle could run one exchange with you and another with the real server, and pass everything along while reading it.

The **certificate** closes that gap.

1. The certificate says, in effect, "this public key belongs to \`example.com\`", and it is **signed by a certificate authority** (CA) that checked the site's owner controls that domain.
2. Your browser or operating system ships with a list of CAs it trusts. It checks the signature chain from the site's certificate up to one of them, and that the name matches the site you asked for.
3. During the handshake the server **signs the key exchange with the private key** matching that certificate. Someone in the middle doesn't have that key, so they can't produce the signature.

So an attacker would need either the site's private key or a CA willing to sign a certificate for a domain they don't control. That's why your browser shows a full-page warning when a certificate doesn't check out: clicking through it gives up exactly this protection.`,

    'who checks the certificate authorities': `Mostly the browser and operating system makers, plus a public record that anyone can watch.

- **Root programs.** Apple, Google, Microsoft and Mozilla each decide which certificate authorities their software trusts. CAs have to pass regular audits and follow shared rules about how they check who owns a domain. A CA that breaks them can be removed, and that has happened: a CA that mis-issued certificates can find its new ones distrusted by every major browser.
- **Certificate Transparency.** Browsers only accept a certificate if it has been recorded in public, append-only logs. Site owners (and researchers) monitor those logs, so a certificate issued for your domain without your knowledge shows up where you can see it.
- **Revocation and short lifetimes.** A certificate that leaks can be revoked, but revocation checking has always been patchy. The bigger protection is that certificates now last months rather than years, so a bad one doesn't stay useful for long.

None of this makes a rogue certificate impossible; it makes it quick to notice and expensive for the CA that signed it.`,
  };

  const CARDS = {
    main: [
      { front: 'A disease affects 1 in 100 people; a test catches 90% of cases and flags 9% of healthy people. If you test positive, about how likely are you to be ill?', back: 'About 9%. Of 1,000 people, 9 ill people test positive and about 89 healthy ones do too: 9 of 98.' },
      { front: 'State Bayes’ rule, naming the prior, likelihood and posterior.', back: '$P(H \\mid E) = P(E \\mid H)\\,P(H) / P(E)$: the posterior $P(H \\mid E)$ is the likelihood $P(E \\mid H)$ times the prior $P(H)$, divided by $P(E)$.' },
      { front: 'What is the odds form of Bayes’ rule?', back: 'Posterior odds = prior odds × likelihood ratio, where the ratio is how much more often the evidence appears when the hypothesis is true than when it is false.' },
      { front: 'What is base-rate neglect?', back: 'Ignoring how common something was to begin with when judging specific evidence about it, such as a test result.' },
    ],
    // a branch's cards, by what it was about (the passage named in the ask)
    branch: [
      [/wrongly flags|false.?positive/i, [{ front: 'Why does a test with a small false-positive rate still give mostly false alarms for a rare disease?', back: 'The rate applies to the healthy group, which is nearly everyone, so the number of false positives (e.g. 89 of 990) dwarfs the true ones (9 of 10).' }]],
      [/likelihood ratio|odds/i, [{ front: 'What is the likelihood ratio of a positive test, and how do you use it?', back: 'Sensitivity ÷ false-positive rate (0.90 / 0.09 = 10 in the reading). Multiply the prior odds by it to get the posterior odds.' },
        { front: 'How do you update on two independent positive tests in odds form?', back: 'Multiply by each test’s likelihood ratio in turn: 1 : 99 × 10 × 10 = 100 : 99, just over 50%.' }]],
    ],
    takeaway: [[/false.?alarms|false.?positive/i, [{ front: 'What decides what a positive test means: the error rate or the number of errors?', back: 'The number: a small rate applied to a huge healthy group gives more false positives than the true positives from a small ill group.' }]]],
  };

  // ---- reading the request ----
  const textOf = (c) => (typeof c === 'string' ? c : (c || []).map((p) => (p.type === 'text' ? p.text : '')).join(''));
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  // the question itself, without the side-question marker and quoted passage the page puts before it
  function question(raw) {
    raw = raw.replace(/\n\n\(The learner is currently looking at p\. \d+ of the document\.\)$/, '');
    // takeaways carried back into a thread come before the next question in the same message: the question is last
    if (/^\[Takeaway carried back/.test(raw)) return raw.slice(raw.lastIndexOf('\n\n') + 2).trim();
    let q = raw.replace(/^\[Side question[^\]]*\]\n?(?:(?:>.*(?:\n|$))*)\n*/, '');
    q = q.replace(/^\[The text of [^\]]*\]\n[\s\S]*?\n\n/, '');
    q = q.replace(/\n\n\(The learner is currently looking at p\. \d+ of the document\.\)$/, '');
    return q.trim();
  }
  const quoted = (raw) => { const m = raw.match(/^\[Side question[^\]]*\]\n((?:>.*(?:\n|$))+)/); return m ? m[1].replace(/^> ?/gm, '').trim() : ''; };
  const snipText = (raw) => { const m = raw.match(/Text found inside it: "([^"]*)"/); return m ? m[1] : ''; };
  const pageAsked = (raw) => { const m = raw.match(/^\[Side question about (?:page (\d+)|this area of the document \(p\. (\d+)\))/); return m ? +(m[1] || m[2]) : 0; };

  // the document's pages, from the system prompt (docPreamble labels them [p. N] or [part N])
  function docOf(system) {
    const m = system.match(/<document>\n([\s\S]*?)\n<\/document>/);
    const title = (system.match(/reading a document titled "([^"]*)"/) || [])[1] || '';
    if (!m) return { title, pages: [] };
    const pages = [], re = /\[(p\.|part) (\d+)\]\n([\s\S]*?)(?=\n\n\[(?:p\.|part) \d+\]\n|$)/g;
    let x; while ((x = re.exec(m[1]))) pages.push({ label: `${x[1]} ${x[2]}`, n: +x[2], text: x[3] });
    return { title, pages };
  }

  // ---- finding the closest passages: word overlap, which is all a demo needs ----
  const STOP = new Set('a an and are as at be but by can do does for from has have how i if in into is it its me my of on or so that the their them then there these this those to was what when where which who why will with you your about would could should more most much very just than also any some all one not no'.split(' '));
  const words = (s) => (s.toLowerCase().match(/[a-z0-9’']+/g) || []).map((w) => w.replace(/[’']s?$/, '').replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length > 1 && !STOP.has(w));
  // a sentence that is mostly numbers and labels (a figure's text, a table) isn't worth quoting
  const prose = (t) => { const w = t.split(/\s+/).filter(Boolean); return w.filter((x) => /^[A-Za-z’'(“"-]{3,}/.test(x)).length >= 0.6 * w.length; };
  function chunks(text) {   // runs of about three sentences
    const s = text.replace(/\s+/g, ' ').split(/(?<=[.!?]["”’)]*) (?=[A-Z0-9“"(])/).filter(prose);   // not at "9.2%"
    for (let i = 0; i < s.length; i++) s[i] += ' ';
    const out = []; for (let i = 0; i < s.length; i += 3) out.push(s.slice(i, i + 3).join('').trim());
    return out.filter((c) => c.length > 40);
  }
  // the passages sharing the most words with the question; words of what it's about (a highlighted passage, the
  // reply a quick question refers to) count a third as much, so they break ties without drowning the question
  function closest(items, query, n, about = '') {   // items: [{text, where}]
    const q = new Set(words(query)), a = new Set(words(about).filter((w) => !q.has(w))); if (!q.size && !a.size) return [];
    return items.map((it) => { const w = new Set(words(it.text)); let sc = 0; for (const t of q) if (w.has(t)) sc += 3; for (const t of a) if (w.has(t)) sc++; return { ...it, sc: sc / Math.sqrt(w.size + 4) }; })
      .filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, n);
  }
  const quote = (t) => '> ' + t.replace(/\n+/g, ' ');

  // ---- the kinds of request ----
  function chat(system, msgs) {
    const raw = textOf(msgs[msgs.length - 1].content), q = question(raw), doc = docOf(system);
    if (/^Your reply above was cut off/.test(raw)) return '\n\n' + NOTE;
    if (isSample(doc) && PREPARED[key(q)]) return PREPARED[key(q)];
    if (!doc.pages.length) {
      if (PREPARED_CHAT[key(q)]) return PREPARED_CHAT[key(q)];
      // a conversation without a document: quote what its replies so far say that's closest (a branch sees them all)
      const said = msgs.filter((m) => m.role === 'assistant').flatMap((m) => chunks(textOf(m.content).replace(/```[\s\S]*?```/g, '').replace(/^\|.*$/gm, '').replace(/\*[^*]*demo[^*]*\*/gi, '')).map((text) => ({ text, where: '' })));
      const hits = closest(said, q, 2, quoted(raw));
      if (hits.length) return `Here's what this conversation already says that's closest to your question:\n\n${hits.map((h) => quote(h.text)).join('\n\n')}\n\n${NOTE}`;
      return `${NOTE.replace(' to explain it', ' to answer that')}\n\nTo see what an answer looks like, open one of the sample conversations in the sidebar and try a suggested question, or highlight a passage in a reply and ask about it. You can also open a PDF of your own with **New from a document**; it stays in this browser.`;
    }
    // what to look for: the question, plus what it's about (a highlighted passage, a snip's words, or the reply
    // a quick question like "Explain simpler" refers to)
    const prev = [...msgs].reverse().find((m) => m.role === 'assistant');
    let about = quoted(raw) || snipText(raw);
    const page = pageAsked(raw);
    if (!about && prev && q.split(/\s+/).length < 14) about = textOf(prev.content).slice(0, 1500);
    const items = doc.pages.filter((p) => !page || p.n === page).flatMap((p) => chunks(p.text).map((text) => ({ text, where: p.label })));
    const hits = closest(items, q, 2, about);
    if (!hits.length) return `Nothing in “${doc.title}” matches your question closely, so there's nothing to quote.\n\n${NOTE}`;
    return `${page ? `Here's what page ${page} says that's closest to your question` : `Here's what the document says that's closest to your question`}:\n\n${hits.map((h) => `${quote(h.text)} [${h.where}]`).join('\n\n')}\n\n${NOTE}`;
  }

  /* Takeaways. The two in the sample conversations (demo/seed.json) were written by a real model: demo/make_sample.py
     --record sent the page's own takeaway request to a Digress server and kept the answers in
     demo/sample/takeaways.json, and hands them to this page only while it builds the seed (window.__seedTakeaways,
     keyed by a phrase of the branch's question). A takeaway a visitor asks for can't be a summary without a model,
     so it's the same shape as one, and says what it is: 2 or 3 one-sentence bullets, each the sentence of what the
     branch found that shares the most words with its questions, with its [p. N]. */
  function takeaway(msgs, body) {
    const all = msgs.map((m) => textOf(m.content)).join('\n'), seed = window.__seedTakeaways;
    if (seed) for (const k of Object.keys(seed)) if (all.includes(k)) {
      if (window.__seedRecord) (window.__takeawayBodies = window.__takeawayBodies || {})[k] = JSON.parse(JSON.stringify(body));
      if (seed[k].text) return seed[k].text;
    }
    const asked = msgs.filter((m) => m.role === 'user').slice(-3).map((m) => question(textOf(m.content))).join(' ');
    const last = [...msgs].reverse().find((m) => m.role === 'assistant'), said = last ? textOf(last.content) : '';
    const CITE = /\s*\[(?:p|pp|part)\.?\s[^\]]+\]\s*$/;
    const sentences = (t) => t.replace(/\s+/g, ' ').split(/(?<=[.!?]["”’)]*) (?=[A-Z0-9“"(])/).map((x) => x.trim()).filter((x) => x.length > 30 && prose(x));
    // a no-model reply is quoted excerpts, each ending in where it's from: one sentence of each, with that place
    const ex = said.split('\n').filter((l) => /^> \S/.test(l)).map((l) => { const t = l.slice(2).trim(), c = (t.match(CITE) || [''])[0]; return { text: t.slice(0, t.length - c.length), cite: c.trim() }; });
    let items = ex.length
      ? ex.map((e) => { const b = closest(sentences(e.text).map((text) => ({ text })), asked, 1)[0] || { text: sentences(e.text)[0] || e.text }; return { text: b.text, where: e.cite }; })
      : (() => { const ss = sentences(said.replace(/```[\s\S]*?```/g, '').replace(/^\s*(>|\||#).*$/gm, '').replace(/\*[^*]*demo[^*]*\*/gi, '')).map((text, n) => ({ text, n }));
        const best = closest(ss, asked, 3); return (best.length ? best : ss.slice(0, 2)).sort((a, b) => a.n - b.n); })();
    items = items.filter((it) => it.text).slice(0, 3);
    const label = '- *(A demo takeaway: sentences picked from what the branch found. With a model connected, it writes its own 2–4 bullet summary.)*';
    return items.length ? items.map((it) => '- ' + it.text + (it.where ? ' ' + it.where : '')).join('\n') + '\n' + label
      : '- *(A demo takeaway: with a model connected, this would sum up what the branch found in 2–4 bullets.)*';
  }

  function cards(system, msgs, ask) {
    const max = +((ask.match(/At most (\d+) cards/) || [])[1] || 3);
    const have = new Set((ask.split("Don't repeat these existing cards:\n")[1] || '').split('\n').map(key));
    const sample = isSample(docOf(system));
    let out = [];
    if (sample) {
      const by = (list, text) => (list.find(([re]) => re.test(text)) || [0, []])[1];
      out = /the main thread/.test(ask) ? CARDS.main : /the takeaway below/.test(ask) ? by(CARDS.takeaway, ask) : /this side branch/.test(ask) ? by(CARDS.branch, (ask.match(/about “([^”]*)”/) || [])[1] || '') : [];
    }
    if (!out.length) {   // each question asked and the first lines of its answer
      for (let i = 0; i + 1 < msgs.length; i++) {
        if (msgs[i].role !== 'user' || msgs[i + 1].role !== 'assistant') continue;
        const q = question(textOf(msgs[i].content)), a = textOf(msgs[i + 1].content).replace(/^>.*$/gm, '').replace(/\*[^*]*demo[^*]*\*/gi, '').trim();
        if (!q || /^\[(Flashcards|Takeaway)/.test(q) || !a) continue;
        out.push({ front: /[?]$/.test(q) ? q : q + '?', back: chunks(a)[0] || a.slice(0, 200) });
      }
    }
    return JSON.stringify(out.filter((c) => !have.has(key(c.front))).slice(0, max));
  }

  function guide(system, msgs) {
    const raw = textOf(msgs[msgs.length - 1].content);
    const items = [], re = /<doc name="([^"]*)" file="([^"]*)">\n([\s\S]*?)\n<\/doc>/g;
    let x; while ((x = re.exec(system))) {
      if (/NOT built yet/.test(x[1])) continue;
      for (const para of x[3].split(/\n\s*\n/)) { const t = para.replace(/^#+\s*/gm, '').trim(); if (t.length > 60 && !/^[|`<!]/.test(t)) items.push({ text: t.length > 600 ? t.slice(0, 600) + '…' : t, where: x[1] }); }
    }
    const hits = closest(items, raw, 2);
    const head = `*The demo has no model, so here's what Digress's own documentation says that's closest to your question:*`;
    return hits.length ? `${head}\n\n${hits.map((h) => `${quote(h.text)}\n\n— *${h.where}*`).join('\n\n')}` : `*The demo has no model, and nothing in Digress's documentation matches that closely. The [README](${INSTALL}) covers everything it does.*`;
  }

  function find(msgs) {
    const raw = textOf(msgs[msgs.length - 1].content), desc = (raw.match(/in their own words:\n"([^"]*)"/) || [])[1] || '';
    if (/List up to 8 short search phrases/.test(raw)) { const w = [...new Set(words(desc))]; return w.slice(0, 8).join('\n'); }
    const n = (raw.match(/^\[\d+\]/gm) || []).length;
    return JSON.stringify(Array.from({ length: Math.min(3, n) }, (_, i) => ({ n: i + 1, why: 'shares words with your description (demo: no model to judge)' })));
  }

  window.DemoReplies = {
    reply(body) {
      const system = body.system || '', msgs = body.messages || [], last = msgs.length ? textOf(msgs[msgs.length - 1].content) : '';
      if (/^You answer questions about Digress/.test(system)) return guide(system, msgs);
      if (/^You help someone find something/.test(system)) return find(msgs);
      if (/^You name notes in a learner's study app/.test(system)) return '';   // no made-up titles: the question stays the title
      if (/\[Flashcards\] Make spaced-repetition flashcards/.test(last)) return cards(system, msgs, last);
      if (/Write a short takeaway from this side branch/.test(last)) return takeaway(msgs, body);
      return chat(system, msgs);
    },
  };
})();
