// Offline tests: every outside service is faked, so these run anywhere in seconds and check the app's own logic.
const { openApp, drawRoute, buildLinks, suite, OUT } = require('./lib');
const path = require('path');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/* Fake router: the "fastest route" is a straight line between whatever points it is given. */
/* Google's polyline format at 6 decimal places, which is what Valhalla answers with. */
function enc6(pts) {
  let out = '', pl = 0, pn = 0;
  const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of pts) { const a = Math.round(la * 1e6), b = Math.round(lo * 1e6); out += enc(a - pl) + enc(b - pn); pl = a; pn = b; }
  return out;
}
const valhallaQuery = u => JSON.parse(new URL(u).searchParams.get('json'));
const valhallaPts = u => valhallaQuery(u).locations.map(l => [l.lat, l.lon]);
/* Asked to keep off some spots, the fake second engine swings 400 m north between each pair of points. */
function aroundMarks(pts) { const out = [pts[0]]; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; out.push([a[0] + 0.0036, a[1] + (b[1] - a[1]) * 0.1], [b[0] + 0.0036, b[1] - (b[1] - a[1]) * 0.1], b); } return out; }
const valhallaAnswer = (route, pts) => json(route, { trip: { legs: [{ shape: enc6(pts) }], summary: { length: 1, time: 100 } } });
/* A second engine with different taste: on any leg longer than about 700 m it swings out onto "another road". */
function bulgingValhalla(route, u) {
  const pts = valhallaPts(u), out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], m = Math.hypot((b[0] - a[0]) * 110540, (b[1] - a[1]) * 81400);
    if (m > 700) out.push([(a[0] + b[0]) / 2 + 0.0015, (a[1] + b[1]) / 2]);
    out.push(b);
  }
  return valhallaAnswer(route, out);
}

function fakeServices({ osrm, valhalla } = {}) {
  return route => {
    const u = route.request().url();
    if (u.includes('tile.openstreetmap.org')) return route.fulfill({ body: PNG, contentType: 'image/png' });
    if (u.includes('router.project-osrm.org')) {
      if (osrm) return osrm(route, u);
      const pts = u.split('/driving/')[1].split('?')[0].split(';').map(s => s.split(',').map(Number));
      return json(route, { code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates: pts }, legs: [{ steps: [{ intersections: [] }] }] }] });
    }
    if (u.includes('valhalla')) {
      if (valhallaPts(u).length > 10) return json(route, { error_code: 150, error: 'Exceeded max locations: 10' }, 400); // the real public server's limit
      if (valhallaQuery(u).exclude_locations) return valhallaAnswer(route, aroundMarks(valhallaPts(u)));
      return valhalla ? valhalla(route, u) : valhallaAnswer(route, valhallaPts(u)); // by default the second engine agrees with the first
    }
    if (u.includes('nominatim')) return json(route, [{ display_name: 'Frame Park, Waukesha, Wisconsin, USA', lat: '43.018', lon: '-88.224' }]);
    return route.abort();
  };
}
const A = [43.0100, -88.2400], B = [43.0100, -88.2200], MID = [43.0160, -88.2300];

module.exports = async function offline(browser, url) {
  const S = suite('Offline (faked services)');

  await S.test('Page loads on a phone with no errors', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    t.check(await page.title() === 'Draw My Route', 'wrong page title');
    t.check((await page.textContent('#sheet h2')).includes('Where are you going?'), 'start screen not shown');
    t.check(await page.isVisible('#q-from') && await page.isVisible('#q-to'), 'From and To boxes are missing');
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    t.check(!over, 'page scrolls sideways on a phone');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Home-screen setup: manifest, icons and app title are present', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
    const info = await page.evaluate(async () => {
      const get = async h => (await fetch(h)).status;
      const m = await (await fetch('manifest.webmanifest')).json();
      return { name: m.name, display: m.display, icons: await Promise.all(m.icons.map(i => get(i.src))), touch: await get(document.querySelector('link[rel=apple-touch-icon]').href), capable: !!document.querySelector('meta[name=apple-mobile-web-app-capable]') };
    });
    t.check(info.name === 'Draw My Route' && info.display === 'standalone', 'manifest name or display mode is wrong');
    t.check(info.icons.every(s => s === 200) && info.touch === 200, 'an icon file is missing');
    t.check(info.capable, 'missing iPhone full-screen tag');
    await ctx.close();
  });

  await S.test('Tapping the map adds points and draws a route', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    await page.mouse.click(80, 200); await page.waitForTimeout(500);
    await page.mouse.click(300, 220); await page.waitForTimeout(700);
    const n = await page.evaluate(() => window.DMR.S.pts.length);
    t.check(n === 2, `expected 2 points after 2 taps, got ${n}`);
    t.check(await page.isEnabled('#b-build'), 'Make share links stayed disabled');
    t.check(await page.inputValue('#q-from') === 'Pin on map' && await page.inputValue('#q-to') === 'Pin on map', 'From and To boxes do not show the tapped pins');
    await page.click('#b-clear'); await page.waitForTimeout(300);
    t.check(await page.evaluate(() => window.DMR.S.pts.length) === 0 && await page.inputValue('#q-to') === '', 'Clear did not reset the route');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Fewest stops: straight route needs none; bent route gets a stop on the bend', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices(), level: 'few' });
    await drawRoute(page, [A, B]);
    let r = await buildLinks(page);
    t.check(r && r.stops.length === 0 && r.score >= 0.99, `straight route: ${r && r.stops.length} stops, score ${r && r.score}`);
    await page.click('#b-edit');
    await drawRoute(page, [A, MID, B]);
    r = await buildLinks(page);
    t.check(r.stops.length >= 1 && r.stops.length <= 2, `bent route: expected 1-2 stops, got ${r.stops.length}`);
    t.check(r.score >= 0.97, `bent route match only ${Math.round(r.score * 100)}%`);
    t.check(r.google[0].includes('waypoints=') && r.apple[0].includes('waypoint='), 'links are missing the stop');
    await page.screenshot({ path: path.join(OUT, 'offline-result.png') });
    await ctx.close();
  });

  await S.test('Second engine disagrees: extra stops are added until both engines follow the route', async t => {
    const one = await openApp(browser, url, { mock: fakeServices({ valhalla: bulgingValhalla }), level: 'few' });
    await drawRoute(one.page, [A, B]);
    const r1 = await buildLinks(one.page);
    t.check(r1.stops.length === 0 && r1.checked === 'one', `at the fewest-stops level expected 0 stops, got ${r1.stops.length}`);
    await one.ctx.close();
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ valhalla: bulgingValhalla }), level: 'balanced' });
    await drawRoute(page, [A, B]);
    const r = await buildLinks(page);
    t.note(`${r.stops.length} stops; first engine ${Math.round(r.score * 100)}%, second ${Math.round(r.score2 * 100)}%`);
    t.check(r.checked === 'two', 'second engine was not consulted');
    t.check(r.stops.length >= 1 && r.stops.length <= 6, `expected 1-6 stops, got ${r.stops.length}`);
    t.check(r.score >= 0.97 && r.score2 >= 0.97, 'stops did not bring both engines onto the route');
    t.check((await page.textContent('#sheet')).includes('two routing engines'), 'result does not say it was double-checked');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Second engine unavailable: links are still made and the user is told', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ valhalla: route => route.abort() }), level: 'balanced' });
    await drawRoute(page, [A, MID, B]);
    const r = await buildLinks(page);
    t.check(r && r.checked === 'failed', 'expected a result marked as single-engine');
    t.check(r.stops.length >= 1 && r.score >= 0.97, 'single-engine fallback did not produce a good result');
    t.check((await page.textContent('#sheet')).includes('one engine only'), 'result does not mention the missing double-check');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Three levels: fewest stops by default, more reliable means more stops, no stretch longer than the level allows, and the choice is remembered', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    const FAR = [43.0100, -88.1800]; // about 4.9 km east of A, in a straight line
    const metres = (a, b) => Math.hypot((b[0] - a[0]) * 110540, (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
    const levels = await page.evaluate(() => window.DMR.LEVELS);
    await drawRoute(page, [A, FAR]);
    let r = await buildLinks(page);
    const seen = {};
    const record = async key => {
      r = await page.evaluate(() => { const x = window.DMR.S.result; return { level: x.level, origin: x.origin, dest: x.dest, stops: x.stops, match: x.match }; });
      const pts = [r.origin, ...r.stops, r.dest], longest = Math.max(...pts.slice(1).map((p, i) => metres(pts[i], p)));
      seen[key] = { stops: r.stops.length, longest: Math.round(longest) };
      t.check(r.level === key, `expected level ${key}, got ${r.level}`);
      t.check(r.match >= 0.97, `${key}: match fell to ${Math.round(r.match * 100)}%`);
      if (levels[key].maxGap) t.check(longest <= levels[key].maxGap + 160, `${key}: a stretch of ${Math.round(longest)} m has no stop (limit ${levels[key].maxGap} m)`);
    };
    await record('few'); // the default: as few stops as possible
    for (const key of ['balanced', 'most']) {
      await page.click(`[data-level="${key}"]`);
      await page.waitForFunction(k => window.DMR.S.mode === 'result' && window.DMR.S.result.level === k, key, { timeout: 30000 });
      await record(key);
    }
    t.note(`stops: fewest ${seen.few.stops}, balanced ${seen.balanced.stops}, most reliable ${seen.most.stops}; longest stretch without a stop: ${seen.few.longest} / ${seen.balanced.longest} / ${seen.most.longest} m`);
    t.check(seen.few.stops === 0, 'fewest-stops level added stops to a route that needs none');
    t.check(seen.balanced.stops > seen.few.stops && seen.most.stops > seen.balanced.stops, 'stop counts do not rise with the level');
    await page.reload(); await page.waitForFunction(() => window.DMR);
    t.check(await page.evaluate(() => window.DMR.S.level) === 'most', 'choice was not remembered after reload');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Long route with many stops is still double-checked (second engine takes 10 points at a time)', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices(), level: 'most' });
    await drawRoute(page, [A, [43.0100, -88.1200]]); // about 9.8 km in a straight line
    const r = await buildLinks(page);
    t.note(`${r.stops.length} stops in ${r.parts.length} links`);
    t.check(r.stops.length > 10, `expected more than 10 stops, got ${r.stops.length}`);
    t.check(r.checked === 'two' && r.score2 >= 0.97, 'second engine dropped out on a long route (' + r.checked + ')');
    t.check(r.parts.length >= 2 && r.parts.every(p => p.w.length <= 9), 'links were not split correctly');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Links: long routes split into parts of at most 9 stops that chain together', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
    const out = await page.evaluate(() => {
      const D = window.DMR, stops = Array.from({ length: 25 }, (_, i) => [43 + i / 1000, -88]);
      const parts = D.splitParts([42.9, -88], [43.1, -88], stops);
      return { sizes: parts.map(p => p.w.length), chain: parts.every((p, i) => i === 0 || (p.o[0] === parts[i - 1].d[0] && p.o[1] === parts[i - 1].d[1])), last: parts[parts.length - 1].d, g: D.googleLink(parts[0], false, true), a: D.appleLink(parts[0], true, false), total: parts.reduce((n, p) => n + p.w.length, 0) + parts.length - 1 };
    });
    t.check(out.sizes.every(n => n <= 9), 'a part has more than 9 stops: ' + out.sizes);
    t.check(out.chain, 'a part does not start where the previous one ended');
    t.check(out.total === 25 && out.last[0] === 43.1, 'stops were lost or the destination changed when splitting');
    const g = new URL(out.g);
    t.check(g.searchParams.get('waypoints').split('|').length === 9 && g.searchParams.get('avoid') === 'highways' && g.searchParams.get('travelmode') === 'driving', 'Google link fields are wrong');
    const a = new URL(out.a);
    t.check(!a.searchParams.get('source') && a.searchParams.getAll('waypoint').length === 10, '"start from my location" Apple link is wrong');
    await ctx.close();
  });

  await S.test('Share link opens the viewer with the same route', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
    await drawRoute(page, [A, MID, B]);
    const r = await buildLinks(page);
    const v = await ctx.newPage(); const errs = []; v.on('pageerror', e => errs.push(e.message));
    await v.route(u => u.origin !== new URL(url).origin, fakeServices());
    await v.goto(r.share); await v.waitForFunction(() => window.DMR && window.DMR.S.mode === 'viewer');
    const got = await v.evaluate(() => ({ s: window.DMR.S.viewer.s, g: document.querySelector('a.btn.google').href }));
    t.check(JSON.stringify(got.s) === JSON.stringify(r.stops.map(s => s.map(x => +x.toFixed(6)))), 'viewer stops differ from the sender\'s');
    t.check(got.g === r.google[0], 'viewer Google link differs from the sender\'s');
    t.check(errs.length === 0, errs.join('; '));
    await ctx.close();
  });

  await S.test('Damaged share link shows a message instead of a blank page', async t => {
    const { ctx, page, errors } = await openApp(browser, url + '#r=not-a-real-link', { mock: fakeServices() });
    t.check((await page.textContent('#sheet h2')).length > 0, 'nothing shown');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('From and To boxes: searching sets the start and destination, in either order', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    await page.fill('#q-to', 'frame park'); await page.waitForSelector('#results button:not([disabled])'); await page.click('#results button');
    t.check(await page.evaluate(() => window.DMR.S.pts.length) === 0 && await page.inputValue('#q-to') === 'Frame Park', 'destination typed first was not remembered');
    await page.fill('#q-from', 'frame park'); await page.waitForSelector('#results button:not([disabled])'); await page.click('#results button');
    await page.waitForFunction(() => window.DMR.S.desired && !window.DMR.S.busy);
    const st = await page.evaluate(() => ({ n: window.DMR.S.pts.length, from: window.DMR.S.fromLabel, to: window.DMR.S.toLabel }));
    t.check(st.n === 2 && st.from === 'Frame Park' && st.to === 'Frame Park', 'start and destination were not both set: ' + JSON.stringify(st));
    t.check((await page.textContent('#sheet h2')).includes('Shape your route'), 'did not move on to shaping the route');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Starts from your current location when the browser allows it', async t => {
    const ctx = await browser.newContext({ ...require('playwright').devices['iPhone 13'], geolocation: { latitude: 43.0117, longitude: -88.2315 }, permissions: ['geolocation'] });
    const page = await ctx.newPage(); await page.route(u => u.origin !== new URL(url).origin, fakeServices());
    await page.goto(url);
    await page.waitForFunction(() => window.DMR && window.DMR.S.pts.length === 1, null, { timeout: 8000 });
    t.check(await page.inputValue('#q-from') === 'My location', 'From box does not say My location');
    await page.fill('#q-to', 'frame park'); await page.waitForSelector('#results button:not([disabled])'); await page.click('#results button');
    await page.waitForFunction(() => window.DMR.S.pts.length === 2 && window.DMR.S.desired);
    await ctx.close();
  });

  await S.test('Dragging the line with a mouse adds a pin where you let go and re-routes through it', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    await drawRoute(page, [A, B]); await page.waitForTimeout(600);
    const mid = await page.evaluate(([a, b]) => { const p = window.DMR.map.latLngToContainerPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); return [p.x, p.y]; }, [A, B]);
    await page.mouse.move(mid[0], mid[1]); await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(mid[0] + 2 * i, mid[1] - 12 * i, { steps: 2 });
    await page.mouse.up();
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && window.DMR.S.desired && !window.DMR.S.busy && window.DMR.S.desired.coords.length === 3, null, { timeout: 8000 });
    const out = await page.evaluate(() => { const D = window.DMR, p = D.map.latLngToContainerPoint(D.S.pts[1]); return { x: p.x, y: p.y, n: D.S.desired.coords.length, pins: document.querySelectorAll('.pin.mid').length }; });
    t.check(Math.abs(out.x - (mid[0] + 12)) < 6 && Math.abs(out.y - (mid[1] - 72)) < 6, `pin ended at ${Math.round(out.x)},${Math.round(out.y)}, expected ${mid[0] + 12},${mid[1] - 72}`);
    t.check(out.n === 3 && out.pins === 1, 'route was not re-drawn through the new pin');
    await page.waitForTimeout(500);
    t.check(await page.evaluate(() => window.DMR.S.pts.length) === 3, 'letting go also added a stray extra point');
    await page.screenshot({ path: path.join(OUT, 'offline-dragged.png') });
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Touch: press-and-hold then drag reshapes the line; a quick swipe across it just pans the map', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    await drawRoute(page, [A, B]); await page.waitForTimeout(600);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const midOf = () => page.evaluate(([a, b]) => { const p = window.DMR.map.latLngToContainerPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); return [Math.round(p.x), Math.round(p.y)]; }, [A, B]);
    // quick swipe: no hold
    let m = await midOf(); const c0 = await page.evaluate(() => window.DMR.map.getCenter().lng);
    await touch('touchStart', m[0], m[1]);
    for (let i = 1; i <= 5; i++) { await touch('touchMove', m[0] + 10 * i, m[1]); await page.waitForTimeout(16); }
    await touch('touchEnd'); await page.waitForTimeout(900);
    const afterSwipe = await page.evaluate(() => ({ n: window.DMR.S.pts.length, lng: window.DMR.map.getCenter().lng }));
    t.check(afterSwipe.n === 2, 'a quick swipe along the line changed the route');
    t.check(Math.abs(afterSwipe.lng - c0) > 1e-5, 'a quick swipe starting on the line did not pan the map');
    // press, hold, then pull
    m = await midOf();
    await touch('touchStart', m[0], m[1]); await page.waitForTimeout(380);
    for (let i = 1; i <= 5; i++) { await touch('touchMove', m[0], m[1] - 14 * i); await page.waitForTimeout(16); }
    await touch('touchEnd');
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && window.DMR.S.desired && !window.DMR.S.busy, null, { timeout: 8000 });
    const pin = await page.evaluate(() => { const D = window.DMR, p = D.map.latLngToContainerPoint(D.S.pts[1]); return [p.x, p.y]; });
    t.check(Math.abs(pin[0] - m[0]) < 8 && Math.abs(pin[1] - (m[1] - 70)) < 8, `pin ended at ${Math.round(pin[0])},${Math.round(pin[1])}, expected ${m[0]},${m[1] - 70}`);
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Avoid a road: marking a road on the route moves the route off it, and the links keep off it too', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    await drawRoute(page, [A, B]); await page.waitForTimeout(500);
    await page.click('#b-avoid');
    t.check((await page.textContent('#sheet h2')).includes('Tap a road to avoid'), 'avoid mode did not open');
    const mid = await page.evaluate(([a, b]) => { window.DMR.fitRoute(window.DMR.S.desired.coords); const p = window.DMR.map.latLngToContainerPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); return [p.x, p.y]; }, [A, B]);
    await page.waitForTimeout(500); await page.mouse.click(mid[0], mid[1]);
    await page.waitForFunction(() => window.DMR.S.zones.length === 1 && window.DMR.S.desired && !window.DMR.S.busy && window.DMR.S.desired.coords.length > 2, null, { timeout: 8000 });
    const st = await page.evaluate(() => { const D = window.DMR, z = D.S.zones[0]; return { pts: D.S.pts.length, nearest: Math.min(...D.S.desired.coords.map(c => Math.hypot((c[0] - z[0]) * 110540, (c[1] - z[1]) * 81400))) }; });
    t.check(st.pts === 2, 'marking a road added a route point');
    t.check(st.nearest > 150, `route still passes ${Math.round(st.nearest)} m from the marked road`);
    await page.click('#b-avoid');
    const r = await buildLinks(page);
    t.note(`${r.stops.length} stop(s); "${r.heading}"`);
    t.check(r && r.avoidOnly && r.crossed === 0 && r.stops.length >= 1, 'links do not keep the driver off the marked road');
    await page.screenshot({ path: path.join(OUT, 'offline-avoid.png') });
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('A note added when sharing is shown to the person who opens the link', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
    await drawRoute(page, [A, MID, B]); await buildLinks(page);
    await page.fill('#f-note', 'Go this way <b>the bridge on Main is closed</b>');
    const link = await page.evaluate(() => window.DMR.shareLink());
    const v = await ctx.newPage(); await v.route(u => u.origin !== new URL(url).origin, fakeServices());
    await v.goto(link); await v.waitForFunction(() => window.DMR && window.DMR.S.mode === 'viewer');
    t.check((await v.textContent('.note')) === 'Go this way <b>the bridge on Main is closed</b>', 'note missing or altered in the viewer');
    t.check(await v.locator('.note b').count() === 0, 'note text was treated as HTML');
    await ctx.close();
  });

  await S.test('Routing service down: user gets a clear message and can keep working', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ osrm: route => route.abort() }) });
    await page.evaluate(([a, b]) => { const D = window.DMR; D.S.pts.push(a, b); D.changed(); }, [A, B]);
    await page.waitForSelector('#toast:not([hidden])', { timeout: 8000 });
    const msg = await page.textContent('#toast');
    t.note('message shown: "' + msg + '"');
    t.check(!/failed to fetch|typeerror|undefined/i.test(msg), 'the message is a raw technical error: "' + msg + '"');
    t.check(await page.evaluate(() => window.DMR.S.busy === 0), 'app is stuck on "Fitting your route"');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Routing service returns an error page: handled without breaking', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ osrm: route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }) }) });
    await page.evaluate(([a, b]) => { const D = window.DMR; D.S.pts.push(a, b); D.changed(); }, [A, B]);
    await page.waitForSelector('#toast:not([hidden])', { timeout: 8000 });
    const msg = await page.textContent('#toast');
    t.note('message shown: "' + msg + '"');
    t.check(!/unexpected token|json|syntaxerror/i.test(msg), 'the message is a raw technical error: "' + msg + '"');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Routing service keeps saying "too busy": app gives up instead of retrying forever', async t => {
    let n = 0;
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices({ osrm: route => { n++; return route.fulfill({ status: 429, body: 'Too Many Requests' }); } }) });
    await page.evaluate(([a, b]) => { const D = window.DMR; D.S.pts.push(a, b); D.changed(); }, [A, B]);
    await page.waitForTimeout(14000);
    const busy = await page.evaluate(() => window.DMR.S.busy);
    t.note(`${n} attempts in 14 seconds`);
    t.check(busy === 0, `still retrying after 14 seconds (${n} attempts) with no message to the user`);
    await ctx.close();
  });

  await S.test('Route that fails while making links returns to drawing with the line intact', async t => {
    let fail = false;
    const base = fakeServices();
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ osrm: (route, u) => fail ? route.abort() : (() => { const pts = u.split('/driving/')[1].split('?')[0].split(';').map(s => s.split(',').map(Number)); return json(route, { code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates: pts }, legs: [{ steps: [{ intersections: [] }] }] }] }); })() }) });
    await drawRoute(page, [A, MID, B]); fail = true;
    const r = await buildLinks(page);
    t.check(r === null, 'expected no result when the router fails');
    t.check(await page.evaluate(() => window.DMR.S.mode === 'draw' && window.DMR.S.pts.length === 3), 'points were lost after the failure');
    t.check(await page.isVisible('#b-build'), 'draw sheet did not come back');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  return S;
};
