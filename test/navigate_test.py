"""Browser checks for the Navigate page, served over HTTP as GitHub Pages would.

Uses a scripted GPS (window.__gps) so a boat can be driven along a route quickly and
deterministically. Run: python test/navigate_test.py   (env: VERBOSE=1, ONLY=desktop,phone)
"""
import asyncio, functools, http.server, io, json, os, re, sys, threading, zipfile
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent / 'dist'
OUT = HERE.parent / 'test-output'
OUT.mkdir(exist_ok=True)
WORK = OUT / 'nav-files'
WORK.mkdir(exist_ok=True)
PORT = 8775
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
handler = functools.partial(Quiet, directory=str(ROOT))
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{PORT}/'

PROFILES = {
    'phone': dict(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True, color_scheme='dark'),
    'small-phone': dict(viewport={'width': 320, 'height': 640}, device_scale_factor=2, is_mobile=True, has_touch=True),
    'tablet': dict(viewport={'width': 820, 'height': 1180}, device_scale_factor=2, is_mobile=True, has_touch=True),
    'desktop': dict(viewport={'width': 1366, 'height': 900}),
}

# ---------- Test files ----------
FIX = (HERE / 'fixtures' / 'foursided-c.gpx').read_text()
PTS = [(float(a), float(b)) for a, b in re.findall(r'<rtept lat="([-\d.]+)" lon="([-\d.]+)"', FIX)]
(WORK / 'Hit3.gpx').write_text(FIX)
kml = ('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Search line</name>'
       '<LineString><coordinates>' + ' '.join(f'{lo},{la},0' for la, lo in PTS) + '</coordinates></LineString></Placemark></Document></kml>')
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('doc.kml', kml)
(WORK / 'area.kmz').write_bytes(buf.getvalue())
half = len(PTS) // 2
two = ('<?xml version="1.0"?><gpx version="1.1"><rte><name>Big-1</name>' + ''.join(f'<rtept lat="{a}" lon="{b}"/>' for a, b in PTS[:half + 1]) +
       '</rte><rte><name>Big-2</name>' + ''.join(f'<rtept lat="{a}" lon="{b}"/>' for a, b in PTS[half:]) + '</rte></gpx>')
(WORK / 'Big.gpx').write_text(two)
(WORK / 'notes.txt').write_text('not a route')

# Scripted GPS: replaces navigator.geolocation; the test feeds fixes with window.__gps.fix(lat, lon, acc).
GPS_SHIM = """
(() => {
  const watchers = new Map(); let id = 0, last = null, denied = false;
  const geo = {
    watchPosition(ok, err) { const i = ++id; watchers.set(i, { ok, err }); if (denied) setTimeout(() => err && err({ code: 1, message: 'denied' }), 0); else if (last) setTimeout(() => ok(last), 0); return i; },
    clearWatch(i) { watchers.delete(i); },
    getCurrentPosition(ok, err) { if (denied) setTimeout(() => err && err({ code: 1 }), 0); else if (last) setTimeout(() => ok(last), 0); }
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  window.__gps = {
    fix(lat, lon, acc, t, heading, speed) {
      last = { coords: { latitude: lat, longitude: lon, accuracy: acc || 5, heading: heading ?? null, speed: speed ?? null }, timestamp: t || Date.now() };
      watchers.forEach(w => w.ok(last));
    },
    deny() { denied = true; watchers.forEach(w => w.err && w.err({ code: 1, message: 'denied' })); },
    count: () => watchers.size
  };
})();
"""

results = []
def check(profile, name, ok, detail=''):
    results.append((profile, name, bool(ok), detail))
    if os.environ.get('VERBOSE'):
        print(('PASS ' if ok else 'FAIL ') + profile + ': ' + name + ('' if ok else '  ' + str(detail)), flush=True)


async def run_profile(b, name, opts):
    ctx = await b.new_context(**opts)
    await ctx.add_init_script(GPS_SHIM)
    await ctx.route('https://basemap.nationalmap.gov/**', lambda r: r.abort())
    await ctx.route('https://fonts.googleapis.com/**', lambda r: r.abort())
    pg = await ctx.new_page()
    pg.set_default_timeout(int(os.environ.get('PW_TIMEOUT', '15000')))
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    vis = pg.is_visible
    vw = opts['viewport']

    # Fresh visit: nothing to offer from the builder yet.
    await pg.goto(BASE + 'navigate.html')
    await pg.wait_for_selector('#p-setup')
    check(name, 'opens on "Follow a route"', await vis('#p-setup') and not await vis('#use-grid'))
    check(name, 'no sideways scroll, page does not scroll', await pg.evaluate('document.documentElement.scrollWidth') <= vw['width']
          and await pg.evaluate('document.scrollingElement.scrollHeight') <= vw['height'] + 1)
    mb = await pg.locator('.mapbox').bounding_box()
    check(name, 'map gets a usable share of the screen', mb['height'] >= 160 and mb['width'] >= vw['width'] * (0.55 if vw['width'] >= 900 else 0.99), json.dumps(mb))

    # Bad file
    await pg.set_input_files('#file-in', str(WORK / 'notes.txt'))
    await pg.wait_for_function("document.getElementById('load-status').textContent.includes('notes.txt')")
    check(name, 'a non-route file gives a clear message', 'GPX, KML or KMZ' in await pg.inner_text('#load-status'))

    # GPX from the grid builder
    await pg.set_input_files('#file-in', str(WORK / 'Hit3.gpx'))
    await pg.wait_for_selector('#p-choose:not([hidden])')
    check(name, 'GPX file loads and is recognised as a 16-pass grid', await pg.inner_text('#r-name') == 'Hit3'
          and '16 passes' in await pg.inner_text('#r-sum'), await pg.inner_text('#r-sum'))
    check(name, 'route drawn on the map', await pg.locator('#nav-map .rt-pass').count() == 16 and await pg.locator('#nav-map .rt-turn').count() == 15)
    check(name, 'nearest-point start waits for GPS', await pg.is_disabled('#start-near') and 'GPS' in await pg.inner_text('#near-desc'))

    # GPS fix near the middle of pass 7 (legs 12): nearest point offered.
    a, b2 = PTS[12], PTS[13]
    await pg.evaluate('([la, lo]) => window.__gps.fix(la, lo, 6)', [(a[0] + b2[0]) / 2, a[1] + 0.00003])
    await pg.wait_for_function("!document.getElementById('start-near').disabled")
    check(name, 'nearest point names the pass and distance', 'Pass 7' in await pg.inner_text('#near-desc'), await pg.inner_text('#near-desc'))
    check(name, 'GPS accuracy shown', 'GPS ±' in await pg.inner_text('#gps-text') and 'good' in (await pg.get_attribute('#gps-chip', 'class')))
    check(name, 'boat and link to nearest point drawn', await pg.locator('#nav-map .boat').count() == 1 and await pg.locator('#nav-map .near-pt').count() == 1)

    # Tap pass 3 (leg 4) on the map to choose it.
    box = await pg.locator('#nav-map').bounding_box()
    sel = await pg.evaluate('''([la, lo]) => {
        const svg = document.getElementById('nav-map'); const vb = svg.viewBox.baseVal; const r = svg.getBoundingClientRect();
        const line = [...svg.querySelectorAll('.rt-pass')][2];
        const x = (line.x1.baseVal.value + line.x2.baseVal.value) / 2, y = (line.y1.baseVal.value + line.y2.baseVal.value) / 2;
        return [r.left + x * r.width / vb.width, r.top + y * r.height / vb.height]; }''', [0, 0])
    if opts.get('has_touch'):
        cdp = await ctx.new_cdp_session(pg)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': sel[0], 'y': sel[1], 'id': 0}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    else:
        await pg.mouse.click(sel[0], sel[1])
    await pg.wait_for_timeout(150)
    check(name, 'tapping a pass on the map chooses it', not await pg.is_disabled('#start-sel') and 'pass 3' in await pg.inner_text('#sel-title')
          and await pg.locator('#nav-map .rt-sel').count() == 1, await pg.inner_text('#sel-title'))

    # Units
    await pg.select_option('#units', 'm')
    check(name, 'switching to metres updates the summary', ' m apart' in await pg.inner_text('#r-sum'))
    await pg.select_option('#units', 'ft')

    # Remembered after reload
    await pg.reload(); await pg.wait_for_selector('#p-choose:not([hidden])')
    check(name, 'route remembered after reload', await pg.inner_text('#r-name') == 'Hit3')

    # Multi-route GPX (a grid split for Humminbird): joined first, choice offered.
    await pg.click('#change-route')
    await pg.set_input_files('#file-in', str(WORK / 'Big.gpx'))
    await pg.wait_for_selector('#p-choose:not([hidden])')
    opts_txt = await pg.eval_on_selector_all('#r-cand option', 'os => os.map(o => o.textContent)')
    check(name, 'split routes are joined, with a choice of lines', await vis('#r-cand') and len(opts_txt) == 3 and 'all routes joined' in opts_txt[0]
          and '16 passes' in await pg.inner_text('#r-sum'), json.dumps(opts_txt))
    await pg.select_option('#r-cand', '1')
    check(name, 'choosing another line in the file switches to it', 'Big-1' in await pg.inner_text('#r-name'))

    # KMZ
    await pg.click('#change-route')
    await pg.set_input_files('#file-in', str(WORK / 'area.kmz'))
    await pg.wait_for_selector('#p-choose:not([hidden])')
    check(name, 'KMZ from Google Earth opens', await pg.inner_text('#r-name') == 'Search line' and '16 passes' in await pg.inner_text('#r-sum'))

    # Builder hand-off: visit the builder, then "Navigate this grid".
    await pg.goto(BASE + 'index.html'); await pg.wait_for_selector('#stats .stat')
    check(name, 'builder links to Navigate', await vis('#appnav') and await vis('#nav-this'))
    await pg.click('#nav-this')
    await pg.wait_for_selector('#p-choose:not([hidden])')
    check(name, '"Navigate this grid" opens the builder grid', await pg.inner_text('#r-name') == 'Hit3' and '16 passes' in await pg.inner_text('#r-sum')
          and '#grid' not in pg.url)
    await pg.click('#change-route')
    check(name, 'builder grid offered on the setup screen', await vis('#use-grid') and 'Hit3' in await pg.inner_text('#use-grid-desc'))

    # Location denied: explains, and nearest stays off.
    pg2 = await ctx.new_page()
    await pg2.goto(BASE + 'navigate.html'); await pg2.wait_for_selector('#p-choose:not([hidden])')
    await pg2.evaluate('window.__gps.deny()')
    await pg2.wait_for_function("document.getElementById('near-desc').textContent.includes('Location is off')")
    check(name, 'location denied: says how to fix it', await pg2.is_disabled('#start-near') and 'No GPS' in await pg2.inner_text('#gps-text'))
    await pg2.close()

    await pg.screenshot(path=str(OUT / f'navigate-{name}.png'))
    check(name, 'no script errors', not errs, str(errs[:3]))
    await ctx.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        only = os.environ.get('ONLY')
        for name, opts in PROFILES.items():
            if only and name not in only.split(','):
                continue
            await run_profile(b, name, opts)
        await b.close()
    srv.shutdown()
    for prof in [p for p in PROFILES if any(r[0] == p for r in results)]:
        rs = [r for r in results if r[0] == prof]
        print(f'{prof}: {sum(r[2] for r in rs)}/{len(rs)} passed')
        for _, n, ok, d in rs:
            if not ok:
                print(f'  FAIL {n}  {d}')
    print('TOTAL', sum(r[2] for r in results), '/', len(results))
    if not all(r[2] for r in results):
        sys.exit(1)

asyncio.run(main())
