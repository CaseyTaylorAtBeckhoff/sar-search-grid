/* SAR search grid core: grid generation + GPX / Humminbird .HWR writers.
 *
 * Grid logic ported from foursided.py (Casey, 2013).
 * HWR writer ported from GPSBabel's humminbird.cc (GPL v2+):
 *   Copyright (C) 2008 Björn Augustsson, Olaf Klein; 2005-2024 Robert Lipe.
 */
(function (root) {
  'use strict';

  // ---------- Grid ----------

  // corners: [c1, c2, c3, c4] as {lat, lon}.
  //   c1 = start, c2 = end of first pass, then continuing around the shape.
  //   Passes run parallel to c1->c2 and step from that edge toward c4->c3.
  function buildGrid(corners, passes) {
    passes = Math.max(2, Math.floor(passes));
    const [c1, c2, c3, c4] = corners;
    const pts = [];
    let forward = true;
    for (let i = 0; i < passes; i++) {
      const s = i / (passes - 1);
      let a = { lat: c1.lat + s * (c4.lat - c1.lat), lon: c1.lon + s * (c4.lon - c1.lon) };
      let b = { lat: c2.lat + s * (c3.lat - c2.lat), lon: c2.lon + s * (c3.lon - c2.lon) };
      if (!forward) [a, b] = [b, a];
      forward = !forward;
      pts.push(a, b);
    }
    return pts;
  }

  // Great-circle distance in metres.
  function distM(a, b) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Lane spacing along the start edge (c1->c4) and end edge (c2->c3), in metres.
  function laneSpacing(corners, passes) {
    const [c1, c2, c3, c4] = corners;
    const n = Math.max(1, passes - 1);
    return { start: distM(c1, c4) / n, end: distM(c2, c3) / n };
  }

  // Passes needed so lanes are no wider than spacingM on the wider edge.
  function passesForSpacing(corners, spacingM) {
    const [c1, c2, c3, c4] = corners;
    const width = Math.max(distM(c1, c4), distM(c2, c3));
    return Math.max(2, Math.ceil(width / spacingM) + 1);
  }

  function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += distM(pts[i - 1], pts[i]);
    return d;
  }

  // ---------- Naming ----------

  // Waypoint names: prefix + zero-padded number, kept within maxLen.
  function waypointNames(count, prefix, maxLen) {
    const digits = String(count).length;
    const p = cleanName(prefix || 'WP').slice(0, Math.max(1, maxLen - digits));
    const out = [];
    for (let i = 1; i <= count; i++) out.push(p + String(i).padStart(digits, '0'));
    return out;
  }

  function cleanName(s) {
    // Printable ASCII only: the units use a fixed-width byte field.
    return String(s).replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
  }

  // Split a point list into routes of at most maxPts points. Each new route
  // starts at the last point of the previous one so the track is continuous.
  function splitRoutes(count, maxPts) {
    const routes = [];
    let start = 0;
    while (start < count - 1 || routes.length === 0) {
      const end = Math.min(count, start + maxPts);
      const idx = [];
      for (let i = start; i < end; i++) idx.push(i);
      routes.push(idx);
      if (end >= count) break;
      start = end - 1;
    }
    return routes;
  }

  function routeNames(baseName, n, maxLen) {
    const base = cleanName(baseName || 'Grid') || 'Grid';
    if (n === 1) return [base.slice(0, maxLen)];
    const out = [];
    for (let i = 1; i <= n; i++) {
      const suffix = '-' + i;
      out.push(base.slice(0, maxLen - suffix.length) + suffix);
    }
    return out;
  }

  // ---------- GPX ----------

  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toGPX(pts, opts) {
    const o = Object.assign({ routeName: 'Grid', prefix: 'WP', time: new Date() }, opts);
    const names = opts && opts.names ? opts.names : waypointNames(pts.length, o.prefix, 20);
    const iso = o.time.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="SAR Search Grid" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <metadata><name>' + xmlEsc(o.routeName) + '</name><time>' + iso + '</time></metadata>',
      '  <rte>',
      '    <name>' + xmlEsc(o.routeName) + '</name>'
    ];
    pts.forEach((p, i) => {
      lines.push('    <rtept lat="' + p.lat.toFixed(7) + '" lon="' + p.lon.toFixed(7) + '"><name>' +
        xmlEsc(names[i]) + '</name></rtept>');
    });
    lines.push('  </rte>', '</gpx>', '');
    return lines.join('\n');
  }

  // ---------- Humminbird .HWR (HELIX, 1100-series and other legacy units) ----------

  const WPT_MAGIC = 0x02020024;
  const RTE_MAGIC = 0x03030088;
  const WPT_NAME_LEN = 12;     // incl. terminating NUL -> 11 usable chars
  const RTE_NAME_LEN = 20;     // incl. terminating NUL -> 19 usable chars
  const MAX_RTE_POINTS = 50;
  const I1924_EQU_AXIS = 6378388.0;
  const EAST_SCALE = 20038297.0;
  const COS2_AE = 0.9966349016452 * 0.9966349016452;

  function hwrEast(lon) { return Math.round(lon / 180.0 * EAST_SCALE); }
  function hwrNorth(lat) {
    const gc = Math.atan(COS2_AE * Math.tan(lat * Math.PI / 180.0));   // geodetic -> geocentric (rad)
    return Math.round(Math.log(Math.tan(Math.PI / 4.0 + gc / 2.0)) * I1924_EQU_AXIS);
  }
  function hwrLatLon(east, north) {             // inverse, for verification/preview
    const gud = Math.atan(Math.sinh(north / I1924_EQU_AXIS));
    return { lat: Math.atan(Math.tan(gud) / COS2_AE) * 180 / Math.PI, lon: east / EAST_SCALE * 180 };
  }

  function putName(view, offset, field, s) {
    const str = cleanName(s).slice(0, field - 1);
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  // opts: { routeName, prefix, time (Date), names (optional explicit waypoint names),
  //         wptTimes (optional array of Date), icon (0 = Normal) }
  function toHWR(pts, opts) {
    const o = Object.assign({ routeName: 'Grid', prefix: 'WP', time: new Date(), icon: 0 }, opts);
    const names = o.names || waypointNames(pts.length, o.prefix, WPT_NAME_LEN - 1);
    const t = Math.floor(o.time.getTime() / 1000) >>> 0;
    const routes = splitRoutes(pts.length, MAX_RTE_POINTS);
    const rNames = routeNames(o.routeName, routes.length, RTE_NAME_LEN - 1);

    const buf = new ArrayBuffer(pts.length * 36 + routes.length * 136);
    const v = new DataView(buf);
    let off = 0;

    pts.forEach((p, i) => {
      v.setUint32(off, WPT_MAGIC);
      v.setUint16(off + 4, i);          // num
      v.setUint16(off + 6, 0);          // zero
      v.setUint8(off + 8, 1);           // status
      v.setUint8(off + 9, o.icon);      // icon
      v.setUint16(off + 10, 0);         // depth (cm)
      const wt = o.wptTimes ? Math.floor(o.wptTimes[i].getTime() / 1000) >>> 0 : t;
      v.setUint32(off + 12, wt);        // time (UTC epoch s)
      v.setInt32(off + 16, hwrEast(p.lon));
      v.setInt32(off + 20, hwrNorth(p.lat));
      putName(v, off + 24, WPT_NAME_LEN, names[i]);
      off += 36;
    });

    routes.forEach((idx, r) => {
      v.setUint32(off, RTE_MAGIC);
      v.setUint16(off + 4, r);           // num
      v.setUint16(off + 6, 0);           // zero
      v.setUint8(off + 8, 0);            // status
      v.setUint8(off + 9, 0);            // U0
      v.setUint8(off + 10, 0);           // U1
      v.setInt8(off + 11, idx.length);   // count
      v.setUint32(off + 12, o.routeTime !== undefined ? o.routeTime : t);
      putName(v, off + 16, RTE_NAME_LEN, rNames[r]);
      idx.forEach((wi, k) => v.setUint16(off + 36 + k * 2, wi));
      off += 136;
    });

    return { bytes: new Uint8Array(buf), routes: rNames.map((n, i) => ({ name: n, points: routes[i].length })), names };
  }

  // Minimal reader for self-checks.
  function readHWR(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const wpts = [], rtes = [];
    let off = 0;
    const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = v.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
    while (off < bytes.length) {
      const m = v.getUint32(off);
      if (m === WPT_MAGIC) {
        const ll = hwrLatLon(v.getInt32(off + 16), v.getInt32(off + 20));
        wpts.push({ num: v.getUint16(off + 4), name: str(off + 24, 12), lat: ll.lat, lon: ll.lon });
        off += 36;
      } else if (m === RTE_MAGIC) {
        const n = v.getInt8(off + 11), pts = [];
        for (let k = 0; k < n; k++) pts.push(v.getUint16(off + 36 + k * 2));
        rtes.push({ num: v.getUint16(off + 4), name: str(off + 16, 20), points: pts });
        off += 136;
      } else throw new Error('Unknown record 0x' + m.toString(16) + ' at ' + off);
    }
    return { wpts, rtes };
  }

  const api = { buildGrid, distM, laneSpacing, passesForSpacing, pathLength, waypointNames,
    splitRoutes, routeNames, toGPX, toHWR, readHWR, hwrEast, hwrNorth, hwrLatLon,
    LIMITS: { WPT_NAME: WPT_NAME_LEN - 1, RTE_NAME: RTE_NAME_LEN - 1, RTE_POINTS: MAX_RTE_POINTS } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GridCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
