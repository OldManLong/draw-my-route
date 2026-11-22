// Shared helpers for the test suites.
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path');

const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

async function launch() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  // Keep requests to the private local server off the proxy.
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  return chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {});
}

/* Opens the site on an emulated iPhone and collects every error the page raises. */
async function openApp(browser, url, { mock } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: [] });
  const page = await ctx.newPage();
  const errors = [], calls = { osrm: 0, valhalla: 0, nominatim: 0, tiles: 0 };
  page.on('pageerror', e => errors.push('page error: ' + e.message));
  page.on('request', r => {
    const u = r.url();
    if (u.includes('router.project-osrm.org')) calls.osrm++;
    else if (u.includes('valhalla')) calls.valhalla++;
    else if (u.includes('nominatim')) calls.nominatim++;
    else if (u.includes('tile.openstreetmap.org')) calls.tiles++;
  });
  if (mock) await page.route(u => u.origin !== new URL(url).origin, mock);
  await page.goto(url);
  await page.waitForFunction(() => window.DMR && document.querySelector('#sheet h2'));
  return { ctx, page, errors, calls };
}

/* Puts route points (and optional stay-off marks) on the map, exactly as tapping would, and waits for the road-fitted line. */
async function drawRoute(page, pts, zones = []) {
  await page.evaluate(([pts, zones]) => {
    const D = window.DMR;
    D.S.pts.length = 0; pts.forEach(p => D.S.pts.push(p));
    D.S.zones.length = 0; zones.forEach(z => D.S.zones.push(z));
    D.S.desired = null; D.changed();
  }, [pts, zones]);
  await page.waitForFunction(() => window.DMR.S.desired && !window.DMR.S.busy, null, { timeout: 60000 });
  return page.evaluate(() => { const d = window.DMR.S.desired; return { coords: d.coords, distance: d.distance, duration: d.duration, hwy: d.hwy }; });
}

/* Presses "Make share links" and returns what the app decided. */
async function buildLinks(page, timeout = 240000) {
  await page.click('#b-build');
  await page.waitForFunction(() => window.DMR.S.mode === 'result' || window.DMR.S.mode === 'draw', null, { timeout });
  return page.evaluate(() => {
    const D = window.DMR, r = D.S.result;
    if (!r) return null;
    const parts = D.splitParts(r.origin, r.dest, r.stops);
    return {
      origin: r.origin, dest: r.dest, stops: r.stops, score: r.score, avoid: r.avoid, avoidOnly: r.avoidOnly, crossed: r.crossed, zones: r.zones, blocked: r.blocked,
      predicted: r.cand.coords, parts,
      google: parts.map(p => D.googleLink(p, false, r.avoid)), apple: parts.map(p => D.appleLink(p, false, r.avoid)),
      share: D.shareLink(), heading: document.querySelector('#sheet h2').textContent,
    };
  });
}

/* ---- Independent geometry (deliberately not the app's own code, so it can catch the app's mistakes) ---- */
const R = 6371000, rad = Math.PI / 180;
function toXY(ll, ref) { return [(ll[1] - ref[1]) * rad * R * Math.cos(ref[0] * rad), (ll[0] - ref[0]) * rad * R]; }
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distToPath(p, path) { let best = Infinity; for (let i = 0; i < path.length - 1; i++) { const d = segDist(p, path[i], path[i + 1]); if (d < best) best = d; } return best; }
function densify(path, step) {
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
/* Share of each line that lies within `tol` metres of the other; the lower of the two is the match. */
function matchScore(aLL, bLL, tol = 25) {
  const ref = aLL[0], A = aLL.map(p => toXY(p, ref)), B = bLL.map(p => toXY(p, ref));
  const cover = (X, Y) => { const d = densify(X, 15); return d.filter(p => distToPath(p, Y) <= tol).length / d.length; };
  return Math.min(cover(A, B), cover(B, A));
}
function distToRouteM(ll, routeLL) { const ref = routeLL[0]; return distToPath(toXY(ll, ref), routeLL.map(p => toXY(p, ref))); }
function alongRoute(ll, routeLL) {
  const ref = routeLL[0], P = toXY(ll, ref), X = routeLL.map(p => toXY(p, ref)); let best = Infinity, at = 0, run = 0;
  for (let i = 0; i < X.length - 1; i++) { const d = segDist(P, X[i], X[i + 1]); if (d < best) { best = d; at = run; } run += Math.hypot(X[i + 1][0] - X[i][0], X[i + 1][1] - X[i][1]); }
  return at;
}

/* A second router (Valhalla, normal driving settings) asked from inside the page, as a stand-in for "a maps app that is not OSRM". */
async function secondOpinion(page, pts, avoidHighways) {
  await new Promise(r => setTimeout(r, 1200)); // be polite to the free server
  return page.evaluate(async ([pts, avoid]) => {
    const dec6 = s => { const out = []; let i = 0, la = 0, lo = 0; const d = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; }; while (i < s.length) { la += d(); lo += d(); out.push([la / 1e6, lo / 1e6]); } return out; };
    const q = { locations: pts.map(p => ({ lat: p[0], lon: p[1], type: 'break' })), costing: 'auto', ...(avoid ? { costing_options: { auto: { use_highways: 0 } } } : {}) };
    const r = await fetch('https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(q)));
    const j = await r.json(); if (!j.trip) return null;
    let coords = []; j.trip.legs.forEach(l => { const c = dec6(l.shape); coords = coords.length ? coords.concat(c.slice(1)) : c; });
    return coords;
  }, [pts, avoidHighways]);
}

/* Tiny test runner. */
function suite(name) {
  const results = [];
  return {
    name, results,
    async test(title, fn) {
      const t0 = Date.now(); const rec = { title, status: 'pass', notes: [], ms: 0 };
      const ctx = { note: s => rec.notes.push(s), warn: s => { rec.notes.push('WARN ' + s); if (rec.status === 'pass') rec.status = 'warn'; }, check: (cond, msg) => { if (!cond) throw new Error(msg); } };
      try { await fn(ctx); } catch (e) { rec.status = 'fail'; rec.notes.push('FAIL ' + (e.message || e).split('\n')[0]); }
      rec.ms = Date.now() - t0; results.push(rec);
      console.log(`${rec.status === 'pass' ? '  ok  ' : rec.status === 'warn' ? ' WARN ' : ' FAIL '} ${title} (${(rec.ms / 1000).toFixed(1)}s)`);
      rec.notes.forEach(n => console.log('        ' + n));
    },
  };
}

module.exports = { OUT, launch, openApp, drawRoute, buildLinks, matchScore, distToRouteM, alongRoute, secondOpinion, suite };
