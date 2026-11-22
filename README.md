# Draw My Route

Draw your own driving route on a map, then open it in Google Maps or Apple Maps.
Draw My Route works out the fewest in-between stops needed to keep those apps on your route.

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
- Routing: the public OSRM demo server, and the public Valhalla server for avoid-highways predictions
- Search: Nominatim

They are fine for personal and light use but are rate-limited and come with no uptime promise.
If the site gets real traffic, switch to a provider with a free tier meant for apps.

Map data © OpenStreetMap contributors. Leaflet is included under its BSD 2-Clause licence (see `LEAFLET-LICENSE.txt`).
