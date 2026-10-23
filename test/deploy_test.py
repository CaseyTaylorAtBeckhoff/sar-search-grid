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
    if os.environ.get('VERBOSE'): print(('PASS ' if ok else 'FAIL ') + profile + ': ' + name + ('  ' + str(detail) if not ok else ''), flush=True)

def gpsbabel_count(path, fmt):
    out = subprocess.run(['gpsbabel', '-r', '-i', fmt, '-f', path, '-o', 'unicsv', '-F', '-'],
                         capture_output=True, text=True)
    return len(out.stdout.strip().splitlines()) - 1 if out.returncode == 0 else -1

async def run_profile(b, name, opts):
    ctx = await b.new_context(accept_downloads=True, permissions=['geolocation'], geolocation={'latitude': 41.3655, 'longitude': -112.0745, 'accuracy': 12}, **opts)
    pg = await ctx.new_page()
    pg.set_default_timeout(int(os.environ.get('PW_TIMEOUT', '20000')))
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

    # Zoom and pan
    width_js = """() => { const p = document.querySelector('#chart .area').getAttribute('points').trim().split(' ')
        .map(q => q.split(',').map(Number)); const xs = p.map(q => q[0]); return { w: Math.max(...xs) - Math.min(...xs), x0: p[0][0], y0: p[0][1] }; }"""
    await pg.locator('#chart').scroll_into_view_if_needed()
    check(name, 'zoom buttons shown', await vis('#zoom-in') and await vis('#zoom-out') and await vis('#zoom-fit'))
    a = await pg.evaluate(width_js)
    bar0 = await pg.eval_on_selector('#scalebar', 'e => e.textContent')
    await pg.click('#zoom-in'); await pg.wait_for_timeout(450)
    b = await pg.evaluate(width_js)
    bar1 = await pg.eval_on_selector('#scalebar', 'e => e.textContent')
    check(name, '+ button zooms in 2x and rescales the scale bar', 1.9 < b['w'] / a['w'] < 2.1 and bar1 != bar0, f"{a['w']:.0f} -> {b['w']:.0f}, scale {bar1!r}")
    check(name, 'Fit enabled after zooming', await pg.is_enabled('#zoom-fit'))
    await pg.fill('#passes', '18'); await pg.wait_for_timeout(100)
    kept = await pg.evaluate(width_js)
    check(name, 'zoom kept when passes change', abs(kept['w'] - b['w']) < 1)
    await pg.click('#zoom-out'); await pg.wait_for_timeout(450)
    c = await pg.evaluate(width_js)
    check(name, '- button zooms out 2x', abs(c['w'] - a['w']) < 1.5, f"{c['w']:.1f} vs {a['w']:.1f}")
    await pg.click('#zoom-in'); await pg.wait_for_timeout(450)
    await pg.click('#zoom-fit'); await pg.wait_for_timeout(200)
    d = await pg.evaluate(width_js)
    check(name, 'Fit returns to the whole area', abs(d['w'] - a['w']) < 1 and not await pg.is_enabled('#zoom-fit'))
    box = await pg.locator('#chart').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] * 0.45
    if opts.get('has_touch'):
        cdp = await ctx.new_cdp_session(pg)
        T = lambda typ, pts: cdp.send('Input.dispatchTouchEvent', {'type': typ, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
        await T('touchStart', [(cx, cy)])
        for i in range(1, 6): await T('touchMove', [(cx + i * 8, cy + i * 3)])
        hint = await vis('#map-hint')
        await T('touchEnd', []); await pg.wait_for_timeout(400)
        e = await pg.evaluate(width_js)
        check(name, 'one finger does not move the map, shows two-finger hint', abs(e['x0'] - d['x0']) < 0.5 and hint)
        await T('touchStart', [(cx - 30, cy), (cx + 30, cy)])
        for i in range(1, 8): await T('touchMove', [(cx - 30 - i * 10, cy), (cx + 30 + i * 10, cy)])
        await T('touchEnd', []); await pg.wait_for_timeout(450)
        g = await pg.evaluate(width_js)
        check(name, 'two-finger pinch zooms in', g['w'] / d['w'] > 2.0, f"{d['w']:.0f} -> {g['w']:.0f}")
        await T('touchStart', [(cx - 20, cy), (cx + 20, cy)])
        for i in range(1, 6): await T('touchMove', [(cx - 20 + i * 12, cy + i * 6), (cx + 20 + i * 12, cy + i * 6)])
        await T('touchEnd', []); await pg.wait_for_timeout(450)
        h = await pg.evaluate(width_js)
        check(name, 'two-finger drag pans', abs(h['w'] - g['w']) < 2 and h['x0'] - g['x0'] > 20, f"moved {h['x0'] - g['x0']:.0f}")
    else:
        await pg.mouse.move(cx, cy); await pg.mouse.wheel(0, -300); await pg.wait_for_timeout(450)
        e = await pg.evaluate(width_js)
        check(name, 'mouse wheel zooms in', e['w'] / d['w'] > 1.3, f"{d['w']:.0f} -> {e['w']:.0f}")
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 60, cy + 40, steps=6); await pg.mouse.up()
        await pg.wait_for_timeout(450)
        g = await pg.evaluate(width_js)
        scale = 640 / box['width']
        check(name, 'mouse drag pans the map', abs((g['x0'] - e['x0']) - 60 * scale) < 4 and abs(g['w'] - e['w']) < 1, f"moved {g['x0'] - e['x0']:.1f}, expected {60 * scale:.1f}")
    await pg.fill('#c0', '41.3651, -112.0735'); await pg.wait_for_timeout(100)
    check(name, 'editing a corner refits the map', not await pg.is_enabled('#zoom-fit'))
    await pg.fill('#c0', '41.3650583, -112.073523'); await pg.fill('#passes', '20')

    # Satellite imagery: serve fake tiles, make zoom 16 missing so tiles fall back to 15
    await ctx.route('https://basemap.nationalmap.gov/**', tile_handler)
    await pg.evaluate('window.dispatchEvent(new Event("online"))')
    await pg.wait_for_function("document.getElementById('sat-credit').textContent.startsWith('Imagery')", timeout=8000)
    tiles = await pg.locator('#chart .vp > .sat-tiles image').count()
    fell_back = await pg.eval_on_selector_all('#chart .vp > .sat-tiles svg', 'els => els.filter(e => e.getAttribute("viewBox") !== "0 0 256 256").length')
    check(name, 'satellite tiles shown, missing zoom falls back to parent', tiles > 0 and fell_back == tiles and await pg.eval_on_selector('#chart', 'e => e.classList.contains("sat")'), f'{tiles} tiles, {fell_back} via fallback')
    await pg.screenshot(path=f'{OUT}/{name}-satellite.png', full_page=False)
    await pg.click('#sat-toggle')
    check(name, 'satellite toggle turns imagery off', await pg.locator('#chart .vp > .sat-tiles image').count() == 0 and await pg.inner_text('#sat-toggle') == 'Satellite: off')
    await pg.click('#sat-toggle')
    await ctx.unroute('https://basemap.nationalmap.gov/**')
    await ctx.route('https://basemap.nationalmap.gov/**', lambda r: r.abort())
    await pg.fill('#passes', '21'); await pg.fill('#passes', '20')
    await pg.wait_for_function("document.getElementById('sat-credit').textContent.startsWith('No satellite')", timeout=8000)
    check(name, 'no internet: preview falls back to plain water', not await pg.eval_on_selector('#chart', 'e => e.classList.contains("sat")') and await pg.locator('#chart .pass').count() == 20)
    await ctx.unroute('https://basemap.nationalmap.gov/**')

    # Paste all four corners in one go
    await pg.click('#paste-open')
    check(name, 'paste box opens', await vis('#paste-box'))
    await pg.fill('#paste-box', 'N41 21.9035 W112 04.41138 N41 22.1784 W112 04.41138 N41 22.1784 W112 04.7145 N41 21.9035 W112 04.7145')
    filled = [await pg.input_value(f'#c{i}') for i in range(4)]
    check(name, 'pasting one line of 4 positions fills all corners',
          filled[2] == 'N 41 22.1784 W 112 04.7145' and 'Filled corners' in await pg.inner_text('#paste-status'), json.dumps(filled))
    await pg.fill('#paste-box', '41.36506, -112.07352\n41.36964, -112.07352')
    check(name, 'pasting too few positions explains the problem', 'need 4' in await pg.inner_text('#paste-status')
          and await pg.input_value('#c2') == 'N 41 22.1784 W 112 04.7145')
    gpx = '<gpx>' + ''.join(f'<wpt lat="{la}" lon="{lo}"/>' for la, lo in [(41.3650583, -112.073523), (41.36964, -112.073523), (41.36964, -112.078575), (41.3650583, -112.078575)]) + '</gpx>'
    await pg.fill('#paste-box', gpx)
    check(name, 'pasting GPX waypoints fills the corners', await pg.input_value('#c3') == '41.365058, -112.078575')
    await pg.click('#paste-open')
    check(name, 'paste box closes', not await vis('#paste-box'))

    # Pick corners on a map
    await ctx.route('https://basemap.nationalmap.gov/**', tile_handler)
    before = [await pg.input_value(f'#c{i}') for i in range(4)]
    await pg.click('#pick-open')
    await pg.wait_for_selector('#pick-map .vp')
    pbox = await pg.locator('#pick-map').bounding_box()
    vw = opts['viewport']
    check(name, 'picker fills the screen, no sideways scroll', await vis('#picker') and pbox['width'] >= vw['width'] - 1
          and await pg.evaluate('document.documentElement.scrollWidth') <= vw['width'])
    check(name, 'picker shows the current corners', await pg.locator('#pick-map .pk-dot').count() == 4 and await pg.is_disabled('#pick-undo'))
    await pg.click('#pick-cancel')
    check(name, 'Cancel closes without changing corners', not await vis('#picker') and [await pg.input_value(f'#c{i}') for i in range(4)] == before)

    await pg.click('#pick-open'); await pg.wait_for_selector('#pick-map .vp')
    await pg.click('#pick-clear')
    check(name, 'Clear removes the corners and asks for corner 1', await pg.locator('#pick-map .pk-dot').count() == 0
          and 'corner 1' in await pg.inner_text('#pick-msg') and await pg.is_disabled('#pick-done'))
    pbox = await pg.locator('#pick-map').bounding_box()
    spots = [(0.35, 0.70), (0.35, 0.35), (0.65, 0.35), (0.65, 0.70)]   # SW, NW, NE, SE in screen terms
    pts = [(pbox['x'] + pbox['width'] * fx, pbox['y'] + pbox['height'] * fy) for fx, fy in spots]
    cdp = await ctx.new_cdp_session(pg) if opts.get('has_touch') else None
    async def tap(x, y):
        if cdp:
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y, 'id': 0}]})
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        else:
            await pg.mouse.click(x, y)
        await pg.wait_for_timeout(60)
    async def swipe(x, y, dx, dy):
        if cdp:
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y, 'id': 0}]})
            for i in range(1, 7):
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x + dx * i / 6, 'y': y + dy * i / 6, 'id': 0}]})
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        else:
            await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + dx, y + dy, steps=6); await pg.mouse.up()
        await pg.wait_for_timeout(400)
    for x, y in pts[:3]: await tap(x, y)
    check(name, 'tapping places corners in order', await pg.locator('#pick-map .pk-dot').count() == 3 and 'corner 4' in await pg.inner_text('#pick-msg'))
    await pg.click('#pick-undo')
    check(name, 'Undo removes the last corner', await pg.locator('#pick-map .pk-dot').count() == 2 and 'corner 3' in await pg.inner_text('#pick-msg'))
    await swipe(pbox['x'] + pbox['width'] / 2, pbox['y'] + pbox['height'] / 2, 40, 0)
    check(name, 'dragging moves the map without placing a corner', await pg.locator('#pick-map .pk-dot').count() == 2 and await pg.is_enabled('#pick-fit'))
    await pg.click('#pick-fit'); await pg.wait_for_timeout(200)
    for x, y in pts[2:]: await tap(x, y)
    check(name, 'all four placed enables Use corners', await pg.locator('#pick-map .pk-dot').count() == 4
          and await pg.locator('#pick-map .pk-area').count() == 1 and await pg.is_enabled('#pick-done'))
    await pg.click('[data-pc="1"]')
    check(name, 'picking a number lets you move that corner', 'move corner 2' in await pg.inner_text('#pick-msg'))
    await pg.fill('#pick-goto-in', '40.7608, -111.8910'); await pg.press('#pick-goto-in', 'Enter'); await pg.wait_for_timeout(200)
    check(name, 'Go to centers on a typed position', 'Centered on' in await pg.inner_text('#pick-status') and await pg.locator('#pick-map .pk-goto').count() == 1)
    await pg.click('#pick-me'); await pg.wait_for_timeout(400)
    check(name, 'My location centers on the device position', 'your location' in await pg.inner_text('#pick-status') and await pg.locator('#pick-map .pk-me').count() == 1)
    await pg.click('#pick-done')
    got = [json.loads('[' + (await pg.input_value(f'#c{i}')) + ']') for i in range(4)]
    ok_shape = got[1][0] > got[0][0] and got[2][1] > got[1][1] and abs(got[0][1] - got[1][1]) < 1e-4 and abs(got[2][0] - got[1][0]) < 1e-4
    check(name, 'Use corners fills the boxes with the tapped positions', not await vis('#picker') and ok_shape and await pg.locator('#chart .pass').count() > 0, json.dumps(got))
    await pg.click('#pick-open'); await pg.wait_for_selector('#pick-map .vp')
    await pg.keyboard.press('Escape')
    check(name, 'Escape closes the picker', not await vis('#picker'))
    await ctx.unroute('https://basemap.nationalmap.gov/**')
    for i, v in enumerate(before): await pg.fill(f'#c{i}', v)

    await pg.screenshot(path=f'{OUT}/{name}.png', full_page=True)
    check(name, 'no script errors', not errs, str(errs[:3]))
    await ctx.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, opts in PROFILES.items():
            if os.environ.get('ONLY') and name not in os.environ['ONLY'].split(','): continue
            await run_profile(b, name, opts)
        await b.close()
    srv.shutdown()
    width = max(len(r[1]) for r in results)
    for prof in [p for p in PROFILES if any(r[0] == p for r in results)]:
        rs = [r for r in results if r[0] == prof]
        print(f'\n{prof}: {sum(r[2] for r in rs)}/{len(rs)} passed')
        for _, n, ok, d in rs:
            if not ok: print(f'  FAIL {n.ljust(width)} {d}')
    print('\nTOTAL', sum(r[2] for r in results), '/', len(results))
    if not all(r[2] for r in results): sys.exit(1)

asyncio.run(main())
