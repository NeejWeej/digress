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
- **Images in Markdown documents:** pasted or uploaded Markdown with image links still loads those images straight
  from their sites (replies don't: their images wait for a click); it could get the same placeholders as web articles.
- **Joining a side question into its parent:** `ThreadOps.join` exists (Undo of "Move what follows into a branch"
  and of Start over use it), but a side question would need a way to keep its prefix (what the passage was) in the text.
- **Live updates between devices:** a tab catches up when it comes back to the foreground, not while two
  screens are both in view. A server-sent event per conversation would do it, if that ever matters.
- **Bigger diagrams:** a diagram is drawn no wider than its message and at most 60% of the window's height; the
  zoom strip only magnifies it inside that box. Two ways to make it really bigger:
  - **Full screen:** a button beside the 🔍 opens it over the whole window, where the wheel, a trackpad pinch or
    a finger pinch zoom it and dragging moves it (no chat behind it to scroll); Esc, a click outside or back
    closes it (`closeTopmost`). Also covers phones, where the canvas takes the pinch and a diagram in a card
    can't be zoomed now.
  - **Beside the rest:** pop the diagram out into its own pane (Columns/Rows) or card (canvas), resizable like
    any other, so it stays large next to the conversation that discusses it. It would follow the message
    (redrawn from its source, not copied), and close without changing anything.
  On the canvas, the 60% cap could also follow the card's height, so resizing a card enlarges its diagrams.

## Long conversations and big documents

Not needed yet; written down in case it ever is. As of November 2026 the fullest conversation reached 84k tokens
of a 500k window, and most stay under 40k. History grows slowly: only the replies' text is sent again
(`buildContext` sends each message's `content`), never the web results or pages a reply read along the way, and a
branch carries only its own path. The more likely way to fill a window is a single reply that reads a lot, which
neither idea below touches.

- **A document rule tied to the window (maybe).** Today a document goes whole into the system prompt under
  `DOC_BUDGET` (200k characters, ~50k tokens), else the model starts from its contents and the document tools. The
  cutoff could instead be a share of the model's window, say 15%: a 50k-token document would go whole on a 500k or
  1M model but not a 272k one. Unsure it's worth it: in the cached system prompt, a whole document costs little
  per question (cache reads are about a tenth of the price); the cost is window space, and a whole document gives
  better answers when a question spans several parts of it. It would need each model's window in `/api/models`
  (the providers' model lists have it), and threads on different models could then see the document differently.
- **History the model looks up, if a thread ever gets near its window.** The document tools' approach applied to
  the conversation itself: send the recent part word for word, an outline of the older part (one line per
  exchange, from the questions themselves, not model-written summaries), and `search_history` / `read_messages`
  tools limited to the thread's path, run in the page like the document tools. What has to hold: the cut is a
  pure function of the path, so a message's context stays fixed and merges still work; it moves in big steps, so
  the prompt cache survives; nothing changes below a threshold (say 40% of the window); and "What the model sees"
  shows the cut. Several days of work, in the middle of how every request is built, so only if it's needed.
  Revisit if a conversation's `usage.ctx` passes about 40% of its window.

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

## Sharing a conversation as a standalone `.html` file

Exporting and importing `.digress` archives (with optional document and flashcards), Markdown (`.md`), and Anki (`.csv`) is already built, and anyone without Digress can open a `.digress` file directly on the demo site (see [done.md](done.md)). What isn't built yet is a **self-contained single `.html` viewer** that works completely offline from `file://` without visiting the demo site:

- **A live viewer, read-only:** built the way the demo is (`demo/build.mjs`), with the conversation as its seed instead of `demo/seed.json`. Columns, Rows, the canvas, branch chips and search all work; asking a question says to import it into Digress to continue. To check: IndexedDB from a `file://` page, bundling CDN libraries (~5–7 MB) for true offline viewing, and HTML attachments on Android (some viewers don't run scripts).
- **Per-branch selection:** optionally picking specific branches (or leaving out model names / token counts) in the export dialog.

## Client structure and runtime performance

Startup, PDF memory, streaming highlighting, canvas caching, incremental search, and SQLite + FTS5 storage have already been built (see [done.md](done.md)). Further cleanups if the app or conversation libraries grow much larger:

- **Block-level streaming diffing:** `hljs` is cached during streaming, so code-heavy replies stay fast, but `marked.parse()` and `DOMPurify.sanitize()` still re-run on the whole reply every 70 ms. Splitting settled top-level blocks from the trailing active block would flatten CPU on very long (5,000+ word) streaming replies.
- **Lighter connector wires:** updating existing SVG `<path>` `d` attributes in place instead of rebuilding `svg.innerHTML`, and bounding crossing `<mask>` rects to the viewport rather than a `30000×30000` user-space box.
- **Search in a Web Worker (demo/offline):** the local server now runs FTS5 search in SQLite; for the browser-only demo or offline mode with huge libraries, moving `MiniSearch` into a Web Worker would keep typing off the main thread completely.

## Videos, YouTube first

Learn from a video the way Digress does from a PDF: branch from what was said or from what was on screen. YouTube
is the main focus; uploaded video files are supported too, but second. The server stays light: it never
downloads or keeps a video.

- **The pane:** the player, with branch markers on its timeline, over the transcript, which follows along
  (the line being spoken highlighted; click a line to jump there). Highlight transcript text to branch, like a
  passage (the branch keeps the time and the words); pause and **Ask about this frame** to branch with the frame
  as its image, like a snip (or drag a box over the paused video for part of it). The model cites `[t. 12:34]`,
  which seeks the player; branch cards on the canvas show their frame; the reading mark is a time ("you got up to
  41:20").
- **Tools,** like the document tools (run in the browser): `read_transcript(from, to)` like `read_pages`, and
  `view_frame(t)` like `view_page`, so the model reads what was said and looks when it needs to ("as you can
  see here"). An hour's transcript is ~13k tokens, so it can usually go whole, like a short PDF; chapters from
  the description are its table of contents.
- **Playback:** YouTube's official embedded player (IFrame API) streams straight to the browser and lets the
  page play, pause, seek and read the time; no server load, works on phones.
- **Transcript:** the server fetches the captions (text, ~100 KB an hour) plus title, chapters and description.
  There's no official way for videos that aren't yours, so it reads the caption files YouTube's player uses,
  which can break when YouTube changes them; `yt-dlp --skip-download --write-auto-subs` (captions only, never the
  video) as an optional fallback if installed. Without captions (an uploaded file), whisper if installed.
- **Frames, the hard part** (the embedded player won't hand its pixels to the page), lightest first:
  1. Tab capture (desktop Chrome): allow "share this tab" once a session, and the page grabs what the player
     shows, cropped to it, sharp. Nothing downloaded; `view_frame` can seek, wait and capture by itself. Not on
     Chrome for Android, and the player must be on screen.
  2. YouTube's scrub-preview thumbnails: tiny, light, work on phones, but too small to read slides or code.
  3. The server grabs one frame (`yt-dlp` for the stream, `ffmpeg` reading a few MB around that moment, nothing
     kept): sharp, anywhere, but against YouTube's terms and fragile. Opt-in only, if those are installed.
  4. Paste a screenshot (works today, phones included).
  Uploaded files are easy: the browser draws any frame itself.
- **What's kept:** the transcript and only the frames used (small JPEGs), never the video.
- **To settle:** desktop or phone first (on a phone, frames are the weak spot: thumbnails, pasted screenshots,
  or option 3); and how much breakage from unofficial caption fetching is acceptable.
