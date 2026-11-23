// Offline tests: every outside service is faked, so these run anywhere in seconds and check the app's own logic.
const { openApp, drawRoute, buildLinks, suite, OUT } = require('./lib');
const { waukeshaOverpass } = require('./fixture');
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

/* "Which road is near here?" By default only the spot itself. With bigRoadLocate there is also a main road running
   east-west along latitude 43.0130, and the nearest small street is 11 m south of wherever you ask. */
const BIG_ROAD_LAT = 43.0130;
const edge = (lat, lon, metres, cls, name) => ({ correlated_lat: lat, correlated_lon: lon, distance: metres, edge: { classification: { classification: cls } }, edge_info: { names: name ? [name] : [] } });
function plainLocate(route, u) { return json(route, valhallaQuery(u).locations.map(l => ({ edges: l.search_filter ? [] : [edge(l.lat, l.lon, 0, 'residential', '')] }))); }
function bigRoadLocate(route, u) {
  return json(route, valhallaQuery(u).locations.map(l => ({ edges: [l.search_filter
    ? edge(BIG_ROAD_LAT, l.lon, Math.abs(l.lat - BIG_ROAD_LAT) * 110540, l.search_filter.min_road_class, 'Big Road')
    : edge(l.lat - 0.0001, l.lon, 11, 'residential', 'Side Street')] })));
}

/* Road-data service stand-ins. Real Waukesha roads from the fixture; by default (no `roads` option) the service is unreachable. */
const WAUKESHA = JSON.stringify(waukeshaOverpass());
const waukeshaRoads = route => route.fulfill({ contentType: 'application/json', body: WAUKESHA });
const W = { library: [43.0086229, -88.2328702], airport: [43.0396037, -88.2348839], hospital: [43.0114004, -88.2430759] };

/* Place search and address lookup stand-ins (OpenStreetMap's Nominatim). */
const FRAME_PARK = { name: 'Frame Park', category: 'leisure', display_name: 'Frame Park, 1150, Baxter Street, Waukesha, Waukesha County, Wisconsin, 53186, United States', lat: '43.018', lon: '-88.224', address: { house_number: '1150', road: 'Baxter Street', city: 'Waukesha', state: 'Wisconsin', postcode: '53186' } };
const houseAt = u => { const q = new URL(u).searchParams; return { lat: q.get('lat'), lon: q.get('lon'), category: 'building', name: '', address: { house_number: '101', road: 'West Main Street', city: 'Waukesha', state: 'Wisconsin', postcode: '53186' } }; };
const bareRoadAt = u => { const q = new URL(u).searchParams; return { lat: q.get('lat'), lon: q.get('lon'), category: 'highway', name: 'County Road F', address: { road: 'County Road F', city: 'Waukesha', state: 'Wisconsin' } }; };

function fakeServices({ osrm, valhalla, locate, roads, reverse } = {}) {
  return route => {
    const u = route.request().url();
    if (u.includes('tile.openstreetmap.org')) return route.fulfill({ body: PNG, contentType: 'image/png' });
    if (u.includes('router.project-osrm.org')) {
      if (osrm) return osrm(route, u);
      const pts = u.split('/driving/')[1].split('?')[0].split(';').map(s => s.split(',').map(Number));
      return json(route, { code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates: pts }, legs: [{ steps: [{ intersections: [] }] }] }] });
    }
    if (u.includes('overpass')) return roads ? roads(route, u) : route.abort();
    if (u.includes('valhalla') && u.includes('/locate')) return (locate || plainLocate)(route, u);
    if (u.includes('valhalla')) {
      if (valhallaPts(u).length > 10) return json(route, { error_code: 150, error: 'Exceeded max locations: 10' }, 400); // the real public server's limit
      if (valhallaQuery(u).exclude_locations) return valhallaAnswer(route, aroundMarks(valhallaPts(u)));
      return valhalla ? valhalla(route, u) : valhallaAnswer(route, valhallaPts(u)); // by default the second engine agrees with the first
    }
    if (u.includes('nominatim') && u.includes('/reverse')) return json(route, reverse ? reverse(u) : { error: 'Unable to geocode' }); // by default: no address known
    if (u.includes('nominatim')) return json(route, [FRAME_PARK]);
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
    // Stops go out as bare GPS coordinates, never as a name or address, so nobody mistakes one for the destination.
    const coord = /^-?\d{1,3}\.\d{6},-?\d{1,3}\.\d{6}$/;
    const gStops = new URL(r.google[0]).searchParams.get('waypoints').split('|'), aStops = new URL(r.apple[0]).searchParams.getAll('waypoint');
    t.check(gStops.length === r.stops.length && gStops.every(w => coord.test(w)), 'a Google stop is not a plain coordinate pair: ' + gStops.join(' | '));
    t.check(aStops.length === r.stops.length && aStops.every(w => coord.test(w)), 'an Apple stop is not a plain coordinate pair: ' + aStops.join(' | '));
    t.check((await page.textContent('#sheet')).includes('sent as map coordinates'), 'result screen does not explain that stops are coordinates');
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

  await S.test('Security: a tampered share link is refused, and text in a link is never run as code', async t => {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const good = { v: 1, o: [43.01, -88.24], d: [43.01, -88.22], s: [[43.016, -88.23]], p: '' };
    const bad = { 'coordinates that are not numbers': { ...good, o: ['<img src=x onerror=alert(1)>', 0] }, 'a latitude off the globe': { ...good, d: [943, -88] }, 'stops that are not a list': { ...good, s: 'abc' }, 'hundreds of stops': { ...good, s: Array.from({ length: 500 }, () => [43, -88]) }, 'a stop holding text': { ...good, s: [[43, '-88<script>']] }, 'an oversized line': { ...good, p: 'a'.repeat(30000) } };
    for (const [what, data] of Object.entries(bad)) {
      const { ctx, page, errors } = await openApp(browser, url + '#r=' + b64(data), { mock: fakeServices() });
      t.check(await page.evaluate(() => window.DMR.S.mode) === 'draw' && (await page.textContent('#toast')).includes('damaged'), `${what}: the link was accepted`);
      t.check(errors.length === 0, `${what}: ` + errors.join('; '));
      await ctx.close();
    }
    // Text fields carrying markup: shown as plain text, links still only ever point at Google and Apple.
    const evil = '"><img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const { ctx, page, errors } = await openApp(browser, url + '#r=' + b64({ ...good, n: evil, t: evil, on: evil, dn: 'javascript:alert(1)' }), { mock: fakeServices() });
    await page.waitForFunction(() => window.DMR.S.mode === 'viewer'); await page.waitForTimeout(300);
    t.check(await page.evaluate(() => window.__pwned) === undefined, 'markup from the link was run');
    t.check(await page.locator('#sheet img, #sheet script').count() === 0, 'markup from the link became page elements');
    const hrefs = await page.$$eval('#sheet a[href]', as => as.map(a => a.href));
    t.check(hrefs.length >= 2 && hrefs.every(h => h.startsWith('https://www.google.com/maps/dir/') || h.startsWith('https://maps.apple.com/directions') || h.startsWith(new URL(url).origin)), 'a link points somewhere unexpected: ' + hrefs.join(' | '));
    t.check((await page.textContent('#sheet')).includes('javascript:alert(1)'), 'the destination text the link carries is not shown to the person opening it');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Security: the page may only talk to the services it uses, and only run its own scripts', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    t.check(csp && csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && !/script-src[^;]*unsafe/.test(csp), 'the security policy is missing or allows inline scripts');
    const out = await page.evaluate(async () => {
      const tryFetch = await fetch('https://example.com/collect?x=1').then(() => 'sent', () => 'refused');
      const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.appendChild(s);
      const ext = await new Promise(res => { const e = document.createElement('script'); e.src = 'https://example.com/x.js'; e.onload = () => res('loaded'); e.onerror = () => res('refused'); document.body.appendChild(e); });
      return { tryFetch, inline: window.__inline === 1, ext };
    });
    t.check(out.tryFetch === 'refused', 'the page could send data to a server it does not use');
    t.check(!out.inline && out.ext === 'refused', 'the page ran a script that is not its own');
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

  await S.test('Start and destination go out as real places; only the stops are coordinates', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ reverse: houseAt }) });
    // From: a pin tapped on the map (its address is looked up). To: a place picked from search.
    await page.mouse.click(80, 200);
    await page.waitForFunction(() => window.DMR.S.fromQ !== '', null, { timeout: 5000 });
    t.check(await page.inputValue('#q-from') === '101 West Main Street', 'From box does not show the address of the tapped spot: ' + await page.inputValue('#q-from'));
    await page.fill('#q-to', 'frame park'); await page.waitForSelector('#results button:not([disabled])'); await page.click('#results button');
    await page.waitForFunction(() => window.DMR.S.desired && !window.DMR.S.busy);
    // bend the route so it needs a stop
    await page.evaluate(() => { const D = window.DMR, a = D.S.pts[0], b = D.S.pts[1]; D.S.pts.splice(1, 0, [(a[0] + b[0]) / 2 + 0.006, (a[1] + b[1]) / 2]); D.changed(); });
    await page.waitForFunction(() => window.DMR.S.desired && !window.DMR.S.busy && window.DMR.S.desired.coords.length === 3);
    const r = await buildLinks(page);
    const g = new URL(r.google[0]), a = new URL(r.apple[0]), coord = /^-?\d{1,3}\.\d{6},-?\d{1,3}\.\d{6}$/;
    t.note('Google: from "' + g.searchParams.get('origin') + '" to "' + g.searchParams.get('destination') + '" via ' + g.searchParams.get('waypoints'));
    t.check(g.searchParams.get('origin') === '101 West Main Street, Waukesha, Wisconsin 53186', 'Google start is not the street address');
    t.check(g.searchParams.get('destination') === 'Frame Park, 1150 Baxter Street, Waukesha, Wisconsin 53186', 'Google destination is not the named place with its address');
    t.check(a.searchParams.get('source') === g.searchParams.get('origin') && a.searchParams.get('destination') === g.searchParams.get('destination'), 'Apple link does not carry the same start and destination');
    const gs = g.searchParams.get('waypoints').split('|'), as = a.searchParams.getAll('waypoint');
    t.check(gs.length >= 1 && gs.every(w => coord.test(w)) && as.every(w => coord.test(w)), 'a stop is not a plain coordinate pair');
    // the shared link carries the names too
    const v = await ctx.newPage(); await v.route(u => u.origin !== new URL(url).origin, fakeServices());
    await v.goto(r.share); await v.waitForFunction(() => window.DMR && window.DMR.S.mode === 'viewer');
    t.check(await v.getAttribute('a.btn.google', 'href') === r.google[0], 'the shared link lost the place names');
    // "start from my current location": the start is left out and becomes a coordinate stop
    await page.click('details.opts summary'); await page.check('#t-here');
    const here = new URL(await page.getAttribute('a.btn.google', 'href'));
    t.check(!here.searchParams.get('origin') && here.searchParams.get('waypoints').split('|').every(w => coord.test(w)), '"start from my location" link is wrong');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('A spot with no real address (a bare road, or nothing nearby) goes out as coordinates', async t => {
    for (const [what, reverse] of [['bare road', bareRoadAt], ['address 300 m away', u => { const h = houseAt(u); h.lat = String(+h.lat + 0.003); return h; }], ['no answer', null]]) {
      const { ctx, page } = await openApp(browser, url, { mock: fakeServices({ reverse }) });
      await page.mouse.click(80, 200); await page.waitForTimeout(400); await page.mouse.click(300, 220);
      await page.waitForFunction(() => window.DMR.S.desired && !window.DMR.S.busy); await page.waitForTimeout(500);
      const r = await buildLinks(page), g = new URL(r.google[0]), coord = /^-?\d{1,3}\.\d{6},-?\d{1,3}\.\d{6}$/;
      t.check(coord.test(g.searchParams.get('origin')) && coord.test(g.searchParams.get('destination')), `${what}: expected coordinates, got "${g.searchParams.get('origin')}" to "${g.searchParams.get('destination')}"`);
      await ctx.close();
    }
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
    const cases = await page.evaluate(() => { const f = window.DMR.placeText; return [
      f({ name: 'Target', category: 'shop', address: { house_number: '2401', road: 'Kossow Road', town: 'Waukesha', state: 'Wisconsin', postcode: '53186' } }).q,
      f({ name: 'Frame Park', category: 'leisure', address: { road: 'Baxter Street', city: 'Waukesha', state: 'Wisconsin' } }).q,
      f({ name: 'Main Street', category: 'highway', address: { road: 'Main Street', city: 'Waukesha', state: 'Wisconsin' } }).q,
      f({ name: 'Waukesha', category: 'place', address: { city: 'Waukesha', state: 'Wisconsin' } }).q,
      f({ name: 'Lonely Barn', category: 'building', address: { road: 'Farm Lane', state: 'Wisconsin' } }).q]; });
    t.check(cases[0] === 'Target, 2401 Kossow Road, Waukesha, Wisconsin 53186', 'store: ' + cases[0]);
    t.check(cases[1] === 'Frame Park, Waukesha, Wisconsin', 'named place without a house number: ' + cases[1]);
    t.check(cases[2] === '' && cases[3] === '' && cases[4] === '', 'a bare road, a town or a place with no town was given a name: ' + cases.slice(2).join(' | '));
    await ctx.close();
  });

  await S.test('Location is never requested when the page opens, only when the visitor taps the button', async t => {
    // Location permission already granted, the case where a browser would hand it over without a prompt.
    const ctx = await browser.newContext({ ...require('playwright').devices['iPhone 13'], geolocation: { latitude: 43.0117, longitude: -88.2315 }, permissions: ['geolocation'] });
    await ctx.addInitScript(() => { window.__asked = 0; const g = navigator.geolocation, get = g.getCurrentPosition.bind(g), watch = g.watchPosition.bind(g); g.getCurrentPosition = (...a) => { window.__asked++; return get(...a); }; g.watchPosition = (...a) => { window.__asked++; return watch(...a); }; });
    const page = await ctx.newPage(); await page.route(u => u.origin !== new URL(url).origin, fakeServices({ reverse: houseAt }));
    await page.goto(url); await page.waitForFunction(() => window.DMR && document.querySelector('#sheet h2'));
    await page.waitForTimeout(2500);
    const idle = await page.evaluate(() => ({ asked: window.__asked, pts: window.DMR.S.pts.length, from: document.getElementById('q-from').value, zoom: window.DMR.map.getZoom() }));
    t.check(idle.asked === 0, `the page asked for the location ${idle.asked} time(s) just by opening`);
    t.check(idle.pts === 0 && idle.from === '', 'a starting point was set without the visitor doing anything');
    t.check(idle.zoom <= 5, 'the map opened zoomed in on a particular place');
    t.check((await page.textContent('#sheet')).includes('only requested if you tap'), 'the start screen does not say when location is used');
    // typing and searching must not ask either
    await page.fill('#q-to', 'frame park'); await page.waitForSelector('#results button:not([disabled])'); await page.click('#results button');
    await page.waitForTimeout(500);
    t.check(await page.evaluate(() => window.__asked) === 0, 'searching for a place asked for the location');
    // the button first shows the site's own clear question, and still has not asked
    await page.click('#b-loc');
    await page.waitForSelector('#ask:not([hidden])');
    const words = await page.textContent('#askbox');
    t.check(/Use your current location\?/.test(words) && /where you are right now/.test(words) && /does not store/.test(words), 'the question does not say plainly what is asked and what happens to it');
    await page.waitForTimeout(600);
    t.check(await page.evaluate(() => window.__asked) === 0, 'the location was requested before the visitor answered');
    // "Not now" closes it and nothing is asked
    await page.click('#ask-no');
    t.check(await page.isHidden('#ask') && await page.evaluate(() => window.__asked) === 0 && await page.evaluate(() => window.DMR.S.pts.length) === 0, '"Not now" did not simply close the question');
    // Escape too
    await page.click('#b-loc'); await page.waitForSelector('#ask:not([hidden])'); await page.keyboard.press('Escape');
    t.check(await page.isHidden('#ask') && await page.evaluate(() => window.__asked) === 0, 'Escape did not close the question');
    // "Use my location" asks, once
    await page.click('#b-loc'); await page.click('#ask-yes');
    await page.waitForFunction(() => window.DMR.S.pts.length === 2 && window.DMR.S.fromQ !== '', null, { timeout: 8000 });
    t.check(await page.evaluate(() => window.__asked) === 1, 'tapping the button did not ask exactly once');
    t.check(await page.inputValue('#q-from') === 'My location', 'From box does not say My location');
    t.check(await page.evaluate(() => window.DMR.S.fromQ) === '101 West Main Street, Waukesha, Wisconsin 53186', 'the address of my location was not looked up for the links');
    await ctx.close();
    // the start screen's own button too
    const two = await browser.newContext({ ...require('playwright').devices['iPhone 13'], geolocation: { latitude: 43.0117, longitude: -88.2315 }, permissions: ['geolocation'] });
    const p2 = await two.newPage(); await p2.route(u => u.origin !== new URL(url).origin, fakeServices({ reverse: houseAt }));
    await p2.goto(url); await p2.waitForSelector('#b-here'); await p2.click('#b-here');
    await p2.waitForSelector('#ask:not([hidden])'); await p2.screenshot({ path: path.join(OUT, 'offline-location-question.png') }); await p2.click('#ask-yes');
    await p2.waitForFunction(() => window.DMR.S.pts.length === 1, null, { timeout: 8000 });
    t.check(await p2.inputValue('#q-from') === 'My location', 'the start screen button did not set the start');
    await two.close();
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

  await S.test('The route follows the pointer live while dragging, before you let go', async t => {
    const { ctx, page, errors, calls } = await openApp(browser, url, { mock: fakeServices() });
    await drawRoute(page, [A, B]); await page.waitForTimeout(600);
    const mid = await page.evaluate(([a, b]) => { const p = window.DMR.map.latLngToContainerPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); return [p.x, p.y]; }, [A, B]);
    const before = calls.osrm;
    await page.mouse.move(mid[0], mid[1]); await page.mouse.down();
    const seen = [];
    for (let i = 1; i <= 4; i++) {                       // four pulls, pausing only long enough for a redraw to arrive
      await page.mouse.move(mid[0], mid[1] - 20 * i, { steps: 3 });
      await page.waitForFunction(y => { const D = window.DMR, c = D.S.desired && D.S.desired.coords; if (!c || c.length !== 3) return false; return Math.abs(D.map.latLngToContainerPoint(c[1]).y - y) < 4; }, mid[1] - 20 * i, { timeout: 4000 });
      seen.push(await page.evaluate(() => { const D = window.DMR, ll = D.S.line.getLatLngs()[1]; return Math.round(D.map.latLngToContainerPoint(ll).y); }));
    }
    const during = calls.osrm - before;
    t.note(`line bend followed to y = ${seen.join(', ')} while the button was still down; ${during} routing requests`);
    t.check(seen.every((y, i) => Math.abs(y - (mid[1] - 20 * (i + 1))) < 4), 'the drawn line did not keep up with the pointer');
    t.check(during >= 4 && during <= 16, `${during} routing requests during one drag (expected a handful, not a flood)`);
    await page.mouse.up();
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && !window.DMR.S.busy && !!window.DMR.S.grab, null, { timeout: 8000 });
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Dragging an existing pin also re-draws the route live', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() });
    await drawRoute(page, [A, MID, B]); await page.waitForTimeout(600);
    const pin = await page.evaluate(() => { const p = window.DMR.map.latLngToContainerPoint(window.DMR.S.pts[1]); return [p.x, p.y]; });
    await page.mouse.move(pin[0], pin[1]); await page.mouse.down();
    await page.mouse.move(pin[0] + 10, pin[1] + 30, { steps: 5 });
    await page.waitForFunction(y => { const D = window.DMR, c = D.S.desired.coords; return c.length === 3 && Math.abs(D.map.latLngToContainerPoint(c[1]).y - y) < 5; }, pin[1] + 30, { timeout: 4000 });
    await page.mouse.up();
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && !window.DMR.S.busy && !!window.DMR.S.grab, null, { timeout: 8000 });
    const at = await page.evaluate(() => { const p = window.DMR.map.latLngToContainerPoint(window.DMR.S.pts[1]); return [p.x, p.y]; });
    t.check(Math.abs(at[1] - (pin[1] + 30)) < 6, 'pin did not stay where it was dropped');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Roads on the phone: the line follows every movement along real roads, without waiting for the server', async t => {
    let slow = false;
    const straight = (route, u) => { const pts = u.split('/driving/')[1].split('?')[0].split(';').map(s => s.split(',').map(Number)); const answer = () => json(route, { code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates: pts }, legs: [{ steps: [{ intersections: [] }] }] }] }); return slow ? setTimeout(answer, 3000) : answer(); };
    const { ctx, page, errors, calls } = await openApp(browser, url, { mock: fakeServices({ roads: waukeshaRoads, osrm: straight }) });
    await drawRoute(page, [W.library, W.airport]);
    await page.waitForFunction(() => window.DMR.local.status === 'ready', null, { timeout: 8000 });
    const net = await page.evaluate(() => ({ junctions: window.DMR.local.net.nodes, pieces: window.DMR.local.net.edges }));
    t.note(`road network loaded: ${net.junctions} junctions, ${net.pieces} road pieces`);
    t.check(net.pieces > 5000, 'road network looks incomplete');
    await page.waitForTimeout(500);
    const mid = await page.evaluate(([a, b]) => { const p = window.DMR.map.latLngToContainerPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); return [p.x, p.y]; }, [W.library, W.airport]);
    slow = true; const osrmBefore = calls.osrm, lookupsBefore = calls.valhalla;
    await page.mouse.move(mid[0], mid[1]); await page.mouse.down();
    const shapes = new Set(); let onRoads = 0;
    for (let i = 1; i <= 30; i++) {                                   // thirty small movements, one frame apart
      await page.mouse.move(mid[0] - 3 * i, mid[1] + i);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const line = await page.evaluate(() => window.DMR.S.line.getLatLngs().map(p => [p.lat, p.lng]));
      shapes.add(JSON.stringify(line.map(p => [p[0].toFixed(5), p[1].toFixed(5)])));
      if (line.length > 20) onRoads++;                                 // real roads bend; the fake server only ever answers with straight lines
    }
    const previews = await page.evaluate(() => window.DMR.live.previews);
    t.note(`${previews} redraws for 30 movements, ${shapes.size} distinct line shapes, ${calls.osrm - osrmBefore} server routing requests still unanswered, ${calls.valhalla - lookupsBefore} road lookups`);
    t.check(previews >= 25, `only ${previews} redraws for 30 movements`);
    t.check(onRoads >= 28, 'the line did not follow real roads while dragging');
    t.check(shapes.size >= 3, 'the line did not change as the pointer moved');
    t.check(calls.valhalla - lookupsBefore === 0, 'road lookups went to the server even though the roads were on the phone');
    await page.screenshot({ path: path.join(OUT, 'offline-local-drag.png') });
    slow = false; await page.mouse.up();
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && window.DMR.S.pts[1].snapped && !window.DMR.S.busy && !!window.DMR.S.grab, null, { timeout: 12000 });
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Roads on the phone: shaping a route asks no routing server; only sending does', async t => {
    const { ctx, page, errors, calls } = await openApp(browser, url, { mock: fakeServices({ roads: waukeshaRoads }) });
    await drawRoute(page, [W.library, W.airport]);
    await page.waitForFunction(() => window.DMR.local.status === 'ready', null, { timeout: 8000 });
    const first = calls.osrm + calls.valhalla;                           // at most the one request made before the roads arrived
    t.check(first <= 1, `${first} routing requests before the roads arrived`);
    await page.waitForTimeout(500);
    // drag the line, then mark a road to avoid
    const mid = await page.evaluate(() => { const D = window.DMR, c = D.S.desired.coords, p = D.map.latLngToContainerPoint(c[Math.floor(c.length / 2)]); return [p.x, p.y]; });
    await page.mouse.move(mid[0], mid[1]); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(mid[0] - 4 * i, mid[1] + i, { steps: 2 });
    await page.mouse.up();
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && window.DMR.S.pts[1].snapped && !window.DMR.S.busy && !!window.DMR.S.grab, null, { timeout: 8000 });
    const shaped = await page.evaluate(() => ({ by: window.DMR.S.desired.src, n: window.DMR.S.desired.coords.length, km: window.DMR.S.desired.distance / 1000 }));
    t.check(shaped.by === 'phone' && shaped.n > 20, `route after the drag was drawn by ${shaped.by} with ${shaped.n} points`);
    await page.evaluate(() => { const D = window.DMR, c = D.S.desired.coords; D.S.zones.push(c[Math.floor(c.length * 0.8)]); D.changed(); });
    await page.waitForFunction(() => window.DMR.S.desired && !window.DMR.S.busy && window.DMR.S.zones.length === 1 && !!window.DMR.S.grab, null, { timeout: 8000 });
    await page.waitForTimeout(400);
    const around = await page.evaluate(() => { const D = window.DMR, z = D.S.zones[0]; return { by: D.S.desired.src, nearest: Math.min(...D.S.desired.coords.map(c => Math.hypot((c[0] - z[0]) * 110540, (c[1] - z[1]) * 81400))) }; });
    t.check(around.by === 'phone' && around.nearest > 40, `after marking a road the route passes ${Math.round(around.nearest)} m from it (drawn by ${around.by})`);
    const shaping = calls.osrm + calls.valhalla - first;
    t.note(`${first} routing request(s) to get started, ${shaping} while dragging and marking a road`);
    t.check(shaping === 0, `${shaping} routing-server requests were made while shaping the route`);
    // sending is the one step that asks the server
    const r = await buildLinks(page);
    const sending = calls.osrm + calls.valhalla - first - shaping;
    t.note(`${sending} routing request(s) to send it; the sent line shares ${Math.round(r.same * 100)}% of the shaped line (the test's stand-in server only knows straight lines)`);
    t.check(r && sending >= 1, 'sending did not consult the routing server');
    t.check(r.stops.length >= 1 && r.parts.every(p => p.w.length <= 9), 'links were not built');   // the stand-in servers disagree wildly, so the count means nothing here
    t.check((await page.textContent('#sheet')).includes('different side streets'), 'result does not say the sent line differs from the shaped one');
    await page.click('#b-edit');
    t.check(await page.evaluate(() => window.DMR.S.line.getLatLngs().length > 20), 'going back to edit did not restore the shaped line');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Roads on the phone: if the routing server is down at send time, sending fails with a message and the route is kept', async t => {
    let down = false;
    const straight = (route, u) => { if (down) return route.abort(); const pts = u.split('/driving/')[1].split('?')[0].split(';').map(s => s.split(',').map(Number)); return json(route, { code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates: pts }, legs: [{ steps: [{ intersections: [] }] }] }] }); };
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ roads: waukeshaRoads, osrm: straight }) });
    await drawRoute(page, [W.library, W.airport]);
    await page.waitForFunction(() => window.DMR.local.status === 'ready' && !window.DMR.S.busy, null, { timeout: 8000 });
    await page.evaluate(() => window.DMR.changed());                     // make sure the line on screen is the phone's
    await page.waitForFunction(() => window.DMR.S.desired && window.DMR.S.desired.src === 'phone' && !window.DMR.S.busy, null, { timeout: 8000 });
    down = true;
    const r = await buildLinks(page, 60000);
    t.check(r === null, 'expected sending to fail cleanly with the routing server down');   // stops cannot be worked out without it
    t.check(await page.evaluate(() => window.DMR.S.mode === 'draw' && window.DMR.S.pts.length === 2), 'the route was lost');
    t.check((await page.textContent('#toast')).length > 0, 'no message shown');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Roads on the phone: a dropped pin snaps to the larger road at once, with no server lookup', async t => {
    const { ctx, page, errors, calls } = await openApp(browser, url, { mock: fakeServices({ roads: waukeshaRoads }) });
    await drawRoute(page, [W.library, W.airport]);
    await page.waitForFunction(() => window.DMR.local.status === 'ready', null, { timeout: 8000 });
    // Same downtown spot as the live snapping test: 6 m from a service lane, about 16 m from North Barstow Street.
    const out = await page.evaluate(async () => { const D = window.DMR; D.map.setView([43.0125, -88.2290], 16, { animate: false }); const t0 = performance.now(); const s = await D.snapToRoad([43.0125, -88.2290], false); return { s, ms: performance.now() - t0 }; });
    t.note(`landed on "${out.s.name}" (${out.s.tier}) in ${out.ms.toFixed(1)} ms`);
    t.check(out.s.name === 'North Barstow Street', `expected North Barstow Street, got "${out.s.name}"`);
    t.check(out.ms < 50 && calls.valhalla === 0, 'the lookup went to the server');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Road download: falls over to the second server, and dragging still works if both are down', async t => {
    let hits = [];
    const firstDown = (route, u) => { hits.push(new URL(u).host); return new URL(u).host === 'overpass-api.de' ? route.abort() : waukeshaRoads(route); };
    const one = await openApp(browser, url, { mock: fakeServices({ roads: firstDown }) });
    await drawRoute(one.page, [W.library, W.airport]);
    await one.page.waitForFunction(() => window.DMR.local.status === 'ready', null, { timeout: 8000 });
    t.note('servers tried: ' + hits.join(', '));
    t.check(hits.length === 2 && hits[0] === 'overpass-api.de', 'did not try the first server then the second');
    await one.ctx.close();
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices() }); // road service unreachable
    await drawRoute(page, [A, B]);
    await page.waitForFunction(() => window.DMR.local.status === 'failed', null, { timeout: 8000 });
    t.check(await page.isEnabled('#b-build'), 'app is unusable without the road download');
    t.check(await page.locator('#roads').count() === 0, 'the "loading roads" note is stuck on screen');
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

  await S.test('Dropping the line near a main road lands on the main road; far from one it stays where you put it', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ locate: bigRoadLocate }) });
    await drawRoute(page, [A, B]); await page.waitForTimeout(600);
    const px = ll => page.evaluate(ll => { const p = window.DMR.map.latLngToContainerPoint(ll); return [p.x, p.y]; }, ll);
    const pull = async (from, to) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(from[0] + (to[0] - from[0]) * i / 6, from[1] + (to[1] - from[1]) * i / 6, { steps: 2 }); await page.mouse.up(); };
    const lonMid = (A[1] + B[1]) / 2, start = await px([A[0], lonMid]), road = await px([BIG_ROAD_LAT, lonMid]);
    // let go 6 px short of the main road: it should jump onto it
    await pull(start, [road[0], road[1] + 6]);
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && window.DMR.S.pts[1].snapped && !window.DMR.S.busy && window.DMR.S.desired.coords.length === 3, null, { timeout: 8000 });
    let pin = await page.evaluate(() => window.DMR.S.pts[1]);
    t.check(Math.abs(pin[0] - BIG_ROAD_LAT) < 1e-6, `pin landed at latitude ${pin[0].toFixed(5)}, not on the main road at ${BIG_ROAD_LAT}`);
    t.check((await page.textContent('#toast')).includes('Big Road'), 'user was not told which road the pin landed on');
    // drag that pin well away from the main road (100 px south): it should stay by the small street there
    const from = await px(pin), far = [from[0] + 30, from[1] + 100];
    await page.mouse.move(from[0], from[1]); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(from[0] + 5 * i, from[1] + 100 * i / 6, { steps: 2 }); await page.mouse.up();
    await page.waitForFunction(lat => window.DMR.S.pts.length === 3 && window.DMR.S.pts[1].snapped && Math.abs(window.DMR.S.pts[1][0] - lat) > 1e-4 && !window.DMR.S.busy, BIG_ROAD_LAT, { timeout: 8000 });
    pin = await page.evaluate(() => window.DMR.S.pts[1]); const at = await px(pin);
    t.check(Math.abs(at[1] - far[1]) < 8, `pin ended ${Math.round(Math.abs(at[1] - far[1]))} px from where it was dropped, expected to stay put`);
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Road lookup unavailable: the pin simply stays where it was dropped', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ locate: route => route.abort() }) });
    await drawRoute(page, [A, B]); await page.waitForTimeout(600);
    const mid = await page.evaluate(([a, b]) => { const p = window.DMR.map.latLngToContainerPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); return [p.x, p.y]; }, [A, B]);
    await page.mouse.move(mid[0], mid[1]); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(mid[0], mid[1] - 10 * i, { steps: 2 }); await page.mouse.up();
    await page.waitForFunction(() => window.DMR.S.pts.length === 3 && window.DMR.S.desired && !window.DMR.S.busy && window.DMR.S.desired.coords.length === 3, null, { timeout: 8000 });
    const at = await page.evaluate(() => { const p = window.DMR.map.latLngToContainerPoint(window.DMR.S.pts[1]); return [p.x, p.y]; });
    t.check(Math.abs(at[1] - (mid[1] - 60)) < 6, 'pin moved even though no road information was available');
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

  await S.test('Routing service goes silent: the app stops waiting and says so instead of hanging', async t => {
    const { ctx, page, errors } = await openApp(browser, url, { mock: fakeServices({ osrm: () => { /* never answer */ } }) });
    await page.evaluate(([a, b]) => { const D = window.DMR; D.S.pts.push(a, b); D.changed(); }, [A, B]);
    await page.waitForSelector('#toast:not([hidden])', { timeout: 30000 });
    t.note('message shown: "' + await page.textContent('#toast') + '"');
    t.check(await page.evaluate(() => window.DMR.S.busy === 0), 'app is still waiting');
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
