/* Draw My Route: local road network.
   Downloads the roads around a trip from OpenStreetMap (Overpass) and routes on them inside the browser.
   This is what lets the line follow a finger instantly while dragging: no server round trip per redraw.
   The routing servers still decide the final line; this is the fast preview, tuned to agree with them where it can. */
(function () {
  'use strict';

  const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  const DRIVABLE = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service';
  /* Road size classes: 0 freeway, 1 trunk, 2 primary, 3 secondary, 4 tertiary, 5 local street, 6 service lane. Ramps and slip roads add 10. */
  const CLASS = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 5, living_street: 6, service: 6 };
  /* Default speeds in km/h, close to the routing server's car profile so previews usually agree with it. */
  const KMH = { 0: 90, 1: 85, 2: 65, 3: 55, 4: 40, 5: 25, 6: 15, 10: 45, 11: 40, 12: 30, 13: 25, 14: 20 };
  const VMAX = 38; // m/s, faster than any road here: keeps the search heuristic honest

  function query(box) { // box = [south, west, north, east]
    const b = box.map(v => v.toFixed(5)).join(',');
    return `[out:json][timeout:25];way["highway"~"^(${DRIVABLE})$"]["service"!~"parking_aisle|driveway"]["access"!~"^(private|no)$"]["area"!="yes"](${b});out tags geom qt;`;
  }

  /* Fetch the drivable roads in a box. Tries each server in turn; rejects if none answers. */
  async function fetchRoads(box, signal) {
    let lastErr = new Error('no road server');
    for (const url of ENDPOINTS) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query(box)), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        if (!r.ok) throw new Error('road server answered ' + r.status);
        const j = await r.json();
        if (!j || !Array.isArray(j.elements)) throw new Error('road server sent something unexpected');
        return j.elements;
      } catch (e) { lastErr = e; if (signal && signal.aborted) throw e; }
      finally { clearTimeout(timer); }
    }
    throw lastErr;
  }

  function speedOf(tags, cls) {
    const m = /^(\d+(?:\.\d+)?)\s*(mph)?/.exec(tags.maxspeed || '');
    if (m) { const kmh = parseFloat(m[1]) * (m[2] ? 1.609344 : 1); if (kmh >= 5 && kmh <= 150) return kmh * 0.8 / 3.6; } // drivers average under the limit
    return (KMH[cls] || 25) / 3.6;
  }

  /* Turn the downloaded ways into a routable network. ref = [lat, lon] used as the origin of a flat metre grid. */
  function buildNet(elements, ref) {
    const KX = 111320 * Math.cos(ref[0] * Math.PI / 180), KY = 110540;
    const toXY = ll => [(ll[1] - ref[1]) * KX, -(ll[0] - ref[0]) * KY], toLL = p => [ref[0] - p[1] / KY, ref[1] + p[0] / KX];
    const ways = elements.filter(w => w.type === 'way' && w.tags && w.nodes && w.geometry && w.nodes.length === w.geometry.length && w.nodes.length > 1 && w.tags.highway);
    // A point becomes a junction if two ways share it, or it is the end of a way.
    const uses = new Map();
    for (const w of ways) w.nodes.forEach((id, i) => uses.set(id, (uses.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
    const N = [], nodeOf = new Map(), E = [], names = [''], nameIdx = new Map([['', 0]]);
    const node = (id, g) => { let n = nodeOf.get(id); if (n === undefined) { n = N.length; nodeOf.set(id, n); const p = toXY([g.lat, g.lon]); N.push({ x: p[0], y: p[1], out: [] }); } return n; };
    for (const w of ways) {
      const t = w.tags, base = t.highway.replace(/_link$/, ''), link = base !== t.highway;
      if (!(base in CLASS)) continue;
      const cls = CLASS[base] + (link ? 10 : 0), v = speedOf(t, cls);
      let one = 0;
      if (t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true') one = 1;
      else if (t.oneway === '-1' || t.oneway === 'reverse') one = -1;
      else if (t.oneway !== 'no' && (base === 'motorway' || t.junction === 'roundabout' || t.junction === 'circular')) one = 1;
      const label = t.name || t.ref || '';
      let ni = nameIdx.get(label); if (ni === undefined) { ni = names.length; names.push(label); nameIdx.set(label, ni); }
      let start = 0;
      for (let i = 1; i < w.nodes.length; i++) {
        if (uses.get(w.nodes[i]) < 2 && i < w.nodes.length - 1) continue;
        const a = node(w.nodes[start], w.geometry[start]), b = node(w.nodes[i], w.geometry[i]);
        const g = []; for (let k = start; k <= i; k++) g.push(toXY([w.geometry[k].lat, w.geometry[k].lon]));
        const cum = [0]; for (let k = 1; k < g.length; k++) cum.push(cum[k - 1] + Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]));
        if (a !== b && cum[cum.length - 1] > 0.5) E.push({ a, b, one, v, g, cum, len: cum[cum.length - 1], cls, name: ni });
        start = i;
      }
    }
    E.forEach((e, i) => { e.id = i; });
    const tag = {}; // identifies this network, so snap results cached on points are never reused with another one
    const hs = new Float64Array(E.length * 2), he = new Float64Array(E.length * 2), H = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
    E.forEach((e, id) => {
      if (e.one !== -1) N[e.a].out.push(2 * id);
      if (e.one !== 1) N[e.b].out.push(2 * id + 1);
      const g = e.g, n = g.length; hs[2 * id] = H(g[0], g[1]); he[2 * id] = H(g[n - 2], g[n - 1]); hs[2 * id + 1] = H(g[n - 1], g[n - 2]); he[2 * id + 1] = H(g[1], g[0]);
    });
    const arcTo = k => k & 1 ? E[k >> 1].a : E[k >> 1].b;
    const turn = (k1, k2) => { if ((k1 >> 1) === (k2 >> 1)) return 20; let d = (hs[k2] - he[k1]) * 180 / Math.PI; d = ((d + 540) % 360) - 180; const a = Math.abs(d); return a < 30 ? 0 : a < 140 ? (d > 0 ? 3 : 6) : 8; };

    // Grid of road segments, for "which road is near this point?"
    const SC = 80, SG = new Map();
    E.forEach((e, id) => { for (let s = 0; s < e.g.length - 1; s++) { const a = e.g[s], b = e.g[s + 1];
      for (let i = Math.floor(Math.min(a[0], b[0]) / SC); i <= Math.floor(Math.max(a[0], b[0]) / SC); i++) for (let j = Math.floor(Math.min(a[1], b[1]) / SC); j <= Math.floor(Math.max(a[1], b[1]) / SC); j++) { const k = i + ',' + j; let L = SG.get(k); if (!L) SG.set(k, L = []); L.push(id, s); } } });
    /* Nearest road to p (metres) among edges accepted by `ok`, within `reach` metres. */
    function nearest(p, reach, ok) {
      let best = null; const ci = Math.floor(p[0] / SC), cj = Math.floor(p[1] / SC), R = Math.ceil(reach / SC);
      for (let ring = 0; ring <= R; ring++) {
        if (best && best.d <= (ring - 1) * SC) break; // nothing in a farther ring can beat it
        for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          const L = SG.get(i + ',' + j); if (!L) continue;
          for (let q = 0; q < L.length; q += 2) { const id = L[q], s = L[q + 1], e = E[id]; if (ok && !ok(e)) continue;
            const a = e.g[s], b = e.g[s + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
            let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
            const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(p[0] - x, p[1] - y);
            if (d <= reach && (!best || d < best.d)) best = { d, e: id, pos: e.cum[s] + t * (e.cum[s + 1] - e.cum[s]), xy: [x, y] }; }
        }
      }
      return best;
    }

    function slice(e, p0, p1) { const g = e.g, c = e.cum, out = [];
      const at = p => { let i = 0; while (i < c.length - 2 && c[i + 1] < p) i++; const t = (p - c[i]) / ((c[i + 1] - c[i]) || 1); return [g[i][0] + t * (g[i + 1][0] - g[i][0]), g[i][1] + t * (g[i + 1][1] - g[i][1])]; };
      out.push(at(p0)); if (p1 >= p0) { for (let i = 0; i < c.length; i++) if (c[i] > p0 && c[i] < p1) out.push(g[i]); } else { for (let i = c.length - 1; i >= 0; i--) if (c[i] < p0 && c[i] > p1) out.push(g[i]); } out.push(at(p1)); return out; }
    const arcPts = k => { const e = E[k >> 1]; return k & 1 ? e.g.slice().reverse() : e.g; };

    // Search state is reused between searches (a stamp marks which entries belong to the current one), so a redraw allocates almost nothing.
    const n2 = E.length * 2, dist = new Float64Array(n2), prev = new Int32Array(n2), stamp = new Int32Array(n2); let gen = 0;
    const hk = [], hv = [];
    const push = (k, v) => { let i = hk.length; hk.push(k); hv.push(v); while (i > 0) { const p = (i - 1) >> 1; if (hv[p] <= v) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
    const pop = () => { const rk = hk[0], lk = hk.pop(), lv = hv.pop(), n = hk.length; if (n) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i, mv = lv; if (l < n && hv[l] < mv) { m = l; mv = hv[l]; } if (r < n && hv[r] < mv) m = r; if (m === i) break; hk[i] = hk[m]; hv[i] = hv[m]; i = m; } hk[i] = lk; hv[i] = lv; } return rk; };

    /* Fastest way from snapped point S to snapped point T (A* over road directions, with turn costs). */
    function leg(S, T, prevArc, blocked) {
      const eS = E[S.e], eT = E[T.e], fwdS = eS.one !== -1, bwdS = eS.one !== 1, fwdT = eT.one !== -1, bwdT = eT.one !== 1;
      const uturn = a => prevArc >= 0 && (prevArc >> 1) === (a >> 1) && prevArc !== a ? 600 : 0;
      const tx = T.xy[0], ty = T.xy[1], h = n => Math.hypot(N[n].x - tx, N[n].y - ty) / VMAX;
      let best = { c: Infinity, arc: -2, last: -1 };
      if (S.e === T.e) { if (T.pos >= S.pos && fwdS) best = { c: (T.pos - S.pos) / eS.v + uturn(2 * S.e), arc: -1, last: 2 * S.e };
        else if (T.pos < S.pos && bwdS) best = { c: (S.pos - T.pos) / eS.v + uturn(2 * S.e + 1), arc: -1, last: 2 * S.e + 1 }; }
      gen++; hk.length = 0; hv.length = 0;
      const seed = (k, c) => { stamp[k] = gen; dist[k] = c; prev[k] = -1; push(k, c + h(arcTo(k))); };
      if (fwdS) seed(2 * S.e, (eS.len - S.pos) / eS.v + uturn(2 * S.e));
      if (bwdS) seed(2 * S.e + 1, S.pos / eS.v + uturn(2 * S.e + 1));
      while (hk.length) {
        const f = hv[0], k = pop(), d = dist[k]; if (f >= best.c) break; const n = arcTo(k);
        if (f > d + h(n) + 1e-9) continue; // stale heap entry
        if (n === eT.a && fwdT) { const c = d + turn(k, 2 * T.e) + T.pos / eT.v; if (c < best.c) best = { c, arc: k, last: 2 * T.e }; }
        if (n === eT.b && bwdT) { const c = d + turn(k, 2 * T.e + 1) + (eT.len - T.pos) / eT.v; if (c < best.c) best = { c, arc: k, last: 2 * T.e + 1 }; }
        const out = N[n].out;
        for (let q = 0; q < out.length; q++) { const k2 = out[q], e = E[k2 >> 1]; if (blocked && blocked.has(k2 >> 1)) continue;
          const c = d + e.len / e.v + turn(k, k2); if (stamp[k2] !== gen || c < dist[k2]) { stamp[k2] = gen; dist[k2] = c; prev[k2] = k; push(k2, c + h(arcTo(k2))); } }
      }
      if (best.arc === -2) return null;
      let pts;
      if (best.arc === -1) pts = slice(eS, S.pos, T.pos);
      else { const arcs = []; for (let a = best.arc; a >= 0; a = prev[a]) arcs.unshift(a);
        pts = arcs[0] & 1 ? slice(eS, S.pos, 0) : slice(eS, S.pos, eS.len);
        for (let i = 1; i < arcs.length; i++) { const g = arcPts(arcs[i]); for (let q = 1; q < g.length; q++) pts.push(g[q]); }
        const tail = best.last & 1 ? slice(eT, eT.len, T.pos) : slice(eT, 0, T.pos); for (let q = 1; q < tail.length; q++) pts.push(tail[q]); }
      return { pts, time: best.c, last: best.last };
    }

    /* Route through a list of [lat, lon] points. Returns null if any point is off the network or unreachable.
       cache (optional Map) remembers legs between the same pair of points, so dragging one pin only recomputes its two legs. */
    function route(ptsLL, opt) {
      const blocked = opt && opt.blocked, cache = opt && opt.cache;
      const S = ptsLL.map(ll => { if (ll._sn && ll._sn.net === tag) return ll._sn.s;
        const s = (blocked && nearest(toXY(ll), 800, e => !blocked.has(e.id))) || nearest(toXY(ll), 800, null);
        ll._sn = { net: tag, s }; return s; });
      if (S.some(s => !s)) return null;
      let all = [], time = 0, prevArc = -1;
      for (let i = 1; i < S.length; i++) {
        const key = cache ? S[i - 1].e + ':' + S[i - 1].pos.toFixed(1) + '>' + S[i].e + ':' + S[i].pos.toFixed(1) + '|' + prevArc : null;
        let r = key ? cache.get(key) : undefined;
        if (r === undefined) { r = leg(S[i - 1], S[i], prevArc, blocked); if (key) cache.set(key, r); }
        if (!r) return null;
        if (all.length) { for (let q = 1; q < r.pts.length; q++) all.push(r.pts[q]); } else all = r.pts.slice();
        time += r.time; prevArc = r.last;
      }
      let d = 0; for (let i = 1; i < all.length; i++) d += Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]);
      return { coords: all.map(toLL), distance: d, duration: time };
    }

    /* Where a dropped pin should land: nearest road, with a head start for larger roads (see SNAP_TIERS in app.js). */
    /* Freeways count as main roads: dragging the line onto one means "take it". Ramps and slip roads (class 10 and up) never do. */
    const TIER_OK = { main: e => e.cls <= 2, medium: e => e.cls <= 4, any: null };
    /* The nearest point on every road piece within `reach` metres of p that `ok` accepts, nearest first. */
    function nearestEach(p, reach, ok) {
      const best = new Map(), ci = Math.floor(p[0] / SC), cj = Math.floor(p[1] / SC), R = Math.ceil(reach / SC);
      for (let i = ci - R; i <= ci + R; i++) for (let j = cj - R; j <= cj + R; j++) {
        const L = SG.get(i + ',' + j); if (!L) continue;
        for (let q = 0; q < L.length; q += 2) { const id = L[q], s = L[q + 1], e = E[id]; if (ok && !ok(e)) continue;
          const a = e.g[s], b = e.g[s + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
          let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(p[0] - x, p[1] - y);
          // one hit per road and direction of travel, so several pieces of one carriageway count once
          const key = e.name + '|' + (e.one === 0 ? 'both' : Math.round((Math.atan2(dy, dx) * (e.one === -1 ? -1 : 1) + (e.one === -1 ? Math.PI : 0)) / (Math.PI / 2)) & 3);
          const had = best.get(key); if (d <= reach && (!had || d < had.d)) best.set(key, { d, e: id, xy: [x, y] }); }
      }
      return [...best.values()].sort((a, b) => a.d - b.d);
    }
    /* Where a dropped pin should land: nearest road, with a head start for larger roads (see SNAP_TIERS in app.js).
       `choices` are the other roads of that size right there (within SIDE metres more than the nearest): the two
       directions of a freeway, a road crossing it. The app picks among them the one the route flows through. */
    const SIDE = 120, CHOICES = 8;
    function snap(ll, tiers, mpp, k) {
      const p = toXY(ll); let best = null;
      for (const t of tiers) {
        const reach = t.filter ? Math.min(t.reach * k * mpp, 600) : 600, hit = nearest(p, reach, TIER_OK[t.name]); if (!hit) continue;
        const score = hit.d / mpp - t.head * k; if (!best || score < best.score) best = { score, ll: toLL(hit.xy), name: names[E[hit.e].name], tier: t.name, d: hit.d };
      }
      if (best && best.tier !== 'any') best.choices = nearestEach(p, best.d + Math.min(500, Math.max(SIDE, 30 * k * mpp)), TIER_OK[best.tier]).slice(0, CHOICES).map(h => ({ ll: toLL(h.xy), name: names[E[h.e].name], d: h.d, freeway: E[h.e].cls === 0 }));
      return best;
    }
    /* Road stretches within `radius` metres of any of the given points: used to keep previews off roads marked to avoid. */
    function edgesNear(points, radius) { const set = new Set(); const R = Math.ceil(radius / SC);
      for (const ll of points) { const p = toXY(ll), ci = Math.floor(p[0] / SC), cj = Math.floor(p[1] / SC);
        for (let i = ci - R; i <= ci + R; i++) for (let j = cj - R; j <= cj + R; j++) { const L = SG.get(i + ',' + j); if (!L) continue;
          for (let q = 0; q < L.length; q += 2) { const e = E[L[q]], s = L[q + 1], a = e.g[s], b = e.g[s + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
            let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
            if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= radius) set.add(L[q]); } } }
      return set; }

    return { route, snap, edgesNear, nodes: N.length, edges: E.length };
  }

  window.DMRRoads = { fetchRoads, buildNet, query };
})();
