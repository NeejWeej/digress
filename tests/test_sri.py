"""Every library the page loads from a CDN carries a Subresource Integrity hash, and each hash is that of the exact file.
  - Every CDN script URL in web/index.html has a hash: in its <script> tag, or in SRI (for the ones loaded later).
  - Each hash matches the copy in node_modules (the CDN serves the npm file byte for byte), so bumping a version
    without its hash fails here, not in someone's browser.
No browser needed. Asserts and exits non-zero."""
import base64, hashlib, os, re, sys
from common import REPO, ROOT, CDN

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

page = open(os.path.join(REPO, 'web', 'index.html'), encoding='utf-8').read()
urls = sorted({u for u in re.findall(r"https://(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)/[^\"'`\s]+", page) if u.endswith('.js')})
pdfjs = re.search(r"const PDFJS='([^']+)'", page).group(1)   # pdf.js and its worker: the base URL, then the file names
urls += [pdfjs + 'pdf.min.js', pdfjs + 'pdf.worker.min.js']
tags = dict(re.findall(r'<script[^>]*?src="([^"]+)"[^>]*?integrity="([^"]+)"', page))
sri = dict(re.findall(r"'(https://[^']+)':'(sha384-[^']+)'", page[page.index('const SRI={'):page.index('};', page.index('const SRI={'))]))

check('the page loads libraries from CDNs', len(urls) >= 10, urls)
for u in urls:
    have = tags.get(u) or sri.get(u)
    local = next((v for k, v in CDN.items() if u.endswith(k)), None)
    want = local and 'sha384-' + base64.b64encode(hashlib.sha384(open(ROOT + local, 'rb').read()).digest()).decode()
    check(f'{u.split("/")[-1]}: has a hash, and it is the file’s', have and have == want, {'url': u, 'page': have, 'node_modules': want})
nocors = re.findall(r'<script[^>]*integrity="[^"]+"(?![^>]*crossorigin)[^>]*>', page)
check('every <script> with a hash is loaded with CORS (crossorigin), which the hash check needs', not nocors, nocors)
print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
sys.exit(1 if fails else 0)
