// Verifies grid-core.js against the original Python output and GPSBabel's .hwr writer.
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const G = require('../grid-core.js');

// Reference output of the original foursided.py lives in test/fixtures; scratch files go to a temp dir.
const fixture = path.join(__dirname, 'fixtures', 'foursided-c.gpx');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sar-grid-'));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

const corners = [
  { lat: 41.3650583, lon: -112.073523 },
  { lat: 41.36964, lon: -112.073523 },
  { lat: 41.36964, lon: -112.078575 },
  { lat: 41.3650583, lon: -112.078575 }];

// 1. Grid matches original Python script (16 passes).
const ref = [...fs.readFileSync(fixture, 'utf8')
  .matchAll(/<rtept lat="([-\d.]+)" lon="([-\d.]+)"/g)].map(m => ({ lat: +m[1], lon: +m[2] }));
const pts = G.buildGrid(corners, 16);
ok(pts.length === ref.length, `point count ${pts.length} == ${ref.length}`);
const maxErr = Math.max(...pts.map((p, i) => Math.max(Math.abs(p.lat - ref[i].lat), Math.abs(p.lon - ref[i].lon))));
ok(maxErr < 1e-9, `max coordinate difference vs Python ${maxErr.toExponential(2)} deg`);

// 2. HWR bytes match GPSBabel for the same GPX (names, times, frozen route time).
const names = pts.map((_, i) => 'wp' + (i + 1));
const wptTimes = pts.map((_, i) => new Date(Date.UTC(2013, 7, 21, 1, i + 1)));
const env = Object.assign({}, process.env, { GPSBABEL_FREEZE_TIME: 'y', TZ: 'UTC' });
execFileSync('gpsbabel', ['-i', 'gpx', '-f', fixture, '-o', 'humminbird', '-F', path.join(work, 'gb.hwr')], { env });
const gb = fs.readFileSync(path.join(work, 'gb.hwr'));
const mine = G.toHWR(pts, { routeName: 'Hit3', names, wptTimes, routeTime: 0, icon: 255 }).bytes;
const firstDiff = gb.findIndex((b, i) => b !== mine[i]);
ok(gb.length === mine.length && firstDiff === -1,
  `HWR identical to GPSBabel (${mine.length} bytes${firstDiff >= 0 ? ', first diff at ' + firstDiff : ''})`);

// 3. Large grid (>50 points) splits into continuous routes; matches GPSBabel given the same split.
const big = G.buildGrid(corners, 40);                 // 80 points
const bigRes = G.toHWR(big, { routeName: 'LongNameForBigGrid1234', prefix: 'TestGrid', routeTime: 0, time: new Date(0) });
ok(bigRes.routes.length === 2 && bigRes.routes[0].points === 50 && bigRes.routes[1].points === 31,
  `80 pts split into routes ${JSON.stringify(bigRes.routes)}`);
ok(bigRes.routes.every(r => r.name.length <= 19), 'route names <= 19 chars');
ok(bigRes.names.every(n => n.length <= 11) && new Set(bigRes.names).size === big.length, `waypoint names <= 11 chars & unique (${bigRes.names[0]}..${bigRes.names.at(-1)})`);
const back = G.readHWR(bigRes.bytes);
ok(back.rtes[0].points.at(-1) === back.rtes[1].points[0], 'second route starts where first ends');
const rtErr = Math.max(...back.wpts.map((w, i) => G.distM(w, big[i])));
ok(rtErr < 1.0, `HWR round-trip position error ${rtErr.toFixed(3)} m`);

// Feed the same split to GPSBabel via a 2-route GPX and compare bytes.
const t0 = '1970-01-01T00:00:00Z';
const gpx = ['<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">'];
bigRes.routes.forEach((r, k) => {
  const idx = G.splitRoutes(big.length, 50)[k];
  gpx.push('<rte><name>' + r.name + '</name>' + idx.map(i =>
    `<rtept lat="${big[i].lat.toFixed(12)}" lon="${big[i].lon.toFixed(12)}"><time>${t0}</time><name>${bigRes.names[i]}</name></rtept>`).join('') + '</rte>');
});
gpx.push('</gpx>');
fs.writeFileSync(path.join(work, 'big.gpx'), gpx.join('\n'));
execFileSync('gpsbabel', ['-i', 'gpx', '-f', path.join(work, 'big.gpx'), '-o', 'humminbird', '-F', path.join(work, 'big_gb.hwr')], { env });
const gb2 = fs.readFileSync(path.join(work, 'big_gb.hwr'));
const mine2 = G.toHWR(big.map(p => ({ lat: +p.lat.toFixed(12), lon: +p.lon.toFixed(12) })),
  { routeName: 'LongNameForBigGrid1234', names: bigRes.names, time: new Date(0), routeTime: 0, icon: 255 }).bytes;
const d2 = gb2.findIndex((b, i) => b !== mine2[i]);
ok(gb2.length === mine2.length && d2 === -1, `split HWR identical to GPSBabel (${mine2.length} bytes${d2 >= 0 ? ', first diff at ' + d2 : ''})`);

// 4. GPX output parses with GPSBabel and round-trips coordinates.
fs.writeFileSync(path.join(work, 'mine.gpx'), G.toGPX(pts, { routeName: 'Hit3', prefix: 'wp' }));
const csv = execFileSync('gpsbabel', ['-r', '-i', 'gpx', '-f', path.join(work, 'mine.gpx'), '-o', 'unicsv', '-F', '-'], { env }).toString();
const rows = csv.trim().split('\n').slice(1);
ok(rows.length === pts.length, `GPSBabel reads ${rows.length} route points from our GPX`);
fs.writeFileSync(path.join(work, 'mine.hwr'), G.toHWR(pts, { routeName: 'Hit3', prefix: 'wp' }).bytes);
const csv2 = execFileSync('gpsbabel', ['-r', '-i', 'humminbird', '-f', path.join(work, 'mine.hwr'), '-o', 'unicsv', '-F', '-'], { env }).toString();
ok(csv2.trim().split('\n').length - 1 === pts.length, 'GPSBabel reads our own .hwr back');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
