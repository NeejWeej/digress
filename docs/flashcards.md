# Flashcards

Digress can turn what you dug into while reading or chatting into flashcards, and bring them back on a
spaced-repetition schedule so you keep it. They're **off by default, per conversation**: a conversation
where you don't turn them on looks and behaves exactly as if the feature didn't exist.

## Turning them on

Open the cards panel with the cards button in the main pane's header and choose **Turn on for this conversation**. It applies
to that conversation only. **Turn off for this conversation** (at the bottom of the panel) stops new
drafts; cards you already have stay.

## Where cards come from

Once they're on, the model drafts cards on its own from the moments that show what you cared about:

- **A highlight you branched from.** When a side branch about a highlighted passage gets its first answer,
  the model drafts cards from that branch.
- **A snip or page of a PDF.** The same, and the card keeps a copy of the snipped image, so you can review
  it without opening the PDF.
- **A takeaway.** When you carry a takeaway back from a branch, the model drafts cards from it.

You can also ask:

- **Make cards** in a branch's header drafts from that branch.
- **Make cards** in the panel (it says how many threads are new) drafts from everything that changed since
  the last time, thread by thread.

Each draft is one model call, using the same model, context and document as the conversation, so the
cards can check the document rather than guess. It drafts at most three or four cards each time, and fewer
when there's less worth remembering (sometimes none). Cards it already made aren't repeated.

## The inbox

Drafts never go straight into your reviews. They wait in the **Inbox** tab, where you can:

- **Keep** a card (or **Keep all**), and it starts coming up for review;
- **Edit** the front or back first;
- **Delete** the ones that aren't worth it (or **Delete all**).

## Reviewing

The **Review** button in the sidebar shows when cards are due, across all your conversations. In the
panel you can also pick **This conversation** or **All conversations**.

1. You see the front. Think of the answer, then show the back (**Space** or **Enter**).
2. Rate how it went: **Again**, **Hard**, **Good** or **Easy** (keys **1** to **4**). Each button shows
   when you'd see the card next with that rating.

The schedule is [FSRS](https://github.com/open-spaced-repetition/fsrs4anki) (version 4.5, default
weights), the scheduler Anki uses: cards you know well come back less and less often, cards you miss come
back soon.

The **All** tab lists every card, where you can edit one or **suspend** it (it stays, but stops coming up
until you resume it).

## Back to where it came from

Every card remembers where it was made. Its link (**↗** with the branch's name, or **O** while reviewing) opens the
conversation and the branch, scrolled to the reply the card came from, with the passage you highlighted
flashing in its parent. A **← Back to review** pill takes you back to the same card, at the same point.

## Offline

Reviewing works without the server, as long as the page has been opened once over https or on localhost
(where browsers allow it to keep a copy). Your cards and their images are kept in the browser; ratings and
edits made offline are sent, in order, when the server is reachable again. Only flashcards work offline;
chatting needs the server.

## Where they're stored

Cards live in their own collection, `data/cards/` (next to `data/convs/`), not inside conversations, which
is what lets review span all of them. Deleting a conversation doesn't delete its cards; they just can't
link back anymore.
