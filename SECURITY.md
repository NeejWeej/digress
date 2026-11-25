# Security

## Reporting a problem

Please report security problems privately: on GitHub, open the repository's **Security** tab and choose **Report a vulnerability**. That reaches the maintainer without making the details public. Please don't open a public issue for them.

Say what you found, how to reproduce it, and what it lets someone do. You'll get a reply, and a fix with credit if you'd like it.

## What matters most

Digress's server has **no login**: it's meant to listen only on your own machine, or on a private network such as Tailscale ([remote access](docs/remote-access.md)). So the parts that guard it matter most:

- **The host and origin check** (`requestAllowed` in `server/server.mjs`): refusing requests from other sites and DNS-rebinding tricks.
- **Fetching documents from links** (`server/fetchdoc.mjs`): public addresses only, no credentials, only the file types it expects.
- **What the model can do**: web search only, when you turn it on; never shell, file or fetch tools ([agents/server.md](agents/server.md), "Web access is search only").
- **The page**: replies and documents are rendered through DOMPurify, and articles are parsed without running anything on them.

Anything that gets around one of these is worth reporting. So is a way for a web page, a document or a model's reply to reach your conversations or your machine.

## Not a problem in Digress

- Exposing the server to the public internet yourself. It has no login and the docs say not to.
- The [demo site](https://neejweej.github.io/digress/): static files on GitHub Pages, with no server and no model behind it. Everything a visitor does stays in their own browser.
