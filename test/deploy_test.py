"""Deployment test: serve dist/ over HTTP (as GitHub Pages would) and exercise the
standalone page in phone and desktop browser profiles."""
import asyncio, http.server, threading, functools, subprocess, json, os, sys
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
ROOT = str(HERE.parent / 'dist')
OUT = str(HERE.parent / 'test-output')
os.makedirs(OUT, exist_ok=True)
PORT = 8765

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'

PROFILES = {
    'android-phone': dict(viewport={'width': 412, 'height': 915}, device_scale_factor=2.6, is_mobile=True, has_touch=True,
                          user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'),
    'iphone-size': dict(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True, color_scheme='dark',
                        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
    'small-phone': dict(viewport={'width': 320, 'height': 640}, device_scale_factor=2, is_mobile=True, has_touch=True),
    'tablet': dict(viewport={'width': 820, 'height': 1180}, device_scale_factor=2, is_mobile=True, has_touch=True),
    'desktop': dict(viewport={'width': 1366, 'height': 900}),
}


import io
from PIL import Image, ImageDraw
def _tile_png():
    im = Image.new('RGB', (256, 256), (46, 74, 58)); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 255, 140], fill=(28, 58, 86)); d.line([0, 140, 255, 150], fill=(150, 140, 110), width=6)
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
TILE = _tile_png()
async def tile_handler(route):
    z = int(route.request.url.split('/tile/')[1].split('/')[0])
    if z >= 16: await route.fulfill(status=404, body='Tile not found')
    else: await route.fulfill(status=200, body=TILE, content_type='image/png')

results = []
def check(profile, name, ok, detail=''):
    results.append((profile, name, bool(ok), detail))

def gpsbabel_count(path, fmt):
    out = subprocess.run(['gpsbabel', '-r', '-i', fmt, '-f', path, '-o', 'unicsv', '-F', '-'],
                         capture_output=True, text=True)
    return len(out.stdout.strip().splitlines()) - 1 if out.returncode == 0 else -1

async def run_profile(b, name, opts):
    ctx = await b.new_context(accept_downloads=True, **opts)
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text and 'Failed to load resource' not in m.text else None)
    await pg.goto(URL)
    await pg.wait_for_selector('#stats .stat')

    vis = lambda sel: pg.is_visible(sel)
    sw = await pg.evaluate('document.documentElement.scrollWidth')
    check(name, 'no horizontal scroll', sw <= opts['viewport']['width'], f'scrollWidth {sw}')
    check(name, 'no speed field', await pg.locator('#speed').count() == 0)
    check(name, 'units hidden in "number of passes" mode', not await vis('#units'))
    stats = await pg.locator('#stats .stat').count()
    check(name, 'five stats, no time estimate', stats == 5 and 'mph' not in await pg.inner_text('#stats'), f'{stats} stats')

    # Stats fill every row edge to edge (no empty cells)
    boxes = await pg.eval_on_selector_all('#stats .stat', 'els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top]; })')
    grid = await pg.eval_on_selector('#stats', 'e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }')
    rows = {}
    for l, r, t in boxes: rows.setdefault(round(t), []).append((l, r))
    full = all(abs(min(x[0] for x in v) - grid[0]) < 3 and abs(max(x[1] for x in v) - grid[1]) < 3 for v in rows.values())
    check(name, 'stats rows have no empty cells', full, f'{len(rows)} rows')

    # Touch targets
    small = await pg.eval_on_selector_all('button:not(.link), select, input', 'els => els.filter(e => e.offsetParent && e.getBoundingClientRect().height < 38).map(e => e.id || e.textContent.trim())')
    check(name, 'controls at least 38px tall', not small, str(small))

    # Downloads straight from the deployed page
    for btn, ext, fmt, expect in (('#save-hwr', 'hwr', 'humminbird', 32), ('#save-gpx', 'gpx', 'gpx', 32)):
        async with pg.expect_download() as d:
            await pg.click(btn)
        dl = await d.value
        path = f'{OUT}/{name}.{ext}'
        await dl.save_as(path)
        n = gpsbabel_count(path, fmt)
        check(name, f'.{ext} downloads and reads back', dl.suggested_filename == f'Hit3.{ext}' and n == expect,
              f'{dl.suggested_filename}, {n} points')

    # Spacing mode shows units; switching units keeps the physical distance
    await pg.click('#pm-spacing')
    check(name, 'units shown in lane spacing mode', await vis('#units'))
    ft = float(await pg.input_value('#spacing'))
    await pg.select_option('#units', 'm')
    m = float(await pg.input_value('#spacing'))
    check(name, 'feet -> metres keeps spacing', abs(ft * 0.3048 - m) < 0.1, f'{ft} ft -> {m} m')
    await pg.select_option('#units', 'ft')
    await pg.click('#pm-count')
    check(name, 'units hidden again after switching back', not await vis('#units'))

    # Center & size has its own units picker, kept in sync
    await pg.click('#mode-center')
    check(name, 'center mode shows units next to length/width', await vis('#units-center'))
    await pg.select_option('#units-center', 'm')
    same = await pg.input_value('#units') == 'm'
    check(name, 'both unit pickers stay in sync', same)
    await pg.select_option('#units-center', 'ft')
    await pg.click('#mode-corners')

    # Paste four lines into corner 1
    lines = '41.3650583, -112.073523\nN41 22.178 W112 04.411\nN 41° 22.178\' W 112° 04.715\'\n41°21\'54.21"N 112°04\'42.87"W'
    await pg.fill('#c0', '')
    await pg.evaluate("""t => { const el = document.getElementById('c0'); const dt = new DataTransfer(); dt.setData('text/plain', t);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""", lines)
    vals = [await pg.input_value(f'#c{i}') for i in range(4)]
    check(name, 'pasting four lines fills all corners', all(vals) and vals[3].startswith('41°'), json.dumps(vals))

    # Works offline once loaded (everything is inline)
    await ctx.set_offline(True)
    await pg.fill('#passes', '20')
    async with pg.expect_download() as d:
        await pg.click('#save-hwr')
    dl = await d.value
    await dl.save_as(f'{OUT}/{name}-offline.hwr')
    check(name, 'generates files with no signal (page already open)', gpsbabel_count(f'{OUT}/{name}-offline.hwr', 'humminbird') == 40)
    await ctx.set_offline(False)

    # Settings survive a reload
    await pg.reload()
    await pg.wait_for_selector('#stats .stat')
    check(name, 'settings remembered after reload', await pg.input_value('#passes') == '20')

    # Satellite imagery: serve fake tiles, make zoom 16 missing so tiles fall back to 15
    await ctx.route('https://basemap.nationalmap.gov/**', tile_handler)
    await pg.evaluate('window.dispatchEvent(new Event("online"))')
    await pg.wait_for_function("document.getElementById('sat-credit').textContent.startsWith('Imagery')", timeout=8000)
    tiles = await pg.locator('#chart .sat-tiles image').count()
    fell_back = await pg.eval_on_selector_all('#chart .sat-tiles svg', 'els => els.filter(e => e.getAttribute("viewBox") !== "0 0 256 256").length')
    check(name, 'satellite tiles shown, missing zoom falls back to parent', tiles > 0 and fell_back == tiles and await pg.eval_on_selector('#chart', 'e => e.classList.contains("sat")'), f'{tiles} tiles, {fell_back} via fallback')
    await pg.screenshot(path=f'{OUT}/{name}-satellite.png', full_page=False)
    await pg.click('#sat-toggle')
    check(name, 'satellite toggle turns imagery off', await pg.locator('#chart .sat-tiles image').count() == 0 and await pg.inner_text('#sat-toggle') == 'Satellite: off')
    await pg.click('#sat-toggle')
    await ctx.unroute('https://basemap.nationalmap.gov/**')
    await ctx.route('https://basemap.nationalmap.gov/**', lambda r: r.abort())
    await pg.fill('#passes', '21'); await pg.fill('#passes', '20')
    await pg.wait_for_function("document.getElementById('sat-credit').textContent.startsWith('No satellite')", timeout=8000)
    check(name, 'no internet: preview falls back to plain water', not await pg.eval_on_selector('#chart', 'e => e.classList.contains("sat")') and await pg.locator('#chart .pass').count() == 20)
    await ctx.unroute('https://basemap.nationalmap.gov/**')

    await pg.screenshot(path=f'{OUT}/{name}.png', full_page=True)
    check(name, 'no script errors', not errs, str(errs[:3]))
    await ctx.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, opts in PROFILES.items():
            await run_profile(b, name, opts)
        await b.close()
    srv.shutdown()
    width = max(len(r[1]) for r in results)
    for prof in PROFILES:
        rs = [r for r in results if r[0] == prof]
        print(f'\n{prof}: {sum(r[2] for r in rs)}/{len(rs)} passed')
        for _, n, ok, d in rs:
            if not ok: print(f'  FAIL {n.ljust(width)} {d}')
    print('\nTOTAL', sum(r[2] for r in results), '/', len(results))
    if not all(r[2] for r in results): sys.exit(1)

asyncio.run(main())
