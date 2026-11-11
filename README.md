# Digress

A branching chat for learning. Ask Claude about something, highlight any passage in the answer, and dig into it in a side thread without losing your place. Branches sit side by side (columns, rows or a free canvas), each one knows exactly where it came from, and you can carry a takeaway back to the parent.

- Highlight → branch, with numbered markers in the parent and "show in source" jumps back to the exact words
- Columns, rows, a canvas with cards you can snap or stick to the screen, and a tree view
- Start from a PDF or Markdown file: one thread about the whole document, branches for any passage
- Markdown, code highlighting, LaTeX (MathJax) and Mermaid diagrams
- Pins, archive, ⌘K search across everything (BM25, typo tolerant)

The whole app is one file, `web/index.html`. A small server with no dependencies (`server/server.mjs`) serves it, keeps your data in `data/`, and talks to Claude.

## Quick start

Needs Node 18 or newer.

```sh
git clone <your repo> digress && cd digress
npm start              # → http://127.0.0.1:8787
```

### Connecting Claude

**With your Claude subscription (Pro or Max):** Digress runs the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI in non-interactive mode (`claude -p`), signed in with your Claude account, so you don't need an API key.

```sh
npm install -g @anthropic-ai/claude-code   # or: curl -fsSL https://claude.ai/install.sh | bash
claude                                      # once, to sign in; then /exit
npm start
```

On a headless server, `claude setup-token` prints a long-lived token instead. Put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`.

Things to know:
- Usage counts against your plan's limits, like Claude Code does.
- This is for **your own use**. Anthropic's terms don't allow routing other people's requests through your subscription, so don't share a subscription-backed Digress with anyone else on your tailnet. Use an API key for that.
- Each reply starts a fresh `claude -p` run with tools turned off. Earlier turns are sent as part of the prompt, so the first reply can take a second or two longer than over the API.

**With an API key:** put `ANTHROPIC_API_KEY=...` in `.env` (copy `.env.example`). When a key is set it is used unless `LLM_PROVIDER=claude-code`. The API path streams directly, caches the system prompt (handy for long PDFs) and lists every model your key can use.

## Hosting on your tailnet

The server listens on `127.0.0.1` only. Put [Tailscale Serve](https://tailscale.com/kb/1312/serve) in front of it to get a private HTTPS address that only devices on your tailnet can open:

```sh
npm start                       # or run it as a service, below
tailscale serve --bg 8787       # → https://<machine>.<tailnet>.ts.net
tailscale serve status          # see the URL; `tailscale serve --https=443 off` to stop
```

Digress has no login of its own. Tailscale is the lock, so don't use `tailscale funnel` (public internet) or `HOST=0.0.0.0` unless you add authentication in front.

### Keep it running (systemd)

```ini
# /etc/systemd/system/digress.service
[Unit]
Description=Digress
After=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/digress
ExecStart=/usr/bin/node server/server.mjs
Restart=on-failure
# Make sure the service can find `claude` (check with: which claude)
Environment=PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now digress
```

Run the service as the same user you signed in to Claude Code with, because the sign-in lives in that user's home folder. Or use `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

## Your data

Everything lives in `data/` (or `DATA_DIR`):

```
data/convs/<id>.json      one file per conversation
data/index/<id>.json      search index entries
data/files/<id>           uploaded documents (+ .meta.json)
```

Back it up by copying the folder. It's git-ignored.

## Configuration

See `.env.example`. The main settings: `LLM_PROVIDER`, `DEFAULT_MODEL` (default `claude-sonnet-5-5`), `PORT` (8787), `HOST` (127.0.0.1), `DATA_DIR`, `CLAUDE_BIN`.

## Other ways to run it

`web/index.html` also works without the server:
- **As a claude.ai artifact**: it uses claude.ai's built-in model, storage and file features.
- **Opened as a file**: it stores conversations in the browser's local storage, but has no model.

## Development

```sh
npm install                              # local copies of the CDN libraries, for the tests
pip install -r tests/requirements.txt && python -m playwright install chromium
npm test                                 # or: python3 tests/run_all.py canvas
```

`tests/test_server.py` runs the server against fake stand-ins for Claude Code and the Anthropic API, so it needs neither. The other tests drive the UI from the file directly. Screenshots and logs land in `tests/.artifacts/`. Set `CHROME_PATH` to use your own Chrome.

`npm run dev` runs the server with live reload: editing `web/` reloads open pages, and editing the server restarts it (and then reloads the pages). A page waits while a reply is streaming or you have a draft typed, and shows an "Updated · reload" button instead.

See [AGENTS.md](AGENTS.md) for how the code is organized.

## License

MIT
