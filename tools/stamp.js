// Stamps each script address in index.html with a short fingerprint of that file's contents, e.g. app.js?v=1a2b3c4d.
// Browsers keep files for a while; without this a visitor can end up with a new page and old code (or the reverse),
// and things silently stop working. With it, a page always loads exactly the code it was published with.
// Run after changing app.js, roads.js or leaflet.js:  node tools/stamp.js     (the tests fail if it was forgotten)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const FILES = ['leaflet.js', 'roads.js', 'app.js'];
const print = f => crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').slice(0, 10);
function stamped(html) {
  for (const f of FILES) {
    const re = new RegExp('<script src="' + f.replace('.', '\\.') + '(\\?v=[0-9a-f]+)?"></script>');
    if (!re.test(html)) throw new Error('index.html has no script tag for ' + f);
    html = html.replace(re, `<script src="${f}?v=${print(f)}"></script>`);
  }
  return html;
}
module.exports = { stamped, FILES, print };
if (require.main === module) {
  const p = path.join(ROOT, 'index.html'), before = fs.readFileSync(p, 'utf8'), after = stamped(before);
  if (after !== before) fs.writeFileSync(p, after);
  console.log(after !== before ? 'index.html stamped' : 'index.html already up to date');
}
