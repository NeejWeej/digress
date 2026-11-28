# Notes for coding agents

Digress is a branching chat for learning. Read README.md for what it does. This file is the overview: read it whole. The details live in `agents/`, one file per area: **before changing an area, read its file** (the index is below). They're precise about names, traps and which test covers what, and most bugs this project has had were someone not knowing one of them.

If `agents.local/` exists, read `agents.local/README.md` before any work: notes about this particular machine (the dev server, how to run tests and commit here), kept out of git. It says which of its other files to read for what.

## Where things are

- `web/index.html` + `web/styles.css` + `web/js/`: the entire client (HTML shell + theme/font/lib boot in `index.html`, stylesheet in `styles.css`, native ES modules in `web/js/`, starting at `web/js/app.js`). No build step. Libraries come from this server's `lib/` first and a CDN second, with the same SRI hashes (`window.LIBS`, `server/libs.json`).
- `web/prompts.js`: every instruction the page sends the model (`PROMPTS`). New model-facing text goes there, never inline.
- `web/threads.js`: `ThreadOps`, pure functions on a conversation's message tree (`walk`, `split`, `join`, `swap`, `merge`), property-tested.
- `server/server.mjs`: Node ≥22.5 (uses built-in `node:sqlite`), **no dependencies**; keep it that way. `server/db.mjs`: SQLite + FTS5 storage and search. `server/runs.mjs`: replies as runs that outlive their connection.
- `demo/`: the demo site (Cloudflare Workers; the old GitHub Pages address redirects there): the same page with an in-browser stand-in for the server.
- `tests/`: Python Playwright; `python3 tests/run_all.py`. `evals/`: prompt comparisons against a real model, run by hand only.
- `docs/`: user docs. "Ask about Digress" answers from README.md, `docs/` and these notes, so keep them current when a feature changes.

## The one rule: connectors

The client never calls the server directly. Everything goes through `io = {llm, store, index, files, ready}`, set up once by `initConnectors()`. New features use `io.*`. Model providers are entries in the server's `PROVIDERS`; the client only reads the NDJSON stream. A change to the server contract must change `demo/demo.js` and `tests/fakes/page-server.js` too. The contract is in `agents/server.md`.

## Traps that break things (details in the files)

- **Anchors are character offsets that ignore whitespace**, counted by `textWalker`. Anything that adds text inside a message or document body moves every stored anchor: new controls go outside `.body`, or add no text (CSS `attr()`, icons). `agents/documents.md`.
- **Messages are a tree; threads are a labeling of it.** Rearranging threads goes through `ThreadOps`; Redo/Edit never replace an answer. `agents/data-model.md`.
- **Several devices save by merging** (`ThreadOps.merge`). Anything new on a conversation must survive `merge`; per-page state goes in `LOCAL_MSG`, per-device layout in `ui`. `agents/data-model.md`.
- **Keep the prompt prefix stable**: the system prompt is the same for every question in a conversation, and anything added to a message comes from what's saved with it. `agents/model-context.md`.
- **Security**: model text never fetches from another site by itself (`purifyNoRemote`); web access is search only, never shell or file tools; `fetchdoc.mjs` stays strict; `requestAllowed()` stays first in `route()`. `agents/server.md`, `agents/rendering.md`.
- **Search has two engines**: the real server finds results with FTS5 (`server/db.mjs`), the demo and the UI tests' fake with MiniSearch; both rank with `web/js/searchrank.js`. A change to how one finds results goes in both; `tests/test_search_parity.py` checks they agree. `agents/search.md`.
- **Modules call each other through `app`** (filled at the end of `web/js/app.js`), **and redraw each other through `invalidate('key')`** (`web/js/redraw.js`, synchronous on purpose). `tests/test_app_registry.py` catches a name or key nobody registered. `agents/layout.md`, `agents/ui.md`.
- **Themes are CSS variables only**; no hard-coded colors, no `prefers-color-scheme`. `agents/ui.md`.
- **The document pane is the pseudo-thread `'doc'`** and can be moved onto the canvas; never clone it. `agents/documents.md`, `agents/canvas.md`.
- **Safari (WebKit) differs** (no scroll anchoring, scroll resets on hidden elements, …); a test that passes in Chromium can pass for the wrong reason. `agents/testing.md`.

## Index of `agents/`

| File | Read it before touching |
|---|---|
| `layout.md` | libraries and how they load, prompts.js, threads.js, CI workflows, docs and media |
| `server.md` | the API contract, providers (Claude, ChatGPT, Gemini), connections and keys, runs, token counts, web search, fetching documents, host checks |
| `data-model.md` | the `conv` shape, titles, threads, versions (Redo/Edit/Move/Start over), sync and merge, several windows, takeaways, export/import, blank conversations |
| `documents.md` | anchors, PDF text layers, the `'doc'` pane, the reading mark, web articles |
| `canvas.md` | canvas coordinates, docking the document, arriving, drags, Return, branch chips, long cards, views |
| `ui.md` | startup order, themes and fonts, shortcuts and the keys panel, Zen, installed app, panes and their headers, resize, branch counts, reply badges, wires, tooltips, top bar, the sidebar, Activity |
| `rendering.md` | `plain()`, remote content, math, diagrams, code blocks |
| `search.md` | the index, scope, "Describe it instead", landing and Back |
| `model-context.md` | `buildContext`, images in context, document tools, prompts and skills, Ask about Digress |
| `cards.md` | flashcards, drafting, fixes, offline review |
| `demo.md` | the demo site |
| `testing.md` | how the tests run, waiting without fixed timeouts, WebKit |

Add new notes to the file for their area (or a new file, listed here); keep this file short.

## Testing

```sh
npm install && pip install -r tests/requirements.txt && python -m playwright install chromium
python3 tests/run_all.py            # all
python3 tests/run_all.py dock       # by name
```

Each test file stands alone (its own browser, server on `free_port()`, temp data) since they run in parallel. Add a test when you fix a bug. Never wait a fixed time for something to happen: wait for the state (`soon`, `wait_for_function`, `settle`). The rest is in `agents/testing.md`.
