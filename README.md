# Draw My Route

Choose the way you want to drive, then open it in Google Maps or Apple Maps.

It is for drivers who would rather not take the road their maps app picks for them, such as nervous drivers
who want to keep off a particular highway or junction, and for telling someone else "go this way, because…".

How it works for the person using it:

1. Set where you are starting (your location by default) and where you are going. The fastest route appears.
2. Drag the orange line onto the roads you want. On a phone, press and hold the line first, then drag.
   The route re-draws continuously while you drag, about three times a second.
   Where you let go, the route snaps to a road, and larger roads are favoured: a drop near a main road lands
   on it instead of on the side street or car park beside it. Freeways get no such favour.
   Or tap **Avoid a road** and tap any road you would rather not drive on; the route moves off it.
3. Tap **Send to Google or Apple Maps**. You can open the route yourself or share it, with a note, with someone else.

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
- Search: Nominatim

They are fine for personal and light use but are rate-limited and come with no uptime promise.
If the site gets real traffic, switch to a provider with a free tier meant for apps.

Map data © OpenStreetMap contributors. Leaflet is included under its BSD 2-Clause licence (see `LEAFLET-LICENSE.txt`).

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
