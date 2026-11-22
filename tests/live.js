// Live tests: real OpenStreetMap tiles, routing and search. Slower, and they need internet access.
// Each scenario draws a route the way a person would, makes the share links, then checks the result three ways:
//   1. the app's own predicted match,
//   2. an independent re-measurement of that match (separate code, so it catches scoring mistakes),
//   3. a "second opinion": a different router (Valhalla) is given the same stops. If it also follows the
//      drawn route, the stops are likely to hold up in maps apps that do not think like the app's router.
const path = require('path');
const { openApp, drawRoute, buildLinks, matchScore, distToRouteM, alongRoute, secondOpinion, suite, OUT } = require('./lib');

const P = {
  library: [43.0086229, -88.2328702], carroll: [43.0039527, -88.2292641], framePark: [43.0182516, -88.2241790],
  courthouse: [43.0227893, -88.2292592], hospital: [43.0114004, -88.2430759], southHigh: [42.9928266, -88.2232275],
  grocery: [42.9916193, -88.2576786], minooka: [42.9765574, -88.1851730], airport: [43.0396037, -88.2348839],
  brookfield: [43.0340, -88.1090], greenfieldAve: [43.0166, -88.1200],
  timesSq: [40.7580, -73.9855], empire: [40.7484, -73.9857], unionSq: [40.7359, -73.9911],
  londonEye: [51.5033, -0.1196], stPauls: [51.5138, -0.0984], towerBridge: [51.5055, -0.0754],
};

const SCENARIOS = [
  { id: 'direct', title: 'Fastest route as drawn (library to Frame Park)', pts: [P.library, P.framePark], expectStops: [0, 0] },
  { id: 'detour', title: 'One deliberate detour (library to Frame Park past the hospital)', pts: [P.library, P.hospital, P.framePark], expectStops: [1, 6] },
  { id: 'scenic', title: 'Several must-pass places across town', pts: [P.grocery, P.carroll, P.courthouse, P.airport], expectStops: [1, 9] },
  { id: 'loop', title: 'Loop that ends near where it starts', pts: [P.library, P.framePark, P.courthouse, P.hospital, P.carroll], expectStops: [1, 9] },
  { id: 'highway', title: 'Longer trip where the fastest way is the highway (Waukesha to Brookfield)', pts: [P.library, P.brookfield], expectStops: [0, 0] },
  { id: 'no-highway', title: 'Same trip drawn on surface streets instead of the highway', pts: [P.library, P.greenfieldAve, P.brookfield], expectStops: [0, 9] },
  { id: 'manhattan', title: 'Dense one-way streets (Times Square to Union Square past the Empire State Building)', pts: [P.timesSq, P.empire, P.unionSq], expectStops: [0, 6] },
  { id: 'london', title: 'Outside the US, driving on the left (London Eye to Tower Bridge past St Paul\'s)', pts: [P.londonEye, P.stPauls, P.towerBridge], expectStops: [0, 8] },
];

module.exports = async function live(browser, url) {
  const S = suite('Live (real maps and routing)');
  const metrics = [];

  for (const sc of SCENARIOS) {
    await S.test(sc.title, async t => {
      const { ctx, page, errors, calls } = await openApp(browser, url);
      const t0 = Date.now();
      const desired = await drawRoute(page, sc.pts);
      const r = await buildLinks(page);
      const secs = (Date.now() - t0) / 1000;
      t.check(r, 'no result: ' + (await page.textContent('#toast')));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, `live-${sc.id}.png`) });

      const own = r.score, indep = matchScore(desired.coords, r.predicted);
      const second = await secondOpinion(page, [r.origin, ...r.stops, r.dest], r.avoid).catch(() => null);
      const secondScore = second ? matchScore(desired.coords, second) : null;
      const offLine = r.stops.map(s => distToRouteM(s, desired.coords)), worstOff = Math.max(0, ...offLine);
      const order = r.stops.map(s => alongRoute(s, desired.coords));
      const m = { id: sc.id, km: +(desired.distance / 1000).toFixed(1), stops: r.stops.length, parts: r.parts.length, avoidHighways: !!r.avoid, appMatch: Math.round(own * 100), independentMatch: Math.round(indep * 100), secondOpinion: secondScore == null ? null : Math.round(secondScore * 100), seconds: +secs.toFixed(1), routerCalls: calls.osrm + calls.valhalla };
      metrics.push(m);
      t.note(`${m.km} km, ${m.stops} stop${m.stops === 1 ? '' : 's'}${m.avoidHighways ? ' + avoid highways' : ''}, app says ${m.appMatch}%, re-measured ${m.independentMatch}%, second router ${m.secondOpinion == null ? 'unavailable' : m.secondOpinion + '%'}, ${m.seconds}s, ${m.routerCalls} router calls`);

      t.check(errors.length === 0, errors.join('; '));
      t.check(own >= 0.97, `app's predicted match is only ${m.appMatch}%`);
      t.check(indep >= 0.95, `app claims ${m.appMatch}% but re-measuring gives ${m.independentMatch}%`);
      t.check(r.stops.length >= sc.expectStops[0] && r.stops.length <= sc.expectStops[1], `expected ${sc.expectStops[0]}-${sc.expectStops[1]} stops, got ${r.stops.length}`);
      t.check(worstOff <= 15, `a stop sits ${Math.round(worstOff)} m off the drawn route`);
      t.check(order.every((a, i) => i === 0 || a >= order[i - 1] - 30), 'stops are not in driving order');
      t.check(r.parts.every(p => p.w.length <= 9), 'a link has more than 9 stops');
      for (const g of r.google) { const u = new URL(g); t.check(u.searchParams.get('destination') && u.searchParams.get('origin'), 'Google link is missing a start or end'); }
      if (secondScore != null && secondScore < 0.9) t.warn(`a different router only follows ${m.secondOpinion}% of the drawn route with these stops, so Google or Apple may stray too`);
      if (secs > 45) t.warn(`took ${m.seconds}s to make the links`);
      await ctx.close();
    });
  }

  await S.test('Stay-off mark keeps the predicted route away from a road', async t => {
    const { ctx, page, errors } = await openApp(browser, url);
    // Find where the fastest library-to-airport route runs, mark its midpoint, then draw a route that goes around via the hospital.
    const fast = await drawRoute(page, [P.library, P.airport]);
    const mark = fast.coords[Math.floor(fast.coords.length / 2)];
    const desired = await drawRoute(page, [P.library, P.hospital, P.airport], [mark]);
    const onOwn = distToRouteM(mark, desired.coords);
    const r = await buildLinks(page);
    t.check(r, 'no result');
    await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, 'live-stay-off.png') });
    t.note(`mark is ${Math.round(onOwn)} m from the drawn route; ${r.stops.length} stop(s); heading "${r.heading}"`);
    if (onOwn <= 40) { t.warn('the detour still passes the marked spot, so the app ignored the mark (scenario needs a different detour)'); await ctx.close(); return; }
    const near = distToRouteM(mark, r.predicted);
    t.check(r.avoidOnly, 'app did not switch to stay-off mode');
    t.check(r.crossed === 0 && near > 40, `predicted route still passes ${Math.round(near)} m from the marked spot`);
    t.check(errors.length === 0, errors.join('; '));
    await ctx.close();
  });

  await S.test('Real search finds a named place', async t => {
    const { ctx, page } = await openApp(browser, url);
    await page.fill('#q', 'Frame Park Waukesha');
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
