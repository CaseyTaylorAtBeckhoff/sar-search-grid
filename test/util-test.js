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

// Pasting all four corners at once
const C4 = [[41.3650583, -112.073523], [41.36964, -112.073523], [41.36964, -112.078575], [41.3650583, -112.078575]];
const pastes = [
  ['one per line (decimal)', C4.map(c => c.join(', ')).join('\n')],
  ['Windows line endings', C4.map(c => c.join(', ')).join('\r\n')],
  ['semicolons on one line', C4.map(c => c.join(', ')).join('; ')],
  ['pipes on one line', C4.map(c => c.join(',')).join(' | ')],
  ['8 numbers, commas only', C4.map(c => c.join(',')).join(',')],
  ['8 numbers, spaces only', C4.map(c => c.join(' ')).join(' ')],
  ['numbered lines', C4.map((c, i) => `${i + 1}) ${c.join(', ')}`).join('\n')],
  ['"Corner N (NW):" labels', C4.map((c, i) => `Corner ${i + 1} (${['SE', 'NE', 'NW', 'SW'][i]}): ${c.join(', ')}`).join('\n')],
  ['deg + min, one line, letters first', 'N41 21.9035 W112 04.41138 N41 22.1784 W112 04.41138 N41 22.1784 W112 04.7145 N41 21.9035 W112 04.7145'],
  ['deg + min, Humminbird symbols', "N 41° 21.904' W 112° 04.411'\nN 41° 22.178' W 112° 04.411'\nN 41° 22.178' W 112° 04.715'\nN 41° 21.904' W 112° 04.715'"],
  ['DMS, letters after, one line', `41°21'54.21"N 112°04'24.68"W 41°22'10.70"N 112°04'24.68"W 41°22'10.70"N 112°04'42.87"W 41°21'54.21"N 112°04'42.87"W`],
  ['deg + min, signs only, 16 numbers', '41 21.9035 -112 4.41138 41 22.1784 -112 4.41138 41 22.1784 -112 4.7145 41 21.9035 -112 4.7145'],
  ['GPX waypoints', '<gpx>' + C4.map((c, i) => `<wpt lat="${c[0]}" lon="${c[1]}"><name>C${i + 1}</name></wpt>`).join('') + '</gpx>'],
  ['KML closed polygon (lon,lat)', '<Polygon><outerBoundaryIs><LinearRing><coordinates>' + [...C4, C4[0]].map(c => `${c[1]},${c[0]},0`).join(' ') + '</coordinates></LinearRing></outerBoundaryIs></Polygon>'],
  ['KML separate placemarks', C4.map(c => `<Placemark><Point><coordinates>${c[1]},${c[0]}</coordinates></Point></Placemark>`).join('\n')],
  ['blank lines and spaces', '\n  ' + C4.map(c => c.join(', ')).join('\n\n   ') + '\n\n'],
];
for (const [name, text] of pastes) {
  const r = U.parseCorners(text);
  const err = r.error ? Infinity : Math.max(...r.pts.map((p, i) => G.distM(p, { lat: C4[i][0], lon: C4[i][1] })));
  ok(err < 3, `paste ${name.padEnd(36)} ${r.error ? 'ERR ' + r.error : r.how + ', ' + err.toFixed(2) + ' m'}`);
}
ok(U.parseCorners('41.3650583, -112.073523').error === 'That is only one position. Paste all 4 corners.', 'one position: says so');
ok(/need 4/.test(U.parseCorners(C4.slice(0, 3).map(c => c.join(', ')).join('\n')).error || ''), 'three positions: says 3 of 4');
ok(!!U.parseCorners('hello there').error, 'no positions: error');
ok(U.parseCorners('   ').empty, 'empty paste ignored');
ok(U.parseCorners(C4.map(c => c.join(', ')).join('\n')).pts[2].text === '41.36964, -112.078575', 'keeps the pasted wording for each corner');

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
