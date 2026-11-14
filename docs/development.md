# Development

The client is one file, `web/index.html`, with no build step. The server, `server/server.mjs`, has no dependencies. [AGENTS.md](../AGENTS.md) explains how the pieces fit together and lists the traps.

## Live reload

```sh
npm run dev
```

Editing `web/` reloads open pages, and editing the server restarts it (and then reloads the pages). A page waits while a reply is streaming or you have a draft typed, and shows an "Updated · reload" button instead.

## Tests

```sh
npm install                              # local copies of the CDN libraries, for the tests
pip install -r tests/requirements.txt && python -m playwright install chromium
npm test                                 # or: python3 tests/run_all.py canvas
```

`tests/test_server.py` runs the server against fake stand-ins for Claude Code, the Anthropic API and OpenAI (`tests/fakes/`), so it needs none of them. The other tests drive the UI from the file directly, with the CDN libraries served from `node_modules`. Screenshots and logs land in `tests/.artifacts/`. The test files run side by side (`-j N` to choose how many, `-j 1` for one at a time). Set `CHROME_PATH` to use your own Chrome.

## README screenshots and GIF

```sh
pip install pillow                       # for the GIF
python3 docs/media/make_media.py
```

This rewrites `docs/media/columns.png`, `document.png`, `canvas.png` and `branching.gif`. It starts its own server on a free port with a throwaway data folder and a stand-in for the Claude Code CLI that streams canned replies (about attention in transformers), prints a small PDF of lecture notes with Chromium, and drives the app with Playwright at 1400×850. It doesn't call any model or touch your `data/`.

## The film

```sh
pip install numpy pillow imageio-ffmpeg  # imageio-ffmpeg brings its own ffmpeg
python3 docs/media/film/make_film.py      # about 5 minutes
```

This rebuilds `docs/media/film/digress-film.mp4` (about a minute, 1080p, under 10 MB) and its `poster.png`, the same way: its own server, a fake model, the real app captured with Playwright. Title cards are `docs/media/film/cards.html`; the music is synthesized in the script, nothing sampled. `--keep DIR` keeps the recordings so you can re-edit without recapturing (see the script's header). Fonts come from Google Fonts, so build it online.
