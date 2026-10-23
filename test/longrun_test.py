"""Long run: 90 minutes of 1-per-second GPS fixes along a grid, played back quickly on a
phone-sized screen with the CPU slowed 4x. Checks the page keeps up, what it stores, and that
a reload, resume, summary and GPX export still work with a long track.
Run: python test/longrun_test.py
"""
import asyncio, functools, http.server, json, os, sys, threading
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent / 'dist'
OUT = HERE.parent / 'test-output'
OUT.mkdir(exist_ok=True)
MINUTES = int(os.environ.get('MINUTES', '90'))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8776), functools.partial(Quiet, directory=str(ROOT)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:8776/'

GPS_SHIM = (HERE / 'navigate_test.py').read_text().split('GPS_SHIM = """')[1].split('"""')[0]

# Drives the boat inside the page: one fix per simulated second at 1.5 m/s, weaving a few
# metres either side of the line, with Date.now() following the simulated clock.
DRIVE = """
async (minutes) => {
  const N = window.NavCore;
  const data = JSON.parse(localStorage.getItem('sar-nav-v1')).route;
  const route = N.buildRoute(data.points);
  const real = Date.now.bind(Date);
  let sim = real();
  Date.now = () => sim;
  const per = [], total = minutes * 60;
  let n = 0;
  outer:
  for (let lap = 0; lap < 3; lap++) for (let i = 0; i < route.legs.length; i++) {
    const l = route.legs[i];
    for (let a = 0; a <= l.len; a += 1.5) {
      const p = N.pointOn(route, i, a), q = route.proj.fwd(p);
      const off = 2.5 * Math.sin(n / 9);
      const nx = (l.b.y - l.a.y) / l.len, ny = -(l.b.x - l.a.x) / l.len;
      const pos = route.proj.inv({ x: q.x + nx * off, y: q.y + ny * off });
      sim += 1000;
      const t0 = performance.now();
      window.__gps.fix(pos.lat, pos.lon, 4, sim, null, 1.5);
      per.push(performance.now() - t0);
      if (++n % 120 === 0) await new Promise(r => setTimeout(r, 0));   // let the page breathe
      if (n >= total) break outer;
    }
  }
  window.dispatchEvent(new Event('pagehide'));      // save now
  per.sort((x, y) => x - y);
  const run = localStorage.getItem('sar-nav-run') || '';
  return {
    fixes: n, avg: per.reduce((s, x) => s + x, 0) / per.length, p95: per[Math.floor(per.length * 0.95)], max: per[per.length - 1],
    stored: run.length, track: JSON.parse(run).track.length,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    cov: document.getElementById('cov-val').textContent, leg: document.getElementById('nav-leg').textContent
  };
}
"""

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + ('  ' + str(detail) if detail else ''), flush=True)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
        await ctx.add_init_script(GPS_SHIM)
        await ctx.route('https://basemap.nationalmap.gov/**', lambda r: r.abort())
        await ctx.route('https://fonts.googleapis.com/**', lambda r: r.abort())
        pg = await ctx.new_page()
        pg.set_default_timeout(60000)
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        cdp = await ctx.new_cdp_session(pg)
        await cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})

        await pg.goto(BASE + 'index.html'); await pg.wait_for_selector('#stats .stat')
        await pg.goto(BASE + 'navigate.html#grid'); await pg.wait_for_selector('#p-choose:not([hidden])')
        start = await pg.evaluate("JSON.parse(localStorage.getItem('sar-nav-v1')).route.points[0]")
        await pg.evaluate('([la, lo]) => window.__gps.fix(la, lo, 4)', [start['lat'], start['lon']])
        await pg.click('#start-begin'); await pg.wait_for_selector('#p-nav:not([hidden])')

        r = await pg.evaluate(DRIVE, MINUTES)
        print(json.dumps(r))
        check(f'{MINUTES} minutes of fixes processed', r['fixes'] == MINUTES * 60, r['fixes'])
        check('keeps up on a slowed CPU: average per fix', r['avg'] < 60, f"{r['avg']:.1f} ms (a fix arrives every 1000 ms)")
        check('keeps up on a slowed CPU: 95th percentile', r['p95'] < 150, f"{r['p95']:.1f} ms")
        check('track stored on the phone', 2000 < r['track'] <= MINUTES * 60, f"{r['track']} points")
        check('storage stays small', r['stored'] < 1_000_000, f"{r['stored'] / 1024:.0f} KB for {MINUTES} min (phone limit is about 5 MB)")
        check('coverage builds up over the run', int(r['cov'].split(' of ')[0]) >= 12, r['cov'])
        if r['heap']:
            check('memory use reasonable', r['heap'] < 60_000_000, f"{r['heap'] / 1e6:.1f} MB JS heap")
        await pg.screenshot(path=str(OUT / 'longrun-navigating.png'))

        # Reload with a long track, resume, end, export.
        t0 = await pg.evaluate('performance.now()')
        await pg.reload(); await pg.wait_for_selector('#resume:not([hidden])')
        t1 = await pg.evaluate('performance.now()')
        check('after a reload the long run is offered to resume', True, f"page ready in {t1:.0f} ms")
        await pg.click('#resume-go'); await pg.wait_for_selector('#p-nav:not([hidden])')
        check('resumed with coverage intact', (await pg.inner_text('#cov-val')).strip() == r['cov'].strip(), await pg.inner_text('#cov-val'))
        await pg.click('#nav-stop'); await pg.wait_for_selector('#p-done:not([hidden])')
        check('summary of the long run', 'of 16' in await pg.inner_text('#sum-cov'), (await pg.inner_text('#sum-cov')) + ' · ' + (await pg.inner_text('#sum-dist')))
        async with pg.expect_download() as dl:
            await pg.click('#sum-save')
        d = await dl.value
        path = OUT / 'longrun-track.gpx'
        await d.save_as(str(path))
        size = path.stat().st_size
        check('GPX export of the long run', path.read_text().count('<trkpt') > 2000 and size < 2_000_000, f"{size / 1024:.0f} KB")
        await pg.screenshot(path=str(OUT / 'longrun-summary.png'))
        check('no script errors', not errs, str(errs[:3]))
        await b.close()
    srv.shutdown()
    print('TOTAL', sum(r[1] for r in results), '/', len(results))
    if not all(r[1] for r in results):
        sys.exit(1)

asyncio.run(main())
