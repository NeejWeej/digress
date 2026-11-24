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
replace a reply in place when nothing depends on it; otherwise they ask again as another version (an `alt`
thread starting where the question did), and "Use this version" swaps which one the conversation goes on
with. The swap is built from two general operations, split and join (`web/threads.js`), checked by a
randomized test that no message's context ever changes. Branches can be hidden from the tree.

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
