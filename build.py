"""Build the pages: inline the shared CSS and JS into each page.

dist/index.html     -> grid builder, standalone page for GitHub Pages or opening locally
dist/navigate.html  -> Navigate page (follow a route with the phone's GPS)
dist/sar-grid.html  -> grid builder as a body fragment for the claude.ai artifact
"""
from pathlib import Path

here = Path(__file__).parent
PARTS = {
    "/*__COMMON_CSS__*/": "common.css",
    "/*__GRID_CORE__*/": "grid-core.js",
    "/*__UTIL__*/": "util.js",
    "/*__MAP__*/": "map.js",
    "/*__ROUTE_IO__*/": "route-io.js",
    "/*__NAV_CORE__*/": "nav-core.js",
}
SKELETON = (
    '<!doctype html>\n<html lang="en">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}'
    'img{max-width:100%}[hidden]{display:none!important}</style>\n'
    '</head>\n<body>\n'
)


def assemble(src_name):
    page = (here / src_name).read_text()
    for marker, fname in PARTS.items():
        if marker in page:
            page = page.replace(marker, (here / fname).read_text())
    assert "/*__" not in page, f"unfilled placeholder in {src_name}"
    return page


dist = here / "dist"
dist.mkdir(exist_ok=True)
builder = assemble("index.src.html")
(dist / "sar-grid.html").write_text(builder)
(dist / "index.html").write_text(SKELETON + builder + "\n</body>\n</html>\n")
if (here / "navigate.src.html").exists():
    (dist / "navigate.html").write_text(SKELETON + assemble("navigate.src.html") + "\n</body>\n</html>\n")
print("built", sorted(p.name for p in dist.iterdir()))
