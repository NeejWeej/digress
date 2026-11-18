# Future directions

Ideas that aren't built yet, written down so they aren't lost. What's already built is in [done.md](done.md).

## Loose ends

- **Document tools:** a `view_area` tool (a sharp crop of part of a page) if small chart text turns out to
  be misread.
- **Prompt cache on the ChatGPT plan route** is best-effort: measured hit rates from 0 to 5 of 8 identical
  requests with the same prompt_cache_key, with or without tools. Nothing more to set on our side
  (prompt_cache_retention isn't accepted there); recheck if OpenAI documents more.
- **Web on/off and the prompt cache with an Anthropic API key:** with Claude Code and ChatGPT, switching Web
  keeps the tool list the same (only what may run changes), so the cache survives. On the API, the
  `web_search` tool is still added or removed, and since tools come first in the prompt, switching Web
  makes the whole conversation uncached once ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  changing tool definitions invalidates every cache tier). Anthropic's fix is mid-conversation tool changes:
  keep `tools` fixed and append `tool_addition` / `tool_removal` blocks where Web changed (beta
  `mid-conversation-tool-changes-2026-07-01` or `inline-tools-2026-09-15`; Opus 4.8 and later, Sonnet 5.5,
  Haiku 5.5, not Sonnet 5; [mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)).
  Needs an API key to check, and whether it applies to the server-side `web_search` tool.
- **Web articles:** a bookmarklet or small browser extension that sends the article from the tab you're
  reading, for pages the server can't fetch (logins, paywalls you pay for).
- **Images in Markdown:** pasted or uploaded Markdown with image links still loads those images straight
  from their sites; it could get the same placeholders as web articles. The same goes for images in model replies, which is
  also a way a prompt-injected model could send conversation text to a site (in an image URL).
- **Split and join in the UI:** `ThreadOps.split` ("make the rest of this thread a branch") and `join`
  exist and are tested, but only "Use this version" uses them. Joining a side question into its parent
  would also need a way to keep its prefix (what the passage was) in the text.
- **Live updates between devices:** a tab catches up when it comes back to the foreground, not while two
  screens are both in view. A server-sent event per conversation would do it, if that ever matters.
- **Rewind:** delete a message and everything after it in a thread, with a confirmation listing what goes.

## Sub-agents that explore

An `explore(task)` tool: Digress starts a separate model run with the same read-only tools and a fresh
context; it reads as much as it needs and reports back, and only the report enters your thread.

- **Why:** when answering means reading far more than should sit in the conversation (every question
  resends the whole thread, so 50 pages of tool output make every later question bigger), or when a
  question spans many separate parts.
- **In parallel:** several explorers each take a part ("how do these three sections disagree?").
- **A conversation, not a handoff:** the main model can answer the report ("you skipped the appendix;
  check whether the numbers there agree") and the explorer continues with its own context, instead of
  starting over.
- **Explorers talking to each other:** e.g. one explorer per section, asked to reconcile their findings
  before reporting.
- **Keeping it honest:** a report is a summary the main model can't see behind, which is the same
  silent-missing-context risk as cutting a document down. So: every claim cites its page (or file and
  line), reports say what was searched and *not* found, the main model can check claims with
  `read_pages`, and each explorer's trail shows under the reply, folded.
- **In Digress's own terms:** an explorer's run, and any back-and-forth with it, could itself be a branch,
  visible on the tree and canvas like any other thread.

## Bring your own models, search and tools

Each piece the model depends on could be swapped for one you run yourself.

- **Open models:** one generic provider for anything with an OpenAI-compatible API (Ollama, LM Studio,
  llama.cpp's server, vLLM): a base URL and key in `.env`, its models listed beside Claude and
  ChatGPT, one more entry in `PROVIDERS`. Things to get right:
  - **Context size.** Local models often run with 8k–32k tokens, and Ollama's default is smaller still: it
    silently drops the start of a long prompt, so the model would answer without the document and nobody
    would know. Needs a per-provider limit, so larger documents start from the table of contents and the
    pages the question needs instead of the whole text.
  - **Tools** (search, read pages, view a page) need function calling, which local models do unevenly: a
    switch, off by default, falling back to the page-picking preamble (`{tools:false}`).
  - **Images** only with vision models; **effort** only with reasoning models; a **fast model** for the
    search helper.
- **Web search on our side:** today it's done by the model's provider (Claude Code's WebSearch, the API's
  `web_search`, ChatGPT's), so a local model has none. A search backend run by the Digress server (SearXNG
  self-hosted; Brave or Tavily with a key) offered to the model as an ordinary tool would give every model
  search, and lets you choose who sees your queries. Results still go through the same source filtering,
  and the Web toggle stays the only way it's turned on.
- **Pluggable tools:** most likely MCP servers you name in the settings. The guard rails matter more than
  the plumbing: the server has no login and tools run on this machine, which is why only read-only document
  tools exist today. So: read-only, opt-in per tool, shown under the reply like the document tools, and
  never anything that writes files, runs commands or reaches the network on its own.

## A codebase (or a folder of documents) as the source

The same tools over a codebase or a set of documents: open a repository, ask about it, branch from a
function or a passage, and let explorers read across files. The branching tree and canvas then become a
map of everything you've worked out about it, in one place.

- **Access stays explicit:** the tools read only folders you attach, read-only, never anything else on the
  machine, in the spirit of the opt-in web toggle and "no other tools".
- **UI:** code views with line anchors (branch from a line range like from a highlight), file and symbol
  navigation, and a canvas that can lay branches out alongside the structure of the code.

## Sharing a conversation

Send one whole conversation to someone as a single `.html` file. They can look around in it without
installing anything, and, if they run Digress themselves, import it and carry on with their own Claude Code
or ChatGPT login.

- **A live viewer, read-only:** built the way the demo is (`demo/build.mjs`): the real page with an
  in-browser stand-in for the server, the conversation as its seed instead of `demo/seed.json`. Columns,
  Rows, the canvas, branch chips and search all work; asking a question says to import it into Digress to
  continue. Made in the browser from the page's own files (fetched from the server) plus the conversation
  and its images. The libraries still come from CDNs, so it needs internet to open (bundling them adds
  about 5–7 MB). To check: IndexedDB from a `file://` page, and HTML attachments on Android (some viewers
  don't run scripts).
- **Choosing what goes in:** a dialog lists the branches (hidden ones and other versions optional),
  takeaways, images, the document and the file's size before saving. Never in it: flashcards (their own
  collection), `run` ids, layouts, device and window ids. Model names and token counts optional.
- **The document is included by default, with an option to leave it out** (it may be someone else's
  paper). Left out, a document opened from a link (`doc.source`) is fetched again on import and checked
  to be the same file, so branches still land on their passages; otherwise the reader can attach their
  own copy.
- **Import is the safety line.** The data sits in the file as inert JSON (`<script
  type="application/json">`); importing reads the file as text and takes only that block, never running
  its scripts, so an edited viewer can't reach the importer's Digress. Then: `ThreadOps.check`, size
  limits and image types checked, a new conversation id, no `run`; nothing is sent to a model and no link
  fetched until the reader acts. It's always a new conversation, so no merging. A file picker in the
  sidebar, or drop the file on the page; not a button in the shared file that posts to a local Digress,
  which would mean loosening `requestAllowed()`.
- **Carrying on:** every request is rebuilt from saved messages (`buildContext`), so it works with
  whichever provider the importer has; a model they don't have falls back to their default.
- **Tests:** export → import round trip, a tampered file refused, the viewer opening from a local file.
