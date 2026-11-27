# Saved web references on demand

On 2026-11-27, six paired follow-ups compared the inline builder at `1e0acd8` with the compact markers and `list_sources` tool. Both arms used the same synthetic histories and `gpt-6.2-sol` through the local Digress server. Web search was off. One sample per arm in this final run.

Both arms answered all six cases as expected. The lookup arm used exactly one call after a gap and one for the earlier of two studies. In both cases the model explicitly selected S1. Deterministic tests separately exercise the omitted argument. The explicit citation, sibling branch and two unrelated questions triggered no calls.

| Follow-up | Initial message characters, inline → lookup | Final-round input tokens, inline → lookup | Provider rounds, inline → lookup |
|---|---:|---:|---:|
| source-gap | 1,379 → 785 | 5,573 → 5,701 | 1 → 2 |
| source-earlier | 1,942 → 754 | 5,708 → 5,698 | 1 → 2 |
| source-cited | 1,123 → 529 | 5,530 → 5,455 | 1 → 1 |
| source-sibling | 270 → 270 | 5,327 → 5,327 | 1 → 1 |
| source-unrelated | 1,062 → 468 | 5,514 → 5,439 | 1 → 1 |
| source-verbose | 4,380 → 469 | 6,341 → 5,439 | 1 → 1 |

Message characters measure the serialized message array before generation. The provider’s final-round input count includes system text and tool overhead, plus the tool result after retrieval. Multi-round input counts here describe only the last round and cannot be used as total billed tokens. The twenty-link control saved 902 input tokens on a single-round answer. The actual source questions incurred an extra round. These fixtures establish the tradeoff for these requests; production savings depend on how often follow-ups need retrieval.

Two earlier five-case development runs also selected the correct list and avoided unnecessary calls. With the longer tool description, the second run spent 17 extra input tokens on an unrelated question after eight links. That result motivated the compact schema and the twenty-link control.

Reproduce the source comparison with `node evals/prompt_eval.mjs --sources --model gpt-6.2-sol`. Reproduce the independent five-case activity regression with `PYTHON=.venv/bin/python node evals/prompt_eval.mjs --activity --model gpt-6.2-sol`. In that regression, the annotated visual follow-up called only `view_page(47)` and read **40**. The arm without the annotation opened three pages. With the PDF unavailable, both declined to invent the endpoint.

## Recorded source comparison

### source-earlier

**Inline**

> The first study, Larch: [Calibration appendix](https://archive.example.org/papers/r7x-p14).

**Lookup**

> The first study, **Larch**, listed its calibration appendix at https://archive.example.org/papers/r7x-p14.

Tool trace: `[{"input":{"reply":"S1"},"result":"S1"}]`

### source-gap

**Inline**

> The Larch study’s [Calibration appendix](https://archive.example.org/papers/r7x-p14) was listed at `https://archive.example.org/papers/r7x-p14`.

**Lookup**

> The [Larch study’s calibration appendix](https://archive.example.org/papers/r7x-p14) was listed at `https://archive.example.org/papers/r7x-p14`.

Tool trace: `[{"input":{"reply":"S1"},"result":"S1"}]`

### source-cited

**Inline**

> [Calibration appendix](https://archive.example.org/papers/r7x-p14)

**Lookup**

> [Calibration appendix](https://archive.example.org/papers/r7x-p14)

### source-sibling

**Inline**

> I can’t see your other branch, so I don’t know the calibration appendix URL. Could you paste the message that mentioned it?

**Lookup**

> I can’t see your other branch, so I don’t know the URL. Could you paste the passage that mentions the calibration appendix?

### source-verbose

**Inline**

> Random assignment means using chance to decide which study group each participant joins, rather than letting participants or researchers choose.

**Lookup**

> Random assignment means using chance to decide which group each study participant joins, rather than letting participants or researchers choose.

### source-unrelated

**Inline**

> Random assignment means using chance, rather than anyone’s choice, to decide which group each study participant joins.

**Lookup**

> Random assignment means using chance to decide which study group each participant joins.

## Activity regression

## figure-page

**Look for:** Recalls page 47.

### before (206 chars, 2.7 s)

> I can’t tell which page it’s on. The pilot report didn’t load for me, so I couldn’t see the figure. I shouldn’t have described the curves as if I had. If you upload the report, I can help locate the figure.

### after (8 chars, 1.7 s)

> Page 47.

---

## figure-value

**Look for:** Locates page 47 and acknowledges that the numeric endpoint is unavailable.

### before (184 chars, 2.2 s)

> I can’t see the figure, so I can’t tell what value the blue line ended at. My earlier description wasn’t verified. Could you upload the figure or crop the blue endpoint and the y-axis?

### after (172 chars, 2.3 s)

> I can’t see the figure right now, and my earlier description didn’t record the blue line’s final value. If you share the figure from page 47, I can read it from the y-axis.

---

## figure-tool

**Look for:** Calls view_page on page 47, receives its image, and reads the blue endpoint as 40.

### before (189 chars, 6.3 s)

> The blue line ends at **20** on [p. 7], **60** on [p. 24], and **40** on [p. 47]. All three figures are titled “Pilot response curves,” so the value depends on which page you’re looking at.

Tool trace: `[{"name":"view_page","input":{"page":7},"result":"text+image"},{"name":"view_page","input":{"page":24},"result":"text+image"},{"name":"view_page","input":{"page":47},"result":"text+image"}]`

### after (54 chars, 5.2 s)

> The blue line leveled off and ended at **40** [p. 47].

Tool trace: `[{"name":"view_page","input":{"page":47},"result":"text+image"}]`

---

## web-source

**Look for:** Identifies the reported appendix and distinguishes the source reference from evidence of causation.

### before (534 chars, 3.5 s)

> I didn’t cite a source, and I can’t identify the study from this conversation. I shouldn’t have stated that the treated group recovered sooner as a fact.
>
> Even if the study reported faster recovery in the treated group, that difference alone wouldn’t show that the treatment caused it. Random assignment would make a causal conclusion more credible, but a small pilot study can still leave a lot of uncertainty about the size of the effect—or whether there was one at all.
>
> Can you share the study title or paste the relevant passage?

### after (430 chars, 7.6 s)

> The saved source was the [Larch pilot methods appendix](https://example.org/larch/appendix).
>
> My earlier answer reported a difference between the groups, not proof that the treatment caused it. I can see the saved reference, but not enough about how the groups were formed to tell whether the study supports a causal conclusion. Random assignment would help distinguish a treatment effect from differences that were already there.

Serialized message characters: 453.

Tool trace: `[{"input":{"reply":"S1"},"result":"S1"}]`

---

## sibling-page

**Look for:** Acknowledges the missing information without giving a page number.

### before (175 chars, 2.4 s)

> I can’t see the other branch, and the pilot report didn’t load here. Can you paste the figure caption or the relevant excerpt from that branch so I can help identify the page?

### after (149 chars, 2.7 s)

> I can’t see the other branch, and the *Pilot report* didn’t load here. Could you share the PDF and tell me which figure it was, by number or caption?
