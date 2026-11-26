// Shared settings defaults and per-site URL rule matching for Digress Clipper.
// Loaded by background.js (via importScripts), popup.html, options.html, and Node tests.
(function (root) {
  const DEFAULT_SETTINGS = {
    digressUrl: 'http://127.0.0.1:8788',
    rules: [
      { pattern: 'x.com', mode: 'branch', convTitle: 'Twitter clippings', focus: false },
      { pattern: 'twitter.com', mode: 'branch', convTitle: 'Twitter clippings', focus: false },
      { pattern: 'news.ycombinator.com', mode: 'branch', convTitle: 'HN clippings', focus: true },
    ],
    fallback: { mode: 'doc', convTitle: '', focus: true },
  };

  function normalizeDigressUrl(raw) {
    const s = String(raw || '').trim().replace(/\/+$/, '');
    if (!s) return DEFAULT_SETTINGS.digressUrl;
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch (_) {
      return DEFAULT_SETTINGS.digressUrl;
    }
  }

  // Matches a URL against a rule pattern:
  //   - "*.substack.com" -> any subdomain of substack.com (and substack.com itself)
  //   - "x.com"          -> x.com or www.x.com (any path)
  //   - "x.com/i/lists"  -> x.com whose pathname starts with /i/lists
  //   - "https://..."    -> exact prefix match
  function ruleMatches(urlStr, pattern) {
    const pat = String(pattern || '').trim().toLowerCase();
    if (!pat) return false;
    if (pat === '*') return true;
    let u;
    try { u = new URL(urlStr); } catch (_) { return false; }
    if (/^https?:\/\//i.test(pat)) return urlStr.toLowerCase().startsWith(pat);
    const slash = pat.indexOf('/');
    const hostPat = (slash >= 0 ? pat.slice(0, slash) : pat).replace(/^www\./, '');
    const pathPat = slash >= 0 ? pat.slice(slash) : '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let hostOk = false;
    if (hostPat.startsWith('*.')) {
      const base = hostPat.slice(2);
      hostOk = host === base || host.endsWith('.' + base);
    } else {
      hostOk = host === hostPat;
    }
    if (!hostOk) return false;
    if (!pathPat) return true;
    return (u.pathname + u.search).toLowerCase().startsWith(pathPat);
  }

  function matchRule(urlStr, settings) {
    const cfg = settings || DEFAULT_SETTINGS;
    const rules = Array.isArray(cfg.rules) ? cfg.rules : DEFAULT_SETTINGS.rules;
    for (const r of rules) {
      if (r && ruleMatches(urlStr, r.pattern)) {
        return {
          mode: r.mode === 'branch' ? 'branch' : 'doc',
          convTitle: String(r.convTitle || '').trim(),
          focus: r.focus !== false,
          pattern: r.pattern,
        };
      }
    }
    const fb = cfg.fallback || DEFAULT_SETTINGS.fallback;
    return {
      mode: fb.mode === 'branch' ? 'branch' : 'doc',
      convTitle: String(fb.convTitle || '').trim(),
      focus: fb.focus !== false,
      pattern: '*',
    };
  }

  const api = { DEFAULT_SETTINGS, normalizeDigressUrl, ruleMatches, matchRule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DigressRules = api;
})(typeof self !== 'undefined' ? self : globalThis);
