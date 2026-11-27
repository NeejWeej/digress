# Browser Clipper extension

The **Digress Clipper** (`extension/`) is a small Manifest V3 browser extension for Chrome, Brave, Arc, and Edge that sends tweets, highlighted selections, or paywalled web articles straight into your Digress instance—without sharing logins or cookies with the server.

## Install (unpacked, no store needed)

1. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder in this repository.
4. Click the extension’s icon → **Settings**, and set **Digress URL** to your own server (e.g. `https://your-box.tailnet.ts.net` or `http://127.0.0.1:8788`).

## How to clip

- **On X / Twitter:**
  - Click the small **Digress branch icon** injected into any tweet’s action bar right from your scrolling feed (`Shift+Click` to jump straight to Digress), **or**
  - Right-click anywhere on a tweet → **Send to Digress**, which opens a submenu: **Send using site rule**, **Send thread up to here**, **Send just this tweet**, **Branch in current conversation**, or **New document conversation**.
  - By default, tweets clip as isolated branches into a **"Twitter clippings"** conversation in the background with a fading in-page confirmation toast (and an **Open** button). Each branch sends only that tweet or thread (plus quoted tweets and up to 4 images) to the model—never the rest of your clippings. Long clipped passages include a **Show full / Show less** toggle at the top of the branch.
- **On any other website:**
  - Highlight text and right-click → **Send to Digress** (or press `Alt+D`) to clip the selection, or trigger it with nothing selected to send the full rendered page (including paywalled articles you’re logged into) through Digress’s reader view.
  - Click the toolbar icon to pick an **existing conversation** (or create a new one), choose **+ New clipped branch** (with an optional custom branch title) or drop the clip into an **existing branch**, add an optional question/note (`⌘/Ctrl+Enter` to send), or tick **Remember for `<site>`** to save a per-site rule in one click.

## Settings & per-site rules

In **Settings**, click **Detect open tab** or **Test** to connect to your Digress URL, choose your default X clip scope (**Single tweet** vs. **Thread up to clicked tweet**) and whether to show in-page toasts, and add ordered rules mapping hostnames (`x.com`), wildcard subdomains (`*.substack.com`), or URL prefixes (`x.com/i/lists/123`) to either:

- **Branch in conversation** (with live conversation name suggestions; auto-creates the conversation if it doesn’t exist yet), or
- **New document conversation**,

plus whether to focus the Digress tab or clip silently in the background. Use ↑/↓ to reorder rules—first matching rule wins; everything else uses the default fallback rule.
