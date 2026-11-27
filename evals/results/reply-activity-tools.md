# Reply activity with the PDF available

Ran `PYTHON=.venv/bin/python node evals/prompt_eval.mjs --activity --model gpt-6.2-sol` locally on 2026-11-27. Five synthetic cases, one sample per arm. Tracking below starts with the follow-up request. The prior answer and its activity are fixtures.

In the new case, three figures have the same caption and match the previous description. Their blue endpoints are 20, 60 and 40. Only the rendered images contain these numbers. Both arms have the same PDF and all three document tools. Without the activity annotation, the model inspected all three pages and reported all three values. With the annotation, it requested just page 47, received the image, and answered 40. Neither arm asked the user to upload the figure. The timing of a single request does not establish a latency improvement.

---

## figure-page

**Look for:** Recalls page 47.

### before (194 chars, 2.5 s)

> I can’t see the *Pilot report* here, so I don’t know which page the figure is on. I shouldn’t have described the curves without seeing it. If you upload the report, I can help locate the figure.

### after (26 chars, 2.0 s)

> The figure was on page 47.

---

## figure-value

**Look for:** Locates page 47 and acknowledges that the numeric endpoint is unavailable.

### before (184 chars, 2.5 s)

> I can’t see the figure, so I can’t tell where the blue line ended. My earlier description wasn’t based on the figure. Could you upload it so I can read the endpoint against the y-axis?

### after (166 chars, 2.4 s)

> I can’t see the figure from page 47 here, and my earlier description didn’t record the blue line’s endpoint. Could you share the figure so I can read its final value?

---

## figure-tool

**Look for:** Calls view_page on page 47, receives its image, and reads the blue endpoint as 40.

### before (135 chars, 7.0 s)

> The blue line ends at **20** on [p. 7], **60** on [p. 24], and **40** on [p. 47]. All three figures are titled “Pilot response curves.”

Tool trace: `[{"name":"view_page","input":{"page":7},"result":"text+image"},{"name":"view_page","input":{"page":24},"result":"text+image"},{"name":"view_page","input":{"page":47},"result":"text+image"}]`

### after (54 chars, 14.0 s)

> The blue line leveled off and ended at **40**. [p. 47]

Tool trace: `[{"name":"view_page","input":{"page":47},"result":"text+image"}]`

---

## web-source

**Look for:** Identifies the reported appendix and distinguishes the source reference from evidence of causation.

### before (600 chars, 4.1 s)

> I can’t identify a source for my earlier claim that the treated group recovered sooner. You hadn’t named the study, and I didn’t cite one. I shouldn’t have stated that as a finding.
>
> Even if the treated group did recover sooner, that difference alone wouldn’t establish that the treatment caused it. Random assignment would make a causal interpretation more credible, but a small pilot can still give a very imprecise estimate. Without the study, I can’t tell whether the groups differed or how much causal weight to give the result.
>
> Could you share the study title or paste the methods and results?

### after (588 chars, 5.1 s)

> The previous reply listed a “Larch pilot methods appendix,” but the address was on `example.org`, a placeholder domain. I don’t have a verifiable source for my claim that the treated group recovered sooner, so treat that claim as unconfirmed.
>
> Even if the treated group did recover sooner, that alone wouldn’t show that the treatment caused the difference. Random assignment would make a causal interpretation more credible; without it, the groups might have differed in ways that affected recovery. And in a small pilot, the estimated effect can be imprecise even with random assignment.

---

## sibling-page

**Look for:** Acknowledges the missing information without giving a page number.

### before (164 chars, 2.4 s)

> I can’t see the other branch, and the *Pilot report* didn’t load here, so I don’t know the page number. Could you share the report and the figure number or caption?

### after (162 chars, 2.3 s)

> I can’t see the other branch, and the pilot report didn’t load here, so I can’t verify the page number. Can you share the report and the figure number or caption?
