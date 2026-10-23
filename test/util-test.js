// Coordinate parser, orientation, geometry and ZIP checks.
const U = require('../util.js'), G = require('../grid-core.js'), fs = require('fs'), path = require('path');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

// Every format should land within ~3 m of the same point.
const target = { lat: 41.3650583, lon: -112.073523 };
const formats = [
  ['decimal (Google Maps)', '41.3650583, -112.073523'],
  ['decimal, hemisphere after', '41.3650583° N, 112.073523° W'],
  ['decimal, hemisphere before', 'N41.3650583 W112.073523'],
  ['decimal, lowercase hemisphere', '41.36506n 112.07352w'],
  ['decimal, slash between', '41.3650583/-112.073523'],
  ['decimal, typographic minus', '41.3650583, −112.073523'],
  ['deg + min (Humminbird)', "N 41° 21.904'  W 112° 04.411'"],
  ['deg + min (Garmin)', 'N41 21.904 W112 04.411'],
  ['deg + min, signs only', '41 21.904, -112 4.411'],
  ['DMS (Google Maps)', `41°21'54.2"N 112°04'24.7"W`],
  ['DMS, spaces only', '41 21 54.2 N 112 4 24.7 W'],
  ['DMS, signs only', '41 21 54.2 -112 4 24.7'],
  ['DMS, d/m/s letters', '41d21m54.2s N 112d4m24.7s W'],
  ['DMS, d/m/s attached N/W', '41d21m54.2sN 112d4m24.7sW'],
  ['DMS, unicode primes', '41°21′54.2″N 112°04′24.7″W'],
  ['DMS, deg/min/sec words', '41deg 21min 54.2sec N, 112deg 4min 24.7sec W'],
  ['southern/eastern check', 'S 33 51.5 E 151 12.6'],
];
for (const [name, s] of formats) {
  const r = U.parseCoord(s);
  if (name === 'southern/eastern check') { ok(!r.error && r.lat < 0 && r.lon > 0, `${name}: ${JSON.stringify(r)}`); continue; }
  const err = r.error ? Infinity : G.distM(r, target);
  ok(err < 3, `${name.padEnd(30)} ${r.error ? 'ERR ' + r.error : err.toFixed(2) + ' m off'}`);
}
for (const [s, why] of [['abc', 'no numbers'], ['91, 10', 'lat out of range'], ['41.3 W112', 'one hemisphere'],
  ['41 61 0 -112 0 0', 'minutes >= 60'], ['-41.3 S 112 W', 'sign and S']])
  ok(!!U.parseCoord(s).error, `rejects ${why}: ${JSON.stringify(s)}`);

// Orientation: start corner and pass axis
const B = [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, { lat: 1, lon: 1 }, { lat: 0, lon: 1 }];
ok(JSON.stringify(U.orient(B, 0, 'A')) === JSON.stringify(B), 'default orientation matches foursided.py order');
for (const s of [0, 1, 2, 3]) for (const a of ['A', 'B']) {
  const o = U.orient(B, s, a);
  ok(o[0] === B[s] && ((o[0].lat !== o[1].lat) === (a === 'A')), `start ${s + 1}, axis ${a}`);
}
ok(U.cornersCrossed([B[0], B[2], B[1], B[3]]) && !U.cornersCrossed(B), 'detects corners entered out of order');

// Center box dimensions
const box = U.boxFromCenter({ lat: 41.36735, lon: -112.07605 }, 1000, 300, 45);
ok(Math.abs(G.distM(box[0], box[1]) - 1000) < 1 && Math.abs(G.distM(box[1], box[2]) - 300) < 1, 'center box is 1000 x 300 m');

// ZIP opens with Python's zipfile
const out = path.join(require('os').tmpdir(), 'sar-grid-test.zip');
fs.writeFileSync(out, U.makeZip([{ name: 'Hit3.hwr', data: new Uint8Array([1, 2, 3, 250]) }, { name: 'Hit3.gpx', data: '<gpx/>\n' }]));
const zres = require('child_process').execFileSync('python3', ['-c',
  `import zipfile;z=zipfile.ZipFile('${out}');print(z.testzip(), z.read('Hit3.hwr')==bytes([1,2,3,250]))`]).toString().trim();
ok(zres === 'None True', 'zip archive valid');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
