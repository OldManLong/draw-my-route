# Draw My Route

Choose the way you want to drive, then open it in Google Maps or Apple Maps.

It is for drivers who would rather not take the road their maps app picks for them, such as nervous drivers
who want to keep off a particular highway or junction, and for telling someone else "go this way, because…".

How it works for the person using it:

1. Set where you are starting and where you are going. The fastest route appears.
   The site only asks for your location if you tap the location button; it never asks just because the page opened.
2. Drag the orange line onto the roads you want. On a phone, press and hold the line first, then drag.
   While you drag, the route follows your finger. The page downloads the roads around your trip
   (`roads.js`, from OpenStreetMap's Overpass service) and works out each redraw on the phone itself,
   so there is no wait and no routing server is asked while you shape the route, including when you mark
   a road to avoid. If the road download fails, or the trip covers too large an area (about 700 km²),
   shaping falls back to asking the routing server.
   Only the send step asks the routing server: once for its own line through your pins, which is the best
   stand-in for what Google and Apple will choose, and then to work out the stops. If that line uses
   different side streets from the one you shaped, the result screen says so.
   Where you let go, the route snaps to a road, and larger roads are favoured: a drop near a main road lands
   on it instead of on the side street or car park beside it. Freeways get no such favour.
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

## Stops levels

The result screen has a three-way control for how firmly the route is pinned down:

- **Fewest stops** (default): one routing engine, stops only where the fastest route would leave the drawn one.
- **Balanced**: two engines, plus a stop at least every 2 km so no long stretch is left to chance.
- **Most reliable**: two engines, plus a stop at least every 700 m. Longer routes need several links (9 stops each).

The spacings were chosen by trying 2 km, 1.2 km and 700 m on the live test routes and scoring each with an outside engine.
- Road data for smooth dragging: Overpass (`overpass-api.de`, then `overpass.private.coffee` if that fails)
- Search: Nominatim

They are fine for personal and light use but are rate-limited and come with no uptime promise.
If the site gets real traffic, switch to a provider with a free tier meant for apps.

Map data © OpenStreetMap contributors. Leaflet is included under its BSD 2-Clause licence (see `LEAFLET-LICENSE.txt`).

## Privacy and security

- The site has no accounts, no server of its own and no analytics. Nothing a visitor does is stored by the site.
- The visitor's location is requested only when they tap the location button, never on opening the page.
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
