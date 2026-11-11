# Notes for coding agents

Digress is a branching chat for learning. Read README.md for what it does. This file covers how the code fits together and the traps.

## Layout

- `web/index.html`: the entire client (HTML, CSS, JS) in one file. No build step. Libraries come from CDNs: marked, DOMPurify, highlight.js, MathJax 3 (async), mermaid (lazy), pdf.js 3.11 (lazy), MiniSearch (lazy).
- `server/server.mjs`: Node ≥18, **no dependencies**. Keep it that way unless there's a strong reason.
- `tests/`: Python Playwright. `run_all.py` runs everything; `test_server.py` uses `tests/fakes/` instead of real Claude.

## Connectors: the one rule

The client never calls a model, storage or file API directly. It goes through `io = {llm, store, index, files, ready}`, chosen once at startup by `initConnectors()`:

1. **Server** (`findServer()` → `GET api/health` returns `{app:'digress'}`): `serverLlm`, `serverStore`, `serverFiles`.
2. **claude.ai artifact runtime** (`window.claude`): `claudeAiLlm`, `claudeAiStore`, `claudeAiFiles`.
3. **Plain browser**: `localStore` / `memoryStore`, `noLlm`, `noFiles`.

New features must use `io.*` and work in all three. To add a model provider, change the server (see `chatViaClaudeCode` / `chatViaApi`); the client just reads the NDJSON stream.

Server contract:
- `GET /api/health` → `{app:'digress', llm, provider, why}`
- `GET /api/models` → `{models:[[id,label]], defaultLabel}`
- `POST /api/chat` `{system, messages, model, effort}` → NDJSON lines: `{d:"text"}`*, then `{done, model, truncated}` or `{error}`
- `/api/store/{convs|index}[/:id]`: GET list / GET / PUT / PATCH / DELETE
- `/api/files`: `POST ?type=` with raw body → `{id}`; `GET`/`DELETE /api/files/:id`

## Data model

`conv = {id, title, created, updated, threads, msgs, order, ui, nextColor, doc?, pinned?, archived?}`

- `threads[tid] = {id, parent, anchorMsg, anchorText, anchorRange:{s,e}, anchorPage, title, colorIdx, resolved?, pinned?}`. `main` is the root.
- `msgs[mid] = {role: user|assistant|note, thread, text, ...}`; `order[tid]` lists a thread's message ids. Notes are takeaways carried back from a branch (`fromThread`).
- `ui`: open/collapsed panes, layout, view (`panes` | `canvas` | `tree`), canvas state `ui.cv` (positions, sizes, z order, per-card zoom `cz`, docked cards `dock`).

## Traps

- **Anchors are character offsets that ignore whitespace** (`anchorRange`), counted by `textWalker`, which skips rendered math, mermaid and footnote markers. Don't change what `textWalker` skips without migrating stored anchors. Older anchors fall back to fuzzy text matching using the surrounding prefix and suffix.
- **The document pane is the pseudo-thread `'doc'`.** Branches from it have `anchorMsg: 'DOC'`. Code that filters `ui.open` / `ui.collapsed` by existing threads must keep `'doc'` (this broke once).
- **Canvas coordinates:** cards have world positions; the camera scale is `cam.k`, and each card has its own zoom (CSS `zoom` via `--cz`). Stored sizes are at 100%. Anything that converts screen ↔ content uses `contentScale(node)` (which is 1 for cards stuck to the screen). Scroll offsets inside a zoomed card must be divided by it.
- **Startup order:** MathJax loads async and may already be cached, so `__mathReady` can fire before a conversation exists. Keep its guards, and keep `waitRuntime` a hoisted function.
- **Class names:** generic names clash with top-bar styles (`.sel` did). Prefix new canvas classes.
- **Context building:** `buildContext(tid)` returns `{system, messages}`. The system prompt includes the document text (up to about 80k characters, with `[p. N]` page labels). Branches get a prefix quoting the anchor. The claude.ai connector folds `system` into the first message; the server passes it through properly.

## Testing

```sh
npm install && pip install -r tests/requirements.txt && python -m playwright install chromium
python3 tests/run_all.py            # all
python3 tests/run_all.py dock       # by name
```

The UI tests load `web/index.html` from disk, map CDN URLs to `node_modules`, and stub `window.claude`. Most of them print what they observe. Read the output and the screenshots in `tests/.artifacts/` when changing that area. `test_server.py` asserts and exits non-zero. Add a test when you fix a bug.
