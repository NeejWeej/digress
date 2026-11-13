# Using Digress from other devices

The server listens on `127.0.0.1` and has no login of its own, so the safe way to reach it from your phone or another computer is a private network in front of it. [Tailscale](https://tailscale.com) is the easiest, and Digress allows `*.ts.net` names out of the box.

## Tailscale Serve

[Tailscale Serve](https://tailscale.com/kb/1312/serve) gives the server a private HTTPS address that only devices on your tailnet can open:

```sh
npm start                       # or run it as a service, below
tailscale serve --bg 8787       # → https://<machine>.<tailnet>.ts.net
tailscale serve status          # see the URL; `tailscale serve --https=443 off` to stop
```

Tailscale is the lock here, so:

- Don't use `tailscale funnel`, which puts it on the public internet.
- Don't set `HOST=0.0.0.0` unless you add authentication in front.
- If you signed in with your Claude subscription, keep it to yourself. Anthropic's terms don't allow routing other people's requests through your subscription; use an API key if others on your tailnet will use it. The same goes for a ChatGPT plan.

If you reach the server by another name (a LAN hostname, say), add it to `ALLOWED_HOSTS` in `.env`; see [setup.md](setup.md#who-can-talk-to-the-server).

## Keep it running (systemd)

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

Run the service as the same user you signed in with, because the sign-ins live in that user's home folder: Claude Code's in its own config, ChatGPT's in `~/.config/digress/chatgpt.json`. For Claude on a headless machine you can use `CLAUDE_CODE_OAUTH_TOKEN` in `.env` instead (from `claude setup-token`).

To sign in to ChatGPT on a remote machine, forward the login port from your laptop first, then run the login on the server:

```sh
ssh -N -L 1457:127.0.0.1:1457 <server>
npm run chatgpt -- login --no-browser     # on the server; open the printed link on your laptop
```

## On your phone

Open the `ts.net` address in your phone's browser. The layout adapts to a narrow screen, and the views work with touch:

- **Columns / Rows:** drag the gap between two panes with a finger to resize them.
- **Canvas:** drag the background to pan, pinch to zoom, drag a card by its title to move it, and scroll inside a card without moving the canvas.
- Select text the usual way (long-press and drag the handles) and the branch box appears; no mouse needed.
