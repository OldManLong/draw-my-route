# Draw My Route

Choose the way you want to drive, then open it in Google Maps or Apple Maps.

It is for drivers who would rather not take the road their maps app picks for them, such as nervous drivers
who want to keep off a particular highway or junction, and for telling someone else "go this way, because…".

How it works for the person using it:

1. Set where you are starting and where you are going. The fastest route appears.
   The site only asks for your location if you tap the location button; it never asks just because the page opened.
2. Drag the orange line onto the roads you want. On a phone, press and hold the line first, then drag.
   A pin means "take this road", not "stop here": it lands on the road you dragged to, freeways included, and on
   the side of it that the route flows along, so the route never leaves a freeway just to touch a pin.
   Taps never add pins to a route, and neither does a press that isn't followed by a pull, so a pin cannot be
   added by accident. Typing a destination searches near the start first and lists the nearest matches on top.
   While you drag, the route follows your finger. The page downloads the roads around your trip
   (`roads.js`, from OpenStreetMap's Overpass service) and works out each redraw on the phone itself,
   so there is no wait and no routing server is asked while you shape the route, including when you mark
   a road to avoid. If the road download fails, or the trip covers too large an area (about 700 km²),
   shaping falls back to asking the routing server.
   Only the send step asks the routing server: once for its own line through your pins, which is the best
   stand-in for what Google and Apple will choose, and then to work out the stops. If that line uses
   different side streets from the one you shaped, the result screen says so.
   Where you let go, the route snaps to a road, and larger roads are favoured: a drop near a main road lands
   on it instead of on the side street or car park beside it. Ramps are never favoured.
   Or tap **Avoid a road** and tap any road you would rather not drive on; the route moves off it.
3. Tap **Send to Google or Apple Maps**. You can open the route yourself or share it, with a note, with someone else.

The start and destination are handed to the maps app as real places: the name and address of a place picked
from search, or the street address of a dropped pin or your own location. A spot with no clear address goes as
exact coordinates. The in-between stops are always coordinates, so nobody mistakes one for the destination.

Google and Apple do not accept a drawn route, so the site adds in-between stops that pull them onto yours.
Stops are announced while driving, so by default it adds as few as possible.
There is deliberately no blanket "avoid highways" switch: a quiet rural highway and an eight-lane interstate
are very different roads, so you choose road by road instead.

It is a static site: there is no server and no build step. Everything runs in the browser.

## Put it online (GitHub Pages)

1. Put these files at the top level of a GitHub repository.
2. In the repository, open Settings, then Pages.
3. Under "Build and deployment", choose "Deploy from a branch", pick `main` and `/ (root)`, and save.
4. After a minute the site is live at `https://<your-username>.github.io/<repository-name>/`.

## Changing the code

After editing `app.js`, `roads.js` or `leaflet.js`, run `node tools/stamp.js` before publishing. It updates the
fingerprints on the script addresses in `index.html`, so a visitor's browser never pairs a new page with old code.
The tests fail if this step was missed.

## Add it to a phone's home screen

- iPhone: open the site in Safari, tap Share, then "Add to Home Screen".
- Android: open the site in Chrome, tap the menu, then "Add to Home screen".

## Services it uses

The page calls these free public services straight from the visitor's browser:

- Map tiles: OpenStreetMap
- Routing: the public OSRM demo server, plus the public Valhalla server, which routes around roads marked
  to avoid and gives a second opinion at the Balanced and Most reliable levels.
  At those levels stops are only accepted when both engines follow the drawn route with them, because Google
  and Apple each route differently and stops that convince a single engine are fragile.
  The public Valhalla server takes at most 10 points per request, so long routes are checked in pieces.

## How firmly the route is held

The in-between stops are plumbing: they are how Google and Apple are kept on the route. The result screen just says
the route is ready; the mechanics sit under "Details and options", including a three-way control:

- **Lightest** (default): one routing engine, a pass-through point only where the fastest route would leave the drawn one.
- **Balanced**: two engines, plus a point at least every 2 km so no long stretch is left to chance.
- **Firmest**: two engines, plus a point at least every 700 m. Longer routes need several links (9 points each).

The spacings were chosen by trying 2 km, 1.2 km and 700 m on the live test routes and scoring each with an outside engine.
- Road data for smooth dragging: Overpass (`overpass-api.de`, then `overpass.private.coffee` if that fails)
- Search: Photon (forgiving of misspellings, favours places near the start), with Nominatim as fallback and for addresses

They are fine for personal and light use but are rate-limited and come with no uptime promise.
If the site gets real traffic, switch to a provider with a free tier meant for apps.

## Credits

- **The idea: Alaina Salas.** She wanted a way to choose the roads she takes instead of the ones a maps app picks,
  and asked for this to be built.
- Map, road, place and address data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, under the
  Open Database Licence. The credit is shown on the map on every screen, linked to that page, as the licence asks.
- Map pictures: OpenStreetMap's tile servers. Routing: [OSRM](https://project-osrm.org/) and
  [Valhalla](https://valhalla.github.io/valhalla/), on servers run by [FOSSGIS](https://www.fossgis.de/).
  Place search: [Photon](https://photon.komoot.io/) by komoot, with [Nominatim](https://nominatim.org/) as fallback and
  for address lookup. Road data: the [Overpass API](https://overpass-api.de/). All are named under "About and credits"
  on the site's start screen.
- [Leaflet](https://leafletjs.com/) is included under its BSD 2-Clause licence (see `LEAFLET-LICENSE.txt`).
- The road data in `tests/fixtures/` is OpenStreetMap data too, under the same licence.
- Draw My Route is not connected with Google or Apple; it only builds links that open in their maps apps.

## Privacy and security

- The site has no accounts, no server of its own and no analytics. Nothing a visitor does is stored by the site.
- The visitor's location is requested only when they tap the location button, never on opening the page.
  The browser's own permission prompt does the asking.
- To work, the page sends the points of a trip to the free OpenStreetMap services listed above (routing, road data,
  search and address lookup), and the visitor's location, if they chose to use it, once to the address lookup.
- A shared link contains the route itself, including where it starts and ends, so anyone given the link can see it.
- Whatever a shared link carries is checked before use and only ever shown as plain text.
- A content security policy in `index.html` lets the page run only its own scripts and talk only to the services it uses.

## Testing

The `tests/` folder holds an automated test suite. It starts a private copy of the site on this computer only
(`127.0.0.1`, unreachable from outside), opens it in an emulated iPhone, and drives it the way a person would.

Setup, once: install Node.js, then run `npm install` and `npx playwright install chromium` in this folder.

- `npm run test:offline` fakes every outside service and checks the app's own logic in a few seconds:
  loading, From and To boxes, dragging the line by mouse and by touch, avoiding a road, link building,
  share links and notes, and what happens when the routing service fails.
- `npm run test:live` uses the real map, routing and search services. It draws a set of real routes
  (short, detour, loop, highway, surface streets, Manhattan one-ways, London) and checks each result three ways:
  the app's predicted match in both of its routing engines, an independent re-measurement of it, and the opinion of
  an outside engine the app never uses (BRouter). Each route is run at all three stops levels.
- `npm test` runs both. Screenshots and `report.json` land in `tests/output/`.
- `npm run serve` just runs the private copy at http://127.0.0.1:8123/ so you can click around yourself.

A warning in the live tests means the links hold in the app's own two engines but the outside engine took a different
road, which is the best available hint that Google Maps or Apple Maps might too.
