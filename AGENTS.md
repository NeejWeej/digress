# Notes for coding agents

Digress is a branching chat for learning. Read README.md for what it does. This file covers how the code fits together and the traps.

## Layout

- `web/index.html`: the entire client (HTML, CSS, JS) in one file. No build step. Libraries come from CDNs: marked, DOMPurify, highlight.js, MathJax 3 (async), mermaid (lazy), pdf.js 3.11 (lazy), MiniSearch (lazy).
- `server/server.mjs`: Node ≥18, **no dependencies**. Keep it that way unless there's a strong reason.
- `tests/`: Python Playwright. `run_all.py` runs everything; `test_server.py` uses `tests/fakes/` instead of real Claude.
- `docs/`: user docs linked from README.md (`setup.md`, `remote-access.md`, `development.md`). `docs/media/make_media.py` regenerates the README screenshots and GIF; rerun it when the UI changes visibly.

## Connectors: the one rule

The client never calls the server directly. It goes through `io = {llm, store, index, files, ready}`, set up once at startup by `initConnectors()`: `findServer()` (`GET api/health` returns `{app:'digress'}`) → `serverLlm`, `serverStore`, `serverFiles`. Opened without its server, the page shows a banner (`noServer()`: `noLlm`, `memoryStore`, `noFiles`) and saves nothing.

New features must use `io.*`. To add a model provider, add an entry to `PROVIDERS` in the server (`available`, `why`, `models`, `web`, `chat`; see `chatViaClaudeCode` / `chatViaApi` / `server/chatgpt.mjs`); the client just reads the NDJSON stream. Several providers can be on at once (one Claude provider, plus ChatGPT once signed in): `/api/models` lists all their models and each chat goes to the provider that owns its model (`providerFor`). Connectors that can't do something say so (`supportsEffort`, `supportsWeb`, `supportsImages`) and the UI hides or works around it.

Server contract:
- `GET /api/health` → `{app:'digress', llm, provider, providers, web, why}`
- `GET /api/models` → `{models:[[id,label]], defaultLabel}`
- `POST /api/chat` `{system, messages, model, effort, web}`: each message's `content` is a string or a list of parts `{type:'text',text}` / `{type:'image',mediaType,data}` (base64; user messages only). `server/content.mjs` checks them and converts them for each provider; anything it doesn't understand is refused (400), never dropped. Response: NDJSON lines: `{d:"text"}`, `{search:"query"}`, `{sources:[{title,url}]}` (any order), then `{done, model, truncated}` or `{error}`
- `/api/store/{convs|index}[/:id]`: GET list / GET / PUT / PATCH / DELETE
- `/api/files`: `POST ?type=` with raw body → `{id}`; `GET`/`DELETE /api/files/:id`
- `POST /api/fetch-doc` `{url, confirm:[codes]}` → the document's bytes (headers `x-doc-kind`, `x-doc-name`, `x-doc-url`), or `409 {warnings:[{code,text}], url}` when the reader must OK it first (`http`, `ip`, `port`). Client side: `io.files.fromLink` (server connector only; the dialog says so elsewhere).

## Data model

`conv = {id, title, created, updated, threads, msgs, order, ui, nextColor, doc?, pinned?, archived?}`; `doc = {kind, name, assetId?, text?, source?}` (`source`: the link it was opened from)
- User messages can carry `images: [{asset|data, type, w, h}]` (pasted screenshots, stored via `io.files`, inline as a data URL where there's no file storage).
- A snip or whole-page branch from a PDF has `anchorRegion: {x,y,w,h}` (fractions of page `anchorPage`; 0,0,1,1 = the whole page) and `regionText` (the PDF's words inside it); its `anchorText` is just a label. The image isn't stored: it's redrawn from the PDF when needed.

- `threads[tid] = {id, parent, anchorMsg, anchorText, anchorRange:{s,e}, anchorPage, title, colorIdx, resolved?, pinned?}`. `main` is the root.
- `msgs[mid] = {role: user|assistant|note, thread, text, ...}`; assistant replies made with web on also keep `web`, `searches` and `sources`; `order[tid]` lists a thread's message ids. Notes are takeaways carried back from a branch (`fromThread`).
- `ui`: open/collapsed panes, layout, view (`panes` | `canvas` | `tree`), per-pane zoom `pz[tid]` (a factor; the PDF pane re-renders at it, where 1 = fit width), canvas state `ui.cv` (positions, sizes, z order, per-card zoom `cz`, docked cards `dock`).

## Traps

- **Anchors are character offsets that ignore whitespace** (`anchorRange`), counted by `textWalker`, which skips rendered math, mermaid and footnote markers. Don't change what `textWalker` skips without migrating stored anchors. Older anchors fall back to fuzzy text matching using the surrounding prefix and suffix.
- **PDF text layers end with an empty `.endOfContent` div** that moves around while you select (it fills the gaps between words so the selection doesn't jump, especially on touch). It holds no text, so anchors are unaffected; don't style or count text-layer children without allowing for it.
- **The document pane is the pseudo-thread `'doc'`.** Branches from it have `anchorMsg: 'DOC'`. Code that filters `ui.open` / `ui.collapsed` by existing threads must keep `'doc'` (this broke once).
- **Canvas coordinates:** cards have world positions; the camera scale is `cam.k`, and each card has its own zoom (CSS `zoom` via `--cz`). Stored sizes are at 100%. Anything that converts screen ↔ content uses `contentScale(node)` (which is 1 for cards stuck to the screen). Scroll offsets inside a zoomed card must be divided by it.
- **Startup order:** MathJax loads async and may already be cached, so `__mathReady` can fire before a conversation exists. Keep its guards.
- **Class names:** generic names clash with top-bar styles (`.sel` did). Prefix new canvas classes.
- **Web access is search only, and only when asked.** `web` is false unless the reader turned the Web toggle on. Claude Code gets `--tools WebSearch` and nothing else (and `--tools ""` when off), plus `--strict-mcp-config --safe-mode --disable-slash-commands` so none of the user's own MCP servers, hooks, CLAUDE.md or skills load; never add WebFetch, Bash or file tools there: they run on this machine, and the server has no login. The API path uses the server-side `web_search` tool. ChatGPT (`server/chatgpt.mjs`) sends no `tools` at all, or only `[{type:'web_search'}]` (hosted by OpenAI); it has no code that runs a tool call. Its plan route requires `store:false` + `stream:true` and rejects `system` messages and `max_output_tokens`. Keep the request prefix stable (system prompt as the first developer message, history as separate unchanged turns) so OpenAI's prompt cache keeps working. Source URLs are filtered to http(s) on the server and again in the client.
- **Documents from links are fetched by the server, so `server/fetchdoc.mjs` must stay strict:** http(s) only, no credentials, public addresses only (checked inside the DNS lookup and on every redirect, so rebinding can't slip past), an OK from the reader for http / bare IPs / odd ports, and only real PDFs or UTF-8 text. `DOC_FETCH_TEST_ALLOW` exists for the tests' fake site; never set it otherwise.
- **The server only answers its own page.** `requestAllowed()` refuses requests whose Host isn't localhost/loopback/the `HOST` address/`ALLOWED_HOSTS` (default `.ts.net`; leading dot = suffix) (DNS rebinding) or whose Origin is another site (cross-site POSTs). Keep that check first in `route()`.
- **Images in context:** `buildContext` emits `{type:'image', ref}` parts; `resolveContext` turns them into bytes right before sending and fails the whole request if one can't be loaded (never send with a piece missing). Connectors without `supportsImages` get a visible note in place of each image. `tests/test_context.py` checks that every message and image on a branch's path reaches each provider intact; keep it passing.
- **Context building:** `buildContext(tid)` returns `{system, messages}`. The system prompt includes the document text (up to about 80k characters, with `[p. N]` page labels). Branches get a prefix quoting the anchor (or, for a snip or page, an image of it).

## Testing

```sh
npm install && pip install -r tests/requirements.txt && python -m playwright install chromium
python3 tests/run_all.py            # all
python3 tests/run_all.py dock       # by name
```

The UI tests open the app with `common.goto_app()`: it serves `web/index.html` at `http://digress.test/`, maps CDN URLs to `node_modules`, and injects `tests/fakes/page-server.js`, a fake of the server's `/api/*` that runs in the page; each test supplies its fake model as `window.fakeLLM`. Many of them print what they observe: read the output (`tests/.artifacts/*.log`) and the screenshots there when changing that area. `test_server.py` and `test_context.py` run the real server (with fake Claude Code / Anthropic / OpenAI from `tests/fakes/`), assert, and exit non-zero. Add a test when you fix a bug.
