// Live tests: real OpenStreetMap tiles, routing and search. Slower, and they need internet access.
// Each scenario draws a route the way a person would, makes the share links, then checks the result three ways:
//   1. the app's own predicted match in each of its two routing engines (OSRM and Valhalla),
//   2. an independent re-measurement of those matches (separate code, so it catches scoring mistakes),
//   3. an outside judge: BRouter, an engine the app never uses, is given the same stops. If it also follows
//      the drawn route, the stops are likely to hold up in maps apps that think differently from the app.
// Each scenario runs at all three stops levels (fewest, balanced, most reliable) so the trade-off is visible.
const path = require('path');
const { openApp, drawRoute, buildLinks, matchScore, distToRouteM, alongRoute, outsideOpinion, suite, OUT } = require('./lib');

const P = {
  library: [43.0086229, -88.2328702], carroll: [43.0039527, -88.2292641], framePark: [43.0182516, -88.2241790],
  courthouse: [43.0227893, -88.2292592], hospital: [43.0114004, -88.2430759], southHigh: [42.9928266, -88.2232275],
  grocery: [42.9916193, -88.2576786], minooka: [42.9765574, -88.1851730], airport: [43.0396037, -88.2348839],
  brookfield: [43.0340, -88.1090], greenfieldAve: [43.0166, -88.1200],
  timesSq: [40.7580, -73.9855], empire: [40.7484, -73.9857], unionSq: [40.7359, -73.9911],
  londonEye: [51.5033, -0.1196], stPauls: [51.5138, -0.0984], towerBridge: [51.5055, -0.0754],
};

const SCENARIOS = [
  { id: 'direct', title: 'Fastest route as drawn (library to Frame Park)', pts: [P.library, P.framePark] },
  { id: 'detour', title: 'One deliberate detour (library to Frame Park past the hospital)', pts: [P.library, P.hospital, P.framePark] },
  { id: 'scenic', title: 'Several must-pass places across town', pts: [P.grocery, P.carroll, P.courthouse, P.airport] },
  { id: 'loop', title: 'Loop that ends near where it starts', pts: [P.library, P.framePark, P.courthouse, P.hospital, P.carroll] },
  { id: 'highway', title: 'Longer trip where the fastest way is the highway (Waukesha to Brookfield)', pts: [P.library, P.brookfield] },
  { id: 'no-highway', title: 'Same trip drawn on surface streets instead of the highway', pts: [P.library, P.greenfieldAve, P.brookfield] },
  { id: 'manhattan', title: 'Dense one-way streets (Times Square to Union Square past the Empire State Building)', pts: [P.timesSq, P.empire, P.unionSq] },
  { id: 'london', title: 'Outside the US, driving on the left (London Eye to Tower Bridge past St Paul\'s)', pts: [P.londonEye, P.stPauls, P.towerBridge] },
];

module.exports = async function live(browser, url) {
  const S = suite('Live (real maps and routing)');
  const metrics = [];

  for (const sc of SCENARIOS) {
    await S.test(sc.title, async t => {
      const pct = x => x == null ? null : Math.round(x * 100);
      const runs = {};
      for (const level of ['few', 'balanced', 'most']) {
        const { ctx, page, errors, calls } = await openApp(browser, url, { level });
        const t0 = Date.now();
        const desired = await drawRoute(page, sc.pts);
        const r = await buildLinks(page);
        const secs = (Date.now() - t0) / 1000;
        t.check(r, `${level}: no result: ` + (await page.textContent('#toast')));
        if (level === 'balanced') { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, `live-${sc.id}.png`) }); }
        const out = await outsideOpinion(page, [r.origin, ...r.stops, r.dest]);
        runs[level] = { r, desired, errors, secs, calls: calls.osrm + calls.valhalla, outside: out ? matchScore(desired.coords, out) : null };
        await ctx.close();
      }
      const { r, desired, errors, secs } = runs.balanced;
      const indep = matchScore(desired.coords, r.predicted), indep2 = r.predicted2 ? matchScore(desired.coords, r.predicted2) : null;
      const offLine = r.stops.map(s => distToRouteM(s, desired.coords)), worstOff = Math.max(0, ...offLine);
      const order = r.stops.map(s => alongRoute(s, desired.coords));
      const m = { id: sc.id, km: +(desired.distance / 1000).toFixed(1), checked: r.checked, appMatch: Math.floor(r.match * 100), engine1: pct(r.score), engine2: pct(r.score2), remeasured1: pct(indep), remeasured2: pct(indep2) };
      for (const k of ['few', 'balanced', 'most']) m[k] = { stops: runs[k].r.stops.length, links: runs[k].r.parts.length, outside: pct(runs[k].outside), seconds: +runs[k].secs.toFixed(1), routerCalls: runs[k].calls };
      metrics.push(m);
      const show = k => `${m[k].stops} stop${m[k].stops === 1 ? '' : 's'} / ${m[k].outside ?? 'n/a'}%`;
      t.note(`${m.km} km. Stops / outside judge: fewest ${show('few')}, balanced ${show('balanced')}, most reliable ${show('most')}. Balanced took ${m.balanced.seconds}s and ${m.balanced.routerCalls} router calls; app says ${m.appMatch}%.`);

      for (const k of ['few', 'balanced', 'most']) {
        t.check(runs[k].errors.length === 0, `${k}: ` + runs[k].errors.join('; '));
        t.check(runs[k].r.parts.every(p => p.w.length <= 9), `${k}: a link has more than 9 stops`);
        t.check(runs[k].r.score >= 0.97, `${k}: first engine only follows ${pct(runs[k].r.score)}% of the route`);
      }
      t.check(m.few.stops <= m.balanced.stops && m.balanced.stops <= m.most.stops, 'stop counts do not rise with the level');
      t.check(indep >= 0.95, `app claims ${m.engine1}% for the first engine but re-measuring gives ${m.remeasured1}%`);
      t.check(indep2 == null || Math.abs(indep2 - r.score2) <= 0.06, `app claims ${m.engine2}% for the second engine but re-measuring gives ${m.remeasured2}%`);
      t.check(worstOff <= 15, `a stop sits ${Math.round(worstOff)} m off the drawn route`);
      t.check(order.every((a, i) => i === 0 || a >= order[i - 1] - 30), 'stops are not in driving order');
      for (const g of r.google) { const u = new URL(g); t.check(u.searchParams.get('destination') && u.searchParams.get('origin'), 'Google link is missing a start or end'); }
      if (r.checked !== 'two') t.warn('the second routing engine did not answer during this run, so the app fell back to one engine');
      if (r.match < 0.97) t.warn(`the two engines agree on only ${m.appMatch}% of the route even with stops`);
      if (runs.balanced.outside != null && runs.balanced.outside < 0.9) t.warn(`balanced: an outside routing engine follows only ${m.balanced.outside}% of the drawn route`);
      if (runs.most.outside != null && runs.most.outside < 0.9) t.warn(`most reliable: an outside routing engine follows only ${m.most.outside}% of the drawn route`);
      if (secs > 60) t.warn(`balanced took ${secs.toFixed(0)}s to make the links`);
    });
  }

  await S.test('Avoid a road: marking a road on the fastest route moves the route off it, and the links keep off it', async t => {
    const { ctx, page, errors } = await openApp(browser, url);
    const fast = await drawRoute(page, [P.library, P.airport]);
    const mark = fast.coords[Math.floor(fast.coords.length / 2)];
    const desired = await drawRoute(page, [P.library, P.airport], [mark]);
    const drawnGap = distToRouteM(mark, desired.coords);
    t.note(`fastest route ${(fast.distance / 1000).toFixed(1)} km; around the marked road ${(desired.distance / 1000).toFixed(1)} km, passing ${Math.round(drawnGap)} m from the mark`);
    t.check(drawnGap > 40, `the drawn route still passes ${Math.round(drawnGap)} m from the marked road`);
    const r = await buildLinks(page);
    t.check(r, 'no result');
    await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, 'live-avoid.png') });
    const near = distToRouteM(mark, r.predicted);
    t.note(`${r.stops.length} stop(s); "${r.heading}"`);
    t.check(r.avoidOnly, 'app did not switch to avoid-only mode');
    t.check(r.crossed === 0 && near > 40, `predicted route still passes ${Math.round(near)} m from the marked road`);
    const out = await outsideOpinion(page, [r.origin, ...r.stops, r.dest]);
    if (out) { const d = distToRouteM(mark, out); t.note(`outside engine passes ${Math.round(d)} m from the mark`); if (d <= 40) t.warn('an outside routing engine still uses the marked road with these stops'); }
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Snapping favours the larger road: a drop between a car-park lane and a through street lands on the street', async t => {
    const { ctx, page } = await openApp(browser, url);
    // Downtown Waukesha: this spot is 6 m from a service lane and about 16 m from North Barstow Street.
    const out = await page.evaluate(async () => { const D = window.DMR; D.map.setView([43.0125, -88.2290], 16, { animate: false }); const coarse = await D.snapToRoad([43.0125, -88.2290], false), fine = await D.snapToRoad([43.0125, -88.2290], true); return { coarse, fine }; });
    t.note(`finger: "${out.coarse.name}" (${out.coarse.tier}); mouse: "${out.fine.name}" (${out.fine.tier})`);
    t.check(out.coarse.tier !== 'none', 'road lookup did not answer');
    t.check(out.coarse.name === 'North Barstow Street' && out.coarse.tier === 'medium', `expected to land on North Barstow Street, got "${out.coarse.name}" (${out.coarse.tier})`);
    await ctx.close();
  });

  await S.test('On-phone preview agrees with the routing server (so the line rarely shifts when you let go)', async t => {
    // The road-data service is unreachable from the test machine, so real Waukesha roads from the fixture stand in for it. Routing is the real server.
    const { waukeshaOverpass } = require('./fixture'); const body = JSON.stringify(waukeshaOverpass());
    const { ctx, page, errors } = await openApp(browser, url);
    await page.route(u => u.host.startsWith('overpass'), route => route.fulfill({ contentType: 'application/json', body }));
    const cases = [['library to airport', [P.library, P.airport]], ['grocery to courthouse', [P.grocery, P.courthouse]], ['library to Frame Park via hospital', [P.library, P.hospital, P.framePark]], ['South High to airport via Carroll', [P.southHigh, P.carroll, P.airport]], ['hospital to South High', [P.hospital, P.southHigh]]];
    const scores = [];
    for (const [name, pts] of cases) {
      await drawRoute(page, [pts[0], pts[pts.length - 1]]);
      await page.waitForFunction(() => window.DMR.local.status === 'ready', null, { timeout: 15000 });
      // Pins in the middle are snapped onto a road first, as they are when the line is dragged in the app.
      for (let i = 1; i < pts.length - 1; i++) pts[i] = (await page.evaluate(p => window.DMR.snapToRoad(p, false), pts[i])).ll;
      const server = await drawRoute(page, pts);
      const mine = await page.evaluate(pts => { const D = window.DMR, t0 = performance.now(), r = D.local.net.route(pts.map(p => p.slice())); return r && { coords: r.coords, ms: performance.now() - t0 }; }, pts);
      t.check(mine, `${name}: no on-phone route`);
      const m = matchScore(server.coords, mine.coords); scores.push(m);
      t.note(`${name}: ${Math.round(m * 100)}% the same roads (${mine.ms.toFixed(1)} ms on the phone)`);
    }
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    t.note(`average agreement ${Math.round(avg * 100)}%`);
    t.check(errors.length === 0, errors.join('; '));
    if (avg < 0.85) t.warn(`on-phone previews match the server on only ${Math.round(avg * 100)}% of the route on average, so the line will often shift on release`);
    await ctx.close();
  });

  await S.test('Real search finds a named place', async t => {
    const { ctx, page } = await openApp(browser, url);
    await page.fill('#q-to', 'Frame Park Waukesha');
    await page.waitForSelector('#results button', { timeout: 20000 });
    const first = await page.textContent('#results button');
    t.note('first result: ' + first.replace(/\s+/g, ' '));
    t.check(/frame park/i.test(first), 'expected Frame Park in the results');
    await ctx.close();
  });

  await S.test('Real map tiles load', async t => {
    const { ctx, page, calls } = await openApp(browser, url);
    await page.waitForTimeout(4000);
    const loaded = await page.evaluate(() => [...document.querySelectorAll('img.leaflet-tile')].filter(i => i.complete && i.naturalWidth > 0).length);
    t.note(`${loaded} tiles loaded of ${calls.tiles} requested`);
    t.check(loaded >= 4, 'map tiles did not load');
    await ctx.close();
  });

  S.metrics = metrics;
  return S;
};

module.exports.SCENARIOS = SCENARIOS;
