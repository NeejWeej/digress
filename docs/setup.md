# Setup and configuration

Digress needs Node 18 or newer and nothing else: the server has no dependencies, so there is no `npm install` step to run it.

```sh
npm start              # → http://127.0.0.1:8787
```

Settings go in a `.env` file in the repo folder (copy [`.env.example`](../.env.example)) or in the environment. Everything is optional. Restart the server after changing `.env`.

## Model connections

You need at least one. Claude and ChatGPT can be connected at once: the model picker lists all their models and each reply goes to the connection that owns the model you picked.

### ChatGPT, with your ChatGPT plan

For ChatGPT Plus or Pro. No API key and no Codex.

```sh
npm run chatgpt -- login       # opens the browser; --no-browser just prints the link
npm run chatgpt -- status      # connected or not (never prints tokens)
npm run chatgpt -- logout      # revokes the sign-in and forgets the tokens
```

How it works:

- It uses OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for open-source, locally hosted apps. On first sign-in Digress registers as its own app, then calls the public Responses API with `store: false`, so OpenAI doesn't keep the conversation as a stored response.
- Usage counts against your plan. You can cap how much Digress may use at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
- The models listed are the ones your account offers. They appear in the picker right after you sign in; no restart is needed.
- The model gets no tools at all, or, only when you turn **Web** on, OpenAI's hosted web search. Digress has no code that runs a tool call.
- The sign-in is saved in `~/.config/digress/chatgpt.json`, readable only by you, outside the data folder. Change the place with `CHATGPT_AUTH_FILE`.
- The server logs each reply's cached input tokens, so you can see the prompt cache working.

The login waits for OpenAI to redirect your browser to `http://127.0.0.1:1457/auth/callback` (change the port with `CHATGPT_LOGIN_PORT`). When signing in on a remote machine, forward that port first:

```sh
ssh -N -L 1457:127.0.0.1:1457 <server>      # on your laptop, then run the login on the server
```

### Claude, with your Claude subscription (Claude Code)

For Claude Pro or Max. Digress runs the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI non-interactively (`claude -p`), signed in with your Claude account.

```sh
npm install -g @anthropic-ai/claude-code   # or: curl -fsSL https://claude.ai/install.sh | bash
claude                                      # once, to sign in; then /exit
npm start
```

- If `claude` isn't on the server's `PATH`, set `CLAUDE_BIN` to its full path. The server looks for the CLI once, so restart it after installing.
- On a headless machine, `claude setup-token` prints a long-lived token. Put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`.
- Each reply starts a fresh run in an empty temporary folder, with tools off (only `WebSearch` when you turn **Web** on) and none of your own Claude Code setup loaded: no MCP servers, hooks, `CLAUDE.md` or skills. Earlier turns are sent as part of the prompt, so the first reply can take a second or two longer than over the API.
- Usage counts against your plan's limits, as Claude Code does.
- This is for **your own use**. Anthropic's terms don't allow routing other people's requests through your subscription, so don't share a subscription-backed Digress with anyone else. Use an API key for that.

### Claude, with an Anthropic API key

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env
```

The API path streams directly, caches the system prompt (handy for long PDFs) and lists every model your key can use. When a key is set it is used for Claude instead of the CLI, unless you set `LLM_PROVIDER=claude-code`.

### Which model is the default

Each conversation keeps the model and effort it started with: its first question saves the actual model (even when the picker said Default), and opening it again, after a reload or on another device, puts the picker back to it. Changing the picker or the effort while a conversation is open changes that conversation's from then on. A new conversation starts at Default. If a conversation's model isn't available right now (say you signed out of ChatGPT), it says so and uses the default until it is, without forgetting it. Web search is never kept: it's off until you turn it on.

The ☆ changes what a new conversation starts with. Pick a model and click the ☆ beside the picker, and it becomes the default on all your devices (kept in `data/prefs.json`). Without that, when the picker says **Default**, Digress uses `DEFAULT_MODEL` if it's set (`claude-opus-5-5` out of the box), otherwise the first model of the default connection. `LLM_PROVIDER` picks that connection: `claude-code`, `anthropic` or `chatgpt`. It defaults to `anthropic` when there's an API key and `claude-code` otherwise.

## Web search

The **Web** button in the top bar is off until you turn it on, and it applies to new replies only. When it's on:

- Claude Code gets only its `WebSearch` tool, the API gets Anthropic's server-side `web_search` tool, and ChatGPT gets OpenAI's hosted `web_search`. All of them run on the provider's side.
- Nothing fetches pages from your machine, and the model can't run code or touch files.
- Replies list the searches and sources they used. Source links are filtered to `http(s)`.

`MAX_SEARCHES` (default 5) caps searches per reply on the API path. `WEB_SEARCH=off` removes the button entirely.

## Documents from a link

Paste a link to a PDF, a Markdown or text file, or a web article into the **New from a document** dialog and the server downloads it; after that it's stored like an upload. Because the server does the fetching, it is strict:

- `http` and `https` only, and no user names or passwords in the link.
- Public internet addresses only: never this machine or your local network. This is checked when the name is looked up and again on every redirect, so a site can't redirect or re-point its name to get around it.
- It asks you first before opening an unencrypted `http` link, a bare IP address or an unusual port.
- It keeps only real PDFs, valid UTF-8 text and web pages, up to `MAX_UPLOAD_MB`.

**Web articles** (blog posts, essays, news) open in reader view. The page is handed to your browser as plain text, never shown as a page, so nothing on it runs. Your browser keeps just the article, using [Readability](https://github.com/mozilla/readability), the engine behind Firefox's reader view, and saves it as Markdown. From then on it works like any text document: highlight to branch, search, flashcards, and the model's document tools. Its links point where they did on the site.

Images aren't downloaded. Each one becomes a placeholder showing its description, with buttons to **load** it or **open the original** in a new tab. Loading goes through the same strict download, accepts only real PNG, JPEG, WebP or GIF files (no SVG), and keeps a copy with the conversation, so the site doesn't see you looking at it again. The model sees the placeholders as text. It can ask to see the pictures in a part of the article (`view_page`), but only the article's own image links, and an image from a link that needs your OK stays unloaded until you load it yourself.

Pages behind a login, or apps rather than articles, won't work: copy the text and paste it instead.

## Who can talk to the server

Digress has no login. Anything that can reach the server can read and change every conversation, so:

- It listens on `127.0.0.1` by default (`HOST`), which keeps other machines out.
- It only answers requests addressed to names it expects, which blocks DNS-rebinding tricks from websites open in your browser. Always allowed: `localhost`, `127.0.0.1`, `[::1]`, and the `HOST` address if it's a specific one. Add more with `ALLOWED_HOSTS`, comma separated; an entry starting with a dot matches every name under it. The default is `.ts.net`, for [Tailscale Serve](remote-access.md). Setting `ALLOWED_HOSTS` replaces the default, so include `.ts.net` yourself if you still want it, or set it to `none` to allow only the names above.
- It refuses requests whose `Origin` is another website, so a page can't make your browser post to it.

To reach it from other devices, see [remote-access.md](remote-access.md). Don't use `HOST=0.0.0.0` unless something in front of it handles authentication.

## Your data

Everything lives in `data/` (or `DATA_DIR`):

```
data/convs/<id>.json      one file per conversation
data/index/<id>.json      search index entries
data/files/<id>           uploaded documents (+ .meta.json)
```

Back it up by copying the folder. It's git-ignored.

## All settings

| Setting | Default | What it does |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` with a key, else `claude-code` | Default connection: `claude-code`, `anthropic` or `chatgpt` |
| `DEFAULT_MODEL` | `claude-opus-5-5` | Model used when the picker says Default, unless you chose one with the ☆ in the app |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CLAUDE_CODE_OAUTH_TOKEN` | | Token from `claude setup-token`, for headless machines |
| `ANTHROPIC_API_KEY` | | Use the Anthropic API for Claude |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API address |
| `MAX_TOKENS` | `16000` | Longest reply on the API path |
| `CHATGPT_AUTH_FILE` | `~/.config/digress/chatgpt.json` | Where the ChatGPT sign-in is kept |
| `CHATGPT_LOGIN_PORT` | `1457` | Port for the one-time sign-in callback |
| `WEB_SEARCH` | on | `off` removes the Web button |
| `MAX_SEARCHES` | `5` | Searches per reply (API path) |
| `MAX_TOOL_CALLS` | `15` | Document tool calls (search, read, view) per reply |
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `ALLOWED_HOSTS` | `.ts.net` | Extra names the server answers to (see above) |
| `DATA_DIR` | `./data` | Where conversations and documents are kept |
| `MAX_UPLOAD_MB` | `50` | Largest document, uploaded or from a link |
