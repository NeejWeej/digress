# Flashcards

Digress can turn what you dug into while reading or chatting into flashcards, and bring them back on a
spaced-repetition schedule so you keep it. They're **off by default, per conversation**: a conversation
where you don't turn them on looks and behaves exactly as if the feature didn't exist.

## Turning them on

Open the cards panel with the cards button in the main pane's header and choose **Turn on for this conversation**. It applies
to that conversation only. **Turn off for this conversation** (at the bottom of the panel) stops new
drafts; cards you already have stay.

Two switches, shown above **Turn on** (so you choose before anything can happen) and afterwards at the bottom of
the panel, decide how cards come without your asking. Both are on by default:

- **Draft in the background**: drafts after a highlight's or clip's first answer and after a takeaway (a model call
  each). Off, nothing is drafted on its own; useful for a conversation like your Twitter clippings, where most
  branches aren't worth cards but a few are.
- **Let the model suggest cards**: the model is offered `suggest_card` while it answers. Off, it isn't, and a
  suggestion from a reply already under way is turned down.

Asking always works while cards are on (**Cards** on a branch, **Make cards**, **Draft more**), and review, the
inbox and Fix… are the same either way.

## Where cards come from

Once they're on, the model drafts cards on its own from the moments that show what you cared about (the first three with **Draft in the background**, the last with **Let the model suggest cards**):

- **A highlight you branched from.** When a side branch about a highlighted passage gets its first answer,
  the model drafts cards from that branch.
- **A snip or page of a PDF, or an image in a text document.** The same, and the card keeps a copy of the
  snipped image, so you can review it without opening the document.
- **A takeaway.** When you carry a takeaway back from a branch, the model drafts cards from it.
- **The model, while it answers.** In a conversation with flashcards on, the model has a tool,
  `suggest_card`, and can add a card whenever it judges something has landed: in the main thread or a branch,
  on its own judgment rather than on a schedule. A toast says when it did (with **Open**), and the card points
  back to that reply. It can't suggest the same question twice in a conversation, and it isn't offered at all
  where flashcards are off.

You can also ask:

- **Cards** in a branch's header drafts from that branch: the first time from all of it, after that only from
  what's new since its cards were last drafted. While it works the button says **Drafting…** (and can't be
  pressed twice); a toast says when the cards are in, with **Open**. With nothing new, the button (which then
  counts the branch's cards) opens that branch's cards instead, where **Draft more** asks for more on purpose.
- **Make cards** in the panel (it says how many threads are new) drafts from everything that changed since
  the last time, thread by thread.

Each draft is one model call, using the same model, context and document as the conversation, so the
cards can check the document rather than guess. It drafts at most three or four cards each time, and fewer
when there's less worth remembering (sometimes none). Cards it already made aren't repeated. With each card
it copies the sentence the answer rests on, word for word from the conversation or the document; Digress
keeps it only if it really is there, so a card either shows its true source or none.

## The inbox

Drafts never go straight into your reviews. They wait in the **Inbox** tab, where you can:

- **Keep** a card (or **Keep all**), and it starts coming up for review;
- **Edit** the front or back first;
- **Delete** the ones that aren't worth it (or **Delete all**).

## Reviewing

The **Review** button in the sidebar shows when cards are due, across all your conversations. In the
panel, pick **All conversations** or any one conversation with cards; each is listed with how many are due
and new, most due first.

1. You see the front. Think of the answer, then show the back (**Space** or **Enter**).
2. With the answer comes where it came from: the quoted sentence (and its page, if it's from the document).
3. Rate how it went: **Again**, **Hard**, **Good** or **Easy** (keys **1** to **4**). Each button shows
   when you'd see the card next with that rating.

### When a card is off

With the answer showing, two quiet buttons sit beside **Open in conversation**:

- **Edit** (**E**): change the front or back yourself. The card keeps its schedule.
- **Fix…** (**F**): something's wrong and you'd like the model to sort it out. Tap what's off (*Wrong*, *Unclear*,
  *Too vague*, *Two questions in one*, *Answer too long*), add a note if you like, and **Send**
  (⌘/Ctrl+Enter). The card leaves review and the model checks it against the conversation and the document (the
  same context it drafted from; for a card from a conversation that isn't open, that branch's messages). A toast
  says when its answer is in the **Inbox**, shown under the card as it was:
  - **Rewrite** or **Split** (two cards, when it asked two things): editable, then **Accept** or **Keep original**.
    If only the wording changed the card keeps its schedule; if the answer itself changed it starts over as a new card.
  - **Delete**: why it isn't worth keeping; delete it or keep it.
  - **It's right**: the model can tell you the card was fine, and why, citing the source. **Keep it** puts it back.

  It needs the model, so it's hidden offline. A fix whose page was closed before it finished offers **Try again**.

Not in the mood for a card? **Skip** (or **S**) goes on to the next one without rating it; the skipped card
comes back at the end of the session. Nothing about it changes.

After the last card, a summary says how many you reviewed, what share you recalled (anything but **Again**), how
many come back soon, and when the next card is due, with a bar of your ratings and a link to **Activity**.

The schedule is [FSRS](https://github.com/open-spaced-repetition/fsrs4anki) (version 4.5, default
weights), the scheduler Anki uses: cards you know well come back less and less often, cards you miss come
back soon.

The **All** tab lists every card, where you can edit one or **suspend** it (it stays, but stops coming up
until you resume it).

## Back to where it came from

Every card remembers where it was made. **Open in conversation** under the answer (or **O** while reviewing; **↗**
with the branch's name in the lists) opens the conversation at the quoted sentence, highlighted: in its
reply, or on its page of the document. A card without a quote opens the branch at the reply it came from, with
the passage you highlighted flashing in its parent. A **← Back to review** pill takes you back to the same card, at the same point.

## Sharing and Anki

Exporting a conversation (the ⤓ on its row in the sidebar) can include its flashcards in the `.digress` file. Whoever
opens it gets them in their **Inbox**, as new cards: your schedule and reviews stay with you. **Flashcards for Anki**
saves your kept cards as a CSV that Anki imports as is (File → Import): front, back, the sentence the card came from,
and a tag for the conversation.

## Offline

Reviewing works without the server, as long as the page has been opened once over https or on localhost
(where browsers allow it to keep a copy). Your cards and their images are kept in the browser; ratings and
edits made offline are sent, in order, when the server is reachable again. Only flashcards work offline;
chatting needs the server.

Reviewing never waits on the network: a rating is kept in the browser at once and the next card shows straight
away, while the change is sent in the background (each try gives up after a few seconds, so a network that's
there but goes nowhere can't stall it). If it can't get through, a toast says so once and the review shows how
many changes are waiting on this device. They're sent when the connection comes back, when you return to the
tab, or on the next try (every 30 seconds) and the note goes away. Opening the flashcards uses this device's copy
if the server takes more than a couple of seconds to answer.

## Where they're stored

Cards live in their own table in `data/digress.db`, beside conversations rather than inside them, which
is what lets review span all of them. Deleting a conversation doesn't delete its cards unless you tick **Also delete its N flashcards** when you
move it to the Trash (the dialog lists them, folded away in a box that scrolls). That's the only time it asks:

- Ticked: the cards leave review straight away. Restore the conversation and they're back, schedule and all.
  Delete for good, or the automatic cleanup after 7 days, deletes them with it.
- Unticked: they stay in review. While the conversation is in the Trash, a card from it says so, with
  **Restore it**. Once it's deleted for good, the card says where it came from was deleted, since it can't
  take you back there any more; keep it or delete it.

Deleting a branch offers the same checkbox for the cards made from it and its sub-branches.
