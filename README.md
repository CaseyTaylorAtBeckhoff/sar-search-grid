# Sidescan Search Grid

A web page for laying out lawnmower search grids for sidescan sonar boat crews, then saving the grid as a file the boat's unit can import.

- **.hwr** for Humminbird HELIX and 1100-series units
- **.gpx** for Humminbird SOLIX/APEX, Garmin, Lowrance, Raymarine, Furuno and most other chartplotters

It runs in any modern browser on phones, tablets and laptops. Once the page is open it works with no signal. Nothing is sent to a server.

**Live page:** `https://<owner>.github.io/sar-search-grid/` (see Settings → Pages)

> **Test before relying on it.** The .hwr output matches GPSBabel byte for byte, but it has not yet been imported on every unit model. Back up the unit's waypoints, import a test grid, and confirm the route before using it on a search.

## Using it

1. **Search area.** Enter the four corners in order around the area, or a center point with length, width and heading.
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

Spaces work in place of ° ′ ″. Use N/S/E/W or a minus sign. Pasting four lines into corner 1 fills all four corners.

### Getting the file onto the SD card from a phone

Use a phone SD card reader with a full-size SD slot (USB-C, or Lightning for older iPhones). Keep a dedicated FAT32 card (32 GB or smaller) for transfers, separate from chart cards.

### Unit limits the page handles

- Humminbird routes hold 50 points. Larger grids are split into several routes that join end to end.
- Waypoint names are cut to 11 characters and route names to 19.
- HELIX units store up to 2,750 waypoints; the page warns past that.

## Map preview

- **Zoom and pan:** use the + / − buttons, or the mouse wheel and drag on a computer. On a phone or tablet, use two fingers (one finger still scrolls the page). **Fit** returns to the whole search area.
- **Satellite imagery:** when there's internet, the preview shows USGS National Map aerial imagery (public domain, US coverage, no account needed). Without internet it falls back to a plain outline.

## Development

The page is plain HTML and JavaScript with no build tools beyond a small Python script that inlines the JS into one file.

| File | Purpose |
|---|---|
| `index.src.html` | Page layout, styles and UI code |
| `grid-core.js` | Grid layout (from the original `foursided.py`) and the GPX and .hwr writers |
| `util.js` | Coordinate parsing, area geometry, ZIP packaging |
| `build.py` | Builds `dist/index.html` |
| `test/` | Checks run on every push |

```sh
python build.py                 # -> dist/index.html (open it in a browser)
node test/util-test.js          # coordinate formats, geometry
node test/verify.js             # grid vs foursided.py, .hwr vs GPSBabel (needs gpsbabel)
python test/deploy_test.py      # phone/tablet/desktop browser checks (needs playwright, pillow, gpsbabel)
```

Every push to `main` runs all checks in GitHub Actions and publishes to GitHub Pages only if they pass. Screenshots from the browser checks are saved with each run.

## Credits and license

- Grid layout ported from `foursided.py` (Casey, 2013), kept in `test/fixtures/` as the reference.
- The Humminbird .hwr writer is adapted from [GPSBabel](https://www.gpsbabel.org/)'s `humminbird.cc` (© Björn Augustsson, Olaf Klein, Robert Lipe; GPL v2 or later).
- Satellite imagery: USDA, USGS The National Map.

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
