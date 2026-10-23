/* Navigation math for following a route: distance off the line, progress along each leg,
 * nearest point on the route, pass/turn detection for search grids, and coverage.
 * Works in browsers and in Node (tests). Distances are metres; positions are {lat, lon}.
 */
(function (root) {
  'use strict';

  const R = 6371008.8;

  // Flat projection around a reference point; accurate to well under 0.1% over a few km.
  function projector(ref) {
    const ky = R * Math.PI / 180, kx = Math.cos(ref.lat * Math.PI / 180) * ky;
    return {
      fwd: p => ({ x: (p.lon - ref.lon) * kx, y: (p.lat - ref.lat) * ky }),
      inv: q => ({ lat: ref.lat + q.y / ky, lon: ref.lon + q.x / kx })
    };
  }

  const bearingDeg = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;

  // A grid alternates long passes with short turns that run between parallel passes.
  function detectGrid(legs) {
    if (legs.length < 3) return null;
    for (const parity of [0, 1]) {
      const passes = legs.filter((_, i) => i % 2 === parity), turns = legs.filter((_, i) => i % 2 !== parity);
      if (passes.length < 2 || !turns.length) continue;
      const minPass = Math.min(...passes.map(l => l.len)), maxTurn = Math.max(...turns.map(l => l.len));
      if (minPass < 1.5 * maxTurn) continue;
      const ref = passes[0].brg;
      const parallel = passes.every(l => { const d = Math.abs(((l.brg - ref) % 180 + 180) % 180); return Math.min(d, 180 - d) < 20; });
      if (!parallel) continue;
      const lane = turns.map(l => l.len).sort((a, b) => a - b)[Math.floor(turns.length / 2)];
      return { parity, passCount: passes.length, lane };
    }
    return null;
  }

  // points: [{lat, lon, name}] in order. Returns the route model used by everything below.
  function buildRoute(points, opts) {
    opts = opts || {};
    const ref = { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lon: points.reduce((s, p) => s + p.lon, 0) / points.length };
    const proj = projector(ref);
    const xy = points.map(proj.fwd);
    const legs = [];
    let dist = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = xy[i], b = xy[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) continue;
      legs.push({ i: legs.length, from: i, a, b, len, brg: bearingDeg(a, b), start: dist });
      dist += len;
    }
    const grid = opts.grid === false ? null : detectGrid(legs);
    legs.forEach((l, i) => {
      l.isPass = grid ? i % 2 === grid.parity : true;
      l.pass = grid && l.isPass ? (i - grid.parity) / 2 + 1 : null;
    });
    // On-line tolerance: a quarter of the lane spacing for grids, 25 ft otherwise.
    const tol = opts.tol || (grid ? Math.min(20, Math.max(4.5, grid.lane / 4)) : 7.62);
    return { points, legs, total: dist, proj, grid, tol, ref };
  }

  // Where the boat is relative to one leg. xte > 0: boat is right of the line (steer left).
  function legState(route, i, pos) {
    const l = route.legs[i], p = route.proj.fwd(pos);
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, px = p.x - l.a.x, py = p.y - l.a.y;
    const along = (px * dx + py * dy) / l.len;
    const xte = (px * dy - py * dx) / l.len;
    return { leg: i, along, xte, toEnd: l.len - along, len: l.len };
  }

  // Closest point on the route. fromLeg/toLeg limit the search (inclusive).
  function nearest(route, pos, fromLeg, toLeg) {
    const p = route.proj.fwd(pos);
    let best = null;
    const lo = Math.max(0, fromLeg || 0), hi = Math.min(route.legs.length - 1, toLeg === undefined ? route.legs.length - 1 : toLeg);
    for (let i = lo; i <= hi; i++) {
      const l = route.legs[i];
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const t = Math.max(0, Math.min(l.len, ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / l.len));
      const d = Math.hypot(l.a.x + dx * t / l.len - p.x, l.a.y + dy * t / l.len - p.y);
      if (!best || d < best.dist - 1e-9) best = { leg: i, along: t, dist: d };
    }
    return best;
  }

  // Nearest leg for starting or re-joining: among legs about as close as the nearest one,
  // prefer a pass over a turn (at a corner the boat is usually starting the pass).
  function nearestToJoin(route, pos) {
    const best = nearest(route, pos);
    if (!best || route.legs[best.leg].isPass) return best;
    const slack = Math.max(2, route.tol / 2);
    let pick = best;
    for (const i of [best.leg + 1, best.leg - 1]) {
      if (i < 0 || i >= route.legs.length || !route.legs[i].isPass) continue;
      const n = nearest(route, pos, i, i);
      if (n.dist <= best.dist + slack && (pick === best || n.dist < pick.dist)) pick = n;
    }
    return pick;
  }

  // Point on leg i at a distance along it.
  function pointOn(route, i, along) {
    const l = route.legs[i], t = Math.max(0, Math.min(l.len, along)) / l.len;
    return route.proj.inv({ x: l.a.x + (l.b.x - l.a.x) * t, y: l.a.y + (l.b.y - l.a.y) * t });
  }

  // Merge [a, b] into a sorted list of non-overlapping intervals.
  function addInterval(list, a, b) {
    if (b < a) [a, b] = [b, a];
    const out = [];
    let placed = false;
    for (const [s, e] of list) {
      if (e < a - 0.5) out.push([s, e]);
      else if (s > b + 0.5) { if (!placed) { out.push([a, b]); placed = true; } out.push([s, e]); }
      else { a = Math.min(a, s); b = Math.max(b, e); }
    }
    if (!placed) out.push([a, b]);
    return out;
  }
  const intervalsLength = list => list.reduce((s, [a, b]) => s + (b - a), 0);

  // Follows the boat along the route.
  // state (plain JSON, saved by the page): { leg, startLeg, startAlong, cover: [[ [a,b], ... ] per leg], last, finished }
  function createNavigator(route, saved) {
    const legs = route.legs;
    // armed: the boat has been seen before the end of the current leg. Auto-advance needs it,
    // so choosing a leg by hand (Back, Skip, Nearest) never jumps straight past it.
    const st = saved || { leg: 0, startLeg: 0, startAlong: 0, cover: legs.map(() => []), last: null, finished: false, armed: false };
    const arriveFor = l => Math.min(10, l.len * 0.4);

    function start(leg, along) {
      st.leg = Math.max(0, Math.min(legs.length - 1, leg));
      st.startLeg = st.leg; st.startAlong = Math.max(0, along || 0);
      st.last = null; st.finished = false; st.armed = false;
    }
    function setLeg(leg) {
      st.leg = Math.max(0, Math.min(legs.length - 1, leg));
      st.last = null; st.finished = false; st.armed = false;
    }

    // Where the boat is on the current leg, without changing anything (for display).
    function peek(fix) {
      const s = legState(route, st.leg, fix);
      return { leg: st.leg, along: s.along, xte: s.xte, toEnd: Math.max(0, s.toEnd), len: s.len, onLine: Math.abs(s.xte) <= route.tol, advancedFrom: [], finished: st.finished };
    }

    // fix: {lat, lon, t (ms)}. Returns the current situation for the display.
    function update(fix) {
      let s = legState(route, st.leg, fix);
      const advancedFrom = [];
      const thr = l => l.len - arriveFor(l);
      if (s.along < thr(legs[st.leg])) st.armed = true;
      // A leg chosen by hand that the boat is already past, with the boat running the next leg: move on.
      if (!st.armed && s.along >= thr(legs[st.leg]) && st.leg < legs.length - 1) {
        const nx = legState(route, st.leg + 1, fix);
        if (nx.along >= arriveFor(legs[st.leg + 1]) && nx.along < nx.len && Math.abs(nx.xte) <= route.tol * 2) st.armed = true;
      }
      // Move on when the end of the leg is reached (or passed); short turns can go by in one fix.
      for (let n = 0; n < 4 && !st.finished && st.armed && s.along >= thr(legs[st.leg]); n++) {
        record(fix, s);
        advancedFrom.push(st.leg);
        if (st.leg === legs.length - 1) { st.finished = true; break; }
        st.leg++;
        st.last = null;
        s = legState(route, st.leg, fix);
      }
      if (!st.finished) record(fix, s);
      const on = Math.abs(s.xte) <= route.tol;
      return { leg: st.leg, along: s.along, xte: s.xte, toEnd: Math.max(0, s.toEnd), len: s.len, onLine: on, advancedFrom, finished: st.finished };
    }

    // Count the stretch between the previous fix and this one as covered when both were on the line.
    function record(fix, s) {
      const on = Math.abs(s.xte) <= route.tol;
      const prev = st.last;
      if (prev && prev.leg === s.leg && prev.on && on && fix.t - prev.t < 30000) {
        const L = legs[s.leg].len;
        st.cover[s.leg] = addInterval(st.cover[s.leg], Math.max(0, Math.min(L, prev.along)), Math.max(0, Math.min(L, s.along)));
      }
      st.last = { leg: s.leg, along: s.along, on, t: fix.t };
    }

    // Covered fraction of each leg, and totals for passes.
    function coverage() {
      const per = legs.map((l, i) => Math.min(1, intervalsLength(st.cover[i]) / l.len));
      const passes = legs.filter(l => l.isPass);
      const passLen = passes.reduce((s, l) => s + l.len, 0);
      const done = passes.reduce((s, l) => s + per[l.i] * l.len, 0);
      return { per, fraction: passLen ? done / passLen : 0, coveredM: done, passM: passLen };
    }

    return { state: st, start, setLeg, update, peek, coverage };
  }

  const api = { projector, buildRoute, detectGrid, legState, nearest, nearestToJoin, pointOn, addInterval, intervalsLength, createNavigator, bearingDeg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NavCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
