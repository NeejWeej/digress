"""Draws the app icons from web/icon.svg (light colors) on the home-screen icon's cream background:
  web/icon-192.png, web/icon-512.png       the logo filling most of the square (Android's "any" icons)
  web/icon-maskable-512.png                the logo inside the middle 60%, which Android crops to a circle,
                                           squircle or rounded square (its "maskable" icon)
Run: python3 docs/media/make_icons.py"""
import asyncio, os, re
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, '..', '..', 'web')
BG = '#fffaf2'   # the same as apple-touch-icon.png

def svg():
    s = open(os.path.join(WEB, 'icon.svg')).read()
    s = re.sub(r'@media[^{]*\{[^}]*\}[^}]*\}[^}]*\}[^}]*\}[^}]*\}', '', s)   # light colors only
    return re.sub(r'<!--.*?-->', '', s, flags=re.S)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, size, logo in [('icon-192.png', 192, .70), ('icon-512.png', 512, .70), ('icon-maskable-512.png', 512, .50)]:
            pg = await b.new_page(viewport={'width': size, 'height': size})
            px = round(size * logo)
            await pg.set_content(f'<html><body style="margin:0;width:{size}px;height:{size}px;background:{BG};display:flex;align-items:center;justify-content:center">'
                                 f'<div style="width:{px}px;height:{px}px">{svg().replace("<svg ", f"<svg width={px} height={px} ", 1)}</div></body></html>')
            await pg.screenshot(path=os.path.join(WEB, name))
            await pg.close()
            print('wrote', name)
        await b.close()

asyncio.run(main())
