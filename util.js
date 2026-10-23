/* SAR search grid helpers: coordinate parsing/formatting, area geometry, ZIP packaging. */
(function (root) {
  'use strict';

  // ---------- Coordinates ----------

  // Accepts decimal degrees, degrees + decimal minutes, or DMS, with or without
  // hemisphere letters: "41.36506, -112.07352", "N41 21.904 W112 04.411",
  // "N 41° 21.904' W 112° 04.411'", 41°21'54.2"N 112°04'24.7"W.
  function parseCoord(str) {
    if (!str || !String(str).trim()) return { empty: true };
    // Typographic minus signs and dashes (common when copying from web pages) -> '-'
    let raw = String(str).replace(/[−‐‑‒–—﹣－]/g, '-');
    // Letter unit markers (41d21m54.2s) when degrees are written with a 'd'
    if (/\d\s*(?:deg|d)(?![a-z])/i.test(raw))
      raw = raw.replace(/(\d)\s*(?:deg|min|sec|d|m|s)(?=[\s\d.,;:\/NSEWnsew-]|$)/g, '$1 ');
    const s = raw.toUpperCase().replace(/[°º˚'’′"”″,;\/]/g, ' ');
    const toks = s.match(/[NSEW]|[-+]?\d+(?:\.\d+)?/g);
    if (!toks) return { error: 'No numbers found' };
    const isL = t => /^[NSEW]$/.test(t);
    const letters = toks.filter(isL);
    let groups = [];
    if (letters.length === 2) {
      if (isL(toks[0])) {
        let cur = null;
        for (const t of toks) {
          if (isL(t)) { cur = { h: t, n: [] }; groups.push(cur); } else cur.n.push(t);
        }
      } else {
        let cur = { n: [] };
        for (const t of toks) {
          if (isL(t)) { cur.h = t; groups.push(cur); cur = { n: [] }; } else cur.n.push(t);
        }
        if (cur.n.length) return { error: 'Extra numbers after the last N/S/E/W' };
      }
    } else if (letters.length === 0) {
      if (toks.length % 2 || toks.length > 6) return { error: 'Enter latitude and longitude' };
      const half = toks.length / 2;
      groups = [{ n: toks.slice(0, half) }, { n: toks.slice(half) }];
    } else {
      return { error: 'Use N/S and E/W on both values, or on neither' };
    }
    if (groups.length !== 2) return { error: 'Enter latitude and longitude' };

    const vals = [];
    for (const g of groups) {
      if (!g.n.length || g.n.length > 3) return { error: 'Use degrees, degrees + minutes, or degrees + minutes + seconds' };
      const neg = g.n[0].startsWith('-');
      const d = Math.abs(parseFloat(g.n[0])), m = g.n[1] ? parseFloat(g.n[1]) : 0, sec = g.n[2] ? parseFloat(g.n[2]) : 0;
      if (m >= 60 || sec >= 60 || m < 0 || sec < 0) return { error: 'Minutes and seconds must be under 60' };
      if (g.n.length > 1 && d % 1 !== 0) return { error: 'Degrees must be whole when minutes are given' };
      let v = d + m / 60 + sec / 3600;
      if (neg || g.h === 'S' || g.h === 'W') v = -v;
      if (neg && (g.h === 'S' || g.h === 'W')) return { error: 'Use a minus sign or S/W, not both' };
      vals.push({ v, h: g.h });
    }
    let lat, lon;
    if (vals[0].h) {
      const ns = vals.find(x => x.h === 'N' || x.h === 'S'), ew = vals.find(x => x.h === 'E' || x.h === 'W');
      if (!ns || !ew) return { error: 'Need one N/S value and one E/W value' };
      lat = ns.v; lon = ew.v;
    } else {
      lat = vals[0].v; lon = vals[1].v;
    }
    if (Math.abs(lat) > 90) return { error: 'Latitude must be between -90 and 90' };
    if (Math.abs(lon) > 180) return { error: 'Longitude must be between -180 and 180' };
    return { lat, lon };
  }

  // Several points pasted at once: one per line, separated by ; or |, all on one line,
  // labelled ("Corner 1: ..."), or a GPX / KML snippet. Returns { pts: [{lat, lon, text}], how }
  // or { error }. `text` keeps the user's own wording for each point where there is one.
  function parseCorners(input, want) {
    want = want || 4;
    const t = String(input || '').trim();
    if (!t) return { empty: true };
    let pts = null, how = '';

    const gpx = [];
    for (const m of t.matchAll(/<(?:wpt|rtept|trkpt)\b[^>]*>/gi)) {
      const la = /\blat\s*=\s*["']([-+\d.]+)["']/i.exec(m[0]), lo = /\blon\s*=\s*["']([-+\d.]+)["']/i.exec(m[0]);
      if (la && lo) gpx.push({ lat: +la[1], lon: +lo[1] });
    }
    if (gpx.length) { pts = gpx; how = 'GPX'; }
    if (!pts) {
      const kml = [];
      for (const b of t.matchAll(/<(?:gx:)?coord(?:inates)?\b[^>]*>([\s\S]*?)<\/(?:gx:)?coord(?:inates)?>/gi)) {
        b[1].trim().split(/\s+/).forEach(tr => {
          const v = tr.split(',').map(Number);           // KML order is lon,lat[,alt]
          if (v.length >= 2 && isFinite(v[0]) && isFinite(v[1])) kml.push({ lat: v[1], lon: v[0] });
        });
      }
      if (kml.length) { pts = kml; how = 'KML'; }
    }
    if (pts) {
      // A closed outline repeats its first point at the end.
      if (pts.length === want + 1 && Math.abs(pts[0].lat - pts[want].lat) < 1e-7 && Math.abs(pts[0].lon - pts[want].lon) < 1e-7)
        pts = pts.slice(0, want);
      if (pts.some(p => Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) return { error: `The ${how} has a position out of range.` };
      pts = pts.map(p => ({ lat: p.lat, lon: p.lon, text: p.lat.toFixed(6) + ', ' + p.lon.toFixed(6) }));
    } else {
      // Plain text. Drop labels such as "Corner 1 (NW):", "Pt 2 =", "3)" or "4. ".
      const lines = t.split(/\r?\n/).map(l => l
        .replace(/\([A-Za-z\s]*\)/g, ' ')
        .replace(/^\s*[A-Za-z]{2,}[\w #\/.-]*?\s*[:=]\s*/, '')
        .replace(/^\s*(?:(?:corner|point|pt|wp|waypoint)\s*#?\s*\d+\s*[-:.)=]?|#?\d+\s*[:)]|\d+\.\s+)\s*/i, '')
        .trim());
      const segs = lines.join('\n').split(/\r?\n|;|\|/).map(s => s.trim()).filter(Boolean);
      if (segs.length >= 2) {
        const parsed = segs.map(parseCoord);
        if (parsed.every(p => !p.error)) { pts = parsed.map((p, i) => ({ lat: p.lat, lon: p.lon, text: segs[i] })); how = 'separate lines'; }
      }
      if (!pts) {
        // Everything on one run: split the numbers and hemisphere letters into points.
        let raw = lines.join(' ').replace(/[−‐‑‒–—﹣－]/g, '-');
        if (/\d\s*(?:deg|d)(?![a-z])/i.test(raw)) raw = raw.replace(/(\d)\s*(?:deg|min|sec|d|m|s)(?=[\s\d.,;:\/NSEWnsew-]|$)/g, '$1 ');
        const toks = raw.toUpperCase().replace(/[°º˚'’′"”″,;\/]/g, ' ').match(/[NSEW]|[-+]?\d+(?:\.\d+)?/g) || [];
        const isL = x => /^[NSEW]$/.test(x);
        const groups = [];
        if (toks.some(isL)) {
          let cur = [], letters = 0;
          const prefix = isL(toks[0]);
          for (const x of toks) {
            if (isL(x) && prefix && letters === 2) { groups.push(cur); cur = []; letters = 0; }
            cur.push(x);
            if (isL(x)) { letters++; if (!prefix && letters === 2) { groups.push(cur); cur = []; letters = 0; } }
          }
          if (cur.length) groups.push(cur);
        } else if (toks.length % want === 0 && [2, 4, 6].includes(toks.length / want)) {
          const per = toks.length / want;
          for (let i = 0; i < toks.length; i += per) groups.push(toks.slice(i, i + per));
        }
        if (groups.length) {
          const parsed = groups.map(g => ({ g: g.join(' '), p: parseCoord(g.join(' ')) }));
          const bad = parsed.findIndex(x => x.p.error);
          if (bad >= 0) return { error: `Point ${bad + 1} ("${parsed[bad].g}"): ${parsed[bad].p.error}` };
          pts = parsed.map(x => ({ lat: x.p.lat, lon: x.p.lon, text: x.g })); how = 'one line';
        }
      }
    }
    if (!pts) {
      const one = parseCoord(t);
      return { error: one.error ? "Couldn't find " + want + ' positions in that text.' : 'That is only one position. Paste all ' + want + ' corners.' };
    }
    if (pts.length !== want) return { error: `Found ${pts.length} position${pts.length === 1 ? '' : 's'}; need ${want}.` };
    return { pts, how };
  }

  // Degrees + decimal minutes, the way Humminbird units display positions.
  function fmtDDM(v, isLat) {
    const h = isLat ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E');
    const a = Math.abs(v);
    let d = Math.floor(a), m = (a - d) * 60;
    if (m >= 59.9995) { d += 1; m = 0; }
    return h + ' ' + String(d).padStart(isLat ? 2 : 3, '0') + '° ' + m.toFixed(3).padStart(6, '0') + "'";
  }
  function fmtPos(p) { return fmtDDM(p.lat, true) + '  ' + fmtDDM(p.lon, false); }

  // ---------- Area geometry ----------

  const R = 6371008.8;
  function offset(c, dxEast, dyNorth) {
    return {
      lat: c.lat + (dyNorth / R) * 180 / Math.PI,
      lon: c.lon + (dxEast / (R * Math.cos(c.lat * Math.PI / 180))) * 180 / Math.PI
    };
  }

  // Box from a center point. Corner 1 is back-left, 2 front-left, 3 front-right,
  // 4 back-right, looking along the heading. Passes default to running along the heading.
  function boxFromCenter(c, lengthM, widthM, headingDeg) {
    const h = headingDeg * Math.PI / 180;
    const u = [Math.sin(h), Math.cos(h)];        // along heading (east, north)
    const v = [Math.cos(h), -Math.sin(h)];       // to the right of the heading
    const at = (a, b) => offset(c, a * u[0] + b * v[0], a * u[1] + b * v[1]);
    const L = lengthM / 2, W = widthM / 2;
    return [at(-L, -W), at(L, -W), at(L, W), at(-L, W)];
  }

  // Reorder corners so the grid starts at corner `start` (0-3) with passes
  // parallel to side 1-2 (axis 'A') or side 2-3 (axis 'B').
  function orient(base, start, axis) {
    const evenStart = start % 2 === 0;
    const forward = (axis === 'A') === evenStart;
    const out = [];
    for (let k = 0; k < 4; k++) out.push(base[((start + (forward ? k : -k)) % 4 + 4) % 4]);
    return out;
  }

  // Local flat projection (metres) around a reference point.
  function project(p, ref) {
    return {
      x: (p.lon - ref.lon) * Math.PI / 180 * R * Math.cos(ref.lat * Math.PI / 180),
      y: (p.lat - ref.lat) * Math.PI / 180 * R
    };
  }

  function segmentsCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  }

  // True when the four corners, taken in order, make a bow-tie instead of an outline.
  function cornersCrossed(corners) {
    const ref = corners[0];
    const p = corners.map(c => project(c, ref));
    return segmentsCross(p[0], p[1], p[2], p[3]) || segmentsCross(p[1], p[2], p[3], p[0]);
  }

  // ---------- ZIP (stored, no compression) ----------

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // files: [{ name, data: Uint8Array | string }]
  function makeZip(files, when) {
    const enc = new TextEncoder();
    const d = when || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const entries = files.map(f => {
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      return { name: enc.encode(f.name), data, crc: crc32(data) };
    });
    const localSize = entries.reduce((s, e) => s + 30 + e.name.length + e.data.length, 0);
    const centralSize = entries.reduce((s, e) => s + 46 + e.name.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const v = new DataView(out.buffer);
    let off = 0;
    const offsets = [];
    for (const e of entries) {
      offsets.push(off);
      v.setUint32(off, 0x04034b50, true); v.setUint16(off + 4, 20, true); v.setUint16(off + 6, 0x0800, true);
      v.setUint16(off + 8, 0, true); v.setUint16(off + 10, dosTime, true); v.setUint16(off + 12, dosDate, true);
      v.setUint32(off + 14, e.crc, true); v.setUint32(off + 18, e.data.length, true); v.setUint32(off + 22, e.data.length, true);
      v.setUint16(off + 26, e.name.length, true); v.setUint16(off + 28, 0, true);
      out.set(e.name, off + 30); out.set(e.data, off + 30 + e.name.length);
      off += 30 + e.name.length + e.data.length;
    }
    const cdStart = off;
    entries.forEach((e, i) => {
      v.setUint32(off, 0x02014b50, true); v.setUint16(off + 4, 20, true); v.setUint16(off + 6, 20, true);
      v.setUint16(off + 8, 0x0800, true); v.setUint16(off + 10, 0, true); v.setUint16(off + 12, dosTime, true);
      v.setUint16(off + 14, dosDate, true); v.setUint32(off + 16, e.crc, true); v.setUint32(off + 20, e.data.length, true);
      v.setUint32(off + 24, e.data.length, true); v.setUint16(off + 28, e.name.length, true);
      // extra, comment, disk, internal attrs = 0; external attrs = 0
      v.setUint32(off + 42, offsets[i], true);
      out.set(e.name, off + 46);
      off += 46 + e.name.length;
    });
    v.setUint32(off, 0x06054b50, true); v.setUint16(off + 8, entries.length, true); v.setUint16(off + 10, entries.length, true);
    v.setUint32(off + 12, off - cdStart, true); v.setUint32(off + 16, cdStart, true);
    return out;
  }

  const api = { parseCoord, parseCorners, fmtDDM, fmtPos, offset, boxFromCenter, orient, project, cornersCrossed, crc32, makeZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GridUtil = api;
})(typeof window !== 'undefined' ? window : globalThis);
