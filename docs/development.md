# Development

The client is one file, `web/index.html`, with no build step. The server, `server/server.mjs`, has no dependencies. [AGENTS.md](../AGENTS.md) explains how the pieces fit together and lists the traps; the details are in [agents/](../agents/), one file per area.

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

GitHub Actions runs the same tests on every push and pull request (`.github/workflows/tests.yml`); a failed run keeps `tests/.artifacts/` for a week.

## The demo site

```sh
node demo/build.mjs                      # builds _site/: the real page plus an in-browser stand-in for the server
python3 -m http.server -d _site 8000     # then open http://localhost:8000
.venv/bin/python demo/make_sample.py     # remake the sample PDF and conversation (after changing either)
```

After Tests passes on main, `.github/workflows/demo.yml` builds it and publishes it to GitHub Pages, so the demo always matches the code. It has no model: the sample reading's suggested questions get replies written in `demo/replies.js`, and anything else gets the closest passages of the document. `tests/test_demo.py` checks it.

## README screenshots and GIF

```sh
pip install pillow                       # for the GIF
python3 docs/media/make_media.py
```

This rewrites `docs/media/columns.png`, `document.png`, `canvas.png` and `branching.gif`. It starts its own server on a free port with a throwaway data folder and a stand-in for the Claude Code CLI that streams canned replies (about attention in transformers), prints a small PDF of lecture notes with Chromium, and drives the app with Playwright at 1400×850. It doesn't call any model or touch your `data/`.

## The film

```sh
pip install numpy pillow imageio-ffmpeg  # imageio-ffmpeg brings its own ffmpeg
python3 docs/media/film/make_film.py      # about 3 minutes
```

This rebuilds `docs/media/film/digress-film.mp4` (about 30 seconds, 1080p, H.264 High + AAC, under 5 MB so it fits GitHub's upload limit) and its `poster.png`, the same way: its own server, a fake model, the real app captured with Playwright. Title cards are `docs/media/film/cards.html`; the music is synthesized in the script, nothing sampled. `--keep DIR` keeps the recordings so you can re-edit without recapturing (see the script's header). Fonts come from Google Fonts, so build it online. GitHub's file viewer doesn't play videos (an `.mp4` in the repo only offers a download), so for a player in the README, drag the new file into GitHub's web editor for README.md once and use the `https://github.com/user-attachments/assets/…` URL it inserts.

## Comparing prompt changes

`evals/` holds a small set of questions for checking a change to the prompts (`web/prompts.js`) against a real model: a mistaken premise, a quick fact, a beginner's question, an analogy, something the model can't know exactly, side branches, a branch the model can't see, and a document that's wrong. Each is sent with the prompts from a git ref and with your working copy, and the answers are written side by side to `evals/out/`:

```sh
node evals/prompt_eval.mjs --model gpt-6.2-astra                 # HEAD vs your working copy
node evals/prompt_eval.mjs --model claude-opus-5-5 --before main --only unseen-branch,doc-wrong
```

It needs the Digress server running (`--base`, default `http://localhost:8788`) and uses your real model connection, so it costs real usage: the tests and CI never run it. Nothing is scored; each case says what to look for.
