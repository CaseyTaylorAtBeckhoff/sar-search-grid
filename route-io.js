/* Route files for the Navigate page: GPX, KML and KMZ.
 *
 * readRouteFile(fileName, bytes, inflateRaw) -> Promise<{ candidates } | { error }>
 *   Each candidate is a line the boat could follow:
 *   { name, kind: 'routes' | 'route' | 'track' | 'line' | 'points' | 'outline', points: [{lat, lon, name}], note }
 *   The first candidate is the best guess; the page lets the user choose when there are several.
 * inflateRaw(Uint8Array) -> Promise<Uint8Array> decompresses KMZ entries (browser: DecompressionStream).
 * Works in browsers and in Node (tests).
 */
(function (root) {
  'use strict';

  const R = 6371008.8;

  function decodeEntities(s) {
    return String(s)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&')
      .trim();
  }
  const tagText = (xml, tag) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    return m ? decodeEntities(m[1]) : '';
  };
  // Text of a <name> that belongs to this element, not to one of its children.
  const ownName = (xml, childTag) => {
    const head = childTag ? xml.split(new RegExp(`<${childTag}\\b`, 'i'))[0] : xml;
    return tagText(head, 'name');
  };
  const valid = p => isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

  function distM(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Drop points that repeat the previous one (route joins, stationary GPS).
  function dedupe(pts, minM) {
    const out = [];
    for (const p of pts) if (!out.length || distM(out[out.length - 1], p) > (minM || 0.3)) out.push(p);
    return out;
  }
  // Douglas-Peucker in a local flat projection; tolM in metres.
  function simplify(pts, tolM) {
    if (pts.length < 3) return pts.slice();
    const ref = pts[0], kx = Math.cos(ref.lat * Math.PI / 180) * R * Math.PI / 180, ky = R * Math.PI / 180;
    const xy = pts.map(p => [(p.lon - ref.lon) * kx, (p.lat - ref.lat) * ky]);
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dx * (ay - xy[i][1]) - dy * (ax - xy[i][0])) / L;
        if (d > best) { best = d; bi = i; }
      }
      if (best > tolM) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ---------- GPX ----------
  function gpxPoints(xml, tag) {
    const out = [];
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
    for (const m of xml.matchAll(re)) {
      const la = /\blat\s*=\s*["']([-+\d.eE]+)["']/.exec(m[1]), lo = /\blon\s*=\s*["']([-+\d.eE]+)["']/.exec(m[1]);
      if (!la || !lo) continue;
      const p = { lat: +la[1], lon: +lo[1], name: m[2] ? tagText(m[2], 'name') : '' };
      if (valid(p)) out.push(p);
    }
    return out;
  }
  function parseGPX(xml) {
    const c = [];
    const rtes = [...xml.matchAll(/<rte\b[^>]*>([\s\S]*?)<\/rte>/gi)].map((m, i) => ({
      name: ownName(m[1], 'rtept') || `Route ${i + 1}`, points: dedupe(gpxPoints(m[1], 'rtept'))
    })).filter(r => r.points.length >= 2);
    if (rtes.length > 1) {
      const joined = dedupe(rtes.flatMap(r => r.points));
      const base = rtes[0].name.replace(/[-_ ]*1$/, '') || 'Route';
      c.push({ name: base, kind: 'routes', points: joined, note: `${rtes.length} routes joined end to end (${rtes.map(r => r.name).join(', ')})` });
    }
    rtes.forEach(r => c.push({ name: r.name, kind: 'route', points: r.points }));
    [...xml.matchAll(/<trk\b[^>]*>([\s\S]*?)<\/trk>/gi)].forEach((m, i) => {
      const raw = dedupe(gpxPoints(m[1], 'trkpt'));
      if (raw.length < 2) return;
      const pts = simplify(raw, 2);
      c.push({ name: ownName(m[1], 'trkseg') || `Track ${i + 1}`, kind: 'track', points: pts,
        note: pts.length < raw.length ? `Recorded track simplified from ${raw.length} to ${pts.length} points` : '' });
    });
    const wpts = dedupe(gpxPoints(xml, 'wpt'));
    if (wpts.length >= 2) c.push({ name: 'Waypoints', kind: 'points', points: wpts, note: `${wpts.length} waypoints, followed in file order` });
    return c;
  }

  // ---------- KML ----------
  function kmlCoords(text, spaceSeparated) {
    const out = [];
    if (spaceSeparated) {              // gx:coord "lon lat alt"
      const v = text.trim().split(/\s+/).map(Number);
      if (v.length >= 2) out.push({ lat: v[1], lon: v[0], name: '' });
    } else {
      for (const tr of text.trim().split(/\s+/)) {
        const v = tr.split(',').map(Number);   // lon,lat[,alt]
        if (v.length >= 2) out.push({ lat: v[1], lon: v[0], name: '' });
      }
    }
    return out.filter(valid);
  }
  function parseKML(xml) {
    const lines = [], outlines = [], points = [];
    const marks = [...xml.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi)].map(m => m[1]);
    marks.forEach((pm, i) => {
      const name = ownName(pm.replace(/<(?:LineString|Point|Polygon|MultiGeometry|gx:Track)\b[\s\S]*$/i, '')) || `Item ${i + 1}`;
      for (const ls of pm.matchAll(/<LineString\b[^>]*>([\s\S]*?)<\/LineString>/gi)) {
        const pts = dedupe(kmlCoords(tagText(ls[1], 'coordinates')));
        if (pts.length >= 2) lines.push({ name, kind: 'line', points: pts });
      }
      const gx = [...pm.matchAll(/<gx:coord>([\s\S]*?)<\/gx:coord>/gi)].flatMap(m => kmlCoords(m[1], true));
      if (gx.length >= 2) {
        const raw = dedupe(gx), pts = simplify(raw, 2);
        lines.push({ name, kind: 'track', points: pts, note: pts.length < raw.length ? `Recorded track simplified from ${raw.length} to ${pts.length} points` : '' });
      }
      for (const pg of pm.matchAll(/<outerBoundaryIs\b[^>]*>([\s\S]*?)<\/outerBoundaryIs>/gi)) {
        const pts = dedupe(kmlCoords(tagText(pg[1], 'coordinates')));
        if (pts.length >= 3) outlines.push({ name, kind: 'outline', points: pts, note: 'Outline of an area, followed around its edge' });
      }
      const pt = /<Point\b[^>]*>([\s\S]*?)<\/Point>/i.exec(pm);
      if (pt) {
        const p = kmlCoords(tagText(pt[1], 'coordinates'))[0];
        if (p) points.push(Object.assign(p, { name }));
      }
    });
    lines.sort((a, b) => b.points.length - a.points.length);
    const c = lines.slice();
    const pts = dedupe(points);
    if (pts.length >= 2) c.push({ name: 'Points', kind: 'points', points: pts, note: `${pts.length} points, followed in file order` });
    return c.concat(outlines);
  }

  // ---------- KMZ (zip) ----------
  async function unzipKml(bytes, inflateRaw) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('The KMZ file is damaged (no zip directory).');
    const count = v.getUint16(eocd + 10, true);
    let off = v.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count && v.getUint32(off, true) === 0x02014b50; n++) {
      const method = v.getUint16(off + 10, true), csize = v.getUint32(off + 20, true);
      const nameLen = v.getUint16(off + 28, true), extra = v.getUint16(off + 30, true), comment = v.getUint16(off + 32, true);
      const local = v.getUint32(off + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
      entries.push({ name, method, csize, local });
      off += 46 + nameLen + extra + comment;
    }
    const kmls = entries.filter(e => /\.kml$/i.test(e.name));
    const e = kmls.find(x => /(^|\/)doc\.kml$/i.test(x.name)) || kmls[0];
    if (!e) throw new Error('The KMZ file has no KML inside it.');
    const lo = e.local, data0 = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    const data = bytes.subarray(data0, data0 + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error('The KMZ file uses a compression this page cannot open.');
  }

  function decodeText(bytes) {
    let t = new TextDecoder('utf-8').decode(bytes);
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return t;
  }

  async function readRouteFile(fileName, bytes, inflateRaw) {
    try {
      if (!bytes || !bytes.length) return { error: 'The file is empty.' };
      let text, kind;
      if (bytes[0] === 0x50 && bytes[1] === 0x4B) { text = decodeText(await unzipKml(bytes, inflateRaw)); kind = 'kml'; }
      else {
        text = decodeText(bytes.subarray(0, Math.min(bytes.length, 50 * 1024 * 1024)));
        if (/<gpx\b/i.test(text)) kind = 'gpx';
        else if (/<kml\b/i.test(text)) kind = 'kml';
      }
      if (!kind) {
        if (/\.hwr$/i.test(fileName || '') || (bytes.length >= 4 && bytes[0] === 0x02 && bytes[1] <= 0x03 && bytes[2] === 0x00 && bytes[3] === 0x24))
          return { error: 'This is a Humminbird .hwr file. Open the matching .gpx instead (the grid builder saves both).' };
        return { error: "This isn't a GPX, KML or KMZ file." };
      }
      const candidates = kind === 'gpx' ? parseGPX(text) : parseKML(text);
      if (!candidates.length) return { error: `The ${kind.toUpperCase()} file has no route, track or line with at least two points.` };
      return { candidates, format: kind === 'gpx' ? 'GPX' : (bytes[0] === 0x50 ? 'KMZ' : 'KML') };
    } catch (err) {
      return { error: err && err.message ? err.message : "Couldn't read the file." };
    }
  }

  // Browser decompressor for KMZ entries.
  async function inflateRawBrowser(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open KMZ files. Use the KML or GPX instead.');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const api = { readRouteFile, parseGPX, parseKML, unzipKml, simplify, dedupe, inflateRawBrowser };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RouteIO = api;
})(typeof window !== 'undefined' ? window : globalThis);
