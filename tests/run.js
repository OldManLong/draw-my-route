// Runs the test suites against a private local copy of the site.
//   node tests/run.js            both suites
//   node tests/run.js --offline  faked services only (fast, no internet needed)
//   node tests/run.js --live     real maps and routing only
const fs = require('fs'), path = require('path');
const { start } = require('./serve');
const { launch, OUT } = require('./lib');

(async () => {
  const only = process.argv.includes('--offline') ? 'offline' : process.argv.includes('--live') ? 'live' : null;
  const { server, url } = await start(+process.env.PORT || 8123);
  const browser = await launch();
  const suites = [];
  try {
    if (only !== 'live') { console.log('\nOffline tests'); suites.push(await require('./offline')(browser, url)); }
    if (only !== 'offline') { console.log('\nLive tests'); suites.push(await require('./live')(browser, url)); }
  } finally { await browser.close(); server.close(); }

  const all = suites.flatMap(s => s.results), count = k => all.filter(r => r.status === k).length;
  const report = { when: new Date().toISOString(), totals: { pass: count('pass'), warn: count('warn'), fail: count('fail') }, suites: suites.map(s => ({ name: s.name, results: s.results, metrics: s.metrics })) };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.totals.pass} passed, ${report.totals.warn} passed with warnings, ${report.totals.fail} failed. Report and screenshots are in tests/output/.`);
  process.exit(report.totals.fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
