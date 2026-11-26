# Browser Clipper extension

The **Digress Clipper** (`extension/`) is a small Manifest V3 browser extension for Chrome, Brave, Arc, and Edge that sends tweets, highlighted selections, or paywalled web articles straight into your Digress instance—without sharing logins or cookies with the server.

## Install (unpacked, no store needed)

1. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder in this repository.
4. Click the extension’s icon → **Settings**, and set **Digress URL** to your own server (e.g. `https://your-box.tailnet.ts.net` or `http://127.0.0.1:8788`).

## How to clip

- **On X / Twitter:**
  - Click the small **Digress branch icon** injected into any tweet’s action bar right from your scrolling feed (no need to open the tweet), **or**
  - Right-click anywhere on a tweet → **Send to Digress**.
  - By default, tweets clip as isolated branches into a **"Twitter clippings"** conversation in the background so you can keep scrolling. Each branch sends only that tweet (plus its quoted tweet and attached images) to the model—never the rest of your clippings.
- **On any other website:**
  - Highlight text and right-click → **Send to Digress** (or press `Alt+D`) to clip the selection, or trigger it with nothing selected to send the full rendered page (including paywalled articles you’re logged into) through Digress’s reader view.
  - Click the toolbar icon to override the destination for a single clip (new document vs. branch in a named conversation, and whether to switch to the Digress tab).

## Per-site rules

In **Settings**, add ordered rules mapping hostnames (`x.com`), wildcard subdomains (`*.substack.com`), or URL prefixes (`x.com/i/lists/123`) to either:

- **Branch in conversation** (auto-creates the conversation if it doesn’t exist yet), or
- **New document conversation**,

plus whether to focus the Digress tab or clip silently in the background. First matching rule wins; everything else uses the default fallback rule.
