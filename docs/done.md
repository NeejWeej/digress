# Done

Ideas from [future.md](future.md) that have been built, kept here as a record of why they look the way
they do. What's still open about them is in future.md under "Loose ends".

## The model reads documents itself

Built and tested (see AGENTS.md, "Document tools"): `search`, `read_pages` and `view_page`, defined once in
`server/doctools.mjs` and run in the browser tab, with one agentic loop per provider (Anthropic API, ChatGPT
function calls, Claude Code through a one-reply MCP endpoint). A document under 200k characters goes whole;
a longer one starts from its table of contents and first 3 pages, and a branch about a passage carries the
pages around it. Each reply shows what it searched, read and looked at.

## Web articles as documents

Built (see AGENTS.md, "Web articles"): paste a link to an article and it opens in reader view as a
Markdown document, images as placeholders you can load.

## Prompts in one place, and themes

Every instruction the page sends the model lives in `web/prompts.js`, so it can be read and changed without
digging through the client. The palette button in the top bar switches between themes (light, dark, match
the device, and several more); each theme is just a set of CSS variables.
