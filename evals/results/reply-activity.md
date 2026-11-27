# Historical reply activity · paired follow-up eval

Run on 2026-11-27 at 22:52 UTC with `node evals/prompt_eval.mjs --activity --model gpt-6.2-sol`. All eight responses reported the requested model. Each synthetic fixture went through the production context builder twice with the same prompts. The baseline omitted saved activity. Both arms had web and tools disabled.

The annotation let the model recall the figure page and name the reported appendix. Neither figure-value answer invented an endpoint. The baseline incorrectly asserted that the earlier description had no basis in the figure. The annotated answer distinguished prior viewing from present access. The web answer still slightly overstated the relationship by calling the reported appendix “its source.” Both sibling answers acknowledged the missing information. This was one sample per arm per case and did not measure tool use.

## Paired answers


## figure-page

**Look for:** Recalls page 47.

### before (127 chars, 2.2 s)

> I don’t know which page it’s on. I can’t see the report or the figure, and I shouldn’t have described the curves as if I could.

### after (26 chars, 2.5 s)

> The figure was on page 47.

---

## figure-value

**Look for:** Locates page 47 and acknowledges that the numeric endpoint is unavailable.

### before (184 chars, 2.4 s)

> I can’t see the figure, so I can’t tell where the blue line ended. My earlier description wasn’t based on the figure. If you upload it with the y-axis visible, I can read the endpoint.

### after (182 chars, 2.6 s)

> I can’t see the figure right now, and my earlier description didn’t record the blue line’s final value. If you share the figure from page 47, I can read the endpoint from the y-axis.

---

## web-source

**Look for:** Identifies the reported appendix and distinguishes the source reference from evidence of causation.

### before (593 chars, 4.0 s)

> I didn’t cite a source, and nothing in this conversation identifies the study. I shouldn’t have stated that the treated group recovered sooner as a fact.
>
> Even if the study reported faster recovery in the treated group, that difference alone wouldn’t establish causation. Random assignment would strengthen the case that the treatment made the difference, but a small pilot study can still leave considerable uncertainty about the size of the effect or whether there was one at all.
>
> If you share the study title or paste the methods and results, I can assess what the study actually supports.

### after (552 chars, 4.9 s)

> The previous reply listed the **Larch pilot methods appendix** as its source. I can see that reference, but not the appendix itself, so I can’t verify that it supports the claim.
>
> “The treated group recovered sooner” describes a difference; it doesn’t show that the treatment **caused** it. If participants were randomly assigned to groups, that would strengthen a causal interpretation, though a small pilot could still give an imprecise estimate. Without knowing how the groups were formed, the earlier reply shouldn’t be read as a causal conclusion.

---

## sibling-page

**Look for:** Acknowledges the missing information without giving a page number.

### before (186 chars, 2.8 s)

> I can’t see the other branch, and the *Pilot report* didn’t load here, so I don’t know the page number. Can you share the report and the figure number or caption so I can help locate it?

### after (140 chars, 2.4 s)

> I can’t see the other branch, and the *Pilot report* didn’t load here. Could you share the figure number or caption so I can help locate it?
