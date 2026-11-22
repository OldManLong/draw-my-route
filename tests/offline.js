// Offline tests: every outside service is faked, so these run anywhere in seconds and check the app's own logic.
const { openApp, drawRoute, buildLinks, suite, OUT } = require('./lib');
const path = require('path');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/* Fake router: the "fastest route" is a straight line between whatever points it is given. */
function fakeServices({ osrm } = {}) {
  return route => {
    const u = route.request().url();
    if (u.includes('tile.openstreetmap.org')) return route.fulfill({ body: PNG, contentType: 'image/png' });
    if (u.includes('router.project-osrm.org')) {
      if (osrm) return osrm(route, u);
      const pts = u.split('/driving/')[1].split('?')[0].split(';').map(s => s.split(',').map(Number));
      return json(route, { code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates: pts }, legs: [{ steps: [{ intersections: [] }] }] }] });
    }
    if (u.includes('valhalla')) return json(route, { error: 'No route' }, 400);
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
    t.check((await page.textContent('#sheet h2')).includes('Draw your route'), 'draw sheet not shown');
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
    await page.click('#b-undo'); await page.waitForTimeout(300);
    t.check(await page.evaluate(() => window.DMR.S.pts.length) === 1, 'Undo did not remove a point');
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Straight route needs no stops; bent route gets a stop on the bend', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
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

  await S.test('Search finds a place and adds it to the route', async t => {
    const { ctx, page } = await openApp(browser, url, { mock: fakeServices() });
    await page.fill('#q', 'frame park'); await page.waitForSelector('#results button:not([disabled])');
    await page.click('#results button'); await page.click('.pop .btn.primary');
    t.check(await page.evaluate(() => window.DMR.S.pts.length) === 1, 'search result was not added as a point');
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
