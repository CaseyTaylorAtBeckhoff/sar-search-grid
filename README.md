# Sidescan Search Grid

A web page for laying out lawnmower search grids for sidescan sonar boat crews, then saving the grid as a file the boat's unit can import.

- **.hwr** for Humminbird HELIX and 1100-series units
- **.gpx** for Humminbird SOLIX/APEX, Garmin, Lowrance, Raymarine, Furuno and most other chartplotters

It runs in any modern browser on phones, tablets and laptops. Once a page is open it works with no signal. Nothing is sent to a server.

A second page, **Navigate**, follows a grid (or any GPX/KML route) with the phone's GPS. See [Navigate](#navigate-beta).

**Live pages:** [Build grid](https://caseytayloratbeckhoff.github.io/sar-search-grid/) · [Navigate](https://caseytayloratbeckhoff.github.io/sar-search-grid/navigate.html)

> **Test before relying on it.** The .hwr output matches GPSBabel byte for byte, but it has not yet been imported on every unit model. Back up the unit's waypoints, import a test grid, and confirm the route before using it on a search.

## Using it

1. **Search area.** Enter the four corners in order around the area (type them, pick them on a map, or paste all four at once), or a center point with length, width and heading.
2. **Passes.** Set the number of passes, or the lane spacing (usually about twice the sonar's range per side, minus overlap). Choose which corner to start at and which way the passes run.
3. **Names.** Give each grid its own route name and waypoint prefix so grids don't overwrite each other on the unit.
4. **Save** the .hwr or .gpx file and copy it to the unit's SD card, then import nav data on the unit.

### Coordinate formats

Each corner box accepts any of these. The line under the box shows how it was read.

| Format | Example |
|---|---|
| Decimal degrees | `41.36506, -112.07352` · `N41.36506 W112.07352` |
| Degrees + decimal minutes (Humminbird, Garmin) | `N41 21.904 W112 04.411` |
| Degrees, minutes, seconds | `41°21'54.2"N 112°04'24.7"W` · `41 21 54.2 N 112 04 24.7 W` |

Spaces work in place of ° ′ ″. Use N/S/E/W or a minus sign.

### Picking corners on a map

**Pick on map** opens a full-screen satellite map, centered on your phone's location when location is allowed (otherwise on the current search area). Tap to place corners 1 to 4 in order around the area. Drag or pinch to move the map, use **My location** (crosshair button) or **Go to** a typed position to get there, tap a corner number to move that corner, and **Undo** or **Clear** to start again. **Use corners** fills in the four boxes.

### Pasting all four corners

**Paste all 4** opens a box that takes all four corners in one paste: one per line, all on one line, numbered or labelled (`Corner 1: …`), or a GPX or KML snippet from CalTopo, Google Earth and similar. Pasting several positions straight into any corner box works too.

### Getting the file onto the SD card from a phone

Use a phone SD card reader with a full-size SD slot (USB-C, or Lightning for older iPhones). Keep a dedicated FAT32 card (32 GB or smaller) for transfers, separate from chart cards.

### Unit limits the page handles

- Humminbird routes hold 50 points. Larger grids are split into several routes that join end to end.
- Waypoint names are cut to 11 characters and route names to 19.
- HELIX units store up to 2,750 waypoints; the page warns past that.

## Navigate (Beta)

The **Navigate** page follows a route with the phone's GPS: how far off the line you are, which way to steer, and how much of each pass you have covered. Switch between **Build grid** and **Navigate** at the top of either page.

### Opening a route

- **Navigate this grid** on the Build grid page, or **Use grid from Build grid** on the Navigate page.
- **Open route file** for a file someone sent you: GPX (routes, tracks or waypoints) or KML/KMZ (lines, tracks, points or an area outline), from CalTopo, Google Earth, Garmin and similar. Save an emailed or texted file to the phone first, then open it. On a computer you can drop the file on the page.
- If a file has several lines, pick one from the list. A grid split into several Humminbird routes is joined back into one.

### Where to start

- **Nearest point to the boat**: joins the route where the boat is now (at a corner it picks the pass, not the turn). Use this to pick up a route part-way through.
- **Beginning**, or **a pass you tap** on the map.

### While navigating

- The big box shows **On line**, or the distance off with ◀ / ▶ for which way to steer. Before reaching a leg it shows the distance and heading to its start.
- Below it: distance to the end of the pass, speed, course against the line, and time to the end of the pass.
- It moves on at the end of each leg. **Back**, **Skip** and **Nearest** change the leg by hand.
- The map follows the boat; moving it by hand stops following until you press **Follow**. Green shows the covered parts of each pass; the blue line is your track.
- **Sound** (off by default for each run) beeps when you drift off the line, at the end of each leg, at the end of the route and if GPS is lost. Phones that support it also vibrate.
- **On the line within** (on the start screen) sets how far either side still counts as on the line and covered: a quarter of the lane spacing by default, 25 ft for routes that aren't grids.

### Keeping it running

- **Keep the page open with the screen on**, and keep the phone plugged in. The page asks the phone to keep the screen on (Chrome on Android, Safari on iOS 16.4 or later; iOS 18.4 or later if added to the home screen). Phones pause location for web pages when the screen is off or another app is in front, so those times show as gaps in the track.
- The track saves every few seconds. If the page is closed or reloaded, it offers to **resume** the run.
- In testing, a 90-minute run on a phone-sized screen with the processor slowed 4× used about 4 ms per GPS fix, 145 KB of storage and 15 MB of memory.

### After the run

**End run** shows passes covered, % of pass length, distance run, tracking gaps and which passes were missed. **Save track (GPX)** saves the route, the track (split where tracking stopped) and the covered stretches, with a coverage note, for CalTopo, Google Earth or the team. **Keep going** returns to the run.

## Map preview

- **Zoom and pan:** use the + / − buttons, or the mouse wheel and drag on a computer. On a phone or tablet, use two fingers (one finger still scrolls the page). **Fit** returns to the whole search area.
- **Satellite imagery:** when there's internet, the preview shows USGS National Map aerial imagery (public domain, US coverage, no account needed). Without internet it falls back to a plain outline.

## Development

The page is plain HTML and JavaScript with no build tools beyond a small Python script that inlines the JS into one file.

| File | Purpose |
|---|---|
| `index.src.html` | Build grid page: layout and UI code |
| `navigate.src.html` | Navigate page: layout and UI code |
| `common.css` | Styles shared by both pages |
| `map.js` | Zoomable satellite map shared by both pages |
| `grid-core.js` | Grid layout (from the original `foursided.py`) and the GPX and .hwr writers |
| `util.js` | Coordinate parsing, area geometry, ZIP packaging |
| `route-io.js` | Reads GPX, KML and KMZ route files |
| `nav-core.js` | Navigation math: distance off the line, progress, nearest point, pass detection, coverage |
| `build.py` | Builds `dist/index.html` and `dist/navigate.html` |
| `test/` | Checks run on every push |

```sh
python build.py                 # -> dist/index.html (open it in a browser)
node test/util-test.js          # coordinate formats, geometry
node test/verify.js             # grid vs foursided.py, .hwr vs GPSBabel (needs gpsbabel)
node test/nav-test.js           # route files and navigation math
python test/deploy_test.py      # Build grid page in phone/tablet/desktop browsers (needs playwright, pillow, gpsbabel)
python test/navigate_test.py    # Navigate page with a scripted boat, four screen sizes
python test/longrun_test.py     # 90-minute run played back on a slowed phone
```

Every push to `main` runs all checks in GitHub Actions and publishes to GitHub Pages only if they pass. Screenshots from the browser checks are saved with each run.

## Credits and license

- Grid layout ported from `foursided.py` (Casey, 2013), kept in `test/fixtures/` as the reference.
- The Humminbird .hwr writer is adapted from [GPSBabel](https://www.gpsbabel.org/)'s `humminbird.cc` (© Björn Augustsson, Olaf Klein, Robert Lipe; GPL v2 or later).
- Satellite imagery: USDA, USGS The National Map.

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
