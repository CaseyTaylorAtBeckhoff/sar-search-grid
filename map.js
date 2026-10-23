/* Zoomable, pannable SVG map over USGS satellite tiles, shared by the grid builder,
 * the corner picker and the Navigate page. */
(function (root) {
  'use strict';
  // USGS National Map orthoimagery: public domain, no key, US coverage. Cached to zoom 16.
  const IMAGERY = {
    url: (z, y, x) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 16,
    fallbackLevels: 3,
    credit: 'Imagery: USDA, USGS The National Map'
  };
  // The claude.ai preview frame blocks images from other sites; the deployed page does not.
  const framed = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
  const imageryBlocked = () => framed && !!(window.claude && typeof window.claude.use === 'function');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function mercator(p) {
    const r = p.lat * Math.PI / 180;
    return { x: (p.lon + 180) / 360 * 256, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 };
  }
  function unmercator(x, y) {
    return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 256))) * 180 / Math.PI, lon: x / 256 * 360 - 180 };
  }
  // Metres per Web Mercator unit at a latitude; metres per drawing pixel = this / k.
  const metresPerUnit = lat => 2 * Math.PI * 6378137 * Math.cos(lat * Math.PI / 180) / 256;

  // units: 'ft' or 'm'
  function scaleBarSvg(ctx, units, id) {
    const unit = units === 'm' ? 1 : 0.3048, f = n => n.toFixed(1);
    const targetUnits = 120 * ctx.mPerPx / unit;
    const mag = Math.pow(10, Math.floor(Math.log10(targetUnits)));
    const nice = [1, 2, 5, 10].map(m => m * mag).reduce((best, v) => Math.abs(v - targetUnits) < Math.abs(best - targetUnits) ? v : best, mag);
    const barPx = nice * unit / ctx.mPerPx;
    const label = nice >= 1 ? nice.toLocaleString() : String(+nice.toPrecision(2));
    return `<g${id ? ` id="${id}"` : ''} transform="translate(18,${ctx.H - 22})"><rect class="panel" x="-8" y="-24" width="${f(barPx + 16)}" height="38" rx="6"/>` +
      `<rect class="ink" width="${f(barPx)}" height="5"/><rect class="surf" width="${f(barPx / 2)}" height="5"/>` +
      `<text class="t" y="-8">0</text><text class="t" x="${f(barPx)}" y="-8" text-anchor="end">${label} ${units === 'm' ? 'm' : 'ft'}</text></g>`;
  }

  // A zoomable, pannable map drawn in SVG over satellite tiles. Used by the grid preview
  // and the corner picker. Gestures move the drawing with a transform right away; when they
  // settle, it is redrawn at the new scale so lines stay crisp and sharper imagery loads.
  //
  // cfg: size() -> {W, H, mapH}; pad(toVb) -> {l, r, t, b}; zoomLimits(rendered) -> [kMin, kMax];
  //      draw(ctx) -> {defs, vp, fixed}; touch: 'twoFinger' (one finger scrolls the page) or
  //      'pointer' (one finger pans); dblclickZoom; maxTiles; maxFitMPerPx; controls {zin, zout, fit};
  //      hint (element); credit(msg); imagery() -> bool; onTap(latlon); after(map);
  //      tileMargin: extra imagery loaded around the view (fraction of its size), for panTo
  function createMap(svg, cfg) {
    const m = { view: null, bounds: null, rendered: null, live: { s: 1, tx: 0, ty: 0 }, drawId: 0 };
    let commitTimer = null, pinch = null, drag = null, oneTouch = null, hintTimer = null;
    const ptrs = new Map();

    m.setBounds = (latlons, keepView) => {
      const q = latlons.map(mercator);
      m.bounds = q.length ? {
        minX: Math.min(...q.map(p => p.x)), maxX: Math.max(...q.map(p => p.x)),
        minY: Math.min(...q.map(p => p.y)), maxY: Math.max(...q.map(p => p.y)),
        lat: latlons.reduce((s, p) => s + p.lat, 0) / latlons.length
      } : null;
      if (!keepView) m.view = null;
    };

    function makeCtx(r) {
      const S = p => { const q = mercator(p); return [r.ox + q.x * r.k, r.oy + q.y * r.k]; };
      return { S, k: r.k, ox: r.ox, oy: r.oy, W: r.W, H: r.H, mapH: r.mapH, fitK: r.fitK, mPerPx: r.mPerK / r.k, toVb: r.toVb, view: m.view };
    }

    m.render = keepTiles => {
      if (!svg.getClientRects().length) return;          // not on screen (e.g. picker closed)
      const id = ++m.drawId;
      const prevLive = m.live;
      m.live = { s: 1, tx: 0, ty: 0 };
      const { W, H, mapH } = cfg.size();
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const rect = svg.getBoundingClientRect();
      const toVb = W / (rect.width || W);
      const pad = cfg.pad(toVb);
      const b = m.bounds || { minX: 0, maxX: 256, minY: 40, maxY: 216, lat: 0 };
      const availW = Math.max(1, W - pad.l - pad.r), availH = Math.max(1, mapH - pad.t - pad.b);
      let fitK = Math.min(availW / Math.max(1e-9, b.maxX - b.minX), availH / Math.max(1e-9, b.maxY - b.minY));
      if (cfg.maxFitMPerPx) fitK = Math.min(fitK, metresPerUnit(b.lat) / cfg.maxFitMPerPx);
      let k, ox, oy;
      if (m.view) { k = m.view.k; ox = W / 2 - m.view.cx * k; oy = mapH / 2 - m.view.cy * k; }
      else {
        k = fitK;
        ox = pad.l + availW / 2 - (b.minX + b.maxX) / 2 * k;
        oy = pad.t + availH / 2 - (b.minY + b.maxY) / 2 * k;
      }
      const mPerK = metresPerUnit(unmercator(0, Math.max(0, Math.min(256, (mapH / 2 - oy) / k))).lat);
      m.rendered = { ox, oy, k, fitK, mPerK, W, H, mapH, toVb };
      const f = n => n.toFixed(1);

      // Satellite tiles (Web Mercator, 256 px). Each tile sits in its own <svg> so a
      // missing tile can fall back to a zoomed-in crop of its parent.
      const wantSat = cfg.imagery();
      let tiles = '', tileCount = 0;
      const zWant = Math.round(Math.log2(k / toVb * Math.min(3, window.devicePixelRatio || 1)));
      if (wantSat && navigator.onLine !== false && isFinite(zWant)) {
        let z = Math.max(1, Math.min(IMAGERY.maxZoom, zWant));
        let n, x0, x1, y0, y1;
        for (;;) {
          n = Math.pow(2, z);
          const mx = W * (cfg.tileMargin || 0), my = H * (cfg.tileMargin || 0);
          x0 = Math.floor((-mx - ox) / k * n / 256); x1 = Math.floor((W + mx - ox) / k * n / 256);
          y0 = Math.max(0, Math.floor((-my - oy) / k * n / 256)); y1 = Math.min(n - 1, Math.floor((H + my - oy) / k * n / 256));
          if ((x1 - x0 + 1) * (y1 - y0 + 1) <= (cfg.maxTiles || 48) || z <= 1) break;
          z--;
        }
        const ts = 256 / n * k;
        tiles += '<g class="sat-tiles">';
        for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
          const wx = ((tx % n) + n) % n;
          tiles += `<svg x="${f(ox + tx * ts)}" y="${f(oy + ty * ts)}" width="${(ts + 0.6).toFixed(2)}" height="${(ts + 0.6).toFixed(2)}" viewBox="0 0 256 256" preserveAspectRatio="none" data-z="${z}" data-x="${wx}" data-y="${ty}">` +
            `<image width="256" height="256" preserveAspectRatio="none" href="${IMAGERY.url(z, ty, wx)}"/></svg>`;
          tileCount++;
        }
        tiles += '</g>';
      }

      const out = cfg.draw(makeCtx(m.rendered));
      // Keep the previous imagery (moved to match the new view) until the new tiles load.
      const oldTiles = keepTiles ? svg.querySelector('.vp > .sat-tiles') : null;
      const hadSat = svg.classList.contains('sat');
      svg.innerHTML = (out.defs || '') + '<g class="vp">' + tiles + `<g class="ov">${out.vp || ''}</g></g><g class="fx">${out.fixed || ''}</g>`;
      svg.classList.toggle('sat', !!(oldTiles && hadSat && wantSat));
      let backdrop = null;
      if (oldTiles && wantSat) {
        backdrop = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        backdrop.setAttribute('class', 'sat-old');
        backdrop.setAttribute('transform', `matrix(${prevLive.s} 0 0 ${prevLive.s} ${prevLive.tx} ${prevLive.ty})`);
        backdrop.appendChild(oldTiles);
        const vp = svg.querySelector('.vp');
        vp.insertBefore(backdrop, vp.firstChild);
        setTimeout(() => backdrop.remove(), 10000);
      }
      if (cfg.after) cfg.after(m);

      if (!wantSat) { cfg.credit(imageryBlocked() ? "Satellite imagery isn't available in this preview." : ''); return; }
      if (!tileCount) { cfg.credit('No satellite imagery: no internet connection.'); return; }
      if (!backdrop) cfg.credit('Loading satellite imagery…');
      let settled = 0, shown = 0;
      const done = () => {
        if (id !== m.drawId) return;
        if (shown) cfg.credit(IMAGERY.credit);
        if (settled === tileCount) {
          if (backdrop) backdrop.remove();
          if (!shown) { svg.classList.remove('sat'); cfg.credit('No satellite imagery: offline or not available here.'); }
        }
      };
      svg.querySelectorAll('.vp > .sat-tiles svg').forEach(box => {
        const img = box.querySelector('image');
        let depth = 0;
        img.addEventListener('load', () => {
          if (id !== m.drawId) return;
          settled++; shown++;
          svg.classList.add('sat');
          done();
        });
        img.addEventListener('error', () => {
          if (id !== m.drawId) return;
          const z = +box.dataset.z, x = +box.dataset.x, y = +box.dataset.y;
          depth++;
          if (depth > IMAGERY.fallbackLevels || z - depth < 0) { box.remove(); settled++; done(); return; }
          const mm = Math.pow(2, depth), size = 256 / mm;
          box.setAttribute('viewBox', `${(x % mm) * size} ${(y % mm) * size} ${size} ${size}`);
          img.setAttribute('href', IMAGERY.url(z - depth, y >> depth, x >> depth));
        });
      });
    };

    // Redraw only the markers and labels (no tile reload); the current gesture transform stays.
    m.redrawOverlay = () => {
      if (!m.rendered) return;
      const out = cfg.draw(makeCtx(m.rendered));
      const ov = svg.querySelector('.ov'), fx = svg.querySelector('.fx');
      if (ov) ov.innerHTML = out.vp || '';
      if (fx) fx.innerHTML = out.fixed || '';
    };

    m.clear = msg => {
      m.drawId++;
      m.rendered = null;
      svg.classList.remove('sat');
      const { W, H } = cfg.size();
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" class="empty">${esc(msg)}</text>`;
      cfg.credit('');
    };

    m.svgPoint = (clientX, clientY) => {
      const r = svg.getBoundingClientRect(), { W, H } = m.rendered || cfg.size();
      return [(clientX - r.left) * W / r.width, (clientY - r.top) * H / r.height];
    };
    m.toLatLon = p => {
      const r = m.rendered, l = m.live, k = r.k * l.s;
      return unmercator((p[0] - (r.ox * l.s + l.tx)) / k, (p[1] - (r.oy * l.s + l.ty)) / k);
    };
    m.centerOn = (ll, mPerPx) => {
      const q = mercator(ll);
      clearTimeout(commitTimer);
      m.view = { cx: q.x, cy: q.y, k: mPerPx ? metresPerUnit(ll.lat) / mPerPx : (m.rendered ? m.rendered.k * m.live.s : 1) };
      m.render(true);
    };
    m.fit = () => { clearTimeout(commitTimer); m.view = null; m.render(true); };
    // Keep a moving point (the boat) in the middle by shifting the drawing. The map is only
    // redrawn, with fresh imagery, once it has drifted a good way from where it was drawn.
    m.panTo = ll => {
      const r = m.rendered;
      if (!r || pinch || drag) return;
      const q = mercator(ll), s = m.live.s;
      const tx = r.W / 2 - s * (r.ox + q.x * r.k), ty = r.mapH / 2 - s * (r.oy + q.y * r.k);
      setLive(s, tx, ty);
      const far = Math.abs(tx) > r.W * (cfg.tileMargin || 0) * 0.8 || Math.abs(ty) > r.H * (cfg.tileMargin || 0) * 0.8;
      if (far || s !== 1) scheduleCommit(0);
    };

    function applyLive() {
      const vp = svg.querySelector('.vp');
      if (vp) vp.setAttribute('transform', `matrix(${m.live.s} 0 0 ${m.live.s} ${m.live.tx} ${m.live.ty})`);
    }
    function setLive(s, tx, ty) { m.live = { s, tx, ty }; applyLive(); }
    function scaleBounds() {
      const [kMin, kMax] = cfg.zoomLimits(m.rendered);
      return [kMin / m.rendered.k, kMax / m.rendered.k];
    }
    function zoomAt(p, factor, delay) {
      if (!m.rendered) return;
      const [lo, hi] = scaleBounds();
      const s = Math.max(lo, Math.min(hi, m.live.s * factor));
      const fct = s / m.live.s;
      setLive(s, p[0] - fct * (p[0] - m.live.tx), p[1] - fct * (p[1] - m.live.ty));
      scheduleCommit(delay);
    }
    m.zoomAt = zoomAt;
    function scheduleCommit(delay) {
      clearTimeout(commitTimer);
      commitTimer = setTimeout(commit, delay === undefined ? 250 : delay);
    }
    function commit() {
      if (!m.rendered || pinch || drag) return;
      const l = m.live, r = m.rendered;
      if (l.s === 1 && l.tx === 0 && l.ty === 0) return;
      const k = r.k * l.s, ox = r.ox * l.s + l.tx, oy = r.oy * l.s + l.ty;
      m.view = { k, cx: (r.W / 2 - ox) / k, cy: (r.mapH / 2 - oy) / k };
      m.render(true);
    }
    const centre = () => { const r = m.rendered; return [r.W / 2, r.mapH / 2]; };
    if (cfg.controls) {
      cfg.controls.zin.addEventListener('click', () => m.rendered && zoomAt(centre(), 2, 120));
      cfg.controls.zout.addEventListener('click', () => m.rendered && zoomAt(centre(), 0.5, 120));
      cfg.controls.fit.addEventListener('click', () => m.rendered && m.fit());
    }

    // Mouse wheel zooms at the pointer; double-click zooms in where enabled.
    svg.addEventListener('wheel', e => {
      if (!m.rendered) return;
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoomAt(m.svgPoint(e.clientX, e.clientY), Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    if (cfg.dblclickZoom) svg.addEventListener('dblclick', e => { if (m.rendered) { e.preventDefault(); zoomAt(m.svgPoint(e.clientX, e.clientY), 2, 120); } });

    // Pointer gestures: drag pans, two pointers pinch, a tap without movement calls onTap.
    // In 'twoFinger' mode touch pointers are left to the touch handlers below.
    function pinchStart() {
      const [a, b] = [...ptrs.values()];
      return { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s0: m.live.s, tx0: m.live.tx, ty0: m.live.ty };
    }
    function pinchMove(a, b, g) {
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [lo, hi] = scaleBounds();
      const s = Math.max(lo, Math.min(hi, g.s0 * d / g.d0));
      const fct = s / g.s0;
      setLive(s, mid[0] - fct * (g.m0[0] - g.tx0), mid[1] - fct * (g.m0[1] - g.ty0));
    }
    svg.addEventListener('pointerdown', e => {
      if (!m.rendered) return;
      if (e.pointerType === 'touch' && cfg.touch !== 'pointer') return;
      if (e.pointerType !== 'touch' && e.button !== 0) return;
      try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const p = m.svgPoint(e.clientX, e.clientY);
      ptrs.set(e.pointerId, p);
      clearTimeout(commitTimer);
      if (ptrs.size === 1) drag = { last: p, cx: e.clientX, cy: e.clientY, moved: false, multi: false };
      else if (ptrs.size === 2) { pinch = pinchStart(); if (drag) drag.multi = true; }
    });
    svg.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return;
      const p = m.svgPoint(e.clientX, e.clientY);
      ptrs.set(e.pointerId, p);
      if (pinch && ptrs.size >= 2) { const [a, b] = [...ptrs.values()]; pinchMove(a, b, pinch); return; }
      if (!drag) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < (e.pointerType === 'touch' ? 8 : 4)) return;
        drag.moved = true;
        svg.classList.add('dragging');
      }
      setLive(m.live.s, m.live.tx + p[0] - drag.last[0], m.live.ty + p[1] - drag.last[1]);
      drag.last = p;
    });
    const pointerEnd = e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (pinch && ptrs.size < 2) {
        pinch = null;
        if (ptrs.size === 1) { const p = [...ptrs.values()][0]; drag = { last: p, cx: 0, cy: 0, moved: true, multi: true }; }
      }
      if (ptrs.size === 0) {
        const tap = drag && !drag.moved && !drag.multi && e.type === 'pointerup';
        drag = null;
        svg.classList.remove('dragging');
        if (tap && cfg.onTap) cfg.onTap(m.toLatLon(m.svgPoint(e.clientX, e.clientY)));
        scheduleCommit(0);
      }
    };
    svg.addEventListener('pointerup', pointerEnd);
    svg.addEventListener('pointercancel', pointerEnd);

    // 'twoFinger' touch: two fingers pan and zoom; one finger keeps scrolling the page.
    if (cfg.touch === 'twoFinger') {
      const showHint = () => {
        if (!cfg.hint) return;
        cfg.hint.hidden = false;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => { cfg.hint.hidden = true; }, 1600);
      };
      const touchPts = t => [m.svgPoint(t[0].clientX, t[0].clientY), m.svgPoint(t[1].clientX, t[1].clientY)];
      svg.addEventListener('touchstart', e => {
        if (!m.rendered) return;
        if (e.touches.length >= 2) {
          e.preventDefault();
          clearTimeout(commitTimer);
          if (cfg.hint) cfg.hint.hidden = true;
          const [a, b] = touchPts(e.touches);
          pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s0: m.live.s, tx0: m.live.tx, ty0: m.live.ty };
          oneTouch = null;
        } else {
          oneTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, hinted: false };
        }
      }, { passive: false });
      svg.addEventListener('touchmove', e => {
        if (pinch && e.touches.length >= 2) {
          e.preventDefault();
          const [a, b] = touchPts(e.touches);
          pinchMove(a, b, pinch);
        } else if (oneTouch && e.touches.length === 1 && !oneTouch.hinted) {
          const t = e.touches[0];
          if (Math.hypot(t.clientX - oneTouch.x, t.clientY - oneTouch.y) > 12) { oneTouch.hinted = true; showHint(); }
        }
      }, { passive: false });
      const endTouch = e => {
        if (pinch && e.touches.length < 2) { pinch = null; scheduleCommit(0); }
        if (!e.touches.length) oneTouch = null;
      };
      svg.addEventListener('touchend', endTouch);
      svg.addEventListener('touchcancel', endTouch);
    }
    return m;
  }


  root.SarMap = { IMAGERY, imageryBlocked, mercator, unmercator, metresPerUnit, scaleBarSvg, createMap };
})(window);
