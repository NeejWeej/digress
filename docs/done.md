# Done

Ideas from [future.md](future.md) that have been built, kept here as a record of why they look the way
they do. What's still open about them is in future.md under "Loose ends".

## The model reads documents itself

Built and tested (see agents/model-context.md, "Document tools"): `search`, `read_pages` and `view_page`, defined once in
`server/doctools.mjs` and run in the browser tab, with one agentic loop per provider (Anthropic API, ChatGPT
function calls, Claude Code through a one-reply MCP endpoint). A document under 200k characters goes whole;
a longer one starts from its table of contents and first 3 pages, and a branch about a passage carries the
pages around it. Each reply shows what it searched, read and looked at.

## Web articles as documents

Built (see agents/documents.md, "Web articles"): paste a link to an article and it opens in reader view as a
Markdown document, images as placeholders you can load.

## Redo, edit and other versions

The conversation is a tree of messages, and threads are just a way of cutting it into runs. Redo and Edit
never replace an answer in place: they always ask again as another version (an `alt` thread starting where
the question did, open beside the original so you can compare), and "Use this version" swaps which one the
conversation goes on with. The swap is built from two general operations, split and join (`web/threads.js`),
checked by a randomized test that no message's context ever changes. Branches can be hidden from the tree,
and "Move what follows into a branch" / "Start over" build on the same operations.

## Prompts in one place, and themes

Every instruction the page sends the model lives in `web/prompts.js`, so it can be read and changed without
digging through the client. The palette button in the top bar switches between themes (light, dark, match
the device, and several more); each theme is just a set of CSS variables.

## Several devices, and replies that survive a locked phone

A conversation carries a version number; a save says which version it started from, and if another device
saved in between, the page merges the two (`ThreadOps.merge` in `web/threads.js`): what only one side changed
is taken, deletions win, and when both went on from the same point the later one becomes another version. The
result must pass `check()` and every message must see exactly what it saw before, or this device's version is
kept as a copy instead. A randomized test runs thousands of two-device cases. Layout is per device, and canvas
views are how you share one on purpose. Tabs catch up when they come back to the foreground.

Replies are runs on the server (`server/runs.mjs`): a dropped connection only detaches the page, which
reconnects and replays from the line it had; a reply that finishes with nobody watching is written into its
conversation; one nobody comes back to within 10 minutes is stopped and saved as cut off, with Continue.

## Export, share and import

Conversations export in the browser as compressed `.digress` archives (with checkboxes to include the
attached document and the conversation's flashcards, which arrive in the inbox without review history),
as readable Markdown (`.md`), or as Anki-ready flashcards (`.csv`). Importing validates structure with
`ThreadOps.check` and assigns fresh ids; `.digress` files can also be opened directly on the demo site
by someone without Digress installed.

## Flashcards, folders, Activity and Google Gemini

Optional per-conversation flashcards draft from highlights, snips, takeaways and `suggest_card` into an
inbox, schedule reviews with FSRS (including offline review queued in `localStorage`), quote their source
with jump-back, and support AI-assisted `Fix…`. Conversations can be organized into folders (each with an
optional starting system prompt), tracked in the Activity stats page, and run against Google Gemini
alongside Claude and ChatGPT.

## Startup, PDF memory and runtime performance

Static assets and large JSON responses are gzip-compressed with weak `ETag`/`304`; the sidebar fetches
cached metadata via `GET /api/store/convs?meta=1` instead of full conversation JSON. MathJax loads lazily
only when math is rendered; `pdf.js` runs in a real Web Worker from `/lib/`, renders visible pages
immediately while extracting text in the background, evicts off-screen page canvases/text layers, and
destroys previous PDF instances on switch. Streaming caches `highlight.js` output, canvas reuses cached
message DOM, `MiniSearch` updates incrementally per conversation, and CSS lives in `web/styles.css`.

## SQLite storage and server-side search

The server keeps everything in one SQLite database (`data/digress.db`, Node's built-in `node:sqlite`, so still
no dependencies) instead of a JSON file per conversation, card and layout; older `data/` folders are imported on
first start and moved to `data/_legacy_json/`. Search runs on the server with FTS5 (BM25 ranking, with a
typo-tolerant fallback through `fts5vocab`), advertised by `search:true` in `/api/health`; the demo, which has no
server, keeps using `MiniSearch` in the browser.
