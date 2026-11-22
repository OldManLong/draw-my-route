// Turns the compact Waukesha road fixture into the JSON shape the Overpass road-data service returns,
// so tests can stand in for that service with real OpenStreetMap geometry.
const fs = require('fs'), path = require('path');
const HIGHWAY = { 0: 'motorway', 1: 'trunk', 2: 'primary', 3: 'secondary', 4: 'tertiary', 5: 'residential', 6: 'service' };

function waukeshaOverpass() {
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'waukesha-roads.json'), 'utf8'));
  const KX = 111320 * Math.cos(g.ref[0] * Math.PI / 180), KY = 110540;
  const ll = (x, y) => ({ lat: +(g.ref[0] - y / KY).toFixed(7), lon: +(g.ref[1] + x / KX).toFixed(7) });
  let extra = 1e9; const elements = [];
  g.e.forEach(([a, b, nm, cls, mph, one, mid], i) => {
    const nodes = [a + 1], geometry = [ll(g.n[2 * a], g.n[2 * a + 1])];
    for (let k = 0; k < mid.length; k += 2) { nodes.push(extra++); geometry.push(ll(mid[k], mid[k + 1])); }
    nodes.push(b + 1); geometry.push(ll(g.n[2 * b], g.n[2 * b + 1]));
    const base = HIGHWAY[cls % 10] || 'residential', name = g.names[nm];
    const tags = { highway: cls >= 10 ? base + '_link' : base, maxspeed: mph + ' mph' };
    if (name && name !== 'ramp') tags.name = name;
    if (one === 1) tags.oneway = 'yes'; else if (one === -1) tags.oneway = '-1'; else if (base === 'motorway') tags.oneway = 'no';
    elements.push({ type: 'way', id: i + 1, nodes, geometry, tags });
  });
  return { version: 0.6, elements };
}
module.exports = { waukeshaOverpass };
