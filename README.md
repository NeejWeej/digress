# <img src="docs/media/logo.svg" alt="" width="36" height="36" align="top"> Digress

**A branching chat for learning.** Highlight any words in an answer, ask about them, and the reply opens in its own thread beside the one it came from. Follow a tangent as far as you like, then come back to exactly where you were.

https://github.com/user-attachments/assets/4435b865-4ed3-46e9-b086-07de01d6515c

**[Try the demo](https://neejweej.github.io/digress/)** in your browser, nothing to install. It's the real app with a sample reading and conversation, but no model behind it: the sample's replies were written in advance, other questions get the closest passages of the document, and everything you do stays in your browser. To ask real questions, [set it up](docs/setup.md) with your Claude or ChatGPT account.


## Why branch?

Learning something hard is not a straight line. A good explanation raises three new questions, and in a normal chat each one pushes the original thread further up the screen until you lose it. You either stop asking, or you end up with one long scroll where the main idea and every side question are tangled together.

Digress keeps them apart. Every question you ask about a passage becomes a **branch** that remembers the exact words it came from. The main thread stays readable, each side question gets a full, focused answer, and the shape of the conversation shows you how the ideas connect.

![Digress in Columns view: the main thread on the left, a branch from one of its sentences, and a branch of that branch, whose takeaway has been carried back into its parent](docs/media/columns.png)

## Highlight → branch

![Selecting a phrase in an answer, typing a question, and a new branch opening beside it](docs/media/branching.gif)

Select any text in a reply and type a question (or pick a quick one: *Explain simpler*, *Example*, *Why?*, *Go deeper*). The answer opens in a new pane next to its parent.

- The model sees the whole conversation up to that point, plus the passage you picked, so the answer is about *that* sentence in *that* context.
- A numbered marker in the parent shows where each branch starts. Click it to open the branch; **Show in source** in the branch jumps back to the exact words and flashes them.
- Branches can branch again, as deep as you need. The sidebar shows the whole tree. Each pane's header says how many branches come off it; click that number for a list of just those, nested, and click one to open it.

## Takeaways: carry it back

When a branch has answered your question, press **Takeaway**. Digress writes two to four bullets of what you learned and adds them to the end of the parent thread, optionally focused on what you ask for. The main thread then builds on them, so your understanding accumulates instead of staying scattered across tangents. The branch's name in a takeaway takes you to the last reply it saw; if you keep going in the branch afterwards, a line there marks where the takeaway ends, since what's below it isn't in the takeaway.

## Fix a reply: redo, edit, other versions

Picked the wrong model, or asked the wrong thing? **Redo** asks again with the model and effort selected now, and the pencil on a question lets you **edit** it. On the latest reply, with nothing hanging off it, the new answer simply replaces the old one. Further back, it becomes **another version**: the question asked again from the same point, in its own pane next to the original, so you can compare. Nothing that was there changes. The question shows how many versions it has, and **Use this version** makes the conversation go on with the one you prefer. The other one stays, and you can switch back. The same goes for **Retry** on a reply that ended in an error: once the conversation has gone on from it, Retry asks again as another version rather than swapping out what later answers built on (and a cut-off reply there offers no **Continue**). Branches you're done with can be hidden from the tree without deleting them.

While a reply is being written you see what it's doing (searching, reading pages) and for how long. Under each reply: the model and effort it used, and what it had of the document (all of it, or which pages it started from and read).

## Read with a document

![A PDF of lecture notes on the left, a summary with page links in the middle, and a branch about one highlighted sentence on the right](docs/media/document.png)

Start from a **PDF, Markdown or text file, or a web article**: upload one, paste text, or paste a link and the server downloads it. A blog post or article opens in reader view (just the article, as Markdown, nothing on the page runs). Its images stay as placeholders until you load them. The document opens beside a main thread about the whole thing, and the model has its text, with page numbers. In a long PDF, click **Page N** in its header to jump to any page.

The model can also read the document itself. It can search it, read pages and look at a page as an image (for figures and tables), as many times as a question needs. A document up to about 200k characters (around 100 dense pages) is sent whole. For a longer one, the model starts from the table of contents and the first pages, then reads what the question needs. Under each reply you see what it read, with links to the pages. These tools only read the open document: nothing else on your machine.

- Highlight any passage in the PDF to branch about just that part. Markers sit in the margin of the page.
- Page references in answers, like [p. 2], are links that scroll the document there.
- Ask about a whole page, or snip a figure, table or equation, and the model gets a sharp image of it, rendered from the PDF.

Want a clean slate? **Start over** in the main thread's header empties main, so the next question starts from just the document. Nothing is lost: what was in main becomes another version of it (under Branches, with its branches and flashcards), and **Use this version** brings it back. Branches off the document itself stay where they are. For a completely separate start, **New conversation from this document** (in the document's header) opens a fresh conversation on the same file and leaves this one as it is.

You can also paste or drop screenshots into any message box: a plot from your notebook, a slide, a whiteboard photo.

## Remember it: flashcards (optional)

Turn on flashcards for a conversation and the model drafts cards from what you dug into: each highlight you branched from, each snip, each takeaway. They wait in an inbox until you keep, edit or delete them; **Make cards** drafts more from whatever changed since last time, and each branch has its own **Cards** button. Kept cards come back for review on a spaced-repetition schedule (FSRS), and each card links back to where it came from: the branch opens at the reply the card was made from, with the passage you highlighted flashing, and **Back to review** returns you to the same card (press **O** while reviewing). **Skip** (**S**) puts a card to the back of the session without rating it. Reviewing works offline too and never waits on the network: the page and your cards stay available in the browser, a rating is kept at once, and reviews sync in the background when the server is reachable again (the review shows how many are waiting). Conversations where you don't turn it on look exactly as before. How it all works: [docs/flashcards.md](docs/flashcards.md).

## Three ways to see it

Switch views from the top bar at any time; the conversation is the same.

- **Columns:** threads side by side, each pane next to the one it branched from, with a line connecting each branch to its source.
- **Rows:** the same panes stacked top to bottom, each at full width.

Drag the handle after a pane to resize it. Hold it at the edge of the window and the pane keeps growing while the panes scroll along, so even the last pane can be wider (or, in Rows, taller) than the screen. Whenever the pane reaches the width that exactly fills the window ("Fits the window"), by hand or growing, it snaps there: let go to keep that size, pull a little further or keep holding at the edge and it carries on.
- **Canvas:** the whole tree as cards on an infinite canvas. Pan, zoom, move cards, snap them to an edge or keep one stuck to the screen while you move around. Works with touch, too. Drag the background to pan and scroll to zoom; drag a card by its title to move it, or to an edge of the screen to dock it there. **Alt**+scroll over a card zooms just that card, and **Space** reads the selected card full screen.

<img src="docs/media/canvas.png" alt="The same conversation as cards on a canvas in the dark theme, one card expanded to read in place, connected by lines from each highlight to its branch" width="700">

With a document, its card's **Expand** button fills the canvas with the document itself, and dragging the card to an edge (or **Side** once expanded) docks it to that side with the canvas beside it: pages at full sharpness, and highlighting, snips, zoom and page jumps work as in Columns. Following a branch marker from the expanded document moves it to the side, to make room for the branch's card. **Canvas views** save an arrangement of the canvas under a name (the **Views** button in its corner), so you can switch between setups and open the same one on another device. Without them, each device keeps its own canvas and pane layout, since what fits on a laptop doesn't fit on a phone.

Answers render Markdown, code with syntax highlighting, LaTeX math and Mermaid diagrams. A tall diagram fits in about 60% of the window's height, whole. One too small to read has a zoom button under it: **+ / − / Fit** and four arrows (hold one to keep going), right there in the chat; once zoomed in, you can also drag it around. Scrolling over a diagram still scrolls the conversation. On a phone or tablet, pinch to zoom the page instead. Panes collapse to thin strips, **Focus** hides everything else, and each pane keeps its own zoom. **Zen** (<kbd>⌘.</kbd> / <kbd>Ctrl+.</kbd>) hides the top bar and sidebar too, for reading a paper with nothing else on screen; branching works as usual, and <kbd>⌘B</kbd> / <kbd>Ctrl+B</kbd> (or the tab at the left edge) still brings the sidebar out over the panes. Collapsed strips can be dragged to reorder them, like the grip on an open pane. Ask in a branch, then minimize it (or fold its card on the canvas, or close it) and keep reading: while the reply is written its strip, card and row in the sidebar show three dots, and once it's done they say **Ready** until you open it. Any pane can be closed, main and the document included; their rows at the top of Branches in the sidebar bring them back. In a long document, the ribbon button in its corner marks where you got up to (no chat attached); it syncs with the conversation, and opening it again offers to take you back. Drag the ribbon to move it. Under each reply, a quiet line says how full the model's context was when it answered ("52k / 1M context"), from the provider's own count. On a narrow window or a phone, whatever doesn't fit in the top bar moves into a ⋯ menu; a narrow pane puts its buttons on a second row rather than hiding any (zoom included). The palette button, **Appearance**, switches themes: light and dark (or match your device), plus Sand, Sea glass, Rosé Pine Dawn and Moon, Solarized Light, Everforest (light and dark), Catppuccin Latte and Mocha, Kanagawa, Gruvbox, Flexoki (light and dark), Shades of Purple and Nord. The menu has foldable **Light**, **Dark** and **PDF pages** sections (the one with your current theme opens; folded ones show a dot per choice) and scrolls on a small screen. Under **PDF pages**, PDFs can stay as printed or turn **Dark** (light text on dark pages; photos look like negatives), **Dim** or **Sepia**, or **Match the theme** (dark pages with a dark theme). It only changes how pages look to you: what the model gets from a page is the original. Below them, **Lines between panes** turns off the lines from each branch to where it came from in Columns and Rows (they stay in Zen unless you do; the canvas keeps its own), and **Fit to this screen** undoes the pane widths and zoom levels in the open conversation. Each device keeps its own layout of a conversation; opening one on a new device (a phone after the desktop) takes the other device's open panes, view and canvas arrangement, but not its pane widths, zoom levels or docked cards, so it fits the smaller screen.

Not sure how something works? The **?** beside *How it works* in the sidebar opens **Ask about Digress**: a chat that has this README and the rest of Digress's documentation, using the model you picked. It is never saved.

## Search everything

<kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> searches every conversation at once: questions, answers, highlights, takeaways and documents. It is a full-text index (BM25) that tolerates typos and takes you to the words it found, highlighted, inside the message or document page. A **Back** chip then returns you to where you were, even in another conversation. Press <kbd>Tab</kbd> in the search box to look only in this conversation or only in one thread, or click the magnifier at the bottom right of a pane to search just that thread. Half remember something but not the words? Choose **Describe it instead** under the results: the model suggests the words you probably used (it gets what you typed and your conversations' titles, never their text), and if that isn't enough you can let it pick from short snippets of the best matches. Pin the conversations and branches you keep coming back to, and archive the rest. Deleting a conversation moves it to **Trash** at the bottom of the sidebar, on every device: restore it within 7 days, or it's deleted for good then (or right away with **Delete for good**). Its document goes with it only if no other conversation uses that file (moving it to Trash and **Delete for good** both say which it is, by name), and its flashcards stay in your review unless you tick **Also delete its flashcards** when you move it to the trash (the dialog lists them, folded away). Ticked, they leave review at once and come back if you restore it; it's asked once, and Delete for good or the 7-day cleanup does what you chose. Deleting a branch offers the same for its cards. A card whose conversation is in the trash says so in review, with **Restore**, and one whose source was deleted says it can't take you back any more. Two conversations with the same name show the day each started. Once you have a document conversation, **All · Docs · Chats** above the list shows just one kind. Double-click a title in the sidebar to rename it.

## Keyboard shortcuts

⌘ on a Mac, Ctrl elsewhere. The list is also under **How it works** in the sidebar.

| Keys | What it does |
| --- | --- |
| <kbd>⌘K</kbd> | Search (in search: <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd> open a result, <kbd>⌘Enter</kbd> opens it and keeps searching, <kbd>Tab</kbd> switches everywhere / this conversation / this pane) |
| <kbd>⌘B</kbd> | Show or hide the sidebar (in Zen too, over the panes) |
| <kbd>⌘.</kbd> | Zen |
| <kbd>⌘'</kbd> | Canvas, or back to the panes (Columns or Rows, whichever you had) |
| <kbd>⌘⇧'</kbd> | Switch Columns and Rows |
| <kbd>⌘\\</kbd> | Collapse the pane you're in to a strip, or expand it again (on the canvas: expand or shrink the selected card) |
| <kbd>⌘⇧\\</kbd> | Close the pane you're in; the toast's **Undo** brings it back |
| <kbd>Enter</kbd> / <kbd>⇧Enter</kbd> | Send / a new line |
| <kbd>Esc</kbd> | Close the question box; leave Focus |
| <kbd>Space</kbd> | On the canvas: read the selected card full screen (again or <kbd>Esc</kbd>: back) |
| <kbd>⌘⌥←</kbd> <kbd>⌘⌥→</kbd> <kbd>⌘⌥↑</kbd> <kbd>⌘⌥↓</kbd> | On the canvas: dock the selected card left, right, full screen; undock it |
| <kbd>⌥</kbd>+scroll | On the canvas: zoom one card |
| <kbd>Space</kbd> / <kbd>1</kbd>–<kbd>4</kbd> / <kbd>S</kbd> / <kbd>O</kbd> | Reviewing flashcards: show the answer / rate it / skip it / open where it came from |
| <kbd>⌘</kbd>+click | A conversation in the sidebar: open it in a new window |

The ⌘ shortcuts work while you're typing. "The pane you're in" is the one you last clicked, typed in or scrolled; with more than one pane open, it has a faint outline.

## Models: Claude and ChatGPT, on the plans you already pay for

Digress needs no API key if you already have a subscription.

- **ChatGPT, with your ChatGPT plan (Plus or Pro).** Run `npm run chatgpt -- login` once and sign in with your ChatGPT account. Digress uses OpenAI's *Sign in with ChatGPT* for open-source apps: it registers as its own app, calls the Responses API with `store: false`, and usage counts against your plan. Your plan's models appear in the model picker.
- **Claude, with your Claude subscription (Pro or Max).** If the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI is installed and signed in, Digress runs it for each reply with all of its own tools turned off and none of your Claude Code setup loaded (only web search when you ask, and the document tools above), so it answers on your plan.
- **Claude, with an Anthropic API key.** Put `ANTHROPIC_API_KEY` in `.env` and Digress calls the API directly, with prompt caching for long documents.

Claude and ChatGPT can be connected at the same time. Pick a model per message from the top bar (each reply shows which model wrote it), along with how much effort it should put in.

## Web search, only when you ask

Models answer from what they know unless you turn on **Web** in the top bar. Then they may search the web, link the pages they use right in the answer, and the reply lists its sources. It is search only: the search runs on Anthropic's or OpenAI's side, and the model gets no tool that fetches pages or runs anything on your machine. With Claude Code and ChatGPT, switching Web on or off doesn't make the model reread the whole conversation: the tools it's offered stay the same and only whether search may run changes, so the provider's prompt cache keeps working (each question asked with Web on is marked as such).

## The prompts are yours to change

Everything Digress tells the model (the tutor instructions, how branches, takeaways and flashcards are asked for, how documents are introduced) is in one file, [`web/prompts.js`](web/prompts.js). Edit it and reload.

## On several devices

Open it from your laptop and your phone (see [Using it from other devices](docs/remote-access.md)) and they stay in step. Switch back to a tab and it picks up whatever you did elsewhere, without a reload; the layout stays as it was on that device. If both changed the same conversation, the two are combined and nothing is lost: when both asked from the same point, the later question becomes another version.

A reply keeps going on the server when your phone locks, you switch apps or conversations, or the page reloads, and the page picks it back up when you return. If nothing comes back for 10 minutes it stops, keeps what it wrote, and offers **Continue**.

## Your data stays on your machine

Digress is one HTML file (`web/index.html`) and a small Node server with no dependencies (`server/server.mjs`). Conversations and documents are plain JSON and files in `data/`; the only thing that leaves your machine is what you send to the model you picked. The server listens on `127.0.0.1`, has no accounts, and refuses requests from other websites.

## Quick start

Needs Node 18 or newer, plus at least one model connection from above.

```sh
git clone https://github.com/NeejWeej/digress && cd digress

# connect a model (any or all):
npm run chatgpt -- login         # ChatGPT, with your ChatGPT plan
claude                           # Claude Code, signed in with your Claude plan (then /exit)
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env   # or an Anthropic API key

npm start                        # → http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787>, click **New conversation** or **New from a document**, and ask something.

## More

- [Setup and configuration](docs/setup.md): each model connection in detail, `.env` options, documents from links, where data lives.
- [Using it from other devices](docs/remote-access.md): Tailscale, running it as a service, using it on your phone.
- [Development](docs/development.md): tests, live reload, regenerating these screenshots. [AGENTS.md](AGENTS.md) explains how the code fits together.
- [Future directions](docs/future.md): ideas for later, like sub-agents that explore and codebases as a source.
- [Flashcards](docs/flashcards.md): turning them on, where cards come from, the inbox, reviewing, offline.
- [Done](docs/done.md): ideas from that list that have been built.

## License

MIT

Developed with Claude Opus 5.5.
