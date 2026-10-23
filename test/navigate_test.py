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

    # ---------- Live navigation (scripted boat) ----------
    import math
    def off(pt, north_m, east_m):
        return (pt[0] + north_m / 111195.0, pt[1] + east_m / (111195.0 * math.cos(math.radians(pt[0]))))
    async def fix(pt, acc=5, speed=1.5):
        await pg.evaluate('([la, lo, a, v]) => window.__gps.fix(la, lo, a, undefined, null, v)', [pt[0], pt[1], acc, speed])
    async def text(sel): return (await pg.inner_text(sel)).strip()
    await pg.click('#use-grid'); await pg.wait_for_selector('#p-choose:not([hidden])')
    p1a, p1b = PTS[0], PTS[1]            # pass 1 runs north
    await fix(off(p1a, -60, 0))
    await pg.click('#start-begin'); await pg.wait_for_selector('#p-nav:not([hidden])')
    check(name, 'Beginning starts on pass 1', 'Pass 1' in await text('#nav-leg') and 'of 16' in await text('#nav-leg'), await text('#nav-leg'))
    check(name, 'before the pass: heads to its start', 'start of pass 1' in await text('#steer-what') and 'head 000' in await text('#steer-what'), await text('#steer-what'))
    L = (p1b[0] - p1a[0]) * 111195.0
    await fix(off(p1a, 20, 0)); await fix(off(p1a, 40, 12))
    check(name, 'right of the line: steer left with the distance', 'steer left' in await text('#steer-what') and await text('#steer-arrow') == '◀'
          and 'off' in await pg.get_attribute('#steer', 'class') and await text('#steer-big') in ('39 ft', '40 ft'), await text('#steer-big'))
    await fix(off(p1a, 60, -12))
    check(name, 'left of the line: steer right', 'steer right' in await text('#steer-what') and await text('#steer-arrow') == '▶')
    await fix(off(p1a, 80, 1))
    check(name, 'on the line: says so', await text('#steer-big') == 'On line' and 'on' in (await pg.get_attribute('#steer', 'class')).split())
    check(name, 'distance to the end of the pass', 'pass 1' in await text('#prog-label') and abs(int(re.sub(r'[^0-9]', '', await text('#prog-to'))) - (L - 80) / 0.3048) < 4,
          await text('#prog-to'))
    check(name, 'speed and course shown', await text('#f-speed') == '3.4 mph' and await text('#f-course') == '033°' and 'line 000°' in (await text('#f-line')).lower(),
          await text('#f-speed') + ' ' + await text('#f-course') + ' ' + await text('#f-line'))
    for d in range(100, int(L) + 4, 25): await fix(off(p1a, min(d, L + 2), 0.5))
    check(name, 'end of pass 1 moves on to the turn', 'Turn' in await text('#nav-leg') and await pg.is_visible('#toast') and 'Pass 1 done' in await text('#toast'),
          await text('#nav-leg'))
    await pg.click('#nav-next')
    check(name, 'Skip moves to the next pass', 'Pass 2' in await text('#nav-leg'))
    await pg.click('#nav-prev'); await pg.click('#nav-prev')
    check(name, 'Back returns to pass 1 and stays there at its end', 'Pass 1' in await text('#nav-leg'))
    await fix(off(p1b, 0, 0.5))
    check(name, '...even with the next GPS fix', 'Pass 1' in await text('#nav-leg'))
    m7 = ((PTS[12][0] + PTS[13][0]) / 2, PTS[12][1])
    await fix(off(m7, 0, 3))
    await pg.click('#nav-near')
    check(name, 'Nearest jumps to the pass the boat is on', 'Pass 7' in await text('#nav-leg') and 'Jumped to pass 7' in await text('#toast'))
    await pg.wait_for_timeout(300)
    async def boat_offset():
        return await pg.evaluate("""() => { const svg = document.getElementById('nav-map'); const r = svg.getBoundingClientRect();
            const b = svg.querySelector('.boat, .boat-arrow').getBoundingClientRect();
            return [b.left + b.width / 2 - (r.left + r.width / 2), b.top + b.height / 2 - (r.top + r.height / 2)]; }""")
    await fix(off(m7, 15, 2)); await pg.wait_for_timeout(350)
    o = await boat_offset()
    check(name, 'map follows the boat', abs(o[0]) < 6 and abs(o[1]) < 6, str(o))
    mb = await pg.locator('#nav-map').bounding_box()
    cx, cy = mb['x'] + mb['width'] / 2, mb['y'] + mb['height'] / 2
    if opts.get('has_touch'):
        cdp = await ctx.new_cdp_session(pg)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': cx, 'y': cy, 'id': 0}]})
        for i in range(1, 6): await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': cx + i * 15, 'y': cy, 'id': 0}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    else:
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 75, cy, steps=5); await pg.mouse.up()
    await pg.wait_for_timeout(350)
    await fix(off(m7, 20, 2)); await pg.wait_for_timeout(350)
    o = await boat_offset()
    check(name, 'moving the map by hand stops following', await pg.get_attribute('#nav-follow', 'aria-pressed') == 'false' and abs(o[0]) > 40, str(o))
    await pg.click('#nav-follow'); await pg.wait_for_timeout(350)
    o = await boat_offset()
    check(name, 'Follow brings the boat back to the middle', await pg.get_attribute('#nav-follow', 'aria-pressed') == 'true' and abs(o[0]) < 6 and abs(o[1]) < 6, str(o))
    await pg.click('#nav-pause')
    check(name, 'Pause and resume', await text('#nav-pause') == 'Resume')
    await pg.click('#nav-pause')
    check(name, 'screen-awake note shown', len(await text('#wake-status')) > 20)
    check(name, 'navigation panel fits without sideways scroll', await pg.evaluate('document.documentElement.scrollWidth') <= vw['width'])
    await pg.screenshot(path=str(OUT / f'navigating-{name}.png'))
    await pg.click('#nav-stop')
    check(name, 'End run shows the run summary', await pg.is_visible('#p-done'))
    await pg.click('#sum-new')
    check(name, 'Done returns to the start choices', await pg.is_visible('#p-choose'))

    # ---------- Track, coverage and resume ----------
    await fix(off(p1a, -10, 0))
    await pg.click('#start-begin'); await pg.wait_for_selector('#p-nav:not([hidden])')
    check(name, 'new run starts with nothing covered', (await text('#cov-val')).startswith('0 of 16'), await text('#cov-val'))
    for d in range(0, int(L) + 4, 6): await fix(off(p1a, min(d, L + 2), 1.0))
    check(name, 'running pass 1 on the line covers it', (await text('#cov-val')).startswith('1 of 16'), await text('#cov-val'))
    check(name, 'covered stretch and track drawn on the map', await pg.locator('#nav-map .rt-cov').count() >= 1 and await pg.locator('#nav-map .trk').count() == 1)
    await pg.wait_for_timeout(5600)      # saves are batched every 5 s
    run = await pg.evaluate("JSON.parse(localStorage.getItem('sar-nav-run'))")
    check(name, 'track saved on the phone as it goes', run and len(run['track']) > 30 and run['nav']['leg'] >= 1 and not run.get('endedAt'),
          (len(run['track']) if run else None))
    # Screen off for a minute: phones stop location for web pages; the gap is noted.
    await pg.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange')); const real = Date.now; Date.now = () => real() + 75000;
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange')); }""")
    check(name, 'screen-off gap noted when coming back', 'Tracking stopped for 1 min' in await text('#toast'), await text('#toast'))
    run = await pg.evaluate("JSON.parse(localStorage.getItem('sar-nav-run'))")
    check(name, 'gap saved with the run', any(g['why'] == 'screen' for g in run['gaps']))
    # Reload mid-run: offered to resume where it left off.
    await pg.reload(); await pg.wait_for_selector('#p-choose:not([hidden])')
    check(name, 'after a reload the unfinished run is offered', await vis('#resume') and 'covered' in await text('#resume-desc'), await text('#resume-desc'))
    await pg.evaluate("() => { const real = Date.now; Date.now = () => real() + 120000; }")   # the phone was away for 2 min
    await pg.click('#resume-go'); await pg.wait_for_selector('#p-nav:not([hidden])')
    check(name, 'resuming keeps the leg and coverage', (await text('#cov-val')).startswith('1 of 16') and 'Pass 1' not in await text('#nav-leg'),
          await text('#nav-leg') + ' / ' + await text('#cov-val'))
    await fix(off(PTS[2], 5, 0))
    await pg.evaluate("window.dispatchEvent(new Event('pagehide'))")
    run = await pg.evaluate("JSON.parse(localStorage.getItem('sar-nav-run'))")
    check(name, 'time away while reloading counted as a gap', any(g['why'] == 'closed' for g in run['gaps']), json.dumps(run['gaps']))

    # ---------- Sound alerts ----------
    check(name, 'sound starts off for a run', await pg.get_attribute('#nav-sound', 'aria-pressed') == 'false')
    await pg.click('#nav-sound')
    check(name, 'sound can be turned on', await pg.get_attribute('#nav-sound', 'aria-pressed') == 'true' and await text('#nav-sound') == 'Sound on')
    p2a, p2b = PTS[2], PTS[3]          # pass 2 runs south
    await pg.click('#nav-near'); await fix(off(p2a, -20, 0.5))
    await fix(off(p2a, -26, 15))
    check(name, 'drifting off the line beeps', (await pg.get_attribute('#nav-sound', 'data-alerts') or '').endswith(':off'),
          await pg.get_attribute('#nav-sound', 'data-alerts'))
    L2 = (p2a[0] - p2b[0]) * 111195.0
    for d in range(30, int(L2) + 4, 30): await fix(off(p2a, -min(d, L2 + 2), 0.5))
    check(name, 'end of a pass beeps', (await pg.get_attribute('#nav-sound', 'data-alerts') or '').endswith(':leg'),
          await pg.get_attribute('#nav-sound', 'data-alerts'))

    # ---------- Summary and export ----------
    await pg.click('#nav-stop')
    check(name, 'summary: passes covered and what was missed', await vis('#p-done') and (await text('#sum-cov')).startswith('2 of 16')
          and await pg.locator('#sum-miss li').count() == 1 and 'Passes 3–16' in await text('#sum-miss'), await text('#sum-cov') + ' / ' + await text('#sum-miss'))
    check(name, 'summary map shows the whole route with coverage and track', await pg.locator('#nav-map .rt-cov').count() >= 2
          and await pg.locator('#nav-map .trk').count() == 1 and await pg.locator('#nav-map .rt-active').count() == 0)
    await pg.screenshot(path=str(OUT / f'summary-{name}.png'))
    check(name, 'summary: distance and gaps', await text('#sum-dist') != '–' and (await text('#sum-gaps')).startswith(('2', '3')), await text('#sum-gaps'))
    async with pg.expect_download() as dl:
        await pg.click('#sum-save')
    d = await dl.value
    path = WORK / f'track-{name}.gpx'
    await d.save_as(str(path))
    gpx = path.read_text()
    import subprocess
    trk = subprocess.run(['gpsbabel', '-t', '-i', 'gpx', '-f', str(path), '-o', 'unicsv', '-F', '-'], capture_output=True, text=True)
    rte = subprocess.run(['gpsbabel', '-r', '-i', 'gpx', '-f', str(path), '-o', 'unicsv', '-F', '-'], capture_output=True, text=True)
    check(name, 'track GPX saves with a clear name', re.match(r'^Hit3-track-\d{8}-\d{4}\.gpx$', d.suggested_filename) is not None, d.suggested_filename)
    check(name, 'GPX has the route, the track and the covered parts (GPSBabel reads it)', trk.returncode == 0 and rte.returncode == 0
          and len(rte.stdout.strip().splitlines()) - 1 == 32 and len(trk.stdout.strip().splitlines()) > 40
          and '<name>Hit3 covered</name>' in gpx and 'Covered 2 of 16 passes' in gpx,
          f'route {len(rte.stdout.splitlines())} track {len(trk.stdout.splitlines())} {trk.stderr[:120]}')
    check(name, 'track split where tracking stopped', gpx.count('<trkseg>') >= 3)
    await pg.click('#sum-resume')
    check(name, 'Keep going returns to navigating', await vis('#p-nav') and (await text('#cov-val')).startswith('2 of 16'))
    await pg.click('#nav-stop'); await pg.click('#sum-new')
    check(name, 'an ended run is not offered again', await vis('#p-choose') and not await vis('#resume'))

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
