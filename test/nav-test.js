// Route files (GPX, KML, KMZ) and navigation math.
const zlib = require('zlib');
const G = require('../grid-core.js'), U = require('../util.js');
const IO = require('../route-io.js'), N = require('../nav-core.js');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const enc = s => new TextEncoder().encode(s);
const inflate = async d => new Uint8Array(zlib.inflateRawSync(Buffer.from(d)));

const corners = [
  { lat: 41.3650583, lon: -112.073523 }, { lat: 41.36964, lon: -112.073523 },
  { lat: 41.36964, lon: -112.078575 }, { lat: 41.3650583, lon: -112.078575 }];
const grid = G.buildGrid(corners, 16);        // 32 points, 31 legs
const big = G.buildGrid(corners, 40);         // 80 points -> 2 Humminbird routes

// Minimal zip writer with deflate, to build a real KMZ.
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc(f.name), raw = enc(f.data), data = f.store ? raw : zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(f.store ? 0 : 8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    parts.push(h, Buffer.from(name), Buffer.from(data));
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(f.store ? 0 : 8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, Buffer.from(name));
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, e]));
}

(async () => {
  // ---------- Route files ----------
  const gpx1 = G.toGPX(grid, { routeName: 'Hit3', prefix: 'H3-' });
  let r = await IO.readRouteFile('Hit3.gpx', enc(gpx1), inflate);
  ok(!r.error && r.candidates.length === 1 && r.candidates[0].points.length === 32 && r.candidates[0].name === 'Hit3', `GPX route from the grid builder: ${r.error || r.candidates[0].points.length + ' points'}`);
  ok(r.candidates[0].points[4].name === 'H3-05', 'GPX keeps waypoint names');

  // Split grid: two <rte>, second starts where the first ends -> joined candidate first.
  const hw = G.toHWR(big, { routeName: 'Big', prefix: 'B' });
  const idx = G.splitRoutes(big.length, 50);
  const gpx2 = '<?xml version="1.0"?><gpx version="1.1">' + idx.map((ii, k) => `<rte><name>${hw.routes[k].name}</name>` +
    ii.map(i => `<rtept lat="${big[i].lat}" lon="${big[i].lon}"><name>${hw.names[i]}</name></rtept>`).join('') + '</rte>').join('') + '</gpx>';
  r = await IO.readRouteFile('big.gpx', enc(gpx2), inflate);
  ok(r.candidates[0].kind === 'routes' && r.candidates[0].points.length === 80 && r.candidates.length === 3,
    `split grid (2 routes) is joined back into one 80-point route: ${r.candidates.map(c => c.kind + ':' + c.points.length).join(', ')}`);

  // Recorded track with GPS noise along a straight line -> simplified.
  let trk = '<gpx><trk><name>Run &amp; return</name><trkseg>';
  for (let i = 0; i <= 600; i++) trk += `<trkpt lat="${41.36 + i * 0.00001 + (i % 2 ? 1e-7 : -1e-7)}" lon="${-112.07 + (i % 3) * 1e-8}"><time>2026-10-01T10:00:00Z</time></trkpt>`;
  trk += '</trkseg></trk></gpx>';
  r = await IO.readRouteFile('t.gpx', enc(trk), inflate);
  ok(r.candidates[0].kind === 'track' && r.candidates[0].points.length < 10 && r.candidates[0].name === 'Run & return' && /simplified/.test(r.candidates[0].note),
    `GPX track simplified (${r.candidates[0].points.length} points), name decoded: "${r.candidates[0].name}"`);

  r = await IO.readRouteFile('w.gpx', enc('<gpx><wpt lat="41.1" lon="-112.1"><name>A</name></wpt><wpt lat="41.2" lon="-112.1"/><wpt lat="41.2" lon="-112.2"/></gpx>'), inflate);
  ok(r.candidates[0].kind === 'points' && r.candidates[0].points.length === 3, 'GPX waypoints only: followed in file order');

  // KML: CalTopo/Google Earth line, points, polygon
  const kmlLine = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Doc</name>
    <Placemark><name>Search line</name><LineString><coordinates>\n${grid.map(p => `${p.lon},${p.lat},0`).join('\n')}\n</coordinates></LineString></Placemark>
    <Placemark><name>PLS</name><Point><coordinates>-112.075,41.367,0</coordinates></Point></Placemark>
    <Placemark><name>Area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${[...corners, corners[0]].map(p => `${p.lon},${p.lat}`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>`;
  r = await IO.readRouteFile('area.kml', enc(kmlLine), inflate);
  ok(r.format === 'KML' && r.candidates[0].kind === 'line' && r.candidates[0].name === 'Search line' && r.candidates[0].points.length === 32
    && Math.abs(r.candidates[0].points[0].lat - grid[0].lat) < 1e-9, `KML LineString read with lon,lat order: ${r.candidates.map(c => c.kind + ':' + c.name).join(', ')}`);
  ok(r.candidates.some(c => c.kind === 'outline' && c.points.length === 5 && c.points[4].lat === c.points[0].lat), 'KML polygon offered as an outline that returns to its start');

  const kmlPts = '<kml><Document>' + grid.slice(0, 6).map((p, i) => `<Placemark><name>P${i + 1}</name><Point><coordinates>${p.lon},${p.lat}</coordinates></Point></Placemark>`).join('') + '</Document></kml>';
  r = await IO.readRouteFile('pts.kml', enc(kmlPts), inflate);
  ok(r.candidates[0].kind === 'points' && r.candidates[0].points.length === 6 && r.candidates[0].points[2].name === 'P3', 'KML points followed in file order');

  const gxt = '<kml><Placemark><name>Track</name><gx:Track>' + grid.slice(0, 4).map(p => `<when>2026-01-01T00:00:00Z</when><gx:coord>${p.lon} ${p.lat} 0</gx:coord>`).join('') + '</gx:Track></Placemark></kml>';
  r = await IO.readRouteFile('gx.kml', enc(gxt), inflate);
  ok(r.candidates[0].kind === 'track' && r.candidates[0].points.length === 4, 'KML gx:Track read');

  r = await IO.readRouteFile('area.kmz', zip([{ name: 'files/icon.png', data: 'x', store: true }, { name: 'doc.kml', data: kmlLine }]), inflate);
  ok(r.format === 'KMZ' && r.candidates[0].points.length === 32, `KMZ (deflated) opened: ${r.error || r.format}`);
  r = await IO.readRouteFile('stored.kmz', zip([{ name: 'a.kml', data: kmlLine, store: true }]), inflate);
  ok(!r.error && r.candidates[0].points.length === 32, 'KMZ (stored) opened');

  r = await IO.readRouteFile('Hit3.hwr', G.toHWR(grid, {}).bytes, inflate);
  ok(/Humminbird/.test(r.error || ''), `.hwr explains to open the .gpx: ${r.error}`);
  r = await IO.readRouteFile('notes.txt', enc('hello'), inflate);
  ok(/GPX, KML or KMZ/.test(r.error || ''), 'other files: clear error');
  r = await IO.readRouteFile('one.gpx', enc('<gpx><rte><rtept lat="41" lon="-112"/></rte></gpx>'), inflate);
  ok(/at least two points/.test(r.error || ''), 'route with one point: clear error');
  r = await IO.readRouteFile('bad.kmz', new Uint8Array([0x50, 0x4b, 1, 2, 3]), inflate);
  ok(/damaged/.test(r.error || ''), 'damaged KMZ: clear error');

  // ---------- Navigation math ----------
  const route = N.buildRoute(grid);
  ok(route.legs.length === 31 && route.grid && route.grid.passCount === 16, `grid detected: ${route.grid && route.grid.passCount} passes`);
  const lane = G.distM(grid[1], grid[2]);
  ok(Math.abs(route.grid.lane - lane) < 0.5, `lane spacing ${route.grid.lane.toFixed(1)} m (expected ${lane.toFixed(1)})`);
  ok(route.legs[0].pass === 1 && route.legs[1].pass === null && route.legs[30].pass === 16, 'passes numbered 1..16, turns unnumbered');
  ok(Math.abs(route.tol - Math.min(20, Math.max(4.5, route.grid.lane / 4))) < 1e-9 && route.tol > 6.9 && route.tol < 7.1, `on-line tolerance ${route.tol.toFixed(1)} m (a quarter of the lane)`);

  // Leg 0 runs north. A boat 10 m east of it is right of the line: xte > 0, steer left.
  const R0 = 6371008.8, dLon = m => m / (R0 * Math.cos(41.367 * Math.PI / 180)) * 180 / Math.PI, dLat = m => m / R0 * 180 / Math.PI;
  const mid = { lat: (grid[0].lat + grid[1].lat) / 2, lon: grid[0].lon };
  let s = N.legState(route, 0, { lat: mid.lat, lon: mid.lon + dLon(10) });
  ok(Math.abs(s.xte - 10) < 0.1 && Math.abs(s.along - route.legs[0].len / 2) < 0.5, `east of a northbound line: xte +${s.xte.toFixed(2)} m (steer left)`);
  s = N.legState(route, 1, { lat: grid[1].lat + dLat(5), lon: (grid[1].lon + grid[2].lon) / 2 });
  ok(Math.abs(s.xte - 5) < 0.1, `north of a westbound turn is its right side: xte +${s.xte.toFixed(2)} m (steer left)`);
  s = N.legState(route, 1, { lat: grid[1].lat - dLat(5), lon: (grid[1].lon + grid[2].lon) / 2 });
  ok(Math.abs(s.xte + 5) < 0.1, `south of a westbound turn: xte ${s.xte.toFixed(2)} m (steer right)`);

  const n1 = N.nearest(route, { lat: grid[10].lat + dLat(-30), lon: grid[10].lon + dLon(3) });
  ok(n1.leg === 9 || n1.leg === 10, `nearest point: leg ${n1.leg}, ${n1.dist.toFixed(1)} m away`);
  const n2 = N.nearest(route, { lat: (grid[12].lat + grid[13].lat) / 2, lon: grid[12].lon + dLon(2) });
  ok(n2.leg === 12 && Math.abs(n2.dist - 2) < 0.2, `nearest to the middle of pass 7: leg ${n2.leg}`);

  const generic = N.buildRoute([corners[0], corners[2], { lat: 41.37, lon: -112.07 }, corners[1]]);
  ok(!generic.grid && generic.legs.every(l => l.isPass) && Math.abs(generic.tol - 7.62) < 1e-9, 'non-grid route: every leg is a leg, 25 ft tolerance');

  let iv = N.addInterval([], 10, 20); iv = N.addInterval(iv, 30, 40); iv = N.addInterval(iv, 18, 32); iv = N.addInterval(iv, 50, 45);
  ok(JSON.stringify(iv) === '[[10,40],[45,50]]' && N.intervalsLength(iv) === 35, `interval merge ${JSON.stringify(iv)}`);

  // Drive the whole grid at ~1.5 m/s, 1 fix per second, weaving 2 m either side of the line.
  function drive(rt, nav, fromLeg, fromAlong, opts) {
    opts = opts || {};
    let t = 0, fixes = 0, maxOff = 0;
    for (let i = fromLeg; i < rt.legs.length; i++) {
      const L = rt.legs[i].len;
      for (let a = i === fromLeg ? fromAlong : 0; a <= L + 0.01; a += 1.5) {
        const p = N.pointOn(rt, i, a), l = rt.legs[i];
        const off = (opts.offset || 0) + 2 * Math.sin(t / 7);
        const nx = (l.b.y - l.a.y) / L, ny = -(l.b.x - l.a.x) / L;     // right-hand normal
        const q = rt.proj.fwd(p), pos = rt.proj.inv({ x: q.x + nx * off, y: q.y + ny * off });
        const res = nav.update({ lat: pos.lat, lon: pos.lon, t: t * 1000 });
        maxOff = Math.max(maxOff, Math.abs(res.xte));
        t++; fixes++;
        if (res.finished) return { fixes, maxOff, finished: true };
      }
    }
    return { fixes, maxOff, finished: false };
  }
  let nav = N.createNavigator(route);
  nav.start(0, 0);
  let d = drive(route, nav, 0, 0);
  let cov = nav.coverage();
  ok(d.finished && cov.fraction > 0.97, `full run: finished, passes ${(cov.fraction * 100).toFixed(1)}% covered (${d.fixes} fixes)`);
  ok(cov.per.every((f, i) => !route.legs[i].isPass || f > 0.95), 'every pass covered');

  // Start in the middle: nearest point to a boat sitting halfway along pass 7.
  nav = N.createNavigator(route);
  const here = N.pointOn(route, 12, route.legs[12].len / 2);
  const st = N.nearest(route, here);
  nav.start(st.leg, st.along);
  d = drive(route, nav, st.leg, st.along);
  cov = nav.coverage();
  const firstHalf = cov.per.slice(0, 12).every(f => f === 0), rest = cov.per.slice(13).every((f, i) => !route.legs[13 + i].isPass || f > 0.95);
  ok(nav.state.startLeg === 12 && firstHalf && rest && cov.per[12] > 0.45 && cov.per[12] < 0.55,
    `start mid-route at pass 7: earlier passes uncovered, pass 7 half (${(cov.per[12] * 100).toFixed(0)}%), rest covered`);

  // Running 3x the tolerance off the line covers nothing but still advances to the end.
  nav = N.createNavigator(route);
  nav.start(0, 0);
  d = drive(route, nav, 0, 0, { offset: route.tol * 3 });
  ok(d.finished && nav.coverage().fraction < 0.05, `3x tolerance off the line: route still followed, ${(nav.coverage().fraction * 100).toFixed(1)}% counted (only where turns cross a pass)`);

  // Saved state survives a reload (JSON round trip).
  nav = N.createNavigator(route); nav.start(0, 0);
  for (let i = 0; i < 40; i++) { const p = N.pointOn(route, 0, i * 3); nav.update({ lat: p.lat, lon: p.lon, t: i * 1000 }); }
  const saved = JSON.parse(JSON.stringify(nav.state));
  const nav2 = N.createNavigator(route, saved);
  ok(nav2.state.leg === nav.state.leg && Math.abs(nav2.coverage().fraction - nav.coverage().fraction) < 1e-12, 'navigator state round-trips through JSON');

  console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
  process.exit(fails ? 1 : 0);
})();
