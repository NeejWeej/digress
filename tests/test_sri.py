"""Every library the page loads carries a Subresource Integrity hash, and each hash is that of the exact file.
  - Every CDN script URL in web/index.html is in LIBS, with this server's copy (lib/...) and the file's hash.
  - Each hash matches the copy in node_modules (the CDN serves the npm file byte for byte, and lib/ serves
    node_modules itself), so bumping a version without its hash fails here, not in someone's browser.
  - The <script> tags use LIBS's hash for their lib/ copy, and load with CORS (crossorigin), which the check needs.
  - server/libs.json (what the server will serve) lists exactly LIBS's lib/ copies.
No browser needed. Asserts and exits non-zero."""
import base64, hashlib, os, re, sys
from common import REPO, LIBS, lib_path

fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name, '' if ok else str(detail)[:300])
    if not ok: fails.append(name)

page = open(os.path.join(REPO, 'web', 'index.html'), encoding='utf-8').read()
table = page[page.index('window.LIBS={'):page.index('};', page.index('window.LIBS={'))]
libs = {c: (l, h) for c, l, h in re.findall(r"'(https://[^']+)':\['(lib/[^']+)','(sha384-[^']+)'\]", table)}
urls = sorted({u for u in re.findall(r"https://(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)/[^\"'`\s]+", page) if u.endswith('.js')})
pdfjs = re.search(r"const PDFJS='([^']+)'", page).group(1)   # pdf.js and its worker: the base URL, then the file names
urls = sorted(set(urls) | {pdfjs + 'pdf.min.js', pdfjs + 'pdf.worker.min.js'})
sha = lambda f: 'sha384-' + base64.b64encode(hashlib.sha384(open(f, 'rb').read()).digest()).decode()

check('the page loads libraries', len(urls) >= 10, urls)
for u in urls:
    l, h = libs.get(u, (None, None))
    f = l and lib_path(l[4:])
    check(f'{u.split("/")[-1]}: in LIBS, with a copy here and the file’s hash', bool(f) and os.path.isfile(f) and h == sha(f), {'url': u, 'lib': l, 'page': h, 'node_modules': f and os.path.isfile(f) and sha(f)})
check('libs.json lists exactly those copies', sorted(l[4:] for l, _ in libs.values()) == sorted(LIBS), [sorted(l[4:] for l, _ in libs.values()), LIBS])
tags = re.findall(r'<script[^>]*?src="(lib/[^"]+)"[^>]*?integrity="([^"]+)"', page)
check('the <script> tags load this server’s copies', len(tags) >= 4, tags)
byl = {l: h for l, h in libs.values()}
for src, h in tags:
    check(f'<script src="{src}"> has LIBS’s hash for it', byl.get(src) == h, [h, byl.get(src)])
nocors = re.findall(r'<script[^>]*integrity="[^"]+"(?![^>]*crossorigin)[^>]*>', page)
check('every <script> with a hash is loaded with CORS (crossorigin), which the hash check needs', not nocors, nocors)
print('\nall passed' if not fails else f'\n{len(fails)} failed: {fails}')
sys.exit(1 if fails else 0)
